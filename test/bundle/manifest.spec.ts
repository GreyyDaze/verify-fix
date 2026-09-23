import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { buildManifest, detectFailurePoint, detectTargetResolution, findOverlappingRuns, resultErrors, summarizeErrorMessage, specLocation, type ManifestInputs } from "../../src/bundle/manifest.ts";
import { classifyRca } from "../../src/bundle/rca-mode.ts";
import { traceZipToHar } from "../../src/trace/trace-to-har.ts";
import { fakeTraceZip } from "../helpers/fake-trace.ts";
import type { ChecklyCheck, CheckResultSummary, ErrorGroup, RootCauseAnalysis } from "../../src/checkly/types.ts";
import { CHECK } from "../helpers/fixtures.ts";

const BASE = "https://slots.example.test";
const SPEC = readFileSync(new URL("../../examples/slots-booking/web/tests/booking.spec.ts", import.meta.url), "utf8");
const PW_CONFIG = readFileSync(new URL("../../examples/slots-booking/web/playwright.config.ts", import.meta.url), "utf8");



function summary(id: string, ok: boolean, startedAt: string, loc = "us-east-1", stoppedAt?: string): CheckResultSummary {
  return { id, hasFailures: !ok, hasErrors: false, runLocation: loc, startedAt, ...(stoppedAt ? { stoppedAt } : {}), resultType: "FINAL", attempts: 1, errorGroupIds: ok ? [] : ["eg-1"] };
}

/** The message Playwright 1.63 produces for the real incident (shape copied from a captured result). */
const REAL_MESSAGE = [
  "Error: expect(locator).toHaveText(expected) failed",
  "",
  "Locator:  getByTestId('book-status')",
  "Expected: \"200\"",
  "Received: \"401\"",
  "Timeout:  10000ms",
  "",
  "Call log:",
  "  - Expect \"toHaveText\" with timeout 10000ms",
  "  - waiting for getByTestId('book-status')",
  "    9 × locator resolved to <span data-testid=\"book-status\">401</span>",
  "      - unexpected value \"401\"",
  "",
  "",
  "  34 |     await page.getByRole('button', { name: 'Book 09:30' }).click()",
  "  35 |",
  "> 36 |     await expect(page.getByTestId('book-status')).toHaveText('200')",
  "     |                                                   ^",
  "  37 |     await expect(page.getByTestId('booking-result')).toHaveText('CONFIRMED')",
  "    at /tmp/checkly/user/tests/booking.spec.ts:36:51",
].join("\n");

const REAL_RESULT_ERROR = {
  error: { message: REAL_MESSAGE, stack: REAL_MESSAGE },
  specId: "spec-1",
  testFile: "tests/booking.spec.ts",
  suitePath: ["slots booking flow"],
  testTitle: "log in and book the 09:30 slot",
  projectName: "booking",
};

function failingExtract() {
  return traceZipToHar(
    fakeTraceZip({
      baseURL: BASE,
      requests: [
        { method: "GET", url: `${BASE}/`, status: 200, mimeType: "text/html", body: "<html/>", t: 1 },
        { method: "POST", url: `${BASE}/api/login`, status: 200, body: '{"token":"tok-demo-3"}', t: 2 },
        { method: "GET", url: `${BASE}/api/slots`, status: 200, body: "{}", t: 3 },
        { method: "POST", url: `${BASE}/api/book`, status: 401, body: '{"error":"session superseded by a newer login"}', t: 4 },
        { method: "GET", url: "https://third-party.example/pixel", status: 500, body: "", t: 5 },
      ],
      actions: [
        { apiName: "page.goto", params: { url: "/" } },
        { apiName: "expect.toHaveText", params: { selector: "book-status", expectedText: [{ string: "200" }] }, error: "Expected string: \"200\"\nReceived string: \"401\"" },
      ],
    }),
  );
}

