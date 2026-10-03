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
import { repairedBookingSubject, sameOrRepairedBookingWrite } from "./repair.ts";

export interface MultiStepPolicyResult {
  rejected: string | null;
  uncertain: string | null;
  notes: string[];
}

/** Report a fixed syntax category, never the source path, identifier, raw
 * literal, imported package or assertion text embedded in a parser error. */
function unsupportedReason(errors: string[]): string | null {
  if (!errors.length) return null;
  const error = errors[0]!;
  const category = /unresolved expression/i.test(error) ? "unresolved expression"
    : /unsupported matcher/i.test(error) ? "unsupported matcher"
    : /constant cycle/i.test(error) ? "constant cycle"
    : /import/i.test(error) ? "unsupported executable import"
    : /request URL|origin provenance|ENVIRONMENT_URL/i.test(error) ? "unproven ENVIRONMENT_URL origin"
    : /helper|constructor|alias/i.test(error) ? "unknown executable helper"
    : /test.step|callback/i.test(error) ? "unbound executed test.step"
    : "unsupported source syntax";
  return `${category} in Multistep source — UNCERTAIN before execution`;
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
      ? `original Multistep source is unsupported: ${unsupportedReason(original.errors)}`
      : null;
  const candidateUncertain = !candidate
    ? "the candidate Multistep source could not be parsed"
    : candidate.errors.length > 0
      ? `candidate Multistep source is unsupported: ${unsupportedReason(candidate.errors)}`
      : null;

  // ---- FAILED checks on the candidate (definite, outrank UNCERTAIN) ----
  const rejections: string[] = [];
  if (candidate) {
    if (!candidate.construct && original?.construct) {
      rejections.push("MultiStepCheck construct removed — the incident check no longer exists");
    } else if (candidate.construct && original?.construct && candidate.construct.logicalId !== original.construct.logicalId) {
      rejections.push("MultiStepCheck logical ID changed — check identity must not change");
    }
    if (candidate.construct && original?.construct) {
      if (original.construct.executed && !candidate.construct.executed) {
        rejections.push("MultiStepCheck construct moved into dead or helper code — incident check no longer executes");
      }
      const keep = (c: NonNullable<MultiStepSourceModel["construct"]>) => ({
        name: c.name, entrypoint: c.entrypoint, frequencyMinutes: c.frequencyMinutes,
        locations: c.locations, runParallel: c.runParallel, doubleCheck: c.doubleCheck, activated: c.activated,
        muted: c.muted, tags: c.tags, environmentKeys: c.environmentKeys, environmentDefinitions: c.environmentDefinitions,
      });
      if (JSON.stringify(keep(candidate.construct)) !== JSON.stringify(keep(original.construct))) {
        rejections.push("MultiStepCheck construct settings changed (name/entrypoint/scheduling/locations/activation/tags/environment keys must remain bound to the incident check)");
      }
    }
    if (!candidate.script && original?.script) {
      rejections.push("Multistep transaction script missing from the candidate");
    } else if (candidate.script) {
      const required = (original?.script?.steps ?? []).filter((step) => step.executed);
      const allCandidateSteps = candidate.script.steps;
      const seen = allCandidateSteps.filter((step) => step.executed);
      // A same-title call in an uncalled helper, detached callback, or dead
      // branch cannot satisfy an executed required step. Unknown titles are
      // unsupported data flow, not proof that a known step was removed.
      const seenTitles = seen.map((s) => s.title);
      const requiredTitles = required.map((s) => s.title);
      const missing = requiredTitles.filter((title) => !seenTitles.includes(title));
      const unknownTitle = candidate.errors.some((error) => /test\.step title.*not a static string/.test(error));
      if (missing.length > 0 && (!unknownTitle || missing.some((title) => allCandidateSteps.some((step) => step.title === title && !step.executed)))) {
        rejections.push(`required test.step() removed or skipped (${missing.length} required step(s))`);
      }
      const requiredPresent = requiredTitles.filter((title) => seenTitles.includes(title));
      const seenRequired = seenTitles.filter((title) => requiredTitles.includes(title));
      if (JSON.stringify(requiredPresent) !== JSON.stringify(seenRequired)) {
        rejections.push("required test.step() reordered (required step sequence changed)");
      }
      const extra = seenTitles.filter((title) => !requiredTitles.includes(title));
      if (extra.length > 0 && requiredTitles.length > 0) {
        notes.push(`candidate adds ${extra.length} step(s) not in the original transaction`);
      }
      for (const step of allCandidateSteps) {
        if (requiredTitles.includes(step.title) && !step.awaited) {
          rejections.push("missing await on required test.step — definite FAILED");
        }
        if (requiredTitles.includes(step.title) && step.conditional) {
          rejections.push("required test.step is conditionally bypassed — definite FAILED");
        }
      }
      for (const marker of candidate.script.banned) {
        rejections.push(marker.startsWith("compatibility repair in assertion target")
          ? "compatibility repair in assertion target" : marker);
      }
      // A parse error makes the tuples unjudgeable: do not turn an unknown
      // matcher/expression into a definite failure just because its hash is
      // shared. Definite step/construct/banned changes above still outrank it.
      if (original?.script && original.errors.length === 0 && candidate.errors.length === 0) {
        const requestTuple = (r: typeof candidate.script.requests[number]) => [r.stepTitle, r.method, r.urlTemplate, r.headerKeys, r.bodyKeys, r.usesBearer, r.optionsShape];
        if (candidate.script.securityBindings.length !== original.script.securityBindings.length
          || original.script.securityBindings.some((binding, i) =>
            !sameOrRepairedBookingWrite(binding, candidate.script!.securityBindings[i]!))) {
          rejections.push("Multistep environment, regional account, slot or bearer-token data binding changed — the captured transaction cannot be retargeted");
        }
        if (JSON.stringify(candidate.script.requests.map(requestTuple)) !== JSON.stringify(original.script.requests.map(requestTuple))) {
          rejections.push("ordered Multistep requests changed (method, URL provenance, step, headers or body shape) — the captured transaction may not be bypassed");
        }
        // ID deliberately hashes matcher+target, not subject. Diff *tuples*,
        // with occurrence counts and order, before consulting IDs. A stale
        // book-body field may acquire the corresponding nested booking field
        // with the same ID: that is removed+added contract evidence, not a
        // substituted retained assertion. Other same-ID substitutions cannot
        // launder a check or move an assertion to a different step.
        const originalAssertions = original.script.assertions;
        const candidateAssertions = candidate.script.assertions;
        const tuple = (a: typeof candidateAssertions[number]) => JSON.stringify([a.stepTitle, a.id, a.subject, a.matcher, a.target, a.negated]);
        const retainedOld = originalAssertions.map(tuple).filter((key) => candidateAssertions.some((a) => tuple(a) === key));
        const retainedNew = candidateAssertions.map(tuple).filter((key) => originalAssertions.some((a) => tuple(a) === key));
        if (JSON.stringify(retainedOld) !== JSON.stringify(retainedNew)) {
          rejections.push("step-scoped assertion tuples with retained IDs were moved, substituted, duplicated or reordered");
        }
        const oldCounts = new Map<string, number>();
        const newCounts = new Map<string, number>();
        for (const a of originalAssertions) oldCounts.set(tuple(a), (oldCounts.get(tuple(a)) ?? 0) + 1);
        for (const a of candidateAssertions) newCounts.set(tuple(a), (newCounts.get(tuple(a)) ?? 0) + 1);
        const missingTuples = originalAssertions.filter((a) => (newCounts.get(tuple(a)) ?? 0) < (oldCounts.get(tuple(a)) ?? 0));
        const addedTuples = candidateAssertions.filter((a) => (oldCounts.get(tuple(a)) ?? 0) < (newCounts.get(tuple(a)) ?? 0));
        const nestedRepair = (old: typeof originalAssertions[number], next: typeof candidateAssertions[number]): boolean =>
          old.stepTitle === "book 09:30" && next.stepTitle === old.stepTitle && next.id === old.id
          && !old.negated && !next.negated && next.matcher === old.matcher && next.target === old.target
          && repairedBookingSubject(old.subject) === next.subject;
        for (const old of missingTuples) {
          const colliding = addedTuples.filter((next) => next.id === old.id);
          if (colliding.length && !colliding.some((next) => nestedRepair(old, next))) {
            rejections.push("step-scoped assertion tuples with retained IDs were moved, substituted, duplicated or reordered");
            break;
          }
        }
        if (missingTuples.length) notes.push(`${missingTuples.length} original assertion tuple(s) replaced (full step-scoped inventory diff governs the verdict)`);
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
