// Builds Playwright-style trace archives for tests.
//
// Default format is the one @playwright/test 1.63 writes (and Checkly serves
// back): bodies referenced by `_file`, browser calls with `title` + `stepId`,
// and a `test.trace` with the test-runner steps (category, spec location,
// full error text). `format: "legacy"` builds the older layout (`_sha1`
// bodies, `apiName` on the browser call, no test.trace) so the reader keeps
// working on traces from older runtimes.

import { writeZip } from "./zip-writer.ts";

export interface FakeRequest {
  method: string;
  url: string;
  status: number;
  mimeType?: string;
  body?: string;
  requestBody?: string;
  requestHeaders?: Array<{ name: string; value: string }>;
  responseHeaders?: Array<{ name: string; value: string }>;
  resourceType?: string;
  t?: number;
}

export interface FakeAction {
  /** `page.goto`, `locator.fill`, `expect.toHaveText`, or `step:<title>` for a test.step */
  apiName: string;
  params?: Record<string, unknown>;
  /** test-runner error text (goes to test.trace; the browser call gets a bare "Expect failed") */
  error?: string;
  /** spec location recorded by the test runner */
  line?: number;
  column?: number;
  t?: number;
}

export interface FakeTraceOptions {
  baseURL: string;
  requests: FakeRequest[];
  actions: FakeAction[];
  store?: boolean;
  format?: "1.63" | "legacy";
  /** absolute spec path as Checkly's runner sees it */
  specFile?: string;
}

