// Problem-name taxonomy law: every multistep problem literal emitted anywhere
// in the multistep/bundle pipeline must be an exact fixed category. A misspelled
// name (a real `MULTIPLE_FAILURE_STEP_UNBOUND` typo shipped once) is not in the
// fixed set, matches no deliberate category rule, and therefore collapses into
// the `MULTISTEP_EVIDENCE_INVALID` fallback — mislabeling the true gate and
// hiding which admission actually rejected the evidence.
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import test from "node:test";
import { isKnownMultiStepProblem, multistepProblemCategory } from "../../src/multistep/sanitize.ts";

const srcDir = new URL("../../src/", import.meta.url).pathname;
const files = [
  ...readdirSync(`${srcDir}multistep`).filter((name) => name.endsWith(".ts")).map((name) => `src/multistep/${name}`),
  ...readdirSync(`${srcDir}bundle`).filter((name) => name.endsWith(".ts")).map((name) => `src/bundle/${name}`),
  "src/bundle.ts",
];

const LITERAL = /"(MULTISTEP|MULTIPLE)_[A-Z_]+"/g;
const extract = (path: string): string[] => [...readFileSync(`${srcDir}../${path}`, "utf8").matchAll(LITERAL)]
  .map((match) => match[0]!.slice(1, -1));

test("every emitted multistep problem name is an exact fixed category", () => {
  const emitted = new Map<string, string[]>();
  for (const file of files) for (const name of extract(file)) {
    emitted.set(name, [...emitted.get(name) ?? [], file]);
  }
  assert.ok(emitted.size > 40, `taxonomy scan found the pipeline literals (${emitted.size})`);
  // Names that never pass through the category mapper — still exact fixed
  // spellings: verify-time bundle problems and result metadata labels, thrown
  // reader/output/bridge/executor signals, warning-level uncertain markers,
  // and one env-key prefix literal.
  const verifyTimeOnly = new Set([
    "MULTISTEP_LEGACY_BUNDLE_UNBOUND",
    "MULTISTEP_SCENE_PROVENANCE_INVALID",
    "MULTISTEP_EVIDENCE_INVALID",
    "MULTISTEP_RUN_FAILED",
    "MULTISTEP_RUN_PASSED",
    "MULTISTEP_BUNDLE_PATH_UNSAFE",
    "MULTISTEP_BUNDLE_FILE_UNSAFE",
    "MULTISTEP_OUTPUT_PATH_UNSAFE",
    "MULTISTEP_OUTPUT_BOUND",
    "MULTISTEP_RAW_OUTPUT_FORBIDDEN",
    "MULTISTEP_SECRET_UNSCREENABLE",
    "MULTISTEP_SOURCE_UNPROVEN",
    "MULTISTEP_ASSERTIONS_UNPROVEN",
    "MULTISTEP_DISK_BINDING_INVALID",
    "MULTISTEP_CLEANUP_FAILED",
    "MULTISTEP_BRIDGE_SETUP_FAILED",
    "MULTISTEP_BRIDGE_CLEANUP_FAILED",
    "MULTISTEP_USER_",
  ]);
  for (const [name, where] of emitted) {
    assert.ok(!name.startsWith("MULTIPLE_"), `${name} (${where.join(", ")}) is a typo: no problem may fall outside the fixed taxonomy`);
    assert.ok(isKnownMultiStepProblem(name) || verifyTimeOnly.has(name),
      `${name} (${where.join(", ")}) is not a fixed category and would surface as the EVIDENCE_INVALID fallback`);
    if (!verifyTimeOnly.has(name)) {
      assert.equal(multistepProblemCategory(name), name, `${name} must categorize as itself`);
    }
  }
});

test("the rendered per-side availability names are exact fixed categories", () => {
  for (const side of ["FAILING", "PASSING"]) {
    for (const suffix of ["RESULT_MISSING", "RECORDING_MISSING", "RECORDING_INVALID"]) {
      const name = `MULTISTEP_${side}_${suffix}`;
      assert.ok(isKnownMultiStepProblem(name), `${name} must be a fixed category`);
      assert.equal(multistepProblemCategory(name), name);
    }
  }
});

test("every dynamic wording family maps to its truthful category, never the generic fallback", () => {
  // Internally contradictory stats/status evidence:
  assert.equal(multistepProblemCategory("inconsistent capture: result status is failed but stats.unexpected is 0 (corrupt or internally inconsistent evidence)"),
    "MULTISTEP_RESULT_STATS_INVALID");
  assert.equal(multistepProblemCategory("inconsistent capture: stats.unexpected > 0 but no failed result status and no failed step (corrupt or internally inconsistent evidence)"),
    "MULTISTEP_RESULT_STATS_INVALID");
  assert.equal(multistepProblemCategory("inconsistent capture: failed step(s) recorded inside an all-passed result (corrupt or internally inconsistent evidence)"),
    "MULTISTEP_RESULT_STATS_INVALID");
  // Unparseable/malformed raw evidence:
  for (const wording of [
    "logs.txt is not valid JSON (corrupt or truncated asset)",
    "check-run-data.json is not a JSON object (corrupt asset)",
    "test-results.json is not valid JSON (corrupt or truncated asset)",
    "test-results.json lacks a single genuine nested Playwright suites/specs/tests/results array",
    "test-results.json top-level step is not a genuine Playwright test.step with nested children",
    "request checklyData is not a genuine nested Playwright array",
    "step nesting exceeds supported depth (truncated or corrupt evidence)",
    "headers field is neither an object nor an array (corrupt evidence)",
    "logs.txt contains a malformed entry (corrupt asset)",
  ]) {
    assert.equal(multistepProblemCategory(wording), "MULTISTEP_RAW_SCHEMA_INVALID", wording);
  }
  // Ordered-step absence stays a missing-evidence problem (checked first):
  assert.equal(multistepProblemCategory("test-results.json contains no ordered step evidence (missing execution evidence)"),
    "MULTISTEP_EVIDENCE_MISSING");
});

test("the category mapper maps every deliberate wording family and never invents categories", () => {
  assert.equal(multistepProblemCategory("token relationship inconsistent: expected exactly 3 token occurrences, observed 2"),
    "MULTISTEP_TOKEN_RELATIONSHIP_INVALID");
  assert.equal(multistepProblemCategory("account relationship inconsistent: 2 distinct account values"),
    "MULTISTEP_ACCOUNT_RELATIONSHIP_INVALID");
  assert.equal(multistepProblemCategory("zip: local and central headers disagree"), "MULTISTEP_ARCHIVE_INVALID");
  assert.equal(multistepProblemCategory("logs.txt is not valid JSON (corrupt or truncated asset)"),
    "MULTISTEP_RAW_SCHEMA_INVALID");
  assert.equal(multistepProblemCategory("test-results.json contains no ordered step evidence (missing execution evidence)"),
    "MULTISTEP_EVIDENCE_MISSING");
  assert.equal(multistepProblemCategory("MULTIPLE_FAILURE_STEP_UNBOUND"), "MULTISTEP_EVIDENCE_INVALID",
    "the historical typo maps to the fallback — the emitter itself must never spell it");
});
