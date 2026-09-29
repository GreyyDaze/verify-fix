// Local-only isolation of environment names at the Checkly CLI child boundary.
// No cloud session, credentials, or Checkly account are used.
import assert from "node:assert/strict";
import test from "node:test";
import { scopedChecklyEnvironment } from "../../src/executor/checkly-cli.ts";
import type { Bundle } from "../../src/types.ts";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChecklyCliExecutor } from "../../src/executor/checkly-cli.ts";
import { syntheticRemoteBundle } from "./remote-fixture.ts";
import { repairedNestedSpec } from "./detection-fixture.ts";
import { multiStepDiskRebound, sameBoundedData } from "../../src/multistep/rebind.ts";
import { trustedMultiStepDetection } from "../../src/multistep/detection.ts";

const bundle = { check: { checkType: "MULTI_STEP" } } as Bundle;

test("Multistep cloud child sees two region identities and approved bypass, never shared browser/API secrets", () => {
  const input = { MULTISTEP_USER_US_EAST_1: "synthetic-ms-east", MULTISTEP_USER_EU_WEST_1: "synthetic-ms-west",
    CHECKLY_SECRET_VERCEL_AUTOMATION_BYPASS_SECRET: "synthetic-bypass", ENVIRONMENT_NAME: "preview",
    TEST_USER: "synthetic-browser", TEST_USER_US_EAST_1: "synthetic-browser-east", API_TOKEN: "synthetic-api",
    CHECKLY_API_KEY: "synthetic-cloud-auth", ENVIRONMENT_URL: "https://untrusted-override.invalid",
    PATH: "/untrusted/path" };
  assert.deepEqual(scopedChecklyEnvironment(bundle, input), {
    MULTISTEP_USER_US_EAST_1: "synthetic-ms-east", MULTISTEP_USER_EU_WEST_1: "synthetic-ms-west",
    CHECKLY_SECRET_VERCEL_AUTOMATION_BYPASS_SECRET: "synthetic-bypass", ENVIRONMENT_NAME: "preview",
  });
  assert.equal(scopedChecklyEnvironment(bundle, { ...input, MULTISTEP_USER_EU_WEST_1: input.MULTISTEP_USER_US_EAST_1 }), null);
  assert.equal(scopedChecklyEnvironment(bundle, { ...input, MULTISTEP_USER_US_EAST_1: "" }), null);
  assert.equal(scopedChecklyEnvironment(bundle, { ...input, MULTISTEP_USER_US_EAST_1: " synthetic-ms-east" }), null);
  // The legacy API/browser sandbox keeps its separate environment contract.
  const api = { check: { checkType: "API" } } as Bundle;
  assert.deepEqual(scopedChecklyEnvironment(api, input), input);
});


