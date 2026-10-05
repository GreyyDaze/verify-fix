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
import { emptyExecutionCost, type Bundle, type ExecutionCost, type ExperimentExecutor, type ObservationValue, type RunContext, type Scene, type SceneObservation, type TraceStep } from "../types.ts";
import { runSandbox } from "../sandbox.ts";
import { runPlaywrightSandbox } from "../playwright-sandbox.ts";
import { AUTOMATION_BYPASS_INPUT, trustedAutomationBypass, trustedRegionalAccounts } from "../multistep/accounts.ts";
import { trustedMultiStepDetection } from "../multistep/detection.ts";
import { multiStepDiskRebound } from "../multistep/rebind.ts";
import { runMultiStepSandbox } from "../multistep/executor.ts";
import { parseMultiStepProject } from "../multistep/source.ts";
import { deriveRegionalAccountMapping } from "../multistep/region-account-mapping.ts";
import { knownRoute } from "../multistep/routes.ts";
import { sceneExpected } from "../contract/contract.ts";
import { fnv1a } from "../assertion/id.ts";
import { effectiveConcurrency, needsTarget, parseMode, type ParsedMode } from "../scene/modes.ts";
import { SceneProxy, type ProxyHit } from "../scene/proxy.ts";
import type { Har } from "../trace/har-types.ts";
import { ApiSceneExecutor } from "../api/executor.ts";

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
  /** Customer project containing node_modules/@playwright/test. */
  projectDir?: string | null;
  /** Optional custom Chromium/Chrome binary (mainly CI/sandbox use). */
  browserExecutablePath?: string;
  /** Measurement hook. Called once for every completed scene repetition. */
  onRepetition?: (record: { sceneId: string; repetition: number; checkPassed: boolean; hits: ProxyHit[] }) => void;
}

/** Fallback cap when neither the option nor the bundle declares one. */
export const DEFAULT_MAX_RUNS_PER_SCENE = 10;

interface CandidateOutcome {
  passed: boolean;
  inconclusive: boolean;
  reason: string | null;
  trace: TraceStep[];
  /** Null if the run never yielded a browser-process measurement. */
  browserProcesses?: number | null;
}

