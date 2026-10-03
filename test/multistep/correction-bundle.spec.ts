// Correction batch: end-to-end local bundle capture and remote/ZIP attacks.
// All data are synthetic. No Checkly account, credential or signed URL is used.
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, symlinkSync, linkSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildBundle } from "../../src/bundle/build.ts";
import { loadBundle } from "../../src/bundle.ts";
import { buildContract } from "../../src/contract/contract.ts";
import { assessAdequacy } from "../../src/adequacy/adequacy.ts";
import type { ChecklyClient } from "../../src/checkly/client.ts";
import type { AssetManifestEntry, CheckResultSummary } from "../../src/checkly/types.ts";
import { openZip, openZipBounded, readZipEntry, listZip } from "../../src/trace/zip.ts";
import { writeZip } from "../helpers/zip-writer.ts";
import { buildMultiStepRecording, readMultiStepAssets } from "../../src/multistep/capture.ts";
import { validMultiStepStoredRecording } from "../../src/multistep/recording-schema.ts";
import { trustedMultiStepDetection } from "../../src/multistep/detection.ts";
import { readBoundedBundleFile } from "../../src/multistep/files.ts";
import { MULTISTEP_DETECTION_MODE, parseMode } from "../../src/scene/modes.ts";
import { SceneProxy } from "../../src/scene/proxy.ts";
import { SceneExecutor } from "../../src/executor/scene.ts";
import { runMultiStepSandbox, bridgeReporterMismatch } from "../../src/multistep/executor.ts";
import { normalizeMultiStepCapture } from "../../src/multistep/normalize.ts";
import { multiStepDetectionShapeProblems, multiStepShapeProblems } from "../../src/multistep/shape.ts";
import { verify, staticallyRejected } from "../../src/verify.ts";
import { DETECTION_WEB, repairedNestedSpec, startDetectionApp } from "./detection-fixture.ts";
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
/** Verified Checkly 9.5.0 manifest source scope: an OBJECT bound to the exact
 * check and result ids, never a free-form string. */
const sourceOf = (id: string): AssetManifestEntry["source"] => ({
  type: "check-result", checkId: "synthetic-check", checkName: "slots booking multistep transaction",
  checkType: "MULTI_STEP", resultId: id,
});
/** One valid archive-bundle entry of the shape `checkly assets download`
 * produces: report/log/file type, application/zip content type, archive entry. */
const entry = (name: string, id = "synthetic-fail", url?: string): AssetManifestEntry => ({
  name,
  type: name === "logs.txt" ? "log" : name === "check-run-data.json" ? "file" : "report",
  source: sourceOf(id),
  contentType: "application/zip",
  url: url ?? `https://signed.invalid/${id}.zip`,
  archive: { entryName: name },
});
interface FakeOpts {
  resultId?: string;
  checkLocations?: string[];
  fail?: CheckResultSummary;
  pass?: CheckResultSummary | null;
  remote?: (id: string) => { assets: AssetManifestEntry[]; truncated?: boolean };
  download?: (url: string, maxBytes: number) => Promise<Buffer>;
  detail?: (result: CheckResultSummary) => CheckResultSummary;
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
        privateLocations: [], tags: ["slots-booking", "verify-fix-example", "multistep"], retryStrategy: null, doubleCheck: false, runtimeId: null,
        script: SPEC, scriptPath: "multistep-booking.spec.ts",
        environmentVariables: [
          { key: "ENVIRONMENT_URL", value: FAKE_ORIGIN, secret: false },
          { key: "MULTISTEP_USER_US_EAST_1", value: FAKE_ACCOUNT, secret: true },
          { key: "MULTISTEP_USER_EU_WEST_1", value: "other-fixture", secret: true },
          { key: "VERCEL_AUTOMATION_BYPASS_SECRET", value: opts.shortSecret ? "abc" : "synthetic-protected-bypass-2910", secret: true },
        ],
      };
    },
    async listResults() { return { entries: history, nextId: null }; },
    async getResult(_checkId: string, id: string) {
      const original = history.find((r) => r.id === id)!;
      return { ...(opts.detail?.(original) ?? original),
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
/** Mock the authenticated, result-scoped asset manifest and bounded ZIP
 * download. This is synthetic remote-path proof, NEVER Checkly/cloud proof. */
async function captureRemote(opts: FakeOpts = {}, fixtureDir: string | null = null, dir = project()) {
  const zips = new Map<string, Buffer>();
  for (const [side, id] of [["failing", opts.fail?.id ?? "synthetic-fail"],
    ["passing", opts.pass?.id ?? "synthetic-pass"]] as const) {
    const files = fixtureDir ? Object.fromEntries(["test-results.json", "logs.txt", "check-run-data.json"].map((name) =>
      [name, readFileSync(join(fixtureDir, side, name))]))
      : { "test-results.json": side === "failing" ? failingTestResults() : passingTestResults(),
        "logs.txt": side === "failing" ? failingLogs() : passingLogs(),
        "check-run-data.json": JSON.stringify({ script: CANARY, scriptPath: CANARY }) };
    zips.set(id, writeZip(files));
  }
  const remote = (id: string) => ({ assets: ["test-results.json", "logs.txt", "check-run-data.json"].map((name) => ({
    ...entry(name, id, `https://signed.invalid/${id}.zip?sig=${CANARY}`),
  })) });
  return capture({ ...opts, remote: opts.remote ?? remote, download: opts.download ?? (async (url) => {
    const id = /\/(synthetic-(?:fail|pass))\.zip/.exec(url)?.[1];
    return zips.get(id ?? "") ?? Buffer.alloc(0);
  }) }, null, dir);
}

function allFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const path = join(dir, e.name);
    return e.isDirectory() ? allFiles(path) : [path];
  });
}

