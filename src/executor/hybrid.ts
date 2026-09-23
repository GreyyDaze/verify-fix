// Phase 5 executor split.
//
// A real preview supplies all application behavior. REPRODUCTION and DETECTION
// run locally through the deterministic scene proxy. HEALTHY and REGRESSION
// run from Checkly's cloud through the customer's own CLI.

import { ChecklyCliExecutor, type ChecklyCliExecutorOptions } from "./checkly-cli.ts";
import { SceneExecutor, type SceneExecutorOptions } from "./scene.ts";
import { emptyExecutionCost, type Bundle, type ExecutionCost, type ExperimentExecutor, type RunContext, type Scene, type SceneObservation } from "../types.ts";

export interface HybridExecutorOptions extends Omit<SceneExecutorOptions, "target"> {
  target: string | null;
  targetRevision?: string;
  checklyTimeoutMs?: number;
}

export class HybridExecutor implements ExperimentExecutor {
  readonly kind = "hybrid" as const;
  readonly scene: SceneExecutor;
  readonly checkly: ChecklyCliExecutor;

  constructor(opts: HybridExecutorOptions) {
    this.scene = new SceneExecutor(opts);
    const remote: ChecklyCliExecutorOptions = {
      target: opts.target,
      projectDir: opts.projectDir ?? null,
      env: opts.env,
      environmentName: opts.environmentName,
      targetRevision: opts.targetRevision,
      maxRunsPerScene: opts.maxRunsPerScene,
      timeoutMs: opts.checklyTimeoutMs,
      verbose: opts.verbose,
    };
    this.checkly = new ChecklyCliExecutor(remote);
  }

  get budgetExhausted(): boolean {
    return this.scene.budgetExhausted || this.checkly.budgetExhausted;
  }

  get nondeterministicScenes(): string[] {
    return [...new Set([...this.scene.nondeterministicScenes, ...this.checkly.nondeterministicScenes])];
  }

  isLive(): boolean {
    return this.scene.isLive() && this.checkly.isLive();
  }

  async runScene(bundle: Bundle, patchSource: string, scene: Scene, ctx?: RunContext): Promise<SceneObservation> {
    return scene.type === "HEALTHY" || scene.type === "REGRESSION"
      ? this.checkly.runScene(bundle, patchSource, scene, ctx)
      : this.scene.runScene(bundle, patchSource, scene, ctx);
  }

  costReport(): ExecutionCost {
    const local = this.scene.costReport();
    const remote = this.checkly.costReport();
    const cost = emptyExecutionCost();
    cost.scenes = new Set([...local.byScene, ...remote.byScene].map((row) => `${row.phase}:${row.sceneId}`)).size;
    cost.runs = local.runs + remote.runs;
    cost.checklyTestSessions = remote.checklyTestSessions;
    cost.checklyCloudRuns = remote.checklyCloudRuns;
    cost.checklySessionIds = [...remote.checklySessionIds];
    cost.checklyResultIds = [...remote.checklyResultIds];
    cost.localRuns = local.localRuns;
    cost.browserProcesses = local.browserProcesses;
    cost.mutationRuns = local.mutationRuns + remote.mutationRuns;
    cost.wallTimeMs = local.wallTimeMs + remote.wallTimeMs;
    cost.byScene = [...local.byScene, ...remote.byScene];
    return cost;
  }

  async close(): Promise<void> {
    await this.scene.close();
  }
}
