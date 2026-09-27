// Thin client for the Checkly Public API — only the calls `verify-fix bundle`
// needs. Endpoints and headers are the ones the official CLI uses
// (checkly@9.5.0, dist/rest/*.js):
//   GET  /v1/checks/{id}
//   GET  /v2/check-results/{checkId}?limit&resultType&hasFailures&fields=a,b
//   GET  /v1/check-results/{checkId}/{resultId}
//   GET  /v1/check-results/{checkId}/{resultId}/assets[?type=trace]
//   GET  /v1/error-groups/checks/{checkId}
//   GET  /v1/error-groups/{id}
//   GET  /v1/root-cause-analyses/{id}          (202 = still running)
//   POST /v1/root-cause-analyses/error-groups/{errorGroupId}
// Auth: `Authorization: Bearer <key>` + `x-checkly-account: <id>`, sent ONLY to
// the API origin. Asset URLs on other origins are presigned and get no headers.

import type { ChecklyCredentials } from "./credentials.ts";
import type {
  AssetManifest,
  AssetType,
  ChecklyCheck,
  CheckResult,
  CheckResultsPage,
  ErrorGroup,
  RootCauseAnalysis,
} from "./types.ts";

export class ChecklyApiError extends Error {
  readonly status: number;
  readonly url: string;
  constructor(status: number, url: string, detail: string) {
    super(`Checkly API ${status} for ${url}${detail ? `: ${detail}` : ""}`);
    this.status = status;
    this.url = url;
  }
}

export interface ChecklyClientOptions {
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  userAgent?: string;
  /** retry budget for 429/5xx */
  retries?: number;
  sleep?: (ms: number) => Promise<void>;
}

export interface ListResultsParams {
  limit?: number;
  nextId?: string;
  from?: number;
  to?: number;
  hasFailures?: boolean;
  resultType?: "FINAL" | "ATTEMPT" | "ALL";
  fields?: string[];
}

/** Bound even non-asset API JSON before calling JSON.parse or Buffer.concat. */
export const MAX_API_JSON_BYTES = 16 * 1024 * 1024;

async function boundedResponseText(res: Response, maxBytes: number): Promise<string> {
  const length = res.headers.get("content-length");
  if (length !== null && /^\d+$/.test(length) && Number(length) > maxBytes) {
    await res.body?.cancel();
    throw new Error("Checkly API response exceeds JSON byte bound");
  }
  if (!res.body) return "";
  const reader = res.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value.byteLength > maxBytes - total) {
        await reader.cancel();
        throw new Error("Checkly API response exceeds JSON byte bound");
      }
      total += value.byteLength;
      chunks.push(Buffer.from(value));
    }
    return Buffer.concat(chunks, total).toString("utf8");
  } finally {
    reader.releaseLock();
  }
}

export class ChecklyClient {
  readonly baseUrl: string;
  private readonly creds: ChecklyCredentials;
  private readonly fetchImpl: typeof fetch;
  private readonly userAgent: string;
  private readonly retries: number;
  private readonly sleep: (ms: number) => Promise<void>;
  /** every request made, for the bundle's provenance section (no headers, no bodies). */
  readonly calls: Array<{ method: string; url: string; status: number }> = [];

