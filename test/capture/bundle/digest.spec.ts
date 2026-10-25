// Whole-bundle SHA-256 fingerprint: deterministic over directory contents and
// fail-closed on anything that is not a plain file or directory.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bundleDigest, isBundleDigest } from "../../../src/capture/bundle/digest.ts";

function tempBundle(): string {
  const dir = mkdtempSync(join(tmpdir(), "verify-fix-digest-"));
  mkdirSync(join(dir, "check/checks"), { recursive: true });
  mkdirSync(join(dir, "results"), { recursive: true });
  writeFileSync(join(dir, "manifest.json"), '{"schemaVersion":"v3"}\n');
  writeFileSync(join(dir, "check/checks/a.check.ts"), "// a\n");
  writeFileSync(join(dir, "results/failing.json"), "{}\n");
  return dir;
}

test("bundleDigest is a stable sha256 over every file", () => {
  const dir = tempBundle();
  try {
    const first = bundleDigest(dir);
    assert.match(first, /^[a-f0-9]{64}$/);
    assert.equal(bundleDigest(dir), first, "same bytes give the same fingerprint");
    assert.equal(isBundleDigest(first), true);
    assert.equal(isBundleDigest("abc"), false);
    assert.equal(isBundleDigest(first.toUpperCase()), false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("bundleDigest changes when any file changes", () => {
  const dir = tempBundle();
  try {
    const before = bundleDigest(dir);
    writeFileSync(join(dir, "results/failing.json"), "{\"x\":1}\n");
    assert.notEqual(bundleDigest(dir), before);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("bundleDigest ignores creation order and mtimes", async () => {
  const a = tempBundle();
  const b = mkdtempSync(join(tmpdir(), "verify-fix-digest-b-"));
  try {
    // Same content, written in a different order.
    mkdirSync(join(b, "check/checks"), { recursive: true });
    mkdirSync(join(b, "results"), { recursive: true });
    writeFileSync(join(b, "results/failing.json"), "{}\n");
    writeFileSync(join(b, "check/checks/a.check.ts"), "// a\n");
    writeFileSync(join(b, "manifest.json"), '{"schemaVersion":"v3"}\n');
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(bundleDigest(b), bundleDigest(a));
  } finally {
    rmSync(a, { recursive: true, force: true });
    rmSync(b, { recursive: true, force: true });
  }
});

test("bundleDigest fails closed on a symlink inside the bundle", () => {
  const dir = tempBundle();
  try {
    symlinkSync(join(dir, "manifest.json"), join(dir, "alias.json"));
    assert.throws(() => bundleDigest(dir), /BUNDLE_DIGEST_PATH_UNSAFE/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("bundleDigest rejects a non-directory path", () => {
  const dir = mkdtempSync(join(tmpdir(), "verify-fix-digest-file-"));
  try {
    const file = join(dir, "manifest.json");
    writeFileSync(file, "{}\n");
    assert.throws(() => bundleDigest(file), /BUNDLE_DIGEST_PATH_UNSAFE/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
