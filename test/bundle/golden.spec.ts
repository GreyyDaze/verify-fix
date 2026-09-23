// Golden test over the REAL captured bundle (fixtures/bundles/slots-booking-overlap).
//
// The fixture was produced by `verify-fix bundle` against the real Checkly
// account: real result documents, real Rocky RCA, real spec files, real HAR.
// This test feeds those files back through buildManifest and pins the
// decisions the tool must make on them. The raw trace zips are not in git
// (raw/ is ignored), so the trace extract is rebuilt from the HAR and the
// action list the bundle already contains.

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { buildManifest, resultErrors, type FetchedResult, type ManifestInputs } from "../../src/bundle/manifest.ts";
import type { ChecklyCheck, CheckResult, CheckResultSummary, ErrorGroup, RootCauseAnalysis } from "../../src/checkly/types.ts";
import type { Har } from "../../src/trace/har-types.ts";
import type { TraceAction, TraceExtract } from "../../src/trace/trace-to-har.ts";
import type { ManifestV3 } from "../../src/bundle/types.ts";

const DIR = new URL("../../fixtures/bundles/slots-booking-overlap/", import.meta.url).pathname;
const read = (rel: string) => readFileSync(join(DIR, rel), "utf8");
const json = <T>(rel: string) => JSON.parse(read(rel)) as T;

const captured = json<ManifestV3>("manifest.json");
const checkConfig = json<{ check: ManifestV3["check"]; config: ManifestV3["config"]; target: ManifestV3["target"] }>("check.config.json");
const failingResult = json<CheckResult>("results/failing.json");
const passingResult = json<CheckResult>("results/passing.json");
const rcaDoc = json<{ errorGroup: ManifestV3["errorGroup"]; rca: RootCauseAnalysis | null }>("rca.json");
const historyFile = existsSync(join(DIR, "results/history.json")) ? json<CheckResultSummary[]>("results/history.json") : null;

/** Rebuild the extract from what the bundle kept (HAR + actions without params). */
function extractFrom(label: "failing" | "passing"): TraceExtract {
  const har = json<Har>(`recordings/${label}.har`);
  const raw = json<Array<Partial<TraceAction> & { apiName: string; title: string; error: string | null }>>(`recordings/${label}.actions.json`);
  const actions: TraceAction[] = raw.map((a) => ({
    callId: a.callId ?? "",
    apiName: a.apiName,
    title: a.title,
    category: a.category ?? (a.apiName.startsWith("Test.") ? "expect" : "browser"),
    startTime: a.startTime ?? null,
    endTime: a.endTime ?? null,
    error: a.error ?? null,
    params: a.params ?? {},
    location: a.location ?? null,
  }));
  const errored = actions.filter((a) => a.error);
  const failingAction = errored.find((a) => a.category === "expect" || a.category === "pw:api") ?? errored[0] ?? null;
  const origin = har.log.entries[0] ? new URL(har.log.entries[0].request.url).origin : null;
  return { har, actions, failingAction, baseURL: origin, browserName: "chromium", files: { network: [], trace: [], resources: 0 } };
}

function summaryOf(r: CheckResult): CheckResultSummary {
  return {
    id: r.id,
    hasFailures: r.hasFailures,
    hasErrors: r.hasErrors,
    runLocation: r.runLocation,
    startedAt: r.startedAt,
    stoppedAt: r.stoppedAt,
    resultType: r.resultType,
    attempts: r.attempts,
    errorGroupIds: r.errorGroupIds,
  };
}

const check: ChecklyCheck = {
  id: checkConfig.check.deployedId ?? checkConfig.check.id,
  name: captured.check.name,
  checkType: "PLAYWRIGHT",
  groupId: null,
  runtimeId: null,
  frequency: checkConfig.config.frequencyMinutes,
  locations: checkConfig.config.locations,
  runParallel: checkConfig.config.runParallel,
  activated: checkConfig.config.activated,
  muted: checkConfig.config.muted,
  tags: checkConfig.config.tags,
  environmentVariables: checkConfig.config.environmentVariables.map((e) => ({ key: e.key, value: "x", secret: e.secret })),
  playwrightVersion: checkConfig.config.playwright?.version ?? undefined,
};

const sources = captured.check.files.map((f) => ({ path: f, content: read(join("check", f)) }));

