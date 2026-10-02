// Real Checkly 9.5.0 evidence shape — synthetic values, real structure.
// The structure mirrors the verified checkly@9.5.0 runner output: top-level
// steps carry `stepId` ("test.step@N", "hook@N", "pw:api@N", "expect@N") with
// NO `category` field; hook entries surround the transaction; pw:api checklyData
// records duplicate response headers as both `headers` and `responseHeaders`;
// request bodies wrap the payload in `data` alongside `maxRedirects`.
// All values are synthetic: no raw Checkly asset, account, token or signed URL.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { normalizeMultiStepCapture } from "../../src/multistep/normalize.ts";
import { extractTransaction } from "../../src/multistep/transaction.ts";
import { multiStepShapeProblems } from "../../src/multistep/shape.ts";
import { buildMultiStepRecording, readMultiStepAssets, MULTISTEP_DRAFT_SCHEMA } from "../../src/multistep/capture.ts";
import { sanitizeMultiStepCapture } from "../../src/multistep/sanitize.ts";
import { deployedMultiStepProblem, deployedProblemFields } from "../../src/multistep/identity.ts";
import { parseMultiStepProject } from "../../src/multistep/source.ts";
import { buildBundle } from "../../src/bundle/build.ts";
import { loadBundle } from "../../src/bundle.ts";
import type { ChecklyClient } from "../../src/checkly/client.ts";
import type { AssetManifestEntry, CheckResultSummary } from "../../src/checkly/types.ts";
import { writeZip } from "../helpers/zip-writer.ts";
import { FAKE_ACCOUNT, FAKE_TOKEN, FAKE_ORIGIN, SELECTED_SLOT } from "./helpers.ts";

const web = fileURLToPath(new URL("../../examples/slots-booking/web/", import.meta.url));
const projectModel = parseMultiStepProject(new Map([
  ["checks/multistep-booking.check.ts", readFileSync(`${web}checks/multistep-booking.check.ts`, "utf8")],
  ["checks/multistep-booking.spec.ts", readFileSync(`${web}checks/multistep-booking.spec.ts`, "utf8")],
]), "checks/multistep-booking.spec.ts");
if (!projectModel?.script) throw new Error("example multistep model failed to parse");

type Json = Record<string, unknown>;

function pwApi(stepId: string, title: string, init: {
  method: string; path: string; fetchUid: string;
  requestHeaders: Array<[string, string]>; responseHeaders: Array<[string, string]>;
  requestBody: unknown; body: unknown; expected?: unknown; actual?: unknown;
}): Json {
  return {
    stepId, title, duration: 10,
    checklyData: [{
      fetchUid: init.fetchUid, url: `${FAKE_ORIGIN}${init.path}`, method: init.method,
      status: 200, statusText: "OK",
      headers: init.responseHeaders.map(([name, value]) => ({ name, value })),
      requestHeaders: init.requestHeaders.map(([name, value]) => ({ name, value })),
      responseHeaders: init.responseHeaders.map(([name, value]) => ({ name, value })),
      requestBody: init.requestBody, body: init.body,
      ...(init.expected !== undefined ? { expected: init.expected } : {}),
      ...(init.actual !== undefined ? { actual: init.actual } : {}),
      timings: { total: 10 }, queryParams: [],
    }],
  };
}

function expectStep(stepId: string, title: string, actual: unknown, expectedData: unknown, error?: Json): Json {
  return {
    stepId, title, duration: 0, ...(error ? { error } : {}),
    checklyData: [{ title, ...(actual !== undefined ? { actual } : {}), expectedData }],
  };
}

function hook(stepId: string, title: string, children: Json[] = []): Json {
  return { stepId, title, duration: 1, checklyData: null, steps: children };
}

function testStep(stepId: string, title: string, children: Json[], error?: Json): Json {
  return { stepId, title, duration: 10, checklyData: null, ...(error ? { error } : {}), steps: children };
}

