// Playwright trace (.zip) → HAR 1.2 + the list of test steps with their errors.
//
// Format, verified against playwright-core / @playwright/test 1.63 and against
// real traces downloaded from Checkly (fixtures/bundles/slots-booking-overlap):
//   <n>-trace.network  JSON lines { type: "resource-snapshot", snapshot: <HAR entry> }
//                      bodies are referenced by request.postData / response.content:
//                        _file: "resources/<sha1>.<ext>"   (1.5x+; the text field is "")
//                        _sha1: "<sha1>.<ext>"             (older traces)
//   <n>-trace.trace    browser-side events written by the tracing recorder:
//                      { type: "before", callId, startTime, title, class, method, params, stepId?, parentId? }
//                      { type: "after",  callId, endTime, error?: { message } }
//                      { type: "context-options", browserName, options: { baseURL? } }
//                      (older traces name the call `apiName` instead of `title`)
//   test.trace         test-runner steps written by @playwright/test:
//                      { type: "before", callId: <stepId>, stepId, parentId?, startTime,
//                        class: "Test", method: <category: "pw:api"|"expect"|"test.step"|"fixture"|"hook"|…>,
//                        title, params, stack: [{ file, line, column }] }
//                      { type: "after", callId, endTime, error?: { message, stack } }
//                      Browser calls point at their test step through `stepId`, and the
//                      test step's `after.error` carries the human-readable failure
//                      ("expect(locator).toHaveText(expected) failed … Expected … Received …").
// A trace zip may contain several chunks (0-trace.*, 1-trace.*, test.trace).

import { openZip } from "./zip.ts";
import type { Har, HarEntry } from "./har-types.ts";

export type BodyPolicy = "api" | "all" | "none";

export type ActionCategory = "pw:api" | "expect" | "test.step" | "browser" | "other";

export interface TraceAction {
  callId: string;
  /** Canonical call name: `page.goto`, `locator.fill`, `expect.toHaveText`, or the step title */
  apiName: string;
  /** Short human summary of the call: selector, url, expected value… */
  title: string;
  category: ActionCategory;
  startTime: number | null;
  endTime: number | null;
  error: string | null;
  params: Record<string, unknown>;
  /** Spec location of the step when the test runner recorded it */
  location: { file: string; line: number; column: number } | null;
}

export interface TraceExtract {
  har: Har;
  actions: TraceAction[];
  failingAction: TraceAction | null;
  baseURL: string | null;
  browserName: string | null;
  files: { network: string[]; trace: string[]; resources: number };
}

const TEXT_MIME_RE = /^(text\/|application\/(json|xml|x-www-form-urlencoded|javascript|graphql|ld\+json)|.*\+json$|.*\+xml$)/i;
const STATIC_MIME_RE = /^(image\/|font\/|audio\/|video\/|application\/(javascript|x-javascript|wasm|octet-stream|font|zip|pdf)|text\/(css|javascript))/i;
const STATIC_PATH_RE = /\.(js|mjs|css|map|png|jpe?g|gif|svg|webp|ico|woff2?|ttf|otf|mp4|webm)(\?|$)/i;
const STATIC_RESOURCE_TYPES = new Set(["script", "stylesheet", "image", "font", "media", "manifest"]);

function includeBody(policy: BodyPolicy, entry: HarEntry, mime: string, size: number, maxBytes: number): boolean {
  if (policy === "none") return false;
  if (size > maxBytes) return false;
  if (policy === "all") return true;
  // "api": pages and data the check actually reasons about; skip static assets
  if (entry._resourceType && STATIC_RESOURCE_TYPES.has(entry._resourceType)) return false;
  if (STATIC_MIME_RE.test(mime) || STATIC_PATH_RE.test(entry.request.url)) return false;
  return true;
}

function decodeBody(buf: Buffer, mime: string): { text: string; encoding?: "base64" } {
  if (TEXT_MIME_RE.test(mime) || mime === "x-unknown" || mime === "") {
    const text = buf.toString("utf8");
    // If it was not valid UTF-8 the replacement char shows up; fall back to base64.
    if (!text.includes("\uFFFD")) return { text };
  }
  return { text: buf.toString("base64"), encoding: "base64" };
}

/** Human details of a call from its params: selector, url, expected text… */
export function describeParams(params: Record<string, unknown>): string {
  const bits: string[] = [];
  for (const k of ["url", "selector", "expression", "expected", "text", "value"]) {
    const v = params[k];
    if (v === undefined || v === null || v === "") continue;
    bits.push(`${k}=${JSON.stringify(v)}`);
  }
  // expect.* params carry expectedText as an array of {string}
  const exp = params.expectedText;
  if (Array.isArray(exp)) {
    const strings = exp.map((e) => (e && typeof e === "object" && "string" in e ? String((e as { string: unknown }).string) : String(e)));
    bits.push(`expected=${JSON.stringify(strings.length === 1 ? strings[0] : strings)}`);
  }
  if (typeof params.timeout === "number") bits.push(`timeout=${params.timeout}`);
  return bits.join(" ");
}

