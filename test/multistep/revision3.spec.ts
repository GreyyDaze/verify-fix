// Revision-3 adversarial tests: every correction area from the coordinator
// review gets a direct attack test. All fixtures are locally constructed
// synthetic values — mechanics only, never real Checkly/browser/cloud proof.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { request as httpsRequest } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startOriginBridge, MAX_REQUEST_BODY_BYTES } from "../../src/multistep/origin-bridge.ts";
import { runMultiStepSandbox, staticBrowserFreeScript, bridgeReporterMismatch } from "../../src/multistep/executor.ts";
import { normalizeMultiStepCapture, observeMultiStepCapture } from "../../src/multistep/normalize.ts";
import { extractTransaction } from "../../src/multistep/transaction.ts";
import { sanitizeMultiStepCapture } from "../../src/multistep/sanitize.ts";
import { buildMultiStepRecording, readMultiStepAssets, MAX_ASSET_FILE_BYTES } from "../../src/multistep/capture.ts";
import { parseMultiStepScript } from "../../src/multistep/source.ts";
import { evaluateMultiStepPolicy } from "../../src/multistep/policy.ts";
import { openZipBounded, ASSET_ZIP_BOUNDS } from "../../src/trace/zip.ts";
import { writeZip } from "../helpers/zip-writer.ts";
import { FAKE_ACCOUNT, FAKE_ORIGIN, FAKE_TOKEN, passingTestResults, passingLogs, failingTestResults, failingLogs } from "./helpers.ts";

const WEB = new URL("../../examples/slots-booking/web/", import.meta.url).pathname;
const SPEC_SOURCE = readFileSync(join(WEB, "checks", "multistep-booking.spec.ts"), "utf8");

// ---------------------------------------------------------------------------
// 1. Real asset shapes: array headers, nested checklyData arrays, requestBody.data, body
// ---------------------------------------------------------------------------

test("rev3/normalize: array-form headers, nested checklyData arrays, requestBody.data, and the real body field all normalize to structured evidence", () => {
  const capture = normalizeMultiStepCapture({ testResults: passingTestResults(), logs: passingLogs(), checkRunData: undefined });
  assert.equal(capture.problems.length, 0, JSON.stringify(capture.problems));
  const login = capture.steps.find((s) => s.title === "login")!.requests[0]!;
  assert.equal(login.method, "POST");
  assert.equal(login.requestHeaders["content-type"], "application/json", "array-form request headers normalize to a name record");
  assert.deepEqual(login.requestBody, { account: FAKE_ACCOUNT }, "requestBody.data unwraps to the real payload");
  assert.deepEqual(login.responseBody, { ok: true, account: FAKE_ACCOUNT, version: 1, token: FAKE_TOKEN, store: "memory" }, "the real body field is read as the response body");
  const session = capture.steps.find((s) => s.title === "session")!.requests[0]!;
  assert.equal(session.requestHeaders.authorization, `Bearer ${FAKE_TOKEN}`, "array-form headers preserve values for normalization");
  assert.equal(session.responseHeaders["content-type"], "application/json", "array-form response headers normalize too");
  assert.deepEqual(session.responseBody, { valid: true, account: FAKE_ACCOUNT, tokenVersion: 1, currentVersion: 1 });
  const confirm = capture.steps.find((s) => s.title === "confirm transaction")!;
  assert.equal(confirm.assertions.length, 1, "array checklyData assertion records extract");
  assert.equal(confirm.assertions[0]!.expected, "CONFIRMED");
});

test("rev3/normalize: inconsistent stats/status/steps become UNCERTAIN (never PASS/FAIL)", () => {
  // a) failed result status with stats.unexpected === 0
  const a = JSON.parse(passingTestResults());
  a.suites[0].suites[0].specs[0].tests[0].results[0].status = "failed";
  const captureA = normalizeMultiStepCapture({ testResults: JSON.stringify(a) });
  assert.ok(captureA.problems.some((p) => /inconsistent capture/.test(p)), JSON.stringify(captureA.problems));
  assert.equal(observeMultiStepCapture(captureA).observed, "uncertain");

  // b) failed step recorded inside an all-passed result
  const b = JSON.parse(passingTestResults());
  const confirmStep = b.suites[0].suites[0].specs[0].tests[0].results[0].steps.find((s: { title: string }) => s.title === "confirm transaction");
  confirmStep.steps[0].error = { message: "unexpected failure" };
  const captureB = normalizeMultiStepCapture({ testResults: JSON.stringify(b) });
  assert.ok(captureB.problems.some((p) => /inconsistent capture/.test(p)), JSON.stringify(captureB.problems));
  assert.equal(observeMultiStepCapture(captureB).observed, "uncertain");

  // c) setup-failure shape: failed result, no steps, unexpected 0 → both the
  // inconsistency and the missing-step-evidence reasons surface as UNCERTAIN
  const c = JSON.parse(passingTestResults());
  c.stats = { expected: 0, unexpected: 0, flaky: 0, skipped: 0 };
  c.suites[0].suites[0].specs[0].tests[0].results[0] = { status: "failed", steps: [] };
  const captureC = normalizeMultiStepCapture({ testResults: JSON.stringify(c) });
  assert.ok(captureC.problems.some((p) => /inconsistent capture/.test(p)), JSON.stringify(captureC.problems));
  const observedC = observeMultiStepCapture(captureC);
  assert.equal(observedC.observed, "uncertain");
  assert.match(observedC.reason ?? "", /no ordered step evidence/);
});

// ---------------------------------------------------------------------------
// 2. Origin bridge: key deletion, bounds, single completion, Connection headers, evidence
// ---------------------------------------------------------------------------

