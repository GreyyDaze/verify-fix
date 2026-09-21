// Credential policy for everything the bundle writes (BRAINSTORM D8):
// the bundle may be committed to a repo, so it must never carry a secret.
//   - env vars: names only (values are dropped before anything is written)
//   - HAR: authorization/cookie headers, secret-looking query params and JSON
//     body fields are replaced by REDACTED(<hash>). The hash keeps equality
//     (two requests that carried the same token still look alike) without
//     revealing the value.

import { fnv1a } from "../assertion/id.ts";
import type { Har, HarEntry, HarHeader } from "../trace/har-types.ts";

const SECRET_HEADERS = new Set([
  "authorization",
  "proxy-authorization",
  "cookie",
  "set-cookie",
  "x-api-key",
  "x-auth-token",
  "x-checkly-account",
]);

const SECRET_KEY_RE = /(^|[_\-.])(token|secret|password|passwd|api[_-]?key|access[_-]?key|authorization|session|cookie|credential)s?($|[_\-.])/i;

export function redact(value: string): string {
  return `REDACTED(${fnv1a(value).slice(0, 8)})`;
}

export function isSecretKey(name: string): boolean {
  return SECRET_KEY_RE.test(name) || SECRET_HEADERS.has(name.toLowerCase());
}

function redactHeaders(headers: HarHeader[] | undefined): HarHeader[] {
  if (!headers) return [];
  return headers.map((h) => (SECRET_HEADERS.has(h.name.toLowerCase()) ? { ...h, value: redact(h.value) } : h));
}

function redactCookies(cookies: Array<{ name: string; value: string }> | undefined) {
  if (!cookies) return [];
  return cookies.map((c) => ({ ...c, value: redact(c.value) }));
}

function redactQuery(query: Array<{ name: string; value: string }> | undefined) {
  if (!query) return [];
  return query.map((q) => (isSecretKey(q.name) ? { ...q, value: redact(q.value) } : q));
}

function redactUrl(url: string): string {
  try {
    const u = new URL(url);
    let changed = false;
    for (const [k, v] of [...u.searchParams.entries()]) {
      if (isSecretKey(k)) {
        u.searchParams.set(k, redact(v));
        changed = true;
      }
    }
    if (u.username || u.password) {
      u.username = "";
      u.password = "";
      changed = true;
    }
    return changed ? u.toString() : url;
  } catch {
    return url;
  }
}

/** Deep-redact JSON values whose key looks secret. Non-JSON text is returned as-is. */
export function redactJsonText(text: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return text;
  }
  const walk = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === "object") {
      const out: Record<string, unknown> = {};
      for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
        out[k] = isSecretKey(k) && typeof val === "string" ? redact(val) : walk(val);
      }
      return out;
    }
    return v;
  };
  return JSON.stringify(walk(parsed));
}

function isJsonMime(mime: string | undefined): boolean {
  return !!mime && /json/i.test(mime);
}

export function sanitizeEntry(entry: HarEntry): HarEntry {
  const req = entry.request;
  const res = entry.response;
  const postData = req.postData
    ? {
        ...req.postData,
        text:
          req.postData.text && isJsonMime(req.postData.mimeType)
            ? redactJsonText(req.postData.text)
            : req.postData.text,
      }
    : undefined;
  const content =
    res.content.text && res.content.encoding !== "base64" && isJsonMime(res.content.mimeType)
      ? { ...res.content, text: redactJsonText(res.content.text) }
      : res.content;
  return {
    ...entry,
    request: {
      ...req,
      url: redactUrl(req.url),
      headers: redactHeaders(req.headers),
      cookies: redactCookies(req.cookies),
      queryString: redactQuery(req.queryString),
      ...(postData ? { postData } : {}),
    },
    response: {
      ...res,
      headers: redactHeaders(res.headers),
      cookies: redactCookies(res.cookies),
      content,
    },
  };
}

export function sanitizeHar(har: Har): Har {
  return { log: { ...har.log, entries: har.log.entries.map(sanitizeEntry) } };
}

/**
 * Environment variables as the bundle stores them: names and flags only.
 * Accepts whatever shape the API returns and drops `value` unconditionally.
 */
export function envVarNamesOnly(
  vars: Array<{ key: string; secret?: boolean; locked?: boolean; value?: unknown }> | null | undefined,
): Array<{ key: string; secret: boolean }> {
  return (vars ?? []).map((v) => ({ key: v.key, secret: Boolean(v.secret || v.locked) }));
}
