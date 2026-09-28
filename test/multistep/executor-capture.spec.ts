// Stage-7 focused tests: Multistep executor adapter (mechanics via a test
// double — never real Checkly/browser/cloud proof), asset-directory capture,
// the full `verify-fix bundle --assets` mechanics path, report fields, and
// CLI help. Fixtures are locally constructed with synthetic values only.

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execSync, spawnSync } from "node:child_process";
import { runMultiStepSandbox, resolvePlaywrightCli } from "../../src/multistep/executor.ts";
import { buildMultiStepRecording, readMultiStepAssets, MECHANICS_ONLY_NOTE } from "../../src/multistep/capture.ts";
import { buildBundle } from "../../src/bundle/build.ts";
import { loadBundle } from "../../src/bundle.ts";
import { buildReport } from "../../src/report/report.ts";
import { emptyExecutionCost } from "../../src/types.ts";
import type { ContractReport } from "../../src/contract/contract.ts";
import type { ChecklyClient } from "../../src/checkly/client.ts";
import type { CheckResult, CheckResultSummary } from "../../src/checkly/types.ts";
import { writeZip } from "../helpers/zip-writer.ts";
import {
  FAKE_ACCOUNT,
  FAKE_ORIGIN,
  FAKE_TOKEN,
  failingLogs,
  failingTestResults,
  passingLogs,
  passingTestResults,
} from "./helpers.ts";

const WEB = new URL("../../examples/slots-booking/web/", import.meta.url).pathname;
const SPEC_SOURCE = readFileSync(join(WEB, "checks", "multistep-booking.spec.ts"), "utf8");
const CONSTRUCT_SOURCE = readFileSync(join(WEB, "checks", "multistep-booking.check.ts"), "utf8");

function makeFakeProject(): string {
  const project = mkdtempSync(join(tmpdir(), "verify-fix-multistep-project-"));
  const pw = join(project, "node_modules", "@playwright", "test");
  mkdirSync(pw, { recursive: true });
  writeFileSync(join(project, "package.json"), JSON.stringify({ name: "fake-project", private: true }));
  writeFileSync(join(pw, "package.json"), JSON.stringify({ name: "@playwright/test", version: "1.0.0", exports: { "./cli": "./cli.cjs" } }));
  writeFileSync(join(pw, "cli.cjs"), [
    "const fs = require('node:fs')",
    "// Test double: prove the adapter never asks for a browser.",
    "if (process.env.VERIFY_FIX_BROWSER_PATH) {",
    "  console.log(JSON.stringify({ stats: { expected: 0, unexpected: 1, flaky: 0 }, suites: [{ specs: [{ tests: [{ results: [{ status: 'failed', steps: [], error: { message: 'browser executable requested' } }] }] }] }], errors: [] }))",
    "  process.exit(1)",
    "}",
    "if (process.argv.includes('--project')) {",
    "  console.log(JSON.stringify({ stats: { expected: 0, unexpected: 1, flaky: 0 }, suites: [{ specs: [{ tests: [{ results: [{ status: 'failed', steps: [], error: { message: 'browser project filter requested' } }] }] }] }], errors: [] }))",
    "  process.exit(1)",
    "}",
    "process.stdout.write(fs.readFileSync(require('node:path').join(__dirname, '../../../fake-report.json'), 'utf8'))",
    "process.exit(0)",
  ].join("\n"));
  return project;
}

function writeAssetDir(): { dir: string; passingDir: string } {
  const dir = mkdtempSync(join(tmpdir(), "verify-fix-multistep-assets-"));
  writeFileSync(join(dir, "test-results.json"), failingTestResults());
  writeFileSync(join(dir, "logs.txt"), failingLogs());
  writeFileSync(join(dir, "check-run-data.json"), JSON.stringify({ script: "// synthetic\n", scriptPath: "checks/multistep-booking.spec.ts" }));
  const passingDir = join(dir, "passing");
  mkdirSync(passingDir, { recursive: true });
  writeFileSync(join(passingDir, "test-results.json"), passingTestResults());
  writeFileSync(join(passingDir, "logs.txt"), passingLogs());
  writeFileSync(join(passingDir, "check-run-data.json"), JSON.stringify({ script: "// synthetic\n", scriptPath: "checks/multistep-booking.spec.ts" }));
  return { dir, passingDir };
}

