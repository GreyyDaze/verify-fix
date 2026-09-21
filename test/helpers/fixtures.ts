// Shared fake Checkly check definition for bundle tests.
import type { ChecklyCheck } from "../../src/checkly/types.ts";

export const CHECK: ChecklyCheck = {
  id: "11111111-2222-3333-4444-555555555555",
  name: "slots booking flow",
  checkType: "PLAYWRIGHT",
  activated: true,
  muted: false,
  frequency: 5,
  locations: ["us-east-1", "eu-west-1"],
  tags: ["slots-booking"],
  groupId: null,
  runtimeId: null,
  runParallel: true,
  retryStrategy: null,
  environmentVariables: [{ key: "TEST_USER", value: "demo-account-value", locked: false }, { key: "APP_PASSWORD", value: "sup3r-secret-value", secret: true }],
  playwrightConfigPath: "./playwright.config.ts",
  pwProjects: ["booking"],
  pwTags: [],
  playwrightVersion: "1.63.0",
};
