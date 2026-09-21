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

  // Mutation phase: few, directed weak variants of the CANDIDATE patch.
  // Killed = the suite caught it (detection switched to pass, or healthy broke).
  // Survived = behaviorally identical to the candidate across the scenes — the
  // oracle cannot see the piece the mutant removed → blind-spot signal.
  const mutantResults: MutantResult[] = [];
  const detectionScene = bundle.scenes.find((s) => s.type === "DETECTION");
  const healthyScene = bundle.scenes.find((s) => s.type === "HEALTHY");
  for (const m of seedMutants(patchSource, bundle.check.file)) {
    const detObs = detectionScene ? await executor.runScene(bundle, m.source, detectionScene) : null;
    const healthyObs = healthyScene ? await executor.runScene(bundle, m.source, healthyScene) : null;
    const detCaught = detObs === null ? false : detObs.observed === "pass"; // masked a must-fail → caught
    const healthyCaught = healthyObs === null ? false : healthyObs.observed === "fail"; // broke healthy → caught
    const survived = !(detCaught || healthyCaught);
    mutantResults.push({
      name: m.name,
      family: m.family,
      survived,
      detail: m.detail,
    });
    if (verbose) {
      console.error(`[verify] mutant ${m.name} (${m.family}) survived=${survived} (det="${detObs?.observed}", healthy="${healthyObs?.observed}")`);
    }
  }

  const nonDet = synthetic ? [...synthetic.nondeterministicScenes] : [];
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

export function healthyRunsUsed(bundle: Bundle, observations: Map<string, SceneObservation>): number {
  const h = bundle.scenes.filter((s): s is typeof s & { type: "HEALTHY" } => s.type === "HEALTHY");
  return h.reduce((acc, s) => acc + (observations.get(s.sceneId)?.repetitions ?? 0), 0);
}