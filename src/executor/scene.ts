// Scene executor — runs the candidate check in each scene through the scene
// proxy (src/scene/proxy.ts) against a real target or a recording. Replaces
// the hand-written app simulator: the target is the customer's app (a local
// `next start`, a staging URL, production), never a model of it.
//
// Per scene:
//   1. read the mode (live / live-concurrent:N / inject / replay);
//   2. decide the concurrency: min(N, what the patched config still allows);
//   3. for each repetition: arm the proxy, start `concurrency` sandboxes at
//      once (each with its own ENVIRONMENT_URL = its proxy listener), wait;
//   4. evidence gate: every run must have reached the proxy at least once and
//      the sandbox must report a non-vacuous run — otherwise the repetition
//      is `uncertain`, never pass/fail;
//   5. repetitions that disagree → `uncertain` (non-deterministic).
//
// A repetition "passes" only if every concurrent run passed: one failing
// location is one alert.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Bundle, ExperimentExecutor, ObservationValue, RunContext, Scene, SceneObservation, TraceStep } from "../types.ts";
import { runSandbox, type SandboxOutcome } from "../sandbox.ts";
import { sceneExpected } from "../contract/contract.ts";
import { fnv1a } from "../assertion/id.ts";
import { effectiveConcurrency, needsTarget, parseMode, type ParsedMode } from "../scene/modes.ts";
import { SceneProxy } from "../scene/proxy.ts";
import type { Har } from "../trace/har-types.ts";

/** Reproducible per-run randomness seed: same scene + repetition + run → same seed. */
export function repetitionSeed(sceneId: string, repetition: number, runIndex = 0): number {
  return parseInt(fnv1a(`${sceneId}:${repetition}${runIndex ? `:${runIndex}` : ""}`), 16) >>> 0;
}

export interface SceneExecutorOptions {
  /** live target origin (`--target`); null = live scenes are uncertain */
  target: string | null;
  /** the check's own variables (--env-file); never read from the bundle */
  env?: Record<string, string>;
  environmentName?: string;
  /** Per-scene run cap. Defaults to the bundle's declared runBudget.maxPerScene. */
  maxRunsPerScene?: number;
  verbose?: boolean;
  barrierTimeoutMs?: number;
  sandboxTimeoutMs?: number;
}

/** Fallback cap when neither the option nor the bundle declares one. */
export const DEFAULT_MAX_RUNS_PER_SCENE = 10;

export function isSceneExecutor(e: ExperimentExecutor): e is SceneExecutor {
  return e.kind === "scene";
}

export class SceneExecutor implements ExperimentExecutor {
  readonly kind = "scene" as const;
  readonly target: string | null;
  readonly env: Record<string, string>;
  readonly environmentName: string;
  readonly maxRunsPerScene: number | null;
  readonly verbose: boolean;
  private readonly barrierTimeoutMs: number | undefined;
  private readonly sandboxTimeoutMs: number | undefined;
  private readonly proxy = new SceneProxy();
  private used = new Map<string, number>();
  private harCache = new Map<string, Har | null>();
  nondeterministicScenes: string[] = [];
  budgetExhausted = false;
  /** scenes whose runs produced no admissible evidence, with the reason */
  inconclusiveScenes: Array<{ sceneId: string; reason: string }> = [];

  constructor(opts: SceneExecutorOptions) {
    this.target = opts.target ? opts.target.replace(/\/+$/, "") : null;
    this.env = { ...(opts.env ?? {}) };
    this.environmentName = opts.environmentName ?? "verify-fix";
    this.maxRunsPerScene = opts.maxRunsPerScene ?? null;
    this.verbose = opts.verbose ?? false;
    this.barrierTimeoutMs = opts.barrierTimeoutMs;
    this.sandboxTimeoutMs = opts.sandboxTimeoutMs;
  }

  isLive(): boolean {
    return this.target !== null;
  }

  costReport(): { scenes: number; runs: number } {
    return { scenes: this.used.size, runs: [...this.used.values()].reduce((a, b) => a + b, 0) };
  }

  budgetFor(bundle: Bundle): number {
    const declared = bundle.runBudget?.maxPerScene;
    return this.maxRunsPerScene ?? (typeof declared === "number" && declared > 0 ? declared : DEFAULT_MAX_RUNS_PER_SCENE);
  }

