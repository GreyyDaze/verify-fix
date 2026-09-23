// Harness for the vacuous-pass seam (sandbox ⇄ DSL ⇄ scene executor) and the
// seeded slots-booking suite, run against the REAL example app
// (examples/slots-booking/web, `next start`, in-memory store) — no simulator.
// Run with: npm test
//
// Invariants under test:
//   1. A DSL run that never contacts ENVIRONMENT_URL is never a pass — it is
//      `vacuous`, the executor classifies it `uncertain`, the decision table
//      maps it to UNCERTAIN (exit 2) with an explicit reason.
//   2. The scene layer reproduces the incident from the real app: two
//      interleaved runs on one account → 401 on booking, deterministically.
//   3. The seeded suite keeps its oracle verdicts: the good config patches PASS
//      (exit 0) with scene-c observing a real `fail`; every fooling seed is
//      FAILED (1); the flaky seed is never PASS. Outcomes are stable across
//      re-runs.

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";

import { loadBundle } from "../src/bundle.ts";
import { verify } from "../src/verify.ts";
import { loadPatch } from "../src/patch.ts";
import { runSandbox, parseOutcomeLine } from "../src/sandbox.ts";
import { SceneExecutor, detectEnvScopeDodge, DEFAULT_MAX_RUNS_PER_SCENE, repetitionSeed } from "../src/executor/scene.ts";
import { buildContract } from "../src/contract/contract.ts";
import { assessAdequacy } from "../src/adequacy/adequacy.ts";
import { decide } from "../src/decision/decision.ts";
import { parseInventory, stripComments } from "../src/assertion/inventory.ts";
import { assertionId } from "../src/assertion/id.ts";
import type { Bundle, Scene, SceneObservation } from "../src/types.ts";
import { startExampleApp, type RunningApp } from "./helpers/example-app.ts";

const ROOT = join(import.meta.dirname, "..");
const INCIDENT_DIR = join(ROOT, "fixtures/slots-booking/bundle/incidents/slots-booking-overlap");
const WEAK_DIR = join(ROOT, "fixtures/slots-booking/bundle/incidents/slots-booking-weak-oracle");
const REAL_BUNDLE_DIR = join(ROOT, "fixtures/bundles/slots-booking-overlap");
const PATCH_DIR = join(ROOT, "fixtures/slots-booking/patches");
const patchFile = (name: string) => readFileSync(join(PATCH_DIR, name), "utf8");
const ENV = { ACCOUNT: "demo" };

/** Expected verdict per seeded patch, as documented in each patch header. */
const SEEDED: Array<{ name: string; exit: 0 | 1 | 2 | "never-pass" }> = [
  { name: "01-good-run-parallel-false", exit: 0 },
  { name: "02-mutation-d-weakened-good", exit: 1 },
  { name: "03-weaken-assertion.ts", exit: 1 },
  { name: "04-catch-ignore.ts", exit: 1 },
  { name: "05-trivial-true.ts", exit: 1 },
  { name: "06-hardcode.ts", exit: 1 },
  { name: "07-change-account.ts", exit: 1 },
  { name: "08-timeout-mask.ts", exit: 1 },
  { name: "09-remove-step.ts", exit: 1 },
  { name: "10-regression-symptom-fix.ts", exit: 1 },
  { name: "11-flaky.ts", exit: "never-pass" },
  { name: "12-good-one-location", exit: 0 },
  { name: "13-config-retry-only", exit: 1 },
];

function sceneOf(bundle: Bundle, id: string): Scene {
  const s = bundle.scenes.find((x) => x.sceneId === id);
  if (!s) throw new Error(`no scene ${id}`);
  return s;
}

let app: RunningApp;
before(async () => {
  app = await startExampleApp();
});
after(async () => {
  await app.stop();
});

// ───────────────────────── sandbox + DSL evidence rule ─────────────────────────

