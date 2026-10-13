// `verify-fix init` — Phase 8 task 8.1.
//
// Prepares verify-fix inside an EXISTING Checkly project. It never creates or
// copies the example project, never provisions a service, and never reads or
// stores a credential. It writes only the agreed CLI configuration and package
// scripts, and only after an explicit confirmation.
//
// Scope boundaries are load-bearing:
//   * Nothing is written before the user confirms.
//   * A project that already has the files is reported, not overwritten.
//   * No credential, dotenv value, or secret is ever read into memory.

import { existsSync, readFileSync, statSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";

/** Files that identify an existing Checkly project. */
export const PROJECT_MARKERS = [
  "checkly.config.ts",
  "checkly.config.js",
  "checkly.config.mjs",
] as const;

export interface DetectedProject {
  root: string;
  configFile: string | null;
  hasPlaywrightConfig: boolean;
  hasPackageJson: boolean;
  hasIncidentsDir: boolean;
  hasVerifyFixInstalled: boolean;
  /** Present but never parsed for values — only its existence is reported. */
  hasEnvFile: boolean;
}

export interface InitPlan {
  project: DetectedProject;
  /** Files verify-fix would create. Empty means the project is already set up. */
  actions: { path: string; description: string }[];
  /** Human-readable notes; never contain a credential or a file's contents. */
  notes: string[];
}

/** Bound every read so a hostile or enormous file cannot be slurped. */
const MAX_PACKAGE_JSON_BYTES = 1024 * 1024;

function isFile(path: string): boolean {
  try { return statSync(path).isFile(); } catch { return false; }
}

function isDirectory(path: string): boolean {
  try { return statSync(path).isDirectory(); } catch { return false; }
}

export function detectProject(cwd: string): DetectedProject {
  const root = resolve(cwd);
  const configFile = PROJECT_MARKERS.map((name) => join(root, name)).find(isFile) ?? null;
  const packageJson = join(root, "package.json");
  let hasVerifyFixInstalled = false;
  if (isFile(packageJson) && statSync(packageJson).size <= MAX_PACKAGE_JSON_BYTES) {
    // Read only the dependency name, never any value.
    hasVerifyFixInstalled = /"verify-fix"\s*:\s*"(?:\^|~|>=?\s*\d|latest)/.test(readFileSync(packageJson, "utf8"));
  }
  return {
    root,
    configFile,
    hasPlaywrightConfig: ["playwright.config.ts", "playwright.config.js"]
      .some((name) => isFile(join(root, name))),
    hasPackageJson: isFile(packageJson),
    hasIncidentsDir: isDirectory(join(root, "incidents")),
    hasVerifyFixInstalled,
    hasEnvFile: [".env", ".env.local", ".env.production"].some((name) => isFile(join(root, name))),
  };
}

const PACKAGE_SCRIPTS = {
  "verify:bundle": "verify-fix bundle --check <check-id> --out ./incidents/<incident>",
  "verify:measure": "verify-fix measure --bundle ./incidents/<incident> --target <url> --project .",
  "verify:check": "verify-fix verify --candidate-project . --base <git-ref> --bundle ./incidents/<incident> --target <url>",
} as const;

/**
 * Decide what `init` would do. Pure: no filesystem writes.
 *
 * `init` configures an existing project. It must not create or copy the
 * example, so a directory with no Checkly config is reported as "not a Checkly
 * project" rather than scaffolded.
 */
export function planInit(cwd: string): InitPlan {
  const project = detectProject(cwd);
  const notes: string[] = [];
  const actions: InitPlan["actions"] = [];

  if (!project.configFile) {
    return {
      project,
      actions: [],
      notes: [
        "No checkly.config.ts|js found in this directory.",
        "verify-fix init configures an EXISTING Checkly project; it never creates or copies the example project.",
        "Run it from your Checkly project root, or use `npm create verify-fix@latest <dir> -- --template slots-booking-live` to copy the worked example.",
      ],
    };
  }

  notes.push(`Detected Checkly project: ${project.configFile.replace(`${project.root}/`, "")}`);
  if (!project.hasPackageJson) notes.push("No package.json found; the verify-fix scripts will be skipped.");
  if (project.hasEnvFile) {
    notes.push("An env file is present. Its contents are NEVER read, parsed, copied, or stored.");
  }
  if (project.hasIncidentsDir) {
    notes.push("An incidents/ directory already exists; existing bundles are left untouched.");
  }

  if (!project.hasVerifyFixInstalled && project.hasPackageJson) {
    actions.push({
      path: "package.json",
      description: `add the verify-fix scripts: ${Object.keys(PACKAGE_SCRIPTS).join(", ")}`,
    });
  } else if (project.hasVerifyFixInstalled) {
    notes.push("verify-fix is already a dependency; the dependency entry is left untouched.");
  }

  if (!project.hasIncidentsDir) {
    actions.push({ path: "incidents/", description: "create an empty directory for captured incident bundles" });
  }

  return { project, actions, notes };
}

/** The exact package.json script block init would merge in. Pure. */
export function initPackageScripts(): Record<string, string> {
  return { ...PACKAGE_SCRIPTS };
}

/**
 * Merge the init scripts into a package.json text, preserving the rest.
 * Pure: returns new text; the caller decides whether to write it.
 */
export function mergePackageScripts(packageJsonText: string): string {
  const parsed = JSON.parse(packageJsonText) as { scripts?: Record<string, string> };
  const scripts = { ...(parsed.scripts ?? {}), ...PACKAGE_SCRIPTS };
  const next = { ...parsed, scripts };
  return `${JSON.stringify(next, null, 2)}\n`;
}

/** The confirmation text shown before anything is written. */
export function initConfirmation(plan: InitPlan): string {
  const lines = ["verify-fix init — the following will be written:", ""];
  for (const action of plan.actions) lines.push(`  + ${action.path}  (${action.description})`);
  if (!plan.actions.length) lines.push("  nothing — this project is already configured");
  lines.push("", "Not touched: your checks, your Checkly config, any env file, and any captured incident.");
  lines.push("No service is provisioned and no credential is read or stored.");
  return lines.join("\n");
}

export function isSafeRelativeTarget(root: string, target: string): boolean {
  const resolved = resolve(root, target);
  return !isAbsolute(target) && (resolved === root || resolved.startsWith(`${root}/`));
}