// Orchestrator: bundle + patch → contract → scenes → mutants → adequacy →
// decision → report/exit. Single entry for the CLI and the seeded suite.
//
// The patch may change the check code, the check config, or both. Code is
// judged by the contract engine and the scenes; config by the config policy
// (src/scene/config-diff.ts) and by the concurrency the scenes run at.

import type { Bundle, BundleConfig, Decision, ExecutionCost, ExperimentExecutor, RunContext, Scene, SceneObservation } from "./types.ts";
import { buildContract, type ContractReport } from "./contract/contract.ts";
import { assessAdequacy, type MutantResult } from "./adequacy/adequacy.ts";
import { decide } from "./decision/decision.ts";
import { seedMutants } from "./mutation.ts";
import { buildReport, type Report } from "./report/report.ts";
import { detectEnvScopeDodge, regionalUserKeys, SceneExecutor } from "./executor/scene.ts";
import { HybridExecutor } from "./executor/hybrid.ts";
import { inlinePatch, newFiles, originalConfigSource, patchedAssets, patchedCheckSource, patchedConfig, patchedConfigSource, patchedFiles, type PatchSet } from "./patch.ts";
import { applyConfigPolicy, diffCheckConfig, parseCheckConfig, type ConfigPolicy } from "./scene/config-diff.ts";
import { checkEnv, type EnvCheck } from "./scene/env.ts";
import type { CandidateRevisionMetadata, CandidateTargetBinding } from "./candidate/revision.ts";
import { evaluateApiPolicy, type ApiPolicyResult } from "./api/policy.ts";

export const PR12_HEALTHY_RUNS = 5; // PR-12: ≥5 repeated healthy runs, else flake → UNCERTAIN

export interface VerifyOptions {
  bundle: Bundle;
  /** the candidate: a PatchSet, or check source text (replaces the main check file) */
  patch: PatchSet | string;
  executor?: ExperimentExecutor;
  /** live target for the scene executor (`--target`) */
  target?: string | null;
  /** the check's variables (`--env-file`) */
  env?: Record<string, string>;
  environmentName?: string;
  maxRunsPerScene?: number;
  /** Checkly/Playwright project whose node_modules runs browser specs. */
  projectDir?: string | null;
  browserExecutablePath?: string;
  /** Exact deployment commit associated with the target URL. */
  targetRevision?: string;
  /** Report-only path of the project whose candidate files were loaded. */
  candidateProject?: string | null;
  /** Immutable complete-source identity for local/PR candidate modes. */
  candidateRevision?: CandidateRevisionMetadata | null;
  /** Source-to-deployment binding and protected-gate eligibility. */
  targetBinding?: CandidateTargetBinding | null;
  verbose?: boolean;
}

export interface VerifyResult {
  contract: ContractReport;
  observations: Map<string, SceneObservation>;
  mutants: MutantResult[];
  decision: Decision;
  report: Report;
  envDodge: string | null;
  configPolicy: ConfigPolicy;
  apiPolicy: ApiPolicyResult | null;
  envCheck: EnvCheck;
  patchedConfig: BundleConfig | null;
  cost: ExecutionCost;
}

export function makeExecutor(opts: { target?: string | null; targetRevision?: string; env?: Record<string, string>; environmentName?: string; maxRunsPerScene?: number; projectDir?: string | null; browserExecutablePath?: string; verbose?: boolean }): ExperimentExecutor {
  if (process.env.VERIFY_FIX_EXECUTOR === "hybrid") {
    return new HybridExecutor({ target: opts.target ?? null, targetRevision: opts.targetRevision, env: opts.env, environmentName: opts.environmentName, maxRunsPerScene: opts.maxRunsPerScene, projectDir: opts.projectDir, browserExecutablePath: opts.browserExecutablePath, verbose: opts.verbose });
  }
  return new SceneExecutor({ target: opts.target ?? null, env: opts.env, environmentName: opts.environmentName, maxRunsPerScene: opts.maxRunsPerScene, projectDir: opts.projectDir, browserExecutablePath: opts.browserExecutablePath, verbose: opts.verbose });
}