test("executor adapter rejects a forged JSON report without independent bridge/reporter traffic", async () => {
  const project = makeFakeProject();
  const reportFile = join(project, "fake-report.json");
  writeFileSync(reportFile, passingTestResults());
  // Even HTTPS targets are bridged. This fake CLI prints a plausible JSON
  // report but neither sends traffic nor writes the trusted audit pipe.
  const outcome = await runMultiStepSandbox({
    baseUrl: "https://fixture.invalid",
    projectDir: project,
    files: { "multistep-booking.spec.ts": SPEC_SOURCE },
    checkFile: "multistep-booking.spec.ts",
    env: { REGION: "us-east-1", MULTISTEP_USER_US_EAST_1: "synthetic-account-east" },
  });
  assert.equal(outcome.inconclusive, true, outcome.reason ?? "");
  assert.equal(outcome.passed, false);
  assert.match(outcome.reason ?? "", /zero requests/);
  assert.equal(outcome.browserProcesses, 0, "the spawned fake run was sampled, but it did not prove traffic");
  assert.deepEqual(outcome.proxyEvidence, [], "an HTTPS run is bridged, and zero requests cannot pass");
  assert.deepEqual(outcome.reporterEvidence, [], "a JSON report is not the trusted audit pipe");
  assert.deepEqual(outcome.trace.map((t) => t.outcome), ["ok", "ok", "ok", "ok", "ok"]);
  assert.equal(outcome.capture?.steps.length, 5);
  // resolved from the customer's own install only
  assert.ok(resolvePlaywrightCli(project).endsWith("cli.cjs"));
});

test("executor adapter: a bridged run where the bridge sees ZERO requests can never PASS", async () => {
  const project = makeFakeProject();
  const reportFile = join(project, "fake-report.json");
  writeFileSync(reportFile, passingTestResults());
  // http target → the trusted bridge is established, but the fake runner
  // performs no HTTP requests: bridge evidence is empty while the report
  // claims a pass. Zero-bridge evidence must be UNCERTAIN, never PASS.
  const outcome = await runMultiStepSandbox({
    baseUrl: "http://127.0.0.1:9/never-contacted",
    projectDir: project,
    files: { "multistep-booking.spec.ts": SPEC_SOURCE },
    checkFile: "multistep-booking.spec.ts",
    env: { REGION: "us-east-1", MULTISTEP_USER_US_EAST_1: "synthetic-account-east" },
  });
  assert.equal(outcome.passed, false);
  assert.equal(outcome.inconclusive, true);
  assert.match(outcome.reason ?? "", /zero requests/);
  assert.equal(outcome.proxyEvidence.length, 0, "the bridge saw no traffic");
});

test("executor adapter treats missing/corrupt reporter output as inconclusive", async () => {
  const project = makeFakeProject();
  const reportFile = join(project, "fake-report.json");
  writeFileSync(reportFile, "not json at all");
  const outcome = await runMultiStepSandbox({
    baseUrl: "http://127.0.0.1:9/",
    projectDir: project,
    files: { "multistep-booking.spec.ts": SPEC_SOURCE },
    checkFile: "multistep-booking.spec.ts",
    env: { REGION: "us-east-1", MULTISTEP_USER_US_EAST_1: "synthetic-account-east" },
  });
  assert.equal(outcome.passed, false);
  assert.equal(outcome.inconclusive, true);
  assert.match(outcome.reason ?? "", /no admissible JSON step evidence/);
});

test("readMultiStepAssets: flat files, per-result subdirs, and assets.zip", () => {
  const { dir } = writeAssetDir();
  const flat = readMultiStepAssets(dir);
  assert.ok(flat.failing?.testResults?.includes('"stats"'));
  assert.ok(flat.failing?.logs);
  // passing/ subdir exists → split layout
  assert.ok(flat.passing?.testResults?.includes("confirm transaction"));

  // assets.zip from `checkly assets download`
  const zipDir = mkdtempSync(join(tmpdir(), "verify-fix-multistep-zip-"));
  writeFileSync(join(zipDir, "assets.zip"), writeZip({
    "test-results.json": failingTestResults(),
    "check-run-data.json": JSON.stringify({ scriptPath: "x.ts" }),
    "logs.txt": failingLogs(),
  }));
  const zipped = readMultiStepAssets(zipDir);
  assert.ok(zipped.failing?.testResults);
  assert.deepEqual(zipped.failing?.missing, []);

  // missing everything → test-results reported missing
  const empty = mkdtempSync(join(tmpdir(), "verify-fix-multistep-empty-"));
  const none = readMultiStepAssets(empty);
  assert.equal(none.failing?.testResults, null);
  assert.ok(none.failing?.missing.includes("test-results.json"));
});

