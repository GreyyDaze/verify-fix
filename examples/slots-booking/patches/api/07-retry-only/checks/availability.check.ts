import { ApiCheck, AssertionBuilder, Frequency, RetryStrategyBuilder } from "checkly/constructs";
import * as path from "node:path";

const SLOT = "09:30";
const EXPECTED_STATUS = "AVAILABLE";

export const availabilityAssertions = [
  AssertionBuilder.statusCode().equals(200),
  AssertionBuilder.headers("content-type").equals("application/json"),
  AssertionBuilder.jsonBody("slot").equals(SLOT),
  // FAKE 07 — RETRY-ONLY "REPAIR". The assertions are untouched, but the check
  // is configured to retry until it passes. A genuine contract failure is
  // retried and eventually reported as passing. Retries measure recurrence;
  // they cannot repair a broken contract.
  AssertionBuilder.jsonBody("status").equals(EXPECTED_STATUS),
];

new ApiCheck("slots-availability-api", {
  name: "slots availability API",
  activated: true,
  muted: false,
  frequency: Frequency.EVERY_5M,
  locations: ["us-east-1", "eu-west-1"],
  tags: ["slots-booking", "api"],
  // `retryStrategy` is a top-level ApiCheck option (Checkly docs: Api Check
  // Construct > Configuration). Not a `request` field.
  retryStrategy: RetryStrategyBuilder.linearStrategy({
    baseBackoffSeconds: 1,
    maxRetries: 5,
    sameRegion: true,
  }),
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