import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildProtectedRequirements,
  compareProtectedRequirements,
  PROTECTED_REQUIREMENT_ADAPTERS,
  sealProtectedRequirements,
  type CandidateEffectiveRequirements,
  type ProtectedRequirementsPolicy,
} from "../src/protected-requirements.ts";

const policy: ProtectedRequirementsPolicy = {
  schemaVersion: "protected-requirements-v2",
  policyVersion: 2,
  check: { id: "check-1", logicalId: "booking-flow", checkType: "MULTI_STEP" },
  sources: [{ kind: "checkly-api", identity: "check-1", sha256: "a".repeat(64) }],
  fields: {
    activated: { effect: "protected", comparison: "exact", original: { state: "known", value: true } },
    locations: { effect: "protected", comparison: "set-equal", original: { state: "known", value: ["us-east-1", "eu-west-1"] } },
    assertions: { effect: "protected", comparison: "required-tuples", original: { state: "known", value: [{ id: "assert-1", subject: "booking.confirmed", matcher: "toBe", target: "CONFIRMED" }] } },
    frequency: { effect: "metadata", comparison: "exact", original: { state: "known", value: 5 } },
  },
};

function candidate(fields: CandidateEffectiveRequirements["fields"]): CandidateEffectiveRequirements {
  return { check: { ...policy.check }, fields };
}

const unchanged = candidate({
  activated: { state: "known", value: true },
  locations: { state: "known", value: ["eu-west-1", "us-east-1"] },
  assertions: { state: "known", value: [
    { id: "assert-1", subject: "booking.confirmed", matcher: "toBe", target: "CONFIRMED" },
    { id: "assert-2", subject: "session.user", matcher: "toBeDefined", target: true },
  ] },
  frequency: { state: "known", value: 10 },
});

test("protected policy digest seals a normalized versioned policy", () => {
  const sealed = sealProtectedRequirements(policy);
  assert.match(sealed.sha256, /^[a-f0-9]{64}$/);
  assert.equal(compareProtectedRequirements(sealed, unchanged).verdict, "PASS");
});

test("a definite protected change fails while reporting only fixed reason codes", () => {
  const sealed = sealProtectedRequirements(policy);
  const result = compareProtectedRequirements(sealed, candidate({ ...unchanged.fields,
    locations: { state: "known", value: ["us-east-1"] },
  }));
  assert.equal(result.verdict, "FAILED");
  assert.deepEqual(result.reasonCodes, ["PROTECTED_REQUIREMENT_CHANGED"]);
});

test("missing or unresolved protected configuration is uncertain", () => {
  const sealed = sealProtectedRequirements(policy);
  const result = compareProtectedRequirements(sealed, candidate({
    ...unchanged.fields,
    activated: { state: "unknown", reason: "CONFIG_NOT_RETURNED" },
  }));
  assert.equal(result.verdict, "UNCERTAIN");
  assert.deepEqual(result.reasonCodes, ["PROTECTED_REQUIREMENT_UNRESOLVED"]);
});

test("unclassified candidate settings are uncertain instead of silently accepted", () => {
  const sealed = sealProtectedRequirements(policy);
  const result = compareProtectedRequirements(sealed, candidate({ ...unchanged.fields,
    playwrightConfigPath: { state: "known", value: "playwright.config.ts" },
  }));
  assert.equal(result.verdict, "UNCERTAIN");
  assert.deepEqual(result.reasonCodes, ["CANDIDATE_SETTING_UNCLASSIFIED"]);
});

test("metadata-only differences are reported without blocking", () => {
  const result = compareProtectedRequirements(sealProtectedRequirements(policy), unchangedCandidate);
  assert.equal(result.verdict, "PASS");
  assert.deepEqual(result.changedMetadata, ["frequency"]);
});

test("tampered policy content fails its pinned digest", () => {
  const sealed = sealProtectedRequirements(policy);
  const tampered = structuredClone(sealed);
  tampered.policy.fields.activated.original = { state: "known", value: false };
  assert.throws(() => compareProtectedRequirements(tampered, unchanged), /PROTECTED_POLICY_DIGEST_MISMATCH/);
});

test("supported Checkly types build common and type-specific requirements without inventing defaults", () => {
  for (const [checkType, adapter] of Object.entries(PROTECTED_REQUIREMENT_ADAPTERS)) {
    const built = buildProtectedRequirements({
      check: { id: "check-1", logicalId: "booking-flow", checkType },
      sources: [{ kind: "checkly-api", identity: "check-1", sha256: "a".repeat(64) }],
      values: {},
    });
    assert.equal(built.status, "ready");
    if (built.status !== "ready") continue;
    assert.equal(built.adapter, adapter.id);
    assert.deepEqual(built.envelope.policy.fields.locations.original, {
      state: "unknown", reason: "CONFIG_NOT_RETURNED",
    });
    for (const field of adapter.fields) {
      assert.deepEqual(built.envelope.policy.fields[field.name]?.original, {
        state: "unknown", reason: "CONFIG_NOT_RETURNED",
      });
    }
  }
});

test("unknown original settings are preserved as unresolved requirements", () => {
  const built = buildProtectedRequirements({
    check: { id: "check-1", logicalId: "booking-flow", checkType: "MULTI_STEP" },
    sources: [{ kind: "checkly-api", identity: "check-1", sha256: "a".repeat(64) }],
    values: {},
    unsupportedSettings: ["multistep.futureSetting"],
  });
  assert.equal(built.status, "ready");
  if (built.status !== "ready") return;
  assert.deepEqual(built.envelope.policy.fields["multistep.futureSetting"]?.original, {
    state: "unknown", reason: "UNSUPPORTED_SETTING",
  });
});

test("unknown Checkly resource types cannot build a pass-capable policy", () => {
  const built = buildProtectedRequirements({
    check: { id: "check-1", logicalId: "booking-flow", checkType: "FUTURE_TYPE" },
    sources: [{ kind: "checkly-api", identity: "check-1", sha256: "a".repeat(64) }],
    values: {},
  });
  assert.deepEqual(built, { status: "unsupported", reasonCode: "UNSUPPORTED_CHECK_TYPE" });
});

test("a policy without trusted source identities is rejected", () => {
  assert.throws(() => buildProtectedRequirements({
    check: { id: "check-1", logicalId: "booking-flow", checkType: "API" },
    sources: [],
    values: {},
  }), /PROTECTED_POLICY_INVALID/);
});
