// Phase 8 task 8.2 / 8.5 — `create-verify-fix` copies the MAINTAINED example.
//
// These tests copy the real example out of this repository into a temp
// directory, which is the same proof path the packed package takes.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createFromTemplate, findRepositoryRelativeImports, isDestinationUsable, TEMPLATE_NAME } from "../src/create.ts";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

function destination(): string {
  return join(mkdtempSync(join(tmpdir(), "verify-fix-create-")), "project");
}

test("the maintained example exists where the creator looks for it", () => {
  assert.ok(existsSync(join(REPO_ROOT, "examples", "slots-booking", "web", "package.json")));
});

test("the creator copies the maintained example into a standalone directory", () => {
  const dir = destination();
  const result = createFromTemplate({ repoRoot: REPO_ROOT, destination: dir });
  assert.equal(result.status, "created");
  if (result.status !== "created") return;
  assert.ok(result.copiedFiles > 0);
  for (const required of ["package.json", "README.md", "checkly.config.ts", "playwright.config.ts", "app"]) {
    assert.ok(existsSync(join(dir, required)), `${required} is copied`);
  }
});

test("the copied project has NO repository-relative import back into verify-fix", () => {
  const dir = destination();
  createFromTemplate({ repoRoot: REPO_ROOT, destination: dir });
  assert.deepEqual(findRepositoryRelativeImports(dir), []);
});

test("the copied project carries no mock, secret, incident, build cache, or raw trace", () => {
  const dir = destination();
  createFromTemplate({ repoRoot: REPO_ROOT, destination: dir });
  // incidents/ starts empty
  const incidents = readdirSync(join(dir, "incidents")).filter((name) => name !== ".gitkeep");
  assert.deepEqual(incidents, [], "no captured incident is shipped");
  // no secrets
  for (const secret of [".env", ".env.local", ".env.production"]) {
    assert.equal(existsSync(join(dir, secret)), false, `${secret} is never copied`);
  }
  // no dependency or build directories
  for (const artifact of ["node_modules", ".next", "test-results", "playwright-report"]) {
    assert.equal(existsSync(join(dir, artifact)), false, `${artifact} is never copied`);
  }
  // no raw trace or HAR evidence
  const offenders: string[] = [];
  const walk = (d: string): void => {
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      if (["node_modules", ".next"].includes(entry.name)) continue;
      const full = join(d, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.(har|zip)$/.test(entry.name)) offenders.push(full);
    }
  };
  walk(dir);
  assert.deepEqual(offenders, [], "no raw trace or archive is copied");
});

test("a non-empty destination is REFUSED, so a learner's project is never overwritten", () => {
  const dir = destination();
  createFromTemplate({ repoRoot: REPO_ROOT, destination: dir });
  const again = createFromTemplate({ repoRoot: REPO_ROOT, destination: dir });
  assert.equal(again.status, "refused");
  if (again.status !== "refused") return;
  assert.match(again.reason, /not empty/);
});

test("an empty or absent destination is usable; a populated one is not", () => {
  assert.equal(isDestinationUsable(join(tmpdir(), `vf-${Date.now()}`, "absent")).usable, true);
  const dir = mkdtempSync(join(tmpdir(), "verify-fix-usable-"));
  assert.equal(isDestinationUsable(dir).usable, true);
  writeFileSync(join(dir, "package.json"), "{}", "utf8");
  assert.equal(isDestinationUsable(dir).usable, false);
});

test("an unknown template is refused; this package carries no second implementation", () => {
  const result = createFromTemplate({ repoRoot: REPO_ROOT, destination: destination(), template: "something-else" });
  assert.equal(result.status, "refused");
  if (result.status !== "refused") return;
  assert.match(result.reason, /unknown template/);
});

test("the copy is independent of the repository: editing the copy does not touch the original", () => {
  const dir = destination();
  createFromTemplate({ repoRoot: REPO_ROOT, destination: dir });
  const copied = join(dir, "checkly.config.ts");
  const original = join(REPO_ROOT, "examples", "slots-booking", "web", "checkly.config.ts");
  writeFileSync(copied, "// edited in the copy\n", "utf8");
  assert.notEqual(readFileSync(original, "utf8"), "// edited in the copy\n");
});

test("the copied README still teaches the workshop", () => {
  const dir = destination();
  createFromTemplate({ repoRoot: REPO_ROOT, destination: dir });
  const readme = readFileSync(join(dir, "README.md"), "utf8");
  for (const topic of ["Vercel", "Upstash", "Checkly", "verify-fix bundle", "verify-fix verify"]) {
    assert.ok(readme.includes(topic), `the README covers ${topic}`);
  }
});

test("the template name is the maintained one", () => {
  assert.equal(TEMPLATE_NAME, "slots-booking-live");
});