export async function verify(opts: VerifyOptions): Promise<VerifyResult> {
  const verifyStartedAt = Date.now();
  const { bundle, verbose } = opts;
  const patch: PatchSet = typeof opts.patch === "string" ? inlinePatch(bundle, opts.patch) : opts.patch;
  const patchSource = patchedCheckSource(bundle, patch);
  const executor = opts.executor ?? makeExecutor({ target: opts.target, targetRevision: opts.targetRevision, env: opts.env, environmentName: opts.environmentName, maxRunsPerScene: opts.maxRunsPerScene, projectDir: opts.projectDir, browserExecutablePath: opts.browserExecutablePath, verbose });

  // ── static: code dodges, config policy, environment ──────────────────────
  const originalCfg = parseCheckConfig(originalConfigSource(bundle));
  const patchedCfgView = parseCheckConfig(patchedConfigSource(bundle, patch));
  const codeChanged = patchSource !== bundle.checkSource;
  const configPolicy = applyConfigPolicy(diffCheckConfig(originalCfg, patchedCfgView), codeChanged, originalCfg, patchedCfgView);
  const runConfig = patchedConfig(bundle, patch);
  const candidateFiles = patchedFiles(bundle, patch);
  const candidateCheckFile = patch.checkFile ?? bundle.check.file;
  const originalFiles = new Map(Object.entries(bundle.files));
  originalFiles.set(bundle.check.file, bundle.checkSource);
  const candidateFileMap = new Map(Object.entries(candidateFiles));
  candidateFileMap.set(candidateCheckFile, patchSource);
  const apiPolicy = bundle.check.checkType === "API" || bundle.api
    ? evaluateApiPolicy(bundle.check.file, originalFiles, candidateCheckFile, candidateFileMap, bundle.check.logicalId)
    : null;
  const declared = [...new Set([
    ...(bundle.config?.environmentVariables ?? []),
    ...(runConfig?.environmentVariables ?? []),
    ...configPolicy.declaredEnvKeys,
    ...(apiPolicy?.candidate?.environmentKeys ?? []),
  ])];
  let envDodge = detectEnvScopeDodge(bundle.checkSource, patchSource, { locations: runConfig?.locations, declaredEnvKeys: declared });
  const provided = { ...(opts.env ?? {}) };
  const regionalKeys = regionalUserKeys(patchSource, { locations: runConfig?.locations, declaredEnvKeys: declared });
  if (!envDodge && regionalKeys) {
    const values = regionalKeys.map((key) => provided[key]).filter((value): value is string => Boolean(value));
    if (values.length === regionalKeys.length && new Set(values).size !== values.length) {
      envDodge = "regional test-user variables resolve to the same value — overlapping locations still share one account";
    }
  }
  const ctx: RunContext = {
    config: runConfig,
    files: candidateFiles,
    assets: patchedAssets(patch),
    ...(patch.checkFile ? { checkFile: patch.checkFile } : {}),
    ...(patch.playwrightConfigFile ? { playwrightConfigFile: patch.playwrightConfigFile } : {}),
    ...(patch.checkName ? { checkName: patch.checkName } : {}),
    phase: "candidate",
  };
  const environmentEntries = apiPolicy
    ? [candidateCheckFile, apiPolicy.candidate?.setupFile, apiPolicy.candidate?.teardownFile]
        .filter((file): file is string => Boolean(file))
        .map((file) => [file, candidateFiles[file]] as const)
        .filter((entry): entry is readonly [string, string] => typeof entry[1] === "string")
    : [[candidateCheckFile, patchSource] as const];
  const environmentSource = environmentEntries.map(([file, source]) => `// ${file}\n${source}`).join("\n");
  const envCheck = checkEnv(environmentSource || patchSource, provided, declared);
  const added = newFiles(bundle, patch);

  const contract = buildContract(bundle, patchSource, candidateFileMap, candidateCheckFile);
  if (verbose) {
    console.error(`[verify] ${bundle.incidentId}: ${bundle.scenes.length} scenes, determinism gate blocked=${contract.determinismGate.blocked}, config changes=${configPolicy.changes.length}, env missing=${envCheck.missing.map((m) => m.name).join(",") || "none"}`);
  }

  const observations = new Map<string, SceneObservation>();
  const missingEnvReason = apiPolicy?.uncertain
    ?? (apiPolicy && !opts.target ? "ENVIRONMENT_URL is missing; pass --target so {{ENVIRONMENT_URL}} can be resolved without a fallback" : null)
    ?? (envCheck.missing.length > 0
      ? `the check reads ${envCheck.missing.map((m) => `${m.form === "handlebars" ? "{{" + m.name + "}}" : "process.env." + m.name} (line ${m.line})`).join(", ")} and no value was provided — pass --env-file; a run with an empty variable would not be the customer's check`
      : null);
  const undeclaredEnvReason = envCheck.undeclared.length > 0
    ? `the patch reads undeclared environment variable(s): ${envCheck.undeclared.join(", ")}`
    : null;
  const preflightRejected = patch.rejection ?? apiPolicy?.rejected ?? staticallyRejected(bundle, patchSource, candidateFileMap, candidateCheckFile) ?? envDodge ?? configPolicy.rejected ?? undeclaredEnvReason;
  if (preflightRejected) {
    if (verbose) console.error(`[verify] static rejection before execution: ${preflightRejected}`);
  } else if (missingEnvReason) {
    for (const s of bundle.scenes) {
      observations.set(s.sceneId, { sceneId: s.sceneId, observed: "uncertain", repetitions: 0, trace: [], source: s.type === "HEALTHY" || s.type === "REGRESSION" ? "checkly" : "scene", reason: missingEnvReason, environment: s.environment ?? "target" });
    }
  } else {
    const rank: Record<Scene["type"], number> = { REPRODUCTION: 0, DETECTION: 1, HEALTHY: 2, REGRESSION: 3, MUTATION: 4 };
    const ordered = [...bundle.scenes].sort((a, b) => rank[a.type] - rank[b.type]);
    for (const s of ordered) {
      const observation = await executor.runScene(bundle, patchSource, s, ctx);
      observations.set(s.sceneId, observation);
      const expected = s.verdict.mustFail ? "fail" : "pass";
      // A conclusive mismatch already fixes the verdict at FAILED. Missing
      // evidence already fixes it at UNCERTAIN. Do not buy later cloud runs.
      if (observation.observed === "uncertain" || observation.observed !== expected) break;
    }
  }
  // Determinism evidence is about the CANDIDATE's own repetitions; snapshot it
  // before the mutation phase runs weakened variants through the same executor.
  const nonDet = [...new Set(executor.nondeterministicScenes)];

  // Mutation phase: few, directed weak variants of the CANDIDATE patch.
  // Killed = the verifier caught it: either the contract engine rejects the
  // mutant outright (a core-path assertion removed/weakened, or an assertion
  // wrapped so its failure is swallowed — the same static law that FAILs a
  // candidate), or the scenes distinguish it (detection switched to pass, or
  // healthy broke). Survived = the verifier would give the mutant the same
  // verdict as the candidate — it cannot see the piece the mutant removed →
  // blind-spot signal. An `uncertain` observation is no evidence either way,
  // so it never counts as a catch.
  const mutantResults: MutantResult[] = [];
  const detectionScene = bundle.scenes.find((s) => s.type === "DETECTION");
  const healthyScene = bundle.scenes.find((s) => s.type === "HEALTHY");
  const candidateScenesMatched = bundle.scenes.every((s) => {
    const observed = observations.get(s.sceneId)?.observed;
    return observed !== undefined && observed !== "uncertain" && observed === (s.verdict.mustFail ? "fail" : "pass");
  });
  const mutationCtx: RunContext = { ...ctx, phase: "mutation" };
  for (const m of candidateScenesMatched ? seedMutants(patchSource, candidateCheckFile, candidateFiles) : []) {
    const mutantFiles = new Map(candidateFileMap);
    mutantFiles.set(candidateCheckFile, m.source);
    const staticKill = staticallyRejected(bundle, m.source, mutantFiles, candidateCheckFile);
    let detObs: SceneObservation | null = null;
    let healthyObs: SceneObservation | null = null;
    let survived: boolean;
    if (staticKill) {
      survived = false;
    } else if (missingEnvReason) {
      survived = true; // nothing could be observed; the verifier cannot claim a catch
    } else {
      detObs = detectionScene ? await executor.runScene(bundle, m.source, detectionScene, mutationCtx) : null;
      const detCaught = detObs?.observed === "pass"; // masked a must-fail → caught
      // A detection kill is conclusive. Avoid a paid remote healthy run.
      healthyObs = !detCaught && healthyScene ? await executor.runScene(bundle, m.source, healthyScene, mutationCtx) : null;
      const healthyCaught = healthyObs?.observed === "fail"; // broke healthy → caught
      survived = !(detCaught || healthyCaught);
    }
    mutantResults.push({ name: m.name, family: m.family, survived, detail: m.detail });
    if (verbose) {
      const how = staticKill ? `static: ${staticKill}` : `det="${detObs?.observed ?? "n/a"}", healthy="${healthyObs?.observed ?? "n/a"}"`;
      console.error(`[verify] mutant ${m.name} (${m.family}) survived=${survived} (${how})`);
    }
  }
  const healthySceneIds = bundle.scenes.filter((s) => s.type === "HEALTHY").map((s) => s.sceneId);
  const healthyRuns = healthySceneIds.map((id) => observations.get(id)?.repetitions ?? 0);
  const healthyRepetitionsMet = healthySceneIds.length > 0 && healthyRuns.every((r) => r >= PR12_HEALTHY_RUNS);

  const adequacy = assessAdequacy({ contract, sceneObservations: observations, mutants: mutantResults });

  const decision = decide({
    contract,
    observations,
    adequacy,
    nonDeterministicScenes: nonDet,
    healthyRepetitionsMet,
    runBudgetExhausted: executor.budgetExhausted || false,
  });

  // ── static rejections outrank whatever the scenes said ───────────────────
  // A removed incident check, dodge, or masking-only config change is a
  // definite finding, not missing evidence: FAILED even when scenes did not run.
  if (patch.rejection) {
    decision.reasons.push(`candidate identity: ${patch.rejection}`);
    decision.verdict = "FAILED";
    decision.exitCode = 1;
  }
  if (envDodge) {
    decision.reasons.push(`env-scope dodge detected: ${envDodge}`);
    decision.verdict = "FAILED";
    decision.exitCode = 1;
  }
  if (configPolicy.rejected) {
    decision.reasons.push(`config policy: ${configPolicy.rejected}`);
    decision.verdict = "FAILED";
    decision.exitCode = 1;
  }
  if (apiPolicy?.rejected) {
    decision.reasons.push(`API policy: ${apiPolicy.rejected}`);
    decision.verdict = "FAILED";
    decision.exitCode = 1;
  }
  for (const n of configPolicy.notes) decision.reasons.push(`config: ${n}`);
  for (const n of apiPolicy?.notes ?? []) decision.reasons.push(`API: ${n}`);
  if (apiPolicy?.uncertain && !patch.rejection && !envDodge && !configPolicy.rejected && !apiPolicy.rejected) {
    decision.reasons.push(`API evidence unresolved: ${apiPolicy.uncertain}`);
    decision.verdict = "UNCERTAIN";
    decision.exitCode = 2;
  }
  if (envCheck.undeclared.length > 0) {
    decision.reasons.push(`env: the patch reads ${envCheck.undeclared.join(", ")} — not declared on the check; it must be added to the check's environment variables in Checkly (values never enter the bundle)`);
    decision.verdict = "FAILED";
    decision.exitCode = 1;
  }
  for (const d of envCheck.defaulted) decision.reasons.push(`env: ${d.name} not provided; the check ran on its own fallback (line ${d.line})`);
  if (added.length > 0) decision.reasons.push(`patch adds files not in the bundle: ${added.join(", ")} (copied into the candidate check tree)`);

  await executor.close?.();

  const cost = executor.costReport();
  cost.runs = cost.checklyCloudRuns + cost.localRuns;
  cost.wallTimeMs = Date.now() - verifyStartedAt;
  const report = buildReport(contract, decision, observations, {
    cost,
    target: opts.target ?? null,
    targetRevision: opts.targetRevision ?? null,
    candidateProject: opts.candidateProject ?? null,
    candidate: patch.path ?? patch.kind,
    candidateRevision: opts.candidateRevision ?? patch.revision ?? null,
    candidateCheck: patch.checkLogicalId ? { logicalId: patch.checkLogicalId, name: patch.checkName ?? null, file: patch.checkFile ?? null } : null,
    targetBinding: opts.targetBinding ?? null,
  });
  return {
    contract,
    observations,
    mutants: mutantResults,
    decision,
    report,
    envDodge,
    configPolicy,
    apiPolicy,
    envCheck,
    patchedConfig: runConfig,
    cost,
  };
}

/** The contract engine's static law applied to a mutant: returns the reason it
 * would be FAILED before any scene runs, or null if only the scenes can tell. */
export function staticallyRejected(bundle: Bundle, mutantSource: string, files?: Map<string, string>, checkFile?: string): string | null {
  const c = buildContract(bundle, mutantSource, files, checkFile);
  const core = [...c.diff.removed, ...c.diff.weakened].filter((a) => a.onCriticalPath);
  if (core.length > 0) return `core-path assertion removed/weakened (${core.map((a) => `${a.subject}.${a.matcher}`).join(", ")})`;
  if (c.suppressionCandidates.length > 0) return `suppression candidate (${c.suppressionCandidates.length})`;
  return null;
}

export function healthyRunsUsed(bundle: Bundle, observations: Map<string, SceneObservation>): number {
  const h = bundle.scenes.filter((s): s is Scene & { type: "HEALTHY" } => s.type === "HEALTHY");
  return h.reduce((acc, s) => acc + (observations.get(s.sceneId)?.repetitions ?? 0), 0);
}