  /** The label the report shows in its environment column. */
  environmentLabel(bundle: Bundle, scene: Scene, mode: ParsedMode, concurrency: number): string {
    const host = this.target ? new URL(this.target).host : "no target";
    switch (mode.kind) {
      case "live":
        return `target ${host} (live)`;
      case "live-concurrent":
        return `target ${host} (live-concurrent:${concurrency}${concurrency < mode.concurrency ? ` of ${mode.concurrency}, schedule allows ${concurrency}` : ""})`;
      case "inject":
        return `target ${host} + inject ${mode.rule.raw}`;
      case "replay":
        return `recording ${mode.har}`;
      default:
        return scene.mode;
    }
  }

  private har(bundle: Bundle, file: string): Har | null {
    const candidates = [join(bundle.dir, "recordings", file), join(bundle.dir, file)];
    const path = candidates.find((p) => existsSync(p)) ?? null;
    if (!path) return null;
    if (!this.harCache.has(path)) {
      try {
        this.harCache.set(path, JSON.parse(readFileSync(path, "utf8")) as Har);
      } catch {
        this.harCache.set(path, null);
      }
    }
    return this.harCache.get(path) ?? null;
  }

  private uncertain(scene: Scene, reason: string, repetitions: number, trace: TraceStep[], environment: string): SceneObservation {
    this.inconclusiveScenes.push({ sceneId: scene.sceneId, reason });
    if (this.verbose) console.error(`[scene] ${scene.sceneId} observed=uncertain — ${reason}`);
    return { sceneId: scene.sceneId, observed: "uncertain", repetitions, trace, source: "scene", reason, environment };
  }

  async runScene(bundle: Bundle, patchSource: string, scene: Scene, ctx?: RunContext): Promise<SceneObservation> {
    const mode = parseMode(scene.mode);
    const config = ctx?.config ?? bundle.config;
    const allowed = effectiveConcurrency(config);
    const concurrency = mode.kind === "live-concurrent" ? Math.max(1, Math.min(mode.concurrency, allowed)) : 1;
    const environment = this.environmentLabel(bundle, scene, mode, concurrency);

    if (mode.kind === "unknown" || mode.kind === "pending") return this.uncertain(scene, `scene mode not runnable: ${mode.reason}`, 0, [], environment);
    if (needsTarget(mode) && !this.target) {
      const recorded = bundle.recordedOrigin ? `the recorded origin ${bundle.recordedOrigin}` : "a recorded origin";
      return this.uncertain(scene, `live scene needs a target: pass --target <url> (${recorded} is never used implicitly)`, 0, [], environment);
    }
    const replayHar = mode.kind === "replay" ? this.har(bundle, mode.har) : null;
    if (mode.kind === "replay" && !replayHar) return this.uncertain(scene, `recording ${mode.har} not found in the bundle`, 0, [], environment);
    const failingHar = mode.kind === "inject" ? this.har(bundle, "failing.har") : null;

    const budget = this.budgetFor(bundle);
    const wantedRuns = Math.min(scene.experiments[0]?.repetitions ?? 1, budget);
    const usedSoFar = this.used.get(scene.sceneId) ?? 0;
    const canRun = Math.max(0, budget - usedSoFar);
    if (canRun <= 0) {
      this.budgetExhausted = true;
      return this.uncertain(scene, `run budget exhausted (${usedSoFar}/${budget} runs used for this scene)`, 0, [], environment);
    }
    const reps = Math.max(1, Math.min(wantedRuns, canRun));
    this.used.set(scene.sceneId, usedSoFar + reps);

    const observedOutcomes: Array<"pass" | "fail"> = [];
    const mergedTrace: TraceStep[] = [];
    let index = 0;
    const push = (t: Omit<TraceStep, "index">) => mergedTrace.push({ ...t, index: index++ });
    if (concurrency < (mode.kind === "live-concurrent" ? mode.concurrency : 1)) {
      push({ kind: "step", what: `scheduling: the patched config allows ${allowed} overlapping run(s) (runParallel=${String(config?.runParallel)}, locations=${config?.locations.length ?? "?"}); scene runs at concurrency ${concurrency}`, outcome: "ok" });
    }

    for (let rep = 0; rep < reps; rep++) {
      const urls = await this.proxy.arm({ mode, target: this.target, runs: concurrency, replayHar, failingHar, barrierTimeoutMs: this.barrierTimeoutMs });
      const env = { ...this.env, ...(scene.env ?? {}) };
      const settled = await Promise.all(
        urls.map((url, runIndex) =>
          runSandbox(patchSource, { baseUrl: url, environmentName: this.environmentName, env, seed: repetitionSeed(scene.sceneId, rep, runIndex), timeoutMs: this.sandboxTimeoutMs })
            .then((outcome) => ({ ok: true as const, outcome }))
            .catch((err: Error) => ({ ok: false as const, err }))
            .finally(() => this.proxy.runFinished(runIndex)),
        ),
      );
      const hits = this.proxy.hits();
      let repPassed = true;
      for (let runIndex = 0; runIndex < settled.length; runIndex++) {
        const s = settled[runIndex];
        const runHits = hits.filter((h) => h.runIndex === runIndex);
        const tag = concurrency > 1 ? `run ${runIndex + 1}/${concurrency}: ` : "";
        if (!s.ok) {
          const msg = s.err?.message ?? String(s.err);
          push({ kind: "step", what: `${tag}sandbox error: ${msg.split("\n")[0].slice(0, 200)}`, outcome: "failed" });
          return this.uncertain(scene, `sandbox could not run the check: ${msg.split("\n")[0].slice(0, 200)}`, rep, mergedTrace, environment);
        }
        const outcome: SandboxOutcome = s.outcome;
        for (const r of outcome.results) for (const t of r.trace) push({ ...t, what: tag ? `${tag}${t.what}` : t.what });
        push({ kind: "step", what: `${tag}${runHits.length} request(s) reached the proxy → ${hits.length ? summarize(runHits) : "none"}`, outcome: runHits.length ? "ok" : "skipped" });
        if (runHits.length === 0) {
          // The executor's own count, independent of anything inside the sandbox.
          return this.uncertain(scene, `${tag}no request reached ENVIRONMENT_URL — nothing was observed in this scene state`, rep + 1, mergedTrace, environment);
        }
        if (outcome.vacuous) return this.uncertain(scene, `${tag}${outcome.vacuousReason ?? "vacuous run"}`, rep + 1, mergedTrace, environment);
        if (!outcome.passed) repPassed = false;
      }
      observedOutcomes.push(repPassed ? "pass" : "fail");
      if (this.verbose) {
        console.error(`[scene] ${scene.sceneId} rep=${rep + 1}/${reps} concurrency=${concurrency} observed=${repPassed ? "pass" : "fail"} expected=${sceneExpected(scene).observed} hits=${hits.length} (${environment})`);
      }
    }

    const uniq = new Set(observedOutcomes);
    if (uniq.size > 1) {
      this.nondeterministicScenes.push(scene.sceneId);
      const passes = observedOutcomes.filter((o) => o === "pass").length;
      return this.uncertain(scene, `repetitions disagreed (pass×${passes}, fail×${observedOutcomes.length - passes} over ${observedOutcomes.length} runs) — non-deterministic`, observedOutcomes.length, mergedTrace, environment);
    }
    if (observedOutcomes.length === 0) return this.uncertain(scene, "no run executed", 0, mergedTrace, environment);
    const observed: ObservationValue = observedOutcomes[0];
    return { sceneId: scene.sceneId, observed, repetitions: observedOutcomes.length, trace: mergedTrace, source: "scene", environment };
  }

