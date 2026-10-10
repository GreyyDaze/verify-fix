// `create-verify-fix` — Phase 8 task 8.2.
//
// `npm create verify-fix@latest <dir> -- --template slots-booking-live`
// copies the MAINTAINED example out of the verify-fix repository. It never
// synthesises a second app or check implementation, and it never contains its
// own copy of the example's source.
//
// Only documented placeholders may be replaced, a non-empty destination is
// refused, and the copied project starts with an EMPTY incidents/ directory.

import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";

export const TEMPLATE_NAME = "slots-booking-live";

export interface CreateOptions {
  /** Repository root that holds examples/slots-booking/web. */
  repoRoot: string;
  destination: string;
  template?: string;
  /** Non-interactive proof runs set this; interactive callers prompt. */
  confirm?: boolean;
}

export type CreateResult =
  | { status: "created"; destination: string; copiedFiles: number; skipped: string[] }
  | { status: "refused"; reason: string };

/** Directory names never copied out of the maintained example. */
const EXCLUDED = new Set([
  "node_modules", ".git", ".next", "dist", "build", "coverage",
  ".env", ".env.local", ".env.production", ".env.development",
  "incidents", "test-results", "playwright-report", "tsconfig.tsbuildinfo",
]);

/** Files never copied, whatever their directory. */
const EXCLUDED_FILES = new Set([
  ".DS_Store", ".env", ".env.local", ".env.production", "tsconfig.tsbuildinfo",
]);

/**
 * A destination is refused unless it is absent or completely empty.
 * Refusing a non-empty directory is what stops a command from overwriting a
 * learner's real project.
 */
export function isDestinationUsable(destination: string): { usable: boolean; reason: string } {
  const resolved = resolve(destination);
  if (!existsSync(resolved)) return { usable: true, reason: "destination does not exist yet" };
  let entries: string[];
  try { entries = readdirSync(resolved); }
  catch (error) { return { usable: false, reason: `destination is not readable: ${(error as Error).message}` }; }
  if (entries.length === 0) return { usable: true, reason: "destination is empty" };
  if (entries.length === 1 && entries[0] === ".git") return { usable: true, reason: "destination holds only .git" };
  return { usable: false, reason: `destination is not empty (${entries.slice(0, 5).join(", ")}...)` };
}

function countFiles(root: string): number {
  let total = 0;
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (EXCLUDED.has(entry.name) || EXCLUDED_FILES.has(entry.name)) continue;
      if (entry.isDirectory()) walk(join(dir, entry.name));
      else if (entry.isFile()) total++;
    }
  };
  if (existsSync(root)) walk(root);
  return total;
}

export function createFromTemplate(options: CreateOptions): CreateResult {
  const template = options.template ?? TEMPLATE_NAME;
  const repoRoot = resolve(options.repoRoot);
  if (template !== TEMPLATE_NAME) {
    return { status: "refused", reason: `unknown template "${template}". The only maintained template is "${TEMPLATE_NAME}".` };
  }
  // The template lives in the verify-fix repository. This command copies it; it
  // does not carry a second implementation of the example.
  const source = join(repoRoot, "examples", "slots-booking", "web");
  if (!existsSync(source)) {
    return { status: "refused", reason: `maintained example not found at ${source}` };
  }

  const destination = resolve(options.destination);
  const usability = isDestinationUsable(destination);
  if (!usability.usable) return { status: "refused", reason: usability.reason };

  if (!existsSync(destination)) mkdirSync(destination, { recursive: true });

  const copyFilter = (src: string): boolean => {
    const name = basename(src);
    if (EXCLUDED_FILES.has(name) || EXCLUDED.has(name)) return false;
    try { return statSync(src).isFile() || statSync(src).isDirectory(); } catch { return false; }
  };
  cpSync(source, destination, { recursive: true, filter: copyFilter });

  // The copied project starts with NO incident: the learner captures their own.
  const incidents = join(destination, "incidents");
  if (existsSync(incidents)) rmSync(incidents, { recursive: true, force: true });
  mkdirSync(incidents, { recursive: true });
  writeFileSync(join(incidents, ".gitkeep"), "", "utf8");

  // Documented placeholders only. A copied project must have no
  // repository-relative import back into verify-fix.
  // Documented placeholders only. A copied project must carry no
  // repository-relative path back into the verify-fix repository.
  const PLACEHOLDERS: ReadonlyArray<[string, string]> = [
    ["examples/slots-booking/web", "."],
  ];
  const skipped: string[] = [];
  for (const name of ["README.md", "vercel.json"]) {
    const file = join(destination, name);
    if (!existsSync(file)) { skipped.push(name); continue; }
    let text = readFileSync(file, "utf8");
    for (const [from, to] of PLACEHOLDERS) text = text.replaceAll(from, to);
    writeFileSync(file, text, "utf8");
  }

  return { status: "created", destination, copiedFiles: countFiles(destination), skipped };
}

/** Prove the copied project carries no repository-relative dependency. */
export function findRepositoryRelativeImports(destination: string): string[] {
  const offenders: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (EXCLUDED.has(entry.name) || EXCLUDED_FILES.has(entry.name)) continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) { walk(full); continue; }
      if (!/\.(ts|tsx|js|mjs|json)$/.test(entry.name)) continue;
      let text: string;
      try { text = readFileSync(full, "utf8"); } catch { continue; }
      if (/verify-fix\/src|examples\/slots-booking|\.\.\/\.\.\/verify-fix/.test(text)) {
        offenders.push(full.replace(`${destination}/`, ""));
      }
    }
  };
  if (existsSync(destination)) walk(destination);
  return offenders;
}