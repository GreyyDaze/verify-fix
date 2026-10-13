// Raw downloaded assets are *ephemeral*. They are never attached to a capture
// or recording: a WeakMap makes them available solely to the transaction
// relationship check, before sanitization. Every tree is bounded iteratively
// so unknown reporter metadata and ignored branches cannot hide a token or
// evade a recursive walk. Only fixed problem categories leave this module.

const roots = new WeakMap<object, readonly unknown[]>();
export const MAX_RAW_NODES = 30_000;
export const MAX_RAW_DEPTH = 32;
export const MAX_RAW_STRING = 1024 * 1024;
export const MAX_RAW_STRING_TOTAL = 12 * 1024 * 1024;
export const MAX_RAW_MEMBERS = 4096;

interface Entry { value: unknown; depth: number }

/** Bounds apply to every nested object, array, key and primitive string, not
 * only to fields the Playwright normalizer happens to project. */
export function rawTreeBounded(root: unknown): boolean {
  const stack: Entry[] = [{ value: root, depth: 0 }];
  let nodes = 0;
  let chars = 0;
  while (stack.length) {
    const { value, depth } = stack.pop()!;
    if (++nodes > MAX_RAW_NODES || depth > MAX_RAW_DEPTH) return false;
    if (typeof value === "string") {
      chars += value.length;
      if (value.length > MAX_RAW_STRING || chars > MAX_RAW_STRING_TOTAL) return false;
    } else if (value !== null && typeof value === "object") {
      const entries = Object.entries(value);
      if (entries.length > MAX_RAW_MEMBERS) return false;
      for (const [key, item] of entries) {
        chars += key.length;
        if (key.length > MAX_RAW_STRING || chars > MAX_RAW_STRING_TOTAL) return false;
        stack.push({ value: item, depth: depth + 1 });
      }
    }
  }
  return true;
}

/** Evidence-bearing Checkly records must not project an ambiguous, unknown
 * request/response alias. Playwright reporter metadata outside these records
 * is allowed, but is still included in the bounded token scan. */
const DATA_KEYS = new Set([
  "requestTitle", "title", "fetchUid", "method", "url", "uri", "requestHeaders", "headers", "requestBody",
  "status", "statusCode", "statusText", "responseHeaders", "body", "responseBody", "expected", "actual",
  "expectedData", "actualData", "timings", "request", "response",
  // Verified real Checkly 9.5.0 runner record: every pw:api entry carries the
  // parsed query parameters alongside `timings` (empty for canonical routes).
  "queryParams",
]);
const REQUEST_KEYS = new Set(["method", "url", "uri", "headers", "body", "data"]);
const RESPONSE_KEYS = new Set(["status", "statusCode", "statusText", "headers", "body", "data"]);
const isObject = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const keysAllowed = (value: unknown, keys: ReadonlySet<string>): boolean =>
  isObject(value) && Object.keys(value).every((key) => keys.has(key));

export function rawReporterSchema(root: unknown): boolean {
  if (!isObject(root) || !Array.isArray(root.suites)) return false;
  const stack: unknown[] = [...root.suites];
  while (stack.length) {
    const value = stack.pop();
    if (!isObject(value)) continue;
    for (const [key, item] of Object.entries(value)) {
      if (key === "checklyData") {
        if (!Array.isArray(item)) return false;
        const nested: unknown[] = [...item];
        while (nested.length) {
          const part = nested.pop();
          if (Array.isArray(part)) nested.push(...part);
          else if (isObject(part)) {
            if (!keysAllowed(part, DATA_KEYS)
              || part.request !== undefined && !keysAllowed(part.request, REQUEST_KEYS)
              || part.response !== undefined && !keysAllowed(part.response, RESPONSE_KEYS)) return false;
          } else return false;
        }
      } else if (Array.isArray(item) || isObject(item)) stack.push(item);
    }
  }
  return true;
}

export function bindRawEvidence(capture: object, raw: readonly unknown[]): void {
  roots.set(capture, raw);
}

/** Raw substring matches, including keys and EVERY field of reporter, logs
 * and check-run-data. The normalized transaction independently proves the
 * three allowed semantic sites; hence any fourth raw appearance (also in an
 * ignored field, duplicate representation, nested assertion or log) rejects
 * the capture. null means raw evidence was not registered/bounded. */
export function rawTokenOccurrences(capture: object, token: string): number | null {
  const raw = roots.get(capture);
  if (!raw || !token) return null;
  let count = 0;
  const stack: unknown[] = [...raw];
  const add = (value: string): void => { count += value.split(token).length - 1; };
  while (stack.length) {
    const value = stack.pop();
    if (typeof value === "string") add(value);
    else if (value !== null && typeof value === "object") {
      for (const [key, item] of Object.entries(value)) {
        add(key);
        stack.push(item);
      }
    }
    if (count > 3) return count;
  }
  return count;
}

/** JSON.parse silently accepts repeated keys and keeps only the LAST value.
 * A shadowed token/status/header would otherwise vanish before admission.
 * Called only after JSON.parse has already established valid JSON grammar. */
export function rawJsonUniqueKeys(text: string): boolean {
  const stack: Array<{ keys: Set<string> | null; expectKey: boolean }> = [];
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (char === "{" || char === "[") {
      stack.push({ keys: char === "{" ? new Set() : null, expectKey: char === "{" });
    } else if (char === "}" || char === "]") {
      stack.pop();
    } else if (char === ",") {
      const top = stack.at(-1);
      if (top?.keys) top.expectKey = true;
    } else if (char === '\"') {
      const begin = i;
      while (++i < text.length) {
        if (text[i] === "\\") { i++; continue; }
        if (text[i] === '\"') break;
      }
      const top = stack.at(-1);
      if (top?.keys && top.expectKey) {
        const key: string = JSON.parse(text.slice(begin, i + 1));
        if (top.keys.has(key)) return false;
        top.keys.add(key);
        top.expectKey = false;
      }
    }
  }
  return stack.length === 0;
}