interface UpstreamRecord {
  method: string;
  url: string;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

function startUpstream(): Promise<{ url: string; records: UpstreamRecord[]; close: () => Promise<void> }> {
  const records: UpstreamRecord[] = [];
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      records.push({ method: req.method ?? "", url: req.url ?? "", headers: { ...req.headers }, body: Buffer.concat(chunks).toString("utf8") });
      if ((req.url ?? "").startsWith("/big")) {
        res.writeHead(200, { "content-type": "application/octet-stream", "content-length": String(11 * 1024 * 1024) });
        const chunk = Buffer.alloc(1024 * 1024, 0x61);
        let sent = 0;
        const pump = (): void => {
          while (sent < 11) {
            if (!res.write(chunk)) {
              sent += 1;
              res.once("drain", pump);
              return;
            }
            sent += 1;
          }
          res.end();
        };
        pump();
        return;
      }
      res.writeHead(201, { "content-type": "application/json", "x-upstream": "exact-value" });
      res.end(JSON.stringify({ echoed: true }));
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (!addr || typeof addr !== "object") throw new Error("upstream: no port");
      resolve({ url: `http://127.0.0.1:${addr.port}`, records, close: () => new Promise<void>((done) => server.close(() => done())) });
    });
  });
}

function bridgeRequest(
  origin: string,
  ca: Buffer,
  method: string,
  target: string,
  headers: Record<string, string>,
  body: string | Buffer,
): Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: string }> {
  return new Promise((resolve, reject) => {
    const url = new URL(target, origin);
    const req = httpsRequest(url, { method, headers, ca, servername: "127.0.0.1" }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: { ...res.headers }, body: Buffer.concat(chunks).toString("utf8") }));
      res.on("error", reject);
    });
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

test("rev3/bridge: private keys and OpenSSL config are deleted immediately after start; close removes everything", async () => {
  const bridge = await startOriginBridge("http://127.0.0.1:9");
  try {
    assert.ok(existsSync(bridge.caPath), "the public CA certificate must remain for NODE_EXTRA_CA_CERTS");
    for (const file of ["ca-key.pem", "leaf-key.pem", "leaf.csr", "openssl.cnf"]) {
      assert.ok(!existsSync(join(bridge.materialDir, file)), `${file} must be deleted before candidate execution begins`);
    }
  } finally {
    await bridge.close();
  }
  assert.ok(!existsSync(bridge.materialDir), "close runs every cleanup step — the material directory is gone");
});

test("rev3/bridge: Connection-named headers are stripped, opaque path segments are redacted in evidence, and the bridge answers each request exactly once", async () => {
  const upstream = await startUpstream();
  const bridge = await startOriginBridge(upstream.url);
  try {
    const ca = await readFile(bridge.caPath);
    const opaque = "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6";
    const res = await bridgeRequest(bridge.origin, ca, "GET", `/api/probe/${opaque}?token=raw-query-value`, {
      connection: "x-drop-me",
      "x-drop-me": "must-not-forward",
      "x-keep": "keep",
    }, "");
    assert.equal(res.status, 201, "the response still passes through");
    const seen = upstream.records[0]!;
    assert.equal(seen.headers["x-drop-me"], undefined, "headers named in Connection are hop-by-hop and never forwarded");
    assert.notEqual(seen.headers.connection, "x-drop-me", "the client's Connection value is never forwarded (the transport may manage its own)");
    assert.equal(seen.headers["x-keep"], "keep", "ordinary headers still forward");
    assert.equal(seen.url, `/api/probe/${opaque}?token=raw-query-value`, "the upstream receives the verbatim path and query");

    const ev = bridge.evidence[0]!;
    assert.equal(ev.path, "/api/probe/<redacted>", "sensitive/opaque path values never enter evidence");
    assert.deepEqual(ev.queryKeys, ["token"], "evidence carries query key names only");
    const serialized = JSON.stringify(bridge.evidence);
    assert.ok(!serialized.includes("raw-query-value"), "evidence must never contain raw query values");
    assert.ok(!serialized.includes(opaque), "evidence must never contain the opaque path segment");

    // a second request works — the server never got wedged by the first
    const second = await bridgeRequest(bridge.origin, ca, "GET", "/api/again", {}, "");
    assert.equal(second.status, 201);
    assert.equal(bridge.evidence.length, 2, "one evidence entry per request — no double answers");
    assert.deepEqual(bridge.evidence.map((e) => e.index), [1, 2]);
  } finally {
    await bridge.close();
    await upstream.close();
  }
});

test("rev3/bridge: request bodies over the bound are refused once with 413; oversized responses abort as forward errors", { timeout: 120_000 }, async () => {
  const upstream = await startUpstream();
  const bridge = await startOriginBridge(upstream.url);
  try {
    const ca = await readFile(bridge.caPath);
    // request body over the bound
    const over = Buffer.alloc(MAX_REQUEST_BODY_BYTES + 1024, 0x62);
    let refused = false;
    try {
      await bridgeRequest(bridge.origin, ca, "POST", "/api/upload", {
        "content-type": "application/octet-stream",
        "content-length": String(over.length),
      }, over);
    } catch {
      refused = true; // client side may observe the refusal as an error too
    }
    const ev413 = bridge.evidence.find((e) => e.path === "/api/upload");
    assert.ok(ev413, "the oversized upload is recorded exactly once");
    assert.equal(ev413!.status, 413, "the bridge refuses over-bound bodies itself");
    assert.equal(ev413!.forwardError, undefined, "a size refusal is not a forward error");
    assert.equal(refused || true, true);

    // response body over the bound → forward aborts with forwardError
    let aborted = false;
    try {
      await bridgeRequest(bridge.origin, ca, "GET", "/big", {}, "");
    } catch {
      aborted = true;
    }
    assert.equal(aborted, true, "the oversized response never completes to the client");
    const evBig = bridge.evidence.find((e) => e.path === "/big")!;
    assert.equal(evBig.forwardError, true, "an oversized response is a forward failure (→ UNCERTAIN downstream)");
    assert.equal(bridge.evidence.filter((e) => e.path === "/big").length, 1, "single completion — one entry even on abort");

    // the bridge is still healthy afterwards
    const after = await bridgeRequest(bridge.origin, ca, "GET", "/api/ok", {}, "");
    assert.equal(after.status, 201);
  } finally {
    await bridge.close();
    await upstream.close();
  }
});

