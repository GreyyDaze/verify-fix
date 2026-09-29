// Scene proxy — the one place a scene shapes traffic. The check under test
// talks to ENVIRONMENT_URL; that is this proxy. Per scene it is armed with a
// mode and a target, then every request is:
//
//   live              forwarded to the target as-is
//   live-concurrent   forwarded, but API/fetch call k of every run is held
//                     until all runs have sent call k, then the group is
//                     forwarded in run order and responses are released
//                     together. Browser documents/assets bypass the barrier.
//                     Two runs therefore execute "login, login, book, book" —
//                     the recorded 401 overlap — instead of scheduler timing.
//   inject            generic recorded/error response (non-Multistep)
//   multistep-detection  forward the four fixed API calls; only when the
//                     validated nested book response agrees with the live
//                     account/token/version/slot chain, flip its existing
//                     booking.confirmed boolean from true to false (HTTP 200)
//   replay            answered from a HAR; the target is never contacted
//
// Every request is counted per run. The executor's evidence gate reads these
// counts: a run with zero hits never becomes a pass or a fail.
//
// One listener per concurrent run (127.0.0.1, random port) — the run index is
// known from the port, so nothing has to be injected into the customer's
// check to tell runs apart. Redirect Location headers pointing at the target
// are rewritten to the run's proxy origin so a following request still goes
// through the proxy.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { Har, HarEntry } from "../trace/har-types.ts";
import type { InjectRule, ParsedMode } from "./modes.ts";
import { isTrustedMultiStepDetection, type TrustedMultiStepDetection } from "../multistep/detection.ts";
import { knownRoute } from "../multistep/routes.ts";

export interface ProxyHit {
  runIndex: number;
  /** 1-based request ordinal within the run */
  ordinal: number;
  method: string;
  path: string;
  status: number;
  /** true for API/fetch traffic; false for browser documents and assets */
  action: boolean;
  source: "target" | "recording" | "injected" | "unmatched" | "error";
}

export interface ArmOptions {
  mode: ParsedMode;
  /** target origin for live/inject modes, e.g. http://127.0.0.1:3000 */
  target: string | null;
  /** number of concurrent runs = listeners */
  runs: number;
  /** recording used by replay (the one named in the mode) */
  replayHar?: Har | null;
  /** For API-only browser HARs, serve page assets from the explicit target. */
  replayBrowserAssetsFromTarget?: boolean;
  /** the failing recording — inject answers with its recorded failure when it has one */
  failingHar?: Har | null;
  /** lockstep barrier: how long to wait for the other runs' request k before forwarding anyway */
  barrierTimeoutMs?: number;
  /** Granted only after re-loading and validating a remote failing v3 bundle. */
  trustedMultiStepDetection?: TrustedMultiStepDetection;
}

const HOP_BY_HOP = new Set(["host", "connection", "keep-alive", "transfer-encoding", "te", "trailer", "upgrade", "proxy-connection", "content-length", "accept-encoding", "expect"]);
const DROP_RESPONSE = new Set(["content-encoding", "transfer-encoding", "content-length", "connection", "keep-alive"]);

interface DetectionState {
  account: string;
  token: string;
  version: number;
  session: boolean;
  slots: boolean;
}

/** Parser bound to the fixed transaction; never retain or log raw bodies. */
function boundedJsonObject(bytes: Buffer): Record<string, unknown> | null {
  if (bytes.length > 16 * 1024) return null;
  try {
    const value: unknown = JSON.parse(bytes.toString("utf8"));
    return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
  } catch { return null; }
}
function version(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= 1_000_000_000;
}

interface Pending {
  runIndex: number;
  ordinal: number;
  forward: () => Promise<void>;
  release: () => void;
}

class Barrier {
  private groups = new Map<number, { pending: Pending[]; timer: NodeJS.Timeout | null; started: boolean }>();
  private finished = new Set<number>();
  private readonly runs: number;
  private readonly timeoutMs: number;
  constructor(runs: number, timeoutMs: number) {
    this.runs = runs;
    this.timeoutMs = timeoutMs;
  }

