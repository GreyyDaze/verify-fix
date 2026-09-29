// Mocked Checkly/Playwright JSON only. None of these tests uses a private
// account, Checkly, a deployed check, or a real bundle/RCA.
import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeMultiStepCapture, observeMultiStepCapture } from "../../src/multistep/normalize.ts";
import { extractTransaction } from "../../src/multistep/transaction.ts";
import { sanitizeMultiStepCapture } from "../../src/multistep/sanitize.ts";
import { buildMultiStepRecording, MULTISTEP_DRAFT_SCHEMA } from "../../src/multistep/capture.ts";
import { multiStepShapeProblems } from "../../src/multistep/shape.ts";
import { validMultiStepStoredRecording } from "../../src/multistep/recording-schema.ts";
import { FAKE_TOKEN, failingTestResults, passingTestResults } from "./helpers.ts";

type Report = Record<string, any>;
function run(report: Report): Report { return report.suites[0].suites[0].specs[0].tests[0].results[0]; }
function raw(failing = true): Report { return JSON.parse(failing ? failingTestResults() : passingTestResults()) as Report; }
function body(report: Report, index: number): Report { return run(report).steps[index].steps[0].checklyData[0]; }
function reject(report: Report, label: string): void {
  const text = JSON.stringify(report);
  const capture = normalizeMultiStepCapture({ testResults: text });
  assert.ok(capture.problems.length, `${label}: normalization must have a fixed problem`);
  assert.equal(observeMultiStepCapture(capture).observed, "uncertain", label);
  const transaction = extractTransaction(capture);
  assert.equal(sanitizeMultiStepCapture({ ...capture, problems: [] }, transaction).ok, false,
    `${label}: stripping the parser's problems cannot promote a bad shape`);
  const recording = buildMultiStepRecording({ texts: { testResults: text, checkRunData: null, logs: null } });
  assert.equal(recording.ok, false, `${label}: no recording draft for inadmissible evidence`);
}

test("admission: EXACT four-step failed book / five-step passed confirmation and four ordered HTTP-200 requests", () => {
  const fail = buildMultiStepRecording({ texts: { testResults: failingTestResults(), logs: null, checkRunData: null } });
  const pass = buildMultiStepRecording({ texts: { testResults: passingTestResults(), logs: null, checkRunData: null } });
  assert.ok(fail.ok && pass.ok, "both canonical synthetic shapes normalize and sanitize");
  if (!fail.ok || !pass.ok) return;
  assert.equal(fail.recording.schemaVersion, MULTISTEP_DRAFT_SCHEMA, "unbound mechanics are not v3 recordings");
  assert.equal(validMultiStepStoredRecording(fail.recording, "failing"), false);
  assert.equal(fail.capture.steps.length, 4);
  assert.equal(pass.capture.steps.length, 5);
  assert.deepEqual([fail, pass].map((value) => value.capture.steps.slice(0, 4).map((step) => step.requests[0]?.status)),
    [[200, 200, 200, 200], [200, 200, 200, 200]]);
  assert.deepEqual([fail, pass].map((value) => multiStepShapeProblems(value.capture)), [[], []]);
  assert.equal(fail.capture.steps[3]?.requests[0]?.responseBody &&
    (fail.capture.steps[3]?.requests[0]?.responseBody as Report).confirmed, undefined,
    "the failed stale field was absent despite a successful nested booking");
  assert.equal(pass.capture.steps[4]?.status, "passed");
});

test("admission: early failing prefixes, four passing steps, failed fifth confirmation are never negative or positive proof", () => {
  for (let count = 1; count <= 3; count++) {
    const report = raw();
    run(report).steps.length = count;
    reject(report, `failing prefix of ${count} canonical requests`);
  }
  const fourPassing = raw(false);
  run(fourPassing).steps.length = 4;
  reject(fourPassing, "passing report omits confirmation");
  const fifthFailed = raw(false);
  run(fifthFailed).status = "failed";
  run(fifthFailed).steps[4].error = { message: "expect(received).toBe(expected)",
    stack: "at confirm transaction (multistep-booking.spec.ts:152:12)" };
  fifthFailed.stats.expected = 0;
  fifthFailed.stats.unexpected = 1;
  reject(fifthFailed, "fifth confirmation failed after four HTTP 200s");
});

test("admission: HTTP 401 and 500 at EVERY canonical request on BOTH selected sides is UNCERTAIN", () => {
  for (const failing of [true, false]) for (const status of [401, 500]) for (let index = 0; index < 4; index++) {
    const report = raw(failing);
    body(report, index).status = status;
    reject(report, `${failing ? "failing" : "passing"} ${status} at request ${index + 1}`);
  }
});

