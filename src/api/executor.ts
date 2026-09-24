import { createHash } from "node:crypto";
import { parseApiCheckProject, type ApiAssertionModel } from "./model.ts";
import { runSetupScript, sameRequestIdentity, type SetupRequest } from "./setup-sandbox.ts";
import { emptyExecutionCost, type ApiRecording, type Bundle, type ExecutionCost, type ObservationValue, type RunContext, type Scene, type SceneObservation, type TraceStep } from "../types.ts";

export interface ApiExecutorOptions {
  target?: string | null;
  env?: Record<string, string>;
  maxRunsPerScene?: number;
  verbose?: boolean;
}

interface ResponseEvidence {
  status: number;
  headers: Record<string, string>;
  bodyText: string | null;
  json: unknown | null;
  readable: boolean;
  truncated: boolean;
}

function normalizedFiles(bundle: Bundle, patchSource: string, ctx?: RunContext): Map<string, string> {
  const files = new Map<string, string>();
  for (const [file, source] of Object.entries(ctx?.files ?? bundle.files)) files.set(file.replace(/\\/g, "/"), source);
  files.set((ctx?.checkFile ?? bundle.check.file).replace(/\\/g, "/"), patchSource);
  return files;
}

function headers(value: Headers): Record<string, string> {
  const output: Record<string, string> = {};
  value.forEach((item, name) => { output[name.toLowerCase()] = item; });
  return output;
}

function jsonPath(value: unknown, selector: string): { found: boolean; value: unknown } {
  let current = value;
  for (const part of selector.split(".").filter(Boolean)) {
    if (!current || typeof current !== "object" || Array.isArray(current) || !Object.prototype.hasOwnProperty.call(current, part)) return { found: false, value: undefined };
    current = (current as Record<string, unknown>)[part];
  }
  return { found: true, value: current };
}

function evaluate(assertion: ApiAssertionModel, response: ResponseEvidence): { pass: boolean; uncertain: string | null; actual: unknown } {
  if (assertion.operator !== "equals") return { pass: false, uncertain: `unsupported AssertionBuilder operator ${assertion.operator}`, actual: null };
  let actual: unknown;
  if (assertion.property === "statusCode") actual = response.status;
  else if (assertion.property === "headers") {
    if (!assertion.selector) return { pass: false, uncertain: "header assertion has no static header name", actual: null };
    actual = response.headers[assertion.selector.toLowerCase()];
  } else if (assertion.property === "jsonBody") {
    if (!response.readable || response.truncated || response.json === null) return { pass: false, uncertain: "JSON response evidence is unreadable, truncated, or absent", actual: null };
    if (!assertion.selector) actual = response.json;
    else {
      const selected = jsonPath(response.json, assertion.selector);
      actual = selected.found ? selected.value : undefined;
    }
  } else return { pass: false, uncertain: `unsupported AssertionBuilder property ${assertion.property}`, actual: null };
  return { pass: Object.is(actual, assertion.target), uncertain: null, actual };
}

function traceValue(value: unknown): string {
  if (value === undefined) return "missing";
  const text = JSON.stringify(value);
  return text.length > 120 ? `${text.slice(0, 117)}...` : text;
}

function recordingFor(bundle: Bundle, scene: Scene): ApiRecording | null {
  if (scene.mode.includes("passing.api.json")) return bundle.api?.passing ?? null;
  if (scene.mode.includes("failing.api.json")) return bundle.api?.failing ?? null;
  return null;
}

function responseFromRecording(recording: ApiRecording): ResponseEvidence | null {
  const response = recording.response;
  if (!response) return null;
  return {
    status: response.status,
    headers: Object.fromEntries(Object.entries(response.headers).map(([name, value]) => [name.toLowerCase(), value])),
    bodyText: response.bodyText,
    json: response.json,
    readable: response.readable,
    truncated: response.truncated,
  };
}

function requestFromModel(url: string, method: string, body: string | null, staticHeaders: Record<string, string>): SetupRequest {
  const parsed = new URL(url);
  return {
    url,
    method,
    headers: { ...staticHeaders },
    body,
    queryParameters: Object.fromEntries(parsed.searchParams.entries()),
  };
}

function targetUrl(template: string, target: string): string | null {
  if (!template.startsWith("{{ENVIRONMENT_URL}}")) return null;
  try {
    const origin = new URL(target).origin;
    return new URL(`${origin}${template.slice("{{ENVIRONMENT_URL}}".length)}`).toString();
  } catch {
    return null;
  }
}

