// Sandbox check DSL. Mirrors the surface of Checkly's `check.ts` / Playwright
// `expect` that monitoring checks are written against, so the *same* check
// source can run synthetically (this module) or on real Checkly (unmodified
// imports). Every outcome is recorded to a trace; verdicts come from that trace.
// No LLM anywhere in this module.

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
}

const registry: Array<{ name: string; handler: (ctx: { baseUrl: string; account: string }) => Promise<void> }> = [];
const trace: TraceItem[] = [];

export function baseUrl(): string {
  return process.env.APP_BASE_URL ?? "http://127.0.0.1:1";
}

export function step(what: string) {
  trace.push({ kind: "step", what, outcome: "ok" });
}

export function suppression(what: string) {
  trace.push({ kind: "suppression", what, outcome: "ok" });
}

export function check(name: string, maybeHandlerOrOptions: unknown, maybeHandler?: (ctx: { baseUrl: string; account: string }) => Promise<void>) {
  const handler = (typeof maybeHandlerOrOptions === "function" ? maybeHandlerOrOptions : maybeHandler) as (
    ctx: { baseUrl: string; account: string }
  ) => Promise<void>;
  registry.push({ name, handler });
}

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

function record(matcher: string, subject: unknown, target: string, ok: boolean, detail: string) {
  const id = assertionId(subjectOf(subject), matcher, target);
  trace.push({ kind: "assertion", what: `${matcher}(${target}) on ${subjectOf(subject)} — ${detail}`, outcome: ok ? "ok" : "failed", assertionId: id });
}

function failAssertion(matcher: string, subject: unknown, target: string, detail: string): never {
  record(matcher, subject, target, false, detail);
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
      record("toBe", actual, subjectOf(expected), ok, ok ? "match" : `got ${subjectOf(actual)}`);
      if (!ok) failAssertion("toBe", actual, subjectOf(expected), `got ${subjectOf(actual)}`);
    },
    toEqual(expected: unknown) {
      const ok = eq(actual, expected);
      record("toEqual", actual, subjectOf(expected), ok, ok ? "deep match" : `got ${subjectOf(actual)}`);
      if (!ok) failAssertion("toEqual", actual, subjectOf(expected), `got ${subjectOf(actual)}`);
    },
    toContainText(expected: string) {
      const hay = String(actual ?? "");
      const ok = hay.includes(expected);
      record("toContainText", actual, expected, ok, ok ? "found" : `missing in ${subjectOf(actual)}`);
      if (!ok) failAssertion("toContainText", actual, expected, `missing in ${subjectOf(actual)}`);
    },
    toContain(expected: unknown) {
      const ok = Array.isArray(actual) ? actual.some((x) => eq(x, expected)) : String(actual ?? "").includes(String(expected));
      record("toContain", actual, subjectOf(expected), ok, ok ? "found" : "not found");
      if (!ok) failAssertion("toContain", actual, subjectOf(expected), "not found");
    },
    toMatch(pattern: RegExp) {
      const ok = pattern.test(String(actual ?? ""));
      record("toMatch", actual, String(pattern), ok, ok ? "matched" : `did not match ${String(pattern)}`);
      if (!ok) failAssertion("toMatch", actual, String(pattern), `did not match ${String(pattern)}`);
    },
    toBeGreaterThan(expected: number) {
      const v = Number(actual);
      const ok = v > expected;
      record("toBeGreaterThan", actual, String(expected), ok, `got ${v}`);
      if (!ok) failAssertion("toBeGreaterThan", actual, String(expected), `got ${v}`);
    },
    toBeGreaterThanOrEqual(expected: number) {
      const v = Number(actual);
      const ok = v >= expected;
      record("toBeGreaterThanOrEqual", actual, String(expected), ok, `got ${v}`);
      if (!ok) failAssertion("toBeGreaterThanOrEqual", actual, String(expected), `got ${v}`);
    },
    toBeLessThan(expected: number) {
      const v = Number(actual);
      const ok = v < expected;
      record("toBeLessThan", actual, String(expected), ok, `got ${v}`);
      if (!ok) failAssertion("toBeLessThan", actual, String(expected), `got ${v}`);
    },
    toHaveLength(expected: number) {
      const v = (actual as ArrayLike<unknown> | string)?.length ?? -1;
      const ok = v === expected;
      record("toHaveLength", actual, String(expected), ok, `got length ${v}`);
      if (!ok) failAssertion("toHaveLength", actual, String(expected), `got length ${v}`);
    },
    toBeTruthy() {
      const ok = Boolean(actual);
      record("toBeTruthy", actual, "", ok, ok ? "truthy" : "falsy");
      if (!ok) failAssertion("toBeTruthy", actual, "", "falsy");
    },
    toBeDefined() {
      const ok = actual !== undefined && actual !== null;
      record("toBeDefined", actual, "", ok, ok ? "defined" : "undefined/null");
      if (!ok) failAssertion("toBeDefined", actual, "", "undefined/null");
    },
    toBeNull() {
      const ok = actual === null;
      record("toBeNull", actual, "", ok, ok ? "null" : `got ${subjectOf(actual)}`);
      if (!ok) failAssertion("toBeNull", actual, "", `got ${subjectOf(actual)}`);
    },
    toBeFalsy() {
      const ok = !actual;
      record("toBeFalsy", actual, "", ok, ok ? "falsy" : "truthy");
      if (!ok) failAssertion("toBeFalsy", actual, "", "truthy");
    },
  };
}

/** Run phase: produced by driver.ts, consumed by the executor via stdout JSON. */
export async function runCollected(ctx: { baseUrl: string; account: string; concurrentRuns?: number }) {
  console.error(`[DSL runCollected] baseUrl=${JSON.stringify(ctx.baseUrl)} account=${JSON.stringify(ctx.account)} registry=${registry.length} runs=${ctx.concurrentRuns ?? 1}`);
  const results: CheckRunResult[] = [];
  let runSeq = 0;
  for (const entry of registry) {
    const runs = ctx.concurrentRuns ?? 1;
    const sub = await Promise.all(
      Array.from({ length: runs }, async (_, i) => {
        trace.length = 0;
        const myRunId = ++runSeq;
        try {
          await entry.handler({ baseUrl: ctx.baseUrl, account: `${ctx.account}#${i}` });
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
    const passed = sub.every((s) => s.passed);
    const firstError = sub.find((s) => !s.passed)?.error ?? null;
    results.push({
      name: entry.name,
      passed,
      error: firstError,
      trace: JSON.parse(JSON.stringify(trace)),
      runCount: runs,
      runs: sub.map((s, i) => ({ id: `sandbox-run:${runSeq}-${i}`, passed: s.passed })),
    });
  }
  console.log(JSON.stringify({ results }));
}