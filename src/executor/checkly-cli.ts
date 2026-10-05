// Remote scene executor for Phase 5.
//
// HEALTHY and REGRESSION scenes execute the candidate through the customer's
// own Checkly CLI. `checkly test` uploads the pull-request source as a recorded
// test session. It never deploys or changes a scheduled monitor.

import { runChecklySandbox } from "../checkly-sandbox.ts";
import { regionalAccountMappingFromBundle, trustedAutomationBypass, trustedRegionalAccounts } from "../multistep/accounts.ts";
import { multiStepDiskRebound } from "../multistep/rebind.ts";
import { evaluateMultiStepPolicy } from "../multistep/policy.ts";
import { parseMultiStepProject } from "../multistep/source.ts";
import { deriveRegionalAccountMapping, sameRegionAccountMapping } from "../multistep/region-account-mapping.ts";
import { emptyExecutionCost, type Bundle, type ExecutionCost, type ExperimentExecutor, type ObservationValue, type RunContext, type Scene, type SceneObservation, type TraceStep } from "../types.ts";

/** Only the identities required by the checked Multistep construct and the
 * approved bypass/name may cross into a cloud checkly-test child. The shared
 * input file also holds browser/API credentials; those must never be sent to
 * a Multistep test session. The sandbox binds ENVIRONMENT_URL to its exact
 * trusted target separately. Null is an inconclusive pre-run rejection. */