test("buildMultiStepRecording: missing assets or broken relationships never yield a recording", () => {
  const missing = buildMultiStepRecording({ texts: { testResults: null, checkRunData: null, logs: null } });
  assert.equal(missing.ok, false);
  assert.ok(!missing.ok && missing.problems.some((p) => p === "MULTISTEP_EVIDENCE_MISSING"));
  assert.equal(MECHANICS_ONLY_NOTE.includes("mechanics only"), true);
});

test("bundle --assets capture: sanitized recording, dependency failure point, loadable bundle", async () => {
  const project = mkdtempSync(join(tmpdir(), "verify-fix-multistep-checkly-project-"));
  mkdirSync(join(project, "checks"), { recursive: true });
  writeFileSync(join(project, "checkly.config.ts"), "export default { logicalId: 'slots-booking-multistep' }\n");
  writeFileSync(join(project, "checks", "multistep-booking.check.ts"), CONSTRUCT_SOURCE);
  writeFileSync(join(project, "checks", "multistep-booking.spec.ts"), SPEC_SOURCE);
  const { dir: assetsDir } = writeAssetDir();

  const summary = (id: string, passed: boolean, startedAt: string): CheckResultSummary => ({
    id,
    checkId: "multistep-check-id",
    name: "slots booking multistep transaction",
    hasFailures: !passed,
    hasErrors: false,
    runLocation: passed ? "us-east-1" : "eu-west-1",
    startedAt,
    stoppedAt: startedAt,
    resultType: "FINAL",
    attempts: passed ? 1 : 2,
    errorGroupIds: [],
  });
  const history = [
    summary("ms-fail-3", false, "2026-09-25T22:28:13.000Z"),
    summary("ms-fail-2", false, "2026-09-25T22:23:13.000Z"),
    summary("ms-fail-1", false, "2026-09-25T22:18:13.000Z"),
    summary("ms-pass", true, "2026-09-25T20:08:13.000Z"),
  ];
  const client = {
    calls: [],
    async getCheck() {
      return {
        id: "multistep-check-id",
        name: "slots booking multistep transaction",
        checkType: "MULTI_STEP",
        activated: true,
        muted: false,
        frequency: 5,
        locations: ["us-east-1", "eu-west-1"],
        runParallel: true,
        doubleCheck: true,
        retryStrategy: { type: "FIXED", maxRetries: 1, baseBackoffSeconds: 0, maxDurationSeconds: 600, sameRegion: false },
        tags: ["multistep"],
        groupId: null,
        runtimeId: null,
        script: SPEC_SOURCE,
        scriptPath: "multistep-booking.spec.ts",
        environmentVariables: [
          { key: "ENVIRONMENT_URL", value: FAKE_ORIGIN, secret: false },
          { key: "MULTISTEP_USER_US_EAST_1", value: FAKE_ACCOUNT, secret: true },
        ],
      };
    },
    async listResults() {
      return { entries: history, nextId: null };
    },
    async getResult(_checkId: string, id: string) {
      const base = history.find((h) => h.id === id)!;
      return {
        ...base,
        errors: id === "ms-fail-1"
          ? [{ error: { message: "Error: expect(received).toBe(expected)" }, testTitle: "slots booking multistep transaction", testFile: "multistep-booking.spec.ts" }]
          : [],
        multiStepCheckResult: { errors: [] },
      } as unknown as CheckResult;
    },
    async getAssets() {
      return { assets: [] };
    },
    async download() {
      throw new Error("download must not be called when --assets is supplied");
    },
  } as unknown as ChecklyClient;

  const out = mkdtempSync(join(tmpdir(), "verify-fix-multistep-bundle-"));
  const outcome = await buildBundle(
    { checkId: "multistep-check-id", outDir: out, projectDir: project, assetsDir, log: () => {} },
    { client, accountId: "acct", toolVersion: "0.1.0", now: () => new Date("2026-09-25T23:00:00.000Z") },
  );

  // recordings written and referenced
  assert.equal(outcome.manifest.recordings.multistepFailing, "recordings/failing.multistep.json");
  assert.equal(outcome.manifest.recordings.multistepPassing, "recordings/passing.multistep.json");
  assert.equal(outcome.manifest.multistep?.failing, null);
  assert.equal(outcome.manifest.multistep?.passing, null);

  // NO raw sensitive value in any written file (env values, account, token, origin)
  for (const file of outcome.files) {
    const text = readFileSync(join(out, file), "utf8");
    assert.ok(!text.includes(FAKE_ACCOUNT), `${file} leaks the account env value`);
    assert.ok(!text.includes(FAKE_TOKEN), `${file} leaks the token`);
    assert.ok(!text.includes(FAKE_ORIGIN), `${file} leaks the ENVIRONMENT_URL value`);
  }
  // RECURSIVE leak inspection: every file under the bundle directory,
  // listed in outcome.files or not (including .gitignore and README.md)
  const walk = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const full = join(dir, entry.name);
      return entry.isDirectory() ? walk(full) : [full];
    });
  const allFiles = walk(out);
  assert.ok(allFiles.length >= outcome.files.length, "the recursive walk sees at least the reported files");
  for (const file of allFiles) {
    const text = readFileSync(file, "utf8");
    assert.ok(!text.includes(FAKE_ACCOUNT), `${file} leaks the account env value (recursive scan)`);
    assert.ok(!text.includes(FAKE_TOKEN), `${file} leaks the token (recursive scan)`);
    assert.ok(!text.includes(FAKE_ORIGIN), `${file} leaks the ENVIRONMENT_URL value (recursive scan)`);
  }
  // local asset provenance: hash-only records for the raw inputs (hash-before-parse)
  const manifest = JSON.parse(readFileSync(join(out, "manifest.json"), "utf8"));
  const localAssets = manifest.provenance.assets.filter((a: { type: string }) => a.type === "local-asset");
  assert.ok(localAssets.length >= 2, `expected local-asset provenance entries, got ${JSON.stringify(localAssets)}`);
  assert.ok(localAssets.every((a: { sha256: string; bytes: number }) => /^[0-9a-f]{64}$/.test(a.sha256) && a.bytes > 0));
  const rawHash = createHash("sha256").update(readFileSync(join(assetsDir, "test-results.json"))).digest("hex");
  assert.ok(localAssets.some((a: { name: string; sha256: string }) => a.name === "test-results.json" && a.sha256 === rawHash), "the recorded hash matches the raw bytes that were parsed");

  // sanitized recording structure
  const recording = JSON.parse(readFileSync(join(out, "recordings", "failing.multistep.json"), "utf8"));
  assert.equal(recording.schemaVersion, "multistep-recording-v2");
  assert.equal(recording.kind, "failing");
  assert.deepEqual(recording.steps.map((s: { title: string }) => s.title), ["login", "session", "slots", "book 09:30"]);
  assert.equal(recording.transaction.token.occurrences, 3);
  assert.equal(recording.evidenceNote, MECHANICS_ONLY_NOTE);
  assert.equal(recording.recurrence.attempts, 2, "retry attempts recorded as recurrence only");

  // failure point: answered-200 request → dependency (drift), assertion bound to the stale toBe(true)
  const fp = outcome.manifest.failurePoint;
  assert.ok(fp, "failure point derived from the failing step");
  assert.equal(fp!.request, null);
  assert.equal(fp!.dependency?.method, "POST");
  assert.equal(fp!.dependency?.path, "/api/book");
  assert.equal(fp!.dependency?.passingStatus, 200);
  assert.equal(fp!.assertion?.assertionId, "assert:3b894637");
  assert.equal(fp!.action!.error, "ASSERTION_FAILED", "raw result errors are never persisted");

  // scenes: healthy + live reproduction (persistent) + inject detection
  const scenes = outcome.manifest.scenes;
  assert.deepEqual(scenes.map((s) => s.type).sort(), ["DETECTION", "HEALTHY", "REPRODUCTION"]);
  const reproduction = scenes.find((s) => s.type === "REPRODUCTION")!;
  assert.equal(reproduction.mode, "live");
  const detection = scenes.find((s) => s.type === "DETECTION")!;
  assert.equal(detection.mode, "inject:POST /api/book -> 500");
  assert.equal(detection.verdict.mustFail, true);

  // loadable as a real bundle with Multistep evidence bound
  const { bundle } = loadBundle(out);
  assert.equal(bundle.check.checkType, "MULTI_STEP");
  assert.ok(bundle.multistep);
  assert.equal(bundle.multistep!.kind, "failing");
  assert.deepEqual(bundle.multistep!.steps, ["login", "session", "slots", "book 09:30"]);
  assert.deepEqual(bundle.multistep!.problems, []);
});

