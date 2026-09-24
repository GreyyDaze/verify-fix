import { test } from "node:test";
import assert from "node:assert/strict";
import { cpSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildBundle } from "../../src/bundle/build.ts";
import { loadBundle } from "../../src/bundle.ts";
import type { ChecklyClient } from "../../src/checkly/client.ts";
import type { CheckResult, CheckResultSummary } from "../../src/checkly/types.ts";

const secret = "bundle-api-secret";

function summary(id: string, passed: boolean, startedAt: string): CheckResultSummary {
  return {
    id,
    checkId: "api-check-id",
    name: "slots availability API",
    hasFailures: !passed,
    hasErrors: false,
    runLocation: passed ? "us-east-1" : "eu-west-1",
    startedAt,
    stoppedAt: startedAt,
    resultType: "FINAL",
    attempts: 1,
    errorGroupIds: [],
  };
}

function detail(result: CheckResultSummary, field: "availability" | "status"): CheckResult {
  return {
    ...result,
    checkType: "API",
    apiCheckResult: {
      request: {
        method: "GET",
        url: `https://slots.example/api/v1/availability?slot=09%3A30&token=${secret}`,
        headers: { authorization: `Bearer ${secret}`, "x-request-id": result.id },
      },
      response: {
        status: 200,
        statusText: "OK",
        headers: { "content-type": "application/json", "set-cookie": `session=${secret}` },
        body: JSON.stringify({ slot: "09:30", [field]: "AVAILABLE" }),
      },
      assertions: [],
    },
  } as unknown as CheckResult;
}

test("bundle CLI path captures sanitized API request, response, setup provenance, history, and API scenes", async () => {
  const project = mkdtempSync(join(tmpdir(), "verify-fix-api-project-"));
  cpSync("examples/slots-booking/web/checkly.config.ts", join(project, "checkly.config.ts"));
  cpSync("examples/slots-booking/web/checks", join(project, "checks"), { recursive: true });
  const failing = summary("api-failing", false, "2026-09-24T10:10:00.000Z");
  const passing = summary("api-passing", true, "2026-09-24T10:05:00.000Z");
  const client = {
    calls: [],
    async getCheck() {
      return {
        id: "api-check-id",
        name: "slots availability API",
        checkType: "API",
        activated: true,
        muted: false,
        frequency: 5,
        locations: ["us-east-1", "eu-west-1"],
        tags: ["api"],
        groupId: null,
        runtimeId: null,
        runParallel: true,
        environmentVariables: [
          { key: "ENVIRONMENT_URL", value: "https://slots.example", secret: false },
          { key: "API_TOKEN", value: secret, secret: true },
        ],
        request: { method: "GET", url: "{{ENVIRONMENT_URL}}/api/v1/availability?slot=09:30", assertions: [] },
      };
    },
    async listResults() { return { entries: [failing, passing], nextId: null }; },
    async getResult(_checkId: string, resultId: string) { return detail(resultId === failing.id ? failing : passing, resultId === failing.id ? "status" : "availability"); },
    async getAssets() { return { assets: [] }; },
    async errorGroupsForCheck() { return []; },
  } as unknown as ChecklyClient;
  const out = mkdtempSync(join(tmpdir(), "verify-fix-api-bundle-"));
  const built = await buildBundle({ checkId: "api-check-id", outDir: out, projectDir: project }, { client, accountId: "account", toolVersion: "test", now: () => new Date("2026-09-24T10:15:00.000Z") });

  assert.equal(built.manifest.check.logicalId, "slots-availability-api");
  assert.equal(built.manifest.check.file, "checks/availability.check.ts");
  assert.equal(built.manifest.recordings.apiFailing, "recordings/failing.api.json");
  assert.equal(built.manifest.recordings.apiPassing, "recordings/passing.api.json");
  assert.deepEqual(built.manifest.scenes.map((scene) => [scene.type, scene.mode]), [
    ["HEALTHY", "live"],
    ["REPRODUCTION", "replay:failing.api.json"],
    ["DETECTION", "replay:passing.api.json"],
  ]);
  assert.equal(built.manifest.assertions?.totalAssertions, 4);
  assert.equal(built.manifest.scenes.every((scene) => scene.assertionsInvolved.length === 4), true);

  const failingText = readFileSync(join(out, "recordings/failing.api.json"), "utf8");
  const passingText = readFileSync(join(out, "recordings/passing.api.json"), "utf8");
  assert.doesNotMatch(`${failingText}${passingText}`, new RegExp(secret));
  const captured = JSON.parse(failingText);
  assert.equal(captured.request.url, "https://recorded.invalid/api/v1/availability?slot=09%3A30&token=%5BREDACTED%5D");
  assert.doesNotMatch(`${failingText}${passingText}`, /slots\.example/);
  assert.equal(captured.request.headers.authorization, "[REDACTED]");
  assert.equal(captured.response.json.status, "AVAILABLE");
  assert.equal(captured.setup.file, "checks/availability.setup.ts");
  assert.match(captured.setup.sha256, /^[a-f0-9]{64}$/);
  assert.equal(Array.isArray(JSON.parse(readFileSync(join(out, "results/history.json"), "utf8"))), true);

  const loaded = loadBundle(out).bundle;
  assert.equal(loaded.check.checkType, "API");
  assert.equal(loaded.api?.failing?.resultId, "api-failing");
  assert.equal(loaded.api?.passing?.resultId, "api-passing");
  assert.deepEqual(loaded.scenes.map((scene) => scene.mode), ["live", "replay:failing.api.json", "replay:passing.api.json"]);
});
