// Report — the traceable evidence chain (prod PRD §6 acid test + success #4):
// a human can merge/block in ≤30s from the summary table + top-3 evidence lines.
// Every sentence must reduce to "experiment X, oracle Y, matched/mismatched, strength Z".

import type { Decision, EvidenceRow, SceneObservation } from "../types.ts";
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

export function buildReport(contract: ContractReport, decision: Decision, observations: Map<string, SceneObservation>): Report {
  const lines: string[] = [];
  lines.push(`# verify-fix report — ${contract.bundle.incidentId}`);
  lines.push("");
  lines.push(`**Verdict:** ${decision.verdict} (exit ${decision.exitCode})`);
  lines.push("");
  lines.push(`**Check:** ${contract.bundle.check.repo}/${contract.bundle.check.file} (logicalId \`${contract.bundle.check.logicalId}\`)`);
  lines.push("");
  lines.push("| experiment | oracle | expected | observed | match | strength |");
  lines.push("|---|---|---|---|---|---|");
  for (const r of decision.rows) {
    lines.push(`| ${r.experiment} | ${oracleShorthand(r)} | ${r.expected} | ${r.observed} | ${r.matched ? "✓" : "✗"} | ${r.strength.toFixed(3)} |`);
  }
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

  const topOut = topEvidence(contract, decision, observations);
  return {
    incidents: contract.bundle.incidentId,
    decision,
    topEvidence: topOut,
    markdown: lines.join("\n"),
    json: {
      incidentId: contract.bundle.incidentId,
      verdict: decision.verdict,
      exitCode: decision.exitCode,
      rows: decision.rows,
      adequacy: decision.adequacy,
      reasons: decision.reasons,
      determinism: contract.bundle.determinism,
      topEvidence: topOut,
    },
  };
}

export function topEvidence(contract: ContractReport, decision: Decision, observations: Map<string, SceneObservation>): string[] {
  const out: string[] = [];
  const mismatches = decision.rows.filter((r) => !r.matched);
  for (const m of mismatches) {
    out.push(`experiment ${m.experiment} ran against oracle ${oracleShorthand(m)}, observed ${m.observed} vs expected ${m.expected} — MISMATCH, strength ${m.strength.toFixed(3)}`);
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