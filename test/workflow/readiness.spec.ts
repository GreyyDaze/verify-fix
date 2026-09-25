import assert from "node:assert/strict";
import test from "node:test";

import {
  MAX_HEALTH_BODY_BYTES,
  evaluateReadiness,
  isProtectionStatus,
} from "../../.github/helpers/readiness.mjs";

test("health verdict ready", () => {
  const v = evaluateReadiness(200, JSON.stringify({
    ok: true,
    store: "inmemory",
    slotLoadDelayMs: 0,
  }));
  assert.deepEqual(v, { ready: true, reason: "ready-with-health", retryable: false });
});

test("health verdict not ready when ok is not true", () => {
  const v = evaluateReadiness(200, JSON.stringify({
    ok: false,
    store: "inmemory",
    slotLoadDelayMs: 0,
  }));
  assert.deepEqual(v, { ready: false, reason: "unexpected-health-shape", retryable: true });
});

test("health verdict invalid JSON", () => {
  const v = evaluateReadiness(200, "<!DOCTYPE html>");
  assert.deepEqual(v, { ready: false, reason: "invalid-health-json", retryable: true });
});

test("health verdict missing fields", () => {
  const v = evaluateReadiness(200, JSON.stringify({ ok: true, store: "x" }));
  assert.deepEqual(v, { ready: false, reason: "unexpected-health-shape", retryable: true });
});

test("health verdict non-finite delay", () => {
  const v = evaluateReadiness(200, JSON.stringify({ ok: true, store: "x", slotLoadDelayMs: Infinity }));
  assert.deepEqual(v, { ready: false, reason: "unexpected-health-shape", retryable: true });
});

test("health verdict unexpected status not ready", () => {
  const v = evaluateReadiness(500, "");
  assert.deepEqual(v, { ready: false, reason: "unexpected-status", retryable: true });
});

test("health verdict protected status", () => {
  const v = evaluateReadiness(302, "");
  assert.deepEqual(v, { ready: false, reason: "deployment-protection-response", retryable: false });
});

test("health verdict array body is invalid JSON shape", () => {
  const v = evaluateReadiness(200, "[]");
  assert.equal(v.ready, false);
  assert.equal(v.reason, "unexpected-health-shape");
});

test("isProtectionStatus covers every redirect and auth status", () => {
  for (const status of [301, 302, 303, 307, 308, 401, 403]) {
    assert.equal(isProtectionStatus(status), true, `status ${status}`);
  }
  for (const status of [200, 201, 204, 206, 400, 404, 418, 500, 503]) {
    assert.equal(isProtectionStatus(status), false, `status ${status}`);
  }
});

test("an oversized health body fails closed BEFORE parsing", () => {
  // Not valid JSON at all — the size check must win over the parse attempt.
  const huge = "x".repeat(MAX_HEALTH_BODY_BYTES + 1);
  const v = evaluateReadiness(200, huge);
  assert.deepEqual(v, {
    ready: false,
    reason: "health-body-too-large",
    retryable: false,
  });
});

test("a body just over the bound fails, a valid body under it is evaluated normally", () => {
  const padded = JSON.stringify({
    ok: true,
    store: "inmemory",
    slotLoadDelayMs: 0,
    pad: "y".repeat(MAX_HEALTH_BODY_BYTES),
  });
  assert.ok(padded.length > MAX_HEALTH_BODY_BYTES);
  assert.equal(evaluateReadiness(200, padded).reason, "health-body-too-large");
  // Under the bound: normal evaluation still applies.
  const small = JSON.stringify({ ok: true, store: "inmemory", slotLoadDelayMs: 0 });
  assert.ok(small.length <= MAX_HEALTH_BODY_BYTES);
  assert.equal(evaluateReadiness(200, small).ready, true);
});

test("health body size check counts UTF-8 bytes, not string characters", () => {
  // 40,000 'é' characters: 40,000 JS characters (< 64 KiB — the old string
  // check would have accepted this) but 80,000 UTF-8 bytes (> 64 KiB).
  const overByBytes = "é".repeat(40000);
  assert.ok(overByBytes.length <= MAX_HEALTH_BODY_BYTES);
  assert.ok(Buffer.byteLength(overByBytes, "utf8") > MAX_HEALTH_BODY_BYTES);
  assert.deepEqual(evaluateReadiness(200, overByBytes), {
    ready: false,
    reason: "health-body-too-large",
    retryable: false,
  });
  // 30,000 'é' characters = 60,000 UTF-8 bytes ≤ bound: the size check
  // passes on the byte count and normal evaluation applies instead.
  const underByBytes = "é".repeat(30000);
  assert.ok(underByBytes.length <= MAX_HEALTH_BODY_BYTES);
  assert.ok(Buffer.byteLength(underByBytes, "utf8") <= MAX_HEALTH_BODY_BYTES);
  assert.equal(evaluateReadiness(200, underByBytes).reason, "invalid-health-json");
});
