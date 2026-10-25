// Sandbox evidence rules that do not depend on any captured bundle: a run
// that never contacts ENVIRONMENT_URL is vacuous, the sandbox receives only
// Checkly's variables and the check's own, and the outcome marker is explicit.
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { runSandbox, parseOutcomeLine } from "../../../src/execution/sandbox/runner.ts";
import { repetitionSeed } from "../../../src/execution/executor/scene.ts";
import { parseInventory, stripComments } from "../../../src/evidence/assertion/inventory.ts";
import { startExampleApp, type RunningApp } from "../../helpers/example-app.ts";

const ENV = { ACCOUNT: "demo" };

let app: RunningApp;
before(async () => {
  app = await startExampleApp();
});
after(async () => {
  await app.stop();
});

describe("sandbox: a DSL run must prove it contacted ENVIRONMENT_URL", () => {
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
    const src = `import { check, expect } from "@checkly/cli";\ncheck("hitless", async () => { expect(1).toBe(1); });\n`;
    const out = await runSandbox(src, { baseUrl: app.url, env: ENV });
    assert.equal(out.passed, false, "no contact → never a pass");
    assert.equal(out.vacuous, true);
    assert.equal(out.simHits, 0);
    assert.equal(out.results[0].assertionCount, 1);
    assert.ok(out.results[0].trace.some((t) => t.kind === "step" && t.outcome === "skipped" && /did not contact armed sim/.test(t.what)));
  });

  test("the sandbox gets Checkly's variables and the check's own — and nothing from the parent process", async () => {
    process.env.VERIFY_FIX_PARENT_SECRET = "must-not-leak";
    try {
      const src = [
        `import { check, expect } from "@checkly/cli";`,
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
      `import { check, expect } from "@checkly/cli";`,
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

describe("assertion inventory", () => {
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