function loginStep(): Json {
  return testStep("test.step@31", "login", [
    pwApi("pw:api@32", "POST /api/login", {
      method: "POST", path: "/api/login", fetchUid: "fetch-1",
      requestHeaders: [["content-type", "application/json"]],
      responseHeaders: [["content-type", "application/json"]],
      requestBody: { data: { account: FAKE_ACCOUNT }, maxRedirects: 20 },
      body: { ok: true, account: FAKE_ACCOUNT, version: 1, token: FAKE_TOKEN, store: "memory" },
    }),
    expectStep("expect@33", "Expect \"toBe\"", 200, 200),
    expectStep("expect@34", "Expect \"toBe\"", true, true),
  ]);
}

function sessionStep(): Json {
  return testStep("test.step@42", "session", [
    pwApi("pw:api@43", "GET /api/session", {
      method: "GET", path: "/api/session", fetchUid: "fetch-2",
      requestHeaders: [["authorization", `Bearer ${FAKE_TOKEN}`]],
      responseHeaders: [["content-type", "application/json"]],
      requestBody: { maxRedirects: 20 },
      body: { valid: true, account: FAKE_ACCOUNT, tokenVersion: 1, currentVersion: 1 },
    }),
    expectStep("expect@44", "Expect \"toBe\"", 200, 200),
    expectStep("expect@45", "Expect \"toBe\"", true, true),
  ]);
}

function slotsStep(): Json {
  return testStep("test.step@50", "slots", [
    pwApi("pw:api@51", "GET /api/slots", {
      method: "GET", path: "/api/slots", fetchUid: "fetch-3",
      requestHeaders: [], responseHeaders: [["content-type", "application/json"]],
      requestBody: { maxRedirects: 20 },
      body: { slots: [SELECTED_SLOT, "10:00", "11:30"], delayMs: 1500 },
    }),
    expectStep("expect@52", "Expect \"toBe\"", 200, 200),
    expectStep("expect@53", "Expect \"toContain\"", [SELECTED_SLOT, "10:00", "11:30"], SELECTED_SLOT),
  ]);
}

function bookStepFailing(): Json {
  const error = {
    message: "Error: expect(received).toBe(expected) // Object.is equality\n\nExpected: true\nReceived: undefined",
    stack: "Error: expect(received).toBe(expected)\n    at multistep-booking.spec.ts:142:44",
    isSoft: false,
    location: { file: "/check/synthetic/checks/multistep-booking.spec.ts", column: 44, line: 142 },
  };
  return testStep("test.step@58", "book 09:30", [
    pwApi("pw:api@59", "POST /api/book", {
      method: "POST", path: "/api/book", fetchUid: "fetch-4",
      requestHeaders: [["authorization", `Bearer ${FAKE_TOKEN}`], ["content-type", "application/json"]],
      responseHeaders: [["content-type", "application/json"]],
      requestBody: { data: { slot: SELECTED_SLOT }, maxRedirects: 20 },
      body: { booking: { confirmed: true, status: "CONFIRMED", account: FAKE_ACCOUNT, slot: SELECTED_SLOT, sessionVersion: 1 } },
    }),
    expectStep("expect@61", "Expect \"toBe\"", undefined, true, error),
  ], error);
}

function bookStepPassing(): Json {
  return testStep("test.step@58", "book 09:30", [
    pwApi("pw:api@59", "POST /api/book", {
      method: "POST", path: "/api/book", fetchUid: "fetch-4",
      requestHeaders: [["authorization", `Bearer ${FAKE_TOKEN}`], ["content-type", "application/json"]],
      responseHeaders: [["content-type", "application/json"]],
      requestBody: { data: { slot: SELECTED_SLOT }, maxRedirects: 20 },
      body: { confirmed: true, booking: "CONFIRMED", account: FAKE_ACCOUNT, slot: SELECTED_SLOT, version: 1 },
    }),
    expectStep("expect@60", "Expect \"toBe\"", 200, 200),
    expectStep("expect@61", "Expect \"toBe\"", true, true),
  ]);
}

function confirmStep(): Json {
  return testStep("test.step@70", "confirm transaction", [
    { stepId: "expect@71", title: "Expect \"toBe\"", duration: 0, checklyData: [{ title: "Expect \"toBe\"", actual: "CONFIRMED", expectedData: "CONFIRMED" }] },
  ]);
}

