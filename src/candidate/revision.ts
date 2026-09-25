// Candidate revision intake.
//
// A candidate is an immutable snapshot of a complete Git repository state.
// Local mode snapshots HEAD plus staged, unstaged, and non-ignored untracked
// files. Pull-request mode resolves one GitHub PR head SHA, fetches that exact
// commit, and snapshots it. Git changes are report data. They are never the
// runtime source of truth.

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

export type CandidateSourceKind = "local" | "github-pr";
export type CandidateChangeStatus = "added" | "modified" | "deleted" | "renamed" | "copied" | "type-changed" | "unmerged";

export interface CandidateChange {
  status: CandidateChangeStatus;
  path: string;
  previousPath?: string;
}

export interface PullRequestIdentity {
  url: string;
  number: number;
  state: string;
  baseRepository: string;
  headRepository: string;
  baseSha: string;
  headSha: string;
  headRef: string;
  fork: boolean;
}

export interface CandidateRevisionMetadata {
  source: CandidateSourceKind;
  sourceReference: string;
  repositoryRoot: string;
  projectPath: string;
  baseSha: string;
  headSha: string;
  dirty: boolean;
  immutable: true;
  digestAlgorithm: "sha256";
  digest: string;
  fileCount: number;
  totalBytes: number;
  changes: CandidateChange[];
  pullRequest?: PullRequestIdentity;
}

export interface CandidateRevision {
  metadata: CandidateRevisionMetadata;
  /** Immutable copy. It never contains .git, dependencies, output, or secrets. */
  snapshotRoot: string;
  /** Checkly project directory inside snapshotRoot. */
  projectRoot: string;
  /** Original local project. Null for --pr. Used only as a default dependency location. */
  runtimeProjectRoot: string | null;
  /** Every copied path, relative to snapshotRoot. */
  files: string[];
  assertUnchanged(): void;
  dispose(): void;
}

export interface DeploymentMetadata {
  provider: string;
  deploymentId: string;
  revision: string;
  url: string;
  environment?: string;
}

export interface CandidateTargetBinding {
  scope: "local" | "pull-request";
  sourceRevision: string;
  targetRevision: string | null;
  targetUrl: string | null;
  deployment: DeploymentMetadata | null;
  exactRevision: boolean;
  cloudApproved: boolean;
  forkApproved: boolean;
  gateEligible: boolean;
  reason: string;
}

export const MAX_CANDIDATE_FILE_BYTES = 20 * 1024 * 1024;
export const MAX_CANDIDATE_TOTAL_BYTES = 256 * 1024 * 1024;

const DEPENDENCY_OR_OUTPUT = new Set([
  "node_modules", ".pnpm-store", ".yarn", ".next", ".nuxt", ".output", ".svelte-kit",
  ".vercel", ".turbo", ".cache", "coverage", "dist", "build", "out", "target",
]);
const CREDENTIAL_NAME = /^(?:\.npmrc|\.yarnrc(?:\.yml)?|\.pnpmfile\.cjs|\.netrc|credentials(?:\.json)?|id_(?:rsa|dsa|ecdsa|ed25519)|.*\.(?:pem|key|p12|pfx))$/i;

function run(command: string, args: string[], cwd?: string): string {
  try {
    return execFileSync(command, args, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: 64 * 1024 * 1024,
    }).trim();
  } catch (error) {
    const failure = error as Error & { stderr?: string | Buffer };
    const stderr = String(failure.stderr ?? "").trim().split("\n").at(-1);
    throw new Error(`${command} ${args[0] ?? ""} failed${stderr ? `: ${stderr}` : `: ${failure.message}`}`);
  }
}

function git(root: string, args: string[]): string {
  return run("git", ["-C", root, ...args]);
}

function slash(path: string): string {
  return path.split("\\").join("/");
}

function pathInside(root: string, path: string, label: string): string {
  const rel = slash(relative(root, path));
  if (rel === ".." || rel.startsWith("../") || isAbsolute(rel)) throw new Error(`${label} leaves the repository root: ${path}`);
  return rel || ".";
}