function passingExtract() {
  return traceZipToHar(
    fakeTraceZip({
      baseURL: BASE,
      requests: [
        { method: "POST", url: `${BASE}/api/login`, status: 200, body: '{"token":"tok-demo-1"}', t: 2 },
        { method: "POST", url: `${BASE}/api/book`, status: 200, body: '{"booking":"CONFIRMED"}', t: 4 },
      ],
      actions: [{ apiName: "expect.toHaveText", params: { expectedText: [{ string: "CONFIRMED" }] } }],
    }),
  );
}

const RCA_RACE: RootCauseAnalysis = {
  id: "rca-1",
  created_at: "2026-09-21T10:00:00Z",
  analysis: {
    classification: "Check configuration issue",
    rootCause: "Two parallel runs from different locations log in with the same test account; the second login supersedes the first session, so the first run's booking request is rejected with 401.",
    userImpact: "None for real users.",
    codeFix: null,
    evidence: [{ description: "POST /api/book returned 401", artifacts: [{ name: "trace.zip", type: "trace" }] }],
    referenceLinks: null,
  },
  provider: "openai",
  model: "gpt-5.1",
  durationMs: 12000,
};

const ERROR_GROUP: ErrorGroup = {
  id: "eg-1",
  checkId: CHECK.id,
  errorHash: "h",
  rawErrorMessage: null,
  cleanedErrorMessage: 'Error: expect(locator).toHaveText(expected) failed\nExpected string: "200"\nReceived string: "401"',
  firstSeen: "2026-09-21T09:50:00Z",
  lastSeen: "2026-09-21T10:00:00Z",
};

function inputs(over: Partial<ManifestInputs> = {}): ManifestInputs {
  const history = [
    summary("r-fail", false, "2026-09-21T10:00:00Z", "eu-west-1"),
    summary("r-pass-2", true, "2026-09-21T09:55:00Z", "us-east-1"),
    summary("r-pass-1", true, "2026-09-21T09:50:00Z", "eu-west-1"),
  ];
  return {
    check: CHECK,
    failing: { summary: history[0], detail: { ...history[0], playwrightCheckResult: { errors: ["tests/booking.spec.ts:19:3 › slots booking flow › log in and book the 09:30 slot\nExpected string: \"200\""] } }, extract: failingExtract() },
    passing: { summary: history[1], detail: null, extract: passingExtract() },
    errorGroup: ERROR_GROUP,
    rca: RCA_RACE,
    history,
    sources: [
      { path: "playwright.config.ts", content: PW_CONFIG },
      { path: "tests/booking.spec.ts", content: SPEC },
    ],
    mainSource: "tests/booking.spec.ts",
    project: { dir: "/repo/monitoring", gitCommit: "abc123", logicalId: "slots-booking-monitoring", repoUrl: "https://github.com/x/y" },
    measurement: null,
    recordings: { failing: "recordings/failing.har", passing: "recordings/passing.har", bodies: "api" },
    assets: [],
    apiCalls: [],
    accountId: "acct-1",
    now: "2026-09-21T12:00:00Z",
    toolVersion: "0.1.0",
    ...over,
  };
}

