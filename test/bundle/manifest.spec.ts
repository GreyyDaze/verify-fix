import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { buildManifest, detectFailurePoint, detectTargetResolution, expectedReceived, failingTestOf, findOverlappingRuns, groupErrorMatches, rcaFit, rcaIsStale, rcaMentionsReceived, resultErrors, runOutcome, summarizeErrorMessage, specLocation, type ManifestInputs } from "../../src/bundle/manifest.ts";
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

// Playwright 1.63, locator matched nothing: no "Received:" line at all — the outcome is an "Error:" line under Timeout (copied from the live drift capture)
const DRIFT_MESSAGE = REAL_MESSAGE.replace('Received: "401"\nTimeout:  10000ms', 'Timeout: 10000ms\nError: element(s) not found');
// older Playwright wording, kept so both shapes parse
const DRIFT_MESSAGE_LEGACY = REAL_MESSAGE.replace('Received: "401"', "Received: <element(s) not found>");
const DRIFT_RESULT_ERROR = { ...REAL_RESULT_ERROR, error: { message: DRIFT_MESSAGE, stack: DRIFT_MESSAGE } };

test("expected/received: Playwright and Checkly-cleaned shapes parse; a group matches a run only when Received agrees", () => {
  assert.deepEqual(expectedReceived(REAL_MESSAGE), { expected: '"200"', received: '"401"' });
  assert.ok(/Timeout: 10000ms\nError: element\(s\) not found/.test(DRIFT_MESSAGE), "fixture message has the live shape");
  assert.deepEqual(expectedReceived(DRIFT_MESSAGE), { expected: '"200"', received: "element(s) not found" });
  assert.deepEqual(expectedReceived(DRIFT_MESSAGE_LEGACY), { expected: '"200"', received: "<element(s) not found>" });
  assert.deepEqual(runOutcome(["tests/booking.spec.ts:19:3 › suite › test", DRIFT_MESSAGE]), { expected: '"200"', received: "element(s) not found" });
  assert.deepEqual(expectedReceived(ERROR_GROUP.cleanedErrorMessage), { expected: '"200"', received: '"401"' });
  assert.deepEqual(expectedReceived("Error: page.goto: net::ERR_NAME_NOT_RESOLVED"), { expected: null, received: null });
  // Checkly's cleaned message is one line: the value must stop at the next label
  const ONE_LINE = `Error: expect(locator).toHaveText(expected) failed Locator: getByTestId('book-status') Expected: "200" Received: "401" Timeout: 10000ms Call log: - Expect "toHaveText"`;
  assert.deepEqual(expectedReceived(ONE_LINE), { expected: '"200"', received: '"401"' });
  const ONE_LINE_DRIFT = `Error: expect(locator).toHaveText(expected) failed Locator: getByTestId('book-status') Expected: "200" Timeout: 10000ms Error: element(s) not found Call log: - Expect "toHaveText"`;
  assert.deepEqual(expectedReceived(ONE_LINE_DRIFT), { expected: '"200"', received: "element(s) not found" });
  assert.equal(groupErrorMatches(ONE_LINE, [REAL_MESSAGE]), true);
  assert.equal(groupErrorMatches(ONE_LINE, [DRIFT_MESSAGE]), false);
  assert.equal(groupErrorMatches(ERROR_GROUP.cleanedErrorMessage, [REAL_MESSAGE]), true);
  assert.equal(groupErrorMatches(ERROR_GROUP.cleanedErrorMessage, [DRIFT_MESSAGE]), false);
  assert.equal(groupErrorMatches("Error: timeout", [DRIFT_MESSAGE]), null, "no Received on the group side → not comparable");
  assert.equal(groupErrorMatches(ERROR_GROUP.cleanedErrorMessage, ["tests/booking.spec.ts:19:3 › suite › test"]), null);
});

