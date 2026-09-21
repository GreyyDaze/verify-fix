import { test } from "node:test";
import assert from "node:assert/strict";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { buildBundle, assertNoSecretLeak, collectProjectSources } from "../../src/bundle/build.ts";
import { loadBundle } from "../../src/bundle.ts";
import type { ChecklyClient } from "../../src/checkly/client.ts";
import type { AssetManifest, CheckResult, CheckResultSummary, ErrorGroup } from "../../src/checkly/types.ts";
import { fakeTraceZip } from "../helpers/fake-trace.ts";
import { writeZip } from "../helpers/zip-writer.ts";
import { CHECK } from "../helpers/fixtures.ts";

const BASE = "https://slots.example.test";
const REPO = new URL("../../", import.meta.url).pathname;

function summary(id: string, ok: boolean, startedAt: string, loc: string): CheckResultSummary {
  return { id, hasFailures: !ok, hasErrors: false, runLocation: loc, startedAt, resultType: "FINAL", attempts: 1, errorGroupIds: ok ? [] : ["eg-1"] };
}

const HISTORY = [
  summary("r-fail", false, "2026-09-21T10:00:00Z", "eu-west-1"),
  summary("r-pass-2", true, "2026-09-21T09:55:00Z", "us-east-1"),
  summary("r-pass-1", true, "2026-09-21T09:50:00Z", "eu-west-1"),
];

function failingTrace() {
  return fakeTraceZip({
    baseURL: BASE,
    requests: [
      { method: "GET", url: `${BASE}/`, status: 200, mimeType: "text/html", body: "<html/>", t: 1 },
      { method: "POST", url: `${BASE}/api/login`, status: 200, body: '{"token":"tok-demo-3"}', t: 2 },
      { method: "POST", url: `${BASE}/api/book`, status: 401, body: '{"error":"session superseded by a newer login"}', requestHeaders: [{ name: "authorization", value: "Bearer tok-demo-3" }], t: 3 },
    ],
    actions: [{ apiName: "expect.toHaveText", params: { expectedText: [{ string: "200" }] }, error: 'Expected string: "200"\nReceived string: "401"' }],
  });
}

function passingTrace() {
  return fakeTraceZip({
    baseURL: BASE,
    requests: [
      { method: "POST", url: `${BASE}/api/login`, status: 200, body: '{"token":"tok-demo-1"}', t: 2 },
      { method: "POST", url: `${BASE}/api/book`, status: 200, body: '{"booking":"CONFIRMED"}', t: 3 },
    ],
    actions: [{ apiName: "expect.toHaveText", params: { expectedText: [{ string: "CONFIRMED" }] } }],
  });
}

/** A stand-in for ChecklyClient with the same method surface, no network. */
function fakeClient(opts: { archive?: boolean } = {}) {
  const downloads: string[] = [];
  const failingZip = failingTrace();
  const passingZip = passingTrace();
  const archiveZip = writeZip({ "traces/booking-trace.zip": failingZip, "logs.txt": "log" });
  const client = {
    calls: [] as Array<{ method: string; url: string; status: number }>,
    async getCheck() {
      return CHECK;
    },
    async listResults() {
      return { entries: HISTORY, nextId: null };
    },
    async getResult(_checkId: string, id: string): Promise<CheckResult> {
      const s = HISTORY.find((h) => h.id === id)!;
      return { ...s, playwrightCheckResult: { errors: s.hasFailures ? ["tests/booking.spec.ts:19:3 › slots booking flow › log in and book the 09:30 slot"] : [] } };
    },
    async getAssets(_checkId: string, id: string): Promise<AssetManifest> {
      if (id === "r-fail" && opts.archive) return { assets: [{ type: "trace", name: "booking-trace.zip", url: "https://s3.example/archive.zip?sig=1", source: "playwright", archive: { entryName: "traces/booking-trace.zip" } }] };
      if (id === "r-fail") return { assets: [{ type: "trace", name: "trace.zip", url: "https://s3.example/failing.zip?sig=1", source: "playwright" }] };
      return { assets: [{ type: "trace", name: "trace.zip", url: "https://s3.example/passing.zip?sig=2", source: "playwright" }] };
    },
    async download(url: string) {
      downloads.push(url);
      if (url.startsWith("https://s3.example/archive.zip")) return archiveZip;
      if (url.startsWith("https://s3.example/failing.zip")) return failingZip;
      return passingZip;
    },
    async getErrorGroup(id: string): Promise<ErrorGroup> {
      return {
        id,
        checkId: CHECK.id,
        errorHash: "h",
        rawErrorMessage: null,
        cleanedErrorMessage: 'expect(locator).toHaveText(expected) failed\nExpected string: "200"\nReceived string: "401"',
        firstSeen: "2026-09-21T09:59:00Z",
        lastSeen: "2026-09-21T10:00:00Z",
        rootCauseAnalyses: [
          {
            id: "rca-1",
            created_at: "2026-09-21T10:01:00Z",
            analysis: { classification: "Check configuration", rootCause: "Parallel runs share one test account; the second login supersedes the first session.", userImpact: "none", codeFix: null, evidence: [], referenceLinks: null },
            provider: "openai",
            model: "gpt",
            durationMs: 1,
          },
        ],
      };
    },
    async errorGroupsForCheck() {
      return [];
    },
    async triggerRca() {
      return { id: "rca-x" };
    },
    async waitForRca() {
      return null;
    },
  };
  return { client: client as unknown as ChecklyClient, downloads };
}

function makeProjectDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "vf-project-"));
  cpSync(join(REPO, "examples/slots-booking/monitoring/checkly.config.ts"), join(dir, "checkly.config.ts"));
  cpSync(join(REPO, "examples/slots-booking/monitoring/playwright.config.ts"), join(dir, "playwright.config.ts"));
  mkdirSync(join(dir, "tests"));
  cpSync(join(REPO, "examples/slots-booking/monitoring/tests/booking.spec.ts"), join(dir, "tests/booking.spec.ts"));
  mkdirSync(join(dir, "node_modules/should-be-skipped"), { recursive: true });
  writeFileSync(join(dir, "node_modules/should-be-skipped/x.spec.ts"), "expect(1).toBe(1)");
  return dir;
}

test("bundle: end to end with a fake Checkly — files, sanitized HAR, manifest, no secrets", async () => {
  const out = mkdtempSync(join(tmpdir(), "vf-bundle-"));
  const project = makeProjectDir();
  const logs: string[] = [];
  try {
    const { client, downloads } = fakeClient();
    const outcome = await buildBundle(
      { checkId: CHECK.id, outDir: out, projectDir: project, log: (l) => logs.push(l) },
      { client, accountId: "acct-1", toolVersion: "0.1.0", now: () => new Date("2026-09-21T12:00:00Z") },
    );
    assert.deepEqual(downloads.map((u) => u.replace(/\?.*/, "")), ["https://s3.example/failing.zip", "https://s3.example/passing.zip"]);
    for (const f of ["manifest.json", "check.config.json", "check/tests/booking.spec.ts", "check/playwright.config.ts", "check/checkly.config.ts", "recordings/failing.har", "recordings/passing.har", "recordings/failing.actions.json", "results/failing.json", "results/passing.json", "rca.json", "README.md", ".gitignore"]) {
      assert.ok(existsSync(join(out, f)), `missing ${f}`);
    }
    assert.equal(existsSync(join(out, "check/node_modules")), false);
    const manifest = JSON.parse(readFileSync(join(out, "manifest.json"), "utf8"));
    assert.equal(manifest.schemaVersion, "v3");
    assert.equal(manifest.incident.status, "captured");
    assert.equal(manifest.check.file, "tests/booking.spec.ts");
    assert.equal(manifest.check.logicalId, "slots-booking-monitoring");
    assert.equal(manifest.reproduction.mode, "live-concurrent:2");
    assert.equal(manifest.failurePoint.request.path, "/api/book");
    assert.deepEqual(manifest.scenes.map((s: { sceneId: string }) => s.sceneId), ["healthy-live", "reproduction", "detection"]);
    assert.equal(manifest.provenance.assets.length, 2);
    assert.match(manifest.provenance.assets[0].sha256, /^[0-9a-f]{64}$/);
    assert.equal(manifest.assertions.totalAssertions, 4);
    // secrets: env var values and bearer tokens must be absent from every file
    const all = ["manifest.json", "check.config.json", "recordings/failing.har", "recordings/passing.har", "rca.json", "README.md", "results/failing.json"].map((f) => readFileSync(join(out, f), "utf8")).join("\n");
    assert.equal(all.includes("demo-account-value"), false);
    assert.equal(all.includes("sup3r-secret-value"), false);
    assert.equal(all.includes("tok-demo-3"), false);
    assert.ok(all.includes("TEST_USER"), "env var NAMES are kept");
    // v2 loader refuses v3 with a pointer to the phase plan
    assert.throws(() => loadBundle(out), /v3 bundle generated by `verify-fix bundle`/);
    assert.ok(logs.some((l) => /wrote \d+ files/.test(l)));
  } finally {
    rmSync(out, { recursive: true, force: true });
    rmSync(project, { recursive: true, force: true });
  }
});

