// Parity test: the trusted gate recomputes the bundle fingerprint with a
// dependency-free helper (no execution of the tool under test). The helper's
// algorithm must be byte-identical to src/capture/bundle/digest.ts, or a valid
// bundle would be rejected (or worse, a swapped one accepted).
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bundleDigest } from "../../src/capture/bundle/digest.ts";

const root = new URL("../../", import.meta.url).pathname;
const helper = join(root, ".github/helpers/bundle-digest.mjs");

function runHelper(dir: string) {
  return spawnSync(process.execPath, [helper, dir], { encoding: "utf8", timeout: 10_000 });
}

test("helper fingerprint matches the TypeScript bundle digest", () => {
  const dir = mkdtempSync(join(tmpdir(), "verify-fix-digest-parity-"));
  try {
    mkdirSync(join(dir, "check/checks"), { recursive: true });
    mkdirSync(join(dir, "results"), { recursive: true });
    writeFileSync(join(dir, "manifest.json"), '{"schemaVersion":"v3"}\n');
    writeFileSync(join(dir, "check/checks/a.check.ts"), "// a\n");
    writeFileSync(join(dir, "results/history.json"), "[]\n");
    const out = runHelper(dir);
    assert.equal(out.status, 0, out.stderr);
    assert.equal(out.stdout.trim(), bundleDigest(dir));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("helper fails closed on a symlink and on no argument", () => {
  const dir = mkdtempSync(join(tmpdir(), "verify-fix-digest-unsafe-"));
  try {
    writeFileSync(join(dir, "manifest.json"), "{}\n");
    symlinkSync(join(dir, "manifest.json"), join(dir, "alias.json"));
    const unsafe = runHelper(dir);
    assert.equal(unsafe.status, 1);
    assert.match(unsafe.stderr, /BUNDLE_DIGEST_PATH_UNSAFE/);
    const missing = spawnSync(process.execPath, [helper], { encoding: "utf8" });
    assert.equal(missing.status, 2);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