function report(stats: Json, steps: Json[]): string {
  const failed = Number(stats.unexpected) > 0;
  return JSON.stringify({
    config: { configFile: "/check/synthetic/playwright.config.js", rootDir: "/check/synthetic", reporter: [["json", { outputFile: "test-results.json", isMultiStepCheckType: true }]] },
    errors: [],
    stats,
    suites: [{
      title: "script.spec.js", file: "script.spec.js", column: 0, line: 0,
      suites: [{
        title: "slots booking multistep transaction",
        specs: [{
          title: "slots booking multistep transaction", ok: false, tags: [],
          tests: [{
            timeout: 30000, annotations: [], expectedStatus: "passed", projectId: "chromium", projectName: "chromium",
            results: [{
              workerIndex: 0, parallelIndex: 0, status: failed ? "failed" : "passed", duration: 100,
              error: failed ? {
                message: "Error: expect(received).toBe(expected) // Object.is equality\n\nExpected: true\nReceived: undefined",
                stack: "Error: expect(received).toBe(expected)\n    at multistep-booking.spec.ts:142:44",
                isSoft: false,
                location: { file: "/check/synthetic/checks/multistep-booking.spec.ts", column: 44, line: 142 },
              } : undefined,
              errors: failed ? [{ location: { file: "/check/synthetic/checks/multistep-booking.spec.ts", column: 44, line: 142 }, message: "Error: expect(received).toBe(expected)\n\nExpected: true\nReceived: undefined" }] : [],
              stdout: [], stderr: [], retry: 0, steps,
              startTime: "2026-09-29T20:33:17.870Z", annotations: [], attachments: [],
              errorLocation: failed ? { file: "/check/synthetic/checks/multistep-booking.spec.ts", column: 44, line: 142 } : undefined,
            }],
            status: failed ? "unexpected" : "expected", secretScrubbingDurationMs: 0,
          }],
          id: "spec-1", file: "../../checkly/functions/src/2026-04/node_modules/vm2/lib/bridge.js", line: 1664, column: 11,
        }],
      }],
    }],
  });
}

/** Real Checkly 9.5.0 failing capture: four ordered steps, hooks, no confirm. */
export function realShapeFailing(): string {
  return report(
    { startTime: "2026-09-29T20:33:16.334Z", duration: 3388.14, expected: 0, skipped: 0, unexpected: 1, flaky: 0 },
    [hook("hook@1", "Before Hooks"), loginStep(), sessionStep(), slotsStep(), bookStepFailing(), hook("hook@62", "After Hooks"), hook("hook@93", "Worker Cleanup")],
  );
}

/** Real Checkly 9.5.0 passing capture: five ordered steps with confirmation. */
export function realShapePassing(): string {
  return report(
    { startTime: "2026-09-29T20:33:16.334Z", duration: 3388.14, expected: 1, skipped: 0, unexpected: 0, flaky: 0 },
    [hook("hook@1", "Before Hooks"), loginStep(), sessionStep(), slotsStep(), bookStepPassing(), confirmStep(), hook("hook@62", "After Hooks"), hook("hook@93", "Worker Cleanup")],
  );
}

export function realShapeCheckRunData(): string {
  return JSON.stringify({
    script: "// synthetic entrypoint\nimport { expect, test } from '@playwright/test'\n",
    scriptPath: "checks/multistep-booking.spec.ts", imports: [], dependencies: [], playwrightConfig: null,
  });
}

export function realShapeLogs(): string {
  return JSON.stringify([
    { time: 1790713994338, msg: "Starting job", level: "DEBUG" },
    { time: 1790713999658, msg: "1) book 09:30 — expect(received).toBe(expected)", level: "INFO" },
  ]);
}

