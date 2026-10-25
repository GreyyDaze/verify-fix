// The only source-side moves the bundle scenario justifies. These are not
// general response rewriting or loose same-ID matches: matcher, target,
// negation, step, source binding and occurrence counts are independently
// enforced by policy + contract + the local runner.
import type { MultistepEvidenceScenario } from "../../types.ts";

export function repairedSubject(scenario: MultistepEvidenceScenario | null | undefined, subject: string): string | null {
  return scenario?.repair?.find((move) => move.from === subject)?.to ?? null;
}

// A field move must still source each cross-step variable from the actual
// response. All declarations and all non-repaired writes stay byte-identical.
export function sameOrRepairedWrite(scenario: MultistepEvidenceScenario | null | undefined,
  original: string, candidate: string): boolean {
  if (candidate === original) return true;
  if (scenario?.writes?.some((move) => move.from === original && move.to === candidate)) return true;
  // A repaired binding is the same expression with one scenario-proven field
  // move substituted; no other byte of the binding may change.
  return (scenario?.repair ?? []).some((move) =>
    original.includes(move.from) && original.split(move.from).join(move.to) === candidate);
}
