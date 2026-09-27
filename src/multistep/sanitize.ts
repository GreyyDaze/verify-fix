// Relationship-preserving sanitization for Multistep captures.
//
// Uses the real observed relationship: ONE account label, ONE token label,
// two matching `Bearer <token>` Authorization uses, exactly three total
// token occurrences. The committed representation contains no original token,
// no original account, no Authorization secret, no cookie, no provider token,
// no secret environment value, no signed asset URL, and no raw query values.
// It preserves method, path, query-key NAMES, request-body structure, status,
// header names, response-body structure, assertion provenance, and ordered
// steps — and it preserves equality relationships with the OPAQUE LABELS
// themselves, never with hashes of the original values.
//
// Strict allow-list: every field of the sanitized recording is constructed
// explicitly from a known-safe schema — captured objects are never spread
// into the output, unknown keys are dropped rather than inspected, timings
// and check-run metadata are pruned to their allow-listed fields, query
// parameter VALUES are redacted, sensitive path segments are redacted, and
// only `Bearer <token>` Authorization values survive (label-replaced).
//
// If the token relationship is missing or inconsistent the sanitizer returns
// a reason instead of a capture — the decision layer maps that to UNCERTAIN.
// Output is always valid JSON-serializable structure, and a final leak check
// verifies that NO original sensitive value survives serialization.
//
// Callers must run the returned `secrets` against every file actually
// written to the bundle (buildBundle does).

import type { MultiStepCapture, MultiStepRequestEvidence } from "./normalize.ts";
import type { MultiStepTransaction } from "./transaction.ts";

export const ACCOUNT_LABEL = "<account>";
export const TOKEN_LABEL = "<token>";
/** Header values other than Authorization are unrelated to any supported assertion. */
const REDACTED_HEADER = "<redacted>";

export type SanitizeResult =
  | { ok: true; capture: MultiStepCapture; secrets: string[] }
  | { ok: false; reason: string };

function replaceLabels(value: string, labels: Map<string, string>): string {
  let out = value;
  for (const [secret, label] of labels) out = out.split(secret).join(label);
  return out;
}

function scrub(value: unknown, labels: Map<string, string>, depth = 0): unknown {
  if (typeof value === "string") return replaceLabels(value, labels);
  if (Array.isArray(value)) return depth > 12 ? null : value.map((item) => scrub(item, labels, depth + 1));
  if (value && typeof value === "object") {
    if (depth > 12) return null;
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) out[key] = scrub(item, labels, depth + 1);
    return out;
  }
  return value;
}

/** Keep the query-key structure; replace every query value (signed URLs included). */
function redactQueryValues(url: string): string {
  try {
    const parsed = new URL(url, "https://recorded.invalid");
    const keys = [...parsed.searchParams.keys()];
    parsed.search = "";
    for (const key of keys) parsed.searchParams.append(key, "<redacted>");
    return parsed.toString();
  } catch {
    return url.replace(/\?[^#\s]*/, (query) => {
      const pairs = query.slice(1).split("&").filter(Boolean);
      return pairs.length ? `?${pairs.map((pair) => `${pair.split("=")[0]}=<redacted>`).join("&")}` : "";
    });
  }
}

/** Redact raw query strings that appear inside free text (error messages). */
function redactQueriesInText(text: string): string {
  return text.replace(/\?[^\s)"']+/g, (query) => {
    const pairs = query.slice(1).split("&").filter(Boolean);
    return pairs.length ? `?${pairs.map((pair) => `${pair.split("=")[0]}=<redacted>`).join("&")}` : "";
  });
}

/** Origins of recorded request URLs are environment values (ENVIRONMENT_URL)
 * and never enter the bundle — same precedent as the API recorder. */
const SANITIZED_ORIGIN = "https://recorded.invalid";

