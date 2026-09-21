// Contract engine — the oracle generator (prod PRD §5.1).
// Deterministic. Validates verdict provenance against the two legal sources
// (PR-3), builds the assertion inventory of original vs patched check, checks
// the diff for weakened/removed/guarded core-path assertions, and verifies
// envAssumptions + the reproduction-determinism gate (PR-7).

import type { AssertionInventory, Bundle, EvidenceRow, Scene, SceneType } from "../types.ts";
import { parseInventory, inventoryDiff, type InventoryDiff } from "../assertion/inventory.ts";

export interface ContractReport {
  bundle: Bundle;
  original: AssertionInventory;
  patched: AssertionInventory;
  diff: InventoryDiff;
  /** scenes whose oracle verdict could not be traced → the bundle is invalid. */
  provenanceViolations: string[];
  unverifiedAssumptions: string[];
  determinismGate: { blocked: boolean; reason: string };
  /** engine-side dodge signals on the patched check */
  suppressionCandidates: string[];
  rows: EvidenceRow[];
  sceneCountByType: Partial<Record<SceneType, number>>;
}

const LEGAL_PROVENANCE = new Set(["recorded", "code"]);

export function sceneExpected(scene: Scene): { observed: "pass" | "fail"; oracle: string } {
  const p = scene.verdict.provenance;
  const oracle =
    p.kind === "recorded" ? `recorded:${p.runId} (${p.artifactId})` : `code:assert:${p.assertionId}`;
  return { observed: scene.verdict.mustFail ? "fail" : "pass", oracle };
}

export function buildContract(bundle: Bundle, patchedSource: string): ContractReport {
  const violations: string[] = [];
  for (const scene of bundle.scenes) {
    const p = scene.verdict.provenance;
    if (typeof p.kind !== "string" || !LEGAL_PROVENANCE.has(p.kind)) {
      violations.push(`${scene.sceneId}: provenance kind '${(p as { kind?: string }).kind ?? "?"}' is not recorded|code`);
    }
    if (p.kind === "recorded" && (!p.runId || !p.artifactId)) {
      violations.push(`${scene.sceneId}: recorded provenance missing runId/artifactId`);
    }
    if (p.kind === "code" && !/^assert:/.test(p.assertionId)) {
      violations.push(`${scene.sceneId}: code provenance id '${p.assertionId}' is not an assertion id`);
    }
  }

  const original = parseInventory(bundle.check.file, bundle.checkSource);
  const patched = parseInventory(bundle.check.file, patchedSource);
  const diff = inventoryDiff(original, patched);

  const unverifiedAssumptions: string[] = [];
  for (const a of bundle.envAssumptions) {
    if (!a.verified) unverifiedAssumptions.push(a.id);
  }

  const determinismGate = (() => {
    if (bundle.determinism.achieved < bundle.determinism.targetRuns) {
      return { blocked: true, reason: `reproduction only verified for ${bundle.determinism.achieved}/${bundle.determinism.targetRuns} runs (PR-7 N≥20 bar not met)` };
    }
    if (bundle.determinism.overlapFailRate !== 1) {
      return { blocked: true, reason: `overlap fail-rate ${bundle.determinism.overlapFailRate * 100}% ≠ 100% — reproduction is not deterministic` };
    }
    if (bundle.determinism.sequentialPassRate !== 1) {
      return { blocked: true, reason: `sequential pass-rate ${bundle.determinism.sequentialPassRate * 100}% ≠ 100% — healthy baseline is not deterministic` };
    }
    return { blocked: false, reason: "determinism gate passed" };
  })();

  const suppressionCandidates = patched.assertions
    .filter((a) => a.guarded && a.kind === "exact" && a.falsifiable)
    .map((a) => `${a.id} (${a.subject}) wrapped in catch/soft — can swallow the real failure`);

  const rows: EvidenceRow[] = bundle.scenes.map((scene) => {
    const { observed: expected, oracle } = sceneExpected(scene);
    return {
      experiment: scene.sceneId,
      oracle,
      observed: "pass",
      expected,
      matched: false,
      strength: 0,
    };
  });

  const sceneCountByType: Partial<Record<SceneType, number>> = {};
  for (const s of bundle.scenes) sceneCountByType[s.type] = (sceneCountByType[s.type] ?? 0) + 1;

  return {
    bundle,
    original,
    patched,
    diff,
    provenanceViolations: violations,
    unverifiedAssumptions,
    determinismGate,
    suppressionCandidates,
    rows,
    sceneCountByType,
  };
}