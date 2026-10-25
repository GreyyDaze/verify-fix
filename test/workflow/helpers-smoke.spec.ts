import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

const helpersDirUrl = new URL("../../.github/helpers/", import.meta.url);

const EXPECTED_HELPERS = [
  "bundle-digest.mjs",
  "deployment-url-roles.mjs",
  "probe-readiness.mjs",
  "readiness.mjs",
  "run-production-url-preflight.mjs",
];

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

test("helpers neither create statuses nor call any Vercel API", () => {
  for (const file of EXPECTED_HELPERS) {
    const source = readFileSync(new URL(file, helpersDirUrl), "utf8");
    assert.ok(!source.includes('method: "POST"'), `${file} must not POST`);
    assert.ok(!/api\.vercel\.com|vercel\.com\/api/i.test(source), `${file} must not call Vercel`);
    assert.ok(!source.includes("process.env.VERCEL_TOKEN"), `${file} must not read VERCEL_TOKEN`);
  }
});
