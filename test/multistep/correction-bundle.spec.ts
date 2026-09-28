// Correction batch: end-to-end local bundle capture and remote/ZIP attacks.
// All data are synthetic. No Checkly account, credential or signed URL is used.
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, symlinkSync, linkSync, renameSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildBundle } from "../../src/bundle/build.ts";
import { loadBundle } from "../../src/bundle.ts";
import { buildContract } from "../../src/contract/contract.ts";
import type { ChecklyClient } from "../../src/checkly/client.ts";
import type { AssetManifestEntry, CheckResultSummary } from "../../src/checkly/types.ts";
import { openZip, openZipBounded, readZipEntry, listZip } from "../../src/trace/zip.ts";
import { writeZip } from "../helpers/zip-writer.ts";
import { buildMultiStepRecording, readMultiStepAssets } from "../../src/multistep/capture.ts";
import { validMultiStepStoredRecording } from "../../src/multistep/recording-schema.ts";
import { FAKE_ACCOUNT, FAKE_TOKEN, FAKE_ORIGIN, failingTestResults, passingTestResults, failingLogs, passingLogs } from "./helpers.ts";

const WEB = new URL("../../examples/slots-booking/web/", import.meta.url).pathname;
const FILE = "checks/multistep-booking.spec.ts";
const CONSTRUCT_FILE = "checks/multistep-booking.check.ts";
const SPEC = readFileSync(join(WEB, FILE), "utf8");
const CONSTRUCT = readFileSync(join(WEB, CONSTRUCT_FILE), "utf8");
const CANARY = "PRIVATE_RESULT_CANARY_7432_XYZ";

