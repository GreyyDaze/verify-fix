// One bounded, project-relative source closure for capture, loading and local
// execution. No path supplied by a check, manifest or patch may escape it.
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, realpathSync } from "node:fs";
import path from "node:path";

/** Read a fixed bundle-relative file through checked directories and one
 * no-follow descriptor. A caller-controlled bundle may not redirect a
 * recording, result, manifest or source file outside its root via a symlink
 * or hardlink, nor grow a file between stat and read. No raw path is included
 * in failure messages. The caller supplies a literal, not a manifest pointer. */
export function readBoundedBundleFile(root: string, relative: string, limit: number): string {
  const base = path.resolve(root);
  const parts = relative.split("/");
  if (!parts.length || parts.some((part) => !part || part === "." || part === ".." || part.includes("\\"))) {
    throw new Error("MULTISTEP_BUNDLE_PATH_UNSAFE");
  }
  if (realpathSync(base) !== base) throw new Error("MULTISTEP_BUNDLE_PATH_UNSAFE");
  let dir = base;
  for (const segment of parts.slice(0, -1)) {
    const stat = lstatSync(dir);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("MULTISTEP_BUNDLE_PATH_UNSAFE");
    dir = path.join(dir, segment);
  }
  const parent = lstatSync(dir);
  if (!parent.isDirectory() || parent.isSymbolicLink()) throw new Error("MULTISTEP_BUNDLE_PATH_UNSAFE");
  const file = path.join(dir, parts.at(-1)!);
  const before = lstatSync(file);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size > limit) {
    throw new Error("MULTISTEP_BUNDLE_FILE_UNSAFE");
  }
  const fd = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const opened = fstatSync(fd);
    if (!opened.isFile() || opened.nlink !== 1 || opened.dev !== before.dev || opened.ino !== before.ino
      || opened.size > limit) throw new Error("MULTISTEP_BUNDLE_FILE_UNSAFE");
    const pieces: Buffer[] = [];
    let size = 0;
    for (;;) {
      const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, limit + 1 - size));
      const count = readSync(fd, chunk, 0, chunk.length, null);
      if (count === 0) break;
      size += count;
      if (size > limit) throw new Error("MULTISTEP_BUNDLE_FILE_UNSAFE");
      pieces.push(chunk.subarray(0, count));
    }
    const after = fstatSync(fd);
    if (after.size !== opened.size || after.mtimeMs !== opened.mtimeMs || size !== after.size) {
      throw new Error("MULTISTEP_BUNDLE_FILE_UNSAFE");
    }
    return Buffer.concat(pieces, size).toString("utf8");
  } finally {
    closeSync(fd);
  }
}

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