  /** A run exited: it will not send more requests, so waiting groups can go. */
  runFinished(runIndex: number): void {
    this.finished.add(runIndex);
    for (const k of [...this.groups.keys()]) void this.tryRun(k);
  }

  private activeRuns(): number {
    return this.runs - this.finished.size;
  }

  /** Register request `ordinal` of run `runIndex`; resolves when its response may be released. */
  enter(p: Pending): Promise<void> {
    return new Promise<void>((resolve) => {
      const entry: Pending = { ...p, release: resolve };
      let g = this.groups.get(p.ordinal);
      if (!g) {
        g = { pending: [], timer: null, started: false };
        this.groups.set(p.ordinal, g);
        g.timer = setTimeout(() => void this.tryRun(p.ordinal, true), this.timeoutMs);
      }
      g.pending.push(entry);
      void this.tryRun(p.ordinal);
    });
  }

  private async tryRun(ordinal: number, timedOut = false): Promise<void> {
    const g = this.groups.get(ordinal);
    if (!g || g.started) return;
    const present = new Set(g.pending.map((p) => p.runIndex));
    const waitingFor = [...Array(this.runs).keys()].filter((i) => !present.has(i) && !this.finished.has(i));
    if (waitingFor.length > 0 && !timedOut && this.activeRuns() > present.size) return;
    g.started = true;
    if (g.timer) clearTimeout(g.timer);
    this.groups.delete(ordinal);
    // forward one after another in run order; release all responses together
    const ordered = [...g.pending].sort((a, b) => a.runIndex - b.runIndex);
    for (const p of ordered) await p.forward();
    for (const p of ordered) p.release();
  }
}

export class SceneProxy {
  private servers: Server[] = [];
  private urls: string[] = [];
  private opts: ArmOptions | null = null;
  private hitsList: ProxyHit[] = [];
  private ordinals: number[] = [];
  /** Ordinals only for API/fetch traffic. Browser assets never enter the barrier. */
  private actionOrdinals: number[] = [];
  private barrier: Barrier | null = null;
  private replayUsed = new Map<string, number>();
  /** Raw identities live only in memory during this one scene repetition. */
  private detectionStates: Array<DetectionState | null> = [];

  /** Arm the proxy for one scene repetition. Returns one ENVIRONMENT_URL per run. */
  async arm(opts: ArmOptions): Promise<string[]> {
    await this.closeServers();
    this.opts = opts;
    this.hitsList = [];
    this.ordinals = Array.from({ length: opts.runs }, () => 0);
    this.actionOrdinals = Array.from({ length: opts.runs }, () => 0);
    this.replayUsed = new Map();
    if (opts.mode.kind === "multistep-detection" && !isTrustedMultiStepDetection(opts.trustedMultiStepDetection)) {
      throw new Error("SCENE_PROXY_DETECTION_AUTHORITY_MISSING");
    }
    if (opts.mode.kind === "replay" && opts.replayHar && (!Array.isArray(opts.replayHar.log?.entries)
      || opts.replayHar.log.entries.length > 2000)) throw new Error("SCENE_PROXY_RECORDING_INVALID");
    this.detectionStates = Array.from({ length: opts.runs }, () => null);
    this.barrier = opts.mode.kind === "live-concurrent" && opts.runs > 1 ? new Barrier(opts.runs, opts.barrierTimeoutMs ?? 2000) : null;
    this.urls = [];
    for (let i = 0; i < opts.runs; i++) {
      const server = createServer((req, res) => void this.handle(i, req, res));
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
      const addr = server.address();
      if (!addr || typeof addr !== "object") throw new Error("proxy: no port");
      this.servers.push(server);
      this.urls.push(`http://127.0.0.1:${addr.port}`);
    }
    return this.urls;
  }

  urlFor(runIndex: number): string {
    return this.urls[runIndex];
  }