function inputs(over: Partial<ManifestInputs> = {}): ManifestInputs {
  const failing: FetchedResult = { summary: summaryOf(failingResult), detail: failingResult, extract: extractFrom("failing") };
  const passing: FetchedResult = { summary: summaryOf(passingResult), detail: passingResult, extract: extractFrom("passing") };
  const history = historyFile ?? [failing.summary, passing.summary];
  const errorGroup: ErrorGroup | null = rcaDoc.errorGroup
    ? { id: rcaDoc.errorGroup.id, checkId: check.id, errorHash: "", rawErrorMessage: null, cleanedErrorMessage: rcaDoc.errorGroup.cleanedErrorMessage, firstSeen: rcaDoc.errorGroup.firstSeen, lastSeen: rcaDoc.errorGroup.lastSeen }
    : null;
  return {
    check,
    failing,
    passing,
    errorGroup,
    rca: rcaDoc.rca,
    history,
    sources,
    mainSource: captured.check.file,
    project: { dir: "examples/slots-booking/web", gitCommit: captured.check.projectCommit, logicalId: captured.check.logicalId, repoUrl: captured.check.repo, playwright: { configPath: "./playwright.config.ts", projects: ["booking"], tags: [] } },
    measurement: null,
    recordings: { failing: "recordings/failing.har", passing: "recordings/passing.har", bodies: "api" },
    assets: [],
    apiCalls: [],
    accountId: "acct",
    now: captured.generatedAt,
    toolVersion: captured.generatedBy.split("@")[1] ?? "0.1.0",
    ...over,
  };
}

test("golden (real bundle): the captured incident is the booking 401 at spec line 36, bound to assert:fab411b3", () => {
  const m = buildManifest(inputs());
  assert.equal(m.incident.status, "captured");
  assert.equal(m.incident.title, "slots booking flow: expect(locator).toHaveText(expected) failed — on getByTestId('book-status'), expected \"200\", received \"401\"");
  // The fixture is re-captured from the live account; the run id changes, the shape must not.
  assert.equal(m.results.failing?.id, failingResult.id);
  assert.equal(m.results.failing?.id, captured.results.failing?.id);
  assert.equal(m.results.failing?.runLocation, "us-east-1");
  assert.deepEqual(m.results.failing?.failingTest, { file: "booking.spec.ts", title: "log in and book the 09:30 slot", project: "booking", line: 36, column: 51 });
  assert.equal(m.results.failing?.errors.length, 1);
  assert.equal(m.results.failing?.errors[0].includes("\u001b["), false, "no ANSI colour codes in stored errors");
  // network: POST /api/book 401 in the failing run, 200 in the passing run
  assert.equal(m.failurePoint?.request?.method, "POST");
  assert.equal(m.failurePoint?.request?.path, "/api/book");
  assert.equal(m.failurePoint?.request?.status, 401);
  assert.equal(m.failurePoint?.request?.passingStatus, 200);
  // spec line → assertion id (line 27 has the same matcher/target, so the same id)
  assert.deepEqual(m.failurePoint?.assertion, { file: "booking.spec.ts", line: 36, column: 51, assertionId: "assert:fab411b3" });
  assert.match(m.failurePoint!.action!.error, /Received: "401"/);
  const detection = m.scenes.find((s) => s.type === "DETECTION")!;
  assert.equal(detection.mode, "inject:POST /api/book -> 401");
  assert.deepEqual(detection.assertionsInvolved, ["assert:fab411b3"]);
  assert.equal(detection.verdict.mustFail, true);
  // config facts survive as recorded
  assert.equal(m.config.runParallel, true);
  assert.deepEqual(m.config.locations, ["us-east-1", "eu-west-1"]);
  assert.deepEqual(m.config.environmentVariables, [{ key: "TEST_USER", secret: false }]);
  assert.equal(m.config.playwright?.configPath, "./playwright.config.ts");
  assert.deepEqual(m.config.playwright?.projects, ["booking"]);
  assert.equal(m.config.playwright?.source, "project");
  // the real check has no intent and inherits the account's repair default (kept OFF)
  assert.deepEqual(m.config.repair, { intent: null, aiAutoRepairEnabled: null });
  assert.equal(m.target.resolution, "code");
  assert.equal(m.target.recordedOrigin, "https://slots-booking-verify-fix.vercel.app");
  // Rocky's verdict is recorded, never followed blindly
  assert.equal(m.rca?.classification, "INFRASTRUCTURE_ERROR");
  assert.equal(m.rca?.repairRecommendation, "DO_NOT_REPAIR");
  // the group's first failure and this run both received "401" → the RCA is about this failure
  assert.equal(m.rca?.groupErrorMatchesFailingRun, true);
  assert.equal(m.rca?.createdBeforeFailingRun, true, "Rocky analyzed the first 401 two days before this run");
  assert.equal(m.rca?.mentionsFailingRunReceived, true, "Rocky's text says 401");
  assert.equal(m.rca?.describesFailingRun, true);
  assert.equal(m.notes.some((n) => /merges different failures|never mentions/.test(n)), false);
  assert.equal(m.incidentId, captured.incidentId, "the incident id is stable across re-captures of the same failure");
  assert.equal(resultErrors(passingResult).length, 0);
});

