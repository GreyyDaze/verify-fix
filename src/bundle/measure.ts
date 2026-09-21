// `--measure N` / `--measure-overlap M`: real determinism numbers.
//
// Runs the customer's ORIGINAL check on Checkly's cloud through the official
// CLI (`npx checkly test --record --reporter json`) from the Checkly project
// directory. Sequential runs give the pass rate; overlap pairs (two `checkly
// test` processes started at the same moment) give how often overlapping runs
// break each other. The JSON reporter writes to CHECKLY_REPORTER_JSON_OUTPUT
// (reporters/json.js in checkly@9.5.0):
//   { testSessionId, numChecks, runLocation, checks: [{ result: "Pass"|"Fail"|"Degraded", name, ... }] }

import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface MeasureRun {
  ok: boolean;
  testSessionId: string | null;
  failedChecks: string[];
  exitCode: number | null;
  stderrTail: string;
}

export interface MeasureResult {
  sequential: { runs: number; passed: number; passRate: number; sessions: string[] };
  overlap: { pairs: number; pairsWithFailure: number; failRate: number; sessions: string[] };
}

export interface Runner {
  (args: string[], env: NodeJS.ProcessEnv, cwd: string): Promise<{ exitCode: number | null; stderr: string }>;
}

const defaultRunner: Runner = (args, env, cwd) =>
  new Promise((resolve) => {
    const child = spawn("npx", args, { cwd, env, stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (d) => (stderr += String(d)));
    child.on("close", (code) => resolve({ exitCode: code, stderr }));
    child.on("error", (err) => resolve({ exitCode: null, stderr: String(err) }));
  });

export interface MeasureOptions {
  projectDir: string;
  sequentialRuns: number;
  overlapPairs: number;
  /** ENVIRONMENT_URL for the runs (omit → the check's own default) */
  targetUrl?: string;
  /** limit to one check by name filter (checkly test --grep) */
  grep?: string;
  runner?: Runner;
  log?: (line: string) => void;
}

async function runOnce(opts: MeasureOptions, label: string): Promise<MeasureRun> {
  const runner = opts.runner ?? defaultRunner;
  const dir = mkdtempSync(join(tmpdir(), "verify-fix-measure-"));
  const out = join(dir, "report.json");
  const args = ["checkly", "test", "--record", "--reporter", "json"];
  if (opts.targetUrl) args.push("-e", `ENVIRONMENT_URL=${opts.targetUrl}`);
  if (opts.grep) args.push("--grep", opts.grep);
  const env = { ...process.env, CHECKLY_REPORTER_JSON_OUTPUT: out, CI: "1" };
  const { exitCode, stderr } = await runner(args, env, opts.projectDir);
  let report: { testSessionId?: string; checks?: Array<{ result: string; name: string }> } | null = null;
  try {
    report = JSON.parse(readFileSync(out, "utf8"));
  } catch {
    report = null;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  const failed = (report?.checks ?? []).filter((c) => c.result !== "Pass").map((c) => c.name);
  const ok = report !== null && failed.length === 0 && exitCode === 0;
  opts.log?.(`[measure] ${label}: ${ok ? "pass" : "FAIL"}${report?.testSessionId ? ` session=${report.testSessionId}` : ""}${exitCode !== 0 ? ` exit=${exitCode}` : ""}`);
  return { ok, testSessionId: report?.testSessionId ?? null, failedChecks: failed, exitCode, stderrTail: stderr.slice(-400) };
}

export async function measureDeterminism(opts: MeasureOptions): Promise<MeasureResult> {
  const sequential: MeasureRun[] = [];
  for (let i = 0; i < opts.sequentialRuns; i++) sequential.push(await runOnce(opts, `sequential ${i + 1}/${opts.sequentialRuns}`));

  const overlapSessions: string[] = [];
  let pairsWithFailure = 0;
  for (let i = 0; i < opts.overlapPairs; i++) {
    const [a, b] = await Promise.all([runOnce(opts, `overlap ${i + 1}/${opts.overlapPairs} (A)`), runOnce(opts, `overlap ${i + 1}/${opts.overlapPairs} (B)`)]);
    if (!a.ok || !b.ok) pairsWithFailure += 1;
    for (const s of [a.testSessionId, b.testSessionId]) if (s) overlapSessions.push(s);
  }

  const passed = sequential.filter((r) => r.ok).length;
  return {
    sequential: {
      runs: sequential.length,
      passed,
      passRate: sequential.length ? Number((passed / sequential.length).toFixed(3)) : 0,
      sessions: sequential.map((r) => r.testSessionId).filter((s): s is string => !!s),
    },
    overlap: {
      pairs: opts.overlapPairs,
      pairsWithFailure,
      failRate: opts.overlapPairs ? Number((pairsWithFailure / opts.overlapPairs).toFixed(3)) : 0,
      sessions: overlapSessions,
    },
  };
}