/** Playwright colours its error messages when the runner had a TTY; the codes are noise here. */
export function stripAnsi(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\u001b\[[0-9;]*m/g, "");
}

function parseLines<T = Record<string, unknown>>(text: string): T[] {
  const out: T[] = [];
  for (const line of text.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    try {
      out.push(JSON.parse(t) as T);
    } catch {
      // tolerate a torn last line (trace was cut while writing)
    }
  }
  return out;
}

export interface TraceToHarOptions {
  bodies?: BodyPolicy;
  maxBodyBytes?: number;
  creatorVersion?: string;
}

interface RawCall {
  callId: string;
  cls: string;
  method: string;
  title: string | null;
  params: Record<string, unknown>;
  startTime: number | null;
  endTime: number | null;
  error: string | null;
  stepId: string | null;
  parentId: string | null;
  location: { file: string; line: number; column: number } | null;
}

/** `page.goto(https://x)` → `page.goto`; `expect.toHaveText` stays. */
function canonicalName(title: string | null, cls: string, method: string): string {
  if (title) {
    const head = title.split("(")[0].trim();
    if (/^[\w.$]+$/.test(head)) return head;
    return title;
  }
  return cls && method ? `${cls}.${method}` : method || cls || "unknown";
}

function toAction(call: RawCall, category: ActionCategory, browser: RawCall | null): TraceAction {
  const params = Object.keys(call.params).length ? call.params : (browser?.params ?? {});
  const apiName = canonicalName(call.title, call.cls, call.method);
  const details = describeParams(params);
  return {
    callId: call.callId,
    apiName,
    title: details ? `${apiName} ${details}` : (call.title ?? apiName),
    category,
    startTime: call.startTime,
    endTime: call.endTime,
    error: call.error ?? browser?.error ?? null,
    params,
    location: call.location ?? browser?.location ?? null,
  };
}

