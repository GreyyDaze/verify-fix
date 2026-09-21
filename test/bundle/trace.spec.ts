import { test } from "node:test";
import assert from "node:assert/strict";
import { listZip, openZip, readZipEntry, isZip } from "../../src/trace/zip.ts";
import { traceZipToHar, mergeHars } from "../../src/trace/trace-to-har.ts";
import { sanitizeHar, redact, envVarNamesOnly, redactJsonText } from "../../src/bundle/sanitize.ts";
import { writeZip } from "../helpers/zip-writer.ts";
import { fakeTraceZip } from "../helpers/fake-trace.ts";

test("zip: round-trips deflate and store entries", () => {
  const big = "x".repeat(10_000);
  for (const store of [false, true]) {
    const zip = writeZip({ "a.txt": "hello", "dir/b.json": '{"k":1}', "big.txt": big }, { store });
    assert.ok(isZip(zip));
    const names = listZip(zip).map((e) => e.name);
    assert.deepEqual(names, ["a.txt", "dir/b.json", "big.txt"]);
    const map = openZip(zip);
    assert.equal(map.get("a.txt")!().toString(), "hello");
    assert.equal(map.get("dir/b.json")!().toString(), '{"k":1}');
    assert.equal(map.get("big.txt")!().length, 10_000);
    assert.equal(readZipEntry(zip, listZip(zip)[2]).toString(), big);
  }
});

test("zip: rejects non-zip input", () => {
  assert.throws(() => listZip(Buffer.from("not a zip at all")), /end of central directory/);
});

const BASE = "https://slots.example.test";

function overlapTrace() {
  return fakeTraceZip({
    baseURL: BASE,
    requests: [
      { method: "GET", url: `${BASE}/`, status: 200, mimeType: "text/html", body: "<html>login</html>", t: 1 },
      { method: "GET", url: `${BASE}/_next/static/chunks/app.js`, status: 200, mimeType: "application/javascript", body: "console.log(1)", resourceType: "script", t: 2 },
      { method: "POST", url: `${BASE}/api/login`, status: 200, body: '{"ok":true,"token":"tok-demo-3","version":3}', requestBody: '{"account":"demo"}', requestHeaders: [{ name: "content-type", value: "application/json" }], t: 3 },
      { method: "GET", url: `${BASE}/api/slots`, status: 200, body: '{"slots":["09:30"]}', t: 4 },
      { method: "POST", url: `${BASE}/api/book`, status: 401, body: '{"error":"session superseded by a newer login","tokenVersion":3,"currentVersion":4}', requestHeaders: [{ name: "authorization", value: "Bearer tok-demo-3" }, { name: "cookie", value: "sid=abc" }], t: 5 },
    ],
    actions: [
      { apiName: "page.goto", params: { url: "/" } },
      { apiName: "locator.fill", params: { selector: "internal:label=\"Account\"i", value: "demo" } },
      { apiName: "expect.toHaveText", params: { selector: "internal:testid=[data-testid=\"book-status\"s]", expectedText: [{ string: "200" }] }, error: "Timed out 10000ms waiting for expect(locator).toHaveText(expected)\n\nExpected string: \"200\"\nReceived string: \"401\"" },
      { apiName: "expect.toHaveText", params: { selector: "x", expectedText: [{ string: "CONFIRMED" }] } },
    ],
  });
}