test("manifest: captured race incident → 3 scenes, live-concurrent reproduction, inject detection, recorded provenance", () => {
  const m = buildManifest(inputs());
  assert.equal(m.schemaVersion, "v3");
  assert.equal(m.incident.status, "captured");
  assert.deepEqual(m.scenes.map((s) => [s.sceneId, s.type, s.mode, s.verdict.mustFail]), [
    ["healthy-live", "HEALTHY", "live", false],
    ["reproduction", "REPRODUCTION", "live-concurrent:2", false],
    ["detection", "DETECTION", "inject:POST /api/book -> 401", true],
  ]);
  assert.equal(m.reproduction.mode, "live-concurrent:2");
  assert.match(m.reproduction.matchedRule!, /concurrency/);
  assert.equal(m.scenes[1].verdict.provenance.kind, "recorded");
  assert.equal((m.scenes[1].verdict.provenance as { runId: string }).runId, "r-fail");
  assert.equal((m.scenes[0].verdict.provenance as { runId: string }).runId, "r-pass-2");
  assert.deepEqual(m.oracleProvenance, { recorded: 3, codeDerived: 0 });
  // failure point: last failed same-origin API call, third-party 500 ignored
  assert.equal(m.failurePoint?.request?.path, "/api/book");
  assert.equal(m.failurePoint?.request?.status, 401);
  assert.equal(m.failurePoint?.request?.passingStatus, 200);
  assert.equal(m.failurePoint?.action?.apiName, "expect.toHaveText");
  // assertions come from the real spec; the detection scene binds to the failing expect (toHaveText '200')
  assert.ok(m.assertions && m.assertions.totalAssertions >= 4);
  const bound = m.assertions!.assertions.filter((a) => m.scenes[2].assertionsInvolved.includes(a.id));
  assert.ok(bound.length >= 1 && bound.every((a) => a.matcher === "toHaveText" && a.target === "'200'"), JSON.stringify(bound));
  // config facts
  assert.equal(m.config.runParallel, true);
  assert.deepEqual(m.config.environmentVariables, [{ key: "TEST_USER", secret: false }, { key: "APP_PASSWORD", secret: true }]);
  assert.equal(m.target.resolution, "code");
  assert.equal(m.target.recordedOrigin, BASE);
  assert.ok(m.envAssumptions.some((a) => a.id === "run-parallel"));
  assert.ok(m.envAssumptions.some((a) => a.id === "shared-account" && a.text.includes("TEST_USER")));
  assert.equal(m.determinism.measured, false);
  assert.equal(m.determinism.history.finalRuns, 3);
  assert.equal(m.determinism.history.passRate, 0.667);
  assert.equal(m.determinism.history.byLocation["eu-west-1"].passed, 1);
  assert.equal(m.check.projectCommit, "abc123");
  assert.equal(m.check.logicalId, "slots-booking-monitoring");
});

test("manifest: never contains an env var value", () => {
  const m = buildManifest(inputs());
  const text = JSON.stringify(m);
  assert.equal(text.includes("demo-account-value"), false);
  assert.equal(text.includes("sup3r-secret-value"), false);
});

test("manifest: healthy check without failure → baseline bundle with only the HEALTHY scene", () => {
  const history = [summary("r-pass-2", true, "2026-09-21T09:55:00Z"), summary("r-pass-1", true, "2026-09-21T09:50:00Z")];
  const m = buildManifest(inputs({ failing: null, errorGroup: null, rca: null, history, passing: { summary: history[0], detail: null, extract: passingExtract() }, recordings: { failing: null, passing: "recordings/passing.har", bodies: "api" } }));
  assert.equal(m.incident.status, "no-failure-yet");
  assert.deepEqual(m.scenes.map((s) => s.sceneId), ["healthy-live"]);
  assert.equal(m.reproduction.mode, "both");
  assert.equal(m.failurePoint, null);
  assert.ok(m.notes.some((n) => /no failing result/.test(n)));
  assert.match(m.incidentId, /-baseline$/);
});

test("manifest: changed-response RCA → replay mode; no RCA → both with alternative mode", () => {
  const rcaChanged: RootCauseAnalysis = { ...RCA_RACE, id: "rca-2", analysis: { ...RCA_RACE.analysis, rootCause: "The booking API renamed field `booking` to `status`; the check still reads the old property." } };
  const replay = buildManifest(inputs({ rca: rcaChanged }));
  assert.equal(replay.reproduction.mode, "replay:failing.har");
  assert.equal(replay.scenes[1].mode, "replay:failing.har");
  assert.equal(replay.scenes[1].environment, "recording");

  const none = buildManifest(inputs({ rca: null, errorGroup: { ...ERROR_GROUP, cleanedErrorMessage: "Error: something odd" } }));
  assert.equal(none.reproduction.mode, "both");
  assert.equal(none.scenes[1].mode, "live-concurrent:2");
  assert.equal(none.scenes[1].alternativeMode, "replay:failing.har");
});

