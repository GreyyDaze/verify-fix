// Real Checkly / Playwright result normalization for Multistep captures.
//
// Input path (documented by the Stage-7 evidence review):
//   Checkly final result → downloaded assets (logs.txt, test-results.json,
//   check-run-data.json) → Playwright JSON report → ordered steps →
//   checklyData → structured transaction.
//
// test-results.json is the required asset: it carries the ordered steps and
// their nested checklyData (method, URL, query, headers, bodies, status,
// timings, expected/actual, request title, fetch UID). check-run-data.json is
// OPTIONAL evidence (dependencies/imports/playwrightConfig may be absent in a
// failing capture). logs.txt is JSON [{level,msg,time}].
//
// Anything missing, unreadable, corrupt, truncated, or structurally invalid
// becomes a `problems` entry — the decision layer maps problems to UNCERTAIN,
// never to PASS or FAIL. No LLM. No invented trace/HAR/video.

import type { ObservationValue } from "../types.ts";
import { MULTISTEP_STEP_TITLES } from "./routes.ts";
import { multiStepShapeProblems } from "./shape.ts";

export interface MultiStepRequestEvidence {
  /** request title from checklyData, when present */
  title: string | null;
  method: string | null;
  url: string | null;
  path: string | null;
  queryKeys: string[];
  requestHeaders: Record<string, string>;
  requestBody: unknown;
  status: number | null;
  statusText: string | null;
  responseHeaders: Record<string, string>;
  responseBody: unknown;
  expected: unknown;
  actual: unknown;
  timings: unknown;
  fetchUid: string | null;
}

export interface MultiStepAssertionEvidence {
  title: string | null;
  expected: unknown;
  actual: unknown;
  /** null when the outcome cannot be derived from the capture */
  passed: boolean | null;
}

export interface MultiStepStepEvidence {
  title: string;
  status: "passed" | "failed" | "skipped" | "unknown";
  error: string | null;
  /** Numeric spec line only; no source path or free-form stack is retained. */
  failureLine?: number | null;
  requests: MultiStepRequestEvidence[];
  assertions: MultiStepAssertionEvidence[];
}

export interface MultiStepCheckRunData {
  dependencies: unknown;
  imports: unknown;
  playwrightConfig: unknown;
  script: string | null;
  scriptPath: string | null;
}

export interface MultiStepCapture {
  kind: "passing" | "failing";
  stats: { expected: number; unexpected: number; flaky: number } | null;
  /** The single actual Playwright test-result status, independently of stats. */
  reporterStatus: "passed" | "failed" | null;
  /** No independent reporter error or contradictory duplicated request field. */
  reporterErrors: 0 | 1;
  steps: MultiStepStepEvidence[];
  checkRunData: MultiStepCheckRunData | null;
  logs: Array<{ level: string; msg: string; time: number | null }> | null;
  /** recurrence evidence only — never changes an observation */
  recurrence: { attempts: number | null };
  /** normalization problems → UNCERTAIN downstream */
  problems: string[];
}

interface JsonStep {
  title?: unknown;
  error?: unknown;
  errors?: unknown;
  status?: unknown;
  steps?: unknown;
  checklyData?: unknown;
  category?: unknown;
  duration?: unknown;
}

interface JsonReport {
  stats?: { expected?: unknown; unexpected?: unknown; flaky?: unknown; skipped?: unknown };
  suites?: unknown;
  errors?: unknown;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function asString(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return null;
}

/**
 * Header values arrive in real assets as either a plain object
 * (`{name: value}`) or array form (`[[name, value], …]`, `[{name, value}, …]`,
 * or nested arrays). Both normalize to the same lowercase-name record;
 * unsupported shapes are reported as corrupt evidence.
 */
function headerRecord(value: unknown, problems?: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  const put = (name: unknown, item: unknown): void => {
    const text = Array.isArray(item) ? item.map(asString).filter((v): v is string => v !== null).join(", ") : asString(item);
    const key = asString(name);
    if (key !== null && text !== null) out[key.toLowerCase()] = text;
    else problems?.push("header entry does not read as text (corrupt evidence)");
  };
  const record = asRecord(value);
  if (record) {
    for (const [name, item] of Object.entries(record)) put(name, item);
    return out;
  }
  if (Array.isArray(value)) {
    for (const entry of value) {
      if (Array.isArray(entry) && entry.length >= 2) {
        put(entry[0], entry[1]);
      } else {
        const item = asRecord(entry);
        if (item && ("name" in item || "key" in item) && "value" in item) put(item.name ?? item.key, item.value);
        else problems?.push("header array entry is not a [name, value] pair (corrupt evidence)");
      }
    }
    return out;
  }
  if (value !== null && value !== undefined) problems?.push("headers field is neither an object nor an array (corrupt evidence)");
  return out;
}

/** Flatten nested `checklyData` arrays to their record elements (bounded, silent — may run twice per child). */
function checklyRecords(child: JsonStep): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  const walk = (value: unknown, depth: number): void => {
    if (depth > 4) return;
    const record = asRecord(value);
    if (record) {
      out.push(record);
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) walk(item, depth + 1);
    }
  };
  walk(child.checklyData, 0);
  return out;
}

