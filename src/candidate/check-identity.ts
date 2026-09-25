// Stable Checkly identity resolution for a complete candidate tree.
//
// Display names and file paths may change. The logical ID is the durable key.
// The incident's logical ID is derived from its captured source when older v3
// bundles stored the project ID instead of the nested check ID.

import { existsSync, readFileSync, statSync } from "node:fs";
import { extname, join } from "node:path";
import type { Bundle } from "../types.ts";
import type { CandidateChange, CandidateRevision } from "./revision.ts";

export interface CheckIdentityResolution {
  logicalId: string;
  name: string;
  identityFile: string;
  checkFile: string | null;
  configFile: string | null;
  rejection: string | null;
}

interface LogicalEntry {
  logicalId: string;
  name: string | null;
  path: string;
  index: number;
}

const CODE = /\.(?:[cm]?[jt]sx?)$/i;
const CHECKLY_CONFIG = /(?:^|\/)checkly\.config\.(?:[cm]?[jt]s)$/i;
const SPEC = /\.(?:spec|test)\.[cm]?[jt]sx?$/i;

function slash(value: string): string {
  return value.split("\\").join("/");
}

function stringValue(text: string, key: string): string | null {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const matches = text.matchAll(new RegExp(`\\b${escaped}\\s*:\\s*(['\"\x60])([^'\"\x60]+)\\1`, "g"));
  for (const match of matches) {
    let depth = 0;
    let quote: string | null = null;
    for (let i = 0; i < (match.index ?? 0); i++) {
      const char = text[i];
      if (quote) {
        if (char === "\\") i++;
        else if (char === quote) quote = null;
      } else if (char === "'" || char === '"' || char === "`") quote = char;
      else if (char === "{") depth++;
      else if (char === "}") depth--;
    }
    // A balanced object starts at depth 1. Constructor tails start at 0.
    if (depth <= 1) return match[2];
  }
  return null;
}

/** Small balanced-object reader. It does not execute candidate code. */
function objectAround(source: string, index: number): string {
  const stack: number[] = [];
  let quote: string | null = null;
  let lineComment = false;
  let blockComment = false;
  const ranges: Array<{ start: number; end: number }> = [];
  for (let i = 0; i < source.length; i++) {
    const char = source[i];
    const next = source[i + 1];
    if (lineComment) {
      if (char === "\n") lineComment = false;
      continue;
    }
    if (blockComment) {
      if (char === "*" && next === "/") { blockComment = false; i++; }
      continue;
    }
    if (quote) {
      if (char === "\\") i++;
      else if (char === quote) quote = null;
      continue;
    }
    if (char === "/" && next === "/") { lineComment = true; i++; continue; }
    if (char === "/" && next === "*") { blockComment = true; i++; continue; }
    if (char === "'" || char === '"' || char === "`") { quote = char; continue; }
    if (char === "{") stack.push(i);
    if (char === "}") {
      const start = stack.pop();
      if (start !== undefined && start <= index && index <= i) ranges.push({ start, end: i + 1 });
    }
  }
  ranges.sort((a, b) => (a.end - a.start) - (b.end - b.start));
  const range = ranges[0];
  return range ? source.slice(range.start, range.end) : source;
}

function maskComments(source: string): string {
  const chars = [...source];
  let quote: string | null = null;
  for (let i = 0; i < chars.length; i++) {
    const char = chars[i];
    const next = chars[i + 1];
    if (quote) {
      if (char === "\\") i++;
      else if (char === quote) quote = null;
      continue;
    }
    if (char === "'" || char === '"' || char === "`") { quote = char; continue; }
    if (char === "/" && next === "/") {
      chars[i] = chars[i + 1] = " ";
      i += 2;
      while (i < chars.length && chars[i] !== "\n") chars[i++] = " ";
      i--;
      continue;
    }
    if (char === "/" && next === "*") {
      chars[i] = chars[i + 1] = " ";
      i += 2;
      while (i < chars.length && !(chars[i] === "*" && chars[i + 1] === "/")) {
        if (chars[i] !== "\n") chars[i] = " ";
        i++;
      }
      if (i < chars.length) { chars[i] = chars[i + 1] = " "; i++; }
    }
  }
  return chars.join("");
}

