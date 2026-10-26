import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const scriptPath = fileURLToPath(new URL("../../scripts/ci-gate.sh", import.meta.url));
const source = readFileSync(scriptPath, "utf8");

test("the neutral gate adapter is provider-agnostic and binds an exact revision", () => {
  assert.doesNotMatch(source, /github\.event|api\.vercel\.com|actions\/checkout|deployment_status/);
  assert.match(source, /--candidate-revision/);
  assert.match(source, /--cloud-approved/);
  assert.match(source, /--executor hybrid/);
  assert.match(source, /gateEligible/);
});

test("the neutral gate adapter parses and fails closed without configuration", () => {
  execFileSync("bash", ["-n", scriptPath], { encoding: "utf8" });
  const empty = spawnSync("bash", [scriptPath], {
    encoding: "utf8",
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
  });
  assert.equal(empty.status, 2, `${empty.stdout}${empty.stderr}`);
  assert.match(empty.stderr, /is required/);
});

test("the neutral gate adapter refuses a target revision that is not the candidate pin", () => {
  const root = mkdtempSync(join(tmpdir(), "verify-fix-ci-gate-"));
  try {
    const bundle = join(root, "bundle");
    mkdirSync(bundle);
    const metadata = join(root, "deployment.json");
    writeFileSync(metadata, "{}");
    const result = spawnSync("bash", [scriptPath], {
      encoding: "utf8",
      env: {
        PATH: process.env.PATH ?? "/usr/bin:/bin",
        VF_BUNDLE_DIR: bundle,
        VF_BUNDLE_DIGEST: "a".repeat(64),
        VF_CANDIDATE_PROJECT: root,
        VF_BASE: "a".repeat(40),
        VF_CANDIDATE_REVISION: "a".repeat(40),
        VF_TARGET: "https://preview.example",
        VF_TARGET_REVISION: "b".repeat(40),
        VF_TARGET_METADATA: metadata,
        CHECKLY_API_KEY: "synthetic-key",
        CHECKLY_ACCOUNT_ID: "synthetic-account",
      },
    });
    assert.equal(result.status, 2, `${result.stdout}${result.stderr}`);
    assert.match(result.stderr, /must equal VF_CANDIDATE_REVISION/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function adapterEnv(root: string, cli: string): NodeJS.ProcessEnv {
  const bundle = join(root, "bundle");
  mkdirSync(bundle, { recursive: true });
  const metadata = join(root, "deployment.json");
  writeFileSync(metadata, "{}");
  return {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    VF_BUNDLE_DIR: bundle,
    VF_BUNDLE_DIGEST: "a".repeat(64),
    VF_CANDIDATE_PROJECT: root,
    VF_BASE: "a".repeat(40),
    VF_CANDIDATE_REVISION: "a".repeat(40),
    VF_TARGET: "https://preview.example",
    VF_TARGET_REVISION: "a".repeat(40),
    VF_TARGET_METADATA: metadata,
    CHECKLY_API_KEY: "synthetic-key",
    CHECKLY_ACCOUNT_ID: "synthetic-account",
    VF_CLI: cli,
  };
}

function stubCli(root: string, name: string, verdict: string, eligible: boolean, exitCode = 0): string {
  const path = join(root, name);
  writeFileSync(path, `
    import { writeFileSync } from "node:fs";
    const args = process.argv.slice(2);
    writeFileSync(${JSON.stringify(path)} + ".args.json", JSON.stringify(args));
    writeFileSync(args[args.indexOf("--report-json") + 1], JSON.stringify({
      verdict: ${JSON.stringify(verdict)},
      targetBinding: { gateEligible: ${eligible} },
    }));
    process.exit(${exitCode});
  `);
  return path;
}

test("the gate defaults the requirements mode to shadow and honours an override", () => {
  const root = mkdtempSync(join(tmpdir(), "verify-fix-ci-gate-mode-"));
  try {
    const cli = stubCli(root, "mode.mjs", "PASS", true);
    const modePassed = () => {
      const args = JSON.parse(readFileSync(`${cli}.args.json`, "utf8")) as string[];
      return args[args.indexOf("--requirements-mode") + 1];
    };

    const byDefault = spawnSync("bash", [scriptPath], { encoding: "utf8", env: adapterEnv(root, cli) });
    assert.equal(byDefault.status, 0, `${byDefault.stdout}${byDefault.stderr}`);
    assert.equal(modePassed(), "shadow", "an unset mode must not silently enforce");

    const overridden = spawnSync("bash", [scriptPath], {
      encoding: "utf8",
      env: { ...adapterEnv(root, cli), VF_REQUIREMENTS_MODE: "enforce" },
    });
    assert.equal(overridden.status, 0, `${overridden.stdout}${overridden.stderr}`);
    assert.equal(modePassed(), "enforce");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the neutral gate adapter accepts only a gate-eligible PASS", () => {
  const root = mkdtempSync(join(tmpdir(), "verify-fix-ci-gate-pass-"));
  try {
    const cli = stubCli(root, "pass.mjs", "PASS", true);
    const result = spawnSync("bash", [scriptPath], { encoding: "utf8", env: adapterEnv(root, cli) });
    assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
    assert.match(result.stdout, /ci-gate: PASS \(gate-eligible\)/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the neutral gate adapter fails closed when the pinned CLI version differs", () => {
  const root = mkdtempSync(join(tmpdir(), "verify-fix-ci-gate-version-"));
  try {
    const path = join(root, "versioned.mjs");
    writeFileSync(path, `
      const args = process.argv.slice(2);
      if (args.includes("--version")) { process.stdout.write("9.9.9\\n"); process.exit(0); }
      process.exit(0);
    `);
    const mismatch = spawnSync("bash", [scriptPath], {
      encoding: "utf8",
      env: { ...adapterEnv(root, path), VF_CLI_VERSION: "0.1.0" },
    });
    assert.equal(mismatch.status, 2, `${mismatch.stdout}${mismatch.stderr}`);
    assert.match(mismatch.stderr, /VF_CLI_VERSION=0\.1\.0 but the CLI reports '9\.9\.9'/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the neutral gate adapter continues when the pinned version matches", () => {
  const root = mkdtempSync(join(tmpdir(), "verify-fix-ci-gate-version-ok-"));
  try {
    const path = join(root, "versioned-pass.mjs");
    writeFileSync(path, `
      import { writeFileSync } from "node:fs";
      const args = process.argv.slice(2);
      if (args.includes("--version")) { process.stdout.write("0.1.0\\n"); process.exit(0); }
      writeFileSync(args[args.indexOf("--report-json") + 1], JSON.stringify({
        verdict: "PASS",
        targetBinding: { gateEligible: true },
      }));
      process.exit(0);
    `);
    const result = spawnSync("bash", [scriptPath], {
      encoding: "utf8",
      env: { ...adapterEnv(root, path), VF_CLI_VERSION: "0.1.0" },
    });
    assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
    assert.match(result.stdout, /ci-gate: PASS \(gate-eligible\)/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the neutral gate adapter fails closed on an ineligible PASS or failing verdict", () => {
  const root = mkdtempSync(join(tmpdir(), "verify-fix-ci-gate-fail-"));
  try {
    const ineligible = spawnSync("bash", [scriptPath], {
      encoding: "utf8",
      env: adapterEnv(root, stubCli(root, "ineligible.mjs", "PASS", false)),
    });
    assert.equal(ineligible.status, 2, `${ineligible.stdout}${ineligible.stderr}`);
    assert.match(ineligible.stderr, /not gate-eligible/);

    const failed = spawnSync("bash", [scriptPath], {
      encoding: "utf8",
      env: adapterEnv(root, stubCli(root, "failed.mjs", "FAIL", true)),
    });
    assert.equal(failed.status, 2, `${failed.stdout}${failed.stderr}`);
    assert.match(failed.stderr, /verdict is FAIL, not PASS/);

    const crashed = spawnSync("bash", [scriptPath], {
      encoding: "utf8",
      env: adapterEnv(root, stubCli(root, "crashed.mjs", "PASS", true, 7)),
    });
    assert.equal(crashed.status, 7, `${crashed.stdout}${crashed.stderr}`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
