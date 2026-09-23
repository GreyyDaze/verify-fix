// Report — the traceable evidence chain (prod PRD §6 acid test + success #4):
// a human can merge/block in ≤30s from the summary table + top-3 evidence lines.
// Every sentence must reduce to "experiment X, oracle Y, matched/mismatched, strength Z".

import type { Decision, EvidenceRow, ExecutionCost, SceneObservation } from "../types.ts";
import type { ContractReport } from "../contract/contract.ts";

export interface Report {
  incidents: string;
  decision: Decision;
  topEvidence: string[];
  markdown: string;
  json: Record<string, unknown>;
}

function oracleShorthand(row: EvidenceRow): string {
  return row.oracle.length > 42 ? `${row.oracle.slice(0, 39)}…` : row.oracle;
}

export interface ReportDetails {
  cost?: ExecutionCost;
  target?: string | null;
  targetRevision?: string | null;
  candidateProject?: string | null;
  candidate?: string | null;
}

export function buildReport(contract: ContractReport, decision: Decision, observations: Map<string, SceneObservation>, details: ReportDetails = {}): Report {
  const lines: string[] = [];
  const observationValues = [...observations.values()];
  const checklySessionIds = [...new Set([...observationValues.flatMap((observation) => observation.checklySessionIds ?? []), ...(details.cost?.checklySessionIds ?? [])])];
  const checklyResultIds = [...new Set([...observationValues.flatMap((observation) => observation.checklyResultIds ?? []), ...(details.cost?.checklyResultIds ?? [])])];
  lines.push(`# verify-fix report — ${contract.bundle.incidentId}`);
  lines.push("");
  lines.push(`**Verdict:** ${decision.verdict} (exit ${decision.exitCode})`);
  lines.push("");
  lines.push(`**Check:** ${contract.bundle.check.repo}/${contract.bundle.check.file} (logicalId \`${contract.bundle.check.logicalId}\`)`);
  lines.push("");
  lines.push("| experiment | environment | oracle | expected | observed | match | strength |");
  lines.push("|---|---|---|---|---|---|---|");
  for (const r of decision.rows) {
    const match = r.observed === "uncertain" ? "?" : r.matched ? "✓" : "✗";
    lines.push(`| ${r.experiment} | ${r.environment} | ${oracleShorthand(r)} | ${r.expected} | ${r.observed} | ${match} | ${r.strength.toFixed(3)} |`);
  }
  lines.push("");
  // Parity note (D3): a live row proves behavior against THAT host only. Which
  // host is the customer's choice (--target); the tool never picks one.
  const liveRows = decision.rows.filter((r) => r.environment.startsWith("target "));
  const hosts = [...new Set(liveRows.map((r) => /^target (\S+)/.exec(r.environment)?.[1] ?? ""))].filter(Boolean);
  if (hosts.length > 0) lines.push(`_Live rows ran against ${hosts.join(", ")}. They say nothing about any other environment; run again with \`--target\` for each one that matters._`);
  lines.push("");
  if (decision.adequacy) {
    const s = decision.adequacy;
    lines.push(`**Adequacy:** oracle_strength = ${s.score.toFixed(3)} ` + `(falsifiability ${s.falsifiability.toFixed(2)}, coverage ${s.coverage.toFixed(2)}, env ${s.envCompleteness.toFixed(2)}, mutant-kill ${s.mutantKillRate.toFixed(2)}); threshold = 0.7`);
  }
  lines.push("");
  lines.push("**Reasons:**");
  for (const r of decision.reasons) lines.push(`- ${r}`);
  lines.push("");
  lines.push("**Top evidence lines:**");
  const top = topEvidence(contract, decision, observations);
  top.forEach((t, i) => lines.push(`${i + 1}. ${t}`));
  lines.push("");
  if (details.target || details.targetRevision || details.candidateProject || details.candidate) {
    lines.push("**Candidate target:**");
    if (details.candidate) lines.push(`- Candidate: \`${details.candidate}\``);
    if (details.target) lines.push(`- URL: ${details.target}`);
    if (details.targetRevision) lines.push(`- Revision: \`${details.targetRevision}\``);
    if (details.candidateProject) lines.push(`- Project: \`${details.candidateProject}\``);
    lines.push("");
  }
  if (checklySessionIds.length > 0 || checklyResultIds.length > 0) {
    lines.push("**Recorded Checkly evidence:**");
    if (checklySessionIds.length > 0) lines.push(`- Test session ids: ${checklySessionIds.map((id) => `\`${id}\``).join(", ")}`);
    if (checklyResultIds.length > 0) lines.push(`- Result ids: ${checklyResultIds.map((id) => `\`${id}\``).join(", ")}`);
    lines.push("");
  }
  if (details.cost) {
    const c = details.cost;
    lines.push("**Cost:**");
    lines.push(`- Checkly test sessions: ${c.checklyTestSessions}`);
    lines.push(`- Checkly cloud check runs: ${c.checklyCloudRuns}`);
    lines.push(`- Local runs: ${c.localRuns}`);
    lines.push(`- Browser processes: ${c.browserProcesses}`);
    lines.push(`- Mutation runs: ${c.mutationRuns}`);
    lines.push(`- Total completed runs: ${c.runs}`);
    lines.push(`- Wall time: ${(c.wallTimeMs / 1000).toFixed(1)}s`);
    for (const row of c.byScene) {
      lines.push(`- ${row.sceneId} (${row.phase}, ${row.executor}): ${row.checkRuns} check run(s), ${(row.wallTimeMs / 1000).toFixed(1)}s`);
    }
    lines.push("");
  }

  const topOut = topEvidence(contract, decision, observations);
  return {
    incidents: contract.bundle.incidentId,
    decision,
    topEvidence: topOut,
    markdown: lines.join("\n"),
    json: {
      incidentId: contract.bundle.incidentId,
      candidate: details.candidate ?? null,
      verdict: decision.verdict,
      exitCode: decision.exitCode,
      rows: decision.rows,
      adequacy: decision.adequacy,
      reasons: decision.reasons,
      determinism: contract.bundle.determinism,
      target: details.target ?? null,
      targetRevision: details.targetRevision ?? null,
      candidateProject: details.candidateProject ?? null,
      checklyEvidence: { testSessionIds: checklySessionIds, resultIds: checklyResultIds },
      cost: details.cost ?? null,
      topEvidence: topOut,
    },
  };
}

export function topEvidence(contract: ContractReport, decision: Decision, observations: Map<string, SceneObservation>): string[] {
  const out: string[] = [];
  const mismatches = decision.rows.filter((r) => r.observed !== "uncertain" && !r.matched);
  for (const m of mismatches) {
    out.push(`experiment ${m.experiment} ran against oracle ${oracleShorthand(m)}, observed ${m.observed} vs expected ${m.expected} — MISMATCH, strength ${m.strength.toFixed(3)}`);
  }
  const inconclusive = decision.rows.filter((r) => r.observed === "uncertain");
  for (const u of inconclusive) {
    out.push(`experiment ${u.experiment} ran against oracle ${oracleShorthand(u)}, observed uncertain (expected ${u.expected}) — INCONCLUSIVE: ${u.note ?? "no admissible evidence"}`);
  }
  for (const r of decision.reasons.filter((x) => x.startsWith("core-path assertion") || x.startsWith("suppression") || x.startsWith("mutant"))) {
    out.push(r);
  }
  if (contract.determinismGate.blocked) out.push(`determinism gate: ${contract.determinismGate.reason}`);
  const unverified = contract.unverifiedAssumptions.map((a) => `env assumption ${a} not verified (STING class 4)`);
  out.push(...unverified);
  if (out.length === 0) {
    const first = decision.rows.slice(0, 3);
    for (const r of first) {
      out.push(`experiment ${r.experiment} ran against oracle ${oracleShorthand(r)}, observed ${r.observed} matched expected — strength ${r.strength.toFixed(3)}`);
    }
  }
  return out.slice(0, 5).map((s, i) => `[${i + 1}] ${s}`);
}