function project(): string {
  const dir = mkdtempSync(join(tmpdir(), "verify-fix-correction-project-"));
  mkdirSync(join(dir, "checks"));
  writeFileSync(join(dir, "checkly.config.ts"), "export default {logicalId:'slots-booking-multistep'}\n");
  writeFileSync(join(dir, FILE), SPEC);
  writeFileSync(join(dir, CONSTRUCT_FILE), CONSTRUCT);
  return dir;
}
function assetDir(failing = failingTestResults(), passing = passingTestResults(), metadata = false): string {
  const dir = mkdtempSync(join(tmpdir(), "verify-fix-correction-assets-"));
  for (const [side, report, logs] of [["failing", failing, failingLogs()], ["passing", passing, passingLogs()]] as const) {
    const path = join(dir, side);
    mkdirSync(path);
    writeFileSync(join(path, "test-results.json"), report);
    writeFileSync(join(path, "logs.txt"), metadata ? JSON.stringify([{ level: CANARY, msg: CANARY, time: 1 }]) : logs);
    writeFileSync(join(path, "check-run-data.json"), JSON.stringify({ script: `const secret = '${CANARY}'`, scriptPath: `/${CANARY}/secret.spec.ts`, imports: [{ path: CANARY }], playwrightConfig: { path: CANARY } }));
  }
  return dir;
}
function summary(id: string, failure: boolean): CheckResultSummary {
  return {
    id, checkId: "synthetic-check", name: "slots booking multistep transaction", hasFailures: failure, hasErrors: false,
    runLocation: failure ? "eu-west-1" : "us-east-1",
    startedAt: failure ? "2026-09-25T22:18:13.000Z" : "2026-09-25T20:08:13.000Z",
    stoppedAt: failure ? "2026-09-25T22:18:18.000Z" : "2026-09-25T20:08:18.000Z",
    resultType: "FINAL", attempts: failure ? 2 : 1, errorGroupIds: [],
  };
}
interface FakeOpts {
  resultId?: string;
  checkLocations?: string[];
  fail?: CheckResultSummary;
  pass?: CheckResultSummary | null;
  remote?: (id: string) => { assets: AssetManifestEntry[]; truncated?: boolean };
  download?: (url: string, maxBytes: number) => Promise<Buffer>;
  canary?: boolean;
  shortSecret?: boolean;
}
function fakeClient(opts: FakeOpts = {}): ChecklyClient {
  const fail = opts.fail ?? summary("synthetic-fail", true);
  const pass = opts.pass === undefined ? summary("synthetic-pass", false) : opts.pass;
  const history = [fail, ...(pass ? [pass] : [])];
  return {
    calls: [{ method: "GET", url: `https://signed.invalid/${CANARY}/capture?token=${CANARY}`, status: 200 }],
    async getCheck() {
      return {
        id: "synthetic-check", name: "slots booking multistep transaction", checkType: "MULTI_STEP",
        activated: true, muted: false, frequency: 5, runParallel: true, locations: opts.checkLocations ?? ["us-east-1", "eu-west-1"],
        privateLocations: [CANARY], tags: [CANARY], retryStrategy: { path: CANARY }, runtimeId: CANARY,
        script: SPEC, scriptPath: `/${CANARY}/multistep-booking.spec.ts`,
        environmentVariables: [
          { key: "ENVIRONMENT_URL", value: FAKE_ORIGIN, secret: false },
          { key: "MULTISTEP_USER_US_EAST_1", value: FAKE_ACCOUNT, secret: true },
          { key: "MULTISTEP_USER_EU_WEST_1", value: "other-fixture", secret: true },
          { key: "CANARY_NAME", value: opts.shortSecret ? "abc" : CANARY, secret: true },
        ],
      };
    },
    async listResults() { return { entries: history, nextId: null }; },
    async getResult(_checkId: string, id: string) {
      const original = history.find((r) => r.id === id)!;
      return { ...original,
        errors: opts.canary ? [{ error: { message: `expect() failed at /users/${CANARY}/secret.spec.ts:999:99`, stack: CANARY }, testFile: `/${CANARY}/secret.spec.ts`, testTitle: CANARY }] : [],
        multiStepCheckResult: { pages: [{ url: `https://${CANARY}.invalid`, error: CANARY }], errors: [] },
        logs: [{ level: CANARY, msg: CANARY }], trace: { path: `/${CANARY}/trace` },
      };
    },
    async getAssets(_checkId: string, id: string) { return opts.remote?.(id) ?? { assets: [] }; },
    async download(url: string, maxBytes: number) { return opts.download?.(url, maxBytes) ?? Buffer.alloc(0); },
  } as unknown as ChecklyClient;
}
async function capture(opts: FakeOpts, localAssets: string | null, dir = project()) {
  const outDir = mkdtempSync(join(tmpdir(), "verify-fix-correction-bundle-"));
  const outcome = await buildBundle({ checkId: "synthetic-check", resultId: opts.resultId, outDir, projectDir: dir, assetsDir: localAssets, log: () => {} },
    { client: fakeClient(opts), accountId: "synthetic", now: () => new Date("2026-09-27T00:00:00.000Z") });
  return { ...outcome, outDir };
}
function allFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const path = join(dir, e.name);
    return e.isDirectory() ? allFiles(path) : [path];
  });
}