/** The real body field: a record with only a `data` key wraps the payload. */
function unwrapDataField(value: unknown): unknown {
  const record = asRecord(value);
  if (record && Object.keys(record).length === 1 && "data" in record) return record.data;
  return value;
}

function requestEvidence(child: JsonStep, problems: string[]): MultiStepRequestEvidence | null {
  const records = checklyRecords(child);
  const requests = records.filter((r) => "method" in r || "url" in r || "request" in r || "requestBody" in r || "requestHeaders" in r);
  const raw = requests[0] ?? null;
  if (!raw) return null;
  if (requests.length !== 1) problems.push("MULTISTEP_REQUEST_SCHEMA_INVALID");
  if (!Array.isArray(child.checklyData)) problems.push("request checklyData is not a genuine nested Playwright array");
  const nestedRequest = asRecord(raw.request);
  const request = nestedRequest ?? raw;
  const nestedResponse = asRecord(raw.response);
  const response = nestedResponse ?? {};
  const method = asString(raw.method ?? request.method)?.toUpperCase() ?? null;
  const url = asString(raw.url ?? request.url ?? request.uri) ?? null;
  // Checkly assets may repeat a field in both the outer and nested request/
  // response. An outer 200 cannot erase a nested 401 (or a different body),
  // even when either representation alone looks like the canonical request.
  if (raw.method != null && nestedRequest?.method != null
    && asString(raw.method)?.toUpperCase() !== asString(nestedRequest.method)?.toUpperCase()) problems.push("MULTISTEP_REQUEST_SCHEMA_INVALID");
  const redundantUrls = [raw.url, nestedRequest?.url, nestedRequest?.uri].filter((value) => value != null);
  if (redundantUrls.some((value) => value !== url)) problems.push("MULTISTEP_REQUEST_SCHEMA_INVALID");
  if (method === null && url === null) {
    // checklyData without request fields is assertion-only evidence — legal.
    if ("method" in raw || "url" in raw || "request" in raw) {
      problems.push("checklyData request evidence has a method/url field that does not read as text (corrupt evidence)");
    }
    return null;
  }
  const statusRaw = raw.status ?? response.status ?? raw.statusCode ?? response.statusCode;
  const numericStatus = (value: unknown): number | null => typeof value === "number" && Number.isSafeInteger(value)
    ? value : typeof value === "string" && /^\d{3}$/.test(value) ? Number(value) : null;
  const status = numericStatus(statusRaw);
  const redundantStatuses = [raw.status, response.status, raw.statusCode, response.statusCode]
    .filter((value) => value != null);
  if (redundantStatuses.some((value) => numericStatus(value) === null || numericStatus(value) !== status)) {
    problems.push("MULTISTEP_REQUEST_SCHEMA_INVALID");
  }
  const sameField = (values: unknown[]): boolean => values.length <= 1
    || values.every((value) => JSON.stringify(unwrapDataField(value)) === JSON.stringify(unwrapDataField(values[0])));
  if (!sameField([raw.requestBody, nestedRequest?.body, nestedRequest?.data].filter((value) => value != null))
    || !sameField([raw.responseBody, nestedResponse?.body, nestedResponse?.data, raw.body].filter((value) => value != null))
    || !sameField([raw.expected, raw.expectedData].filter((value) => value != null))
    || !sameField([raw.actual, raw.actualData].filter((value) => value != null))) {
    problems.push("MULTISTEP_REQUEST_SCHEMA_INVALID");
  }
  const headers = asRecord(raw.requestHeaders ?? raw.headers ?? request.headers) ?? raw.requestHeaders ?? raw.headers ?? request.headers;
  const responseHeaders = asRecord(raw.responseHeaders ?? response.headers) ?? raw.responseHeaders ?? response.headers;
  const sameHeaders = (values: unknown[]): boolean => {
    if (values.length <= 1) return true;
    const normalized = values.map((value) => JSON.stringify(Object.entries(headerRecord(value, problems))
      .sort(([a], [b]) => a.localeCompare(b))));
    return normalized.every((value) => value === normalized[0]);
  };
  if (!sameHeaders([raw.requestHeaders, raw.headers, nestedRequest?.headers].filter((value) => value != null))
    || !sameHeaders([raw.responseHeaders, nestedResponse?.headers].filter((value) => value != null))) {
    problems.push("MULTISTEP_REQUEST_SCHEMA_INVALID");
  }
  return {
    title: asString(raw.requestTitle ?? raw.title ?? child.title),
    method,
    url,
    path: asString(raw.path) ?? pathOf(url),
    queryKeys: Array.isArray(raw.queryKeys) ? raw.queryKeys.map(asString).filter((v): v is string => v !== null) : queryKeysOf(url),
    requestHeaders: headerRecord(headers, problems),
    requestBody: "requestBody" in raw
      ? unwrapDataField(raw.requestBody)
      : nestedRequest
        ? (nestedRequest.body ?? nestedRequest.data ?? null)
        : null,
    status,
    statusText: asString(raw.statusText ?? response.statusText),
    responseHeaders: headerRecord(responseHeaders, problems),
    responseBody: unwrapDataField(raw.responseBody ?? response.body ?? response.data ?? raw.body ?? null),
    expected: "expected" in raw ? raw.expected : raw.expectedData ?? null,
    actual: "actual" in raw ? raw.actual : raw.actualData ?? null,
    timings: raw.timings ?? null,
    fetchUid: asString(raw.fetchUid ?? raw.fetchUID),
  };
}