test("rca fit: Rocky's paraphrased text is searched for what the run received; only an RCA older than the run can be stale", () => {
  const rca401: RootCauseAnalysis = {
    ...RCA_RACE,
    analysis: { ...RCA_RACE.analysis, rootCause: "The booking flow returned an HTTP 401 where 200 was expected.", evidence: [{ description: "the DOM repeatedly shows <span data-testid=\"book-status\">401</span>", artifacts: [] }], steps: [{ name: "Validate the booking status", errors: ["Booking status element reported 401 instead of the expected 200."] }] },
  };
  assert.equal(rcaMentionsReceived(rca401, [REAL_MESSAGE]), true, '"401" → 401 appears in the text');
  assert.equal(rcaMentionsReceived(rca401, [DRIFT_MESSAGE]), false, "element(s) not found appears nowhere");
  assert.equal(rcaMentionsReceived(rca401, ["tests/booking.spec.ts:19:3 › suite › test"]), null);
  assert.equal(rcaMentionsReceived(null, [DRIFT_MESSAGE]), null);
  // an RCA written BEFORE the run is stale when the group merges different failures…
  assert.deepEqual(rcaFit({ rca: rca401, createdBefore: true, groupMatches: false, mentions: false }), { stale: true, describes: false });
  assert.deepEqual(rcaFit({ rca: rca401, createdBefore: true, groupMatches: false, mentions: true }), { stale: true, describes: false }, "group mismatch wins: the text may mention the value for other reasons");
  // …or when it never mentions what the run received, even if the group message is not comparable
  assert.deepEqual(rcaFit({ rca: rca401, createdBefore: true, groupMatches: null, mentions: false }), { stale: true, describes: false });
  assert.deepEqual(rcaFit({ rca: rca401, createdBefore: true, groupMatches: true, mentions: false }), { stale: true, describes: false });
  // same failure recurring: trusted
  assert.deepEqual(rcaFit({ rca: rca401, createdBefore: true, groupMatches: true, mentions: true }), { stale: false, describes: true });
  assert.deepEqual(rcaFit({ rca: rca401, createdBefore: true, groupMatches: true, mentions: null }), { stale: false, describes: true });
  // an RCA created AFTER the run is never stale: the group message never updates, so a mismatch there
  // says nothing about a later analysis (and re-requesting it on every capture would loop forever)
  assert.deepEqual(rcaFit({ rca: rca401, createdBefore: false, groupMatches: false, mentions: true }), { stale: false, describes: true });
  assert.deepEqual(rcaFit({ rca: rca401, createdBefore: false, groupMatches: false, mentions: false }), { stale: false, describes: null }, "not decidable from the outside");
  assert.deepEqual(rcaFit({ rca: rca401, createdBefore: false, groupMatches: null, mentions: null }), { stale: false, describes: null });
  // nothing comparable at all
  assert.deepEqual(rcaFit({ rca: rca401, createdBefore: true, groupMatches: null, mentions: null }), { stale: false, describes: null });
  assert.deepEqual(rcaFit({ rca: null, createdBefore: true, groupMatches: false, mentions: false }), { stale: false, describes: null });
  assert.equal(rcaIsStale({ rca: rca401, createdBefore: true, groupMatches: false, mentions: false }), true);
});

