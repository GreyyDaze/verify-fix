import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildCostMatrix, costMatrixMarkdown } from "../src/cost-report.ts";

function report(candidate: string, verdict: "PASS" | "FAILED" | "UNCERTAIN", cloud: number, local: number, wall: number) {
  return {
    candidate,
    verdict,
    cost: {
      scenes: 2,
      runs: cloud + local,
      checklyTestSessions: cloud,
      checklyCloudRuns: cloud,
      localRuns: local,
      browserProcesses: local,
      mutationRuns: 1,
      wallTimeMs: wall,
      byScene: [],
    },
  };
}

test("cost report lists every candidate and groups exact runs and wall time by verdict", () => {
  const dir = mkdtempSync(join(tmpdir(), "verify-fix-cost-"));
  mkdirSync(join(dir, "nested"));
  writeFileSync(join(dir, "good.json"), JSON.stringify(report("good", "PASS", 10, 20, 30_000)));
  writeFileSync(join(dir, "nested", "fake.json"), JSON.stringify(report("fake", "FAILED", 0, 5, 4_000)));
  writeFileSync(join(dir, "noise.json"), JSON.stringify({ hello: true }));
  const matrix = buildCostMatrix(dir);
  assert.equal(matrix.rows.length, 2);
  assert.deepEqual(matrix.byVerdict.PASS, {
    candidates: 1,
    checklyTestSessions: 10,
    checklyCloudRuns: 10,
    localRuns: 20,
    browserProcesses: 20,
    mutationRuns: 1,
    totalCompletedRuns: 30,
    wallTimeMs: 30_000,
  });
  assert.equal(matrix.byVerdict.FAILED.localRuns, 5);
  assert.equal(matrix.byVerdict.FAILED.browserProcesses, 5);
  assert.match(costMatrixMarkdown(matrix), /Totals by verdict/);
  assert.match(costMatrixMarkdown(matrix), /No money estimate/);
});
