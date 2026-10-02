// Synthetic workflow shell simulation only: never calls a real deployment,
// Checkly, GitHub or a browser. Exercises the checked-in bash blocks with
// fake test-only values and checks their secret/file lifecycle.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const workflow = readFileSync(new URL("../../.github/workflows/protected-gate.yml", import.meta.url), "utf8");

function scriptOf(name: string): string {
  const header = `      - name: ${name}\n`;
  const begin = workflow.indexOf(header);
  assert.ok(begin >= 0, `workflow step ${name} exists`);
  const rest = workflow.slice(begin + header.length);
  const next = rest.search(/^      - (?:name:|uses:) /m);
  const step = next >= 0 ? rest.slice(0, next) : rest;
  const marker = "        run: |\n";
  const run = step.indexOf(marker);
  assert.ok(run >= 0, `${name} has a multiline shell block`);
  return step.slice(run + marker.length).split("\n")
    .filter((line) => line === "" || line.startsWith("          "))
    .map((line) => line.slice(10)).join("\n");
}

const synthetic = {
  TEST_USER: "synthetic-browser",
  TEST_USER_US_EAST_1: "synthetic-browser-east",
  TEST_USER_EU_WEST_1: "synthetic-browser-west",
  API_TOKEN: "synthetic-api-token",
  BYPASS: "synthetic-bypass-not-a-real-value",
};

function run(name: string, cwd: string, env: Record<string, string>): ReturnType<typeof spawnSync> {
  return spawnSync("bash", ["-e"], {
    input: scriptOf(name), cwd,
    encoding: "utf8", timeout: 10_000,
    env: { ...process.env, ...env },
  });
}

