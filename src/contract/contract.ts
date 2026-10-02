// Contract engine — the oracle generator (prod PRD §5.1).
// Deterministic. Validates verdict provenance against the two legal sources
// (PR-3), builds the assertion inventory of original vs patched check, checks
// the diff for weakened/removed/guarded core-path assertions, and verifies
// envAssumptions + the reproduction-determinism gate (PR-7).

import type { Assertion, AssertionInventory, Bundle, EvidenceRow, Scene, SceneType } from "../types.ts";
import { parseMultiStepProject } from "../multistep/source.ts";
import { repairedBookingSubject } from "../multistep/repair.ts";
import { parseProjectInventory, inventoryDiff, type InventoryDiff } from "../assertion/inventory.ts";

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

/** Multistep identity is a full, counted (step, subject, matcher, target)
 * tuple. assertionId remains unchanged and can legitimately collide for two
 * different subjects; no same-ID shortcut may erase removed/added evidence. */
function multistepTupleDiff(bundle: Bundle, before: Map<string, string>, after: Map<string, string>,
  original: AssertionInventory, patched: AssertionInventory, base: InventoryDiff, candidateFile: string): InventoryDiff {
  const oldModel = parseMultiStepProject(before, bundle.check.file)?.script;
  const newModel = parseMultiStepProject(after, candidateFile)?.script;
  if (!oldModel || !newModel) return base;
  const key = (a: typeof oldModel.assertions[number]): string => JSON.stringify([a.stepTitle, a.id, a.subject, a.matcher, a.target, a.negated]);
  const oldCounts = new Map<string, number>();
  const newCounts = new Map<string, number>();
  for (const item of oldModel.assertions) oldCounts.set(key(item), (oldCounts.get(key(item)) ?? 0) + 1);
  for (const item of newModel.assertions) newCounts.set(key(item), (newCounts.get(key(item)) ?? 0) + 1);
  const seenOld = new Map<string, number>();
  const seenNew = new Map<string, number>();
  const removed: Assertion[] = [];
  const added: Assertion[] = [];
  const failure = bundle.multistep?.problems.length === 0 ? bundle.multistep.failureAssertion : null;
  const originalStale = oldModel.assertions.find((item) => item.stepTitle === "book 09:30"
    && item.sourceLine === failure?.line && item.id === failure?.id && item.subject === "body.confirmed"
    && item.matcher === "toBe" && item.target === "true" && !item.negated);
  const protectedRepair = Boolean(failure && originalStale && failure.file === bundle.check.file
    && failure.step === "book 09:30" && !oldModel.errors.length && !newModel.errors.length
    && newModel.assertions.some((item) => item.stepTitle === failure.step && item.id === failure.id
      && item.subject === "body.booking.confirmed" && item.matcher === "toBe"
      && item.target === "true" && !item.negated));
  const repairedBookField = (old: typeof oldModel.assertions[number]): boolean => {
    const subject = repairedBookingSubject(old.subject);
    if (!protectedRepair || !failure || !subject || old.negated || old.stepTitle !== failure.step) return false;
    const replacement = { ...old, subject };
    // A duplicated assertion cannot be discharged by just one same-ID
    // replacement. Require every occurrence to remain hard and step-scoped.
    if ((newCounts.get(key(replacement)) ?? 0) < (oldCounts.get(key(old)) ?? 0)) return false;
    return newModel.assertions.some((next) => key(next) === key(replacement));
  };
  for (let i = 0; i < oldModel.assertions.length; i++) {
    const tuple = oldModel.assertions[i]!;
    const tupleKey = key(tuple);
    const seen = (seenOld.get(tupleKey) ?? 0) + 1;
    seenOld.set(tupleKey, seen);
    if (seen <= (newCounts.get(tupleKey) ?? 0)) continue;
    const assertion = original.assertions[i];
    if (assertion) removed.push(repairedBookField(tuple) ? { ...assertion, onCriticalPath: false } : assertion);
  }
  for (let i = 0; i < newModel.assertions.length; i++) {
    const tuple = newModel.assertions[i]!;
    const tupleKey = key(tuple);
    const seen = (seenNew.get(tupleKey) ?? 0) + 1;
    seenNew.set(tupleKey, seen);
    if (seen <= (oldCounts.get(tupleKey) ?? 0)) continue;
    const assertion = patched.assertions[i];
    if (assertion) added.push(assertion);
  }
  return { ...base, removed, added };
}

