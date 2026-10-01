// The EXISTING scheduled result, validated without triggering a new run.
// Structure mirrors the real Checkly 9.5.0 scheduled artifact exactly: the
// pw:api records carry `queryParams` + duplicated response headers + the
// `data`-wrapped request body; the failing expect is reported in the runner's
// own transpiled/VM-wrapped coordinates (132:44 for source line 142 of the
// SAME deployed script); the manifest stores the three assets in one archive
// with a free-form content type; and the deployed check carries a
// provider-generated `frequencyOffset` spread the construct never set.
// Every value is synthetic: no real account, token, signed URL, bypass value
// or raw Checkly output — only the artifact's verified structure.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildBundle } from "../../src/bundle/build.ts";
import { loadBundle } from "../../src/bundle.ts";
import { assertionId } from "../../src/assertion/id.ts";
import { digestBytes } from "../../src/multistep/binding.ts";
import { deployedMultiStepProblem, deployedProblemFields } from "../../src/multistep/identity.ts";
import { parseMultiStepProject } from "../../src/multistep/source.ts";
import type { ChecklyClient } from "../../src/checkly/client.ts";
import type { AssetManifestEntry, AssetType, CheckResultSummary } from "../../src/checkly/types.ts";
import { writeZip } from "../helpers/zip-writer.ts";
import { FAKE_ACCOUNT, FAKE_TOKEN, FAKE_ORIGIN, SELECTED_SLOT } from "./helpers.ts";

const web = fileURLToPath(new URL("../../examples/slots-booking/web/", import.meta.url));
const spec = readFileSync(`${web}checks/multistep-booking.spec.ts`, "utf8");
const construct = readFileSync(`${web}checks/multistep-booking.check.ts`, "utf8");

import { fileURLToPath } from "node:url";

type Json = Record<string, unknown>;

// The real runner reports the failing expect at 132:44 inside its wrapped
// runtime file; the deployed script (byte-identical to the repo spec) has the
// stale assertion at source line 142.
const RUNTIME_LINE = 132;
const RUNTIME_COLUMN = 44;
const SOURCE_LINE = 142;
const CHECK_DIR = "/check/296fd6d7-e671-40e2-a4d6-191592cacb28";
const STALE_ERROR = "Error: expect(received).toBe(expected) // Object.is equality\n\nExpected: true\nReceived: undefined";
const STALE_STACK = `${STALE_ERROR}\n    at VM2 Wrapper.apply (/checkly/functions/src/2026-04/node_modules/vm2/lib/bridge.js:1664:11)\n    at ${CHECK_DIR}/checks/multistep-booking.spec.ts:${RUNTIME_LINE}:${RUNTIME_COLUMN}`;
const staleLocation = (line: number = RUNTIME_LINE): Json => ({
  file: `${CHECK_DIR}/checks/multistep-booking.spec.ts`, column: RUNTIME_COLUMN, line,
});

function headers(pairs: Array<[string, string]>): Json[] {
  return pairs.map(([name, value]) => ({ name, value }));
}

function pwApi(stepId: string, title: string, init: {
  method: string; path: string; fetchUid: string;
  requestHeaders: Array<[string, string]>; responseHeaders: Array<[string, string]>;
  requestBody: unknown; body: unknown;
}): Json {
  return {
    stepId, title, duration: 10,
    checklyData: [{
      fetchUid: init.fetchUid, url: `${FAKE_ORIGIN}${init.path}`, status: 200, statusText: "OK",
      headers: headers(init.responseHeaders),
      requestHeaders: headers(init.requestHeaders),
      responseHeaders: headers(init.responseHeaders),
      requestBody: init.requestBody, body: init.body, method: init.method,
      timings: { wait: 2.4, dns: 21.3, tcp: 2.1, firstByte: 66.9, download: 1.1, total: 93.9 },
      queryParams: [],
    }],
  };
}

function expectStep(stepId: string, actual: unknown, expectedData: unknown, error?: Json): Json {
  return {
    stepId, title: "Expect \"toBe\"", duration: 0, ...(error ? { error } : {}),
    checklyData: [{ title: "Expect \"toBe\"", ...(actual !== undefined ? { actual } : {}), expectedData }],
  };
}