for (const [phase, build, cleanup] of [
  ["preview", "Build protected runtime and deployment metadata", "Remove preview runtime inputs"],
  ["production", "Build private runtime inputs and exact target metadata", "Remove production runtime inputs"],
] as const) {
  test(`${phase} shell uses scoped 0600 inputs, never logs secret values, and cleans both files`, () => {
    const root = mkdtempSync(join(tmpdir(), `verify-fix-shell-${phase}-`));
    try {
      const githubEnv = join(root, "github-env");
      const trustedPreview = join(root, "trusted", "incidents", "synthetic-preview");
      mkdirSync(trustedPreview, { recursive: true });
      writeFileSync(join(trustedPreview, "manifest.json"), JSON.stringify({ check: { checkType: "API" } }));
      const sha = "a".repeat(40);
      const url = "https://synthetic-deploy.invalid";
      const env = { ...synthetic, GITHUB_ENV: githubEnv, RUNNER_TEMP: root,
        VERIFY_FIX_BUNDLE: "incidents/synthetic-preview",
        MULTISTEP_USER_US_EAST_1: "synthetic-multistep-east",
        MULTISTEP_USER_EU_WEST_1: "synthetic-multistep-west",
        TARGET_URL: url, TARGET_REVISION: sha, VERIFIED_ID: "42", VERIFIED_SHA: sha, VERIFIED_URL: url,
        DEPLOYMENT_ID: "42", DEPLOYMENT_ENVIRONMENT: "Production",
      };
      const result = run(build, root, env);
      assert.equal(result.status, 0, result.stderr?.toString());
      assert.equal(result.stdout, "");
      assert.equal(result.stderr, "");
      const output = readFileSync(githubEnv, "utf8");
      assert.doesNotMatch(output, /synthetic-browser|synthetic-api-token|synthetic-bypass/);
      const file = /^VERIFY_FIX_ENV_FILE=(.+)$/m.exec(output)?.[1];
      const metadata = /^VERIFY_FIX_TARGET_METADATA=(.+)$/m.exec(output)?.[1];
      assert.ok(file && metadata && file.startsWith(root) && metadata.startsWith(root));
      for (const path of [file, metadata]) {
        assert.equal(statSync(path).mode & 0o777, 0o600);
        assert.ok(statSync(path).size < 4096);
      }
      const runtime = readFileSync(file, "utf8");
      for (const [name, value] of Object.entries(synthetic)) {
        const exportName = name === "BYPASS" ? "CHECKLY_SECRET_VERCEL_AUTOMATION_BYPASS_SECRET" : name;
        assert.ok(runtime.includes(`${exportName}=${value}\n`));
      }
      if (phase === "preview") {
        assert.doesNotMatch(runtime, /MULTISTEP_USER_/, "legacy API preview must not receive unrelated identities");
      } else {
        assert.match(runtime, /MULTISTEP_USER_US_EAST_1=synthetic-multistep-east\n/);
        assert.match(runtime, /MULTISTEP_USER_EU_WEST_1=synthetic-multistep-west\n/);
      }
      assert.deepEqual(JSON.parse(readFileSync(metadata, "utf8")), {
        provider: "github-deployment", deploymentId: "42", revision: sha, url, environment: "Production",
      });
      const cleaned = run(cleanup, root, { ...env, VERIFY_FIX_ENV_FILE: file, VERIFY_FIX_TARGET_METADATA: metadata });
      assert.equal(cleaned.status, 0, cleaned.stderr?.toString());
      assert.equal(existsSync(file), false);
      assert.equal(existsSync(metadata), false);

      // A malformed secret must fail before publishing paths and the ERR
      // trap removes both private files even without the always() cleanup.
      writeFileSync(githubEnv, "");
      const invalid = run(build, root, { ...env, TEST_USER: "synthetic\nnew-line" });
      assert.notEqual(invalid.status, 0);
      assert.doesNotMatch(`${invalid.stdout}${invalid.stderr}`, /synthetic\nnew-line|synthetic-bypass/);
      assert.equal(readFileSync(githubEnv, "utf8"), "");
      assert.deepEqual(readdirSync(root).filter((name) => name.startsWith("verify-fix-")), [],
        "ERR trap removed all temporary secrets");
      if (phase === "production") {
        for (const incorrect of [{ MULTISTEP_USER_US_EAST_1: "" },
          { MULTISTEP_USER_EU_WEST_1: "synthetic-multistep-east" },
          { MULTISTEP_USER_US_EAST_1: synthetic.TEST_USER }]) {
          const rejected = run(build, root, { ...env, ...incorrect });
          assert.notEqual(rejected.status, 0, "missing, shared or browser-overlap identities must fail closed");
          assert.doesNotMatch(`${rejected.stdout}${rejected.stderr}`, /synthetic-multistep-|synthetic-browser/);
          assert.deepEqual(readdirSync(root).filter((name) => name.startsWith("verify-fix-")), []);
        }
      }
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
}

test("Phase 7 bundle guard fails closed without an explicit reviewed path or on a legacy API bundle", () => {
  const root = mkdtempSync(join(tmpdir(), "verify-fix-bundle-guard-"));
  try {
    const bundle = join(root, "trusted", "incidents", "synthetic-phase7-fixture");
    mkdirSync(bundle, { recursive: true });
    const legacy = { schemaVersion: "v3", check: { checkType: "API", file: "checks/availability.check.ts" },
      recordings: { multistepFailing: null } };
    writeFileSync(join(bundle, "manifest.json"), JSON.stringify(legacy));
    const step = "Require a reviewed Phase 7 Multistep incident bundle";
    const missing = run(step, root, { APPROVED_BUNDLE: "", VERIFY_FIX_BUNDLE: "incidents/slots-availability-api" });
    assert.notEqual(missing.status, 0);
    const old = run(step, root, { APPROVED_BUNDLE: "incidents/synthetic-phase7-fixture",
      VERIFY_FIX_BUNDLE: "incidents/synthetic-phase7-fixture" });
    assert.notEqual(old.status, 0);
    writeFileSync(join(bundle, "manifest.json"), JSON.stringify({ schemaVersion: "v3",
      check: { checkType: "MULTI_STEP", file: "checks/multistep-booking.spec.ts", logicalId: "slots-booking-multistep" },
      recordings: { multistepFailing: "recordings/failing.multistep.json" } }));
    const matchingShape = run(step, root, { APPROVED_BUNDLE: "incidents/synthetic-phase7-fixture",
      VERIFY_FIX_BUNDLE: "incidents/synthetic-phase7-fixture" });
    assert.equal(matchingShape.status, 0, matchingShape.stderr?.toString());
    // This is deliberately only a shallow pre-approval *shape* guard. The
    // trusted verifier must still validate authenticated result provenance,
    // all files, the candidate source and the complete decision law.
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("approved Phase 7 preview receives two distinct Multistep identities only for a Multistep bundle", () => {
  const root = mkdtempSync(join(tmpdir(), "verify-fix-preview-multistep-"));
  try {
    const bundle = join(root, "trusted", "incidents", "synthetic-preview-multistep");
    mkdirSync(bundle, { recursive: true });
    writeFileSync(join(bundle, "manifest.json"), JSON.stringify({ check: { checkType: "MULTI_STEP" } }));
    const output = join(root, "github-env");
    const build = "Build protected runtime and deployment metadata";
    const env = { ...synthetic, RUNNER_TEMP: root, GITHUB_ENV: output,
      VERIFY_FIX_BUNDLE: "incidents/synthetic-preview-multistep",
      MULTISTEP_USER_US_EAST_1: "synthetic-ms-east", MULTISTEP_USER_EU_WEST_1: "synthetic-ms-west",
      TARGET_URL: "https://synthetic-preview.invalid", TARGET_REVISION: "a".repeat(40),
      DEPLOYMENT_ID: "42", DEPLOYMENT_ENVIRONMENT: "Preview" };
    const accepted = run(build, root, env);
    assert.equal(accepted.status, 0, accepted.stderr?.toString());
    assert.equal(accepted.stdout, "");
    const file = /^VERIFY_FIX_ENV_FILE=(.+)$/m.exec(readFileSync(output, "utf8"))?.[1];
    const metadata = /^VERIFY_FIX_TARGET_METADATA=(.+)$/m.exec(readFileSync(output, "utf8"))?.[1];
    assert.ok(file && metadata);
    const text = readFileSync(file, "utf8");
    assert.match(text, /MULTISTEP_USER_US_EAST_1=synthetic-ms-east\n/);
    assert.match(text, /MULTISTEP_USER_EU_WEST_1=synthetic-ms-west\n/);
    const cleaned = run("Remove preview runtime inputs", root,
      { ...env, VERIFY_FIX_ENV_FILE: file, VERIFY_FIX_TARGET_METADATA: metadata });
    assert.equal(cleaned.status, 0);
    writeFileSync(output, "");
    const rejected = run(build, root, { ...env, MULTISTEP_USER_US_EAST_1: env.TEST_USER });
    assert.notEqual(rejected.status, 0);
    assert.doesNotMatch(`${rejected.stdout}${rejected.stderr}`, /synthetic-ms-|synthetic-browser/);
    assert.equal(readFileSync(output, "utf8"), "");
    assert.deepEqual(readdirSync(root).filter((name) => name.startsWith("verify-fix-")), []);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