export function multistepRegionForLocation(location: string): string | null {
  return typeof location === "string" && location.length > 0 && location.length <= 256
    && !/[\u0000-\u001f\u007f]/.test(location) ? location : null;
}

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
  private readonly projectDir: string | null;
  private readonly browserExecutablePath: string | undefined;
  private readonly onRepetition: SceneExecutorOptions["onRepetition"];
  private readonly proxy = new SceneProxy();
  private readonly apiExecutor: ApiSceneExecutor;
  private used = new Map<string, number>();
  private readonly cost: ExecutionCost = emptyExecutionCost();
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
    this.projectDir = opts.projectDir ?? null;
    this.browserExecutablePath = opts.browserExecutablePath;
    this.onRepetition = opts.onRepetition;
    this.apiExecutor = new ApiSceneExecutor({ target: this.target, env: this.env, maxRunsPerScene: opts.maxRunsPerScene, verbose: this.verbose });
  }

  isLive(): boolean {
    return this.target !== null;
  }

  costReport(): ExecutionCost {
    const api = this.apiExecutor.costReport();
    return {
      ...this.cost,
      scenes: this.used.size + api.scenes,
      runs: this.cost.localRuns + api.localRuns,
      localRuns: this.cost.localRuns + api.localRuns,
      browserProcesses: this.cost.browserProcesses + api.browserProcesses,
      ...(this.cost.multiStepBrowserCounts ? { multiStepBrowserCounts: [...this.cost.multiStepBrowserCounts] } : {}),
      httpRequests: (this.cost.httpRequests ?? 0) + (api.httpRequests ?? 0),
      mutationRuns: this.cost.mutationRuns + api.mutationRuns,
      wallTimeMs: this.cost.wallTimeMs + api.wallTimeMs,
      checklySessionIds: [...this.cost.checklySessionIds],
      checklyResultIds: [...this.cost.checklyResultIds],
      byScene: [...this.cost.byScene.map((row) => ({ ...row })), ...api.byScene],
    };
  }

  budgetFor(bundle: Bundle): number {
    const declared = bundle.runBudget?.maxPerScene;
    return this.maxRunsPerScene ?? (typeof declared === "number" && declared > 0 ? declared : DEFAULT_MAX_RUNS_PER_SCENE);
  }

  /** The label the report shows in its environment column. */
  environmentLabel(bundle: Bundle, scene: Scene, mode: ParsedMode, concurrency: number, replayBrowserAssets = false): string {
    const host = this.target ? new URL(this.target).host : "no target";
    switch (mode.kind) {
      case "live":
        return `target ${host} (live)`;
      case "live-concurrent":
        return `target ${host} (live-concurrent:${concurrency}${concurrency < mode.concurrency ? ` of ${mode.concurrency}, schedule allows ${concurrency}` : ""})`;
      case "inject":
        return `target ${host} + inject ${mode.rule.raw}`;
      case "multistep-detection":
        return `target ${host} + trusted HTTP-200 nested booking confirmation mutation`;
      case "replay":
        return replayBrowserAssets && this.target
          ? `recording ${mode.har} + target ${new URL(this.target).host} (browser assets)`
          : `recording ${mode.har}`;
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

  private async runCandidate(bundle: Bundle, patchSource: string, ctx: RunContext | undefined, url: string, env: Record<string, string>, seed: number,
    detectionScene: Scene | null = null): Promise<CandidateOutcome> {
    const checkFile = ctx?.checkFile ?? bundle.check.file;
    if (bundle.check.checkType === "MULTI_STEP") {
      // The Multistep runner uses Playwright's API request fixture only —
      // the adapter never configures or launches a browser.
      if (!this.projectDir) throw new Error(`Multistep check needs --project <dir> so @playwright/test can be resolved`);
      const out = await runMultiStepSandbox({
        baseUrl: url,
        environmentName: this.environmentName,
        env,
        timeoutMs: this.sandboxTimeoutMs,
        projectDir: this.projectDir,
        files: { ...(ctx?.files ?? bundle.files), [checkFile]: patchSource },
        originalFiles: bundle.files,
        checkFile,
        seed,
        ...(detectionScene ? { detection: { bundle, scene: detectionScene } } : {}),
      });
      return { passed: out.passed, inconclusive: out.inconclusive, reason: out.reason, trace: out.trace, browserProcesses: out.browserProcesses };
    }
    if (bundle.playwright && /\.(?:spec|test)\.[cm]?[jt]sx?$/.test(checkFile)) {
      if (!this.projectDir) throw new Error(`Playwright check needs --project <dir> so @playwright/test can be resolved`);
      const out = await runPlaywrightSandbox({
        baseUrl: url,
        environmentName: this.environmentName,
        env,
        timeoutMs: this.sandboxTimeoutMs,
        projectDir: this.projectDir,
        configFile: ctx?.playwrightConfigFile ?? bundle.playwright.configFile,
        projects: bundle.playwright.projects,
        files: { ...(ctx?.files ?? bundle.files), [checkFile]: patchSource },
        assets: ctx?.assets,
        checkFile,
        seed,
        browserExecutablePath: this.browserExecutablePath,
      });
      return { passed: out.passed, inconclusive: out.inconclusive, reason: out.reason, trace: out.trace };
    }

    const out = await runSandbox(patchSource, { baseUrl: url, environmentName: this.environmentName, env, seed, timeoutMs: this.sandboxTimeoutMs });
    return {
      passed: out.passed,
      inconclusive: out.vacuous,
      reason: out.vacuousReason,
      trace: out.results.flatMap((r) => r.trace).map((t, index) => ({ ...t, index })),
    };
  }

  async runScene(bundle: Bundle, patchSource: string, scene: Scene, ctx?: RunContext): Promise<SceneObservation> {
    if (bundle.check.checkType === "API" || bundle.api) {
      const observation = await this.apiExecutor.runScene(bundle, patchSource, scene, ctx);
      this.budgetExhausted ||= this.apiExecutor.budgetExhausted;
      this.nondeterministicScenes.push(...this.apiExecutor.nondeterministicScenes.filter((id) => !this.nondeterministicScenes.includes(id)));
      return observation;
    }
    const mode = parseMode(scene.mode);
    const isMultiStep = bundle.check.checkType === "MULTI_STEP";
    if (isMultiStep && bundle.schemaVersion === "v3" && !multiStepDiskRebound(bundle)) {
      return this.uncertain(scene, "Multistep on-disk remote authority changed or is unresolved", 0, [], "target");
    }
    // A MultiStepCheck construct overrides project-level Checkly scheduling.
    // Its unchanged deployed check configuration (captured in the bundle) is
    // the trusted location list; a patched checkly.config.ts for another check
    // may NOT relabel two executed regions as one.
    // Experiment conditions belong to the trusted bundle. Candidate project
    // configuration must never lower regions or reproduction concurrency.
    const config = bundle.config ?? ctx?.config ?? null;
    const allowed = effectiveConcurrency(config);
    const locations = config?.locations.length ? config.locations : bundle.config?.locations ?? [];
    const concurrency = mode.kind === "live-concurrent"
      ? Math.max(1, Math.min(mode.concurrency, allowed, isMultiStep ? Math.max(1, locations.length) : mode.concurrency)) : 1;
    let environment = this.environmentLabel(bundle, scene, mode, concurrency);

    if (mode.kind === "unknown" || mode.kind === "pending") return this.uncertain(scene, `scene mode not runnable: ${mode.reason}`, 0, [], environment);
    if ((isMultiStep && scene.type === "DETECTION" && mode.kind !== "multistep-detection")
      || (mode.kind === "multistep-detection" && (!isMultiStep || !trustedMultiStepDetection(bundle, scene)))) {
      return this.uncertain(scene, "Multistep detection lacks validated failing-side remote provenance and fixed nested booking facts", 0, [], environment);
    }
    if (needsTarget(mode) && !this.target) {
      const recorded = bundle.recordedOrigin ? `the recorded origin ${bundle.recordedOrigin}` : "a recorded origin";
      return this.uncertain(scene, `live scene needs a target: pass --target <url> (${recorded} is never used implicitly)`, 0, [], environment);
    }
    const replayHar = mode.kind === "replay" ? this.har(bundle, mode.har) : null;
    if (mode.kind === "replay" && !replayHar) return this.uncertain(scene, `recording ${mode.har} not found in the bundle`, 0, [], environment);
    const replayBrowserAssets = Boolean(mode.kind === "replay" && bundle.playwright && replayHar && browserAssetBodiesMissing(replayHar));
    if (replayBrowserAssets && !this.target) {
      return this.uncertain(scene, `recording ${mode.kind === "replay" ? mode.har : ""} keeps API bodies only; this browser replay needs --target for page assets (or recapture with --bodies all)`, 0, [], environment);
    }
    if (replayBrowserAssets) environment = this.environmentLabel(bundle, scene, mode, concurrency, true);
    const failingHar = mode.kind === "inject" ? this.har(bundle, "failing.har") : null;

    const baseEnv = { ...this.env, ...(scene.env ?? {}) };
    // A concurrency-one scene still executes both configured regions, one
    // after the other. Scheduling is independent of the account values.
    const regions = isMultiStep ? locations.map(multistepRegionForLocation) : [];
    if (isMultiStep && (!regions.length || regions.some((region) => region === null))) {
      return this.uncertain(scene, "Multistep has no valid trusted region list — no runner was started", 0, [], environment);
    }
    const sourceFiles = new Map(Object.entries(ctx?.files ?? bundle.files));
    sourceFiles.set(ctx?.checkFile ?? bundle.check.file, patchSource);
    const sourceModel = isMultiStep ? parseMultiStepProject(sourceFiles, ctx?.checkFile ?? bundle.check.file) : null;
    const policyEnv = bundle.protectedRequirements?.policy.fields.environmentVariableNames?.original;
    const declaredEnvKeys = [
      ...(bundle.config?.environmentVariables ?? []),
      ...(policyEnv?.state === "known" && Array.isArray(policyEnv.value)
        ? policyEnv.value.filter((value): value is string => typeof value === "string") : []),
      ...(sourceModel?.construct?.environmentKeys ?? []),
    ];
    const mapping = isMultiStep
      ? deriveRegionalAccountMapping(sourceFiles.entries(), locations, [...new Set(declaredEnvKeys)])
      : null;
    if (isMultiStep && !mapping) {
      return this.uncertain(scene, "Multistep per-location account mapping is unsupported or unresolved — no runner was started", 0, [], environment);
    }
    // Only mapped account keys cross the child boundary. A scene may add no
    // other user-provided names, and no caller may override trusted runners.
    const protectedRunnerKeys = ["REGION", "PATH", "HOME", "NODE_OPTIONS", "NODE_EXTRA_CA_CERTS",
      "LD_LIBRARY_PATH", "ENVIRONMENT_URL", "ENVIRONMENT_NAME", "SANDBOX_SEED", "CI"];
    if (isMultiStep && (Object.keys(baseEnv).some((key) => protectedRunnerKeys.includes(key.toUpperCase()))
      || Object.keys(scene.env ?? {}).some((key) => !Object.values(mapping ?? {}).includes(key)
        && key !== AUTOMATION_BYPASS_INPUT && key !== "REGION"))) {
      return this.uncertain(scene, "Multistep env-file overrides a trusted runner key — no runner was started", 0, [], environment);
    }
    const accounts = isMultiStep && mapping
      ? trustedRegionalAccounts(baseEnv, mapping, locations) : null;
    if (isMultiStep && (!accounts || !trustedAutomationBypass(baseEnv))) {
      return this.uncertain(scene, "Multistep regional account or protected bypass inputs are unavailable or overlap — no runner was started", 0, [], environment);
    }

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
    const costRow = {
      sceneId: scene.sceneId,
      executor: "scene" as const,
      repetitions: 0,
      checkRuns: 0,
      wallTimeMs: 0,
      phase: ctx?.phase ?? "candidate" as const,
      maxConcurrentRuns: concurrency,
      requiredRegions: [...locations],
      executedRegions: [] as string[],
      ...(isMultiStep ? { multiStepBrowserCounts: [] as Array<number | null> } : {}),
    };
    this.cost.byScene.push(costRow);

    const observedOutcomes: Array<"pass" | "fail"> = [];
    const mergedTrace: TraceStep[] = [];
    let index = 0;
    const push = (t: Omit<TraceStep, "index">) => mergedTrace.push({ ...t, index: index++ });
    if (concurrency < (mode.kind === "live-concurrent" ? mode.concurrency : 1)) {
      push({ kind: "step", what: `scheduling: the patched config allows ${allowed} overlapping run(s) (runParallel=${String(config?.runParallel)}, locations=${config?.locations.length ?? "?"}); scene runs at concurrency ${concurrency}`, outcome: "ok" });
    }

    for (let rep = 0; rep < reps; rep++) {
      let repPassed = true;
      const allHits: ProxyHit[] = [];
      const batches = isMultiStep ? Math.ceil(locations.length / concurrency) : 1;
      for (let batch = 0; batch < batches; batch++) {
        const batchStart = batch * concurrency;
        const batchRuns = isMultiStep ? Math.min(concurrency, locations.length - batchStart) : concurrency;
        const batchRegions = isMultiStep
          ? locations.slice(batchStart, batchStart + batchRuns)
          : Array.from({ length: batchRuns }, (_, runIndex) => locations[runIndex % Math.max(1, locations.length)]).filter((value): value is string => Boolean(value));
        costRow.executedRegions!.push(...batchRegions.filter((region) => !costRow.executedRegions!.includes(region)));
        const urls = await this.proxy.arm({ mode, target: this.target, runs: batchRuns, replayHar, replayBrowserAssetsFromTarget: replayBrowserAssets,
          failingHar, barrierTimeoutMs: this.barrierTimeoutMs,
          trustedMultiStepDetection: mode.kind === "multistep-detection"
            ? trustedMultiStepDetection(bundle, scene) ?? undefined : undefined });
        const startedAt = Date.now();
        const settled = await Promise.all(
          urls.map((url, runIndex) => {
            const globalRunIndex = batchStart + runIndex;
            const region = isMultiStep ? regions[globalRunIndex]! : locations[runIndex % Math.max(1, locations.length)];
            const env = (isMultiStep ? {
              REGION: region!,
              ...Object.fromEntries(locations.map((location) => [accounts!.keys[location]!, accounts!.values[location]!])),
              [AUTOMATION_BYPASS_INPUT]: baseEnv[AUTOMATION_BYPASS_INPUT],
            } : {
              ...baseEnv,
              CHECKLY: "1",
              CHECKLY_RUN_SOURCE: "TEST_RECORD",
              CI: "1",
              ...(region ? { CHECKLY_REGION: region } : {}),
            }) as Record<string, string>;
            return this.runCandidate(bundle, patchSource, ctx, url, env, repetitionSeed(scene.sceneId, rep, globalRunIndex),
              mode.kind === "multistep-detection" ? scene : null)
              .then((outcome) => ({ ok: true as const, outcome }))
              .catch((err: Error) => ({ ok: false as const, err }))
              .finally(() => this.proxy.runFinished(runIndex));
          }),
        );
        const elapsed = Date.now() - startedAt;
        costRow.checkRuns += batchRuns;
        costRow.wallTimeMs += elapsed;
        this.cost.localRuns += batchRuns;
        if (bundle.playwright) this.cost.browserProcesses += batchRuns * Math.max(1, bundle.playwright.projects.length);
        if (isMultiStep) {
          const samples = settled.map((result) => result.ok ? result.outcome.browserProcesses ?? null : null);
          costRow.multiStepBrowserCounts!.push(...samples);
          (this.cost.multiStepBrowserCounts ??= []).push(...samples);
          this.cost.browserProcesses += samples.reduce<number>((sum, n) => sum + (n ?? 0), 0);
        }
        this.cost.wallTimeMs += elapsed;
        if (costRow.phase === "mutation") this.cost.mutationRuns += batchRuns;
        const hits = this.proxy.hits();
        allHits.push(...hits);
        for (let runIndex = 0; runIndex < settled.length; runIndex++) {
          const s = settled[runIndex];
          const runHits = hits.filter((h) => h.runIndex === runIndex);
          const globalRunIndex = batchStart + runIndex;
          const tag = isMultiStep ? `region ${regions[globalRunIndex]}: ` : concurrency > 1 ? `run ${runIndex + 1}/${batchRuns}: ` : "";
          if (!s.ok) {
            // A Multistep exception may contain a project path or dependency
            // error from the host. It is not transaction evidence or report text.
            const msg = isMultiStep ? "Multistep sandbox execution unavailable"
              : (s.err?.message ?? String(s.err)).split("\n")[0].slice(0, 200);
            push({ kind: "step", what: `${tag}sandbox error: ${msg}`, outcome: "failed" });
            return this.uncertain(scene, `sandbox could not run the check: ${msg}`, rep, mergedTrace, environment);
          }
          const outcome = s.outcome;
          for (const t of outcome.trace) push({ ...t, what: tag ? `${tag}${t.what}` : t.what });
          if (isMultiStep && !outcome.inconclusive && outcome.browserProcesses == null) {
            return this.uncertain(scene, "Multistep browser-process measurement unavailable — no zero-browser claim", rep + 1, mergedTrace, environment);
          }
          if (isMultiStep && !outcome.inconclusive && (outcome.browserProcesses ?? 0) > 0) {
            return this.uncertain(scene, "Multistep browser process observed — API-only execution not proven", rep + 1, mergedTrace, environment);
          }
          const traffic = isMultiStep
            ? runHits.slice(0, 4).map((hit) => `${hit.method === "GET" || hit.method === "POST" ? hit.method : "OTHER"} ${knownRoute(hit.path) ?? "<unknown-route>"} ${hit.status}`).join(", ")
            : summarize(runHits);
          push({ kind: "step", what: `${tag}${runHits.length} request(s) reached the proxy → ${runHits.length ? traffic : "none"}`, outcome: runHits.length ? "ok" : "skipped" });
          if (bundle.check.checkType === "MULTI_STEP") {
            // Completed requests of the structured transaction — counted from
            // the scene proxy (the executor's own evidence, not child stderr).
            this.cost.httpRequests = (this.cost.httpRequests ?? 0) + runHits.length;
          }
          if (runHits.length === 0) {
            // The executor's own count, independent of anything inside the sandbox.
            return this.uncertain(scene, `${tag}no request reached ENVIRONMENT_URL — nothing was observed in this scene state`, rep + 1, mergedTrace, environment);
          }
          if (mode.kind === "multistep-detection") {
            const expected = [["POST", "/api/login"], ["GET", "/api/session"],
              ["GET", "/api/slots"], ["POST", "/api/book"]] as const;
            if (runHits.length !== 4 || runHits.some((hit, i) => hit.ordinal !== i + 1
              || hit.method !== expected[i]![0] || hit.path !== expected[i]![1]
              || hit.status !== 200 || hit.source !== (i === 3 ? "injected" : "target"))) {
              return this.uncertain(scene, `${tag}the fixed HTTP-200 nested booking mutation did not occur exactly once after three completed requests`,
                rep + 1, mergedTrace, environment);
            }
          }
          if (outcome.inconclusive) return this.uncertain(scene, `${tag}${outcome.reason ?? "runner produced no admissible result"}`, rep + 1, mergedTrace, environment);
          if (!outcome.passed) repPassed = false;
        }
      }
      if (isMultiStep && bundle.schemaVersion === "v3" && !multiStepDiskRebound(bundle)) {
        return this.uncertain(scene, "Multistep on-disk authority changed during execution", rep + 1, mergedTrace, environment);
      }
      if (mode.kind === "multistep-detection" && !trustedMultiStepDetection(bundle, scene)) {
        return this.uncertain(scene, "Multistep failing-side evidence changed during the scene", rep + 1, mergedTrace, environment);
      }
      costRow.repetitions += 1;
      observedOutcomes.push(repPassed ? "pass" : "fail");
      this.onRepetition?.({ sceneId: scene.sceneId, repetition: rep, checkPassed: repPassed,
        hits: isMultiStep ? allHits.map((hit) => ({ ...hit, path: knownRoute(hit.path) ?? "<unknown-route>" })) : allHits });
      if (this.verbose) {
        console.error(`[scene] ${scene.sceneId} rep=${rep + 1}/${reps} concurrency=${concurrency} observed=${repPassed ? "pass" : "fail"} expected=${sceneExpected(scene).observed} hits=${allHits.length} (${environment})`);
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

function browserAssetBodiesMissing(har: Har): boolean {
  const browserTypes = new Set(["document", "script", "stylesheet", "font", "image"]);
  return har.log.entries.some((e) => browserTypes.has(e._resourceType ?? "") && e.response.status !== 204 && !e.response.content.text);
}

function summarize(hits: Array<{ method: string; path: string; status: number; source: string; action?: boolean }>): string {
  const useful = hits.filter((h) => h.action !== false || h.path.startsWith("/api/"));
  const shown = (useful.length ? useful : hits).slice(0, 12);
  const text = shown.map((h) => `${h.method} ${h.path} ${h.status}${h.source === "target" ? "" : ` (${h.source})`}`).join(", ");
  const hidden = hits.length - shown.length;
  return hidden > 0 ? `${text}, … ${hidden} browser asset request(s)` : text;
}

/** Detect the "change account/region/env to dodge" vector (threat row + STING
 * class 4): patch swaps credential constants, or starts generating accounts at
 * runtime (per-run sessions), dodging the shared-account semantics the incident
 * depends on. Deterministic, code-derived. Compares the SET of distinct
 * credential-bearing statements, so a fix that merely reuses the same account
 * in more requests is not a dodge. */
export interface EnvScopeContext {
  locations?: string[];
  declaredEnvKeys?: string[];
}

export function regionalUserEnvKey(location: string): string {
  return `TEST_USER_${location.toUpperCase().replace(/[^A-Z0-9]+/g, "_")}`;
}

export function regionalUserKeys(source: string, context: EnvScopeContext): string[] | null {
  const locations = context.locations ?? [];
  if (locations.length < 2 || !/process\.env\.CHECKLY_REGION\b/.test(source)) return null;
  const expected = locations.map(regionalUserEnvKey);
  const declared = new Set(context.declaredEnvKeys ?? []);
  const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const mapped = locations.every((location, index) => {
    const key = expected[index];
    const entry = new RegExp(`["']${escape(location)}["']\\s*:\\s*process\\.env(?:\\.${key}|\\[['\"]${key}['\"]\\])`);
    return declared.has(key) && entry.test(source);
  });
  if (!mapped) return null;
  const selection = /\bTEST_USER\b\s*=\s*[A-Za-z_$][\w$]*\[\s*process\.env\.CHECKLY_REGION(?:\s*\?\?\s*(['"])\1)?\s*\]/.exec(source);
  if (!selection) return null;
  const selectionLine = source.slice(source.lastIndexOf("\n", selection.index) + 1, source.indexOf("\n", selection.index) === -1 ? source.length : source.indexOf("\n", selection.index));
  if (!/\]\s*;?\s*(?:\/\/.*)?$/.test(selectionLine)) return null;
  if (/(['"])[^'"]+\1/.test(selectionLine.replace(/(['"])\1/g, ""))) return null;
  return expected;
}

export function detectEnvScopeDodge(original: string, patched: string, context: EnvScopeContext = {}): string | null {
  const ACCOUNT_TOKEN = /\b(?:account|username|email|user|ACCOUNT|USERNAME|EMAIL|TEST_USER)\b\s*[:=]/;
  const GEN = /Date\.now\(\)|Math\.random\(\)|randomUUID\(\)|crypto\.random/;

  const credentialLines = (src: string) => src.split("\n").filter((l) => ACCOUNT_TOKEN.test(l));
  const origLines = credentialLines(original);
  const newLines = credentialLines(patched);

  const genLine = newLines.find((l) => GEN.test(l));
  if (genLine) {
    return `account/credential generated at runtime (${genLine.trim().slice(0, 60)}) — dodges the shared-account failure; envAssumption "single shared account" violated`;
  }
  // A fixed mapping from each configured Checkly region to a declared user is
  // a real overlap repair. It preserves stable identities while preventing two
  // locations from invalidating the same session. Random or undeclared users
  // remain a dodge.
  if (regionalUserKeys(patched, context)) return null;
  const distinct = (lines: string[]) => [...new Set(lines.map((l) => l.trim().replace(/\s+/g, " ")))].sort();
  if (JSON.stringify(distinct(origLines)) !== JSON.stringify(distinct(newLines))) {
    return "account/credential constant changed — dodges the shared-account failure; envAssumption 'single shared account' violated";
  }
  return null;
}
