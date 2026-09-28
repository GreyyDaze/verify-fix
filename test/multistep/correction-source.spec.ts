// Correction batch: adversarial source, policy, env and attribution tests.
// All project/asset values are synthetic; these prove mechanics, not Checkly
// or deployment behavior. The canonical spec/construct are read, never edited.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseMultiStepProject, parseMultiStepScript } from "../../src/multistep/source.ts";
import { evaluateMultiStepPolicy } from "../../src/multistep/policy.ts";
import { runMultiStepSandbox, bridgeReporterMismatch } from "../../src/multistep/executor.ts";
import { MAX_REPORTER_AUDIT_BYTES, parseReporterAudit } from "../../src/multistep/reporter.ts";
import { checkEnv } from "../../src/scene/env.ts";
import { emptyExecutionCost, type Bundle, type ExperimentExecutor, type Scene } from "../../src/types.ts";
import { verify } from "../../src/verify.ts";
import { detectMultiStepFailurePoint } from "../../src/bundle/manifest.ts";
import { buildMultiStepRecording } from "../../src/multistep/capture.ts";
import { failingTestResults, passingTestResults, failingLogs } from "./helpers.ts";

const WEB = new URL("../../examples/slots-booking/web/", import.meta.url).pathname;
const FILE = "checks/multistep-booking.spec.ts";
const CHECK = "checks/multistep-booking.check.ts";
const SPEC = readFileSync(join(WEB, FILE), "utf8");
const CONSTRUCT = readFileSync(join(WEB, CHECK), "utf8");
const files = (spec = SPEC, construct = CONSTRUCT, extra: Record<string, string> = {}) =>
  new Map([[FILE, spec], [CHECK, construct], ...Object.entries(extra)]);
const ORIGINAL = parseMultiStepProject(files(), FILE)!;
assert.deepEqual(ORIGINAL.errors, [], "the unmodified baseline must be fully modeled");

function candidate(spec: string, construct = CONSTRUCT, extra: Record<string, string> = {}) {
  return parseMultiStepProject(files(spec, construct, extra), FILE)!;
}

function bundle(): Bundle {
  const scene: Scene = {
    sceneId: "source-gate", type: "REPRODUCTION", mode: "live", state: "local fixture", environment: "target",
    verdict: { mustFail: false, provenance: { kind: "code", assertionId: ORIGINAL.script!.assertions[0]!.id }, envAssumptions: ["target-resolution"] },
    experiments: [{ repetitions: 1, durationSec: 10, expectStable: true }], assertionsInvolved: [],
  };
  return {
    schemaVersion: "v3", incidentId: "synthetic-multistep", incident: { title: "synthetic", description: "synthetic" },
    check: { repo: "", file: FILE, name: "slots booking multistep transaction", checkType: "MULTI_STEP", logicalId: "slots-booking-multistep", deployedId: "fake" },
    checkSource: SPEC, files: Object.fromEntries(files()), configFile: null,
    config: { runParallel: true, locations: ["us-east-1", "eu-west-1"], frequencyMinutes: 5,
      environmentVariables: ["ENVIRONMENT_URL", "MULTISTEP_USER_US_EAST_1", "MULTISTEP_USER_EU_WEST_1"] },
    recordedOrigin: null, dir: WEB, playwright: null, api: null,
    multistep: { kind: "failing", steps: ["login", "session", "slots", "book 09:30"], problems: [] },
    scenes: [scene], envAssumptions: [{ id: "target-resolution", text: "synthetic", verified: true }],
    determinism: { targetRuns: 20, achieved: 20, sequentialPassRate: 1, overlapFailRate: 0, lastVerifiedAt: "2026-09-27" },
    runBudget: { maxPerScene: 1, used: 0 }, oracleProvenance: { recorded: 0, codeDerived: 1 },
  };
}

test("CI is a built-in env key and REGION is runtime-provided only for Multistep", () => {
  const src = "const a = process.env.CI; const b = process.env.REGION; const c = process.env.UNKNOWN_CUSTOM_KEY";
  const multi = checkEnv(src, {}, [], ["REGION"]);
  assert.deepEqual(multi.missing.map((r) => r.name), ["UNKNOWN_CUSTOM_KEY"]);
  assert.deepEqual(multi.undeclared, ["UNKNOWN_CUSTOM_KEY"]);
  const generic = checkEnv(src, {}, []);
  assert.deepEqual(generic.missing.map((r) => r.name), ["REGION", "UNKNOWN_CUSTOM_KEY"]);
  assert.deepEqual(generic.undeclared, ["REGION", "UNKNOWN_CUSTOM_KEY"]);
});

