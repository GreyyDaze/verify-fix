import { ApiCheck, AssertionBuilder, Frequency } from "checkly/constructs";
import * as path from "node:path";

const SLOT = "09:30";

export const availabilityAssertions = [
  AssertionBuilder.statusCode().equals(200),
  AssertionBuilder.headers("content-type").equals("application/json"),
  AssertionBuilder.jsonBody("slot").equals(SLOT),
  // FAKE 03 — WEAKEN OPERATOR. `equals` becomes `contains`. The API returning
  // "UNAVAILABLE", "NOT_AVAILABLE", or any string containing "AVAILABLE" now
  // passes. The assertion still looks present but can no longer distinguish
  // the healthy value from the broken one.
  AssertionBuilder.jsonBody("status").contains("AVAILABLE"),
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