function testStep(stepId: string, title: string, children: Json[], error?: Json): Json {
  return { stepId, title, duration: 10, checklyData: null, ...(error ? { error } : {}), steps: children };
}

function hook(stepId: string, title: string, children: Json[] = []): Json {
  return { stepId, title, duration: 13, checklyData: null, steps: children };
}

const loginBody = { ok: true, account: FAKE_ACCOUNT, version: 30, token: FAKE_TOKEN, store: "upstash" };
const sessionBody = { valid: true, account: FAKE_ACCOUNT, tokenVersion: 30, currentVersion: 30 };
const slotsBody = { slots: [SELECTED_SLOT, "10:00", "10:30"], delayMs: 1500 };
const nestedBookBody = { booking: { confirmed: true, status: "CONFIRMED", account: FAKE_ACCOUNT, slot: SELECTED_SLOT, sessionVersion: 30 } };
const flatBookBody = { confirmed: true, booking: "CONFIRMED", account: FAKE_ACCOUNT, slot: SELECTED_SLOT, version: 30 };

/** The real failing scheduled run: hooks, four ordered test.steps, the stale
 * assertion failing inside "book 09:30", no confirmation step. */
function failingSteps(reportedLine: number = RUNTIME_LINE): Json[] {
  const bookError = { message: STALE_ERROR, stack: STALE_STACK, isSoft: false, location: staleLocation(reportedLine) };
  return [
    hook("hook@1", "Before Hooks", [
      { stepId: "fixture@2", title: "Fixture \"playwright\"", duration: 13, checklyData: null },
      { stepId: "fixture@29", title: "Fixture \"request\"", duration: 5, checklyData: null, steps: [{ stepId: "pw:api@30", title: "Create request context", duration: 2, checklyData: null }] },
    ]),
    testStep("test.step@31", "login", [
      pwApi("pw:api@32", "POST \"/api/login\"", {
        method: "POST", path: "/api/login", fetchUid: "938cfd4382bca7114c0a0bab4450ec20",
        requestHeaders: [["user-agent", "Checkly/1.0 (https://www.checklyhq.com)"], ["accept", "*/*"], ["x-vercel-protection-bypass", "*********"], ["content-type", "application/json"], ["content-length", "42"]],
        responseHeaders: [["cache-control", "public, max-age=0, must-revalidate"], ["content-type", "application/json"]],
        requestBody: { data: { account: FAKE_ACCOUNT }, maxRedirects: 20 },
        body: loginBody,
      }),
      expectStep("expect@33", 200, 200),
      expectStep("expect@34", true, true),
      expectStep("expect@35", "string", "string"),
      expectStep("expect@36", FAKE_ACCOUNT, FAKE_ACCOUNT),
      expectStep("expect@37", "number", "number"),
      { stepId: "expect@38", title: "Expect \"toBeGreaterThan\"", duration: 0, checklyData: [{ actual: 30, title: "Expect \"toBeGreaterThan\"", expectedData: 0 }] },
      expectStep("expect@39", true, true),
      expectStep("expect@40", "string", "string"),
      { stepId: "expect@41", title: "Expect \"toBeGreaterThan\"", duration: 0, checklyData: [{ actual: 35, title: "Expect \"toBeGreaterThan\"", expectedData: 0 }] },
    ]),
    testStep("test.step@42", "session", [
      pwApi("pw:api@43", "GET \"/api/session\"", {
        method: "GET", path: "/api/session", fetchUid: "99964d0f6e00826caa6570923d1adb01",
        requestHeaders: [["user-agent", "Checkly/1.0 (https://www.checklyhq.com)"], ["accept", "*/*"], ["authorization", `Bearer ${FAKE_TOKEN}`], ["x-vercel-protection-bypass", "*********"]],
        responseHeaders: [["content-type", "application/json"]],
        requestBody: { maxRedirects: 20 },
        body: sessionBody,
      }),
      expectStep("expect@44", 200, 200),
      expectStep("expect@45", true, true),
      expectStep("expect@46", "string", "string"),
      expectStep("expect@47", FAKE_ACCOUNT, FAKE_ACCOUNT),
      expectStep("expect@48", 30, 30),
      expectStep("expect@49", 30, 30),
    ]),
    testStep("test.step@50", "slots", [
      pwApi("pw:api@51", "GET \"/api/slots\"", {
        method: "GET", path: "/api/slots", fetchUid: "1e4865506218ef7c628a73764fc30e55",
        requestHeaders: [["user-agent", "Checkly/1.0 (https://www.checklyhq.com)"], ["accept", "*/*"], ["x-vercel-protection-bypass", "*********"]],
        responseHeaders: [["age", "0"], ["content-type", "application/json"]],
        requestBody: { maxRedirects: 20 },
        body: slotsBody,
      }),
      expectStep("expect@52", 200, 200),
      expectStep("expect@53", "object", "object"),
      { stepId: "expect@54", title: "Expect \"not toBeNull\"", duration: 0, checklyData: [{ title: "Expect \"not toBeNull\"", actual: slotsBody }] },
      expectStep("expect@55", true, true),
      expectStep("expect@56", "number", "number"),
      { stepId: "expect@57", title: "Expect \"toContain\"", duration: 0, checklyData: [{ actual: [SELECTED_SLOT, "10:00", "10:30"], title: "Expect \"toContain\"", expectedData: SELECTED_SLOT }] },
    ]),
    testStep("test.step@58", "book 09:30", [
      pwApi("pw:api@59", "POST \"/api/book\"", {
        method: "POST", path: "/api/book", fetchUid: "8168ba3af3a814045e5f2bc5824e20d9",
        requestHeaders: [["user-agent", "Checkly/1.0 (https://www.checklyhq.com)"], ["accept", "*/*"], ["authorization", `Bearer ${FAKE_TOKEN}`], ["x-vercel-protection-bypass", "*********"], ["content-type", "application/json"], ["content-length", "16"]],
        responseHeaders: [["content-type", "application/json"]],
        requestBody: { data: { slot: SELECTED_SLOT }, maxRedirects: 20 },
        body: nestedBookBody,
      }),
      expectStep("expect@60", 200, 200),
      expectStep("expect@61", undefined, true, { message: STALE_ERROR, stack: STALE_STACK, isSoft: false, location: staleLocation(reportedLine) }),
    ], bookError),
    hook("hook@62", "After Hooks", [
      { stepId: "fixture@63", title: "Fixture \"request\"", duration: 2, checklyData: null },
      { stepId: "fixture@72", title: "Fixture \"userAgent\"", duration: 0, checklyData: null },
    ]),
    hook("hook@93", "Worker Cleanup", [
      { stepId: "fixture@99", title: "Fixture \"playwright\"", duration: 0, checklyData: null },
    ]),
  ];
}