  constructor(creds: ChecklyCredentials, opts: ChecklyClientOptions = {}) {
    this.creds = creds;
    this.baseUrl = (opts.baseUrl ?? process.env.CHECKLY_API_URL ?? "https://api.checklyhq.com").replace(/\/$/, "");
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.userAgent = opts.userAgent ?? "verify-fix-bundle/0.1.0";
    this.retries = opts.retries ?? 3;
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  private isApiOrigin(url: string): boolean {
    try {
      return new URL(url, this.baseUrl).origin === new URL(this.baseUrl).origin;
    } catch {
      return false;
    }
  }

  private async request(method: string, url: string, init: { body?: unknown; accept?: string } = {}): Promise<Response> {
    const absolute = new URL(url, this.baseUrl).toString();
    const headers: Record<string, string> = { "user-agent": this.userAgent, accept: init.accept ?? "application/json" };
    if (this.isApiOrigin(absolute)) {
      headers.authorization = `Bearer ${this.creds.apiKey}`;
      headers["x-checkly-account"] = this.creds.accountId;
    }
    let body: string | undefined;
    if (init.body !== undefined) {
      headers["content-type"] = "application/json";
      body = JSON.stringify(init.body);
    }
    let attempt = 0;
    for (;;) {
      const res = await this.fetchImpl(absolute, { method, headers, body });
      this.calls.push({ method, url: absolute.replace(/\?.*$/, ""), status: res.status });
      if ((res.status === 429 || res.status >= 500) && attempt < this.retries) {
        await res.body?.cancel();
        attempt += 1;
        const retryAfter = Number(res.headers.get("retry-after"));
        await this.sleep(Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 500 * 2 ** attempt);
        continue;
      }
      return res;
    }
  }

  private async json<T>(method: string, url: string, init: { body?: unknown } = {}): Promise<{ status: number; data: T }> {
    const res = await this.request(method, url, init);
    const text = await boundedResponseText(res, MAX_API_JSON_BYTES);
    if (!res.ok) throw new ChecklyApiError(res.status, url, text.slice(0, 300));
    // 202 bodies matter: GET rca → {id, status: "PENDING"}; POST trigger → {id, status: "PENDING"}.
    return { status: res.status, data: (text ? JSON.parse(text) : null) as T };
  }

  getCheck(id: string): Promise<ChecklyCheck> {
    return this.json<ChecklyCheck>("GET", `/v1/checks/${encodeURIComponent(id)}`).then((r) => r.data);
  }

  listResults(checkId: string, params: ListResultsParams = {}): Promise<CheckResultsPage> {
    const q = new URLSearchParams();
    if (params.limit) q.set("limit", String(params.limit));
    if (params.nextId) q.set("nextId", params.nextId);
    if (params.from) q.set("from", String(params.from));
    if (params.to) q.set("to", String(params.to));
    if (params.hasFailures !== undefined) q.set("hasFailures", String(params.hasFailures));
    if (params.resultType) q.set("resultType", params.resultType);
    if (params.fields?.length) q.set("fields", params.fields.join(","));
    const qs = q.toString();
    return this.json<CheckResultsPage | CheckResult[]>("GET", `/v2/check-results/${encodeURIComponent(checkId)}${qs ? `?${qs}` : ""}`).then((r) =>
      Array.isArray(r.data) ? { entries: r.data, nextId: null } : r.data,
    );
  }

  getResult(checkId: string, resultId: string): Promise<CheckResult> {
    return this.json<CheckResult>("GET", `/v1/check-results/${encodeURIComponent(checkId)}/${encodeURIComponent(resultId)}`).then((r) => r.data);
  }

  getAssets(checkId: string, resultId: string, type?: AssetType): Promise<AssetManifest> {
    const qs = type ? `?type=${type}` : "";
    return this.json<AssetManifest>("GET", `/v1/check-results/${encodeURIComponent(checkId)}/${encodeURIComponent(resultId)}/assets${qs}`).then((r) => r.data);
  }

  /** Stream an asset under a fixed byte budget; never allocate an unchecked body. */
  async download(url: string, maxBytes = 200 * 1024 * 1024): Promise<Buffer> {
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) throw new Error("invalid asset download byte bound");
    const res = await this.request("GET", url, { accept: "*/*" });
    if (!res.ok) {
      await res.body?.cancel();
      throw new Error(`asset download failed (HTTP ${res.status})`);
    }
    const length = res.headers.get("content-length");
    if (length !== null && /^\d+$/.test(length) && Number(length) > maxBytes) {
      await res.body?.cancel();
      throw new Error("asset download exceeds byte bound (Content-Length)");
    }
    if (!res.body) return Buffer.alloc(0);
    const reader = res.body.getReader();
    const chunks: Buffer[] = [];
    let total = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value.byteLength > maxBytes - total) {
          await reader.cancel();
          throw new Error("asset download exceeds byte bound (stream)");
        }
        total += value.byteLength;
        chunks.push(Buffer.from(value));
      }
      return Buffer.concat(chunks, total);
    } finally {
      reader.releaseLock();
    }
  }

  errorGroupsForCheck(checkId: string): Promise<ErrorGroup[]> {
    return this.json<ErrorGroup[]>("GET", `/v1/error-groups/checks/${encodeURIComponent(checkId)}`).then((r) => r.data ?? []);
  }

  getErrorGroup(id: string): Promise<ErrorGroup> {
    return this.json<ErrorGroup>("GET", `/v1/error-groups/${encodeURIComponent(id)}`).then((r) => r.data);
  }

  async getRca(id: string): Promise<{ status: "ready"; rca: RootCauseAnalysis } | { status: "pending" }> {
    const r = await this.json<RootCauseAnalysis>("GET", `/v1/root-cause-analyses/${encodeURIComponent(id)}`);
    return r.status === 202 ? { status: "pending" } : { status: "ready", rca: r.data };
  }

  /**
   * Ask Rocky for a new analysis of an error group. Same call the Checkly CLI
   * makes for `checkly rca run --error-group <id>`; the API answers 202 with
   * {id, status: "PENDING"} and the analysis is polled with getRca().
   * `userContext` is the CLI's `--user-context` (free text Rocky reads).
   */
  async triggerRca(errorGroupId: string, userContext?: string): Promise<{ id: string }> {
    const url = `/v1/root-cause-analyses/error-groups/${encodeURIComponent(errorGroupId)}`;
    const r = await this.json<{ id?: string; status?: string } | null>("POST", url, userContext ? { body: { userContext } } : {});
    const id = r.data?.id;
    if (!id) throw new ChecklyApiError(r.status, url, `trigger accepted but no RCA id in the response body: ${JSON.stringify(r.data)?.slice(0, 200)}`);
    return { id };
  }

  async waitForRca(id: string, timeoutMs = 180_000, pollMs = 2000): Promise<RootCauseAnalysis | null> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const r = await this.getRca(id);
      if (r.status === "ready") return r.rca;
      if (Date.now() > deadline) return null;
      await this.sleep(pollMs);
    }
  }
}
