import type { Bundle } from "../types.ts";
import { validatedRegionAccountMapping } from "./region-account-mapping.ts";

// Trusted input validation at BOTH scene and direct sandbox entries. Never
// return, hash, log, or persist either account; the child receives just one.
export interface TrustedRegionalAccounts {
  /** Values stay in memory and are never included in diagnostics or reports. */
  values: Record<string, string>;
  keys: Record<string, string>;
  selected: string | null;
  selectedKey: string | null;
}

/** Read only the secret-free region -> environment-name mapping sealed in the bundle. */
export function regionalAccountMappingFromBundle(bundle: Bundle): Record<string, string> | null {
  const field = bundle.protectedRequirements?.policy.fields["multistep.environmentMapping"]?.original;
  return field?.state === "known" ? validatedRegionAccountMapping(field.value) : null;
}

export function trustedRegionalAccounts(
  env: Record<string, string>,
  mapping: Record<string, string>,
  locations: string[],
  region?: string,
): TrustedRegionalAccounts | null {
  if (locations.length === 0 || new Set(locations).size !== locations.length
    || Object.keys(mapping).length !== locations.length
    || locations.some((location) => !Object.hasOwn(mapping, location))) return null;
  const valid = (value: unknown): value is string => typeof value === "string"
    && value.length > 0 && value.length <= 512 && value === value.trim() && !/[\u0000-\u001f\u007f]/.test(value);
  const values: Record<string, string> = {};
  const keys: Record<string, string> = {};
  for (const location of locations) {
    const key = mapping[location];
    if (typeof key !== "string" || !/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(key) || !valid(env[key])) return null;
    keys[location] = key;
    values[location] = env[key];
  }
  if (new Set(Object.values(values)).size !== locations.length
    || region !== undefined && !locations.includes(region)) return null;
  return {
    values,
    keys,
    selected: region === undefined ? null : values[region] ?? null,
    selectedKey: region === undefined ? null : keys[region] ?? null,
  };
}

/** The Checkly CLI reads the named secret; only the single child receives its
 * runtime header value. Never include it in a trace, report, hash or error. */
export const AUTOMATION_BYPASS_INPUT = "CHECKLY_SECRET_VERCEL_AUTOMATION_BYPASS_SECRET";
export function trustedAutomationBypass(env: Record<string, string>): string | null {
  const value = env[AUTOMATION_BYPASS_INPUT];
  return typeof value === "string" && value.length > 0 && value.length <= 512
    && value === value.trim() && !/[\u0000-\u001f\u007f]/.test(value) ? value : null;
}
