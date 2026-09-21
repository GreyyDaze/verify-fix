// Orchestrator: bundle + patch → contract → scenes → mutants → adequacy →
// decision → report/exit. Single entry for the CLI and the seeded suite.

import type { Bundle, Decision, ExperimentExecutor, SceneObservation } from "./types.ts";
import { buildContract, type ContractReport } from "./contract/contract.ts";
import { assessAdequacy, type MutantResult } from "./adequacy/adequacy.ts";
import { decide } from "./decision/decision.ts";
import { seedMutants } from "./mutation.ts";
import { buildReport, type Report } from "./report/report.ts";
import { isSyntheticExecutor, detectEnvScopeDodge, SyntheticExecutor } from "./executor/synthetic.ts";
import { ChecklyExecutor } from "./executor/checkly.ts";

export const PR12_HEALTHY_RUNS = 5; // PR-12: ≥5 repeated healthy runs, else flake → UNCERTAIN

export interface VerifyOptions {
  bundle: Bundle;
  patchSource: string;
  executor?: ExperimentExecutor;
  appSimPath?: string | null;
  maxRunsPerScene?: number;
  verbose?: boolean;
}

export interface VerifyResult {
  contract: ContractReport;
  observations: Map<string, SceneObservation>;
  mutants: MutantResult[];
  decision: Decision;
  report: Report;
  envDodge: string | null;
  cost: { scenes: number; runs: number };
}

export function makeExecutor(opts: { appSimPath?: string | null; maxRunsPerScene?: number; verbose?: boolean }, bundle: Bundle): ExperimentExecutor {
  if (opts.appSimPath) {
    return new SyntheticExecutor(opts.appSimPath, { maxRunsPerScene: opts.maxRunsPerScene, verbose: opts.verbose });
  }
  return new ChecklyExecutor({ dryRunOnly: !process.env.CHECKLY_API_KEY, verbose: opts.verbose });
}

export async function verify(opts: VerifyOptions): Promise<VerifyResult> {
  const { bundle, patchSource, verbose } = opts;
  const executor = opts.executor ?? makeExecutor({ appSimPath: opts.appSimPath, maxRunsPerScene: opts.maxRunsPerScene, verbose }, bundle);
  let synthetic: SyntheticExecutor | null = null;
  if (isSyntheticExecutor(executor)) synthetic = executor;

  const envDodge = detectEnvScopeDodge(bundle.checkSource, patchSource);

  const contract = buildContract(bundle, patchSource);
  if (verbose) {
    console.error(`[verify] ${bundle.incidentId}: ${bundle.scenes.length} scenes, determinism gate blocked=${contract.determinismGate.blocked}`);
  }

  const observations = new Map<string, SceneObservation>();
  for (const s of bundle.scenes) {
    observations.set(s.sceneId, await executor.runScene(bundle, patchSource, s));
  }
  // Determinism evidence is about the CANDIDATE's own repetitions; snapshot it
  // before the mutation phase runs weakened variants through the same executor.
  const nonDet = synthetic ? [...new Set(synthetic.nondeterministicScenes)] : [];

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
    } else {
      detObs = detectionScene ? await executor.runScene(bundle, m.source, detectionScene) : null;
      healthyObs = healthyScene ? await executor.runScene(bundle, m.source, healthyScene) : null;
      const detCaught = detObs?.observed === "pass"; // masked a must-fail → caught
      const healthyCaught = healthyObs?.observed === "fail"; // broke healthy → caught
      survived = !(detCaught || healthyCaught);
    }
    mutantResults.push({
      name: m.name,
      family: m.family,
      survived,
      detail: m.detail,
    });
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

  if (envDodge) {
    decision.reasons.push(`env-scope dodge detected: ${envDodge}`);
    if (decision.verdict === "PASS") {
      decision.verdict = "FAILED";
      decision.exitCode = 1;
    }
  }

  if (synthetic) await synthetic.close();

  const report = buildReport(contract, decision, observations);
  return {
    contract,
    observations,
    mutants: mutantResults,
    decision,
    report,
    envDodge,
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
  const h = bundle.scenes.filter((s): s is typeof s & { type: "HEALTHY" } => s.type === "HEALTHY");
  return h.reduce((acc, s) => acc + (observations.get(s.sceneId)?.repetitions ?? 0), 0);
}