/** Assertion evidence carried by checklyData (expected/actual), separate from request fields. */
function checklyAssertionEvidence(child: JsonStep, failed: boolean, problems: string[]): MultiStepAssertionEvidence | null {
  const records = checklyRecords(child);
  const assertions = records.filter((r) => "expected" in r || "expectedData" in r || "actual" in r || "actualData" in r);
  const raw = assertions[0] ?? null;
  if (!raw) return null;
  if (assertions.length !== 1
    || ("expected" in raw && "expectedData" in raw && JSON.stringify(raw.expected) !== JSON.stringify(raw.expectedData))
    || ("actual" in raw && "actualData" in raw && JSON.stringify(raw.actual) !== JSON.stringify(raw.actualData))) {
    problems.push("MULTISTEP_ASSERTION_EVIDENCE_MISSING");
  }
  const hasExpected = "expected" in raw || "expectedData" in raw;
  const hasActual = "actual" in raw || "actualData" in raw;
  if (!hasExpected && !hasActual) return null;
  if (!Array.isArray(child.checklyData)) problems.push("assertion checklyData is not a genuine nested Playwright array");
  return {
    title: asString(raw.requestTitle ?? raw.title ?? child.title),
    expected: hasExpected ? ("expected" in raw ? raw.expected : raw.expectedData) : null,
    actual: hasActual ? ("actual" in raw ? raw.actual : raw.actualData) : null,
    passed: failed ? false : null,
  };
}

