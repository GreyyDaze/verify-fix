// Synthetic remote-path fixture only. No Checkly account, browser/cloud proof,
// deployment, credentials or signed URL: fake result-scoped ZIP downloads are
// produced locally and the resulting v3 bundle is loaded back from disk.
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildBundle } from "../../../src/capture/bundle/build.ts";
import { buildProtectedRequirements, policyKnown, protectedSourceIdentity } from "../../../src/policy/requirements.ts";
import { loadBundle } from "../../../src/capture/bundle/load.ts";
import type { ChecklyClient } from "../../../src/capture/checkly/client.ts";
import type { AssetManifestEntry, CheckResultSummary } from "../../../src/capture/checkly/types.ts";
import { writeZip } from "../../helpers/zip-writer.ts";
import { FAKE_ACCOUNT, FAKE_ORIGIN, failingTestResults, passingTestResults, failingLogs, passingLogs } from "./helpers.ts";

const WEB = new URL("../../../examples/slots-booking/web/", import.meta.url).pathname;
const SPEC_FILE = "checks/multistep-booking.spec.ts";
const CONSTRUCT_FILE = "checks/multistep-booking.check.ts";
const name = "slots booking multistep transaction";
const prefix = "synthetic-rebound-";

function summary(id: string, failed: boolean): CheckResultSummary {
  return { id, checkId: "synthetic-check", name, hasFailures: failed, hasErrors: false,
    runLocation: failed ? "eu-central-1" : "us-east-1", resultType: "FINAL", attempts: 1,
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
        frequency: 5, runParallel: true, locations: ["us-east-1", "eu-central-1"], privateLocations: [],
        tags: ["slots-booking", "verify-fix-example", "multistep"], retryStrategy: null, doubleCheck: false, runtimeId: null,
        script: spec, scriptPath: "multistep-booking.spec.ts", environmentVariables: [
          { key: "ENVIRONMENT_URL", value: FAKE_ORIGIN, secret: false },
          { key: "MULTISTEP_USER_US_EAST_1", value: FAKE_ACCOUNT, secret: true },
          { key: "MULTISTEP_USER_EU_CENTRAL_1", value: "fixture-west-distinct", secret: true },
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
  const initial = loadBundle(outDir).bundle;
  if (initial.multistep?.problems.length) throw new Error("synthetic fixture did not bind both remote recordings");
  const policy = buildProtectedRequirements({
    check: {
      id: initial.check.deployedId ?? "synthetic-check",
      logicalId: initial.check.logicalId ?? null,
      checkType: "MULTI_STEP",
    },
    sources: [protectedSourceIdentity("checkly-api", "synthetic-checkly-check", "synthetic-checkly-check")],
    values: {
      "multistep.environmentMapping": policyKnown({
        "eu-central-1": "MULTISTEP_USER_EU_CENTRAL_1",
        "us-east-1": "MULTISTEP_USER_US_EAST_1",
      }),
    },
  });
  if (policy.status !== "ready") throw new Error("synthetic fixture could not seal Phase 9 policy");
  const manifestPath = join(outDir, "manifest.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as Record<string, unknown>;
  manifest.protectedRequirements = policy.envelope;
  // This fixture is deliberately the recorded nested-response incident: the
  // source's flat field names moved into `booking.*`, including the renamed
  // session version. That aliasing is contract data, so it is declared here
  // rather than inferred by product code.
  const scenario = manifest.scenario as Record<string, unknown>;
  scenario.stepTitles = ["login", "session", "slots", "book 09:30", "confirm transaction"];
  scenario.repair = [
    { from: "body.confirmed", to: "body.booking.confirmed" },
    { from: "body.booking", to: "body.booking.status" },
    { from: "typeof body.account", to: "typeof body.booking.account" },
    { from: "body.account", to: "body.booking.account" },
    { from: "body.slot", to: "body.booking.slot" },
    { from: "body.version", to: "body.booking.sessionVersion" },
  ];
  scenario.writes = [
    { from: "write:bookingAccount:=:body.account as string", to: "write:bookingAccount:=:body.booking.account as string" },
    { from: "write:bookingSlot:=:body.slot as string", to: "write:bookingSlot:=:body.booking.slot as string" },
    { from: "write:bookingVersion:=:body.version as number", to: "write:bookingVersion:=:body.booking.sessionVersion as number" },
    { from: "write:bookingConfirmed:=:body.confirmed === true", to: "write:bookingConfirmed:=:body.booking.confirmed === true" },
    { from: "write:bookingResult:=:body.booking as string", to: "write:bookingResult:=:body.booking.status as string" },
  ];
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
  const bundle = loadBundle(outDir).bundle;
  if (!bundle.protectedRequirements) throw new Error("synthetic fixture policy did not reload");
  return bundle;
}
