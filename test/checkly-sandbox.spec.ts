// Checkly CLI process boundary. The fake project-local CLI proves candidate
// copying, exact target/location arguments, recorded JSON classification, and
// the no-evidence rules without contacting a Checkly account.

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseChecklyReport, runChecklySandbox } from "../src/checkly-sandbox.ts";
import { ChecklyCliExecutor } from "../src/executor/checkly-cli.ts";
import type { Bundle, Scene } from "../src/types.ts";

function report(result = "Pass", retries = 0) {
  return JSON.stringify({
    testSessionId: "session-123",
    numChecks: 1,
    runLocation: "eu-west-1",
    checks: [{ result, name: "slots booking flow", checkType: "PLAYWRIGHT", retries, link: "https://app.checklyhq.com/test-sessions/session-123/results/result-456" }],
  });
}

describe("Checkly JSON evidence", () => {
  test("pass and fail are observations; missing sessions, zero checks, retries, and malformed reports are inconclusive", () => {
    const passed = parseChecklyReport(report(), 0);
    assert.equal(passed.passed, true);
    assert.equal(passed.inconclusive, false);
    assert.deepEqual(passed.checkResultIds, ["result-456"]);
    assert.equal(parseChecklyReport(report("Fail"), 1).inconclusive, false);
    assert.equal(parseChecklyReport(report("Fail"), 1).passed, false);
    assert.equal(parseChecklyReport(report("Pass", 1), 0).inconclusive, true);
    assert.equal(parseChecklyReport(JSON.stringify({ testSessionId: "session", numChecks: 1, checks: [{ result: "Pass", name: "slots booking flow" }] }), 0).inconclusive, true);
    assert.equal(parseChecklyReport(JSON.stringify({ numChecks: 0, checks: [] }), 0).inconclusive, true);
    assert.equal(parseChecklyReport("not-json", 1, "cloud error").inconclusive, true);
  });

  test("uses the project-local CLI with candidate source, exact preview URL, zero retries, and a temporary env file", async () => {
    const project = mkdtempSync(join(tmpdir(), "verify-fix-fake-checkly-project-"));
    mkdirSync(join(project, "node_modules", ".bin"), { recursive: true });
    writeFileSync(join(project, "package.json"), JSON.stringify({ name: "customer-project" }));
    writeFileSync(join(project, "checkly.config.ts"), "// ORIGINAL CONFIG");
    mkdirSync(join(project, "tests"), { recursive: true });
    writeFileSync(join(project, "tests", "booking.spec.ts"), "// ORIGINAL SPEC");
    mkdirSync(join(project, "app"), { recursive: true });
    writeFileSync(join(project, "app", "private.txt"), "must not enter the Checkly sandbox");
    writeFileSync(join(project, ".env.local"), "PRIVATE_VALUE=must-not-enter");
    const cli = join(project, "node_modules", ".bin", "checkly");
    writeFileSync(cli, `#!/usr/bin/env node
const fs = require('node:fs')
const args = process.argv.slice(2)
const value = (name) => args[args.indexOf(name) + 1]
const source = fs.readFileSync('tests/booking.spec.ts', 'utf8')
const envText = fs.readFileSync(value('--env-file'), 'utf8')
const ok = args[0] === 'test' && args.includes('--record') && value('--retries') === '0' && value('--location') === 'eu-west-1' && value('--grep') === '^slots booking flow$' && !args.includes('-e') && source.includes('CANDIDATE') && envText.includes('TEST_USER="demo"') && envText.includes('ENVIRONMENT_URL="https://preview.example.com"') && envText.includes('ENVIRONMENT_NAME="preview"') && process.env.TEST_USER === 'demo' && process.env.ENVIRONMENT_URL === 'https://preview.example.com' && !fs.existsSync('app/private.txt') && !fs.existsSync('.env.local')
const out = { testSessionId: 'session-live', numChecks: 1, runLocation: 'eu-west-1', checks: [{ result: ok ? 'Pass' : 'Fail', name: 'slots booking flow', checkType: 'PLAYWRIGHT', retries: 0, link: 'https://app.checklyhq.com/test-sessions/session-live/results/result-live' }] }
fs.writeFileSync(process.env.CHECKLY_REPORTER_JSON_OUTPUT, JSON.stringify(out))
process.exitCode = ok ? 0 : 1
`);
    chmodSync(cli, 0o755);

    const outcome = await runChecklySandbox({
      projectDir: project,
      files: { "checkly.config.ts": "// CANDIDATE CONFIG", "tests/booking.spec.ts": "// CANDIDATE SPEC" },
      target: "https://preview.example.com",
      targetRevision: "abc123",
      env: { TEST_USER: "demo", ENVIRONMENT_NAME: "preview" },
      location: "eu-west-1",
      checkName: "slots booking flow",
      testSessionName: "verify candidate",
    });
    assert.equal(outcome.passed, true, outcome.reason ?? outcome.raw);
    assert.equal(outcome.testSessionId, "session-live");
    assert.deepEqual(outcome.checkResultIds, ["result-live"]);
    assert.equal(outcome.cloudRuns, 1);
  });

  test("remote executor repeats every configured location and reports cloud cost", async () => {
    const project = mkdtempSync(join(tmpdir(), "verify-fix-fake-checkly-executor-"));
    mkdirSync(join(project, "node_modules", ".bin"), { recursive: true });
    mkdirSync(join(project, "tests"), { recursive: true });
    writeFileSync(join(project, "package.json"), JSON.stringify({ name: "customer-project" }));
    writeFileSync(join(project, "checkly.config.ts"), "// config");
    writeFileSync(join(project, "tests", "booking.spec.ts"), "// candidate");
    const cli = join(project, "node_modules", ".bin", "checkly");
    writeFileSync(cli, `#!/usr/bin/env node
const fs = require('node:fs')
const args = process.argv.slice(2)
const at = (name) => args[args.indexOf(name) + 1]
const location = at('--location')
fs.writeFileSync(process.env.CHECKLY_REPORTER_JSON_OUTPUT, JSON.stringify({ testSessionId: 'session-' + location, numChecks: 1, runLocation: location, checks: [{ result: 'Pass', name: 'slots booking flow', retries: 0, link: 'https://app.checklyhq.com/test-sessions/x/results/result-' + location }] }))
`);
    chmodSync(cli, 0o755);
    const bundle = {
      incidentId: "incident",
      check: { repo: "repo", file: "tests/booking.spec.ts", name: "slots booking flow", logicalId: "slots", deployedId: null },
      checkSource: "// candidate",
      files: { "checkly.config.ts": "// config", "tests/booking.spec.ts": "// candidate" },
      config: { runParallel: true, locations: ["us-east-1", "eu-west-1"], frequencyMinutes: 5, environmentVariables: [] },
    } as unknown as Bundle;
    const scene: Scene = {
      sceneId: "healthy-live",
      type: "HEALTHY",
      state: "healthy",
      mode: "live",
      verdict: { mustFail: false, provenance: { kind: "code", assertionId: "assert:x" }, envAssumptions: [] },
      experiments: [{ durationSec: 1, repetitions: 2, expectStable: true }],
      assertionsInvolved: [],
    };
    const previous = process.env.CHECKLY_API_KEY;
    process.env.CHECKLY_API_KEY = "test-key";
    try {
      const executor = new ChecklyCliExecutor({ target: "https://preview.example.com", projectDir: project });
      const observed = await executor.runScene(bundle, bundle.checkSource, scene, { config: bundle.config, files: bundle.files, phase: "candidate" });
      assert.equal(observed.observed, "pass");
      assert.equal(observed.repetitions, 2);
      assert.equal(observed.checklySessionIds?.length, 4);
      assert.equal(observed.checklyResultIds?.length, 4);
      assert.equal(executor.costReport().checklyTestSessions, 4);
      assert.equal(executor.costReport().checklyCloudRuns, 4);
      assert.equal(executor.costReport().checklySessionIds.length, 4);
      assert.equal(executor.costReport().checklyResultIds.length, 4);
    } finally {
      if (previous === undefined) delete process.env.CHECKLY_API_KEY;
      else process.env.CHECKLY_API_KEY = previous;
    }
  });
});
