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
//   inject            forwarded, except the request matching the rule, which
//                     is answered with the recorded failing response (same
//                     method, path and status in the failing HAR) or a plain
//                     JSON failure when the recording has none
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
}

const HOP_BY_HOP = new Set(["host", "connection", "keep-alive", "transfer-encoding", "te", "trailer", "upgrade", "proxy-connection", "content-length", "accept-encoding", "expect"]);
const DROP_RESPONSE = new Set(["content-encoding", "transfer-encoding", "content-length", "connection", "keep-alive"]);

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

  /** Arm the proxy for one scene repetition. Returns one ENVIRONMENT_URL per run. */
  async arm(opts: ArmOptions): Promise<string[]> {
    await this.closeServers();
    this.opts = opts;
    this.hitsList = [];
    this.ordinals = Array.from({ length: opts.runs }, () => 0);
    this.actionOrdinals = Array.from({ length: opts.runs }, () => 0);
    this.replayUsed = new Map();
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
    const url = new URL(req.url ?? "/", this.urls[runIndex]);
    const body = await readBody(req);
    const action = shouldInterleave(req);
    const hit: ProxyHit = { runIndex, ordinal, method, path: url.pathname, status: 0, action, source: "error" };
    this.hitsList.push(hit);

    let answer: Answer = { status: 502, headers: { "content-type": "application/json" }, body: Buffer.from(JSON.stringify({ error: "verify-fix proxy: not handled" })), source: "error" };
    const forward = async () => {
      try {
        answer = await this.answer(opts, runIndex, method, url, req, body);
      } catch (err) {
        answer = { status: 502, headers: { "content-type": "application/json" }, body: Buffer.from(JSON.stringify({ error: `verify-fix proxy: ${(err as Error).message}` })), source: "error" };
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

  private async answer(opts: ArmOptions, runIndex: number, method: string, url: URL, req: IncomingMessage, body: Buffer): Promise<Answer> {
    const mode = opts.mode;
    if (mode.kind === "replay") {
      if (opts.replayBrowserAssetsFromTarget && !shouldInterleave(req)) {
        if (!opts.target) throw new Error("browser replay needs a target because the HAR omits page asset bodies");
        return this.forwardToTarget(opts.target, this.urls[runIndex], method, url, req, body);
      }
      return this.fromRecording(opts.replayHar ?? null, method, url);
    }
    if (mode.kind === "inject" && matchesRule(mode.rule, method, url)) return injected(mode.rule, opts.failingHar ?? null);
    if (mode.kind === "unknown" || mode.kind === "pending") throw new Error(mode.reason);
    if (!opts.target) throw new Error("no target for a live scene (pass --target <url>)");
    return this.forwardToTarget(opts.target, this.urls[runIndex], method, url, req, body);
  }

  private async forwardToTarget(target: string, proxyOrigin: string, method: string, url: URL, req: IncomingMessage, body: Buffer): Promise<Answer> {
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
    return { status: res.status, headers: out, body: Buffer.from(await res.arrayBuffer()), source: "target" };
  }

  private fromRecording(har: Har | null, method: string, url: URL): Answer {
    if (!har) return notRecorded(method, url, "no recording loaded for replay");
    const candidates = har.log.entries.filter((e) => e.request.method.toUpperCase() === method && samePath(e.request.url, url));
    if (candidates.length === 0) return notRecorded(method, url, "no recorded response");
    const key = `${method} ${url.pathname}`;
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

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function samePath(recordedUrl: string, url: URL): boolean {
  try {
    const r = new URL(recordedUrl);
    if (r.pathname !== url.pathname) return false;
    // a recorded query string must match when the live request has one (RSC requests etc.)
    if (r.search && url.search) return r.search === url.search;
    return true;
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
