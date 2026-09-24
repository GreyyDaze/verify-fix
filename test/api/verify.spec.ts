import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { readFileSync } from "node:fs";
import { parseApiCheckProject } from "../../src/api/model.ts";
import { verify } from "../../src/verify.ts";
import type { PatchSet } from "../../src/patch.ts";
import type { ApiRecording, Bundle, Scene } from "../../src/types.ts";

const checkFile = "checks/availability.check.ts";
const setupFile = "checks/availability.setup.ts";
const original = readFileSync("examples/slots-booking/web/checks/availability.check.ts", "utf8");
const strictRepair = original.replace('jsonBody("availability")', 'jsonBody("status")');
const setup = readFileSync("examples/slots-booking/web/checks/availability.setup.ts", "utf8");
const token = "verify-token";
let server: Server;
let target = "";

function apiRecording(resultId: string, body: Record<string, string>): ApiRecording {
  return {
    schemaVersion: "api-recording-v1",
    resultId,
    checkId: "api-check-id",
    startedAt: "2026-09-24T10:00:00.000Z",
    request: { method: "GET", url: "https://slots.example/api/v1/availability?slot=09:30", headers: { authorization: "[REDACTED]" }, body: null },
    response: { status: 200, headers: { "content-type": "application/json" }, contentType: "application/json", bodyText: JSON.stringify(body), json: body, readable: true, truncated: false },
    setup: null,
    unsupportedReasons: [],
  };
}

function makeScene(sceneId: string, type: Scene["type"], mode: string, mustFail: boolean, assertionsInvolved: string[]): Scene {
  return {
    sceneId,
    type,
    state: sceneId,
    mode,
    environment: mode === "live" ? "target" : "recording",
    verdict: { mustFail, provenance: { kind: "recorded", runId: `${sceneId}-result`, artifactId: mode }, envAssumptions: [] },
    experiments: [{ durationSec: 1, repetitions: 5, expectStable: true }],
    assertionsInvolved,
  };
}

function incidentBundle(): Bundle {
  const model = parseApiCheckProject(checkFile, new Map([[checkFile, original], [setupFile, setup]]))!;
  const ids = model.request.assertions.map((assertion) => assertion.assertion.id);
  const scenes = [
    makeScene("healthy-live", "HEALTHY", "live", false, ids),
    makeScene("reproduction", "REPRODUCTION", "replay:failing.api.json", false, ids),
    makeScene("detection", "DETECTION", "replay:passing.api.json", true, ids),
  ];
  return {
    schemaVersion: "v3",
    incidentId: "slots-api-field-rename",
    incident: { title: "availability changed to status", description: "real API contract drift" },
    check: { repo: "", file: checkFile, name: "slots availability API", checkType: "API", logicalId: "slots-availability-api", deployedId: "api-check-id" },
    checkSource: original,
    files: { [checkFile]: original, [setupFile]: setup },
    configFile: null,
    config: { runParallel: true, locations: ["us-east-1", "eu-west-1"], frequencyMinutes: 5, environmentVariables: ["API_TOKEN"] },
    recordedOrigin: "https://slots.example",
    dir: "/not-used",
    playwright: null,
    api: { failing: apiRecording("failing", { slot: "09:30", status: "AVAILABLE" }), passing: apiRecording("passing", { slot: "09:30", availability: "AVAILABLE" }) },
    scenes,
    envAssumptions: [],
    determinism: { targetRuns: 20, achieved: 20, sequentialPassRate: 0, overlapFailRate: 0, reproductionFailRate: 1, baselinePassRate: null, method: "checkly-cloud", lastVerifiedAt: "2026-09-24T10:00:00.000Z" },
    runBudget: { maxPerScene: 10, used: 0 },
    oracleProvenance: { recorded: 3, codeDerived: 0 },
  };
}