test("local capture stores ONLY fixed schemas/categories; results, logs, pages, trace, paths and arbitrary API details cannot leak", async () => {
  const assets = assetDir(failingTestResults(), passingTestResults(), true);
  // Inject arbitrary fields everywhere without changing the four canonical
  // requests or the relationship sites the capture must preserve.
  for (const side of ["failing", "passing"]) {
    const file = join(assets, side, "test-results.json");
    const raw = JSON.parse(readFileSync(file, "utf8"));
    raw[CANARY] = { secret: CANARY };
    const text = JSON.stringify(raw).replace('"statusText":"OK"', `"statusText":"${CANARY}"`);
    writeFileSync(file, text);
  }
  const out = await capture({ canary: true }, assets);
  assert.equal(out.manifest.recordings.multistepFailing, "recordings/failing.multistep.json");
  assert.equal(out.manifest.recordings.multistepPassing, "recordings/passing.multistep.json");
  assert.equal(out.manifest.provenance.apiCalls[0]?.url, "<checkly-request>");
  assert.equal(out.manifest.results.failing?.errors.length, 0);
  assert.equal(out.manifest.results.failing?.failingTest, null);
  assert.equal(out.manifest.results.failing?.trace, null);
  assert.equal(out.manifest.rca, null);
  assert.equal(out.manifest.errorGroup, null);
  assert.equal(out.manifest.config.retryStrategy, null);
  assert.ok(!out.files.includes("rca.json"), "raw RCA output is not part of a Multistep bundle");
  for (const path of allFiles(out.outDir)) {
    const text = readFileSync(path, "utf8");
    for (const secret of [CANARY, FAKE_TOKEN, FAKE_ACCOUNT, FAKE_ORIGIN]) {
      assert.ok(!text.includes(secret), `${path} contains forbidden raw value ${secret}`);
    }
  }
  const rec = JSON.parse(readFileSync(join(out.outDir, "recordings", "failing.multistep.json"), "utf8"));
  assert.equal(validMultiStepStoredRecording(rec, "failing"), true);
  assert.equal(rec.checkRunData, null);
  assert.equal(rec.logs, null);
  assert.equal(rec.steps[0].requests[0].timings, null);
  assert.equal(rec.steps[0].requests[0].statusText, null);
  assert.equal(rec.transaction.token.occurrences, 3);
  const loaded = loadBundle(out.outDir).bundle;
  assert.deepEqual(loaded.multistep?.problems, []);
  assert.equal(loaded.check.file, FILE, "the deployed API script is bound to the construct's actual entrypoint");
});
test("passing/failing asset swapping, summary-side contradictions and missing pointers never borrow the opposite side", async () => {
  const swapped = await capture({}, assetDir(passingTestResults(), failingTestResults()));
  assert.equal(swapped.manifest.recordings.multistepFailing, null);
  assert.equal(swapped.manifest.recordings.multistepPassing, null);
  assert.ok(swapped.manifest.multistep?.failing?.problems.includes("MULTISTEP_CAPTURE_SIDE_MISMATCH"));
  assert.ok(swapped.manifest.multistep?.passing?.problems.includes("MULTISTEP_CAPTURE_SIDE_MISMATCH"));
  assert.ok(loadBundle(swapped.outDir).bundle.multistep!.problems.length >= 2);

  const valid = await capture({}, assetDir());
  const m = JSON.parse(readFileSync(join(valid.outDir, "manifest.json"), "utf8"));
  m.recordings.multistepFailing = "../../out-of-bundle.secret";
  writeFileSync(join(valid.outDir, "manifest.json"), JSON.stringify(m));
  const loaded = loadBundle(valid.outDir).bundle;
  assert.equal(loaded.multistep!.kind, null, "a passing recording can never substitute for a failed result");
  assert.deepEqual(loaded.multistep!.steps, []);
  assert.ok(loaded.multistep!.problems.includes("MULTISTEP_FAILING_RECORDING_MISSING"));

  const passedOnly = summary("passed-selected", false);
  const wrong = await capture({ fail: passedOnly, pass: null, resultId: "passed-selected" }, assetDir());
  assert.equal(wrong.manifest.recordings.multistepFailing, null);
  assert.ok(wrong.manifest.multistep?.failing?.problems.includes("MULTISTEP_RESULT_SIDE_MISMATCH"));
});

test("deployed Checkly scheduling that differs from the construct gates both evidence sides as UNCERTAIN", async () => {
  const drift = await capture({ checkLocations: ["us-east-1"] }, assetDir());
  for (const side of ["failing", "passing"] as const) {
    assert.ok(drift.manifest.multistep?.[side]?.problems.includes("MULTISTEP_DEPLOYED_CONFIG_MISMATCH"));
  }
  assert.ok(loadBundle(drift.outDir).bundle.multistep?.problems.includes("MULTISTEP_DEPLOYED_CONFIG_MISMATCH"));
});