function redactOrigin(url: string): string {
  try {
    const parsed = new URL(url, SANITIZED_ORIGIN);
    return SANITIZED_ORIGIN + parsed.pathname + parsed.search;
  } catch {
    return url.replace(/https?:\/\/[^/?#]+/, SANITIZED_ORIGIN);
  }
}

/** Never store sensitive path values: long opaque segments are redacted. */
function redactPath(path: string): string {
  if (typeof path !== "string") return path;
  const capped = path.length > 512 ? path.slice(0, 512) : path;
  return capped
    .split("/")
    .map((segment) => (/^[A-Za-z0-9+/=_-]{32,}$/.test(segment) && /\d/.test(segment) && /[A-Za-z]/.test(segment) ? "<redacted>" : segment))
    .join("/");
}

/** Timings: only the two allow-listed numeric fields survive. */
function pruneTimings(value: unknown): { startTime: number; endTime: number } | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const startTime = typeof record.startTime === "number" ? record.startTime : null;
  const endTime = typeof record.endTime === "number" ? record.endTime : null;
  return startTime !== null && endTime !== null ? { startTime, endTime } : null;
}

function sanitizeRequest(request: MultiStepRequestEvidence, labels: Map<string, string>): MultiStepRequestEvidence {
  const requestHeaders: Record<string, string> = {};
  for (const [name, value] of Object.entries(request.requestHeaders)) {
    if (name.toLowerCase() === "authorization") {
      // Only `Bearer <token>` survives — and only with its label replaced.
      // Non-Bearer schemes are refused upstream by the transaction extractor.
      const replaced = replaceLabels(value, labels);
      requestHeaders[name] = /^Bearer\s+\S+$/.test(replaced.trim()) ? replaced : REDACTED_HEADER;
    } else {
      requestHeaders[name] = REDACTED_HEADER;
    }
  }
  const responseHeaders: Record<string, string> = {};
  for (const name of Object.keys(request.responseHeaders)) responseHeaders[name] = REDACTED_HEADER;
  return {
    // explicit allow-list construction — captured objects are never spread
    title: request.title === null ? null : replaceLabels(request.title, labels),
    method: request.method,
    url: typeof request.url === "string" ? redactOrigin(redactQueryValues(request.url)) : request.url,
    path: request.path === null || request.path === undefined ? null : redactPath(request.path),
    queryKeys: (request.queryKeys ?? []).map((key) => replaceLabels(key, labels)),
    requestHeaders,
    requestBody: scrub(request.requestBody, labels),
    status: request.status,
    statusText: request.statusText === null ? null : replaceLabels(request.statusText, labels),
    responseHeaders,
    responseBody: scrub(request.responseBody, labels),
    expected: scrub(request.expected, labels),
    actual: scrub(request.actual, labels),
    timings: pruneTimings(request.timings),
    fetchUid: request.fetchUid === null ? null : replaceLabels(request.fetchUid, labels),
  };
}

/**
 * Sanitize a normalized capture for storage. Requires the transaction's
 * token relationship to be present, consistent, and exactly three
 * occurrences — otherwise returns the reason so the consumer records
 * UNCERTAIN instead of a sanitized capture. Returns the original sensitive
 * values as `secrets` so callers can verify EVERY file actually written.
 */
export function sanitizeMultiStepCapture(capture: MultiStepCapture, transaction: MultiStepTransaction): SanitizeResult {
  if (transaction.problems.length > 0) {
    return { ok: false, reason: transaction.problems.join("; ") };
  }
  if (!transaction.account || !transaction.token) {
    return { ok: false, reason: "account/token relationship incomplete — cannot sanitize without inventing labels" };
  }
  const accountValue = transaction.account.value;
  const tokenValue = transaction.token.value;
  if (!accountValue || !tokenValue) {
    return { ok: false, reason: "account/token relationship incomplete — one opaque label per value is required" };
  }
  if (transaction.token.occurrences !== 3) {
    return { ok: false, reason: `token relationship inconsistent: expected 3 occurrences (login body + two Authorization headers), observed ${transaction.token.occurrences}` };
  }
  // The recorded origin (the ENVIRONMENT_URL value) must not survive either.
  const originMatch = capture.steps.flatMap((s) => s.requests).map((r) => r.url).find((url) => typeof url === "string" && /^https?:\/\//.test(url));
  const recordedOrigin = originMatch ? /^https?:\/\/[^/?#]+/.exec(originMatch)?.[0] : null;
  const pairs: Array<[string, string]> = [[accountValue, ACCOUNT_LABEL], [tokenValue, TOKEN_LABEL]];
  if (recordedOrigin && recordedOrigin !== SANITIZED_ORIGIN) pairs.push([recordedOrigin, SANITIZED_ORIGIN]);
  // LONGEST FIRST: when one sensitive value contains another (an account
  // value inside a token value), the longer value must be replaced before
  // the shorter one or label remnants leak into the output.
  const labels = new Map<string, string>(pairs.sort((a, b) => b[0].length - a[0].length));
  const secrets = [...labels.keys()];

  const steps = capture.steps.map((step) => ({
    // explicit allow-list construction — captured objects are never spread
    title: replaceLabels(step.title, labels),
    status: step.status,
    error: step.error === null ? null : redactQueriesInText(replaceLabels(step.error, labels)),
    requests: step.requests.map((request) => sanitizeRequest(request, labels)),
    assertions: step.assertions.map((assertion) => ({
      title: assertion.title === null ? null : replaceLabels(assertion.title, labels),
      expected: scrub(assertion.expected, labels),
      actual: scrub(assertion.actual, labels),
      passed: assertion.passed,
    })),
  }));
  // Log content is free-form and may embed any raw value — content removed.
  const logs = capture.logs?.map((entry) => ({
    level: entry.level,
    msg: "<redacted>",
    time: entry.time,
  })) ?? null;
  // Check-run metadata removed: only the static script path is provenance;
  // dependencies/imports/config/script content never enter the recording.
  const checkRunData = capture.checkRunData
    ? {
        dependencies: null,
        imports: null,
        playwrightConfig: null,
        script: null,
        scriptPath: capture.checkRunData.scriptPath === null ? null : replaceLabels(capture.checkRunData.scriptPath, labels),
      }
    : null;

  const sanitized: MultiStepCapture = {
    kind: capture.kind,
    stats: capture.stats === null ? null : { expected: capture.stats.expected, unexpected: capture.stats.unexpected, flaky: capture.stats.flaky },
    steps,
    checkRunData,
    logs,
    recurrence: { attempts: capture.recurrence.attempts },
    problems: capture.problems.map((problem) => replaceLabels(problem, labels)),
  };

  // Final safety net: nothing re-serialized may still carry an original value.
  const serialized = JSON.stringify(sanitized);
  for (const secret of secrets) {
    if (serialized.includes(secret)) {
      const kind = secret === accountValue ? "account" : secret === tokenValue ? "token" : "origin";
      return { ok: false, reason: `sanitization incomplete: an original ${kind} value would survive serialization` };
    }
  }
  try {
    JSON.parse(serialized);
  } catch {
    return { ok: false, reason: "sanitization produced invalid JSON" };
  }
  return { ok: true, capture: sanitized, secrets };
}
