// Mutation — few, directed weak variants of the candidate check (ACH-style,
// prod PRD §1.3): one operator family + one contextual/LLM-style family.
// A mutant "survives" if it masks the detection scene while the good patch
// fails it — that is proof the oracle is blind there (STING weakness classes).

import { parseInventory, parseProjectInventory } from "./assertion/inventory.ts";
import type { Assertion } from "./types.ts";

export type MutantFamily = "operator" | "llm";

export interface SeededMutant {
  name: string;
  family: MutantFamily;
  source: string;
  detail: string;
}

function swapLine(source: string, lineNumber: number, next: string): string {
  const lines = source.split("\n");
  if (lineNumber < 1 || lineNumber > lines.length) return source;
  lines[lineNumber - 1] = next;
  return lines.join("\n");
}

/** Operator family: weaken a strong assertion's matcher to a never-falsifiable one. */
function operatorMutant(source: string, a: Assertion): SeededMutant {
  const indented = /^\s*/.exec(a.sourceLine === 0 ? "" : source.split("\n")[a.sourceLine - 1] ?? "")?.[0] ?? "";
  let next: string;
  let matcher = "toBeDefined";
  let args = "()";
  const num = Number(a.target.replace(/[,)]/g, ""));
  if (a.matcher === "toBe" && (!Number.isNaN(num) || a.target === "true" || a.target === "false")) {
    matcher = "toBeGreaterThanOrEqual";
    args = "(0)";
  } else if (a.matcher === "toContainText" || a.matcher === "toContain" || a.matcher === "toHaveText") {
    // For a Playwright locator, visibility is the realistic weak repair: the
    // element may be present while its status text is wrong. Plain DSL values
    // retain the generic toBeDefined mutation.
    matcher = /\bpage\.|\b(?:getBy|locator)\w*\(/.test(a.subject) ? "toBeVisible" : "toBeDefined";
    args = "()";
  }
  next = `${indented}await expect(${a.subject}).${matcher}${args};`;
  const replaced = swapLine(source, a.sourceLine, next);
  return {
    name: `mut-op-${a.id}`,
    family: "operator",
    source: replaced,
    detail: `weakened ${a.matcher}(${a.target}) on ${a.subject} → ${matcher}${args}`,
  };
}

/** Contextual family: strip the guarding assertion entirely (a knowledge-aware
 * "sure, everyone sees 200" mutant). */
function llmMutant(source: string, a: Assertion): SeededMutant {
  const lines = source.split("\n");
  const line = lines[a.sourceLine - 1] ?? "";
  const next = lines.map((l, i) => (i === a.sourceLine - 1 ? `// ${l.trim()}  <-- removed for mutation` : l)).join("\n");
  void line;
  return {
    name: `mut-llm-${a.id}`,
    family: "llm",
    source: next,
    detail: `contextual: assertion ${a.id} (${a.subject}.${a.matcher}) removed — a knowledge-aware agent's harmless-edit move`,
  };
}

/** Swallow the assertion exactly as a try/catch "stability fix" would. */
function catchMutant(source: string, a: Assertion): SeededMutant {
  const lines = source.split("\n");
  const line = lines[a.sourceLine - 1] ?? "";
  const indent = /^\s*/.exec(line)?.[0] ?? "";
  lines[a.sourceLine - 1] = `${indent}try { ${line.trim()} } catch { /* ignored for mutation */ }`;
  return {
    name: `mut-llm-catch-${a.id}`,
    family: "llm",
    source: lines.join("\n"),
    detail: `contextual: assertion ${a.id} wrapped in try/catch so its failure is swallowed`,
  };
}

/** Break the detection scene by swapping the assertion target to always-true. */
function llmDodgeMutant(source: string, a: Assertion): SeededMutant {
  const lines = source.split("\n");
  const needle = `expect(${a.subject}).${a.matcher}`;
  const swap = `await expect(${a.subject}).toBeDefined();`;
  const replaced = lines.map((l) => (l.includes(needle) ? swap : l)).join("\n");
  return {
    name: `mut-llm-dodge-${a.id}`,
    family: "llm",
    source: replaced,
    detail: `contextual: ${needle} → toBeDefined (asserts the symptom object exists, never its property)`,
  };
}

function apiMutants(source: string, assertions: Assertion[]): SeededMutant[] {
  const target = assertions.find((assertion) => assertion.matcher === "equals");
  if (!target) return [];
  const lines = source.split("\n");
  const line = lines[target.sourceLine - 1] ?? "";
  if (!line.includes(".equals(")) return [];

  const weakLines = [...lines];
  weakLines[target.sourceLine - 1] = line.replace(".equals(", ".contains(");
  const removedLines = [...lines];
  removedLines[target.sourceLine - 1] = `// ${line.trim()}  // removed for deterministic mutation`;
  return [
    {
      name: `mut-op-${target.id}`,
      family: "operator",
      source: weakLines.join("\n"),
      detail: `weakened exact AssertionBuilder.equals on ${target.subject} to contains`,
    },
    {
      name: `mut-contract-remove-${target.id}`,
      family: "llm",
      source: removedLines.join("\n"),
      detail: `deterministic contextual mutation removed API assertion ${target.id}`,
    },
  ];
}

/** Deterministic mutation suite over the candidate check's strongest assertions. */
export function seedMutants(patchSource: string, checkFile: string, files?: Record<string, string>): SeededMutant[] {
  const tree = new Map(Object.entries(files ?? { [checkFile]: patchSource }));
  tree.set(checkFile, patchSource);
  const inv = parseProjectInventory(checkFile, tree);
  if (/\bAssertionBuilder\s*\./.test(patchSource)) return apiMutants(patchSource, inv.assertions);
  const browserInventory = parseInventory(checkFile, patchSource);
  const strong = browserInventory.assertions.filter((a) => a.falsifiable && a.kind === "exact");
  if (strong.length === 0) return [];
  const target = strong[0];
  const out: SeededMutant[] = [];
  out.push(operatorMutant(patchSource, target));
  if (strong[1]) out.push(operatorMutant(patchSource, strong[1]));
  out.push(llmMutant(patchSource, target));
  out.push(catchMutant(patchSource, target));
  out.push(llmDodgeMutant(patchSource, target));
  return out;
}
