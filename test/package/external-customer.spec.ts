// Distribution boundary. The examples stay in this repository for development,
// but a customer consumes verify-fix as a package from a different project.
// This test packs the exact npm artifact, installs it in a temporary customer
// project outside the repository, and invokes its installed binary there.

import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, spawnSync } from "node:child_process";

const REPO_ROOT = join(import.meta.dirname, "..", "..");
const DRIFT_BUNDLE = join(REPO_ROOT, "fixtures", "bundles", "slots-booking-drift");
const BAD_CANDIDATE = join(REPO_ROOT, "fixtures", "patches", "slots-booking-drift", "05-delete-assertion", "tests", "booking.spec.ts");
const GOOD_CANDIDATE = join(REPO_ROOT, "fixtures", "patches", "slots-booking-drift", "01-good-rename", "tests", "booking.spec.ts");

interface PackedFile {
  path: string;
}

interface PackResult {
  filename: string;
  files: PackedFile[];
}

function run(command: string, args: string[], cwd: string) {
  return spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    env: { PATH: process.env.PATH, HOME: process.env.HOME },
  });
}

function pack(cwd: string, destination: string): PackResult {
  const result = run("npm", ["pack", "--json", "--pack-destination", destination], cwd);
  assert.equal(result.status, 0, `npm pack failed:\n${result.stdout}\n${result.stderr}`);
  const parsed = JSON.parse(result.stdout) as PackResult[];
  assert.equal(parsed.length, 1);
  return parsed[0];
}

function runAsync(command: string, args: string[], cwd: string, extraEnv: NodeJS.ProcessEnv = {}): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env: { PATH: process.env.PATH, HOME: process.env.HOME, ...extraEnv },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += String(chunk)));
    child.stderr.on("data", (chunk) => (stderr += String(chunk)));
    child.on("error", reject);
    child.on("close", (status) => resolve({ status, stdout, stderr }));
  });
}

