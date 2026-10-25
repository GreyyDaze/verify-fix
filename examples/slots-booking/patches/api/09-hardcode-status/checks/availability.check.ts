import { ApiCheck, AssertionBuilder, Frequency } from "checkly/constructs";
import * as path from "node:path";

// FAKE 09 — HARDCODED EXPECTATION. Every assertion compares a literal with a
// literal instead of reading the response. Nothing about the application's
// actual reply is asserted, so the check is green whether the API returns
// "AVAILABLE", "UNAVAILABLE", or no field at all. It is unfalsifiable by
// construction: no recorded failure could ever make it fail.
//
// Compare 01-good-field-rename, which asserts the SAME "AVAILABLE" value but
// reads it from the response with `jsonBody("status")`.
export const availabilityAssertions = [
  AssertionBuilder.jsonBody("status").equals("AVAILABLE"),
  AssertionBuilder.jsonBody("availability").equals("AVAILABLE"),
  AssertionBuilder.jsonBody("status").equals("AVAILABLE"),
];

new ApiCheck("slots-availability-api", {
  name: "slots availability API",
  activated: true,
  muted: false,
  frequency: Frequency.EVERY_5M,
  locations: ["us-east-1", "eu-west-1"],
  tags: ["slots-booking", "api"],
  environmentVariables: [
    { key: "ENVIRONMENT_URL", value: process.env.ENVIRONMENT_URL ?? "" },
    { key: "API_TOKEN", value: process.env.API_TOKEN ?? "", secret: true },
  ],
  setupScript: {
    entrypoint: path.join(__dirname, "availability.setup.ts"),
  },
  request: {
    method: "GET",
    url: "{{ENVIRONMENT_URL}}/api/v1/availability?slot=09:30",
    assertions: availabilityAssertions,
  },
});