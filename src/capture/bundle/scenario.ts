// Trusted Multistep scenario validation.
//
// The scenario lives only in the bundle manifest and is covered by the bundle
// digest. It is a closed grammar: unknown keys, unbounded strings, query
// strings, origins, duplicate routes and non-scalar mutations are rejected
// outright. Rejection is recorded as a Multistep problem, which downstream
// verification turns into UNCERTAIN — never a silent fallback to default
// routes or fields.

import type { MultistepScenario, MultistepScenarioMutation, MultistepScenarioRoute,
  MultistepWitness, MultistepWitnessRef, MultistepWitnessShape } from "../../types.ts";

export type ScenarioValidation =
  | { scenario: MultistepScenario; problem: null }
  | { scenario: null; problem: string };

export const MULTISTEP_SCENARIO_INVALID = "MULTISTEP_SCENARIO_INVALID";

const FORBIDDEN_KEYS = new Set(["__proto__", "constructor", "prototype"]);
const ROUTE_KEYS = ["method", "path", "step"] as const;
const ROUTE_OPTIONAL = ["auth"] as const;
const MUTATION_KEYS = ["method", "path", "jsonPath", "expected", "replace"] as const;
const SCENARIO_KEYS = ["kind", "routes", "stepTitles", "mutation"] as const;
const SCENARIO_OPTIONAL = ["slot", "repair", "writes", "witness"] as const;
const METHOD = /^[A-Z]{2,16}$/;
const PATH = /^\/[A-Za-z0-9._~!$&'()*+,;=:@%/-]{0,2047}$/;
const PROPERTY = /^[A-Za-z_$][A-Za-z0-9_$-]{0,63}$/;

function invalid(): ScenarioValidation {
  return { scenario: null, problem: MULTISTEP_SCENARIO_INVALID };
}

function record(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const object = value as Record<string, unknown>;
  const keys = Object.keys(object);
  if (keys.some((key) => FORBIDDEN_KEYS.has(key))) return null;
  return object;
}

function keysMatch(value: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []): boolean {
  const keys = Object.keys(value);
  const allowed = new Set([...required, ...optional]);
  return required.every((key) => Object.hasOwn(value, key)) && keys.every((key) => allowed.has(key));
}

function text(value: unknown, max: number): string | null {
  return typeof value === "string" && value.length > 0 && value.length <= max && value.trim() === value
    ? value : null;
}

function scalar(value: unknown): string | number | boolean | null {
  if (typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.length <= 1024) return value;
  return null;
}

function route(value: unknown): MultistepScenarioRoute | null {
  const raw = record(value);
  if (!raw || !keysMatch(raw, ROUTE_KEYS, ROUTE_OPTIONAL)) return null;
  const method = typeof raw.method === "string" && METHOD.test(raw.method) ? raw.method : null;
  const path = typeof raw.path === "string" && PATH.test(raw.path)
    && !raw.path.includes("?") && !raw.path.includes("#") && !raw.path.includes("..")
    && !raw.path.includes("//") ? raw.path : null;
  const step = text(raw.step, 200);
  if (raw.auth !== undefined && typeof raw.auth !== "boolean") return null;
  return method && path && step
    ? { method, path, step, ...(raw.auth === undefined ? {} : { auth: raw.auth }) }
    : null;
}

function mutation(value: unknown, routes: readonly MultistepScenarioRoute[]): MultistepScenarioMutation | null {
  const raw = record(value);
  if (!raw || !keysMatch(raw, MUTATION_KEYS)) return null;
  const method = typeof raw.method === "string" && METHOD.test(raw.method) ? raw.method : null;
  const path = typeof raw.path === "string" && PATH.test(raw.path) ? raw.path : null;
  if (!method || !path || !routes.some((entry) => entry.method === method && entry.path === path)) return null;
  if (!Array.isArray(raw.jsonPath) || raw.jsonPath.length < 1 || raw.jsonPath.length > 8) return null;
  const jsonPath = raw.jsonPath.map((part) => typeof part === "string" && PROPERTY.test(part) ? part : null);
  if (jsonPath.some((part) => part === null)) return null;
  if (new Set(jsonPath).size !== jsonPath.length) return null;
  const expected = scalar(raw.expected);
  const replace = scalar(raw.replace);
  if (expected === null || replace === null) return null;
  if (typeof expected !== typeof replace) return null;
  if (expected === replace) return null;
  return { method, path, jsonPath: jsonPath as string[], expected, replace };
}

function witnessShape(value: unknown, depth = 0, budget = { nodes: 0 }): MultistepWitnessShape | null {
  if (depth > 8 || ++budget.nodes > 512) return null;
  const raw = record(value);
  if (!raw) return null;
  if (raw.kind === "null" || raw.kind === "string" || raw.kind === "number" || raw.kind === "boolean") {
    return keysMatch(raw, ["kind"]) ? { kind: raw.kind } : null;
  }
  if (raw.kind === "array") {
    if (!keysMatch(raw, ["kind", "item"]) || raw.item === undefined) return null;
    const item = raw.item === null ? null : witnessShape(raw.item, depth + 1, budget);
    if (raw.item !== null && !item) return null;
    return { kind: "array", item };
  }
  if (raw.kind !== "object" || !keysMatch(raw, ["kind", "fields"])) return null;
  const fields = record(raw.fields);
  if (!fields) return null;
  const parsed: Record<string, MultistepWitnessShape> = {};
  const keys = Object.keys(fields);
  if (keys.length > 64) return null;
  for (const key of keys) {
    if (!PROPERTY.test(key)) return null;
    const child = witnessShape(fields[key], depth + 1, budget);
    if (!child) return null;
    parsed[key] = child;
  }
  return { kind: "object", fields: parsed };
}

function witnessRef(value: unknown, routeCount: number): MultistepWitnessRef | null {
  const raw = record(value);
  if (!raw || !keysMatch(raw, ["route", "where", "path"])) return null;
  if (!Number.isSafeInteger(raw.route) || (raw.route as number) < 0 || (raw.route as number) >= routeCount) return null;
  if (raw.where !== "request" && raw.where !== "response") return null;
  if (!Array.isArray(raw.path) || raw.path.length < 1 || raw.path.length > 8) return null;
  const path: string[] = [];
  for (const part of raw.path) {
    if (typeof part !== "string" || !PROPERTY.test(part)) return null;
    path.push(part);
  }
  return { route: raw.route as number, where: raw.where, path };
}

function witness(value: unknown, routes: readonly MultistepScenarioRoute[]): MultistepWitness | null {
  const raw = record(value);
  if (!raw || !keysMatch(raw, ["responses", "equalities"])) return null;
  if (!Array.isArray(raw.responses) || raw.responses.length !== routes.length) return null;
  const responses: MultistepWitnessShape[] = [];
  for (const entry of raw.responses) {
    const shape = witnessShape(entry);
    if (!shape || shape.kind !== "object") return null;
    responses.push(shape);
  }
  if (!Array.isArray(raw.equalities) || raw.equalities.length > 64) return null;
  const equalities: MultistepWitness["equalities"] = [];
  for (const entry of raw.equalities) {
    const item = record(entry);
    if (!item || !keysMatch(item, ["left", "right"])) return null;
    const left = witnessRef(item.left, routes.length);
    const right = witnessRef(item.right, routes.length);
    if (!left || !right || (left.route === right.route && left.where === right.where
      && JSON.stringify(left.path) === JSON.stringify(right.path))) return null;
    equalities.push({ left, right });
  }
  return { responses, equalities };
}

/** Validate the manifest `scenario` block. Never mutates or repairs the input. */
export function validateMultistepScenario(value: unknown): ScenarioValidation {
  const raw = record(value);
  if (!raw || !keysMatch(raw, SCENARIO_KEYS, SCENARIO_OPTIONAL) || raw.kind !== "multistep") return invalid();
  if (!Array.isArray(raw.routes) || raw.routes.length < 1 || raw.routes.length > 32) return invalid();
  const routes: MultistepScenarioRoute[] = [];
  for (const entry of raw.routes) {
    const parsed = route(entry);
    if (!parsed) return invalid();
    routes.push(parsed);
  }
  if (new Set(routes.map((entry) => `${entry.method} ${entry.path}`)).size !== routes.length) return invalid();
  if (new Set(routes.map((entry) => entry.path)).size !== routes.length) return invalid();
  if (!Array.isArray(raw.stepTitles) || raw.stepTitles.length < routes.length || raw.stepTitles.length > 64) return invalid();
  const stepTitles: string[] = [];
  for (const title of raw.stepTitles) {
    const parsed = text(title, 200);
    if (!parsed) return invalid();
    stepTitles.push(parsed);
  }
  if (new Set(stepTitles).size !== stepTitles.length) return invalid();
  if (routes.some((entry) => !stepTitles.includes(entry.step))) return invalid();
  const parsedMutation = mutation(raw.mutation, routes);
  if (!parsedMutation) return invalid();
  const slot = raw.slot === undefined ? undefined
    : typeof raw.slot === "string" && /^\d{2}:\d{2}$/.test(raw.slot) ? raw.slot : null;
  if (slot === null) return invalid();
  const repairs = (key: "repair" | "writes"): Array<{ from: string; to: string }> | null => {
    if (raw[key] === undefined) return [];
    if (!Array.isArray(raw[key]) || raw[key].length > 32) return null;
    const out: Array<{ from: string; to: string }> = [];
    for (const entry of raw[key] as unknown[]) {
      const item = record(entry);
      if (!item || !keysMatch(item, ["from", "to"])) return null;
      const from = text(item.from, 512);
      const to = text(item.to, 512);
      if (!from || !to || from === to) return null;
      out.push({ from, to });
    }
    if (new Set(out.map((item) => item.from)).size !== out.length) return null;
    return out;
  };
  const repair = repairs("repair");
  const writes = repairs("writes");
  if (!repair || !writes) return invalid();
  const parsedWitness = raw.witness === undefined ? null : witness(raw.witness, routes);
  if (raw.witness !== undefined && !parsedWitness) return invalid();
  return {
    scenario: {
      kind: "multistep", routes, stepTitles, mutation: parsedMutation,
      ...(slot ? { slot } : {}),
      ...(repair.length ? { repair } : {}),
      ...(writes.length ? { writes } : {}),
      ...(parsedWitness ? { witness: parsedWitness } : {}),
    },
    problem: null,
  };
}