test("real Checkly 9.5.0 failing shape: four ordered steps, hooks skipped, stale assertion bound", () => {
  const capture = normalizeMultiStepCapture({
    testResults: realShapeFailing(), checkRunData: realShapeCheckRunData(), logs: realShapeLogs(), attempts: 1,
  });
  assert.deepEqual(capture.problems, []);
  assert.equal(capture.kind, "failing");
  assert.equal(capture.steps.length, 4, "hook entries are not transaction steps");
  assert.deepEqual(capture.steps.map((s) => s.title), ["login", "session", "slots", "book 09:30"]);
  assert.equal(capture.steps[3]!.status, "failed");
  assert.equal(capture.steps[3]!.failureLine, 142);
  assert.equal(capture.steps[3]!.requests.length, 1);
  assert.equal(capture.steps[3]!.requests[0]!.status, 200);
  assert.deepEqual(capture.steps[3]!.requests[0]!.requestBody, { slot: SELECTED_SLOT });
  assert.deepEqual(capture.steps[3]!.requests[0]!.responseBody, {
    booking: { confirmed: true, status: "CONFIRMED", account: FAKE_ACCOUNT, slot: SELECTED_SLOT, sessionVersion: 1 },
  });
  assert.deepEqual(multiStepShapeProblems(capture), []);
  const tx = extractTransaction(capture);
  assert.deepEqual(tx.problems, []);
  assert.equal(tx.token!.occurrences, 3);
  assert.equal(tx.account!.sites.length, 4);
  assert.equal(tx.slot!.value, SELECTED_SLOT);
  assert.equal(tx.version!.value, 1);
});

test("real Checkly 9.5.0 passing shape: five ordered steps with confirmation", () => {
  const capture = normalizeMultiStepCapture({ testResults: realShapePassing(), attempts: 1 });
  assert.deepEqual(capture.problems, []);
  assert.equal(capture.kind, "passing");
  assert.equal(capture.steps.length, 5);
  assert.equal(capture.steps[4]!.title, "confirm transaction");
  assert.deepEqual(multiStepShapeProblems(capture), []);
});

test("real Checkly 9.5.0 evidence sanitizes to a values-free recording", () => {
  const capture = normalizeMultiStepCapture({ testResults: realShapeFailing(), attempts: 1 });
  const tx = extractTransaction(capture);
  const sanitized = sanitizeMultiStepCapture(capture, tx);
  assert.equal(sanitized.ok, true);
  if (!sanitized.ok) return;
  const serialized = JSON.stringify(sanitized.capture);
  for (const secret of [FAKE_ACCOUNT, FAKE_TOKEN, FAKE_ORIGIN]) {
    assert.ok(!serialized.includes(secret), "raw secret must not enter the sanitized capture");
  }
  assert.equal((sanitized.capture.steps[3]!.requests[0]!.responseBody as any).booking.confirmed, true);
  assert.equal((sanitized.capture.steps[3]!.requests[0]!.requestBody as any).slot, SELECTED_SLOT);
  const recording = buildMultiStepRecording({
    texts: { testResults: realShapeFailing(), checkRunData: realShapeCheckRunData(), logs: realShapeLogs() }, attempts: 1,
  });
  assert.equal(recording.ok, true);
  if (!recording.ok) return;
  // A local draft is mechanics-only proof, never a stored v3 recording.
  assert.equal(recording.recording.schemaVersion, MULTISTEP_DRAFT_SCHEMA);
  assert.equal(recording.recording.kind, "failing");
  assert.equal(recording.recording.steps.length, 4);
  assert.equal(recording.recording.transaction!.token.occurrences, 3);
});

test("ZIP and flat-directory --assets feed the same admission path", async () => {
  const flat = mkdtempSync(join(tmpdir(), "checkly950-flat-"));
  writeFileSync(join(flat, "test-results.json"), realShapeFailing());
  writeFileSync(join(flat, "check-run-data.json"), realShapeCheckRunData());
  writeFileSync(join(flat, "logs.txt"), realShapeLogs());
  const zipDir = mkdtempSync(join(tmpdir(), "checkly950-zip-"));
  const { writeZip } = await import("../helpers/zip-writer.ts");
  writeFileSync(join(zipDir, "assets.zip"), writeZip({
    "test-results.json": realShapeFailing(), "check-run-data.json": realShapeCheckRunData(), "logs.txt": realShapeLogs(),
  }));
  const fromFlat = readMultiStepAssets(flat).failing!;
  const fromZip = readMultiStepAssets(zipDir).failing!;
  assert.deepEqual(fromFlat.found, fromZip.found);
  assert.deepEqual(fromFlat.hashes, fromZip.hashes);
  const recFlat = buildMultiStepRecording({ texts: fromFlat, attempts: 1 });
  const recZip = buildMultiStepRecording({ texts: fromZip, attempts: 1 });
  assert.equal(recFlat.ok, true);
  assert.equal(recZip.ok, true);
  assert.deepEqual(recFlat.recording, recZip.recording);
});

