// Stage-7 focused tests: structured transaction extraction and
// relationship-preserving sanitization. Fixtures are locally constructed.

import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeMultiStepCapture } from "../../src/multistep/normalize.ts";
import { extractTransaction, requestSequence } from "../../src/multistep/transaction.ts";
import { ACCOUNT_LABEL, TOKEN_LABEL, sanitizeMultiStepCapture } from "../../src/multistep/sanitize.ts";
import { FAKE_ACCOUNT, FAKE_TOKEN, FAKE_ORIGIN, failingTestResults, passingLogs, passingTestResults } from "./helpers.ts";

function passingCapture() {
  return normalizeMultiStepCapture({ testResults: passingTestResults(), logs: passingLogs() });
}

test("cross-step account, slot, version, and token relationships extract from evidence", () => {
  const capture = passingCapture();
  const tx = extractTransaction(capture);
  assert.deepEqual(tx.problems, []);
  assert.equal(tx.account?.value, FAKE_ACCOUNT);
  assert.ok(tx.account!.sites.includes("login.response.body.account"));
  assert.ok(tx.account!.sites.some((s) => s.startsWith("session") && s.includes("response")), `account sites: ${tx.account!.sites}`);
  assert.ok(tx.account!.sites.some((s) => s.startsWith("book")), `account sites: ${tx.account!.sites}`);
  assert.equal(tx.slot?.value, "09:30");
  assert.ok(tx.slot!.sites.includes("book 09:30.request.body.slot"));
  assert.ok(tx.slot!.sites.includes("book 09:30.response.body.slot"));
  assert.equal(tx.version?.value, 1);
  assert.ok(tx.version!.sites.includes("login.response.body.version"));
  assert.ok(tx.version!.sites.includes("session.response.body.tokenVersion"));
  assert.ok(tx.version!.sites.includes("book 09:30.response.body.version"));
  assert.equal(tx.steps.map((s) => s.title).join(","), "login,session,slots,book 09:30,confirm transaction");
  assert.deepEqual(requestSequence(capture).map((r) => r.request.method), ["POST", "GET", "GET", "POST"]);
});

test("one token label reused three times: login body + two matching Bearer headers", () => {
  const capture = passingCapture();
  const tx = extractTransaction(capture);
  assert.equal(tx.token?.value, FAKE_TOKEN);
  assert.equal(tx.token?.occurrences, 3);
  assert.equal(tx.token!.sites.filter((s) => s.includes("headers.authorization")).length, 2);
  assert.equal(tx.token!.sites[0], "login.response.body.token");
  const auths = capture.steps.flatMap((s) => s.requests).map((r) => r.requestHeaders.authorization);
  const bearer = auths.filter((a) => a !== undefined);
  assert.equal(bearer.length, 2);
  assert.ok(bearer.every((a) => a === `Bearer ${FAKE_TOKEN}`), "both Authorization headers use the login-issued token");
});

