// Aggregate Phase 5 verification reports. Money is intentionally absent because
// account pricing is not evidence in an incident bundle.

import { readFileSync, readdirSync, statSync } from "node:fs";
import { basename, join, relative, resolve } from "node:path";
import type { ExecutionCost, VerdictValue } from "./types.ts";

export interface CandidateCostRow {
  file: string;
  candidate: string;
  verdict: VerdictValue;
  checklyTestSessions: number;
  checklyCloudRuns: number;
  localRuns: number;
  browserProcesses: number;
  httpRequests: number;
  mutationRuns: number;
  totalCompletedRuns: number;
  wallTimeMs: number;
}

export interface CostGroup {
  candidates: number;
  checklyTestSessions: number;
  checklyCloudRuns: number;
  localRuns: number;
  browserProcesses: number;
  httpRequests: number;
  mutationRuns: number;
  totalCompletedRuns: number;
  wallTimeMs: number;
}

export interface CostMatrix {
  rows: CandidateCostRow[];
  byVerdict: Record<VerdictValue, CostGroup>;
}

const emptyGroup = (): CostGroup => ({ candidates: 0, checklyTestSessions: 0, checklyCloudRuns: 0, localRuns: 0, browserProcesses: 0, httpRequests: 0, mutationRuns: 0, totalCompletedRuns: 0, wallTimeMs: 0 });

export function buildCostMatrix(directory: string): CostMatrix {
  const root = resolve(directory);
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path);
      else if (name.endsWith(".json")) files.push(path);
    }
  };
  walk(root);

  const rows: CandidateCostRow[] = [];
  for (const file of files.sort()) {
    let report: { candidate?: string | null; verdict?: VerdictValue; cost?: (Partial<ExecutionCost> & { localPlaywrightRuns?: number }) | null };
    try {
      report = JSON.parse(readFileSync(file, "utf8"));
    } catch {
      continue;
    }
    if (!report.cost || !report.verdict || !["PASS", "FAILED", "UNCERTAIN"].includes(report.verdict)) continue;
    const localRuns = report.cost.localRuns ?? report.cost.localPlaywrightRuns ?? 0;
    const cloudRuns = report.cost.checklyCloudRuns ?? 0;
    rows.push({
      file: relative(root, file) || basename(file),
      candidate: report.candidate ?? basename(file, ".json"),
      verdict: report.verdict,
      checklyTestSessions: report.cost.checklyTestSessions ?? 0,
      checklyCloudRuns: cloudRuns,
      localRuns,
      browserProcesses: report.cost.browserProcesses ?? report.cost.localPlaywrightRuns ?? 0,
      httpRequests: report.cost.httpRequests ?? 0,
      mutationRuns: report.cost.mutationRuns ?? 0,
      totalCompletedRuns: report.cost.runs ?? cloudRuns + localRuns,
      wallTimeMs: report.cost.wallTimeMs ?? 0,
    });
  }

  const byVerdict: CostMatrix["byVerdict"] = { PASS: emptyGroup(), FAILED: emptyGroup(), UNCERTAIN: emptyGroup() };
  for (const row of rows) {
    const group = byVerdict[row.verdict];
    group.candidates += 1;
    group.checklyTestSessions += row.checklyTestSessions;
    group.checklyCloudRuns += row.checklyCloudRuns;
    group.localRuns += row.localRuns;
    group.browserProcesses += row.browserProcesses;
    group.httpRequests += row.httpRequests;
    group.mutationRuns += row.mutationRuns;
    group.totalCompletedRuns += row.totalCompletedRuns;
    group.wallTimeMs += row.wallTimeMs;
  }
  return { rows, byVerdict };
}

export function costMatrixMarkdown(matrix: CostMatrix): string {
  const lines = [
    "# verify-fix cost report",
    "",
    "| candidate | verdict | Checkly sessions | cloud runs | local runs | browser processes | HTTP requests | mutation runs | total runs | wall time |",
    "|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|",
    ...matrix.rows.map((row) => `| ${row.candidate} | ${row.verdict} | ${row.checklyTestSessions} | ${row.checklyCloudRuns} | ${row.localRuns} | ${row.browserProcesses} | ${row.httpRequests} | ${row.mutationRuns} | ${row.totalCompletedRuns} | ${(row.wallTimeMs / 1000).toFixed(1)}s |`),
    "",
    "## Totals by verdict",
    "",
    "| verdict | candidates | Checkly sessions | cloud runs | local runs | browser processes | HTTP requests | mutation runs | total runs | wall time |",
    "|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|",
    ...(["PASS", "FAILED", "UNCERTAIN"] as VerdictValue[]).map((verdict) => {
      const row = matrix.byVerdict[verdict];
      return `| ${verdict} | ${row.candidates} | ${row.checklyTestSessions} | ${row.checklyCloudRuns} | ${row.localRuns} | ${row.browserProcesses} | ${row.httpRequests} | ${row.mutationRuns} | ${row.totalCompletedRuns} | ${(row.wallTimeMs / 1000).toFixed(1)}s |`;
    }),
    "",
    "No money estimate is included. Account pricing is not captured evidence.",
    "",
  ];
  return lines.join("\n");
}
