// Assertion inventory: parse the check source into the machine-extractable
// contract (prod PRD §5.1 step 1). Also: flow-step inventory (for
// "remove the failing step" detection) and suppression detection
// (catch/ignore/throttle wrapping of assertions).

import type { Assertion, AssertionInventory } from "../types.ts";
import { assertionId, normalizeSubject } from "./id.ts";
import { isFalsifiable, isWeakMatcher, matcherClass } from "./classify.ts";

const EXPECT_RE = /expect\s*\(\s*([^)\]]+?)\s*\)\.([A-Za-z][\w$]*)\s*\(\s*([\s\S]*?)\s*\)/g;

const STEP_PATTERNS: Array<{ label: string; re: RegExp }> = [
  { label: "page.goto", re: /page\.goto\(/ },
  { label: "request.get", re: /\b(?:request|req|client|api)\.(?:get|post|put|patch|send)\b/ },
  { label: "fetch", re: /\bfetch\(/ },
  { label: "navigate", re: /\.navigate\(/ },
  { label: "click", re: /\.click\(/ },
  { label: "login", re: /\blogin\b/ },
  { label: "book", re: /\bbook\b/ },
];

const GUARDABLE = /catch\s*\(|\bcatch\s*\{|\.catch\(|softExpect|expect\.poll|\.finally\(/;

interface Line {
  text: string;
  lineNumber: number;
}

function splitLines(source: string): Line[] {
  return source.split(/\r?\n/).map((text, i) => ({ text, lineNumber: i + 1 }));
}

/** Ranges of lines that are wrapped by a swallowing construct: inside a catch
 * block, or inside a try that has a matching catch (assertions there throw
 * harmlessly). try/finally WITHOUT catch is NOT a guard — legitimate fix. */
function guardRanges(lines: Line[]): Set<number> {
  const guarded = new Set<number>();
  let braceDepth = 0;
  let inCatch = false;
  let catchDepth = -1;
  let pendingTry: { line: number; depth: number } | null = null;

  const markCatchOpen = (openLine: number) => {
    if (pendingTry) {
      for (let l = pendingTry.line; l <= openLine; l++) guarded.add(l);
      pendingTry = null;
    }
    // the catch's own block afterward is guarded too
    inCatch = true;
    catchDepth = braceDepth;
  };

  for (const line of lines) {
    const hasTry = /\btry\b/.test(line.text);
    const hasCatchKeyword = /\bcatch\b/.test(line.text);
    const hasFinally = /\bfinally\b/.test(line.text);
    const hasCatchDot = /\.catch\(|softExpect|expect\.poll/.test(line.text);
    const open = (line.text.match(/\{/g) ?? []).length;
    const close = (line.text.match(/\}/g) ?? []).length;

    if (hasCatchKeyword) markCatchOpen(line.lineNumber);
    if (hasFinally) pendingTry = null; // try/finally alone is not a swallowing guard
    if (hasCatchDot) {
      guarded.add(line.lineNumber);
      inCatch = true;
      catchDepth = braceDepth;
    }
    if (hasTry) pendingTry = pendingTry ?? { line: line.lineNumber, depth: braceDepth };

    braceDepth += open - close;
    if (inCatch && braceDepth <= catchDepth) inCatch = false;
    if (pendingTry && braceDepth < pendingTry.depth) pendingTry = null;
    if (inCatch) guarded.add(line.lineNumber);
  }
  return guarded;
}

function findAssertions(source: string): Array<{ subject: string; matcher: string; target: string; lineNumber: number; guarded: boolean }> {
  const out: Array<{ subject: string; matcher: string; target: string; lineNumber: number; guarded: boolean }> = [];
  const lines = splitLines(source);
  const guardedLines = guardRanges(lines);
  for (const line of lines) {
    EXPECT_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = EXPECT_RE.exec(line.text)) !== null) {
      const subject = normalizeSubject(m[1]);
      const matcher = m[2];
      const target = normalizeSubject(m[3]);
      const guarded = guardedLines.has(line.lineNumber) || GUARDABLE.test(line.text);
      out.push({ subject, matcher, target, lineNumber: line.lineNumber, guarded });
    }
  }
  return out;
}

export function parseInventory(checkFile: string, source: string): AssertionInventory {
  const raw = findAssertions(source);
  const assertions: Assertion[] = raw.map((a) => {
    const cls = matcherClass(a.matcher);
    const weak = isWeakMatcher(a.matcher);
    return {
      id: assertionId(a.subject, a.matcher, a.target),
      subject: a.subject,
      matcher: a.matcher,
      target: a.target,
      kind: cls.kind,
      onCriticalPath: true, // every assertion in a check protects behavior; refined by guard/weak scans
      sourceLine: a.lineNumber,
      falsifiable: isFalsifiable(a.matcher, a.target) && !weak,
      guarded: a.guarded,
    };
  });
  const steps: string[] = [];
  for (const line of splitLines(source)) {
    for (const p of STEP_PATTERNS) {
      if (p.re.test(line.text)) {
        steps.push(`${p.label}:${line.lineNumber}`);
      }
    }
  }
  return { checkFile, assertions, steps, totalAssertions: assertions.length };
}

export interface InventoryDiff {
  removed: Assertion[];
  weakened: Assertion[];
  added: Assertion[];
  changedTarget: Assertion[];
  flowChanged: boolean;
}

/** Compare the contract (original) inventory against the patched inventory. */
export function inventoryDiff(original: AssertionInventory, patched: AssertionInventory): InventoryDiff {
  const byKey = new Map<string, Assertion>();
  const bySubject = new Map<string, Assertion>();
  for (const a of original.assertions) {
    byKey.set(`${a.subject}|${a.matcher}`, a);
    if (!bySubject.has(a.subject)) bySubject.set(a.subject, a);
  }
  const removed: Assertion[] = [];
  const weakened: Assertion[] = [];
  const added: Assertion[] = [];
  const changedTarget: Assertion[] = [];
  const seenKeys = new Set<string>();

  for (const p of patched.assertions) {
    const key = `${p.subject}|${p.matcher}`;
    seenKeys.add(key);
    const orig = byKey.get(key);
    if (!orig) {
      // maybe subject changed? Treated as added (overfit/renaming) unless removed counterpart exists
      added.push(p);
      continue;
    }
    if (orig.target !== p.target) {
      changedTarget.push({ ...p, id: orig.id, sourceLine: p.sourceLine });
      continue;
    }
    if (orig.falsifiable && !p.falsifiable) weakened.push(p);
    if (!orig.falsifiable && p.falsifiable) added.push(p); // notable: made stronger
  }
  for (const a of original.assertions) {
    if (!seenKeys.has(`${a.subject}|${a.matcher}`) && !patched.assertions.some((p) => p.subject === a.subject && p.matcher === a.matcher)) {
      removed.push(a);
    }
  }
  const flowChanged = JSON.stringify(original.steps) !== JSON.stringify(patched.steps);
  return { removed, weakened, added, changedTarget, flowChanged };
}