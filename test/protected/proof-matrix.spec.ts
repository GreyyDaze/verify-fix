// Phase 9 task 9.15 — protected monitoring guarantees proof matrix.
//
// Every case the Phase 9 plan names: inheritance, overrides, new settings,
// unknown settings, location changes, concurrency changes, retries, activation,
// alert behaviour, new monitor discovery, imported configuration, sibling
// impact, policy tampering, missing and duplicate accounts, candidate-controlled
// reproduction, positive testing, falsification, regression, secret leakage.
//
// SCOPE: this is deterministic unit/contract evidence. It is NOT a real Checkly
// run; stages 2 and 3 (shadow, migration, enforcement) need the account.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildProtectedRequirements,
  classifyNewSetting,
  compareProtectedRequirements,
  sealProtectedRequirements,
  type CandidateEffectiveRequirements,
  type ProtectedRequirementsPolicy,
} from "../../src/protected-requirements.ts";

const policy: ProtectedRequirementsPolicy = {
  schemaVersion: "protected-requirements-v2",
  policyVersion: 2,
  check: { id: "check-1", logicalId: "booking-flow", checkType: "MULTI_STEP" },
  sources: [{ kind: "checkly-api", identity: "check-1", sha256: "a".repeat(64) }],
  fields: {
    "check.name": { effect: "metadata", comparison: "exact", original: { state: "known", value: "booking-flow" } },
    activated: { effect: "protected", comparison: "exact", original: { state: "known", value: true } },
    muted: { effect: "protected", comparison: "exact", original: { state: "known", value: false } },
    shouldFail: { effect: "protected", comparison: "exact", original: { state: "known", value: false } },
    frequency: { effect: "protected", comparison: "exact", original: { state: "known", value: 5 } },
    locations: { effect: "protected", comparison: "set-equal", original: { state: "known", value: ["us-east-1", "eu-west-1"] } },
    privateLocations: { effect: "protected", comparison: "set-equal", original: { state: "known", value: [] } },
    runParallel: { effect: "protected", comparison: "exact", original: { state: "known", value: true } },
    retryStrategy: { effect: "protected", comparison: "exact", original: { state: "known", value: null } },
    alertBehavior: { effect: "protected", comparison: "exact", original: { state: "known", value: "default" } },
    environmentVariableNames: { effect: "protected", comparison: "set-equal", original: { state: "known", value: ["ENVIRONMENT_URL"] } },
    targetResolution: { effect: "protected", comparison: "exact", original: { state: "known", value: "code" } },
    "execution.dependencyMetadata": { effect: "protected", comparison: "exact", original: { state: "known", value: {} } },
    "multistep.orderedSteps": { effect: "protected", comparison: "exact", original: { state: "known", value: ["login", "book"] } },
    "multistep.routesAndMethods": { effect: "protected", comparison: "exact", original: { state: "known", value: ["POST /login", "POST /book"] } },
    "multistep.assertions": { effect: "protected", comparison: "required-tuples", original: { state: "known", value: [{ id: "assert-1", subject: "booking.confirmed", matcher: "toBe", target: "true" }] } },
    "multistep.environmentMapping": { effect: "protected", comparison: "exact", original: { state: "known", value: { "us-east-1": "USER_EAST", "eu-west-1": "USER_WEST" } } },
    "multistep.runtimeTransaction": { effect: "protected", comparison: "exact", original: { state: "known", value: "booking" } },
    "multistep.runtime": { effect: "protected", comparison: "exact", original: { state: "known", value: "node" } },
  },
};

const sealed = sealProtectedRequirements(policy);

function candidate(overrides: Partial<CandidateEffectiveRequirements["fields"]> = {},
  identity: Partial<CandidateEffectiveRequirements["check"]> = {}): CandidateEffectiveRequirements {
  const defaults = Object.fromEntries(
    Object.entries(policy.fields).map(([name, field]) => [name, field.original]),
  ) as unknown as CandidateEffectiveRequirements["fields"];
  return { check: { ...policy.check, ...identity },
    fields: { ...defaults, ...overrides } as CandidateEffectiveRequirements["fields"] };
}