describe("sandbox: a DSL run must prove it contacted ENVIRONMENT_URL", () => {
  let bundle: Bundle;
  before(() => {
    bundle = loadBundle(INCIDENT_DIR).bundle;
  });

  test("empty registry (check module registers nothing) is vacuous, never passed", async () => {
    const out = await runSandbox(`export const nothing = 1;`, { baseUrl: app.url, env: ENV });
    assert.equal(out.passed, false);
    assert.equal(out.vacuous, true);
    assert.match(out.vacuousReason ?? "", /did not contact armed sim/);
    assert.match(out.vacuousReason ?? "", /no check registered/);
    assert.equal(out.simHits, 0);
    assert.ok(out.results[0].trace.some((t) => /did not contact armed sim/.test(t.what)), "trace carries the explicit vacuous step");
  });

  test("a registered check that never reaches ENVIRONMENT_URL is vacuous even if its assertions hold", async () => {
    const src = `import { check, expect } from "./check-api.ts";\ncheck("hitless", async () => { expect(1).toBe(1); });\n`;
    const out = await runSandbox(src, { baseUrl: app.url, env: ENV });
    assert.equal(out.passed, false, "no contact → never a pass");
    assert.equal(out.vacuous, true);
    assert.equal(out.simHits, 0);
    assert.equal(out.results[0].assertionCount, 1);
    assert.ok(out.results[0].trace.some((t) => t.kind === "step" && t.outcome === "skipped" && /did not contact armed sim/.test(t.what)));
  });

  test("the real check against the real app: steps traced, runtime assertion ids bind to inventory ids", async () => {
    const ok = await runSandbox(bundle.checkSource, { baseUrl: app.url, env: ENV });
    assert.equal(ok.vacuous, false);
    assert.equal(ok.passed, true, JSON.stringify(ok.results[0]?.trace));
    assert.ok(ok.simHits >= 2, `expected ≥2 hits, got ${ok.simHits}`);
    const trace = ok.results[0].trace;
    assert.ok(trace.some((t) => t.kind === "step" && t.what === "fetch POST /api/login → 200"), JSON.stringify(trace));
    assert.ok(trace.some((t) => t.kind === "step" && t.what === "fetch POST /api/book → 200"), JSON.stringify(trace));
    const inv = parseInventory(bundle.check.file, bundle.checkSource);
    const status200 = inv.assertions.find((a) => a.matcher === "toBe" && a.target === "200")!;
    assert.equal(status200.id, assertionId("", "toBe", "200"));
    const runtime = trace.filter((t) => t.kind === "assertion" && t.what.startsWith("toBe(200)"));
    assert.ok(runtime.length >= 1);
    for (const r of runtime) assert.equal(r.assertionId, status200.id, "runtime toBe(200) binds to the inventory's toBe|200 id");
  });

  test("the sandbox gets Checkly's variables and the check's own — and nothing from the parent process", async () => {
    process.env.VERIFY_FIX_PARENT_SECRET = "must-not-leak";
    try {
      const src = [
        `import { check, expect } from "./check-api.ts";`,
        `check("env", async ({ baseUrl }) => {`,
        `  await fetch(\`\${await baseUrl}/api/health\`);`,
        `  expect(process.env.ENVIRONMENT_NAME).toBe("staging");`,
        `  expect(process.env.ACCOUNT).toBe("demo");`,
        `  expect(String(process.env.VERIFY_FIX_PARENT_SECRET)).toBe("undefined");`,
        `});`,
      ].join("\n");
      const out = await runSandbox(src, { baseUrl: app.url, env: ENV, environmentName: "staging" });
      assert.equal(out.passed, true, JSON.stringify(out.results[0]?.trace));
    } finally {
      delete process.env.VERIFY_FIX_PARENT_SECRET;
    }
  });

  test("outcome line is located by marker even when the check prints its own JSON", () => {
    const raw = ['{"noise":true}', '{"__verifyFixOutcome":true,"baseUrl":"x","results":[],"vacuous":true,"vacuousReason":"r"}', '{"more":"noise"}'].join("\n");
    const parsed = parseOutcomeLine(raw);
    assert.ok(parsed);
    assert.equal(parsed.vacuous, true);
    assert.equal(parseOutcomeLine('{"results":[]}'), null, "an unmarked object is not an outcome");
  });

  test("seeded randomness is reproducible per repetition and differs across repetitions and runs", async () => {
    const src = [
      `import { check, expect } from "./check-api.ts";`,
      `check("rnd", async ({ baseUrl }) => {`,
      `  await fetch(\`\${await baseUrl}/api/health\`);`,
      `  expect(String(Math.random())).toBe("never");`,
      `});`,
    ].join("\n");
    const seedA = repetitionSeed("scene-x", 0);
    const seedB = repetitionSeed("scene-x", 1);
    assert.notEqual(seedA, seedB);
    assert.notEqual(repetitionSeed("scene-x", 0, 1), seedA, "second concurrent run draws its own sequence");
    const r1 = await runSandbox(src, { baseUrl: app.url, env: ENV, seed: seedA });
    const r2 = await runSandbox(src, { baseUrl: app.url, env: ENV, seed: seedA });
    const r3 = await runSandbox(src, { baseUrl: app.url, env: ENV, seed: seedB });
    const drawn = (o: typeof r1) => o.results[0].trace.find((t) => t.kind === "assertion")!.what;
    assert.equal(drawn(r1), drawn(r2), "same seed → same Math.random sequence");
    assert.notEqual(drawn(r1), drawn(r3), "different repetition → different sequence");
  });
});

