import { ApiCheck, AssertionBuilder, Frequency } from "checkly/constructs";
import * as path from "node:path";

const SLOT = "09:30";
const EXPECTED_STATUS = "AVAILABLE";

export const availabilityAssertions = [
  AssertionBuilder.statusCode().equals(200),
  AssertionBuilder.headers("content-type").equals("application/json"),
  AssertionBuilder.jsonBody("slot").equals(SLOT),
  AssertionBuilder.jsonBody("status").equals(EXPECTED_STATUS),
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
    // FAKE 04 — REDIRECT TO A DIFFERENT ENDPOINT. The check no longer monitors
    // the route that failed. /health stays green while the availability
    // contract is broken, so the original alarm is silently disarmed.
    url: "{{ENVIRONMENT_URL}}/api/health?slot=09:30",
    assertions: availabilityAssertions,
  },
});