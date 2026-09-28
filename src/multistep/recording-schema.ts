// Validate a stored recording BEFORE the bundle loader can use it. v1
// recordings allowed free-form paths/errors; they require re-capture. This
// v2 schema contains only fixed routes/steps/enums, bounded numbers and the
// opaque account/token labels. Missing/tampered evidence becomes UNCERTAIN.
import { MULTISTEP_RECORDING_SCHEMA, MECHANICS_ONLY_NOTE, type MultiStepRecording } from "./capture.ts";
import { extractTransaction } from "./transaction.ts";
import { MULTISTEP_ROUTES, MULTISTEP_STEP_TITLES, type MultiStepRoute } from "./routes.ts";
import type { MultiStepCapture } from "./normalize.ts";
import { multiStepSourcePath } from "./files.ts";

function obj(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
function keys(value: unknown, allowed: readonly string[]): value is Record<string, unknown> {
  const record = obj(value);
  return Boolean(record && Object.keys(record).every((key) => allowed.includes(key)));
}
function num(value: unknown): boolean {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= 1_000_000_000;
}
function assertionValue(value: unknown): boolean {
  return value === null || typeof value === "boolean" || num(value)
    || ["CONFIRMED", "09:30", "string", "number", "object", "undefined", "<redacted>"].includes(value as string);
}

const RESPONSE_FIELDS: Record<MultiStepRoute, string[]> = {
  "/api/login": ["ok", "account", "version", "token"],
  "/api/session": ["valid", "account", "tokenVersion", "currentVersion"],
  "/api/slots": ["delayMs", "slots"],
  "/api/book": ["confirmed", "booking", "account", "slot", "version"],
};

function safeBody(value: unknown, route: MultiStepRoute, side: "request" | "response"): boolean {
  if (value === null) return true;
  const fields = side === "request" ? (route === "/api/login" ? ["account"] : route === "/api/book" ? ["slot"] : []) : RESPONSE_FIELDS[route];
  if (!keys(value, fields)) return false;
  const item = value as Record<string, unknown>;
  for (const [key, field] of Object.entries(item)) {
    if (key === "account" && field !== "<account>") return false;
    if (key === "token" && field !== "<token>") return false;
    if (key === "slot" && field !== "09:30") return false;
    if ((key === "ok" || key === "valid" || key === "confirmed") && typeof field !== "boolean") return false;
    if (["version", "tokenVersion", "currentVersion", "sessionVersion", "delayMs"].includes(key) && !num(field)) return false;
    if (key === "slots" && (!Array.isArray(field) || field.length > 64 || field.some((s) => s !== "09:30" && s !== "<redacted>"))) return false;
    if (key === "status" && field !== "CONFIRMED") return false;
    if (key === "booking" && field !== "CONFIRMED"
      && (!keys(field, ["confirmed", "status", "account", "slot", "sessionVersion"])
        || !Object.entries(field).every(([nestedKey, nestedValue]) => {
          if (nestedKey === "confirmed") return typeof nestedValue === "boolean";
          if (nestedKey === "status") return nestedValue === "CONFIRMED";
          if (nestedKey === "account") return nestedValue === "<account>";
          if (nestedKey === "slot") return nestedValue === "09:30";
          return nestedKey === "sessionVersion" && num(nestedValue);
        }))) return false;
  }
  return true;
}

function requiredBody(value: unknown, route: MultiStepRoute, side: "request" | "response"): boolean {
  const body = obj(value);
  if (side === "request") {
    if (route === "/api/login") return body?.account === "<account>";
    if (route === "/api/book") return body?.slot === "09:30";
    return value === null;
  }
  if (!body) return false;
  if (route === "/api/login") return body.ok === true && body.account === "<account>"
    && body.token === "<token>" && num(body.version);
  if (route === "/api/session") return body.valid === true && body.account === "<account>"
    && num(body.tokenVersion) && num(body.currentVersion);
  if (route === "/api/slots") return Array.isArray(body.slots) && body.slots.includes("09:30") && num(body.delayMs);
  const booking = obj(body.booking);
  return booking
    ? booking.confirmed === true && booking.status === "CONFIRMED" && booking.account === "<account>"
      && booking.slot === "09:30" && num(booking.sessionVersion)
    : body.confirmed === true && body.booking === "CONFIRMED" && body.account === "<account>"
      && body.slot === "09:30" && num(body.version);
}

export function validMultiStepStoredRecording(value: unknown, side: "failing" | "passing"): value is MultiStepRecording {
  if (!keys(value, ["schemaVersion", "kind", "stats", "steps", "checkRunData", "logs", "recurrence", "transaction", "problems", "evidenceNote", "binding"])) return false;
  const root = value as unknown as MultiStepRecording;
  const binding = root.binding;
  if (!keys(binding, ["side", "checkId", "resultId", "runLocation", "startedAt", "stoppedAt", "sourceFile", "sourceSha256", "testResultsSha256", "reporter", "bridge"])
    || !binding || Object.keys(binding).length !== 11 || binding.side !== side
    || !/^[a-zA-Z0-9_-]{1,128}$/.test(binding.checkId) || !/^[a-zA-Z0-9_-]{1,128}$/.test(binding.resultId)
    || !["us-east-1", "eu-west-1"].includes(binding.runLocation)
    || !Number.isFinite(Date.parse(binding.startedAt))
    || (binding.stoppedAt !== null && !Number.isFinite(Date.parse(binding.stoppedAt)))
    || typeof binding.sourceFile !== "string" || multiStepSourcePath(binding.sourceFile) !== binding.sourceFile
    || !/^[a-f0-9]{64}$/.test(binding.sourceSha256) || !/^[a-f0-9]{64}$/.test(binding.testResultsSha256)
    || binding.reporter !== "playwright-json-nested" || binding.bridge !== "required-at-local-execution") return false;
  if (root.schemaVersion !== MULTISTEP_RECORDING_SCHEMA || root.kind !== side || root.evidenceNote !== MECHANICS_ONLY_NOTE
    || root.checkRunData !== null || root.logs !== null || !Array.isArray(root.problems) || root.problems.length > 0
    || !keys(root.stats, ["expected", "unexpected", "flaky"]) || !root.stats
    || !num(root.stats.expected) || !num(root.stats.unexpected) || !num(root.stats.flaky)
    || !keys(root.recurrence, ["attempts"]) || (root.recurrence.attempts !== null && !num(root.recurrence.attempts))
    || !Array.isArray(root.steps) || root.steps.length < 4 || root.steps.length > 5) return false;
  let failed = 0;
  for (let i = 0; i < root.steps.length; i++) {
    const step = root.steps[i]!;
    if (!keys(step, ["title", "status", "error", "failureLine", "requests", "assertions"])
      || step.title !== MULTISTEP_STEP_TITLES[i] || !["passed", "failed"].includes(step.status)
      || (step.error !== null && step.error !== "ASSERTION_FAILED" && step.error !== "STEP_ERROR")
      || (step.failureLine !== null && step.failureLine !== undefined && (!num(step.failureLine) || step.failureLine < 1 || step.failureLine > 100_000))
      || !Array.isArray(step.requests) || step.requests.length !== (i < 4 ? 1 : 0)
      || !Array.isArray(step.assertions) || step.assertions.length < 1 || step.assertions.length > 200
      || !step.assertions.some((item) => item.expected !== null)) return false;
    if (step.status === "failed") {
      failed++;
      if (i !== root.steps.length - 1 || step.error === null) return false;
    } else if (step.error !== null) return false;
    for (const a of step.assertions) {
      if (!keys(a, ["title", "expected", "actual", "passed"]) || a.title !== "assertion"
        || !assertionValue(a.expected) || !assertionValue(a.actual) || (a.passed !== null && typeof a.passed !== "boolean")) return false;
    }
    for (const request of step.requests) {
      const route = Object.keys(MULTISTEP_ROUTES)[i] as MultiStepRoute;
      if (!keys(request, ["title", "method", "url", "path", "queryKeys", "requestHeaders", "requestBody", "status", "statusText", "responseHeaders", "responseBody", "expected", "actual", "timings", "fetchUid"])
        || request.path !== route || request.method !== MULTISTEP_ROUTES[route]
        || request.title !== `${request.method} ${route}` || request.url !== `https://recorded.invalid${route}`
        || !Array.isArray(request.queryKeys) || request.queryKeys.length !== 0
        || !keys(request.requestHeaders, ["authorization", "content-type"])
        || (request.requestHeaders.authorization !== undefined && request.requestHeaders.authorization !== "Bearer <token>")
        || (request.requestHeaders["content-type"] !== undefined && request.requestHeaders["content-type"] !== "<redacted>")
        || !keys(request.responseHeaders, []) || !num(request.status) || typeof request.status !== "number" || request.status < 100 || request.status > 599
        || request.statusText !== null || request.timings !== null || request.fetchUid !== null
        || !safeBody(request.requestBody, route, "request") || !safeBody(request.responseBody, route, "response")
        || !requiredBody(request.requestBody, route, "request") || !requiredBody(request.responseBody, route, "response")
        || (route === "/api/session" || route === "/api/book" ? request.requestHeaders.authorization !== "Bearer <token>" : request.requestHeaders.authorization !== undefined)
        || !assertionValue(request.expected) || !assertionValue(request.actual)) return false;
    }
  }
  if (side === "passing" ? failed !== 0 || root.steps.length !== 5 || root.stats.unexpected !== 0 || root.stats.expected < 1
    : failed !== 1 || root.stats.unexpected < 1) return false;

  // Prove transaction sites/steps are derived exclusively from these checked
  // request objects, not an extra free-form copy from the raw asset.
  const capture: MultiStepCapture = {
    kind: root.kind, stats: root.stats, steps: root.steps, checkRunData: null, logs: null,
    recurrence: root.recurrence, problems: [],
  };
  const tx = extractTransaction(capture);
  if (tx.problems.length || !tx.account || !tx.token || !keys(root.transaction, ["steps", "account", "token", "slot", "version"])) return false;
  const expected = {
    steps: tx.steps,
    account: { label: "<account>", sites: tx.account.sites },
    token: { label: "<token>", sites: tx.token.sites, occurrences: tx.token.occurrences },
    slot: tx.slot, version: tx.version,
  };
  return JSON.stringify(root.transaction) === JSON.stringify(expected);
}
