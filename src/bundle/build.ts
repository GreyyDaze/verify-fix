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
import { closeSync, constants, existsSync, fstatSync, ftruncateSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import type { ChecklyClient } from "../checkly/client.ts";
import type { AssetManifestEntry, ChecklyCheck, CheckResult, CheckResultSummary, ErrorGroup, RootCauseAnalysis } from "../checkly/types.ts";
import { ASSET_ZIP_BOUNDS, isZip, openZipBounded } from "../trace/zip.ts";
import { mergeHars, traceZipToHar, type BodyPolicy, type TraceExtract } from "../trace/trace-to-har.ts";
import { sanitizeHar } from "./sanitize.ts";
import { buildManifest, expectedReceived, findOverlappingRuns, groupErrorMatches, rcaFit, rcaMentionsReceived, resultErrors, runOutcome, type FetchedResult } from "./manifest.ts";
import { measureDeterminism, type MeasureResult, type Runner } from "./measure.ts";
import type { ManifestV3 } from "./types.ts";
import { apiRecordingFromResult, setupProvenance } from "../api/recording.ts";
import { parseApiCheckProject } from "../api/model.ts";
import { buildMultiStepRecording, readMultiStepAssets, MAX_ASSET_FILE_BYTES, MAX_ASSET_ZIP_BYTES, type MultiStepAssetTexts, type MultiStepRecordingDraft } from "../multistep/capture.ts";
import { finalizeRemoteMultiStepRecording } from "../multistep/binding.ts";
import type { MultiStepCapture } from "../multistep/normalize.ts";
import type { MultiStepRecording } from "../multistep/capture.ts";
import { constrainMultiStepManifest, multiStepRunMetadata } from "../multistep/bundle-evidence.ts";
import { multistepProblemCategory } from "../multistep/sanitize.ts";
import { parseMultiStepConstruct, parseMultiStepProject } from "../multistep/source.ts";
import { deployedProblem } from "../multistep/identity.ts";
import { multiStepSourceClosureProblem, multiStepSourcePath, MULTISTEP_MAX_SOURCE_BYTES, MULTISTEP_MAX_SOURCE_FILE_BYTES, MULTISTEP_MAX_SOURCE_FILES } from "../multistep/files.ts";

export interface BuildOptions {
  checkId: string;
  resultId?: string | null;
  outDir: string;
  projectDir?: string | null;
  /** Directory of assets already downloaded with `checkly assets download` (MULTI_STEP only). */
  assetsDir?: string | null;
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

function findApiCheckFiles(root: string, max = 100): string[] {
  const out: string[] = [];
  const walk = (dir: string, depth: number) => {
    if (out.length >= max || depth > 8) return;
    for (const name of readdirSync(dir)) {
      if (["node_modules", ".git", ".next", "dist", "build", "test-results", "playwright-report"].includes(name)) continue;
      const file = join(dir, name);
      const stat = lstatSync(file);
      if (stat.isSymbolicLink()) continue;
      if (stat.isDirectory()) walk(file, depth + 1);
      else if (/\.check\.[cm]?[jt]sx?$/.test(name)) out.push(file);
      if (out.length >= max) return;
    }
  };
  walk(root, 0);
  return out.sort();
}

function relativeModule(root: string, from: string, specifier: string): string | null {
  const base = resolve(dirname(from), specifier);
  const candidates = [base, `${base}.ts`, `${base}.tsx`, `${base}.js`, `${base}.mjs`, `${base}.cjs`, join(base, "index.ts"), join(base, "index.tsx"), join(base, "index.js")];
  const file = candidates.find((candidate) => existsSync(candidate) && statSync(candidate).isFile()) ?? null;
  return file && !relative(root, file).startsWith("..") ? file : null;
}

function collectModuleClosure(root: string, initial: string[], sources: Array<{ path: string; content: string }>): void {
  const seen = new Set(sources.map((source) => source.path.replace(/\\/g, "/")));
  const queue = [...initial];
  while (queue.length) {
    const file = queue.shift()!;
    const rel = relative(root, file).replace(/\\/g, "/");
    if (seen.has(rel)) continue;
    const content = readFileSync(file, "utf8");
    sources.push({ path: rel, content });
    seen.add(rel);
    for (const match of content.matchAll(/(?:import|export)\s+(?:[^'";]+?\s+from\s+)?['"](\.[^'"]+)['"]/g)) {
      const imported = relativeModule(root, file, match[1]);
      if (imported) queue.push(imported);
    }
  }
}

function boundedMultiStepSource(root: string, file: string): { path: string; content: string } {
  const rel = relative(root, file).replaceAll("\\", "/");
  if (!multiStepSourcePath(rel) || !realpathSync(file).startsWith(`${realpathSync(root)}/`)) {
    throw new Error("MULTISTEP_SOURCE_PATH_UNSAFE");
  }
  const stat = lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("MULTISTEP_SOURCE_PATH_UNSAFE");
  if (stat.size > MULTISTEP_MAX_SOURCE_FILE_BYTES) throw new Error("MULTISTEP_SOURCE_CLOSURE_BOUND");
  const fd = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const opened = fstatSync(fd);
    if (!opened.isFile() || opened.size > MULTISTEP_MAX_SOURCE_FILE_BYTES) throw new Error("MULTISTEP_SOURCE_CLOSURE_BOUND");
    const chunks: Buffer[] = [];
    let size = 0;
    while (size <= MULTISTEP_MAX_SOURCE_FILE_BYTES) {
      const buffer = Buffer.allocUnsafe(Math.min(64 * 1024, MULTISTEP_MAX_SOURCE_FILE_BYTES + 1 - size));
      const n = readSync(fd, buffer, 0, buffer.length, null);
      if (!n) return { path: rel, content: Buffer.concat(chunks, size).toString("utf8") };
      size += n;
      if (size > MULTISTEP_MAX_SOURCE_FILE_BYTES) break;
      chunks.push(buffer.subarray(0, n));
    }
    throw new Error("MULTISTEP_SOURCE_CLOSURE_BOUND");
  } finally { closeSync(fd); }
}

function collectMultiStepClosure(root: string, initial: string[], sources: Array<{ path: string; content: string }>): void {
  const seen = new Set(sources.map((item) => item.path));
  const queue = [...initial];
  let bytes = sources.reduce((n, item) => n + Buffer.byteLength(item.content, "utf8"), 0);
  while (queue.length) {
    const file = queue.shift()!;
    const source = boundedMultiStepSource(root, file);
    if (seen.has(source.path)) continue;
    if (seen.size >= MULTISTEP_MAX_SOURCE_FILES || (bytes += Buffer.byteLength(source.content, "utf8")) > MULTISTEP_MAX_SOURCE_BYTES) {
      throw new Error("MULTISTEP_SOURCE_CLOSURE_BOUND");
    }
    seen.add(source.path);
    sources.push(source);
    for (const match of source.content.matchAll(/(?:import|export)\s+(?:[^'";]+?\s+from\s+)?['"](\.[^'"]+)['"]/g)) {
      const imported = relativeModule(root, file, match[1]);
      if (imported) queue.push(imported);
    }
  }
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
      if (check.checkType === "MULTI_STEP" && (!multiStepSourcePath(name)
        || Buffer.byteLength(check.script, "utf8") > MULTISTEP_MAX_SOURCE_FILE_BYTES)) {
        warnings.push("MULTISTEP_SOURCE_CLOSURE_BOUND");
      } else {
        sources.push({ path: name, content: check.script });
        mainSource = name;
      }
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
      const content = check.checkType === "MULTI_STEP"
        ? boundedMultiStepSource(root, checklyConfig).content : readFileSync(checklyConfig, "utf8");
      sources.push({ path: relative(root, checklyConfig), content });
      logicalId = /logicalId\s*:\s*['"`]([^'"`]+)['"`]/.exec(content)?.[1] ?? null;
      repoUrl = /repoUrl\s*:\s*['"`]([^'"`]+)['"`]/.exec(content)?.[1] ?? null;
      playwright.configPath = /playwrightConfigPath\s*:\s*['"`]([^'"`]+)['"`]/.exec(content)?.[1] ?? null;
      playwright.projects = stringList(content, "pwProjects");
      playwright.tags = stringList(content, "pwTags");
    } else {
      warnings.push(`no checkly.config.* found in ${root}`);
    }

    if (check.checkType === "MULTI_STEP") {
      // The Checkly API returns the DEPLOYED script (as a basename), whereas
      // the construct names its actual project-relative entrypoint. Bind those
      // two identities before saving: no same-basename fallback at verify time.
      try {
        const candidates = findApiCheckFiles(root, MULTISTEP_MAX_SOURCE_FILES + 1);
        if (candidates.length > MULTISTEP_MAX_SOURCE_FILES) throw new Error("MULTISTEP_SOURCE_CLOSURE_BOUND");
        for (const file of candidates) {
          const content = boundedMultiStepSource(root, file).content;
          if (content.includes("new MultiStepCheck(")) collectMultiStepClosure(root, [file], sources);
        }
      } catch (error) { warnings.push((error as Error).message.startsWith("MULTISTEP_")
        ? (error as Error).message : "MULTISTEP_SOURCE_PATH_UNSAFE"); }
      const construct = parseMultiStepConstruct(new Map(sources.map((item) => [item.path, item.content])));
      if (construct?.model.errors.length) warnings.push("MULTISTEP_CONSTRUCT_UNRESOLVED");
      else if (construct && (
        JSON.stringify(construct.model.locations) !== JSON.stringify(check.locations ?? [])
        || (typeof check.runParallel === "boolean" && construct.model.runParallel !== check.runParallel)
        || (typeof check.activated === "boolean" && construct.model.activated !== check.activated)
        || (typeof check.muted === "boolean" && construct.model.muted !== check.muted)
        || (typeof check.frequency === "number" && construct.model.frequencyMinutes !== check.frequency)
      )) warnings.push("MULTISTEP_DEPLOYED_CONFIG_MISMATCH");
      const entrypoint = construct?.model.entrypoint ?? null;
      if (entrypoint) {
        const onDisk = resolve(root, entrypoint);
        if (relative(root, onDisk).startsWith("..") || isAbsolute(relative(root, onDisk))) {
          warnings.push("MULTISTEP_ENTRYPOINT_UNSAFE");
        } else if (existsSync(onDisk)) {
          try { collectMultiStepClosure(root, [onDisk], sources); }
          catch (error) { warnings.push((error as Error).message.startsWith("MULTISTEP_")
            ? (error as Error).message : "MULTISTEP_SOURCE_PATH_UNSAFE"); }
          const deployed = sources.find((item) => item.path === mainSource);
          const project = sources.find((item) => item.path === entrypoint);
          if (deployed && project && deployed.content !== project.content) warnings.push("MULTISTEP_SOURCE_PROJECT_MISMATCH");
          if (deployed && project && deployed !== project) {
            // NEVER overwrite the construct's entrypoint with a different
            // deployed script: the disagreement is an admission failure, not
            // a way to make a source hash match after the fact.
            sources.splice(sources.indexOf(deployed), 1);
          }
          if (project) mainSource = entrypoint;
        } else {
          warnings.push("MULTISTEP_ENTRYPOINT_MISSING");
        }
      } else warnings.push("MULTISTEP_CONSTRUCT_UNRESOLVED");
      const sourceMap = new Map(sources.map((source) => [source.path.replaceAll("\\", "/"), source.content]));
      const closureProblem = multiStepSourceClosureProblem(sourceMap);
      if (closureProblem) warnings.push(closureProblem);
      const model = mainSource && !closureProblem ? parseMultiStepProject(sourceMap, mainSource) : null;
      if (model?.errors.length) warnings.push("MULTISTEP_SOURCE_UNPROVEN");
      // The project config describes the *other* Playwright check too. The
      // incident logical ID belongs to the executed Multistep construct.
      logicalId = model?.construct?.logicalId ?? null;
      const deployed = deployedProblem(check, model,
        mainSource ? sourceMap.get(mainSource) ?? null : null);
      if (deployed.problem) {
        warnings.push(deployed.problem);
        // Field names only — never values or raw provider text.
        if (deployed.fields.length) warnings.push(`deployed config mismatch field: ${[...new Set(deployed.fields)].join(", ")}`);
      }
    }

    if (check.checkType === "API") {
      const candidates = findApiCheckFiles(root);
      const selected = candidates.find((file) => {
        const content = readFileSync(file, "utf8");
        return new RegExp(`name\\s*:\\s*['\"]${check.name.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\$&")}['\"]`).test(content);
      }) ?? (candidates.length === 1 ? candidates[0] : null);
      if (selected) {
        collectModuleClosure(root, [selected], sources);
        mainSource = relative(root, selected).replace(/\\/g, "/");
        const fileMap = new Map(sources.map((source) => [source.path.replace(/\\/g, "/"), source.content]));
        const model = parseApiCheckProject(mainSource, fileMap);
        if (model?.setupFile) {
          const setup = resolve(root, model.setupFile);
          if (existsSync(setup)) collectModuleClosure(root, [setup], sources);
          else warnings.push(`API setup entrypoint ${model.setupFile} was not found`);
        }
        if (model?.teardownFile) {
          const teardown = resolve(root, model.teardownFile);
          if (existsSync(teardown)) collectModuleClosure(root, [teardown], sources);
          else warnings.push(`API teardown entrypoint ${model.teardownFile} was not found`);
        }
      } else {
        warnings.push(`no ApiCheck source matching ${check.name} was found in ${root}`);
      }
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

const MULTISTEP_ASSET_NAMES = ["test-results.json", "check-run-data.json", "logs.txt"];

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
  secretValues: string[],
  assetKind: "trace" | "multistep" = "trace",
  localAssets: MultiStepAssetTexts | null = null,
): Promise<{ fetched: FetchedResult; warnings: string[] }> {
  const warnings: string[] = [];
  let detail: CheckResult | null = null;
  try {
    detail = await client.getResult(checkId, summary.id);
  } catch (err) {
    warnings.push(`${label}: could not load result detail (${(err as Error).message})`);
  }
  const apiRecording = detail && assetKind !== "multistep" ? apiRecordingFromResult(checkId, detail, secretValues) : null;

  if (assetKind === "multistep") {
    // Structured capture: normalize the downloaded assets (or fetch them
    // through the API when no --assets dir was given). Raw bytes are hashed
    // for provenance and never written to the bundle.
    const texts: MultiStepAssetTexts = { testResults: null, checkRunData: null, logs: null, found: [], missing: [] };
    if (localAssets) {
      Object.assign(texts, localAssets);
      // Hash-only provenance for locally supplied assets: every raw byte
      // hashed BEFORE parsing, recorded in provenance, never written.
      for (const [name, meta] of Object.entries(localAssets.hashes ?? {})) {
        assetsOut.push({ result: label, name, type: "local-asset", bytes: meta.bytes, sha256: meta.sha256 });
      }
      if (localAssets.invalid) warnings.push(`${label}: local assets invalid (${localAssets.invalid}) — recorded as UNCERTAIN evidence, never a fallback`);
      log(`[bundle] ${label}: using local --assets (${texts.found.join(", ") || "no files"})`);
    } else {
      let entries: AssetManifestEntry[] = [];
      let invalid: string | null = null;
      try {
        const m = await client.getAssets(checkId, summary.id);
        if (!Array.isArray(m.assets)) invalid = "MULTISTEP_ASSET_MANIFEST_INVALID";
        else entries = m.assets;
        if (m.truncated) invalid = "MULTISTEP_ASSET_MANIFEST_TRUNCATED";
      } catch {
        invalid = "MULTISTEP_ASSET_MANIFEST_UNAVAILABLE";
      }
      const byName = new Map<string, string>();
      const archiveCache = new Map<string, ReturnType<typeof openZipBounded>>();
      let totalDecoded = 0;
      let totalDownloaded = 0;
      if (entries.length > ASSET_ZIP_BOUNDS.maxEntries) invalid = "MULTISTEP_ASSET_COUNT_EXCEEDED";
      for (const asset of invalid ? [] : entries) {
        // An API manifest is untrusted JSON, even when the HTTP status is 2xx.
        // Reject malformed accepted descriptors as a fixed evidence category
        // instead of throwing while inspecting a path before the ZIP bounds.
        if (!asset || typeof asset !== "object" || typeof asset.name !== "string" || typeof asset.url !== "string"
          || (asset.archive != null && (!asset.archive || typeof asset.archive !== "object" || typeof asset.archive.entryName !== "string"))) {
          invalid = "MULTISTEP_ASSET_MANIFEST_INVALID";
          break;
        }
        // Ignore unrelated screenshots/attachments entirely. An accepted
        // name is fixed and cannot carry a secret path segment.
        const archived = asset.archive?.entryName.split("/").pop() ?? "";
        const name = MULTISTEP_ASSET_NAMES.includes(archived) ? archived : asset.name;
        if (!MULTISTEP_ASSET_NAMES.includes(name)) continue;
        if (byName.has(name)) { invalid = "MULTISTEP_DUPLICATE_ASSET"; break; }
        // Only result-scoped report/file descriptors can authorize evidence.
        // The hash includes the exact signed manifest URL, but no URL or
        // descriptor is ever written to the bundle.
        let remoteUrl: URL;
        try { remoteUrl = new URL(asset.url); }
        catch { invalid = "MULTISTEP_ASSET_MANIFEST_INVALID"; break; }
        // Verified Checkly 9.5.0 manifest shape (official API reference and
        // the CLI's own asset-manifests types): `source` is a result-scope
        // OBJECT, not a string, and `contentType` is an OPTIONAL free-form
        // string — the API documents no fixed value for archive entries (the
        // CLI labels only its own collapsed zip download `application/zip`).
        // Archive zip-ness is therefore enforced on the DOWNLOADED BYTES by
        // the bounded ZIP reader below, never by a metadata equality.
        const source = asset.source;
        const sourceRecord = source && typeof source === "object" && !Array.isArray(source) ? source as unknown as Record<string, unknown> : null;
        const sourceKeys = sourceRecord ? Object.keys(sourceRecord) : [];
        const sourceId = (key: string): string | null =>
          typeof sourceRecord?.[key] === "string" && /^[a-zA-Z0-9_-]{1,128}$/.test(sourceRecord[key] as string) ? sourceRecord[key] as string : null;
        const contentTypeValid = asset.contentType === undefined
          || (typeof asset.contentType === "string" && asset.contentType.length <= 512);
        if ((asset.type !== "report" && asset.type !== "file" && !(name === "logs.txt" && asset.type === "log"))
          || !sourceRecord || sourceRecord.type !== "check-result"
          || sourceKeys.some((key) => !["type", "checkId", "checkName", "checkType", "resultId", "testSessionId"].includes(key))
          || sourceKeys.length > 6
          || sourceId("checkId") !== checkId || sourceId("resultId") !== summary.id
          || !contentTypeValid
          || (asset.archive
            ? (Object.keys(asset.archive).length !== 1 || asset.archive.entryName.length > 256)
            : false)
          || remoteUrl.protocol !== "https:" || remoteUrl.username || remoteUrl.password
          || asset.url.length > 4096 || Object.keys(asset).some((key) => !["name", "type", "url", "contentType", "source", "archive"].includes(key))) {
          invalid = "MULTISTEP_ASSET_TYPE_INVALID";
          break;
        }
        const manifestEntrySha256 = sha256(Buffer.from(JSON.stringify({
          type: asset.type, name: asset.name, source: {
            type: sourceRecord.type,
            checkId: sourceId("checkId"), checkName: sourceId("checkName"),
            checkType: sourceId("checkType"), resultId: sourceId("resultId"),
            testSessionId: sourceId("testSessionId"),
          }, url: asset.url,
          contentType: asset.contentType ?? null, archive: asset.archive?.entryName ?? null,
        }), "utf8"));
        try {
          let buf: Buffer;
          if (asset.archive) {
            let zip = archiveCache.get(asset.url);
            if (!zip) {
              const archive = await client.download(asset.url, Math.min(MAX_ASSET_ZIP_BYTES, ASSET_ZIP_BOUNDS.maxTotalUncompressedBytes - totalDownloaded));
              if (archive.length > MAX_ASSET_ZIP_BYTES || archive.length > ASSET_ZIP_BOUNDS.maxTotalUncompressedBytes - totalDownloaded) throw new Error("zip: archive exceeds byte bound");
              totalDownloaded += archive.length;
              zip = openZipBounded(archive, ASSET_ZIP_BOUNDS);
              archiveCache.set(asset.url, zip);
            }
            const entry = zip.get(asset.archive.entryName);
            if (!entry) throw new Error("zip: required asset entry is missing");
            buf = entry();
          } else {
            buf = await client.download(asset.url, Math.min(MAX_ASSET_FILE_BYTES, ASSET_ZIP_BOUNDS.maxTotalUncompressedBytes - totalDownloaded));
            if (buf.length > ASSET_ZIP_BOUNDS.maxTotalUncompressedBytes - totalDownloaded) throw new Error("asset download exceeds byte bound");
            totalDownloaded += buf.length;
          }
          if (buf.length > MAX_ASSET_FILE_BYTES || buf.length > ASSET_ZIP_BOUNDS.maxTotalUncompressedBytes - totalDecoded) {
            throw new Error("asset exceeds decoded byte bound");
          }
          totalDecoded += buf.length;
          assetsOut.push({ result: label, name, type: "remote-asset", resultId: summary.id, assetType: asset.type,
            manifestEntrySha256, bytes: buf.length, sha256: sha256(buf) });
          byName.set(name, buf.toString("utf8"));
        } catch (err) {
          invalid = multistepProblemCategory(err instanceof Error ? err.message : "asset invalid");
          break; // partial remote capture is not admissible evidence
        }
      }
      if (invalid) {
        texts.invalid = invalid;
        assetsOut.splice(0, assetsOut.length, ...assetsOut.filter((asset) => asset.result !== label));
        warnings.push(`${label}: remote Multistep asset capture is invalid (${invalid}) — UNCERTAIN`);
      } else {
        texts.testResults = byName.get("test-results.json") ?? null;
        texts.checkRunData = byName.get("check-run-data.json") ?? null;
        texts.logs = byName.get("logs.txt") ?? null;
        texts.found = MULTISTEP_ASSET_NAMES.filter((name) => byName.has(name));
      }
      texts.missing = MULTISTEP_ASSET_NAMES.filter((name) => !texts.found.includes(name));
    }
    if (texts.testResults === null && !texts.missing.includes("test-results.json")) texts.missing.push("test-results.json");
    return {
      fetched: { summary, detail, extract: null, apiRecording: null, multistep: null, multistepTexts: texts, multistepProblems: [] },
      warnings,
    };
  }

  let manifestEntries: AssetManifestEntry[] = [];
  try {
    const m = await client.getAssets(checkId, summary.id, apiRecording ? undefined : "trace");
    manifestEntries = m.assets ?? [];
    if (m.truncated) warnings.push(`${label}: asset manifest truncated (${m.entriesReturned}/${m.entriesTotal})`);
  } catch (err) {
    warnings.push(`${label}: could not list assets (${(err as Error).message})`);
  }
  if (!apiRecording && manifestEntries.length === 0) warnings.push(`${label}: no Playwright trace asset on result ${summary.id} (is trace: 'on' in playwright.config.ts?)`);

  const archiveCache = new Map<string, Buffer>();
  const extracts: TraceExtract[] = [];
  let totalRemoteDownloaded = 0;
  const downloadBounded = async (url: string): Promise<Buffer> => {
    const remaining = ASSET_ZIP_BOUNDS.maxTotalUncompressedBytes - totalRemoteDownloaded;
    const budget = Math.min(MAX_ASSET_ZIP_BYTES, remaining);
    if (budget <= 0) throw new Error("remote trace download aggregate bound exceeded");
    const data = await client.download(url, budget);
    if (data.length > budget) throw new Error("remote trace download aggregate bound exceeded");
    totalRemoteDownloaded += data.length;
    return data;
  };
  for (const asset of manifestEntries) {
    try {
      let buf: Buffer;
      if (asset.archive) {
        let archive = archiveCache.get(asset.url);
        if (!archive) {
          archive = await downloadBounded(asset.url);
          archiveCache.set(asset.url, archive);
        }
        const entry = openZipBounded(archive).get(asset.archive.entryName);
        if (!entry) throw new Error("trace asset entry is missing from archive");
        buf = entry();
      } else {
        buf = await downloadBounded(asset.url);
      }
      assetsOut.push({ result: label, name: asset.name, type: asset.type, bytes: buf.length, sha256: sha256(buf) });
      // API assets may contain wire-level authorization data. Hash them for
      // provenance, but never write or parse them into a bundle.
      if (apiRecording) continue;
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
  return { fetched: { summary, detail, extract, apiRecording }, warnings };
}

function trimmedResult(detail: CheckResult | null, apiRecording?: FetchedResult["apiRecording"], multistep = false): Record<string, unknown> | null {
  if (!detail) return null;
  if (multistep) return multiStepRunMetadata(detail as CheckResultSummary);
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
    apiCheckResult: apiRecording
      ? {
          request: apiRecording.request ? { method: apiRecording.request.method, url: apiRecording.request.url } : null,
          response: apiRecording.response ? { status: apiRecording.response.status, contentType: apiRecording.response.contentType, readable: apiRecording.response.readable, truncated: apiRecording.response.truncated } : null,
          requestError: detail.apiCheckResult?.requestError ? "request error present; sensitive message omitted" : null,
          assertionCount: detail.apiCheckResult?.assertions?.length ?? null,
          recording: `recordings/${detail.hasFailures || detail.hasErrors ? "failing" : "passing"}.api.json`,
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

const MULTISTEP_OUTPUT_FILES = new Set([
  "manifest.json", "check.config.json", "README.md", ".gitignore",
  "results/failing.json", "results/passing.json", "results/history.json",
  "recordings/failing.multistep.json", "recordings/passing.multistep.json",
]);

/** A Multistep bundle has a small, explicit set of output paths. Reject
 * symlinks/hardlinks in a reused output directory rather than following them
 * when replacing an earlier synthetic capture. The caller chooses outDir, but
 * data-derived paths can never escape it or introduce arbitrary artifacts. */
function writeMultiStepBundleFiles(outDir: string, files: Array<{ file: string; text: string }>, secrets: string[]): Array<{ file: string; text: string }> {
  const seen = new Set<string>();
  let totalBytes = 0;
  if (files.length > MULTISTEP_MAX_SOURCE_FILES + MULTISTEP_OUTPUT_FILES.size) throw new Error("MULTISTEP_OUTPUT_BOUND");
  for (const entry of files) {
    const name = entry.file.replaceAll("\\", "/");
    if (entry.file !== name || seen.has(name)
      || !(MULTISTEP_OUTPUT_FILES.has(name) || (name.startsWith("check/") && multiStepSourcePath(name.slice(6)) === name.slice(6)))) {
      throw new Error("MULTISTEP_OUTPUT_PATH_UNSAFE");
    }
    seen.add(name);
    const bytes = Buffer.byteLength(entry.text, "utf8");
    const limit = name.startsWith("recordings/") ? 2 * 1024 * 1024 : 4 * 1024 * 1024;
    if (bytes > limit || (totalBytes += bytes) > 16 * 1024 * 1024) throw new Error("MULTISTEP_OUTPUT_BOUND");
  }
  const statOrNull = (file: string): ReturnType<typeof lstatSync> | null => {
    try { return lstatSync(file); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  };
  const dirs = new Set<string>();
  for (const file of seen) {
    const parts = file.split("/");
    for (let i = 1; i < parts.length; i++) dirs.add(parts.slice(0, i).join("/"));
  }
  // Inspect the ENTIRE existing tree (including stale files) before writing.
  // Neither a valid old bundle nor a planted secret may leave an unexamined
  // path. Directory walks and reads are bounded before allocation.
  const inspect = (dir: string, rel = "", collected: Array<{ file: string; text: string }> = []): Array<{ file: string; text: string }> => {
    for (const name of readdirSync(dir)) {
      if (collected.length > MULTISTEP_MAX_SOURCE_FILES + MULTISTEP_OUTPUT_FILES.size
        || name === "." || name === "..") throw new Error("MULTISTEP_OUTPUT_BOUND");
      const path = rel ? `${rel}/${name}` : name;
      const stat = lstatSync(join(dir, name));
      if (stat.isSymbolicLink()) throw new Error("MULTISTEP_OUTPUT_PATH_UNSAFE");
      if (stat.isDirectory()) {
        if (!dirs.has(path)) throw new Error("MULTISTEP_OUTPUT_PATH_UNSAFE");
        inspect(join(dir, name), path, collected);
      } else {
        if (!seen.has(path) || !stat.isFile() || stat.nlink !== 1
          || stat.size > (path.startsWith("recordings/") ? 2 : 4) * 1024 * 1024) {
          throw new Error("MULTISTEP_OUTPUT_PATH_UNSAFE");
        }
        collected.push({ file: path, text: readFileSync(join(dir, name), "utf8") });
      }
    }
    if (collected.length > files.length || collected.reduce((n, f) => n + Buffer.byteLength(f.text), 0) > 16 * 1024 * 1024) {
      throw new Error("MULTISTEP_OUTPUT_BOUND");
    }
    return collected;
  };
  let ancestor = dirname(outDir);
  while (true) {
    const stat = statOrNull(ancestor);
    if (stat) {
      // Resolve OS-level symlinks (macOS /var → /private/var, /tmp →
      // /private/tmp): the resolved parent must be a real directory. The
      // outDir itself and its contents stay lstat-checked (no-follow) below.
      const target = stat.isSymbolicLink() ? statOrNull(realpathSync(ancestor)) : stat;
      if (!target || !target.isDirectory()) throw new Error("MULTISTEP_OUTPUT_PATH_UNSAFE");
    }
    if (ancestor === dirname(ancestor)) break;
    ancestor = dirname(ancestor);
  }
  const root = statOrNull(outDir);
  if (root && (!root.isDirectory() || root.isSymbolicLink())) throw new Error("MULTISTEP_OUTPUT_PATH_UNSAFE");
  if (root) assertNoSecretLeak(inspect(outDir), secrets);
  mkdirSync(outDir, { recursive: true });
  if (!lstatSync(outDir).isDirectory() || lstatSync(outDir).isSymbolicLink()) throw new Error("MULTISTEP_OUTPUT_PATH_UNSAFE");
  // Preflight every existing path before writing any file, including broken
  // symlinks and hardlinks whose target is outside the output directory.
  for (const entry of files) {
    const parts = entry.file.split("/");
    let parent = outDir;
    for (const segment of parts.slice(0, -1)) {
      parent = join(parent, segment);
      const stat = statOrNull(parent);
      if (stat && (!stat.isDirectory() || stat.isSymbolicLink())) throw new Error("MULTISTEP_OUTPUT_PATH_UNSAFE");
    }
    const existing = statOrNull(join(outDir, entry.file));
    if (existing && (!existing.isFile() || existing.isSymbolicLink() || existing.nlink !== 1)) {
      throw new Error("MULTISTEP_OUTPUT_PATH_UNSAFE");
    }
  }
  const written: Array<{ file: string; text: string }> = [];
  for (const entry of files) {
    const p = join(outDir, entry.file);
    mkdirSync(dirname(p), { recursive: true });
    // Never truncate before verifying the opened descriptor. O_NOFOLLOW and
    // O_EXCL protect final-component symlinks and race-created replacements.
    const exists = statOrNull(p) !== null;
    const fd = openSync(p, exists ? constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0)
      : constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600);
    try {
      const stat = fstatSync(fd);
      if (!stat.isFile() || stat.nlink !== 1) throw new Error("MULTISTEP_OUTPUT_PATH_UNSAFE");
      if (exists) ftruncateSync(fd, 0);
      writeFileSync(fd, entry.text);
    } finally { closeSync(fd); }
    written.push({ file: entry.file, text: readFileSync(p, "utf8") });
  }
  const tree = inspect(outDir);
  if (tree.length !== files.length || tree.some((entry) => !seen.has(entry.file))) throw new Error("MULTISTEP_OUTPUT_PATH_UNSAFE");
  assertNoSecretLeak(tree, secrets); // full postflight, not just our writes
  return written;
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
  if (check.checkType === "MULTI_STEP") log("[bundle] Multistep deployed check fetched; configuration and script require exact local binding");
  else log(`[bundle] check ${check.id} "${check.name}" type=${check.checkType} locations=${(check.locations ?? []).join(",")} runParallel=${Boolean(check.runParallel)}`);
  const secretValues = (check.environmentVariables ?? []).map((v) => v.value).filter((v): v is string => typeof v === "string");
  const isMultiStep = check.checkType === "MULTI_STEP";
  // A raw ZIP, log or JSON asset must never be persisted for this protected
  // transaction, even when a legacy capture flag asks to retain raw bytes.
  // Reject before the first result download, not after writing a raw/ tree.
  if (isMultiStep && opts.keepRaw) throw new Error("MULTISTEP_RAW_OUTPUT_FORBIDDEN");
  const multistepAssets = opts.assetsDir && isMultiStep ? readMultiStepAssets(opts.assetsDir) : null;
  if (opts.assetsDir && !isMultiStep) warnings.push("--assets is only used for MULTI_STEP checks; ignored for this check type");
  if (opts.assetsDir && isMultiStep) {
    log(`[bundle] local assets supplied: failing [${multistepAssets?.failing?.found.join(", ") ?? "none"}], passing [${multistepAssets?.passing?.found.join(", ") ?? "none"}]`);
  }

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
  const assetKind: "trace" | "multistep" = isMultiStep ? "multistep" : "trace";
  if (failingSummary) {
    const r = await fetchResultWithTrace(client, check.id, failingSummary, "failing", bodies, assets, rawDir ? join(rawDir, "failing") : null, log, toolVersion, secretValues, assetKind, multistepAssets?.failing ?? null);
    failing = r.fetched;
    warnings.push(...r.warnings);
  }
  if (passingSummary) {
    const r = await fetchResultWithTrace(client, check.id, passingSummary, "passing", bodies, assets, rawDir ? join(rawDir, "passing") : null, log, toolVersion, secretValues, assetKind, multistepAssets?.passing ?? (!failingSummary ? multistepAssets?.failing : null) ?? null);
    passing = r.fetched;
    warnings.push(...r.warnings);
  }

  // 3b. Multistep: normalize → extract relationships → sanitize → record.
  // Only sanitized structured evidence is ever written; problems become
  // manifest.multistep so `verify` maps them to UNCERTAIN.
  const multistepRecordings: { failing: string | null; passing: string | null } = { failing: null, passing: null };
  const multistepDrafts: Partial<Record<"failing" | "passing", { recording: MultiStepRecordingDraft; capture: MultiStepCapture }>> = {};
  const boundRecordings: Partial<Record<"failing" | "passing", MultiStepRecording>> = {};
  const multistepProblems: { failing: string[] | null; passing: string[] | null } = { failing: null, passing: null };
  const multistepSecrets: string[] = [];
  for (const [side, fetched] of [["failing", failing], ["passing", passing]] as const) {
    if (!fetched?.multistepTexts) continue;
    const expectFailing = side === "failing";
    if (isOk(fetched.summary) === expectFailing) {
      const problems = ["MULTISTEP_RESULT_SIDE_MISMATCH"];
      fetched.multistepProblems = problems;
      multistepProblems[side] = problems;
      warnings.push(`${side}: result summary contradicts the evidence side — UNCERTAIN`);
      continue;
    }
    const capture = buildMultiStepRecording({ texts: fetched.multistepTexts, attempts: fetched.summary.attempts ?? null });
    if (capture.ok && capture.recording.kind === side) {
      multistepDrafts[side] = { recording: capture.recording, capture: capture.capture };
      // No draft can become a manifest failure point or recording pointer.
      fetched.multistep = null;
      fetched.multistepProblems = [];
      multistepProblems[side] = null;
      multistepSecrets.push(...capture.secrets);
      log(`[bundle] ${side}: multistep capture normalized (${capture.capture.kind}, ${capture.capture.steps.length} step entries)`);
    } else {
      const problems = capture.ok ? ["MULTISTEP_CAPTURE_SIDE_MISMATCH"] : capture.problems;
      fetched.multistep = null;
      fetched.multistepProblems = problems;
      multistepProblems[side] = problems;
      warnings.push(`${side}: multistep evidence unresolved (${problems[0]}) — UNCERTAIN, never PASS/FAIL`);
    }
  }

  // 4. error group + RCA
  let errorGroup: ErrorGroup | null = null;
  let rca: RootCauseAnalysis | null = null;
  let replacedRca: RootCauseAnalysis | null = null;
  if (failing && !isMultiStep) {
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
      // newest completed analysis first; a PENDING/FAILED entry has no `analysis`
      const analyses = (errorGroup.rootCauseAnalyses ?? []).filter((a) => a && a.analysis && typeof a.created_at === "string").sort((a, b) => b.created_at.localeCompare(a.created_at));
      rca = analyses[0] ?? null;
      // Rocky analyzes only the first failure of a group. When the captured
      // run's "Received" differs from the group's first failure, the existing
      // RCA is about another incident (seen live: a UI rename landed in the
      // 401 group). Then --trigger-rca asks for a fresh analysis.
      const runErrors = resultErrors(failing.detail);
      const matches = groupErrorMatches(errorGroup.cleanedErrorMessage, runErrors);
      const mentions = rcaMentionsReceived(rca, runErrors);
      const createdBefore = rca ? Date.parse(rca.created_at) < Date.parse(failing.summary.startedAt) : null;
      const fit = rcaFit({ rca, createdBefore, groupMatches: matches, mentions });
      const stale = fit.stale;
      if (rca) {
        log(
          `[bundle] RCA fit: group first received ${expectedReceived(errorGroup.cleanedErrorMessage).received ?? "?"}, this run received ${runOutcome(runErrors).received ?? "?"}; ` +
            `RCA created ${createdBefore ? "before" : "after"} this run, mentions the run's received value: ${mentions ?? "n/a"} → ` +
            (stale ? "STALE (about an earlier failure)" : fit.describes === true ? "describes this run" : "not decidable from the outside (read it before trusting it)"),
        );
      }
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
  if (isMultiStep && proj.warnings.some((warning) => warning.startsWith("MULTISTEP_"))) {
    const problem = proj.warnings.find((warning) => warning.startsWith("MULTISTEP_"))!;
    for (const side of ["failing", "passing"] as const) {
      if (side === "failing" && !failing || side === "passing" && !passing) continue;
      multistepProblems[side] = [...new Set([...(multistepProblems[side] ?? []), problem])];
    }
  }
  if (isMultiStep) {
    const source = proj.sources.find((item) => item.path === proj.mainSource);
    const model = proj.mainSource ? parseMultiStepProject(
      new Map(proj.sources.map((item) => [item.path, item.content])), proj.mainSource) : null;
    const unsafeSource = proj.warnings.some((warning) => warning.startsWith("MULTISTEP_"));
    for (const [side, fetched] of [["failing", failing], ["passing", passing]] as const) {
      const draft = multistepDrafts[side];
      if (!draft || !fetched) continue;
      // --assets supplies useful normalization/sanitization mechanics, but
      // never an authenticated result-scoped manifest or a bound v3 record.
      const remote = assets.filter((item) => item.result === side && item.name === "test-results.json" && item.type === "remote-asset");
      const problem = multistepAssets?.[side] ? "MULTISTEP_MECHANICS_ONLY" : "MULTISTEP_CAPTURE_BINDING_INVALID";
      const record = !source || unsafeSource || remote.length !== 1 ? null : finalizeRemoteMultiStepRecording(draft.recording, {
        side, checkId: check.id, result: fetched.summary, detail: fetched.detail,
        sourceFile: source.path, sourceText: source.content, sourceModel: model, asset: remote[0]!,
      });
      if (!record) {
        fetched.multistep = null;
        fetched.multistepProblems = [...new Set([...(multistepProblems[side] ?? []), problem])];
        multistepProblems[side] = fetched.multistepProblems;
        continue;
      }
      fetched.multistep = draft.capture;
      fetched.multistepProblems = [];
      boundRecordings[side] = record;
      multistepRecordings[side] = JSON.stringify(record, null, 2) + "\n";
    }
  }
  if (check.checkType === "API" && proj.mainSource) {
    const sourceMap = new Map(proj.sources.map((source) => [source.path.replace(/\\/g, "/"), source.content]));
    const model = parseApiCheckProject(proj.mainSource, sourceMap);
    if (model?.setupFile) {
      const source = sourceMap.get(model.setupFile);
      if (source) {
        if (failing?.apiRecording) failing.apiRecording.setup = setupProvenance(model.setupFile, source);
        if (passing?.apiRecording) passing.apiRecording.setup = setupProvenance(model.setupFile, source);
      } else {
        warnings.push(`API setup provenance is missing because ${model.setupFile} was not captured`);
      }
    }
  }
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
        grep: check.name,
        runner: deps.runner,
        log,
      });
    }
  }

  // 7. manifest + files
  const recordings = {
    failing: failing?.extract ? "recordings/failing.har" : null,
    passing: passing?.extract ? "recordings/passing.har" : null,
    apiFailing: failing?.apiRecording ? "recordings/failing.api.json" : null,
    apiPassing: passing?.apiRecording ? "recordings/passing.api.json" : null,
    multistepFailing: multistepRecordings.failing ? "recordings/failing.multistep.json" : null,
    multistepPassing: multistepRecordings.passing ? "recordings/passing.multistep.json" : null,
    bodies,
  };
  let manifest = buildManifest({
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
    multistep: isMultiStep
      ? { failing: multistepProblems.failing ? { problems: multistepProblems.failing } : null, passing: multistepProblems.passing ? { problems: multistepProblems.passing } : null }
      : null,
    assets,
    apiCalls: client.calls.map((c) => ({ ...c })),
    accountId: deps.accountId,
    now,
    toolVersion,
  });
  if (isMultiStep) manifest = constrainMultiStepManifest(manifest, boundRecordings,
    new Map(proj.sources.map((item) => [item.path, item.content])));
  else manifest.notes.push(...warnings.map((w) => `warning: ${w}`));

  const files: Array<{ file: string; text: string }> = [];
  files.push({ file: "manifest.json", text: JSON.stringify(manifest, null, 2) + "\n" });
  files.push({ file: "check.config.json", text: JSON.stringify({ check: manifest.check, config: manifest.config, target: manifest.target }, null, 2) + "\n" });
  for (const s of proj.sources) files.push({ file: join("check", s.path), text: s.content });
  if (failing?.extract) files.push({ file: "recordings/failing.har", text: JSON.stringify(sanitizeHar(failing.extract.har), null, 1) + "\n" });
  if (passing?.extract) files.push({ file: "recordings/passing.har", text: JSON.stringify(sanitizeHar(passing.extract.har), null, 1) + "\n" });
  if (failing?.apiRecording) files.push({ file: "recordings/failing.api.json", text: JSON.stringify(failing.apiRecording, null, 2) + "\n" });
  if (passing?.apiRecording) files.push({ file: "recordings/passing.api.json", text: JSON.stringify(passing.apiRecording, null, 2) + "\n" });
  if (multistepRecordings.failing) files.push({ file: "recordings/failing.multistep.json", text: multistepRecordings.failing });
  if (multistepRecordings.passing) files.push({ file: "recordings/passing.multistep.json", text: multistepRecordings.passing });
  if (failing?.extract) files.push({ file: "recordings/failing.actions.json", text: JSON.stringify(failing.extract.actions.map(({ params: _p, ...a }) => a), null, 1) + "\n" });
  if (passing?.extract) files.push({ file: "recordings/passing.actions.json", text: JSON.stringify(passing.extract.actions.map(({ params: _p, ...a }) => a), null, 1) + "\n" });
  if (failing) files.push({ file: "results/failing.json", text: JSON.stringify(trimmedResult(failing.detail, failing.apiRecording, isMultiStep) ?? (isMultiStep ? multiStepRunMetadata(failing.summary) : failing.summary), null, 2) + "\n" });
  if (passing) files.push({ file: "results/passing.json", text: JSON.stringify(trimmedResult(passing.detail, passing.apiRecording, isMultiStep) ?? (isMultiStep ? multiStepRunMetadata(passing.summary) : passing.summary), null, 2) + "\n" });
  if (!isMultiStep && (rca || errorGroup)) files.push({ file: "rca.json", text: JSON.stringify({ errorGroup: manifest.errorGroup, rca, ...(replacedRca ? { replacedRca } : {}) }, null, 2) + "\n" });
  // the result window the decisions were made from (ids + timestamps only), so
  // the overlap evidence and the pass rate can be re-checked offline
  files.push({
    file: "results/history.json",
    text:
      JSON.stringify(
        history.map((r) => isMultiStep ? multiStepRunMetadata(r) : ({
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

  // Final leak check over EVERY original sensitive value: Checkly env vars
  // plus the original account/token/origin values the sanitizer labeled.
  const allSecrets = [...new Set([...secretValues, ...multistepSecrets])];
  // The generic builder tolerates short public fixture values because they
  // collide with ordinary words. A Multistep bundle cannot make that trade:
  // fail closed rather than persist a value we cannot reliably screen.
  if (isMultiStep && allSecrets.some((value) => value.length > 0 && value.length < 6)) {
    throw new Error("MULTISTEP_SECRET_UNSCREENABLE");
  }
  assertNoSecretLeak(files, allSecrets);

  const written: Array<{ file: string; text: string }> = isMultiStep
    ? writeMultiStepBundleFiles(outDir, files, allSecrets)
    : (() => {
        mkdirSync(outDir, { recursive: true });
        const output: Array<{ file: string; text: string }> = [];
        for (const f of files) {
          const p = isAbsolute(f.file) ? f.file : join(outDir, f.file);
          mkdirSync(dirname(p), { recursive: true });
          writeFileSync(p, f.text);
          output.push({ file: f.file, text: readFileSync(p, "utf8") });
        }
        return output;
      })();
  // And again over every file ACTUALLY written, straight from disk.
  assertNoSecretLeak(written, allSecrets);
  log(`[bundle] wrote ${files.length} files to ${outDir} (post-write leak check over ${allSecrets.length} original sensitive value(s): clean)`);
  return { manifest, outDir, files: files.map((f) => f.file), warnings };
}

export function bundleReadme(m: ManifestV3): string {
  // Older captured bundles predate the Rocky repair fields. Regenerating their
  // README during local measurement must remain safe.
  const repair = m.config.repair ?? { intent: null, aiAutoRepairEnabled: null };
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
    `- Rocky guardrails: intent ${repair.intent ? `"${repair.intent.goal}" (${repair.intent.mustPreserve.length} mustPreserve, ${repair.intent.requiredOutcomes.length} requiredOutcomes)` : "none"}; automatic repair ${repair.aiAutoRepairEnabled === null ? "inherits the account default" : repair.aiAutoRepairEnabled ? "ON for this check" : "OFF for this check"}`,
    `- Reproduction mode: **${m.reproduction.mode}** (decided by ${m.reproduction.decidedBy}) — ${m.reproduction.reason}`,
    m.failurePoint?.request
      ? `- Failure point: ${m.failurePoint.request.method} ${m.failurePoint.request.path} → ${m.failurePoint.request.status}${m.failurePoint.request.passingStatus !== null ? ` (passing run: ${m.failurePoint.request.passingStatus})` : ""}`
      : m.failurePoint?.dependency
        ? `- Step dependency: ${m.failurePoint.dependency.method} ${m.failurePoint.dependency.path} (observed in the failing run${m.failurePoint.dependency.passingStatus === null ? "" : `; passing-run status ${m.failurePoint.dependency.passingStatus}`}; ${m.check.checkType === "MULTI_STEP" ? "trusted local detection flips only nested booking.confirmed to false at HTTP 200" : "detection injects 500"})`
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
    `- Measurement method: ${m.determinism.method ?? "none"}; last verified ${m.determinism.lastVerifiedAt}`,
    "",
    "## Notes",
    "",
    ...m.notes.map((n) => `- ${n}`),
    "",
  ];
  return lines.filter((l) => l !== null).join("\n");
}
