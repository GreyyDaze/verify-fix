// Integration test: the EXACT unchanged canonical Multistep file
// (examples/slots-booking/web/checks/multistep-booking.spec.ts) executed
// through the Multistep adapter against local synthetic HTTP apps.
//
// Mechanics-only: the responses are locally generated and prove adapter
// mechanics (HTTPS origin bridge, ordered request observation, structured
// evidence, no browser) — they are never real Checkly, browser, deployment,
// or cloud proof, and never an application-repair proof.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { join } from "node:path";
import { runMultiStepSandbox } from "../../src/multistep/executor.ts";

const WEB = new URL("../../examples/slots-booking/web/", import.meta.url).pathname;
// Byte-exact canonical source — read from disk, never edited by these tests.
// The STALE incident contract is committed as a fixture so these tests do not
// depend on whether the live example has been repaired.
const CANONICAL_SPEC = readFileSync(new URL("./fixtures/canonical-stale-multistep.spec.ts", import.meta.url), "utf8");

const ACCOUNT = "user-fixture-001";
const TOKEN = "tok-fixture-canonical-0001";
const ORDERED_PATHS = ["/api/login", "/api/session", "/api/slots", "/api/book"];

interface ReceivedRequest {
  method: string;
  url: string;
  authorization: string | null;
  bypass: string | null;
  body: Record<string, unknown> | null;
  statusSent: number;
}

interface SyntheticApp {
  url: string;
  received: ReceivedRequest[];
  close: () => Promise<void>;
}

/** Minimal local app: 'flat' answers the old contract (check passes),
 *  'nested' answers the incident contract (check fails inside 'book 09:30'). */
function startSyntheticApp(mode: "flat" | "nested", errorAt?: { position: number; status: 401 | 500 }): Promise<SyntheticApp> {
  const received: ReceivedRequest[] = [];
  const handler = (req: IncomingMessage, res: ServerResponse): void => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      let body: Record<string, unknown> | null = null;
      try {
        body = raw.length > 0 ? (JSON.parse(raw) as Record<string, unknown>) : null;
      } catch {
        body = null;
      }
      const authorization = typeof req.headers.authorization === "string" ? req.headers.authorization : null;
      const authed = authorization === `Bearer ${TOKEN}`;
      const url = req.url ?? "/";
      let status = 200;
      let payload: unknown;
      if (req.method === "POST" && url === "/api/login") {
        payload = { ok: true, account: ACCOUNT, version: 1, token: TOKEN, store: "memory" };
      } else if (req.method === "GET" && url === "/api/session") {
        payload = authed
          ? { valid: true, account: ACCOUNT, tokenVersion: 1, currentVersion: 1 }
          : { valid: false };
        if (!authed) status = 401;
      } else if (req.method === "GET" && url === "/api/slots") {
        payload = { slots: ["09:30", "10:00"], delayMs: 0 };
      } else if (req.method === "POST" && url === "/api/book") {
        if (!authed) {
          status = 401;
          payload = { error: "unauthorized" };
        } else if (mode === "flat") {
          payload = { confirmed: true, booking: "CONFIRMED", account: ACCOUNT, slot: "09:30", version: 1 };
        } else {
          payload = { booking: { confirmed: true, status: "CONFIRMED", account: ACCOUNT, slot: "09:30", sessionVersion: 1 } };
        }
      } else {
        status = 404;
        payload = { error: "not found" };
      }
      if (errorAt && received.length === errorAt.position) status = errorAt.status;
      received.push({ method: req.method ?? "", url, authorization,
        bypass: typeof req.headers["x-vercel-protection-bypass"] === "string"
          ? req.headers["x-vercel-protection-bypass"] : null, body, statusSent: status });
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(payload));
    });
  };
  return new Promise((resolve) => {
    const server: Server = createServer(handler);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (!addr || typeof addr !== "object") throw new Error("synthetic app: no port");
      resolve({
        url: `http://127.0.0.1:${addr.port}`,
        received,
        close: () => new Promise<void>((done) => server.close(() => done())),
      });
    });
  });
}