test("golden (real bundle): reproduction mode comes from result timestamps when a sibling run overlapped, else from the rule table", () => {
  const m = buildManifest(inputs());
  if (historyFile) {
    // re-captured bundle: the window is in the bundle → the overlap is checkable offline.
    // The passing reference IS the overlapping eu-west-1 run (the builder prefers it),
    // so its delta and overlap are pure arithmetic on the two stored results.
    assert.equal(m.reproduction.decidedBy, "result-timestamps");
    assert.equal(m.reproduction.mode, "live-concurrent:2");
    assert.equal(m.reproduction.matchedRule, "overlapping-run");
    const fStart = Date.parse(failingResult.startedAt);
    const fStop = Date.parse(failingResult.stoppedAt!);
    const pStart = Date.parse(passingResult.startedAt);
    const pStop = Date.parse(passingResult.stoppedAt!);
    const real = m.reproduction.overlappingRuns.find((o) => o.runId === passingResult.id);
    assert.ok(real, "the passing reference must be listed as an overlapping run");
    assert.equal(real.runLocation, "eu-west-1");
    assert.equal(real.passed, true);
    assert.equal(real.startDeltaMs, fStart - pStart);
    assert.equal(real.overlapMs, Math.min(fStop, pStop) - Math.max(fStart, pStart));
    assert.ok(real.startDeltaMs > 0 && real.startDeltaMs < 5000, `sibling started ${real.startDeltaMs} ms before the failing run`);
  } else {
    // first capture: only two results are in the fixture (09:20 and 09:23 — no overlap);
    // Rocky's text names no concurrency, so the fixed table says "both"
    assert.equal(m.reproduction.decidedBy, "none");
    assert.equal(m.reproduction.mode, "both");
    assert.equal(m.scenes[1].mode, "live-concurrent:2");
    assert.equal(m.scenes[1].alternativeMode, "replay:failing.har");
  }
  // with the sibling run from Rocky's own evidence ("passed in eu-west-1 one second earlier") the tool decides concurrency
  const failingStart = Date.parse(failingResult.startedAt);
  const sibling: CheckResultSummary = {
    id: "sibling-eu",
    hasFailures: false,
    hasErrors: false,
    runLocation: "eu-west-1",
    startedAt: new Date(failingStart - 1000).toISOString(),
    stoppedAt: new Date(failingStart + 6000).toISOString(),
    resultType: "FINAL",
    attempts: 1,
    errorGroupIds: [],
  };
  const withSibling = buildManifest(inputs({ history: [summaryOf(failingResult), sibling, summaryOf(passingResult)] }));
  assert.equal(withSibling.reproduction.decidedBy, "result-timestamps");
  assert.equal(withSibling.reproduction.mode, "live-concurrent:2");
  assert.equal(withSibling.reproduction.matchedRule, "overlapping-run");
  // The synthetic sibling is listed next to whatever real overlap the fixture already holds.
  const synthetic = withSibling.reproduction.overlappingRuns.find((o) => o.runId === "sibling-eu");
  assert.deepEqual(synthetic && [synthetic.runId, synthetic.startDeltaMs, synthetic.overlapMs, synthetic.passed], ["sibling-eu", 1000, 6000, true]);
  assert.equal(withSibling.reproduction.overlappingRuns.length, (historyFile ? 1 : 0) + 1);
  assert.ok(withSibling.notes.some((n) => /INFRASTRUCTURE_ERROR \(DO_NOT_REPAIR\)/.test(n) && /follows the timestamps/.test(n)), withSibling.notes.join("\n"));
  assert.ok(withSibling.envAssumptions.some((a) => a.id === "overlapping-run" && a.verified));
  assert.equal(withSibling.scenes[1].mode, "live-concurrent:2");
  assert.equal(withSibling.scenes[1].alternativeMode, undefined);
});

test("golden (real bundle): the manifest never carries env var values or bearer tokens", () => {
  const text = JSON.stringify(buildManifest(inputs()));
  assert.equal(/"value"\s*:\s*"x"/.test(text), false);
  assert.equal(/Bearer [A-Za-z0-9._-]{8,}/.test(text), false);
  assert.equal(read("recordings/failing.har").includes("Bearer tok"), false);
});