test("construct settings are bound: duplicate fields, changed values and a renamed entrypoint do not pass", () => {
  const changed = [
    CONSTRUCT.replace("frequency: Frequency.EVERY_5M", "frequency: Frequency.EVERY_15M"),
    CONSTRUCT.replace("runParallel: true,", "runParallel: false,"),
    CONSTRUCT.replace("value: process.env.MULTISTEP_USER_US_EAST_1 ?? \"\"", "value: process.env.MULTISTEP_USER_EU_WEST_1 ?? \"\""),
    CONSTRUCT.replace("runParallel: true,", "runParallel: true, runParallel: false,"),
    CONSTRUCT.replace("entrypoint: path.join(__dirname, \"multistep-booking.spec.ts\")", "entrypoint: path.join(__dirname, \"other.spec.ts\")"),
  ];
  for (const construct of changed) {
    const model = candidate(SPEC, construct, { "other/other.spec.ts": SPEC });
    const policy = evaluateMultiStepPolicy(ORIGINAL, model);
    assert.ok(model.errors.length || policy.rejected, "construct drift is unjudgeable or a definite change");
    assert.notEqual(policy.rejected === null && policy.uncertain === null, true);
  }
  const duplicate = candidate(SPEC, changed[3]!);
  assert.ok(duplicate.construct!.errors.some((error) => /duplicate/.test(error)));
  const wrongEntrypoint = candidate(SPEC, changed[4]!, { "other/other.spec.ts": SPEC });
  assert.equal(wrongEntrypoint.script, null, "a same-basename file is never a substitute for the construct entrypoint");
  const unavailableOriginal = parseMultiStepProject(new Map([[FILE, SPEC]]), FILE)!;
  const unknowable = evaluateMultiStepPolicy(unavailableOriginal, unavailableOriginal);
  assert.equal(unknowable.rejected, null, "an uncaptured original construct cannot definitely be called a removed check");
  assert.match(unknowable.uncertain ?? "", /original Multistep source is unsupported/);
});

test("request options, region/slot/token bindings and complete same-ID assertion tuples cannot be laundered", () => {
  const changes: Array<[string, RegExp]> = [
    [SPEC.replace("const region = process.env.REGION", "const region = 'us-east-1'"), /regional account|data binding/],
    [SPEC.replace("const SELECTED_SLOT = '09:30'", "const SELECTED_SLOT = '10:00'"), /slot|data binding/],
    [SPEC.replace("`Bearer ${bearerToken}`", "'Bearer stolen-synthetic-token'"), /ordered Multistep requests/],
    [SPEC.replace("expect(body.slot).toBe('09:30')", "expect(body.booking).toBe('09:30')"), /step-scoped assertion tuples/],
  ];
  for (const [spec, reason] of changes) {
    const model = candidate(spec);
    const verdict = evaluateMultiStepPolicy(ORIGINAL, model);
    assert.match(verdict.rejected ?? "", reason, `must not silently accept ${reason}`);
  }
  const original = ORIGINAL.script!.assertions.find((a) => a.subject === "body.slot" && a.target === "'09:30'")!;
  const substituted = candidate(changes[3]![0]).script!.assertions.find((a) => a.subject === "body.booking" && a.target === "'09:30'")!;
  assert.equal(original.id, substituted.id, "identity remains byte-stable; step-scoped tuple catches the substitution");
  const smuggled = candidate(SPEC.replace("data: { slot: SELECTED_SLOT },", "data: { slot: SELECTED_SLOT, ...extra },"));
  assert.ok(smuggled.errors.some((error) => /request data/.test(error)), "a spread can alter a body without changing its modeled key");
});

