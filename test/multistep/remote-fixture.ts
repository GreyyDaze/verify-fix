// Synthetic remote-path fixture only. No Checkly account, browser/cloud proof,
// deployment, credentials or signed URL: fake result-scoped ZIP downloads are
// produced locally and the resulting v3 bundle is loaded back from disk.
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildBundle } from "../../src/bundle/build.ts";
import { buildProtectedRequirements, policyKnown, protectedSourceIdentity } from "../../src/protected-requirements.ts";
import { loadBundle } from "../../src/bundle.ts";
import type { ChecklyClient } from "../../src/checkly/client.ts";
import type { AssetManifestEntry, CheckResultSummary } from "../../src/checkly/types.ts";
import { writeZip } from "../helpers/zip-writer.ts";
import { FAKE_ACCOUNT, FAKE_ORIGIN, failingTestResults, passingTestResults, failingLogs, passingLogs } from "./helpers.ts";

const WEB = new URL("../../examples/slots-booking/web/", import.meta.url).pathname;
const SPEC_FILE = "checks/multistep-booking.spec.ts";
const CONSTRUCT_FILE = "checks/multistep-booking.check.ts";
const name = "slots booking multistep transaction";
const prefix = "synthetic-rebound-";

function summary(id: string, failed: boolean): CheckResultSummary {
  return { id, checkId: "synthetic-check", name, hasFailures: failed, hasErrors: false,
    runLocation: failed ? "eu-west-1" : "us-east-1", resultType: "FINAL", attempts: 1,
    startedAt: "2026-09-25T22:18:13.000Z", stoppedAt: "2026-09-25T22:18:18.000Z", errorGroupIds: [] };
}

export async function syntheticRemoteBundle() {
  const projectDir = mkdtempSync(join(tmpdir(), prefix + "project-"));
  mkdirSync(join(projectDir, "checks"));
  const spec = readFileSync(join(WEB, SPEC_FILE), "utf8");
  writeFileSync(join(projectDir, "checkly.config.ts"), "export default {logicalId:'slots-booking-multistep'}\n");
  writeFileSync(join(projectDir, SPEC_FILE), spec);
  writeFileSync(join(projectDir, CONSTRUCT_FILE), readFileSync(join(WEB, CONSTRUCT_FILE), "utf8"));
  const failing = summary("synthetic-fail", true);
  const passing = summary("synthetic-pass", false);
  const archive = new Map([
    [failing.id, writeZip({ "test-results.json": failingTestResults(), "logs.txt": failingLogs(),
      "check-run-data.json": "{}" })],
    [passing.id, writeZip({ "test-results.json": passingTestResults(), "logs.txt": passingLogs(),
      "check-run-data.json": "{}" })],
  ]);
  const entries = (id: string): AssetManifestEntry[] => ["test-results.json", "logs.txt", "check-run-data.json"]
    .map((filename) => ({ name: filename, type: filename === "logs.txt" ? "log" as const
      : filename === "check-run-data.json" ? "file" as const : "report" as const,
      source: { type: "check-result" as const, checkId: "synthetic-check", checkName: name, checkType: "MULTI_STEP", resultId: id },
      contentType: "application/zip", url: `https://fixture.invalid/${id}.zip`, archive: { entryName: filename } }));
  const client = {
    calls: [],
    async getCheck() {
      return { id: "synthetic-check", name, checkType: "MULTI_STEP", activated: true, muted: false,
        frequency: 5, runParallel: true, locations: ["us-east-1", "eu-west-1"], privateLocations: [],
        tags: ["slots-booking", "verify-fix-example", "multistep"], retryStrategy: null, doubleCheck: false, runtimeId: null,
        script: spec, scriptPath: "multistep-booking.spec.ts", environmentVariables: [
          { key: "ENVIRONMENT_URL", value: FAKE_ORIGIN, secret: false },
          { key: "MULTISTEP_USER_US_EAST_1", value: FAKE_ACCOUNT, secret: true },
          { key: "MULTISTEP_USER_EU_WEST_1", value: "fixture-west-distinct", secret: true },
          { key: "VERCEL_AUTOMATION_BYPASS_SECRET", value: "synthetic-bypass-not-real-918", secret: true },
        ] };
    },
    async listResults() { return { entries: [failing, passing], nextId: null }; },
    async getResult(_checkId: string, id: string) { return id === failing.id ? failing : passing; },
    async getAssets(_checkId: string, id: string) { return { assets: entries(id) }; },
    async download(url: string) {
      const id = new URL(url).pathname.slice(1, -4);
      return archive.get(id) ?? Buffer.alloc(0);
    },
  } as unknown as ChecklyClient;
  const outDir = mkdtempSync(join(tmpdir(), prefix + "bundle-"));
  await buildBundle({ checkId: "synthetic-check", outDir, projectDir, assetsDir: null, log: () => {} },
    { client, accountId: "synthetic", now: () => new Date("2026-09-27T00:00:00.000Z") });
  const bundle = loadBundle(outDir).bundle;
  if (bundle.multistep?.problems.length) throw new Error("synthetic fixture did not bind both remote recordings");
  const policy = buildProtectedRequirements({
    check: {
      id: bundle.check.deployedId ?? "synthetic-check",
      logicalId: bundle.check.logicalId ?? null,
      checkType: "MULTI_STEP",
    },
    sources: [protectedSourceIdentity("checkly-api", "synthetic-checkly-check", "synthetic-checkly-check")],
    values: {
      "multistep.environmentMapping": policyKnown({
        "eu-west-1": "MULTISTEP_USER_EU_WEST_1",
        "us-east-1": "MULTISTEP_USER_US_EAST_1",
      }),
    },
  });
  if (policy.status !== "ready") throw new Error("synthetic fixture could not seal Phase 9 policy");
  bundle.protectedRequirements = policy.envelope;
  bundle.protectedRequirementsIssue = null;
  return bundle;
}
