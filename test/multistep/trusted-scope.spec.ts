// Phase 9 task 9.2: "Do not hardcode fixture names, regions, routes, or
// account-variable names."
//
// The verifier previously pinned the slots-booking EXAMPLE app's regions
// (`us-east-1` / `eu-west-1`) in five admission gates. A tool sold to customers
// would reject every other customer's locations as untrusted. These tests prove
// the trust root is now the incident BUNDLE's own declared configuration, and
// that derivation stays fail-closed.
import { test } from "node:test";
import assert from "node:assert/strict";
import { trustedMultistepScope, isTrustedMultistepLocation, isTrustedMultistepEnvKey, isSyntacticallyValidRegion } from "../../src/multistep/trusted-scope.ts";
import { multistepRegionForLocation } from "../../src/executor/scene.ts";

const EXAMPLE = {
  locations: ["us-east-1", "eu-west-1"],
  environmentVariables: [{ key: "MULTISTEP_USER_US_EAST_1" }, { key: "MULTISTEP_USER_EU_WEST_1" }],
};

test("a bundle's declared regions and env keys are trusted", () => {
  const scope = trustedMultistepScope(EXAMPLE);
  assert.equal(scope.derived, true);
  assert.equal(isTrustedMultistepLocation(scope, "us-east-1"), true);
  assert.equal(isTrustedMultistepLocation(scope, "eu-west-1"), true);
  assert.equal(isTrustedMultistepEnvKey(scope, "MULTISTEP_USER_US_EAST_1"), true);
  assert.equal(isTrustedMultistepEnvKey(scope, "MULTISTEP_USER_EU_WEST_1"), true);
  assert.equal(isTrustedMultistepEnvKey(scope, "ENVIRONMENT_URL"), true, "structural keys stay trusted");
});

test("a DIFFERENT customer's region set is trusted without any code change", () => {
  // The whole point: a customer on different Checkly regions must be admitted.
  const scope = trustedMultistepScope({
    locations: ["ap-southeast-2", "eu-central-1"],
    environmentVariables: [{ key: "MY_ACCT_AP_SOUTHEAST_2" }, { key: "MY_ACCT_EU_CENTRAL_1" }],
  });
  assert.equal(scope.derived, true);
  assert.equal(isTrustedMultistepLocation(scope, "ap-southeast-2"), true);
  assert.equal(isTrustedMultistepLocation(scope, "eu-central-1"), true);
  assert.equal(isTrustedMultistepLocation(scope, "us-east-1"), false, "the example region is NOT special");
  assert.equal(isTrustedMultistepEnvKey(scope, "MY_ACCT_AP_SOUTHEAST_2"), true);
  assert.equal(isTrustedMultistepEnvKey(scope, "MULTISTEP_USER_US_EAST_1"), false, "account var names are not hardcoded either");
});

test("the previously hardcoded plan-blocked region is admitted when the bundle declares it", () => {
  // Checkly Hobby stopped allowing eu-west-1. A customer still on it must work.
  const scope = trustedMultistepScope({ locations: ["us-east-1", "eu-west-1"], environmentVariables: [] });
  assert.equal(isTrustedMultistepLocation(scope, "eu-west-1"), true);
});

test("derivation FAILS CLOSED on a missing, empty, or malformed location set", () => {
  for (const bad of [null, undefined, {}, { locations: [] }, { locations: "us-east-1" },
    { locations: ["us-east-1", "us-east-1"] }, { locations: ["../../etc/passwd"] },
    { locations: ["us-east-1", "bad region"] }, { locations: [42] }, { locations: new Array(500).fill("us-east-1") }]) {
    const scope = trustedMultistepScope(bad as never);
    assert.equal(scope.derived, false, `${JSON.stringify(bad)} must not derive trust`);
    assert.equal(scope.locations.size, 0, "an unusable location set trusts NOTHING");
    assert.equal(isTrustedMultistepLocation(scope, "us-east-1"), false, "never falls back to a default region list");
  }
});

test("only env-var NAMES are retained; a hostile key is dropped, never the value", () => {
  const scope = trustedMultistepScope({
    locations: ["us-east-1"],
    environmentVariables: [{ key: "GOOD_KEY" }, { key: "bad key with spaces" }, { key: "" }, "PLAIN_STRING_KEY", 42, null],
  });
  assert.equal(isTrustedMultistepEnvKey(scope, "GOOD_KEY"), true);
  assert.equal(isTrustedMultistepEnvKey(scope, "PLAIN_STRING_KEY"), true);
  for (const rejected of ["bad key with spaces", "", "a".repeat(200)]) {
    assert.equal(isTrustedMultistepEnvKey(scope, rejected), false);
  }
  // Nothing in the scope is ever a value.
  for (const key of scope.envKeys) assert.match(key, /^[A-Za-z_][A-Za-z0-9_]{0,127}$/);
});

test("run-location recognition is syntactic; trust is decided separately", () => {
  for (const region of ["us-east-1", "eu-west-1", "eu-central-1", "ap-southeast-2", "ap-south-1", "us-west-1"]) {
    assert.equal(multistepRegionForLocation(region), region, `${region} is a valid provider region`);
  }
  for (const junk of ["", "not a region", "../../etc", "us-east-1/../x", "US-EAST-1", "us_east_1", "us-east", "us-east-11"]) {
    assert.equal(multistepRegionForLocation(junk), null, `${junk} must be rejected`);
  }
  assert.equal(isSyntacticallyValidRegion("us-east-1"), true);
  assert.equal(isSyntacticallyValidRegion("US-EAST-1"), false);
});

test("the derived scope cannot be widened in place", () => {
  const scope = trustedMultistepScope(EXAMPLE);
  // Object.freeze does not stop Set.add, so the scope exposes an immutable
  // facade: `add` is simply not present, and mutating the source array later
  // cannot change the derived trust.
  assert.equal(typeof (scope.locations as unknown as { add?: unknown }).add, "undefined");
  assert.throws(() => (scope.locations as unknown as Set<string>).add("attacker-region"));
  const source = { locations: ["us-east-1"], environmentVariables: [] as unknown[] };
  const derived = trustedMultistepScope(source);
  (source.locations as string[]).push("attacker-region");
  assert.equal(isTrustedMultistepLocation(derived, "attacker-region"), false,
    "mutating the input after derivation must not widen trust");
  assert.equal(isTrustedMultistepLocation(derived, "us-east-1"), true);
});