function safeProjectPath(value: string): string {
  const normalized = slash(value || ".").replace(/^\.\//, "").replace(/\/+$/, "") || ".";
  if (isAbsolute(value) || normalized === ".." || normalized.startsWith("../")) throw new Error(`--project-path must stay inside the candidate repository: ${value}`);
  return normalized;
}

function isAnyDotenv(path: string): boolean {
  const name = path.split("/").at(-1) ?? "";
  return /^\.env(?:\.|$)/i.test(name);
}

function isCredentialDotenv(path: string): boolean {
  const name = path.split("/").at(-1) ?? "";
  return isAnyDotenv(path) && !/^\.env\.(?:example|sample|template)$/i.test(name);
}

function rejectUnsafePath(path: string): void {
  const normalized = slash(path).replace(/^\.\//, "");
  if (!normalized || normalized === ".." || normalized.startsWith("../") || normalized.includes("\0") || isAbsolute(normalized)) {
    throw new Error(`unsafe candidate path: ${path}`);
  }
  const parts = normalized.split("/");
  if (parts.some((part) => part === ".git")) throw new Error(`candidate Git metadata is not allowed in the snapshot: ${normalized}`);
  const blocked = parts.find((part) => DEPENDENCY_OR_OUTPUT.has(part));
  if (blocked) throw new Error(`candidate dependency or build output is not allowed: ${normalized} (${blocked})`);
  const name = parts.at(-1) ?? "";
  if (isCredentialDotenv(normalized) || CREDENTIAL_NAME.test(name)) throw new Error(`credential-bearing candidate file is not allowed: ${normalized}`);
}

function nulList(value: string): string[] {
  return value ? value.split("\0").filter(Boolean) : [];
}

function trackedAndUntracked(root: string): string[] {
  return nulList(git(root, ["ls-files", "-z", "--cached", "--others", "--exclude-standard"]));
}

function rejectSubmodules(root: string): void {
  for (const entry of nulList(git(root, ["ls-files", "--stage", "-z"]))) {
    const tab = entry.indexOf("\t");
    if (tab === -1) continue;
    const metadata = entry.slice(0, tab).split(/\s+/);
    if (metadata[0] === "160000") throw new Error(`candidate submodule is not allowed: ${entry.slice(tab + 1)}`);
  }
}

function copyEntry(sourceRoot: string, snapshotRoot: string, relativePath: string): number {
  rejectUnsafePath(relativePath);
  const source = resolve(sourceRoot, relativePath);
  pathInside(sourceRoot, source, "candidate path");
  if (!existsSync(source) && !lstatExists(source)) return 0; // deleted tracked path
  const info = lstatSync(source);
  const destination = resolve(snapshotRoot, relativePath);
  pathInside(snapshotRoot, destination, "snapshot path");
  mkdirSync(dirname(destination), { recursive: true });

  if (info.isSymbolicLink()) {
    const target = readlinkSync(source);
    if (isAbsolute(target)) throw new Error(`candidate symbolic link is absolute: ${relativePath} -> ${target}`);
    const resolvedTarget = resolve(dirname(source), target);
    pathInside(sourceRoot, resolvedTarget, `candidate symbolic link ${relativePath}`);
    if (!existsSync(resolvedTarget)) throw new Error(`candidate symbolic link is dangling: ${relativePath} -> ${target}`);
    const realTarget = realpathSync(resolvedTarget);
    pathInside(sourceRoot, realTarget, `candidate symbolic link ${relativePath}`);
    symlinkSync(target, destination, info.isDirectory() ? "dir" : "file");
    return Buffer.byteLength(target);
  }
  if (!info.isFile()) throw new Error(`candidate entry is not a regular file: ${relativePath}`);
  if (info.size > MAX_CANDIDATE_FILE_BYTES) throw new Error(`candidate file exceeds ${MAX_CANDIDATE_FILE_BYTES} bytes: ${relativePath}`);
  copyFileSync(source, destination);
  chmodSync(destination, info.mode & 0o111 ? 0o555 : 0o444);
  return info.size;
}

function lstatExists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

function freezeDirectories(root: string): void {
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) walk(join(dir, entry.name));
    }
    chmodSync(dir, 0o555);
  };
  walk(root);
}

