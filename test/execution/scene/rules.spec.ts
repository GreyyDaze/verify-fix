// Pure rules of the scene layer: mode grammar, effective concurrency, config
// diff + policy, environment references, patch sets.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { parseMode, effectiveConcurrency, needsTarget } from "../../../src/execution/scene/modes.ts";
import { parseCheckConfig, diffCheckConfig, applyConfigPolicy } from "../../../src/execution/scene/config-diff.ts";
import { parseEnvFile, referencedEnvVars, checkEnv } from "../../../src/execution/sandbox/env.ts";
import { parseInventory, inventoryDiff } from "../../../src/evidence/assertion/inventory.ts";
import { detectEnvScopeDodge, matchesTargetOrigin, regionalUserEnvKey } from "../../../src/execution/executor/scene.ts";

describe("scene modes", () => {
  test("grammar: live, live-concurrent:N, replay:<har>, inject:<rule>; everything else is unknown, never a silent live", () => {
    assert.deepEqual(parseMode("live"), { kind: "live", concurrency: 1 });
    assert.deepEqual(parseMode("live-concurrent:2"), { kind: "live-concurrent", concurrency: 2 });
    assert.equal(parseMode("live-concurrent:1").kind, "unknown");
    assert.equal(parseMode("live-concurrent:9").kind, "unknown");
    assert.deepEqual(parseMode("replay:failing.har"), { kind: "replay", har: "failing.har" });
    const inj = parseMode("inject:POST /api/book?x=1 -> 401");
    assert.equal(inj.kind, "inject");
    if (inj.kind === "inject") assert.deepEqual({ ...inj.rule, raw: undefined }, { method: "POST", path: "/api/book", status: 401, raw: undefined });
    assert.equal(parseMode("inject:<failing request unknown>").kind, "pending");
    assert.equal(parseMode("inject:book fails").kind, "unknown");
    assert.equal(parseMode("").kind, "unknown");
    assert.equal(parseMode(undefined).kind, "unknown");
    assert.equal(parseMode("normal").kind, "unknown");
  });

  test("needsTarget: live, live-concurrent and inject need --target; replay and pending do not", () => {
    assert.equal(needsTarget(parseMode("live")), true);
    assert.equal(needsTarget(parseMode("live-concurrent:2")), true);
    assert.equal(needsTarget(parseMode("inject:GET / -> 500")), true);
    assert.equal(needsTarget(parseMode("replay:x.har")), false);
    assert.equal(needsTarget(parseMode("inject:<failing request unknown>")), false);
  });

  test("effective concurrency follows Checkly scheduling: runParallel → one run per location, otherwise one run per tick", () => {
    assert.equal(effectiveConcurrency({ runParallel: true, locations: ["a", "b", "c"] }), 3);
    assert.equal(effectiveConcurrency({ runParallel: false, locations: ["a", "b", "c"] }), 1);
    assert.equal(effectiveConcurrency({ runParallel: true, locations: ["a"] }), 1);
    assert.equal(effectiveConcurrency(null), Number.POSITIVE_INFINITY, "unknown config never lowers a scene's concurrency");
  });
});