test("lexical const-only resolution, cycle errors, no executable local modules and no shadowed URL wrappers", async () => {
  const marker = join(mkdtempSync(join(tmpdir(), "verify-fix-preflight-")), "executed");
  const imported = "import { STEP_TITLE } from './untrusted'\n" + SPEC.replace("await test.step('login'", "await test.step(STEP_TITLE");
  const malicious = `import { writeFileSync } from 'node:fs'\nwriteFileSync(${JSON.stringify(marker)}, 'executed')\nexport const STEP_TITLE = 'login'`;
  const model = candidate(imported, CONSTRUCT, { "checks/untrusted.ts": malicious });
  assert.ok(model.errors.some((error) => /executable|external/.test(error)));
  const outcome = await runMultiStepSandbox({
    projectDir: WEB, baseUrl: "https://fixture.invalid", checkFile: FILE,
    files: Object.fromEntries(files(imported, CONSTRUCT, { "checks/untrusted.ts": malicious })),
    env: { REGION: "us-east-1", MULTISTEP_USER_US_EAST_1: "user-fixture-001" },
  });
  assert.equal(outcome.inconclusive, true);
  assert.equal(outcome.browserProcesses, null, "no child process was sampled because none started");
  assert.equal(outcome.environmentOrigin, null, "even the origin bridge was not started");
  assert.equal(existsSync(marker), false, "the executable node:fs module did not run");

  const cycled = candidate("import { STEP_TITLE } from './cyclic'\n" + SPEC.replace("await test.step('login'", "await test.step(STEP_TITLE"), CONSTRUCT,
    { "checks/cyclic.ts": "export const STEP_TITLE = OTHER; export const OTHER = STEP_TITLE;" });
  assert.ok(cycled.errors.some((error) => /cycle/.test(error)));
  const shadowed = SPEC.replace("await test.step('login', async () => {", [
    "await test.step('login', async () => {",
    "    const requireHttpsOrigin = (_: string) => 'https://attacker.invalid'",
    "    const origin = requireHttpsOrigin(rawEnvironmentUrl)",
  ].join("\n"));
  const shadowModel = candidate(shadowed);
  assert.ok(shadowModel.errors.some((error) => /origin provenance|helper/.test(error)));
  const mutableTitle = parseMultiStepScript("x.spec.ts", [
    "import {test} from '@playwright/test'", "const title = 'login'", "test('x', async () => {",
    "let title = 'login'; await test.step(title, async () => {})", "})",
  ].join("\n"));
  assert.ok(mutableTitle.errors.some((error) => /not a static string/.test(error)));
  const escaped = candidate("function unused() { const outOfScope = 200 }\n"
    + SPEC.replace("expect(response.status()).toBe(200)", "expect(response.status() + outOfScope).toBe(200)"));
  assert.ok(escaped.errors.some((error) => /unresolved expression.*outOfScope/.test(error)),
    "a declaration in an unrelated function cannot resolve a nested assertion identifier");
});

test("shadowed Playwright test/expect/request and mutated response payloads cannot masquerade as the executed primitives", async () => {
  const attacks = [
    SPEC.replace("  await test.step('login'", "  const test = { step: async () => {} }\n  await test.step('login'"),
    SPEC.replace("    expect(response.status()).toBe(200)", "    const expect = (_: unknown) => ({ toBe: (_: unknown) => {} })\n    expect(response.status()).toBe(200)"),
    SPEC.replace("    const response = await request.post(`${origin}/api/login`", "    const request = { post: async (_: string, __: unknown) => ({ status: () => 200, json: async () => ({}) }) }\n    const response = await request.post(`${origin}/api/login`"),
    SPEC.replace("    expect(body.confirmed).toBe(true)", "    body.confirmed = true\n    expect(body.confirmed).toBe(true)"),
    SPEC.replace("    expect(body.confirmed).toBe(true)", "    const payloadAlias = body\n    payloadAlias.confirmed = true\n    expect(body.confirmed).toBe(true)"),
    SPEC.replace("    expect(response.status()).toBe(200)", "    response.status = () => 200\n    expect(response.status()).toBe(200)"),
    SPEC.replace("const response = await request.post(`${origin}/api/login`", "const actualResponse = await request.post(`${origin}/api/login`")
      .replace("    expect(response.status()).toBe(200)", "    const response = { status: () => 200, json: async () => ({}) }\n    expect(response.status()).toBe(200)"),
    SPEC.replace("const body = (await response.json()) as {", "const actualBody = (await response.json()) as {")
      .replace("    expect(body.ok).toBe(true)", "    const body = { ok: true, account, version: 1, token: 'synthetic' }\n    expect(body.ok).toBe(true)"),
    SPEC.replace("const CONTROL_CHARACTERS =", "class URL { constructor(_: string) {} get origin() { return 'https://attacker.invalid' } static canParse() { return true } }\nconst CONTROL_CHARACTERS ="),
  ];
  for (const source of attacks) {
    const parsed = candidate(source);
    assert.ok(parsed.errors.some((error) => /shadowed|fixture|mutated|bound|unknown helper/.test(error)), JSON.stringify(parsed.errors));
    const policy = evaluateMultiStepPolicy(ORIGINAL, parsed);
    assert.ok(policy.uncertain || policy.rejected, "a definite hardcoded-host rejection can outrank an unsupported-source finding");
  }
  const out = await runMultiStepSandbox({ projectDir: WEB, baseUrl: "https://fixture.invalid", checkFile: FILE,
    files: Object.fromEntries(files(attacks[1]!)), env: { REGION: "us-east-1", MULTISTEP_USER_US_EAST_1: "synthetic" } });
  assert.equal(out.inconclusive, true);
  assert.equal(out.environmentOrigin, null, "the shadowed expect was rejected before any runner or bridge was started");
  const relationshipRewrite = candidate(SPEC.replace("loginAccount = body.account as string", "loginAccount = account"));
  assert.match(evaluateMultiStepPolicy(ORIGINAL, relationshipRewrite).rejected ?? "", /binding changed/);
});

