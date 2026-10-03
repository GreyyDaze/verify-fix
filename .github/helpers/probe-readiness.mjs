// @ts-check
// Non-interactive readiness probe for deployment URLs (Stage 2).
//
// Plain dependency-free ESM (`.mjs`): executed directly by the existing
// setup-node runtime, never via TypeScript stripping, experimental flags, or
// a `.ts` entrypoint.
//
// Public-first flow, with hard rules:
//   - Phase 1 (public): every request goes to `${origin}/api/health` derived
//     with the URL API (no string concatenation) WITHOUT the bypass header —
//     even when a bypass value is available in the environment. Only a 200
//     with valid health JSON counts as readiness here, and it is reported
//     without ever having sent the bypass.
//   - A protection response (302/401/403, manual redirect mode — redirects
//     are never followed and Location is never trusted) marks the origin as
//     protected. If no bypass value is available, the probe fails closed.
//   - Phase 2 (bypass): retry the SAME validated origin and URL with the
//     bypass header. Only 200 + valid health JSON becomes ready. Another
//     protection response fails immediately — a second 302 is never
//     readiness. Invalid JSON after bypass keeps failing until exhausted.
//   - Every fetch uses an abort timeout, so a hanging request cannot stall
//     the job. Fetch and sleep are injectable for tests.
//   - Health bodies are fully bounded before any content is trusted: for
//     200 responses Content-Length is inspected first (malformed, negative,
//     non-integer, unsafe, or oversized lengths fail closed and the body is
//     never consumed), then the body streams through a reader that counts
//     UTF-8 BYTES and cancels the stream the moment MAX_HEALTH_BODY_BYTES
//     is exceeded — `response.text()` is never called. Non-200 responses
//     never have their body read or retained; readiness uses only the
//     status.
//   - An oversized or invalid-size response is DEFINITIVE: a stable reason
//     (`health-body-too-large` / `health-content-length-invalid`) returns
//     with no sleep, no retry, and no transition from public probing to
//     bypass probing. Body content is never logged.
//   - The bypass value is never logged, printed, or echoed; only stable
//     reasons leave this module.
//
// Required health JSON: `{ ok: true, store: string, slotLoadDelayMs: number }`.
// Exit codes: 0 ready, 1 protection without bypass, 2 budget exhausted.

import process from "node:process";
import { fileURLToPath } from "node:url";
import { isProtectionStatus, evaluateReadiness, MAX_HEALTH_BODY_BYTES } from "./readiness.mjs";
import { normalizeHttpsOrigin } from "./deployment-url-roles.mjs";

/** Header the trusted preview/production origin recognizes for Vercel
 * Deployment Protection. Named interface only; the value is never added to
 * this repository — callers must pass it in at run time. */
export const PROTECTION_BYPASS_HEADER = "x-vercel-protection-bypass";

/**
 * @typedef {object} ProbeOutcome
 * @property {boolean} ready
 * @property {string} reason Stable, log-safe reason.
 * @property {boolean} bypassUsed Whether the bypass header was sent.
 */

/** @param {number} ms @returns {Promise<void>} */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Read at most `maxBytes` from a response body STREAM. The bound is applied
 * while pulling chunks: reading stops and the reader is cancelled the moment
 * the bound is exceeded — an oversized body is never fully materialized and
 * `response.text()` is never called. The bound counts actual UTF-8 BYTES
 * read from the stream (never JavaScript string characters). Bodies at or
 * under the bound are decoded and returned whole.
 *
 * @param {Response} response
 * @param {number} maxBytes
 * @returns {Promise<{ body: string, tooLarge: boolean }>}
 */
async function readBodyBounded(response, maxBytes) {
  if (response.body == null) return { body: "", tooLarge: false };
  const reader = response.body.getReader();
  /** @type {Uint8Array[]} */
  const chunks = [];
  let received = 0;
  for (;;) {
    const result = await reader.read();
    if (result.done) break;
    const chunk = result.value;
    received += chunk.byteLength;
    if (received > maxBytes) {
      // Stop pulling immediately: the rest of the stream is never read.
      try {
        await reader.cancel();
      } catch {
        // The stream may already be errored; either way we stop here.
      }
      return { body: "", tooLarge: true };
    }
    chunks.push(chunk);
  }
  const bytes = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { body: new TextDecoder().decode(bytes), tooLarge: false };
}

