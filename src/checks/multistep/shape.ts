// One admission rule for downloaded evidence, values-free recordings, and
// local reporter evidence. A failure prefix, HTTP error or different assertion
// is an unknown execution, not a negative observation.
//
// Route order, step titles, the selected slot and the detection mutation all
// come from the validated bundle scenario. Application field names remain the
// check's own contract; no route or literal slot value is assumed here.
import type { MultistepEvidenceScenario, MultistepScenario, MultistepWitness, MultistepWitnessShape } from "../../types.ts";
import type { MultiStepCapture } from "./normalize.ts";
import { routeAt } from "./routes.ts";

function object(value: unknown): Record<string, unknown> | null {
  if (typeof value === "string" && value.length <= 1024 * 1024) {
    try { return object(JSON.parse(value)); } catch { return null; }
  }
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
function identity(value: unknown): boolean { return typeof value === "string" && value.length > 0; }

function valueAt(value: unknown, path: readonly string[]): unknown {
  let current: unknown = value;
  for (const key of path) {
    const record = object(current);
    if (!record || !Object.hasOwn(record, key)) return undefined;
    current = record[key];
  }
  return current;
}

function parentAt(value: unknown, path: readonly string[]): Record<string, unknown> | null {
  return path.length ? object(valueAt(value, path.slice(0, -1))) : object(value);
}

function witnessShapeHolds(shape: MultistepWitnessShape | null, value: unknown): boolean {
  if (!shape) return Array.isArray(value) && value.length === 0;
  if (shape.kind === "null") return value === null;
  if (shape.kind === "string") return typeof value === "string";
  if (shape.kind === "number") return typeof value === "number";
  if (shape.kind === "boolean") return typeof value === "boolean";
  if (Array.isArray(value)) {
    return shape.kind === "array" && value.every((item) => witnessShapeHolds(shape.item, item));
  }
  if (!value || typeof value !== "object" || shape.kind !== "object") return false;
  const raw = value as Record<string, unknown>;
  const keys = Object.keys(raw);
  const expected = Object.keys(shape.fields);
  return keys.length === expected.length && expected.every((key) => key in raw
    && witnessShapeHolds(shape.fields[key]!, raw[key]));
}

function witnessValue(steps: MultiStepCapture["steps"], ref: MultistepWitness["equalities"][number]["left"]): { ok: boolean; value?: unknown } {
  const request = steps[ref.route]?.requests[0];
  let current: unknown = ref.where === "request" ? request?.requestBody : request?.responseBody;
  for (const key of ref.path) {
    if (!current || typeof current !== "object" || Array.isArray(current) || !(key in current)) return { ok: false };
    current = (current as Record<string, unknown>)[key];
  }
  return { ok: true, value: current };
}

/** Re-check the values-free witness against a captured transaction. Shape and
 * scalar equalities only: no recorded value or secret is compared. */
export function multistepWitnessProblems(scenario: MultistepEvidenceScenario, capture: Pick<MultiStepCapture, "steps">): string[] {
  const witness = (scenario as MultistepScenario).witness;
  if (!witness || witness.responses.length !== capture.steps.length) return [];
  const problems: string[] = [];
  for (let i = 0; i < witness.responses.length; i++) {
    if (!witnessShapeHolds(witness.responses[i]!, capture.steps[i]?.requests[0]?.responseBody)) {
      problems.push("MULTISTEP_REQUEST_BODY_INVALID");
      break;
    }
  }
  for (const pair of witness.equalities) {
    const left = witnessValue(capture.steps, pair.left);
    const right = witnessValue(capture.steps, pair.right);
    if (!left.ok || !right.ok || left.value !== right.value) {
      problems.push("MULTISTEP_TRANSACTION_RELATIONSHIP_INVALID");
      break;
    }
  }
  return problems;
}

function mutationOf(scenario: MultistepEvidenceScenario): MultistepScenario["mutation"] | null {
  return (scenario as MultistepScenario).mutation ?? null;
}

function routeIndex(scenario: MultistepEvidenceScenario): number {
  const mutation = mutationOf(scenario);
  return mutation ? scenario.routes.findIndex((route) => route.method === mutation.method && route.path === mutation.path) : -1;
}

/** A fact from an ALREADY validated remote failing-side recording, never
 * inferred from a passing run or from a local reporter. The scenario's
 * mutation path and expected value must actually be present in the recorded
 * HTTP-200 response. */
export function recordedNestedBookingConfirmed(scenario: MultistepEvidenceScenario, steps: MultiStepCapture["steps"]): boolean {
  const mutation = mutationOf(scenario);
  if (!mutation) return false;
  const index = routeIndex(scenario);
  const request = index < 0 ? undefined : steps[index]?.requests[0];
  const parent = parentAt(request?.responseBody, mutation.jsonPath);
  return steps.length === scenario.routes.length && request?.method === mutation.method
    && request.path === mutation.path && request.status === 200
    && parent !== null && parent !== undefined
    && parent[mutation.jsonPath.at(-1)!] === mutation.expected;
}

/** The *local* detection shape, used only after trusted remote provenance and
 * a proxy-confirmed mutation. Remote admission still calls the unmodified
 * multiStepShapeProblems: its failing response MUST still carry the expected
 * value. No other request/field/status is relaxed. */
export function multiStepDetectionShapeProblems(scenario: MultistepScenario, capture: Pick<MultiStepCapture, "kind" | "stats" | "reporterStatus" | "reporterErrors" | "steps">): string[] {
  if (capture.kind !== "failing" || capture.steps.length !== scenario.routes.length) return ["MULTISTEP_STEP_SEQUENCE_INVALID"];
  const index = routeIndex(scenario);
  const book = index < 0 ? undefined : capture.steps[index];
  const request = book?.requests[0];
  if (!book || !request) return ["MULTISTEP_REQUEST_BODY_INVALID"];
  const parent = parentAt(request.responseBody, scenario.mutation.jsonPath);
  const leaf = scenario.mutation.jsonPath.at(-1)!;
  if (!parent || parent[leaf] !== scenario.mutation.replace) return ["MULTISTEP_REQUEST_BODY_INVALID"];
  // Reuse ALL original request, assertion, and step checks on a temporary
  // in-memory view. Only the one proven mutated scalar is restored for the
  // original strict validator; neither this view nor a draft is stored.
  const restoredParent = { ...parent, [leaf]: scenario.mutation.expected };
  const rebuilt = setAt(request.responseBody, scenario.mutation.jsonPath, restoredParent);
  const originalShape = { ...capture, steps: [...capture.steps.slice(0, index), {
    ...book, requests: [{ ...request, responseBody: rebuilt }, ...book.requests.slice(1)],
  }, ...capture.steps.slice(index + 1)] };
  return [...multiStepShapeProblems(scenario, originalShape), ...multistepWitnessProblems(scenario, originalShape)];
}

function setAt(value: unknown, path: readonly string[], replacementParent: Record<string, unknown>): unknown {
  if (path.length === 0) return replacementParent;
  const root = object(value);
  if (!root) return value;
  const clone: Record<string, unknown> = { ...root };
  const [head, ...rest] = path;
  clone[head!] = rest.length === 0 ? replacementParent[path.at(-1)!] : setAt(root[head!], rest, replacementParent);
  return clone;
}

/** Fixed, values-free categories; never echo response bodies or reporter text. */
export function multiStepShapeProblems(scenario: MultistepEvidenceScenario, capture: Pick<MultiStepCapture, "kind" | "stats" | "reporterStatus" | "reporterErrors" | "steps">,
  reporterOnly = false): string[] {
  const problems: string[] = [];
  const failing = capture.kind === "failing";
  const steps = capture.steps;
  // A reporter-only capture legitimately has no request records; in that
  // case the observed step count is the bound, never a fixed scenario length.
  const requestSteps = scenario.routes.length || (failing ? steps.length : 0);
  // A failing recording proves the scenario prefix up to the mutation
  // assertion. A passing run may also execute declared steps that issue no
  // request after that prefix (the confirmation step); every such extra step
  // must be a plain passed step.
  const required = failing ? scenario.stepTitles.slice(0, requestSteps) : scenario.stepTitles;
  const size = failing ? requestSteps : Math.max(required.length, steps.length);
  const titleMismatch = required.some((title, i) => steps[i]?.title !== title)
    || steps.slice(required.length).some((s, i) => failing && required.length + i < requestSteps);
  const sizeMismatch = failing ? steps.length !== requestSteps : steps.length < required.length;
  if (titleMismatch || sizeMismatch || capture.reporterStatus !== (failing ? "failed" : "passed") || capture.reporterErrors !== 0 || !capture.stats
    || capture.stats.flaky !== 0 || capture.stats.expected !== (failing ? 0 : 1)
    || capture.stats.unexpected !== (failing ? 1 : 0)
    || steps.some((s, i) => s.status !== (failing && i === requestSteps - 1 ? "failed" : "passed")
      || !(failing && i === requestSteps - 1) && s.error !== null)) {
    problems.push("MULTISTEP_STEP_SEQUENCE_INVALID");
  }
  if (sizeMismatch || titleMismatch) return problems;
  if (failing) {
    const book = steps[requestSteps - 1]!;
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
    if (step.requests.length !== (i < requestSteps ? 1 : 0)) {
      problems.push("MULTISTEP_REQUEST_SEQUENCE_INVALID");
      continue;
    }
    if (i >= requestSteps) {
      if (!step.assertions.some((a) => a.expected === "CONFIRMED" && a.actual === "CONFIRMED" && a.passed !== false)) {
        problems.push("MULTISTEP_ASSERTION_EVIDENCE_MISSING");
      }
      continue;
    }
    const req = step.requests[0]!;
    const route = routeAt(scenario, i)!;
    let validUrl = false;
    try {
      const url = new URL(req.url ?? "");
      validUrl = url.protocol === "https:" && !url.username && !url.password && !url.search && !url.hash
        && url.pathname === route.path;
    } catch { /* not canonical */ }
    if (req.method !== route.method || req.path !== route.path || !validUrl || req.queryKeys.length !== 0
      || req.status !== 200) problems.push("MULTISTEP_REQUEST_SCHEMA_INVALID");
    const body = object(req.responseBody);
    const input = req.requestBody === null || req.requestBody === undefined ? null : object(req.requestBody);
    // Structural admission only. Application field names and cross-request
    // relationships are the check's own contract, proven by the bound source
    // and the scenario mutation, not by a hardcoded response schema here.
    if (!body || (req.requestBody !== null && req.requestBody !== undefined && !input)
      || (input === null && ["POST", "PUT", "PATCH"].includes(req.method ?? ""))) {
      problems.push("MULTISTEP_REQUEST_BODY_INVALID");
    }
    const mutation = mutationOf(scenario);
    if (i === requestSteps - 1 && mutation) {
      const parent = parentAt(req.responseBody, mutation.jsonPath);
      if (!parent || parent[mutation.jsonPath.at(-1)!] !== mutation.expected) {
        problems.push(failing ? "MULTISTEP_FAILURE_STEP_UNBOUND" : "MULTISTEP_REQUEST_BODY_INVALID");
      }
    }
    // The request record repeats the assertion only in some reporter formats
    // (the real Checkly 9.5.0 runner puts the assertion on the expect step's
    // checklyData instead, and fetch-record copies vary in serialization:
    // received `undefined` serializes away, nulls and duplicated
    // expectedData/actualData pairs appear). A copy is admissible when it
    // carries no assertable primitive or agrees with the stale assertion; it
    // is rejected only when it CONTRADICTS it. The binding proof itself stays
    // with the step-level assertion evidence checked above — this law never
    // admits or denies a binding on its own.
    if (i === requestSteps - 1 && failing
      && ((typeof req.expected === "boolean" || typeof req.expected === "number" || typeof req.expected === "string")
        && req.expected !== true
        || req.actual === true)) {
      problems.push("MULTISTEP_FAILURE_STEP_UNBOUND");
    }
    if (i === requestSteps - 1 && !failing && !step.assertions.some((a) => a.expected === true
      && a.actual === true && a.passed !== false)) {
      problems.push("MULTISTEP_ASSERTION_EVIDENCE_MISSING");
    }
    if (route.auth === true && !identity(req.requestHeaders.authorization)) {
      problems.push("MULTISTEP_TOKEN_RELATIONSHIP_INVALID");
    }
    if (!step.assertions.some((a) => a.expected !== null && a.expected !== undefined)) {
      problems.push("MULTISTEP_ASSERTION_EVIDENCE_MISSING");
    }
  }
  return [...new Set(problems)];
}
