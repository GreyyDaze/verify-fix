// Builds Playwright-style trace archives for tests, following the on-disk
// format of playwright-core 1.63 (see src/trace/trace-to-har.ts header).

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
  apiName: string;
  params?: Record<string, unknown>;
  error?: string;
  t?: number;
}

export function fakeTraceZip(opts: { baseURL: string; requests: FakeRequest[]; actions: FakeAction[]; store?: boolean }): Buffer {
  const files: Record<string, string> = {};
  const networkLines: string[] = [];
  let n = 0;
  for (const r of opts.requests) {
    n += 1;
    const sha1 = `sha${n}.dat`;
    const psha = `psha${n}.dat`;
    if (r.body !== undefined) files[`resources/${sha1}`] = r.body;
    if (r.requestBody !== undefined) files[`resources/${psha}`] = r.requestBody;
    const entry = {
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
        ...(r.requestBody !== undefined ? { postData: { mimeType: "application/json", _sha1: psha } } : {}),
      },
      response: {
        status: r.status,
        statusText: "",
        httpVersion: "HTTP/1.1",
        cookies: [],
        headers: r.responseHeaders ?? [{ name: "content-type", value: r.mimeType ?? "application/json" }],
        content: { size: r.body?.length ?? -1, mimeType: r.mimeType ?? "application/json", ...(r.body !== undefined ? { _sha1: sha1 } : {}) },
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
    networkLines.push(JSON.stringify({ type: "resource-snapshot", snapshot: entry }));
  }
  files["trace.network"] = networkLines.join("\n") + "\n";

  const traceLines: string[] = [
    JSON.stringify({ type: "context-options", browserName: "chromium", options: { baseURL: opts.baseURL }, platform: "linux" }),
  ];
  opts.actions.forEach((a, i) => {
    const callId = `call@${i + 1}`;
    traceLines.push(JSON.stringify({ type: "before", callId, startTime: 1000 + i * 100, apiName: a.apiName, class: "Frame", method: "x", params: a.params ?? {} }));
    traceLines.push(JSON.stringify({ type: "after", callId, endTime: 1050 + i * 100, ...(a.error ? { error: { message: a.error } } : {}) }));
  });
  files["trace.trace"] = traceLines.join("\n") + "\n";
  files["trace.stacks"] = "{}\n";
  return writeZip(files, { store: opts.store });
}
