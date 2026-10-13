import { ApiCheck, AssertionBuilder, Frequency } from "checkly/constructs";
import * as path from "node:path";

const SLOT = "09:30";
const EXPECTED_STATUS = "AVAILABLE";

export const availabilityAssertions = [
  AssertionBuilder.statusCode().equals(200),
  AssertionBuilder.headers("content-type").equals("application/json"),
  AssertionBuilder.jsonBody("slot").equals(SLOT),
  // CORRECT REPAIR. The application renamed this response field from
  // `availability` to `status` (incidents/slots-availability-api). The
  // monitoring contract is unchanged in strength: same status, same
  // content-type, same exact slot, same exact value. Only the field name
  // follows the application's new contract.
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
    url: "{{ENVIRONMENT_URL}}/api/v1/availability?slot=09:30",
    assertions: availabilityAssertions,
  },
});