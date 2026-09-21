// Adequacy engine (prod PRD §5.2): scans the suite against STING's four
// weakness classes and computes oracle_strength ∈ [0,1] from (a) assertion
// falsifiability, (b) per-scene assertion coverage, (c) env-assumption
// completeness, (d) mutant-kill rate. Weak → cannot PASS.

import type { Bundle, OracleStrength, SceneObservation, SceneType, WeaknessScan } from "../types.ts";
import type { ContractReport } from "../contract/contract.ts";

export interface MutantResult {
  name: string;
  family: "operator" | "llm";
  survived: boolean;
  detail: string;
}

export interface AdequacyInput {
  contract: ContractReport;
  sceneObservations: Map<string, SceneObservation>;
  mutants: MutantResult[];
}

export interface AdequacyOutput {
  strength: OracleStrength;
  weakness: WeaknessScan;
  blockers: string[];
  mutants: MutantResult[];
}

const INDEPENDENT_TYPES: SceneType[] = ["REPRODUCTION", "HEALTHY", "DETECTION", "REGRESSION"];

export function assessAdequacy(input: AdequacyInput): AdequacyOutput {
  const { contract, sceneObservations, mutants } = input;
  const b: Bundle = contract.bundle;

  const critical = contract.original.assertions.filter((a) => a.onCriticalPath);
  const falsifiableCrit = critical.filter((a) => a.falsifiable);
  const falsifiability = critical.length === 0 ? 0 : falsifiableCrit.length / critical.length;

  const falsifiableIds = new Set(falsifiableCrit.map((a) => a.id));
  let coveredIds = new Set<string>();
  let partialPathCoverage = false;
  for (const s of b.scenes) {
    const involved = (s.assertionsInvolved ?? []).filter((id) => falsifiableIds.has(id));
    if (involved.length === 0) partialPathCoverage = true;
    for (const id of involved) coveredIds.add(id);
  }
  const coverage = falsifiableIds.size === 0 ? 0 : coveredIds.size / falsifiableIds.size;

  const totalEnv = b.envAssumptions.length;
  const verifiedEnv = b.envAssumptions.filter((a) => a.verified).length;
  const envCompleteness = totalEnv === 0 ? 1 : verifiedEnv / totalEnv;

  const killed = mutants.filter((m) => m.survived === false).length;
  const mutantKillRate = mutants.length === 0 ? 0 : killed / mutants.length;

  const score = Math.min(1, 0.3 * falsifiability + 0.3 * coverage + 0.2 * envCompleteness + 0.2 * mutantKillRate);

  const independentTypes = new Set<SceneType>();
  for (const t of INDEPENDENT_TYPES) if ((contract.sceneCountByType[t] ?? 0) > 0) independentTypes.add(t);
  const insufficientInputSpace = b.scenes.length < 3 || independentTypes.size < 2;

  const operators = new Set<string>();
  for (const m of mutants) if (m.family === "operator") operators.add(m.name);
  const llm = new Set<string>();
  for (const m of mutants) if (m.family === "llm") llm.add(m.name);

  const missingEnvContext = b.envAssumptions.filter((a) => !a.verified).map((a) => a.id);

  const weakAssertions = contract.original.assertions
    .filter((a) => a.kind === "property" || !a.falsifiable)
    .map((a) => ({ assertionId: a.id, reason: `matcher ${a.matcher}${a.falsifiable ? "" : " is not falsifiable"} (STING weak-assertion class)` }));

  const weakness: WeaknessScan = {
    insufficientInputSpace,
    partialPathCoverage,
    weakAssertions,
    missingEnvContext,
    operatorMutants: [...operators],
    llmMutants: [...llm],
  };

  const strength: OracleStrength = { score, falsifiability, coverage, envCompleteness, mutantKillRate };

  const blockers: string[] = [];
  if (insufficientInputSpace) blockers.push("insufficient input space: fewer than 3 scenes or <2 independent scene types (PR-6)");
  if (partialPathCoverage) blockers.push("partial path coverage: one or more scenes exercise no falsifiable assertion");
  if (contract.unverifiedAssumptions.length > 0) blockers.push("unverified env assumptions (STING class 4 / 3-vs-18 lesson)");
  if (weakAssertions.length > 0) blockers.push(`${weakAssertions.length} weak (non-falsifiable) assertion(s) on core path`);

  return { strength, weakness, blockers, mutants: input.mutants };
}