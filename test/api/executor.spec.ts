import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { readFileSync } from "node:fs";
import { ApiSceneExecutor } from "../../src/api/executor.ts";
import { parseApiCheckProject } from "../../src/api/model.ts";
import { verify } from "../../src/verify.ts";
import type { ApiRecording, Bundle, Scene } from "../../src/types.ts";

const checkFile = "checks/availability.check.ts";
const setupFile = "checks/availability.setup.ts";
const incidentCheckRoot = "incidents/slots-availability-api/check";
const baseline = readFileSync(`${incidentCheckRoot}/${checkFile}`, "utf8");
const candidate = baseline.replace('jsonBody("availability")', 'jsonBody("status")');
const setup = readFileSync(`${incidentCheckRoot}/${setupFile}`, "utf8");
const token = "local-api-token";
let server: Server;
let target = "";
let hits = 0;

function recording(id: string, body: Record<string, string>): ApiRecording {
  return {
    schemaVersion: "api-recording-v1",
    resultId: id,
    checkId: "check-api",
    startedAt: "2026-09-24T10:00:00.000Z",
    request: {
      method: "GET",
      url: "https://slots.example/api/v1/availability?slot=09:30",
      headers: { authorization: "[REDACTED]", "x-request-id": "checkly-1" },
      body: null,
    },
    response: {
      status: 200,
      headers: { "content-type": "application/json" },
      contentType: "application/json",
      bodyText: JSON.stringify(body),
      json: body,
      readable: true,
      truncated: false,
    },
    setup: null,
    unsupportedReasons: [],
  };
}

function scene(sceneId: string, type: Scene["type"], mode: string, mustFail: boolean): Scene {
  return {
    sceneId,
    type,
    state: sceneId,
    mode,
    environment: mode.startsWith("replay:") ? "recording" : "target",
    verdict: { mustFail, provenance: { kind: "recorded", runId: `run-${sceneId}`, artifactId: mode }, envAssumptions: [] },
    experiments: [{ durationSec: 1, repetitions: 2, expectStable: true }],
    assertionsInvolved: [],
  };
}

function bundle(): Bundle {
  return {
    schemaVersion: "v3",
    incidentId: "slots-api-field-rename",
    incident: { title: "API field rename", description: "availability changed to status" },
    check: { repo: "", file: checkFile, name: "slots availability API", checkType: "API", logicalId: "slots-availability-api", deployedId: "check-api" },
    checkSource: baseline,
    files: { [checkFile]: baseline, [setupFile]: setup },
    configFile: null,
    config: { runParallel: true, locations: ["us-east-1", "eu-west-1"], frequencyMinutes: 5, environmentVariables: ["API_TOKEN"] },
    recordedOrigin: "https://slots.example",
    dir: "/not-used",
    playwright: null,
    api: {
      failing: recording("failed-result", { slot: "09:30", status: "AVAILABLE" }),
      passing: recording("passing-result", { slot: "09:30", availability: "AVAILABLE" }),
    },
    scenes: [],
    envAssumptions: [],
    determinism: { targetRuns: 20, achieved: 20, sequentialPassRate: 0, overlapFailRate: 0, reproductionFailRate: 1, baselinePassRate: null, method: "checkly-cloud", lastVerifiedAt: "2026-09-24T10:00:00.000Z" },
    runBudget: { maxPerScene: 10, used: 0 },
    oracleProvenance: { recorded: 3, codeDerived: 0 },
  };
}