test("manifest: no passing result → HEALTHY provenance falls back to code with a note", () => {
  const m = buildManifest(inputs({ passing: null, recordings: { failing: "recordings/failing.har", passing: null, bodies: "api" } }));
  const healthy = m.scenes.find((s) => s.type === "HEALTHY")!;
  assert.equal(healthy.verdict.provenance.kind, "code");
  assert.ok(healthy.notes?.some((n) => /no passing result/.test(n)));
  assert.equal(m.failurePoint?.request?.passingStatus, null);
});

test("manifest: an overlapping run from another location decides live-concurrent, even when the RCA text says otherwise", () => {
  // failing run 10:00:00–10:00:25 @ eu-west-1; us-east-1 started 4 s earlier and passed
  const history = [
    summary("r-fail", false, "2026-09-21T10:00:00Z", "eu-west-1", "2026-09-21T10:00:25Z"),
    summary("r-pass-2", true, "2026-09-21T09:59:56Z", "us-east-1", "2026-09-21T10:00:12Z"),
    summary("r-pass-1", true, "2026-09-21T09:50:00Z", "eu-west-1", "2026-09-21T09:50:20Z"),
  ];
  const rcaInfra: RootCauseAnalysis = {
    ...RCA_RACE,
    analysis: { ...RCA_RACE.analysis, classification: "INFRASTRUCTURE_ERROR", rootCause: "The API returned an unexpected status code 401.", repairRecommendation: "DO_NOT_REPAIR" },
  };
  const m = buildManifest(inputs({ history, rca: rcaInfra, failing: { summary: history[0], detail: { ...history[0], errors: [REAL_RESULT_ERROR] }, extract: failingExtract() } }));
  assert.equal(m.reproduction.mode, "live-concurrent:2");
  assert.equal(m.reproduction.matchedRule, "overlapping-run");
  assert.equal(m.reproduction.decidedBy, "result-timestamps");
  assert.deepEqual(
    m.reproduction.overlappingRuns.map((o) => [o.runId, o.runLocation, o.startDeltaMs, o.overlapMs, o.passed]),
    [["r-pass-2", "us-east-1", 4000, 12000, true]],
  );
  assert.match(m.reproduction.reason, /r-pass-2 from us-east-1 started 4\.0 s before the failing run/);
  assert.ok(m.notes.some((n) => /RCA text suggested replay:failing\.har/.test(n) && /follows the timestamps/.test(n)), m.notes.join("\n"));
  assert.ok(m.envAssumptions.some((a) => a.id === "overlapping-run" && a.verified && /GET \/v2\/check-results/.test(a.verifiedBy)));
  assert.equal(m.scenes[1].mode, "live-concurrent:2");
  assert.ok(m.scenes[1].verdict.envAssumptions.includes("overlapping-run"), "the reproduction scene names the overlap as its evidence");
  assert.equal(m.rca?.repairRecommendation, "DO_NOT_REPAIR");
  // the same-location earlier run does not count as an overlap
  assert.equal(findOverlappingRuns(history[0], history).length, 1);
});