function makeWritable(root: string): void {
  if (!existsSync(root)) return;
  const walk = (path: string) => {
    const info = lstatSync(path);
    if (info.isSymbolicLink()) return;
    if (info.isDirectory()) {
      chmodSync(path, 0o755);
      for (const name of readdirSync(path)) walk(join(path, name));
    } else {
      chmodSync(path, info.mode | 0o600);
    }
  };
  walk(root);
}

function treeEntries(root: string): string[] {
  const result: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const absolute = join(dir, entry.name);
      if (entry.isDirectory()) walk(absolute);
      else result.push(slash(relative(root, absolute)));
    }
  };
  walk(root);
  return result;
}

export function digestSnapshot(root: string): { digest: string; files: string[]; totalBytes: number } {
  const hash = createHash("sha256");
  const files = treeEntries(root);
  let totalBytes = 0;
  for (const path of files) {
    const absolute = join(root, path);
    const info = lstatSync(absolute);
    const kind = info.isSymbolicLink() ? "120000" : info.mode & 0o111 ? "100755" : "100644";
    const content = info.isSymbolicLink() ? Buffer.from(readlinkSync(absolute)) : readFileSync(absolute);
    totalBytes += content.byteLength;
    hash.update(kind).update("\0").update(path).update("\0").update(content).update("\0");
  }
  return { digest: hash.digest("hex"), files, totalBytes };
}

function parseChanges(raw: string): CandidateChange[] {
  const fields = nulList(raw);
  const out: CandidateChange[] = [];
  for (let i = 0; i < fields.length;) {
    const code = fields[i++];
    const letter = code[0];
    if (letter === "R" || letter === "C") {
      const previousPath = fields[i++];
      const path = fields[i++];
      if (previousPath && path) out.push({ status: letter === "R" ? "renamed" : "copied", previousPath: slash(previousPath), path: slash(path) });
      continue;
    }
    const path = fields[i++];
    if (!path) continue;
    const status: CandidateChangeStatus = letter === "A" ? "added"
      : letter === "D" ? "deleted"
      : letter === "T" ? "type-changed"
      : letter === "U" ? "unmerged"
      : "modified";
    out.push({ status, path: slash(path) });
  }
  return out;
}

function discoverChanges(root: string, baseSha: string): CandidateChange[] {
  const changes = parseChanges(git(root, ["diff", "--name-status", "-z", "-M", baseSha, "--"]));
  const known = new Set(changes.map((change) => change.path));
  for (const path of nulList(git(root, ["ls-files", "-z", "--others", "--exclude-standard"]))) {
    const normalized = slash(path);
    if (!known.has(normalized)) changes.push({ status: "added", path: normalized });
  }
  return changes.sort((a, b) => a.path.localeCompare(b.path) || (a.previousPath ?? "").localeCompare(b.previousPath ?? ""));
}

