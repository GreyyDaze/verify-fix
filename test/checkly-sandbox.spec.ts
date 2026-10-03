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
    checks: [{ result, name: "slots booking flow", checkType: "PLAYWRIGHT", retries, link: "https://app.checklyhq.com/accounts/synthetic-account/test-sessions/session-123/results/result-456" }],
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
const ok = args[0] === 'test' && args.filter((item) => item === '--record').length === 1 && value('--retries') === '0' && value('--location') === 'eu-west-1' && value('--grep') === '^slots booking flow$' && !args.includes('-e') && source.includes('CANDIDATE') && envText.includes('TEST_USER="demo"') && envText.includes('ENVIRONMENT_URL="https://preview.example.com"') && envText.includes('ENVIRONMENT_NAME="preview"') && process.env.TEST_USER === 'demo' && process.env.ENVIRONMENT_URL === 'https://preview.example.com' && !fs.existsSync('app/private.txt') && !fs.existsSync('.env.local')
const out = { testSessionId: 'session-live', numChecks: 1, runLocation: 'eu-west-1', checks: [{ result: ok ? 'Pass' : 'Fail', name: 'slots booking flow', checkType: 'PLAYWRIGHT', retries: 0, link: 'https://app.checklyhq.com/accounts/synthetic-checkly-account/test-sessions/session-live/results/result-live' }] }
fs.writeFileSync(process.env.CHECKLY_REPORTER_JSON_OUTPUT, JSON.stringify(out))
process.exitCode = ok ? 0 : 1
`);
    chmodSync(cli, 0o755);

    const savedApiKey = process.env.CHECKLY_API_KEY;
    const savedAccountId = process.env.CHECKLY_ACCOUNT_ID;
    process.env.CHECKLY_API_KEY = "synthetic-checkly-key";
    process.env.CHECKLY_ACCOUNT_ID = "synthetic-checkly-account";
    let outcome;
    try {
      outcome = await runChecklySandbox({
        projectDir: project,
        files: { "checkly.config.ts": "// CANDIDATE CONFIG", "tests/booking.spec.ts": "// CANDIDATE SPEC" },
        target: "https://preview.example.com",
        targetRevision: "abc123",
        env: { TEST_USER: "demo", ENVIRONMENT_NAME: "preview" },
        location: "eu-west-1", checkName: "slots booking flow", testSessionName: "verify candidate",
      });
    } finally {
      if (savedApiKey === undefined) delete process.env.CHECKLY_API_KEY;
      else process.env.CHECKLY_API_KEY = savedApiKey;
      if (savedAccountId === undefined) delete process.env.CHECKLY_ACCOUNT_ID;
      else process.env.CHECKLY_ACCOUNT_ID = savedAccountId;
    }
    assert.equal(outcome.passed, true, outcome.reason ?? "no reason");
    assert.equal(outcome.testSessionId, "session-live");
    assert.deepEqual(outcome.checkResultIds, ["result-live"]);
    assert.equal(outcome.cloudRuns, 1);
    // A failed child can emit anything to stderr. No unstructured output or
    // raw provider exception becomes a report, even without a JSON file.
    writeFileSync(cli, "#!/usr/bin/env node\nprocess.stderr.write('private-stderr-canary')\nprocess.exitCode = 7\n");
    chmodSync(cli, 0o755);
    process.env.CHECKLY_API_KEY = "synthetic-checkly-key";
    process.env.CHECKLY_ACCOUNT_ID = "synthetic-checkly-account";
    try {
      const failed = await runChecklySandbox({
        projectDir: project,
        files: { "checkly.config.ts": "// CANDIDATE CONFIG", "tests/booking.spec.ts": "// CANDIDATE SPEC" },
        target: "https://preview.example.com", env: { TEST_USER: "demo" },
        location: "eu-west-1", checkName: "slots booking flow", testSessionName: "verify candidate",
      });
      assert.equal(failed.inconclusive, true);
      assert.equal(failed.testSessionId, null);
      assert.ok(!JSON.stringify(failed).includes("private-stderr-canary"));
      assert.ok(!JSON.stringify(failed).includes("synthetic-checkly-key"));
    } finally {
      if (savedApiKey === undefined) delete process.env.CHECKLY_API_KEY;
      else process.env.CHECKLY_API_KEY = savedApiKey;
      if (savedAccountId === undefined) delete process.env.CHECKLY_ACCOUNT_ID;
      else process.env.CHECKLY_ACCOUNT_ID = savedAccountId;
    }
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
const session = 'session-' + location + '-' + process.pid
fs.writeFileSync(process.env.CHECKLY_REPORTER_JSON_OUTPUT, JSON.stringify({ testSessionId: session, numChecks: 1, runLocation: location, checks: [{ result: 'Pass', name: 'slots booking flow', checkType: 'PLAYWRIGHT', retries: 0, link: 'https://app.checklyhq.com/accounts/synthetic-account/test-sessions/' + session + '/results/result-' + process.pid }] }))
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
    const invalidTarget = new ChecklyCliExecutor({ target: "invalid://private-stderr-canary", projectDir: project });
    const refused = await invalidTarget.runScene(bundle, bundle.checkSource, scene);
    assert.equal(refused.observed, "uncertain");
    assert.equal(refused.repetitions, 0);
    assert.ok(!JSON.stringify(refused).includes("private-stderr-canary"));
    const previous = process.env.CHECKLY_API_KEY;
    const previousAccount = process.env.CHECKLY_ACCOUNT_ID;
    process.env.CHECKLY_API_KEY = "test-key";
    process.env.CHECKLY_ACCOUNT_ID = "synthetic-account";
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
      if (previousAccount === undefined) delete process.env.CHECKLY_ACCOUNT_ID;
      else process.env.CHECKLY_ACCOUNT_ID = previousAccount;
    }
  });
});

test("Checkly JSON reporter admission rejects forged accounts, retries, shadow keys, wrong source and stale status", () => {
  const expected = { name: "slots booking multistep transaction", location: "eu-west-1",
    checkType: "MULTI_STEP", accountId: "synthetic-account" };
  const base = JSON.parse(report()) as Record<string, unknown> & { checks: Array<Record<string, unknown>> };
  base.checks[0]!.name = expected.name;
  base.checks[0]!.checkType = expected.checkType;
  base.checks[0]!.filename = "checks/multistep-booking.check.ts";
  const good = JSON.stringify(base);
  assert.equal(parseChecklyReport(good, 0, "", 0, expected).inconclusive, false);
  const tamper = (fn: (data: typeof base) => void) => {
    const data = structuredClone(base);
    fn(data);
    const observed = parseChecklyReport(JSON.stringify(data), 0, "private-stderr-canary", 0, expected);
    assert.equal(observed.inconclusive, true);
    assert.equal(observed.cloudRuns, 0);
    assert.equal(observed.testSessionId, null);
    assert.equal(observed.checkResultIds.length, 0);
    assert.ok(!JSON.stringify(observed).includes("private-stderr-canary"));
  };
  tamper((d) => { d.numChecks = 2; });
  tamper((d) => { d.checks.push({ ...d.checks[0] }); });
  tamper((d) => { d.runLocation = "us-east-1"; });
  tamper((d) => { d.checks[0]!.retries = 1; });
  tamper((d) => { delete d.checks[0]!.retries; });
  tamper((d) => { d.checks[0]!.runError = "secret-from-provider"; });
  tamper((d) => { d.checks[0]!.filename = "checks/multistep-booking.spec.ts"; });
  tamper((d) => { d.checks[0]!.filename = "checks/other.check.ts"; });
  tamper((d) => { d.checks[0]!.name = "other transaction"; });
  tamper((d) => { d.checks[0]!.link = String(d.checks[0]!.link).replace("synthetic-account", "other-account"); });
  tamper((d) => { d.checks[0]!.link = String(d.checks[0]!.link).replace("session-123", "other-session"); });
  tamper((d) => { d.checks[0]!.link = String(d.checks[0]!.link).replace("app.checklyhq.com", "attacker.invalid"); });
  assert.equal(parseChecklyReport(good, 1, "", 0, expected).inconclusive, true, "exit 1 cannot prove Pass");
  assert.equal(parseChecklyReport(good.replace('"retries":0', '"retries":1,"retries":0'), 0, "", 0, expected).inconclusive,
    true, "duplicate JSON keys cannot hide a retry");
  const deep = structuredClone(base);
  let nested: unknown = "value";
  for (let i = 0; i < 36; i++) nested = { branch: nested };
  deep.extra = nested;
  assert.equal(parseChecklyReport(JSON.stringify(deep), 0, "", 0, expected).inconclusive, true,
    "unused nested reporter data still obeys the raw schema bound");
});