test("manifest: a sibling that failed at the same moment is not evidence of concurrency (drift shape)", () => {
  // runParallel: both locations fail in the same minute, and so did the cycle before.
  // The overlap is real but decides nothing — the failure does not depend on which copy wins.
  const history = [
    summary("d-fail-eu", false, "2026-09-23T10:00:00Z", "eu-west-1", "2026-09-23T10:00:20Z"),
    summary("d-fail-us", false, "2026-09-23T09:59:59Z", "us-east-1", "2026-09-23T10:00:18Z"),
    summary("d-fail-eu-0", false, "2026-09-23T09:55:00Z", "eu-west-1", "2026-09-23T09:55:20Z"),
    summary("d-fail-us-0", false, "2026-09-23T09:54:59Z", "us-east-1", "2026-09-23T09:55:19Z"),
    summary("d-pass-eu", true, "2026-09-23T09:50:00Z", "eu-west-1", "2026-09-23T09:50:15Z"),
    summary("d-pass-us", true, "2026-09-23T09:49:59Z", "us-east-1", "2026-09-23T09:50:14Z"),
  ];
  const rcaDrift: RootCauseAnalysis = {
    ...RCA_RACE,
    analysis: { ...RCA_RACE.analysis, classification: "CHECK_ERROR", rootCause: "The locator getByTestId('book-status') was not found because the element was renamed in the latest deploy.", repairRecommendation: "REPAIR" },
  };
  const m = buildManifest(inputs({ history, rca: rcaDrift, failing: { summary: history[0], detail: { ...history[0], errors: [REAL_RESULT_ERROR] }, extract: failingExtract() }, passing: { summary: history[4], detail: null, extract: passingExtract() } }));
  // the overlap is recorded as evidence …
  assert.deepEqual(m.reproduction.overlappingRuns.map((o) => [o.runId, o.passed]), [["d-fail-us", false]]);
  assert.ok(m.envAssumptions.some((a) => a.id === "overlapping-run" && /d-fail-us \(us-east-1, failed\)/.test(a.text)));
  // … but it does not decide the mode; the text rule does
  assert.notEqual(m.reproduction.decidedBy, "result-timestamps");
  assert.notEqual(m.reproduction.matchedRule, "overlapping-run");
  assert.equal(m.reproduction.decidedBy, "rca-text");
  assert.equal(m.reproduction.mode, "replay:failing.har");
  assert.ok(m.notes.some((n) => /d-fail-us @ us-east-1 overlapped the failing run and failed too/.test(n) && /not evidence of concurrency/.test(n)), m.notes.join("\n"));
  assert.equal(m.scenes[1].mode, "replay:failing.har");
  assert.equal(m.scenes[1].verdict.envAssumptions.includes("overlapping-run"), false, "a failed sibling is not the reproduction scene's evidence");
});

test("manifest: Rocky guardrails (intent, aiAutoRepairEnabled) are recorded as evidence, absent → null", () => {
  const bare = buildManifest(inputs());
  assert.deepEqual(bare.config.repair, { intent: null, aiAutoRepairEnabled: null });
  const guarded: ChecklyCheck = {
    ...CHECK,
    intent: { goal: "A logged-in user can book the 09:30 slot.", mustPreserve: ["The booking status assertion expects 200."], requiredOutcomes: null },
    aiAutoRepairEnabled: false,
  };
  const m = buildManifest(inputs({ check: guarded }));
  assert.deepEqual(m.config.repair, {
    intent: { goal: "A logged-in user can book the 09:30 slot.", requiredOutcomes: [], mustPreserve: ["The booking status assertion expects 200."] },
    aiAutoRepairEnabled: false,
  });
  // still no env var value anywhere
  assert.equal(JSON.stringify(m).includes("demo-account-value"), false);
});

