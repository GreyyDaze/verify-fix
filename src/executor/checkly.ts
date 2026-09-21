// Checkly experiment executor — PR-1: every experiment observed via real
// Checkly (deploy → trigger → read), no side test runner decides a verdict.
// Endpoints follow Checkly API v1 shapes (browser checks are /v1/check-checks).
// NOTE: route shapes were written from the API's documented surface but cannot
// be exercised without a live account + API key; `verify-fix checkly --dry-run`
// prints exactly the operations a live run would perform. The definitive live
// proof is a build-time task once credentials exist (prod PRD §11.2).

import type { Bundle, ExperimentExecutor, Scene, SceneObservation, TraceStep } from "../types.ts";
import { sceneExpected } from "../contract/contract.ts";

const API_BASE = process.env.CHECKLY_API_BASE ?? "https://api.checklyhq.com/v1";

export interface ChecklyExecutorOptions {
  apiKey?: string;
  accountId?: string;
  dryRunOnly?: boolean;
  verbose?: boolean;
}

export class ChecklyExecutor implements ExperimentExecutor {
  readonly kind = "checkly" as const;
  private readonly apiKey: string | null;
  private readonly accountId: string | null;
  private readonly dryRunOnly: boolean;
  readonly verbose: boolean;
  private used = 0;
  budgetExhausted = false;
  readonly maxRunsPerScene: number;
  nondeterministicScenes: string[] = [];

  constructor(opts: ChecklyExecutorOptions = {}) {
    this.apiKey = opts.apiKey ?? process.env.CHECKLY_API_KEY ?? null;
    this.accountId = opts.accountId ?? process.env.CHECKLY_ACCOUNT_ID ?? null;
    this.dryRunOnly = opts.dryRunOnly ?? false;
    this.verbose = opts.verbose ?? false;
    this.maxRunsPerScene = 10;
  }

  isLive(): boolean {
    return Boolean(this.apiKey) && !this.dryRunOnly;
  }

  costReport(): { scenes: number; runs: number } {
    return { scenes: this.used, runs: this.used };
  }

  private checkCreds(): void {
    if (!this.apiKey && !this.dryRunOnly) {
      throw new Error(
        "Checkly executor requires CHECKLY_API_KEY (and optionally CHECKLY_ACCOUNT_ID). Use --executor synthetic, or CHECKLY_DRY_RUN=1 for dry-run."
      );
    }
  }

  private async api<T>(method: string, path: string, body?: unknown): Promise<T> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.apiKey ?? "dry-run"}`,
      "Content-Type": "application/json",
    };
    if (this.accountId) headers["X-Checkly-Account"] = this.accountId;
    if (this.dryRunOnly || !this.apiKey) {
      const line = `[checkly dry-run] ${method} ${API_BASE}${path}`;
      if (this.verbose) console.error(line);
      return { dryRun: true, path, method } as T;
    }
    const res = await fetch(`${API_BASE}${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
    if (!res.ok) {
      throw new Error(`Checkly API ${method} ${path} → ${res.status} ${await res.text().then((t) => t.slice(0, 300))}`);
    }
    return (await res.json()) as T;
  }

  private bodyFor(bundle: Bundle, patchSource: string, scene: Scene): Record<string, unknown> {
    return {
      name: `verify-fix-${bundle.incidentId}-${scene.sceneId}`,
      type: "BROWSER",
      script: patchSource,
      frequency: 10,
      locations: ["us-east-1"],
      tags: ["verify-fix"],
      activated: true,
      environmentVariables: [{ key: "APP_BASE_URL", value: process.env.APP_BASE_URL ?? scene.state }, { key: "APP_SCENE", value: scene.sceneId }],
    };
  }

  async runScene(bundle: Bundle, patchSource: string, scene: Scene): Promise<SceneObservation> {
    this.checkCreds();
    if (this.used >= this.maxRunsPerScene) {
      this.budgetExhausted = true;
      // no run happened → no observation (never a pass)
      return { sceneId: scene.sceneId, observed: "uncertain", repetitions: 0, trace: [], source: "checkly", reason: "run budget exhausted" };
    }
    const deployed = await this.api<{ id?: string }>("PUT", `/v1/check-checks/${bundle.check.deployedId ?? "verify-fix-dry-run"}`, this.bodyFor(bundle, patchSource, scene));
    const checkId = deployed.id ?? `${bundle.check.logicalId}-${scene.sceneId}`;
    const run = await this.api<{ result_id?: string; id?: string }>("POST", `/v1/check-checks/${checkId}/runs`, {});
    this.used += 1;
    if (this.dryRunOnly || !this.apiKey) {
      // A dry run performs no live check: there is no observation to admit.
      return {
        sceneId: scene.sceneId,
        observed: "uncertain",
        repetitions: 0,
        trace: [{ index: 0, kind: "step", what: "dry-run: no live result", outcome: "skipped" }],
        source: "checkly",
        reason: "checkly dry-run: no live run was performed",
      };
    }
    const resultId = run.result_id ?? run.id ?? "dry-run";
    const result = await this.api<{ successful?: boolean; checkResult?: Array<{ status?: string; name?: string }> }>(
      "GET",
      `/v1/check-results/${resultId}`
    );
    const passed = result.successful === true;
    const { observed: expected } = sceneExpected(scene);
    const trace: TraceStep[] = (
      result.checkResult ?? []
    ).map((c, i) => ({ index: i, kind: "assertion", what: `${c.name ?? "assertion"}`, outcome: c.status === "SUCCESSFUL" ? "ok" : "failed" }));
    if (passed !== (expected === "pass")) this.nondeterministicScenes.push(scene.sceneId);
    return {
      sceneId: scene.sceneId,
      observed: passed ? "pass" : "fail",
      repetitions: 1,
      trace,
      source: "checkly",
      checklyRunIds: [resultId],
    };
  }
}