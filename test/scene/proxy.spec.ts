// Scene proxy: the four modes, per-run hit counting, and the lockstep
// interleaving that reproduces an overlap deterministically. Own tiny target,
// no example app needed.

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { SceneProxy, shouldInterleave } from "../../src/scene/proxy.ts";
import { parseMode } from "../../src/scene/modes.ts";
import type { Har, HarEntry } from "../../src/trace/har-types.ts";

let target: Server;
let targetUrl: string;
const arrivals: string[] = [];
let sessions = new Map<string, number>();

test("browser barrier admits fetch/API calls but not documents, assets, or Next.js RSC traffic", () => {
  const req = (headers: Record<string, string>, url = "/api/x", method = "GET") => ({ headers, url, method });
  assert.equal(shouldInterleave(req({})), true, "non-browser API clients omit Fetch Metadata");
  assert.equal(shouldInterleave(req({ "sec-fetch-dest": "empty" })), true, "browser fetch/XHR");
  assert.equal(shouldInterleave(req({ "sec-fetch-dest": "document" }, "/")), false);
  assert.equal(shouldInterleave(req({ "sec-fetch-dest": "script" }, "/_next/static/app.js")), false);
  assert.equal(shouldInterleave(req({ "sec-fetch-dest": "empty", rsc: "1" }, "/book")), false, "Next client navigation is not a business API call");
});

before(async () => {
  target = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const body = Buffer.concat(chunks).toString("utf8");
    const url = new URL(req.url ?? "/", "http://x");
    arrivals.push(`${req.method} ${url.pathname}`);
    if (url.pathname === "/api/login") {
      const { account } = JSON.parse(body) as { account: string };
      const version = (sessions.get(account) ?? 0) + 1;
      sessions.set(account, version);
      res.writeHead(200, { "content-type": "application/json", "x-echo-auth": req.headers.authorization ?? "" });
      return res.end(JSON.stringify({ token: `tok-${account}-${version}` }));
    }
    if (url.pathname === "/api/book") {
      const m = /^Bearer tok-(.+)-(\d+)$/.exec(req.headers.authorization ?? "");
      const current = m ? sessions.get(m[1]) : undefined;
      if (!m || current !== Number(m[2])) {
        res.writeHead(401, { "content-type": "application/json" });
        return res.end(JSON.stringify({ error: "session superseded by a newer login" }));
      }
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({ confirmed: true }));
    }
    if (url.pathname === "/go") {
      res.writeHead(302, { location: `${targetUrl}/landed?x=1` });
      return res.end();
    }
    if (url.pathname === "/slow") {
      await new Promise((r) => setTimeout(r, 30));
    }
    res.writeHead(200, { "content-type": "text/plain" });
    res.end(`ok ${url.pathname}${url.search}`);
  });
  await new Promise<void>((r) => target.listen(0, "127.0.0.1", () => r()));
  const addr = target.address() as { port: number };
  targetUrl = `http://127.0.0.1:${addr.port}`;
});
after(async () => {
  await new Promise<void>((r) => target.close(() => r()));
});

function entry(method: string, path: string, status: number, body: unknown, mime = "application/json"): HarEntry {
  return {
    startedDateTime: "2026-09-23T00:00:00Z",
    time: 1,
    request: { method, url: `https://recorded.example${path}`, httpVersion: "HTTP/1.1", cookies: [], headers: [], queryString: [], headersSize: -1, bodySize: -1 },
    response: { status, statusText: "", httpVersion: "HTTP/1.1", cookies: [], headers: [{ name: "content-type", value: mime }, { name: "set-cookie", value: "secret=1" }], content: { size: 0, mimeType: mime, text: typeof body === "string" ? body : JSON.stringify(body) }, headersSize: -1, bodySize: -1, redirectURL: "" },
    cache: {},
    timings: {},
  };
}
const har = (entries: HarEntry[]): Har => ({ log: { version: "1.2", creator: { name: "t", version: "0" }, pages: [], entries } });

const json = (method: string, url: string, body?: unknown, headers: Record<string, string> = {}) =>
  fetch(url, { method, headers: { "content-type": "application/json", ...headers }, body: body === undefined ? undefined : JSON.stringify(body), redirect: "manual" });