  hits(): ProxyHit[] {
    return [...this.hitsList];
  }

  hitsFor(runIndex: number): number {
    return this.hitsList.filter((h) => h.runIndex === runIndex).length;
  }

  /** Tell the lockstep barrier a run's sandbox has exited. */
  runFinished(runIndex: number): void {
    this.barrier?.runFinished(runIndex);
  }

  async close(): Promise<void> {
    await this.closeServers();
    this.detectionStates = [];
  }

  private async closeServers(): Promise<void> {
    const servers = this.servers;
    this.servers = [];
    await Promise.all(servers.map((s) => new Promise<void>((resolve) => s.close(() => resolve()))));
  }

  private async handle(runIndex: number, req: IncomingMessage, res: ServerResponse): Promise<void> {
    const opts = this.opts!;
    const ordinal = ++this.ordinals[runIndex];
    const method = (req.method ?? "GET").toUpperCase();
    let url: URL;
    try { url = new URL(req.url ?? "/", this.urls[runIndex]); }
    catch {
      res.writeHead(400, { "content-type": "application/json" });
      res.end('{"error":"invalid scene request"}');
      return;
    }
    const detection = opts.mode.kind === "multistep-detection";
    const action = shouldInterleave(req);
    const hit: ProxyHit = { runIndex, ordinal, method,
      path: detection ? knownRoute(url.pathname) ?? "<unknown-route>" : url.pathname,
      status: 0, action, source: "error" };
    // The fifth request is evidence of a noncanonical run; never let an
    // unbounded stream of later requests grow the in-memory evidence list.
    if (!detection || ordinal <= 5) this.hitsList.push(hit);
    const expected = [["POST", "/api/login"], ["GET", "/api/session"],
      ["GET", "/api/slots"], ["POST", "/api/book"]] as const;
    if (detection && (ordinal > 4 || !expected[ordinal - 1]
      || method !== expected[ordinal - 1]![0] || req.url !== expected[ordinal - 1]![1]
      || url.origin !== this.urls[runIndex])) {
      hit.status = 400;
      res.writeHead(400, { "content-type": "application/json" });
      res.end('{"error":"noncanonical scene request"}');
      return;
    }
    let body: Buffer;
    try {
      body = await readBody(req, detection ? 1024 : 1024 * 1024);
    } catch {
      hit.status = 413;
      res.writeHead(413, { "content-type": "application/json" });
      res.end('{"error":"verify-fix detection request exceeds bound"}');
      return;
    }

    let answer: Answer = { status: 502, headers: { "content-type": "application/json" }, body: Buffer.from(JSON.stringify({ error: "verify-fix proxy: not handled" })), source: "error" };
    const forward = async () => {
      try {
        answer = await this.answer(opts, runIndex, ordinal, method, url, req, body);
      } catch {
        // Never reflect upstream error text: it may contain credentials,
        // signed URLs, cookies or the target's own private diagnostics.
        answer = { status: 502, headers: { "content-type": "application/json" },
          body: Buffer.from('{"error":"verify-fix proxy forward unavailable"}'), source: "error" };
      }
    };
    // Browser document/script/style/image requests can arrive in a different
    // order in each process. Pairing those by ordinal can deadlock or pair a
    // login with a script. Fetch/XHR requests have `sec-fetch-dest: empty`.
    // Non-browser API clients omit that header, so all of their calls retain
    // the Phase 3 lockstep behavior.
    if (this.barrier && action) {
      const actionOrdinal = ++this.actionOrdinals[runIndex];
      await this.barrier.enter({ runIndex, ordinal: actionOrdinal, forward, release: () => {} });
    } else {
      await forward();
    }

    hit.status = answer.status;
    hit.source = answer.source;
    res.writeHead(answer.status, answer.headers);
    res.end(answer.body);
  }

