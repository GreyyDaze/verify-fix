// Sandbox runner: execute the patched check source in an isolated temp dir
// using Node's native TypeScript support. The check talks to ENVIRONMENT_URL
// (Checkly's convention) — in a scene that is the scene proxy, which forwards
// to the target, answers from a recording, or injects a failure. Verdicts come
// from the recorded JSON trace, never from inference.
//
// Evidence rule (mirrors check-api.ts): `passed` is true only when at least
// one check ran, contacted ENVIRONMENT_URL, and every run held. A run that
// registered no check or never reached it is `vacuous` — the caller must
// classify it UNCERTAIN, never pass/fail.

import { mkdtemp, writeFile, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import type { CheckRunResult, CollectedOutcome } from "./check-api.ts";

export interface SandboxContext {
  /** becomes ENVIRONMENT_URL — the scene proxy's origin for this run */
  baseUrl: string;
  /** becomes ENVIRONMENT_NAME */
  environmentName?: string;
  /** the check's own variables (from --env-file / the scene), e.g. ACCOUNT, TEST_USER */
  env?: Record<string, string>;
  timeoutMs?: number;
  /** Seed for the sandbox's Math.random (see SEED_MODULE). Omit for native randomness. */
  seed?: number;
}

export interface SandboxOutcome {
  /** true only for a non-vacuous run in which every registered check passed. */
  passed: boolean;
  /** true when the run produced no admissible evidence (no check, or no request reached the armed baseUrl). */
  vacuous: boolean;
  vacuousReason: string | null;
  results: CheckRunResult[];
  /** total requests that reached the armed baseUrl across all checks */
  simHits: number;
  raw: string;
}

/** Maps @checkly/playwright (real SDK) to the sandbox DSL, so the *authentic*
 * check file runs unmodified here and on real Checkly. */
export function remapImports(source: string): string {
  return source
    .replace(/@checkly\/playwright/g, "./check-api.ts")
    .replace(/@checkly\/cli/g, "./check-api.ts");
}

export const OUTCOME_MARKER = '"__verifyFixOutcome":true';

/**
 * Deterministic randomness for the sandboxed check. When SANDBOX_SEED is set,
 * Math.random is a seeded PRNG (mulberry32) so a verification run is
 * reproducible: the same patch + scene + repetition always yields the same
 * evidence. The executor gives every repetition its own seed, so a genuinely
 * flaky check still produces disagreeing repetitions — it just does so the
 * same way on every re-run of verify-fix. Evaluated before the check module.
 */
export const SEED_MODULE = [
  `const raw = process.env.SANDBOX_SEED;`,
  `if (raw !== undefined && raw !== "") {`,
  `  let a = (Number(raw) >>> 0) || 0x9e3779b9;`,
  `  Math.random = () => {`,
  `    a = (a + 0x6d2b79f5) >>> 0;`,
  `    let t = a;`,
  `    t = Math.imul(t ^ (t >>> 15), t | 1);`,
  `    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);`,
  `    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;`,
  `  };`,
  `}`,
  ``,
].join("\n");

/** Locate the driver's outcome line in the child's stdout (checks may print too). */
export function parseOutcomeLine(raw: string): CollectedOutcome | null {
  const line = raw
    .trim()
    .split("\n")
    .reverse()
    .find((l) => l.startsWith("{") && l.includes(OUTCOME_MARKER));
  if (!line) return null;
  const parsed = JSON.parse(line) as CollectedOutcome;
  if (!Array.isArray(parsed.results)) return null;
  return parsed;
}

export async function runSandbox(checkSource: string, ctx: SandboxContext): Promise<SandboxOutcome> {
  const dir = await mkdtemp(join(tmpdir(), "verify-fix-sandbox-"));
  try {
    const checkApi = await readFile(join(import.meta.dirname, "check-api.ts"), "utf8");
    const idSrc = await readFile(join(import.meta.dirname, "assertion", "id.ts"), "utf8");
    const remapped = remapImports(checkSource);

    await writeFile(join(dir, "check.ts"), remapped, "utf8");
    await writeFile(join(dir, "id.ts"), idSrc, "utf8");
    await writeFile(join(dir, "check-api.ts"), checkApi.replace("./assertion/id.ts", "./id.ts"), "utf8");

    await writeFile(join(dir, "seed.ts"), SEED_MODULE, "utf8");

    // The driver MUST load the patched check module before the run phase: the
    // check registers itself via `check(name, handler)` as a side effect of
    // import. Without this import the registry is empty and runCollected has
    // nothing to execute — the run is vacuous (no step ever reaches the armed
    // sim) and must never be reported as a pass. seed.ts is imported first so
    // the check module already sees deterministic Math.random.
    const driver = [
      `import "./seed.ts";`,
      `import "./check.ts";`,
      `import { runCollected } from "./check-api.ts";`,
      `await runCollected({`,
      `  baseUrl: process.env.ENVIRONMENT_URL ?? "http://127.0.0.1:1",`,
      `  account: process.env.ACCOUNT ?? process.env.TEST_USER ?? "demo",`,
      `});`,
      ``,
    ].join("\n");
    await writeFile(join(dir, "driver.ts"), driver, "utf8");

    const raw = await new Promise<string>((resolve, reject) => {
      // Only what the sandbox needs: PATH/HOME for node, Checkly's two
      // variables, the check's own variables, the seed. The parent's
      // environment (API keys, shell state) does not leak into the check.
      const child = spawn(process.execPath, ["--no-warnings", "driver.ts"], {
        cwd: dir,
        env: {
          PATH: process.env.PATH ?? "",
          HOME: process.env.HOME ?? "",
          NODE_OPTIONS: process.env.NODE_OPTIONS ?? "",
          ...(ctx.env ?? {}),
          ENVIRONMENT_URL: ctx.baseUrl,
          ENVIRONMENT_NAME: ctx.environmentName ?? "verify-fix",
          SANDBOX_SEED: ctx.seed === undefined ? "" : String(ctx.seed >>> 0),
        },
      });
      let stdout = "";
      let stderr = "";
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        reject(new Error(`sandbox timeout after ${ctx.timeoutMs ?? 20000}ms; stderr: ${stderr.slice(0, 400)}`));
      }, ctx.timeoutMs ?? 20000);
      child.stdout.on("data", (d) => (stdout += String(d)));
      child.stderr.on("data", (d) => (stderr += String(d)));
      child.on("error", (e) => {
        clearTimeout(timer);
        reject(e);
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        if (code === 0) resolve(stdout);
        else reject(new Error(`sandbox exited ${code}: ${stderr.slice(0, 600)}\nstdout: ${stdout.slice(0, 400)}`));
      });
    });

    const parsed = parseOutcomeLine(raw);
    if (!parsed) throw new Error(`no JSON outcome from sandbox: ${raw.slice(0, 300)}`);
    const simHits = parsed.results.reduce((acc, r) => acc + (r.simHits ?? 0), 0);
    const vacuous = parsed.vacuous === true || parsed.results.length === 0 || simHits === 0;
    const vacuousReason = vacuous
      ? parsed.vacuousReason ?? (parsed.results.length === 0 ? "DSL did not contact armed sim: empty result set" : "DSL did not contact armed sim: no request reached the armed baseUrl")
      : null;
    const passed = !vacuous && parsed.results.every((r) => r.passed);
    return { passed, vacuous, vacuousReason, results: parsed.results, simHits, raw };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
