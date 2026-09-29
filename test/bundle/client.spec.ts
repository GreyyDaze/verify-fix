import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChecklyClient, ChecklyApiError, MAX_API_JSON_BYTES } from "../../src/checkly/client.ts";
import { resolveCredentials, checklyCliConfigDir } from "../../src/checkly/credentials.ts";

type Call = { url: string; init: RequestInit };

function fakeFetch(handler: (url: string, init: RequestInit) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const f = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init: init ?? {} });
    return handler(url, init ?? {});
  }) as unknown as typeof fetch;
  return { fetch: f, calls };
}

const creds = { apiKey: "cu_test_key", accountId: "acct-123", source: "env" as const };

test("client: API calls carry bearer + account headers; presigned downloads carry none", async () => {
  const { fetch, calls } = fakeFetch((url) => {
    if (url.startsWith("https://api.checklyhq.com/v1/checks/abc")) return new Response(JSON.stringify({ id: "abc", name: "c" }), { status: 200 });
    if (url.startsWith("https://s3.example/trace.zip")) return new Response(new Uint8Array([1, 2, 3]), { status: 200 });
    return new Response("nope", { status: 404 });
  });
  const c = new ChecklyClient(creds, { fetchImpl: fetch, baseUrl: "https://api.checklyhq.com" });
  const check = await c.getCheck("abc");
  assert.equal(check.id, "abc");
  const h1 = calls[0].init.headers as Record<string, string>;
  assert.equal(h1.authorization, "Bearer cu_test_key");
  assert.equal(h1["x-checkly-account"], "acct-123");

  const buf = await c.download("https://s3.example/trace.zip?X-Amz-Signature=zzz");
  assert.deepEqual([...buf], [1, 2, 3]);
  const h2 = calls[1].init.headers as Record<string, string>;
  assert.equal(h2.authorization, undefined, "no credentials to a presigned URL");
  assert.equal(h2["x-checkly-account"], undefined);
  // provenance records fixed operation categories, never paths or signatures
  assert.deepEqual(c.calls.map((x) => x.url), ["get-check", "asset"]);
});

test("client: list results builds the v2 query, RCA 202 is 'pending', errors carry status", async () => {
  const seen: string[] = [];
  const { fetch } = fakeFetch((url) => {
    seen.push(url);
    if (url.includes("/v2/check-results/")) return new Response(JSON.stringify({ entries: [{ id: "r1" }], nextId: null }), { status: 200 });
    if (url.endsWith("/v1/root-cause-analyses/rca-1")) return new Response(JSON.stringify({ id: "rca-1", status: "PENDING" }), { status: 202 });
    if (url.endsWith("/v1/root-cause-analyses/rca-2")) return new Response(JSON.stringify({ id: "rca-2", analysis: { classification: "x" } }), { status: 200 });
    return new Response(JSON.stringify({ statusCode: 401, message: "Bad Token" }), { status: 401 });
  });
  const c = new ChecklyClient(creds, { fetchImpl: fetch, baseUrl: "https://api.checklyhq.com" });
  const page = await c.listResults("chk", { limit: 50, resultType: "FINAL", hasFailures: true, fields: ["id", "startedAt"] });
  assert.equal(page.entries[0].id, "r1");
  assert.equal(seen[0], "https://api.checklyhq.com/v2/check-results/chk?limit=50&hasFailures=true&resultType=FINAL&fields=id%2CstartedAt");
  assert.deepEqual(await c.getRca("rca-1"), { status: "pending" });
  const ready = await c.getRca("rca-2");
  assert.equal(ready.status, "ready");
  await assert.rejects(c.getCheck("missing"), (err: unknown) => err instanceof ChecklyApiError && err.status === 401 && /Bad Token/.test(err.message));
});

