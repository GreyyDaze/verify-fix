// Synthetic experiment executor — synthetic-first proof (prod PRD §11.1,
// success #7). Drives an incident-provided deterministic app simulator
// (app-sim.ts) into each scene state, runs the patched check through the
// sandbox, and records observed outcomes. Production swaps this for the
// Checkly executor (PR-1) without touching the decision table.
//
// Evidence gate: a scene observation is admitted as pass/fail ONLY when every
// repetition proved it exercised the armed sim (≥1 request reached the armed
// baseUrl, per the DSL trace in the sandbox's JSON outcome). A hitless or
// crashed run, an exhausted budget, or repetitions that disagree all yield
// observed="uncertain" with an explicit reason — never a silent pass.

import { pathToFileURL } from "node:url";
import type {
  Bundle,
  ExperimentExecutor,
  ObservationValue,
  Scene,
  SceneObservation,
  TraceStep,
} from "../types.ts";
import { runSandbox, type SandboxOutcome } from "../sandbox.ts";
import { sceneExpected } from "../contract/contract.ts";
import { fnv1a } from "../assertion/id.ts";

/** Reproducible per-repetition randomness seed: same scene + repetition → same seed. */
export function repetitionSeed(sceneId: string, repetition: number): number {
  return parseInt(fnv1a(`${sceneId}:${repetition}`), 16) >>> 0;
}

/** Contract between verify-fix and the incident's app simulator. Implemented by
 * the fixture's app-sim.ts, and by the real app's deterministic state entrances
 * in production. */
export interface AppSim {
  start(): Promise<string>;
  /** Put the app into the scene's state (deterministic entrypoint). */
  drive(scene: Scene): Promise<void>;
  close(): Promise<void>;
}

export interface SyntheticExecutorOptions {
  /** Per-scene run cap. Defaults to the bundle's declared runBudget.maxPerScene. */
  maxRunsPerScene?: number;
  account?: string;
  verbose?: boolean;
}

/** Fallback cap when neither the option nor the bundle declares one. */
export const DEFAULT_MAX_RUNS_PER_SCENE = 10;

export function isSyntheticExecutor(e: ExperimentExecutor): e is SyntheticExecutor {
  return e.kind === "synthetic";
}

export class SyntheticExecutor implements ExperimentExecutor {
  readonly kind = "synthetic" as const;
  readonly appSimPath: string;
  private sim: AppSim | null = null;
  private baseUrl = "";
  private used = new Map<string, number>();
  /** explicit override; null = honor bundle.runBudget.maxPerScene */
  readonly maxRunsPerScene: number | null;
  readonly account: string;
  nondeterministicScenes: string[] = [];
  budgetExhausted = false;
  /** scenes whose runs produced no admissible evidence, with the reason */
  inconclusiveScenes: Array<{ sceneId: string; reason: string }> = [];
  verbose: boolean;

  constructor(appSimPath: string, opts: SyntheticExecutorOptions = {}) {
    this.appSimPath = appSimPath;
    this.maxRunsPerScene = opts.maxRunsPerScene ?? null;
    this.account = opts.account ?? "demo";
    this.verbose = opts.verbose ?? false;
  }

  isLive(): boolean {
    return false;
  }

  costReport(): { scenes: number; runs: number } {
    return {
      scenes: this.used.size,
      runs: [...this.used.values()].reduce((a, b) => a + b, 0),
    };
  }

  budgetFor(bundle: Bundle): number {
    const declared = bundle.runBudget?.maxPerScene;
    return this.maxRunsPerScene ?? (typeof declared === "number" && declared > 0 ? declared : DEFAULT_MAX_RUNS_PER_SCENE);
  }

  private async ensureSim(): Promise<string> {
    if (this.sim) return this.baseUrl;
    if (!this.appSimPath) throw new Error("synthetic executor requires an app-sim.ts in the bundle directory");
    const mod = (await import(pathToFileURL(this.appSimPath).href)) as {
      default?: () => Promise<AppSim>;
    };
    if (!mod.default) throw new Error(`app-sim at ${this.appSimPath} must default-export create(): Promise<AppSim>`);
    this.sim = await mod.default();
    this.baseUrl = await this.sim.start();
    return this.baseUrl;
  }

  private uncertain(scene: Scene, reason: string, repetitions: number, trace: TraceStep[]): SceneObservation {
    this.inconclusiveScenes.push({ sceneId: scene.sceneId, reason });
    if (this.verbose) console.error(`[synthetic] scene=${scene.sceneId} observed=uncertain — ${reason}`);
    return { sceneId: scene.sceneId, observed: "uncertain", repetitions, trace, source: "synthetic", reason };
  }