function reportOf(steps: Json[], stats: Json, failed: boolean): string {
  const results = [{
    workerIndex: 0, parallelIndex: 0, status: failed ? "failed" : "passed", duration: failed ? 1764 : 1500,
    ...(failed ? {
      error: { message: STALE_ERROR, stack: STALE_STACK, isSoft: false, location: staleLocation() },
      errors: [{ location: staleLocation(), message: `${STALE_ERROR}\n    at VM2 Wrapper.apply (/checkly/functions/src/2026-04/node_modules/vm2/lib/bridge.js:1664:11)\n    at ${CHECK_DIR}/checks/multistep-booking.spec.ts:${RUNTIME_LINE}:${RUNTIME_COLUMN}` }],
      errorLocation: staleLocation(),
    } : {}),
    stdout: [], stderr: [], retry: 0, steps,
    startTime: failed ? "2026-09-29T20:33:17.870Z" : "2026-09-29T20:08:13.870Z", annotations: [], attachments: [],
  }];
  return JSON.stringify({
    config: {
      configFile: `${CHECK_DIR}/playwright.config.js`, rootDir: CHECK_DIR, forbidOnly: false, fullyParallel: false,
      globalTimeout: 240000, metadata: { actualWorkers: 1 }, preserveOutput: "always",
      projects: [{ id: "chromium", name: "chromium", testDir: CHECK_DIR, testMatch: ["**/*.@(spec|test).?(c|m)[jt]s?(x)"], timeout: 30000, retries: 0 }],
      quiet: false,
      reporter: [["json", { outputFile: "test-results.json", isMultiStepCheckType: true }]],
      runAgents: "none", version: "1.58.3-checkly.2", workers: 1, webServer: null,
    },
    suites: [{
      title: "script.spec.js", file: "script.spec.js", column: 0, line: 0,
      specs: [{
        title: "slots booking multistep transaction", ok: !failed, tags: [],
        tests: [{
          timeout: 30000, annotations: [], expectedStatus: "passed", projectId: "chromium", projectName: "chromium",
          results, status: failed ? "unexpected" : "expected", secretScrubbingDurationMs: 0,
        }],
        id: "ff6f4949ce356f706172-2b739766abdd3a45316c",
        file: "../../checkly/functions/src/2026-04/node_modules/vm2/lib/bridge.js", line: 1664, column: 11,
      }],
    }],
    errors: [],
    stats,
  });
}