export function sceneExpected(scene: Scene): { observed: "pass" | "fail"; oracle: string } {
  const p = scene.verdict.provenance;
  const oracle =
    p.kind === "recorded" ? `recorded:${p.runId} (${p.artifactId})` : `code:assert:${p.assertionId}`;
  return { observed: scene.verdict.mustFail ? "fail" : "pass", oracle };
}

export function buildContract(bundle: Bundle, patchedSource: string, patchedFiles?: Map<string, string>, patchedCheckFile?: string): ContractReport {
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

  const originalFiles = new Map(Object.entries(bundle.files));
  originalFiles.set(bundle.check.file, bundle.checkSource);
  const candidateFiles = patchedFiles ? new Map(patchedFiles) : new Map(originalFiles);
  const candidateCheckFile = patchedCheckFile ?? bundle.check.file;
  candidateFiles.set(candidateCheckFile, patchedSource);
  const original = parseProjectInventory(bundle.check.file, originalFiles, bundle.check.logicalId, bundle.check.checkType);
  const patched = parseProjectInventory(candidateCheckFile, candidateFiles, bundle.check.logicalId, bundle.check.checkType);
  const genericDiff = inventoryDiff(original, patched);
  const diff = bundle.check.checkType === "MULTI_STEP"
    ? multistepTupleDiff(bundle, originalFiles, candidateFiles, original, patched, genericDiff, candidateCheckFile)
    : genericDiff;

  const unverifiedAssumptions: string[] = [];
  for (const a of bundle.envAssumptions) {
    if (!a.verified) unverifiedAssumptions.push(a.id);
  }

  const determinismGate = (() => {
    if (bundle.determinism.achieved < bundle.determinism.targetRuns) {
      return { blocked: true, reason: `reproduction only verified for ${bundle.determinism.achieved}/${bundle.determinism.targetRuns} runs (PR-7 N≥20 bar not met)` };
    }
    const reproductionFailRate = bundle.determinism.reproductionFailRate ?? bundle.determinism.overlapFailRate;
    if (reproductionFailRate !== 1) {
      return { blocked: true, reason: `reproduction fail-rate ${reproductionFailRate * 100}% ≠ 100% — the incident is not deterministic` };
    }
    // A separate healthy baseline exists for timing/concurrency incidents. A
    // persistent `live` drift incident has no green baseline on the current
    // target; its one-at-a-time failures are the reproduction itself.
    const baselinePassRate = bundle.determinism.baselinePassRate === undefined ? bundle.determinism.sequentialPassRate : bundle.determinism.baselinePassRate;
    if (baselinePassRate !== null && baselinePassRate !== 1) {
      return { blocked: true, reason: `baseline pass-rate ${baselinePassRate * 100}% ≠ 100% — healthy baseline is not deterministic` };
    }
    return { blocked: false, reason: `determinism gate passed${bundle.determinism.method ? ` (${bundle.determinism.method})` : ""}` };
  })();

  const suppressionCandidates = patched.assertions
    .filter((a) => a.guarded && a.kind === "exact" && a.falsifiable)
    .map((a) => `${a.id} (${a.subject}) wrapped in catch/soft — can swallow the real failure`);

  // Rows start with NO observation; the decision table fills `observed` from
  // the executor. Starting at "pass" would make an unobserved scene look green.
  const rows: EvidenceRow[] = bundle.scenes.map((scene) => {
    const { observed: expected, oracle } = sceneExpected(scene);
    return {
      experiment: scene.sceneId,
      environment: scene.environment ?? "target",
      oracle,
      observed: "uncertain",
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