test("the packed CLI runs from an external customer project without repository files", { timeout: 120_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), "verify-fix-external-customer-"));
  const packed = join(root, "packed");
  const customer = join(root, "customer-project");
  const incident = join(customer, "incidents", "booking-drift");
  mkdirSync(packed, { recursive: true });
  mkdirSync(customer, { recursive: true });

  try {
    const cliPackage = pack(REPO_ROOT, packed);
    const packagePaths = new Set(cliPackage.files.map((file) => file.path));
    assert.ok(packagePaths.has("bin/verify-fix"), "published artifact must contain the executable");
    assert.ok(packagePaths.has("dist/cli.js"), "published artifact must contain compiled CLI code");
    assert.ok(packagePaths.has("src/check-api.ts"), "published artifact must contain the sandbox check API template");
    assert.ok(packagePaths.has("src/assertion/id.ts"), "published artifact must contain the sandbox assertion-id template");
    assert.ok(!packagePaths.has("src/cli.ts"), "installed consumers must not execute TypeScript from node_modules");
    assert.ok([...packagePaths].every((path) => !path.startsWith("examples/")), "example applications must not enter the npm package");
    assert.ok([...packagePaths].every((path) => !path.startsWith("fixtures/")), "test incidents must not enter the npm package");
    assert.ok([...packagePaths].every((path) => !path.startsWith("test/")), "the test suite must not enter the npm package");

    // Pack the one runtime dependency too. This keeps the consumer install
    // offline while still exercising npm's real tarball installation path.
    const typescriptPackage = pack(join(REPO_ROOT, "node_modules", "typescript"), packed);
    const cliTarball = join(packed, cliPackage.filename);
    const typescriptTarball = join(packed, typescriptPackage.filename);
    writeFileSync(join(customer, "package.json"), JSON.stringify({
      name: "outside-customer-monitoring-project",
      private: true,
      type: "module",
      dependencies: {
        "verify-fix": `file:${cliTarball}`,
        typescript: `file:${typescriptTarball}`,
      },
    }, null, 2));

    const install = run("npm", ["install", "--offline", "--ignore-scripts", "--no-audit", "--no-fund"], customer);
    assert.equal(install.status, 0, `external package install failed:\n${install.stdout}\n${install.stderr}`);

    // The bundle and candidate now live only under the external customer root.
    // The CLI repository is neither the current directory nor an input path.
    cpSync(DRIFT_BUNDLE, incident, { recursive: true });
    cpSync(join(incident, "check", "checkly.config.ts"), join(customer, "checkly.config.ts"));
    cpSync(join(incident, "check", "playwright.config.ts"), join(customer, "playwright.config.ts"));
    mkdirSync(join(customer, "tests"), { recursive: true });
    cpSync(BAD_CANDIDATE, join(customer, "tests", "booking.spec.ts"));
    writeFileSync(join(customer, ".gitignore"), "node_modules/\nverify-fix*.json\n");
    assert.equal(run("git", ["init", "-q"], customer).status, 0);
    assert.equal(run("git", ["config", "user.email", "customer@example.com"], customer).status, 0);
    assert.equal(run("git", ["config", "user.name", "Customer"], customer).status, 0);
    assert.equal(run("git", ["add", "-A"], customer).status, 0);
    assert.equal(run("git", ["commit", "-qm", "baseline"], customer).status, 0);
    const baseRevision = run("git", ["rev-parse", "HEAD"], customer).stdout.trim();

    const executable = join(customer, "node_modules", ".bin", process.platform === "win32" ? "verify-fix.cmd" : "verify-fix");
    const report = join(customer, "verify-fix.json");
    const verify = run(executable, [
      "verify",
      "--bundle", "incidents/booking-drift",
      "--candidate-project", ".",
      "--base", baseRevision,
      "--project", ".",
      "--executor", "scene",
      "--report-json", "verify-fix.json",
    ], customer);

    assert.equal(verify.status, 1, `the known bad external candidate must be FAILED:\n${verify.stdout}\n${verify.stderr}`);
    assert.ok(existsSync(report), `the installed CLI must write its report:\n${verify.stdout}\n${verify.stderr}`);
    const outcome = JSON.parse(readFileSync(report, "utf8")) as { verdict: string; candidate?: string; candidateProject?: string };
    assert.equal(outcome.verdict, "FAILED");
    assert.equal(outcome.candidate, customer);
    assert.equal(outcome.candidateProject, customer);

    // Prove the installed package also runs the complete hybrid path against
    // a customer-chosen environment. Nothing here assumes Vercel.
    cpSync(GOOD_CANDIDATE, join(customer, "tests", "booking.spec.ts"));
    const playwrightPackage = join(customer, "node_modules", "@playwright", "test");
    mkdirSync(playwrightPackage, { recursive: true });
    writeFileSync(join(playwrightPackage, "package.json"), JSON.stringify({
      name: "@playwright/test",
      exports: { "./cli": "./cli.cjs" },
    }));
    writeFileSync(join(playwrightPackage, "cli.cjs"), [
      `const fs = require('node:fs')`,
      `const source = fs.readFileSync('tests/booking.spec.ts', 'utf8')`,
      `fetch(process.env.ENVIRONMENT_URL + '/api/book', { method: 'POST' }).then(async (response) => {`,
      `  const passed = response.status === 200 && source.includes('booking-status') && process.env.ENVIRONMENT_NAME === 'customer-staging'`,
      `  const status = passed ? 'passed' : 'failed'`,
      `  console.log(JSON.stringify({ suites: [{ title: 'tests/booking.spec.ts', specs: [{ title: 'books', tests: [{ projectName: 'booking', results: [{ status, ...(passed ? {} : { error: { message: 'known failure reached the monitor' } }) }] }] }] }], errors: [] }))`,
      `  process.exitCode = passed ? 0 : 1`,
      `})`,
    ].join("\n"));

    const checklyBin = join(customer, "node_modules", ".bin", process.platform === "win32" ? "checkly.cmd" : "checkly");
    writeFileSync(checklyBin, `#!/usr/bin/env node\nconst fs = require('node:fs')\nconst args = process.argv.slice(2)\nconst value = (name) => args[args.indexOf(name) + 1]\nconst location = value('--location')\nconst envText = fs.readFileSync(value('--env-file'), 'utf8')\nconst passed = envText.includes('ENVIRONMENT_NAME="customer-staging"')\nconst report = { testSessionId: 'session-' + location, numChecks: 1, runLocation: location, checks: [{ result: passed ? 'Pass' : 'Fail', name: 'slots booking flow', retries: 0, link: 'https://app.checklyhq.com/test-sessions/external/results/result-' + location }] }\nfs.writeFileSync(process.env.CHECKLY_REPORTER_JSON_OUTPUT, JSON.stringify(report))\nprocess.exitCode = passed ? 0 : 1\n`);
    chmodSync(checklyBin, 0o755);

    let targetHits = 0;
    const target = createServer((_request, response) => {
      targetHits++;
      response.writeHead(200, { "content-type": "application/json" }).end('{"ok":true}');
    });
    await new Promise<void>((resolve) => target.listen(0, "127.0.0.1", resolve));
    const address = target.address();
    if (!address || typeof address === "string") throw new Error("external target has no port");
    const targetUrl = `http://127.0.0.1:${address.port}`;
    try {
      const liveReport = join(customer, "verify-fix-live.json");
      const live = await runAsync(executable, [
        "verify",
        "--bundle", "incidents/booking-drift",
        "--candidate-project", ".",
        "--base", baseRevision,
        "--project", ".",
        "--target", targetUrl,
        "--target-revision", "customer-revision-123",
        "--env-name", "customer-staging",
        "--executor", "hybrid",
        "--report-json", "verify-fix-live.json",
      ], customer, { CHECKLY_API_KEY: "fake-checkly-key", CHECKLY_ACCOUNT_ID: "fake-account" });
      assert.equal(live.status, 0, `the external customer's good repair must PASS:\n${live.stdout}\n${live.stderr}`);
      const result = JSON.parse(readFileSync(liveReport, "utf8")) as {
        verdict: string;
        target: string;
        targetRevision: string;
        candidateProject: string;
        checklyEvidence: { testSessionIds: string[] };
        cost: { localRuns: number; checklyCloudRuns: number };
      };
      assert.equal(result.verdict, "PASS");
      assert.equal(result.target, targetUrl);
      assert.equal(result.targetRevision, "customer-revision-123");
      assert.equal(result.candidateProject, customer);
      assert.ok(result.checklyEvidence.testSessionIds.length > 0);
      assert.ok(result.cost.localRuns > 0);
      assert.ok(result.cost.checklyCloudRuns > 0);
      assert.ok(targetHits > 0);
    } finally {
      await new Promise<void>((resolve) => target.close(() => resolve()));
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
