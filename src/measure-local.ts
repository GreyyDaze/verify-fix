// Local determinism measurement for an existing v3 bundle.
//
// This runs the ORIGINAL captured check through the same Playwright + scene
// proxy path used by verification. For a concurrency/API incident, a healthy
// one-at-a-time run is proved by the recorded request's passing status and an
// overlap reproduction is proved by its failing status. This keeps an older
// overlap bundle measurable even when an unrelated UI locator later drifted.
// For a persistent live incident (for example locator drift), the original
// check itself must fail on every run.

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ManifestV3 } from "./bundle/types.ts";
import type { Bundle, RunContext, Scene } from "./types.ts";
import { SceneExecutor } from "./executor/scene.ts";
import type { ProxyHit } from "./scene/proxy.ts";
import { parseMode } from "./scene/modes.ts";
import { bundleReadme } from "./bundle/build.ts";

interface MeasurementRecord {
  checkPassed: boolean;
  hits: ProxyHit[];
}

export interface LocalMeasureOptions {
  bundle: Bundle;
  target: string;
  env?: Record<string, string>;
  environmentName?: string;
  projectDir: string;
  runs?: number;
  verbose?: boolean;
  browserExecutablePath?: string;
}

export interface LocalMeasureResult {
  sequential: { runs: number; passed: number; passRate: number; sessions: string[] };
  overlap: { pairs: number; pairsWithFailure: number; failRate: number; sessions: string[] } | null;
  reproductionMode: string;
}

function rate(n: number, total: number): number {
  return total ? Number((n / total).toFixed(3)) : 0;
}

function matchingHits(record: MeasurementRecord, req: NonNullable<ManifestV3["failurePoint"]>["request"]): ProxyHit[] {
  if (!req) return [];
  return record.hits.filter((h) => h.method === req.method && h.path === req.path);
}

export async function measureLocalDeterminism(opts: LocalMeasureOptions): Promise<LocalMeasureResult> {
  const { bundle } = opts;
  if (bundle.schemaVersion !== "v3") throw new Error("local measurement writes only generated v3 bundles");
  if (!bundle.playwright) throw new Error("local measurement currently requires a Playwright bundle");
  const manifestPath = join(bundle.dir, "manifest.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as ManifestV3;
  const reproduction = bundle.scenes.find((s) => s.type === "REPRODUCTION");
  if (!reproduction) throw new Error("bundle has no REPRODUCTION scene to measure");
  const parsed = parseMode(reproduction.mode);
  if (parsed.kind !== "live" && parsed.kind !== "live-concurrent") throw new Error(`local measurement does not support reproduction mode ${reproduction.mode}`);
  const runs = opts.runs ?? 20;
  if (!Number.isInteger(runs) || runs < 1) throw new Error("--runs must be a positive integer");

  const records: MeasurementRecord[] = [];
  const executor = new SceneExecutor({
    target: opts.target,
    env: opts.env,
    environmentName: opts.environmentName,
    projectDir: opts.projectDir,
    browserExecutablePath: opts.browserExecutablePath,
    maxRunsPerScene: runs,
    verbose: opts.verbose,
    onRepetition: (r) => records.push({ checkPassed: r.checkPassed, hits: r.hits }),
  });
  const ctx: RunContext = { config: bundle.config, files: bundle.files };
  const measuredScene = (base: Scene, sceneId: string, mode: string): Scene => ({
    ...base,
    sceneId,
    mode,
    experiments: [{ ...base.experiments[0], repetitions: runs }],
  });

  try {
    const sequentialScene = measuredScene(reproduction, "measure-sequential", "live");
    const seqStart = records.length;
    await executor.runScene(bundle, bundle.checkSource, sequentialScene, ctx);
    const sequentialRecords = records.slice(seqStart);
    if (sequentialRecords.length !== runs) throw new Error(`sequential measurement completed ${sequentialRecords.length}/${runs} runs`);

    const request = manifest.failurePoint?.request ?? null;
    const sequentialPassed = sequentialRecords.filter((r) => {
      if (!request) return r.checkPassed;
      const hits = matchingHits(r, request);
      return hits.length > 0 && hits.every((h) => h.status === request.passingStatus);
    }).length;

    let overlap: LocalMeasureResult["overlap"] = null;
    if (parsed.kind === "live-concurrent") {
      const overlapStart = records.length;
      await executor.runScene(bundle, bundle.checkSource, measuredScene(reproduction, "measure-reproduction", reproduction.mode), ctx);
      const overlapRecords = records.slice(overlapStart);
      if (overlapRecords.length !== runs) throw new Error(`overlap measurement completed ${overlapRecords.length}/${runs} pairs`);
      const pairsWithFailure = overlapRecords.filter((r) => {
        if (!request) return !r.checkPassed;
        return matchingHits(r, request).some((h) => h.status === request.status);
      }).length;
      overlap = { pairs: runs, pairsWithFailure, failRate: rate(pairsWithFailure, runs), sessions: [] };
    }

    const sequential = { runs, passed: sequentialPassed, passRate: rate(sequentialPassed, runs), sessions: [] };
    manifest.determinism.measured = true;
    manifest.determinism.method = "local-runner";
    manifest.determinism.sequential = sequential;
    manifest.determinism.overlap = overlap;
    manifest.determinism.lastVerifiedAt = new Date().toISOString();
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n", "utf8");
    writeFileSync(join(bundle.dir, "README.md"), bundleReadme(manifest), "utf8");
    return { sequential, overlap, reproductionMode: reproduction.mode };
  } finally {
    await executor.close();
  }
}
