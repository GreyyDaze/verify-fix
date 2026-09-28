import { test } from "node:test";
import assert from "node:assert/strict";
import { listZip, openZip, readZipEntry, isZip } from "../../src/trace/zip.ts";
import { traceZipToHar, mergeHars } from "../../src/trace/trace-to-har.ts";
import { sanitizeHar, redact, envVarNamesOnly, redactJsonText } from "../../src/bundle/sanitize.ts";
import { writeZip } from "../helpers/zip-writer.ts";
import { fakeTraceZip } from "../helpers/fake-trace.ts";

test("zip: round-trips deflate and store entries", () => {
  // Keep the fixture below the ZIP's 200:1 compression-ratio safety limit.
  const big = "x".repeat(2_000);
  for (const store of [false, true]) {
    const zip = writeZip({ "a.txt": "hello", "dir/b.json": '{"k":1}', "big.txt": big }, { store });
    assert.ok(isZip(zip));
    const names = listZip(zip).map((e) => e.name);
    assert.deepEqual(names, ["a.txt", "dir/b.json", "big.txt"]);
    const map = openZip(zip);
    assert.equal(map.get("a.txt")!().toString(), "hello");
    assert.equal(map.get("dir/b.json")!().toString(), '{"k":1}');
    assert.equal(map.get("big.txt")!().length, 2_000);
    assert.equal(readZipEntry(zip, listZip(zip)[2]).toString(), big);
  }
});

test("zip: rejects non-zip input", () => {
  assert.throws(() => listZip(Buffer.from("not a zip at all")), /end of central directory/);
});

const BASE = "https://slots.example.test";

function overlapTrace(format: "1.63" | "legacy" = "1.63") {
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
      { apiName: "step:Book the slot", line: 30 },
      { apiName: "expect.toHaveText", params: { selector: "internal:testid=[data-testid=\"book-status\"s]", expectedText: [{ string: "200" }] }, line: 36, column: 51, error: "Timed out 10000ms waiting for expect(locator).toHaveText(expected)\n\nLocator: getByTestId('book-status')\nExpected string: \"200\"\nReceived string: \"401\"" },
      { apiName: "expect.toHaveText", params: { selector: "x", expectedText: [{ string: "CONFIRMED" }] }, line: 37 },
    ],
    format,
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
  assert.equal("_file" in byPath["/api/book"].response.content, false);
  assert.equal((byPath["/api/book"] as unknown as Record<string, unknown>)._securityDetails, undefined);
  // actions: test-runner steps of category pw:api / expect / test.step; hooks and fixtures dropped
  assert.deepEqual(
    ex.actions.map((a) => [a.apiName, a.category]),
    [
      ["page.goto", "pw:api"],
      ["locator.fill", "pw:api"],
      ["Book the slot", "test.step"],
      ["expect.toHaveText", "expect"],
      ["expect.toHaveText", "expect"],
    ],
  );
  assert.ok(ex.failingAction);
  assert.equal(ex.failingAction!.apiName, "expect.toHaveText");
  assert.equal(ex.failingAction!.category, "expect");
  assert.match(ex.failingAction!.title, /expected="200"/, "params come from the browser call joined through stepId");
  assert.match(ex.failingAction!.error!, /Received string: "401"/, "error text is the test runner's, not the bare 'Expect failed'");
  assert.deepEqual(ex.failingAction!.location, { file: "/tmp/checkly/user/tests/booking.spec.ts", line: 36, column: 51 });
  assert.equal(ex.files.trace.length, 2, "0-trace.trace + test.trace");
  // "all" keeps the script body, "none" drops everything
  assert.equal(traceZipToHar(overlapTrace(), { bodies: "all" }).har.log.entries[1].response.content.text, "console.log(1)");
  assert.equal(traceZipToHar(overlapTrace(), { bodies: "none" }).har.log.entries[4].response.content.text, undefined);
});