function requestMatchesRecording(request: SetupRequest, recording: ApiRecording): string | null {
  if (!recording.request) return "the API recording has no sanitized request evidence";
  try {
    const actual = new URL(request.url);
    const recorded = new URL(recording.request.url);
    if (request.method !== recording.request.method) return "recorded request method does not match the candidate request";
    if (`${actual.pathname}${actual.search}` !== `${recorded.pathname}${recorded.search}`) return "recorded route or query does not match the candidate request";
    if ((request.body ?? null) !== (recording.request.body ?? null)) return "recorded request body does not match the candidate request";
    return null;
  } catch {
    return "the candidate or recorded request URL is not readable";
  }
}

export class ApiSceneExecutor {
  readonly kind = "scene" as const;
  readonly nondeterministicScenes: string[] = [];
  budgetExhausted = false;
  private readonly target: string | null;
  private readonly env: Record<string, string>;
  private readonly maxRunsPerScene: number | undefined;
  private readonly verbose: boolean;
  private readonly cost: ExecutionCost = emptyExecutionCost();

  constructor(options: ApiExecutorOptions = {}) {
    this.target = options.target ?? null;
    this.env = { ...(options.env ?? {}) };
    this.maxRunsPerScene = options.maxRunsPerScene;
    this.verbose = options.verbose ?? false;
  }

  isLive(): boolean {
    return true;
  }

  costReport(): ExecutionCost {
    return { ...this.cost, checklySessionIds: [], checklyResultIds: [], byScene: [...this.cost.byScene] };
  }