export function logicalEntries(path: string, source: string): LogicalEntry[] {
  const entries: LogicalEntry[] = [];
  const searchable = maskComments(source);
  const property = /\blogicalId\s*:\s*(['"`])([^'"`]+)\1/g;
  let match: RegExpExecArray | null;
  while ((match = property.exec(searchable)) !== null) {
    const object = objectAround(searchable, match.index);
    entries.push({ logicalId: match[2], name: stringValue(object, "name"), path, index: match.index });
  }
  const construct = /\bnew\s+[A-Za-z_$][\w$.]*(?:Check|CheckSuite)\s*\(\s*(['"`])([^'"`]+)\1/g;
  while ((match = construct.exec(searchable)) !== null) {
    const tail = searchable.slice(match.index, Math.min(searchable.length, match.index + 4000));
    entries.push({ logicalId: match[2], name: stringValue(tail, "name"), path, index: match.index });
  }
  return entries;
}

export function incidentLogicalId(bundle: Bundle): string {
  const entries = Object.entries(bundle.files)
    .filter(([path]) => CODE.test(path))
    .flatMap(([path, source]) => logicalEntries(path, source));
  const named = entries.find((entry) => entry.name === bundle.check.name);
  return named?.logicalId ?? bundle.check.logicalId;
}

function projectRelativeChange(change: CandidateChange, projectPath: string): CandidateChange | null {
  const prefix = projectPath === "." ? "" : `${projectPath.replace(/\/$/, "")}/`;
  const convert = (path: string): string | null => {
    if (!prefix) return path;
    return path.startsWith(prefix) ? path.slice(prefix.length) : null;
  };
  const path = convert(change.path);
  if (path === null) return null;
  const previousPath = change.previousPath ? convert(change.previousPath) : undefined;
  return { ...change, path, ...(previousPath ? { previousPath } : {}) };
}

function textFiles(revision: CandidateRevision): Array<{ path: string; source: string }> {
  const prefix = revision.metadata.projectPath === "." ? "" : `${revision.metadata.projectPath}/`;
  const files: Array<{ path: string; source: string }> = [];
  for (const repositoryPath of revision.files) {
    if (prefix && !repositoryPath.startsWith(prefix)) continue;
    const path = prefix ? repositoryPath.slice(prefix.length) : repositoryPath;
    if (!CODE.test(path)) continue;
    const absolute = join(revision.projectRoot, path);
    if (!existsSync(absolute) || !statSync(absolute).isFile()) continue;
    const bytes = readFileSync(absolute);
    if (bytes.includes(0)) continue;
    files.push({ path: slash(path), source: bytes.toString("utf8") });
  }
  return files;
}

function renamedMain(bundle: Bundle, revision: CandidateRevision): string | null {
  const changes = revision.metadata.changes
    .map((change) => projectRelativeChange(change, revision.metadata.projectPath))
    .filter((change): change is CandidateChange => change !== null);
  const rename = changes.find((change) => change.status === "renamed" && change.previousPath === bundle.check.file);
  return rename?.path ?? null;
}

export function resolveCheckIdentity(bundle: Bundle, revision: CandidateRevision): CheckIdentityResolution {
  const expected = incidentLogicalId(bundle);
  const files = textFiles(revision);
  // Incident archives and fixture trees are evidence, not executable candidate
  // project definitions. They may contain the same historical logical ID.
  const identityFiles = files.filter((file) => !/(?:^|\/)(?:incidents|fixtures|__fixtures__|testdata)(?:\/|$)/.test(file.path));
  const entries = identityFiles.flatMap((file) => logicalEntries(file.path, file.source));
  const matched = entries.filter((entry) => entry.logicalId === expected);
  if (matched.length === 0) {
    return {
      logicalId: expected,
      name: bundle.check.name ?? expected,
      identityFile: "",
      checkFile: null,
      configFile: null,
      rejection: `incident check logicalId ${JSON.stringify(expected)} is missing from the candidate tree`,
    };
  }
  if (matched.length > 1) {
    return {
      logicalId: expected,
      name: bundle.check.name ?? expected,
      identityFile: "",
      checkFile: null,
      configFile: null,
      rejection: `incident check logicalId ${JSON.stringify(expected)} is declared more than once in the candidate tree`,
    };
  }
  const identity = matched[0];
  const configFile = matched.map((entry) => entry.path).find((path) => CHECKLY_CONFIG.test(path))
    ?? files.map((file) => file.path).find((path) => CHECKLY_CONFIG.test(path))
    ?? null;

  let checkFile: string | null = null;
  if (SPEC.test(identity.path)) checkFile = identity.path;
  const captured = join(revision.projectRoot, bundle.check.file);
  if (!checkFile && existsSync(captured) && statSync(captured).isFile()) checkFile = bundle.check.file;
  if (!checkFile) checkFile = renamedMain(bundle, revision);
  if (!checkFile && SPEC.test(bundle.check.file)) {
    const specs = files.filter((file) => SPEC.test(file.path));
    const names = [...new Set([bundle.check.name, identity.name].filter((name): name is string => Boolean(name)))];
    const named = specs.filter((file) => names.some((name) => file.source.includes(name)));
    if (named.length === 1) checkFile = named[0].path;
  }
  if (!checkFile && !SPEC.test(bundle.check.file) && identity.path) checkFile = identity.path;

  return {
    logicalId: expected,
    name: identity.name ?? bundle.check.name ?? expected,
    identityFile: identity.path,
    checkFile,
    configFile,
    rejection: checkFile ? null : `incident check logicalId ${JSON.stringify(expected)} remains configured, but its executable source was deleted`,
  };
}

export function configuredPlaywrightPath(source: string | null): string | null {
  if (!source) return null;
  const searchable = maskComments(source);
  return /\bplaywrightConfigPath\s*:\s*(['"`])([^'"`]+)\1/.exec(searchable)?.[2].replace(/^\.\//, "") ?? null;
}

export function sourceExtensionCandidates(path: string): string[] {
  if (extname(path)) return [path];
  return [path, ...[".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".json"].map((extension) => `${path}${extension}`), ...["index.ts", "index.tsx", "index.js", "index.mjs", "index.cjs"].map((name) => join(path, name))].map(slash);
}