test("tampered, legacy, extra-field and symlinked v2 recordings are invalid rather than free-form evidence", async () => {
  for (const mutation of [
    (r: Record<string, unknown>) => { r.schemaVersion = "multistep-recording-v1"; },
    (r: Record<string, unknown>) => { (r.steps as Array<Record<string, unknown>>)[0]!.error = CANARY; },
    (r: Record<string, unknown>) => { (r.transaction as Record<string, unknown>).rawToken = CANARY; },
    (r: Record<string, unknown>) => { r.pages = [{ url: CANARY }]; },
  ]) {
    const out = await capture({}, assetDir());
    const path = join(out.outDir, "recordings", "failing.multistep.json");
    const r = JSON.parse(readFileSync(path, "utf8"));
    mutation(r);
    writeFileSync(path, JSON.stringify(r));
    assert.deepEqual(loadBundle(out.outDir).bundle.multistep?.problems, ["MULTISTEP_FAILING_RECORDING_INVALID"]);
  }
  const out = await capture({}, assetDir());
  const path = join(out.outDir, "recordings", "failing.multistep.json");
  const other = join(out.outDir, "outside.recording.json");
  writeFileSync(other, readFileSync(path));
  const { unlinkSync } = await import("node:fs");
  unlinkSync(path);
  symlinkSync(other, path);
  assert.ok(loadBundle(out.outDir).bundle.multistep!.problems.includes("MULTISTEP_FAILING_RECORDING_INVALID"));
});

test("remote ZIP capture is bounded before allocation and can record a valid, side-specific transaction", async () => {
  const entries = new Map([
    ["synthetic-fail", writeZip({ "test-results.json": failingTestResults(), "logs.txt": failingLogs() })],
    ["synthetic-pass", writeZip({ "test-results.json": passingTestResults(), "logs.txt": passingLogs() })],
  ]);
  const budgets: number[] = [];
  const remote = (id: string) => ({ assets: ["test-results.json", "logs.txt"].map((name) => ({
    name, type: "report" as const, source: "synthetic", url: `https://signed.invalid/${id}.zip?secret=${CANARY}`,
    archive: { entryName: name },
  })) });
  const out = await capture({ remote, download: async (url, max) => {
    budgets.push(max);
    const id = /\/(synthetic-(?:fail|pass))\.zip/.exec(url)?.[1];
    return entries.get(id ?? "")!;
  } }, null);
  assert.deepEqual(loadBundle(out.outDir).bundle.multistep?.problems, []);
  assert.deepEqual(out.manifest.provenance.assets.map((a) => a.name).sort(), ["logs.txt", "logs.txt", "test-results.json", "test-results.json"]);
  assert.equal(budgets.length, 2, "one archive download per side (cached for all of its entries)");
  assert.ok(budgets.every((value) => value > 0 && value <= 64 * 1024 * 1024));
  assert.ok(!allFiles(out.outDir).some((path) => readFileSync(path, "utf8").includes(CANARY)), "signed URLs are never persisted");
});

test("remote duplicates/truncated manifests/CRC failures mark the whole side UNCERTAIN and discard partial hashes", async () => {
  const zip = writeZip({ "test-results.json": failingTestResults(), "logs.txt": failingLogs() });
  const badCrc = Buffer.from(zip);
  const cdirOffset = badCrc.readUInt32LE(badCrc.length - 22 + 16);
  badCrc.writeUInt32LE(0, cdirOffset + 16); // central CRC disagrees with local CRC
  const entry = (name: string): AssetManifestEntry => ({ name, type: "report", source: "synthetic", url: "https://signed.invalid/archive.zip", archive: { entryName: name } });
  const attacks = [
    { remote: () => ({ assets: [entry("test-results.json"), entry("test-results.json")] }), data: zip, category: "MULTISTEP_DUPLICATE_ASSET" },
    { remote: () => ({ assets: [entry("test-results.json")], truncated: true }), data: zip, category: "MULTISTEP_ASSET_MANIFEST_TRUNCATED" },
    { remote: () => ({ assets: [entry("test-results.json")] }), data: badCrc, category: "MULTISTEP_ARCHIVE_INVALID" },
    { remote: () => ({ assets: [null as unknown as AssetManifestEntry] }), data: zip, category: "MULTISTEP_ASSET_MANIFEST_INVALID" },
    { remote: () => ({ assets: [{ ...entry("test-results.json"), archive: { entryName: null as unknown as string } }] }), data: zip, category: "MULTISTEP_ASSET_MANIFEST_INVALID" },
    { remote: () => ({ assets: null as unknown as AssetManifestEntry[] }), data: zip, category: "MULTISTEP_ASSET_MANIFEST_INVALID" },
  ];
  for (const attack of attacks) {
    const out = await capture({ pass: null, remote: attack.remote, download: async () => attack.data }, null);
    assert.equal(out.manifest.recordings.multistepFailing, null);
    assert.ok(out.manifest.multistep?.failing?.problems.includes(attack.category), JSON.stringify(out.manifest.multistep));
    assert.deepEqual(out.manifest.provenance.assets.filter((a) => a.result === "failing"), [], "partial side evidence is rolled back");
    assert.ok(loadBundle(out.outDir).bundle.multistep!.problems.length > 0);
  }
});

