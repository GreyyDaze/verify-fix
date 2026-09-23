// The check's Checkly config AS IT RAN when the incident was recorded.
// Two locations with runParallel on: every tick starts two runs of the check
// at the same moment against the same account — the overlap that produced the
// 401. (Same keys a real `checkly.config.ts` / check construct uses.)
import { defineConfig } from "checkly";

export default defineConfig({
  projectName: "slots-booking",
  logicalId: "slots-booking",
  checks: {
    frequency: 5,
    locations: ["us-east-1", "eu-west-1"],
    runParallel: true,
    environmentVariables: [{ key: "ACCOUNT", value: "{{ACCOUNT}}" }],
    checkMatch: "**/*.check.ts",
  },
});