test("automatic real-shape archive download binds a bundle with scenes and the book 09:30 failure point", async () => {
  const spec = readFileSync(`${web}checks/multistep-booking.spec.ts`, "utf8");
  const construct = readFileSync(`${web}checks/multistep-booking.check.ts`, "utf8");
  const projectDir = mkdtempSync(join(tmpdir(), "checkly950-e2e-project-"));
  mkdirSync(join(projectDir, "checks"));
  writeFileSync(join(projectDir, "checkly.config.ts"), "export default {logicalId:'slots-booking-multistep'}\n");
  writeFileSync(join(projectDir, "checks/multistep-booking.spec.ts"), spec);
  writeFileSync(join(projectDir, "checks/multistep-booking.check.ts"), construct);
  const fail: CheckResultSummary = {
    id: "synthetic-fail", checkId: "synthetic-check", name: "slots booking multistep transaction",
    hasFailures: true, hasErrors: false, runLocation: "eu-west-1", startedAt: "2026-09-25T22:18:13.000Z",
    stoppedAt: "2026-09-25T22:18:18.000Z", resultType: "FINAL", attempts: 1, errorGroupIds: [],
  };
  const pass: CheckResultSummary = { ...fail, id: "synthetic-pass", hasFailures: false, runLocation: "us-east-1", startedAt: "2026-09-25T20:08:13.000Z", stoppedAt: "2026-09-25T20:08:18.000Z" };
  const zip = writeZip({
    "test-results.json": realShapeFailing(), "check-run-data.json": realShapeCheckRunData(), "logs.txt": realShapeLogs(),
  });
  const entry = (name: string, id: string): AssetManifestEntry => ({
    name, type: name === "logs.txt" ? "log" : name === "check-run-data.json" ? "file" : "report",
    source: { type: "check-result", checkId: "synthetic-check", checkName: fail.name, checkType: "MULTI_STEP", resultId: id },
    contentType: "application/zip", url: `https://signed.invalid/${id}.zip`, archive: { entryName: name },
  });
  const client = {
    calls: [],
    async getCheck() {
      return {
        id: "synthetic-check", name: fail.name, checkType: "MULTI_STEP", activated: true, muted: false,
        frequency: 5, runParallel: true, locations: ["us-east-1", "eu-west-1"], privateLocations: [],
        tags: ["slots-booking", "verify-fix-example", "multistep"], retryStrategy: null, doubleCheck: false, runtimeId: null,
        script: spec, scriptPath: "multistep-booking.spec.ts",
        environmentVariables: [
          { key: "ENVIRONMENT_URL", value: FAKE_ORIGIN, secret: false },
          { key: "MULTISTEP_USER_US_EAST_1", value: FAKE_ACCOUNT, secret: true },
          { key: "MULTISTEP_USER_EU_WEST_1", value: "fixture-west", secret: true },
          { key: "VERCEL_AUTOMATION_BYPASS_SECRET", value: "synthetic-bypass-2910", secret: true },
        ],
      };
    },
    async listResults() { return { entries: [fail, pass], nextId: null }; },
    async getResult(_checkId: string, id: string) { return id === fail.id ? fail : pass; },
    async getAssets(_checkId: string, id: string) {
      return { assets: ["test-results.json", "check-run-data.json", "logs.txt"].map((name) => entry(name, id)) };
    },
    async download(url: string) { return url.includes("synthetic-pass")
      ? writeZip({ "test-results.json": realShapePassing(), "check-run-data.json": realShapeCheckRunData(), "logs.txt": realShapeLogs() })
      : zip; },
  } as unknown as ChecklyClient;
  const outDir = mkdtempSync(join(tmpdir(), "checkly950-e2e-bundle-"));
  const outcome = await buildBundle({ checkId: "synthetic-check", outDir, projectDir, log: () => {} },
    { client, accountId: "synthetic", now: () => new Date("2026-09-27T00:00:00.000Z") });
  assert.deepEqual(outcome.warnings, [], "no warnings: no ASSET_TYPE_INVALID, no DEPLOYED_CONFIG_MISMATCH");
  const bundle = loadBundle(outDir).bundle;
  assert.deepEqual(bundle.multistep?.problems ?? [], []);
  assert.ok(bundle.scenes.length > 0, "nonempty scenes");
  assert.equal(bundle.multistep?.failureAssertion?.step, "book 09:30");
  assert.equal(bundle.multistep?.failureAssertion?.line, 142);
  assert.deepEqual(bundle.multistep?.steps.map((s: string) => s), ["login", "session", "slots", "book 09:30"]);
  const recording = JSON.parse(readFileSync(join(outDir, "recordings", "failing.multistep.json"), "utf8"));
  assert.equal(recording.schemaVersion, "multistep-recording-v3");
  assert.equal(recording.binding.failureAssertion?.step, "book 09:30");
  assert.equal(recording.binding.failureAssertion?.subject, "body.confirmed");
  assert.equal(recording.binding.failureAssertion?.repairedSubject, "body.booking.confirmed");
});

