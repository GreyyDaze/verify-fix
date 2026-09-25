// Single authority for the weak-assertion scan (STING class 3).
// Property-based matchers that can never falsify (non-negative, non-null, type-ish)
// are flagged; exact matchers with a concrete target can falsify.

export interface MatcherClass {
  kind: "exact" | "property";
  falsifiable: boolean;
  note: string;
}

const TABLE: Record<string, MatcherClass> = {
  equals: { kind: "exact", falsifiable: true, note: "Checkly exact equality against a concrete target" },
  contains: { kind: "property", falsifiable: true, note: "Checkly substring containment; weaker than exact equality" },
  toBe: { kind: "exact", falsifiable: true, note: "exact equality against a concrete target" },
  toEqual: { kind: "exact", falsifiable: true, note: "deep equality against a concrete target" },
  toStrictEqual: { kind: "exact", falsifiable: true, note: "strict deep equality against a concrete target" },
  toHaveText: { kind: "exact", falsifiable: true, note: "exact text expectation" },
  toContainText: { kind: "exact", falsifiable: true, note: "substring expectation (concrete string)" },
  toContain: { kind: "exact", falsifiable: true, note: "membership against a concrete string/list" },
  toMatch: { kind: "property", falsifiable: true, note: "regex match — checkable, but weak if /.*/ " },
  toBeVisible: { kind: "exact", falsifiable: true, note: "element visibility expectation" },
  toBeEnabled: { kind: "exact", falsifiable: true, note: "element enabled expectation" },
  toBeChecked: { kind: "exact", falsifiable: true, note: "element checked expectation" },
  toHaveValue: { kind: "exact", falsifiable: true, note: "form value expectation" },
  toHaveAttribute: { kind: "exact", falsifiable: true, note: "attribute expectation" },
  toHaveURL: { kind: "exact", falsifiable: true, note: "Playwright URL expectation" },
  toHaveUrl: { kind: "exact", falsifiable: true, note: "url expectation" },
  toBeGreaterThan: { kind: "property", falsifiable: false, note: "range check, never falsified by shape of problem (STING weak-assertion class)" },
  toBeGreaterThanOrEqual: { kind: "property", falsifiable: false, note: "range check; can survive arithmetic/field-drop mutants if used on non-negatives" },
  toBeLessThan: { kind: "property", falsifiable: false, note: "range check, weak" },
  toBeLessThanOrEqual: { kind: "property", falsifiable: false, note: "range check, weak" },
  toBeCloseTo: { kind: "property", falsifiable: false, note: "tolerance check, weak" },
  toBeTruthy: { kind: "property", falsifiable: false, note: "non-vacuous only if subject must be strictly false on breakage; otherwise vacuous (STING)" },
  toBeDefined: { kind: "property", falsifiable: false, note: "never falsified by a broken-but-present value" },
  toBeNull: { kind: "property", falsifiable: false, note: "exact only against null; flagged as property here" },
  toBeFalsy: { kind: "property", falsifiable: false, note: "vacuously true for most values" },
  toHaveLength: { kind: "exact", falsifiable: true, note: "length equality against concrete number" },
  toBeInstanceOf: { kind: "property", falsifiable: false, note: "type check; survives meaning-changing values" },
  toThrow: { kind: "property", falsifiable: false, note: "unbound throw check" },
};

export function matcherClass(matcher: string): MatcherClass {
  return (
    TABLE[matcher] ?? {
      kind: "property",
      falsifiable: true,
      note: `unknown matcher "${matcher}" — treated as property-but-checkable`,
    }
  );
}

export function isWeakMatcher(matcher: string): boolean {
  return matcherClass(matcher).kind === "property" && !matcherClass(matcher).falsifiable;
}

/** toBe with a boolean/string/number literal is only strong if the target is concrete. */
export function isFalsifiable(matcher: string, target: string): boolean {
  const cls = matcherClass(matcher);
  if (!cls.falsifiable) return false;
  if (matcher === "toBeTruthy" || matcher === "toBeDefined") return false;
  // These zero-argument Playwright matchers assert a concrete state. An empty
  // argument list is their normal strong form, not a missing oracle target.
  if (target.trim() === "" && ["toBeVisible", "toBeEnabled", "toBeChecked"].includes(matcher)) return true;
  if (target.trim() === "" && cls.kind === "exact") return false;
  return true;
}
