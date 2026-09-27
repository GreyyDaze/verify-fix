// Static policy for Multistep candidates — the binding parser-and-policy law
// from the Stage-7 requirements, applied to the parsed source model.
//
// Reuses the trusted architecture: the result shape mirrors ApiPolicyResult
// (rejected → FAILED through the existing decision law, uncertain →
// UNCERTAIN through the existing decision law). This is NOT a second verdict
// law — it is static evidence feeding the same decide() table.
//
// FAILED (definite):
//   missing await on a required test.step(); removed, skipped, disabled,
//   reordered, or conditionally bypassed required steps; skip/fixme/soft
//   assertions/catch-ignore/shouldFail; retries or timeouts used as repair;
//   response rewriting; fabricated tokens; hardcoded hosts; hidden or
//   compatibility-repaired assertions; ENVIRONMENT_URL fallbacks.
// UNCERTAIN (never approximated):
//   unsupported syntax, unresolved imports/constants, unsupported matchers,
//   missing or unreadable evidence inputs.

import type { MultiStepSourceModel } from "./source.ts";

export interface MultiStepPolicyResult {
  rejected: string | null;
  uncertain: string | null;
  notes: string[];
}

function stepTitles(model: MultiStepSourceModel): string[] {
  return model.script?.steps.map((s) => s.title) ?? [];
}

export function evaluateMultiStepPolicy(
  original: MultiStepSourceModel | null,
  candidate: MultiStepSourceModel | null,
): MultiStepPolicyResult {
  const notes: string[] = [];

  // ---- UNCERTAIN inputs: a model we cannot read cannot be judged ----
  const originalUncertain = !original
    ? "the original Multistep source could not be parsed"
    : original.errors.length > 0
      ? `original Multistep source is unsupported: ${original.errors.join("; ")}`
      : null;
  const candidateUncertain = !candidate
    ? "the candidate Multistep source could not be parsed"
    : candidate.errors.length > 0
      ? `candidate Multistep source is unsupported: ${candidate.errors.join("; ")}`
      : null;

  // ---- FAILED checks on the candidate (definite, outrank UNCERTAIN) ----
  const rejections: string[] = [];
  if (candidate) {
    if (!candidate.construct) {
      rejections.push("MultiStepCheck construct removed — the incident check no longer exists");
    } else if (candidate.construct.logicalId !== original?.construct?.logicalId) {
      rejections.push(`MultiStepCheck logical ID changed (${String(original?.construct?.logicalId)} → ${String(candidate.construct.logicalId)}) — check identity must not change`);
    }
    if (!candidate.script) {
      rejections.push("Multistep transaction script missing from the candidate");
    } else {
      const required = original?.script?.steps ?? [];
      const seen = candidate.script.steps;
      // ordering + presence of every required step
      const seenTitles = seen.map((s) => s.title);
      const requiredTitles = required.map((s) => s.title);
      const missing = requiredTitles.filter((title) => !seenTitles.includes(title));
      if (missing.length > 0) {
        rejections.push(`required test.step() removed or skipped: ${missing.join(", ")}`);
      }
      const requiredPresent = requiredTitles.filter((title) => seenTitles.includes(title));
      const seenRequired = seenTitles.filter((title) => requiredTitles.includes(title));
      if (JSON.stringify(requiredPresent) !== JSON.stringify(seenRequired)) {
        rejections.push(`required test.step() reordered: expected ${requiredPresent.join(" → ")}, candidate has ${seenRequired.join(" → ")}`);
      }
      const extra = seenTitles.filter((title) => !requiredTitles.includes(title));
      if (extra.length > 0 && requiredTitles.length > 0) {
        notes.push(`candidate adds step(s) not in the original transaction: ${extra.join(", ")}`);
      }
      for (const step of seen) {
        if (requiredTitles.includes(step.title) && !step.awaited) {
          rejections.push(`missing await on required test.step('${step.title}') — definite FAILED`);
        }
        if (requiredTitles.includes(step.title) && step.conditional) {
          rejections.push(`required test.step('${step.title}') is conditionally bypassed — definite FAILED`);
        }
      }
      for (const marker of candidate.script.banned) {
        rejections.push(`${marker}`);
      }
      const originalAssertions = new Set(original?.script?.assertions.map((a) => a.id) ?? []);
      const candidateAssertions = new Set(candidate.script.assertions.map((a) => a.id));
      const removedCount = [...originalAssertions].filter((id) => !candidateAssertions.has(id)).length;
      if (originalAssertions.size > 0 && removedCount > 0) {
        notes.push(`${removedCount} original assertion(s) no longer present in the candidate (inventory diff governs the verdict)`);
      }
    }
  }

  const rejected = rejections.length > 0 ? rejections.join("; ") : null;
  const uncertain = rejected === null ? (originalUncertain ?? candidateUncertain) : null;
  if (original && original.script && original.script.steps.length === 0) {
    notes.push("original Multistep script declares no ordered steps — the required-step baseline is empty");
  }
  return { rejected, uncertain, notes };
}

/** Human-readable ordered-step baseline for reports. */
export function requiredSteps(model: MultiStepSourceModel | null): string[] {
  if (!model) return [];
  const titles = stepTitles(model);
  return titles.length > 0 ? titles : model.construct ? [model.construct.name ?? model.construct.logicalId ?? "multistep"] : [];
}