test("admission: wrong book shape, missing body, contradictory result/stats/error and wrong assertion are inadmissible", () => {
  const attacks: Array<[string, Report]> = [];
  const missing = raw(); body(missing, 3).body = null; attacks.push(["missing book body", missing]);
  const flatFail = raw(); body(flatFail, 3).body = body(raw(false), 3).body;
  attacks.push(["flat instead of nested failing book", flatFail]);
  const nestedPass = raw(false); body(nestedPass, 3).body = body(raw(), 3).body;
  attacks.push(["nested instead of flat passing book", nestedPass]);
  const extraField = raw(); body(extraField, 3).body.confirmed = true;
  attacks.push(["a flat confirmed field contradicts the stale failure", extraField]);
  const wrongAssert = raw(); body(wrongAssert, 3).expected = false;
  attacks.push(["wrong book assertion target", wrongAssert]);
  const maskedStatus = raw(); body(maskedStatus, 3).response = { status: 401 };
  attacks.push(["outer HTTP 200 masks a nested HTTP 401", maskedStatus]);
  const maskedBody = raw(); body(maskedBody, 3).response = { body: { confirmed: true, booking: "CONFIRMED" } };
  attacks.push(["outer booking body masks a contradictory nested body", maskedBody]);
  const maskedMethod = raw(); body(maskedMethod, 0).request = { method: "GET" };
  attacks.push(["outer POST masks a nested GET", maskedMethod]);
  const maskedHeader = raw(); body(maskedHeader, 3).request = { headers: [["authorization", "Bearer other-fixture"]] };
  attacks.push(["outer token header masks a conflicting nested token", maskedHeader]);
  const duplicateRequest = raw();
  run(duplicateRequest).steps[3].steps[0].checklyData.push({ ...body(duplicateRequest, 3) });
  attacks.push(["one Playwright child advertises two request records", duplicateRequest]);
  const maskedAssertion = raw(false);
  run(maskedAssertion).steps[4].steps[0].checklyData[0].expectedData = "FAILED";
  attacks.push(["confirmation expected and expectedData contradict each other", maskedAssertion]);
  const wrongSource = raw(); run(wrongSource).steps[3].steps[1].error.message =
    "expect(received).toBe(expected) at other.spec.ts:142:24";
  attacks.push(["reporter attributes failure to a different spec", wrongSource]);
  const wrongStep = raw(); run(wrongStep).steps[3].title = "session";
  attacks.push(["failure belongs to the wrong step", wrongStep]);
  const resultStatus = raw(); run(resultStatus).status = "passed";
  attacks.push(["reporter result says passed while the book step failed", resultStatus]);
  const fatalErrors = raw(false); fatalErrors.errors = [{ message: "unexpected setup failure" }];
  attacks.push(["additional top-level reporter error", fatalErrors]);
  const resultError = raw(); run(resultError).errors = [{ message: "unexpected teardown failure" }];
  attacks.push(["unrelated test-result error beside the failed book assertion", resultError]);
  const extraRetry = raw(); run(extraRetry).status = "failed";
  const results = extraRetry.suites[0].suites[0].specs[0].tests[0].results;
  results.push(structuredClone(results[0]));
  attacks.push(["additional Playwright result/retry despite one selected run", extraRetry]);
  for (const [label, report] of attacks) reject(report, label);
  const echo = raw();
  run(echo).errors = [{ message: "Error: expect(received).toBe(expected)",
    location: { file: "/synthetic/checks/multistep-booking.spec.ts", line: 142, column: 24 } }];
  assert.deepEqual(normalizeMultiStepCapture({ testResults: JSON.stringify(echo) }).problems, [],
    "the result's single correctly located copy of the SAME book assertion is not an extra error");
});


test("raw asset admission bounds ignored branches, counts every token occurrence and rejects shadowed JSON keys", () => {
  const extraBranches: Array<[string, (data: Report) => void]> = [
    ["top-level reporter metadata", (d) => { d.extra = { ignored: FAKE_TOKEN }; }],
    ["nested reporter config", (d) => { d.config.extra = [FAKE_TOKEN]; }],
    ["unselected assertion metadata", (d) => { run(d).steps[3].steps[1].ignored = FAKE_TOKEN; }],
    ["unknown alias inside checklyData", (d) => { body(d, 3).shadowResponse = { body: { token: FAKE_TOKEN } }; }],
    ["token in a key", (d) => { d.config[FAKE_TOKEN] = "synthetic-hidden"; }],
  ];
  for (const [label, attack] of extraBranches) {
    const report = raw();
    attack(report);
    const text = JSON.stringify(report);
    const capture = normalizeMultiStepCapture({ testResults: text });
    const transaction = extractTransaction(capture);
    assert.ok(capture.problems.length || transaction.problems.length, `${label}: ignored token must be accounted for`);
    assert.equal(buildMultiStepRecording({ texts: { testResults: text, logs: null, checkRunData: null } }).ok,
      false, `${label}: no bounded recording`);
  }
  for (const field of ["logs", "checkRunData"] as const) {
    const texts: { testResults: string; logs: string | null; checkRunData: string | null } = {
      testResults: failingTestResults(), logs: null, checkRunData: null,
    };
    texts[field] = JSON.stringify({ ignored: [{ secret: FAKE_TOKEN }] });
    const recording = buildMultiStepRecording({ texts });
    assert.equal(recording.ok, false, `${field}: token in optional unselected raw asset cannot pass`);
    assert.ok(!JSON.stringify(recording).includes(FAKE_TOKEN));
  }
  const nested = raw();
  let extra: unknown = "synthetic-leaf";
  for (let i = 0; i < 36; i++) extra = { branch: extra };
  nested.config.unused = extra;
  reject(nested, "deep ignored branch obeys the raw tree depth bound");
  nested.config.unused = Array.from({ length: 4100 }, (_, index) => index);
  reject(nested, "large ignored branch obeys the raw member bound");
  const text = failingTestResults().replace('"status":200', '"status":401,"status":200');
  assert.notEqual(text, failingTestResults());
  const shadow = buildMultiStepRecording({ texts: { testResults: text, logs: null, checkRunData: null } });
  assert.equal(shadow.ok, false, "a duplicate key cannot mask an HTTP 401");
});
