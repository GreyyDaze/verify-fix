// The EXISTING scheduled result, validated without triggering a new run.
// The failing side is the REAL scheduled artifact (Checkly-redacted: every
// secret value is the opaque "*********" form), committed verbatim under
// test/multistep/fixtures/ — the automatic remote-download path must admit
// these exact bytes. The passing side is a synthetic historical healthy run
// (flat book contract + confirmation step; the real passing artifacts were
// never supplied). No real account, token, signed URL, bypass value or raw
// Checkly output is stored here.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
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

type Json = Record<string, unknown>;

// The real runner reports the failing expect at 132:44 inside its wrapped
// runtime file; the deployed script (byte-identical to the repo spec) has the
// stale assertion at source line 142.
const RUNTIME_LINE = 132;
const SOURCE_LINE = 142;
const REAL_TARGET_ORIGIN = "https://slots-booking-verify-fix.vercel.app";

const realTestResults = readFileSync(new URL("./fixtures/scheduled-failing-test-results.json", import.meta.url), "utf8");
const realLogs = readFileSync(new URL("./fixtures/scheduled-failing-logs.txt", import.meta.url), "utf8");
const realCheckRunData = JSON.stringify({
  script: spec, scriptPath: "checks/multistep-booking.spec.ts", imports: [], dependencies: [], playwrightConfig: null,
});

/** Re-serialize the real artifact with every reported 132 coordinate rewritten
 * to `line` (stacks, error locations and the result errorLocation), and/or an
 * extra assertion copy merged into the book fetch record. */
function failingReport(reportedLine: number = RUNTIME_LINE, bookFetchAssertion: Json | null = null): string {
  if (reportedLine === RUNTIME_LINE && !bookFetchAssertion) return realTestResults;
  const rewritten = JSON.stringify(JSON.parse(realTestResults))
    .split(`multistep-booking.spec.ts:${RUNTIME_LINE}:`).join(`multistep-booking.spec.ts:${reportedLine}:`)
    .split(`"line":${RUNTIME_LINE}`).join(`"line":${reportedLine}`);
  if (!bookFetchAssertion) return rewritten;
  const reparsed = JSON.parse(rewritten) as Json;
  const steps = ((((reparsed.suites as Json[])[0]!.specs as Json[])[0]!.tests as Json[])[0]!.results as Json[])[0]!.steps as Json[];
  const book = steps.find((step) => step.title === "book 09:30")!;
  const fetchRecord = ((book.steps as Json[]).find((child) => String(child.stepId).startsWith("pw:api"))!.checklyData as Json[])[0]!;
  Object.assign(fetchRecord, bookFetchAssertion);
  return JSON.stringify(reparsed);
}

// ---- synthetic historical healthy run (passing side) ----

const ACCOUNT = FAKE_ACCOUNT;
const TOKEN = FAKE_TOKEN;

function bearer(token: string): Array<{ name: string; value: string }> {
  return [{ name: "authorization", value: `Bearer ${token}` }, { name: "x-vercel-protection-bypass", value: "*********" }];
}

function passingApi(id: string, title: string, method: string, path: string, body: unknown,
  requestBody: unknown, reqHeaders: Array<{ name: string; value: string }>): Json {
  return {
    stepId: id, title, duration: 5,
    checklyData: [{
      fetchUid: `uid-${id}`, url: `${FAKE_ORIGIN}${path}`, status: 200, statusText: "OK",
      headers: [{ name: "content-type", value: "application/json" }],
      requestHeaders: reqHeaders, responseHeaders: [{ name: "content-type", value: "application/json" }],
      method, requestBody, body, timings: { wait: 1, total: 5 }, queryParams: [],
    }],
  };
}

function passingOk(id: string, actual: unknown, expectedData: unknown): Json {
  return { stepId: id, title: "Expect \"toBe\"", duration: 0, checklyData: [{ actual, title: "Expect \"toBe\"", expectedData }] };
}

function passingStep(id: string, title: string, children: Json[]): Json {
  return { stepId: id, title, duration: 10, checklyData: null, steps: children };
}

const COMMON_HEADERS = [
  { name: "user-agent", value: "Checkly/1.0 (https://www.checklyhq.com)" },
  { name: "accept", value: "*/*" },
];

