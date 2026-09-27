// Stage-7 focused tests: Multistep source model + static policy.
// Reads the committed example check source (no cloud), and mutates synthetic
// copies — mechanics proof only.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseMultiStepProject, parseMultiStepScript } from "../../src/multistep/source.ts";
import { evaluateMultiStepPolicy } from "../../src/multistep/policy.ts";
import { parseProjectInventory } from "../../src/assertion/inventory.ts";
import { assertionId } from "../../src/assertion/id.ts";

const web = fileURLToPath(new URL("../../examples/slots-booking/web/", import.meta.url));
const constructSource = readFileSync(`${web}checks/multistep-booking.check.ts`, "utf8");
const scriptSource = readFileSync(`${web}checks/multistep-booking.spec.ts`, "utf8");
const files = new Map([
  ["checks/multistep-booking.check.ts", constructSource],
  ["checks/multistep-booking.spec.ts", scriptPath()],
]);

function scriptPath(): string {
  return scriptSource;
}

const model = parseMultiStepProject(files, "checks/multistep-booking.spec.ts");
if (!model?.script) throw new Error("example multistep model failed to parse");

function candidateWith(mutate: (source: string) => string) {
  const mutated = new Map(files);
  mutated.set("checks/multistep-booking.spec.ts", mutate(scriptSource));
  return parseMultiStepProject(mutated, "checks/multistep-booking.spec.ts");
}

test("ordered five-step parsing: canonical titles, all awaited, none conditional", () => {
  assert.deepEqual(model!.script!.steps.map((s) => s.title), ["login", "session", "slots", "book 09:30", "confirm transaction"]);
  assert.ok(model!.script!.steps.every((s) => s.awaited && !s.conditional));
  assert.equal(model!.errors.length, 0, `parse errors: ${model!.errors.join("; ")}`);
  assert.deepEqual(model!.construct?.errors, []);
  assert.equal(model!.construct?.logicalId, "slots-booking-multistep");
  assert.equal(model!.construct?.entrypoint, "checks/multistep-booking.spec.ts");
  assert.equal(model!.construct?.frequencyMinutes, 5);
  assert.deepEqual(model!.construct?.locations, ["us-east-1", "eu-west-1"]);
  assert.equal(model!.construct?.runParallel, true);
});

test("real request methods, ENVIRONMENT_URL origin, headers, and JSON bodies parse exactly", () => {
  const { requests, readsEnvironmentUrl, environmentUrlFallback, hardcodedHosts, banned } = model!.script!;
  assert.deepEqual(requests.map((r) => `${r.method} ${r.urlTemplate}`), [
    "POST `${origin}/api/login`",
    "GET `${origin}/api/session`",
    "GET `${origin}/api/slots`",
    "POST `${origin}/api/book`",
  ]);
  assert.deepEqual(requests.map((r) => r.stepTitle), ["login", "session", "slots", "book 09:30"]);
  assert.deepEqual(requests[1].headerKeys, ["Authorization"]);
  assert.equal(requests[1].usesBearer, true);
  assert.deepEqual(requests[3].bodyKeys, ["slot"]);
  assert.equal(readsEnvironmentUrl, true);
  assert.equal(environmentUrlFallback, false);
  assert.deepEqual(hardcodedHosts, []);
  assert.deepEqual(banned, []);
});

test("assertion identity stays byte-stable and step context is carried separately", () => {
  const inventory = parseProjectInventory("checks/multistep-booking.spec.ts", new Map(files));
  const modelIds = new Set(model!.script!.assertions.map((a) => a.id));
  assert.equal(inventory.assertions.length, model!.script!.assertions.length);
  assert.ok(inventory.assertions.every((a) => modelIds.has(a.id)));
  // known ids from the shared identity function — byte-stable
  assert.ok(modelIds.has(assertionId("response.status()", "toBe", "200")));
  assert.ok(modelIds.has(assertionId("body.confirmed", "toBe", "true")));
  assert.ok(modelIds.has(assertionId("body.booking", "toBe", "'CONFIRMED'")));
  // step context lives on the model, NOT in the id
  const confirmAssertions = model!.script!.assertions.filter((a) => a.stepTitle === "confirm transaction");
  assert.ok(confirmAssertions.length >= 10, "cross-step relations stay in the confirm step");
  assert.ok(model!.script!.assertions.some((a) => a.stepTitle === "book 09:30" && a.target === "200"));
  // inventory flow steps expose the ordered titles for the step-removal diff
  assert.deepEqual(inventory.steps, ["test.step:login", "test.step:session", "test.step:slots", "test.step:book 09:30", "test.step:confirm transaction"]);
});