  async runScene(bundle: Bundle, patchSource: string, scene: Scene, ctx?: RunContext): Promise<SceneObservation> {
    const startedAt = Date.now();
    const files = normalizedFiles(bundle, patchSource, ctx);
    const checkFile = (ctx?.checkFile ?? bundle.check.file).replace(/\\/g, "/");
    const model = parseApiCheckProject(checkFile, files, bundle.check.logicalId);
    const requested = Math.max(1, scene.experiments[0]?.repetitions ?? 1);
    const budget = Math.min(bundle.runBudget.maxPerScene, this.maxRunsPerScene ?? Number.POSITIVE_INFINITY);
    const repetitions = Math.min(requested, budget);
    if (repetitions < requested) this.budgetExhausted = true;
    const trace: TraceStep[] = [];
    const phase = ctx?.phase ?? "candidate";

    const uncertain = (reason: string): SceneObservation => {
      this.recordCost(scene.sceneId, repetitions, Date.now() - startedAt, phase);
      return { sceneId: scene.sceneId, observed: "uncertain", repetitions: 0, trace, source: "scene", reason, environment: scene.mode.startsWith("replay:") ? `recording ${scene.mode.slice(7)}` : "target" };
    };
    if (!model) return uncertain("the candidate ApiCheck could not be resolved from the complete source tree");
    if (model.errors.length) return uncertain(`the candidate ApiCheck is not safely executable: ${model.errors.join("; ")}`);
    if (model.teardownFile) return uncertain("API teardown execution is not yet parity-confirmed; the candidate cannot be judged locally");
    if (!this.target) return uncertain("ENVIRONMENT_URL is missing; pass --target so the handlebars origin can be resolved");
    const resolvedUrl = targetUrl(model.request.url, this.target);
    if (!resolvedUrl) return uncertain("the API request must use {{ENVIRONMENT_URL}} as its origin with no fallback");
    const recording = recordingFor(bundle, scene);
    if (scene.mode.startsWith("replay:") && !recording) return uncertain(`the required API recording ${scene.mode.slice(7)} is missing`);

    const outcomes: ObservationValue[] = [];
    for (let run = 0; run < repetitions; run += 1) {
      const before = requestFromModel(resolvedUrl, model.request.method, model.request.body, model.request.headers);
      let prepared = before;
      if (model.setupFile) {
        const setup = await runSetupScript(model.setupFile, files, structuredClone(before), { ...this.env, ENVIRONMENT_URL: this.target });
        if (!setup.ok || !setup.request) return uncertain(`setup script failed before request execution: ${setup.error ?? "unknown setup error"}`);
        prepared = setup.request;
        if (!sameRequestIdentity(before, prepared)) return uncertain("setup script changed the request route, query, method, or body");
        const authorization = Object.entries(prepared.headers).find(([name]) => name.toLowerCase() === "authorization")?.[1];
        const requestId = Object.entries(prepared.headers).find(([name]) => name.toLowerCase() === "x-request-id")?.[1];
        const expectedAuthorization = this.env.API_TOKEN ? `Bearer ${this.env.API_TOKEN}` : null;
        if (!authorization || !expectedAuthorization || authorization !== expectedAuthorization || !requestId) return uncertain("setup execution did not produce authorization from API_TOKEN and request identity headers");
        trace.push({ index: trace.length, kind: "step", what: `setup ${model.setupFile} executed (${createHash("sha256").update(files.get(model.setupFile) ?? "").digest("hex").slice(0, 12)}; sensitive values omitted)`, outcome: "ok" });
      }

      let response: ResponseEvidence;
      if (recording) {
        const mismatch = requestMatchesRecording(prepared, recording);
        if (mismatch) return uncertain(mismatch);
        if (recording.unsupportedReasons.length) return uncertain(`API recording is incomplete: ${recording.unsupportedReasons.join("; ")}`);
        const recorded = responseFromRecording(recording);
        if (!recorded) return uncertain("the API recording has no response evidence");
        response = recorded;
        trace.push({ index: trace.length, kind: "step", what: `${prepared.method} ${new URL(prepared.url).pathname}${new URL(prepared.url).search} replayed from ${recording.resultId} → ${response.status}`, outcome: "ok" });
      } else {
        try {
          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(), 10_000);
          const result = await fetch(prepared.url, {
            method: prepared.method,
            headers: prepared.headers,
            body: prepared.body ?? undefined,
            redirect: "manual",
            signal: controller.signal,
          }).finally(() => clearTimeout(timer));
          const text = await result.text();
          const responseHeaders = headers(result.headers);
          const declaredLength = Number(responseHeaders["content-length"] ?? text.length);
          const truncated = text.length > 1_000_000 || (Number.isFinite(declaredLength) && declaredLength > text.length);
          let json: unknown | null = null;
          let readable = true;
          try { json = JSON.parse(text); } catch { readable = false; }
          response = { status: result.status, headers: responseHeaders, bodyText: text.slice(0, 1_000_000), json, readable, truncated };
          trace.push({ index: trace.length, kind: "step", what: `${prepared.method} ${new URL(prepared.url).pathname}${new URL(prepared.url).search} → ${result.status}`, outcome: "ok" });
        } catch (error) {
          return uncertain(`API request produced no response evidence: ${(error as Error).message}`);
        }
      }

      this.cost.httpRequests = (this.cost.httpRequests ?? 0) + 1;
      let passed = true;
      for (const assertion of model.request.assertions) {
        const result = evaluate(assertion, response);
        if (result.uncertain) return uncertain(result.uncertain);
        if (!result.pass) passed = false;
        trace.push({
          index: trace.length,
          kind: "assertion",
          assertionId: assertion.assertion.id,
          what: `${assertion.assertion.subject}.${assertion.operator}(${traceValue(assertion.target)}), received ${traceValue(result.actual)}`,
          outcome: result.pass ? "ok" : "failed",
        });
      }
      outcomes.push(passed ? "pass" : "fail");
    }

    const distinct = new Set(outcomes);
    if (distinct.size !== 1) {
      this.nondeterministicScenes.push(scene.sceneId);
      return uncertain(`API scene repetitions disagreed (${outcomes.join(", ")})`);
    }
    const observed = outcomes[0] ?? "uncertain";
    this.recordCost(scene.sceneId, repetitions, Date.now() - startedAt, phase);
    if (this.verbose) console.error(`[verify] api scene ${scene.sceneId}: ${observed} (${repetitions}/${requested})`);
    return {
      sceneId: scene.sceneId,
      observed,
      repetitions,
      trace,
      source: "scene",
      environment: recording ? `recording ${scene.mode.slice(7)} (result ${recording.resultId})` : `target ${new URL(this.target).host} (API)` ,
    };
  }

  private recordCost(sceneId: string, repetitions: number, wallTimeMs: number, phase: "candidate" | "mutation"): void {
    this.cost.scenes += 1;
    this.cost.localRuns += repetitions;
    this.cost.runs += repetitions;
    this.cost.wallTimeMs += wallTimeMs;
    if (phase === "mutation") this.cost.mutationRuns += repetitions;
    this.cost.byScene.push({ sceneId, executor: "scene", repetitions, checkRuns: repetitions, wallTimeMs, phase });
  }
}