// ───────────────────────── executor classification ─────────────────────────

describe("scene executor: hitless / exhausted / crashed runs are uncertain, never pass", () => {
  let bundle: Bundle;
  before(() => {
    bundle = loadBundle(INCIDENT_DIR).bundle;
  });
  const executor = (opts: Partial<ConstructorParameters<typeof SceneExecutor>[0]> = {}) => new SceneExecutor({ target: app.url, env: ENV, ...opts });

  test("vacuous DSL run → observed uncertain with the proxy's own count", async () => {
    const ex = executor();
    try {
      const obs = await ex.runScene(bundle, `export const nothing = 1;`, sceneOf(bundle, "scene-c-auth-failure"));
      assert.equal(obs.observed, "uncertain");
      assert.match(obs.reason ?? "", /no request reached ENVIRONMENT_URL/);
      assert.ok(obs.trace.some((t) => /0 request\(s\) reached the proxy/.test(t.what)));
    } finally {
      await ex.close();
    }
  });

  test("check pointed at a different host never reaches the proxy → uncertain (not fail, not pass)", async () => {
    const ex = executor();
    try {
      // the app itself, bypassing ENVIRONMENT_URL: the assertions hold, but nothing was observed in the scene
      const elsewhere = bundle.checkSource.replace(/\$\{base\}/g, app.url);
      const obs = await ex.runScene(bundle, elsewhere, sceneOf(bundle, "scene-c-auth-failure"));
      assert.equal(obs.observed, "uncertain");
      assert.match(obs.reason ?? "", /no request reached ENVIRONMENT_URL/);
    } finally {
      await ex.close();
    }
  });

  test("sandbox crash (unparseable patch) → uncertain with reason, executor keeps working", async () => {
    const ex = executor();
    try {
      const obs = await ex.runScene(bundle, `this is not typescript (`, sceneOf(bundle, "scene-b-single-run"));
      assert.equal(obs.observed, "uncertain");
      assert.match(obs.reason ?? "", /sandbox could not run the check/);
      const next = await ex.runScene(bundle, bundle.checkSource, sceneOf(bundle, "scene-b-single-run"));
      assert.equal(next.observed, "pass");
      assert.equal(next.environment, `target ${new URL(app.url).host} (live)`);
    } finally {
      await ex.close();
    }
  });

  test("budget exhausted → uncertain (never the old observed:'pass' stub); bundle budget is honored", async () => {
    const ex = executor({ maxRunsPerScene: 1 });
    try {
      const scene = sceneOf(bundle, "scene-b-single-run");
      const first = await ex.runScene(bundle, bundle.checkSource, scene);
      assert.equal(first.observed, "pass");
      assert.equal(first.repetitions, 1);
      const second = await ex.runScene(bundle, bundle.checkSource, scene);
      assert.equal(second.observed, "uncertain");
      assert.match(second.reason ?? "", /budget exhausted/);
      assert.equal(ex.budgetExhausted, true);
    } finally {
      await ex.close();
    }
    const honoring = executor();
    assert.equal(honoring.budgetFor(bundle), bundle.runBudget.maxPerScene);
    assert.equal(honoring.budgetFor({ ...bundle, runBudget: undefined as unknown as Bundle["runBudget"] }), DEFAULT_MAX_RUNS_PER_SCENE);
    await honoring.close();
  });

  test("detection scene: the proxy injects the recorded 401 on /api/book; the check fails with booking evidence", async () => {
    const ex = executor();
    try {
      const obs = await ex.runScene(bundle, bundle.checkSource, sceneOf(bundle, "scene-c-auth-failure"));
      assert.equal(obs.observed, "fail");
      assert.equal(obs.repetitions, 5);
      assert.ok(obs.trace.some((t) => t.what === "fetch POST /api/book → 401"), "the injected 401 reached the check");
      assert.ok(obs.trace.some((t) => /POST \/api\/book 401 \(injected\)/.test(t.what)), "the proxy recorded the injection");
      assert.ok(obs.trace.some((t) => t.kind === "assertion" && t.outcome === "failed"));
      assert.match(obs.environment ?? "", /\+ inject POST \/api\/book -> 401$/);
    } finally {
      await ex.close();
    }
  });

  test("reproduction scene: two interleaved runs on one account → the real app answers 401 (login, login, book, book)", async () => {
    const ex = executor();
    try {
      // original config: two locations, runParallel on → concurrency 2
      const obs = await ex.runScene(bundle, bundle.checkSource, sceneOf(bundle, "scene-a-overlap"), { config: bundle.config });
      assert.equal(obs.observed, "fail", JSON.stringify(obs.trace.map((t) => t.what)));
      assert.equal(obs.repetitions, 3);
      assert.ok(obs.trace.some((t) => t.what === "run 1/2: fetch POST /api/book → 401"), "the first run's booking was superseded");
      assert.ok(obs.trace.some((t) => t.what === "run 2/2: fetch POST /api/book → 200"), "the second run's booking succeeded");
      assert.equal(obs.environment, `target ${new URL(app.url).host} (live-concurrent:2)`);

      // the scheduling fix: runParallel off → one run per tick → concurrency 1 → the same check passes
      const fixed = await ex.runScene(bundle, bundle.checkSource, sceneOf(bundle, "scene-a-overlap"), { config: { ...bundle.config!, runParallel: false } });
      assert.equal(fixed.observed, "pass");
      assert.match(fixed.environment ?? "", /live-concurrent:1 of 2, schedule allows 1/);
      assert.ok(fixed.trace.some((t) => /scheduling: the patched config allows 1 overlapping run/.test(t.what)));
    } finally {
      await ex.close();
    }
  });

  test("no --target → live scenes are uncertain; the recorded origin is never used implicitly", async () => {
    const ex = new SceneExecutor({ target: null, env: ENV });
    try {
      const obs = await ex.runScene(bundle, bundle.checkSource, sceneOf(bundle, "scene-b-single-run"));
      assert.equal(obs.observed, "uncertain");
      assert.match(obs.reason ?? "", /pass --target/);
      assert.equal(ex.isLive(), false);
    } finally {
      await ex.close();
    }
  });

  test("replay scene: answered from the bundle's passing recording, no target contacted", async () => {
    const ex = new SceneExecutor({ target: null, env: ENV });
    try {
      // the real bundle's passing.har holds POST /api/login 200 and POST /api/book 200
      const withRecordings: Bundle = { ...bundle, dir: REAL_BUNDLE_DIR };
      const scene: Scene = { ...sceneOf(bundle, "scene-b-single-run"), mode: "replay:passing.har" };
      const obs = await ex.runScene(withRecordings, bundle.checkSource, scene);
      assert.equal(obs.observed, "pass", JSON.stringify(obs.trace.map((t) => t.what)));
      assert.equal(obs.environment, "recording passing.har");
      assert.ok(obs.trace.some((t) => /POST \/api\/book 200 \(recording\)/.test(t.what)));
      const missing = await ex.runScene(withRecordings, bundle.checkSource, { ...scene, mode: "replay:nope.har" });
      assert.equal(missing.observed, "uncertain");
      assert.match(missing.reason ?? "", /not found in the bundle/);
    } finally {
      await ex.close();
    }
  });
});

