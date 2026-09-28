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