test("mocked remote capture stores ONLY fixed schemas/categories; results, logs, pages, trace, paths and arbitrary API details cannot leak", async () => {
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
  const out = await captureRemote({ canary: true }, assets);
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
  assert.equal(rec.schemaVersion, "multistep-recording-v3");
  assert.equal(rec.reporterStatus, "failed");
  assert.equal(rec.reporterErrors, 0);
  assert.deepEqual(rec.steps.map((step: { status: string }) => step.status), ["passed", "passed", "passed", "failed"]);
  assert.deepEqual(rec.steps.map((step: { requests: Array<{ status: number }> }) => step.requests[0]?.status), [200, 200, 200, 200]);
  assert.equal(rec.steps[3].requests[0].responseBody.confirmed, undefined);
  assert.equal(rec.steps[3].requests[0].responseBody.booking.confirmed, true);
  const provenance = out.manifest.provenance.assets.find((item) => item.result === "failing" && item.name === "test-results.json")!;
  assert.equal(provenance.type, "remote-asset");
  assert.equal(provenance.resultId, rec.binding.resultId);
  assert.equal(rec.binding.testResultsSha256, provenance.sha256);
  assert.equal(rec.binding.testResultsBytes, provenance.bytes);
  assert.equal(rec.binding.assetManifestSha256, provenance.manifestEntrySha256);
  assert.equal(out.manifest.provenance.assets.find((item) => item.name === "logs.txt")?.assetType, "log",
    "a recognized log descriptor remains optional remote evidence, not the test-results proof");
  assert.equal(rec.binding.failureAssertion.subject, "body.confirmed");
  assert.equal(rec.binding.failureAssertion.repairedSubject, "body.booking.confirmed");
  assert.equal(rec.binding.failureAssertion.negated, false);
  assert.equal(out.manifest.failurePoint?.dependency?.msBeforeStep, null, "no measured interval may be invented");
  assert.equal(out.manifest.failurePoint?.dependency?.passingStatus, null, "no passing-run status may be invented");
  assert.deepEqual(out.manifest.scenes.find((scene) => scene.type === "DETECTION")?.verdict.provenance,
    { kind: "recorded", runId: rec.binding.resultId, artifactId: "recordings/failing.multistep.json" });
  const passed = JSON.parse(readFileSync(join(out.outDir, "recordings", "passing.multistep.json"), "utf8"));
  assert.ok(validMultiStepStoredRecording(passed, "passing"));
  assert.equal(passed.binding.failureAssertion, null);
  assert.deepEqual(passed.steps.map((step: { status: string }) => step.status), ["passed", "passed", "passed", "passed", "passed"]);
  assert.deepEqual(passed.steps.slice(0, 4).map((step) => step.requests[0]?.status), [200, 200, 200, 200]);
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

  const valid = await captureRemote();
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
  const captured = await captureRemote();
  const manifestPath = join(captured.outDir, "manifest.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  assert.equal(manifest.config.runtimeId, null);
  manifest.config.runtimeId = "alternate-runtime";
  writeFileSync(manifestPath, JSON.stringify(manifest));
  assert.ok(loadBundle(captured.outDir).bundle.multistep?.problems.includes("MULTISTEP_DEPLOYED_CONFIG_MISMATCH"),
    "disk manifest runtime drift must not be silently erased when reloading evidence");
  for (const mutation of [
    (m: typeof manifest) => { m.config.shouldFail = true; },
    (m: typeof manifest) => { m.config.doubleCheck = null; },
    (m: typeof manifest) => { m.config.doubleCheck = true; },
    (m: typeof manifest) => { m.config.environmentVariables[0].extraField = true; },
    (m: typeof manifest) => { m.config.repair.extraField = true; },
  ]) {
    const poisoned = structuredClone(captured.manifest);
    mutation(poisoned);
    writeFileSync(manifestPath, JSON.stringify(poisoned));
    assert.ok(loadBundle(captured.outDir).bundle.multistep?.problems.includes("MULTISTEP_DEPLOYED_CONFIG_MISMATCH"),
      "unmodeled stored configuration must never disappear during the disk rebind");
  }
});

test("tampered, legacy, extra-field and symlinked v3 recordings are invalid rather than free-form evidence", async () => {
  for (const mutation of [
    (r: Record<string, unknown>) => { r.schemaVersion = "multistep-recording-v1"; },
    (r: Record<string, unknown>) => { (r.steps as Array<Record<string, unknown>>)[0]!.error = CANARY; },
    (r: Record<string, unknown>) => { (r.transaction as Record<string, unknown>).rawToken = CANARY; },
    (r: Record<string, unknown>) => { r.pages = [{ url: CANARY }]; },
  ]) {
    const out = await captureRemote();
    const path = join(out.outDir, "recordings", "failing.multistep.json");
    const r = JSON.parse(readFileSync(path, "utf8"));
    mutation(r);
    writeFileSync(path, JSON.stringify(r));
    const invalid = loadBundle(out.outDir).bundle.multistep;
    assert.ok(invalid?.problems.includes("MULTISTEP_FAILING_RECORDING_INVALID"));
    assert.equal(invalid?.failureAssertion, null);
  }
  const out = await captureRemote();
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
  const remote = (id: string) => ({ assets: ["test-results.json", "logs.txt"].map((name) =>
    entry(name, id, `https://signed.invalid/${id}.zip?secret=${CANARY}`)) });
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
  const valid = (name: string): AssetManifestEntry => ({ name, type: "report", source: sourceOf("synthetic-fail"), contentType: "application/zip", url: "https://signed.invalid/archive.zip", archive: { entryName: name } });
  const attacks = [
    { remote: () => ({ assets: [valid("test-results.json"), valid("test-results.json")] }), data: zip, category: "MULTISTEP_DUPLICATE_ASSET" },
    { remote: () => ({ assets: [valid("test-results.json")], truncated: true }), data: zip, category: "MULTISTEP_ASSET_MANIFEST_TRUNCATED" },
    { remote: () => ({ assets: [valid("test-results.json")] }), data: badCrc, category: "MULTISTEP_ARCHIVE_INVALID" },
    { remote: () => ({ assets: [null as unknown as AssetManifestEntry] }), data: zip, category: "MULTISTEP_ASSET_MANIFEST_INVALID" },
    { remote: () => ({ assets: [{ ...valid("test-results.json"), archive: { entryName: null as unknown as string } }] }), data: zip, category: "MULTISTEP_ASSET_MANIFEST_INVALID" },
    { remote: () => ({ assets: null as unknown as AssetManifestEntry[] }), data: zip, category: "MULTISTEP_ASSET_MANIFEST_INVALID" },
  ];
  // A string source is not the verified Checkly 9.5.0 shape: the manifest entry
  // must carry the result-scoped source OBJECT bound to this exact check/result.
  const stringSource = await capture({ pass: null, remote: () => ({ assets: [{ ...valid("test-results.json"), source: "synthetic" as unknown as AssetManifestEntry["source"] }] }), download: async () => zip }, null);
  assert.ok(stringSource.manifest.multistep?.failing?.problems.includes("MULTISTEP_ASSET_TYPE_INVALID"));
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
      ...entry(name, "synthetic-fail", `https://signed.invalid/archive-${index}.zip`),
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
  const out = await captureRemote();
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
  const zip = writeZip({ "test-results.json": failingTestResults(), "logs.txt": failingLogs() });
  const remote = (id: string) => ({ assets: ["test-results.json", "logs.txt"].map((name) =>
    entry(name, id)) });
  const buildAt = (outDir: string) => buildBundle({ checkId: "synthetic-check", outDir, projectDir: project(), log: () => {} },
    { client: fakeClient({ remote, download: async (url) => /synthetic-pass/.test(url)
      ? writeZip({ "test-results.json": passingTestResults(), "logs.txt": passingLogs() }) : zip }),
      accountId: "synthetic", now: () => new Date("2026-09-27T00:00:00.000Z") });
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
  const out = await captureRemote();
  renameSync(join(out.outDir, "check"), join(out.outDir, "original-source"));
  symlinkSync(join(out.outDir, "original-source"), join(out.outDir, "check"));
  assert.throws(() => loadBundle(out.outDir), /MULTISTEP_SOURCE_PATH_UNSAFE/);
});

test("a manifest cannot refer to an inherited property or escaping source file", async () => {
  const out = await captureRemote();
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

function resultSteps(report: Record<string, any>): Array<Record<string, any>> {
  return report.suites[0].suites[0].specs[0].tests[0].results[0].steps;
}

/** Only mocked authenticated result manifests are used. Invalid selected
 * evidence must not leave a half-written v3 recording or fallback scene. */
test("remote admission rejects prefixes, failed confirmation, malformed booking and a wrong protected source line", async () => {
  const wrongLine = JSON.parse(failingTestResults());
  resultSteps(wrongLine)[3]!.steps[1].error.message =
    "expect(received).toBe(expected) at book 09:30 (multistep-booking.spec.ts:144:24)";
  const wrongStep = JSON.parse(failingTestResults());
  resultSteps(wrongStep)[3]!.title = "session";
  const missingBody = JSON.parse(failingTestResults());
  resultSteps(missingBody)[3]!.steps[0].checklyData[0].body = null;
  const status401 = JSON.parse(failingTestResults());
  resultSteps(status401)[3]!.steps[0].checklyData[0].status = 401;
  const status500 = JSON.parse(failingTestResults());
  resultSteps(status500)[3]!.steps[0].checklyData[0].status = 500;
  const falseConfirmation = JSON.parse(failingTestResults());
  resultSteps(falseConfirmation)[3]!.steps[0].checklyData[0].body.booking.confirmed = false;
  const missingNestedVersion = JSON.parse(failingTestResults());
  delete resultSteps(missingNestedVersion)[3]!.steps[0].checklyData[0].body.booking.sessionVersion;
  const genericBookError = JSON.parse(failingTestResults());
  resultSteps(genericBookError)[3]!.steps[1].error.message = "Error: generic exception at book 09:30 (multistep-booking.spec.ts:142:24)";
  const fifth = JSON.parse(passingTestResults());
  fifth.stats.expected = 0; fifth.stats.unexpected = 1;
  fifth.suites[0].suites[0].specs[0].tests[0].results[0].status = "failed";
  resultSteps(fifth)[4]!.error = { message: "expect(received).toBe(expected)",
    stack: "at confirm transaction (multistep-booking.spec.ts:151:12)" };
  const variants: Array<[string, string, boolean]> = [
    ["failing two-request prefix", (() => { const r = JSON.parse(failingTestResults()); resultSteps(r).length = 2; return JSON.stringify(r); })(), true],
    ["HTTP 401 on fourth request", JSON.stringify(status401), true],
    ["HTTP 500 on fourth request", JSON.stringify(status500), true],
    ["false nested confirmation is not an original remote incident", JSON.stringify(falseConfirmation), true],
    ["missing nested version cannot be invented", JSON.stringify(missingNestedVersion), true],
    ["generic exception is not the protected assertion", JSON.stringify(genericBookError), true],
    ["missing book response", JSON.stringify(missingBody), true],
    ["mismatched failed step", JSON.stringify(wrongStep), true],
    ["wrong source assertion line", JSON.stringify(wrongLine), true],
    ["failed fifth confirmation", JSON.stringify(fifth), false],
  ];
  for (const [label, report, failing] of variants) {
    const failZip = writeZip({ "test-results.json": failing ? report : failingTestResults(),
      "logs.txt": failingLogs(), "check-run-data.json": "{}" });
    const passZip = writeZip({ "test-results.json": failing ? passingTestResults() : report,
      "logs.txt": passingLogs(), "check-run-data.json": "{}" });
    const out = await captureRemote({ download: async (url) => url.includes("synthetic-fail.zip") ? failZip : passZip });
    const side = failing ? "failing" : "passing";
    const pointer = side === "failing" ? out.manifest.recordings.multistepFailing : out.manifest.recordings.multistepPassing;
    assert.equal(pointer, null, `${label}: never write an invalid side's recording`);
    assert.ok(!out.files.includes(`recordings/${side}.multistep.json`), `${label}: no partial recording file`);
    const loaded = loadBundle(out.outDir).bundle;
    assert.ok(loaded.multistep?.problems.length, `${label}: not admissible for a verdict`);
    assert.equal(loaded.multistep?.failureAssertion, null, `${label}: cannot narrow the repair`);
    if (failing) {
      assert.equal(out.manifest.failurePoint, null, `${label}: never derive a generic failure point`);
      assert.deepEqual(out.manifest.scenes, [], `${label}: no passing-side scene fallback for a failing incident`);
    }
  }
});

test("v3 binding is mandatory and remote-only: v2 plus a binding, local hashes, unknown asset types and ID swaps cannot prove detection", async () => {
  const local = await capture({}, assetDir());
  assert.equal(local.manifest.recordings.multistepFailing, null);
  assert.equal(local.manifest.failurePoint, null);
  assert.ok(local.manifest.multistep?.failing?.problems.includes("MULTISTEP_MECHANICS_ONLY"));
  const bound = await captureRemote();
  const file = join(bound.outDir, "recordings", "failing.multistep.json");
  const initial = JSON.parse(readFileSync(file, "utf8"));
  const legacy = { ...initial, schemaVersion: "multistep-recording-v2" }; // even a real-shaped binding cannot upgrade v2
  assert.equal(validMultiStepStoredRecording(legacy, "failing"), false);
  writeFileSync(file, JSON.stringify(legacy));
  assert.ok(loadBundle(bound.outDir).bundle.multistep?.problems.includes("MULTISTEP_FAILING_RECORDING_INVALID"));
  writeFileSync(file, JSON.stringify(initial));
  const manifestPath = join(bound.outDir, "manifest.json");
  const original = readFileSync(manifestPath, "utf8");
  const attacks: Array<[string, (m: Record<string, any>) => void]> = [
    ["unknown asset type", (m) => { m.provenance.assets[0].type = "unrecognized-asset"; }],
    ["local test-results hash in place of remote", (m) => { m.provenance.assets.find((a: any) => a.result === "failing" && a.name === "test-results.json").type = "local-asset"; }],
    ["result-scoped asset ID swapped", (m) => { m.provenance.assets.find((a: any) => a.result === "failing" && a.name === "test-results.json").resultId = m.results.passing.id; }],
    ["manifest entry digest swapped", (m) => { m.provenance.assets.find((a: any) => a.result === "failing" && a.name === "test-results.json").manifestEntrySha256 = "0".repeat(64); }],
    ["failing and passing result IDs swapped", (m) => { const id = m.results.failing.id; m.results.failing.id = m.results.passing.id; m.results.passing.id = id; }],
    ["unknown unrelated provenance asset", (m) => { m.provenance.assets.push({ result: "failing", name: "arbitrary.bin", type: "mystery", bytes: 1, sha256: "0".repeat(64) }); }],
  ];
  for (const [label, mutate] of attacks) {
    const m = JSON.parse(original);
    mutate(m);
    writeFileSync(manifestPath, JSON.stringify(m));
    const loaded = loadBundle(bound.outDir).bundle;
    assert.ok(loaded.multistep?.problems.length, label);
    assert.equal(loaded.multistep?.failureAssertion, null, `${label}: no proven exception`);
  }
  writeFileSync(manifestPath, original);
  const metadata = join(bound.outDir, "results", "failing.json");
  const stored = readFileSync(metadata, "utf8");
  const contradictory = { ...JSON.parse(stored), hasFailures: false };
  writeFileSync(metadata, JSON.stringify(contradictory));
  assert.ok(loadBundle(bound.outDir).bundle.multistep?.problems.includes("MULTISTEP_FAILING_RECORDING_INVALID"),
    "a matching ID alone cannot hide a contradictory result-detail outcome");
  writeFileSync(metadata, stored);
  const v3 = JSON.parse(readFileSync(file, "utf8"));
  v3.binding.resultId = bound.manifest.results.passing!.id;
  writeFileSync(file, JSON.stringify(v3));
  assert.ok(loadBundle(bound.outDir).bundle.multistep?.problems.includes("MULTISTEP_FAILING_RECORDING_INVALID"));
});

test("unknown remote manifest asset types and deployed-source drift fail before v3 finalization", async () => {
  const remote = (id: string) => ({ assets: [{ name: "test-results.json", type: "unknown" as "report",
    source: sourceOf(id), url: `https://signed.invalid/${id}/report` }] });
  const unknown = await captureRemote({ remote, download: async () => { throw new Error("invalid types must not be downloaded"); } });
  assert.equal(unknown.manifest.recordings.multistepFailing, null);
  assert.ok(unknown.manifest.multistep?.failing?.problems.includes("MULTISTEP_ASSET_TYPE_INVALID"));
  assert.equal(unknown.manifest.failurePoint, null);
  assert.deepEqual(unknown.manifest.scenes, []);
  const contradictory = await captureRemote({ detail: (result) => result.hasFailures
    ? { ...result, resultType: "ATTEMPT" } : result });
  assert.equal(contradictory.manifest.recordings.multistepFailing, null,
    "the authenticated result detail must describe the selected FINAL run");
  assert.equal(contradictory.manifest.failurePoint, null);
  assert.deepEqual(contradictory.manifest.scenes, []);
  const drift = project();
  writeFileSync(join(drift, FILE), SPEC.replace("expect(body.confirmed).toBe(true)", "expect(body.booking.confirmed).toBe(true)"));
  const mismatch = await captureRemote({}, null, drift);
  assert.equal(mismatch.manifest.recordings.multistepFailing, null);
  assert.ok(mismatch.manifest.multistep?.failing?.problems.includes("MULTISTEP_SOURCE_PROJECT_MISMATCH"));
  assert.equal(loadBundle(mismatch.outDir).bundle.multistep?.failureAssertion, null);
});

test("exact output tree and full preflight secret scan reject stale files before any recapture write", async () => {
  const zipFail = writeZip({ "test-results.json": failingTestResults(), "logs.txt": failingLogs() });
  const zipPass = writeZip({ "test-results.json": passingTestResults(), "logs.txt": passingLogs() });
  const remote = (id: string) => ({ assets: ["test-results.json", "logs.txt"].map((name) =>
    entry(name, id)) });
  const buildAt = (outDir: string) => buildBundle({ checkId: "synthetic-check", outDir, projectDir: project(), log: () => {} },
    { client: fakeClient({ remote, download: async (url) => url.includes("synthetic-fail") ? zipFail : zipPass }), accountId: "synthetic" });
  const dir = mkdtempSync(join(tmpdir(), "verify-fix-output-tree-exact-"));
  const outcome = await buildAt(dir);
  assert.deepEqual(allFiles(dir).map((path) => path.slice(dir.length + 1)).sort(), [...outcome.files].sort(),
    "postflight output contains exactly the allowed files");
  const stale = join(dir, "results", "stale.json");
  writeFileSync(stale, "test-only stale file");
  const before = readFileSync(join(dir, "manifest.json"), "utf8");
  await assert.rejects(buildAt(dir), /MULTISTEP_OUTPUT_PATH_UNSAFE/);
  assert.equal(readFileSync(join(dir, "manifest.json"), "utf8"), before, "no file truncated before preflight");
  const { unlinkSync } = await import("node:fs");
  unlinkSync(stale);
  const planted = join(dir, "README.md");
  writeFileSync(planted, `stale ${FAKE_TOKEN}`);
  await assert.rejects(buildAt(dir), /it contains the value of a Checkly environment variable/);
  assert.equal(readFileSync(join(dir, "manifest.json"), "utf8"), before);
  unlinkSync(planted);
  await buildAt(dir);
  assert.deepEqual(loadBundle(dir).bundle.multistep?.problems, [], "bounded recapture restores a missing allowed file");
  assert.deepEqual(allFiles(dir).map((path) => path.slice(dir.length + 1)).sort(), [...outcome.files].sort());
});

// All detection tests below use a mocked *authenticated remote asset path*
// plus a local HTTP app. They prove verifier mechanics only, not Checkly,
// browser, deployment, production or cloud evidence.
const DETECTION_EAST = "synthetic-detection-east";
const DETECTION_WEST = "synthetic-detection-west";
const DETECTION_ENV = { MULTISTEP_USER_US_EAST_1: DETECTION_EAST, MULTISTEP_USER_EU_WEST_1: DETECTION_WEST,
  CHECKLY_SECRET_VERCEL_AUTOMATION_BYPASS_SECRET: "synthetic-bypass-only-7392" };

test("remote-bound HTTP-200 nested confirmation mutation is one field and the repaired candidate fails on THAT line in both regions", { timeout: 180_000 }, async () => {
  const out = await captureRemote();
  const bundle = loadBundle(out.outDir).bundle;
  const detection = bundle.scenes.find((scene) => scene.type === "DETECTION")!;
  assert.deepEqual(bundle.multistep?.problems, []);
  assert.equal(detection.mode, MULTISTEP_DETECTION_MODE);
  assert.deepEqual(detection.verdict.provenance, {
    kind: "recorded", runId: "synthetic-fail", artifactId: "recordings/failing.multistep.json",
  });
  const patch = repairedNestedSpec();
  assert.equal(staticallyRejected(bundle, patch), null, "all seven booked-field assertions move to their bound nested equivalents");
  const diff = buildContract(bundle, patch).diff;
  assert.equal(diff.removed.filter((item) => item.onCriticalPath).length, 0);
  assert.ok(diff.removed.some((item) => item.subject === "body.confirmed"));
  assert.ok(diff.added.some((item) => item.subject === "body.booking.confirmed"));
  const app = await startDetectionApp();
  const runs: Array<{ sceneId: string; hits: Array<{ method: string; path: string; status: number; source: string }> }> = [];
  const executor = new SceneExecutor({ target: app.origin, projectDir: DETECTION_WEB, env: DETECTION_ENV,
    maxRunsPerScene: 1, onRepetition: (value) => runs.push(value) });
  try {
    const reproduced = await executor.runScene(bundle, patch, bundle.scenes.find((scene) => scene.type === "REPRODUCTION")!);
    assert.equal(reproduced.observed, "pass", reproduced.reason ?? "");
    const detected = await executor.runScene(bundle, patch, detection);
    assert.equal(detected.observed, "fail", detected.reason ?? JSON.stringify(detected.trace));
    assert.equal(detected.repetitions, 1);
    assert.deepEqual(runs.filter((item) => item.sceneId === "detection").flatMap((item) => item.hits.map((hit) => [hit.method, hit.path, hit.status, hit.source])), [
      ["POST", "/api/login", 200, "target"], ["GET", "/api/session", 200, "target"],
      ["GET", "/api/slots", 200, "target"], ["POST", "/api/book", 200, "injected"],
      ["POST", "/api/login", 200, "target"], ["GET", "/api/session", 200, "target"],
      ["GET", "/api/slots", 200, "target"], ["POST", "/api/book", 200, "injected"],
    ]);
    assert.deepEqual(app.accounts.filter((account) => [DETECTION_EAST, DETECTION_WEST].includes(account)).sort(),
      [DETECTION_EAST, DETECTION_WEST, DETECTION_EAST, DETECTION_WEST].sort());
    assert.deepEqual(executor.costReport().multiStepBrowserCounts, [0, 0, 0, 0]);
  } finally {
    await executor.close();
    await app.close();
  }
});

test("full synthetic Stage 7 verdict reaches PASS only with remote-bound HTTP-200 detection, five healthy repetitions, and unweakened nested assertions", { timeout: 240_000 }, async () => {
  const out = await captureRemote();
  // SYNTHETIC decision fixture: write the decision-law prerequisites to the
  // local fixture manifest, then re-load it. This is NOT a real measurement;
  // a mutable in-memory override must not borrow on-disk remote authority.
  const manifestPath = join(out.outDir, "manifest.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  manifest.determinism.measured = true;
  manifest.determinism.method = "local-runner";
  manifest.determinism.sequential = { runs: 20, passed: 20, passRate: 1, sessions: [] };
  manifest.determinism.overlap = { pairs: 20, pairsWithFailure: 20, failRate: 1, sessions: [] };
  manifest.determinism.lastVerifiedAt = "2026-09-27T00:00:00.000Z";
  manifest.envAssumptions = manifest.envAssumptions.map((item: { verified: boolean }) => ({ ...item, verified: true }));
  writeFileSync(manifestPath, JSON.stringify(manifest));
  const bundle = loadBundle(out.outDir).bundle;
  assert.deepEqual(bundle.multistep?.problems, []);
  const app = await startDetectionApp();
  try {
    const result = await verify({ bundle, patch: repairedNestedSpec(), target: app.origin,
      projectDir: DETECTION_WEB, env: DETECTION_ENV, maxRunsPerScene: 25 });
    assert.deepEqual([...result.observations].map(([id, item]) => [id, item.observed]), [
      ["reproduction", "pass"], ["detection", "fail"], ["healthy-live", "pass"],
    ], result.decision.reasons.join("; "));
    assert.equal(result.observations.get("healthy-live")?.repetitions, 5);
    assert.equal(result.decision.verdict, "PASS", result.decision.reasons.join("; "));
    assert.equal(result.decision.exitCode, 0);
    assert.equal(result.contract.diff.removed.filter((item) => item.onCriticalPath).length, 0);
    assert.ok(result.mutants.length >= 2 && result.mutants.every((mutant) => !mutant.survived));
    assert.ok(result.cost.multiStepBrowserCounts?.every((count) => count === 0));
    assert.ok((result.cost.httpRequests ?? 0) >= 4 * 2 * (5 + 5 + 5));
  } finally {
    await app.close();
  }
});

test("passing-only/local/missing v3 provenance and caller-selected injection cannot arm detection", async () => {
  const remote = await captureRemote();
  const bundle = loadBundle(remote.outDir).bundle;
  const scene = bundle.scenes.find((item) => item.type === "DETECTION")!;
  const local = await capture({}, assetDir());
  const localBundle = loadBundle(local.outDir).bundle;
  const pretendPassing = { ...scene, verdict: { ...scene.verdict,
    provenance: { kind: "recorded" as const, runId: "synthetic-pass", artifactId: "recordings/passing.multistep.json" } } };
  const cases = [
    { label: "locally captured evidence", bundle: { ...localBundle, scenes: [scene] }, scene },
    { label: "passing side substituted for failing", bundle, scene: pretendPassing },
    { label: "missing failing binding", bundle: { ...bundle, multistep: null }, scene },
    { label: "old HTTP 500 mode", bundle, scene: { ...scene, mode: "inject:POST /api/book -> 500" } },
    { label: "arbitrary HTTP 200 injection", bundle, scene: { ...scene, mode: "inject:POST /api/book -> 200" } },
    { label: "arbitrary route", bundle, scene: { ...scene, mode: "inject:GET /api/slots -> 200" } },
    { label: "caller-selected body field", bundle, scene: { ...scene, mode: "detect:POST /api/book -> 200:booking.status=WRONG" } },
  ];
  for (const item of cases) {
    const executor = new SceneExecutor({ target: "http://127.0.0.1:1", projectDir: DETECTION_WEB, env: DETECTION_ENV });
    try {
      const observation = await executor.runScene(item.bundle, repairedNestedSpec(), item.scene);
      assert.equal(observation.observed, "uncertain", item.label);
      assert.equal(observation.repetitions, 0, `${item.label}: preflight must not start the child or proxy`);
      assert.equal(executor.costReport().localRuns, 0, item.label);
    } finally { await executor.close(); }
  }
  const direct = await runMultiStepSandbox({ projectDir: DETECTION_WEB, baseUrl: "http://127.0.0.1:1",
    files: { ...bundle.files, [FILE]: repairedNestedSpec() }, originalFiles: bundle.files, checkFile: FILE,
    env: { REGION: "us-east-1", ...DETECTION_ENV },
    detection: { bundle: { ...bundle, multistep: null }, scene } });
  assert.equal(direct.inconclusive, true);
  assert.equal(direct.environmentOrigin, null, "direct adapter cannot self-declare detection provenance");
});

test("detection cannot invent a nested response, coerce HTTP 500, change an upstream fact, or leak target secrets", { timeout: 180_000 }, async () => {
  const out = await captureRemote();
  const bundle = loadBundle(out.outDir).bundle;
  const scene = bundle.scenes.find((item) => item.type === "DETECTION")!;
  for (const [label, options] of [
    ["HTTP 500", { bookStatus: 500 }],
    ["flat response", { flat: true }],
    ["target already reports false", { bookConfirmed: false }],
    ["wrong live version", { versionMismatch: true }],
    ["wrong live account", { accountMismatch: true }],
    ["unapproved body field", { extraBookField: CANARY }],
    ["oversized upstream response", { extraBookField: "synthetic-padding".repeat(2048) }],
  ] as const) {
    const app = await startDetectionApp(options);
    const executor = new SceneExecutor({ target: app.origin, projectDir: DETECTION_WEB, env: DETECTION_ENV,
      maxRunsPerScene: 1 });
    try {
      const result = await executor.runScene(bundle, repairedNestedSpec(), scene);
      assert.equal(result.observed, "uncertain", `${label}: ${result.reason ?? ""}`);
      assert.ok(result.reason && !result.reason.includes(CANARY) && !result.reason.includes(DETECTION_EAST));
      assert.ok(!JSON.stringify(result).includes(CANARY), `${label}: never serialize the upstream secret`);
      assert.equal(executor.costReport().httpRequests, 4, `${label}: no later request or confirmed detection`);
    } finally {
      await executor.close();
      await app.close();
    }
  }
});

test("candidate failures on another assertion, in confirmation, or via negation are not conclusive detection", { timeout: 180_000 }, async () => {
  const out = await captureRemote();
  const bundle = loadBundle(out.outDir).bundle;
  const scene = bundle.scenes.find((item) => item.type === "DETECTION")!;
  const patch = repairedNestedSpec();
  const variants = [
    ["wrong hard assertion inside book", patch.replace("expect(body.booking.confirmed).toBe(true)",
      "expect(body.booking.status).toBe('WRONG')\n    expect(body.booking.confirmed).toBe(true)")],
    ["assertion delayed until confirmation", patch.replace("expect(body.booking.confirmed).toBe(true)",
      "expect(body.booking.confirmed).toBe(false)")],
    ["negated confirmation", patch.replace("expect(body.booking.confirmed).toBe(true)",
      "expect(body.booking.confirmed).not.toBe(true)")],
  ] as const;
  for (const [label, candidate] of variants) {
    const app = await startDetectionApp();
    const executor = new SceneExecutor({ target: app.origin, projectDir: DETECTION_WEB, env: DETECTION_ENV,
      maxRunsPerScene: 1 });
    try {
      const result = await executor.runScene(bundle, candidate, scene);
      assert.equal(result.observed, "uncertain", `${label}: ${result.reason ?? ""}`);
      assert.ok(result.reason, label);
    } finally {
      await executor.close();
      await app.close();
    }
  }
  assert.match(staticallyRejected(bundle, variants[2]![1]) ?? "", /core-path assertion/,
    "negation cannot retain a colliding ID as a strong repair");
});

test("JSON request audit admits ONLY the trusted local false confirmation; remote shape and bridge contradictions stay strict", () => {
  const raw = JSON.parse(failingTestResults());
  resultSteps(raw)[3]!.steps[0].checklyData[0].body.booking.confirmed = false;
  const capture = normalizeMultiStepCapture({ testResults: JSON.stringify(raw), reporterOnly: true });
  assert.deepEqual(capture.problems, []);
  assert.ok(multiStepShapeProblems(capture).length > 0, "remote admission never accepts the local false outcome");
  assert.deepEqual(multiStepDetectionShapeProblems(capture), [], "only the fixed nested boolean differs");
  const routes = [["POST", "/api/login", "login"], ["GET", "/api/session", "session"],
    ["GET", "/api/slots", "slots"], ["POST", "/api/book", "book 09:30"]] as const;
  const bridge = routes.map(([method, path], i) => ({ index: i + 1, method, path, status: 200,
    queryKeys: [], requestHeaderNames: i === 1 || i === 3 ? ["authorization", "x-vercel-protection-bypass"] : ["x-vercel-protection-bypass"],
    authorization: i === 1 || i === 3 }));
  const audit = routes.map(([method, path, step]) => ({ method, path, step, originMatches: true, hasQuery: false }));
  assert.equal(bridgeReporterMismatch(bridge, capture, audit, FAKE_ORIGIN, true), null);
  assert.match(bridgeReporterMismatch(bridge, capture, audit, FAKE_ORIGIN) ?? "", /JSON response evidence/);
  assert.match(bridgeReporterMismatch(bridge, capture, null, FAKE_ORIGIN, true) ?? "", /dedicated request audit/);
  const badBridge = bridge.map((row, i) => i === 3 ? { ...row, status: 500 } : row);
  assert.match(bridgeReporterMismatch(badBridge, capture, audit, FAKE_ORIGIN, true) ?? "", /status mismatch|HTTP status/);
  const badAudit = audit.map((row, i) => i === 3 ? { ...row, path: "/api/slots" } : row);
  assert.match(bridgeReporterMismatch(bridge, capture, badAudit, FAKE_ORIGIN, true) ?? "", /disagree|transaction sequence/);
  for (const change of [
    (draft: typeof capture) => { draft.steps[3]!.requests[0]!.responseBody = { booking: { confirmed: false } }; },
    (draft: typeof capture) => { (draft.steps[3]!.requests[0]!.responseBody as Record<string, unknown>).extra = CANARY; },
    (draft: typeof capture) => { draft.steps[3]!.requests[0]!.status = 500; },
    (draft: typeof capture) => { draft.steps[3]!.status = "passed"; },
    (draft: typeof capture) => { draft.steps.push({ title: "confirm transaction", status: "passed",
      error: null, requests: [], assertions: [] }); },
  ]) {
    const draft = JSON.parse(JSON.stringify(capture)) as typeof capture;
    change(draft);
    assert.ok(bridgeReporterMismatch(bridge, draft, audit, FAKE_ORIGIN, true), "changed JSON cannot override four trusted HTTP-200 hits");
  }
});

test("fixed proxy mutation changes exactly booking.confirmed on a completed HTTP-200 transaction (mechanics only)", async () => {
  // This directly tests the response bytes. Only SceneExecutor may set the
  // proxy capability for a verdict, after trustedMultiStepDetection reloads
  // the failing remote v3 bundle; this standalone proxy test is not proof.
  const remote = await captureRemote();
  const diskBundle = loadBundle(remote.outDir).bundle;
  const boundScene = diskBundle.scenes.find((s) => s.type === "DETECTION")!;
  const capability = trustedMultiStepDetection(diskBundle, boundScene);
  assert.ok(capability, "even synthetic mutation mechanics require a rebound failing-side capability");
  const app = await startDetectionApp({ bookHeaders: { "set-cookie": `session=${CANARY}`, "x-private": CANARY } });
  const proxy = new SceneProxy();
  try {
    const [origin] = await proxy.arm({ mode: parseMode(MULTISTEP_DETECTION_MODE), target: app.origin,
      runs: 1, trustedMultiStepDetection: capability! });
    const account = DETECTION_EAST;
    const login = await fetch(`${origin}/api/login`, { method: "POST",
      headers: { "content-type": "application/json" }, body: JSON.stringify({ account }) });
    const loginBody = await login.json() as { token: string; version: number };
    assert.equal(login.status, 200);
    const session = await fetch(`${origin}/api/session`, { headers: { authorization: `Bearer ${loginBody.token}` } });
    assert.equal(session.status, 200); await session.text();
    const slots = await fetch(`${origin}/api/slots`);
    assert.equal(slots.status, 200); await slots.text();
    const booked = await fetch(`${origin}/api/book`, { method: "POST",
      headers: { authorization: `Bearer ${loginBody.token}`, "content-type": "application/json" },
      body: JSON.stringify({ slot: "09:30" }) });
    assert.equal(booked.status, 200);
    assert.equal(booked.headers.get("content-type"), "application/json");
    assert.equal(booked.headers.get("set-cookie"), null);
    assert.equal(booked.headers.get("x-private"), null);
    const mutatedBytes = await booked.text();
    assert.equal(booked.headers.get("content-length"), String(Buffer.byteLength(mutatedBytes)));
    assert.deepEqual(JSON.parse(mutatedBytes), { booking: { confirmed: false, status: "CONFIRMED",
      account, slot: "09:30", sessionVersion: loginBody.version } });
    assert.deepEqual(proxy.hits().map((hit) => [hit.ordinal, hit.path, hit.status, hit.source]), [
      [1, "/api/login", 200, "target"], [2, "/api/session", 200, "target"],
      [3, "/api/slots", 200, "target"], [4, "/api/book", 200, "injected"],
    ]);
    assert.deepEqual(app.paths, ["POST /api/login", "GET /api/session", "GET /api/slots", "POST /api/book"]);
  } finally {
    await proxy.close();
    await app.close();
  }
});

test("proxy refuses forged capability, query-bearing routes and excess calls without mutating target bytes or leaking query", async () => {
  const remote = await captureRemote();
  const bundle = loadBundle(remote.outDir).bundle;
  const scene = bundle.scenes.find((s) => s.type === "DETECTION")!;
  const capability = trustedMultiStepDetection(bundle, scene);
  assert.ok(capability);
  const app = await startDetectionApp();
  const proxy = new SceneProxy();
  try {
    await assert.rejects(proxy.arm({ mode: parseMode(MULTISTEP_DETECTION_MODE), target: app.origin,
      runs: 1, trustedMultiStepDetection: { ...capability! } }), /SCENE_PROXY_DETECTION_AUTHORITY_MISSING/);
    const [origin] = await proxy.arm({ mode: parseMode(MULTISTEP_DETECTION_MODE), target: app.origin,
      runs: 1, trustedMultiStepDetection: capability! });
    const login = await fetch(`${origin}/api/login`, { method: "POST",
      headers: { "content-type": "application/json" }, body: JSON.stringify({ account: DETECTION_EAST }) });
    const { token } = await login.json() as { token: string };
    await (await fetch(`${origin}/api/session`, { headers: { authorization: `Bearer ${token}` } })).text();
    await (await fetch(`${origin}/api/slots`)).text();
    const queryCanary = "sensitive-query-not-evidence";
    const forged = await fetch(`${origin}/api/book?nonce=${queryCanary}`, { method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ slot: "09:30" }) });
    assert.equal(forged.status, 400, "query-bearing request is not the canonical fourth call");
    assert.equal(app.paths.length, 3, "forged fourth call never reaches the target");
    const overflow = await fetch(`${origin}/api/book`, { method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ slot: "09:30" }) });
    assert.equal(overflow.status, 400, "a fifth call cannot borrow the fourth ordinal");
    assert.ok(!JSON.stringify(proxy.hits()).includes(queryCanary));
    assert.equal(proxy.hits().length, 5, "request-evidence list is bounded");
    await (await fetch(`${origin}/api/book?nonce=${queryCanary}`, { method: "POST" })).text();
    assert.equal(proxy.hits().length, 5, "unbounded additional traffic does not grow evidence");
    assert.ok(proxy.hits().every((hit) => hit.source !== "injected"));
  } finally {
    await proxy.close();
    await app.close();
  }
});