test("bundle capture with missing assets records UNCERTAIN problems instead of a recording", async () => {
  const emptyAssets = mkdtempSync(join(tmpdir(), "verify-fix-multistep-noassets-"));
  const summary: CheckResultSummary = {
    id: "r1", checkId: "c1", name: "slots booking multistep transaction", hasFailures: true, hasErrors: false,
    runLocation: "us-east-1", startedAt: "2026-09-25T22:18:13.000Z", resultType: "FINAL", attempts: 2, errorGroupIds: [],
  };
  const client = {
    calls: [],
    async getCheck() {
      return { id: "c1", name: "slots booking multistep transaction", checkType: "MULTI_STEP", activated: true, muted: false, frequency: 5, locations: ["us-east-1"], tags: [], groupId: null, runtimeId: null, script: SPEC_SOURCE, scriptPath: "multistep-booking.spec.ts", environmentVariables: [] };
    },
    async listResults() { return { entries: [summary], nextId: null }; },
    async getResult() { return { ...summary, errors: ["Error: expect(received).toBe(expected)"] } as unknown as CheckResult; },
    async getAssets() { return { assets: [] }; },
    async download() { throw new Error("no download expected"); },
  } as unknown as ChecklyClient;
  const out = mkdtempSync(join(tmpdir(), "verify-fix-multistep-badbundle-"));
  const outcome = await buildBundle(
    { checkId: "c1", outDir: out, projectDir: null, assetsDir: emptyAssets, log: () => {} },
    { client, accountId: "acct", toolVersion: "0.1.0", now: () => new Date("2026-09-25T23:00:00.000Z") },
  );
  assert.equal(outcome.manifest.recordings.multistepFailing, null);
  assert.ok((outcome.manifest.multistep?.failing?.problems ?? []).some((p) => p === "MULTISTEP_EVIDENCE_MISSING"));
  assert.ok(!existsSync(join(out, "recordings", "failing.multistep.json")));
  const { bundle } = loadBundle(out);
  assert.ok(bundle.multistep?.problems.some((p) => p === "MULTISTEP_EVIDENCE_MISSING"));
});