  async runScene(bundle: Bundle, patchSource: string, scene: Scene): Promise<SceneObservation> {
    const budget = this.budgetFor(bundle);
    const wantedRuns = Math.min(scene.experiments[0]?.repetitions ?? 1, budget);
    const usedSoFar = this.used.get(scene.sceneId) ?? 0;
    const canRun = Math.max(0, budget - usedSoFar);
    if (canRun <= 0) {
      this.budgetExhausted = true;
      // No run happened, so there is no observation. Reported as uncertain —
      // the decision table maps it to UNCERTAIN (PR-10), never PASS.
      return this.uncertain(scene, `run budget exhausted (${usedSoFar}/${budget} runs used for this scene)`, 0, []);
    }
    const runs = Math.max(1, Math.min(wantedRuns, canRun));
    this.used.set(scene.sceneId, usedSoFar + runs);

    const baseUrl = await this.ensureSim();
    await this.sim!.drive(scene);

    const observedOutcomes: Array<"pass" | "fail"> = [];
    const mergedTrace: TraceStep[] = [];
    let index = 0;
    const merge = (outcome: SandboxOutcome) => {
      for (const r of outcome.results) {
        for (const t of r.trace) mergedTrace.push({ ...t, index: index++ });
      }
    };

    for (let i = 0; i < runs; i++) {
      // Concurrency is expressed by the app-sim's deterministic state (the
      // scene's drive arms the overlap phantom), so each repetition is one
      // sandboxed run — repeatable, not raced.
      const concurrentRuns = 1;
      const account = scene.type === "REGRESSION" ? `${this.account}-r${i}` : this.account;
      let outcome: SandboxOutcome;
      try {
        outcome = await runSandbox(patchSource, { baseUrl, account, concurrentRuns, seed: repetitionSeed(scene.sceneId, i) });
      } catch (e) {
        // The check could not be executed at all (syntax error, crash, hang).
        // That is not a failing check — it is missing evidence.
        const msg = (e as Error)?.message ?? String(e);
        mergedTrace.push({ index: index++, kind: "step", what: `sandbox error: ${msg.split("\n")[0].slice(0, 200)}`, outcome: "failed" });
        return this.uncertain(scene, `sandbox could not run the check: ${msg.split("\n")[0].slice(0, 200)}`, i, mergedTrace);
      }
      merge(outcome);
      if (outcome.vacuous) {
        // The DSL never reached the armed sim: nothing was observed in this
        // scene state, so neither the pass nor the fail oracle can be satisfied.
        return this.uncertain(scene, outcome.vacuousReason ?? "DSL did not contact armed sim", i + 1, mergedTrace);
      }
      const passed = outcome.passed;
      observedOutcomes.push(passed ? "pass" : "fail");
      if (this.verbose) {
        const expected = sceneExpected(scene);
        console.error(
          `[synthetic] scene=${scene.sceneId} run=${i + 1}/${runs} observed=${passed ? "pass" : "fail"} expected=${expected.observed} simHits=${outcome.simHits}`
        );
      }
    }

    const uniq = new Set(observedOutcomes);
    if (uniq.size > 1) {
      // Repetitions disagreed: the check is flaky in this state. Reporting the
      // last outcome would make the verdict a coin flip; report no outcome.
      this.nondeterministicScenes.push(scene.sceneId);
      const passes = observedOutcomes.filter((o) => o === "pass").length;
      return this.uncertain(
        scene,
        `repetitions disagreed (pass×${passes}, fail×${observedOutcomes.length - passes} over ${observedOutcomes.length} runs) — non-deterministic`,
        observedOutcomes.length,
        mergedTrace
      );
    }

    if (observedOutcomes.length === 0) return this.uncertain(scene, "no run executed", 0, mergedTrace);
    const observed: ObservationValue = observedOutcomes[0];
    return {
      sceneId: scene.sceneId,
      observed,
      repetitions: observedOutcomes.length,
      trace: mergedTrace,
      source: "synthetic",
    };
  }

  async close(): Promise<void> {
    if (this.sim) await this.sim.close();
    this.sim = null;
  }
}

/** Detect the "change account/region/env to dodge" vector (threat row + STING
 * class 4): patch swaps credential constants, or starts generating accounts at
 * runtime (per-run sessions), dodging the shared-account semantics the incident
 * depends on. Deterministic, code-derived. Compares the SET of distinct
 * credential-bearing statements, so a fix that merely reuses the same account
 * in more requests (e.g. lock/unlock bodies) is not a dodge. */
export function detectEnvScopeDodge(original: string, patched: string): string | null {
  const ACCOUNT_TOKEN = /\b(?:account|username|email|user|ACCOUNT|USERNAME|EMAIL)\b\s*[:=]/;
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
