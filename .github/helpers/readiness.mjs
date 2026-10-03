// @ts-check
// Readiness verdicts for the slots-booking preview/production gates (Stage 2).
//
// Pure and dependency-free. A deployment is READY only when the target
// answers 200 with the expected health JSON: `{ ok: true, store: string,
// slotLoadDelayMs: number }`. The response body is bounded
// (MAX_HEALTH_BODY_BYTES, measured in UTF-8 BYTES — never string
// characters) BEFORE any parsing; an unexpectedly large body fails
// closed. A protection response (302 redirect, 401, 403) is NEVER
// ready — a reachable app serving a login or verification page does not
// prove readiness. Any other status, or invalid JSON, stays retryable
// until the caller's budget is exhausted.
//
// Reasons are short, stable, and free of response bodies, headers, or secret
// values; callers may log them safely.

/**
 * Conservative upper bound for a health response body, checked before JSON
 * parsing. The expected body is under 1 KiB.
 * @type {number}
 */
export const MAX_HEALTH_BODY_BYTES = 64 * 1024;

/** Redirect status codes. */
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
/** Authentication/authorization protection statuses. */
const AUTH_PROTECTION_STATUSES = new Set([401, 403]);

/**
 * True for responses that mean "this origin is protected", not "ready":
 * any redirect (manual mode — the body is never followed) or 401/403.
 * @param {number} status
 * @returns {boolean}
 */
export function isProtectionStatus(status) {
  return REDIRECT_STATUSES.has(status) || AUTH_PROTECTION_STATUSES.has(status);
}

/**
 * @typedef {object} ReadinessVerdict
 * @property {boolean} ready
 * @property {string} reason
 * @property {boolean} retryable
 */

/**
 * Evaluate one HTTP response as a readiness verdict.
 *
 * @param {number} status HTTP status code.
 * @param {string} body Exact response text (used only inside this function;
 *   never logged by callers).
 * @returns {ReadinessVerdict}
 */
export function evaluateReadiness(status, body) {
  if (status === 200) {
    // Bound first: an oversized body fails closed BEFORE parsing. The size
    // is measured in UTF-8 BYTES, not JavaScript string characters.
    if (Buffer.byteLength(body, "utf8") > MAX_HEALTH_BODY_BYTES) {
      return { ready: false, reason: "health-body-too-large", retryable: false };
    }
    let parsed;
    try {
      parsed = JSON.parse(body);
    } catch {
      return { ready: false, reason: "invalid-health-json", retryable: true };
    }
    const valid = typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) &&
      parsed.ok === true && typeof parsed.store === "string" &&
      typeof parsed.slotLoadDelayMs === "number" &&
      Number.isFinite(parsed.slotLoadDelayMs);
    if (!valid) {
      return { ready: false, reason: "unexpected-health-shape", retryable: true };
    }
    return { ready: true, reason: "ready-with-health", retryable: false };
  }
  if (isProtectionStatus(status)) {
    return { ready: false, reason: "deployment-protection-response", retryable: false };
  }
  return { ready: false, reason: "unexpected-status", retryable: true };
}