// ---------------------------------------------------------------------------
// 3. Executor: fresh HOME, env collision, bounds, no raw stderr, bridge comparison, browser proof
// ---------------------------------------------------------------------------

interface FakeEnv { HOME?: string; NODE_OPTIONS?: string; LD_LIBRARY_PATH?: string; NODE_EXTRA_CA_CERTS?: string; PATH?: string; ENVIRONMENT_URL?: string }

function makeFakeProject(): string {
  const project = mkdtempSync(join(tmpdir(), "verify-fix-rev3-project-"));
  const pw = join(project, "node_modules", "@playwright", "test");
  mkdirSync(pw, { recursive: true });
  writeFileSync(join(project, "package.json"), JSON.stringify({ name: "fake-project", private: true }));
  writeFileSync(join(pw, "package.json"), JSON.stringify({ name: "@playwright/test", version: "1.0.0", exports: { "./cli": "./cli.cjs" } }));
  writeFileSync(join(pw, "cli.cjs"), [
    "const fs = require('node:fs')",
    // env snapshot for assertions (fresh HOME, replaced NODE_OPTIONS, no LD_LIBRARY_PATH)
    "if (process.env.FAKE_ENV_SNAPSHOT) {",
    "  fs.writeFileSync(process.env.FAKE_ENV_SNAPSHOT, JSON.stringify({",
    "    HOME: process.env.HOME, NODE_OPTIONS: process.env.NODE_OPTIONS,",
    "    LD_LIBRARY_PATH: process.env.LD_LIBRARY_PATH ?? null,",
    "    NODE_EXTRA_CA_CERTS: process.env.NODE_EXTRA_CA_CERTS ?? null,",
    "    PATH: process.env.PATH, ENVIRONMENT_URL: process.env.ENVIRONMENT_URL,",
    "  }))",
    "}",
    "if (process.env.FAKE_STDERR_MARKER) process.stderr.write(process.env.FAKE_STDERR_MARKER)",
    "if (process.env.FAKE_STDOUT_PAD_BYTES) {",
    "  process.stdout.write('x'.repeat(Number(process.env.FAKE_STDOUT_PAD_BYTES)))",
    "}",
    // one real request through the bridge, then the (mismatching) report
    "async function main() {",
    "  if (process.env.FAKE_FETCH_ROUNDS) {",
    "    for (let i = 0; i < Number(process.env.FAKE_FETCH_ROUNDS); i++) {",
    "      await fetch(process.env.ENVIRONMENT_URL + '/api/login', { method: 'POST', body: JSON.stringify({ probe: true }), headers: { 'content-type': 'application/json' } })",
    "    }",
    "  }",
    "  process.stdout.write(fs.readFileSync(process.env.FAKE_REPORT_FILE, 'utf8'))",
    "  process.exit(0)",
    "}",
    "main().catch((e) => { process.stderr.write(String(e)); process.exit(1) })",
  ].join("\n"));
  return project;
}

function specFiles(project: string, report: string): { project: string; files: Record<string, string> } {
  writeFileSync(join(project, "fake-report.json"), report);
  return { project, files: { "multistep-booking.spec.ts": SPEC_SOURCE } };
}

test("rev3/executor: the child runs with a FRESH HOME (removed afterwards), a replaced NODE_OPTIONS, and never inherits LD_LIBRARY_PATH", async () => {
  const project = makeFakeProject();
  const snapshot = join(project, "env-snapshot.json");
  const { project: p, files } = specFiles(project, passingTestResults());
  const outcome = await runMultiStepSandbox({
    baseUrl: "https://fixture.invalid",
    projectDir: p,
    files,
    checkFile: "multistep-booking.spec.ts",
    env: { FAKE_REPORT_FILE: join(p, "fake-report.json"), FAKE_ENV_SNAPSHOT: snapshot, LD_LIBRARY_PATH: "/must/not/leak" },
  });
  // NOTE: LD_LIBRARY_PATH in ctx.env is a RESERVED key → rejected before running
  assert.equal(outcome.inconclusive, true, outcome.reason ?? "");
  assert.match(outcome.reason ?? "", /reserved runner key/);
  assert.ok(!existsSync(snapshot), "a rejected environment must never spawn the runner");

  // now without the collision: fresh HOME + replaced NODE_OPTIONS
  const project2 = makeFakeProject();
  const snapshot2 = join(project2, "env-snapshot.json");
  const { project: p2, files: files2 } = specFiles(project2, passingTestResults());
  const outcome2 = await runMultiStepSandbox({
    baseUrl: "https://fixture.invalid",
    projectDir: p2,
    files: files2,
    checkFile: "multistep-booking.spec.ts",
    env: { FAKE_REPORT_FILE: join(p2, "fake-report.json"), FAKE_ENV_SNAPSHOT: snapshot2 },
  });
  assert.equal(outcome2.inconclusive, false, outcome2.reason ?? "");
  assert.equal(outcome2.passed, true);
  assert.equal(outcome2.browserProcesses, 0, "measured browser processes during the run: zero");
  const env = JSON.parse(readFileSync(snapshot2, "utf8")) as FakeEnv;
  assert.ok(env.HOME && env.HOME.includes("sandbox-home"), `HOME must be the fresh sandbox home, got ${env.HOME}`);
  assert.ok(env.HOME !== process.env.HOME, "HOME must not be the parent's home");
  assert.match(env.NODE_OPTIONS ?? "", /^--import=.*verify-fix-seed\.mjs$/, "NODE_OPTIONS is fully replaced with the seed import");
  assert.equal(env.LD_LIBRARY_PATH, null, "LD_LIBRARY_PATH is never inherited");
  assert.equal(env.NODE_EXTRA_CA_CERTS, null, "https direct targets get no CA override");
  assert.equal(env.ENVIRONMENT_URL, "https://fixture.invalid");
  assert.ok(env.PATH, "PATH remains available");
  assert.ok(!existsSync(env.HOME!), "the fresh HOME is removed after the run");
});

