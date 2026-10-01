// Values-free Multistep recording. The normalized Checkly asset is trusted
// only long enough to establish transaction relationships. What is STORED is
// rebuilt from four fixed route schemas, not recursively scrubbed free-form
// JSON. A new URL/path, header name, log level, error or metadata field can
// never silently become evidence in a bundle.
import type { MultiStepCapture, MultiStepRequestEvidence } from "./normalize.ts";
import type { MultiStepTransaction } from "./transaction.ts";
import { multiStepShapeProblems } from "./shape.ts";
import { knownRoute, knownStepTitle, MULTISTEP_ROUTES, MULTISTEP_STEP_TITLES, routeFromUrl, type MultiStepRoute } from "./routes.ts";

export const ACCOUNT_LABEL = "<account>";
export const TOKEN_LABEL = "<token>";
const REDACTED = "<redacted>";
const ORIGIN_LABEL = "https://recorded.invalid";

export type SanitizeResult =
  | { ok: true; capture: MultiStepCapture; secrets: string[] }
  | { ok: false; reason: string };

/** Fixed categories only. Never serialize a raw parser/asset/transaction error. */
const KNOWN_PROBLEMS = new Set([
  "MULTISTEP_EVIDENCE_MISSING", "MULTISTEP_EVIDENCE_INVALID", "MULTISTEP_TOKEN_RELATIONSHIP_INVALID",
  "MULTISTEP_ACCOUNT_RELATIONSHIP_INVALID", "MULTISTEP_SLOT_RELATIONSHIP_INVALID",
  "MULTISTEP_ARCHIVE_INVALID", "MULTISTEP_ASSET_UNSAFE", "MULTISTEP_SIDE_MISMATCH",
  "MULTISTEP_STEP_SEQUENCE_INVALID", "MULTISTEP_STEP_SCHEMA_INVALID", "MULTISTEP_REQUEST_SCHEMA_INVALID",
  "MULTISTEP_REQUEST_SEQUENCE_INVALID", "MULTISTEP_FAILURE_STEP_UNBOUND", "MULTISTEP_SANITIZATION_INCOMPLETE",
  "MULTISTEP_RESULT_SIDE_MISMATCH", "MULTISTEP_CAPTURE_SIDE_MISMATCH", "MULTISTEP_DUPLICATE_ASSET",
  "MULTISTEP_ASSET_COUNT_EXCEEDED", "MULTISTEP_ASSET_MANIFEST_TRUNCATED", "MULTISTEP_ASSET_MANIFEST_UNAVAILABLE", "MULTISTEP_ASSET_MANIFEST_INVALID",
  "MULTISTEP_SOURCE_PROJECT_MISMATCH", "MULTISTEP_ENTRYPOINT_MISSING", "MULTISTEP_ENTRYPOINT_UNSAFE",
  "MULTISTEP_CONSTRUCT_UNRESOLVED", "MULTISTEP_DEPLOYED_CONFIG_MISMATCH",
  "MULTISTEP_RESULT_STATS_INVALID", "MULTISTEP_REQUEST_BODY_INVALID", "MULTISTEP_ASSERTION_EVIDENCE_MISSING",
  "MULTISTEP_SOURCE_PATH_UNSAFE", "MULTISTEP_SOURCE_CLOSURE_BOUND", "MULTISTEP_CAPTURE_BINDING_INVALID",
  "MULTISTEP_MECHANICS_ONLY", "MULTISTEP_ASSET_TYPE_INVALID", "MULTISTEP_BYPASS_BINDING_INVALID", "MULTISTEP_RAW_SCHEMA_INVALID", "MULTISTEP_CONSTRUCT_IDENTITY_INVALID", "MULTISTEP_DEPLOYED_SOURCE_MISMATCH",
]);
/** True only for the exact fixed problem names above. Used by the taxonomy
 * test to prove every emitter spells a real category (no typo can masquerade
 * as an unknown problem and collapse into the EVIDENCE_INVALID fallback). */
export function isKnownMultiStepProblem(problem: string): boolean {
  return KNOWN_PROBLEMS.has(problem);
}