describe("config diff + policy", () => {
  const original = `export default defineConfig({ checks: { frequency: 5, locations: ["us-east-1", "eu-central-1"], runParallel: true, environmentVariables: [{ key: "ACCOUNT", value: "{{ACCOUNT}}" }] } });`;

  test("parses the keys that matter", () => {
    const v = parseCheckConfig(original);
    assert.equal(v.runParallel, true);
    assert.deepEqual(v.locations, ["us-east-1", "eu-central-1"]);
    assert.equal(v.frequency, "5");
    assert.equal(v.retryStrategy, null);
    assert.deepEqual(v.envKeys, ["ACCOUNT"]);
    assert.deepEqual(parseCheckConfig(null), {
      runParallel: null, locations: null, frequency: null, retryStrategy: null, doubleCheck: null,
      timeouts: {}, envKeys: [], activated: null, muted: null, shouldFail: null,
      privateLocations: null, runtimeId: null,
    });
    assert.equal(parseCheckConfig(`// example: runParallel: true\nrunParallel: false`).runParallel, false, "commented examples are not config values");
  });

  test("scheduling changes are allowed and noted", () => {
    const patched = original.replace("runParallel: true", "runParallel: false");
    const changes = diffCheckConfig(parseCheckConfig(original), parseCheckConfig(patched));
    assert.deepEqual(changes, [{ family: "scheduling", key: "runParallel", from: "true", to: "false" }]);
    const policy = applyConfigPolicy(changes, false, parseCheckConfig(original), parseCheckConfig(patched));
    assert.equal(policy.rejected, null);
    assert.match(policy.notes[0], /scheduling change allowed: runParallel true → false/);
  });

  test("a retry/timeout-only change is rejected; the same change next to a code change is only flagged", () => {
    const patched = original.replace("runParallel: true,", 'runParallel: true, retryStrategy: RetryStrategyBuilder.fixedStrategy({ maxRetries: 2 }), maxResponseTime: 30000,');
    const changes = diffCheckConfig(parseCheckConfig(original), parseCheckConfig(patched));
    assert.deepEqual(changes.map((c) => `${c.family}:${c.key}`), ["masking:retryStrategy", "masking:maxResponseTime"]);
    const alone = applyConfigPolicy(changes, false, parseCheckConfig(original), parseCheckConfig(patched));
    assert.match(alone.rejected ?? "", /retry\/timeout-only change .* masks the failure/);
    const withCode = applyConfigPolicy(changes, true, parseCheckConfig(original), parseCheckConfig(patched));
    assert.equal(withCode.rejected, null);
    assert.match(withCode.notes[0], /retries are not simulated here/);
  });

  test("a new environment variable is declared, never valued", () => {
    const patched = original.replace('{ key: "ACCOUNT", value: "{{ACCOUNT}}" }', '{ key: "ACCOUNT", value: "{{ACCOUNT}}" }, { key: "ACCOUNT_B", value: "{{ACCOUNT_B}}" }');
    const changes = diffCheckConfig(parseCheckConfig(original), parseCheckConfig(patched));
    const policy = applyConfigPolicy(changes, true, parseCheckConfig(original), parseCheckConfig(patched));
    assert.deepEqual(policy.declaredEnvKeys, ["ACCOUNT_B"]);
    assert.match(policy.notes[0], /must exist in Checkly and be provided with --env-file/);
  });
});

