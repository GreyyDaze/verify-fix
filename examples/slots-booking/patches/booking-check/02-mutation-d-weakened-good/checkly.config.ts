// MUTATION D — the good scheduling fix with the booking status assertion
// weakened to a never-falsifiable form. Must be caught (FAILED).
import { defineConfig } from "checkly";

export default defineConfig({
  projectName: "slots-booking",
  logicalId: "slots-booking",
  checks: {
    frequency: 5,
    locations: ["us-east-1", "eu-west-1"],
    runParallel: false,
    environmentVariables: [{ key: "ACCOUNT", value: "{{ACCOUNT}}" }],
    checkMatch: "**/*.check.ts",
  },
});