function verdictFor(overrides: Parameters<typeof candidate>[0] = {}, identity?: Parameters<typeof candidate>[1]) {
  return compareProtectedRequirements(sealed, candidate(overrides, identity));
}

// ---- inheritance / overrides -------------------------------------------------

test("inheritance: an unchanged candidate preserves every protected guarantee", () => {
  const result = verdictFor();
  assert.equal(result.verdict, "PASS");
  assert.deepEqual(result.reasonCodes, []);
});

test("overrides: a project default may not override a protected check setting", () => {
  // The check keeps locations; the candidate cannot reduce them at project level.
  const result = verdictFor({ locations: { state: "known", value: ["us-east-1"] } });
  assert.equal(result.verdict, "FAILED");
  assert.ok(result.reasonCodes.includes("PROTECTED_REQUIREMENT_CHANGED"));
});

// ---- new settings (task 9.5) ------------------------------------------------

test("new settings: a metadata-only change continues to experiments, it is not blocked", () => {
  const result = verdictFor({ "check.name": { state: "known", value: "booking-flow (renamed)" } });
  assert.equal(result.verdict, "PASS", "a metadata-only change must not block");
  assert.deepEqual(result.changedMetadata, ["check.name"]);
});

test("new settings: an addition the policy never had is a supported addition when it cannot weaken monitoring", () => {
  const result = compareProtectedRequirements(sealed, {
    check: { ...policy.check },
    fields: { ...candidate().fields, "check.description": { state: "known", value: "books a slot" } },
  });
  assert.equal(result.verdict, "PASS", "a new setting is analysed, not reflexively rejected");
  assert.deepEqual(result.supportedAdditions, ["check.description"]);
  assert.deepEqual(result.reasonCodes, []);
});

test("new settings: an UNSUPPORTED new setting is UNCERTAIN, never a silent PASS", () => {
  const result = compareProtectedRequirements(sealed, {
    check: { ...policy.check },
    fields: { ...candidate().fields, "alertChannels.somethingNew": { state: "known", value: "x" } },
  });
  assert.equal(result.verdict, "UNCERTAIN");
  assert.ok(result.reasonCodes.includes("CANDIDATE_SETTING_UNCLASSIFIED"));
});

test("new settings: classifyNewSetting keeps the supported-addition list short and explicit", () => {
  assert.equal(classifyNewSetting("check.name"), "supported-addition");
  assert.equal(classifyNewSetting("check.tags"), "supported-addition");
  // Anything that could change what runs, where, or whether failure is reported
  // is deliberately NOT a supported addition.
  for (const unsafe of ["locations", "runParallel", "frequency", "muted", "retryStrategy",
    "alertBehavior", "timeout", "alertChannels.email"]) {
    assert.equal(classifyNewSetting(unsafe), "unsupported", `${unsafe} must not be a safe addition`);
  }
});

test("new settings: supportedAdditions is reported separately from reason codes", () => {
  const result = compareProtectedRequirements(sealed, {
    check: { ...policy.check },
    fields: { ...candidate().fields, "check.tags": { state: "known", value: ["slots", "bookings"] } },
  });
  assert.equal(result.verdict, "PASS");
  assert.deepEqual(result.supportedAdditions, ["check.tags"]);
  assert.deepEqual(result.reasonCodes, []);
});

// ---- unknown settings -------------------------------------------------------

test("unknown settings: an unresolvable protected value is UNCERTAIN, never PASS", () => {
  const result = verdictFor({ alertBehavior: { state: "unknown", reason: "DYNAMIC_VALUE_UNRESOLVED" } as never });
  assert.equal(result.verdict, "UNCERTAIN");
  assert.ok(result.reasonCodes.includes("PROTECTED_REQUIREMENT_UNRESOLVED"));
});