test("trace → HAR: legacy traces (_sha1 bodies, apiName calls, no test.trace) still parse", () => {
  const ex = traceZipToHar(overlapTrace("legacy"), { bodies: "api" });
  assert.equal(ex.har.log.entries.length, 5);
  const book = ex.har.log.entries.find((e) => e.request.url.endsWith("/api/book"))!;
  assert.match(book.response.content.text!, /session superseded/);
  assert.equal(ex.actions.length, 5);
  assert.equal(ex.actions[0].category, "browser");
  assert.equal(ex.failingAction!.apiName, "expect.toHaveText");
  assert.match(ex.failingAction!.error!, /Received string: "401"/);
  assert.equal(ex.failingAction!.location, null);
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

test("zip boundary: exact EOCD comment, spoofed end record, multi-disk and ZIP64 are rejected", () => {
  const base = writeZip({ "safe.txt": "safe evidence" }, { store: true });
  const end = base.length - 22;
  const commented = Buffer.concat([base, Buffer.from("ok")]);
  commented.writeUInt16LE(2, end + 20);
  assert.equal(openZip(commented).get("safe.txt")!().toString(), "safe evidence");
  assert.throws(() => openZip(Buffer.concat([base, Buffer.from("trailing bytes")])), /comment length/);
  const spoof = Buffer.concat([base, Buffer.alloc(22)]);
  spoof.writeUInt16LE(22, end + 20); // the actual EOCD covers a comment
  spoof.writeUInt32LE(0x06054b50, base.length); // forged EOCD inside that comment
  assert.throws(() => openZip(spoof), /ambiguous end of central directory/);
  for (const [offset, length, value] of [[4, 2, 1], [6, 2, 1], [8, 2, 0], [10, 2, 0xffff], [12, 4, 0xffffffff], [16, 4, 0xffffffff]] as const) {
    const attack = Buffer.from(base);
    if (length === 2) attack.writeUInt16LE(value, end + offset);
    else attack.writeUInt32LE(value, end + offset);
    assert.throws(() => openZip(attack), /multi-disk|ZIP64|central directory|entries/);
  }
  const version = Buffer.from(base);
  version.writeUInt16LE(45, version.readUInt32LE(end + 16) + 6);
  assert.throws(() => openZip(version), /ZIP64/);
  const localVersion = Buffer.from(base);
  localVersion.writeUInt16LE(45, 4);
  assert.throws(() => openZip(localVersion), /ZIP64/);
});

test("zip boundary: descriptors, local/central disagreement and overlapping local ranges", () => {
  const base = writeZip({ "safe.txt": "body" }, { store: true });
  const eocd = base.length - 22;
  const cd = base.readUInt32LE(eocd + 16);
  const localName = base.readUInt16LE(26);
  const dataEnd = 30 + localName + 4;
  const descriptor = Buffer.alloc(16);
  descriptor.writeUInt32LE(0x08074b50, 0);
  descriptor.writeUInt32LE(base.readUInt32LE(14), 4);
  descriptor.writeUInt32LE(4, 8);
  descriptor.writeUInt32LE(4, 12);
  const described = Buffer.concat([base.subarray(0, cd), descriptor, base.subarray(cd)]);
  const newCd = cd + descriptor.length;
  described.writeUInt16LE(8, 6); // local: descriptor follows payload
  described.writeUInt32LE(0, 14);
  described.writeUInt32LE(0, 18);
  described.writeUInt32LE(0, 22);
  described.writeUInt16LE(8, newCd + 8); // central agrees on descriptor flag
  described.writeUInt32LE(newCd, described.length - 22 + 16);
  assert.equal(dataEnd, cd);
  assert.equal(openZip(described).get("safe.txt")!().toString(), "body");
  const badDescriptor = Buffer.from(described);
  badDescriptor.writeUInt32LE(0, dataEnd + 4);
  assert.throws(() => openZip(badDescriptor), /descriptor/);
  const missingDescriptor = Buffer.from(described);
  missingDescriptor.writeUInt32LE(cd, missingDescriptor.length - 22 + 16);
  assert.throws(() => openZip(missingDescriptor), /range|directory/);
  const inconsistent = Buffer.from(base);
  inconsistent.writeUInt16LE(8, 8);
  assert.throws(() => openZip(inconsistent), /local and central headers disagree/);
  const wrongCrc = Buffer.from(base);
  wrongCrc.writeUInt32LE(123, 14);
  assert.throws(() => openZip(wrongCrc), /integrity fields disagree/);
  const second = writeZip({ aaa: "same", bbb: "same" }, { store: true });
  const e2 = second.length - 22;
  const c2 = second.readUInt32LE(e2 + 16);
  const firstLength = 46 + second.readUInt16LE(c2 + 28);
  const secondEntry = c2 + firstLength;
  second.write("aaa", secondEntry + 46);
  second.writeUInt32LE(0, secondEntry + 42);
  assert.throws(() => openZip(second), /local entry ranges overlap/);
});

test("zip boundary: ZIP64 extra fields in either header and malformed extra lengths do not pass", () => {
  const base = writeZip({ "safe.txt": "body" }, { store: true });
  const localEnd = 30 + base.readUInt16LE(26);
  const eocd = base.length - 22;
  const central = base.readUInt32LE(eocd + 16);
  const zip64 = Buffer.from([1, 0, 0, 0]); // ZIP64 extra ID with zero-byte payload
  const local = Buffer.concat([base.subarray(0, localEnd), zip64, base.subarray(localEnd)]);
  local.writeUInt16LE(4, 28);
  local.writeUInt32LE(central + 4, local.length - 22 + 16);
  assert.throws(() => openZip(local), /ZIP64 extra/);
  const centralEnd = central + 46 + base.readUInt16LE(central + 28);
  const directory = Buffer.concat([base.subarray(0, centralEnd), zip64, base.subarray(centralEnd)]);
  directory.writeUInt16LE(4, central + 30);
  directory.writeUInt32LE(base.readUInt32LE(eocd + 12) + 4, directory.length - 22 + 12);
  assert.throws(() => openZip(directory), /ZIP64 extra/);
  const malformed = Buffer.from(directory);
  malformed.writeUInt16LE(10, centralEnd + 2);
  assert.throws(() => openZip(malformed), /truncated extra field/);
});
