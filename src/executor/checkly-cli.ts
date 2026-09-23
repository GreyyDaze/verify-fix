// Remote scene executor for Phase 5.
//
// HEALTHY and REGRESSION scenes execute the candidate through the customer's
// own Checkly CLI. `checkly test` uploads the pull-request source as a recorded
// test session. It never deploys or changes a scheduled monitor.

import { runChecklySandbox } from "../checkly-sandbox.ts";
import { emptyExecutionCost, type Bundle, type ExecutionCost, type ExperimentExecutor, type ObservationValue, type RunContext, type Scene, type SceneObservation, type TraceStep } from "../types.ts";

export interface ChecklyCliExecutorOptions {
  target: string | null;
  projectDir: string | null;
  env?: Record<string, string>;
  environmentName?: string;
  targetRevision?: string;
  maxRunsPerScene?: number;
  timeoutMs?: number;
  verbose?: boolean;
}

export class ChecklyCliExecutor implements ExperimentExecutor {
  readonly kind = "checkly" as const;
  readonly nondeterministicScenes: string[] = [];
  budgetExhausted = false;
  private readonly target: string | null;
  private readonly projectDir: string | null;
  private readonly env: Record<string, string>;
  private readonly targetRevision: string | undefined;
  private readonly maxRunsPerScene: number;
  private readonly timeoutMs: number | undefined;
  private readonly verbose: boolean;
  private readonly used = new Map<string, number>();
  private readonly cost: ExecutionCost = emptyExecutionCost();

  constructor(opts: ChecklyCliExecutorOptions) {
    this.target = opts.target ? opts.target.replace(/\/+$/, "") : null;
    this.projectDir = opts.projectDir;
    this.env = { ...(opts.env ?? {}), ...(opts.environmentName ? { ENVIRONMENT_NAME: opts.environmentName } : {}) };
    this.targetRevision = opts.targetRevision;
    this.maxRunsPerScene = opts.maxRunsPerScene ?? 10;
    this.timeoutMs = opts.timeoutMs;
    this.verbose = opts.verbose ?? false;
  }

  isLive(): boolean {
    return Boolean(this.target && this.projectDir);
  }

  costReport(): ExecutionCost {
    return { ...this.cost, scenes: this.used.size, runs: this.cost.checklyCloudRuns, checklySessionIds: [...this.cost.checklySessionIds], checklyResultIds: [...this.cost.checklyResultIds], byScene: this.cost.byScene.map((row) => ({ ...row })) };
  }

  private uncertain(scene: Scene, reason: string, repetitions: number, trace: TraceStep[], sessions: string[], results: string[], environment: string): SceneObservation {
    if (this.verbose) console.error(`[checkly] ${scene.sceneId} observed=uncertain — ${reason}`);
    return { sceneId: scene.sceneId, observed: "uncertain", repetitions, trace, source: "checkly", reason, environment, checklySessionIds: sessions, checklyResultIds: results };
  }