test("only remote/source-bound Multistep evidence recognizes two concrete boundary checks; version range remains weak", async () => {
  const out = await captureRemote();
  const bundle = loadBundle(out.outDir).bundle;
  const adequacyOf = (input: typeof bundle) => assessAdequacy({
    contract: buildContract(input, repairedNestedSpec()), sceneObservations: new Map(), mutants: [],
  }).weakness.weakAssertions;
  const proven = adequacyOf(bundle);
  assert.equal(proven.length, 1);
  assert.match(proven[0]!.reason, /toBeGreaterThan/);
  const unproven = adequacyOf({ ...bundle, multistep: null });
  assert.equal(unproven.length, 3, "a local/self-declared bundle cannot silently strengthen weak assertions");
  const borrowed = adequacyOf({ ...bundle, scenes: bundle.scenes.map((scene) => scene.type === "DETECTION"
    ? { ...scene, verdict: { ...scene.verdict, provenance: { kind: "recorded" as const,
      runId: "synthetic-pass", artifactId: "recordings/passing.multistep.json" } } } : scene) });
  assert.equal(borrowed.length, 3, "the passing side cannot supply failing-side adequacy proof");
});

test("semantic fault stays an HTTP-200 nested booking response with the ORIGINAL stale assertion failing before confirmation", { timeout: 180_000 }, async () => {
  const app = await startDetectionApp();
  try {
    const result = await runMultiStepSandbox({ projectDir: DETECTION_WEB, baseUrl: app.origin,
      files: { [FILE]: SPEC }, checkFile: FILE,
      env: { REGION: "us-east-1", ...DETECTION_ENV } });
    assert.equal(result.inconclusive, false, result.reason ?? "");
    assert.equal(result.passed, false);
    assert.deepEqual(result.capture?.steps.map((step) => [step.title, step.status]), [
      ["login", "passed"], ["session", "passed"], ["slots", "passed"], ["book 09:30", "failed"],
    ]);
    assert.equal(result.capture?.steps[3]?.failureLine, 142, "source-bound stale body.confirmed assertion");
    assert.deepEqual(result.proxyEvidence.map((request) => request.status), [200, 200, 200, 200]);
    assert.ok(!JSON.stringify(result.trace).includes(DETECTION_EAST), "local traces never contain the account value");
    assert.equal(result.browserProcesses, 0);
  } finally { await app.close(); }
});

