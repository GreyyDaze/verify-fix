// Phase 8 task 8.1 — `verify-fix init` configures an EXISTING Checkly project.
//
// Scope boundaries under test: init must not create or copy the example, must
// not provision a service, must not read or store a credential, and must not
// write anything before an explicit confirmation.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { detectProject, initConfirmation, initPackageScripts, isSafeRelativeTarget, mergePackageScripts, planInit } from "../src/init.ts";

function tempProject(files: Record<string, string> = {}): string {
  const dir = mkdtempSync(join(tmpdir(), "verify-fix-init-"));
  for (const [name, body] of Object.entries(files)) {
    const parent = join(dir, name.split("/").slice(0, -1).join("/"));
    if (parent) mkdirSync(parent, { recursive: true });
    writeFileSync(join(dir, name), body, "utf8");
  }
  return dir;
}

const CONFIG = 'import { defineConfig } from "checkly"\nexport default defineConfig({ projectName: "p" })\n';

test("init detects an existing Checkly project", () => {
  const dir = tempProject({ "checkly.config.ts": CONFIG, "package.json": '{"name":"x"}' });
  const plan = planInit(dir);
  assert.ok(plan.project.configFile, "the config file is found");
  assert.equal(plan.project.hasPackageJson, true);
});

test("init REFUSES a directory with no Checkly project, and never scaffolds one", () => {
  const dir = tempProject({ "package.json": '{"name":"x"}' });
  const plan = planInit(dir);
  assert.equal(plan.project.configFile, null);
  assert.deepEqual(plan.actions, [], "init must not create files in a non-Checkly directory");
  assert.match(plan.notes.join(" "), /never creates or copies the example/);
  assert.equal(existsSync(join(dir, "checkly.config.ts")), false);
});

test("init never reads an env file; it only reports that one exists", () => {
  const dir = tempProject({ "checkly.config.ts": CONFIG, "package.json": '{"name":"x"}',
    ".env.local": "API_TOKEN=super-secret-value\n" });
  const plan = planInit(dir);
  assert.equal(plan.project.hasEnvFile, true);
  const rendered = [initConfirmation(plan), ...plan.notes].join("\n");
  assert.ok(!rendered.includes("super-secret-value"), "an env value must never reach output");
  assert.match(rendered, /NEVER read, parsed, copied, or stored/);
});

test("init plans a package.json script merge and an empty incidents/ directory", () => {
  const dir = tempProject({ "checkly.config.ts": CONFIG, "package.json": '{"name":"x","scripts":{"build":"next build"}}' });
  const plan = planInit(dir);
  const paths = plan.actions.map((action) => action.path);
  assert.ok(paths.includes("package.json"));
  assert.ok(paths.includes("incidents/"));
  // An existing incidents/ directory is left alone.
  const withIncidents = tempProject({ "checkly.config.ts": CONFIG, "package.json": '{"name":"x"}', "incidents/.gitkeep": "" });
  assert.equal(planInit(withIncidents).actions.some((action) => action.path === "incidents/"), false);
});

test("init does not touch the Checkly config or any check source", () => {
  const dir = tempProject({ "checkly.config.ts": CONFIG, "package.json": '{"name":"x"}',
    "checks/booking.check.ts": "// a check\n" });
  const before = readFileSync(join(dir, "checkly.config.ts"), "utf8");
  planInit(dir);
  assert.equal(readFileSync(join(dir, "checkly.config.ts"), "utf8"), before);
  assert.equal(readFileSync(join(dir, "checks/booking.check.ts"), "utf8"), "// a check\n");
});

test("merging package scripts preserves existing scripts", () => {
  const merged = mergePackageScripts('{"name":"x","scripts":{"build":"next build"}}');
  const parsed = JSON.parse(merged) as { name: string; scripts: Record<string, string> };
  assert.equal(parsed.name, "x");
  assert.equal(parsed.scripts.build, "next build", "the existing script survives");
  for (const key of Object.keys(initPackageScripts())) {
    assert.ok(parsed.scripts[key], `${key} is added`);
  }
});

test("merging package scripts twice is idempotent", () => {
  const once = mergePackageScripts('{"name":"x","scripts":{}}');
  assert.equal(mergePackageScripts(once), once);
});

test("init is a no-op when verify-fix is already a dependency", () => {
  const dir = tempProject({ "checkly.config.ts": CONFIG,
    "package.json": '{"name":"x","devDependencies":{"verify-fix":"^0.1.0"}}', "incidents/.gitkeep": "" });
  const plan = planInit(dir);
  assert.equal(plan.project.hasVerifyFixInstalled, true);
  assert.deepEqual(plan.actions, []);
});

test("the confirmation text states what is NOT touched", () => {
  const dir = tempProject({ "checkly.config.ts": CONFIG, "package.json": '{"name":"x"}' });
  const text = initConfirmation(planInit(dir));
  assert.match(text, /Not touched: your checks, your Checkly config, any env file, and any captured incident/);
  assert.match(text, /No service is provisioned and no credential is read or stored/);
});

test("detectProject never throws on a hostile or absent directory", () => {
  const dir = tempProject({});
  assert.doesNotThrow(() => detectProject(dir));
  assert.doesNotThrow(() => detectProject(join(dir, "does-not-exist")));
  const detected = detectProject(join(dir, "does-not-exist"));
  assert.equal(detected.configFile, null);
});

test("isSafeRelativeTarget refuses an escape from the project root", () => {
  const dir = tempProject({ "checkly.config.ts": CONFIG });
  assert.equal(isSafeRelativeTarget(dir, "incidents"), true);
  assert.equal(isSafeRelativeTarget(dir, "../outside"), false);
  assert.equal(isSafeRelativeTarget(dir, "/etc/passwd"), false);
});