test("unsupported Multistep syntax is UNCERTAIN before any scene/runner executes, and the report omits raw source paths", async () => {
  let called = 0;
  const executor: ExperimentExecutor = {
    kind: "scene", isLive: () => true, budgetExhausted: false, nondeterministicScenes: [],
    costReport: emptyExecutionCost,
    runScene: async () => { called++; throw new Error("must not start before source preflight"); },
  };
  const patch = SPEC.replace("expect(body.ok).toBe(true)", "expect(unknownSecretVariable).toBe(true)");
  const result = await verify({ bundle: bundle(), patch, executor, target: "https://fixture.invalid",
    env: { MULTISTEP_USER_US_EAST_1: "user-fixture-001", MULTISTEP_USER_EU_WEST_1: "user-fixture-002" } });
  assert.equal(called, 0);
  assert.equal(result.decision.verdict, "UNCERTAIN");
  assert.equal(result.decision.exitCode, 2);
  assert.ok(!JSON.stringify(result.report.json).includes("unknownSecretVariable"), "parser raw identifiers are not report evidence");

  const emptyProject = mkdtempSync(join(tmpdir(), "verify-fix-no-runner-"));
  const invalid = await runMultiStepSandbox({ projectDir: emptyProject, baseUrl: "https://fixture.invalid",
    checkFile: FILE, files: Object.fromEntries(files(patch)), env: {} });
  assert.match(invalid.reason ?? "", /source is unsupported before execution/);
  assert.equal(invalid.environmentOrigin, null, "source preflight runs before missing dependency lookup");
  const unavailable = await runMultiStepSandbox({ projectDir: emptyProject, baseUrl: "https://fixture.invalid",
    checkFile: FILE, files: Object.fromEntries(files()), env: { REGION: "us-east-1", MULTISTEP_USER_US_EAST_1: "fixture-east" } });
  assert.match(unavailable.reason ?? "", /runner dependencies are unavailable/);
  assert.ok(!JSON.stringify(unavailable).includes(emptyProject), "raw project paths never become sandbox evidence");
  const unsafe = await runMultiStepSandbox({ projectDir: emptyProject, baseUrl: "https://fixture.invalid",
    checkFile: FILE, files: { ...Object.fromEntries(files()), "../../private-source.ts": "raw path marker" }, env: {} });
  assert.match(unsafe.reason ?? "", /source closure exceeds its safe boundary|candidate file path is unsafe/);
  assert.equal(unsafe.environmentOrigin, null);
});

test("an assertion is attributed only within its failed step, with a unique matching source line/target", () => {
  const recording = buildMultiStepRecording({ texts: { testResults: failingTestResults(), logs: failingLogs(), checkRunData: null } });
  assert.ok(recording.ok);
  if (!recording.ok) return;
  const source = [{ path: FILE, content: SPEC }];
  const correct = detectMultiStepFailurePoint(recording.capture, source, FILE);
  assert.ok(correct?.assertion?.assertionId);
  assert.equal(correct?.assertion?.line, 142);
  const wrong = structuredClone(recording.capture);
  wrong.steps[3]!.failureLine = 144; // typeof body.account, but the captured expected value is true
  assert.equal(detectMultiStepFailurePoint(wrong, source, FILE)?.assertion, null);
  const ambiguous = structuredClone(recording.capture);
  ambiguous.steps[3]!.failureLine = null;
  const duplicated = SPEC.replace("expect(body.confirmed).toBe(true)", "expect(body.confirmed).toBe(true)\n    expect(body.confirmed).toBe(true)");
  assert.equal(detectMultiStepFailurePoint(ambiguous, [{ path: FILE, content: duplicated }], FILE)?.assertion, null);
});