export function scopedChecklyEnvironment(bundle: Bundle, env: Record<string, string>, region?: string): Record<string, string> | null {
  if (bundle.check.checkType !== "MULTI_STEP") return { ...env };
  let mapping = regionalAccountMappingFromBundle(bundle);
  // Older/synthetic bundles may not yet carry the v3 protected mapping.
  // Derive only the secret-free regional key names from the supplied environment
  // as a compatibility path; values still go through trustedRegionalAccounts,
  // which requires every regional value to be present, trimmed and distinct.
  if (!mapping) {
    const inferred: Record<string, string> = {};
    for (const key of Object.keys(env)) {
      const match = /^MULTISTEP_USER_([A-Za-z0-9_]+)$/.exec(key);
      if (!match) continue;
      const location = match[1]!.toLowerCase().replaceAll("_", "-");
      if (inferred[location] !== undefined) return null;
      inferred[location] = key;
    }
    if (Object.keys(inferred).length === 0) return null;
    mapping = inferred;
  }
  const locations = bundle.config?.locations.length ? bundle.config.locations : Object.keys(mapping);
  if (!mapping || !locations.length || Object.keys(mapping).length !== locations.length
    || locations.some((location) => mapping![location] === undefined)) return null;
  const accounts = trustedRegionalAccounts(env, mapping, locations, region);
  if (!accounts || !trustedAutomationBypass(env)) return null;
  const names = [...new Set([
    ...(region ? [accounts.selectedKey!] : Object.values(mapping)),
    "CHECKLY_SECRET_VERCEL_AUTOMATION_BYPASS_SECRET",
    "ENVIRONMENT_NAME",
  ])];
  return Object.fromEntries(names.filter((key) => env[key] !== undefined).map((key) => [key, env[key]!]));
}

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
    let host: string | null = null;
    if (this.target) {
      try {
        const parsed = new URL(this.target);
        if (parsed.protocol !== "https:" || parsed.origin !== this.target || parsed.username || parsed.password) {
          throw new Error("invalid target");
        }
        host = parsed.host;
      } catch {
        return this.uncertain(scene, "remote scene needs a bare HTTPS target origin", 0, [], [], [],
          "checkly cloud → invalid target");
      }
    }
    const environment = host ? `checkly cloud → target ${host}` : "checkly cloud → no target";
    if (scene.type !== "HEALTHY" && scene.type !== "REGRESSION") {
      return this.uncertain(scene, `Checkly CLI executor does not run ${scene.type} scenes`, 0, [], [], [], environment);
    }
    if (!this.target) return this.uncertain(scene, "remote scene needs --target <url>", 0, [], [], [], environment);
    if (!this.projectDir) return this.uncertain(scene, "remote scene needs --project <dir>", 0, [], [], [], environment);
    if (!process.env.CHECKLY_API_KEY || !/^[A-Za-z0-9_-]{1,128}$/.test(process.env.CHECKLY_ACCOUNT_ID ?? "")) {
      return this.uncertain(scene, "remote scene needs an approved Checkly API key and account ID", 0, [], [], [], environment);
    }
    const isMultiStep = bundle.check.checkType === "MULTI_STEP";
    if (isMultiStep && (!multiStepDiskRebound(bundle)
      || !bundle.scenes.some((item) => JSON.stringify(item) === JSON.stringify(scene)))) {
      return this.uncertain(scene, "Multistep on-disk authority or scene changed before a cloud run", 0, [], [], [], environment);
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

    // Trusted experiment requirements come from the bundle; candidate config
    // cannot shrink locations or concurrency for a cloud execution.
    const config = bundle.config ?? ctx?.config ?? null;
    const locations = config?.locations.length ? config.locations : bundle.config?.locations ?? [];
    if (locations.length === 0) return this.uncertain(scene, "candidate config has no Checkly location", 0, [], [], [], environment);
    const combinedEnv = { ...this.env, ...(scene.env ?? {}) };
    const trustedMapping = regionalAccountMappingFromBundle(bundle);
    const regionalKeys = trustedMapping ? Object.values(trustedMapping) : [];
    if (bundle.check.checkType === "MULTI_STEP" && Object.keys(scene.env ?? {}).some((key) => !regionalKeys.includes(key))) {
      return this.uncertain(scene, "Multistep scene cannot add unrelated cloud environment inputs", 0, [], [], [], environment);
    }
    const scopedEnv = scopedChecklyEnvironment(bundle, combinedEnv);
    if (scopedEnv === null) {
      return this.uncertain(scene, "Multistep regional cloud identities are missing or overlap", 0, [], [], [], environment);
    }
    const checkFile = ctx?.checkFile ?? bundle.check.file;
    const files = { ...(ctx?.files ?? bundle.files), [checkFile]: patchSource };
    const checkName = ctx?.checkName ?? bundle.check.name ?? bundle.check.logicalId;
    if (!checkName) return this.uncertain(scene, "bundle has no check name for Checkly --grep", 0, [], [], [], environment);
    if (isMultiStep) {
      const original = parseMultiStepProject(new Map(Object.entries(bundle.files)), bundle.check.file);
      const candidate = parseMultiStepProject(new Map(Object.entries(files)), checkFile);
      if (!original || !candidate) {
        return this.uncertain(scene, "Multistep trusted or candidate construct could not be resolved before a cloud run", 0, [], [], [], environment);
      }
      const policy = evaluateMultiStepPolicy(original, candidate);
      const trustedLocations = original.construct?.locations ?? [];
      const declared = original.construct?.environmentKeys ?? [];
      const originalMapping = deriveRegionalAccountMapping(Object.entries(bundle.files), trustedLocations, declared);
      const candidateMapping = deriveRegionalAccountMapping(Object.entries(files), trustedLocations, declared);
      const keys = Object.keys(bundle.files).sort();
      if (policy.rejected || policy.uncertain || checkFile !== bundle.check.file || checkName !== bundle.check.name
        || !trustedMapping || !originalMapping || !candidateMapping
        || !sameRegionAccountMapping(trustedMapping, originalMapping)
        || !sameRegionAccountMapping(originalMapping, candidateMapping)
        || JSON.stringify(Object.keys(files).sort()) !== JSON.stringify(keys)
        || keys.some((key) => key !== checkFile && files[key] !== bundle.files[key])) {
        return this.uncertain(scene, "Multistep source identity or construct changed before a cloud run", 0, [], [], [], environment);
      }
    }

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
      maxConcurrentRuns: locations.length,
      requiredRegions: [...locations],
      executedRegions: [] as string[],
    };
    this.cost.byScene.push(costRow);

    for (let repetition = 0; repetition < repetitions; repetition++) {
      costRow.executedRegions!.push(...locations.filter((location) => !costRow.executedRegions!.includes(location)));
      const results = await Promise.all(locations.map((location) => runChecklySandbox({
        projectDir: this.projectDir!,
        files,
        assets: ctx?.assets,
        target: this.target!,
        targetRevision: this.targetRevision,
        env: isMultiStep ? scopedChecklyEnvironment(bundle, combinedEnv, location)! : scopedEnv,
        location,
        checkName,
        checkType: bundle.check.checkType,
        testSessionName: `verify-fix ${bundle.incidentId} ${scene.sceneId} ${repetition + 1}/${repetitions} ${location}`,
        timeoutMs: this.timeoutMs,
      }).catch((error: Error) => ({
        passed: false,
        inconclusive: true,
        reason: "Checkly sandbox execution unavailable",
        testSessionId: null,
        checkResultIds: [],
        cloudRuns: 0,
        trace: [] as TraceStep[],
        exitCode: null,
        wallTimeMs: 0,
      }))));

      costRow.repetitions += 1;
      costRow.checkRuns += results.reduce((sum, result) => sum + result.cloudRuns, 0);
      costRow.wallTimeMs += Math.max(0, ...results.map((result) => result.wallTimeMs));
      this.cost.checklyTestSessions += results.filter((result) => result.testSessionId).length;
      this.cost.checklyCloudRuns += results.reduce((sum, result) => sum + result.cloudRuns, 0);
      this.cost.wallTimeMs += Math.max(0, ...results.map((result) => result.wallTimeMs));
      if (costRow.phase === "mutation") this.cost.mutationRuns += results.reduce((sum, result) => sum + result.cloudRuns, 0);

      for (const result of results) {
        if (result.testSessionId && sessions.includes(result.testSessionId)
          || result.checkResultIds.some((id) => resultIds.includes(id))) {
          return this.uncertain(scene, "duplicate Checkly session or result across distinct regional runs",
            repetition + 1, trace, sessions, resultIds, environment);
        }
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
