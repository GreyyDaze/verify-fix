import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { apiInventory, parseApiCheckProject } from "../../src/api/model.ts";
import { evaluateApiPolicy } from "../../src/api/policy.ts";
import { apiRecordingFromResult, setupProvenance } from "../../src/api/recording.ts";
import { assertionId } from "../../src/assertion/id.ts";
import type { CheckResult } from "../../src/checkly/types.ts";

const checkFile = "checks/availability.check.ts";
const setupFile = "checks/availability.setup.ts";
const baseline = readFileSync("examples/slots-booking/web/checks/availability.check.ts", "utf8");
const setup = readFileSync("examples/slots-booking/web/checks/availability.setup.ts", "utf8");

function tree(check = baseline, setupSource = setup): Map<string, string> {
  return new Map([[checkFile, check], [setupFile, setupSource]]);
}

test("ApiCheck model parses exact request, setup, environment, and AssertionBuilder contract", () => {
  const model = parseApiCheckProject(checkFile, tree());
  assert.ok(model);
  assert.equal(model.logicalId, "slots-availability-api");
  assert.equal(model.name, "slots availability API");
  assert.equal(model.request.method, "GET");
  assert.equal(model.request.url, "{{ENVIRONMENT_URL}}/api/v1/availability?slot=09:30");
  assert.equal(model.setupFile, setupFile);
  assert.deepEqual(model.environmentKeys, ["ENVIRONMENT_URL", "API_TOKEN"]);
  assert.deepEqual(model.request.assertions.map((assertion) => [assertion.property, assertion.selector, assertion.operator, assertion.target]), [
    ["statusCode", null, "equals", 200],
    ["headers", "content-type", "equals", "application/json"],
    ["jsonBody", "slot", "equals", "09:30"],
    ["jsonBody", "availability", "equals", "AVAILABLE"],
  ]);
  assert.deepEqual(model.errors, []);
});

test("AssertionBuilder inventory keeps assertion identity when only the JSON field name changes", () => {
  const before = parseApiCheckProject(checkFile, tree())!;
  const after = parseApiCheckProject(checkFile, tree(baseline.replace('jsonBody("availability")', 'jsonBody("status")')))!;
  const beforeField = before.request.assertions.at(-1)!;
  const afterField = after.request.assertions.at(-1)!;
  assert.equal(beforeField.assertion.id, assertionId(beforeField.assertion.subject, "equals", '"AVAILABLE"'));
  assert.equal(beforeField.assertion.id, afterField.assertion.id);
  assert.equal(beforeField.assertion.subject, 'jsonBody("availability")');
  assert.equal(afterField.assertion.subject, 'jsonBody("status")');
  assert.equal(apiInventory(after).totalAssertions, 4);
});

test("ApiCheck model resolves imported assertion arrays and imported constants", () => {
  const files = new Map<string, string>([
    ["checks/api.check.ts", `
      import { ApiCheck } from "checkly/constructs";
      import { API_ASSERTIONS } from "./contract";
      new ApiCheck("slots-availability-api", {
        name: "slots availability API",
        setupScript: { entrypoint: "setup.ts" },
        request: { method: "GET", url: "{{ENVIRONMENT_URL}}/api/v1/availability?slot=09:30", assertions: API_ASSERTIONS },
      });
    `],
    ["checks/contract.ts", `
      import { AssertionBuilder } from "checkly/constructs";
      import { EXPECTED, SLOT } from "./values";
      export const API_ASSERTIONS = [
        AssertionBuilder.statusCode().equals(200),
        AssertionBuilder.headers("content-type").equals("application/json"),
        AssertionBuilder.jsonBody("slot").equals(SLOT),
        AssertionBuilder.jsonBody("status").equals(EXPECTED),
      ];
    `],
    ["checks/values.ts", `export const EXPECTED = "AVAILABLE"; export const SLOT = "09:30";`],
    ["checks/setup.ts", setup],
  ]);
  const model = parseApiCheckProject("checks/api.check.ts", files, "slots-availability-api");
  assert.ok(model);
  assert.deepEqual(model.errors, []);
  assert.equal(model.request.assertions.at(-1)?.sourceFile, "checks/contract.ts");
  assert.equal(model.request.assertions.at(-1)?.target, "AVAILABLE");
});

