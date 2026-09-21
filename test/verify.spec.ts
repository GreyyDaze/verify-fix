// Harness for the vacuous-pass seam (sandbox ⇄ DSL ⇄ synthetic executor) and
// the seeded slots-booking suite. Run with: npm test
//
// Invariants under test:
//   1. A DSL run that never contacts the armed sim is never a pass — it is
//      `vacuous`, the executor classifies it `uncertain`, the decision table
//      maps it to UNCERTAIN (exit 2) with an explicit reason.
//   2. The seeded suite keeps its oracle verdicts: the good patch PASSes (exit 0)
//      with scene-c observing a real `fail`; every fooling seed is FAILED (1);
//      the flaky seed is never PASS. Outcomes are stable across re-runs.

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";

import { loadBundle } from "../src/bundle.ts";
import { verify } from "../src/verify.ts";
import { runSandbox, parseOutcomeLine } from "../src/sandbox.ts";
import { SyntheticExecutor, detectEnvScopeDodge, DEFAULT_MAX_RUNS_PER_SCENE, repetitionSeed, type AppSim } from "../src/executor/synthetic.ts";
import { buildContract } from "../src/contract/contract.ts";
import { assessAdequacy } from "../src/adequacy/adequacy.ts";
import { decide } from "../src/decision/decision.ts";
import { parseInventory, stripComments } from "../src/assertion/inventory.ts";
import { assertionId } from "../src/assertion/id.ts";
import type { Bundle, Scene, SceneObservation } from "../src/types.ts";

const ROOT = join(import.meta.dirname, "..");
const INCIDENT_DIR = join(ROOT, "fixtures/slots-booking/bundle/incidents/slots-booking-overlap");
const PATCH_DIR = join(ROOT, "fixtures/slots-booking/patches");
const patch = (name: string) => readFileSync(join(PATCH_DIR, name), "utf8");

/** Expected verdict per seeded patch, as documented in each patch header. */
const SEEDED: Array<{ file: string; exit: 0 | 1 | 2 | "never-pass" }> = [
  { file: "01-good-serialize.ts", exit: 0 },
  { file: "02-mutation-d-weakened-good.ts", exit: 1 },
  { file: "03-weaken-assertion.ts", exit: 1 },
  { file: "04-catch-ignore.ts", exit: 1 },
  { file: "05-trivial-true.ts", exit: 1 },
  { file: "06-hardcode.ts", exit: 1 },
  { file: "07-change-account.ts", exit: 1 },
  { file: "08-timeout-mask.ts", exit: 1 },
  { file: "09-remove-step.ts", exit: 1 },
  { file: "10-regression-symptom-fix.ts", exit: 1 },
  { file: "11-flaky.ts", exit: "never-pass" },
];

function sceneOf(bundle: Bundle, id: string): Scene {
  const s = bundle.scenes.find((x) => x.sceneId === id);
  if (!s) throw new Error(`no scene ${id}`);
  return s;
}

// ───────────────────────── sandbox + DSL evidence rule ─────────────────────────