test("official free-form archive content type is admitted; a non-string one is not", async () => {
  const spec = readFileSync(`${web}checks/multistep-booking.spec.ts`, "utf8");
  const projectDir = mkdtempSync(join(tmpdir(), "checkly950-ct-project-"));
  mkdirSync(join(projectDir, "checks"));
  writeFileSync(join(projectDir, "checkly.config.ts"), "export default {logicalId:'slots-booking-multistep'}\n");
  writeFileSync(join(projectDir, "checks/multistep-booking.spec.ts"), spec);
  writeFileSync(join(projectDir, "checks/multistep-booking.check.ts"), readFileSync(`${web}checks/multistep-booking.check.ts`, "utf8"));
  const fail: CheckResultSummary = {
    id: "synthetic-fail", checkId: "synthetic-check", name: "slots booking multistep transaction",
    hasFailures: true, hasErrors: false, runLocation: "eu-west-1", startedAt: "2026-09-25T22:18:13.000Z",
    stoppedAt: "2026-09-25T22:18:18.000Z", resultType: "FINAL", attempts: 1, errorGroupIds: [],
  };
  const zip = writeZip({ "test-results.json": realShapeFailing(), "check-run-data.json": realShapeCheckRunData(), "logs.txt": realShapeLogs() });
  const client = (contentType?: unknown) => ({
    calls: [],
    async getCheck() {
      return {
        id: "synthetic-check", name: fail.name, checkType: "MULTI_STEP", activated: true, muted: false,
        frequency: 5, runParallel: true, locations: ["us-east-1", "eu-west-1"], privateLocations: [],
        tags: ["slots-booking", "verify-fix-example", "multistep"], retryStrategy: null, doubleCheck: false, runtimeId: null,
        groupId: null, script: spec, scriptPath: "checks/multistep-booking.spec.ts",
        environmentVariables: [
          { key: "ENVIRONMENT_URL", value: "synthetic-origin", secret: false },
          { key: "MULTISTEP_USER_US_EAST_1", value: "synthetic-east", secret: true },
          { key: "MULTISTEP_USER_EU_WEST_1", value: "synthetic-west", secret: true },
          { key: "VERCEL_AUTOMATION_BYPASS_SECRET", value: "synthetic-bypass", secret: true },
        ],
      };
    },
    async listResults() { return { entries: [fail], nextId: null }; },
    async getResult() { return fail; },
    async getAssets() {
      const entry: Record<string, unknown> = {
        name: "test-results.json", type: "report", contentType, url: "https://signed.invalid/a.zip",
        source: { type: "check-result", checkId: "synthetic-check", checkName: fail.name, checkType: "MULTI_STEP", resultId: fail.id },
        archive: { entryName: "test-results.json" },
      };
      if (contentType === undefined) delete entry.contentType;
      return { assets: [entry] };
    },
    async download() { return zip; },
  } as unknown as ChecklyClient);
  const build = async (client: ChecklyClient) => {
    const outDir = mkdtempSync(join(tmpdir(), "checkly950-ct-bundle-"));
    await buildBundle({ checkId: "synthetic-check", outDir, projectDir, log: () => {} },
      { client, accountId: "synthetic", now: () => new Date("2026-09-27T00:00:00.000Z") });
    return JSON.parse(readFileSync(join(outDir, "manifest.json"), "utf8")) as {
      recordings: { multistepFailing: string | null };
      multistep: { failing: { problems: string[] } | null };
    };
  };
  // Checkly 9.5.0 packs every entry of a result into one zip whose descriptor
  // content type is free-form (the real scheduled run shipped
  // application/octet-stream): zip-ness is verified from the downloaded bytes,
  // so the archive still binds, while zip-adjacent metadata like the entry
  // names stays descriptor-checked.
  const octet = await build(client("application/octet-stream"));
  assert.ok(octet.recordings.multistepFailing, "free-form content type admits the archive");
  assert.ok(!octet.multistep?.failing?.problems.includes("MULTISTEP_ASSET_TYPE_INVALID"));
  const absent = await build(client(undefined));
  assert.ok(absent.recordings.multistepFailing, "an absent contentType is the documented optional shape");
  const numeric = await build(client(513));
  assert.equal(numeric.recordings.multistepFailing, null);
  assert.ok(numeric.multistep?.failing?.problems.includes("MULTISTEP_ASSET_TYPE_INVALID"));
  const long = await build(client("x".repeat(513)));
  assert.equal(long.recordings.multistepFailing, null, "a free-form content type still has a length bound");
  assert.ok(long.multistep?.failing?.problems.includes("MULTISTEP_ASSET_TYPE_INVALID"));
});