test("disk-bound remote children isolate the selected region and bypass at each repeated location", async () => {
  // The locally written executable emulates a Checkly JSON reporter. It never
  // contacts Checkly and writes only pass/fail booleans, not runtime values.
  const project = mkdtempSync(join(tmpdir(), "verify-fix-remote-region-scope-"));
  const priorKey = process.env.CHECKLY_API_KEY;
  const priorAccount = process.env.CHECKLY_ACCOUNT_ID;
  try {
    mkdirSync(join(project, "node_modules", ".bin"), { recursive: true });
    writeFileSync(join(project, "package.json"), '{"name":"synthetic-project"}');
    const cli = join(project, "node_modules", ".bin", "checkly");
    writeFileSync(cli, `#!/usr/bin/env node
const fs = require('node:fs')
const args = process.argv.slice(2)
const at = (flag) => args[args.indexOf(flag) + 1]
const location = at('--location')
const selected = location === 'us-east-1' ? 'MULTISTEP_USER_US_EAST_1' : 'MULTISTEP_USER_EU_WEST_1'
const other = location === 'us-east-1' ? 'MULTISTEP_USER_EU_WEST_1' : 'MULTISTEP_USER_US_EAST_1'
const file = fs.readFileSync(at('--env-file'), 'utf8')
const isolated = args[0] === 'test' && at('--grep') === '^slots booking multistep transaction$'
  && args.filter(v => v === '--record').length === 1 && at('--retries') === '0'
  && !!process.env[selected] && !process.env[other] && file.includes(selected + '=') && !file.includes(other + '=')
  && !!process.env.CHECKLY_SECRET_VERCEL_AUTOMATION_BYPASS_SECRET
  && file.includes('CHECKLY_SECRET_VERCEL_AUTOMATION_BYPASS_SECRET=')
  && !process.env.TEST_USER && !process.env.API_TOKEN && !file.includes('TEST_USER=')
  && process.env.ENVIRONMENT_URL === 'https://synthetic-target.example'
  && process.env.CHECKLY_ACCOUNT_ID === 'synthetic-account'
const session = 'session-' + location + '-' + process.pid
fs.writeFileSync(process.env.CHECKLY_REPORTER_JSON_OUTPUT, JSON.stringify({
  testSessionId: session, runLocation: location, numChecks: 1, checks: [{
    result: isolated ? 'Pass' : 'Fail', name: 'slots booking multistep transaction',
    checkType: 'MULTI_STEP', filename: 'checks/multistep-booking.check.ts', retries: 0,
    link: 'https://app.checklyhq.com/accounts/synthetic-account/test-sessions/' + session + '/results/result-' + process.pid
  }]
}))
process.exitCode = isolated ? 0 : 1
`);
    chmodSync(cli, 0o755);
    const captured = await syntheticRemoteBundle();
    const repaired = repairedNestedSpec();
    const scene = captured.scenes.find((item) => item.type === "HEALTHY")!;
    const regionalEnv = {
      MULTISTEP_USER_US_EAST_1: "synthetic-east", MULTISTEP_USER_EU_WEST_1: "synthetic-west",
      CHECKLY_SECRET_VERCEL_AUTOMATION_BYPASS_SECRET: "synthetic-bypass",
      TEST_USER: "synthetic-browser", API_TOKEN: "synthetic-api",
    };
    process.env.CHECKLY_API_KEY = "synthetic-key";
    process.env.CHECKLY_ACCOUNT_ID = "synthetic-account";
    const run = (env: typeof regionalEnv) => new ChecklyCliExecutor({ projectDir: project,
      target: "https://synthetic-target.example", env });
    const ctx = { phase: "candidate" as const, config: captured.config,
      files: { ...captured.files, [captured.check.file]: repaired } };
    const executor = run(regionalEnv);
    const observed = await executor.runScene(captured, repaired, scene, ctx);
    assert.equal(observed.observed, "pass", observed.reason ?? "no recorded result");
    assert.equal(observed.repetitions, 5);
    assert.equal(new Set(observed.checklySessionIds).size, 10);
    assert.equal(new Set(observed.checklyResultIds).size, 10);
    assert.equal(executor.costReport().checklyTestSessions, 10);
    assert.equal(executor.costReport().checklyCloudRuns, 10);
    const uniqueReporter = readFileSync(cli, "utf8");
    writeFileSync(cli, uniqueReporter.replace("const session = 'session-' + location + '-' + process.pid",
      "const session = 'replayed-session'"));
    const replayed = run(regionalEnv);
    const replayObservation = await replayed.runScene(captured, repaired, scene, ctx);
    assert.equal(replayObservation.observed, "uncertain", "two regional children cannot borrow one session ID");
    assert.equal(replayObservation.repetitions, 1);
    assert.equal(replayed.costReport().checklyCloudRuns, 2, "both already launched children are still counted");
    for (const invalid of [
      { ...regionalEnv, MULTISTEP_USER_EU_WEST_1: regionalEnv.MULTISTEP_USER_US_EAST_1 },
      { ...regionalEnv, CHECKLY_SECRET_VERCEL_AUTOMATION_BYPASS_SECRET: "" },
    ]) {
      const rejected = run(invalid);
      const result = await rejected.runScene(captured, repaired, scene, ctx);
      assert.equal(result.observed, "uncertain");
      assert.equal(result.repetitions, 0);
      assert.equal(rejected.costReport().checklyCloudRuns, 0);
    }
  } finally {
    if (priorKey === undefined) delete process.env.CHECKLY_API_KEY;
    else process.env.CHECKLY_API_KEY = priorKey;
    if (priorAccount === undefined) delete process.env.CHECKLY_ACCOUNT_ID;
    else process.env.CHECKLY_ACCOUNT_ID = priorAccount;
    rmSync(project, { recursive: true, force: true });
  }
});


test("a toJSON method, accessor, or altered caller-owned v3 bundle cannot impersonate disk authority", async () => {
  const disk = await syntheticRemoteBundle();
  const detection = disk.scenes.find((item) => item.type === "DETECTION")!;
  assert.equal(multiStepDiskRebound(disk), true);
  assert.ok(trustedMultiStepDetection(disk, detection));
  const altered = { ...disk, check: { ...disk.check, name: "forged-name" } };
  Object.defineProperty(altered, "toJSON", { value: () => disk, enumerable: false });
  assert.equal(sameBoundedData(altered, disk), false);
  assert.equal(multiStepDiskRebound(altered), false);
  assert.equal(trustedMultiStepDetection(altered, detection), null);
  const forged = { ...detection, assertionsInvolved: [...detection.assertionsInvolved, "forged-assertion"],
    toJSON: () => detection };
  assert.equal(trustedMultiStepDetection({ ...disk, scenes: disk.scenes.map((item) =>
    item.type === "DETECTION" ? forged : item) }, forged), null);
  const accessor = { ...disk, config: { ...disk.config! } };
  Object.defineProperty(accessor.config, "runParallel", { get: () => true, enumerable: true });
  assert.equal(multiStepDiskRebound(accessor), false);
  assert.equal(sameBoundedData([1, , 2], [1, null, 2]), false,
    "sparse arrays cannot stringify to an admitted null");
});
