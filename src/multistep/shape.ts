// One admission rule for downloaded evidence, values-free recordings, and
// local reporter evidence. A failure prefix, HTTP error or different assertion
// is an unknown execution, not a negative observation.
import type { MultiStepCapture } from "./normalize.ts";
import { MULTISTEP_ROUTES, MULTISTEP_STEP_TITLES } from "./routes.ts";

const ROUTES = Object.entries(MULTISTEP_ROUTES);
function object(value: unknown): Record<string, unknown> | null {
  if (typeof value === "string" && value.length <= 1024 * 1024) {
    try { return object(JSON.parse(value)); } catch { return null; }
  }
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
function version(value: unknown): boolean { return typeof value === "number" && Number.isSafeInteger(value) && value >= 0; }
function identity(value: unknown): boolean { return typeof value === "string" && value.length > 0; }
function sameAccount(a: unknown, b: unknown): boolean { return identity(a) && a === b; }

/** A fact from an ALREADY validated remote failing-side v3 recording, never
 * inferred from a passing run or from a local reporter. All fields needed to
 * recognize the fixed nested booking outcome must actually be present. */
export function recordedNestedBookingConfirmed(steps: MultiStepCapture["steps"]): boolean {
  const request = steps[3]?.requests[0];
  const body = object(request?.responseBody);
  const booking = object(body?.booking);
  return steps.length === 4 && request?.method === "POST" && request.path === "/api/book"
    && request.status === 200 && body !== null && Object.keys(body).length === 1
    && Object.hasOwn(body, "booking") && booking !== null
    && JSON.stringify(Object.keys(booking).sort()) === JSON.stringify(["account", "confirmed", "sessionVersion", "slot", "status"])
    && booking.confirmed === true && booking.status === "CONFIRMED"
    && identity(booking.account) && booking.slot === "09:30" && version(booking.sessionVersion);
}

/** The *local* detection shape, used only after trusted remote provenance and
 * a proxy-confirmed mutation. Remote admission still calls the unmodified
 * multiStepShapeProblems: its failing booking MUST have confirmed === true.
 * No other request/field/status is relaxed. */
export function multiStepDetectionShapeProblems(capture: Pick<MultiStepCapture, "kind" | "stats" | "reporterStatus" | "reporterErrors" | "steps">): string[] {
  if (capture.kind !== "failing" || capture.steps.length !== 4) return ["MULTISTEP_STEP_SEQUENCE_INVALID"];
  const book = capture.steps[3]!;
  const request = book.requests[0];
  const body = object(request?.responseBody);
  const booking = object(body?.booking);
  if (!request || !body || !booking || Object.keys(body).length !== 1
    || !Object.hasOwn(body, "booking") || Object.hasOwn(body, "confirmed")
    || JSON.stringify(Object.keys(booking).sort()) !== JSON.stringify(["account", "confirmed", "sessionVersion", "slot", "status"])
    || booking.confirmed !== false) {
    return ["MULTISTEP_REQUEST_BODY_INVALID"];
  }
  // Reuse ALL original request, assertion, and step checks on a temporary
  // in-memory view. Only the one proven mutated boolean is inverted for the
  // original strict validator; neither this view nor a draft is stored.
  const originalShape = { ...capture, steps: [...capture.steps.slice(0, 3), {
    ...book, requests: [{ ...request, responseBody: { ...body, booking: { ...booking, confirmed: true } } }, ...book.requests.slice(1)],
  }] };
  return multiStepShapeProblems(originalShape);
}

/** Fixed, values-free categories; never echo response bodies or reporter text. */
export function multiStepShapeProblems(capture: Pick<MultiStepCapture, "kind" | "stats" | "reporterStatus" | "reporterErrors" | "steps">,
  reporterOnly = false): string[] {
  const problems: string[] = [];
  const failing = capture.kind === "failing";
  const steps = capture.steps;
  const size = failing ? 4 : 5;
  if (steps.length !== size || capture.reporterStatus !== (failing ? "failed" : "passed") || capture.reporterErrors !== 0 || !capture.stats
    || capture.stats.flaky !== 0 || capture.stats.expected !== (failing ? 0 : 1)
    || capture.stats.unexpected !== (failing ? 1 : 0)
    || steps.some((s, i) => s.title !== MULTISTEP_STEP_TITLES[i]
      || s.status !== (failing && i === 3 ? "failed" : "passed")
      || !(failing && i === 3) && s.error !== null)) {
    problems.push("MULTISTEP_STEP_SEQUENCE_INVALID");
  }
  if (steps.length !== size) return problems;
  if (failing) {
    const book = steps[3]!;
    if (!book.error || !(book.error === "ASSERTION_FAILED" || /expect\s*\(/i.test(book.error))
      || !Number.isSafeInteger(book.failureLine) || (book.failureLine ?? 0) < 1) {
      problems.push("MULTISTEP_FAILURE_STEP_UNBOUND");
    }
    if (!reporterOnly && !book.assertions.some((a) => a.expected === true && a.actual !== true && a.passed !== true)) {
      problems.push("MULTISTEP_FAILURE_STEP_UNBOUND");
    }
  }
  if (reporterOnly) return problems;
  for (let i = 0; i < size; i++) {
    const step = steps[i]!;
    if (step.requests.length !== (i < 4 ? 1 : 0)) {
      problems.push("MULTISTEP_REQUEST_SEQUENCE_INVALID");
      continue;
    }
    if (i === 4) {
      if (!step.assertions.some((a) => a.expected === "CONFIRMED" && a.actual === "CONFIRMED" && a.passed !== false)) {
        problems.push("MULTISTEP_ASSERTION_EVIDENCE_MISSING");
      }
      continue;
    }
    const req = step.requests[0]!;
    const [route, method] = ROUTES[i]!;
    let validUrl = false;
    try {
      const url = new URL(req.url ?? "");
      validUrl = url.protocol === "https:" && !url.username && !url.password && !url.search && !url.hash
        && url.pathname === route;
    } catch { /* not canonical */ }
    if (req.method !== method || req.path !== route || !validUrl || req.queryKeys.length !== 0
      || req.status !== 200) problems.push("MULTISTEP_REQUEST_SCHEMA_INVALID");
    const body = object(req.responseBody);
    const input = object(req.requestBody);
    if (!body || (i === 0 && (!input || !identity(input.account) || body.ok !== true
      || !sameAccount(body.account, input.account) || !identity(body.token) || !version(body.version)))
      || (i === 1 && (body.valid !== true || !identity(body.account)
        || !version(body.tokenVersion) || !version(body.currentVersion)))
      || (i === 2 && (!version(body.delayMs) || !Array.isArray(body.slots)
        || body.slots.length < 1 || body.slots.length > 64 || !body.slots.includes("09:30")))
      || (i === 3 && (!input || input.slot !== "09:30"
        || (failing
          ? Object.hasOwn(body, "confirmed") || !object(body.booking)
            || object(body.booking)?.confirmed !== true || object(body.booking)?.status !== "CONFIRMED"
            || !identity(object(body.booking)?.account) || object(body.booking)?.slot !== "09:30"
            || !version(object(body.booking)?.sessionVersion)
          : body.confirmed !== true || body.booking !== "CONFIRMED" || !identity(body.account)
            || body.slot !== "09:30" || !version(body.version))))) {
      problems.push("MULTISTEP_REQUEST_BODY_INVALID");
    }
    // The request record carries expected/actual only in some reporter formats
    // (the real Checkly 9.5.0 runner puts the assertion on the expect step's
    // checklyData instead). When present they must show the stale assertion;
    // when absent, the step-level assertion evidence above is the binding proof.
    if (i === 3 && failing && (req.expected !== null || req.actual !== null)
      && (req.expected !== true || req.actual === true)) {
      problems.push("MULTISTEP_FAILURE_STEP_UNBOUND");
    }
    if (i === 3 && !failing && !step.assertions.some((a) => a.expected === true
      && a.actual === true && a.passed !== false)) {
      problems.push("MULTISTEP_ASSERTION_EVIDENCE_MISSING");
    }
    if ((i === 1 || i === 3) && !identity(req.requestHeaders.authorization)) {
      problems.push("MULTISTEP_TOKEN_RELATIONSHIP_INVALID");
    }
    if (!step.assertions.some((a) => a.expected !== null && a.expected !== undefined)) {
      problems.push("MULTISTEP_ASSERTION_EVIDENCE_MISSING");
    }
  }
  return [...new Set(problems)];
}