test("rev3/executor: reporter stdout over the bound yields no admissible evidence (UNCERTAIN)", async () => {
  const project = makeFakeProject();
  const { project: p, files } = specFiles(project, passingTestResults());
  const outcome = await runMultiStepSandbox({
    baseUrl: "https://fixture.invalid",
    projectDir: p,
    files,
    checkFile: "multistep-booking.spec.ts",
    env: {
      FAKE_REPORT_FILE: join(p, "fake-report.json"),
      FAKE_STDOUT_PAD_BYTES: String(17 * 1024 * 1024), // over the 16 MiB bound
    },
  });
  assert.equal(outcome.passed, false);
  assert.equal(outcome.inconclusive, true);
  assert.match(outcome.reason ?? "", /no admissible evidence/);
});

test("rev3/executor: raw stderr content is never retained or used as evidence", async () => {
  const project = makeFakeProject();
  const { project: p, files } = specFiles(project, passingTestResults());
  const marker = '{"path":"/api/login","evidence-from":"stderr"}';
  const outcome = await runMultiStepSandbox({
    baseUrl: "https://fixture.invalid",
    projectDir: p,
    files,
    checkFile: "multistep-booking.spec.ts",
    env: {
      FAKE_REPORT_FILE: join(p, "fake-report.json"),
      FAKE_STDERR_MARKER: marker,
    },
  });
  assert.equal(outcome.inconclusive, false, outcome.reason ?? "");
  assert.equal(outcome.passed, true);
  assert.ok(outcome.diagnostics.stderrBytes >= marker.length, "stderr is only counted");
  assert.ok(!("stderr" in outcome.diagnostics), "raw stderr content must not exist on the outcome");
  assert.ok(!JSON.stringify(outcome.diagnostics).includes("evidence-from"), "stderr content never surfaces anywhere");
  assert.ok(JSON.stringify(outcome.proxyEvidence) + JSON.stringify(outcome.capture).includes('"/api/login"'), "the evidence is structured");
});

test("rev3/executor: bridge/reporter mismatch — bridge traffic that does not match the report is UNCERTAIN", async () => {
  // A live upstream so the bridge can forward; the fake runner makes exactly
  // ONE request while the report claims FOUR → count mismatch → UNCERTAIN.
  const upstream = await startUpstream();
  try {
    const project = makeFakeProject();
    const { project: p, files } = specFiles(project, passingTestResults());
    const outcome = await runMultiStepSandbox({
      baseUrl: upstream.url,
      projectDir: p,
      files,
      checkFile: "multistep-booking.spec.ts",
      env: {
        FAKE_REPORT_FILE: join(p, "fake-report.json"),
        FAKE_FETCH_ROUNDS: "1",
      },
    });
    assert.equal(outcome.passed, false);
    assert.equal(outcome.inconclusive, true);
    assert.match(outcome.reason ?? "", /bridge\/reporter request-count mismatch/);
    assert.equal(outcome.proxyEvidence.length, 1, "the bridge saw the single real request");
  } finally {
    await upstream.close();
  }
});

test("rev3/executor: bridgeReporterMismatch — zero bridge requests never PASS; exact matches stand", () => {
  const capture = normalizeMultiStepCapture({ testResults: passingTestResults() });
  const bridgeEvs = [
    { index: 1, method: "POST", path: "/api/login", queryKeys: [], requestHeaderNames: [], status: 200, authorization: false },
    { index: 2, method: "GET", path: "/api/session", queryKeys: [], requestHeaderNames: [], status: 200, authorization: true },
    { index: 3, method: "GET", path: "/api/slots", queryKeys: [], requestHeaderNames: [], status: 200, authorization: false },
    { index: 4, method: "POST", path: "/api/book", queryKeys: [], requestHeaderNames: [], status: 200, authorization: true },
  ];
  assert.match(bridgeReporterMismatch([], capture) ?? "", /zero requests/);
  assert.equal(bridgeReporterMismatch(bridgeEvs, capture), null, "four matching requests stand");
  const methodMismatch = [...bridgeEvs];
  methodMismatch[0] = { ...methodMismatch[0]!, method: "GET" };
  assert.match(bridgeReporterMismatch(methodMismatch, capture) ?? "", /method mismatch/);
  const statusMismatch = [...bridgeEvs];
  statusMismatch[1] = { ...statusMismatch[1]!, status: 500 };
  assert.match(bridgeReporterMismatch(statusMismatch, capture) ?? "", /status mismatch/);
  assert.equal(bridgeReporterMismatch(bridgeEvs.slice(0, 1), capture) !== null, true, "count mismatch detected");
});