test("the aggregate REMOTE download budget is passed to every fetch and rolls back a partially captured side", async () => {
  // Two individually valid 48 MiB archives exceed the 96 MiB total by their
  // ZIP headers. The stub deliberately violates the second requested budget:
  // the builder itself must check it even when a custom client misbehaves.
  const bytes = randomBytes(24 * 1024 * 1024);
  const archive = writeZip({ "test-results.json": bytes, "logs.txt": bytes }, { store: true });
  const limits: number[] = [];
  const out = await capture({ pass: null,
    remote: () => ({ assets: ["test-results.json", "logs.txt"].map((name, index) => ({
      name, type: "report" as const, source: "synthetic",
      url: `https://signed.invalid/archive-${index}.zip`, archive: { entryName: name },
    })) }),
    download: async (_url, maxBytes) => { limits.push(maxBytes); return archive; },
  }, null);
  assert.equal(limits.length, 2);
  assert.ok(limits[0]! > archive.length && limits[1]! < archive.length, "second fetch has only the aggregate remaining budget");
  assert.equal(out.manifest.recordings.multistepFailing, null);
  assert.ok(out.manifest.multistep?.failing?.problems.includes("MULTISTEP_ARCHIVE_INVALID"));
  assert.deepEqual(out.manifest.provenance.assets.filter((asset) => asset.result === "failing"), []);
});

test("ZIP forged sizes and CRC cannot evade ACTUAL ratio or integrity; legacy readers are bounded too", () => {
  const highlyCompressed = writeZip({ "test-results.json": Buffer.alloc(400_000, 0x61) });
  const forged = Buffer.from(highlyCompressed);
  const central = forged.readUInt32LE(forged.length - 22 + 16);
  forged.writeUInt32LE(1, central + 24); // tiny declared output, low declared ratio
  forged.writeUInt32LE(1, 22); // local header agrees with the forgery
  assert.throws(() => openZipBounded(forged).get("test-results.json")!(), /actual compression ratio/);
  assert.throws(() => openZip(forged).get("test-results.json")!(), /actual compression ratio/);
  assert.throws(() => readZipEntry(forged, listZip(forged)[0]!), /actual compression ratio/);
  const many = writeZip(Object.fromEntries(Array.from({ length: 65 }, (_, index) => [`entry-${index}`, ""])), { store: true });
  assert.throws(() => listZip(many), /entries exceed count bound/, "even the legacy metadata reader rejects an excessive count before allocating the array");
  const tiny = writeZip({ "test-results.json": "safe" });
  const crc = Buffer.from(tiny);
  const offset = crc.readUInt32LE(crc.length - 22 + 16);
  crc.writeUInt32LE(0, offset + 16);
  crc.writeUInt32LE(0, 14);
  assert.throws(() => openZipBounded(crc).get("test-results.json")!(), /CRC32 integrity mismatch/);
});

test("a direct file and assets.zip together are ambiguous evidence, and local symlinks are not followed", () => {
  const dir = mkdtempSync(join(tmpdir(), "verify-fix-ambiguous-"));
  writeFileSync(join(dir, "test-results.json"), failingTestResults());
  writeFileSync(join(dir, "assets.zip"), writeZip({ "test-results.json": failingTestResults() }));
  assert.match(readMultiStepAssets(dir).failing?.invalid ?? "", /conflicts/);
  const rec = buildMultiStepRecording({ texts: { testResults: null, logs: null, checkRunData: null, invalid: `secret ${CANARY} in archive` } });
  assert.equal(rec.ok, false);
  if (!rec.ok) assert.ok(!JSON.stringify(rec).includes(CANARY), "raw error paths and names become fixed categories");
});

