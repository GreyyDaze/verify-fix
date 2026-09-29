// Synthetic orchestrator proof: an unavailable mutation result is never
// converted to a kill or a survivor. No Checkly account, browser or app runs.
import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";

import { loadBundle } from "../src/bundle.ts";
import { emptyExecutionCost, type ExperimentExecutor, type ObservationValue } from "../src/types.ts";
import { verify } from "../src/verify.ts";

const incident = join(import.meta.dirname, "..", "fixtures/slots-booking/bundle/incidents/slots-booking-overlap");

test("PR-10: the verifier requires admitted mutation evidence before counting a kill or survivor", async () => {
  const { bundle } = loadBundle(incident);
  // An added noncritical assertion ensures at least one seeded mutant needs
  // live scene evidence rather than being immediately killed by static law.
  const candidate = bundle.checkSource.replace("check(", "const extra = expect(1).toBe(1);\ncheck(");
  let mutationRuns = 0;
  const executor: ExperimentExecutor = {
    kind: "scene", budgetExhausted: false, nondeterministicScenes: [],
    isLive: () => true, costReport: emptyExecutionCost,
    async runScene(_bundle, _source, scene, context) {
      if (context?.phase === "mutation") mutationRuns++;
      const observed: ObservationValue = context?.phase === "mutation"
        ? "uncertain" : scene.verdict.mustFail ? "fail" : "pass";
      return { sceneId: scene.sceneId, observed, repetitions: 5, trace: [],
        source: "scene", environment: "synthetic-target",
        ...(context?.phase === "mutation" ? { reason: "synthetic missing result" } : {}) };
    },
  };
  const result = await verify({ bundle, patch: candidate, executor,
    target: "https://synthetic.invalid", env: { ACCOUNT: "synthetic" } });
  assert.ok(mutationRuns > 0, "at least one mutant must actually reach the dynamic admission branch");
  assert.ok(result.mutants.some((mutant) => mutant.inconclusive && !mutant.survived));
  assert.ok(result.mutants.some((mutant) => !mutant.inconclusive && !mutant.survived),
    "a separate static kill remains conclusive");
  assert.equal(result.decision.verdict, "UNCERTAIN");
  assert.equal(result.decision.exitCode, 2);
  assert.ok(result.decision.reasons.some((reason) => /mutation runs lack conclusive evidence/.test(reason)));
});