function queryKeysOf(url: string | null): string[] {
  if (!url) return [];
  try {
    return [...new URL(url, "https://checkly.invalid").searchParams.keys()];
  } catch {
    const m = /\?([^#]+)/.exec(url);
    if (!m) return [];
    return [...new Set(m[1].split("&").map((pair) => decodeURIComponent(pair.split("=")[0] ?? "")).filter(Boolean))];
  }
}

function pathOf(url: string | null): string | null {
  if (!url) return null;
  try {
    return new URL(url, "https://checkly.invalid").pathname;
  } catch {
    const m = /^([/?#]\S*)/.exec(url);
    return m ? m[1] : null;
  }
}



function stepError(step: JsonStep): string | null {
  const direct = asString(step.error);
  if (direct) return direct;
  const errorRecord = asRecord(step.error);
  const nestedMessage = asString(errorRecord?.message);
  if (nestedMessage) return nestedMessage;
  if (Array.isArray(step.errors) && step.errors.length > 0) {
    const first = asRecord(step.errors[0]);
    const message = asString(first?.message) ?? asString(step.errors[0]);
    if (message) return message;
  }
  return null;
}

/** Resolve a *canonical spec basename* and line from the structured error
 * location or stack, never from a generic failed-step prefix. The runtime
 * source parser must independently prove that exact line and assertion. */
function canonicalFailureLine(step: JsonStep, depth = 0): number | null {
  if (depth > 12) return null;
  // A nested expect error is more specific than its enclosing test.step's
  // callback line. Do not attribute the parent location to the assertion.
  for (const child of Array.isArray(step.steps) ? step.steps as JsonStep[] : []) {
    const line = canonicalFailureLine(child, depth + 1);
    if (line !== null) return line;
  }
  const error = asRecord(step.error);
  const location = asRecord(error?.location);
  const source = asString(location?.file);
  const line = location?.line;
  if (source && /(?:^|[/\\])multistep-booking\.spec\.ts$/.test(source)
    && typeof line === "number" && Number.isSafeInteger(line) && line > 0 && line <= 100_000) return line;
  const diagnostic = `${asString(error?.stack) ?? ""}\n${stepError(step) ?? ""}`;
  const match = /(?:^|[(/\\\s])multistep-booking\.spec\.ts:(\d{1,6}):\d{1,6}/.exec(diagnostic);
  return match && Number(match[1]) > 0 && Number(match[1]) <= 100_000 ? Number(match[1]) : null;
}

interface ChildAggregation {
  requests: MultiStepRequestEvidence[];
  assertions: MultiStepAssertionEvidence[];
  error: string | null;
}

/** First error at any depth below (and including) this step. */
function firstErrorDeep(step: JsonStep, depth: number): string | null {
  const own = stepError(step);
  if (own) return own;
  if (depth > 12) return null;
  const children = Array.isArray(step.steps) ? (step.steps as JsonStep[]) : [];
  for (const child of children) {
    const nested = firstErrorDeep(child, depth + 1);
    if (nested) return nested;
  }
  return null;
}

/** Gather request/assertion evidence from every DESCENDANT of a step. */
function aggregateChildren(step: JsonStep, problems: string[], depth: number): ChildAggregation {
  const out: ChildAggregation = { requests: [], assertions: [], error: null };
  if (depth > 12) {
    problems.push("step nesting exceeds supported depth (truncated or corrupt evidence)");
    return out;
  }
  const children = Array.isArray(step.steps) ? (step.steps as JsonStep[]) : [];
  for (const child of children) {
    const childError = firstErrorDeep(child, depth + 1);
    const request = requestEvidence(child, problems);
    const assertion = checklyAssertionEvidence(child, childError !== null, problems);
    if (request) out.requests.push(request);
    if (assertion) out.assertions.push(assertion);
    if (!out.error && childError) out.error = childError;
    const nested = aggregateChildren(child, problems, depth + 1);
    out.requests.push(...nested.requests);
    out.assertions.push(...nested.assertions);
    if (!out.error && nested.error) out.error = nested.error;
  }
  return out;
}

/**
 * One entry per top-level ordered step: descendant (api/expect) evidence
 * aggregates onto its parent so the canonical transaction never duplicates a
 * request, and errors propagate upward.
 */
function collectStep(step: JsonStep, titleFallback: string, problems: string[], depth: number, resultStatus: string | null): MultiStepStepEvidence[] {
  if (depth > 12) {
    problems.push("step nesting exceeds supported depth (truncated or corrupt evidence)");
    return [];
  }
  const title = asString(step.title) ?? titleFallback;
  const ownError = stepError(step);
  const directEvidence = requestEvidence(step, problems);
  const ownAssertion = checklyAssertionEvidence(step, false, problems);
  const aggregated = aggregateChildren(step, problems, depth + 1);
  const error = ownError ?? aggregated.error;
  // Raw Playwright JSON steps carry only title/duration/error (no `status`,
  // and no checklyData — pw:api children are filtered out by the reporter).
  // The result-level status is therefore part of the evidence: a serialized
  // test.step with NO error inside a completed result (passed/failed/
  // timedout) ran to completion. The failing step is identified by its own
  // error; steps after the failure never appear in the report at all.
  const completedResult = resultStatus === "passed" || resultStatus === "failed" || resultStatus === "timedout";
  const status: MultiStepStepEvidence["status"] =
    error ? "failed"
      : step.status === "skipped" ? "skipped"
        : step.status === "failed" || step.status === "timedout" ? "failed"
          : step.status === "passed" ? "passed"
            : directEvidence || aggregated.requests.length > 0 || Array.isArray(step.steps) ? "passed"
              : completedResult ? "passed"
                : "unknown";
  // The step's own evidence first, then aggregated descendants'.
  const assertions = ownAssertion
    ? [{ ...ownAssertion, passed: status === "failed" ? false : ownAssertion.passed }, ...aggregated.assertions]
    : aggregated.assertions;
  const requests = directEvidence ? [directEvidence, ...aggregated.requests] : aggregated.requests;
  const failureLine = error ? canonicalFailureLine(step) : null;
  return [{ title, status, error, failureLine, requests, assertions }];
}

function findResultSteps(report: JsonReport, problems: string[]): {
  entries: Array<{ step: JsonStep; resultStatus: string | null }>;
  sawSpecs: boolean; statuses: string[]; resultErrors: unknown[]; resultCount: number; resultErrorInvalid: boolean;
} {
  const suites = Array.isArray(report.suites) ? report.suites : null;
  if (!suites) return { entries: [], sawSpecs: false, statuses: [], resultErrors: [], resultCount: 0, resultErrorInvalid: false };
  const entries: Array<{ step: JsonStep; resultStatus: string | null }> = [];
  const statuses: string[] = [];
  const resultErrors: unknown[] = [];
  let resultCount = 0;
  let resultErrorInvalid = false;
  let sawSpecs = false;
  const walkSuite = (suite: unknown, depth: number): void => {
    if (depth > 12 || entries.length > 500) return;
    const record = asRecord(suite);
    if (!record) return;
    const specs = Array.isArray(record.specs) ? record.specs : [];
    for (const spec of specs) {
      sawSpecs = true;
      const specRecord = asRecord(spec);
      const tests = Array.isArray(specRecord?.tests) ? specRecord.tests : [];
      for (const test of tests) {
        const testRecord = asRecord(test);
        const results = Array.isArray(testRecord?.results) ? testRecord.results : [];
        resultCount += results.length;
        if (results.length !== 1) problems.push("MULTISTEP_RESULT_STATS_INVALID");
        const resultRecord = asRecord(results[0]);
        const resultStatus = asString(resultRecord?.status);
        const errors = resultRecord?.errors;
        if (errors !== undefined) {
          if (!Array.isArray(errors) || errors.length > 1 || (errors.length > 0 && resultStatus !== "failed")) {
            resultErrorInvalid = true;
            problems.push("MULTISTEP_RESULT_STATS_INVALID");
          } else resultErrors.push(...errors);
        }
        // the result-level status is evidence even when it carries no steps
        if (resultStatus !== null) statuses.push(resultStatus);
        if (Array.isArray(resultRecord?.steps)) {
          for (const step of resultRecord.steps as JsonStep[]) entries.push({ step, resultStatus });
        }
      }
    }
    const nested = Array.isArray(record.suites) ? record.suites : [];
    for (const child of nested) walkSuite(child, depth + 1);
  };
  for (const suite of suites) walkSuite(suite, 0);
  return { entries, sawSpecs, statuses, resultErrors, resultCount, resultErrorInvalid };
}

function parseLogs(text: string, problems: string[]): Array<{ level: string; msg: string; time: number | null }> | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    problems.push("logs.txt is not valid JSON (corrupt or truncated asset)");
    return null;
  }
  if (!Array.isArray(parsed)) {
    problems.push("logs.txt is not a JSON array (corrupt asset)");
    return null;
  }
  const out: Array<{ level: string; msg: string; time: number | null }> = [];
  for (const entry of parsed) {
    const record = asRecord(entry);
    const level = asString(record?.level);
    const msg = asString(record?.msg);
    if (level === null || msg === null) {
      problems.push("logs.txt contains a malformed entry (corrupt asset)");
      return null;
    }
    out.push({ level, msg, time: typeof record?.time === "number" && Number.isFinite(record.time) ? record.time : null });
  }
  return out;
}

function parseCheckRunData(text: string, problems: string[]): MultiStepCheckRunData | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    problems.push("check-run-data.json is not valid JSON (corrupt or truncated asset)");
    return null;
  }
  const record = asRecord(parsed);
  if (!record) {
    problems.push("check-run-data.json is not a JSON object (corrupt asset)");
    return null;
  }
  // All fields are optional evidence: a failing capture may carry only
  // script + scriptPath. Absence is never a problem.
  return {
    dependencies: record.dependencies ?? null,
    imports: record.imports ?? null,
    playwrightConfig: record.playwrightConfig ?? null,
    script: asString(record.script),
    scriptPath: asString(record.scriptPath),
  };
}

export interface NormalizeMultiStepInput {
  /** raw text of test-results.json (required) */
  testResults: string | null | undefined;
  /** raw text of check-run-data.json (optional) */
  checkRunData?: string | null;
  /** raw text of logs.txt (optional) */
  logs?: string | null;
  /** result-level attempt count from the Checkly result (recurrence only) */
  attempts?: number | null;
  /** Local Playwright JSON filters pw:api children; a separately audited
   * bridge/reporter must then corroborate the request sequence. Never set
   * this for downloaded Checkly assets. */
  reporterOnly?: boolean;
}

export function normalizeMultiStepCapture(input: NormalizeMultiStepInput): MultiStepCapture {
  const problems: string[] = [];
  const recurrence = { attempts: typeof input.attempts === "number" && Number.isFinite(input.attempts) ? input.attempts : null };

  if (input.testResults === null || input.testResults === undefined || input.testResults === "") {
    problems.push("test-results.json asset is missing — execution evidence is unavailable (UNCERTAIN)");
  }
  let report: JsonReport | null = null;
  if (input.testResults !== null && input.testResults !== undefined && input.testResults !== "") {
    try {
      const parsed = JSON.parse(input.testResults);
      report = asRecord(parsed) as JsonReport | null;
      if (!report) problems.push("test-results.json is not a JSON object (corrupt or truncated asset)");
    } catch {
      problems.push("test-results.json is not valid JSON (corrupt or truncated asset)");
    }
  }

  let steps: MultiStepStepEvidence[] = [];
  let resultStatuses: string[] = [];
  let reporterResults = 0;
  let reporterErrors: 0 | 1 = 0;
  let stats: MultiStepCapture["stats"] = null;
  if (report) {
    const rawStats = asRecord(report.stats);
    if (rawStats) {
      if (!["expected", "unexpected", "flaky", "skipped"].every((key) =>
        typeof rawStats[key] === "number" && Number.isSafeInteger(rawStats[key]) && (rawStats[key] as number) >= 0)
        || rawStats.skipped !== 0) problems.push("MULTISTEP_RESULT_STATS_INVALID");
      stats = {
        expected: typeof rawStats.expected === "number" ? rawStats.expected : 0,
        unexpected: typeof rawStats.unexpected === "number" ? rawStats.unexpected : 0,
        flaky: typeof rawStats.flaky === "number" ? rawStats.flaky : 0,
      };
    } else {
      problems.push("test-results.json has no stats block (truncated evidence)");
    }
    const found = findResultSteps(report, problems);
    resultStatuses = found.statuses;
    reporterResults = found.resultCount;
    if (found.resultErrorInvalid) reporterErrors = 1;
    if (report.errors !== undefined && (!Array.isArray(report.errors) || report.errors.length !== 0)) {
      reporterErrors = 1;
      problems.push("MULTISTEP_RESULT_STATS_INVALID");
    }
    if (!Array.isArray(report.suites) || !found.sawSpecs || found.statuses.length !== 1) {
      problems.push("test-results.json lacks a single genuine nested Playwright suites/specs/tests/results array");
    }
    const flattened: Array<{ step: JsonStep; resultStatus: string | null }> = [];
    for (const entry of found.entries) {
      const record = asRecord(entry.step);
      if (!record) continue;
      // Top-level entries under the test result are the ordered test.step()
      // calls (nested checklyData lives on their children).
      flattened.push(entry);
    }
    steps = [];
    for (let i = 0; i < flattened.length; i++) {
      if ((!input.reporterOnly && (flattened[i]!.step.category !== "test.step" || !Array.isArray(flattened[i]!.step.steps)))
        || (flattened[i]!.step.steps !== undefined && !Array.isArray(flattened[i]!.step.steps))) {
        problems.push("test-results.json top-level step is not a genuine Playwright test.step with nested children");
      }
      steps.push(...collectStep(flattened[i]!.step, `step ${i + 1}`, problems, 0, flattened[i]!.resultStatus));
    }
    // ---- stats/status/steps consistency: internally contradictory evidence is corrupt ----
    const statuses = found.statuses;
    const anyFailedResult = statuses.some((s) => s === "failed" || s === "timedout");
    const anyPassedResult = statuses.includes("passed");
    const failedSteps = steps.filter((s) => s.status === "failed");
    // Playwright may repeat the SAME failed assertion under result.errors.
    // A second/different error cannot be hidden behind four successful HTTP
    // responses or silently treated as the stale assertion's explanation.
    for (const error of found.resultErrors) {
      const echo: JsonStep = { title: "book 09:30", error };
      if (failedSteps.length !== 1 || steps[3]?.status !== "failed"
        || canonicalFailureLine(echo) !== steps[3].failureLine
        || !/expect\s*\(/i.test(stepError(echo) ?? "")) {
        reporterErrors = 1;
        problems.push("MULTISTEP_RESULT_STATS_INVALID");
      }
    }
    if (stats) {
      if (anyFailedResult && stats.unexpected === 0) {
        problems.push("inconsistent capture: result status is failed but stats.unexpected is 0 (corrupt or internally inconsistent evidence)");
      }
      if (stats.unexpected > 0 && !anyFailedResult && failedSteps.length === 0) {
        problems.push("inconsistent capture: stats.unexpected > 0 but no failed result status and no failed step (corrupt or internally inconsistent evidence)");
      }
      if (failedSteps.length > 0 && anyPassedResult && !anyFailedResult) {
        problems.push("inconsistent capture: failed step(s) recorded inside an all-passed result (corrupt or internally inconsistent evidence)");
      }
    }
    if (steps.length === 0) problems.push("test-results.json contains no ordered step evidence (missing execution evidence)");
  }

  const logs = input.logs === null || input.logs === undefined || input.logs === "" ? null : parseLogs(input.logs, problems);
  const checkRunData = input.checkRunData === null || input.checkRunData === undefined || input.checkRunData === ""
    ? null
    : parseCheckRunData(input.checkRunData, problems);

  const failed = steps.some((s) => s.status === "failed");
  // Retain the contradiction independently of `problems` so a later caller
  // cannot promote a picked outer field by clearing a diagnostic list.
  if (problems.includes("MULTISTEP_REQUEST_SCHEMA_INVALID") || problems.includes("MULTISTEP_ASSERTION_EVIDENCE_MISSING")) reporterErrors = 1;
  const kind: MultiStepCapture["kind"] = failed || (stats !== null && stats.unexpected > 0) ? "failing" : "passing";
  const reporterStatus = reporterResults === 1 && resultStatuses.length === 1 && ["passed", "failed"].includes(resultStatuses[0]!)
    ? resultStatuses[0] as "passed" | "failed" : null;
  if (steps.length > 0) problems.push(...multiStepShapeProblems({ kind, stats, reporterStatus, reporterErrors, steps }, input.reporterOnly === true));
  if (resultStatuses.length === 1 && resultStatuses[0] !== (kind === "failing" ? "failed" : "passed")) {
    problems.push("MULTISTEP_RESULT_STATS_INVALID");
  }
  if (stats && (stats.expected + stats.unexpected !== 1 || stats.flaky !== 0)) {
    problems.push("MULTISTEP_RESULT_STATS_INVALID");
  }
  return { kind, stats, reporterStatus, reporterErrors, steps, checkRunData, logs, recurrence, problems: [...new Set(problems)] };
}

/**
 * Evidence → observation, the only mapping the decision law sees.
 * Problems (missing/corrupt/truncated assets, no step evidence) → UNCERTAIN.
 * Recurrence (attempts) is recorded but NEVER changes the observation.
 */
export function observeMultiStepCapture(capture: MultiStepCapture): { observed: ObservationValue; reason?: string } {
  if (capture.problems.length > 0) {
    return { observed: "uncertain", reason: `multistep evidence unresolved: ${capture.problems.join("; ")}` };
  }
  if (capture.stats === null) {
    return { observed: "uncertain", reason: "multistep evidence has no stats block (missing execution evidence)" };
  }
  if (capture.stats.unexpected > 0 || capture.steps.some((s) => s.status === "failed")) {
    return { observed: "fail" };
  }
  if (capture.steps.length === 0) {
    return { observed: "uncertain", reason: "no ordered step evidence in the capture (setup failure or missing execution evidence)" };
  }
  if (capture.stats.expected < 1) {
    return { observed: "uncertain", reason: "capture reports zero expected tests (missing execution evidence)" };
  }
  return { observed: "pass" };
}