/** Samples the process table during a run; any browser-family process fails.
 * The match is EXACT: a prefix match counted unrelated system processes such
 * as `chrome-devtools-mcp` (an MCP server, not a browser) as browsers. Real
 * browser executables report their exact name in `comm` (chrome, chromium,
 * headless_shell, firefox, webkit, electron); anything with a suffix is not
 * a browser process the verifier started. */
function watchBrowserProcesses(): { stop: () => number } {
  let max = 0;
  const timer = setInterval(() => {
    try {
      const table = execSync("ps -eo comm=", { encoding: "utf8", maxBuffer: 4 * 1024 * 1024 });
      let hits = 0;
      for (const line of table.split("\n")) {
        const name = line.trim();
        if (/^(chrome|chromium|headless_shell|firefox|webkit|electron)$/i.test(name)) hits += 1;
      }
      if (hits > max) max = hits;
    } catch {
      /* sampling only */
    }
  }, 120);
  return {
    stop: () => {
      clearInterval(timer);
      return max;
    },
  };
}

function runCanonical(appUrl: string, timeoutMs = 150_000) {
  return runMultiStepSandbox({
    baseUrl: appUrl,
    projectDir: WEB,
    files: { "multistep-booking.spec.ts": CANONICAL_SPEC },
    checkFile: "multistep-booking.spec.ts",
    env: { REGION: "us-east-1", MULTISTEP_USER_US_EAST_1: ACCOUNT, MULTISTEP_USER_EU_WEST_1: "fixture-west-distinct",
      CHECKLY_SECRET_VERCEL_AUTOMATION_BYPASS_SECRET: "synthetic-bypass-sandbox-376" },
    timeoutMs,
  });
}

test("canonical spec through the adapter (passing flat app): HTTPS origin kept, four ordered requests, reaches 'confirm transaction', zero browsers, structured evidence", { timeout: 180_000 }, async () => {
  const app = await startSyntheticApp("flat");
  const watcher = watchBrowserProcesses();
  try {
    const out = await runCanonical(app.url);
    const maxBrowsers = watcher.stop();

    // ENVIRONMENT_URL stayed HTTPS (origin replaced to the trusted bridge only)
    assert.ok(out.environmentOrigin, "environmentOrigin must be recorded");
    assert.ok(out.environmentOrigin.startsWith("https://127.0.0.1:"), `expected a https bridge origin, got ${out.environmentOrigin}`);

    assert.equal(out.inconclusive, false, out.reason ?? "");
    assert.equal(out.passed, true, JSON.stringify(out.capture?.steps ?? null, null, 2));

    // four ordered requests observed at the bridge
    assert.deepEqual(
      out.proxyEvidence.map((e) => `${e.method} ${e.path}`),
      ["POST /api/login", "GET /api/session", "GET /api/slots", "POST /api/book"],
    );
    assert.ok(out.proxyEvidence.every((e) => e.status === 200), "all four upstream responses were HTTP 200");

    // passing evidence reaches 'confirm transaction'
    const steps = out.capture?.steps ?? [];
    assert.deepEqual(steps.map((s) => s.title), ["login", "session", "slots", "book 09:30", "confirm transaction"]);
    assert.ok(steps.every((s) => s.status === "passed"), JSON.stringify(steps));

    // no browser process at any sampled moment
    assert.equal(out.browserProcesses, 0);
    assert.equal(maxBrowsers, 0, "the Multistep adapter must launch no browser process");

    // evidence lives in structured artifacts, not stderr
    assert.equal(typeof out.diagnostics.stderrBytes, "number", "stderr is counted as diagnostics only — content is never retained");
    assert.ok(!("stderr" in out.diagnostics), "raw stderr content must never be retained");
    const structured = JSON.stringify(out.proxyEvidence) + JSON.stringify(out.capture);
    assert.ok(structured.includes("login") && structured.includes('"path":"/api/login"'), "structured evidence carries the ordered requests");
    assert.ok(!JSON.stringify(out.diagnostics).includes('"path":"/api/login"'), "the ordered-request evidence must not be parsed from stderr");

    // preservation proven upstream through the bridge: method/path/body/headers
    assert.equal(app.received.length, 4, "exactly four requests reached the upstream");
    assert.deepEqual(app.received.map((r) => r.url), ORDERED_PATHS);
    assert.deepEqual(app.received.map((r) => r.method), ["POST", "GET", "GET", "POST"]);
    assert.deepEqual(app.received[0]?.body, { account: ACCOUNT });
    assert.equal(app.received[1]?.authorization, `Bearer ${TOKEN}`);
    assert.equal(app.received[3]?.authorization, `Bearer ${TOKEN}`);
    assert.deepEqual(app.received[3]?.body, { slot: "09:30" });
    assert.ok(app.received.every((request) => request.bypass === "synthetic-bypass-sandbox-376"),
      "every canonical request forwards the approved bypass header to the protected target");
    assert.ok(!JSON.stringify(out.proxyEvidence).includes("synthetic-bypass-sandbox-376"),
      "bounded bridge evidence retains header NAMES, never bypass values");
    assert.ok(!JSON.stringify(out.trace).includes("synthetic-bypass-sandbox-376"));
  } finally {
    watcher.stop();
    await app.close();
  }
});

