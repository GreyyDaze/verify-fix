// CLI argument surface: version reporting and documented bundle flags.
//
// These run the real CLI process so the published entrypoint contract is what
// is under test, not a re-implementation of the parser.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const cli = fileURLToPath(new URL("../../src/cli.ts", import.meta.url));
const packageVersion = JSON.parse(
  readFileSync(join(fileURLToPath(new URL("../../package.json", import.meta.url))), "utf8"),
).version as string;

function run(args: string[], env: NodeJS.ProcessEnv = {}) {
  return spawnSync(process.execPath, [cli, ...args], {
    encoding: "utf8",
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin", ...env },
  });
}

test("--version prints exactly the package version and exits 0", () => {
  for (const flag of ["--version", "-V"]) {
    const result = run([flag]);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), packageVersion);
  }
});

test("--help is discoverable, documents every command, and exits 0", () => {
  const result = run(["--help"]);
  assert.equal(result.status, 0, "an explicit help request is not an error");
  for (const command of ["bundle", "verify", "measure", "init", "cost-report", "--version"]) {
    assert.match(result.stdout, new RegExp(command));
  }
});

test("no command prints usage and exits 2", () => {
  const result = run([]);
  assert.equal(result.status, 2);
  assert.match(result.stdout, /verify-fix bundle/);
});

test("bundle accepts the documented --pass-result flag", () => {
  // A fresh HOME has no saved `checkly login`; reaching the credentials error
  // proves the argument parsed instead of being rejected as an unknown flag.
  const home = mkdtempSync(join(tmpdir(), "verify-fix-cli-home-"));
  try {
    const result = run([
      "bundle",
      "--check", "synthetic-check",
      "--result", "synthetic-failing-result",
      "--pass-result", "synthetic-passing-result",
    ], { HOME: home, XDG_CONFIG_HOME: join(home, ".config") });
    assert.equal(result.status, 2, result.stderr);
    assert.doesNotMatch(result.stderr, /invalid or ambiguous CLI arguments/);
    assert.match(result.stderr, /CHECKLY_API_KEY|credentials/i);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("an unknown flag is rejected rather than ignored", () => {
  const result = run(["verify", "--not-a-flag"]);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /invalid or ambiguous CLI arguments/);
});

/** A v2 bundle is the smallest on-disk shape the loader accepts: a manifest
 * plus the check source it names. It is enough to exercise preflight wiring. */
function minimalBundle(root: string): string {
  const dir = join(root, "bundle");
  mkdirSync(join(dir, "check"), { recursive: true });
  writeFileSync(join(dir, "check", "check.ts"), "// captured check source\n");
  writeFileSync(join(dir, "manifest.json"), JSON.stringify({
    schemaVersion: "v2",
    incidentId: "synthetic-incident",
    incident: { title: "synthetic", description: "synthetic" },
    check: { file: "check.ts" },
    scenes: [],
    envAssumptions: [],
  }));
  return dir;
}

test("--dry-run validates a complete setup and exits 0 without executing", () => {
  const root = mkdtempSync(join(tmpdir(), "verify-fix-preflight-ok-"));
  try {
    const bundle = minimalBundle(root);
    const patch = join(root, "fix.patch");
    writeFileSync(patch, "--- a/check.ts\n+++ b/check.ts\n");
    const result = run(["verify", "--bundle", bundle, "--patch", patch, "--dry-run"]);
    assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
    assert.match(result.stdout, /preflight: ok/);
    assert.match(result.stdout, /no scenes executed/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("--dry-run reports a missing patch and a fingerprint mismatch", () => {
  const root = mkdtempSync(join(tmpdir(), "verify-fix-preflight-bad-"));
  try {
    const bundle = minimalBundle(root);
    const result = run([
      "verify", "--bundle", bundle, "--patch", join(root, "absent.patch"),
      "--bundle-digest", "b".repeat(64), "--dry-run", "--json",
    ]);
    assert.equal(result.status, 2, `${result.stdout}${result.stderr}`);
    const report = JSON.parse(result.stdout) as { ok: boolean; checks: { name: string; ok: boolean }[] };
    assert.equal(report.ok, false);
    assert.equal(report.checks.find((check) => check.name === "patch")?.ok, false);
    assert.equal(report.checks.find((check) => check.name === "bundle fingerprint")?.ok, false);
    assert.equal(report.checks.find((check) => check.name === "bundle")?.ok, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("--dry-run fails closed when the bundle cannot be loaded", () => {
  const root = mkdtempSync(join(tmpdir(), "verify-fix-preflight-nobundle-"));
  try {
    const patch = join(root, "fix.patch");
    writeFileSync(patch, "");
    const result = run(["verify", "--bundle", join(root, "missing"), "--patch", patch, "--dry-run"]);
    assert.equal(result.status, 2);
    assert.match(result.stdout, /preflight: failed/);
    assert.match(result.stdout, /bundle manifest not found/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