describe("sandbox: a DSL run must prove it contacted the armed sim", () => {
  let sim: AppSim;
  let baseUrl: string;
  let bundle: Bundle;
  let appSimPath: string;

  before(async () => {
    const loaded = loadBundle(INCIDENT_DIR);
    bundle = loaded.bundle;
    appSimPath = loaded.appSimPath!;
    const mod = (await import(pathToFileURL(appSimPath).href)) as { default: () => Promise<AppSim> };
    sim = await mod.default();
    baseUrl = await sim.start();
  });
  after(async () => {
    await sim.close();
  });

  test("empty registry (check module registers nothing) is vacuous, never passed", async () => {
    await sim.drive(sceneOf(bundle, "scene-c-auth-failure"));
    const out = await runSandbox(`export const nothing = 1;`, { baseUrl, account: "demo" });
    assert.equal(out.passed, false);
    assert.equal(out.vacuous, true);
    assert.match(out.vacuousReason ?? "", /did not contact armed sim/);
    assert.match(out.vacuousReason ?? "", /no check registered/);
    assert.equal(out.simHits, 0);
    assert.ok(out.results[0].trace.some((t) => /did not contact armed sim/.test(t.what)), "trace carries the explicit vacuous step");
  });

  test("a registered check that never reaches the armed baseUrl is vacuous even if its assertions hold", async () => {
    await sim.drive(sceneOf(bundle, "scene-b-single-run"));
    const src = `import { check, expect } from "./check-api.ts";\ncheck("hitless", async () => { expect(1).toBe(1); });\n`;
    const out = await runSandbox(src, { baseUrl, account: "demo" });
    assert.equal(out.passed, false, "no contact → never a pass");
    assert.equal(out.vacuous, true);
    assert.equal(out.simHits, 0);
    assert.equal(out.results[0].assertionCount, 1);
    assert.ok(out.results[0].trace.some((t) => t.kind === "step" && t.outcome === "skipped" && /did not contact armed sim/.test(t.what)));
  });

  test("a real check contacts the sim: steps traced, runtime assertion ids bind to inventory ids, one entry per assertion", async () => {
    // healthy state: the original check passes with evidence
    await sim.drive(sceneOf(bundle, "scene-b-single-run"));
    const ok = await runSandbox(bundle.checkSource, { baseUrl, account: "demo" });
    assert.equal(ok.vacuous, false);
    assert.equal(ok.passed, true);
    assert.ok(ok.simHits >= 2, `expected ≥2 sim hits, got ${ok.simHits}`);
    const trace = ok.results[0].trace;
    assert.ok(trace.some((t) => t.kind === "step" && t.what === "fetch POST /login → 200"), JSON.stringify(trace));
    assert.ok(trace.some((t) => t.kind === "step" && t.what === "fetch POST /book → 200"), JSON.stringify(trace));
    const inv = parseInventory(bundle.check.file, bundle.checkSource);
    const status200 = inv.assertions.find((a) => a.matcher === "toBe" && a.target === "200")!;
    assert.equal(status200.id, assertionId("", "toBe", "200"));
    const runtime = trace.filter((t) => t.kind === "assertion" && t.what.startsWith("toBe(200)"));
    assert.ok(runtime.length >= 1);
    for (const r of runtime) assert.equal(r.assertionId, status200.id, "runtime toBe(200) binds to the inventory's toBe|200 id");

    // detection state: booking is broken → exactly one failed assertion, recorded once
    await sim.drive(sceneOf(bundle, "scene-c-auth-failure"));
    const bad = await runSandbox(bundle.checkSource, { baseUrl, account: "demo" });
    assert.equal(bad.vacuous, false);
    assert.equal(bad.passed, false);
    const failed = bad.results[0].trace.filter((t) => t.kind === "assertion" && t.outcome === "failed");
    assert.equal(failed.length, 1, `a failed assertion is recorded exactly once: ${JSON.stringify(bad.results[0].trace)}`);
    assert.ok(bad.results[0].trace.some((t) => t.what === "fetch POST /book → 401"));
  });

  test("outcome line is located by marker even when the check prints its own JSON", () => {
    const raw = ['{"noise":true}', '{"__verifyFixOutcome":true,"baseUrl":"x","results":[],"vacuous":true,"vacuousReason":"r"}', '{"more":"noise"}'].join("\n");
    const parsed = parseOutcomeLine(raw);
    assert.ok(parsed);
    assert.equal(parsed.vacuous, true);
    assert.equal(parseOutcomeLine('{"results":[]}'), null, "an unmarked object is not an outcome");
  });

  test("seeded randomness is reproducible per repetition and differs across repetitions", async () => {
    await sim.drive(sceneOf(bundle, "scene-b-single-run"));
    const src = [
      `import { check, expect } from "./check-api.ts";`,
      `check("rnd", async ({ baseUrl }) => {`,
      `  await fetch(\`\${baseUrl}/login\`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ account: "demo" }) });`,
      `  expect(String(Math.random())).toBe("never");`,
      `});`,
    ].join("\n");
    const seedA = repetitionSeed("scene-x", 0);
    const seedB = repetitionSeed("scene-x", 1);
    assert.notEqual(seedA, seedB);
    const r1 = await runSandbox(src, { baseUrl, account: "demo", seed: seedA });
    const r2 = await runSandbox(src, { baseUrl, account: "demo", seed: seedA });
    const r3 = await runSandbox(src, { baseUrl, account: "demo", seed: seedB });
    const drawn = (o: typeof r1) => o.results[0].trace.find((t) => t.kind === "assertion")!.what;
    assert.equal(drawn(r1), drawn(r2), "same seed → same Math.random sequence");
    assert.notEqual(drawn(r1), drawn(r3), "different repetition → different sequence");
  });
});

// ───────────────────────── executor classification ─────────────────────────

