// `verify-fix bundle` orchestrator: Checkly → files on disk.
//
//   1. check definition (config + env var NAMES)
//   2. result history → pick the failing result (or --result) and the last
//      passing result before it
//   3. per result: detail + trace assets → HAR + actions (failure point)
//   4. error group + Rocky RCA (optional: --trigger-rca)
//   5. check sources from the customer's Checkly project dir (--project)
//   6. optional determinism measurement (--measure / --measure-overlap)
//   7. manifest v3 + recordings + config, secrets stripped, written to --out
//
// Nothing here decides a verdict. It only records what Checkly saw.

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import type { ChecklyClient } from "../checkly/client.ts";
import type { AssetManifestEntry, ChecklyCheck, CheckResult, CheckResultSummary, ErrorGroup, RootCauseAnalysis } from "../checkly/types.ts";
import { isZip, openZip } from "../trace/zip.ts";
import { mergeHars, traceZipToHar, type BodyPolicy, type TraceExtract } from "../trace/trace-to-har.ts";
import { sanitizeHar } from "./sanitize.ts";
import { buildManifest, expectedReceived, findOverlappingRuns, groupErrorMatches, resultErrors, type FetchedResult } from "./manifest.ts";
import { measureDeterminism, type MeasureResult, type Runner } from "./measure.ts";
import type { ManifestV3 } from "./types.ts";

export interface BuildOptions {
  checkId: string;
  resultId?: string | null;
  outDir: string;
  projectDir?: string | null;
  measure?: number;
  measureOverlap?: number;
  targetUrl?: string;
  triggerRca?: boolean;
  bodies?: BodyPolicy;
  keepRaw?: boolean;
  historyLimit?: number;
  log?: (line: string) => void;
}

export interface BuildDeps {
  client: ChecklyClient;
  accountId: string;
  toolVersion?: string;
  now?: () => Date;
  runner?: Runner;
}

export interface BuildOutcome {
  manifest: ManifestV3;
  outDir: string;
  files: string[];
  warnings: string[];
}

const RESULT_FIELDS = ["id", "checkId", "name", "hasFailures", "hasErrors", "isDegraded", "runLocation", "startedAt", "stoppedAt", "responseTime", "attempts", "resultType", "sequenceId", "errorGroupIds"];

function sha256(buf: Buffer): string {
  return createHash("sha256").update(buf).digest("hex");
}

function isOk(r: CheckResultSummary): boolean {
  return !r.hasFailures && !r.hasErrors;
}

function findSpecFiles(root: string, testDir: string, max = 200): string[] {
  const start = resolve(root, testDir);
  if (!existsSync(start)) return [];
  const out: string[] = [];
  const walk = (dir: string, depth: number) => {
    if (out.length >= max || depth > 8) return;
    for (const name of readdirSync(dir)) {
      if (name === "node_modules" || name.startsWith(".") || name === "test-results" || name === "playwright-report") continue;
      const p = join(dir, name);
      const st = statSync(p);
      if (st.isDirectory()) walk(p, depth + 1);
      else if (/\.(spec|test)\.[cm]?[jt]sx?$/.test(name)) out.push(p);
      if (out.length >= max) return;
    }
  };
  walk(start, 0);
  return out.sort();
}

function firstExisting(dir: string, names: string[]): string | null {
  for (const n of names) if (existsSync(join(dir, n))) return join(dir, n);
  return null;
}

interface ProjectSources {
  sources: Array<{ path: string; content: string }>;
  mainSource: string | null;
  gitCommit: string | null;
  logicalId: string | null;
  repoUrl: string | null;
  /** Playwright facts read from the project's checkly.config.* (the API does not return them for PLAYWRIGHT checks) */
  playwright: { configPath: string | null; projects: string[]; tags: string[] };
  warnings: string[];
}