test("remote-bound detection rejects altered in-memory authority and hardlinked/escaping bundle bytes", async () => {
  const out = await captureRemote();
  const bundle = loadBundle(out.outDir).bundle;
  const scene = bundle.scenes.find((entry) => entry.type === "DETECTION")!;
  assert.ok(trustedMultiStepDetection(bundle, scene));
  assert.equal(trustedMultiStepDetection({ ...bundle, check: { ...bundle.check, name: "synthetic-tamper" } }, scene), null);
  assert.equal(trustedMultiStepDetection({ ...bundle, scenes: bundle.scenes.map((entry) =>
    entry.type === "REPRODUCTION" ? { ...entry, description: "synthetic-tamper" } : entry) }, scene), null);
  assert.equal(trustedMultiStepDetection({ ...bundle, files: { ...bundle.files, [FILE]: SPEC + "\n// synthetic-tamper" } }, scene), null);

  const target = join(out.outDir, "recordings", "failing.multistep.json");
  const bytes = readFileSync(target);
  const outside = mkdtempSync(join(tmpdir(), "verify-fix-untrusted-hardlink-"));
  const outer = join(outside, "recording.json");
  writeFileSync(outer, bytes);
  unlinkSync(target);
  linkSync(outer, target);
  assert.ok(loadBundle(out.outDir).bundle.multistep?.problems.includes("MULTISTEP_FAILING_RECORDING_INVALID"));
  assert.equal(trustedMultiStepDetection(bundle, scene), null);
  unlinkSync(target);
  writeFileSync(target, bytes);
  assert.ok(trustedMultiStepDetection(bundle, scene));

  const storedDir = join(outside, "recordings");
  renameSync(join(out.outDir, "recordings"), storedDir);
  symlinkSync(storedDir, join(out.outDir, "recordings"), "dir");
  assert.ok(loadBundle(out.outDir).bundle.multistep?.problems.includes("MULTISTEP_FAILING_RECORDING_INVALID"));
  assert.equal(trustedMultiStepDetection(bundle, scene), null, "parent symlink cannot redirect a fixed recording path");
  unlinkSync(join(out.outDir, "recordings"));
  renameSync(storedDir, join(out.outDir, "recordings"));
  assert.ok(trustedMultiStepDetection(bundle, scene));

  const manifest = join(out.outDir, "manifest.json");
  const source = join(outside, "manifest.json");
  writeFileSync(source, readFileSync(manifest));
  unlinkSync(manifest);
  linkSync(source, manifest);
  assert.throws(() => loadBundle(out.outDir), /MULTISTEP_BUNDLE_FILE_UNSAFE/);
  assert.equal(trustedMultiStepDetection(bundle, scene), null);
  unlinkSync(manifest);
  writeFileSync(manifest, readFileSync(source));
  assert.throws(() => readBoundedBundleFile(out.outDir, "recordings/failing.multistep.json", 16),
    /MULTISTEP_BUNDLE_FILE_UNSAFE/, "the bytes budget applies before parsing");
});

