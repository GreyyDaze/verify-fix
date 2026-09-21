// Sandbox check DSL. Mirrors the surface of Checkly's `check.ts` / Playwright
// `expect` that monitoring checks are written against, so the *same* check
// source can run synthetically (this module) or on real Checkly (unmodified
// imports). Every outcome is recorded to a trace; verdicts come from that trace.
// No LLM anywhere in this module.
//
// Evidence rule: a run only counts if it PROVES it exercised the armed app.
// `runCollected` instruments `fetch` so every request that reaches the armed
// baseUrl is a traced step; a run with no registered check, or with no request
// that reached the armed baseUrl, is reported as `vacuous` — never as passed.

import { assertionId } from "./assertion/id.ts";

export interface TraceItem {
  kind: "step" | "assertion" | "suppression";
  what: string;
  outcome: "ok" | "failed" | "skipped";
  assertionId?: string;
}

export interface CheckRunResult {
  name: string;
  passed: boolean;
  error: string | null;
  trace: TraceItem[];
  runCount: number;
  runs: Array<{ id: string; passed: boolean }>;
  /** Requests that reached the armed baseUrl and got a response (proof of contact). */
  simHits: number;
  /** Assertions recorded by the handler. */
  assertionCount: number;
}

/** Shape of the JSON line the driver prints; consumed by sandbox.ts. */
export interface CollectedOutcome {
  __verifyFixOutcome: true;
  baseUrl: string;
  results: CheckRunResult[];
  /** true when the run produced no admissible evidence (see VACUOUS_* reasons). */
  vacuous: boolean;
  vacuousReason: string | null;
}

export const VACUOUS_NO_CHECK = "DSL did not contact armed sim: no check registered (check module did not call check())";
export const VACUOUS_NO_HIT = "DSL did not contact armed sim: no request reached the armed baseUrl";

type Handler = (ctx: { baseUrl: string; account: string }) => Promise<void>;

const registry: Array<{ name: string; handler: Handler }> = [];
const trace: TraceItem[] = [];
let simHits = 0;
let assertionCount = 0;

export function baseUrl(): string {
  return process.env.APP_BASE_URL ?? "http://127.0.0.1:1";
}

export function step(what: string) {
  trace.push({ kind: "step", what, outcome: "ok" });
}

export function suppression(what: string) {
  trace.push({ kind: "suppression", what, outcome: "ok" });
}

export function check(name: string, maybeHandlerOrOptions: unknown, maybeHandler?: Handler) {
  const handler = (typeof maybeHandlerOrOptions === "function" ? maybeHandlerOrOptions : maybeHandler) as Handler;
  registry.push({ name, handler });
}

/** Human-readable rendering of a runtime value (used in trace text). */
function subjectOf(actual: unknown): string {
  if (typeof actual === "string") return `str(${JSON.stringify(actual.slice(0, 60))})`;
  if (typeof actual === "number") return `num(${actual})`;
  if (typeof actual === "boolean") return `bool(${actual})`;
  if (actual === null) return "null";
  if (actual === undefined) return "undefined";
  try {
    return JSON.stringify(actual).slice(0, 120);
  } catch {
    return String(actual);
  }
}

/**
 * Source-like rendering of an expected value, so the runtime assertion id binds
 * to the inventory id (identity = fnv1a("matcher|target"), see assertion/id.ts).
 * `toBe(200)` in source → target "200"; at runtime expected=200 → "200".
 */
function targetOf(expected: unknown): string {
  if (typeof expected === "string") return JSON.stringify(expected);
  if (typeof expected === "number" || typeof expected === "boolean") return String(expected);
  if (expected === null) return "null";
  if (expected === undefined) return "undefined";
  if (expected instanceof RegExp) return String(expected);
  try {
    return JSON.stringify(expected);
  } catch {
    return String(expected);
  }
}