// ───────────────────────── static engine + heuristics ─────────────────────────

describe("static engine", () => {
  test("an undeclared environment variable is FAILED before any run", async () => {
    const { bundle } = loadBundle(INCIDENT_DIR);
    const source = `${bundle.checkSource}\nconst verifyFixUndeclared = process.env.NOT_DECLARED; void verifyFixUndeclared;`;
    const result = await verify({ bundle, patch: source, target: app.url, env: { ...ENV, NOT_DECLARED: "value" } });
    assert.equal(result.decision.verdict, "FAILED");
    assert.equal(result.decision.exitCode, 1);
    assert.deepEqual(result.envCheck.undeclared, ["NOT_DECLARED"]);
    assert.equal(result.cost.runs, 0, "static rejection avoids local and cloud runs");
  });

  test("duplicate regional user values are FAILED before any run", async () => {
    const { bundle } = loadBundle(REAL_BUNDLE_DIR);
    const patch = loadPatch(join(ROOT, "fixtures/patches/slots-booking-overlap/14-good-per-location-users"), bundle);
    const result = await verify({
      bundle,
      patch,
      target: app.url,
      env: { TEST_USER: "demo", TEST_USER_US_EAST_1: "same-user", TEST_USER_EU_WEST_1: "same-user" },
    });
    assert.equal(result.decision.verdict, "FAILED");
    assert.match(result.envDodge ?? "", /same value/);
    assert.equal(result.cost.runs, 0);
  });

  test("env-scope dodge: reusing the same account in more requests is not a dodge; generating one is", () => {
    const { bundle } = loadBundle(INCIDENT_DIR);
    assert.equal(detectEnvScopeDodge(bundle.checkSource, readFileSync(join(PATCH_DIR, "01-good-run-parallel-false", "booking.check.ts"), "utf8")), null);
    assert.match(detectEnvScopeDodge(bundle.checkSource, patchFile("07-change-account.ts")) ?? "", /generated at runtime/);
    assert.match(detectEnvScopeDodge(bundle.checkSource, bundle.checkSource.replace('"demo"', '"other"')) ?? "", /constant changed/);
  });

  test("a commented-out assertion is not an assertion (inventory strips comments, keeps line numbers)", () => {
    const src = [
      `const url = "http://example.test/x"; // trailing`,
      `/* block`,
      `   expect(ghost).toBe(1) */`,
      `// expect(login.status).toBe(200);  <-- removed`,
      `expect(book.status).toBe(200);`,
    ].join("\n");
    const inv = parseInventory("x.ts", src);
    assert.equal(inv.assertions.length, 1);
    assert.equal(inv.assertions[0].subject, "book.status");
    assert.equal(inv.assertions[0].sourceLine, 5);
    assert.ok(stripComments(src).includes(`"http://example.test/x"`), "URLs inside strings survive");
    assert.equal(stripComments(src).split("\n").length, src.split("\n").length);
  });
});