function failingReport(reportedLine: number = RUNTIME_LINE): string {
  return reportOf(failingSteps(reportedLine), { startTime: "2026-09-29T20:33:16.334Z", duration: 3388.141, expected: 0, skipped: 0, unexpected: 1, flaky: 0 }, true)
    .split(`multistep-booking.spec.ts:${RUNTIME_LINE}:${RUNTIME_COLUMN}`).join(`multistep-booking.spec.ts:${reportedLine}:${RUNTIME_COLUMN}`);
}

function passingSteps(): Json[] {
  const ok = (stepId: string, actual: unknown, expectedData: unknown): Json => expectStep(stepId, actual, expectedData);
  return [
    hook("hook@1", "Before Hooks"),
    testStep("test.step@31", "login", [
      pwApi("pw:api@32", "POST \"/api/login\"", {
        method: "POST", path: "/api/login", fetchUid: "pass-1",
        requestHeaders: [["content-type", "application/json"], ["x-vercel-protection-bypass", "*********"]],
        responseHeaders: [["content-type", "application/json"]],
        requestBody: { data: { account: FAKE_ACCOUNT }, maxRedirects: 20 },
        body: loginBody,
      }),
      ok("expect@33", 200, 200), ok("expect@34", true, true),
    ]),
    testStep("test.step@42", "session", [
      pwApi("pw:api@43", "GET \"/api/session\"", {
        method: "GET", path: "/api/session", fetchUid: "pass-2",
        requestHeaders: [["authorization", `Bearer ${FAKE_TOKEN}`], ["x-vercel-protection-bypass", "*********"]],
        responseHeaders: [["content-type", "application/json"]],
        requestBody: { maxRedirects: 20 },
        body: sessionBody,
      }),
      ok("expect@44", 200, 200), ok("expect@45", true, true),
    ]),
    testStep("test.step@50", "slots", [
      pwApi("pw:api@51", "GET \"/api/slots\"", {
        method: "GET", path: "/api/slots", fetchUid: "pass-3",
        requestHeaders: [["x-vercel-protection-bypass", "*********"]],
        responseHeaders: [["content-type", "application/json"]],
        requestBody: { maxRedirects: 20 },
        body: slotsBody,
      }),
      ok("expect@52", 200, 200),
      { stepId: "expect@57", title: "Expect \"toContain\"", duration: 0, checklyData: [{ actual: [SELECTED_SLOT, "10:00", "10:30"], title: "Expect \"toContain\"", expectedData: SELECTED_SLOT }] },
    ]),
    testStep("test.step@58", "book 09:30", [
      pwApi("pw:api@59", "POST \"/api/book\"", {
        method: "POST", path: "/api/book", fetchUid: "pass-4",
        requestHeaders: [["authorization", `Bearer ${FAKE_TOKEN}`], ["content-type", "application/json"], ["x-vercel-protection-bypass", "*********"]],
        responseHeaders: [["content-type", "application/json"]],
        requestBody: { data: { slot: SELECTED_SLOT }, maxRedirects: 20 },
        body: flatBookBody,
      }),
      ok("expect@60", 200, 200),
      ok("expect@61", true, true),
    ]),
    testStep("test.step@70", "confirm transaction", [ok("expect@71", "CONFIRMED", "CONFIRMED")]),
    hook("hook@62", "After Hooks"),
    hook("hook@93", "Worker Cleanup"),
  ];
}