test("ApiCheck model fails closed when an imported assertion target is dynamic", () => {
  const source = baseline.replace("const EXPECTED_AVAILABILITY = \"AVAILABLE\";", "const EXPECTED_AVAILABILITY = getExpectedValue();");
  const model = parseApiCheckProject(checkFile, tree(source));
  assert.ok(model);
  assert.match(model.errors.join(" "), /target is not a static primitive/);
});

test("API policy allows the strict field repair and preserves the request contract", () => {
  const candidate = baseline.replace('jsonBody("availability")', 'jsonBody("status")');
  const result = evaluateApiPolicy(checkFile, tree(), checkFile, tree(candidate), "slots-availability-api");
  assert.equal(result.rejected, null);
  assert.equal(result.uncertain, null);
  assert.match(result.notes.join(" "), /availability to status/);
});

const rejectedCandidates: Array<[string, (source: string) => string, RegExp]> = [
  ["weak operator", (source) => source.replace('jsonBody("availability").equals', 'jsonBody("status").contains'), /exact/],
  ["assertion removal", (source) => source.replace('  AssertionBuilder.jsonBody("availability").equals(EXPECTED_AVAILABILITY),\n', ""), /assertions were removed|availability contract/],
  ["health route", (source) => source.replace("/api/v1/availability?slot=09:30", "/api/health"), /route or query changed/],
  ["hardcoded host", (source) => source.replace("{{ENVIRONMENT_URL}}", "https://example.com"), /hardcoded hosts/],
  ["shouldFail inversion", (source) => source.replace("muted: false,", "muted: false,\n  shouldFail: true,"), /shouldFail/],
  ["retry change", (source) => source.replace("muted: false,", "muted: false,\n  retryStrategy: { type: \"FIXED\", maxRetries: 2 },"), /retry/],
  ["timeout change", (source) => source.replace("muted: false,", "muted: false,\n  maxResponseTime: 30000,"), /timeout/],
];

for (const [name, mutate, reason] of rejectedCandidates) {
  test(`API policy rejects ${name}`, () => {
    const result = evaluateApiPolicy(checkFile, tree(), checkFile, tree(mutate(baseline)), "slots-availability-api");
    assert.match(result.rejected ?? "", reason);
  });
}

test("API policy rejects setup request redirection and response rewriting", () => {
  const redirect = evaluateApiPolicy(checkFile, tree(), checkFile, tree(baseline, `${setup}\nrequest.url = "https://example.com/health";`), "slots-availability-api");
  assert.match(redirect.rejected ?? "", /setup closure rewrites the request/);
  const rewrite = evaluateApiPolicy(checkFile, tree(), checkFile, tree(baseline, `${setup}\nresponse.body = '{"availability":"AVAILABLE"}';`), "slots-availability-api");
  assert.match(rewrite.rejected ?? "", /rewrites the response/);
});

test("API policy rejects teardown response rewriting", () => {
  const withTeardown = baseline.replace(
    "  setupScript: {\n    entrypoint: path.join(__dirname, \"availability.setup.ts\"),\n  },",
    "  setupScript: { entrypoint: path.join(__dirname, \"availability.setup.ts\") },\n  tearDownScript: { entrypoint: path.join(__dirname, \"availability.teardown.ts\") },",
  );
  const files = tree(withTeardown);
  files.set("checks/availability.teardown.ts", `response.body = '{"status":"AVAILABLE"}';`);
  const result = evaluateApiPolicy(checkFile, tree(), checkFile, files, "slots-availability-api");
  assert.match(result.rejected ?? "", /teardown closure rewrites the response/);
});

