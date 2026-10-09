// Multistep candidate matrix (Track A1, local half).
//
// fixtures/patches/slots-booking-multistep-nested-response/ holds eight
// hand-written candidate scripts instead of one.
//
// WHAT IS BEING COMPARED, AND WHY. The captured original asserts the FLAT
// `body.confirmed`; the application now returns `booking.*`. Every candidate
// therefore legitimately rewrites that block, so a diff against the original
// cannot separate the correct repair from a fake that mangles the same block.
// The families are compared in two layers:
//
//   Layer 1 — against the ORIGINAL, for damage the rewrite is NOT allowed to
//             cause: removed steps, missing await, reordered steps, swallowed
//             assertions. This is evaluateMultiStepPolicy.
//   Layer 2 — against the KNOWN-GOOD REPAIR (01), for weakening inside the
//             rewritten block itself: a loose operator, a deleted assertion, a
//             hardcoded constant. This is a counted (step, subject, matcher,
//             target, negated) tuple diff.
//
// SCOPE NOTE: this proves the verifier's static gates on the Multistep family.
// It is NOT Checkly, browser, deployment, or cloud proof. The real-account
// half of A1 is `npm run test:checkly:verify`
// (see docs/REAL-CHECKLY-ACCEPTANCE.md) and has not been run.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseMultiStepProject } from "../../src/multistep/source.ts";
import { evaluateMultiStepPolicy } from "../../src/multistep/policy.ts";

const WEB = new URL("../../examples/slots-booking/web/", import.meta.url).pathname;
const PATCHES = new URL("../../fixtures/patches/slots-booking-multistep-nested-response/checks/", import.meta.url).pathname;
const FILE = "checks/multistep-booking.spec.ts";
const CHECK = "checks/multistep-booking.check.ts";
const SPEC = readFileSync(join(WEB, FILE), "utf8");
const CONSTRUCT = readFileSync(join(WEB, CHECK), "utf8");
const ORIGINAL = parseMultiStepProject(new Map([[FILE, SPEC], [CHECK, CONSTRUCT]]), FILE)!;
assert.deepEqual(ORIGINAL.errors, [], "the canonical baseline must be fully modeled");

const GOOD = readFileSync(join(PATCHES, "01-good-nested-field.spec.ts"), "utf8");
const GOOD_MODEL = parseMultiStepProject(new Map([[FILE, GOOD], [CHECK, CONSTRUCT]]), FILE)!;
assert.deepEqual(GOOD_MODEL.errors, [], "the known-good repair must be fully modeled");

function readCandidate(file: string): string {
  return readFileSync(join(PATCHES, file), "utf8");
}

function model(spec: string) {
  return parseMultiStepProject(new Map([[FILE, spec], [CHECK, CONSTRUCT]]), FILE)!;
}

/** Counted (step, subject, matcher, target, negated) tuples, matching the
 *  identity law src/contract/contract.ts uses for Multistep. */
function tuples(m: typeof GOOD_MODEL): string[] {
  return (m.script?.assertions ?? []).map((a) =>
    JSON.stringify([a.stepTitle, a.id, a.subject, a.matcher, a.target, a.negated]));
}

const GOOD_TUPLES = new Set(tuples(GOOD_MODEL));
const STEP_TITLES = GOOD_MODEL.script?.steps.map((s) => s.title) ?? [];

const MATRIX: { candidate: string; want: "accept" | "policy" | "weaken"; why: string }[] = [
  { candidate: "01-good-nested-field.spec.ts", want: "accept", why: "follows the app's nested booking.* contract" },
  { candidate: "02-loose-operator.spec.ts", want: "weaken", why: "`toBe(true)` weakened to a typeof property matcher" },
  { candidate: "03-delete-assertion.spec.ts", want: "weaken", why: "the booking.confirmed assertion is deleted" },
  { candidate: "04-catch-ignore.spec.ts", want: "policy", why: "assertion wrapped so its failure cannot surface" },
  { candidate: "05-remove-step.spec.ts", want: "policy", why: "the whole confirm transaction step is deleted" },
  { candidate: "06-hardcode.spec.ts", want: "weaken", why: "nested field replaced by a constant-to-constant assertion" },
  { candidate: "07-missing-await.spec.ts", want: "policy", why: "the booking step is not awaited" },
  { candidate: "08-reorder-steps.spec.ts", want: "policy", why: "slots and book steps are swapped" },
];

test("the eight fixtures exist and the canonical baseline plus good repair are fully modeled", () => {
  assert.deepEqual(ORIGINAL.errors, []);
  assert.deepEqual(GOOD_MODEL.errors, []);
  assert.ok(STEP_TITLES.includes("book 09:30"), "the good repair must keep the canonical book step");
  assert.ok(GOOD_TUPLES.size > 0, "the good repair must contribute assertion tuples");
});

test("the good repair is accepted by the original-vs-candidate policy", () => {
  const policy = evaluateMultiStepPolicy(ORIGINAL, GOOD_MODEL);
  assert.equal(policy.rejected, null, `the correct repair was rejected: ${policy.rejected}`);
  assert.equal(policy.uncertain, null, `the correct repair must be judgeable: ${policy.uncertain}`);
});

for (const row of MATRIX.filter((r) => r.want !== "accept")) {
  test(`Multistep candidate ${row.candidate} is convicted: ${row.why}`, () => {
    const candidate = model(readCandidate(row.candidate));
    const policy = evaluateMultiStepPolicy(ORIGINAL, candidate);

    if (row.want === "policy") {
      // Layer 1: the policy must reach a definite verdict against the ORIGINAL.
      assert.ok(policy.rejected !== null || policy.uncertain !== null,
        `${row.candidate} (${row.why}) was neither rejected nor uncertain — policy.rejected=${policy.rejected} policy.uncertain=${policy.uncertain}`);
      return;
    }

    // Layer 2: the candidate must lose tuples the good repair keeps.
    const kept = tuples(candidate).filter((t) => GOOD_TUPLES.has(t)).length;
    const total = tuples(candidate).length;
    assert.ok(total < GOOD_TUPLES.size || kept < GOOD_TUPLES.size,
      `${row.candidate} (${row.why}) preserved every assertion the good repair has ` +
      `(${kept}/${total} kept, good has ${GOOD_TUPLES.size}) — the weakening is not detected`);
  });
}

test("every fake loses at least one layer of protection; none is silently equivalent to the good repair", () => {
  const survivors: string[] = [];
  for (const row of MATRIX.filter((r) => r.want !== "accept")) {
    const candidate = model(readCandidate(row.candidate));
    const policy = evaluateMultiStepPolicy(ORIGINAL, candidate);
    const kept = tuples(candidate).filter((t) => GOOD_TUPLES.has(t)).length;
    const convicted = policy.rejected !== null || policy.uncertain !== null
      || kept < GOOD_TUPLES.size || (candidate.script?.steps.length ?? 0) < STEP_TITLES.length;
    if (!convicted) survivors.push(`${row.candidate} (${row.why})`);
  }
  assert.deepEqual(survivors, [], `these Multistep fakes were not convicted: ${survivors.join(", ")}`);
});