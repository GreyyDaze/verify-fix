// Synthetic experiment executor — synthetic-first proof (prod PRD §11.1,
// success #7). Drives an incident-provided deterministic app simulator
// (app-sim.ts) into each scene state, runs the patched check through the
// sandbox, and records observed outcomes. Production swaps this for the
// Checkly executor (PR-1) without touching the decision table.

import { pathToFileURL } from "node:url";
import type {
  Bundle,
  ExperimentExecutor,
  Scene,
  SceneObservation,
  TraceStep,
} from "../types.ts";
import { runSandbox } from "../sandbox.ts";
import { sceneExpected } from "../contract/contract.ts";

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
  maxRunsPerScene?: number;
  account?: string;
  verbose?: boolean;
}

export function isSyntheticExecutor(e: ExperimentExecutor): e is SyntheticExecutor {
  return e.kind === "synthetic";
}

export class SyntheticExecutor implements ExperimentExecutor {
  readonly kind = "synthetic" as const;
  readonly appSimPath: string;
  private sim: AppSim | null = null;
  private baseUrl = "";
  private used = new Map<string, number>();
  readonly maxRunsPerScene: number;
  readonly account: string;
  nondeterministicScenes: string[] = [];
  budgetExhausted = false;
  verbose: boolean;

  constructor(appSimPath: string, opts: SyntheticExecutorOptions = {}) {
    this.appSimPath = appSimPath;
    this.maxRunsPerScene = opts.maxRunsPerScene ?? 10;
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

  private async ensureSim(): Promise<string> {
    if (this.sim) return this.baseUrl;
    const mod = (await import(pathToFileURL(this.appSimPath).href)) as {
      default?: () => Promise<AppSim>;
    };
    if (!mod.default) throw new Error(`app-sim at ${this.appSimPath} must default-export create(): Promise<AppSim>`);
    this.sim = await mod.default();
    this.baseUrl = await this.sim.start();
    return this.baseUrl;
  }

  async runScene(bundle: Bundle, patchSource: string, scene: Scene): Promise<SceneObservation> {
    const budget = this.maxRunsPerScene;
    const wantedRuns = Math.min(scene.experiments[0]?.repetitions ?? 1, budget);
    const usedSoFar = this.used.get(scene.sceneId) ?? 0;
    const canRun = Math.max(0, budget - usedSoFar);
    if (canRun <= 0) {
      this.budgetExhausted = true;
      return {
        sceneId: scene.sceneId,
        observed: "pass", // never reachable as PASS: orchestrator treats exhausted as UNCERTAIN (PR-10)
        repetitions: 0,
        trace: [],
        source: "synthetic",
      };
    }
    const runs = Math.max(1, Math.min(wantedRuns, canRun));
    this.used.set(scene.sceneId, usedSoFar + runs);

    const baseUrl = await this.ensureSim();
    await this.sim!.drive(scene);

    const observedOutcomes: Array<"pass" | "fail"> = [];
    let mergedTrace: TraceStep[] = [];
    let index = 0;

    for (let i = 0; i < runs; i++) {
      // Concurrency is expressed by the app-sim's deterministic state (the
      // scene's drive arms the overlap phantom), so each repetition is one
      // sandboxed run — repeatable, not raced.
      const concurrentRuns = 1;
      const account = scene.type === "REGRESSION" ? `${this.account}-r${i}` : this.account;
      const outcome = await runSandbox(patchSource, {
        baseUrl,
        account,
        concurrentRuns,
      });
      const passed = outcome.passed;
      observedOutcomes.push(passed ? "pass" : "fail");
      for (const r of outcome.results) {
        for (const t of r.trace) {
          mergedTrace.push({ ...t, index: index++ });
        }
      }
      if (this.verbose) {
        const expected = sceneExpected(scene);
        console.error(`[synthetic] scene=${scene.sceneId} run=${i + 1}/${runs} observed=${passed ? "pass" : "fail"} expected=${expected.observed}`);
      }
    }

    const uniq = new Set(observedOutcomes);
    if (uniq.size > 1) this.nondeterministicScenes.push(scene.sceneId);

    return {
      sceneId: scene.sceneId,
      observed: observedOutcomes[observedOutcomes.length - 1] ?? "pass",
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
 * depends on. Deterministic, code-derived. */
export function detectEnvScopeDodge(original: string, patched: string): string | null {
  const ACCOUNT_TOKEN = /\b(?:account|username|email|user|ACCOUNT|USERNAME|EMAIL)\b\s*[:=]/;
  const GEN = /Date\.now\(\)|Math\.random\(\)|randomUUID\(\)|crypto\.random/;

  const origLines = original.split("\n").filter((l) => ACCOUNT_TOKEN.test(l));
  const newLines = patched.split("\n").filter((l) => ACCOUNT_TOKEN.test(l));

  const genLine = newLines.find((l) => GEN.test(l));
  if (genLine) {
    return `account/credential generated at runtime (${genLine.trim().slice(0, 60)}) — dodges the shared-account failure; envAssumption "single shared account" violated`;
  }
  const haveSameAccountConstants = (a: string[], b: string[]) =>
    JSON.stringify(a.length === 0 ? [] : a) === JSON.stringify(b.length === 0 ? [] : b);
  if (!haveSameAccountConstants(origLines, newLines)) {
    return "account/credential constant changed — dodges the shared-account failure; envAssumption 'single shared account' violated";
  }
  return null;
}