function passingSteps(): Json[] {
  return [
    passingStep("test.step@31", "login", [
      passingApi("pw:api@32", "POST \"/api/login\"", "POST", "/api/login",
        { ok: true, account: ACCOUNT, version: 30, token: TOKEN, store: "upstash" },
        { data: { account: ACCOUNT }, maxRedirects: 20 },
        [...COMMON_HEADERS, { name: "content-type", value: "application/json" }, { name: "x-vercel-protection-bypass", value: "*********" }]),
      passingOk("expect@33", 200, 200), passingOk("expect@34", true, true), passingOk("expect@35", "string", "string"),
      passingOk("expect@36", ACCOUNT, ACCOUNT), passingOk("expect@37", "number", "number"),
      { stepId: "expect@38", title: "Expect \"toBeGreaterThan\"", duration: 0, checklyData: [{ actual: 30, title: "Expect \"toBeGreaterThan\"", expectedData: 0 }] },
      passingOk("expect@39", true, true), passingOk("expect@40", "string", "string"),
      { stepId: "expect@41", title: "Expect \"toBeGreaterThan\"", duration: 0, checklyData: [{ actual: 35, title: "Expect \"toBeGreaterThan\"", expectedData: 0 }] },
    ]),
    passingStep("test.step@42", "session", [
      passingApi("pw:api@43", "GET \"/api/session\"", "GET", "/api/session",
        { valid: true, account: ACCOUNT, tokenVersion: 30, currentVersion: 30 },
        { maxRedirects: 20 }, [...COMMON_HEADERS, ...bearer(TOKEN)]),
      passingOk("expect@44", 200, 200), passingOk("expect@45", true, true), passingOk("expect@46", "string", "string"),
      passingOk("expect@47", ACCOUNT, ACCOUNT), passingOk("expect@48", 30, 30), passingOk("expect@49", 30, 30),
    ]),
    passingStep("test.step@50", "slots", [
      passingApi("pw:api@51", "GET \"/api/slots\"", "GET", "/api/slots",
        { slots: [SELECTED_SLOT, "10:00", "10:30"], delayMs: 1500 },
        { maxRedirects: 20 }, [...COMMON_HEADERS, { name: "x-vercel-protection-bypass", value: "*********" }]),
      passingOk("expect@52", 200, 200), passingOk("expect@53", "object", "object"),
      { stepId: "expect@54", title: "Expect \"not toBeNull\"", duration: 0, checklyData: [{ actual: { slots: [SELECTED_SLOT], delayMs: 1500 }, title: "Expect \"not toBeNull\"" }] },
      passingOk("expect@55", true, true), passingOk("expect@56", "number", "number"),
      { stepId: "expect@57", title: "Expect \"toContain\"", duration: 0, checklyData: [{ actual: [SELECTED_SLOT, "10:00"], title: "Expect \"toContain\"", expectedData: SELECTED_SLOT }] },
    ]),
    passingStep("test.step@58", "book 09:30", [
      passingApi("pw:api@59", "POST \"/api/book\"", "POST", "/api/book",
        { confirmed: true, booking: "CONFIRMED", account: ACCOUNT, slot: SELECTED_SLOT, version: 30 },
        { data: { slot: SELECTED_SLOT }, maxRedirects: 20 },
        [...COMMON_HEADERS, ...bearer(TOKEN), { name: "content-type", value: "application/json" }]),
      passingOk("expect@60", 200, 200), passingOk("expect@61", true, true), passingOk("expect@61b", "CONFIRMED", "CONFIRMED"),
      passingOk("expect@62", "string", "string"), passingOk("expect@63", ACCOUNT, ACCOUNT),
      passingOk("expect@64", SELECTED_SLOT, SELECTED_SLOT), passingOk("expect@65", 30, 30),
    ]),
    passingStep("test.step@70", "confirm transaction", [
      passingOk("expect@71", ACCOUNT, ACCOUNT), passingOk("expect@72", ACCOUNT, ACCOUNT), passingOk("expect@73", ACCOUNT, ACCOUNT),
      passingOk("expect@74", 30, 30), passingOk("expect@75", 30, 30), passingOk("expect@76", 30, 30),
      { stepId: "expect@77", title: "Expect \"toContain\"", duration: 0, checklyData: [{ actual: [SELECTED_SLOT], title: "Expect \"toContain\"", expectedData: SELECTED_SLOT }] },
      passingOk("expect@78", SELECTED_SLOT, SELECTED_SLOT), passingOk("expect@79", SELECTED_SLOT, SELECTED_SLOT),
      passingOk("expect@80", true, true), passingOk("expect@81", "CONFIRMED", "CONFIRMED"),
    ]),
  ];
}