test("bundle: trace inside an asset archive is extracted through archive.entryName", async () => {
  const out = mkdtempSync(join(tmpdir(), "vf-bundle-"));
  try {
    const { client, downloads } = fakeClient({ archive: true });
    const outcome = await buildBundle({ checkId: CHECK.id, outDir: out, projectDir: null }, { client, accountId: "a" });
    assert.equal(downloads.filter((u) => u.includes("archive.zip")).length, 1);
    assert.equal(outcome.manifest.results.failing?.trace?.entries, 3);
    assert.ok(outcome.warnings.some((w) => /pass --project/.test(w)), "PLAYWRIGHT check without --project warns about sources");
    assert.equal(outcome.manifest.assertions, null);
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});

test("bundle: --result selects the incident; healthy history yields a baseline bundle", async () => {
  const out = mkdtempSync(join(tmpdir(), "vf-bundle-"));
  try {
    const { client } = fakeClient();
    (client as unknown as { listResults: () => Promise<unknown> }).listResults = async () => ({ entries: HISTORY.filter((h) => !h.hasFailures), nextId: null });
    const baseline = await buildBundle({ checkId: CHECK.id, outDir: join(out, "a") }, { client, accountId: "a" });
    assert.equal(baseline.manifest.incident.status, "no-failure-yet");
    assert.deepEqual(baseline.manifest.scenes.map((s) => s.sceneId), ["healthy-live"]);
    assert.equal(existsSync(join(out, "a/recordings/failing.har")), false);

    const chosen = await buildBundle({ checkId: CHECK.id, outDir: join(out, "b"), resultId: "r-fail" }, { client, accountId: "a" });
    assert.equal(chosen.manifest.results.failing?.id, "r-fail");
    assert.equal(chosen.manifest.results.passing?.id, "r-pass-2", "passing = newest passing run before the incident");
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});

test("bundle: secret-leak guard refuses to write a file containing an env var value", () => {
  assert.throws(() => assertNoSecretLeak([{ file: "x.json", text: 'token: "hunter2-value"' }], ["hunter2-value"]), /refusing to write x.json/);
  assert.doesNotThrow(() => assertNoSecretLeak([{ file: "x.json", text: "demo" }], ["demo"]), "short values are not treated as secrets (too many false positives)");
});

test("bundle: source collection reads playwright testDir and prefers the spec named in the error", () => {
  const project = makeProjectDir();
  try {
    const s = collectProjectSources(CHECK, project, ["at tests/booking.spec.ts:19:3"]);
    assert.deepEqual(s.sources.map((x) => x.path).sort(), ["checkly.config.ts", "playwright.config.ts", "tests/booking.spec.ts"]);
    assert.equal(s.mainSource, "tests/booking.spec.ts");
    assert.equal(s.logicalId, "slots-booking-monitoring");
    assert.equal(s.repoUrl, "https://github.com/GreyyDaze/verify-fix");
    const browser = collectProjectSources({ ...CHECK, checkType: "BROWSER", script: "expect(1).toBe(1)", scriptPath: "checks/login.spec.ts" }, null, []);
    assert.deepEqual(browser.sources.map((x) => x.path), ["login.spec.ts"]);
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});

test("cli: `bundle` without credentials exits 2 with guidance; help lists both commands", () => {
  const home = mkdtempSync(join(tmpdir(), "vf-home-"));
  try {
    const env = { PATH: process.env.PATH, HOME: home, XDG_CONFIG_HOME: join(home, ".config") } as NodeJS.ProcessEnv;
    const r = spawnSync(process.execPath, ["--no-warnings", join(REPO, "src/cli.ts"), "bundle", "--check", "abc"], { env, encoding: "utf8" });
    assert.equal(r.status, 2);
    assert.match(r.stderr, /No Checkly credentials found/);
    const h = spawnSync(process.execPath, ["--no-warnings", join(REPO, "src/cli.ts"), "--help"], { env, encoding: "utf8" });
    assert.match(h.stdout, /verify-fix bundle --check/);
    assert.match(h.stdout, /verify-fix verify --patch/);
    const bad = spawnSync(process.execPath, ["--no-warnings", join(REPO, "src/cli.ts"), "bundle"], { env, encoding: "utf8" });
    assert.equal(bad.status, 2);
    assert.match(bad.stderr, /--check <checkId> is required/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
