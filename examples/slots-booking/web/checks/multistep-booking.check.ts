import { Frequency, MultiStepCheck } from "checkly/constructs";
import * as path from "node:path";

// Local Stage 3 baseline: exactly ONE new MultiStepCheck construct for the
// slots-booking example. It is discovered with the existing construct files
// via Checkly's default `**/*.check.{js,ts}` pattern and joins the existing
// project (no second project, no catalogue-only check). The transaction code
// lives in multistep-booking.spec.ts, which deliberately does NOT match the
// construct-discovery pattern — it is referenced only as this check's
// entrypoint.
//
// Accounts: ENVIRONMENT_URL has no fallback; the per-region Multistep
// accounts are isolated from the browser check's TEST_USER accounts so the
// two scheduled checks cannot invalidate each other's sessions, and each
// Checkly location gets its own account so concurrent locations cannot
// invalidate each other either. Committing this file commits variable NAMES
// only — values come from the environment at the later checkpoint.
new MultiStepCheck("slots-booking-multistep", {
  name: "slots booking multistep transaction",
  activated: true,
  muted: false,
  frequency: Frequency.EVERY_5M,
  locations: ["us-east-1", "eu-west-1"],
  // Both locations run concurrently; per-region accounts keep them isolated.
  runParallel: true,
  tags: ["slots-booking", "verify-fix-example", "multistep"],
  environmentVariables: [
    { key: "ENVIRONMENT_URL", value: process.env.ENVIRONMENT_URL ?? "" },
    {
      key: "MULTISTEP_USER_US_EAST_1",
      value: process.env.MULTISTEP_USER_US_EAST_1 ?? "",
      secret: true,
    },
    {
      key: "MULTISTEP_USER_EU_WEST_1",
      value: process.env.MULTISTEP_USER_EU_WEST_1 ?? "",
      secret: true,
    },
  ],
  code: {
    entrypoint: path.join(__dirname, "multistep-booking.spec.ts"),
  },
});
