// Regression scope.
//
// The point of these cases: a repair may only claim it left other monitors
// alone when the bundle actually records which monitors exist and which files
// each is built from. Every case below is derived from captured evidence, and
// an incomplete inventory is a legitimate UNCERTAIN rather than a PASS.

import { test } from "node:test";
import assert from "node:assert/strict";
import { assessSiblingImpact, isProjectWideFile, monitorInventory } from "../../src/policy/sibling-impact.ts";

const API = "api-1";
const BROWSER = "browser-1";
const MS = "ms-1";

const INVENTORY = monitorInventory([
  { id: API, name: "availability API", checkType: "API", files: ["checkly.config.ts", "checks/availability.check.ts", "checks/availability.setup.ts", "playwright.config.ts"] },
  { id: BROWSER, name: "booking flow", checkType: "PLAYWRIGHT", files: ["checkly.config.ts", "playwright.config.ts", "tests/booking.spec.ts"] },
  { id: MS, name: "multistep transaction", checkType: "MULTI_STEP", files: ["checkly.config.ts", "playwright.config.ts", "checks/multistep-booking.check.ts", "checks/multistep-booking.spec.ts"] },
]);

const INCIDENT = "checks/multistep-booking.spec.ts";
const impact = (changed: string[], inventory = INVENTORY) => assessSiblingImpact(inventory, INCIDENT, changed);

test("a change confined to the incident check's own spec affects only that monitor", () => {
  const result = impact(["checks/multistep-booking.spec.ts"]);
  assert.deepEqual(result.affected, [MS]);
  assert.equal(result.unresolved, false);
});

test("a change to a sibling's own spec affects that sibling and nobody else", () => {
  assert.deepEqual(impact(["tests/booking.spec.ts"]).affected, [BROWSER]);
  assert.deepEqual(impact(["checks/availability.setup.ts"]).affected, [API]);
});

test("a shared helper imported by one monitor does not drag in the others", () => {
  // The API check's setup module is its own; the Multistep check never imports
  // it, so this must not widen into a project-wide regression.
  const result = impact(["checks/availability.setup.ts"]);
  assert.equal(result.affected.length, 1);
  assert.ok(!result.affected.includes(MS));
});

test("a project-wide configuration change affects every monitor", () => {
  const result = impact(["checkly.config.ts"]);
  assert.deepEqual(result.affected, [API, BROWSER, MS].sort());
  for (const file of ["playwright.config.ts", "package.json", "package-lock.json"]) {
    assert.deepEqual(impact([file]).affected.length, 3, `${file} is project-wide`);
    assert.ok(isProjectWideFile(file));
  }
});

test("a file no captured monitor consumes affects nothing that can be named", () => {
  const result = impact(["docs/notes.md"]);
  assert.ok(!result.affected.includes(API) || !result.affected.includes(BROWSER));
  assert.equal(result.reasons["docs/notes.md"], "no captured monitor consumes this file");
});

test("an incomplete inventory is UNCERTAIN, never an empty impact set", () => {
  const partial = monitorInventory(
    [{ id: MS, name: "multistep transaction", checkType: "MULTI_STEP", files: ["checkly.config.ts", "checks/multistep-booking.spec.ts"] }],
    [MS],
  );
  const result = impact(["checkly.config.ts"], partial);
  assert.equal(result.unresolved, true);
  assert.match(result.reason ?? "", /closure unresolved/);
  assert.deepEqual(result.affected, [], "no monitor may be reported affected or safe when enumeration failed");
});

test("an empty inventory is UNCERTAIN rather than 'nothing is affected'", () => {
  const result = impact(["checkly.config.ts"], monitorInventory([]));
  assert.equal(result.unresolved, true);
  assert.match(result.reason ?? "", /no monitors were inventoried/);
});

test("the same file spelled consistently is attributed regardless of path separator", () => {
  // Windows-authored inventories use backslashes; candidates use POSIX paths.
  const windowsStyle = monitorInventory([
    { id: BROWSER, name: "booking flow", checkType: "PLAYWRIGHT", files: ["checkly.config.ts", "playwright.config.ts", "tests\\booking.spec.ts"] },
  ]);
  assert.deepEqual(impact(["tests/booking.spec.ts"], windowsStyle).affected, [BROWSER]);
});

test("reasons name the file and the monitor without leaking values", () => {
  const result = impact(["tests/booking.spec.ts"]);
  assert.match(result.reasons["tests/booking.spec.ts"], /PLAYWRIGHT monitor booking flow/);
  assert.ok(!JSON.stringify(result.reasons).toLowerCase().includes("secret"));
  assert.ok(!JSON.stringify(result.reasons).toLowerCase().includes("token"));
});

test("every affected monitor id comes from the inventory, never from the caller", () => {
  const hostile = monitorInventory([{ id: MS, name: "m", checkType: "MULTI_STEP", files: ["checkly.config.ts"] }]);
  const result = impact(["checkly.config.ts", "attacker-supplied-file.ts"], hostile);
  assert.deepEqual(result.affected, [MS], "an unknown file cannot introduce an unknown monitor");
});