function buildSnapshot(input: {
  sourceRoot: string;
  projectPath: string;
  source: CandidateSourceKind;
  sourceReference: string;
  repositoryRoot: string;
  baseSha: string;
  headSha: string;
  dirty: boolean;
  changes: CandidateChange[];
  pullRequest?: PullRequestIdentity;
  runtimeProjectRoot: string | null;
  cleanupRoot?: string;
}): CandidateRevision {
  rejectSubmodules(input.sourceRoot);
  const parent = mkdtempSync(join(tmpdir(), "verify-fix-candidate-"));
  const snapshotRoot = join(parent, "repository");
  mkdirSync(snapshotRoot, { recursive: true });
  let totalBytes = 0;
  try {
    const paths = trackedAndUntracked(input.sourceRoot).map(slash).sort();
    for (const path of paths) {
      // Even non-secret templates stay outside the executable snapshot. Real
      // dotenv files are rejected by copyEntry rather than silently ignored.
      if (isAnyDotenv(path) && !isCredentialDotenv(path)) continue;
      totalBytes += copyEntry(input.sourceRoot, snapshotRoot, path);
      if (totalBytes > MAX_CANDIDATE_TOTAL_BYTES) throw new Error(`candidate snapshot exceeds ${MAX_CANDIDATE_TOTAL_BYTES} bytes`);
    }
    const projectPath = safeProjectPath(input.projectPath);
    const projectRoot = resolve(snapshotRoot, projectPath);
    pathInside(snapshotRoot, projectRoot, "candidate project");
    if (!existsSync(projectRoot) || !statSync(projectRoot).isDirectory()) throw new Error(`candidate project directory does not exist in the final tree: ${projectPath}`);
    const measured = digestSnapshot(snapshotRoot);
    freezeDirectories(snapshotRoot);
    const metadata: CandidateRevisionMetadata = {
      source: input.source,
      sourceReference: input.sourceReference,
      repositoryRoot: input.repositoryRoot,
      projectPath,
      baseSha: input.baseSha,
      headSha: input.headSha,
      dirty: input.dirty,
      immutable: true,
      digestAlgorithm: "sha256",
      digest: measured.digest,
      fileCount: measured.files.length,
      totalBytes: measured.totalBytes,
      changes: input.changes,
      ...(input.pullRequest ? { pullRequest: input.pullRequest } : {}),
    };
    let disposed = false;
    return {
      metadata,
      snapshotRoot,
      projectRoot,
      runtimeProjectRoot: input.runtimeProjectRoot,
      files: measured.files,
      assertUnchanged() {
        if (disposed) throw new Error("candidate snapshot was already disposed");
        const current = digestSnapshot(snapshotRoot);
        if (current.digest !== metadata.digest || current.files.length !== metadata.fileCount) {
          throw new Error(`candidate snapshot changed during verification: expected ${metadata.digest}, received ${current.digest}`);
        }
      },
      dispose() {
        if (disposed) return;
        disposed = true;
        try {
          makeWritable(parent);
          rmSync(parent, { recursive: true, force: true });
        } finally {
          if (input.cleanupRoot) rmSync(input.cleanupRoot, { recursive: true, force: true });
        }
      },
    };
  } catch (error) {
    try {
      makeWritable(parent);
      rmSync(parent, { recursive: true, force: true });
    } finally {
      if (input.cleanupRoot) rmSync(input.cleanupRoot, { recursive: true, force: true });
    }
    throw error;
  }
}

export function snapshotLocalCandidate(projectDir: string, baseRef: string): CandidateRevision {
  const requestedProject = resolve(projectDir);
  if (!existsSync(requestedProject) || !statSync(requestedProject).isDirectory()) throw new Error(`candidate project is not a directory: ${requestedProject}`);
  const repositoryRoot = realpathSync(git(requestedProject, ["rev-parse", "--show-toplevel"]));
  const projectRoot = realpathSync(requestedProject);
  const projectPath = pathInside(repositoryRoot, projectRoot, "--candidate-project");
  const baseSha = git(repositoryRoot, ["rev-parse", "--verify", `${baseRef}^{commit}`]);
  const headSha = git(repositoryRoot, ["rev-parse", "--verify", "HEAD^{commit}"]);
  const dirty = git(repositoryRoot, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]).length > 0;
  const changes = discoverChanges(repositoryRoot, baseSha);
  return buildSnapshot({
    sourceRoot: repositoryRoot,
    projectPath,
    source: "local",
    sourceReference: projectRoot,
    repositoryRoot,
    baseSha,
    headSha,
    dirty,
    changes,
    runtimeProjectRoot: projectRoot,
  });
}

export function parseGitHubPullRequestUrl(url: string): { owner: string; repository: string; number: number; url: string } {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`--pr must be a GitHub pull-request URL: ${url}`);
  }
  if (parsed.protocol !== "https:" || parsed.hostname.toLowerCase() !== "github.com") throw new Error(`--pr currently supports only https://github.com pull-request URLs`);
  const match = /^\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/pull\/(\d+)\/?$/.exec(parsed.pathname);
  if (!match || Number(match[3]) < 1) throw new Error(`--pr must look like https://github.com/OWNER/REPO/pull/123`);
  return { owner: match[1], repository: match[2].replace(/\.git$/, ""), number: Number(match[3]), url: `https://github.com/${match[1]}/${match[2].replace(/\.git$/, "")}/pull/${Number(match[3])}` };
}