test("clean original against itself produces no policy verdict", () => {
  const result = evaluateMultiStepPolicy(model, model);
  assert.equal(result.rejected, null);
  assert.equal(result.uncertain, null);
});

test("missing await on a required test.step = FAILED", () => {
  const candidate = candidateWith((s) => s.replace("await test.step('session'", "test.step('session'"));
  const result = evaluateMultiStepPolicy(model, candidate);
  assert.match(result.rejected ?? "", /missing await on required test\.step\('session'\)/);
  assert.equal(result.uncertain, null);
});

test("removed, reordered, or conditionally bypassed required steps = FAILED", () => {
  const removed = candidateWith((s) => s.slice(0, s.indexOf("await test.step('confirm transaction'")) + "\n})\n");
  const removedResult = evaluateMultiStepPolicy(model, removed);
  assert.match(removedResult.rejected ?? "", /removed or skipped: confirm transaction/);

  const reordered = candidateWith((s) => {
    const before = s.indexOf("await test.step('session'");
    const mid = s.indexOf("await test.step('slots'");
    const after = s.indexOf("await test.step('book 09:30'");
    const sessionBlock = s.slice(before, mid);
    const slotsBlock = s.slice(mid, after);
    return s.slice(0, before) + slotsBlock + sessionBlock + s.slice(after);
  });
  const reorderedResult = evaluateMultiStepPolicy(model, reordered);
  assert.match(reorderedResult.rejected ?? "", /reordered/);

  // A step whose call sits inside a conditional block is a bypass vector.
  const conditionalScript = [
    "import { test, expect } from '@playwright/test'",
    "test('t', async ({ request }) => {",
    "  if (process.env.SKIP_LOGIN !== '1') {",
    "    await test.step('login', async () => {",
    "      const r = await request.post('https://x.test/api/login')",
    "      expect(r.status()).toBe(200)",
    "    })",
    "  }",
    "})",
  ].join("\n");
  const conditional = parseMultiStepProject(new Map([
    ["checks/multistep-booking.check.ts", constructSource],
    ["checks/multistep-booking.spec.ts", conditionalScript],
  ]), "checks/multistep-booking.spec.ts");
  const conditionalResult = evaluateMultiStepPolicy(model, conditional);
  assert.match(conditionalResult.rejected ?? "", /conditionally bypassed/);
});

test("skip/fixme/soft/catch/shouldFail/response-rewrite/retries/timeouts are FAILED", () => {
  const cases: Array<[string, (s: string) => string, RegExp]> = [
    ["skip", (s) => s.replace("await test.step('login'", "test.skip('login'"), /test\.skip\/fixme\/only|removed or skipped/],
    ["soft", (s) => s.replace("expect(body.ok).toBe(true)", "expect.soft(body.ok).toBe(true)"), /soft assertion/],
    ["catch", (s) => s.replace("expect(body.ok).toBe(true)", "try { expect(body.ok).toBe(true) } catch {}"), /catch\/ignore suppression/],
    ["shouldFail", (s) => s.replace("test('slots booking multistep transaction'", "test('slots booking multistep transaction', { shouldFail: true }"), /shouldFail/],
    ["rewrite", (s) => s.replace("await request.post(`${origin}/api/login`", "await page.route('**/api/login', () => {})\n    await request.post(`${origin}/api/login`"), /response rewriting/],
    ["retries", (s) => s.replace("test('slots booking multistep transaction', async", "test('slots booking multistep transaction', { retries: 2 }, async"), /retries in code/],
    ["timeout", (s) => s.replace("await test.step('login'", "test.setTimeout(60_000)\n  await test.step('login'"), /timeout\/slow used as repair/],
    ["hardcoded host", (s) => s.replace("`${origin}/api/login`", "`https://hardcoded.example/api/login`"), /hardcoded host/],
    ["env fallback", (s) => s.replace("const rawEnvironmentUrl = process.env.ENVIRONMENT_URL", "const rawEnvironmentUrl = process.env.ENVIRONMENT_URL ?? 'https://fallback.example'"), /ENVIRONMENT_URL has a fallback/],
    ["fabricated token", (s) => s.replace("bearerToken = body.token as string", "bearerToken = 'forged-token-value'"), /fabricated token literal/],
    ["compat repair", (s) => s.replace("expect(body.confirmed).toBe(true)", "expect(body.confirmed ?? body.booking?.confirmed).toBe(true)"), /compatibility repair/],
  ];
  for (const [name, mutate, expected] of cases) {
    const result = evaluateMultiStepPolicy(model, candidateWith(mutate));
    assert.match(result.rejected ?? "", expected, `${name} must be FAILED, got rejected=${result.rejected} uncertain=${result.uncertain}`);
  }
});