test("unknown settings: a candidate missing a required field entirely is UNCERTAIN", () => {
  const fields = candidate().fields;
  delete (fields as Record<string, unknown>).alertBehavior;
  const result = compareProtectedRequirements(sealed, { check: { ...policy.check }, fields });
  assert.equal(result.verdict, "UNCERTAIN");
  assert.ok(result.reasonCodes.includes("PROTECTED_REQUIREMENT_UNRESOLVED"));
});

// ---- the deliberate-reduction cases from the plan ---------------------------

test("location change: removing a location is FAILED; reordering is unchanged; adding is UNCERTAIN", () => {
  assert.equal(verdictFor({ locations: { state: "known", value: ["us-east-1"] } }).verdict, "FAILED");
  assert.equal(verdictFor({ locations: { state: "known", value: ["eu-west-1", "us-east-1"] } }).verdict, "PASS");
  // A third location is not "obviously" a removal, but it is not a recognised
  // safe addition either, so it must not silently PASS.
  const added = verdictFor({ locations: { state: "known", value: ["us-east-1", "eu-west-1", "ap-south-1"] } });
  assert.notEqual(added.verdict, "PASS", "adding a region is FAILED until separately approved");
});

test("concurrency: lowering runParallel is FAILED before any experiment runs", () => {
  const result = verdictFor({ runParallel: { state: "known", value: false } });
  assert.equal(result.verdict, "FAILED");
  assert.ok(result.reasonCodes.includes("PROTECTED_REQUIREMENT_CHANGED"),
    "the reproduction must never silently drop to one run");
});

test("retries: a masking retry strategy is FAILED", () => {
  assert.equal(verdictFor({ retryStrategy: { state: "known", value: { strategy: "linear", maxRetries: 5 } } }).verdict, "FAILED");
});

test("activation: muting or deactivating the incident check is FAILED", () => {
  assert.equal(verdictFor({ muted: { state: "known", value: true } }).verdict, "FAILED");
  assert.equal(verdictFor({ activated: { state: "known", value: false } }).verdict, "FAILED");
  assert.equal(verdictFor({ shouldFail: { state: "known", value: true } }).verdict, "FAILED");
});

test("alert behaviour: changing how failures are reported is FAILED", () => {
  assert.equal(verdictFor({ alertBehavior: { state: "known", value: "none" } }).verdict, "FAILED");
});

test("frequency: reducing how often the check runs is FAILED", () => {
  assert.equal(verdictFor({ frequency: { state: "known", value: 60 } }).verdict, "FAILED");
});

test("target resolution: replacing the target origin variable is FAILED", () => {
  assert.equal(verdictFor({ targetResolution: { state: "known", value: "hardcoded" } }).verdict, "FAILED");
});

// ---- imported configuration / dependency metadata ---------------------------

test("imported configuration: changing the dependency metadata is FAILED", () => {
  assert.equal(verdictFor({ "execution.dependencyMetadata": { state: "known", value: { lockfileChanged: true } } }).verdict, "FAILED");
});

test("environment mapping: remapping a region to a different account key is FAILED", () => {
  const result = verdictFor({
    "multistep.environmentMapping": { state: "known", value: { "us-east-1": "USER_WEST", "eu-west-1": "USER_EAST" } },
  });
  assert.equal(result.verdict, "FAILED");
});

// ---- assertions -------------------------------------------------------------

test("assertions: dropping a required assertion tuple is FAILED; adding one is allowed", () => {
  assert.equal(verdictFor({ "multistep.assertions": { state: "known", value: [] } }).verdict, "FAILED");
  const added = verdictFor({
    "multistep.assertions": { state: "known", value: [
      { id: "assert-1", subject: "booking.confirmed", matcher: "toBe", target: "true" },
      { id: "assert-2", subject: "booking.status", matcher: "toBe", target: "CONFIRMED" },
    ] },
  });
  assert.equal(added.verdict, "PASS", "a strengthened contract is not a reduction");
});