test("canonical no-retry deployed config is exactly doubleCheck:false plus retryStrategy:null", () => {
  const base = {
    id: "synthetic-deployed-id", name: "slots booking multistep transaction", checkType: "MULTI_STEP",
    activated: true, muted: false, frequency: 5, frequencyOffset: 0, runParallel: true,
    locations: ["us-east-1", "eu-west-1"], tags: ["slots-booking", "verify-fix-example", "multistep"],
    groupId: null, runtimeId: null, privateLocations: [], retryStrategy: null, doubleCheck: false,
    script: "synthetic-script", scriptPath: "checks/multistep-booking.spec.ts",
    environmentVariables: [
      { key: "ENVIRONMENT_URL", value: "synthetic-origin", secret: false },
      { key: "MULTISTEP_USER_US_EAST_1", value: "synthetic-east", secret: true },
      { key: "MULTISTEP_USER_EU_WEST_1", value: "synthetic-west", secret: true },
      { key: "VERCEL_AUTOMATION_BYPASS_SECRET", value: "synthetic-bypass", secret: true },
    ],
  } as unknown as Parameters<typeof deployedMultiStepProblem>[0];
  assert.equal(deployedMultiStepProblem({ ...base }, projectModel, "synthetic-script"), null);
  const drift: Array<[string, (c: typeof base) => void, string[]]> = [
    ["doubleCheck true", (c) => { c.doubleCheck = true; }, ["doubleCheck"]],
    ["retry strategy", (c) => { c.retryStrategy = { type: "FIXED", maxRetries: 1, baseBackoffSeconds: 0, maxDurationSeconds: 60, sameRegion: false }; }, ["retryStrategy"]],
    ["missing doubleCheck", (c) => { delete (c as Record<string, unknown>).doubleCheck; }, ["doubleCheck"]],
    ["missing retryStrategy", (c) => { delete (c as Record<string, unknown>).retryStrategy; }, ["retryStrategy"]],
    ["muted", (c) => { c.muted = true; }, ["muted"]],
    ["inactive", (c) => { c.activated = false; }, ["activated"]],
    ["frequency", (c) => { c.frequency = 10; }, ["frequency"]],
    ["parallel", (c) => { c.runParallel = false; }, ["runParallel"]],
    ["locations order", (c) => { c.locations = ["eu-west-1", "us-east-1"]; }, ["locations"]],
    ["private location", (c) => { c.privateLocations = ["private-1"]; }, ["privateLocations"]],
  ];
  for (const [label, mutate, expectedFields] of drift) {
    const changed = structuredClone(base);
    mutate(changed);
    assert.equal(deployedMultiStepProblem(changed, projectModel, "synthetic-script"), "MULTISTEP_DEPLOYED_CONFIG_MISMATCH", label);
    assert.deepEqual(deployedProblemFields(changed, projectModel, "synthetic-script"), expectedFields, `${label} names the mismatched field`);
  }
});