test("exact status and nested JSON assertions are supported (not UNCERTAIN)", () => {
  const nested = candidateWith((s) => s.replace("expect(body.confirmed).toBe(true)", "expect(response.status()).toBe(200)\n    expect(body.booking.status).toBe('CONFIRMED')"));
  const result = evaluateMultiStepPolicy(model, nested);
  assert.equal(result.uncertain, null, `unexpected UNCERTAIN: ${result.uncertain}`);
});

test("unresolved expression = UNCERTAIN", () => {
  const candidate = candidateWith((s) => s.replace("expect(body.ok).toBe(true)", "expect(mysteryValue).toBe(true)"));
  const parsed = candidate;
  assert.ok(parsed!.errors.some((e) => e.includes('unresolved expression "mysteryValue"')));
  const result = evaluateMultiStepPolicy(model, parsed);
  assert.equal(result.rejected, null, "nothing definite failed — this input is unjudgeable");
  assert.match(result.uncertain ?? "", /unresolved expression/);
});

test("unsupported matcher = UNCERTAIN", () => {
  const candidate = candidateWith((s) => s.replace("expect(body.ok).toBe(true)", "expect(body.ok).toBeExactly(true)"));
  assert.ok(candidate!.errors.some((e) => e.includes('unsupported matcher "toBeExactly"')));
  const result = evaluateMultiStepPolicy(model, candidate);
  assert.equal(result.rejected, null);
  assert.match(result.uncertain ?? "", /unsupported matcher/);
});

test("unsupported syntax (non-provable step title) = UNCERTAIN", () => {
  // NOTE: a local `const title = 'login'` IS now statically provable and
  // resolves (see test/multistep/revision3.spec.ts); only non-provable
  // computed titles remain UNCERTAIN.
  const parsed = parseMultiStepScript("x.spec.ts", [
    "import { test, expect } from '@playwright/test'",
    "test('t', async ({ request }) => {",
    "  const title = String(Date.now())",
    "  await test.step(title, async () => {})",
    "})",
  ].join("\n"));
  assert.ok(parsed.errors.some((e) => e.includes("not a static string")));
});

test("MultiStepCheck construct removal or identity change = FAILED", () => {
  const noConstruct = new Map(files);
  noConstruct.set("checks/multistep-booking.check.ts", "// construct removed\nexport {}\n");
  const removed = parseMultiStepProject(noConstruct, "checks/multistep-booking.spec.ts");
  const removedResult = evaluateMultiStepPolicy(model, removed);
  assert.match(removedResult.rejected ?? "", /construct removed/);

  const retargeted = new Map(files);
  retargeted.set("checks/multistep-booking.check.ts", constructSource.replace('"slots-booking-multistep"', '"some-other-check"'));
  const changed = parseMultiStepProject(retargeted, "checks/multistep-booking.spec.ts");
  const changedResult = evaluateMultiStepPolicy(model, changed);
  assert.match(changedResult.rejected ?? "", /logical ID changed/);
});
