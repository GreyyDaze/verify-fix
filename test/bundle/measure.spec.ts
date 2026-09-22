import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { measureDeterminism, type Runner } from "../../src/bundle/measure.ts";

/** A stand-in for `npx checkly test --record --reporter json` that writes the JSON report the real reporter writes. */
function fakeChecklyTest(script: Array<"Pass" | "Fail" | "crash">): { runner: Runner; invocations: Array<{ args: string[]; cwd: string; startedAt: number }> } {
  const invocations: Array<{ args: string[]; cwd: string; startedAt: number }> = [];
  let n = 0;
  const runner: Runner = async (args, env, cwd) => {
    const outcome = script[n] ?? "Pass";
    n += 1;
    const id = n; // captured before the await: two overlapping runs must get distinct session ids
    invocations.push({ args, cwd, startedAt: Date.now() });
    await new Promise((r) => setTimeout(r, 20));
    if (outcome === "crash") return { exitCode: 1, stderr: "ENOTFOUND api.checklyhq.com" };
    writeFileSync(env.CHECKLY_REPORTER_JSON_OUTPUT!, JSON.stringify({ testSessionId: `sess-${id}`, numChecks: 1, runLocation: "eu-west-1", checks: [{ result: outcome, name: "slots booking flow", checkType: "PLAYWRIGHT" }] }));
    return { exitCode: outcome === "Pass" ? 0 : 1, stderr: "" };
  };
  return { runner, invocations };
}

test("measure: sequential pass rate, overlap pairs, session ids, CLI arguments", async () => {
  const { runner, invocations } = fakeChecklyTest(["Pass", "Fail", "Pass", "Pass", "Fail"]);
  const logs: string[] = [];
  const r = await measureDeterminism({ projectDir: "/proj", sequentialRuns: 3, overlapPairs: 1, targetUrl: "https://staging.example", grep: "slots", runner, log: (l) => logs.push(l) });
  assert.deepEqual(r.sequential, { runs: 3, passed: 2, passRate: 0.667, sessions: ["sess-1", "sess-2", "sess-3"] });
  assert.deepEqual(r.overlap, { pairs: 1, pairsWithFailure: 1, failRate: 1, sessions: ["sess-4", "sess-5"] });
  assert.equal(invocations.length, 5);
  assert.deepEqual(invocations[0].args, ["checkly", "test", "--record", "--reporter", "json", "-e", "ENVIRONMENT_URL=https://staging.example", "--grep", "slots"]);
  assert.equal(invocations[0].cwd, "/proj");
  // the overlap pair really starts together (both begin before either finishes)
  assert.ok(Math.abs(invocations[3].startedAt - invocations[4].startedAt) < 15, "overlap runs must start at the same moment");
  assert.ok(logs.some((l) => /sequential 2\/3: FAIL session=sess-2 exit=1/.test(l)));
});

test("measure: a crashed CLI run counts as a failure, never as a pass", async () => {
  const { runner } = fakeChecklyTest(["crash", "Pass"]);
  const r = await measureDeterminism({ projectDir: "/proj", sequentialRuns: 2, overlapPairs: 0, runner });
  assert.equal(r.sequential.passed, 1);
  assert.deepEqual(r.sequential.sessions, ["sess-2"]);
  assert.deepEqual(r.overlap, { pairs: 0, pairsWithFailure: 0, failRate: 0, sessions: [] });
});