test("dedicated reporter audit uses an exact bounded schema, not arbitrary stdout or extra keys", () => {
  const audit = { version: 1, overflow: false, requests: [
    { method: "POST", path: "/api/login", step: "login", originMatches: true, hasQuery: false },
  ] };
  assert.equal(parseReporterAudit(JSON.stringify(audit))?.length, 1);
  assert.equal(parseReporterAudit(JSON.stringify({ ...audit, rawPath: "/private/payload" })), null);
  assert.equal(parseReporterAudit(JSON.stringify({ ...audit, requests: [{ ...audit.requests[0]!, rawUrl: "https://secret.invalid" }] })), null);
  assert.equal(parseReporterAudit(JSON.stringify({ ...audit, overflow: true })), null);
  assert.equal(parseReporterAudit(JSON.stringify({ ...audit, requests: [{ ...audit.requests[0]!, path: "/secret/value" }] })), null);
  assert.equal(parseReporterAudit("x".repeat(MAX_REPORTER_AUDIT_BYTES + 1)), null);
});

test("bridge traffic and JSON requests cannot replace a missing dedicated reporter audit", () => {
  const capture = buildMultiStepRecording({ texts: { testResults: failingTestResults(), logs: null, checkRunData: null } });
  assert.ok(capture.ok);
  if (!capture.ok) return;
  const bridge = [
    { index: 1, method: "POST", path: "/api/login", status: 200, hasQuery: false, queryKeys: [], requestHeaderNames: [], authorization: false },
    { index: 2, method: "GET", path: "/api/session", status: 200, hasQuery: false, queryKeys: [], requestHeaderNames: [], authorization: true },
    { index: 3, method: "GET", path: "/api/slots", status: 200, hasQuery: false, queryKeys: [], requestHeaderNames: [], authorization: false },
    { index: 4, method: "POST", path: "/api/book", status: 200, hasQuery: false, queryKeys: [], requestHeaderNames: [], authorization: true },
  ];
  assert.match(bridgeReporterMismatch(bridge, capture.capture, null) ?? "", /dedicated request audit missing/);
  const wrongOrder = ["/api/session", "/api/login", "/api/slots", "/api/book"] as const;
  const audit = wrongOrder.map((path, i) => ({ method: bridge[i]!.method as "GET" | "POST", path, step: ["login", "session", "slots", "book 09:30"][i]!, originMatches: true, hasQuery: false }));
  assert.match(bridgeReporterMismatch(bridge, capture.capture, audit) ?? "", /disagree|path mismatch/);
  const passing = buildMultiStepRecording({ texts: { testResults: passingTestResults(), logs: null, checkRunData: null } });
  assert.ok(passing.ok);
  if (!passing.ok) return;
  const filtered = structuredClone(passing.capture);
  // JSON reporter implementations can filter their pw:api request children;
  // the dedicated fd-3 audit is still mandatory. A forged passing assertion
  // cannot make a bridge-observed 401 into a passing HTTP status.
  for (const step of filtered.steps) step.requests = [];
  const goodAudit = ["/api/login", "/api/session", "/api/slots", "/api/book"].map((path, i) => ({
    method: bridge[i]!.method as "GET" | "POST", path,
    step: ["login", "session", "slots", "book 09:30"][i]!, originMatches: true, hasQuery: false,
  }));
  const actual401 = bridge.map((item, i) => i === 3 ? { ...item, status: 401 } : item);
  assert.match(bridgeReporterMismatch(actual401, filtered, goodAudit) ?? "", /passing result contradicts HTTP status/);
  const noAuth = bridge.map((item, i) => i === 3 ? { ...item, authorization: false } : item);
  assert.match(bridgeReporterMismatch(noAuth, filtered, goodAudit) ?? "", /authorization-site mismatch/);
});