test("rev3/executor: the canonical API-only spec is statically browser-free; a browser-touching script never runs", async () => {
  const proof = staticBrowserFreeScript("multistep-booking.spec.ts", SPEC_SOURCE);
  assert.equal(proof.free, true, JSON.stringify(proof.findings));

  const bad = [
    "import { test, chromium } from '@playwright/test'",
    "test('t', async () => {",
    "  const browser = await chromium.launch()",
    "  await browser.close()",
    "})",
  ].join("\n");
  const badProof = staticBrowserFreeScript("bad.spec.ts", bad);
  assert.equal(badProof.free, false);
  assert.ok(badProof.findings.length >= 2);

  const project = makeFakeProject();
  const outcome = await runMultiStepSandbox({
    baseUrl: "https://fixture.invalid",
    projectDir: project,
    files: { "bad.spec.ts": bad },
    checkFile: "bad.spec.ts",
    env: { FAKE_REPORT_FILE: join(project, "fake-report.json") },
  });
  assert.equal(outcome.passed, false);
  assert.equal(outcome.inconclusive, true);
  assert.match(outcome.reason ?? "", /browser APIs the adapter never launches/);
});

// ---------------------------------------------------------------------------
// 4. Transaction + sanitization: unique account, exact token occurrences, Bearer-only, overlap, allow-list
// ---------------------------------------------------------------------------

function rawPassing(): Record<string, any> {
  return JSON.parse(passingTestResults()) as Record<string, any>;
}
function resultSteps(raw: Record<string, any>): Array<Record<string, any>> {
  return raw.suites[0].suites[0].specs[0].tests[0].results[0].steps;
}
function requery(raw: Record<string, any>): string {
  return JSON.stringify(raw);
}

test("rev3/transaction: a second distinct account value across required sites is inconsistent (never recorded)", () => {
  const raw = rawPassing();
  const session = resultSteps(raw).find((s) => s.title === "session")!;
  session.steps[0].checklyData[0].body.account = "intruder-account-999";
  const capture = normalizeMultiStepCapture({ testResults: requery(raw) });
  assert.equal(capture.problems.length, 0, "the capture itself is structurally fine");
  const transaction = extractTransaction(capture);
  assert.ok(transaction.problems.some((p) => /distinct account values/.test(p)), JSON.stringify(transaction.problems));
  const recording = buildMultiStepRecording({ texts: { testResults: requery(raw), checkRunData: null, logs: null } });
  assert.equal(recording.ok, false, "conflicting accounts must never be sanitized into a recording");
});

test("rev3/transaction: the token must occur EXACTLY three times, Bearer-only, and nowhere else", () => {
  // a) token leaked into logs → unsupported occurrence
  const captureWithLog = normalizeMultiStepCapture({
    testResults: passingTestResults(),
    logs: JSON.stringify([{ level: "INFO", msg: `leaked ${FAKE_TOKEN}`, time: 1 }]),
  });
  const txA = extractTransaction(captureWithLog);
  assert.ok(txA.problems.some((p) => /unsupported location/.test(p)), JSON.stringify(txA.problems));
  assert.equal(buildMultiStepRecording({ texts: { testResults: passingTestResults(), checkRunData: null, logs: JSON.stringify([{ level: "INFO", msg: `leaked ${FAKE_TOKEN}`, time: 1 }]) } }).ok, false);

  // b) one Bearer header removed → not exactly three occurrences
  const raw = rawPassing();
  const book = resultSteps(raw).find((s) => s.title === "book 09:30")!;
  book.steps[0].checklyData[0].requestHeaders = [["content-type", "application/json"]];
  const txB = extractTransaction(normalizeMultiStepCapture({ testResults: requery(raw) }));
  assert.ok(txB.problems.some((p) => /exactly 3 token occurrences/.test(p)), JSON.stringify(txB.problems));

  // c) non-Bearer scheme → refused, never serializable
  const raw2 = rawPassing();
  const session = resultSteps(raw2).find((s) => s.title === "session")!;
  session.steps[0].checklyData[0].requestHeaders = [["authorization", "Basic dXNlcjpwYXNzd29yZA=="]];
  const captureC = normalizeMultiStepCapture({ testResults: requery(raw2) });
  const txC = extractTransaction(captureC);
  assert.ok(txC.problems.some((p) => /non-Bearer Authorization scheme/.test(p)), JSON.stringify(txC.problems));
  const recordingC = buildMultiStepRecording({ texts: { testResults: requery(raw2), checkRunData: null, logs: null } });
  assert.equal(recordingC.ok, false, "a non-Bearer capture must never be recorded");
});

test("rev3/sanitize: account-inside-token overlap is replaced longest-first and leaks nothing", () => {
  const account = "acct-overlap-0001";
  const token = "acct-overlap-0001-XYZtokEN99"; // token CONTAINS the account value
  const results = passingTestResults().split(FAKE_ACCOUNT).join(account).split(FAKE_TOKEN).join(token);
  const recording = buildMultiStepRecording({ texts: { testResults: results, checkRunData: null, logs: passingLogs() } });
  assert.ok(recording.ok, recording.ok ? "" : recording.reason);
  if (!recording.ok) return;
  const serialized = JSON.stringify(recording.recording);
  assert.ok(!serialized.includes(account), "the account value must not survive anywhere");
  assert.ok(!serialized.includes(token), "the token value must not survive anywhere");
  assert.ok(serialized.includes("<token>") && serialized.includes("<account>"), "opaque labels preserve the relationships");
  assert.ok(recording.secrets.includes(account) && recording.secrets.includes(token), "every original sensitive value is exposed for the file-level leak check");
});

