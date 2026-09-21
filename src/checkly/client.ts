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
    if (res.status === 202) return { status: 202, data: undefined as unknown as T };
    const text = await res.text();
    if (!res.ok) throw new ChecklyApiError(res.status, url, text.slice(0, 300));
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

  /** Download an asset (API path or presigned URL) into memory. */
  async download(url: string, maxBytes = 200 * 1024 * 1024): Promise<Buffer> {
    const res = await this.request("GET", url, { accept: "*/*" });
    if (!res.ok) throw new ChecklyApiError(res.status, url.replace(/\?.*$/, ""), "asset download failed");
    const ab = await res.arrayBuffer();
    if (ab.byteLength > maxBytes) throw new Error(`asset larger than ${maxBytes} bytes: ${url.replace(/\?.*$/, "")}`);
    return Buffer.from(ab);
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

  triggerRca(errorGroupId: string): Promise<{ id: string }> {
    return this.json<{ id: string }>("POST", `/v1/root-cause-analyses/error-groups/${encodeURIComponent(errorGroupId)}`).then((r) => r.data);
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