describe("environment", () => {
  test("env file: KEY=VALUE, quotes, comments, export prefix", () => {
    assert.deepEqual(parseEnvFile(`# c\nA=1\nexport B="two words"\nC='x=y'\n\nbad line\n`), { A: "1", B: "two words", C: "x=y" });
  });

  test("references: {{VAR}} and process.env.VAR, fallback detection, missing vs defaulted vs undeclared", () => {
    const src = `const a = process.env.ACCOUNT ?? "demo";\nconst u = "{{API_KEY}}";\nconst t = process.env.TEST_USER;\n`;
    assert.deepEqual(referencedEnvVars(src).map((r) => `${r.form}:${r.name}:${r.hasFallback}`), ["process.env:ACCOUNT:true", "handlebars:API_KEY:false", "process.env:TEST_USER:false"]);
    const result = checkEnv(src, { TEST_USER: "u" }, ["ACCOUNT", "TEST_USER"]);
    assert.deepEqual(result.missing.map((m) => m.name), ["API_KEY"]);
    assert.deepEqual(result.defaulted.map((m) => m.name), ["ACCOUNT"]);
    assert.deepEqual(result.undeclared, ["API_KEY"]);
    assert.equal(checkEnv(`fetch(process.env.ENVIRONMENT_URL)`, {}, []).missing.length, 0, "the executor always provides ENVIRONMENT_URL");
    assert.deepEqual(checkEnv(`fetch(process.env.CHECKLY_REGION)`, {}, []).undeclared, [], "Checkly's built-in variables are always declared");
  });

  test("a fixed declared user per Checkly region is allowed; random, undeclared, and partial mappings remain dodges", () => {
    const original = `const TEST_USER = process.env.TEST_USER ?? 'demo'`;
    const good = `const USERS = {\n  'us-east-1': process.env.TEST_USER_US_EAST_1,\n  'eu-central-1': process.env.TEST_USER_EU_CENTRAL_1,\n}\nconst TEST_USER = USERS[process.env.CHECKLY_REGION ?? '']`;
    const context = { locations: ["us-east-1", "eu-central-1"], declaredEnvKeys: ["TEST_USER_US_EAST_1", "TEST_USER_EU_CENTRAL_1"] };
    assert.equal(regionalUserEnvKey("us-east-1"), "TEST_USER_US_EAST_1");
    assert.equal(detectEnvScopeDodge(original, good, context), null);
    assert.match(detectEnvScopeDodge(original, `${good} ?? 'hardcoded-user'`, context) ?? "", /constant changed/);
    assert.match(detectEnvScopeDodge(original, good, { ...context, declaredEnvKeys: ["TEST_USER_US_EAST_1"] }) ?? "", /constant changed/);
    assert.match(detectEnvScopeDodge(original, `const TEST_USER = Math.random().toString()`, context) ?? "", /generated at runtime/);
  });
});

describe("Playwright locator drift", () => {
  test("an exact locator rename keeps the assertion contract; weaker matcher and deletion do not", () => {
    const original = `await expect(page.getByTestId('book-status')).toHaveText('200')`;
    const renamed = `await expect(page.getByTestId('booking-status')).toHaveText('200')`;
    const weak = `await expect(page.getByTestId('booking-status')).toBeVisible()`;
    const removed = `// assertion deleted`;
    const inv = parseInventory("tests/booking.spec.ts", original);
    assert.equal(inventoryDiff(inv, parseInventory("tests/booking.spec.ts", renamed)).removed.length, 0);
    assert.equal(inventoryDiff(inv, parseInventory("tests/booking.spec.ts", weak)).removed.length, 1);
    assert.equal(inventoryDiff(inv, parseInventory("tests/booking.spec.ts", removed)).removed.length, 1);
  });

  test("duplicate matcher/target ids still detect deletion of one assertion", () => {
    const original = `await expect(page.getByTestId('login-status')).toHaveText('200')\nawait expect(page.getByTestId('book-status')).toHaveText('200')`;
    const patched = `await expect(page.getByTestId('login-status')).toHaveText('200')`;
    const diff = inventoryDiff(parseInventory("x.spec.ts", original), parseInventory("x.spec.ts", patched));
    assert.equal(diff.removed.length, 1);
    assert.match(diff.removed[0].subject, /book-status/);
  });
});

describe("Multistep target ownership", () => {
  test("accepts only a bare env-file origin that matches the explicit target", () => {
    assert.equal(matchesTargetOrigin("https://slots-booking-verify-fix.vercel.app/", "https://slots-booking-verify-fix.vercel.app"), true);
    assert.equal(matchesTargetOrigin("https://other.example", "https://slots-booking-verify-fix.vercel.app"), false);
    assert.equal(matchesTargetOrigin("https://user:pass@slots-booking-verify-fix.vercel.app", "https://slots-booking-verify-fix.vercel.app"), false);
    assert.equal(matchesTargetOrigin("https://slots-booking-verify-fix.vercel.app/path", "https://slots-booking-verify-fix.vercel.app"), false);
    assert.equal(matchesTargetOrigin("https://slots-booking-verify-fix.vercel.app?x=1", "https://slots-booking-verify-fix.vercel.app"), false);
    assert.equal(matchesTargetOrigin("https://slots-booking-verify-fix.vercel.app", null), false);
  });
});
