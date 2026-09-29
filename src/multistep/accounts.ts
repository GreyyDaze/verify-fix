// Trusted input validation at BOTH scene and direct sandbox entries. Never
// return, hash, log, or persist either account; the child receives just one.
export function trustedRegionalAccounts(env: Record<string, string>, region?: string): {
  east: string; west: string; selected: string | null;
} | null {
  const east = env.MULTISTEP_USER_US_EAST_1;
  const west = env.MULTISTEP_USER_EU_WEST_1;
  const valid = (value: unknown): value is string => typeof value === "string"
    && value.length > 0 && value.length <= 512 && value === value.trim() && !/[\u0000-\u001f\u007f]/.test(value);
  if (!valid(east) || !valid(west) || east === west
    || region !== undefined && region !== "us-east-1" && region !== "eu-west-1") return null;
  return { east, west, selected: region === undefined ? null : region === "us-east-1" ? east : west };
}

/** The Checkly CLI reads the named secret; only the single child receives its
 * runtime header value. Never include it in a trace, report, hash or error. */
export const AUTOMATION_BYPASS_INPUT = "CHECKLY_SECRET_VERCEL_AUTOMATION_BYPASS_SECRET";
export function trustedAutomationBypass(env: Record<string, string>): string | null {
  const value = env[AUTOMATION_BYPASS_INPUT];
  return typeof value === "string" && value.length > 0 && value.length <= 512
    && value === value.trim() && !/[\u0000-\u001f\u007f]/.test(value) ? value : null;
}