export function multistepProblemCategory(problem: string): string {
  if (KNOWN_PROBLEMS.has(problem)) return problem;
  if (/token relationship/i.test(problem)) return "MULTISTEP_TOKEN_RELATIONSHIP_INVALID";
  if (/account relationship/i.test(problem)) return "MULTISTEP_ACCOUNT_RELATIONSHIP_INVALID";
  if (/slot relationship/i.test(problem)) return "MULTISTEP_SLOT_RELATIONSHIP_INVALID";
  if (/assets?\.zip|archive|zip:/i.test(problem)) return "MULTISTEP_ARCHIVE_INVALID";
  if (/symbolic link|symlink|file byte bound|bounded regular file/i.test(problem)) return "MULTISTEP_ASSET_UNSAFE";
  if (/missing|not found|no ordered step/i.test(problem)) return "MULTISTEP_EVIDENCE_MISSING";
  if (/side|kind|status mismatch/i.test(problem)) return "MULTISTEP_SIDE_MISMATCH";
  return "MULTISTEP_EVIDENCE_INVALID";
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function payload(value: unknown): Record<string, unknown> | null {
  if (typeof value === "string" && value.length <= 1024 * 1024) {
    try { return record(JSON.parse(value)); } catch { return null; }
  }
  return record(value);
}

function integer(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= 1_000_000_000 ? value : null;
}

function boolean(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

function fixedString(value: unknown, allowed: readonly string[]): string | null {
  return typeof value === "string" && allowed.includes(value) ? value : null;
}

function redactAssertionValue(value: unknown): unknown {
  if (value === null || value === undefined) return null;
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return [0, 1, 200, 1500].includes(value) ? value : REDACTED;
  if (typeof value === "string") return fixedString(value, ["CONFIRMED", "09:30", "string", "number", "object", "undefined"]) ?? REDACTED;
  // Arbitrary nested objects and strings may carry secrets. Only the type is
  // relevant to assertion failure attribution; the raw value is never stored.
  return REDACTED;
}

function safeBody(route: MultiStepRoute, side: "request" | "response", input: unknown, tx: MultiStepTransaction): Record<string, unknown> | null {
  const body = payload(input);
  if (!body) return null;
  const out: Record<string, unknown> = {};
  const account = (value: unknown): string | null => typeof value === "string" && value === tx.account?.value ? ACCOUNT_LABEL : null;
  const slot = (value: unknown): string | null => fixedString(value, ["09:30"]);
  const version = (value: unknown): number | null => integer(value);
  const put = (key: string, value: unknown): void => { if (value !== null) out[key] = value; };

  if (side === "request") {
    if (route === "/api/login") put("account", account(body.account));
    if (route === "/api/book") put("slot", slot(body.slot));
    return Object.keys(out).length ? out : null;
  }
  if (route === "/api/login") {
    put("ok", boolean(body.ok));
    put("account", account(body.account));
    put("version", version(body.version));
    if (body.token === tx.token?.value) out.token = TOKEN_LABEL;
    // Deployment-reported `store: memory` is not storage proof; omit it
    // entirely rather than projecting a self-asserted trust signal.
  } else if (route === "/api/session") {
    put("valid", boolean(body.valid));
    put("account", account(body.account));
    put("tokenVersion", version(body.tokenVersion));
    put("currentVersion", version(body.currentVersion));
  } else if (route === "/api/slots") {
    put("delayMs", version(body.delayMs));
    if (Array.isArray(body.slots)) out.slots = body.slots.slice(0, 64).map((s) => slot(s) ?? REDACTED);
  } else if (route === "/api/book") {
    put("confirmed", boolean(body.confirmed));
    put("booking", fixedString(body.booking, ["CONFIRMED"]));
    put("account", account(body.account));
    put("slot", slot(body.slot));
    put("version", version(body.version));
    const booking = record(body.booking);
    if (booking) {
      const nested: Record<string, unknown> = {};
      const add = (key: string, value: unknown): void => { if (value !== null) nested[key] = value; };
      add("confirmed", boolean(booking.confirmed));
      add("status", fixedString(booking.status, ["CONFIRMED"]));
      add("account", account(booking.account));
      add("slot", slot(booking.slot));
      add("sessionVersion", version(booking.sessionVersion));
      out.booking = nested;
    }
  }
  return Object.keys(out).length ? out : null;
}

function safeRequest(request: MultiStepRequestEvidence, tx: MultiStepTransaction): MultiStepRequestEvidence | null {
  // URL/path must BOTH identify the same exact canonical route and contain no
  // query or fragment. The URL's origin is replaced wholesale.
  const route = routeFromUrl(request.url);
  if (!route || knownRoute(request.path) !== route || request.queryKeys.length !== 0
    || request.method !== MULTISTEP_ROUTES[route]
    || request.status === null || !Number.isInteger(request.status) || request.status < 100 || request.status > 599) return null;
  const requestHeaders: Record<string, string> = {};
  if (Object.hasOwn(request.requestHeaders, "authorization")) {
    if (request.requestHeaders.authorization !== `Bearer ${tx.token?.value}`) return null;
    requestHeaders.authorization = `Bearer ${TOKEN_LABEL}`;
  }
  if (Object.keys(request.requestHeaders).some((key) => key.toLowerCase() === "content-type")) {
    requestHeaders["content-type"] = REDACTED;
  }
  return {
    title: `${request.method} ${route}`,
    method: request.method,
    url: `${ORIGIN_LABEL}${route}`,
    path: route,
    queryKeys: [],
    requestHeaders,
    requestBody: safeBody(route, "request", request.requestBody, tx),
    status: request.status,
    statusText: null,
    responseHeaders: {},
    responseBody: safeBody(route, "response", request.responseBody, tx),
    expected: redactAssertionValue(request.expected),
    actual: redactAssertionValue(request.actual),
    timings: null,
    fetchUid: null,
  };
}

export function sanitizeMultiStepCapture(capture: MultiStepCapture, transaction: MultiStepTransaction): SanitizeResult {
  const shape = multiStepShapeProblems(capture);
  if (shape.length) return { ok: false, reason: shape[0]! };
  if (capture.problems.length) return { ok: false, reason: multistepProblemCategory(capture.problems[0]!) };
  if (transaction.problems.length) return { ok: false, reason: multistepProblemCategory(transaction.problems[0]!) };
  if (!transaction.account?.value || !transaction.token?.value || transaction.token.occurrences !== 3) {
    return { ok: false, reason: "MULTISTEP_TOKEN_RELATIONSHIP_INVALID" };
  }
  const secrets = new Set([transaction.account.value, transaction.token.value]);
  if (!capture.stats || integer(capture.stats.expected) === null || integer(capture.stats.unexpected) === null
    || integer(capture.stats.flaky) === null || integer(capture.recurrence.attempts) === null && capture.recurrence.attempts !== null
    || capture.steps.length < 4 || capture.steps.length > 5) return { ok: false, reason: "MULTISTEP_EVIDENCE_INVALID" };
  const steps: MultiStepCapture["steps"] = [];
  for (let i = 0; i < capture.steps.length; i++) {
    const step = capture.steps[i]!;
    const title = knownStepTitle(step.title);
    if (step.status !== "passed" && step.status !== "failed" || step.assertions.length > 200) {
      return { ok: false, reason: "MULTISTEP_STEP_SCHEMA_INVALID" };
    }
    if (title === null || title !== MULTISTEP_STEP_TITLES[i]) return { ok: false, reason: "MULTISTEP_STEP_SEQUENCE_INVALID" };
    const requests: MultiStepRequestEvidence[] = [];
    for (const req of step.requests) {
      const saved = safeRequest(req, transaction);
      if (!saved || (i < 4 && saved.path !== (Object.keys(MULTISTEP_ROUTES) as MultiStepRoute[])[i])) {
        return { ok: false, reason: "MULTISTEP_REQUEST_SCHEMA_INVALID" };
      }
      try { if (req.url) secrets.add(new URL(req.url).origin); } catch { return { ok: false, reason: "MULTISTEP_REQUEST_SCHEMA_INVALID" }; }
      requests.push(saved);
    }
    if (requests.length !== (i < 4 ? 1 : 0)) return { ok: false, reason: "MULTISTEP_REQUEST_SEQUENCE_INVALID" };
    steps.push({
      title,
      status: step.status,
      error: step.error === null ? null : /expect\s*\(/i.test(step.error) ? "ASSERTION_FAILED" : "STEP_ERROR",
      failureLine: Number.isSafeInteger(step.failureLine) && (step.failureLine ?? 0) > 0 ? step.failureLine : null,
      requests,
      assertions: step.assertions.map((a) => ({
        title: "assertion", expected: redactAssertionValue(a.expected), actual: redactAssertionValue(a.actual), passed: a.passed,
      })),
    });
  }
  const failed = steps.filter((step) => step.status === "failed");
  if (capture.kind === "failing" ? failed.length !== 1 || steps.at(-1)?.status !== "failed" || capture.stats.unexpected < 1
    : failed.length !== 0 || steps.length !== 5 || capture.stats.unexpected !== 0) {
    return { ok: false, reason: "MULTISTEP_FAILURE_STEP_UNBOUND" };
  }
  // No raw logs, paths, trace/check-run metadata, free-form errors or problem
  // messages. Runtime numeric statistics and fixed transaction shape remain.
  const sanitized: MultiStepCapture = {
    kind: capture.kind,
    reporterStatus: capture.reporterStatus,
    reporterErrors: capture.reporterErrors,
    stats: capture.stats ? { expected: capture.stats.expected, unexpected: capture.stats.unexpected, flaky: capture.stats.flaky } : null,
    steps, checkRunData: null, logs: null,
    recurrence: { attempts: capture.recurrence.attempts }, problems: [],
  };
  const sanitizedShape = multiStepShapeProblems(sanitized);
  if (sanitizedShape.length) return { ok: false, reason: sanitizedShape[0]! };
  const serialized = JSON.stringify(sanitized);
  for (const secret of secrets) {
    if (secret.length > 0 && serialized.includes(secret)) return { ok: false, reason: "MULTISTEP_SANITIZATION_INCOMPLETE" };
  }
  return { ok: true, capture: sanitized, secrets: [...secrets] };
}