before(async () => {
  server = createServer((request, response) => {
    hits += 1;
    assert.equal(request.url, "/api/v1/availability?slot=09:30");
    if (request.headers.authorization !== `Bearer ${token}` || !request.headers["x-request-id"]) {
      response.writeHead(401, { "content-type": "application/json" });
      response.end('{"error":"unauthorized"}');
      return;
    }
    response.writeHead(200, { "content-type": "application/json" });
    response.end('{"slot":"09:30","status":"AVAILABLE"}');
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("test server did not bind");
  target = `http://127.0.0.1:${address.port}`;
});

after(async () => {
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
});

test("API executor runs setup then performs real HEALTHY HTTP requests", async () => {
  const executor = new ApiSceneExecutor({ target, env: { API_TOKEN: token } });
  const healthy = scene("healthy-live", "HEALTHY", "live", false);
  const beforeHits = hits;
  const result = await executor.runScene(bundle(), candidate, healthy, { config: null, files: { [checkFile]: candidate, [setupFile]: setup }, phase: "candidate" });
  assert.equal(result.observed, "pass");
  assert.equal(result.repetitions, 2);
  assert.equal(hits - beforeHits, 2);
  assert.equal(executor.costReport().httpRequests, 2);
  assert.match(result.trace[0].what, /sensitive values omitted/);
  assert.doesNotMatch(JSON.stringify(result), new RegExp(token));
});

test("API executor deterministically replays the changed response for REPRODUCTION", async () => {
  const executor = new ApiSceneExecutor({ target, env: { API_TOKEN: token } });
  const result = await executor.runScene(bundle(), candidate, scene("reproduction", "REPRODUCTION", "replay:failing.api.json", false), { config: null, files: { [checkFile]: candidate, [setupFile]: setup } });
  assert.equal(result.observed, "pass");
  assert.equal(result.repetitions, 2);
  assert.match(result.environment ?? "", /failed-result/);
});

test("API executor replays legacy sanitized origins and Checkly empty GET bodies", async () => {
  const captured = bundle();
  captured.api!.failing!.request!.url = "[REDACTED]/api/v1/availability?slot=09%3A30";
  captured.api!.failing!.request!.body = "";
  const executor = new ApiSceneExecutor({ target, env: { API_TOKEN: token } });
  const result = await executor.runScene(captured, candidate, scene("reproduction", "REPRODUCTION", "replay:failing.api.json", false), { config: null, files: { [checkFile]: candidate, [setupFile]: setup } });
  assert.equal(result.observed, "pass", result.reason ?? "legacy recording should replay");
  assert.equal(result.repetitions, 2);
});

test("API executor DETECTION replay rejects a repair that accepts only the renamed field", async () => {
  const executor = new ApiSceneExecutor({ target, env: { API_TOKEN: token } });
  const result = await executor.runScene(bundle(), candidate, scene("detection", "DETECTION", "replay:passing.api.json", true), { config: null, files: { [checkFile]: candidate, [setupFile]: setup } });
  assert.equal(result.observed, "fail");
  assert.equal(result.repetitions, 2);
  assert.ok(result.trace.some((step) => step.kind === "assertion" && step.outcome === "failed" && step.what.includes('jsonBody("status")')));
});

test("missing API_TOKEN makes setup evidence UNCERTAIN and sends no request", async () => {
  const executor = new ApiSceneExecutor({ target, env: {} });
  const beforeHits = hits;
  const result = await executor.runScene(bundle(), candidate, scene("healthy-live", "HEALTHY", "live", false), { config: null, files: { [checkFile]: candidate, [setupFile]: setup } });
  assert.equal(result.observed, "uncertain");
  assert.match(result.reason ?? "", /setup script failed before request execution/);
  assert.equal(hits, beforeHits);
  assert.equal(executor.costReport().httpRequests, 0);
});

test("setup errors redact secret values before they enter structured evidence", async () => {
  const leakingSetup = `declare const request: { headers: Record<string, string> }; throw new Error(process.env.API_TOKEN);`;
  const executor = new ApiSceneExecutor({ target, env: { API_TOKEN: token } });
  const result = await executor.runScene(bundle(), candidate, scene("healthy-live", "HEALTHY", "live", false), { config: null, files: { [checkFile]: candidate, [setupFile]: leakingSetup } });
  assert.equal(result.observed, "uncertain");
  assert.match(result.reason ?? "", /\[REDACTED\]/);
  assert.doesNotMatch(JSON.stringify(result), new RegExp(token));
});

test("missing ENVIRONMENT_URL target is UNCERTAIN before setup or request", async () => {
  const executor = new ApiSceneExecutor({ target: null, env: { API_TOKEN: token } });
  const beforeHits = hits;
  const result = await executor.runScene(bundle(), candidate, scene("reproduction", "REPRODUCTION", "replay:failing.api.json", false), { config: null, files: { [checkFile]: candidate, [setupFile]: setup } });
  assert.equal(result.observed, "uncertain");
  assert.match(result.reason ?? "", /ENVIRONMENT_URL is missing/);
  assert.equal(hits, beforeHits);
});

test("truncated or malformed API response evidence is UNCERTAIN", async () => {
  const broken = bundle();
  broken.api!.failing!.response!.truncated = true;
  const executor = new ApiSceneExecutor({ target, env: { API_TOKEN: token } });
  const result = await executor.runScene(broken, candidate, scene("reproduction", "REPRODUCTION", "replay:failing.api.json", false), { config: null, files: { [checkFile]: candidate, [setupFile]: setup } });
  assert.equal(result.observed, "uncertain");
  assert.match(result.reason ?? "", /unreadable, truncated, or absent/);
});