  private async answer(opts: ArmOptions, runIndex: number, ordinal: number, method: string, url: URL, req: IncomingMessage, body: Buffer): Promise<Answer> {
    const mode = opts.mode;
    if (mode.kind === "replay") {
      if (opts.replayBrowserAssetsFromTarget && !shouldInterleave(req)) {
        if (!opts.target) throw new Error("browser replay needs a target because the HAR omits page asset bodies");
        return this.forwardToTarget(opts.target, this.urls[runIndex], method, url, req, body);
      }
      return this.fromRecording(opts.replayHar ?? null, runIndex, method, url);
    }
    if (mode.kind === "inject" && matchesRule(mode.rule, method, url)) return injected(mode.rule, opts.failingHar ?? null);
    if (mode.kind === "unknown" || mode.kind === "pending") throw new Error(mode.reason);
    if (!opts.target) throw new Error("no target for a live scene (pass --target <url>)");
    if (mode.kind === "multistep-detection" && !isTrustedMultiStepDetection(opts.trustedMultiStepDetection)) {
      throw new Error("Multistep detection has no remote failing-side provenance");
    }
    const forwarded = await this.forwardToTarget(opts.target, this.urls[runIndex], method, url, req, body,
      mode.kind === "multistep-detection" ? 16 * 1024 : undefined);
    return mode.kind === "multistep-detection"
      ? this.mutateNestedBooking(runIndex, ordinal, method, url, req, body, forwarded)
      : forwarded;
  }

  /** The ONLY Multistep response mutation. It cannot set a path, status,
   * field name, arbitrary body, or new fact. If any runtime relationship is
   * absent, forward unchanged and let the scene's mutation-hit gate return
   * UNCERTAIN. The original remote recording is never modified or re-admitted. */
  private mutateNestedBooking(runIndex: number, ordinal: number, method: string, url: URL,
    req: IncomingMessage, requestBody: Buffer, answer: Answer): Answer {
    const sequence = [["POST", "/api/login"], ["GET", "/api/session"],
      ["GET", "/api/slots"], ["POST", "/api/book"]] as const;
    const expected = sequence[ordinal - 1];
    if (!expected || method !== expected[0] || url.pathname !== expected[1]
      || url.search || url.hash || answer.status !== 200) return answer;
    const response = boundedJsonObject(answer.body);
    if (!response) return answer;
    if (ordinal === 1) {
      const input = boundedJsonObject(requestBody);
      if (!input || Object.keys(input).length !== 1 || typeof input.account !== "string"
        || !input.account || input.account.length > 512 || req.headers.authorization !== undefined
        || response.ok !== true || response.account !== input.account
        || typeof response.token !== "string" || !response.token || response.token.length > 512
        || !version(response.version)) return answer;
      this.detectionStates[runIndex] = {
        account: input.account, token: response.token, version: response.version, session: false, slots: false,
      };
      return answer;
    }
    const state = this.detectionStates[runIndex];
    const previous = this.hitsList.filter((hit) => hit.runIndex === runIndex && hit.ordinal < ordinal);
    if (!state || previous.length !== ordinal - 1 || previous.some((hit, i) =>
      hit.ordinal !== i + 1 || hit.method !== sequence[i]![0] || hit.path !== sequence[i]![1]
      || hit.status !== 200 || hit.source !== "target")) return answer;
    if (ordinal === 2) {
      if (requestBody.length !== 0 || req.headers.authorization !== `Bearer ${state.token}`
        || response.valid !== true || response.account !== state.account
        || response.tokenVersion !== state.version || response.currentVersion !== state.version) return answer;
      state.session = true;
      return answer;
    }
    if (ordinal === 3) {
      if (!state.session || requestBody.length !== 0 || req.headers.authorization !== undefined
        || !Array.isArray(response.slots) || response.slots.length > 64
        || !response.slots.includes("09:30") || !version(response.delayMs)) return answer;
      state.slots = true;
      return answer;
    }
    const input = boundedJsonObject(requestBody);
    const booking = response.booking;
    if (!state.session || !state.slots || !input || Object.keys(input).length !== 1
      || input.slot !== "09:30" || req.headers.authorization !== `Bearer ${state.token}`
      || !/^application\/json(?:\s*;|$)/i.test(answer.headers["content-type"] ?? "")
      || Object.keys(response).length !== 1 || !Object.hasOwn(response, "booking")
      || !booking || typeof booking !== "object" || Array.isArray(booking)
      || JSON.stringify(Object.keys(booking).sort()) !== JSON.stringify(["account", "confirmed", "sessionVersion", "slot", "status"])
      || (booking as Record<string, unknown>).confirmed !== true
      || (booking as Record<string, unknown>).status !== "CONFIRMED"
      || (booking as Record<string, unknown>).account !== state.account
      || (booking as Record<string, unknown>).slot !== "09:30"
      || (booking as Record<string, unknown>).sessionVersion !== state.version) return answer;
    this.detectionStates[runIndex] = null;
    // All other booking properties are copied from the ACTUAL HTTP-200
    // target response, after their presence and relationships were checked.
    // Do not forward upstream headers (including cookies, validators, or
    // secret-bearing extensions) on this newly encoded response.
    const mutated = Buffer.from(JSON.stringify({ booking: { ...(booking as Record<string, unknown>), confirmed: false } }));
    return { status: 200, headers: { "content-type": "application/json", "content-length": String(mutated.byteLength) },
      body: mutated, source: "injected" };
  }

