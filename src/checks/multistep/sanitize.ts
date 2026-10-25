// Values-free Multistep recording. The normalized Checkly asset is trusted
// only long enough to establish transaction relationships. What is STORED is
// rebuilt from four fixed route schemas, not recursively scrubbed free-form
// JSON. A new URL/path, header name, log level, error or metadata field can
// never silently become evidence in a bundle.
import type { MultiStepCapture, MultiStepRequestEvidence } from "./normalize.ts";
import type { MultiStepTransaction } from "./transaction.ts";
import { multiStepShapeProblems } from "./shape.ts";
import { scenarioLayout } from "./layout.ts";

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
  "MULTISTEP_ACCOUNT_RELATIONSHIP_INVALID", "MULTISTEP_SLOT_RELATIONSHIP_INVALID", "MULTISTEP_TRANSACTION_RELATIONSHIP_INVALID",
  "MULTISTEP_ARCHIVE_INVALID", "MULTISTEP_ASSET_UNSAFE", "MULTISTEP_SIDE_MISMATCH",
  "MULTISTEP_STEP_SEQUENCE_INVALID", "MULTISTEP_STEP_SCHEMA_INVALID", "MULTISTEP_REQUEST_SCHEMA_INVALID",
  "MULTISTEP_REQUEST_SEQUENCE_INVALID", "MULTISTEP_FAILURE_STEP_UNBOUND", "MULTISTEP_SANITIZATION_INCOMPLETE",
  "MULTISTEP_RESULT_SIDE_MISMATCH", "MULTISTEP_CAPTURE_SIDE_MISMATCH", "MULTISTEP_DUPLICATE_ASSET",
  "MULTISTEP_ASSET_COUNT_EXCEEDED", "MULTISTEP_ASSET_MANIFEST_TRUNCATED", "MULTISTEP_ASSET_MANIFEST_UNAVAILABLE", "MULTISTEP_ASSET_MANIFEST_INVALID",
  "MULTISTEP_SOURCE_PROJECT_MISMATCH", "MULTISTEP_ENTRYPOINT_MISSING", "MULTISTEP_ENTRYPOINT_UNSAFE",
  "MULTISTEP_CONSTRUCT_UNRESOLVED", "MULTISTEP_DEPLOYED_CONFIG_MISMATCH",
  "MULTISTEP_RESULT_STATS_INVALID", "MULTISTEP_REQUEST_BODY_INVALID", "MULTISTEP_ASSERTION_EVIDENCE_MISSING",
  "MULTISTEP_SOURCE_PATH_UNSAFE", "MULTISTEP_SOURCE_CLOSURE_BOUND", "MULTISTEP_CAPTURE_BINDING_INVALID", "MULTISTEP_ASSET_DOWNLOAD_FAILED",
  "MULTISTEP_MECHANICS_ONLY", "MULTISTEP_ASSET_TYPE_INVALID", "MULTISTEP_BYPASS_BINDING_INVALID", "MULTISTEP_RAW_SCHEMA_INVALID", "MULTISTEP_CONSTRUCT_IDENTITY_INVALID", "MULTISTEP_DEPLOYED_SOURCE_MISMATCH",
  // Rendered per-side availability names (bundle-level templates): a missing
  // or unbindable side must be reported as exactly that, never collapsed into
  // the EVIDENCE_INVALID fallback.
  "MULTISTEP_FAILING_RESULT_MISSING", "MULTISTEP_PASSING_RESULT_MISSING",
  "MULTISTEP_FAILING_RECORDING_MISSING", "MULTISTEP_PASSING_RECORDING_MISSING",
  "MULTISTEP_FAILING_RECORDING_INVALID", "MULTISTEP_PASSING_RECORDING_INVALID",
  // Bundle-supplied scenario absent or rejected by the closed grammar.
  "MULTISTEP_SCENARIO_INVALID",
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
  // HTTP failures from a presigned remote asset are transport failures, not
  // evidence-shape failures. Keep them distinct so the bundle cannot report
  // a generic EVIDENCE_INVALID when the provider artifact was never obtained.
  if (/^asset download failed \(HTTP \d{3}\)$/i.test(problem)) return "MULTISTEP_ASSET_DOWNLOAD_FAILED";
  if (/symbolic link|symlink|file byte bound|bounded regular file/i.test(problem)) return "MULTISTEP_ASSET_UNSAFE";
  if (/missing|not found|no ordered step/i.test(problem)) return "MULTISTEP_EVIDENCE_MISSING";
  // Internally contradictory stats/status evidence is a stats problem, and
  // unparseable/malformed raw evidence is a raw-schema problem: name them
  // truthfully instead of collapsing into the generic fallback. These are
  // matched before the looser side/kind/status wording, which must not eat
  // them (e.g. "side" inside "inside an all-passed result").
  if (/inconsistent capture/i.test(problem)) return "MULTISTEP_RESULT_STATS_INVALID";
  if (/corrupt|not valid JSON|not a JSON object|not a JSON array|not a genuine|genuine nested|malformed entry|exceeds supported depth|does not read as text|neither an object nor an array|has no stats block/i.test(problem)) return "MULTISTEP_RAW_SCHEMA_INVALID";
  if (/\bside\b|kind|status mismatch/i.test(problem)) return "MULTISTEP_SIDE_MISMATCH";
  // Bounded-reader byte-budget violations outside a zip: prefix are unsafe
  // assets, not generic evidence failures.
  if (/byte bound/i.test(problem)) return "MULTISTEP_ASSET_UNSAFE";
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
  if (typeof value === "string") return fixedString(value, ["CONFIRMED", "string", "number", "object", "undefined"]) ?? REDACTED;
  // Arbitrary nested objects and strings may carry secrets. Only the type is
  // relevant to assertion failure attribution; the raw value is never stored.
  return REDACTED;
}