function passingReport(): string {
  return reportOf(passingSteps(), { startTime: "2026-09-29T20:08:13.334Z", duration: 3000, expected: 1, skipped: 0, unexpected: 0, flaky: 0 }, false);
}

function checkRunData(): string {
  // The real asset's script is byte-identical to the repo entrypoint; its
  // scriptPath keeps the construct-relative form.
  return JSON.stringify({ script: spec, scriptPath: "checks/multistep-booking.spec.ts", imports: [], dependencies: [], playwrightConfig: null });
}

function logs(): string {
  const T = 1790713994000;
  return JSON.stringify([
    { time: T + 338, msg: "Starting job", level: "DEBUG" },
    { time: T + 339, msg: "Creating runtime version 2026.04 using Node.js 24", level: "DEBUG" },
    { time: T + 1050, msg: "Running Playwright test script", level: "DEBUG" },
    { time: T + 2659, msg: "Running 1 test using 1 worker", level: "INFO" },
    { time: T + 3872, msg: "[1/1] [chromium] › test.spec.js › slots booking multistep transaction", level: "INFO" },
    { time: T + 5658, msg: "1) [chromium] › test.spec.js › slots booking multistep transaction › book 09:30 ", level: "INFO" },
    { time: T + 5658, msg: "    Error: expect(received).toBe(expected) // Object.is equality", level: "INFO" },
    { time: T + 5658, msg: `    Expected: true\n    Received: undefined\n        at ${CHECK_DIR}/checks/multistep-booking.spec.ts:${RUNTIME_LINE}:${RUNTIME_COLUMN}`, level: "INFO" },
    { time: T + 5723, msg: "1 failed\n    [chromium] › ../../checkly/functions/src/2026-04/node_modules/vm2/lib/bridge.js:1664:11 › slots booking multistep transaction", level: "INFO" },
    { time: T + 5770, msg: "Run finished", level: "DEBUG" },
    { time: T + 5770, msg: "Uploading log file", level: "DEBUG" },
  ]);
}

const fail: CheckResultSummary = {
  id: "synthetic-fail", checkId: "synthetic-check", name: "slots booking multistep transaction",
  hasFailures: true, hasErrors: false, runLocation: "eu-west-1", startedAt: "2026-09-29T20:33:16.334Z",
  stoppedAt: "2026-09-29T20:33:20.000Z", resultType: "FINAL", attempts: 1, errorGroupIds: ["eg-1"],
};
const pass: CheckResultSummary = { ...fail, id: "synthetic-pass", hasFailures: false, startedAt: "2026-09-29T20:08:13.334Z", stoppedAt: "2026-09-29T20:08:16.500Z" };

interface ManifestVariant {
  contentType?: unknown;
  archiveExtraKey?: boolean;
  dropSourceIds?: boolean;
  reportedLine?: number;
  frequencyOffset?: number | null;
}