  private async forwardToTarget(target: string, proxyOrigin: string, method: string, url: URL, req: IncomingMessage, body: Buffer,
    detectionResponseLimit?: number): Promise<Answer> {
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(req.headers)) {
      if (v === undefined || HOP_BY_HOP.has(k)) continue;
      headers[k] = Array.isArray(v) ? v.join(", ") : v;
    }
    headers["accept-encoding"] = "identity";
    const targetUrl = new URL(url.pathname + url.search, target);
    const payload = method === "GET" || method === "HEAD" ? undefined : new Uint8Array(body);
    const res = await fetch(targetUrl, { method, headers, body: payload, redirect: "manual" });
    const out: Record<string, string> = {};
    res.headers.forEach((value, name) => {
      if (DROP_RESPONSE.has(name)) return;
      out[name] = name === "location" ? rewriteOrigin(value, target, proxyOrigin) : value;
    });
    const responseBody = await boundedResponseBody(res, detectionResponseLimit ?? 16 * 1024 * 1024);
    return { status: res.status, headers: out, body: responseBody, source: "target" };
  }

  private fromRecording(har: Har | null, runIndex: number, method: string, url: URL): Answer {
    if (!har) return notRecorded(method, url, "no recording loaded for replay");
    const candidates = har.log.entries.filter((e) => e.request.method.toUpperCase() === method && samePath(e.request.url, url));
    if (candidates.length === 0) return notRecorded(method, url, "no recorded response");
    const key = `${runIndex}:${method} ${url.pathname}${url.search}`;
    const used = this.replayUsed.get(key) ?? 0;
    this.replayUsed.set(key, used + 1);
    // successive identical requests get successive recorded responses; the last one repeats
    const entry = candidates[Math.min(used, candidates.length - 1)];
    return fromEntry(entry, "recording");
  }
}

interface Answer {
  status: number;
  headers: Record<string, string>;
  body: Buffer;
  source: ProxyHit["source"];
}

function readBody(req: IncomingMessage, maxBytes?: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let exceeded = false;
    req.on("data", (c: Buffer) => {
      if (exceeded) return;
      if (maxBytes !== undefined && size + c.length > maxBytes) {
        exceeded = true;
        chunks.length = 0;
        return;
      }
      size += c.length;
      chunks.push(c);
    });
    req.on("end", () => exceeded ? reject(new Error("bounded detection request")) : resolve(Buffer.concat(chunks, size)));
    req.on("error", reject);
  });
}