export function traceZipToHar(zipBuffer: Buffer, opts: TraceToHarOptions = {}): TraceExtract {
  const bodies = opts.bodies ?? "api";
  const maxBodyBytes = opts.maxBodyBytes ?? 256 * 1024;
  const zip = openZip(zipBuffer);

  const networkFiles = [...zip.keys()].filter((n) => n.endsWith(".network")).sort();
  const traceFiles = [...zip.keys()].filter((n) => n.endsWith(".trace")).sort();
  const resourceCount = [...zip.keys()].filter((n) => n.startsWith("resources/")).length;
  if (networkFiles.length === 0 && traceFiles.length === 0) {
    throw new Error("trace: archive has no .network/.trace entries (not a Playwright trace?)");
  }

  /** `_file` is a zip path ("resources/<sha1>.json"); `_sha1` is the bare name. */
  const readResource = (ref: string): Buffer | null => {
    const r = zip.get(ref) ?? zip.get(`resources/${ref}`);
    return r ? r() : null;
  };
  const bodyRef = (o: { _file?: string; _sha1?: string } | undefined): string | null => o?._file ?? o?._sha1 ?? null;

  const entries: HarEntry[] = [];
  for (const file of networkFiles) {
    for (const ev of parseLines<{ type: string; snapshot?: HarEntry }>(zip.get(file)!().toString("utf8"))) {
      if (ev.type !== "resource-snapshot" || !ev.snapshot || !ev.snapshot.request) continue;
      const e = structuredClone(ev.snapshot);
      // response body
      const content = e.response?.content;
      if (content) {
        const mime = content.mimeType ?? "x-unknown";
        const ref = bodyRef(content);
        delete content._sha1;
        delete content._file;
        if (ref) {
          const size = content.size >= 0 ? content.size : maxBodyBytes;
          const blob = includeBody(bodies, e, mime, size, maxBodyBytes) ? readResource(ref) : null;
          if (blob) {
            const { text, encoding } = decodeBody(blob, mime);
            content.text = text;
            if (encoding) content.encoding = encoding;
            if (content.size < 0) content.size = blob.length;
          } else {
            delete content.text;
            content.comment = "body omitted by verify-fix bundle (policy: " + bodies + ")";
          }
        } else if (content.text === "") {
          delete content.text;
        }
      }
      // request body
      const pd = e.request.postData;
      if (pd) {
        const ref = bodyRef(pd);
        delete pd._sha1;
        delete pd._file;
        if (ref && bodies !== "none") {
          const blob = readResource(ref);
          if (blob && blob.length <= maxBodyBytes) pd.text = decodeBody(blob, pd.mimeType ?? "").text;
        } else if (ref) {
          pd.text = "";
          pd.comment = "body omitted by verify-fix bundle (policy: none)";
        }
      }
      delete e._securityDetails;
      delete e._frameref;
      delete e._serviceWorkerRef;
      entries.push(e);
    }
  }
  entries.sort((a, b) => (a._monotonicTime ?? 0) - (b._monotonicTime ?? 0) || a.startedDateTime.localeCompare(b.startedDateTime));

  // calls from every .trace file
  const calls = new Map<string, RawCall>();
  const order: RawCall[] = [];
  let baseURL: string | null = null;
  let browserName: string | null = null;
  for (const file of traceFiles) {
    for (const ev of parseLines<Record<string, unknown>>(zip.get(file)!().toString("utf8"))) {
      const type = ev.type;
      if (type === "context-options") {
        browserName = (ev.browserName as string | undefined) ?? browserName;
        const options = ev.options as { baseURL?: string } | undefined;
        if (options?.baseURL) baseURL = options.baseURL;
      } else if (type === "before") {
        const stack = ev.stack as Array<{ file?: string; line?: number; column?: number }> | undefined;
        const top = Array.isArray(stack) && stack.length ? stack[0] : null;
        const call: RawCall = {
          callId: String(ev.callId),
          cls: String(ev.class ?? ""),
          method: String(ev.method ?? ""),
          title: typeof ev.title === "string" ? ev.title : typeof ev.apiName === "string" ? ev.apiName : null,
          params: (ev.params as Record<string, unknown> | undefined) ?? {},
          startTime: typeof ev.startTime === "number" ? ev.startTime : null,
          endTime: null,
          error: null,
          stepId: typeof ev.stepId === "string" ? ev.stepId : null,
          parentId: typeof ev.parentId === "string" ? ev.parentId : null,
          location: top && typeof top.file === "string" ? { file: top.file, line: Number(top.line ?? 0), column: Number(top.column ?? 0) } : null,
        };
        calls.set(call.callId, call);
        order.push(call);
      } else if (type === "after") {
        const call = calls.get(String(ev.callId));
        if (!call) continue;
        call.endTime = typeof ev.endTime === "number" ? ev.endTime : null;
        const err = ev.error as { message?: string } | undefined;
        if (err?.message) call.error = stripAnsi(err.message);
      }
    }
  }

  // Test-runner steps are the primary view when present (human titles, spec
  // locations, full error text); browser calls fill in params through stepId.
  const testSteps = order.filter((c) => c.cls === "Test");
  const browserByStep = new Map<string, RawCall>();
  for (const c of order) if (c.cls !== "Test" && c.stepId) browserByStep.set(c.stepId, c);

  let actions: TraceAction[];
  if (testSteps.length) {
    const KEEP: Record<string, ActionCategory> = { "pw:api": "pw:api", expect: "expect", "test.step": "test.step" };
    actions = testSteps
      .filter((s) => s.method in KEEP)
      .map((s) => toAction(s, KEEP[s.method], browserByStep.get(s.callId) ?? null));
  } else {
    actions = order.filter((c) => c.cls !== "Tracing").map((c) => toAction(c, "browser", null));
  }
  actions.sort((a, b) => (a.startTime ?? 0) - (b.startTime ?? 0));

  // The failing step: prefer the concrete call (expect / pw:api) over the
  // test.step container that inherits its error.
  const errored = actions.filter((a) => a.error);
  const failingAction = errored.find((a) => a.category === "expect" || a.category === "pw:api" || a.category === "browser") ?? errored[0] ?? null;

  const har: Har = {
    log: {
      version: "1.2",
      creator: { name: "verify-fix bundle", version: opts.creatorVersion ?? "0.1.0", comment: "extracted from a Playwright trace" },
      pages: [],
      entries,
    },
  };
  return {
    har,
    actions,
    failingAction,
    baseURL,
    browserName,
    files: { network: networkFiles, trace: traceFiles, resources: resourceCount },
  };
}

/** Merge several extracts (one per trace file) into one HAR, keeping order by time. */
export function mergeHars(hars: Har[], creatorVersion = "0.1.0"): Har {
  const entries = hars.flatMap((h) => h.log.entries);
  entries.sort((a, b) => (a._monotonicTime ?? 0) - (b._monotonicTime ?? 0) || a.startedDateTime.localeCompare(b.startedDateTime));
  return {
    log: {
      version: "1.2",
      creator: { name: "verify-fix bundle", version: creatorVersion, comment: `merged from ${hars.length} trace(s)` },
      pages: hars.flatMap((h) => h.log.pages),
      entries,
    },
  };
}
