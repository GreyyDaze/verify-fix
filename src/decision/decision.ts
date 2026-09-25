// Decision table — AI-free verdict (prod PRD §6 law, unchanged). No LLM. Every
// reason traces to an executed comparison. This module is what grep audits:
// it must contain no LLM import and no probabilistic judgment.

import type { Bundle, Decision, EvidenceRow, ObservationValue, OracleExpectation, Scene, SceneObservation, VerdictValue } from "../types.ts";
import type { ContractReport } from "../contract/contract.ts";
import type { AdequacyOutput, MutantResult } from "../adequacy/adequacy.ts";

export const ORACLE_STRENGTH_THRESHOLD = 0.7;

export interface DecisionInput {
  contract: ContractReport;
  observations: Map<string, SceneObservation>;
  adequacy: AdequacyOutput;
  /** Determinism/PR-12 guards computed during execution. */
  nonDeterministicScenes: string[];
  healthyRepetitionsMet: boolean;
  runBudgetExhausted: boolean;
}

function expectedOf(scene: Scene): OracleExpectation {
  return scene.verdict.mustFail ? "fail" : "pass";
}

export function decide(input: DecisionInput): Decision {
  const { contract, observations, adequacy, nonDeterministicScenes, healthyRepetitionsMet, runBudgetExhausted } = input;
  const b: Bundle = contract.bundle;
  const reasons: string[] = [];

  if (contract.provenanceViolations.length > 0) {
    return {
      verdict: "UNCERTAIN",
      exitCode: 2,
      rows: contract.rows,
      reasons: [`bundle rejected at ingestion: ${contract.provenanceViolations.join("; ")}`],
      adequacy: adequacy.strength,
      weakness: adequacy.weakness,
    };
  }

  const rows: EvidenceRow[] = contract.rows.map((row) => {
    const scene = b.scenes.find((s) => s.sceneId === row.experiment)!;
    const obs = observations.get(scene.sceneId);
    // A scene that was never observed is not a pass: it is missing evidence.
    const observed: ObservationValue = obs?.observed ?? "uncertain";
    const note = observed === "uncertain" ? obs?.reason ?? "scene was not observed" : undefined;
    const matched = observed !== "uncertain" && observed === row.expected;
    // the executor knows what the run actually talked to; the scene's declared kind is the fallback
    const environment = obs?.environment ?? row.environment;
    return { ...row, environment, observed, matched, strength: adequacy.strength.score, ...(note ? { note } : {}) };
  });

  // Only a real pass/fail can mismatch an oracle; an uncertain observation is
  // neither evidence for nor against the patch.
  const uncertainRows = rows.filter((r) => r.observed === "uncertain");
  const mismatchRows = rows.filter((r) => r.observed !== "uncertain" && !r.matched);
  const regressionRows = rows.filter((r) => r.experiment.startsWith("scene-") && r.expected === "pass");
  const regressionMismatch = regressionRows.filter((r) => r.observed !== "uncertain" && !r.matched);

  // ── law, in order ─────────────────────────────────────────────────────────
  if (contract.determinismGate.blocked) {
    reasons.push(`determinism gate: ${contract.determinismGate.reason}`);
  }

  if (nonDeterministicScenes.length > 0) {
    reasons.push(`non-deterministic reproduction observed in: ${[...new Set(nonDeterministicScenes)].join(", ")}`);
  }

  if (mismatchRows.length > 0) {
    reasons.push(
      mismatchRows.map((r) => `experiment ${r.experiment}: oracle ${r.oracle} ⇒ expected ${r.expected}, observed ${r.observed} — MISMATCH`).join(" | ")
    );
    return { verdict: "FAILED", exitCode: 1, rows, reasons, adequacy: adequacy.strength, weakness: adequacy.weakness };
  }

  const coreWeakened = contract.diff.removed.filter((a) => a.onCriticalPath);
  const coreWeakened2 = contract.diff.weakened.filter((a) => a.onCriticalPath);
  if (coreWeakened.length > 0 || coreWeakened2.length > 0) {
    reasons.push(
      `core-path assertion weakened/removed: ${[...coreWeakened, ...coreWeakened2]
        .map((a) => `${a.id} (${a.subject}.${a.matcher})`)
        .join(", ")}`
    );
    return { verdict: "FAILED", exitCode: 1, rows, reasons, adequacy: adequacy.strength, weakness: adequacy.weakness };
  }

  if (contract.suppressionCandidates.length > 0) {
    reasons.push(`suppression candidates (assertion wrapped so a real failure can be swallowed): ${contract.suppressionCandidates.join("; ")}`);
    return { verdict: "FAILED", exitCode: 1, rows, reasons, adequacy: adequacy.strength, weakness: adequacy.weakness };
  }

  // Inconclusive evidence gate: a scene with no admissible observation (the
  // check never contacted the armed app, the sandbox could not run it, the
  // repetitions disagreed, or the budget ran out) cannot satisfy its oracle in
  // either direction. Nothing below may turn it into a PASS.
  if (uncertainRows.length > 0) {
    reasons.push(
      uncertainRows.map((r) => `experiment ${r.experiment}: oracle ${r.oracle} ⇒ expected ${r.expected}, observed uncertain — ${r.note ?? "no admissible evidence"}`).join(" | ")
    );
    reasons.push("no admissible observation for one or more scenes → UNCERTAIN, never PASS");
    return { verdict: "UNCERTAIN", exitCode: 2, rows, reasons, adequacy: adequacy.strength, weakness: adequacy.weakness };
  }

  const survivedMutants: MutantResult[] = adequacy.mutants.filter((m) => m.survived);
  if (survivedMutants.length > 0) {
    const gap = adequacy.strength.score < ORACLE_STRENGTH_THRESHOLD;
    reasons.push(
      `mutant survived: ${survivedMutants.map((m) => `${m.name} (${m.family}) — ${m.detail}`).join("; ")}; oracle_strength=${adequacy.strength.score.toFixed(3)}`
    );
    reasons.push(gap ? "oracle below threshold → verifier blind spot, no PASS" : "oracle above threshold → weakening caught");
    return { verdict: gap ? "UNCERTAIN" : "FAILED", exitCode: gap ? 2 : 1, rows, reasons, adequacy: adequacy.strength, weakness: adequacy.weakness };
  }

  if (runBudgetExhausted) {
    reasons.push("run budget exhausted → UNCERTAIN, never PASS (PR-10)");
    return { verdict: "UNCERTAIN", exitCode: 2, rows, reasons, adequacy: adequacy.strength, weakness: adequacy.weakness };
  }

  if (contract.determinismGate.blocked) {
    return { verdict: "UNCERTAIN", exitCode: 2, rows, reasons, adequacy: adequacy.strength, weakness: adequacy.weakness };
  }

  if (nonDeterministicScenes.length > 0) {
    return { verdict: "UNCERTAIN", exitCode: 2, rows, reasons, adequacy: adequacy.strength, weakness: adequacy.weakness };
  }

  const independentSceneTypes = new Set(rows.filter((r) => ["REPRODUCTION", "HEALTHY", "DETECTION", "REGRESSION"].includes(contract.bundle.scenes.find((s) => s.sceneId === r.experiment)?.type ?? "")).map((r) => contract.bundle.scenes.find((s) => s.sceneId === r.experiment)!.type));
  const weakHitsOnCore = adequacy.weakness?.weakAssertions.length ?? 0;
  const envAllVerified = contract.unverifiedAssumptions.length === 0;
  const minScenes = b.scenes.length >= 3;

  let passOk = true;
  if (adequacy.strength.score < ORACLE_STRENGTH_THRESHOLD) {
    reasons.push(`oracle_strength=${adequacy.strength.score.toFixed(3)} < ${ORACLE_STRENGTH_THRESHOLD} (adequate scenes required)`);
    passOk = false;
  }
  if (independentSceneTypes.size < 2) {
    reasons.push("fewer than 2 independent experiment types present (PR-6)");
    passOk = false;
  }
  if (weakHitsOnCore > 1) {
    reasons.push(`${weakHitsOnCore} weak-assertion hits on core path (>1 forbidden for PASS)`);
    passOk = false;
  }
  if (!envAllVerified) {
    reasons.push(`env assumptions not 100% verified: ${contract.unverifiedAssumptions.join(", ")}`);
    passOk = false;
  }
  if (!minScenes) {
    reasons.push("fewer than 3 scenes");
    passOk = false;
  }
  if (regressionMismatch.length > 0) {
    reasons.push("regression scenes mismatched (behavioral regression)");
    passOk = false;
  }
  if (!healthyRepetitionsMet) {
    reasons.push("healthy runs not repeated ≥5 (PR-12 flake guard)");
    passOk = false;
  }

  if (passOk) {
    reasons.push("all experiments matched, mutants killed, adequacy above threshold → PASS");
    return { verdict: "PASS", exitCode: 0, rows, reasons, adequacy: adequacy.strength, weakness: adequacy.weakness };
  }

  reasons.push("no violation found, but mandatory PASS conditions not all met → UNCERTAIN");
  return { verdict: "UNCERTAIN", exitCode: 2, rows, reasons, adequacy: adequacy.strength, weakness: adequacy.weakness };
}

export function verdictWord(v: VerdictValue): string {
  return v;
}