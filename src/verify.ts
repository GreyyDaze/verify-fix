// Orchestrator: bundle + patch → contract → scenes → mutants → adequacy →
// decision → report/exit. Single entry for the CLI and the seeded suite.
//
// The patch may change the check code, the check config, or both. Code is
// judged by the contract engine and the scenes; config by the config policy
// (src/scene/config-diff.ts) and by the concurrency the scenes run at.

import type { Bundle, BundleConfig, Decision, ExperimentExecutor, RunContext, Scene, SceneObservation } from "./types.ts";
import { buildContract, type ContractReport } from "./contract/contract.ts";
import { assessAdequacy, type MutantResult } from "./adequacy/adequacy.ts";
import { decide } from "./decision/decision.ts";
import { seedMutants } from "./mutation.ts";
import { buildReport, type Report } from "./report/report.ts";
import { isSceneExecutor, detectEnvScopeDodge, SceneExecutor } from "./executor/scene.ts";
import { ChecklyExecutor } from "./executor/checkly.ts";
import { inlinePatch, newFiles, originalConfigSource, patchedCheckSource, patchedConfig, patchedConfigSource, type PatchSet } from "./patch.ts";
import { applyConfigPolicy, diffCheckConfig, parseCheckConfig, type ConfigPolicy } from "./scene/config-diff.ts";
import { checkEnv, type EnvCheck } from "./scene/env.ts";

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
  envCheck: EnvCheck;
  patchedConfig: BundleConfig | null;
  cost: { scenes: number; runs: number };
}

export function makeExecutor(opts: { target?: string | null; env?: Record<string, string>; environmentName?: string; maxRunsPerScene?: number; projectDir?: string | null; browserExecutablePath?: string; verbose?: boolean }): ExperimentExecutor {
  if (process.env.VERIFY_FIX_EXECUTOR === "checkly") {
    return new ChecklyExecutor({ dryRunOnly: !process.env.CHECKLY_API_KEY, verbose: opts.verbose });
  }
  return new SceneExecutor({ target: opts.target ?? null, env: opts.env, environmentName: opts.environmentName, maxRunsPerScene: opts.maxRunsPerScene, projectDir: opts.projectDir, browserExecutablePath: opts.browserExecutablePath, verbose: opts.verbose });
}

