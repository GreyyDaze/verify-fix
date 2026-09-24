import { ApiCheck, AssertionBuilder, Frequency } from "checkly/constructs";
import * as path from "node:path";

const SLOT = "09:30";
const EXPECTED_AVAILABILITY = "AVAILABLE";
const ENVIRONMENT_URL = process.env.ENVIRONMENT_URL;
const API_TOKEN = process.env.API_TOKEN;

if (!ENVIRONMENT_URL) throw new Error("ENVIRONMENT_URL is required");
if (!API_TOKEN) throw new Error("API_TOKEN is required");

export const availabilityAssertions = [
  AssertionBuilder.statusCode().equals(200),
  AssertionBuilder.headers("content-type").equals("application/json"),
  AssertionBuilder.jsonBody("slot").equals(SLOT),
  AssertionBuilder.jsonBody("availability").equals(EXPECTED_AVAILABILITY),
];

new ApiCheck("slots-availability-api", {
  name: "slots availability API",
  activated: true,
  muted: false,
  frequency: Frequency.EVERY_5M,
  locations: ["us-east-1", "eu-west-1"],
  tags: ["slots-booking", "api"],
  environmentVariables: [
    { key: "ENVIRONMENT_URL", value: ENVIRONMENT_URL },
    { key: "API_TOKEN", value: API_TOKEN, secret: true },
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
