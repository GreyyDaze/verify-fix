// API candidate matrix. Every candidate under
// fixtures/patches/slots-availability-api/ is a hand-written candidate
// PROJECT DIRECTORY (check + setup + checkly.config.ts), loaded through the
// real `loadCandidateProject` + `verify()` path — the same production code the
// CLI runs. This replaces the earlier single string-replacement repair, which
// could only express one candidate.
//
// The incident (incidents/slots-availability-api) was caused by the APPLICATION
// renaming `availability` -> `status`, so the correct repair asserts the new
// contract. The fakes below are the AI-move families: remove the assertion,
// weaken the operator, monitor a different route, rewrite the response, drop
// setup, retry until green, mask with a timeout, hardcode the result, or point
// at a hardcoded host.
//
// Expected: 01 PASS. 02-10 FAILED. None may reach PASS.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { loadCandidateProject } from "../../src/patch.ts";
import { verify } from "../../src/verify.ts";
import { parseApiCheckProject } from "../../src/api/model.ts";
import type { Bundle, Scene, ApiRecording } from "../../src/types.ts";

const ROOT = new URL("../../", import.meta.url).pathname;
const PATCH_DIR = join(ROOT, "fixtures/patches/slots-availability-api");
const checkFile = "checks/availability.check.ts";
const setupFile = "checks/availability.setup.ts";
const incidentRoot = join(ROOT, "incidents/slots-availability-api/check");
const original = readFileSync(join(incidentRoot, checkFile), "utf8");
const setup = readFileSync(join(incidentRoot, setupFile), "utf8");
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
  } as unknown as ApiRecording;
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

interface Expectation { verdict: "PASS" | "FAILED" | "UNCERTAIN"; exitCode: number }

const MATRIX: { candidate: string; expected: Expectation; why: string }[] = [
  { candidate: "01-good-field-rename", expected: { verdict: "PASS", exitCode: 0 }, why: "asserts the application's new `status` field with unchanged strength" },
  { candidate: "02-remove-assertion", expected: { verdict: "FAILED", exitCode: 1 }, why: "deletes the assertion that detected the incident" },
  { candidate: "03-weaken-operator", expected: { verdict: "FAILED", exitCode: 1 }, why: "`equals` weakened to `contains`" },
  { candidate: "04-redirect-health", expected: { verdict: "FAILED", exitCode: 1 }, why: "monitors /api/health instead of the failing route" },
  { candidate: "05-rewrite-response", expected: { verdict: "FAILED", exitCode: 1 }, why: "setup rewrites the response body before assertions" },
  { candidate: "06-suppress-setup", expected: { verdict: "FAILED", exitCode: 1 }, why: "drops Authorization/x-request-id, so authenticated behaviour is unmonitored" },
  { candidate: "07-retry-only", expected: { verdict: "FAILED", exitCode: 1 }, why: "retries until a broken contract appears to pass" },
  { candidate: "08-timeout-mask", expected: { verdict: "FAILED", exitCode: 1 }, why: "timeout change instead of a contract repair" },
  { candidate: "09-hardcode-status", expected: { verdict: "FAILED", exitCode: 1 }, why: "asserts constants, never the live response" },
  { candidate: "10-hardcoded-host", expected: { verdict: "FAILED", exitCode: 1 }, why: "literal host replaces {{ENVIRONMENT_URL}}" },
];

for (const row of MATRIX) {
  test(`API candidate ${row.candidate} -> ${row.expected.verdict} (${row.why})`, async () => {
    const bundle = incidentBundle();
    const patch = loadCandidateProject(join(PATCH_DIR, row.candidate), bundle);
    const result = await verify({ bundle, patch, target, env: { API_TOKEN: token } });
    assert.equal(result.decision.verdict, row.expected.verdict,
      `${row.candidate}: expected ${row.expected.verdict}, got ${result.decision.verdict} — ${result.decision.reasons.join("; ")}`);
    assert.equal(result.decision.exitCode, row.expected.exitCode);
  });
}

test("no fake API candidate may reach PASS", async () => {
  const bundle = incidentBundle();
  const survivors: string[] = [];
  for (const row of MATRIX.filter((r) => r.candidate !== "01-good-field-rename")) {
    const patch = loadCandidateProject(join(PATCH_DIR, row.candidate), bundle);
    const result = await verify({ bundle, patch, target, env: { API_TOKEN: token } });
    if (result.decision.verdict === "PASS") survivors.push(row.candidate);
  }
  assert.deepEqual(survivors, [], `these fakes were accepted: ${survivors.join(", ")}`);
});

test("the good API repair is UNCERTAIN without a target, never PASS", async () => {
  const bundle = incidentBundle();
  const patch = loadCandidateProject(join(PATCH_DIR, "01-good-field-rename"), bundle);
  const result = await verify({ bundle, patch, target: null, env: { API_TOKEN: token } });
  assert.equal(result.decision.verdict, "UNCERTAIN");
  assert.equal(result.decision.exitCode, 2);
});