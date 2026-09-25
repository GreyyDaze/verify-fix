import { test } from "node:test";
import assert from "node:assert/strict";
import { HybridExecutor } from "../../src/executor/hybrid.ts";
import type { Bundle, Scene, SceneObservation } from "../../src/types.ts";

const observation = (sceneId: string, source: "scene" | "checkly"): SceneObservation => ({
  sceneId,
  observed: "pass",
  repetitions: 1,
  trace: [],
  source,
});

const scene = (type: Scene["type"]): Scene => ({
  sceneId: type.toLowerCase(),
  type,
  state: "test",
  mode: "live",
  verdict: { mustFail: false, provenance: { kind: "code", assertionId: "assert:test" }, envAssumptions: [] },
  experiments: [{ durationSec: 1, repetitions: 1, expectStable: true }],
  assertionsInvolved: [],
});

test("hybrid executor routes healthy/regression to Checkly and failure scenes to the local proxy executor", async () => {
  const executor = new HybridExecutor({ target: "https://preview.example.com", projectDir: null });
  const calls: string[] = [];
  executor.scene.runScene = async (_bundle, _source, value) => {
    calls.push(`scene:${value.type}`);
    return observation(value.sceneId, "scene");
  };
  executor.checkly.runScene = async (_bundle, _source, value) => {
    calls.push(`checkly:${value.type}`);
    return observation(value.sceneId, "checkly");
  };
  const bundle = {} as Bundle;
  try {
    for (const type of ["REPRODUCTION", "DETECTION", "HEALTHY", "REGRESSION"] as const) {
      await executor.runScene(bundle, "", scene(type));
    }
    assert.deepEqual(calls, ["scene:REPRODUCTION", "scene:DETECTION", "checkly:HEALTHY", "checkly:REGRESSION"]);
  } finally {
    await executor.close();
  }
});