function scheduledClient(variant: ManifestVariant = {}): ChecklyClient {
  const frequencyOffset = variant.frequencyOffset === undefined ? 37 : variant.frequencyOffset;
  const zipFor = (id: string): Buffer => writeZip(id === "synthetic-pass"
    ? { "test-results.json": passingReport(), "check-run-data.json": checkRunData(), "logs.txt": logs() }
    : { "test-results.json": failingReport(variant.reportedLine ?? RUNTIME_LINE), "check-run-data.json": checkRunData(), "logs.txt": logs() });
  const entries = (id: string): AssetManifestEntry[] => ["test-results.json", "check-run-data.json", "logs.txt"].map((name) => {
    const type: AssetType = name === "logs.txt" ? "log" : name === "check-run-data.json" ? "file" : "report";
    const source: Record<string, unknown> = variant.dropSourceIds
      ? { type: "check-result" }
      : { type: "check-result", checkId: "synthetic-check", checkName: fail.name, checkType: "MULTI_STEP", resultId: id };
    const archive: Record<string, unknown> = { entryName: name };
    if (variant.archiveExtraKey) archive.byteRange = { start: 0, end: 1 };
    const entry: Record<string, unknown> = {
      name, type, source, url: `https://signed.invalid/${id}.zip`, archive,
    };
    if (variant.contentType !== undefined) entry.contentType = variant.contentType;
    else entry.contentType = "application/octet-stream";
    return entry as unknown as AssetManifestEntry;
  });
  const client = {
    calls: [] as unknown[],
    async getCheck() {
      return {
        id: "synthetic-check", name: fail.name, checkType: "MULTI_STEP", activated: true, muted: false,
        frequency: 5, frequencyOffset, runParallel: true, locations: ["us-east-1", "eu-west-1"], privateLocations: [],
        tags: ["slots-booking", "verify-fix-example", "multistep"], retryStrategy: null, doubleCheck: false, runtimeId: null,
        groupId: null, script: spec, scriptPath: "checks/multistep-booking.spec.ts",
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
    async getAssets(_checkId: string, id: string) { return { assets: entries(id) }; },
    async download(url: string) { return zipFor(url.includes("synthetic-pass") ? "synthetic-pass" : "synthetic-fail"); },
  } as unknown as ChecklyClient;
  (client as unknown as { calls: unknown[] }).calls = (client as unknown as { calls: unknown[] }).calls;
  return client;
}

async function scheduledBundle(variant: ManifestVariant = {}): Promise<{ bundle: ReturnType<typeof loadBundle>["bundle"]; outDir: string }> {
  const projectDir = mkdtempSync(join(tmpdir(), "scheduled-result-project-"));
  mkdirSync(join(projectDir, "checks"));
  writeFileSync(join(projectDir, "checkly.config.ts"), "export default {logicalId:'slots-booking-multistep'}\n");
  writeFileSync(join(projectDir, "checks/multistep-booking.spec.ts"), spec);
  writeFileSync(join(projectDir, "checks/multistep-booking.check.ts"), construct);
  const outDir = mkdtempSync(join(tmpdir(), "scheduled-result-bundle-"));
  await buildBundle({ checkId: "synthetic-check", outDir, projectDir, log: () => {} },
    { client: scheduledClient(variant), accountId: "synthetic", now: () => new Date("2026-09-30T00:00:00.000Z") });
  return { bundle: loadBundle(outDir).bundle, outDir };
}

test("the existing scheduled result validates on the automatic remote-download path with no mismatch warning", async () => {
  const { bundle, outDir } = await scheduledBundle();
  assert.deepEqual(bundle.multistep?.problems ?? [], [], "no asset, evidence or config mismatch");
  assert.ok(bundle.scenes.length > 0, "nonempty scenes");
  assert.deepEqual(bundle.scenes.map((scene) => scene.sceneId).sort(), ["detection", "healthy-live", "reproduction"]);
  assert.equal(bundle.multistep?.failureAssertion?.step, "book 09:30");
  assert.equal(bundle.multistep?.failureAssertion?.line, SOURCE_LINE);
  assert.equal(bundle.multistep?.failureAssertion?.id, assertionId("body.confirmed", "toBe", "true"));
  assert.deepEqual(bundle.multistep?.steps, ["login", "session", "slots", "book 09:30"], "failure at book 09:30, no confirmation step");
  assert.equal(bundle.multistep?.kind, "failing");
  // The stored v3 recording: four ordered HTTP-200 requests, one per step,
  // runtime coordinates re-based onto the exact source assertion, and the
  // recurrence-only attempt count from the scheduled result.
  const recording = JSON.parse(readFileSync(join(outDir, "recordings", "failing.multistep.json"), "utf8")) as {
    steps: Array<{ title: string; status: string; failureLine: number | null; requests: Array<{ method: string; path: string; status: number }> }>;
    recurrence: { attempts: number | null };
    binding: { sourceSha256: string; testResultsSha256: string; assetType: string };
  };
  assert.equal(recording.steps.length, 4);
  assert.deepEqual(recording.steps.map((step) => [step.requests[0]!.method, step.requests[0]!.path, step.requests[0]!.status]), [
    ["POST", "/api/login", 200], ["GET", "/api/session", 200], ["GET", "/api/slots", 200], ["POST", "/api/book", 200],
  ]);
  assert.equal(recording.steps[3]!.status, "failed");
  assert.equal(recording.steps[3]!.failureLine, SOURCE_LINE, "reported 132 rebased to the source assertion");
  assert.equal(recording.recurrence.attempts, 1, "no retries: one recorded attempt");
  assert.equal(recording.binding.assetType, "report");
  assert.equal(recording.binding.sourceSha256, digestBytes(spec));
});

test("an out-of-range provider offset still rejects the deployed config", async () => {
  const { bundle } = await scheduledBundle({ frequencyOffset: 999 });
  assert.ok(bundle.multistep?.problems.includes("MULTISTEP_DEPLOYED_CONFIG_MISMATCH"));
  assert.equal(bundle.scenes.length, 0);
});

test("a reported line that names a different source assertion is never laundered", async () => {
  // Repo spec line 134 is `expect(response.status()).toBe(200)` — a real but
  // different in-step assertion. Runtime coordinates may match nothing; they
  // may not retarget the binding.
  const { bundle } = await scheduledBundle({ reportedLine: 134 });
  assert.ok(bundle.multistep?.problems.includes("MULTISTEP_CAPTURE_BINDING_INVALID")
    || bundle.multistep?.problems.includes("MULTISTEP_FAILURE_STEP_UNBOUND"));
  assert.equal(bundle.multistep?.failureAssertion, null);
  assert.equal(bundle.scenes.length, 0);
});

test("archive descriptors admit the official free-form content type and reject malformed ones", async () => {
  const { bundle: admitted } = await scheduledBundle({ contentType: "application/octet-stream" });
  assert.deepEqual(admitted.multistep?.problems ?? [], []);
  const { bundle: absent } = await scheduledBundle({ contentType: "absent" });
  assert.deepEqual(absent.multistep?.problems ?? [], [], "an absent contentType is the documented optional shape");
  const { bundle: numeric } = await scheduledBundle({ contentType: 513 });
  assert.ok(numeric.multistep?.problems.includes("MULTISTEP_ASSET_TYPE_INVALID"));
  const { bundle: extraKey } = await scheduledBundle({ archiveExtraKey: true });
  assert.ok(extraKey.multistep?.problems.includes("MULTISTEP_ASSET_TYPE_INVALID"));
  const { bundle: noIds } = await scheduledBundle({ dropSourceIds: true });
  assert.ok(noIds.multistep?.problems.includes("MULTISTEP_ASSET_TYPE_INVALID"));
});

test("source-controlled frequencyOffset requires exact equality; omitted source accepts only provider metadata", () => {
  const files = new Map([
    ["checks/multistep-booking.check.ts", construct.replace(
      "frequency: Frequency.EVERY_5M,", "frequency: { frequency: 5, frequencyOffset: 30 },")],
    ["checks/multistep-booking.spec.ts", spec],
  ]);
  const controlled = parseMultiStepProject(files, "checks/multistep-booking.spec.ts");
  assert.equal(controlled?.construct?.frequencyMinutes, 5);
  assert.equal(controlled?.construct?.frequencyOffsetSeconds, 30);
  assert.equal(controlled?.construct?.errors.length, 0, `errors: ${controlled?.construct?.errors.join("; ")}`);
  const deployedBase = {
    id: "synthetic-deployed-id", name: "slots booking multistep transaction", checkType: "MULTI_STEP",
    activated: true, muted: false, frequency: 5, frequencyOffset: 30, runParallel: true,
    locations: ["us-east-1", "eu-west-1"], tags: ["slots-booking", "verify-fix-example", "multistep"],
    groupId: null, runtimeId: null, privateLocations: [], retryStrategy: null, doubleCheck: false,
    script: spec, scriptPath: "checks/multistep-booking.spec.ts",
    environmentVariables: [
      { key: "ENVIRONMENT_URL", value: "synthetic-origin", secret: false },
      { key: "MULTISTEP_USER_US_EAST_1", value: "synthetic-east", secret: true },
      { key: "MULTISTEP_USER_EU_WEST_1", value: "synthetic-west", secret: true },
      { key: "VERCEL_AUTOMATION_BYPASS_SECRET", value: "synthetic-bypass", secret: true },
    ],
  } as unknown as Parameters<typeof deployedMultiStepProblem>[0];
  assert.equal(deployedMultiStepProblem(deployedBase, controlled, spec), null, "equal source-controlled offset admitted");
  const drift = structuredClone(deployedBase);
  drift.frequencyOffset = 37;
  assert.equal(deployedMultiStepProblem(drift, controlled, spec), "MULTISTEP_DEPLOYED_CONFIG_MISMATCH");
  assert.deepEqual(deployedProblemFields(drift, controlled, spec), ["frequencyOffset"]);
});

test("an omitted source offset narrowly admits only provider-generated metadata", () => {
  const files = new Map([
    ["checks/multistep-booking.check.ts", construct],
    ["checks/multistep-booking.spec.ts", spec],
  ]);
  const model = parseMultiStepProject(files, "checks/multistep-booking.spec.ts");
  assert.equal(model?.construct?.frequencyOffsetSeconds, null, "Frequency.EVERY_5M controls no offset");
  const deployed = {
    id: "synthetic-deployed-id", name: "slots booking multistep transaction", checkType: "MULTI_STEP",
    activated: true, muted: false, frequency: 5, runParallel: true,
    locations: ["us-east-1", "eu-west-1"], tags: ["slots-booking", "verify-fix-example", "multistep"],
    groupId: null, runtimeId: null, privateLocations: [], retryStrategy: null, doubleCheck: false,
    script: spec, scriptPath: "checks/multistep-booking.spec.ts",
    environmentVariables: [
      { key: "ENVIRONMENT_URL", value: "synthetic-origin", secret: false },
      { key: "MULTISTEP_USER_US_EAST_1", value: "synthetic-east", secret: true },
      { key: "MULTISTEP_USER_EU_WEST_1", value: "synthetic-west", secret: true },
      { key: "VERCEL_AUTOMATION_BYPASS_SECRET", value: "synthetic-bypass", secret: true },
    ],
  } as unknown as Parameters<typeof deployedMultiStepProblem>[0];
  for (const offset of [undefined, null, 0, 1, 37, 50]) {
    const check = structuredClone(deployed);
    if (offset === undefined) delete (check as Record<string, unknown>).frequencyOffset;
    else check.frequencyOffset = offset as number;
    assert.equal(deployedMultiStepProblem(check, model, spec), null, `provider metadata ${String(offset)} admitted`);
  }
  for (const offset of [-5, 2.5, 51, 999]) {
    const check = structuredClone(deployed);
    check.frequencyOffset = offset;
    assert.equal(deployedMultiStepProblem(check, model, spec), "MULTISTEP_DEPLOYED_CONFIG_MISMATCH", `${String(offset)} rejected`);
    assert.deepEqual(deployedProblemFields(check, model, spec), ["frequencyOffset"]);
  }
  // new Frequency(minutes, seconds) is the constructor spelling of the same
  // source control and demands the same exact equality.
  const constructed = new Map([
    ["checks/multistep-booking.check.ts", construct.replace(
      "frequency: Frequency.EVERY_5M,", "frequency: new Frequency(5, 30),")],
    ["checks/multistep-booking.spec.ts", spec],
  ]);
  const viaConstructor = parseMultiStepProject(constructed, "checks/multistep-booking.spec.ts");
  assert.equal(viaConstructor?.construct?.frequencyOffsetSeconds, 30);
  // Sub-minute constants are official spellings too, but they schedule a
  // different (0-minute) check: the canonical identity stays 5 minutes.
  const subMinute = parseMultiStepProject(new Map([
    ["checks/multistep-booking.check.ts", construct.replace("frequency: Frequency.EVERY_5M,", "frequency: Frequency.EVERY_30S,")],
    ["checks/multistep-booking.spec.ts", spec],
  ]), "checks/multistep-booking.spec.ts");
  assert.equal(subMinute?.construct?.frequencyMinutes, 0);
  assert.equal(subMinute?.construct?.frequencyOffsetSeconds, 30);
  assert.equal(deployedMultiStepProblem(deployed, subMinute, spec), "MULTISTEP_CONSTRUCT_IDENTITY_INVALID");
});