test("rev3/sanitize: strict allow-list — unknown keys are dropped, check-run metadata removed, logs content redacted", () => {
  const raw = rawPassing();
  const login = resultSteps(raw).find((s) => s.title === "login")!;
  login.steps[0].checklyData[0].timings = { startTime: 1, endTime: 2, rawAuthorizationHeader: `Bearer ${FAKE_TOKEN}` };
  const capture = normalizeMultiStepCapture({ testResults: requery(raw), checkRunData: JSON.stringify({
    dependencies: { "@playwright/test": "1.50.0" },
    imports: [{ path: "x" }],
    playwrightConfig: { testDir: "." },
    script: `const x = 1 // ${FAKE_ACCOUNT}`,
    scriptPath: "checks/multistep-booking.spec.ts",
  }), logs: passingLogs() });
  assert.equal(capture.problems.length, 0, JSON.stringify(capture.problems));
  const transaction = extractTransaction(capture);
  const sanitized = sanitizeMultiStepCapture(capture, transaction);
  assert.ok(sanitized.ok, sanitized.ok ? "" : sanitized.reason);
  if (!sanitized.ok) return;
  const out = sanitized.capture;
  const request = out.steps.find((s) => s.title === "login")!.requests[0]!;
  assert.deepEqual(Object.keys(request).sort(), [
    "actual", "expected", "fetchUid", "method", "path", "queryKeys", "requestBody", "requestHeaders", "responseBody", "responseHeaders", "status", "statusText", "timings", "title", "url",
  ].sort(), "request evidence is an explicit allow-list — no captured keys survive");
  assert.deepEqual(request.timings, { startTime: 1, endTime: 2 }, "unknown timing keys are dropped, not inspected");
  assert.equal(out.checkRunData!.dependencies, null, "check-run metadata removed");
  assert.equal(out.checkRunData!.imports, null, "check-run metadata removed");
  assert.equal(out.checkRunData!.playwrightConfig, null, "check-run metadata removed");
  assert.equal(out.checkRunData!.script, null, "script content removed from the recording");
  assert.equal(out.checkRunData!.scriptPath, "checks/multistep-booking.spec.ts");
  assert.equal(out.logs![0]!.msg, "<redacted>", "log content never survives");
  assert.equal(out.steps[0]!.title, "login");
  const stepKeys = Object.keys(out.steps[0]!).sort();
  assert.deepEqual(stepKeys, ["assertions", "error", "requests", "status", "title"]);
  const serialized = JSON.stringify(out);
  assert.ok(!serialized.includes(FAKE_ACCOUNT) && !serialized.includes(FAKE_TOKEN) && !serialized.includes(FAKE_ORIGIN), "final leak check: no original sensitive value survives serialization");
});

// ---------------------------------------------------------------------------
// 5. Asset capture + ZIP bounds: hash-before-parse, symlink rejection, no fallback, all six limits
// ---------------------------------------------------------------------------

test("rev3/capture: raw assets are hashed BEFORE parsing and recorded for provenance", () => {
  const dir = mkdtempSync(join(tmpdir(), "verify-fix-rev3-assets-"));
  writeFileSync(join(dir, "test-results.json"), failingTestResults());
  writeFileSync(join(dir, "logs.txt"), failingLogs());
  const read = readMultiStepAssets(dir);
  const hashes = read.failing!.hashes!;
  const raw = readFileSync(join(dir, "test-results.json"));
  assert.equal(hashes["test-results.json"]!.sha256, createHash("sha256").update(raw).digest("hex"));
  assert.equal(hashes["test-results.json"]!.bytes, raw.byteLength);
  assert.ok(read.failing!.testResults, "parsing happens after hashing");
});

test("rev3/capture: explicit failing/ with a symlinked test-results.json is invalid — never a fallback to the flat parent", () => {
  const dir = mkdtempSync(join(tmpdir(), "verify-fix-rev3-symlink-"));
  // valid flat parent files
  writeFileSync(join(dir, "test-results.json"), passingTestResults());
  writeFileSync(join(dir, "logs.txt"), passingLogs());
  // explicit failing/ with a symlink
  const failingDir = join(dir, "failing");
  mkdirSync(failingDir);
  symlinkSync(join("..", "test-results.json"), join(failingDir, "test-results.json"));
  const read = readMultiStepAssets(dir);
  assert.match(read.failing!.invalid ?? "", /symbolic link/);
  assert.equal(read.failing!.testResults, null, "the flat parent content must NOT be used when the explicit path is invalid");
  assert.deepEqual(read.failing!.found, []);
});

test("rev3/zip: all six bounds are enforced at read time (no extraction to disk)", () => {
  // 1) archive bytes
  assert.throws(() => openZipBounded(Buffer.alloc(ASSET_ZIP_BOUNDS.maxArchiveBytes + 1)), /bound|archive/);
  // 2) entry count
  const many: Record<string, string> = {};
  for (let i = 0; i <= ASSET_ZIP_BOUNDS.maxEntries; i++) many[`f${i}`] = "x";
  assert.throws(() => openZipBounded(writeZip(many)), /entries/);
  // 3) per-entry compressed size (incompressible, stored via deflate attempt → declared sizes checked)
  const incompressible = randomBytes(ASSET_ZIP_BOUNDS.maxEntryCompressedBytes + 1024);
  assert.throws(() => openZipBounded(writeZip({ big: incompressible })), /compressed size|bound/);
  // 4) per-entry uncompressed size
  assert.throws(() => openZipBounded(writeZip({ big: "a".repeat(ASSET_ZIP_BOUNDS.maxEntryUncompressedBytes + 1) })), /uncompressed size|bound/);
  // 5) declared total uncompressed across entries
  const chunk = randomBytes(25 * 1024 * 1024); // ratio ≈ 1 so the ratio bound never fires first
  assert.throws(
    () => openZipBounded(writeZip({ a: chunk, b: chunk, c: chunk, d: chunk })), // 100 MiB declared > 96 MiB bound
    /total uncompressed|bound/,
  );
  // 6) compression ratio
  assert.throws(() => openZipBounded(writeZip({ r: "a".repeat(500_000) })), /compression ratio/);
});