before(async () => {
  server = createServer((request, response) => {
    if (request.headers.authorization !== `Bearer ${token}`) {
      response.writeHead(401, { "content-type": "application/json" });
      response.end('{"error":"unauthorized"}');
      return;
    }
    response.writeHead(200, { "content-type": "application/json" });
    response.end('{"slot":"09:30","status":"AVAILABLE"}');
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("server did not bind");
  target = `http://127.0.0.1:${address.port}`;
});

after(async () => {
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
});

test("strict API field repair passes HEALTHY, REPRODUCTION, DETECTION, mutation, and adequacy law", async () => {
  const result = await verify({ bundle: incidentBundle(), patch: strictRepair, target, env: { API_TOKEN: token } });
  assert.equal(result.decision.verdict, "PASS");
  assert.equal(result.decision.exitCode, 0);
  assert.deepEqual([...result.observations.values()].map((observation) => observation.observed), ["pass", "fail", "pass"]);
  assert.equal(result.mutants.length, 2);
  assert.equal(result.mutants.every((mutant) => !mutant.survived), true);
  assert.equal(result.cost.httpRequests, 15);
  assert.equal(result.cost.browserProcesses, 0);
  assert.match(result.decision.reasons.join(" "), /availability to status/);
});

test("complete multi-file candidate resolves imported assertions, constants, and setup helper", async () => {
  const importedCheck = `
import { ApiCheck, Frequency } from "checkly/constructs";
import * as path from "node:path";
import { availabilityAssertions } from "./availability.contract";
new ApiCheck("slots-availability-api", {
  name: "slots availability API",
  activated: true,
  muted: false,
  frequency: Frequency.EVERY_5M,
  locations: ["us-east-1", "eu-west-1"],
  environmentVariables: [
    { key: "ENVIRONMENT_URL", value: process.env.ENVIRONMENT_URL ?? "" },
    { key: "API_TOKEN", value: process.env.API_TOKEN ?? "", secret: true },
  ],
  setupScript: { entrypoint: path.join(__dirname, "availability.setup.ts") },
  request: { method: "GET", url: "{{ENVIRONMENT_URL}}/api/v1/availability?slot=09:30", assertions: availabilityAssertions },
});`;
  const contract = `
import { AssertionBuilder } from "checkly/constructs";
import { EXPECTED_STATUS, SLOT } from "./availability.values";
export const availabilityAssertions = [
  AssertionBuilder.statusCode().equals(200),
  AssertionBuilder.headers("content-type").equals("application/json"),
  AssertionBuilder.jsonBody("slot").equals(SLOT),
  AssertionBuilder.jsonBody("status").equals(EXPECTED_STATUS),
];`;
  const importedSetup = `
import { addRequestHeaders } from "./request-identity";
declare const request: { headers: Record<string, string> };
const token = process.env.API_TOKEN;
if (!token) throw new Error("API_TOKEN is required");
addRequestHeaders(request.headers, token);`;
  const patch: PatchSet = {
    kind: "candidate-revision",
    path: "local-test",
    complete: true,
    checkFile,
    configFile: null,
    files: {
      [checkFile]: importedCheck,
      [setupFile]: importedSetup,
      "checks/availability.contract.ts": contract,
      "checks/availability.values.ts": 'export const EXPECTED_STATUS = "AVAILABLE"; export const SLOT = "09:30";',
      "checks/request-identity.ts": 'export function addRequestHeaders(headers: Record<string, string>, token: string) { headers.Authorization = `Bearer ${token}`; headers["x-request-id"] = `checkly-${Date.now()}`; }',
    },
  };
  const result = await verify({ bundle: incidentBundle(), patch, target, env: { API_TOKEN: token } });
  assert.equal(result.decision.verdict, "PASS");
  assert.equal(result.contract.patched.totalAssertions, 4);
  assert.match(result.decision.reasons.join(" "), /availability to status/);
});

test("stale original API check fails the changed-response reproduction", async () => {
  const result = await verify({ bundle: incidentBundle(), patch: original, target, env: { API_TOKEN: token } });
  assert.equal(result.decision.verdict, "FAILED");
  assert.match(result.decision.reasons.join(" "), /MISMATCH/);
});

test("weaker API repair is statically FAILED before any request", async () => {
  const weak = original.replace('jsonBody("availability").equals', 'jsonBody("status").contains');
  const result = await verify({ bundle: incidentBundle(), patch: weak, target, env: { API_TOKEN: token } });
  assert.equal(result.decision.verdict, "FAILED");
  assert.match(result.decision.reasons.join(" "), /API policy: API contract assertions must remain exact/);
  assert.equal(result.cost.httpRequests, 0);
});

test("unresolved imported API target is UNCERTAIN, never guessed", async () => {
  const dynamic = original.replace("const EXPECTED_AVAILABILITY = \"AVAILABLE\";", "const EXPECTED_AVAILABILITY = getExpectedValue();");
  const result = await verify({ bundle: incidentBundle(), patch: dynamic, target, env: { API_TOKEN: token } });
  assert.equal(result.decision.verdict, "UNCERTAIN");
  assert.match(result.decision.reasons.join(" "), /cannot be safely resolved/);
  assert.equal(result.cost.httpRequests, 0);
});

test("missing target for handlebars is UNCERTAIN even when replay files exist", async () => {
  const result = await verify({ bundle: incidentBundle(), patch: strictRepair, target: null, env: { API_TOKEN: token } });
  assert.equal(result.decision.verdict, "UNCERTAIN");
  assert.match(result.decision.reasons.join(" "), /ENVIRONMENT_URL is missing/);
  assert.equal(result.cost.httpRequests, 0);
});