test("client: triggering an RCA reads the id from the 202 body (the live failure of 2026-09-23)", async () => {
  // POST /v1/root-cause-analyses/error-groups/{id} answers 202 Accepted with
  // {id, status: "PENDING"} — the same body the Checkly CLI's `rca run` reads.
  // The first live --trigger-rca dropped every 202 body and crashed on `id`.
  const posts: Array<{ url: string; body: string | null; contentType: string | undefined }> = [];
  const { fetch } = fakeFetch((url, init) => {
    if (init?.method === "POST") {
      posts.push({ url, body: (init.body as string | undefined) ?? null, contentType: (init.headers as Record<string, string>)["content-type"] });
      if (url.endsWith("/error-groups/eg-empty")) return new Response(null, { status: 202 });
      return new Response(JSON.stringify({ id: "rca-new", status: "PENDING" }), { status: 202 });
    }
    if (url.endsWith("/v1/root-cause-analyses/rca-new")) {
      return posts.length < 2
        ? new Response(JSON.stringify({ id: "rca-new", status: "PENDING" }), { status: 202 })
        : new Response(JSON.stringify({ id: "rca-new", status: "COMPLETED", analysis: { classification: "CONFIGURATION_ERROR" } }), { status: 200 });
    }
    return new Response("nope", { status: 404 });
  });
  const c = new ChecklyClient(creds, { fetchImpl: fetch, baseUrl: "https://api.checklyhq.com", sleep: async () => {} });
  assert.deepEqual(await c.triggerRca("eg-1"), { id: "rca-new" });
  assert.equal(posts[0].url, "https://api.checklyhq.com/v1/root-cause-analyses/error-groups/eg-1");
  assert.equal(posts[0].body, null, "no user context → no body, exactly like the CLI");
  // optional free-text context is sent the way `checkly rca run --user-context` sends it
  assert.deepEqual(await c.triggerRca("eg-1", "failing run 01a0cf22 reports element(s) not found"), { id: "rca-new" });
  assert.equal(posts[1].body, JSON.stringify({ userContext: "failing run 01a0cf22 reports element(s) not found" }));
  assert.equal(posts[1].contentType, "application/json");
  // then the poll: 202 (pending) … 200 (ready)
  const rca = await c.waitForRca("rca-new", 10_000, 1);
  assert.equal(rca?.analysis.classification, "CONFIGURATION_ERROR");
  // an accepted trigger without an id is an error we can name, not a crash on destructuring
  await assert.rejects(c.triggerRca("eg-empty"), (err: unknown) => err instanceof ChecklyApiError && err.status === 202 && /no RCA id in the response body/.test(err.message));
});

test("client: retries 429 with backoff then succeeds", async () => {
  let n = 0;
  const { fetch } = fakeFetch(() => {
    n += 1;
    return n < 3 ? new Response("slow down", { status: 429, headers: { "retry-after": "0" } }) : new Response(JSON.stringify({ id: "ok" }), { status: 200 });
  });
  const waits: number[] = [];
  const c = new ChecklyClient(creds, { fetchImpl: fetch, baseUrl: "https://api.checklyhq.com", sleep: async (ms) => { waits.push(ms); } });
  assert.equal((await c.getCheck("x")).id, "ok");
  assert.equal(n, 3);
  assert.equal(waits.length, 2);
});

test("client: API JSON and signed-asset Content-Length bounds cancel bodies before reading", async () => {
  let cancelled = 0;
  const makeBody = () => new ReadableStream<Uint8Array>({ cancel() { cancelled += 1; } });
  const { fetch } = fakeFetch((url) => new Response(makeBody(), {
    status: 200,
    headers: { "content-length": String(url.includes("/v1/checks/") ? MAX_API_JSON_BYTES + 1 : 1025) },
  }));
  const c = new ChecklyClient(creds, { fetchImpl: fetch });
  await assert.rejects(c.getCheck("over-limit"), /JSON byte bound/);
  await assert.rejects(c.download("https://assets.example.invalid/file", 1024), /Content-Length/);
  assert.equal(cancelled, 2, "both oversized streams are cancelled without collecting their bodies");
});

test("client: streaming JSON and remote assets stop at their byte budgets even without a Content-Length", async () => {
  let cancelled = 0;
  const { fetch } = fakeFetch((url) => new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      if (url.includes("/v1/checks/")) {
        for (let i = 0; i < 4; i++) controller.enqueue(new Uint8Array(4 * 1024 * 1024));
        controller.enqueue(new Uint8Array(1));
      } else {
        controller.enqueue(new Uint8Array(7));
        controller.enqueue(new Uint8Array(6));
      }
    },
    cancel() { cancelled += 1; },
  }), { status: 200 }));
  const c = new ChecklyClient(creds, { fetchImpl: fetch });
  await assert.rejects(c.getCheck("over-limit"), /JSON byte bound/);
  await assert.rejects(c.download("https://assets.example.invalid/file", 10), /stream/);
  assert.equal(cancelled, 2);
});

