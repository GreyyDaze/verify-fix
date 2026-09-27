// Stage-7 focused tests: real-shape Multistep result normalization.
// Fixtures are locally constructed and prove mechanics only.

import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeMultiStepCapture, observeMultiStepCapture } from "../../src/multistep/normalize.ts";
import {
  failingLogs,
  failingTestResults,
  fullCheckRunData,
  minimalCheckRunData,
  passingLogs,
  passingTestResults,
} from "./helpers.ts";

const CANONICAL = ["login", "session", "slots", "book 09:30", "confirm transaction"];

test("passing real-shape normalization: five ordered steps, no problems", () => {
  const capture = normalizeMultiStepCapture({ testResults: passingTestResults(), logs: passingLogs(), checkRunData: fullCheckRunData(), attempts: 1 });
  assert.equal(capture.problems.length, 0);
  assert.equal(capture.kind, "passing");
  assert.deepEqual(capture.stats, { expected: 1, unexpected: 0, flaky: 0 });
  const topLevel = capture.steps.filter((s) => CANONICAL.includes(s.title));
  assert.deepEqual(topLevel.map((s) => s.title), CANONICAL);
  for (const step of topLevel) assert.equal(step.status, "passed");
  // all four requests carry method/path/status evidence
  const requests = capture.steps.flatMap((s) => s.requests);
  assert.equal(requests.length, 4);
  assert.deepEqual(requests.map((r) => `${r.method} ${r.path} → ${r.status}`), [
    "POST /api/login → 200",
    "GET /api/session → 200",
    "GET /api/slots → 200",
    "POST /api/book → 200",
  ]);
  assert.equal(capture.logs?.length, 2);
  assert.equal(capture.checkRunData?.scriptPath, "checks/multistep-booking.spec.ts");
});

test("failing real-shape normalization: error inside book 09:30, confirm absent", () => {
  const capture = normalizeMultiStepCapture({ testResults: failingTestResults(), logs: failingLogs(), attempts: 2 });
  assert.equal(capture.problems.length, 0);
  assert.equal(capture.kind, "failing");
  assert.deepEqual(capture.stats, { expected: 0, unexpected: 1, flaky: 0 });
  const topLevel = capture.steps.filter((s) => CANONICAL.includes(s.title));
  assert.deepEqual(topLevel.map((s) => s.title), ["login", "session", "slots", "book 09:30"]);
  assert.equal(topLevel[3].status, "failed");
  assert.match(topLevel[3].error ?? "", /expect\(received\)\.toBe\(expected\)/);
  assert.ok(!topLevel.some((s) => s.title === "confirm transaction"), "confirm transaction must be absent after the failure");
  // requests completed with HTTP 200 before the stale assertion failed
  const requests = capture.steps.flatMap((s) => s.requests);
  assert.equal(requests.length, 4);
  assert.ok(requests.every((r) => r.status === 200));
  // the stale assertion's expected/actual evidence
  const book = capture.steps.find((s) => s.title === "book 09:30");
  const evidence = book?.requests[0];
  assert.equal(evidence?.expected, true);
  assert.equal(evidence?.actual, null);
});

test("missing optional check-run-data fields: only script + scriptPath is fine", () => {
  const capture = normalizeMultiStepCapture({ testResults: passingTestResults(), checkRunData: minimalCheckRunData() });
  assert.equal(capture.problems.length, 0);
  assert.equal(capture.checkRunData?.dependencies, null);
  assert.equal(capture.checkRunData?.imports, null);
  assert.equal(capture.checkRunData?.playwrightConfig, null);
  assert.equal(capture.checkRunData?.scriptPath, "checks/multistep-booking.spec.ts");
  // check-run-data.json entirely absent is also fine (optional evidence)
  const without = normalizeMultiStepCapture({ testResults: passingTestResults() });
  assert.equal(without.checkRunData, null);
  assert.equal(without.problems.length, 0);
});

test("missing test-results.json asset = UNCERTAIN (missing execution evidence)", () => {
  const capture = normalizeMultiStepCapture({ testResults: null });
  assert.ok(capture.problems.some((p) => p.includes("test-results.json asset is missing")));
  const observation = observeMultiStepCapture(capture);
  assert.equal(observation.observed, "uncertain");
  assert.match(observation.reason ?? "", /multistep evidence unresolved/);
});

test("corrupt or truncated assets = UNCERTAIN", () => {
  const corrupt = normalizeMultiStepCapture({ testResults: '{"stats": {"expected": 1,' });
  assert.ok(corrupt.problems.some((p) => /not valid JSON/.test(p)));
  assert.equal(observeMultiStepCapture(corrupt).observed, "uncertain");

  const truncated = normalizeMultiStepCapture({ testResults: JSON.stringify({ suites: [] }) });
  assert.ok(truncated.problems.length > 0);
  assert.equal(observeMultiStepCapture(truncated).observed, "uncertain");

  const badLogs = normalizeMultiStepCapture({ testResults: passingTestResults(), logs: "not-json" });
  assert.ok(badLogs.problems.some((p) => /logs\.txt/.test(p)));
  assert.equal(observeMultiStepCapture(badLogs).observed, "uncertain");

  const badCheckRunData = normalizeMultiStepCapture({ testResults: passingTestResults(), checkRunData: "{oops" });
  assert.ok(badCheckRunData.problems.some((p) => /check-run-data\.json/.test(p)));
  assert.equal(observeMultiStepCapture(badCheckRunData).observed, "uncertain");
});

test("missing final step due to the prior failure is failing evidence, not UNCERTAIN", () => {
  const capture = normalizeMultiStepCapture({ testResults: failingTestResults() });
  assert.equal(capture.problems.length, 0);
  const observation = observeMultiStepCapture(capture);
  assert.equal(observation.observed, "fail");
});

test("setup failure (no step evidence) = UNCERTAIN", () => {
  const report = JSON.stringify({ stats: { expected: 1, unexpected: 0, flaky: 0 }, suites: [{ title: "s", specs: [{ title: "t", tests: [{ results: [{ status: "failed", steps: [] }] }] }] }] });
  const capture = normalizeMultiStepCapture({ testResults: report });
  const observation = observeMultiStepCapture(capture);
  assert.equal(observation.observed, "uncertain");
  assert.match(observation.reason ?? "", /no ordered step evidence/);
});

test("retry attempts are recurrence only — they never change the observation", () => {
  const once = normalizeMultiStepCapture({ testResults: failingTestResults(), attempts: 1 });
  const twice = normalizeMultiStepCapture({ testResults: failingTestResults(), attempts: 2 });
  assert.equal(twice.recurrence.attempts, 2);
  assert.deepEqual(observeMultiStepCapture(twice), observeMultiStepCapture(once));
  assert.equal(observeMultiStepCapture(twice).observed, "fail");

  const passing = normalizeMultiStepCapture({ testResults: passingTestResults(), attempts: 1 });
  const passingRetried = normalizeMultiStepCapture({ testResults: passingTestResults(), attempts: 2 });
  assert.equal(observeMultiStepCapture(passingRetried).observed, "pass");
  assert.equal(observeMultiStepCapture(passing).observed, "pass");
});
