/**
 * Sibling-monitor inventory — regression scope.
 *
 * A repair that only rewrites the incident check's own entrypoint cannot move
 * another monitor. A repair that touches a project-wide input (the Checkly
 * config, the Playwright config, package.json, or a helper imported by more
 * than one check) CAN, and those monitors must be proven, not assumed safe.
 *
 * The scope is derived from evidence recorded in the trusted bundle — the
 * captured check inventory and each check's own source closure. It is never
 * inferred from the candidate: a candidate cannot declare itself harmless.
 *
 * UNKNOWN means the scope could not be established. That is a legitimate
 * UNCERTAIN, not a PASS: reporting "no affected monitors" without having
 * enumerated them would be exactly the silent regression this task exists to
 * prevent.
 */

export const UNRESOLVED_SCOPE = "PROTECTED_REGRESSION_SCOPE_UNRESOLVED";

/** Inputs shared by every check in the account: change one, and every check
 *  that consumes it is in scope. */
const PROJECT_WIDE_FILES = new Set([
  "checkly.config.ts",
  "checkly.config.js",
  "playwright.config.ts",
  "playwright.config.js",
  "package.json",
  "package-lock.json",
  "yarn.lock",
  "pnpm-lock.yaml",
]);

export interface SiblingMonitor {
  /** Stable Checkly id, or the logicalId when the API returned no id. */
  id: string;
  name: string;
  checkType: string;
  /** Every project-relative file this monitor is built from. */
  files: string[];
}

export interface MonitorInventory {
  monitors: SiblingMonitor[];
  /** False when the account enumeration was incomplete or malformed. */
  complete: boolean;
  reason: string | null;
}

export interface ImpactAssessment {
  /** Ids of monitors that must be regression-tested, including the incident
   *  check itself. */
  affected: string[];
  /** Human-readable file -> reason, for the report. Never contains values. */
  reasons: Record<string, string>;
  unresolved: boolean;
  reason: string | null;
}

/** Compare paths the way the filesystem that produced them does: separators
 *  differ between Windows-authored inventories and POSIX candidate trees. */
function normalizePath(file: string): string {
  return file.trim().replace(/\\/g, "/").toLowerCase();
}

export function isProjectWideFile(file: string): boolean {
  return PROJECT_WIDE_FILES.has(normalizePath(file));
}

/**
 * Which monitors can the changed files move?
 *
 * A file belongs to a monitor when it appears in that monitor's captured
 * source closure. Project-wide files belong to every monitor. A file that
 * matches no monitor's closure affects nothing we can see — but that is only
 * safe to conclude because the inventory was captured completely; if it was
 * not, the scope stays unresolved.
 */
export function assessSiblingImpact(
  inventory: MonitorInventory,
  incidentCheckFile: string,
  changedFiles: string[],
): ImpactAssessment {
  const reasons: Record<string, string> = {};
  if (!inventory.complete || inventory.monitors.length === 0) {
    return {
      affected: [],
      reasons,
      unresolved: true,
      reason: inventory.monitors.length === 0
        ? "no monitors were inventoried; the regression scope cannot be established"
        : inventory.reason ?? "the account monitor inventory is incomplete",
    };
  }
  const affected = new Map<string, string>();
  for (const file of changedFiles) {
    const key = normalizePath(file);
    if (isProjectWideFile(key)) {
      for (const monitor of inventory.monitors) affected.set(monitor.id, `${file} is project-wide`);
      reasons[file] = "project-wide configuration";
      continue;
    }
    for (const monitor of inventory.monitors) {
      if (monitor.files.some((own) => normalizePath(own) === key)) {
        affected.set(monitor.id, `${file} is part of ${monitor.checkType} monitor ${monitor.name}`);
        reasons[file] = `${monitor.checkType} monitor ${monitor.name}`;
      }
    }
    if (!(file in reasons)) reasons[file] = "no captured monitor consumes this file";
  }
  // The incident check is always in scope: it is the monitor being repaired.
  if (!affected.size) {
    for (const monitor of inventory.monitors) {
      if (monitor.files.includes(incidentCheckFile)) affected.set(monitor.id, "incident monitor");
    }
  }
  return { affected: [...affected.keys()].sort(), reasons, unresolved: false, reason: null };
}

/**
 * Build the inventory from the captured check list plus the source closures
 * resolved at capture time. A check whose closure could not be resolved is
 * recorded as incomplete: we cannot prove which files move it.
 */
export function monitorInventory(
  checks: Array<{ id: string; name: string; checkType: string; files: string[] }>,
  unresolvedIds: string[] = [],
): MonitorInventory {
  const monitors: SiblingMonitor[] = checks.map((check) => ({
    id: check.id, name: check.name, checkType: check.checkType, files: [...check.files],
  }));
  const incomplete = unresolvedIds.filter((id) => monitors.some((m) => m.id === id));
  return {
    monitors,
    complete: incomplete.length === 0,
    reason: incomplete.length > 0
      ? "source closure unresolved for captured monitors"
      : null,
  };
}