test("credentials: env wins; otherwise the Checkly CLI login files are read; values never leave the object", () => {
  const home = mkdtempSync(join(tmpdir(), "vf-creds-"));
  try {
    const env: NodeJS.ProcessEnv = { HOME: home, XDG_CONFIG_HOME: join(home, ".config") };
    assert.equal(resolveCredentials(env, "linux"), null);
    const dir = checklyCliConfigDir(env, "linux");
    assert.equal(dir, join(home, ".config", "@checkly/cli"));
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "auth.json"), JSON.stringify({ apiKey: "cu_from_file" }));
    writeFileSync(join(dir, "config.json"), JSON.stringify({ accountId: "acct-file" }));
    assert.deepEqual(resolveCredentials(env, "linux"), { apiKey: "cu_from_file", accountId: "acct-file", source: "checkly-cli-login" });
    assert.deepEqual(resolveCredentials({ ...env, CHECKLY_API_KEY: "cu_env", CHECKLY_ACCOUNT_ID: "acct-env" }, "linux"), { apiKey: "cu_env", accountId: "acct-env", source: "env" });
    assert.equal(resolveCredentials({ ...env, CHECKLY_API_KEY: "cu_env" }, "linux"), null,
      "a partial protected input must not borrow the other half from a different cached account");
    assert.equal(resolveCredentials({ ...env, CHECKLY_ACCOUNT_ID: "acct-env" }, "linux"), null);
    assert.equal(checklyCliConfigDir({ HOME: "/Users/a" }, "darwin"), "/Users/a/Library/Preferences/@checkly/cli");
    assert.equal(checklyCliConfigDir({ HOME: "/Users/a", CHECKLY_ENV: "staging" }, "darwin"), "/Users/a/Library/Preferences/@checkly/cli-staging");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("client boundary: HTTPS origins, redirects and credential isolation hold before a second fetch", async () => {
  assert.throws(() => new ChecklyClient(creds, { baseUrl: "http://127.0.0.1:9999" }), /HTTPS/);
  assert.throws(() => new ChecklyClient(creds, { baseUrl: "https://user:pw@api.checklyhq.com" }), /HTTPS/);
  const external = fakeFetch(() => new Response(null, { status: 302, headers: { location: "https://untrusted.invalid/steal" } }));
  const api = new ChecklyClient(creds, { baseUrl: "https://api.checklyhq.com", fetchImpl: external.fetch });
  await assert.rejects(api.getCheck("a"), /redirect changed its authorized origin/);
  assert.equal(external.calls.length, 1);
  assert.equal((external.calls[0]!.init.headers as Record<string, string>).authorization, "Bearer cu_test_key");

  const wrongOperation = fakeFetch(() => new Response(null, { status: 301, headers: { location: "/v1/error-groups/other" } }));
  await assert.rejects(new ChecklyClient(creds, { fetchImpl: wrongOperation.fetch }).getCheck("a"), /operation/);
  assert.equal(wrongOperation.calls.length, 1);

  const assetRedirect = fakeFetch((url, init) => {
    assert.equal((init.headers as Record<string, string>).authorization, undefined);
    return new Response(null, { status: 302, headers: { location: url.includes("assets.invalid")
      ? "https://api.checklyhq.com/v1/checks/a" : "http://assets.invalid/insecure" } });
  });
  await assert.rejects(new ChecklyClient(creds, { fetchImpl: assetRedirect.fetch }).download("https://assets.invalid/signed?signature=HIDDEN"), /HTTPS/);
  assert.ok(assetRedirect.calls.every((call) => !(call.init.headers as Record<string, string>).authorization));
  assert.ok(!JSON.stringify(api.calls).includes("steal"));
});

test("client boundary: finite deadline, retry cap and bounded streamed asset", async () => {
  const blocked = fakeFetch((_url, init) => new Promise<Response>((_resolve, reject) => {
    init.signal?.addEventListener("abort", () => reject(new Error("request aborted")), { once: true });
  }));
  await assert.rejects(new ChecklyClient(creds, { fetchImpl: blocked.fetch, timeoutMs: 25 }).getCheck("never"), /time limit exceeded/);
  assert.equal(blocked.calls.length, 1);

  const delays: number[] = [];
  const throttled = fakeFetch(() => new Response("retry", { status: 429, headers: { "retry-after": "9999999999" } }));
  await assert.rejects(new ChecklyClient(creds, { fetchImpl: throttled.fetch, retries: 999_999,
    sleep: async (ms) => { delays.push(ms); } }).getCheck("bounded"), (error: unknown) =>
      error instanceof ChecklyApiError && error.status === 429);
  assert.equal(throttled.calls.length, 4, "only three retries are allowed even with an excessive caller budget");
  assert.deepEqual(delays, [30_000, 30_000, 30_000]);

  let chunks = 0;
  const streaming = fakeFetch(() => new Response(new ReadableStream({ pull(controller) {
    chunks++;
    controller.enqueue(new Uint8Array(7));
    if (chunks > 10) controller.close();
  } }), { status: 200 }));
  await assert.rejects(new ChecklyClient(creds, { fetchImpl: streaming.fetch }).download("https://assets.invalid/signed", 16), /stream/);
  assert.ok(chunks < 11, "the reader stopped before consuming an unbounded response");
});