test("sanitization: no original sensitive value survives; labels and structure are preserved", () => {
  const capture = normalizeMultiStepCapture({ testResults: passingTestResults(), logs: passingLogs() });
  const tx = extractTransaction(capture);
  const result = sanitizeMultiStepCapture(capture, tx);
  assert.ok(result.ok, `sanitization failed: !result.ok && 'reason' in result ? (result as {reason:string}).reason : ''`);
  if (!result.ok) return;
  const serialized = JSON.stringify(result.capture);
  assert.ok(!serialized.includes(FAKE_ACCOUNT), "no original account survives");
  assert.ok(!serialized.includes(FAKE_TOKEN), "no original token survives");
  assert.ok(!serialized.includes(FAKE_ORIGIN), "no recorded origin (environment value) survives");
  assert.ok(serialized.includes(ACCOUNT_LABEL), "one opaque account label present");
  assert.ok(serialized.includes(TOKEN_LABEL), "one opaque token label present");
  // Bearer prefix preserved with the opaque label; token label appears exactly
  // three times across the transaction evidence (login body + two headers)
  const authorizationHeaders = result.capture.steps.flatMap((s) => s.requests).map((r) => r.requestHeaders.authorization).filter((a): a is string => a !== undefined);
  assert.equal(authorizationHeaders.length, 2);
  assert.ok(authorizationHeaders.every((a) => a === `Bearer ${TOKEN_LABEL}`));
  const tokenLabelCount = serialized.split(TOKEN_LABEL).length - 1;
  assert.equal(tokenLabelCount, 3, `token label occurrences in the sanitized capture: ${tokenLabelCount}`);
  // unrelated header values are not exposed
  const anyOtherHeader = result.capture.steps.flatMap((s) => s.requests).flatMap((r) => Object.entries(r.requestHeaders)).find(([name]) => name.toLowerCase() !== "authorization");
  if (anyOtherHeader) assert.equal(anyOtherHeader[1], "<redacted>");
  // ordered steps and request/response structure preserved as valid JSON
  assert.deepEqual(result.capture.steps.map((s) => s.title), capture.steps.map((s) => s.title));
  const roundTripped = JSON.parse(JSON.stringify(result.capture));
  assert.equal(roundTripped.steps.length, result.capture.steps.length);
  const loginBody = roundTripped.steps[0].requests[0].responseBody as Record<string, unknown>;
  assert.equal(loginBody.account, ACCOUNT_LABEL);
  assert.equal(loginBody.token, TOKEN_LABEL);
  assert.equal(loginBody.ok, true);
  assert.equal(loginBody.version, 1);
  const bookBody = roundTripped.steps.find((s: { title: string }) => s.title === "book 09:30").requests[0].responseBody as { confirmed?: boolean; booking?: unknown };
  assert.equal(bookBody.confirmed, true);
  // query keys preserved with redacted values
  const url = result.capture.steps[0].requests[0].url as string;
  assert.ok(!url.includes(FAKE_ORIGIN));
  assert.ok(url.startsWith("https://recorded.invalid/"));
});

test("token relationship missing or inconsistent = UNCERTAIN (sanitize refuses)", () => {
  // missing: strip Authorization headers from the session/book requests
  const capture = passingCapture();
  for (const step of capture.steps) {
    for (const request of step.requests) {
      delete request.requestHeaders.authorization;
    }
  }
  const tx = extractTransaction(capture);
  assert.ok(tx.problems.some((p) => p.includes("token relationship missing")));
  const result = sanitizeMultiStepCapture(capture, tx);
  assert.equal(result.ok, false);
  assert.ok(!result.ok && /token relationship/.test(result.reason));

  // inconsistent: a different token in one header
  const tampered = passingCapture();
  const session = tampered.steps.find((s) => s.title === "session");
  session!.requests[0].requestHeaders.authorization = "Bearer some-other-token";
  const tx2 = extractTransaction(tampered);
  assert.ok(tx2.problems.some((p) => p.includes("token relationship inconsistent")));
  const result2 = sanitizeMultiStepCapture(tampered, tx2);
  assert.equal(result2.ok, false);
});

test("failing incident capture sanitizes cleanly (relationship intact, contract stale)", () => {
  const capture = normalizeMultiStepCapture({ testResults: failingTestResults() });
  const tx = extractTransaction(capture);
  assert.deepEqual(tx.problems, []);
  assert.equal(tx.token?.occurrences, 3);
  // nested body still carries account/slot/sessionVersion relationships
  assert.equal(tx.slot?.value, "09:30");
  assert.equal(tx.version?.value, 1);
  const result = sanitizeMultiStepCapture(capture, tx);
  assert.ok(result.ok);
  if (!result.ok) return;
  const serialized = JSON.stringify(result.capture);
  assert.ok(!serialized.includes(FAKE_ACCOUNT));
  assert.ok(!serialized.includes(FAKE_TOKEN));
  const nested = result.capture.steps.find((s) => s.title === "book 09:30")!.requests[0].responseBody as { booking: Record<string, unknown> };
  assert.equal(nested.booking.account, ACCOUNT_LABEL);
  assert.equal(nested.booking.sessionVersion, 1);
  assert.equal(nested.booking.status, "CONFIRMED");
});