interface GitHubPullResponse {
  number?: number;
  state?: string;
  html_url?: string;
  base?: { sha?: string; repo?: { full_name?: string } };
  head?: { sha?: string; ref?: string; repo?: { full_name?: string } | null };
}

export function parsePullRequestIdentity(value: unknown, expected?: ReturnType<typeof parseGitHubPullRequestUrl>): PullRequestIdentity {
  const raw = value as GitHubPullResponse;
  const number = Number(raw?.number);
  const baseRepository = raw?.base?.repo?.full_name ?? "";
  const headRepository = raw?.head?.repo?.full_name ?? "";
  const baseSha = raw?.base?.sha ?? "";
  const headSha = raw?.head?.sha ?? "";
  const headRef = raw?.head?.ref ?? "";
  if (!Number.isInteger(number) || !baseRepository || !headRepository || !/^[0-9a-f]{40}$/i.test(baseSha) || !/^[0-9a-f]{40}$/i.test(headSha) || !headRef) {
    throw new Error("GitHub returned incomplete pull-request identity metadata");
  }
  if (expected && (number !== expected.number || baseRepository.toLowerCase() !== `${expected.owner}/${expected.repository}`.toLowerCase())) {
    throw new Error("GitHub pull-request metadata does not match --pr");
  }
  return {
    url: raw.html_url ?? expected?.url ?? "",
    number,
    state: raw.state ?? "unknown",
    baseRepository,
    headRepository,
    baseSha: baseSha.toLowerCase(),
    headSha: headSha.toLowerCase(),
    headRef,
    fork: baseRepository.toLowerCase() !== headRepository.toLowerCase(),
  };
}

export function resolvePullRequestIdentity(url: string): PullRequestIdentity {
  const parsed = parseGitHubPullRequestUrl(url);
  const raw = run("gh", ["api", `repos/${parsed.owner}/${parsed.repository}/pulls/${parsed.number}`]);
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    throw new Error("GitHub returned invalid pull-request metadata");
  }
  return parsePullRequestIdentity(json, parsed);
}

export function snapshotPullRequestCandidate(url: string, projectPath = "."): CandidateRevision {
  const pull = resolvePullRequestIdentity(url);
  if (pull.state !== "open") throw new Error(`pull request ${pull.url} is ${pull.state}; only an open PR can be verified`);
  const checkoutParent = mkdtempSync(join(tmpdir(), "verify-fix-pr-source-"));
  const sourceRoot = join(checkoutParent, "repository");
  try {
    run("gh", ["repo", "clone", pull.baseRepository, sourceRoot, "--", "--no-checkout", "--filter=blob:none"]);
    git(sourceRoot, ["fetch", "--no-tags", "--depth=1", "origin", pull.baseSha]);
    git(sourceRoot, ["fetch", "--no-tags", "--depth=1", "origin", `+refs/pull/${pull.number}/head:refs/verify-fix/pr-head`]);
    const fetchedHead = git(sourceRoot, ["rev-parse", "refs/verify-fix/pr-head^{commit}"]).toLowerCase();
    if (fetchedHead !== pull.headSha) throw new Error(`pull request moved while it was being pinned: started at ${pull.headSha}, fetched ${fetchedHead}; start a new run`);
    git(sourceRoot, ["checkout", "--detach", "--force", pull.headSha]);
    const checkedOut = git(sourceRoot, ["rev-parse", "HEAD^{commit}"]).toLowerCase();
    if (checkedOut !== pull.headSha) throw new Error(`candidate checkout ${checkedOut} does not equal PR head ${pull.headSha}`);
    const changes = parseChanges(git(sourceRoot, ["diff", "--name-status", "-z", "-M", pull.baseSha, pull.headSha, "--"]));
    return buildSnapshot({
      sourceRoot,
      projectPath: safeProjectPath(projectPath),
      source: "github-pr",
      sourceReference: pull.url,
      repositoryRoot: pull.baseRepository,
      baseSha: pull.baseSha,
      headSha: pull.headSha,
      dirty: false,
      changes,
      pullRequest: pull,
      runtimeProjectRoot: null,
      cleanupRoot: checkoutParent,
    });
  } catch (error) {
    rmSync(checkoutParent, { recursive: true, force: true });
    throw error;
  }
}

