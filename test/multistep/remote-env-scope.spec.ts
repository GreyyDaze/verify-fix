// Local-only isolation of environment names at the Checkly CLI child boundary.
// No cloud session, credentials, or Checkly account are used.
import assert from "node:assert/strict";
import test from "node:test";
import { scopedChecklyEnvironment } from "../../src/executor/checkly-cli.ts";
import type { Bundle } from "../../src/types.ts";

const bundle = { check: { checkType: "MULTI_STEP" } } as Bundle;

test("Multistep cloud child sees two region identities and approved bypass, never shared browser/API secrets", () => {
  const input = { MULTISTEP_USER_US_EAST_1: "synthetic-ms-east", MULTISTEP_USER_EU_WEST_1: "synthetic-ms-west",
    CHECKLY_SECRET_VERCEL_AUTOMATION_BYPASS_SECRET: "synthetic-bypass", ENVIRONMENT_NAME: "preview",
    TEST_USER: "synthetic-browser", TEST_USER_US_EAST_1: "synthetic-browser-east", API_TOKEN: "synthetic-api",
    CHECKLY_API_KEY: "synthetic-cloud-auth", ENVIRONMENT_URL: "https://untrusted-override.invalid",
    PATH: "/untrusted/path" };
  assert.deepEqual(scopedChecklyEnvironment(bundle, input), {
    MULTISTEP_USER_US_EAST_1: "synthetic-ms-east", MULTISTEP_USER_EU_WEST_1: "synthetic-ms-west",
    CHECKLY_SECRET_VERCEL_AUTOMATION_BYPASS_SECRET: "synthetic-bypass", ENVIRONMENT_NAME: "preview",
  });
  assert.equal(scopedChecklyEnvironment(bundle, { ...input, MULTISTEP_USER_EU_WEST_1: input.MULTISTEP_USER_US_EAST_1 }), null);
  assert.equal(scopedChecklyEnvironment(bundle, { ...input, MULTISTEP_USER_US_EAST_1: "" }), null);
  assert.equal(scopedChecklyEnvironment(bundle, { ...input, MULTISTEP_USER_US_EAST_1: " synthetic-ms-east" }), null);
  // The legacy API/browser sandbox keeps its separate environment contract.
  const api = { check: { checkType: "API" } } as Bundle;
  assert.deepEqual(scopedChecklyEnvironment(api, input), input);
});
