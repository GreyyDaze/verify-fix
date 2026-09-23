// GOOD FIX (scheduling, second form): a single location. With one location a
// check has one run per tick even with runParallel on, so runs cannot overlap.
// Check code unchanged.
import { defineConfig } from "checkly";

export default defineConfig({
  projectName: "slots-booking",
  logicalId: "slots-booking",
  checks: {
    frequency: 5,
    locations: ["us-east-1"],
    runParallel: true,
    environmentVariables: [{ key: "ACCOUNT", value: "{{ACCOUNT}}" }],
    checkMatch: "**/*.check.ts",
  },
});