// ───────────────────────── decision table ─────────────────────────

describe("decision table: uncertain observations", () => {
  test("an uncertain scene yields UNCERTAIN (exit 2) with the executor's reason; a real mismatch still wins as FAILED", () => {
    const { bundle } = loadBundle(INCIDENT_DIR);
    const contract = buildContract(bundle, bundle.checkSource);
    const obs = (id: string, observed: SceneObservation["observed"], reason?: string): SceneObservation => ({
      sceneId: id,
      observed,
      repetitions: observed === "uncertain" ? 0 : 5,
      trace: [],
      source: "scene",
      environment: "target example.test (live)",
      ...(reason ? { reason } : {}),
    });
    const allGood = new Map<string, SceneObservation>(
      bundle.scenes.map((s) => [s.sceneId, obs(s.sceneId, s.verdict.mustFail ? "fail" : "pass")])
    );
    const base = { contract, nonDeterministicScenes: [], healthyRepetitionsMet: true, runBudgetExhausted: false };

    const withUncertain = new Map(allGood);
    withUncertain.set("scene-c-auth-failure", obs("scene-c-auth-failure", "uncertain", "no request reached ENVIRONMENT_URL: test"));
    const d1 = decide({ ...base, observations: withUncertain, adequacy: assessAdequacy({ contract, sceneObservations: withUncertain, mutants: [] }) });
    assert.equal(d1.verdict, "UNCERTAIN");
    assert.equal(d1.exitCode, 2);
    assert.ok(d1.reasons.some((r) => /observed uncertain — no request reached ENVIRONMENT_URL: test/.test(r)), d1.reasons.join("\n"));
    const row = d1.rows.find((r) => r.experiment === "scene-c-auth-failure")!;
    assert.equal(row.observed, "uncertain");
    assert.equal(row.matched, false);
    assert.equal(row.environment, "target example.test (live)", "the row shows what the run talked to");

    const withMismatchToo = new Map(withUncertain);
    withMismatchToo.set("scene-b-single-run", obs("scene-b-single-run", "fail"));
    const d2 = decide({ ...base, observations: withMismatchToo, adequacy: assessAdequacy({ contract, sceneObservations: withMismatchToo, mutants: [] }) });
    assert.equal(d2.verdict, "FAILED");
    assert.equal(d2.exitCode, 1);

    const missing = new Map(allGood);
    missing.delete("scene-e-regression");
    const d3 = decide({ ...base, observations: missing, adequacy: assessAdequacy({ contract, sceneObservations: missing, mutants: [] }) });
    assert.equal(d3.verdict, "UNCERTAIN", "an unobserved scene is missing evidence, not a pass");
  });
});