test("trace → HAR: entries, bodies by policy, actions and failing step", () => {
  const ex = traceZipToHar(overlapTrace(), { bodies: "api" });
  assert.equal(ex.baseURL, BASE);
  assert.equal(ex.browserName, "chromium");
  assert.equal(ex.har.log.entries.length, 5);
  const byPath = Object.fromEntries(ex.har.log.entries.map((e) => [new URL(e.request.url).pathname, e]));
  // API bodies are inlined, static script body omitted under policy "api"
  assert.equal(byPath["/api/book"].response.content.text, '{"error":"session superseded by a newer login","tokenVersion":3,"currentVersion":4}');
  assert.equal(byPath["/api/login"].request.postData?.text, '{"account":"demo"}');
  assert.equal(byPath["/_next/static/chunks/app.js"].response.content.text, undefined);
  assert.match(byPath["/_next/static/chunks/app.js"].response.content.comment ?? "", /omitted/);
  // playwright-internal pointers are gone
  assert.equal("_sha1" in byPath["/api/book"].response.content, false);
  assert.equal((byPath["/api/book"] as unknown as Record<string, unknown>)._securityDetails, undefined);
  // actions
  assert.equal(ex.actions.length, 4);
  assert.ok(ex.failingAction);
  assert.equal(ex.failingAction!.apiName, "expect.toHaveText");
  assert.match(ex.failingAction!.title, /expected="200"/);
  assert.match(ex.failingAction!.error!, /Received string: "401"/);
  // "all" keeps the script body, "none" drops everything
  assert.equal(traceZipToHar(overlapTrace(), { bodies: "all" }).har.log.entries[1].response.content.text, "console.log(1)");
  assert.equal(traceZipToHar(overlapTrace(), { bodies: "none" }).har.log.entries[4].response.content.text, undefined);
});

test("trace → HAR: merge keeps time order", () => {
  const a = traceZipToHar(fakeTraceZip({ baseURL: BASE, requests: [{ method: "GET", url: `${BASE}/b`, status: 200, t: 20 }], actions: [] }));
  const b = traceZipToHar(fakeTraceZip({ baseURL: BASE, requests: [{ method: "GET", url: `${BASE}/a`, status: 200, t: 10 }], actions: [] }));
  const merged = mergeHars([a.har, b.har]);
  assert.deepEqual(merged.log.entries.map((e) => new URL(e.request.url).pathname), ["/a", "/b"]);
});

test("sanitize: secrets in headers, cookies, query and JSON bodies are redacted but stay comparable", () => {
  const ex = traceZipToHar(overlapTrace(), { bodies: "api" });
  const clean = sanitizeHar(ex.har);
  const text = JSON.stringify(clean);
  assert.equal(text.includes("tok-demo-3"), false, "token value must not survive anywhere (header or body)");
  assert.equal(text.includes("sid=abc"), false, "cookie must not survive");
  const login = clean.log.entries.find((e) => e.request.url.endsWith("/api/login"))!;
  const book = clean.log.entries.find((e) => e.request.url.endsWith("/api/book"))!;
  assert.match(login.response.content.text!, /"token":"REDACTED\([0-9a-f]{8}\)"/);
  assert.equal(login.request.postData?.text, '{"account":"demo"}', "non-secret request body stays");
  assert.match(book.response.content.text!, /session superseded by a newer login/, "non-secret body content stays");
  assert.match(book.request.headers.find((h) => h.name === "authorization")!.value, /^REDACTED\(/);
  assert.equal(redact("abc"), redact("abc"));
  assert.notEqual(redact("abc"), redact("abd"));
  assert.equal(redactJsonText("not json"), "not json");
  const u = sanitizeHar({ log: { version: "1.2", creator: { name: "t", version: "0" }, pages: [], entries: [{ ...ex.har.log.entries[0], request: { ...ex.har.log.entries[0].request, url: `${BASE}/x?api_key=SECRET123&page=2` } }] } });
  assert.match(u.log.entries[0].request.url, /api_key=REDACTED%28[0-9a-f]{8}%29&page=2/);
});

test("sanitize: env vars keep names and flags only", () => {
  assert.deepEqual(envVarNamesOnly([{ key: "TEST_USER", value: "demo" }, { key: "PW", value: "hunter2", secret: true }, { key: "L", value: "x", locked: true }]), [
    { key: "TEST_USER", secret: false },
    { key: "PW", secret: true },
    { key: "L", secret: true },
  ]);
  assert.deepEqual(envVarNamesOnly(null), []);
});