const SAFE_WORDS = new Set(["CONFIRMED", "string", "number", "object", "undefined"]);

function safeScalar(value: unknown, tx: MultiStepTransaction): unknown {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return integer(value) ?? REDACTED;
  if (typeof value === "string") {
    if (value === tx.account?.value) return ACCOUNT_LABEL;
    if (value === tx.token?.value) return TOKEN_LABEL;
    if (tx.slot?.value && (value === tx.slot.value || /^\d{2}:\d{2}$/.test(value))) return tx.slot.value;
    if (SAFE_WORDS.has(value) || /^[A-Z][A-Z0-9_]{0,31}$/.test(value)) return value;
    return REDACTED;
  }
  return REDACTED;
}

/** Rebuild a values-free JSON body. Unknown strings never survive; role
 * values are replaced by fixed labels; keys are bounded identifiers. */
function safeBody(input: unknown, tx: MultiStepTransaction): Record<string, unknown> | null {
  const body = payload(input);
  if (!body) return null;
  const scrub = (value: unknown, depth: number): unknown => {
    if (depth > 8) return REDACTED;
    if (Array.isArray(value)) return value.slice(0, 64).map((item) => scrub(item, depth + 1));
    const record = value !== null && typeof value === "object" && !Array.isArray(value)
      ? value as Record<string, unknown> : null;
    if (!record) return safeScalar(value, tx);
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(record).slice(0, 32)) {
      if (!/^[A-Za-z_$][A-Za-z0-9_$-]{0,63}$/.test(key)) continue;
      out[key] = scrub(child, depth + 1);
    }
    return out;
  };
  const rebuilt = scrub(body, 0);
  return rebuilt !== null && typeof rebuilt === "object" && !Array.isArray(rebuilt) && Object.keys(rebuilt).length
    ? rebuilt as Record<string, unknown> : null;
}