// ───────────────────────── seeded suite (integration) ─────────────────────────

describe("seeded slots-booking suite keeps its oracle verdicts against the real app", () => {
  const run = (name: string) => {
    const { bundle } = loadBundle(INCIDENT_DIR);
    return verify({ bundle, patch: loadPatch(join(PATCH_DIR, name), bundle), target: app.url, env: ENV });
  };

  test("good config patch PASSes (exit 0): every scene observed with evidence, scene-c fails under injection, stable across re-runs", async () => {
    const a = await run("01-good-run-parallel-false");
    assert.equal(a.decision.verdict, "PASS", a.decision.reasons.join("\n"));
    assert.equal(a.decision.exitCode, 0);
    assert.equal(a.envDodge, null);
    assert.equal(a.configPolicy.rejected, null);
    assert.deepEqual(a.configPolicy.changes.map((c) => `${c.family}:${c.key}`), ["scheduling:runParallel"]);
    assert.equal(a.patchedConfig?.runParallel, false);
    for (const row of a.decision.rows) {
      assert.notEqual(row.observed, "uncertain", `${row.experiment} must be observed`);
      assert.equal(row.matched, true, `${row.experiment} must match its oracle`);
      assert.match(row.environment, /^target 127\.0\.0\.1:\d+/, `${row.experiment} names the host it ran against`);
    }
    const sceneC = a.observations.get("scene-c-auth-failure")!;
    assert.equal(sceneC.observed, "fail");
    assert.equal(sceneC.repetitions, 5);
    assert.ok(sceneC.trace.some((t) => t.what === "fetch POST /api/book → 401"));
    for (const o of a.observations.values()) {
      assert.ok(o.trace.some((t) => t.kind === "step" && /^fetch /.test(t.what) && /→ \d{3}$/.test(t.what)), `${o.sceneId}: trace proves contact with the app`);
    }
    assert.ok(a.mutants.length > 0);
    assert.ok(a.mutants.every((m) => !m.survived), "every seeded mutant is killed by the verifier");
    assert.ok(a.cost.localRuns > 0);
    assert.equal(a.cost.browserProcesses, 0, "the seeded DSL suite starts no browser process");
    assert.ok(a.cost.wallTimeMs > 0);
    assert.match(a.report.markdown, /\*\*Cost:\*\*/);
    assert.deepEqual(a.report.json.cost, a.cost);

    const b = await run("01-good-run-parallel-false");
    assert.deepEqual(b.decision.rows, a.decision.rows, "deterministic scenes: identical evidence on re-run");
    assert.equal(b.decision.verdict, "PASS");
  });

  test("the unpatched check with its original config FAILS: the overlap is reproduced from the real app, not assumed", async () => {
    const { bundle } = loadBundle(INCIDENT_DIR);
    const r = await verify({ bundle, patch: bundle.checkSource, target: app.url, env: ENV });
    assert.equal(r.decision.verdict, "FAILED");
    const overlap = r.observations.get("scene-a-overlap")!;
    assert.equal(overlap.observed, "fail");
    assert.ok(overlap.trace.some((t) => t.what === "run 1/2: fetch POST /api/book → 401"));
    assert.equal(r.observations.has("scene-b-single-run"), false, "a conclusive reproduction mismatch stops later paid/healthy work");
    assert.equal(r.cost.localRuns, 6, "three overlap repetitions run two local checks each");
    assert.equal(r.cost.browserProcesses, 0, "the seeded DSL suite starts no browser process");
  });

  for (const seed of SEEDED.filter((s) => s.exit !== 0)) {
    test(`${seed.name} → ${seed.exit === "never-pass" ? "never PASS" : `exit ${seed.exit}`}`, async () => {
      const r = await run(seed.name);
      if (seed.exit === "never-pass") {
        assert.notEqual(r.decision.verdict, "PASS", r.decision.reasons.join("\n"));
        assert.ok(r.decision.exitCode === 1 || r.decision.exitCode === 2);
        assert.ok(r.decision.reasons.some((x) => /non-deterministic/.test(x)), `flakiness must be recorded: ${r.decision.reasons.join("\n")}`);
        const again = await run(seed.name);
        assert.deepEqual(again.decision.rows, r.decision.rows, "reproducible: a second run yields the same evidence table");
        assert.equal(again.decision.exitCode, r.decision.exitCode);
      } else {
        assert.equal(r.decision.exitCode, seed.exit, `${seed.name}: ${r.decision.verdict} — ${r.decision.reasons.join(" | ")}`);
      }
      if (seed.name === "13-config-retry-only") assert.match(r.configPolicy.rejected ?? "", /retry\/timeout-only change/);
      if (seed.name === "07-change-account.ts") assert.ok(r.decision.reasons.some((x) => /env-scope dodge/.test(x)));
      // no vacuous pass anywhere: an observed pass must carry app contact
      for (const o of r.observations.values()) {
        if (o.observed === "pass") assert.ok(o.trace.some((t) => /^(run \d\/\d: )?fetch .*→ \d{3}$/.test(t.what)), `${seed.name}/${o.sceneId}: pass without contacting the app`);
      }
    });
  }

  test("12-good-one-location PASSes: a single location cannot overlap itself", async () => {
    const r = await run("12-good-one-location");
    assert.equal(r.decision.verdict, "PASS", r.decision.reasons.join("\n"));
    assert.deepEqual(r.configPolicy.changes.map((c) => `${c.family}:${c.key}`), ["scheduling:locations"]);
  });

  test("weak-oracle bundle: a behaving patch never PASSes", async () => {
    const { bundle } = loadBundle(WEAK_DIR);
    const r = await verify({ bundle, patch: loadPatch(join(WEAK_DIR, "patches", "good.ts"), bundle), target: app.url, env: ENV });
    assert.notEqual(r.decision.verdict, "PASS", r.decision.reasons.join("\n"));
  });

  test("CLI: --target + --env-file, directory patch, exit code from the verdict (good patch → 0), environment column", async () => {
    const dir = mkdtempSync(join(tmpdir(), "verify-fix-env-"));
    const envFile = join(dir, ".env");
    writeFileSync(envFile, "# the check's own variable, as `checkly test --env-file` would pass it\nACCOUNT=demo\n");
    const result = await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve) => {
      const child = spawn(
        process.execPath,
        ["--no-warnings", join(ROOT, "src/cli.ts"), "verify", "--patch", join(PATCH_DIR, "01-good-run-parallel-false"), "--bundle", INCIDENT_DIR, "--target", app.url, "--env-file", envFile, "--env-name", "ci"],
        { cwd: ROOT }
      );
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (d) => (stdout += String(d)));
      child.stderr.on("data", (d) => (stderr += String(d)));
      child.on("close", (code) => resolve({ code, stdout, stderr }));
    });
    assert.equal(result.code, 0, result.stdout + result.stderr);
    assert.match(result.stdout, /\*\*Verdict:\*\* PASS \(exit 0\)/);
    assert.match(result.stdout, /\| experiment \| environment \| oracle \|/);
    assert.match(result.stdout, /\| scene-c-auth-failure \| target 127\.0\.0\.1:\d+ \+ inject POST \/api\/book -> 401 \| [^|]+ \| fail \| fail \| ✓ \|/);
    assert.match(result.stdout, /Live rows ran against 127\.0\.0\.1:\d+/);
  });

  test("CLI: the retired direct-API executor cannot be selected", async () => {
    const result = await new Promise<{ code: number | null; stderr: string }>((resolve) => {
      const child = spawn(process.execPath, ["--no-warnings", join(ROOT, "src/cli.ts"), "verify", "--patch", join(PATCH_DIR, "01-good-run-parallel-false"), "--bundle", INCIDENT_DIR, "--executor", "checkly"], { cwd: ROOT });
      let stderr = "";
      child.stderr.on("data", (d) => (stderr += String(d)));
      child.on("close", (code) => resolve({ code, stderr }));
    });
    assert.equal(result.code, 2);
    assert.match(result.stderr, /--executor must be scene or hybrid/);
  });

  test("CLI: without --target the verdict is UNCERTAIN (exit 2), never PASS", async () => {
    const result = await new Promise<{ code: number | null; stdout: string }>((resolve) => {
      const child = spawn(process.execPath, ["--no-warnings", join(ROOT, "src/cli.ts"), "verify", "--patch", join(PATCH_DIR, "01-good-run-parallel-false"), "--bundle", INCIDENT_DIR], { cwd: ROOT });
      let stdout = "";
      child.stdout.on("data", (d) => (stdout += String(d)));
      child.on("close", (code) => resolve({ code, stdout }));
    });
    assert.equal(result.code, 2, result.stdout);
    assert.match(result.stdout, /pass --target/);
  });
});