/** Record exactly one trace entry per assertion; throw a marked failure if it did not hold. */
function assert(matcher: string, subject: unknown, target: string, ok: boolean, detail: string): void {
  const id = assertionId(subjectOf(subject), matcher, target);
  assertionCount += 1;
  trace.push({
    kind: "assertion",
    what: `${matcher}(${target}) on ${subjectOf(subject)} — ${detail}`,
    outcome: ok ? "ok" : "failed",
    assertionId: id,
  });
  if (ok) return;
  const err = new Error(`expect(${subjectOf(subject)}).${matcher}(${target}) FAILED: ${detail}`);
  (err as Error & { __checkFailure: boolean }).__checkFailure = true;
  throw err;
}

function eq(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a === "number" && typeof b === "number") return a === b;
  try {
    const sa = typeof a === "string" ? a : JSON.stringify(a);
    const sb = typeof b === "string" ? b : JSON.stringify(b);
    return sa === sb || (sa === "undefined" && sb === "null") || (sa === "null" && sb === "undefined");
  } catch {
    return false;
  }
}

export function expect(actual: unknown) {
  return {
    toBe(expected: unknown) {
      const ok = eq(actual, expected);
      assert("toBe", actual, targetOf(expected), ok, ok ? "match" : `got ${subjectOf(actual)}`);
    },
    toEqual(expected: unknown) {
      const ok = eq(actual, expected);
      assert("toEqual", actual, targetOf(expected), ok, ok ? "deep match" : `got ${subjectOf(actual)}`);
    },
    toContainText(expected: string) {
      const hay = String(actual ?? "");
      const ok = hay.includes(expected);
      assert("toContainText", actual, targetOf(expected), ok, ok ? "found" : `missing in ${subjectOf(actual)}`);
    },
    toContain(expected: unknown) {
      const ok = Array.isArray(actual) ? actual.some((x) => eq(x, expected)) : String(actual ?? "").includes(String(expected));
      assert("toContain", actual, targetOf(expected), ok, ok ? "found" : "not found");
    },
    toMatch(pattern: RegExp) {
      const ok = pattern.test(String(actual ?? ""));
      assert("toMatch", actual, String(pattern), ok, ok ? "matched" : `did not match ${String(pattern)}`);
    },
    toBeGreaterThan(expected: number) {
      const v = Number(actual);
      const ok = v > expected;
      assert("toBeGreaterThan", actual, String(expected), ok, `got ${v}`);
    },
    toBeGreaterThanOrEqual(expected: number) {
      const v = Number(actual);
      const ok = v >= expected;
      assert("toBeGreaterThanOrEqual", actual, String(expected), ok, `got ${v}`);
    },
    toBeLessThan(expected: number) {
      const v = Number(actual);
      const ok = v < expected;
      assert("toBeLessThan", actual, String(expected), ok, `got ${v}`);
    },
    toHaveLength(expected: number) {
      const v = (actual as ArrayLike<unknown> | string)?.length ?? -1;
      const ok = v === expected;
      assert("toHaveLength", actual, String(expected), ok, `got length ${v}`);
    },
    toBeTruthy() {
      const ok = Boolean(actual);
      assert("toBeTruthy", actual, "", ok, ok ? "truthy" : "falsy");
    },
    toBeDefined() {
      const ok = actual !== undefined && actual !== null;
      assert("toBeDefined", actual, "", ok, ok ? "defined" : "undefined/null");
    },
    toBeNull() {
      const ok = actual === null;
      assert("toBeNull", actual, "", ok, ok ? "null" : `got ${subjectOf(actual)}`);
    },
    toBeFalsy() {
      const ok = !actual;
      assert("toBeFalsy", actual, "", ok, ok ? "falsy" : "truthy");
    },
  };
}

function urlOf(input: RequestInfo | URL): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

function pathOf(url: string): string {
  try {
    const u = new URL(url);
    return `${u.pathname}${u.search}`;
  } catch {
    return url;
  }
}

/**
 * Wrap global fetch so every request the handler makes is a traced step, and
 * every request that reached the armed baseUrl and got a response counts as a
 * sim hit. A request that never got a response (network error) is a failed
 * step, not a hit: it proves nothing about the armed app.
 */