function harEntry(r: FakeRequest, n: number, refs: { body: string | null; requestBody: string | null }, format: "1.63" | "legacy") {
  const bodyRef = (ref: string | null) => (ref === null ? {} : format === "legacy" ? { _sha1: ref.replace(/^resources\//, "") } : { _file: ref, text: "" });
  return {
    pageref: "page@1",
    startedDateTime: new Date(1_700_000_000_000 + (r.t ?? n) * 1000).toISOString(),
    time: 42,
    request: {
      method: r.method,
      url: r.url,
      httpVersion: "HTTP/1.1",
      cookies: [],
      headers: r.requestHeaders ?? [],
      queryString: [],
      headersSize: -1,
      bodySize: r.requestBody ? r.requestBody.length : -1,
      ...(r.requestBody !== undefined ? { postData: { mimeType: "application/json", ...bodyRef(refs.requestBody) } } : {}),
    },
    response: {
      status: r.status,
      statusText: "",
      httpVersion: "HTTP/1.1",
      cookies: [],
      headers: r.responseHeaders ?? [{ name: "content-type", value: r.mimeType ?? "application/json" }],
      content: { size: r.body?.length ?? -1, mimeType: r.mimeType ?? "application/json", ...bodyRef(refs.body) },
      headersSize: -1,
      bodySize: r.body?.length ?? -1,
      redirectURL: "",
    },
    cache: {},
    timings: { send: 1, wait: 30, receive: 11 },
    _frameref: "frame@1",
    _monotonicTime: (r.t ?? n) * 1000,
    _resourceType: r.resourceType ?? (r.mimeType?.includes("html") ? "document" : "fetch"),
    _securityDetails: { protocol: "TLS 1.3" },
  };
}

export function fakeTraceZip(opts: FakeTraceOptions): Buffer {
  const format = opts.format ?? "1.63";
  const specFile = opts.specFile ?? "/tmp/checkly/user/tests/booking.spec.ts";
  const files: Record<string, string> = {};
  const networkLines: string[] = [];
  let n = 0;
  for (const r of opts.requests) {
    n += 1;
    const ext = (r.mimeType ?? "application/json").includes("html") ? "html" : (r.mimeType ?? "").includes("javascript") ? "js" : "json";
    const body = r.body !== undefined ? `resources/${"0".repeat(36)}${String(n).padStart(4, "0")}.${ext}` : null;
    const requestBody = r.requestBody !== undefined ? `resources/${"a".repeat(36)}${String(n).padStart(4, "0")}.json` : null;
    if (body) files[body] = r.body!;
    if (requestBody) files[requestBody] = r.requestBody!;
    networkLines.push(JSON.stringify({ type: "resource-snapshot", snapshot: harEntry(r, n, { body, requestBody }, format) }));
  }

  const contextOptions = JSON.stringify({ type: "context-options", browserName: "chromium", options: { baseURL: opts.baseURL }, platform: "linux" });

  if (format === "legacy") {
    files["trace.network"] = networkLines.join("\n") + "\n";
    const lines = [contextOptions];
    opts.actions.forEach((a, i) => {
      const callId = `call@${i + 1}`;
      lines.push(JSON.stringify({ type: "before", callId, startTime: 1000 + i * 100, apiName: a.apiName, class: "Frame", method: "x", params: a.params ?? {} }));
      lines.push(JSON.stringify({ type: "after", callId, endTime: 1050 + i * 100, ...(a.error ? { error: { message: a.error } } : {}) }));
    });
    files["trace.trace"] = lines.join("\n") + "\n";
    files["trace.stacks"] = "{}\n";
    return writeZip(files, { store: opts.store });
  }

  files["0-trace.network"] = networkLines.join("\n") + "\n";
  const browserLines = [contextOptions, JSON.stringify({ type: "before", callId: "call@0", startTime: 900, title: "Before Hooks", class: "Tracing", method: "tracingGroup", params: {} })];
  browserLines.push(JSON.stringify({ type: "after", callId: "call@0", endTime: 950 }));
  const testLines = [
    JSON.stringify({ type: "before", callId: "hook@1", stepId: "hook@1", startTime: 900, class: "Test", method: "hook", title: "Before Hooks", params: {}, stack: [] }),
    JSON.stringify({ type: "after", callId: "hook@1", endTime: 950 }),
    JSON.stringify({ type: "before", callId: "fixture@1", stepId: "fixture@1", parentId: "hook@1", startTime: 905, class: "Test", method: "fixture", title: 'fixture: page', params: {}, stack: [] }),
    JSON.stringify({ type: "after", callId: "fixture@1", endTime: 940 }),
  ];
  opts.actions.forEach((a, i) => {
    const start = 1000 + i * 100;
    const end = 1050 + i * 100;
    const isStep = a.apiName.startsWith("step:");
    const isExpect = a.apiName.startsWith("expect.");
    const category = isStep ? "test.step" : isExpect ? "expect" : "pw:api";
    const stepId = `${category}@${i + 1}`;
    const title = isStep ? a.apiName.slice(5) : a.apiName === "page.goto" ? `page.goto(${String(a.params?.url ?? "")})` : a.apiName;
    const stack = a.line ? [{ file: specFile, line: a.line, column: a.column ?? 1 }] : [];
    testLines.push(JSON.stringify({ type: "before", callId: stepId, stepId, startTime: start, class: "Test", method: category, title, params: isExpect ? {} : (a.params ?? {}), stack }));
    testLines.push(JSON.stringify({ type: "after", callId: stepId, endTime: end, ...(a.error ? { error: { message: a.error, stack: `${a.error}\n    at ${specFile}:${a.line ?? 0}:${a.column ?? 0}` } } : {}) }));
    if (!isStep) {
      const callId = `call@${i + 1}`;
      const [cls, method] = a.apiName.split(".");
      browserLines.push(JSON.stringify({ type: "before", callId, startTime: start + 1, title, class: cls === "page" ? "Frame" : cls === "locator" ? "Frame" : "Frame", method: isExpect ? "expect" : method, params: { ...(a.params ?? {}), timeout: 10000 }, stepId }));
      browserLines.push(JSON.stringify({ type: "after", callId, endTime: end - 1, ...(a.error ? { error: { message: isExpect ? "Expect failed" : a.error.split("\n")[0] } } : {}) }));
    }
  });
  files["0-trace.trace"] = browserLines.join("\n") + "\n";
  files["test.trace"] = testLines.join("\n") + "\n";
  files["0-trace.stacks"] = JSON.stringify({ files: [specFile], stacks: [] }) + "\n";
  return writeZip(files, { store: opts.store });
}