export function assertPullRequestStillCurrent(revision: CandidateRevision): void {
  if (revision.metadata.source !== "github-pr" || !revision.metadata.pullRequest) return;
  const current = resolvePullRequestIdentity(revision.metadata.pullRequest.url);
  if (current.headSha !== revision.metadata.headSha) {
    throw new Error(`pull request moved during verification: pinned ${revision.metadata.headSha}, now ${current.headSha}; start a new run`);
  }
}

export function loadDeploymentMetadata(path: string): DeploymentMetadata {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(resolve(path), "utf8"));
  } catch (error) {
    throw new Error(`could not read --target-metadata: ${(error as Error).message}`);
  }
  const value = raw as Partial<DeploymentMetadata>;
  if (!value || typeof value.provider !== "string" || !value.provider || typeof value.deploymentId !== "string" || !value.deploymentId || typeof value.revision !== "string" || !value.revision || typeof value.url !== "string" || !/^https?:\/\//.test(value.url)) {
    throw new Error("--target-metadata must contain provider, deploymentId, revision, and an http(s) url");
  }
  return { provider: value.provider, deploymentId: value.deploymentId, revision: value.revision, url: value.url.replace(/\/+$/, ""), ...(typeof value.environment === "string" ? { environment: value.environment } : {}) };
}

export function bindCandidateTarget(input: {
  revision: CandidateRevision;
  target: string | null;
  targetRevision: string | null;
  deployment: DeploymentMetadata | null;
  executor: "scene" | "hybrid";
  cloudApproved: boolean;
  allowForkCloud: boolean;
}): CandidateTargetBinding {
  const sourceRevision = input.revision.metadata.headSha;
  const targetUrl = input.target?.replace(/\/+$/, "") ?? null;
  const targetRevision = input.targetRevision?.toLowerCase() ?? null;
  if (input.revision.metadata.source === "github-pr" && input.executor === "hybrid") {
    if (!input.cloudApproved) throw new Error("pull-request cloud verification requires --cloud-approved after protected-environment approval");
    if (input.revision.metadata.pullRequest?.fork && !input.allowForkCloud) throw new Error("fork pull requests cannot receive cloud credentials without both protected approval and --allow-fork-cloud");
    if (!targetRevision || targetRevision !== sourceRevision) throw new Error(`--target-revision must equal the pinned PR head ${sourceRevision}`);
  }
  if (input.deployment) {
    if (!targetUrl || input.deployment.url !== targetUrl) throw new Error("deployment metadata URL does not equal --target");
    if (!targetRevision || input.deployment.revision.toLowerCase() !== targetRevision) throw new Error("deployment metadata revision does not equal --target-revision");
    if (input.revision.metadata.source === "github-pr" && input.deployment.revision.toLowerCase() !== sourceRevision) throw new Error("deployment metadata revision does not equal the pinned PR head");
  }
  const exactRevision = input.revision.metadata.source === "github-pr" && targetRevision === sourceRevision && input.deployment?.revision.toLowerCase() === sourceRevision;
  const forkApproved = !input.revision.metadata.pullRequest?.fork || input.allowForkCloud;
  const gateEligible = input.revision.metadata.source === "github-pr" && input.executor === "hybrid" && exactRevision && input.cloudApproved && forkApproved;
  const reason = input.revision.metadata.source === "local"
    ? "local snapshot evidence cannot satisfy the protected pull-request gate"
    : gateEligible
      ? "immutable PR head and deployment metadata identify the same revision"
      : !input.deployment
        ? "deployment metadata was not supplied; this run is not authoritative"
        : input.executor !== "hybrid"
          ? "scene-only verification is not an authoritative cloud gate"
          : "the protected gate requirements were not met";
  return {
    scope: input.revision.metadata.source === "local" ? "local" : "pull-request",
    sourceRevision,
    targetRevision,
    targetUrl,
    deployment: input.deployment,
    exactRevision,
    cloudApproved: input.cloudApproved,
    forkApproved,
    gateEligible,
    reason,
  };
}