test("only a result/source/reporter-bound failed assertion may narrow the stale-field contract removal", async () => {
  const out = await capture({}, assetDir());
  const manifestPath = join(out.outDir, "manifest.json");
  const recordingPath = join(out.outDir, "recordings", "failing.multistep.json");
  const initialManifest = readFileSync(manifestPath, "utf8");
  const initialRecording = readFileSync(recordingPath, "utf8");
  const patch = SPEC.replace("expect(body.confirmed).toBe(true)", "expect(body.booking.confirmed).toBe(true)");
  assert.notEqual(patch, SPEC);
  const baseline = loadBundle(out.outDir).bundle;
  assert.deepEqual(baseline.multistep?.problems, []);
  assert.deepEqual(baseline.multistep?.failureAssertion, {
    file: FILE, line: 142,
    id: baseline.multistep!.failureAssertion!.id, step: "book 09:30",
  });
  const diff = buildContract(baseline, patch).diff;
  const removed = diff.removed.find((item) => item.subject === "body.confirmed" && item.target === "true");
  const added = diff.added.find((item) => item.subject === "body.booking.confirmed" && item.target === "true");
  assert.ok(removed && added, "a colliding assertion ID must still produce removed AND added tuple evidence");
  assert.equal(removed.id, added.id);
  assert.equal(removed.onCriticalPath, false, "the proven stale-field replacement alone is the narrow repair exception");

  const manifestAttacks: Array<(m: Record<string, any>) => void> = [
    (m) => { m.failurePoint.assertion.line = 144; },
    (m) => { m.failurePoint.assertion.file = "checks/other.spec.ts"; },
    (m) => { m.failurePoint.assertion.assertionId = "assert:00000000"; },
    (m) => { m.failurePoint.action.title = "session"; },
    (m) => { m.results.failing.id = "different-run"; },
    (m) => { m.results.failing.runLocation = "us-east-1"; },
    (m) => { m.results.failing.startedAt = "2026-09-25T22:19:13.000Z"; },
    (m) => { m.provenance.assets.find((asset: { result: string; name: string }) =>
      asset.result === "failing" && asset.name === "test-results.json").sha256 = "0".repeat(64); },
    (m) => { m.scenes.find((scene: { verdict: { provenance: { kind: string } } }) =>
      scene.verdict.provenance.kind === "recorded").verdict.provenance.runId = "another-run"; },
    (m) => { const detection = m.scenes.find((scene: { type: string }) => scene.type === "DETECTION");
      detection.verdict.provenance = { kind: "recorded", runId: m.results.passing.id,
        artifactId: "recordings/passing.multistep.json" }; },
    (m) => { m.scenes.find((scene: { type: string }) => scene.type === "DETECTION").mode = "inject:GET /api/slots -> 500"; },
    (m) => { m.failurePoint.dependency.path = "/api/slots"; m.failurePoint.dependency.method = "GET"; },
    (m) => { m.scenes = m.scenes.filter((scene: { type: string }) => scene.type !== "DETECTION"); },
    (m) => { m.scenes.find((scene: { type: string }) => scene.type === "DETECTION").verdict.provenance =
      { kind: "code", assertionId: m.failurePoint.assertion.assertionId }; },
    (m) => { m.scenes.find((scene: { type: string }) => scene.type === "DETECTION").sceneId = "healthy-live"; },
  ];
  for (const [index, mutate] of manifestAttacks.entries()) {
    const m = JSON.parse(initialManifest);
    mutate(m);
    writeFileSync(manifestPath, JSON.stringify(m));
    const loaded = loadBundle(out.outDir).bundle;
    assert.ok(loaded.multistep?.problems.length, `manifest attack ${index} cannot retain admissible evidence`);
    const changed = buildContract(loaded, patch).diff.removed.find((item) => item.subject === "body.confirmed" && item.target === "true");
    assert.equal(changed?.onCriticalPath, true, "invalid attribution does not downgrade the removed contract");
  }
  writeFileSync(manifestPath, initialManifest);
  const recordingAttacks: Array<(r: Record<string, any>) => void> = [
    (r) => { r.binding.side = "passing"; },
    (r) => { r.binding.reporter = "forged-stdout"; },
    (r) => { r.binding.bridge = "not-required"; },
    (r) => { r.binding.sourceSha256 = "0".repeat(64); },
    (r) => { r.steps[3].failureLine = 144; },
    (r) => { r.steps[3].assertions = []; },
    (r) => { r.steps[3].requests[0].expected = "<redacted>"; },
  ];
  for (const mutate of recordingAttacks) {
    const r = JSON.parse(initialRecording);
    mutate(r);
    writeFileSync(recordingPath, JSON.stringify(r));
    const loaded = loadBundle(out.outDir).bundle;
    assert.ok(loaded.multistep?.problems.length, "a changed stored recording must become UNCERTAIN");
    assert.equal(buildContract(loaded, patch).diff.removed.find((item) => item.subject === "body.confirmed")?.onCriticalPath, true);
  }
});

