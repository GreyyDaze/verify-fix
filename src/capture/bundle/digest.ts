// Whole-bundle fingerprint. A bundle is proof, not code: it is stored outside
// the candidate's repo (see docs/BUNDLE-STORAGE-PLAN.md) and pinned by this
// SHA-256 so a swapped or edited bundle can never be graded against. The
// digest is a deterministic function of the bundle's directory contents:
// every regular file, ordered by its POSIX relative path, with the path and a
// separating NUL hashed before each file's bytes.
//
// This is deliberately the SAME algorithm as .github/helpers/bundle-digest.mjs
// (used by the trusted gate to check the pin without executing the tool). A
// parity test keeps the two in step.

import { createHash } from "node:crypto";
import { lstatSync, readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";

/**
 * Compute the SHA-256 fingerprint of an on-disk bundle directory.
 *
 * Fails closed on anything that is not a plain file or directory: a symlink,
 * socket, or device node inside the bundle is rejected rather than silently
 * skipped, so the digest always covers exactly the bytes the verifier will read.
 */
export function bundleDigest(dirIn: string): string {
  const dir = resolve(dirIn);
  const root = lstatSync(dir);
  if (!root.isDirectory() || root.isSymbolicLink()) throw new Error("BUNDLE_DIGEST_PATH_UNSAFE");

  const entries: Array<{ path: string; bytes: Buffer }> = [];
  const visit = (directory: string): void => {
    for (const name of readdirSync(directory)) {
      const full = join(directory, name);
      const stat = lstatSync(full);
      if (stat.isSymbolicLink()) throw new Error("BUNDLE_DIGEST_PATH_UNSAFE");
      if (stat.isDirectory()) visit(full);
      else if (stat.isFile()) {
        entries.push({ path: relative(dir, full).split("\\").join("/"), bytes: readFileSync(full) });
      } else {
        throw new Error("BUNDLE_DIGEST_PATH_UNSAFE");
      }
    }
  };
  visit(dir);

  entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const hash = createHash("sha256");
  for (const entry of entries) {
    hash.update(entry.path, "utf8");
    hash.update("\0", "utf8");
    hash.update(entry.bytes);
    hash.update("\0", "utf8");
  }
  return hash.digest("hex");
}

/** True when a value is a lowercase hex SHA-256 fingerprint. */
export function isBundleDigest(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}
