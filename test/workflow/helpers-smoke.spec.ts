import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

import * as deploymentUrlRoles from "../../.github/helpers/deployment-url-roles.mjs";
import * as probeReadiness from "../../.github/helpers/probe-readiness.mjs";
import * as readiness from "../../.github/helpers/readiness.mjs";
import * as productionPreflight from "../../.github/helpers/run-production-url-preflight.mjs";

const helpersDirUrl = new URL("../../.github/helpers/", import.meta.url);
const helpersDirPath = fileURLToPath(helpersDirUrl);

const EXPECTED_HELPERS = [
  "deployment-url-roles.mjs",
  "probe-readiness.mjs",
  "readiness.mjs",
  "run-production-url-preflight.mjs",
];

test("helper directory holds only dependency-free .mjs runtime helpers", () => {
  const files = readdirSync(helpersDirPath).sort();
  assert.deepEqual(files, EXPECTED_HELPERS);
  assert.ok(!files.some((file) => file.endsWith(".ts")), "no TypeScript entrypoints remain");
});

test("every runtime helper is opted into type checking with // @ts-check", () => {
  for (const file of EXPECTED_HELPERS) {
    const firstLine = readFileSync(new URL(file, helpersDirUrl), "utf8")
      .split("\n")[0];
    assert.equal(firstLine, "// @ts-check", `${file} must start with // @ts-check`);
  }
});

test("every runtime helper passes a node --check syntax check", () => {
  for (const file of EXPECTED_HELPERS) {
    execFileSync(process.execPath, ["--check", fileURLToPath(new URL(file, helpersDirUrl))], {
      encoding: "utf8",
    });
  }
});

test("every runtime helper imports as ordinary ESM without executing an entrypoint", async () => {
  for (const file of EXPECTED_HELPERS) {
    const module = await import(new URL(file, helpersDirUrl).href);
    assert.equal(typeof module, "object");
    assert.ok(Object.keys(module).length > 0, `${file} must export something`);
  }
});

test("library helpers expose the documented entry functions", () => {
  assert.equal(typeof deploymentUrlRoles.resolveUrlRoles, "function");
  assert.equal(typeof deploymentUrlRoles.normalizeHttpsOrigin, "function");
  assert.equal(typeof deploymentUrlRoles.validatePreflightInputs, "function");
  assert.equal(typeof deploymentUrlRoles.validateDeploymentRecord, "function");
  assert.equal(typeof deploymentUrlRoles.mapStatusProvenance, "function");
  assert.equal(deploymentUrlRoles.VERCEL_APP_SLUG, "vercel");
  assert.equal(
    deploymentUrlRoles.MANUAL_STABLE_STATUS_MARKER,
    "verify-fix:stable-alias-verified",
  );
  assert.equal(typeof readiness.evaluateReadiness, "function");
  assert.equal(typeof readiness.isProtectionStatus, "function");
  assert.equal(typeof probeReadiness.runReadinessProbe, "function");
  assert.equal(typeof probeReadiness.main, "function");
  assert.equal(typeof productionPreflight.main, "function");
});

test("helpers neither create statuses nor call any Vercel API", () => {
  for (const file of EXPECTED_HELPERS) {
    const source = readFileSync(new URL(file, helpersDirUrl), "utf8");
    assert.ok(!source.includes('method: "POST"'), `${file} must not POST`);
    assert.ok(!/api\.vercel\.com|vercel\.com\/api/i.test(source), `${file} must not call Vercel`);
    assert.ok(!source.includes("process.env.VERCEL_TOKEN"), `${file} must not read VERCEL_TOKEN`);
  }
});