describe("synthetic executor: hitless / exhausted / crashed runs are uncertain, never pass", () => {
  let bundle: Bundle;
  let appSimPath: string;
  before(() => {
    const loaded = loadBundle(INCIDENT_DIR);
    bundle = loaded.bundle;
    appSimPath = loaded.appSimPath!;
  });

  test("vacuous DSL run → observed uncertain with the DSL's reason", async () => {
    const ex = new SyntheticExecutor(appSimPath);
    try {
      const obs = await ex.runScene(bundle, `export const nothing = 1;`, sceneOf(bundle, "scene-c-auth-failure"));
      assert.equal(obs.observed, "uncertain");
      assert.match(obs.reason ?? "", /did not contact armed sim/);
      assert.ok(obs.trace.some((t) => /did not contact armed sim/.test(t.what)));
    } finally {
      await ex.close();
    }
  });

  test("check pointed at a different host never hits the armed sim → uncertain (not fail, not pass)", async () => {
    const ex = new SyntheticExecutor(appSimPath);
    try {
      const elsewhere = bundle.checkSource.replace(/\$\{base\}/g, "http://127.0.0.1:9");
      const obs = await ex.runScene(bundle, elsewhere, sceneOf(bundle, "scene-c-auth-failure"));
      assert.equal(obs.observed, "uncertain");
      assert.match(obs.reason ?? "", /did not contact armed sim/);
    } finally {
      await ex.close();
    }
  });

  test("sandbox crash (unparseable patch) → uncertain with reason, executor keeps working", async () => {
    const ex = new SyntheticExecutor(appSimPath);
    try {
      const obs = await ex.runScene(bundle, `this is not typescript (`, sceneOf(bundle, "scene-b-single-run"));
      assert.equal(obs.observed, "uncertain");
      assert.match(obs.reason ?? "", /sandbox could not run the check/);
      const next = await ex.runScene(bundle, bundle.checkSource, sceneOf(bundle, "scene-b-single-run"));
      assert.equal(next.observed, "pass");
    } finally {
      await ex.close();
    }
  });

  test("budget exhausted → uncertain (never the old observed:'pass' stub); bundle budget is honored", async () => {
    const ex = new SyntheticExecutor(appSimPath, { maxRunsPerScene: 1 });
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
    const honoring = new SyntheticExecutor(appSimPath);
    assert.equal(honoring.budgetFor(bundle), bundle.runBudget.maxPerScene);
    assert.equal(honoring.budgetFor({ ...bundle, runBudget: undefined as unknown as Bundle["runBudget"] }), DEFAULT_MAX_RUNS_PER_SCENE);
  });

  test("scene-c under the good patch observes a real fail with booking evidence", async () => {
    const ex = new SyntheticExecutor(appSimPath);
    try {
      const obs = await ex.runScene(bundle, patch("01-good-serialize.ts"), sceneOf(bundle, "scene-c-auth-failure"));
      assert.equal(obs.observed, "fail");
      assert.equal(obs.repetitions, 5);
      assert.ok(obs.trace.some((t) => t.what === "fetch POST /book → 401"), "the armed sim answered the booking step");
      assert.ok(obs.trace.some((t) => t.kind === "assertion" && t.outcome === "failed"));
    } finally {
      await ex.close();
    }
  });
});

// ───────────────────────── static engine + heuristics ─────────────────────────