test("report states Multistep evidence, proof distinctions, and cost fields", () => {
  const contract = {
    bundle: {
      incidentId: "slots-booking-multistep-fixture",
      check: { repo: "", file: "multistep-booking.spec.ts", logicalId: "slots-booking-multistep", checkType: "MULTI_STEP", name: "slots booking multistep transaction" },
      scenes: [],
      determinism: { targetRuns: 20, achieved: 20, sequentialPassRate: 1, overlapFailRate: 0, lastVerifiedAt: "2026-09-25T00:00:00Z" },
      envAssumptions: [],
    },
    rows: [],
    determinismGate: { blocked: false, reason: "gate passed" },
    unverifiedAssumptions: [],
    provenanceViolations: [],
    suppressionCandidates: [],
    diff: { removed: [], weakened: [], added: [], changedTarget: [], flowChanged: false },
    original: { checkFile: "x", assertions: [], steps: [], totalAssertions: 0 },
    patched: { checkFile: "x", assertions: [], steps: [], totalAssertions: 0 },
    sceneCountByType: {},
  } as unknown as ContractReport;
  const decision = {
    verdict: "UNCERTAIN" as const,
    exitCode: 2 as const,
    rows: [] as Array<{ experiment: string; environment: string; oracle: string; observed: "uncertain"; expected: "pass" | "fail"; matched: boolean; strength: number }>,
    reasons: ["multistep evidence unresolved: test-results.json asset is missing"],
    adequacy: null,
    weakness: null,
  };
  const cost = emptyExecutionCost();
  cost.localRuns = 1;
  const report = buildReport(contract, decision, new Map(), {
    cost,
    multistep: { kind: null, steps: [], problems: ["test-results.json asset is missing"] },
  });
  assert.match(report.markdown, /\*\*Multistep evidence:\*\*/);
  assert.match(report.markdown, /Evidence problems \(→ UNCERTAIN\)/);
  assert.match(report.markdown, /only exact-revision live execution can prove the candidate application repair/);
  assert.match(report.markdown, /retry attempts measure recurrence only/);
  assert.match(report.markdown, /never real Checkly, browser, deployment, or cloud proof/);
  assert.match(report.markdown, /Browser processes: 0/);
  assert.deepEqual(report.json.multistep, { kind: null, steps: [], problems: ["test-results.json asset is missing"] });
  assert.equal(report.json.verdict, "UNCERTAIN");
  assert.ok(report.json.cost);
});

