// Config diff + policy — a fix may live in checkly.config.ts (or the check
// construct) rather than in the spec. Deterministic text parsing of the keys
// that matter for an incident, then one rule per key family:
//
//   scheduling  runParallel, locations, frequency
//               → allowed; the concurrency scenes run at the overlap the new
//                 schedule still permits (see effectiveConcurrency)
//   masking     retryStrategy, doubleCheck, timeouts (maxResponseTime, timeout,
//               maxRetries) → flagged; a patch that changes ONLY these is
//               rejected: retries hide an overlap failure, they do not fix it,
//               and this runner does not simulate retries
//   credentials environmentVariables keys → a new key is "declared": it must
//               exist in Checkly and be provided with --env-file to run here
//
// Nothing here reads the check code; code-side dodges (hardcoded account,
// generated account) stay in executor/scene detectEnvScopeDodge.

import { stripComments } from "../assertion/inventory.ts";

export interface CheckConfigView {
  runParallel: boolean | null;
  locations: string[] | null;
  frequency: string | null;
  retryStrategy: string | null;
  doubleCheck: boolean | null;
  timeouts: Record<string, string>;
  envKeys: string[];
}

const TIMEOUT_KEYS = ["maxResponseTime", "timeout", "degradedResponseTime"];

export function parseCheckConfig(source: string | null | undefined): CheckConfigView {
  // Real checkly.config.ts files explain settings in comments. Those examples
  // are not values. Parse only executable text.
  const s = stripComments(source ?? "");
  const bool = (key: string): boolean | null => {
    const m = new RegExp(`\\b${key}\\s*:\\s*(true|false)\\b`).exec(s);
    return m ? m[1] === "true" : null;
  };
  const locMatch = /\blocations\s*:\s*\[([^\]]*)\]/.exec(s);
  const locations = locMatch ? [...locMatch[1].matchAll(/['"`]([^'"`]+)['"`]/g)].map((m) => m[1]) : null;
  const freq = /\bfrequency\s*:\s*([A-Za-z0-9_.]+)/.exec(s);
  const retry = /\bretryStrategy\s*:\s*([^\n]+?)\s*,?\s*(?:\n|$)/.exec(s);
  const timeouts: Record<string, string> = {};
  for (const key of TIMEOUT_KEYS) {
    const m = new RegExp(`\\b${key}\\s*:\\s*([A-Za-z0-9_.]+)`).exec(s);
    if (m) timeouts[key] = m[1];
  }
  const envBlock = /\benvironmentVariables\s*:\s*\[([\s\S]*?)\]/.exec(s);
  const envKeys = envBlock ? [...envBlock[1].matchAll(/\bkey\s*:\s*['"`]([^'"`]+)['"`]/g)].map((m) => m[1]) : [];
  return {
    runParallel: bool("runParallel"),
    locations,
    frequency: freq ? freq[1] : null,
    retryStrategy: retry ? retry[1].trim().replace(/,$/, "") : null,
    doubleCheck: bool("doubleCheck"),
    timeouts,
    envKeys,
  };
}

export interface ConfigChange {
  family: "scheduling" | "masking" | "credentials" | "other";
  key: string;
  from: string;
  to: string;
}

export function diffCheckConfig(original: CheckConfigView, patched: CheckConfigView): ConfigChange[] {
  const out: ConfigChange[] = [];
  const show = (v: unknown) => (v === null || v === undefined ? "∅" : Array.isArray(v) ? `[${v.join(", ")}]` : String(v));
  const push = (family: ConfigChange["family"], key: string, a: unknown, b: unknown) => {
    if (JSON.stringify(a) !== JSON.stringify(b)) out.push({ family, key, from: show(a), to: show(b) });
  };
  push("scheduling", "runParallel", original.runParallel, patched.runParallel);
  push("scheduling", "locations", original.locations, patched.locations);
  push("scheduling", "frequency", original.frequency, patched.frequency);
  push("masking", "retryStrategy", original.retryStrategy, patched.retryStrategy);
  push("masking", "doubleCheck", original.doubleCheck, patched.doubleCheck);
  for (const key of new Set([...Object.keys(original.timeouts), ...Object.keys(patched.timeouts)])) {
    push("masking", key, original.timeouts[key] ?? null, patched.timeouts[key] ?? null);
  }
  push("credentials", "environmentVariables", original.envKeys, patched.envKeys);
  return out;
}

export interface ConfigPolicy {
  changes: ConfigChange[];
  /** a static rejection, phrased for the decision reasons; null = nothing static to say */
  rejected: string | null;
  notes: string[];
  /** env var keys the patch adds to the check config */
  declaredEnvKeys: string[];
}

export function applyConfigPolicy(changes: ConfigChange[], codeChanged: boolean, original: CheckConfigView, patched: CheckConfigView): ConfigPolicy {
  const notes: string[] = [];
  const scheduling = changes.filter((c) => c.family === "scheduling");
  const masking = changes.filter((c) => c.family === "masking");
  const creds = changes.filter((c) => c.family === "credentials");
  for (const c of scheduling) notes.push(`scheduling change allowed: ${c.key} ${c.from} → ${c.to}; concurrency scenes run at the overlap the new schedule still permits`);
  let rejected: string | null = null;
  if (masking.length > 0) {
    const what = masking.map((c) => `${c.key} ${c.from} → ${c.to}`).join(", ");
    if (scheduling.length === 0 && !codeChanged) {
      rejected = `retry/timeout-only change (${what}) masks the failure instead of fixing it`;
    } else {
      notes.push(`retry/timeout change flagged (${what}): retries are not simulated here; the patch is judged on its other changes`);
    }
  }
  const declaredEnvKeys = (patched.envKeys ?? []).filter((k) => !(original.envKeys ?? []).includes(k));
  for (const c of creds) notes.push(`environment variables changed: ${c.from} → ${c.to}; new keys must exist in Checkly and be provided with --env-file to run here`);
  return { changes, rejected, notes, declaredEnvKeys };
}