describe("static engine", () => {
  test("env-scope dodge: reusing the same account in more requests is not a dodge; generating one is", () => {
    const { bundle } = loadBundle(INCIDENT_DIR);
    assert.equal(detectEnvScopeDodge(bundle.checkSource, patch("01-good-serialize.ts")), null);
    assert.match(detectEnvScopeDodge(bundle.checkSource, patch("07-change-account.ts")) ?? "", /generated at runtime/);
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
      source: "synthetic",
      ...(reason ? { reason } : {}),
    });
    const allGood = new Map<string, SceneObservation>(
      bundle.scenes.map((s) => [s.sceneId, obs(s.sceneId, s.verdict.mustFail ? "fail" : "pass")])
    );
    const base = { contract, nonDeterministicScenes: [], healthyRepetitionsMet: true, runBudgetExhausted: false };

    const withUncertain = new Map(allGood);
    withUncertain.set("scene-c-auth-failure", obs("scene-c-auth-failure", "uncertain", "DSL did not contact armed sim: test"));
    const d1 = decide({ ...base, observations: withUncertain, adequacy: assessAdequacy({ contract, sceneObservations: withUncertain, mutants: [] }) });
    assert.equal(d1.verdict, "UNCERTAIN");
    assert.equal(d1.exitCode, 2);
    assert.ok(d1.reasons.some((r) => /observed uncertain — DSL did not contact armed sim: test/.test(r)), d1.reasons.join("\n"));
    const row = d1.rows.find((r) => r.experiment === "scene-c-auth-failure")!;
    assert.equal(row.observed, "uncertain");
    assert.equal(row.matched, false);

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

describe("seeded slots-booking suite keeps its oracle verdicts", () => {
  test("good patch PASSes (exit 0): every scene observed with evidence, scene-c fails under auth-fail, stable across re-runs", async () => {
    const run = async () => {
      const { bundle, appSimPath } = loadBundle(INCIDENT_DIR);
      return verify({ bundle, patchSource: patch("01-good-serialize.ts"), appSimPath });
    };
    const a = await run();
    assert.equal(a.decision.verdict, "PASS", a.decision.reasons.join("\n"));
    assert.equal(a.decision.exitCode, 0);
    assert.equal(a.envDodge, null);
    for (const row of a.decision.rows) {
      assert.notEqual(row.observed, "uncertain", `${row.experiment} must be observed`);
      assert.equal(row.matched, true, `${row.experiment} must match its oracle`);
    }
    const sceneC = a.observations.get("scene-c-auth-failure")!;
    assert.equal(sceneC.observed, "fail");
    assert.equal(sceneC.repetitions, 5);
    assert.ok(sceneC.trace.some((t) => t.what === "fetch POST /book → 401"));
    for (const o of a.observations.values()) {
      assert.ok(o.trace.some((t) => t.kind === "step" && /^fetch /.test(t.what) && /→ \d{3}$/.test(t.what)), `${o.sceneId}: trace proves contact with the sim`);
    }
    assert.ok(a.mutants.length > 0);
    assert.ok(a.mutants.every((m) => !m.survived), "every seeded mutant is killed by the verifier");

    const b = await run();
    assert.deepEqual(b.decision.rows, a.decision.rows, "deterministic executor: identical evidence on re-run");
    assert.equal(b.decision.verdict, "PASS");
  });

  for (const seed of SEEDED.filter((s) => s.exit !== 0)) {
    test(`${seed.file} → ${seed.exit === "never-pass" ? "never PASS" : `exit ${seed.exit}`}`, async () => {
      const { bundle, appSimPath } = loadBundle(INCIDENT_DIR);
      const r = await verify({ bundle, patchSource: patch(seed.file), appSimPath });
      if (seed.exit === "never-pass") {
        assert.notEqual(r.decision.verdict, "PASS", r.decision.reasons.join("\n"));
        assert.ok(r.decision.exitCode === 1 || r.decision.exitCode === 2);
        assert.ok(r.decision.reasons.some((x) => /non-deterministic/.test(x)), `flakiness must be recorded: ${r.decision.reasons.join("\n")}`);
        // reproducible: a second run yields the same evidence table
        const again = await verify({ bundle: loadBundle(INCIDENT_DIR).bundle, patchSource: patch(seed.file), appSimPath });
        assert.deepEqual(again.decision.rows, r.decision.rows);
        assert.equal(again.decision.exitCode, r.decision.exitCode);
      } else {
        assert.equal(r.decision.exitCode, seed.exit, `${seed.file}: ${r.decision.verdict} — ${r.decision.reasons.join(" | ")}`);
      }
      // no vacuous pass anywhere: an observed pass must carry sim contact
      for (const o of r.observations.values()) {
        if (o.observed === "pass") assert.ok(o.trace.some((t) => /^fetch .*→ \d{3}$/.test(t.what)), `${seed.file}/${o.sceneId}: pass without contacting the sim`);
      }
    });
  }

  test("CLI maps the verdict to the process exit code (good patch → 0)", async () => {
    const result = await new Promise<{ code: number | null; stdout: string }>((resolve) => {
      const child = spawn(
        process.execPath,
        ["--no-warnings", join(ROOT, "src/cli.ts"), "verify", "--patch", join(PATCH_DIR, "01-good-serialize.ts"), "--bundle", INCIDENT_DIR, "--executor", "synthetic"],
        { cwd: ROOT }
      );
      let stdout = "";
      child.stdout.on("data", (d) => (stdout += String(d)));
      child.on("close", (code) => resolve({ code, stdout }));
    });
    assert.equal(result.code, 0, result.stdout);
    assert.match(result.stdout, /\*\*Verdict:\*\* PASS \(exit 0\)/);
    assert.match(result.stdout, /\| scene-c-auth-failure \| [^|]+ \| fail \| fail \| ✓ \|/);
  });
});
