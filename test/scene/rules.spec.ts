// Pure rules of the scene layer: mode grammar, effective concurrency, config
// diff + policy, environment references, patch sets.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { parseMode, effectiveConcurrency, needsTarget } from "../../src/scene/modes.ts";
import { parseCheckConfig, diffCheckConfig, applyConfigPolicy } from "../../src/scene/config-diff.ts";
import { parseEnvFile, referencedEnvVars, checkEnv } from "../../src/scene/env.ts";
import { loadBundle } from "../../src/bundle.ts";
import { loadPatch, patchedConfig, patchedCheckSource, newFiles } from "../../src/patch.ts";
import { parseInventory, inventoryDiff } from "../../src/assertion/inventory.ts";
import { buildContract } from "../../src/contract/contract.ts";
import { SceneExecutor } from "../../src/executor/scene.ts";

const ROOT = join(import.meta.dirname, "..", "..");
const INCIDENT_DIR = join(ROOT, "fixtures/slots-booking/bundle/incidents/slots-booking-overlap");
const PATCH_DIR = join(ROOT, "fixtures/slots-booking/patches");

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
  const original = `export default defineConfig({ checks: { frequency: 5, locations: ["us-east-1", "eu-west-1"], runParallel: true, environmentVariables: [{ key: "ACCOUNT", value: "{{ACCOUNT}}" }] } });`;

  test("parses the keys that matter", () => {
    const v = parseCheckConfig(original);
    assert.equal(v.runParallel, true);
    assert.deepEqual(v.locations, ["us-east-1", "eu-west-1"]);
    assert.equal(v.frequency, "5");
    assert.equal(v.retryStrategy, null);
    assert.deepEqual(v.envKeys, ["ACCOUNT"]);
    assert.deepEqual(parseCheckConfig(null), { runParallel: null, locations: null, frequency: null, retryStrategy: null, doubleCheck: null, timeouts: {}, envKeys: [] });
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
    assert.equal(checkEnv(`fetch(process.env.ENVIRONMENT_URL)`, {}, []).missing.length, 1, "ENVIRONMENT_URL counts as a reference when nothing provides it");
    assert.deepEqual(checkEnv(`fetch(process.env.ENVIRONMENT_URL)`, {}, []).undeclared, [], "Checkly's own variables are always declared");
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

describe("measured real bundles", () => {
  test("local measurements open the right determinism gate for overlap and persistent drift", () => {
    const overlap = loadBundle(join(ROOT, "fixtures/bundles/slots-booking-overlap")).bundle;
    const drift = loadBundle(join(ROOT, "fixtures/bundles/slots-booking-drift")).bundle;
    assert.deepEqual(
      { achieved: overlap.determinism.achieved, reproduction: overlap.determinism.reproductionFailRate, baseline: overlap.determinism.baselinePassRate, method: overlap.determinism.method },
      { achieved: 20, reproduction: 1, baseline: 1, method: "local-runner" },
    );
    assert.deepEqual(
      { achieved: drift.determinism.achieved, reproduction: drift.determinism.reproductionFailRate, baseline: drift.determinism.baselinePassRate, method: drift.determinism.method },
      { achieved: 20, reproduction: 1, baseline: null, method: "local-runner" },
    );
    const overlapFix = loadPatch(join(ROOT, "fixtures/patches/slots-booking-overlap/01-good-run-parallel-false"), overlap);
    const driftFix = loadPatch(join(ROOT, "fixtures/patches/slots-booking-drift/01-good-rename"), drift);
    assert.equal(buildContract(overlap, patchedCheckSource(overlap, overlapFix)).determinismGate.blocked, false);
    assert.equal(buildContract(drift, patchedCheckSource(drift, driftFix)).determinismGate.blocked, false);
  });

  test("an API-only browser replay without --target is inconclusive before Playwright starts", async () => {
    const bundle = loadBundle(join(ROOT, "fixtures/bundles/slots-booking-overlap")).bundle;
    const base = bundle.scenes.find((s) => s.type === "HEALTHY")!;
    const scene = { ...base, sceneId: "replay-preflight", mode: "replay:passing.har", experiments: [{ ...base.experiments[0], repetitions: 1 }] };
    const executor = new SceneExecutor({ target: null, env: { TEST_USER: "demo" } });
    try {
      const observed = await executor.runScene(bundle, bundle.checkSource, scene, { config: bundle.config, files: bundle.files });
      assert.equal(observed.observed, "uncertain");
      assert.match(observed.reason ?? "", /needs --target for page assets/);
    } finally {
      await executor.close();
    }
  });
});

describe("patch sets", () => {
  test("a file replaces the main check; a directory replaces matching files; config merges over the bundle's", () => {
    const { bundle } = loadBundle(INCIDENT_DIR);
    assert.equal(bundle.configFile, "checkly.config.ts");
    assert.deepEqual(bundle.config, { runParallel: true, locations: ["us-east-1", "eu-west-1"], frequencyMinutes: 5, environmentVariables: ["ACCOUNT"] });

    const file = loadPatch(join(PATCH_DIR, "03-weaken-assertion.ts"), bundle);
    assert.equal(file.kind, "file");
    assert.deepEqual(Object.keys(file.files), ["booking.check.ts"]);
    assert.deepEqual(patchedConfig(bundle, file), bundle.config, "a code-only patch keeps the config");

    const dir = loadPatch(join(PATCH_DIR, "01-good-run-parallel-false"), bundle);
    assert.equal(dir.kind, "directory");
    assert.deepEqual(Object.keys(dir.files).sort(), ["booking.check.ts", "checkly.config.ts"]);
    assert.equal(patchedCheckSource(bundle, dir), bundle.checkSource, "the good fix leaves the check code alone");
    assert.deepEqual(patchedConfig(bundle, dir), { ...bundle.config, runParallel: false });
    assert.deepEqual(newFiles(bundle, dir), []);

    const one = loadPatch(join(PATCH_DIR, "12-good-one-location"), bundle);
    assert.deepEqual(patchedConfig(bundle, one)?.locations, ["us-east-1"]);
  });
});