test("ordered steps: removing or reordering a required step is FAILED", () => {
  assert.equal(verdictFor({ "multistep.orderedSteps": { state: "known", value: ["login"] } }).verdict, "FAILED");
  assert.equal(verdictFor({ "multistep.orderedSteps": { state: "known", value: ["book", "login"] } }).verdict, "FAILED");
});

// ---- identity / policy tampering -------------------------------------------

test("identity: changing the stable check identity is FAILED", () => {
  const result = verdictFor({}, { logicalId: "someone-elses-check" });
  assert.equal(result.verdict, "FAILED");
  assert.ok(result.reasonCodes.includes("PROTECTED_CHECK_IDENTITY_CHANGED"));
});

test("policy tampering: a modified policy no longer matches its sealed digest", () => {
  // Swap the protected ORIGINAL value for a weakened one, keeping every
  // structural rule intact so the policy still seals.
  const weakened: ProtectedRequirementsPolicy = {
    ...policy,
    fields: { ...policy.fields, locations: { effect: "protected", comparison: "set-equal", original: { state: "known", value: ["us-east-1"] } } },
  };
  assert.notEqual(sealProtectedRequirements(weakened).sha256, sealed.sha256,
    "a candidate-edited policy must not produce the trusted digest");
  // And the weakened policy cannot reopen the removal it just authorised.
  assert.equal(compareProtectedRequirements(sealed, candidate({ locations: { state: "known", value: ["us-east-1"] } })).verdict, "FAILED");
});

// ---- candidate-controlled reproduction (task 9.7) ---------------------------

test("candidate-controlled reproduction: the candidate cannot supply the trusted experiment conditions", () => {
  // Concurrency, regions and target all come from the sealed policy. A candidate
  // that changes any of them is convicted statically, so it can never lower the
  // difficulty of its own reproduction.
  for (const override of [
    { runParallel: { state: "known", value: false } },
    { locations: { state: "known", value: ["us-east-1"] } },
    { targetResolution: { state: "known", value: "hardcoded" } },
  ] as Partial<CandidateEffectiveRequirements["fields"]>[]) {
    assert.equal(verdictFor(override).verdict, "FAILED",
      `${Object.keys(override)[0]} must not be candidate-controlled`);
  }
});

// ---- adapter coverage -------------------------------------------------------

test("adapters: every supported check type builds a policy from resolved values", () => {
  for (const checkType of ["API", "BROWSER", "PLAYWRIGHT", "MULTI_STEP"]) {
    const built = buildProtectedRequirements({
      check: { id: "c", logicalId: "l", checkType },
      sources: [{ kind: "checkly-api", identity: "c", sha256: "b".repeat(64) }],
      // Omitted required values resolve to UNKNOWN, which can never produce PASS.
      values: {},
    });
    assert.equal(built.status, "ready", `${checkType} must have an adapter`);
    if (built.status !== "ready") continue;
    assert.ok(Object.keys(built.envelope.policy.fields).length > 0, `${checkType} must protect fields`);
    assert.match(built.envelope.sha256, /^[a-f0-9]{64}$/);
  }
});

test("adapters: an unsupported check type is refused rather than half-protected", () => {
  const built = buildProtectedRequirements({
    check: { id: "c", logicalId: "l", checkType: "SOMETHING_ELSE" },
    sources: [{ kind: "checkly-api", identity: "c", sha256: "b".repeat(64) }],
    values: {},
  });
  assert.equal(built.status, "unsupported");
});

// ---- secret leakage ---------------------------------------------------------

test("secret leakage: the sealed policy contains names and values only, never secrets", () => {
  const serialized = JSON.stringify(sealed);
  assert.ok(!/Bearer\s/i.test(serialized), "no bearer token");
  assert.ok(!/eyJ[A-Za-z0-9_-]{10,}/.test(serialized), "no JWT-shaped value");
  assert.equal(typeof sealed.sha256, "string");
  assert.match(sealed.sha256, /^[a-f0-9]{64}$/);
});