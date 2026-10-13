// Trusted Multistep regions and environment-key NAMES are DERIVED from the
// trusted incident bundle, never hardcoded to one customer's regions.
//
// Why this exists: the tool previously pinned `us-east-1` / `eu-west-1` — the
// slots-booking EXAMPLE app's regions — in five admission gates. A tool sold to
// customers would reject every other customer's locations as untrusted, and a
// plan change (Checkly Hobby no longer allowing `eu-west-1`) made the live
// example undeployable. Phase 9 task 9.2 requires: "Do not hardcode fixture
// names, regions, routes, or account-variable names."
//
// FAIL-CLOSED CONTRACT — this module must never widen trust:
//   * A region is trusted only when the bundle itself declares it.
//   * Derivation failure yields an EMPTY trusted set, which makes every
//     region check reject. It never falls back to a default list.
//   * A syntactically invalid region is never trusted, even if declared.
//
// The region -> account-key mapping is a separate concern and is already
// derived from the candidate's own source by
// `./region-account-mapping.ts` (`deriveRegionalAccountMapping`). Nothing here
// reintroduces a hardcoded account-variable name.

/** A syntactically valid Checkly location name. Deliberately strict. */
const REGION_NAME = /^[a-z]{2}-[a-z]+-[0-9]$/;
const ENV_KEY_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;

/** Keys that are always trusted regardless of what the bundle declares. These
 *  are structural to the Multistep runtime contract, not customer-specific. */
const STRUCTURAL_ENV_KEYS = [
  "ENVIRONMENT_URL",
  "CHECKLY_SECRET_VERCEL_AUTOMATION_BYPASS_SECRET",
  "VERCEL_AUTOMATION_BYPASS_SECRET",
] as const;

/** Upper bound so a hostile manifest cannot inflate these sets. */
const MAX_LOCATIONS = 8;
const MAX_ENV_KEYS = 64;

export interface TrustedMultistepScope {
  /** Declared, syntactically valid locations. Empty means "nothing trusted".
   *  A real Set would stay mutable through Object.freeze, so this is an
   *  immutable facade: only `has` and `size` are exposed. */
  readonly locations: ReadonlySet<string>;
  /** Declared env-var NAMES plus the structural keys. Names only, no values. */
  readonly envKeys: ReadonlySet<string>;
  /** True when the bundle declared a usable, complete location set. */
  readonly derived: boolean;
}

/** Object.freeze does not stop Set.add, so expose a read-only facade. */
function immutableSet(values: Iterable<string>): ReadonlySet<string> {
  const set = new Set(values);
  Object.freeze({
    has: (value: string): boolean => set.has(value),
    hasOwn: (value: string): boolean => set.has(value),
    get size(): number { return set.size; },
    [Symbol.iterator]: () => set[Symbol.iterator](),
  } as unknown as ReadonlySet<string>);
  return Object.freeze(Object.defineProperties({}, {
    has: { value: (value: string): boolean => set.has(value) },
    size: { get: (): number => set.size },
    [Symbol.iterator]: { value: () => set[Symbol.iterator]() },
  })) as ReadonlySet<string>;
}

const EMPTY: TrustedMultistepScope = Object.freeze({
  locations: immutableSet([]),
  envKeys: immutableSet([]),
  derived: false,
});

function declaredLocations(config: { locations?: unknown } | null | undefined): string[] {
  const raw = config?.locations;
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > MAX_LOCATIONS) return [];
  const out: string[] = [];
  for (const entry of raw) {
    if (typeof entry !== "string" || !REGION_NAME.test(entry)) return [];
    if (out.includes(entry)) return [];
    out.push(entry);
  }
  return out;
}

function declaredEnvKeys(config: { environmentVariables?: unknown } | null | undefined): string[] {
  const raw = config?.environmentVariables;
  if (!Array.isArray(raw) || raw.length > MAX_ENV_KEYS) return [];
  const out: string[] = [];
  for (const entry of raw) {
    const key = typeof entry === "string" ? entry
      : entry && typeof entry === "object" ? (entry as { key?: unknown }).key : undefined;
    if (typeof key !== "string" || !ENV_KEY_NAME.test(key)) continue;
    if (!out.includes(key)) out.push(key);
  }
  return out;
}

/**
 * Derive the trusted Multistep scope from a bundle configuration.
 *
 * `config` is the trusted bundle's own recorded configuration — never the
 * candidate's. A candidate that changes locations is convicted by the
 * protected-requirements comparison, not admitted as the trust root.
 */
export function trustedMultistepScope(
  config: { locations?: unknown; environmentVariables?: unknown } | null | undefined,
): TrustedMultistepScope {
  const locations = declaredLocations(config);
  const envKeys = declaredEnvKeys(config);
  if (locations.length === 0) return EMPTY;
  return Object.freeze({
    locations: immutableSet(locations),
    envKeys: immutableSet([...STRUCTURAL_ENV_KEYS, ...envKeys]),
    derived: true,
  });
}

/** Is this run location one the trusted bundle actually declares? */
export function isTrustedMultistepLocation(scope: TrustedMultistepScope, location: unknown): location is string {
  return typeof location === "string" && scope.locations.has(location);
}

/** Is this env-var NAME one the trusted bundle declares (or structural)? */
export function isTrustedMultistepEnvKey(scope: TrustedMultistepScope, key: unknown): key is string {
  return typeof key === "string" && scope.envKeys.has(key);
}

/**
 * Regions the tool can reason about generically. This is NOT a trust decision:
 * it only filters obviously malformed provider strings before they reach the
 * region->account mapping. Trust still comes from the bundle.
 */
export function isSyntacticallyValidRegion(value: unknown): value is string {
  return typeof value === "string" && REGION_NAME.test(value);
}