test("manifest: real Playwright result shape → error text, failing test, spec line, assertion id, readable title", () => {
  const history = [summary("r-fail", false, "2026-09-21T10:00:00Z", "eu-west-1"), summary("r-pass-2", true, "2026-09-21T09:55:00Z")];
  const m = buildManifest(inputs({ history, failing: { summary: history[0], detail: { ...history[0], errors: [REAL_RESULT_ERROR] }, extract: failingExtract() } }));
  assert.equal(m.results.failing?.errors.length, 1);
  assert.match(m.results.failing!.errors[0], /^Error: expect\(locator\)\.toHaveText/);
  assert.deepEqual(m.results.failing?.failingTest, { file: "tests/booking.spec.ts", title: "log in and book the 09:30 slot", project: "booking", line: 36, column: 51 });
  assert.equal(m.incident.title, `${CHECK.name}: expect(locator).toHaveText(expected) failed — on getByTestId('book-status'), expected "200", received "401"`);
  assert.match(m.incident.description, /Network: POST \/api\/book → 401 \(passing run: 200\)/);
  assert.match(m.incident.description, /Rocky RCA \(Check configuration issue\)/);
  // the failing step keeps the runner's full message, not the trace's bare error
  assert.match(m.failurePoint!.action!.error, /Received: "401"/);
  assert.deepEqual(m.failurePoint!.assertion, { file: "tests/booking.spec.ts", line: 36, column: 51, assertionId: "assert:fab411b3" });
  // the detection scene binds exactly the assertion on the failing line
  assert.deepEqual(m.scenes[2].assertionsInvolved, ["assert:fab411b3"]);
});

test("result errors: strings, playwright objects and API request errors all normalize to messages", () => {
  assert.deepEqual(resultErrors({ id: "x", hasFailures: true, hasErrors: false, runLocation: "l", startedAt: "t", errors: [REAL_RESULT_ERROR, "plain"] }).map((e) => e.split("\n")[0]), [
    "Error: expect(locator).toHaveText(expected) failed",
    "plain",
  ]);
  assert.deepEqual(resultErrors({ id: "x", hasFailures: true, hasErrors: false, runLocation: "l", startedAt: "t", browserCheckResult: { errors: ["legacy"] } }), ["legacy"]);
  assert.deepEqual(resultErrors({ id: "x", hasFailures: true, hasErrors: false, runLocation: "l", startedAt: "t", apiCheckResult: { requestError: "ECONNRESET" } }), ["ECONNRESET"]);
  assert.deepEqual(resultErrors(null), []);
  assert.deepEqual(specLocation(REAL_MESSAGE, "tests/booking.spec.ts"), { file: "tests/booking.spec.ts", line: 36, column: 51 });
  assert.deepEqual(specLocation("> 12 | expect(x)", null), { file: null, line: 12, column: null });
  assert.deepEqual(specLocation("nothing here", null), { file: null, line: null, column: null });
  assert.equal(summarizeErrorMessage("Error: page.goto: net::ERR_NAME_NOT_RESOLVED at https://x\nCall log:\n  - navigating"), "page.goto: net::ERR_NAME_NOT_RESOLVED at https://x");
  assert.equal(summarizeErrorMessage("x".repeat(400)).length, 160);
});

test("rca rule table: fixed mapping, earliest match wins, unknown → both", () => {
  assert.equal(classifyRca("A race condition between two locations").mode, "live-concurrent:2");
  assert.equal(classifyRca("The second login invalidated the first session").mode, "live-concurrent:2");
  assert.equal(classifyRca("Selector #book was not found after the redesign").mode, "replay:failing.har");
  assert.equal(classifyRca("The API returned an unexpected status code 500").mode, "replay:failing.har");
  assert.equal(classifyRca("DNS resolution timed out").mode, "both");
  assert.equal(classifyRca(null).mode, "both");
  assert.equal(classifyRca("").matchedRule, null);
});

test("target resolution: handlebars for API checks, code for ENVIRONMENT_URL in source, unknown otherwise", () => {
  const api: ChecklyCheck = { ...CHECK, checkType: "API", request: { method: "GET", url: "{{ENVIRONMENT_URL}}/api/health" } };
  assert.equal(detectTargetResolution(api, []), "handlebars");
  assert.equal(detectTargetResolution(CHECK, [{ path: "x.ts", content: "const base = process.env.ENVIRONMENT_URL ?? 'https://prod'" }]), "code");
  assert.equal(detectTargetResolution(CHECK, [{ path: "x.ts", content: "await page.goto('https://prod')" }]), "unknown");
});

test("failure point: nothing to report without a failing trace", () => {
  assert.equal(detectFailurePoint(null, null), null);
});