test("verify-fix bundle --help documents the exact --assets syntax", () => {
  const result = spawnSync(process.execPath, [join(import.meta.dirname, "..", "..", "src", "cli.ts"), "bundle", "--help"], {
    encoding: "utf8",
    env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "" },
  });
  const output = result.stdout + result.stderr;
  assert.match(output, /verify-fix bundle --check <checkId>/);
  assert.match(output, /\[--assets <downloaded-dir>\]/);
  assert.match(output, /checkly assets download --type all --dir <dir>/);
  assert.match(output, /test-results\.json, check-run-data\.json, logs\.txt/);
  assert.match(output, /missing\/corrupt assets make the evidence UNCERTAIN/);
});

test("Mac evidence layout: the exact cp -R preparation yields the --assets shape and the capture reads all six files", async () => {
  // Mechanics only: locally constructed synthetic fixtures — never real Mac
  // evidence, never real Checkly/browser/cloud proof.
  const evidenceDir = mkdtempSync(join(tmpdir(), "verify-fix-evidence-mac-"));
  const passingExtracted = join(evidenceDir, "passing-extracted");
  const failingExtracted = join(evidenceDir, "failing-extracted");
  mkdirSync(passingExtracted, { recursive: true });
  mkdirSync(failingExtracted, { recursive: true });
  const checkRunData = JSON.stringify({ script: "// synthetic\n", scriptPath: "checks/multistep-booking.spec.ts" });
  writeFileSync(join(passingExtracted, "test-results.json"), passingTestResults());
  writeFileSync(join(passingExtracted, "check-run-data.json"), checkRunData);
  writeFileSync(join(passingExtracted, "logs.txt"), passingLogs());
  writeFileSync(join(failingExtracted, "test-results.json"), failingTestResults());
  writeFileSync(join(failingExtracted, "check-run-data.json"), checkRunData);
  writeFileSync(join(failingExtracted, "logs.txt"), failingLogs());

  // The EXACT preparation commands from the review request.
  const bundleAssets = join(evidenceDir, "bundle-assets");
  execSync(
    [
      `mkdir -p "${bundleAssets}"`,
      `cp -R "${passingExtracted}" "${bundleAssets}/passing"`,
      `cp -R "${failingExtracted}" "${bundleAssets}/failing"`,
    ].join(" && "),
    { stdio: "pipe" },
  );

  // The exact directory shape the capture must read:
  const expectedPaths = [
    join(bundleAssets, "passing", "test-results.json"),
    join(bundleAssets, "passing", "check-run-data.json"),
    join(bundleAssets, "passing", "logs.txt"),
    join(bundleAssets, "failing", "test-results.json"),
    join(bundleAssets, "failing", "check-run-data.json"),
    join(bundleAssets, "failing", "logs.txt"),
  ];
  for (const path of expectedPaths) assert.ok(existsSync(path), `missing ${path}`);

  // The capture reads all six files (the loader buildBundle uses for --assets).
  const assets = readMultiStepAssets(bundleAssets);
  assert.ok(assets.passing?.testResults?.includes('"stats"'), "passing/test-results.json read");
  assert.ok(assets.passing?.checkRunData?.includes("checks/multistep-booking.spec.ts"), "passing/check-run-data.json read");
  assert.ok(assets.passing?.logs, "passing/logs.txt read");
  assert.ok(assets.failing?.testResults?.includes('"stats"'), "failing/test-results.json read");
  assert.ok(assets.failing?.checkRunData?.includes("checks/multistep-booking.spec.ts"), "failing/check-run-data.json read");
  assert.ok(assets.failing?.logs, "failing/logs.txt read");
  assert.deepEqual(assets.failing?.missing, []);
  assert.deepEqual(assets.passing?.missing, []);
  assert.deepEqual([...(assets.failing?.found ?? [])].sort(), ["check-run-data.json", "logs.txt", "test-results.json"]);
  assert.deepEqual([...(assets.passing?.found ?? [])].sort(), ["check-run-data.json", "logs.txt", "test-results.json"]);

  // End-to-end: the full --assets capture consumes this exact shape (the
  // fake client's download() throws, so a passing run proves no re-download).
  const project = mkdtempSync(join(tmpdir(), "verify-fix-mac-layout-project-"));
  mkdirSync(join(project, "checks"), { recursive: true });
  writeFileSync(join(project, "checkly.config.ts"), "export default { logicalId: 'slots-booking-multistep' }\n");
  writeFileSync(join(project, "checks", "multistep-booking.check.ts"), CONSTRUCT_SOURCE);
  writeFileSync(join(project, "checks", "multistep-booking.spec.ts"), SPEC_SOURCE);
  const summary = (id: string, passed: boolean, startedAt: string): CheckResultSummary => ({
    id,
    checkId: "multistep-check-id",
    name: "slots booking multistep transaction",
    hasFailures: !passed,
    hasErrors: false,
    runLocation: passed ? "us-east-1" : "eu-west-1",
    startedAt,
    stoppedAt: startedAt,
    resultType: "FINAL",
    attempts: passed ? 1 : 2,
    errorGroupIds: [],
  });
  const history = [
    summary("ms-fail-1", false, "2026-09-25T22:18:13.000Z"),
    summary("ms-pass", true, "2026-09-25T20:08:13.000Z"),
  ];
  const client = {
    calls: [],
    async getCheck() {
      return {
        id: "multistep-check-id",
        name: "slots booking multistep transaction",
        checkType: "MULTI_STEP",
        activated: true,
        muted: false,
        frequency: 5,
        locations: ["us-east-1", "eu-west-1"],
        runParallel: true,
        doubleCheck: true,
        retryStrategy: { type: "FIXED", maxRetries: 1, baseBackoffSeconds: 0, maxDurationSeconds: 600, sameRegion: false },
        tags: ["multistep"],
        groupId: null,
        runtimeId: null,
        script: SPEC_SOURCE,
        scriptPath: "multistep-booking.spec.ts",
        environmentVariables: [
          { key: "ENVIRONMENT_URL", value: FAKE_ORIGIN, secret: false },
          { key: "MULTISTEP_USER_US_EAST_1", value: FAKE_ACCOUNT, secret: true },
        ],
      };
    },
    async listResults() {
      return { entries: history, nextId: null };
    },
    async getResult(_checkId: string, id: string) {
      const base = history.find((h) => h.id === id)!;
      return {
        ...base,
        errors: id === "ms-fail-1"
          ? [{ error: { message: "Error: expect(received).toBe(expected)" }, testTitle: "slots booking multistep transaction", testFile: "multistep-booking.spec.ts" }]
          : [],
        multiStepCheckResult: { errors: [] },
      } as unknown as CheckResult;
    },
    async getAssets() {
      return { assets: [] };
    },
    async download() {
      throw new Error("download must not be called when --assets is supplied with the Mac bundle-assets shape");
    },
  } as unknown as ChecklyClient;

  const out = mkdtempSync(join(tmpdir(), "verify-fix-mac-layout-bundle-"));
  const outcome = await buildBundle(
    { checkId: "multistep-check-id", outDir: out, projectDir: project, assetsDir: bundleAssets, log: () => {} },
    { client, accountId: "acct", toolVersion: "0.1.0", now: () => new Date("2026-09-25T23:00:00.000Z") },
  );
  assert.equal(outcome.manifest.recordings.multistepFailing, "recordings/failing.multistep.json");
  assert.equal(outcome.manifest.recordings.multistepPassing, "recordings/passing.multistep.json");
  const failingRecording = JSON.parse(readFileSync(join(out, "recordings", "failing.multistep.json"), "utf8"));
  const passingRecording = JSON.parse(readFileSync(join(out, "recordings", "passing.multistep.json"), "utf8"));
  assert.deepEqual(failingRecording.steps.map((s: { title: string }) => s.title), ["login", "session", "slots", "book 09:30"]);
  assert.deepEqual(passingRecording.steps.map((s: { title: string }) => s.title), ["login", "session", "slots", "book 09:30", "confirm transaction"]);
  assert.equal(failingRecording.evidenceNote, MECHANICS_ONLY_NOTE);
  const { bundle: reloaded } = loadBundle(out);
  assert.equal(reloaded.check.checkType, "MULTI_STEP");
});