test("required steps in an unused helper or dead branch are FAILED; an unresolved step title stays UNCERTAIN", () => {
  const slots = "  await test.step('slots', async () => {";
  const book = "  await test.step('book 09:30', async () => {";
  assert.ok(SPEC.includes(slots) && SPEC.includes(book));
  const hidden = [
    SPEC.replace(slots, `  function unusedSlots() {\n${slots}`).replace(book, `  }\n${book}`),
    SPEC.replace(slots, `  if (false) {\n${slots}`).replace(book, `  }\n${book}`),
  ];
  for (const source of hidden) {
    const parsed = candidate(source);
    assert.ok(parsed.script?.steps.some((step) => step.title === "slots" && !step.executed));
    const policy = evaluateMultiStepPolicy(ORIGINAL, parsed);
    assert.match(policy.rejected ?? "", /required test.step\(\) removed or skipped/);
  }
  const unknown = candidate(SPEC.replace(slots, "  await test.step(UNKNOWN_TITLE, async () => {"));
  const undecidable = evaluateMultiStepPolicy(ORIGINAL, unknown);
  assert.equal(undecidable.rejected, null, "a title whose value is unresolved cannot prove removal");
  assert.match(undecidable.uncertain ?? "", /unbound executed test.step|unsupported source syntax/);
});

test("construct environment values must be the matching direct approved process.env provenance", () => {
  const source = "value: process.env.MULTISTEP_USER_US_EAST_1 ?? \"\"";
  assert.ok(CONSTRUCT.includes(source));
  for (const replacement of [
    "value: 'hardcoded-synthetic-account'",
    "value: process.env.UNRELATED ?? \"\"",
    "value: process.env.MULTISTEP_USER_EU_WEST_1 ?? \"\"",
    "value: process.env.MULTISTEP_USER_US_EAST_1 ?? 'fallback-account'",
    "value: process.env['MULTISTEP_USER_US_EAST_1'] ?? \"\"",
  ]) {
    const parsed = candidate(SPEC, CONSTRUCT.replace(source, replacement));
    assert.ok(parsed.construct?.errors.some((error) => /matching approved process\.env/.test(error)), replacement);
    const policy = evaluateMultiStepPolicy(ORIGINAL, parsed);
    assert.ok(policy.rejected || policy.uncertain, replacement);
  }
});

test("malformed script, construct and imported consts are UNCERTAIN before runner execution", async () => {
  const malformedScript = SPEC + "\nlet dangling = (\n";
  const script = candidate(malformedScript);
  assert.ok(script.errors.some((error) => /unparseable Multistep transaction source/.test(error)), JSON.stringify(script.errors));
  const scriptVerdict = evaluateMultiStepPolicy(ORIGINAL, script);
  assert.equal(scriptVerdict.rejected, null);
  assert.match(scriptVerdict.uncertain ?? "", /unsupported source syntax/);
  const out = await runMultiStepSandbox({ projectDir: WEB, baseUrl: "https://fixture.invalid", checkFile: FILE,
    files: Object.fromEntries(files(malformedScript)), originalFiles: Object.fromEntries(files()),
    env: { REGION: "us-east-1", MULTISTEP_USER_US_EAST_1: "user-fixture-001" } });
  assert.equal(out.inconclusive, true);
  assert.equal(out.environmentOrigin, null, "an invalid source never establishes a bridge or spawns the runner");
  assert.equal(out.browserProcesses, null);

  const malformedConstruct = candidate(SPEC, CONSTRUCT + "\nconst dangling = (\n");
  assert.ok(malformedConstruct.errors.some((error) => /unparseable MultiStepCheck construct/.test(error)));
  assert.match(evaluateMultiStepPolicy(ORIGINAL, malformedConstruct).uncertain ?? "", /unsupported source syntax/);

  const imported = "import { STEP_TITLE } from './titles'\n" + SPEC.replace("await test.step('login'", "await test.step(STEP_TITLE");
  const malformedModule = candidate(imported, CONSTRUCT, { "checks/titles.ts": "export const STEP_TITLE = 'login'\nconst dangling = (" });
  assert.ok(malformedModule.errors.some((error) => /unparseable local import/.test(error)), JSON.stringify(malformedModule.errors));
  assert.ok(evaluateMultiStepPolicy(ORIGINAL, malformedModule).uncertain);
});

