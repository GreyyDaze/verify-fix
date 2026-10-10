// Focused mechanics tests for the trusted HTTPS origin bridge: origin-only
// replacement, preservation of method/path/query/body/headers, unmodified
// response pass-through, forward-error surfacing, and values-free structured
// evidence. Locally generated responses are mechanics-only; this file never
// contacts a real target, Checkly, or any cloud service.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { request as httpsRequest } from "node:https";
import { readFile } from "node:fs/promises";
import { startOriginBridge } from "../../src/multistep/origin-bridge.ts";

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
      records.push({
        method: req.method ?? "",
        url: req.url ?? "",
        headers: { ...req.headers },
        body: Buffer.concat(chunks).toString("utf8"),
      });
      if ((req.url ?? "").startsWith("/big")) {
        // deliberately over the bridge's response bound (10 MiB)
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
      res.writeHead(201, {
        "content-type": "application/json",
        "x-upstream": "exact-value",
        "set-cookie": "upstream=mechanics; Path=/",
      });
      res.end(JSON.stringify({ echoed: true, at: "upstream" }));
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (!addr || typeof addr !== "object") throw new Error("upstream: no port");
      resolve({
        url: `http://127.0.0.1:${addr.port}`,
        records,
        close: () => new Promise<void>((done) => server.close(() => done())),
      });
    });
  });
}

function bridgeRequest(
  origin: string,
  ca: Buffer,
  method: string,
  target: string,
  headers: Record<string, string>,
  body: string,
): Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: string }> {
  return new Promise((resolve, reject) => {
    const url = new URL(target, origin);
    const req = httpsRequest(
      url,
      { method, headers, ca, servername: "127.0.0.1" },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: { ...res.headers }, body: Buffer.concat(chunks).toString("utf8") }));
      },
    );
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

test("bridge replaces only the origin: method, path, query, body, and headers are preserved; the response passes through unmodified", async () => {
  const upstream = await startUpstream();
  const bridge = await startOriginBridge(upstream.url);
  try {
    assert.ok(bridge.origin.startsWith("https://127.0.0.1:"), `ENVIRONMENT_URL must stay https, got ${bridge.origin}`);
    const ca = await readFile(bridge.caPath);
    const payload = JSON.stringify({ account: "user-fixture-001", note: "body-bytes-intact" });
    const res = await bridgeRequest(
      bridge.origin,
      ca,
      "POST",
      "/api/probe?region=us-east-1&q=two+words&list=1&list=2",
      {
        "content-type": "application/json",
        authorization: "Bearer tok-fixture-unit-0001",
        "x-relevant-header": "keep-me",
        "content-length": String(Buffer.byteLength(payload)),
      },
      payload,
    );

    // response passed through unmodified (no response rewriting)
    assert.equal(res.status, 201);
    assert.equal(res.headers["x-upstream"], "exact-value");
    assert.deepEqual(res.headers["set-cookie"], ["upstream=mechanics; Path=/"]);
    assert.equal(res.body, JSON.stringify({ echoed: true, at: "upstream" }));

    // upstream observed the original method/path/query/body/headers
    assert.equal(upstream.records.length, 1);
    const seen = upstream.records[0]!;
    assert.equal(seen.method, "POST");
    assert.equal(seen.url, "/api/probe?region=us-east-1&q=two+words&list=1&list=2");
    assert.equal(seen.body, payload);
    assert.equal(seen.headers["authorization"], "Bearer tok-fixture-unit-0001");
    assert.equal(seen.headers["x-relevant-header"], "keep-me");
    assert.equal(seen.headers["content-type"], "application/json");

    // Structured evidence preserves order, status and auth presence, but
    // unknown routes and arbitrary query-key names cannot enter the bundle.
    assert.equal(bridge.evidence.length, 1);
    const ev = bridge.evidence[0]!;
    assert.equal(ev.index, 1);
    assert.equal(ev.method, "POST");
    assert.equal(ev.path, "<unknown-route>");
    assert.deepEqual(ev.queryKeys, []);
    assert.equal(ev.hasQuery, true);
    assert.equal(ev.status, 201);
    assert.equal(ev.authorization, true);
    assert.ok(ev.requestHeaderNames.includes("authorization"));
    assert.ok(!ev.requestHeaderNames.includes("x-relevant-header"), "unknown header names are not evidence");
    const serialized = JSON.stringify(bridge.evidence);
    assert.ok(!serialized.includes("tok-fixture-unit-0001"), "evidence must never contain the Authorization value");
    assert.ok(!serialized.includes("keep-me"), "evidence must never contain header values");
    assert.ok(!serialized.includes("user-fixture-001"), "evidence must never contain body bytes");
    assert.ok(!serialized.includes("two+words") && !serialized.includes("region=us-east-1"), "evidence must never contain raw query values");
  } finally {
    await bridge.close();
    await upstream.close();
  }
});

test("bridge marks an unreachable upstream as a forward error (UNCERTAIN material), never as an application response", async () => {
  const bridge = await startOriginBridge("http://127.0.0.1:9");
  try {
    const ca = await readFile(bridge.caPath);
    const res = await bridgeRequest(bridge.origin, ca, "GET", "/api/login", {}, "");
    assert.equal(res.status, 502);
    const ev = bridge.evidence[0];
    assert.ok(ev?.forwardError === true, "forward errors must be recorded on the structured evidence");
    assert.equal(ev?.status, 502);
    assert.ok(!res.body.includes("Error:"), "the bridge must not leak raw error text as application evidence");
  } finally {
    await bridge.close();
  }
});

test("startOriginBridge refuses targets whose boundary cannot be trusted (non-http upstreams)", async () => {
  await assert.rejects(startOriginBridge("ftp://127.0.0.1:21"), /http or https/);
  await assert.rejects(startOriginBridge("not a url"), /valid URL/);
});