test("API policy rejects setup code that does not read API_TOKEN", () => {
  const hardcoded = `declare const request: { headers: Record<string, string> }; request.headers.Authorization = "Bearer hardcoded"; request.headers["x-request-id"] = "fixed";`;
  const result = evaluateApiPolicy(checkFile, tree(), checkFile, tree(baseline, hardcoded), "slots-availability-api");
  assert.match(result.rejected ?? "", /must read API_TOKEN/);
});

test("API policy scans imported setup helpers for response suppression", () => {
  const setupWithHelper = `import { hideFailure } from "./mask";\n${setup}\nhideFailure();`;
  const files = tree(baseline, setupWithHelper);
  files.set("checks/mask.ts", `export function hideFailure() { response.body = '{"availability":"AVAILABLE"}'; }`);
  const result = evaluateApiPolicy(checkFile, tree(), checkFile, files, "slots-availability-api");
  assert.match(result.rejected ?? "", /setup closure rewrites the response/);
});

test("API recording preserves valid JSON and redacts request secrets", () => {
  const result = {
    id: "result-api-1",
    checkId: "check-api",
    name: "slots availability API",
    hasFailures: true,
    hasErrors: false,
    runLocation: "us-east-1",
    startedAt: "2026-09-24T10:00:00.000Z",
    checkType: "API",
    apiCheckResult: {
      request: {
        method: "GET",
        url: "https://slots.example/api/v1/availability?slot=09%3A30&token=secret-token",
        headers: { Authorization: "Bearer secret-token", cookie: "session=secret-token", "x-request-id": "checkly-1" },
        body: "",
      },
      response: {
        status: 200,
        headers: { "content-type": "application/json", "set-cookie": "session=secret-token" },
        body: '{"slot":"09:30","status":"AVAILABLE","token":"secret-token"}',
      },
    },
  } as unknown as CheckResult;
  const recording = apiRecordingFromResult("check-api", result, ["secret-token", "https://slots.example"]);
  assert.ok(recording?.request);
  assert.equal(recording.request.headers.authorization, "[REDACTED]");
  assert.equal(recording.request.headers.cookie, "[REDACTED]");
  assert.equal(recording.request.url, "https://recorded.invalid/api/v1/availability?slot=09%3A30&token=%5BREDACTED%5D");
  assert.doesNotMatch(recording.request.url, /slots\.example/);
  assert.equal(recording.request.body, null);
  assert.deepEqual(recording.response?.json, { slot: "09:30", status: "AVAILABLE", token: "[REDACTED]" });
  assert.equal(recording.response?.headers["set-cookie"], "[REDACTED]");
  assert.doesNotMatch(JSON.stringify(recording), /secret-token/);
});

test("API recording marks malformed declared JSON as unreadable", () => {
  const result = {
    id: "result-api-bad",
    checkId: "check-api",
    name: "slots availability API",
    hasFailures: true,
    hasErrors: false,
    runLocation: "eu-west-1",
    startedAt: "2026-09-24T10:05:00.000Z",
    checkType: "API",
    apiCheckResult: {
      request: { method: "GET", url: "https://slots.example/api/v1/availability?slot=09:30", headers: {} },
      response: { status: 200, headers: { "content-type": "application/json" }, body: "{truncated" },
    },
  } as unknown as CheckResult;
  const recording = apiRecordingFromResult("check-api", result)!;
  assert.equal(recording.response?.readable, false);
  assert.match(recording.unsupportedReasons.join(" "), /not valid JSON/);
});

test("setup provenance contains only path and SHA-256", () => {
  const provenance = setupProvenance(setupFile, setup);
  assert.equal(provenance.file, setupFile);
  assert.match(provenance.sha256, /^[a-f0-9]{64}$/);
  assert.doesNotMatch(JSON.stringify(provenance), /API_TOKEN is required/);
});
