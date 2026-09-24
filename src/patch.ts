// Candidate monitoring-tree loader.
//
// Production local/PR inputs come from an immutable complete Git revision.
// The final check/config/import tree is loaded without restoring deletions.
// `--patch` remains a small compatibility input for fixtures and experiments:
// a file replaces the main captured check and a directory overlays bundle paths.

import { existsSync, lstatSync, readFileSync, realpathSync, readdirSync, statSync } from "node:fs";
import { dirname, extname, join, relative, resolve } from "node:path";
import * as ts from "typescript";
import type { Bundle, BundleConfig } from "./types.ts";
import { parseCheckConfig } from "./scene/config-diff.ts";
import type { CandidateRevision, CandidateRevisionMetadata } from "./candidate/revision.ts";
import { configuredPlaywrightPath, resolveCheckIdentity, sourceExtensionCandidates } from "./candidate/check-identity.ts";

export interface PatchSet {
  kind: "file" | "directory" | "inline" | "candidate-project" | "candidate-revision";
  path: string | null;
  /** relative path under the Checkly project → final UTF-8 content */
  files: Record<string, string>;
  /** Binary files in a complete candidate project. */
  assets?: Record<string, Buffer>;
  /** Complete candidates do not inherit missing files from the incident bundle. */
  complete?: boolean;
  /** Main incident check after a Git rename. Null means the incident check was removed. */
  checkFile?: string | null;
  /** Candidate Checkly config after a rename. */
  configFile?: string | null;
  /** Candidate Playwright config selected by the final Checkly config. */
  playwrightConfigFile?: string | null;
  /** Stable logical ID used to locate the incident check. */
  checkLogicalId?: string;
  /** Candidate display name matched through the stable Checkly logical ID. */
  checkName?: string;
  /** Definite candidate identity failure. The verifier maps this to FAILED. */
  rejection?: string | null;
  /** Public immutable source identity included in reports. */
  revision?: CandidateRevisionMetadata;
}

export function loadPatch(pathIn: string, bundle: Bundle): PatchSet {
  const path = resolve(pathIn);
  if (statSync(path).isDirectory()) {
    const files: Record<string, string> = {};
    const walk = (d: string) => {
      for (const name of readdirSync(d)) {
        const p = join(d, name);
        if (statSync(p).isDirectory()) walk(p);
        else files[relative(path, p).split("\\").join("/")] = readFileSync(p, "utf8");
      }
    };
    walk(path);
    if (Object.keys(files).length === 0) throw new Error(`patch directory ${path} is empty`);
    return { kind: "directory", path, files };
  }
  return { kind: "file", path, files: { [bundle.check.file]: readFileSync(path, "utf8") } };
}

/**
 * Read the candidate monitoring files from a real customer project.
 *
 * Only files captured in the bundle and their relative source imports enter
 * the patch. Application files, node_modules, .next, dotenv files, and other
 * unrelated project content are never scanned.
 */