describe("scene proxy", () => {
  test("live: forwards method, path, query, body and headers; counts hits per run; rewrites redirects to the proxy", async () => {
    const proxy = new SceneProxy();
    try {
      const [url] = await proxy.arm({ mode: parseMode("live"), target: targetUrl, runs: 1 });
      const r1 = await json("POST", `${url}/api/login`, { account: "a" }, { authorization: "Bearer probe" });
      assert.equal(r1.status, 200);
      assert.equal(r1.headers.get("x-echo-auth"), "Bearer probe");
      const r2 = await fetch(`${url}/echo?q=1`);
      assert.equal(await r2.text(), "ok /echo?q=1");
      const r3 = await fetch(`${url}/go`, { redirect: "manual" });
      assert.equal(r3.status, 302);
      assert.equal(r3.headers.get("location"), `${url}/landed?x=1`, "Location back through the proxy, not to the target");
      assert.equal(proxy.hitsFor(0), 3);
      assert.deepEqual(proxy.hits().map((h) => `${h.ordinal}:${h.method} ${h.path} ${h.status} ${h.source}`), ["1:POST /api/login 200 target", "2:GET /echo 200 target", "3:GET /go 302 target"]);
    } finally {
      await proxy.close();
    }
  });

  test("live without a target answers 502 and records source=error (never a silent pass)", async () => {
    const proxy = new SceneProxy();
    try {
      const [url] = await proxy.arm({ mode: parseMode("live"), target: null, runs: 1 });
      const r = await fetch(`${url}/x`);
      assert.equal(r.status, 502);
      assert.match(await r.text(), /no target/);
      assert.equal(proxy.hits()[0].source, "error");
    } finally {
      await proxy.close();
    }
  });

  test("inject: only the matching request is answered — with the recorded failing response when the HAR has one", async () => {
    const proxy = new SceneProxy();
    try {
      const failing = har([entry("POST", "/api/login", 200, { token: "x" }), entry("POST", "/api/book", 401, { error: "recorded 401", account: "demo" })]);
      const [url] = await proxy.arm({ mode: parseMode("inject:POST /api/book -> 401"), target: targetUrl, runs: 1, failingHar: failing });
      const login = await json("POST", `${url}/api/login`, { account: "demo" });
      assert.equal(login.status, 200, "login passes through to the target");
      const book = await json("POST", `${url}/api/book`, { slot: "1" }, { authorization: "Bearer tok-demo-1" });
      assert.equal(book.status, 401);
      assert.deepEqual(await book.json(), { error: "recorded 401", account: "demo" });
      assert.equal(book.headers.get("set-cookie"), null, "recorded cookies are never replayed");
      const get = await fetch(`${url}/api/book`);
      assert.equal(get.status, 401, "same path, other method → not the rule → passes through (the target itself says 401 without a token)");
      assert.equal(proxy.hits().at(-1)?.source, "target");
      assert.deepEqual(proxy.hits().map((h) => h.source), ["target", "injected", "target"]);

      // no recording → synthetic body, same status
      await proxy.arm({ mode: parseMode("inject:POST /api/book -> 503"), target: targetUrl, runs: 1 });
      const synth = await json("POST", `${proxy.urlFor(0)}/api/book`, {});
      assert.equal(synth.status, 503);
      assert.match((await synth.json()).error, /injected by verify-fix/);
    } finally {
      await proxy.close();
    }
  });

  test("replay: recorded responses in order, path+query matching, unmatched → 404 counted as unmatched, target never contacted", async () => {
    const proxy = new SceneProxy();
    try {
      const before = arrivals.length;
      const recording = har([entry("GET", "/api/slots?day=1", 200, { slots: ["a"] }), entry("GET", "/api/slots?day=2", 200, { slots: ["b"] }), entry("POST", "/api/login", 200, { token: "first" }), entry("POST", "/api/login", 200, { token: "second" })]);
      const [url] = await proxy.arm({ mode: parseMode("replay:passing.har"), target: null, runs: 1, replayHar: recording });
      assert.deepEqual(await (await fetch(`${url}/api/slots?day=2`)).json(), { slots: ["b"] }, "query string selects the entry");
      assert.deepEqual(await (await json("POST", `${url}/api/login`, {})).json(), { token: "first" });
      assert.deepEqual(await (await json("POST", `${url}/api/login`, {})).json(), { token: "second" });
      assert.deepEqual(await (await json("POST", `${url}/api/login`, {})).json(), { token: "second" }, "the last recorded response repeats");
      const miss = await fetch(`${url}/api/never`);
      assert.equal(miss.status, 404);
      assert.equal(proxy.hits().at(-1)?.source, "unmatched");
      assert.equal(arrivals.length, before, "the target saw nothing");
    } finally {
      await proxy.close();
    }
  });

  test("browser replay: API responses come from an API-only HAR while explicit target supplies omitted page assets", async () => {
    const proxy = new SceneProxy();
    try {
      const recording = har([entry("POST", "/api/login", 200, { token: "recorded" }), entry("GET", "/app.js", 200, "recorded asset")]);
      const [url] = await proxy.arm({ mode: parseMode("replay:passing.har"), target: targetUrl, runs: 1, replayHar: recording, replayBrowserAssetsFromTarget: true });
      const api = await fetch(`${url}/api/login`, { method: "POST", headers: { "sec-fetch-dest": "empty" } });
      assert.deepEqual(await api.json(), { token: "recorded" });
      const asset = await fetch(`${url}/app.js`, { headers: { "sec-fetch-dest": "script" } });
      assert.equal(await asset.text(), "ok /app.js");
      assert.deepEqual(proxy.hits().map((h) => h.source), ["recording", "target"]);
    } finally {
      await proxy.close();
    }
  });

  test("live-concurrent: two runs are interleaved request by request → login, login, book, book → the first run's booking is 401", async () => {
    const proxy = new SceneProxy();
    try {
      sessions = new Map();
      const start = arrivals.length;
      const urls = await proxy.arm({ mode: parseMode("live-concurrent:2"), target: targetUrl, runs: 2, barrierTimeoutMs: 2000 });
      const client = async (i: number, delayMs: number) => {
        await new Promise((r) => setTimeout(r, delayMs));
        const login = await json("POST", `${urls[i]}/api/login`, { account: "shared" });
        const { token } = (await login.json()) as { token: string };
        // deliberately slow run 2 between its requests: lockstep must not depend on timing
        await new Promise((r) => setTimeout(r, i === 1 ? 60 : 0));
        const book = await json("POST", `${urls[i]}/api/book`, { slot: "1" }, { authorization: `Bearer ${token}` });
        proxy.runFinished(i);
        return book.status;
      };
      const [s1, s2] = await Promise.all([client(0, 0), client(1, 25)]);
      assert.deepEqual(arrivals.slice(start), ["POST /api/login", "POST /api/login", "POST /api/book", "POST /api/book"], "the target saw the interleaving, not two sequential flows");
      assert.equal(s1, 401, "run 1 was superseded by run 2's login");
      assert.equal(s2, 200);
      assert.equal(proxy.hitsFor(0), 2);
      assert.equal(proxy.hitsFor(1), 2);
    } finally {
      await proxy.close();
    }
  });

  test("live-concurrent: a run that exits early releases the others (runFinished), and the barrier times out rather than hanging", async () => {
    const proxy = new SceneProxy();
    try {
      const urls = await proxy.arm({ mode: parseMode("live-concurrent:2"), target: targetUrl, runs: 2, barrierTimeoutMs: 150 });
      // run 2 never sends anything and exits
      proxy.runFinished(1);
      const t0 = Date.now();
      const r = await fetch(`${urls[0]}/alone`);
      assert.equal(r.status, 200);
      assert.ok(Date.now() - t0 < 150, "no wait once the other run is known to be finished");

      await proxy.arm({ mode: parseMode("live-concurrent:2"), target: targetUrl, runs: 2, barrierTimeoutMs: 120 });
      const t1 = Date.now();
      const r2 = await fetch(`${proxy.urlFor(0)}/waits`);
      assert.equal(r2.status, 200);
      const waited = Date.now() - t1;
      assert.ok(waited >= 100 && waited < 2000, `barrier timeout released the request after ${waited} ms`);
    } finally {
      await proxy.close();
    }
  });
});
