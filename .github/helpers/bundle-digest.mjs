// @ts-check
// Whole-bundle SHA-256 fingerprint, dependency-free ESM.
//
// The trusted gate checks a pinned bundle fingerprint before running the
// verifier, so a swapped artifact can never be graded against. This helper
// duplicates src/capture/bundle/digest.ts deliberately: the gate must be able
// to recompute the pin without executing the tool under test. A parity test
// (test/workflow/bundle-digest-helper.spec.ts) keeps the two in step.
//
// Usage: node .github/helpers/bundle-digest.mjs <bundle-dir>
// Prints the lowercase hex digest to stdout. Fails closed (exit 1) on any
// path that is not a plain file or directory: a symlink, socket, or device
// node is rejected rather than silently skipped.

import { createHash } from "node:crypto";
import { lstatSync, readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";

/** @param {string} dirIn */
export function bundleDigest(dirIn) {
  const dir = resolve(dirIn);
  const root = lstatSync(dir);
  if (!root.isDirectory() || root.isSymbolicLink()) throw new Error("BUNDLE_DIGEST_PATH_UNSAFE");

  /** @type {{ path: string, bytes: Buffer }[]} */
  const entries = [];
  /** @param {string} directory */
  const visit = (directory) => {
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

// Only run as a CLI when invoked directly, so tests can import the function.
if (process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname)) {
  const dir = process.argv[2];
  if (!dir) {
    process.stderr.write("usage: bundle-digest.mjs <bundle-dir>\n");
    process.exit(2);
  }
  try {
    process.stdout.write(`${bundleDigest(dir)}\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  }
}