test("manifest: an RCA that predates a different failure in the same group is flagged, not trusted", () => {
  // Seen live on 2026-09-23: the UI rename ("element(s) not found") was grouped
  // with the 401 incident, so no new RCA ran and the drift inherited
  // INFRASTRUCTURE_ERROR / DO_NOT_REPAIR from two days earlier.
  const history = [
    summary("d-fail", false, "2026-09-23T13:40:00Z", "eu-west-1", "2026-09-23T13:40:18Z"),
    summary("d-pass", true, "2026-09-23T13:35:00Z", "eu-west-1", "2026-09-23T13:35:10Z"),
  ];
  const oldRca: RootCauseAnalysis = { ...RCA_RACE, id: "rca-old", created_at: "2026-09-21T16:20:00Z", analysis: { ...RCA_RACE.analysis, classification: "INFRASTRUCTURE_ERROR", repairRecommendation: "DO_NOT_REPAIR" } };
  const m = buildManifest(inputs({ history, rca: oldRca, failing: { summary: history[0], detail: { ...history[0], errors: [DRIFT_RESULT_ERROR] }, extract: failingExtract() }, passing: { summary: history[1], detail: null, extract: passingExtract() } }));
  assert.equal(m.rca?.createdBeforeFailingRun, true);
  assert.equal(m.rca?.groupErrorMatchesFailingRun, false);
  assert.equal(m.rca?.replaced, null);
  assert.ok(m.notes.some((n) => /merges different failures/.test(n) && /received "401"/.test(n) && /received element\(s\) not found/.test(n) && /--trigger-rca/.test(n)), m.notes.join("\n"));
  assert.equal(m.rca?.describesFailingRun, false);
  // the two incidents must not share an incident id even though Checkly gave them one group
  const overlapId = buildManifest(inputs({ history, rca: oldRca, failing: { summary: history[0], detail: { ...history[0], errors: [REAL_RESULT_ERROR] }, extract: failingExtract() }, passing: { summary: history[1], detail: null, extract: passingExtract() } })).incidentId;
  assert.notEqual(m.incidentId, overlapId);
  assert.match(m.incidentId, /^slots-booking-monitoring-[0-9a-f]{6}$/);
  // same group, but Checkly updated the group message to the new failure → signal 2 (old RCA never mentions "element(s) not found") still flags it
  const updatedGroup = { ...ERROR_GROUP, cleanedErrorMessage: ERROR_GROUP.cleanedErrorMessage.replace('Received string: "401"', "Timeout: 10000ms\nError: element(s) not found") };
  const viaText = buildManifest(inputs({ history, rca: oldRca, errorGroup: updatedGroup, failing: { summary: history[0], detail: { ...history[0], errors: [DRIFT_RESULT_ERROR] }, extract: failingExtract() }, passing: { summary: history[1], detail: null, extract: passingExtract() } }));
  assert.equal(viaText.rca?.groupErrorMatchesFailingRun, true);
  assert.equal(viaText.rca?.mentionsFailingRunReceived, false);
  assert.equal(viaText.rca?.describesFailingRun, false);
  assert.ok(viaText.notes.some((n) => /never mentions what the captured run received/.test(n) && /--trigger-rca/.test(n)), viaText.notes.join("\n"));
  // the same run in a group whose first failure IS this failure → fine
  const same = buildManifest(inputs({ history, rca: oldRca, failing: { summary: history[0], detail: { ...history[0], errors: [REAL_RESULT_ERROR] }, extract: failingExtract() }, passing: { summary: history[1], detail: null, extract: passingExtract() } }));
  assert.equal(same.rca?.groupErrorMatchesFailingRun, true);
  assert.equal(same.rca?.describesFailingRun, true);
  assert.equal(same.notes.some((n) => /merges different failures|never mentions/.test(n)), false);
  // a fresh RCA that replaced the old one is recorded with its predecessor
  const fresh: RootCauseAnalysis = { ...oldRca, id: "rca-fresh", created_at: "2026-09-23T13:45:00Z", analysis: { ...oldRca.analysis, classification: "CHECK_ERROR", codeFix: "page.getByTestId('booking-status')", repairRecommendation: "REPAIR" } };
  const replaced = buildManifest(inputs({ history, rca: fresh, replacedRca: oldRca, failing: { summary: history[0], detail: { ...history[0], errors: [DRIFT_RESULT_ERROR] }, extract: failingExtract() }, passing: { summary: history[1], detail: null, extract: passingExtract() } }));
  assert.deepEqual(replaced.rca?.replaced, { id: "rca-old", createdAt: "2026-09-21T16:20:00Z", classification: "INFRASTRUCTURE_ERROR" });
  assert.equal(replaced.rca?.createdBeforeFailingRun, false);
  // fresh RCA whose text (copied from the 401 analysis here) never says "element(s) not found":
  // not stale (it postdates the run), but not confirmed either — the reader is told to read it
  assert.equal(replaced.rca?.describesFailingRun, null);
  assert.ok(replaced.notes.some((n) => /created after this run but its text never mentions what the run received \(element\(s\) not found\)/.test(n)), replaced.notes.join("\n"));
  assert.equal(replaced.rca?.codeFix, "page.getByTestId('booking-status')");
  assert.ok(replaced.notes.some((n) => /requested by verify-fix bundle \(--trigger-rca\)/.test(n) && /rca-old/.test(n)), replaced.notes.join("\n"));
});

test("live result shape: errors nested under playwrightCheckResult still yield failingTest, outcome and a readable title", () => {
  // Captured live: the API nests errors; the bundle's results/*.json lifts them. The first two
  // real captures wrote failingTest: null because only the lifted shape was read.
  const live = { id: "r", runLocation: "eu-west-1", startedAt: "2026-09-23T16:23:56Z", hasFailures: true, hasErrors: false, playwrightCheckResult: { errors: [DRIFT_RESULT_ERROR] } } as unknown as Parameters<typeof failingTestOf>[0];
  assert.deepEqual(failingTestOf(live), { file: "tests/booking.spec.ts", title: "log in and book the 09:30 slot", project: "booking", line: 36, column: 51 });
  assert.equal(summarizeErrorMessage(DRIFT_MESSAGE), `expect(locator).toHaveText(expected) failed — on getByTestId('book-status'), expected "200", element(s) not found`);
  assert.equal(summarizeErrorMessage(REAL_MESSAGE), `expect(locator).toHaveText(expected) failed — on getByTestId('book-status'), expected "200", received "401"`);
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