function instrumentFetch(armedBaseUrl: string): void {
  const realFetch = globalThis.fetch;
  const armed = armedBaseUrl.replace(/\/+$/, "");
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = urlOf(input);
    const method = (init?.method ?? (typeof input === "object" && "method" in input ? input.method : "GET")).toUpperCase();
    const hit = url === armed || url.startsWith(`${armed}/`) || url.startsWith(`${armed}?`);
    const label = hit ? pathOf(url) : url;
    try {
      const res = await realFetch(input, init);
      if (hit) simHits += 1;
      trace.push({ kind: "step", what: `fetch ${method} ${label} → ${res.status}`, outcome: "ok" });
      return res;
    } catch (e) {
      trace.push({ kind: "step", what: `fetch ${method} ${label} → no response: ${(e as Error)?.message ?? e}`, outcome: "failed" });
      throw e;
    }
  }) as typeof fetch;
}

/** Run phase: produced by driver.ts, consumed by the executor via stdout JSON. */
export async function runCollected(ctx: { baseUrl: string; account: string; concurrentRuns?: number }) {
  instrumentFetch(ctx.baseUrl);
  const results: CheckRunResult[] = [];
  let runSeq = 0;

  if (registry.length === 0) {
    // Nothing registered: the check module was not loaded or never called
    // check(). This is the vacuous run — it must surface as evidence, not as an
    // empty result list that a naive `every()` turns into a pass.
    results.push({
      name: "(no check registered)",
      passed: false,
      error: VACUOUS_NO_CHECK,
      trace: [{ kind: "step", what: VACUOUS_NO_CHECK, outcome: "skipped" }],
      runCount: 0,
      runs: [],
      simHits: 0,
      assertionCount: 0,
    });
    emit({ __verifyFixOutcome: true, baseUrl: ctx.baseUrl, results, vacuous: true, vacuousReason: VACUOUS_NO_CHECK });
    return;
  }

  for (const entry of registry) {
    const runs = ctx.concurrentRuns ?? 1;
    // NOTE: trace/simHits/assertionCount are per-run module state; the synthetic
    // executor always drives concurrentRuns=1 (overlap is expressed by the
    // app-sim's armed state), so a run's evidence is exactly what it recorded.
    const sub = await Promise.all(
      Array.from({ length: runs }, async (_, i) => {
        trace.length = 0;
        simHits = 0;
        assertionCount = 0;
        runSeq += 1;
        try {
          if (typeof entry.handler !== "function") throw new Error(`check "${entry.name}" has no handler function`);
          await entry.handler({ baseUrl: ctx.baseUrl, account: runs > 1 ? `${ctx.account}#${i}` : ctx.account });
          return { passed: true, error: null as string | null };
        } catch (e) {
          const err = e as Error;
          if (!(err as Error & { __checkFailure?: boolean }).__checkFailure) {
            trace.push({ kind: "step", what: `unexpected error: ${err?.message ?? e}`, outcome: "failed" });
          }
          return { passed: false, error: err?.message ?? String(e) };
        }
      })
    );
    const hits = simHits;
    const asserted = assertionCount;
    if (hits === 0) {
      trace.push({ kind: "step", what: VACUOUS_NO_HIT, outcome: "skipped" });
    }
    const passed = hits > 0 && sub.every((s) => s.passed);
    const firstError = sub.find((s) => !s.passed)?.error ?? (hits === 0 ? VACUOUS_NO_HIT : null);
    results.push({
      name: entry.name,
      passed,
      error: firstError,
      trace: JSON.parse(JSON.stringify(trace)),
      runCount: runs,
      runs: sub.map((s, i) => ({ id: `sandbox-run:${runSeq}-${i}`, passed: s.passed })),
      simHits: hits,
      assertionCount: asserted,
    });
  }

  const hitless = results.filter((r) => r.simHits === 0);
  const vacuous = hitless.length > 0;
  emit({
    __verifyFixOutcome: true,
    baseUrl: ctx.baseUrl,
    results,
    vacuous,
    vacuousReason: vacuous ? `${VACUOUS_NO_HIT} (${hitless.map((r) => r.name).join(", ")})` : null,
  });
}

function emit(outcome: CollectedOutcome): void {
  console.log(JSON.stringify(outcome));
}
