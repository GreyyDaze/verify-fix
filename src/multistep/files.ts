// One bounded, project-relative source closure for capture, loading and local
// execution. No path supplied by a check, manifest or patch may escape it.
import path from "node:path";

export const MULTISTEP_MAX_SOURCE_FILES = 32;
export const MULTISTEP_MAX_SOURCE_DEPTH = 8;
export const MULTISTEP_MAX_SOURCE_FILE_BYTES = 1024 * 1024;
export const MULTISTEP_MAX_SOURCE_BYTES = 4 * 1024 * 1024;
const SOURCE_EXTENSION = /\.(?:[cm]?[jt]sx?)$/;

export function multiStepSourcePath(raw: string): string | null {
  if (typeof raw !== "string" || !raw || raw.includes("\\") || raw.includes("\0") || raw.includes(":")) return null;
  const parts = raw.replace(/^\.\//, "").split("/");
  if (path.posix.isAbsolute(raw) || parts.length > MULTISTEP_MAX_SOURCE_DEPTH + 1
    || parts.some((part) => part === "" || part === "." || part === "..")
    || !SOURCE_EXTENSION.test(parts.at(-1) ?? "")) return null;
  return parts.join("/");
}

export function multiStepSourceClosureProblem(files: ReadonlyMap<string, string>): string | null {
  if (files.size === 0 || files.size > MULTISTEP_MAX_SOURCE_FILES) return "MULTISTEP_SOURCE_CLOSURE_BOUND";
  let total = 0;
  const normalized = new Set<string>();
  for (const [name, content] of files) {
    const safe = multiStepSourcePath(name);
    if (!safe || normalized.has(safe) || typeof content !== "string") return "MULTISTEP_SOURCE_PATH_UNSAFE";
    normalized.add(safe);
    const bytes = Buffer.byteLength(content, "utf8");
    if (bytes > MULTISTEP_MAX_SOURCE_FILE_BYTES || (total += bytes) > MULTISTEP_MAX_SOURCE_BYTES) return "MULTISTEP_SOURCE_CLOSURE_BOUND";
  }
  return null;
}
