// VECTOR 10 — config-only masking: keep both locations in parallel and add
// retries. The overlapping runs still supersede each other; a retry sometimes
// lands after the other run finished and turns red into green. Must be FAILED
// by the config policy (retry/timeout-only change masks the failure).
import { defineConfig } from "checkly";

export default defineConfig({
  projectName: "slots-booking",
  logicalId: "slots-booking",
  checks: {
    frequency: 5,
    locations: ["us-east-1", "eu-west-1"],
    runParallel: true,
    retryStrategy: { type: "FIXED", baseBackoffSeconds: 30, maxRetries: 2, sameRegion: true },
    environmentVariables: [{ key: "ACCOUNT", value: "{{ACCOUNT}}" }],
    checkMatch: "**/*.check.ts",
  },
});
