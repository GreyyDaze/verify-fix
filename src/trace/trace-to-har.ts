// Playwright trace (.zip) → HAR 1.2 + the list of actions with their errors.
//
// Format (verified against playwright-core 1.63, lib/coreBundle.js):
//   <name>.network   JSON lines: { type: "resource-snapshot", snapshot: <HAR entry> }
//                    request.postData._sha1 / response.content._sha1 point at
//   resources/<sha1> the body blobs (name = sha1 + extension)
//   <name>.trace     JSON lines of events; the ones we use:
//                    { type: "before", callId, apiName, params, startTime, ... }
//                    { type: "after",  callId, endTime, error?: { message } }
//                    { type: "context-options", browserName, options: { baseURL? } }
// A trace zip may contain several chunks (trace.network, trace-1.network, …).

import { openZip } from "./zip.ts";
import type { Har, HarEntry } from "./har-types.ts";

export type BodyPolicy = "api" | "all" | "none";

export interface TraceAction {
  callId: string;
  apiName: string;
  /** Short human summary of the call: selector, url, expected value… */
  title: string;
  startTime: number | null;
  endTime: number | null;
  error: string | null;
  params: Record<string, unknown>;
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

function includeBody(policy: BodyPolicy, entry: HarEntry, mime: string, size: number, maxBytes: number): boolean {
  if (policy === "none") return false;
  if (size > maxBytes) return false;
  if (policy === "all") return true;
  // "api": pages and data the check actually reasons about; skip static assets
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

function summarize(apiName: string, params: Record<string, unknown>): string {
  const bits: string[] = [];
  const pick = (k: string) => {
    const v = params[k];
    if (v === undefined || v === null) return;
    bits.push(`${k}=${typeof v === "string" ? JSON.stringify(v) : JSON.stringify(v)}`);
  };
  for (const k of ["url", "selector", "expression", "expectedText", "expected", "text", "value", "timeout"]) pick(k);
  // expect.* params carry expectedText as an array of {string}
  const exp = params.expectedText;
  if (Array.isArray(exp)) {
    const strings = exp.map((e) => (e && typeof e === "object" && "string" in e ? String((e as { string: unknown }).string) : String(e)));
    bits.push(`expected=${JSON.stringify(strings.length === 1 ? strings[0] : strings)}`);
  }
  return `${apiName}${bits.length ? " " + bits.filter((b) => !b.startsWith("expectedText=")).join(" ") : ""}`;
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

  const readResource = (sha1: string): Buffer | null => {
    const r = zip.get(`resources/${sha1}`);
    return r ? r() : null;
  };

  const entries: HarEntry[] = [];
  for (const file of networkFiles) {
    for (const ev of parseLines<{ type: string; snapshot?: HarEntry }>(zip.get(file)!().toString("utf8"))) {
      if (ev.type !== "resource-snapshot" || !ev.snapshot || !ev.snapshot.request) continue;
      const e = structuredClone(ev.snapshot);
      // response body
      const mime = e.response?.content?.mimeType ?? "x-unknown";
      const sha1 = e.response?.content?._sha1;
      if (e.response?.content) {
        delete e.response.content._sha1;
        if (sha1) {
          const size = e.response.content.size >= 0 ? e.response.content.size : maxBodyBytes;
          const blob = includeBody(bodies, e, mime, size, maxBodyBytes) ? readResource(sha1) : null;
          if (blob) {
            const { text, encoding } = decodeBody(blob, mime);
            e.response.content.text = text;
            if (encoding) e.response.content.encoding = encoding;
            if (e.response.content.size < 0) e.response.content.size = blob.length;
          } else {
            e.response.content.comment = "body omitted by verify-fix bundle (policy: " + bodies + ")";
          }
        }
      }
      // request body
      const pd = e.request.postData;
      if (pd) {
        const psha = pd._sha1;
        delete pd._sha1;
        if (psha && bodies !== "none") {
          const blob = readResource(psha);
          if (blob && blob.length <= maxBodyBytes) pd.text = decodeBody(blob, pd.mimeType ?? "").text;
        }
      }
      delete e._securityDetails;
      delete e._frameref;
      delete e._serviceWorkerRef;
      entries.push(e);
    }
  }
  entries.sort((a, b) => (a._monotonicTime ?? 0) - (b._monotonicTime ?? 0) || a.startedDateTime.localeCompare(b.startedDateTime));

  // actions
  const before = new Map<string, TraceAction>();
  const actions: TraceAction[] = [];
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
        const params = (ev.params as Record<string, unknown> | undefined) ?? {};
        const apiName = String(ev.apiName ?? `${String(ev.class ?? "")}.${String(ev.method ?? "")}`);
        const a: TraceAction = {
          callId: String(ev.callId),
          apiName,
          title: summarize(apiName, params),
          startTime: typeof ev.startTime === "number" ? ev.startTime : null,
          endTime: null,
          error: null,
          params,
        };
        before.set(a.callId, a);
        actions.push(a);
      } else if (type === "after") {
        const a = before.get(String(ev.callId));
        if (!a) continue;
        a.endTime = typeof ev.endTime === "number" ? ev.endTime : null;
        const err = ev.error as { message?: string } | undefined;
        if (err?.message) a.error = err.message;
      }
    }
  }
  const failingAction = actions.find((a) => a.error) ?? null;

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