/**
 * Validate a raw Content-Length header value before any body read. Returns
 * the declared byte length when it is a non-negative safe integer, or null
 * when the value is malformed, negative, non-integer, or unsafe.
 *
 * @param {string} raw
 * @returns {number | null}
 */
function parseContentLength(raw) {
  if (!/^\d+$/.test(raw)) return null;
  const declared = Number(raw);
  if (!Number.isSafeInteger(declared)) return null;
  return declared;
}

/**
 * One fetch to the given URL with `redirect: "manual"` and an abort timeout.
 * Never throws; transport failures collapse into `{ kind: "transport" }`.
 *
 * Reading rules:
 *   - non-200: the body is never read or retained — readiness uses only
 *     the status;
 *   - 200: Content-Length is inspected first; an invalid or oversized
 *     declared length returns a stable `bodyIssue` WITHOUT consuming the
 *     body, otherwise the body streams through the bounded reader that
 *     counts UTF-8 bytes and cancels at the bound.
 * `bodyIssue` is a stable definitive reason (`health-body-too-large` or
 * `health-content-length-invalid`) and never carries body content.
 *
 * @param {string} url
 * @param {string | null} bypassValue `null` = no bypass header at all.
 * @param {typeof fetch} fetchImpl
 * @param {number} timeoutMs
 * @returns {Promise<{ kind: "response", status: number, body: string,
 *   bodyIssue: string | null } | { kind: "transport" }>}
 */