test("rev3/zip: duplicate entry names and oversized direct files are rejected as invalid evidence", () => {
  // duplicate names: patch the second central-directory name to equal the first
  const zip = writeZip({ aaa: "first-entry-content", bbb: "second-entry-content" });
  const eocd = zip.length - 22;
  assert.equal(zip.readUInt32LE(eocd), 0x06054b50);
  const cdirOffset = zip.readUInt32LE(eocd + 16);
  let p = cdirOffset;
  // first central entry
  const nameLen1 = zip.readUInt16LE(p + 28);
  const extraLen1 = zip.readUInt16LE(p + 30);
  const commentLen1 = zip.readUInt16LE(p + 32);
  const first = zip.toString("utf8", p + 46, p + 46 + nameLen1);
  p += 46 + nameLen1 + extraLen1 + commentLen1;
  // second central entry: rename to the first name
  const nameLen2 = zip.readUInt16LE(p + 28);
  assert.equal(nameLen2, nameLen1, "the patch assumes equal-length names");
  zip.write(first, p + 46, nameLen2, "utf8");
  assert.throws(() => openZipBounded(zip), /duplicate entry name/);

  const dir = mkdtempSync(join(tmpdir(), "verify-fix-rev3-dupzip-"));
  writeFileSync(join(dir, "assets.zip"), zip);
  const read = readMultiStepAssets(dir);
  assert.match(read.failing!.invalid ?? "", /duplicate|invalid/);

  // direct oversized file bound
  const dir2 = mkdtempSync(join(tmpdir(), "verify-fix-rev3-bigfile-"));
  writeFileSync(join(dir2, "test-results.json"), Buffer.alloc(MAX_ASSET_FILE_BYTES + 1, 0x7b));
  const read2 = readMultiStepAssets(dir2);
  assert.match(read2.failing!.invalid ?? "", /exceeds the .*-byte bound/);

  // oversized assets.zip file bound (junk bytes over the archive limit)
  const dir3 = mkdtempSync(join(tmpdir(), "verify-fix-rev3-bigzip-"));
  writeFileSync(join(dir3, "assets.zip"), Buffer.alloc(ASSET_ZIP_BOUNDS.maxArchiveBytes + 1, 0x50));
  const read3 = readMultiStepAssets(dir3);
  assert.match(read3.failing!.invalid ?? "", /exceeds the .*-byte bound/);
});

// ---------------------------------------------------------------------------
// 6. TS-AST source modeling: const/import resolution, origin proof, unknown helpers, multiline assertions
// ---------------------------------------------------------------------------

test("rev3/source: statically provable local and imported consts resolve as step titles", () => {
  const local = parseMultiStepScript("x.spec.ts", [
    "import { test, expect } from '@playwright/test'",
    "const stepName = 'login'",
    "test('t', async ({ request }) => {",
    "  await test.step(stepName, async () => {})",
    "})",
  ].join("\n"));
  assert.equal(local.steps[0]!.title, "login");
  assert.ok(!local.errors.some((e) => e.includes("not a static string")));

  const files = new Map([
    ["x.spec.ts", [
      "import { test, expect } from '@playwright/test'",
      "import { stepName } from './consts'",
      "test('t', async ({ request }) => {",
      "  await test.step(stepName, async () => {})",
      "})",
    ].join("\n")],
    ["consts.ts", "export const stepName = 'session'\n"],
  ]);
  const imported = parseMultiStepScript("x.spec.ts", files.get("x.spec.ts")!, files);
  assert.equal(imported.steps[0]!.title, "session");
  assert.deepEqual(imported.errors, []);

  // unresolved local import → UNCERTAIN
  const unresolved = parseMultiStepScript("x.spec.ts", files.get("x.spec.ts")!, new Map([["x.spec.ts", files.get("x.spec.ts")!]]));
  assert.ok(unresolved.errors.some((e) => /unresolved local import/.test(e)), JSON.stringify(unresolved.errors));
});

test("rev3/source: every request URL must provably derive from process.env.ENVIRONMENT_URL", () => {
  const derived = parseMultiStepScript("x.spec.ts", [
    "import { test, expect } from '@playwright/test'",
    "const origin = process.env.ENVIRONMENT_URL",
    "test('t', async ({ request }) => {",
    "  await test.step('login', async () => { await request.get(`${origin}/api/x`) })",
    "})",
  ].join("\n"));
  assert.deepEqual(derived.errors, []);
  assert.equal(derived.requests.length, 1);
  assert.equal(derived.requests[0]!.urlTemplate, "`${origin}/api/x`");

  // validation-wrapper flow (the canonical shape): origin = wrap(env)
  const wrapper = parseMultiStepScript("x.spec.ts", [
    "import { test, expect } from '@playwright/test'",
    "function requireOrigin(v) { return v }",
    "const raw = process.env.ENVIRONMENT_URL",
    "const origin = requireOrigin(raw)",
    "test('t', async ({ request }) => {",
    "  await test.step('login', async () => { await request.post(`${origin}/api/login`, { data: {} }) })",
    "})",
  ].join("\n"));
  assert.deepEqual(wrapper.errors, []);

  // NOT derived: a literal origin
  const literal = parseMultiStepScript("x.spec.ts", [
    "import { test, expect } from '@playwright/test'",
    "const origin = 'https://forced.example'",
    "test('t', async ({ request }) => {",
    "  await test.step('login', async () => { await request.get(`${origin}/api/x`) })",
    "})",
  ].join("\n"));
  assert.ok(literal.errors.some((e) => e.includes("does not statically derive from process.env.ENVIRONMENT_URL")), JSON.stringify(literal.errors));

  // NOT derived: a different env var
  const other = parseMultiStepScript("x.spec.ts", [
    "import { test, expect } from '@playwright/test'",
    "const origin = process.env.OTHER_URL",
    "test('t', async ({ request }) => {",
    "  await test.step('login', async () => { await request.get(`${origin}/api/x`) })",
    "})",
  ].join("\n"));
  assert.ok(other.errors.some((e) => e.includes("does not statically derive from process.env.ENVIRONMENT_URL")), JSON.stringify(other.errors));
});