  async runScene(bundle: Bundle, patchSource: string, scene: Scene, ctx?: RunContext): Promise<SceneObservation> {
    const environment = this.target ? `checkly cloud → target ${new URL(this.target).host}` : "checkly cloud → no target";
    if (scene.type !== "HEALTHY" && scene.type !== "REGRESSION") {
      return this.uncertain(scene, `Checkly CLI executor does not run ${scene.type} scenes`, 0, [], [], [], environment);
    }
    if (!this.target) return this.uncertain(scene, "remote scene needs --target <url>", 0, [], [], [], environment);
    if (!this.projectDir) return this.uncertain(scene, "remote scene needs --project <dir>", 0, [], [], [], environment);
    if (!process.env.CHECKLY_API_KEY) {
      return this.uncertain(scene, "remote scene needs CHECKLY_API_KEY in the environment", 0, [], [], [], environment);
    }

    const used = this.used.get(scene.sceneId) ?? 0;
    const wanted = scene.experiments[0]?.repetitions ?? 1;
    const remaining = Math.max(0, this.maxRunsPerScene - used);
    if (remaining === 0) {
      this.budgetExhausted = true;
      return this.uncertain(scene, `run budget exhausted (${used}/${this.maxRunsPerScene} repetitions)`, 0, [], [], [], environment);
    }
    const repetitions = Math.min(wanted, remaining);
    this.used.set(scene.sceneId, used + repetitions);

    const config = ctx?.config ?? bundle.config;
    const locations = config?.locations.length ? config.locations : bundle.config?.locations ?? [];
    if (locations.length === 0) return this.uncertain(scene, "candidate config has no Checkly location", 0, [], [], [], environment);
    const files = { ...bundle.files, ...(ctx?.files ?? {}), [bundle.check.file]: patchSource };
    const checkName = bundle.check.name ?? bundle.check.logicalId;
    if (!checkName) return this.uncertain(scene, "bundle has no check name for Checkly --grep", 0, [], [], [], environment);

    const trace: TraceStep[] = [];
    const sessions: string[] = [];
    const resultIds: string[] = [];
    const outcomes: Array<"pass" | "fail"> = [];
    let traceIndex = 0;
    const costRow = {
      sceneId: scene.sceneId,
      executor: "checkly" as const,
      repetitions: 0,
      checkRuns: 0,
      wallTimeMs: 0,
      phase: (ctx?.phase ?? "candidate") as "candidate" | "mutation",
    };
    this.cost.byScene.push(costRow);

    for (let repetition = 0; repetition < repetitions; repetition++) {
      const results = await Promise.all(locations.map((location) => runChecklySandbox({
        projectDir: this.projectDir!,
        files,
        target: this.target!,
        targetRevision: this.targetRevision,
        env: { ...this.env, ...(scene.env ?? {}) },
        location,
        checkName,
        testSessionName: `verify-fix ${bundle.incidentId} ${scene.sceneId} ${repetition + 1}/${repetitions} ${location}`,
        timeoutMs: this.timeoutMs,
      }).catch((error: Error) => ({
        passed: false,
        inconclusive: true,
        reason: `Checkly CLI could not run: ${error.message}`,
        testSessionId: null,
        checkResultIds: [],
        cloudRuns: 0,
        trace: [] as TraceStep[],
        exitCode: null,
        wallTimeMs: 0,
        raw: "",
      }))));

      costRow.repetitions += 1;
      costRow.checkRuns += results.reduce((sum, result) => sum + result.cloudRuns, 0);
      costRow.wallTimeMs += Math.max(0, ...results.map((result) => result.wallTimeMs));
      this.cost.checklyTestSessions += results.filter((result) => result.testSessionId).length;
      this.cost.checklyCloudRuns += results.reduce((sum, result) => sum + result.cloudRuns, 0);
      this.cost.wallTimeMs += Math.max(0, ...results.map((result) => result.wallTimeMs));
      if (costRow.phase === "mutation") this.cost.mutationRuns += results.reduce((sum, result) => sum + result.cloudRuns, 0);

      for (const result of results) {
        if (result.testSessionId) sessions.push(result.testSessionId);
        resultIds.push(...result.checkResultIds);
      }
      this.cost.checklySessionIds.push(...results.flatMap((result) => result.testSessionId ? [result.testSessionId] : []));
      this.cost.checklyResultIds.push(...results.flatMap((result) => result.checkResultIds));
      for (let i = 0; i < results.length; i++) {
        const result = results[i];
        const location = locations[i];
        for (const item of result.trace) trace.push({ ...item, index: traceIndex++, what: `${location}: ${item.what}` });
        trace.push({
          index: traceIndex++,
          kind: "step",
          what: `${location}: recorded Checkly session ${result.testSessionId ?? "missing"}; cloud runs ${result.cloudRuns}; wall ${(result.wallTimeMs / 1000).toFixed(1)}s`,
          outcome: result.inconclusive ? "skipped" : result.passed ? "ok" : "failed",
        });
        if (result.inconclusive) return this.uncertain(scene, `${location}: ${result.reason ?? "no admissible Checkly result"}`, repetition + 1, trace, sessions, resultIds, `${environment} (${locations.join(", ")})`);
      }

      const passed = results.every((result) => result.passed);
      outcomes.push(passed ? "pass" : "fail");
      if (this.verbose) console.error(`[checkly] ${scene.sceneId} rep=${repetition + 1}/${repetitions} locations=${locations.join(",")} observed=${passed ? "pass" : "fail"}`);
    }

    const unique = new Set(outcomes);
    if (unique.size > 1) {
      this.nondeterministicScenes.push(scene.sceneId);
      const passes = outcomes.filter((value) => value === "pass").length;
      return this.uncertain(scene, `repetitions disagreed (pass×${passes}, fail×${outcomes.length - passes})`, outcomes.length, trace, sessions, resultIds, `${environment} (${locations.join(", ")})`);
    }
    const observed: ObservationValue = outcomes[0] ?? "uncertain";
    return { sceneId: scene.sceneId, observed, repetitions: outcomes.length, trace, source: "checkly", environment: `${environment} (${locations.join(", ")})`, checklySessionIds: sessions, checklyResultIds: resultIds };
  }
}
