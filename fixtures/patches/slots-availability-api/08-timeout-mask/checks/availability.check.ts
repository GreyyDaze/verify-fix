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
  // FAKE 08 — TIMEOUT MASK. `maxResponseTime` is a top-level ApiCheck option
  // (Checkly docs: Api Check Construct > Configuration, default 20000). A
  // generous value stops the request from ever reporting the error it is
  // supposed to report. The assertions are intact, but a failing response now
  // surfaces as a timeout rather than as a contract violation.
  maxResponseTime: 120_000,
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