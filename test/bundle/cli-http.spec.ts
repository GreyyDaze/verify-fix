// Full path through the real CLI, the real HTTP client and the real orchestrator
// against a local stand-in for api.checklyhq.com. Only Checkly itself is faked.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { fakeTraceZip } from "../helpers/fake-trace.ts";
import { CHECK } from "../helpers/fixtures.ts";

const REPO = new URL("../../", import.meta.url).pathname;
const BASE = "https://slots.example.test";

function json(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

test("cli over http: bundle of the example check against a local Checkly stand-in", async () => {
  const seen: Array<{ url: string; auth: boolean }> = [];
  const failingZip = fakeTraceZip({
    baseURL: BASE,
    requests: [
      { method: "POST", url: `${BASE}/api/login`, status: 200, body: '{"token":"tok-demo-9"}', t: 1 },
      { method: "POST", url: `${BASE}/api/book`, status: 401, body: '{"error":"session superseded by a newer login"}', t: 2 },
    ],
    actions: [{ apiName: "expect.toHaveText", params: { expectedText: [{ string: "200" }] }, error: "Received string: \"401\"" }],
  });
  const passingZip = fakeTraceZip({ baseURL: BASE, requests: [{ method: "POST", url: `${BASE}/api/book`, status: 200, body: '{"booking":"CONFIRMED"}', t: 2 }], actions: [] });
  const history = [
    { id: "r-fail", hasFailures: true, hasErrors: false, runLocation: "eu-west-1", startedAt: "2026-09-21T10:00:00Z", resultType: "FINAL", attempts: 1, errorGroupIds: ["eg-1"] },
    { id: "r-pass", hasFailures: false, hasErrors: false, runLocation: "us-east-1", startedAt: "2026-09-21T09:55:00Z", resultType: "FINAL", attempts: 1, errorGroupIds: [] },
  ];

  // Asset storage on its own origin (like S3 behind a presigned URL): credentials must not be sent here.
  const assetServer = createServer((req: IncomingMessage, res: ServerResponse) => {
    const url = req.url ?? "";
    seen.push({ url: `asset:${url}`, auth: false });
    if (req.headers.authorization || req.headers["x-checkly-account"]) return json(res, 400, { error: "credentials sent to presigned url" });
    res.writeHead(200, { "content-type": "application/zip" });
    res.end(url.includes("failing") ? failingZip : passingZip);
  });
  await new Promise<void>((r) => assetServer.listen(0, "127.0.0.1", r));
  const assetPort = (assetServer.address() as { port: number }).port;

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const url = req.url ?? "";
    const auth = req.headers.authorization === "Bearer cu_local" && req.headers["x-checkly-account"] === "acct-local";
    seen.push({ url, auth });
    if (!auth) return json(res, 401, { statusCode: 401, message: "Bad Token" });
    if (url === `/v1/checks/${CHECK.id}`) return json(res, 200, CHECK);
    if (url.startsWith(`/v2/check-results/${CHECK.id}`)) return json(res, 200, { entries: history, nextId: null });
    if (url === `/v1/check-results/${CHECK.id}/r-fail`) return json(res, 200, { ...history[0], playwrightCheckResult: { errors: ["tests/booking.spec.ts:19:3 › slots booking flow"] } });
    if (url === `/v1/check-results/${CHECK.id}/r-pass`) return json(res, 200, { ...history[1], playwrightCheckResult: { errors: [] } });
    if (url === `/v1/check-results/${CHECK.id}/r-fail/assets?type=trace`) return json(res, 200, { assets: [{ type: "trace", name: "trace.zip", url: `http://127.0.0.1:${assetPort}/failing.zip?sig=1`, source: "pw" }] });
    if (url === `/v1/check-results/${CHECK.id}/r-pass/assets?type=trace`) return json(res, 200, { assets: [{ type: "trace", name: "trace.zip", url: `http://127.0.0.1:${assetPort}/passing.zip?sig=2`, source: "pw" }] });
    if (url === "/v1/error-groups/eg-1") return json(res, 200, { id: "eg-1", checkId: CHECK.id, errorHash: "h", rawErrorMessage: null, cleanedErrorMessage: "toHaveText failed", firstSeen: "2026-09-21T09:59:00Z", lastSeen: "2026-09-21T10:00:00Z", rootCauseAnalyses: [] });
    return json(res, 404, { statusCode: 404, message: "Not Found" });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;
  const out = mkdtempSync(join(tmpdir(), "vf-cli-http-"));
  try {
    const env = {
      PATH: process.env.PATH,
      HOME: out,
      CHECKLY_API_KEY: "cu_local",
      CHECKLY_ACCOUNT_ID: "acct-local",
      CHECKLY_API_URL: `http://127.0.0.1:${port}`,
    } as NodeJS.ProcessEnv;
    // async spawn: a sync spawn would block this process, which also hosts the fake API
    const r = await new Promise<{ status: number | null; stdout: string; stderr: string }>((resolve) => {
      const child = spawn(
        process.execPath,
        ["--no-warnings", join(REPO, "src/cli.ts"), "bundle", "--check", CHECK.id, "--project", join(REPO, "examples/slots-booking/web"), "--out", join(out, "bundle"), "--json", "--verbose"],
        { env, stdio: ["ignore", "pipe", "pipe"] },
      );
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (d) => (stdout += String(d)));
      child.stderr.on("data", (d) => (stderr += String(d)));
      child.on("close", (status) => resolve({ status, stdout, stderr }));
    });
    assert.equal(r.status, 0, r.stderr);
    const summary = JSON.parse(r.stdout);
    assert.equal(summary.status, "captured");
    assert.equal(summary.reproduction, "both", "no RCA and no rule match on the error message → both modes");
    assert.deepEqual(summary.scenes.map((s: { id: string; mode: string }) => [s.id, s.mode]), [
      ["healthy-live", "live"],
      ["reproduction", "live-concurrent:2"],
      ["detection", "inject:POST /api/book -> 401"],
    ]);
    assert.equal(summary.failurePoint.request.path, "/api/book");
    assert.ok(summary.warnings.some((w: string) => /no Rocky RCA/.test(w)));
    assert.ok(existsSync(join(out, "bundle/recordings/failing.har")));
    const manifest = JSON.parse(readFileSync(join(out, "bundle/manifest.json"), "utf8"));
    assert.equal(manifest.check.file, "tests/booking.spec.ts");
    assert.equal(manifest.check.logicalId, "slots-booking-monitoring");
    assert.equal(manifest.target.resolution, "code");
    assert.match(manifest.check.projectCommit ?? "", /^[0-9a-f]{40}$/);
    assert.ok(seen.every((s) => s.url.startsWith("asset:") || s.auth), "every API call was authenticated");
    assert.equal(seen.filter((s) => s.url.startsWith("asset:")).length, 2, "both traces were downloaded from the asset origin");
    assert.match(r.stderr, /credentials from env/);
    const har = readFileSync(join(out, "bundle/recordings/failing.har"), "utf8");
    assert.equal(har.includes("tok-demo-9"), false);
  } finally {
    server.close();
    assetServer.close();
    rmSync(out, { recursive: true, force: true });
  }
});