export async function verify(opts: VerifyOptions): Promise<VerifyResult> {
  const { bundle, verbose } = opts;
  const patch: PatchSet = typeof opts.patch === "string" ? inlinePatch(bundle, opts.patch) : opts.patch;
  const patchSource = patchedCheckSource(bundle, patch);
  const executor = opts.executor ?? makeExecutor({ target: opts.target, env: opts.env, environmentName: opts.environmentName, maxRunsPerScene: opts.maxRunsPerScene, projectDir: opts.projectDir, browserExecutablePath: opts.browserExecutablePath, verbose });
  const scene = isSceneExecutor(executor) ? executor : null;

  // ── static: code dodges, config policy, environment ──────────────────────
  const envDodge = detectEnvScopeDodge(bundle.checkSource, patchSource);
  const originalCfg = parseCheckConfig(originalConfigSource(bundle));
  const patchedCfgView = parseCheckConfig(patchedConfigSource(bundle, patch));
  const codeChanged = patchSource !== bundle.checkSource;
  const configPolicy = applyConfigPolicy(diffCheckConfig(originalCfg, patchedCfgView), codeChanged, originalCfg, patchedCfgView);
  const runConfig = patchedConfig(bundle, patch);
  const ctx: RunContext = { config: runConfig, files: { ...bundle.files, ...patch.files } };
  const provided = { ...(opts.env ?? {}), ...(scene ? scene.env : {}) };
  const declared = [...(bundle.config?.environmentVariables ?? []), ...configPolicy.declaredEnvKeys];
  const envCheck = checkEnv(patchSource, provided, declared);
  const added = newFiles(bundle, patch);

  const contract = buildContract(bundle, patchSource);
  if (verbose) {
    console.error(`[verify] ${bundle.incidentId}: ${bundle.scenes.length} scenes, determinism gate blocked=${contract.determinismGate.blocked}, config changes=${configPolicy.changes.length}, env missing=${envCheck.missing.map((m) => m.name).join(",") || "none"}`);
  }

  const observations = new Map<string, SceneObservation>();
  const missingEnvReason =
    envCheck.missing.length > 0
      ? `the check reads ${envCheck.missing.map((m) => `${m.form === "handlebars" ? "{{" + m.name + "}}" : "process.env." + m.name} (line ${m.line})`).join(", ")} and no value was provided — pass --env-file; a run with an empty variable would not be the customer's check`
      : null;
  for (const s of bundle.scenes) {
    if (missingEnvReason) {
      observations.set(s.sceneId, { sceneId: s.sceneId, observed: "uncertain", repetitions: 0, trace: [], source: executor.kind === "checkly" ? "checkly" : "scene", reason: missingEnvReason, environment: s.environment ?? "target" });
      continue;
    }
    observations.set(s.sceneId, await executor.runScene(bundle, patchSource, s, ctx));
  }
  // Determinism evidence is about the CANDIDATE's own repetitions; snapshot it
  // before the mutation phase runs weakened variants through the same executor.
  const nonDet = scene ? [...new Set(scene.nondeterministicScenes)] : [];

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
  for (const m of seedMutants(patchSource, bundle.check.file)) {
    const staticKill = staticallyRejected(bundle, m.source);
    let detObs: SceneObservation | null = null;
    let healthyObs: SceneObservation | null = null;
    let survived: boolean;
    if (staticKill) {
      survived = false;
    } else if (missingEnvReason) {
      survived = true; // nothing could be observed; the verifier cannot claim a catch
    } else {
      detObs = detectionScene ? await executor.runScene(bundle, m.source, detectionScene, ctx) : null;
      healthyObs = healthyScene ? await executor.runScene(bundle, m.source, healthyScene, ctx) : null;
      const detCaught = detObs?.observed === "pass"; // masked a must-fail → caught
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
  // A dodge or a masking-only config change is a definite finding, not missing
  // evidence: FAILED even when the scenes were inconclusive.
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
  for (const n of configPolicy.notes) decision.reasons.push(`config: ${n}`);
  if (envCheck.undeclared.length > 0) {
    decision.reasons.push(`env: the patch reads ${envCheck.undeclared.join(", ")} — not declared on the check; it must be added to the check's environment variables in Checkly (values never enter the bundle)`);
  }
  for (const d of envCheck.defaulted) decision.reasons.push(`env: ${d.name} not provided; the check ran on its own fallback (line ${d.line})`);
  if (added.length > 0) decision.reasons.push(`patch adds files not in the bundle: ${added.join(", ")} (copied into the candidate check tree)`);

  if (scene) await scene.close();

  const report = buildReport(contract, decision, observations);
  return {
    contract,
    observations,
    mutants: mutantResults,
    decision,
    report,
    envDodge,
    configPolicy,
    envCheck,
    patchedConfig: runConfig,
    cost: executor.costReport(),
  };
}

/** The contract engine's static law applied to a mutant: returns the reason it
 * would be FAILED before any scene runs, or null if only the scenes can tell. */
export function staticallyRejected(bundle: Bundle, mutantSource: string): string | null {
  const c = buildContract(bundle, mutantSource);
  const core = [...c.diff.removed, ...c.diff.weakened].filter((a) => a.onCriticalPath);
  if (core.length > 0) return `core-path assertion removed/weakened (${core.map((a) => `${a.subject}.${a.matcher}`).join(", ")})`;
  if (c.suppressionCandidates.length > 0) return `suppression candidate (${c.suppressionCandidates.length})`;
  return null;
}

export function healthyRunsUsed(bundle: Bundle, observations: Map<string, SceneObservation>): number {
  const h = bundle.scenes.filter((s): s is Scene & { type: "HEALTHY" } => s.type === "HEALTHY");
  return h.reduce((acc, s) => acc + (observations.get(s.sceneId)?.repetitions ?? 0), 0);
}