async function probeOnce(url, bypassValue, fetchImpl, timeoutMs) {
  /** @type {Record<string, string>} */
  const headers = { Accept: "application/json" };
  if (bypassValue !== null && bypassValue !== "") {
    headers[PROTECTION_BYPASS_HEADER] = bypassValue;
  }
  try {
    const response = await fetchImpl(url, {
      redirect: "manual",
      headers,
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (response.status !== 200) {
      // Non-200: never read or retain the body — status is all that matters.
      return { kind: "response", status: response.status, body: "", bodyIssue: null };
    }
    const contentLengthRaw = response.headers.get("content-length");
    if (contentLengthRaw !== null) {
      const declared = parseContentLength(contentLengthRaw);
      if (declared === null) {
        return {
          kind: "response",
          status: 200,
          body: "",
          bodyIssue: "health-content-length-invalid",
        };
      }
      if (declared > MAX_HEALTH_BODY_BYTES) {
        // Declared length already exceeds the bound: the body is NOT consumed.
        return {
          kind: "response",
          status: 200,
          body: "",
          bodyIssue: "health-body-too-large",
        };
      }
    }
    const bounded = await readBodyBounded(response, MAX_HEALTH_BODY_BYTES);
    if (bounded.tooLarge) {
      // Actual bytes crossed the bound: the stream was cancelled mid-read.
      return { kind: "response", status: 200, body: "", bodyIssue: "health-body-too-large" };
    }
    return { kind: "response", status: 200, body: bounded.body, bodyIssue: null };
  } catch {
    return { kind: "transport" };
  }
}

/**
 * Run the public-first readiness probe against an already validated origin.
 *
 * @param {object} input
 * @param {string} input.origin Normalized `URL.origin` (validated upstream).
 * @param {string} [input.bypass] Bypass value supplied at run time; never
 *   stored or requested by this repository. Empty/absent = unavailable.
 * @param {typeof fetch} [input.fetchImpl] Injected fetch (tests, hermetic runs).
 * @param {(ms: number) => Promise<void>} [input.sleepImpl]
 * @param {number} [input.attempts] Attempts per phase.
 * @param {number} [input.delayMs] Delay between attempts.
 * @param {number} [input.timeoutMs] Per-request abort timeout.
 * @returns {Promise<ProbeOutcome>}
 */
export async function runReadinessProbe(input) {
  const origin = input.origin;
  const bypass = input.bypass ?? "";
  const fetchImpl = input.fetchImpl ?? fetch;
  const sleepImpl = input.sleepImpl ?? sleep;
  const attempts = input.attempts ?? 18;
  const delayMs = input.delayMs ?? 5000;
  const timeoutMs = input.timeoutMs ?? 10000;
  const healthUrl = new URL("/api/health", origin).href;

  // Phase 1: public probe — the bypass header is NEVER attached here.
  let protectionSeen = false;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const probe = await probeOnce(healthUrl, null, fetchImpl, timeoutMs);
    if (probe.kind === "transport") {
      await sleepImpl(delayMs);
      continue;
    }
    if (probe.bodyIssue !== null) {
      // Definitive: no sleep, no retry, no transition to bypass probing.
      return { ready: false, reason: probe.bodyIssue, bypassUsed: false };
    }
    if (probe.status === 200) {
      const verdict = evaluateReadiness(200, probe.body);
      if (verdict.ready) {
        // Ready without ever sending the bypass, even if one is available.
        return { ready: true, reason: "public-health-ok", bypassUsed: false };
      }
      await sleepImpl(delayMs);
      continue;
    }
    if (isProtectionStatus(probe.status)) {
      protectionSeen = true;
      break;
    }
    await sleepImpl(delayMs);
  }
  if (!protectionSeen) {
    return { ready: false, reason: "public-not-ready", bypassUsed: false };
  }

  // Protection observed. First 302/401/403 is never accepted as ready.
  if (bypass === "") {
    return { ready: false, reason: "protected-no-bypass-available", bypassUsed: false };
  }

  // Phase 2: same validated origin and URL, now with the bypass header.
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const probe = await probeOnce(healthUrl, bypass, fetchImpl, timeoutMs);
    if (probe.kind === "transport") {
      await sleepImpl(delayMs);
      continue;
    }
    if (isProtectionStatus(probe.status)) {
      // A second protection response (e.g. another 302) fails — never ready.
      return { ready: false, reason: "protected-after-bypass", bypassUsed: true };
    }
    if (probe.bodyIssue !== null) {
      // Definitive during bypass: stop immediately — no sleep, no retry.
      return { ready: false, reason: probe.bodyIssue, bypassUsed: true };
    }
    if (probe.status === 200) {
      const verdict = evaluateReadiness(200, probe.body);
      if (verdict.ready) {
        return { ready: true, reason: "bypass-health-ok", bypassUsed: true };
      }
      // Invalid health JSON still fails after bypass; retry within budget.
      await sleepImpl(delayMs);
      continue;
    }
    await sleepImpl(delayMs);
  }
  return { ready: false, reason: "bypass-not-ready", bypassUsed: true };
}

/**
 * Entry point; only runs when executed as a script, never on import.
 * @param {string[]} argv
 */
export async function main(argv) {
  const origin = normalizeHttpsOrigin(argv[2]);
  if (origin === null) {
    console.error("[probe] target must be a bare HTTPS origin (no path/query/fragment)");
    return 2;
  }
  const outcome = await runReadinessProbe({
    origin,
    bypass: process.env.BYPASS ?? "",
  });
  console.log(`[probe] ready=${outcome.ready} reason=${outcome.reason}`);
  if (outcome.reason === "protected-no-bypass-available") return 1;
  return outcome.ready ? 0 : 2;
}

/* c8 ignore start — script-entry guard: never executes on import. */
if (process.argv[1] !== undefined &&
  fileURLToPath(import.meta.url) === process.argv[1]) {
  main(process.argv).then(
    (code) => { process.exitCode = code; },
    (error) => {
      console.error(`[probe] failed: ${error instanceof Error ? error.message : "unknown"}`);
      process.exitCode = 2;
    },
  );
}
/* c8 ignore stop */
