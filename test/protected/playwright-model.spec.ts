// Phase 9 task 9.1 / 9.4 — effective Playwright Check model.
//
// The bundle captures checkly.config.ts, playwright.config.ts and the spec, so
// the effective model IS resolvable offline. A field that cannot be read from
// those files stays null; a Checkly default is never assumed.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { resolveEffectivePlaywrightModel } from "../../src/protected/playwright-model.ts";

const ROOT = new URL("../..", import.meta.url).pathname;
const captured = (relative: string): string => {
  try { return readFileSync(join(ROOT, relative), "utf8"); } catch { return ""; }
};

const PW = `import { defineConfig, devices } from '@playwright/test'
const PRODUCTION_URL = 'https://example.invalid'
export default defineConfig({
  testDir: './tests', timeout: 60_000, retries: 0, workers: 1, fullyParallel: false,
  use: { baseURL: process.env.ENVIRONMENT_URL ?? PRODUCTION_URL, trace: 'on' },
  projects: [{ name: 'booking', use: { ...devices['Desktop Chrome'] } }],
})
`;

const CHECKLY = `import { defineConfig } from 'checkly'
export default defineConfig({
  checks: { playwrightConfigPath: './playwright.config.ts',
    playwrightChecks: [{ name: 'slots booking flow', pwProjects: ['booking'], runParallel: true }] },
})
`;

test("the captured bundle's effective Playwright model resolves fully", () => {
  const source = captured("fixtures/bundles/slots-booking-overlap/check/playwright.config.ts");
  const model = resolveEffectivePlaywrightModel(source,
    captured("fixtures/bundles/slots-booking-overlap/check/checkly.config.ts"), "playwright.config.ts");
  assert.equal(model.configPath, "playwright.config.ts");
  assert.deepEqual(model.projects, ["booking"]);
  assert.deepEqual(model.testSelection, ["booking"]);
  assert.equal(model.retries, 0, "a captured retries: 0 is a real value, not a default");
  assert.equal(model.targetVariable, "ENVIRONMENT_URL");
  assert.equal(model.targetFallback, "https://slots-booking-verify-fix.vercel.app");
});

test("retries is read numerically, so `retries: 0` is not dropped", () => {
  const model = resolveEffectivePlaywrightModel(PW, CHECKLY, "playwright.config.ts");
  assert.strictEqual(model.retries, 0);
  assert.equal(typeof model.retries, "number");
});

test("the target variable and its hardcoded fallback are both recorded", () => {
  const model = resolveEffectivePlaywrightModel(PW, CHECKLY, "playwright.config.ts");
  assert.equal(model.targetVariable, "ENVIRONMENT_URL");
  assert.equal(model.targetFallback, "https://example.invalid");
});

test("an UNREADABLE config resolves to nothing, not to a default", () => {
  // "export default {}" is a VALID config that simply declares no projects, so
  // it is covered by the next test. Here only genuinely unparseable sources.
  for (const bad of ["", "this is not ((( typescript", "const = =;\n{{{"]) {
    const model = resolveEffectivePlaywrightModel(bad, CHECKLY, "playwright.config.ts");
    assert.equal(model.configPath, null,
      "an unreadable config resolves NOTHING, including the path — fail closed");
    assert.equal(model.projects, null);
    assert.equal(model.retries, null);
    assert.equal(model.targetVariable, null);
    assert.equal(model.targetFallback, null);
  }
});

test("a VALID config that declares nothing yields null fields, not defaults", () => {
  const model = resolveEffectivePlaywrightModel("export default {}", "", "playwright.config.ts");
  assert.equal(model.configPath, "playwright.config.ts", "a readable config keeps its path");
  assert.equal(model.projects, null, "no projects declared -> null, not Playwright's implicit default");
  assert.equal(model.retries, null);
  assert.equal(model.targetVariable, null);
});

test("multiple Playwright projects are all captured", () => {
  // No Checkly scoped pwProjects here: the Playwright file's own projects apply.
  const multi = PW.replace("projects: [{ name: 'booking', use: { ...devices['Desktop Chrome'] } }]",
    "projects: [{ name: 'booking' }, { name: 'admin', grep: /admin/ }]");
  const model = resolveEffectivePlaywrightModel(multi, "", "playwright.config.ts");
  assert.deepEqual(model.projects, ["booking", "admin"]);
  assert.deepEqual(model.testSelection, ["booking", "admin"]);
});

test("an explicit `retries: 3` is read as three, never normalised to zero", () => {
  const model = resolveEffectivePlaywrightModel(PW.replace("retries: 0", "retries: 3"), CHECKLY, "playwright.config.ts");
  assert.equal(model.retries, 3);
});

test("an absent `retries` key stays null — Playwright's own default is not assumed", () => {
  const noRetries = PW.replace(", retries: 0", "");
  assert.equal(resolveEffectivePlaywrightModel(noRetries, CHECKLY, "playwright.config.ts").retries, null);
});

test("a literal baseURL with no env variable is recorded as a fallback only", () => {
  const literal = PW.replace("process.env.ENVIRONMENT_URL ?? PRODUCTION_URL", "'https://pinned.invalid'");
  const model = resolveEffectivePlaywrightModel(literal, CHECKLY, "playwright.config.ts");
  assert.equal(model.targetVariable, null, "a pinned host must not claim an env variable");
  assert.equal(model.targetFallback, "https://pinned.invalid");
});

test("a baseURL reading only process.env records the variable and no fallback", () => {
  const envOnly = PW.replace("?? PRODUCTION_URL", "");
  const model = resolveEffectivePlaywrightModel(envOnly, CHECKLY, "playwright.config.ts");
  assert.equal(model.targetVariable, "ENVIRONMENT_URL");
  assert.equal(model.targetFallback, null, "an unresolved env read is never a literal");
});

test("the Checkly check-scoped pwProjects override the Playwright projects", () => {
  const scoped = CHECKLY.replace("pwProjects: ['booking']", "pwProjects: ['booking', 'admin']");
  const model = resolveEffectivePlaywrightModel(PW, scoped, "playwright.config.ts");
  assert.deepEqual(model.projects, ["booking", "admin"]);
  assert.deepEqual(model.testSelection, ["booking", "admin"]);
});

test("a check-scoped retries override wins over the Playwright file's", () => {
  const scoped = CHECKLY.replace("runParallel: true", "retries: 2");
  const model = resolveEffectivePlaywrightModel(PW, scoped, "playwright.config.ts");
  assert.equal(model.retries, 2);
});

test("configPath comes from the Checkly project when it declares one", () => {
  const model = resolveEffectivePlaywrightModel(PW, CHECKLY, "./configs/pw.config.ts");
  assert.equal(model.configPath, "./configs/pw.config.ts");
});