/** `pwProjects: ['booking']` / `pwTags: ["@smoke"]` → ["booking"] */
function stringList(source: string, key: string): string[] {
  const m = new RegExp(`${key}\\s*:\\s*\\[([^\\]]*)\\]`).exec(source);
  if (!m) return [];
  return [...m[1].matchAll(/['"\`]([^'"\`]+)['"\`]/g)].map((x) => x[1]);
}

export function collectProjectSources(check: ChecklyCheck, projectDir: string | null | undefined, failingErrors: string[]): ProjectSources {
  const warnings: string[] = [];
  const sources: Array<{ path: string; content: string }> = [];
  let mainSource: string | null = null;
  let gitCommit: string | null = null;
  let logicalId: string | null = null;
  let repoUrl: string | null = null;
  const playwright: ProjectSources["playwright"] = { configPath: null, projects: [], tags: [] };

  if (check.checkType === "BROWSER" || check.checkType === "MULTI_STEP") {
    if (typeof check.script === "string" && check.script.length) {
      const name = check.scriptPath ? basename(check.scriptPath) : "check.spec.ts";
      sources.push({ path: name, content: check.script });
      mainSource = name;
    } else {
      warnings.push("the API returned no script for this browser check");
    }
  }

  if (projectDir) {
    const root = resolve(projectDir);
    try {
      gitCommit = execFileSync("git", ["-C", root, "rev-parse", "HEAD"], { stdio: ["ignore", "pipe", "ignore"] }).toString().trim() || null;
    } catch {
      gitCommit = null;
    }
    const checklyConfig = firstExisting(root, ["checkly.config.ts", "checkly.config.mts", "checkly.config.js", "checkly.config.mjs"]);
    if (checklyConfig) {
      const content = readFileSync(checklyConfig, "utf8");
      sources.push({ path: relative(root, checklyConfig), content });
      logicalId = /logicalId\s*:\s*['"`]([^'"`]+)['"`]/.exec(content)?.[1] ?? null;
      repoUrl = /repoUrl\s*:\s*['"`]([^'"`]+)['"`]/.exec(content)?.[1] ?? null;
      playwright.configPath = /playwrightConfigPath\s*:\s*['"`]([^'"`]+)['"`]/.exec(content)?.[1] ?? null;
      playwright.projects = stringList(content, "pwProjects");
      playwright.tags = stringList(content, "pwTags");
    } else {
      warnings.push(`no checkly.config.* found in ${root}`);
    }

    if (check.checkType === "PLAYWRIGHT") {
      const configuredPath = check.playwrightConfigPath ?? playwright.configPath;
      const configured = configuredPath ? resolve(root, configuredPath) : null;
      const pwConfig =
        configured && existsSync(configured) ? configured : firstExisting(root, ["playwright.config.ts", "playwright.config.mts", "playwright.config.js", "playwright.config.mjs"]);
      if (pwConfig) {
        const content = readFileSync(pwConfig, "utf8");
        sources.push({ path: relative(root, pwConfig), content });
        const testDir = /testDir\s*:\s*['"`]([^'"`]+)['"`]/.exec(content)?.[1] ?? ".";
        for (const f of findSpecFiles(dirname(pwConfig), testDir)) {
          sources.push({ path: relative(root, f), content: readFileSync(f, "utf8") });
        }
      } else {
        warnings.push("no playwright.config.* found in the project directory; spec files were not collected");
      }
    }
  } else if (check.checkType === "PLAYWRIGHT") {
    warnings.push("Playwright check suites keep their code in a bundle Checkly does not serve back; pass --project <dir> so the spec files are copied from your repo");
  }

  // main spec: the file named in the failing error, else the only spec
  const specs = sources.filter((s) => /\.(spec|test)\.[cm]?[jt]sx?$/.test(s.path));
  if (!mainSource) {
    const errText = failingErrors.join("\n");
    const named = specs.find((s) => errText.includes(s.path) || errText.includes(basename(s.path)));
    mainSource = named?.path ?? (specs.length === 1 ? specs[0].path : specs[0]?.path ?? null);
  }
  return { sources, mainSource, gitCommit, logicalId, repoUrl, playwright, warnings };
}

async function fetchResultWithTrace(
  client: ChecklyClient,
  checkId: string,
  summary: CheckResultSummary,
  label: "failing" | "passing",
  bodies: BodyPolicy,
  assetsOut: ManifestV3["provenance"]["assets"],
  rawDir: string | null,
  log: (l: string) => void,
  toolVersion: string,
): Promise<{ fetched: FetchedResult; warnings: string[] }> {
  const warnings: string[] = [];
  let detail: CheckResult | null = null;
  try {
    detail = await client.getResult(checkId, summary.id);
  } catch (err) {
    warnings.push(`${label}: could not load result detail (${(err as Error).message})`);
  }
  let manifestEntries: AssetManifestEntry[] = [];
  try {
    const m = await client.getAssets(checkId, summary.id, "trace");
    manifestEntries = m.assets ?? [];
    if (m.truncated) warnings.push(`${label}: asset manifest truncated (${m.entriesReturned}/${m.entriesTotal})`);
  } catch (err) {
    warnings.push(`${label}: could not list assets (${(err as Error).message})`);
  }
  if (manifestEntries.length === 0) warnings.push(`${label}: no Playwright trace asset on result ${summary.id} (is trace: 'on' in playwright.config.ts?)`);

  const archiveCache = new Map<string, Buffer>();
  const extracts: TraceExtract[] = [];
  for (const asset of manifestEntries) {
    try {
      let buf: Buffer;
      if (asset.archive) {
        let archive = archiveCache.get(asset.url);
        if (!archive) {
          archive = await client.download(asset.url);
          archiveCache.set(asset.url, archive);
        }
        const entry = openZip(archive).get(asset.archive.entryName);
        if (!entry) throw new Error(`entry ${asset.archive.entryName} not in archive`);
        buf = entry();
      } else {
        buf = await client.download(asset.url);
      }
      assetsOut.push({ result: label, name: asset.name, type: asset.type, bytes: buf.length, sha256: sha256(buf) });
      if (rawDir) {
        mkdirSync(rawDir, { recursive: true });
        writeFileSync(join(rawDir, basename(asset.archive?.entryName ?? asset.name) || "trace.zip"), buf);
      }
      if (!isZip(buf)) throw new Error("asset is not a zip file");
      extracts.push(traceZipToHar(buf, { bodies, creatorVersion: toolVersion }));
      log(`[bundle] ${label}: trace ${asset.name} → ${extracts.at(-1)!.har.log.entries.length} requests, ${extracts.at(-1)!.actions.length} actions`);
    } catch (err) {
      warnings.push(`${label}: trace ${asset.name} skipped (${(err as Error).message})`);
    }
  }
  let extract: TraceExtract | null = null;
  if (extracts.length === 1) extract = extracts[0];
  else if (extracts.length > 1) {
    const withFailure = extracts.find((e) => e.failingAction) ?? extracts[0];
    extract = {
      har: mergeHars(extracts.map((e) => e.har), toolVersion),
      actions: extracts.flatMap((e) => e.actions),
      failingAction: withFailure.failingAction,
      baseURL: withFailure.baseURL ?? extracts.find((e) => e.baseURL)?.baseURL ?? null,
      browserName: withFailure.browserName,
      files: {
        network: extracts.flatMap((e) => e.files.network),
        trace: extracts.flatMap((e) => e.files.trace),
        resources: extracts.reduce((n, e) => n + e.files.resources, 0),
      },
    };
  }
  return { fetched: { summary, detail, extract }, warnings };
}

function trimmedResult(detail: CheckResult | null): Record<string, unknown> | null {
  if (!detail) return null;
  const r = detail.playwrightCheckResult ?? detail.browserCheckResult ?? detail.multiStepCheckResult ?? null;
  return {
    id: detail.id,
    runLocation: detail.runLocation,
    startedAt: detail.startedAt,
    stoppedAt: detail.stoppedAt ?? null,
    hasFailures: detail.hasFailures,
    hasErrors: detail.hasErrors,
    attempts: detail.attempts ?? null,
    resultType: detail.resultType ?? null,
    errorGroupIds: detail.errorGroupIds ?? [],
    errors: r?.errors ?? [],
    runtimeVersion: r?.runtimeVersion ?? null,
    pages: r?.pages?.map((p) => ({ url: p.url })) ?? [],
    traceSummary: r?.traceSummary ?? null,
    apiCheckResult: detail.apiCheckResult
      ? {
          request: { method: detail.apiCheckResult.request?.method, url: detail.apiCheckResult.request?.url },
          response: { status: detail.apiCheckResult.response?.status, statusText: detail.apiCheckResult.response?.statusText },
          requestError: detail.apiCheckResult.requestError ?? null,
          assertions: detail.apiCheckResult.assertions ?? [],
        }
      : null,
  };
}

/** Defense in depth: no env var VALUE may appear in any written text. */
export function assertNoSecretLeak(texts: Array<{ file: string; text: string }>, values: string[]): void {
  const needles = values.filter((v) => typeof v === "string" && v.length >= 6);
  for (const { file, text } of texts) {
    for (const v of needles) {
      if (text.includes(v)) throw new Error(`refusing to write ${file}: it contains the value of a Checkly environment variable`);
    }
  }
}

export async function buildBundle(opts: BuildOptions, deps: BuildDeps): Promise<BuildOutcome> {
  const log = opts.log ?? (() => {});
  const client = deps.client;
  const toolVersion = deps.toolVersion ?? "0.1.0";
  const now = (deps.now ?? (() => new Date()))().toISOString();
  const bodies: BodyPolicy = opts.bodies ?? "api";
  const warnings: string[] = [];
  const outDir = resolve(opts.outDir);
  const rawDir = opts.keepRaw ? join(outDir, "raw") : null;

  // 1. check
  const check = await client.getCheck(opts.checkId);
  log(`[bundle] check ${check.id} "${check.name}" type=${check.checkType} locations=${(check.locations ?? []).join(",")} runParallel=${Boolean(check.runParallel)}`);
  const secretValues = (check.environmentVariables ?? []).map((v) => v.value).filter((v): v is string => typeof v === "string");

  // 2. history
  const page = await client.listResults(check.id, { limit: opts.historyLimit ?? 100, resultType: "FINAL", fields: RESULT_FIELDS });
  const history = [...(page.entries ?? [])].sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  log(`[bundle] ${history.length} recent FINAL results (${history.filter(isOk).length} passed, ${history.filter((r) => !isOk(r)).length} failed)`);

  let failingSummary: CheckResultSummary | null = null;
  if (opts.resultId) {
    failingSummary = history.find((r) => r.id === opts.resultId) ?? null;
    if (!failingSummary) {
      const d = await client.getResult(check.id, opts.resultId);
      failingSummary = d;
    }
    if (isOk(failingSummary)) warnings.push(`--result ${opts.resultId} is a passing result; it is used as the incident anyway because you asked for it`);
  } else {
    failingSummary = history.find((r) => !isOk(r)) ?? null;
  }
  // The passing reference, best first:
  //   a) a run from another location that overlapped the failing run and
  //      passed — same code, same minute, the closest control there is;
  //   b) the last passing run before the failing one;
  //   c) any passing run.
  const overlapping = findOverlappingRuns(failingSummary, history);
  const sibling = overlapping.find((o) => o.passed && o.runLocation !== failingSummary?.runLocation);
  const passingSummary =
    (sibling ? history.find((r) => r.id === sibling.runId) : null) ??
    history.find((r) => isOk(r) && (!failingSummary || r.startedAt < failingSummary!.startedAt) && r.id !== failingSummary?.id) ??
    history.find((r) => isOk(r) && r.id !== failingSummary?.id) ??
    null;
  log(`[bundle] failing=${failingSummary?.id ?? "none"} passing=${passingSummary?.id ?? "none"}${sibling ? ` (overlapping run from ${sibling.runLocation}, started ${(sibling.startDeltaMs / 1000).toFixed(1)} s before)` : ""}`);
  if (overlapping.length) log(`[bundle] ${overlapping.length} run(s) overlapped the failing run in time: ${overlapping.map((o) => `${o.runId}@${o.runLocation} ${o.passed ? "passed" : "failed"}`).join(", ")}`);

  // 3. results + traces
  const assets: ManifestV3["provenance"]["assets"] = [];
  let failing: FetchedResult | null = null;
  let passing: FetchedResult | null = null;
  if (failingSummary) {
    const r = await fetchResultWithTrace(client, check.id, failingSummary, "failing", bodies, assets, rawDir ? join(rawDir, "failing") : null, log, toolVersion);
    failing = r.fetched;
    warnings.push(...r.warnings);
  }
  if (passingSummary) {
    const r = await fetchResultWithTrace(client, check.id, passingSummary, "passing", bodies, assets, rawDir ? join(rawDir, "passing") : null, log, toolVersion);
    passing = r.fetched;
    warnings.push(...r.warnings);
  }

  // 4. error group + RCA
  let errorGroup: ErrorGroup | null = null;
  let rca: RootCauseAnalysis | null = null;
  let replacedRca: RootCauseAnalysis | null = null;
  if (failing) {
    const ids = failing.summary.errorGroupIds ?? failing.detail?.errorGroupIds ?? [];
    try {
      if (ids.length) errorGroup = await client.getErrorGroup(ids[0]);
      else {
        const groups = await client.errorGroupsForCheck(check.id);
        errorGroup = groups.sort((a, b) => b.lastSeen.localeCompare(a.lastSeen))[0] ?? null;
        if (errorGroup) warnings.push(`failing result carries no errorGroupIds; using the check's most recent error group ${errorGroup.id}`);
      }
    } catch (err) {
      warnings.push(`error group lookup failed (${(err as Error).message})`);
    }
    if (errorGroup) {
      const analyses = [...(errorGroup.rootCauseAnalyses ?? [])].sort((a, b) => b.created_at.localeCompare(a.created_at));
      rca = analyses[0] ?? null;
      // Rocky analyzes only the first failure of a group. When the captured
      // run's "Received" differs from the group's first failure, the existing
      // RCA is about another incident (seen live: a UI rename landed in the
      // 401 group). Then --trigger-rca asks for a fresh analysis.
      const matches = groupErrorMatches(errorGroup.cleanedErrorMessage, resultErrors(failing.detail));
      const stale = rca !== null && matches === false;
      if (stale) log(`[bundle] RCA ${rca!.id} predates a different failure in this group (group first received ${expectedReceived(errorGroup.cleanedErrorMessage).received}, this run received ${expectedReceived(resultErrors(failing.detail).find((e) => /Received/i.test(e)) ?? null).received})`);
      if ((!rca || stale) && opts.triggerRca) {
        try {
          log(`[bundle] triggering Rocky RCA for error group ${errorGroup.id} …`);
          const { id } = await client.triggerRca(errorGroup.id);
          const fresh = await client.waitForRca(id);
          if (fresh) {
            if (rca) replacedRca = rca;
            rca = fresh;
          } else warnings.push(`RCA ${id} did not finish within the wait window; re-run bundle later to include it`);
        } catch (err) {
          warnings.push(`RCA trigger failed (${(err as Error).message})`);
        }
      } else if (!rca) {
        warnings.push("no Rocky RCA on this error group yet (enable Auto Analysis in Checkly, or pass --trigger-rca)");
      } else if (stale) {
        warnings.push(`RCA ${rca.id} describes the group's first failure, not this run's — pass --trigger-rca to request a fresh analysis`);
      }
    }
    log(`[bundle] errorGroup=${errorGroup?.id ?? "none"} rca=${rca?.id ?? "none"}${rca ? ` (${rca.analysis.classification})` : ""}${replacedRca ? ` replaces ${replacedRca.id} (${replacedRca.analysis.classification})` : ""}`);
  }

  // 5. sources
  const proj = collectProjectSources(check, opts.projectDir, failing?.detail ? (failing.detail.playwrightCheckResult ?? failing.detail.browserCheckResult ?? failing.detail.multiStepCheckResult)?.errors ?? [] : []);
  warnings.push(...proj.warnings);
  log(`[bundle] sources: ${proj.sources.map((s) => s.path).join(", ") || "none"}; main=${proj.mainSource ?? "none"}`);

  // 6. measurement
  let measurement: MeasureResult | null = null;
  if ((opts.measure ?? 0) > 0 || (opts.measureOverlap ?? 0) > 0) {
    if (!opts.projectDir) warnings.push("--measure needs --project <checkly project dir>; skipped");
    else {
      measurement = await measureDeterminism({
        projectDir: opts.projectDir,
        sequentialRuns: opts.measure ?? 0,
        overlapPairs: opts.measureOverlap ?? 0,
        targetUrl: opts.targetUrl,
        runner: deps.runner,
        log,
      });
    }
  }

  // 7. manifest + files
  const recordings = {
    failing: failing?.extract ? "recordings/failing.har" : null,
    passing: passing?.extract ? "recordings/passing.har" : null,
    bodies,
  };
  const manifest = buildManifest({
    check,
    failing,
    passing,
    replacedRca,
    errorGroup,
    rca,
    history,
    sources: proj.sources,
    mainSource: proj.mainSource,
    project: { dir: opts.projectDir ?? null, gitCommit: proj.gitCommit, logicalId: proj.logicalId, repoUrl: proj.repoUrl, playwright: proj.playwright },
    measurement,
    recordings,
    assets,
    apiCalls: client.calls.map((c) => ({ ...c })),
    accountId: deps.accountId,
    now,
    toolVersion,
  });
  manifest.notes.push(...warnings.map((w) => `warning: ${w}`));

  const files: Array<{ file: string; text: string }> = [];
  files.push({ file: "manifest.json", text: JSON.stringify(manifest, null, 2) + "\n" });
  files.push({ file: "check.config.json", text: JSON.stringify({ check: manifest.check, config: manifest.config, target: manifest.target }, null, 2) + "\n" });
  for (const s of proj.sources) files.push({ file: join("check", s.path), text: s.content });
  if (failing?.extract) files.push({ file: "recordings/failing.har", text: JSON.stringify(sanitizeHar(failing.extract.har), null, 1) + "\n" });
  if (passing?.extract) files.push({ file: "recordings/passing.har", text: JSON.stringify(sanitizeHar(passing.extract.har), null, 1) + "\n" });
  if (failing?.extract) files.push({ file: "recordings/failing.actions.json", text: JSON.stringify(failing.extract.actions.map(({ params: _p, ...a }) => a), null, 1) + "\n" });
  if (passing?.extract) files.push({ file: "recordings/passing.actions.json", text: JSON.stringify(passing.extract.actions.map(({ params: _p, ...a }) => a), null, 1) + "\n" });
  if (failing) files.push({ file: "results/failing.json", text: JSON.stringify(trimmedResult(failing.detail) ?? failing.summary, null, 2) + "\n" });
  if (passing) files.push({ file: "results/passing.json", text: JSON.stringify(trimmedResult(passing.detail) ?? passing.summary, null, 2) + "\n" });
  if (rca || errorGroup) files.push({ file: "rca.json", text: JSON.stringify({ errorGroup: manifest.errorGroup, rca, ...(replacedRca ? { replacedRca } : {}) }, null, 2) + "\n" });
  // the result window the decisions were made from (ids + timestamps only), so
  // the overlap evidence and the pass rate can be re-checked offline
  files.push({
    file: "results/history.json",
    text:
      JSON.stringify(
        history.map((r) => ({
          id: r.id,
          runLocation: r.runLocation,
          startedAt: r.startedAt,
          stoppedAt: r.stoppedAt ?? null,
          hasFailures: r.hasFailures,
          hasErrors: r.hasErrors,
          resultType: r.resultType ?? null,
          attempts: r.attempts ?? null,
          errorGroupIds: r.errorGroupIds ?? [],
        })),
        null,
        1,
      ) + "\n",
  });
  files.push({ file: ".gitignore", text: "raw/\n" });
  files.push({ file: "README.md", text: bundleReadme(manifest) });

  assertNoSecretLeak(files, secretValues);

  mkdirSync(outDir, { recursive: true });
  for (const f of files) {
    const p = isAbsolute(f.file) ? f.file : join(outDir, f.file);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, f.text);
  }
  log(`[bundle] wrote ${files.length} files to ${outDir}`);
  return { manifest, outDir, files: files.map((f) => f.file), warnings };
}

function bundleReadme(m: ManifestV3): string {
  const lines = [
    `# Bundle: ${m.incidentId}`,
    "",
    `Generated by \`${m.generatedBy}\` at ${m.generatedAt}. Status: **${m.incident.status}**.`,
    "",
    `- Check: **${m.check.name}** (${m.check.checkType}, id \`${m.check.id}\`)`,
    `- Config: every ${m.config.frequencyMinutes ?? "?"} min from ${m.config.locations.join(", ") || "no locations"}, runParallel=${m.config.runParallel}, env vars: ${m.config.environmentVariables.map((v) => v.key).join(", ") || "none"} (names only)`,
    `- Failing result: ${m.results.failing ? `\`${m.results.failing.id}\` (${m.results.failing.runLocation}, ${m.results.failing.startedAt})` : "none yet"}`,
    `- Passing result: ${m.results.passing ? `\`${m.results.passing.id}\` (${m.results.passing.runLocation}, ${m.results.passing.startedAt})` : "none"}`,
    `- RCA: ${m.rca ? `${m.rca.classification}${m.rca.repairRecommendation ? ` / ${m.rca.repairRecommendation}` : ""} — ${m.rca.rootCause.slice(0, 200)}` : "none"}`,
    `- Rocky guardrails: intent ${m.config.repair.intent ? `"${m.config.repair.intent.goal}" (${m.config.repair.intent.mustPreserve.length} mustPreserve, ${m.config.repair.intent.requiredOutcomes.length} requiredOutcomes)` : "none"}; automatic repair ${m.config.repair.aiAutoRepairEnabled === null ? "inherits the account default" : m.config.repair.aiAutoRepairEnabled ? "ON for this check" : "OFF for this check"}`,
    `- Reproduction mode: **${m.reproduction.mode}** (decided by ${m.reproduction.decidedBy}) — ${m.reproduction.reason}`,
    m.failurePoint?.request
      ? `- Failure point: ${m.failurePoint.request.method} ${m.failurePoint.request.path} → ${m.failurePoint.request.status}${m.failurePoint.request.passingStatus !== null ? ` (passing run: ${m.failurePoint.request.passingStatus})` : ""}`
      : "- Failure point: not identified",
    m.failurePoint?.action ? `- Failing step: \`${m.failurePoint.action.title}\` — ${m.failurePoint.action.error.split("\n")[0]}` : "",
    m.failurePoint?.assertion
      ? `- Failing assertion: ${m.failurePoint.assertion.file ?? "spec"}:${m.failurePoint.assertion.line}${m.failurePoint.assertion.assertionId ? ` (${m.failurePoint.assertion.assertionId})` : ""}`
      : "",
    "",
    "## Scenes",
    "",
    "| scene | type | mode | must | provenance | environment |",
    "|---|---|---|---|---|---|",
    ...m.scenes.map(
      (s) =>
        `| ${s.sceneId} | ${s.type} | \`${s.mode}\`${s.alternativeMode ? ` (alt \`${s.alternativeMode}\`)` : ""} | ${s.verdict.mustFail ? "fail" : "pass"} | ${s.verdict.provenance.kind === "recorded" ? `recorded:${s.verdict.provenance.runId}` : `code:${s.verdict.provenance.assertionId}`} | ${s.environment} |`,
    ),
    "",
    "## Determinism",
    "",
    `- History (${m.determinism.history.finalRuns} final runs): pass rate ${m.determinism.history.passRate ?? "n/a"}; by location: ${Object.entries(m.determinism.history.byLocation).map(([l, v]) => `${l} ${v.passed}/${v.runs}`).join(", ") || "n/a"}`,
    `- Measured sequential: ${m.determinism.sequential ? `${m.determinism.sequential.passed}/${m.determinism.sequential.runs}` : "not measured"}`,
    `- Measured overlap: ${m.determinism.overlap ? `${m.determinism.overlap.pairsWithFailure}/${m.determinism.overlap.pairs} pairs failed` : "not measured"}`,
    "",
    "## Notes",
    "",
    ...m.notes.map((n) => `- ${n}`),
    "",
  ];
  return lines.filter((l) => l !== null).join("\n");
}