async function boundedResponseBody(response: Response, maxBytes: number): Promise<Buffer> {
  const rawLength = response.headers.get("content-length");
  if (rawLength !== null && (!/^\d+$/.test(rawLength)
    || !Number.isSafeInteger(Number(rawLength)) || Number(rawLength) > maxBytes)) {
    await response.body?.cancel();
    throw new Error("bounded detection response");
  }
  const reader = response.body?.getReader();
  if (!reader) return Buffer.alloc(0);
  const chunks: Buffer[] = [];
  let size = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) return Buffer.concat(chunks, size);
    if (size + value.length > maxBytes) {
      await reader.cancel();
      throw new Error("bounded detection response");
    }
    chunks.push(Buffer.from(value));
    size += value.length;
  }
}

function samePath(recordedUrl: string, url: URL): boolean {
  try {
    const r = new URL(recordedUrl);
    if (r.pathname !== url.pathname) return false;
    // Neither a missing, added, nor changed query can borrow a recorded
    // response. Hashes and fragments are not a supported replay identity.
    return r.search === url.search && !r.hash && !url.hash;
  } catch {
    return false;
  }
}

/** Browser fetch/XHR uses `empty`; assets and navigations name their type. */
export function shouldInterleave(req: Pick<IncomingMessage, "headers" | "method" | "url">): boolean {
  const raw = req.headers["sec-fetch-dest"];
  const dest = Array.isArray(raw) ? raw[0] : raw;
  if (dest === undefined) return true; // Node/API checks have no Fetch Metadata header.
  if (dest !== "" && dest !== "empty") return false; // document, script, style, image, font…
  // Next.js client navigation and prefetch also use fetch(), but they are page
  // assets rather than business API actions and may differ between browsers.
  if (req.headers.rsc !== undefined || req.headers["next-router-state-tree"] !== undefined || req.headers["next-router-prefetch"] !== undefined) return false;
  const path = new URL(req.url ?? "/", "http://proxy.invalid").pathname;
  if (path.startsWith("/_next/") || /\.(?:js|css|map|png|jpe?g|gif|webp|svg|ico|woff2?|ttf|otf)$/i.test(path)) return false;
  return true;
}

function matchesRule(rule: InjectRule, method: string, url: URL): boolean {
  return rule.method === method && rule.path === url.pathname;
}

function rewriteOrigin(location: string, target: string, proxyOrigin: string): string {
  try {
    const t = new URL(target);
    const l = new URL(location, target);
    if (l.origin === t.origin) return proxyOrigin + l.pathname + l.search + l.hash;
    return location;
  } catch {
    return location;
  }
}

function fromEntry(entry: HarEntry, source: ProxyHit["source"]): Answer {
  const content = entry.response.content;
  const body = content.text === undefined ? Buffer.alloc(0) : content.encoding === "base64" ? Buffer.from(content.text, "base64") : Buffer.from(content.text, "utf8");
  const headers: Record<string, string> = {};
  for (const h of entry.response.headers) {
    const name = h.name.toLowerCase();
    if (DROP_RESPONSE.has(name) || name === "set-cookie") continue;
    headers[name] = h.value;
  }
  if (!headers["content-type"] && content.mimeType) headers["content-type"] = content.mimeType;
  return { status: entry.response.status, headers, body, source };
}

function injected(rule: InjectRule, failingHar: Har | null): Answer {
  const recorded = failingHar?.log.entries.find((e) => e.request.method.toUpperCase() === rule.method && e.response.status === rule.status && new URL(e.request.url).pathname === rule.path);
  if (recorded) return fromEntry(recorded, "injected");
  return {
    status: rule.status,
    headers: { "content-type": "application/json" },
    body: Buffer.from(JSON.stringify({ error: `injected by verify-fix detection scene (${rule.raw})` })),
    source: "injected",
  };
}

function notRecorded(method: string, url: URL, why: string): Answer {
  return {
    status: 404,
    headers: { "content-type": "application/json" },
    body: Buffer.from(JSON.stringify({ error: `verify-fix replay: ${why} for ${method} ${url.pathname}` })),
    source: "unmatched",
  };
}
