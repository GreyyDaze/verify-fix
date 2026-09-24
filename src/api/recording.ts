import { createHash } from "node:crypto";
import type { ApiRecording, ApiSetupProvenance, SanitizedApiRequest, SanitizedApiResponse } from "../types.ts";
import type { CheckResult } from "../checkly/types.ts";

const SECRET_NAME = /authorization|cookie|token|secret|password|api[-_]?key|session/i;
const SAFE_REQUEST_HEADERS = new Set(["accept", "content-type", "user-agent", "x-request-id", "authorization", "cookie"]);
const SAFE_RESPONSE_HEADERS = new Set(["content-type", "content-length", "cache-control", "x-request-id", "set-cookie"]);

function object(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function stringValue(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return null;
}

function redactText(value: string, secrets: string[]): string {
  let output = value.replace(/Bearer\s+[^\s,"']+/gi, "Bearer [REDACTED]");
  for (const secret of secrets.filter((item) => item.length >= 3)) output = output.split(secret).join("[REDACTED]");
  output = output.replace(/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}(?:\.[A-Za-z0-9_-]{5,})?\b/g, "[REDACTED]");
  return output;
}

function redactJson(value: unknown, secrets: string[], key = ""): unknown {
  if (SECRET_NAME.test(key)) return "[REDACTED]";
  if (typeof value === "string") return redactText(value, secrets);
  if (Array.isArray(value)) return value.map((item) => redactJson(item, secrets));
  const source = object(value);
  if (!source) return value;
  const output: Record<string, unknown> = {};
  for (const [name, item] of Object.entries(source)) output[name] = redactJson(item, secrets, name);
  return output;
}

function headerRecord(value: unknown): Record<string, string> {
  const output: Record<string, string> = {};
  if (Array.isArray(value)) {
    for (const item of value) {
      const entry = object(item);
      const name = stringValue(entry?.name ?? entry?.key)?.toLowerCase();
      const headerValue = stringValue(entry?.value);
      if (name && headerValue !== null) output[name] = headerValue;
    }
    return output;
  }
  const source = object(value);
  if (!source) return output;
  for (const [name, item] of Object.entries(source)) {
    const headerValue = Array.isArray(item) ? item.map(stringValue).filter((part): part is string => part !== null).join(", ") : stringValue(item);
    if (headerValue !== null) output[name.toLowerCase()] = headerValue;
  }
  return output;
}

function safeHeaders(value: unknown, response: boolean, secrets: string[]): Record<string, string> {
  const allowed = response ? SAFE_RESPONSE_HEADERS : SAFE_REQUEST_HEADERS;
  const output: Record<string, string> = {};
  for (const [name, item] of Object.entries(headerRecord(value))) {
    if (!allowed.has(name)) continue;
    output[name] = SECRET_NAME.test(name) ? "[REDACTED]" : redactText(item, secrets);
  }
  return output;
}

function safeUrl(raw: string, secrets: string[]): string {
  try {
    const url = new URL(redactText(raw, secrets));
    url.username = "";
    url.password = "";
    for (const name of [...url.searchParams.keys()]) if (SECRET_NAME.test(name)) url.searchParams.set(name, "[REDACTED]");
    return url.toString();
  } catch {
    return redactText(raw, secrets);
  }
}

function bodyText(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (value === null || value === undefined) return null;
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

function firstObject(...values: unknown[]): Record<string, unknown> | null {
  for (const value of values) {
    const candidate = object(value);
    if (candidate) return candidate;
  }
  return null;
}

function requestFrom(detail: Record<string, unknown>, api: Record<string, unknown>, secrets: string[], reasons: string[]): SanitizedApiRequest | null {
  const request = firstObject(api.request, api.requestData, detail.request, detail.requestData);
  if (!request) {
    reasons.push("API result has no supported request object");
    return null;
  }
  const method = stringValue(request.method ?? request.requestMethod);
  const url = stringValue(request.url ?? request.requestUrl ?? request.uri);
  if (!method || !url) {
    reasons.push("API result request has no supported method or URL");
    return null;
  }
  const rawBody = bodyText(request.body ?? request.data ?? request.payload);
  let safeBody = rawBody === null ? null : redactText(rawBody, secrets);
  if (safeBody) {
    try {
      safeBody = JSON.stringify(redactJson(JSON.parse(safeBody), secrets));
    } catch {
      // A text request body is valid evidence after literal secret replacement.
    }
  }
  return {
    method: method.toUpperCase(),
    url: safeUrl(url, secrets),
    headers: safeHeaders(request.headers ?? request.requestHeaders, false, secrets),
    body: safeBody,
  };
}

function responseFrom(detail: Record<string, unknown>, api: Record<string, unknown>, secrets: string[], reasons: string[]): SanitizedApiResponse | null {
  const response = firstObject(api.response, api.responseData, detail.response, detail.responseData);
  if (!response) {
    reasons.push("API result has no supported response object");
    return null;
  }
  const statusRaw = response.status ?? response.statusCode;
  const status = typeof statusRaw === "number" ? statusRaw : Number(statusRaw);
  if (!Number.isInteger(status)) {
    reasons.push("API result response has no supported status code");
    return null;
  }
  const headers = safeHeaders(response.headers ?? response.responseHeaders, true, secrets);
  const contentType = headers["content-type"]?.split(";")[0]?.trim().toLowerCase() ?? null;
  const rawBody = bodyText(response.body ?? response.bodyText ?? response.data);
  if (rawBody === null) {
    reasons.push("API result response body is missing");
    return { status, headers, contentType, bodyText: null, json: null, readable: false, truncated: false };
  }
  const redacted = redactText(rawBody, secrets);
  let json: unknown | null = null;
  let readable = true;
  try {
    json = redactJson(JSON.parse(redacted), secrets);
  } catch {
    if (contentType === "application/json" || contentType?.endsWith("+json")) {
      readable = false;
      reasons.push("API result declares JSON but the response body is not valid JSON");
    }
  }
  return {
    status,
    headers,
    contentType,
    bodyText: json === null ? redacted : JSON.stringify(json),
    json,
    readable,
    truncated: response.truncated === true || response.bodyTruncated === true,
  };
}

export function apiRecordingFromResult(checkId: string, result: CheckResult, secrets: string[] = []): ApiRecording | null {
  const detail = object(result);
  if (!detail) return null;
  const api = firstObject(detail.apiCheckResult, detail.apiResult);
  const checkType = stringValue(detail.checkType ?? detail.type ?? detail.resultType)?.toUpperCase();
  if (!api && checkType !== "API") return null;
  const source = api ?? detail;
  const unsupportedReasons: string[] = [];
  return {
    schemaVersion: "api-recording-v1",
    resultId: result.id,
    checkId,
    startedAt: result.startedAt ?? null,
    request: requestFrom(detail, source, secrets, unsupportedReasons),
    response: responseFrom(detail, source, secrets, unsupportedReasons),
    setup: null,
    unsupportedReasons,
  };
}

export function setupProvenance(file: string, source: string): ApiSetupProvenance {
  return { file, sha256: createHash("sha256").update(source).digest("hex") };
}