function safeRequest(request: MultiStepRequestEvidence, tx: MultiStepTransaction, route: { method: string; path: string }): MultiStepRequestEvidence | null {
  // URL/path must BOTH identify the same exact canonical route and contain no
  // query or fragment. The URL's origin is replaced wholesale.
  let urlPath: string | null = null;
  try {
    const url = request.url ? new URL(request.url) : null;
    urlPath = url && url.protocol === "https:" && !url.username && !url.password && !url.search && !url.hash
      ? url.pathname : null;
  } catch { return null; }
  if (urlPath !== route.path || request.path !== route.path || request.queryKeys.length !== 0
    || request.method !== route.method
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
    title: `${request.method} ${route.path}`,
    method: request.method,
    url: `${ORIGIN_LABEL}${route.path}`,
    path: route.path,
    queryKeys: [],
    requestHeaders,
    requestBody: safeBody(request.requestBody, tx),
    status: request.status,
    statusText: null,
    responseHeaders: {},
    responseBody: safeBody(request.responseBody, tx),
    expected: redactAssertionValue(request.expected),
    actual: redactAssertionValue(request.actual),
    timings: null,
    fetchUid: null,
  };
}

export function sanitizeMultiStepCapture(capture: MultiStepCapture, transaction: MultiStepTransaction): SanitizeResult {
  // Missing or unclean runtime statistics are named before the shape law so a
  // stats-less capture can never masquerade as a sequence problem.
  if (!capture.stats || integer(capture.stats.expected) === null || integer(capture.stats.unexpected) === null
    || integer(capture.stats.flaky) === null) return { ok: false, reason: "MULTISTEP_RESULT_STATS_INVALID" };
  const layout = scenarioLayout(capture);
  const shape = multiStepShapeProblems(layout, capture);
  if (shape.length) return { ok: false, reason: shape[0]! };
  if (capture.problems.length) return { ok: false, reason: multistepProblemCategory(capture.problems[0]!) };
  if (transaction.problems.length) return { ok: false, reason: multistepProblemCategory(transaction.problems[0]!) };
  if (!transaction.account?.value || !transaction.token?.value || transaction.token.occurrences !== 3) {
    return { ok: false, reason: "MULTISTEP_TOKEN_RELATIONSHIP_INVALID" };
  }
  const secrets = new Set([transaction.account.value, transaction.token.value]);
    // A wrong ordered-step count is a sequence problem, never the generic
  // EVIDENCE_INVALID fallback.
  if (capture.steps.length < 1 || capture.steps.length > 64) return { ok: false, reason: "MULTISTEP_STEP_SEQUENCE_INVALID" };
  const steps: MultiStepCapture["steps"] = [];
  for (let i = 0; i < capture.steps.length; i++) {
    const step = capture.steps[i]!;
    const title = step.title;
    if (step.status !== "passed" && step.status !== "failed" || step.assertions.length > 200
      || typeof title !== "string" || title.length === 0) {
      return { ok: false, reason: "MULTISTEP_STEP_SCHEMA_INVALID" };
    }
    if (title !== layout.stepTitles[i]) return { ok: false, reason: "MULTISTEP_STEP_SEQUENCE_INVALID" };
    const requests: MultiStepRequestEvidence[] = [];
    for (const req of step.requests) {
      const route = layout.routes[i];
      const saved = route ? safeRequest(req, transaction, route) : null;
      if (!saved) return { ok: false, reason: "MULTISTEP_REQUEST_SCHEMA_INVALID" };
      try { if (req.url) secrets.add(new URL(req.url).origin); } catch { return { ok: false, reason: "MULTISTEP_REQUEST_SCHEMA_INVALID" }; }
      requests.push(saved);
    }
    if (requests.length !== (i < layout.routes.length ? 1 : 0)) return { ok: false, reason: "MULTISTEP_REQUEST_SEQUENCE_INVALID" };
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
    : failed.length !== 0 || steps.length !== layout.stepTitles.length || capture.stats.unexpected !== 0) {
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
  const sanitizedShape = multiStepShapeProblems(scenarioLayout(sanitized), sanitized);
  if (sanitizedShape.length) return { ok: false, reason: sanitizedShape[0]! };
  const serialized = JSON.stringify(sanitized);
  for (const secret of secrets) {
    if (secret.length > 0 && serialized.includes(secret)) return { ok: false, reason: "MULTISTEP_SANITIZATION_INCOMPLETE" };
  }
  return { ok: true, capture: sanitized, secrets: [...secrets] };
}