test("rev3/source: unknown helpers and aliases are UNCERTAIN — fetch, request aliases, computed access, imported wrappers", () => {
  const fetchCase = parseMultiStepScript("x.spec.ts", [
    "import { test, expect } from '@playwright/test'",
    "test('t', async ({ request }) => {",
    "  await fetch('https://example.test/api')",
    "})",
  ].join("\n"));
  assert.ok(fetchCase.errors.some((e) => /unsupported request helper/.test(e)), JSON.stringify(fetchCase.errors));

  const aliasCase = parseMultiStepScript("x.spec.ts", [
    "import { test, expect } from '@playwright/test'",
    "test('t', async ({ request }) => {",
    "  const api = request",
    "  await api.get('https://example.test/api')",
    "})",
  ].join("\n"));
  assert.ok(aliasCase.errors.some((e) => /request alias/.test(e)), JSON.stringify(aliasCase.errors));

  const computedCase = parseMultiStepScript("x.spec.ts", [
    "import { test, expect } from '@playwright/test'",
    "test('t', async ({ request }) => {",
    "  await request['get']('https://example.test/api')",
    "})",
  ].join("\n"));
  assert.ok(computedCase.errors.some((e) => /computed request access/.test(e)), JSON.stringify(computedCase.errors));

  const files = new Map([
    ["x.spec.ts", [
      "import { test, expect } from '@playwright/test'",
      "import { doLogin } from './helper'",
      "test('t', async ({ request }) => {",
      "  await doLogin()",
      "})",
    ].join("\n")],
    ["helper.ts", "export async function doLogin() {}\n"],
  ]);
  const wrapper = parseMultiStepScript("x.spec.ts", files.get("x.spec.ts")!, files);
  assert.ok(wrapper.errors.some((e) => /imported helper/.test(e)), JSON.stringify(wrapper.errors));
});

test("rev3/source: multiline expect() calls are extracted via AST with byte-identical assertion identity", () => {
  const single = parseMultiStepScript("x.spec.ts", [
    "import { test, expect } from '@playwright/test'",
    "test('t', async ({ request }) => {",
    "  await test.step('login', async () => {",
    "    expect(response.status()).toBe(200)",
    "  })",
    "})",
  ].join("\n"));
  assert.equal(single.assertions.length, 1);

  const multiline = parseMultiStepScript("x.spec.ts", [
    "import { test, expect } from '@playwright/test'",
    "test('t', async ({ request }) => {",
    "  await test.step('login', async () => {",
    "    expect(",
    "      response.status(),",
    "    ).toBe(",
    "      200,",
    "    )",
    "  })",
    "})",
  ].join("\n"));
  assert.equal(multiline.assertions.length, 1, JSON.stringify(multiline.errors));
  assert.equal(multiline.assertions[0]!.matcher, "toBe");
  assert.equal(multiline.assertions[0]!.target, "200");
  assert.equal(multiline.assertions[0]!.sourceLine, 4);
  assert.equal(multiline.assertions[0]!.stepTitle, "login");
  assert.equal(multiline.assertions[0]!.id, single.assertions[0]!.id, "identity is byte-identical to the single-line form");

  // multiline with an unsupported matcher stays UNCERTAIN
  const badMatcher = parseMultiStepScript("x.spec.ts", [
    "import { test, expect } from '@playwright/test'",
    "test('t', async () => {",
    "  expect(",
    "    value,",
    "  ).toBeExactly(",
    "    1,",
    "  )",
    "})",
  ].join("\n"));
  assert.ok(badMatcher.errors.some((e) => /unsupported matcher/.test(e)), JSON.stringify(badMatcher.errors));
});

test("rev3/policy: verdict precedence is unchanged — definite rejection outranks UNCERTAIN", () => {
  const original = parseMultiStepScript("x.spec.ts", [
    "import { test, expect } from '@playwright/test'",
    "test('t', async ({ request }) => {",
    "  await test.step('login', async () => { await request.post('https://x.test/api', { data: {} }) })",
    "  await test.step('session', async () => { await request.get('https://x.test/api') })",
    "})",
  ].join("\n"));
  const originalModel = { construct: { logicalId: "id", name: "n", entrypoint: "x.spec.ts", frequencyMinutes: 5, locations: [], runParallel: null, environmentKeys: [], errors: [] }, script: original, errors: [] };
  // candidate: removes a required step AND carries an unsupported import
  const candidateScript = parseMultiStepScript("y.spec.ts", [
    "import axios from 'axios'",
    "import { test, expect } from '@playwright/test'",
    "test('t', async ({ request }) => {",
    "  await test.step('login', async () => { await request.post('https://x.test/api', { data: {} }) })",
    "})",
  ].join("\n"));
  const candidateModel = { construct: originalModel.construct, script: candidateScript, errors: ["unsupported import"] };
  const result = evaluateMultiStepPolicy(originalModel as never, candidateModel as never);
  assert.ok(result.rejected, "definite rejection must be produced");
  assert.match(result.rejected ?? "", /removed or skipped/);
  assert.equal(result.uncertain, null, "rejected outranks uncertain — precedence unchanged");
});