test("Multistep bundle output is bounded: reused directories cannot redirect files through links", async () => {
  const root = mkdtempSync(join(tmpdir(), "verify-fix-output-bound-"));
  const outside = join(root, "outside");
  mkdirSync(outside);
  const leaked = join(outside, "private.txt");
  writeFileSync(leaked, "leave intact");
  const assets = assetDir();
  const buildAt = (outDir: string) => buildBundle({ checkId: "synthetic-check", outDir, projectDir: project(), assetsDir: assets, log: () => {} },
    { client: fakeClient(), accountId: "synthetic", now: () => new Date("2026-09-27T00:00:00.000Z") });
  const folder = join(root, "symlinked-child");
  mkdirSync(folder);
  symlinkSync(outside, join(folder, "check"));
  await assert.rejects(buildAt(folder), /MULTISTEP_OUTPUT_PATH_UNSAFE/);
  assert.deepEqual(readdirSync(outside), ["private.txt"], "the target outside --out stays untouched");
  const file = join(root, "symlinked-file");
  mkdirSync(file);
  symlinkSync(leaked, join(file, "manifest.json"));
  await assert.rejects(buildAt(file), /MULTISTEP_OUTPUT_PATH_UNSAFE/);
  const hardlink = join(root, "hardlinked-file");
  mkdirSync(hardlink);
  linkSync(leaked, join(hardlink, "manifest.json"));
  await assert.rejects(buildAt(hardlink), /MULTISTEP_OUTPUT_PATH_UNSAFE/);
  assert.equal(readFileSync(leaked, "utf8"), "leave intact");
  const safe = join(root, "safe-bundle");
  await buildAt(safe);
  await buildAt(safe);
  assert.deepEqual(loadBundle(safe).bundle.multistep?.problems, [], "an ordinary bounded recapture can replace its own regular files");
});

test("nested Playwright report, step assertions, required bodies and real token sites are mandatory — store:memory is no substitute", () => {
  const raw = JSON.parse(passingTestResults());
  const run = raw.suites[0].suites[0].specs[0].tests[0].results[0];
  const attacks: Array<[string, (report: any) => void]> = [
    ["flattened report", (r) => { r.steps = r.suites[0].suites[0].specs[0].tests[0].results[0].steps; r.suites = []; }],
    ["missing required step assertion", (r) => { r.suites[0].suites[0].specs[0].tests[0].results[0].steps[0].steps.splice(1, 1); }],
    ["missing login request body", (r) => { r.suites[0].suites[0].specs[0].tests[0].results[0].steps[0].steps[0].checklyData[0].requestBody = null; }],
    ["missing book response body", (r) => { r.suites[0].suites[0].specs[0].tests[0].results[0].steps[3].steps[0].checklyData[0].body = null; }],
    ["only a synthetic store label, not a token", (r) => { r.suites[0].suites[0].specs[0].tests[0].results[0].steps[0].steps[0].checklyData[0].body.token = null; }],
  ];
  assert.equal(run.steps.length, 5);
  for (const [label, mutate] of attacks) {
    const report = structuredClone(raw);
    mutate(report);
    const result = buildMultiStepRecording({ texts: { testResults: JSON.stringify(report), logs: passingLogs(), checkRunData: null } });
    assert.equal(result.ok, false, `${label} cannot become admissible evidence`);
  }
});