test("unmodeled property, prototype, global and destructuring writes cannot preserve an apparently unchanged assertion tuple", async () => {
  const additions = [
    "Object.prototype.confirmed = true",
    "delete Object.prototype.confirmed",
    "process.exit = () => {}",
    "Array.prototype.includes++",
    "JSON = { parse: () => ({ ok: true }) }",
    "const shadow = { value: 1 }; shadow.value = 2",
    "let local = 1; ({ local } = { local: 2 })",
  ];
  for (const addition of additions) {
    const model = candidate(SPEC + `\n${addition}\n`);
    assert.ok(model.errors.some((error) => /unmodeled property|global assignment|unparseable/.test(error)),
      `${addition}: ${JSON.stringify(model.errors)}`);
    const verdict = evaluateMultiStepPolicy(ORIGINAL, model);
    assert.equal(verdict.rejected, null, `unsupported side effects are unjudgeable, not invented definitive proof: ${addition}`);
    assert.ok(verdict.uncertain, `property/global mutation cannot silently pass: ${addition}`);
  }
  const patched = SPEC + "\nObject.prototype.confirmed = true\n";
  const out = await runMultiStepSandbox({ projectDir: WEB, baseUrl: "https://fixture.invalid", checkFile: FILE,
    files: Object.fromEntries(files(patched)), originalFiles: Object.fromEntries(files()),
    env: { REGION: "us-east-1", MULTISTEP_USER_US_EAST_1: "user-fixture-001" } });
  assert.equal(out.inconclusive, true);
  assert.equal(out.environmentOrigin, null);
  assert.equal(out.browserProcesses, null);
});

test("a MultiStepCheck hidden in dead or helper code is FAILED, not a present construct", () => {
  const variants = [
    CONSTRUCT.replace("new MultiStepCheck(", "if (false) new MultiStepCheck("),
    CONSTRUCT.replace("new MultiStepCheck(", "function unusedConstruct() { new MultiStepCheck(").replace(/\);\s*$/, "); }\n"),
  ];
  for (const text of variants) {
    const model = candidate(SPEC, text);
    assert.equal(model.construct?.executed, false);
    const verdict = evaluateMultiStepPolicy(ORIGINAL, model);
    assert.match(verdict.rejected ?? "", /construct moved into dead or helper code/);
    assert.equal(verdict.uncertain, null, "a definite construct removal outranks its unsupported syntax");
  }
});

test("construct top-level side effects, substituted path imports and executable dependencies stay UNCERTAIN", async () => {
  const variants = [
    CONSTRUCT + "\nObject.prototype.safe = true\n",
    CONSTRUCT + "\nimport 'node:fs'\n",
    CONSTRUCT.replace('import * as path from "node:path";', 'const path = { join: () => "checks/multistep-booking.spec.ts" };'),
    CONSTRUCT.replace('import * as path from "node:path";', 'import * as path from "./untrusted-path";'),
  ];
  for (const text of variants) {
    const model = candidate(SPEC, text);
    assert.ok(model.errors.some((error) => /construct contains|approved Checkly\/path import/.test(error)), JSON.stringify(model.errors));
    const verdict = evaluateMultiStepPolicy(ORIGINAL, model);
    assert.equal(verdict.rejected, null, "no definite modeled settings change occurred");
    assert.ok(verdict.uncertain, "side effects/dependency origins cannot be trusted");
  }
  const direct = await runMultiStepSandbox({ projectDir: WEB, baseUrl: "https://fixture.invalid", checkFile: FILE,
    files: Object.fromEntries(files(SPEC, variants[0]!)), originalFiles: Object.fromEntries(files()),
    env: { REGION: "us-east-1", MULTISTEP_USER_US_EAST_1: "user-fixture-001" } });
  assert.equal(direct.inconclusive, true);
  assert.equal(direct.environmentOrigin, null, "even a direct scene/runner cannot bypass construct preflight");
});