export function loadCandidateProject(pathIn: string, bundle: Bundle): PatchSet {
  const requestedRoot = resolve(pathIn);
  if (!statSync(requestedRoot).isDirectory()) throw new Error(`candidate project ${requestedRoot} is not a directory`);
  const root = realpathSync(requestedRoot);
  const files: Record<string, string> = {};
  const pending = [...new Set([...Object.keys(bundle.files), bundle.check.file])];
  const visited = new Set<string>();

  const inside = (path: string): string => {
    const rel = relative(root, path).split("\\").join("/");
    if (!rel || rel === ".." || rel.startsWith("../")) throw new Error(`candidate import leaves --candidate-project: ${path}`);
    return rel;
  };
  const resolveImport = (from: string, specifier: string): string | null => {
    if (!specifier.startsWith(".")) return null;
    const base = resolve(root, dirname(from), specifier);
    const candidates = extname(base)
      ? [base]
      : [base, ...[".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".json"].map((ext) => `${base}${ext}`), ...["index.ts", "index.tsx", "index.js", "index.mjs"].map((name) => join(base, name))];
    for (const path of candidates) {
      if (!existsSync(path)) continue;
      if (lstatSync(path).isSymbolicLink()) throw new Error(`candidate import may not be a symbolic link: ${inside(path)}`);
      if (statSync(path).isFile()) return inside(realpathSync(path));
    }
    return null;
  };

  while (pending.length > 0) {
    const rel = pending.shift()!;
    if (visited.has(rel)) continue;
    if (/(?:^|\/)\.env(?:\.|$)/.test(rel)
      || /(?:^|\/)(?:\.npmrc|\.yarnrc(?:\.yml)?|\.pnpmfile\.cjs)$/.test(rel)
      || /(?:^|\/)(?:node_modules|\.next|\.vercel)(?:\/|$)/.test(rel)) {
      throw new Error(`unsafe candidate monitoring path: ${rel}`);
    }
    visited.add(rel);
    const absolute = resolve(root, rel);
    inside(absolute);
    if (!existsSync(absolute) || !statSync(absolute).isFile()) {
      if (bundle.files[rel] !== undefined || rel === bundle.check.file) throw new Error(`candidate project is missing captured check file ${rel}`);
      continue;
    }
    if (lstatSync(absolute).isSymbolicLink()) throw new Error(`candidate monitoring file may not be a symbolic link: ${rel}`);
    inside(realpathSync(absolute));
    const source = readFileSync(absolute, "utf8");
    files[rel] = source;
    if (/\.[cm]?[jt]sx?$/.test(rel)) {
      for (const reference of ts.preProcessFile(source, true, true).importedFiles) {
        const imported = resolveImport(rel, reference.fileName);
        if (imported && !visited.has(imported)) pending.push(imported);
      }
    }
  }

  return { kind: "candidate-project", path: root, files };
}

const PROJECT_METADATA = /^(?:package\.json|package-lock\.json|npm-shrinkwrap\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb?|(?:tsconfig|jsconfig)(?:\.[^.]+)*\.json)$/;

function decodeCandidateText(bytes: Buffer): string | null {
  if (bytes.includes(0)) return null;
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

/**
 * Build the executable monitoring tree from one immutable candidate revision.
 *
 * The revision digest covers the complete repository. Application files are
 * observed through the supplied deployment. The local and Checkly runners get
 * the final check/config files, their real import closure, and dependency
 * metadata. Missing or renamed files are never restored from the incident.
 */
export function loadCandidateRevision(revision: CandidateRevision, bundle: Bundle): PatchSet {
  revision.assertUnchanged();
  const root = revision.projectRoot;
  const identity = resolveCheckIdentity(bundle, revision);
  const files: Record<string, string> = {};
  const assets: Record<string, Buffer> = {};
  const pending: string[] = [];
  const visited = new Set<string>();

  const inside = (path: string): string => {
    const rel = relative(root, path).split("\\").join("/");
    if (!rel || rel === ".." || rel.startsWith("../")) throw new Error(`candidate import leaves the immutable project snapshot: ${path}`);
    return rel;
  };
  const add = (path: string | null | undefined) => {
    if (path && !visited.has(path) && !pending.includes(path)) pending.push(path);
  };
  add(identity.identityFile);
  add(identity.configFile);
  add(identity.checkFile);

  const configSource = identity.configFile && existsSync(join(root, identity.configFile))
    ? readFileSync(join(root, identity.configFile), "utf8")
    : null;
  let playwrightConfigFile = configuredPlaywrightPath(configSource) ?? bundle.playwright?.configFile ?? null;
  if (playwrightConfigFile && !existsSync(join(root, playwrightConfigFile))) playwrightConfigFile = null;

  for (const repositoryPath of revision.files) {
    const prefix = revision.metadata.projectPath === "." ? "" : `${revision.metadata.projectPath}/`;
    if (prefix && !repositoryPath.startsWith(prefix)) continue;
    const rel = prefix ? repositoryPath.slice(prefix.length) : repositoryPath;
    if (!playwrightConfigFile && /(?:^|\/)playwright\.config\.[cm]?[jt]s$/.test(rel)) playwrightConfigFile = rel;
    if (PROJECT_METADATA.test(rel) || /(?:^|\/)(?:tsconfig|jsconfig)(?:\.[^.]+)*\.json$/.test(rel)) add(rel);
  }
  add(playwrightConfigFile);

  const resolveImport = (from: string, specifier: string): string | null => {
    if (!specifier.startsWith(".")) return null;
    const base = resolve(root, dirname(from), specifier);
    inside(base);
    for (const candidate of sourceExtensionCandidates(inside(base))) {
      const path = resolve(root, candidate);
      inside(path);
      if (!existsSync(path)) continue;
      if (lstatSync(path).isSymbolicLink()) {
        const real = realpathSync(path);
        inside(real);
      }
      if (statSync(path).isFile()) return inside(path);
    }
    return null;
  };

  while (pending.length > 0) {
    const rel = pending.shift()!;
    if (visited.has(rel)) continue;
    visited.add(rel);
    const absolute = resolve(root, rel);
    inside(absolute);
    if (!existsSync(absolute) || !statSync(absolute).isFile()) continue;
    if (lstatSync(absolute).isSymbolicLink()) inside(realpathSync(absolute));
    const bytes = readFileSync(absolute);
    const source = decodeCandidateText(bytes);
    if (source === null) {
      assets[rel] = bytes;
      continue;
    }
    files[rel] = source;
    if (/\.[cm]?[jt]sx?$/.test(rel)) {
      for (const reference of ts.preProcessFile(source, true, true).importedFiles) {
        const imported = resolveImport(rel, reference.fileName);
        if (imported) add(imported);
      }
    }
  }

  // The runner receives the complete final Checkly project, not only files the
  // incident happened to capture. This supports path aliases, fixtures, new
  // helpers, and configuration imports. The repository digest also covers
  // files outside this project; application behavior is judged via --target.
  const prefix = revision.metadata.projectPath === "." ? "" : `${revision.metadata.projectPath}/`;
  for (const repositoryPath of revision.files) {
    if (prefix && !repositoryPath.startsWith(prefix)) continue;
    const rel = prefix ? repositoryPath.slice(prefix.length) : repositoryPath;
    if (/(?:^|\/)\.env(?:\.|$)/.test(rel)) continue;
    const absolute = resolve(root, rel);
    if (!existsSync(absolute) || !statSync(absolute).isFile()) continue;
    const bytes = readFileSync(absolute);
    const source = decodeCandidateText(bytes);
    if (source === null) assets[rel] = bytes;
    else files[rel] = source;
  }

  return {
    kind: "candidate-revision",
    path: revision.metadata.sourceReference,
    files,
    assets,
    complete: true,
    checkFile: identity.checkFile,
    configFile: identity.configFile,
    playwrightConfigFile,
    checkLogicalId: identity.logicalId,
    checkName: identity.name,
    rejection: identity.rejection,
    revision: revision.metadata,
  };
}

/** A patch given as check source text (tests, embedding). */
export function inlinePatch(bundle: Bundle, checkSource: string): PatchSet {
  return { kind: "inline", path: null, files: { [bundle.check.file]: checkSource } };
}

export function patchedCheckSource(bundle: Bundle, patch: PatchSet): string {
  if (patch.complete) return patch.checkFile ? (patch.files[patch.checkFile] ?? "") : "";
  return patch.files[bundle.check.file] ?? bundle.checkSource;
}

export function patchedConfigSource(bundle: Bundle, patch: PatchSet): string | null {
  if (patch.complete) return patch.configFile ? (patch.files[patch.configFile] ?? null) : null;
  const configPath = bundle.configFile ?? "checkly.config.ts";
  return patch.files[configPath] ?? (bundle.configFile ? bundle.files[bundle.configFile] : null);
}

/** Final monitoring tree. Complete candidates never inherit deleted incident files. */
export function patchedFiles(bundle: Bundle, patch: PatchSet): Record<string, string> {
  return patch.complete ? { ...patch.files } : { ...bundle.files, ...patch.files };
}

export function patchedAssets(patch: PatchSet): Record<string, Buffer> {
  return { ...(patch.assets ?? {}) };
}

export function originalConfigSource(bundle: Bundle): string | null {
  return bundle.configFile ? bundle.files[bundle.configFile] : null;
}

/** files in the patch that do not exist in the bundle (new helpers etc.) */
export function newFiles(bundle: Bundle, patch: PatchSet): string[] {
  if (patch.complete) return []; // complete revision reports already contain the Git change list
  return Object.keys(patch.files).filter((f) => bundle.files[f] === undefined && f !== bundle.check.file);
}

/** The check config after the patch: the bundle's config with every key the patched file states. */
export function patchedConfig(bundle: Bundle, patch: PatchSet): BundleConfig | null {
  const source = patchedConfigSource(bundle, patch);
  const base = bundle.config;
  if (!source) return base;
  const view = parseCheckConfig(source);
  if (!base) {
    if (view.runParallel === null && view.locations === null) return null;
    return { runParallel: view.runParallel ?? false, locations: view.locations ?? [], frequencyMinutes: view.frequency && /^\d+$/.test(view.frequency) ? Number(view.frequency) : null, environmentVariables: view.envKeys };
  }
  return {
    runParallel: view.runParallel ?? base.runParallel,
    locations: view.locations ?? base.locations,
    frequencyMinutes: view.frequency && /^\d+$/.test(view.frequency) ? Number(view.frequency) : base.frequencyMinutes,
    environmentVariables: view.envKeys.length ? [...new Set([...base.environmentVariables, ...view.envKeys])] : base.environmentVariables,
  };
}