function passingReport(): string {
  return JSON.stringify({
    config: {
      configFile: "/check/x/playwright.config.js", rootDir: "/check/x", forbidOnly: false, fullyParallel: false,
      globalTimeout: 240000, metadata: { actualWorkers: 1 }, preserveOutput: "always",
      projects: [{ id: "chromium", name: "chromium", testDir: "/check/x", testMatch: ["**/*.@(spec|test).?(c|m)[jt]s?(x)"], timeout: 30000, retries: 0 }],
      quiet: false,
      reporter: [["json", { outputFile: "test-results.json", isMultiStepCheckType: true }]],
      runAgents: "none", version: "1.58.3-checkly.2", workers: 1, webServer: null,
    },
    suites: [{
      title: "script.spec.js", file: "script.spec.js", column: 0, line: 0,
      specs: [{
        title: "slots booking multistep transaction", ok: true, tags: [],
        tests: [{
          timeout: 30000, annotations: [], expectedStatus: "passed", projectId: "chromium", projectName: "chromium",
          results: [{
            workerIndex: 0, parallelIndex: 0, status: "passed", duration: 1500, stdout: [], stderr: [],
            retry: 0, steps: passingSteps(), startTime: "2026-09-29T20:08:14.000Z", annotations: [], attachments: [],
          }],
          status: "expected", secretScrubbingDurationMs: 0,
        }],
        id: "ff6f4949ce356f706172-pass", file: "script.spec.js", line: 15, column: 0,
      }],
    }],
    errors: [],
    stats: { startTime: "2026-09-29T20:08:13.334Z", duration: 3000, expected: 1, skipped: 0, unexpected: 0, flaky: 0 },
  });
}

const fail: CheckResultSummary = {
  id: "synthetic-fail", checkId: "synthetic-check", name: "slots booking multistep transaction",
  hasFailures: true, hasErrors: false, runLocation: "us-east-1", startedAt: "2026-09-29T20:33:16.334Z",
  stoppedAt: "2026-09-29T20:33:20.000Z", resultType: "FINAL", attempts: 1, errorGroupIds: ["eg-1"],
};
const pass: CheckResultSummary = { ...fail, id: "synthetic-pass", hasFailures: false, errorGroupIds: [],
  startedAt: "2026-09-29T20:08:13.334Z", stoppedAt: "2026-09-29T20:08:16.500Z" };

interface ManifestVariant {
  contentType?: unknown;
  archiveExtraKey?: boolean;
  dropSourceIds?: boolean;
  reportedLine?: number;
  frequencyOffset?: number | null;
  /** Assertion copy the real runner may also attach to the book fetch record. */
  bookFetchAssertion?: Json;
}

function scheduledClient(variant: ManifestVariant = {}): ChecklyClient {
  const frequencyOffset = variant.frequencyOffset === undefined ? 37 : variant.frequencyOffset;
  const zipFor = (id: string): Buffer => writeZip(id === "synthetic-pass"
    ? { "test-results.json": passingReport(), "check-run-data.json": realCheckRunData, "logs.txt": realLogs }
    : { "test-results.json": failingReport(variant.reportedLine ?? RUNTIME_LINE, variant.bookFetchAssertion ?? null),
        "check-run-data.json": realCheckRunData, "logs.txt": realLogs });
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
    if (variant.contentType === "absent") delete entry.contentType;
    else if (variant.contentType !== undefined) entry.contentType = variant.contentType;
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
          { key: "ENVIRONMENT_URL", value: REAL_TARGET_ORIGIN, secret: false },
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

test("a redundant assertion copy on the book fetch record admits real serializations and rejects contradictions", async () => {
  // The real Checkly 9.5.0 runner keeps the binding assertion on the expect
  // step's checklyData; a fetch-record copy varies in serialization (received
  // `undefined` drops out of JSON, nulls and duplicated expectedData/actualData
  // pairs appear). Copies that agree — or carry nothing assertable — admit;
  // only a genuine contradiction of the stale assertion rejects.
  for (const [label, extra] of [
    ["expected true, actual null", { expected: true, actual: null }],
    ["expected true only", { expected: true }],
    ["duplicated pair form", { expected: true, expectedData: true, actual: null, actualData: null }],
    ["received undefined marker", { expected: true, actual: "undefined" }],
  ] as Array<[string, Json]>) {
    const { bundle } = await scheduledBundle({ bookFetchAssertion: extra });
    assert.deepEqual(bundle.multistep?.problems ?? [], [], `${label} must admit`);
    assert.equal(bundle.multistep?.failureAssertion?.line, SOURCE_LINE, label);
  }
  for (const [label, extra] of [
    ["expected false", { expected: false }],
    ["expected zero", { expected: 0 }],
    ["expected stringified", { expected: "true" }],
    ["claims passed", { expected: true, actual: true }],
  ] as Array<[string, Json]>) {
    const { bundle } = await scheduledBundle({ bookFetchAssertion: extra });
    assert.ok(bundle.multistep?.problems.includes("MULTISTEP_FAILURE_STEP_UNBOUND"), `${label} must reject as FAILURE_STEP_UNBOUND`);
    assert.equal(bundle.scenes.length, 0, label);
  }
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