test("a symlinked check/ ROOT is not a bounded source closure at bundle load", async () => {
  const out = await capture({}, assetDir());
  renameSync(join(out.outDir, "check"), join(out.outDir, "original-source"));
  symlinkSync(join(out.outDir, "original-source"), join(out.outDir, "check"));
  assert.throws(() => loadBundle(out.outDir), /MULTISTEP_SOURCE_PATH_UNSAFE/);
});

test("a manifest cannot refer to an inherited property or escaping source file", async () => {
  const out = await capture({}, assetDir());
  const path = join(out.outDir, "manifest.json");
  const original = JSON.parse(readFileSync(path, "utf8"));
  for (const file of ["__proto__", "../../private.spec.ts", "checks/unrecorded.spec.ts"]) {
    writeFileSync(path, JSON.stringify({ ...original, check: { ...original.check, file } }));
    assert.throws(() => loadBundle(out.outDir), /MULTISTEP_SOURCE_PATH_UNSAFE|missing under check/);
  }
});

test("short environment secrets that cannot be reliably screened prevent Multistep bundle output", async () => {
  const dir = mkdtempSync(join(tmpdir(), "verify-fix-short-secret-output-"));
  await assert.rejects(buildBundle({ checkId: "synthetic-check", outDir: dir, projectDir: project(), assetsDir: assetDir(), log: () => {} },
    { client: fakeClient({ shortSecret: true }), accountId: "synthetic" }), /MULTISTEP_SECRET_UNSCREENABLE/);
  assert.deepEqual(readdirSync(dir), [], "no partial bundle was written");
});

test("legacy v2 Multistep bundles cannot read a symlinked or escaping source tree", () => {
  const root = mkdtempSync(join(tmpdir(), "verify-fix-v2-multistep-"));
  const outside = mkdtempSync(join(tmpdir(), "verify-fix-v2-private-"));
  writeFileSync(join(outside, "private.spec.ts"), `PRIVATE_SYNTHETIC_CANARY ${CANARY}`);
  const manifest = (file: string) => JSON.stringify({ schemaVersion: "v2",
    check: { file, checkType: "MULTI_STEP" }, scenes: [] });
  symlinkSync(outside, join(root, "check"));
  writeFileSync(join(root, "manifest.json"), manifest("private.spec.ts"));
  assert.throws(() => loadBundle(root), /MULTISTEP_SOURCE_PATH_UNSAFE/,
    "v2 must not read a symlinked check/ root before it knows the source closure is safe");

  const escaped = mkdtempSync(join(tmpdir(), "verify-fix-v2-escape-"));
  mkdirSync(join(escaped, "check"));
  writeFileSync(join(escaped, "check", "normal.spec.ts"), "// bounded synthetic script");
  writeFileSync(join(escaped, "manifest.json"), manifest("../../private.spec.ts"));
  assert.throws(() => loadBundle(escaped), /MULTISTEP_SOURCE_PATH_UNSAFE/,
    "even a valid check/ tree cannot authorize an escaping v2 main-source path");

  const claimed = mkdtempSync(join(tmpdir(), "verify-fix-v2-claim-"));
  mkdirSync(join(claimed, "check"));
  writeFileSync(join(claimed, "check", "safe.spec.ts"), "// bounded synthetic script");
  writeFileSync(join(claimed, "manifest.json"), JSON.stringify({ schemaVersion: "v2",
    check: { file: "safe.spec.ts", checkType: "MULTI_STEP" }, scenes: [],
    multistep: { kind: "passing", steps: ["login"], problems: [] } }));
  assert.deepEqual(loadBundle(claimed).bundle.multistep,
    { kind: null, steps: [], problems: ["MULTISTEP_LEGACY_BUNDLE_UNBOUND"] },
    "a v2 self-declared passing result is not result/asset/source-bound Multistep evidence");
});