test("conditional hard assertions cannot launder their unchanged subject/matcher/target tuples", async () => {
  for (const [before, after] of [
    ["expect(body.ok).toBe(true)", "if (false) expect(body.ok).toBe(true)"],
    ["expect(body.confirmed).toBe(true)", "if (false) expect(body.confirmed).toBe(true)"],
    ["expect(response.status()).toBe(200)", "if (false) expect(response.status()).toBe(200)"],
  ]) {
    const altered = SPEC.replace(before!, after!);
    assert.notEqual(altered, SPEC);
    const parsed = candidate(altered);
    assert.equal(parsed.script?.assertions.length, ORIGINAL.script?.assertions.length,
      "masking leaves every byte-identical assertion tuple in the static inventory");
    const verdict = evaluateMultiStepPolicy(ORIGINAL, parsed);
    assert.match(verdict.rejected ?? "", /hard assertion conditionally bypassed/);
    assert.equal(verdict.uncertain, null, "definite masking outranks an indirect-flow warning");
  }
  const altered = SPEC.replace("expect(body.confirmed).toBe(true)", "if (false) expect(body.confirmed).toBe(true)");
  const out = await runMultiStepSandbox({ projectDir: WEB, baseUrl: "https://fixture.invalid", checkFile: FILE,
    files: Object.fromEntries(files(altered)), originalFiles: Object.fromEntries(files()),
    env: { REGION: "us-east-1", MULTISTEP_USER_US_EAST_1: "user-fixture-001" } });
  assert.equal(out.inconclusive, true);
  assert.equal(out.environmentOrigin, null, "the runner cannot execute the conditionally masked assertion");
});

test("an indirect assertion call is UNCERTAIN, and a conditionally skipped required route is FAILED", () => {
  const indirect = candidate(SPEC.replace("expect(body.ok).toBe(true)", "const captured = expect(body.ok).toBe(true)"));
  const undecidable = evaluateMultiStepPolicy(ORIGINAL, indirect);
  assert.ok(indirect.errors.some((error) => /not a directly executed expression/.test(error)));
  assert.equal(undecidable.rejected, null);
  assert.ok(undecidable.uncertain);

  // Keep the original request call syntactically present but behind a dead
  // branch. The static transaction must not treat that call as executed.
  const routed = candidate(SPEC.replace("    const response = await request.post(`${origin}/api/book`, {", "    if (false) {\n    const response = await request.post(`${origin}/api/book`, {")
    .replace("    expect(response.status()).toBe(200)\n    const body = (await response.json()) as {\n      confirmed?: unknown", "    }\n    expect(response.status()).toBe(200)\n    const body = (await response.json()) as {\n      confirmed?: unknown"));
  assert.ok(routed.script?.banned.some((marker) => /required request conditionally bypassed/.test(marker)), JSON.stringify(routed.script?.banned));
  assert.match(evaluateMultiStepPolicy(ORIGINAL, routed).rejected ?? "", /required request conditionally bypassed/);
});

test("direct sandbox rejects definite source-policy markers even without an originalFiles comparison", async () => {
  const marked = SPEC + "\nconst covertRetryOption = { retries: 3 }\n";
  const parsed = candidate(marked);
  assert.deepEqual(parsed.errors, [], "there is no parser error to accidentally satisfy this test");
  assert.ok(parsed.script?.banned.includes("retries in code"));
  assert.match(evaluateMultiStepPolicy(ORIGINAL, parsed).rejected ?? "", /retries in code/);
  const out = await runMultiStepSandbox({ projectDir: WEB, baseUrl: "https://fixture.invalid", checkFile: FILE,
    files: { [FILE]: marked },
    env: { REGION: "us-east-1", MULTISTEP_USER_US_EAST_1: "user-fixture-001" } });
  assert.equal(out.inconclusive, true);
  assert.equal(out.environmentOrigin, null, "a direct adapter entry must not bypass its own source-policy markers");
  assert.equal(out.browserProcesses, null);
});

test("returns before the transaction or within a required step cannot preserve the original contract", () => {
  for (const altered of [
    SPEC.replace("  await test.step('login'", "  return\n  await test.step('login'"),
    SPEC.replace("    expect(response.status()).toBe(200)", "    return\n    expect(response.status()).toBe(200)"),
  ]) {
    assert.notEqual(altered, SPEC);
    const parsed = candidate(altered);
    assert.equal(parsed.script?.assertions.length, ORIGINAL.script?.assertions.length);
    assert.match(evaluateMultiStepPolicy(ORIGINAL, parsed).rejected ?? "", /returns before all assertions complete/);
  }
});

test("short-circuit and ternary hard assertions cannot hide unchanged assertion tuples", () => {
  for (const bypass of [
    "false && expect(body.ok).toBe(true)",
    "false ? expect(body.ok).toBe(true) : null",
  ]) {
    const parsed = candidate(SPEC.replace("expect(body.ok).toBe(true)", bypass));
    assert.equal(parsed.script?.assertions.length, ORIGINAL.script?.assertions.length);
    assert.match(evaluateMultiStepPolicy(ORIGINAL, parsed).rejected ?? "", /hard assertion conditionally bypassed/);
  }
});