test("scene executor isolates mixed protected env-file inputs; direct Multistep child still rejects unrelated keys", { timeout: 60_000 }, async () => {
  const out = await captureRemote();
  const bundle = loadBundle(out.outDir).bundle;
  const app = await startDetectionApp();
  const mixed = { ...DETECTION_ENV, TEST_USER: "synthetic-browser-user", API_TOKEN: "synthetic-api-token",
    CHECKLY_SECRET_VERCEL_AUTOMATION_BYPASS_SECRET: "synthetic-bypass" };
  const executor = new SceneExecutor({ target: app.origin, projectDir: DETECTION_WEB, env: mixed,
    maxRunsPerScene: 1 });
  try {
    const scene = bundle.scenes.find((entry) => entry.type === "REPRODUCTION")!;
    const observation = await executor.runScene(bundle, repairedNestedSpec(), scene);
    assert.equal(observation.observed, "pass", observation.reason ?? "");
    assert.ok(!JSON.stringify(observation).includes(mixed.API_TOKEN));
    assert.ok(!JSON.stringify(observation).includes(mixed.TEST_USER));
    const direct = await runMultiStepSandbox({ projectDir: DETECTION_WEB, baseUrl: app.origin,
      files: { ...bundle.files, [FILE]: repairedNestedSpec() }, originalFiles: bundle.files, checkFile: FILE,
      env: { REGION: "us-east-1", ...mixed } });
    assert.equal(direct.inconclusive, true);
    assert.equal(direct.environmentOrigin, null);
    assert.match(direct.reason ?? "", /minimal approved Multistep environment/);
  } finally {
    await executor.close();
    await app.close();
  }
});
