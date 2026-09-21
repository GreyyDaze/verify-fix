// REPRODUCTION mode from the RCA text (BRAINSTORM Part 3.4 / D5).
//
// This is a fixed rule table, not a model. Rocky's RCA is INPUT DATA (text
// Checkly produced); the rules below only decide HOW the reproduction scene is
// run, never whether a patch passes. Unknown → run both modes; if neither
// reproduces the incident later, the scene is UNCERTAIN (never faked).
//
//   race / session / concurrency   → live-concurrent:2   (needs the real target)
//   changed response / selector    → replay:failing.har  (recorded responses are exact)
//   anything else                  → both

export type ReproductionMode = "live-concurrent:2" | "replay:failing.har" | "both";

export interface RcaClassification {
  mode: ReproductionMode;
  matchedRule: string | null;
  matchedText: string | null;
}

interface Rule {
  name: string;
  mode: ReproductionMode;
  re: RegExp;
}

export const RCA_RULES: Rule[] = [
  { name: "concurrency: race/overlap words", mode: "live-concurrent:2", re: /\b(race condition|race|concurren\w*|parallel|overlap\w*|simultaneous\w*|interleav\w*)\b/i },
  { name: "concurrency: another run/session/login", mode: "live-concurrent:2", re: /\b(another|second|other|competing|earlier|later)\s+(run|check run|session|login|execution|location|instance)\b/i },
  { name: "concurrency: session invalidated/superseded", mode: "live-concurrent:2", re: /\b(supersed\w*|invalidat\w*|revok\w*|logged out|kicked out|single[- ]session|one session per|session (conflict|collision|clash))\b/i },
  { name: "concurrency: shared test account", mode: "live-concurrent:2", re: /\b(shared|same)\s+(test\s+)?(account|user|credential\w*)\b/i },
  { name: "changed response: field/selector/schema", mode: "replay:failing.har", re: /\b(renamed|removed|missing|changed|unexpected|new)\s+(field|property|key|attribute|selector|element|locator|schema|shape|payload|response body|status code|endpoint|route|path)\b/i },
  { name: "changed response: selector not found", mode: "replay:failing.har", re: /\b(selector|locator|element)\b.*\b(not found|no longer|does not exist|cannot be found|resolved to 0|strict mode)\b/i },
  { name: "changed response: breaking/deprecated", mode: "replay:failing.har", re: /\b(breaking change|deprecat\w*|removed endpoint|404 not found|schema (change|mismatch)|contract (change|violation))\b/i },
];

export function classifyRca(text: string | null | undefined): RcaClassification {
  if (!text) return { mode: "both", matchedRule: null, matchedText: null };
  const flat = text.replace(/\s+/g, " ");
  let best: { rule: Rule; index: number; match: string } | null = null;
  for (const rule of RCA_RULES) {
    const m = rule.re.exec(flat);
    if (m && (best === null || m.index < best.index)) best = { rule, index: m.index, match: m[0] };
  }
  if (!best) return { mode: "both", matchedRule: null, matchedText: null };
  return { mode: best.rule.mode, matchedRule: best.rule.name, matchedText: best.match };
}
