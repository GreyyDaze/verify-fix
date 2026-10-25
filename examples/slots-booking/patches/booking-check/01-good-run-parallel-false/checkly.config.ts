// GOOD FIX (scheduling): runParallel off. Checkly then round-robins the two
// locations — one run per tick — so two runs of the check never start at the
// same moment on the shared account. The check code is unchanged. This is how
// Checkly itself expresses "one run at a time" for a check.
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