  async close(): Promise<void> {
    await this.proxy.close();
  }
}

function summarize(hits: Array<{ method: string; path: string; status: number; source: string }>): string {
  return hits.map((h) => `${h.method} ${h.path} ${h.status}${h.source === "target" ? "" : ` (${h.source})`}`).join(", ");
}

/** Detect the "change account/region/env to dodge" vector (threat row + STING
 * class 4): patch swaps credential constants, or starts generating accounts at
 * runtime (per-run sessions), dodging the shared-account semantics the incident
 * depends on. Deterministic, code-derived. Compares the SET of distinct
 * credential-bearing statements, so a fix that merely reuses the same account
 * in more requests is not a dodge. */
export function detectEnvScopeDodge(original: string, patched: string): string | null {
  const ACCOUNT_TOKEN = /\b(?:account|username|email|user|ACCOUNT|USERNAME|EMAIL|TEST_USER)\b\s*[:=]/;
  const GEN = /Date\.now\(\)|Math\.random\(\)|randomUUID\(\)|crypto\.random/;

  const credentialLines = (src: string) => src.split("\n").filter((l) => ACCOUNT_TOKEN.test(l));
  const origLines = credentialLines(original);
  const newLines = credentialLines(patched);

  const genLine = newLines.find((l) => GEN.test(l));
  if (genLine) {
    return `account/credential generated at runtime (${genLine.trim().slice(0, 60)}) — dodges the shared-account failure; envAssumption "single shared account" violated`;
  }
  const distinct = (lines: string[]) => [...new Set(lines.map((l) => l.trim().replace(/\s+/g, " ")))].sort();
  if (JSON.stringify(distinct(origLines)) !== JSON.stringify(distinct(newLines))) {
    return "account/credential constant changed — dodges the shared-account failure; envAssumption 'single shared account' violated";
  }
  return null;
}