test("canonical spec through the adapter (failing nested app): four requests complete, failure stops inside 'book 09:30', zero browsers, structured evidence", { timeout: 180_000 }, async () => {
  const app = await startSyntheticApp("nested");
  const watcher = watchBrowserProcesses();
  try {
    const out = await runCanonical(app.url);
    const maxBrowsers = watcher.stop();

    assert.ok(out.environmentOrigin?.startsWith("https://127.0.0.1:"), `expected a https bridge origin, got ${out.environmentOrigin}`);
    assert.equal(out.inconclusive, false, out.reason ?? "");
    assert.equal(out.passed, false, "the nested contract must fail the stale flat-contract assertions");

    // four ordered requests still observed — all completed with HTTP 200
    assert.deepEqual(
      out.proxyEvidence.map((e) => `${e.method} ${e.path}`),
      ["POST /api/login", "GET /api/session", "GET /api/slots", "POST /api/book"],
    );
    assert.ok(out.proxyEvidence.every((e) => e.status === 200));
    assert.equal(app.received.length, 4);

    // first three steps pass, failure stops inside 'book 09:30',
    // 'confirm transaction' never runs
    const steps = out.capture?.steps ?? [];
    const byTitle = new Map(steps.map((s) => [s.title, s.status]));
    assert.equal(byTitle.get("login"), "passed");
    assert.equal(byTitle.get("session"), "passed");
    assert.equal(byTitle.get("slots"), "passed");
    assert.equal(byTitle.get("book 09:30"), "failed");
    assert.notEqual(byTitle.get("confirm transaction"), "passed", "'confirm transaction' must not pass");
    assert.equal(byTitle.has("confirm transaction"), false, "'confirm transaction' is absent when the prior step fails");

    // zero browsers, structured-not-stderr
    assert.equal(out.browserProcesses, 0);
    assert.equal(maxBrowsers, 0, "the Multistep adapter must launch no browser process");
    assert.ok(!JSON.stringify(out.diagnostics).includes('"path":"/api/book"'), "the ordered-request evidence must not be parsed from stderr");
    assert.ok(JSON.stringify(out.proxyEvidence).includes('"path":"/api/book"'));
  } finally {
    watcher.stop();
    await app.close();
  }
});

// A failed status assertion, even on the fourth booking request, is NOT the
// source-bound stale-body assertion. A prefix or transport error cannot be
// promoted into a conclusive negative observation.
test("live mocked bridge rejects HTTP 401 and 500 at EACH canonical request position as UNCERTAIN", { timeout: 180_000 }, async () => {
  for (const status of [401, 500] as const) {
    for (let position = 0; position < 4; position++) {
      const app = await startSyntheticApp("nested", { position, status });
      try {
        const out = await runCanonical(app.url);
        assert.equal(out.inconclusive, true, `request ${position + 1}, HTTP ${status}: ${out.reason}`);
        assert.equal(out.passed, false);
        assert.equal(out.proxyEvidence.length, position + 1, "never claim later steps executed");
        assert.equal(out.proxyEvidence.at(-1)?.status, status);
        assert.ok(out.reason && !out.reason.includes(ACCOUNT) && !out.reason.includes(TOKEN));
      } finally { await app.close(); }
    }
  }
});
