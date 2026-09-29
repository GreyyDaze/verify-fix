// Checkly CLI boundary for Phase 5.
//
// Dependency metadata plus the restricted monitoring file set are copied.
// App source, build output, local dotenv files, registry credentials, and
// Vercel state stay out. The customer's own `checkly` binary executes that
// copy on Checkly's cloud runners. Runtime values live in a temporary
// dotenv file outside the copied project and are deleted with the sandbox.

import { spawn } from "node:child_process";
import { closeSync, constants, existsSync, fstatSync, lstatSync, openSync, readSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, normalize, resolve } from "node:path";
import type { TraceStep } from "./types.ts";
import { rawJsonUniqueKeys, rawTreeBounded } from "./multistep/raw-evidence.ts";
import { trustedAutomationBypass } from "./multistep/accounts.ts";

export interface ChecklySandboxContext {
  projectDir: string;
  files: Record<string, string>;
  assets?: Record<string, Uint8Array>;
  target: string;
  targetRevision?: string;
  env?: Record<string, string>;
  location: string;
  checkName: string;
  checkType?: string;
  testSessionName: string;
  timeoutMs?: number;
}

export interface ChecklyJsonCheck {
  result?: string;
  name?: string;
  checkType?: string;
  durationMilliseconds?: number | null;
  filename?: string | null;
  link?: string | null;
  runError?: unknown;
  retries?: number;
}

export interface ChecklyJsonReport {
  testSessionId?: string;
  numChecks?: number;
  runLocation?: string;
  checks?: ChecklyJsonCheck[];
}

export interface ChecklySandboxOutcome {
  passed: boolean;
  inconclusive: boolean;
  reason: string | null;
  testSessionId: string | null;
  checkResultIds: string[];
  cloudRuns: number;
  trace: TraceStep[];
  exitCode: number | null;
  wallTimeMs: number;
}

const PROJECT_METADATA = /^(?:package\.json|package-lock\.json|npm-shrinkwrap\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb?|(?:tsconfig|jsconfig)(?:\.[^.]+)*\.json)$/;

function safeRelativePath(path: string): string {
  const value = normalize(path.replaceAll("\\", "/"));
  if (/[\x00-\x1f\x7f]/.test(path) || value.startsWith("/") || value === ".." || value.startsWith("../")) {
    throw new Error("CHECKLY_SANDBOX_FILE_PATH_INVALID");
  }
  return value.replace(/^\.\//, "");
}

/** Copy dependency/compiler metadata only. Monitoring source comes from the
 * already restricted candidate patch. App source, dotenv files, registry
 * credentials, build output, and Vercel state never enter the CLI sandbox. */
async function copyProjectMetadata(source: string, destination: string): Promise<void> {
  await mkdir(destination, { recursive: true });
  for (const entry of await readdir(source, { withFileTypes: true })) {
    if (!entry.isFile() || !PROJECT_METADATA.test(entry.name)) continue;
    await writeFile(join(destination, entry.name), await readFile(join(source, entry.name)));
  }
}

function dotenv(env: Record<string, string>): string {
  return Object.entries(env)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}=${JSON.stringify(value)}`)
    .join("\n") + "\n";
}

export function resolveChecklyCli(projectDir: string): string {
  const file = join(resolve(projectDir), "node_modules", ".bin", process.platform === "win32" ? "checkly.cmd" : "checkly");
  if (!existsSync(file)) throw new Error(`checkly CLI was not found under --project ${projectDir}; install the project's dependencies first`);
  return file;
}

const ID = /^[a-zA-Z0-9_-]{1,128}$/;
const REPORT_MAX_BYTES = 256 * 1024;

function resultId(link: unknown, session: string, account?: string): string | null {
  if (typeof link !== "string" || link.length > 512) return null;
  try {
    const url = new URL(link);
    // Verified against the locally installed Checkly JSON reporter: its
    // recorded result link is account-scoped, not /test-sessions/<id>/....
    const match = /^\/accounts\/([a-zA-Z0-9_-]+)\/test-sessions\/([a-zA-Z0-9_-]+)\/results\/([a-zA-Z0-9_-]+)$/.exec(url.pathname);
    return url.protocol === "https:" && url.host === "app.checklyhq.com" && !url.search && !url.hash
      && !url.username && !url.password && match && ID.test(match[1]!) && match[2] === session
      && (!account || match[1] === account) && ID.test(match[3]!) ? match[3]! : null;
  } catch { return null; }
}

export interface ChecklyReportExpectation {
  name: string;
  location: string;
  checkType: string;
  accountId?: string;
}

/** Admit exactly ONE recorded, unretried, named result at the requested
 * location. The Checkly JSON file is an untrusted structured input, never
 * report text. No raw stdout, stderr, URLs or runError is returned. */
export function parseChecklyReport(raw: string, exitCode: number | null, _stderr = "", wallTimeMs = 0,
  expected?: ChecklyReportExpectation): ChecklySandboxOutcome {
  const invalid = (reason: string): ChecklySandboxOutcome => ({
    passed: false, inconclusive: true, reason, testSessionId: null, checkResultIds: [],
    cloudRuns: 0, trace: [], exitCode, wallTimeMs,
  });
  if (Buffer.byteLength(raw, "utf8") > REPORT_MAX_BYTES || !raw) return invalid("Checkly structured report is absent or exceeds its bound");
  let parsed: unknown;
  try { parsed = JSON.parse(raw); }
  catch { return invalid("Checkly structured report is not valid JSON"); }
  if (!rawJsonUniqueKeys(raw) || !rawTreeBounded(parsed)
    || !parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return invalid("Checkly structured report schema is invalid or ambiguous");
  }
  const report = parsed as ChecklyJsonReport;
  if (!ID.test(report.testSessionId ?? "") || report.numChecks !== 1
    || !Array.isArray(report.checks) || report.checks.length !== 1
    || typeof report.runLocation !== "string" || !/^[a-z0-9-]{1,32}$/.test(report.runLocation)) {
    return invalid("Checkly structured report lacks exactly one recorded check at a valid location");
  }
  const check = report.checks[0]!;
  const session = report.testSessionId!;
  const id = resultId(check.link, session, expected?.accountId);
  if (!id || check.runError !== null && check.runError !== undefined
    || !["Pass", "Fail"].includes(check.result ?? "")
    || !Number.isSafeInteger(check.retries) || check.retries !== 0
    || expected && (report.runLocation !== expected.location || check.name !== expected.name
      || expected.checkType === "MULTI_STEP" && check.checkType !== "MULTI_STEP")) {
    return invalid("Checkly structured result identity, status or retry evidence is invalid");
  }
  if (expected?.checkType === "MULTI_STEP") {
    const filename = check.filename?.replaceAll("\\", "/");
    if (filename !== "checks/multistep-booking.check.ts") {
      return invalid("Checkly structured result has no canonical Multistep source filename");
    }
  }
  if (check.result === "Pass" ? exitCode !== 0 : exitCode !== 1) {
    return invalid("Checkly CLI exit status contradicts the structured result");
  }
  return {
    passed: check.result === "Pass", inconclusive: false, reason: null, testSessionId: session,
    checkResultIds: [id], cloudRuns: 1, exitCode, wallTimeMs,
    trace: [{ index: 0, kind: "step", what: `Checkly ${report.runLocation}: one recorded check → ${check.result}`,
      outcome: check.result === "Pass" ? "ok" : "failed" }],
  };
}

/** Descriptor-checked, finite read of the private reporter file. An
 * untrusted CLI must not be able to symlink it to another workspace file. */
function boundedReport(path: string): string {
  try {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > REPORT_MAX_BYTES) return "";
    const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      const opened = fstatSync(fd);
      if (!opened.isFile() || opened.nlink !== 1 || opened.size > REPORT_MAX_BYTES) return "";
      const buf = Buffer.alloc(opened.size);
      let count = 0;
      while (count < buf.length) {
        const n = readSync(fd, buf, count, buf.length - count, null);
        if (n === 0) return "";
        count += n;
      }
      return fstatSync(fd).size === opened.size ? buf.toString("utf8") : "";
    } finally { closeSync(fd); }
  } catch { return ""; }
}

export async function runChecklySandbox(ctx: ChecklySandboxContext): Promise<ChecklySandboxOutcome> {
  const unavailable: ChecklySandboxOutcome = { passed: false, inconclusive: true,
    reason: "Checkly sandbox identity, target or account inputs are unavailable", testSessionId: null,
    checkResultIds: [], cloudRuns: 0, trace: [], exitCode: null, wallTimeMs: 0 };
  // No child and no transmitted key without an explicit, matched Checkly
  // account. Browser/API siblings cannot supply a fallback account.
  if (!process.env.CHECKLY_API_KEY || !/^[A-Za-z0-9_-]{1,128}$/.test(process.env.CHECKLY_ACCOUNT_ID ?? "")
    || !/^[a-z0-9-]{1,32}$/.test(ctx.location)
    || !/^[^\x00-\x1f\x7f]{1,128}$/.test(ctx.checkName)
    || !/^https:\/\/[^\s]+$/.test(ctx.target)) return unavailable;
  if (ctx.checkType === "MULTI_STEP") {
    const env = ctx.env ?? {};
    const selected = ctx.location === "us-east-1" ? "MULTISTEP_USER_US_EAST_1"
      : ctx.location === "eu-west-1" ? "MULTISTEP_USER_EU_WEST_1" : null;
    const approved = new Set([selected, "CHECKLY_SECRET_VERCEL_AUTOMATION_BYPASS_SECRET", "ENVIRONMENT_NAME"]);
    if (!selected || typeof env[selected] !== "string" || !env[selected]
      || env[selected] !== env[selected].trim() || env[selected].length > 512
      || /[\x00-\x1f\x7f]/.test(env[selected]) || !trustedAutomationBypass(env)
      || Object.keys(env).some((key) => !approved.has(key))) return unavailable;
  }
  try {
    const target = new URL(ctx.target);
    if (target.origin !== ctx.target && `${target.origin}/` !== ctx.target || target.username || target.password
      || target.search || target.hash) return unavailable;
  } catch { return unavailable; }
  const projectDir = resolve(ctx.projectDir);
  const cli = resolveChecklyCli(projectDir);
  const nodeModules = join(projectDir, "node_modules");
  const root = await mkdtemp(join(tmpdir(), "verify-fix-checkly-"));
  const candidateDir = join(root, "project");
  const envFile = join(root, "runtime.env");
  const reportFile = join(root, "checkly-report.json");

  try {
    await copyProjectMetadata(projectDir, candidateDir);
    for (const [rawPath, content] of Object.entries(ctx.files)) {
      const path = safeRelativePath(rawPath);
      if (/(?:^|\/)\.env(?:\.|$)/.test(path) || /(?:^|\/)(?:\.npmrc|\.yarnrc(?:\.yml)?|\.pnpmfile\.cjs)$/.test(path)) {
        throw new Error(`credential-bearing candidate file is not allowed in the Checkly sandbox: ${path}`);
      }
      const destination = join(candidateDir, path);
      await mkdir(dirname(destination), { recursive: true });
      await writeFile(destination, content, "utf8");
    }
    const occupied = new Set(Object.keys(ctx.files).map(safeRelativePath));
    for (const [rawPath, content] of Object.entries(ctx.assets ?? {})) {
      const path = safeRelativePath(rawPath);
      if (occupied.has(path)) throw new Error("CHECKLY_SANDBOX_FILE_COLLISION");
      occupied.add(path);
      if (/(?:^|\/)\.env(?:\.|$)/.test(path) || /(?:^|\/)(?:\.npmrc|\.yarnrc(?:\.yml)?|\.pnpmfile\.cjs)$/.test(path)) {
        throw new Error(`credential-bearing candidate file is not allowed in the Checkly sandbox: ${path}`);
      }
      const destination = join(candidateDir, path);
      await mkdir(dirname(destination), { recursive: true });
      await writeFile(destination, content);
    }
    if (!["checkly.config.ts", "checkly.config.mts", "checkly.config.js", "checkly.config.mjs", "checkly.config.cjs"].some((file) => existsSync(join(candidateDir, file)))) {
      throw new Error("candidate project has no supported checkly.config.* file");
    }
    if (!existsSync(join(candidateDir, "package.json"))) throw new Error("candidate project has no package.json");
    if (!existsSync(nodeModules)) throw new Error(`node_modules not found under --project ${projectDir}; install the project's dependencies first`);
    await symlink(nodeModules, join(candidateDir, "node_modules"), "junction");
    const runtimeEnv: Record<string, string> = { ...(ctx.env ?? {}), ENVIRONMENT_URL: ctx.target };
    for (const key of [
      "CHECKLY", "CHECKLY_RUN_SOURCE", "CHECKLY_REGION", "CHECKLY_CHECK_ID", "CHECK_NAME", "ACCOUNT_ID", "CI",
      "PATH", "HOME", "NODE_OPTIONS", "LD_PRELOAD", "LD_LIBRARY_PATH", "CHECKLY_API_KEY", "CHECKLY_ACCOUNT_ID",
      "CHECKLY_REPORTER_JSON_OUTPUT", "CHECKLY_REPO_SHA", "CHECKLY_TEST_REPO_SHA",
    ]) delete runtimeEnv[key];
    await writeFile(envFile, dotenv(runtimeEnv), { encoding: "utf8", mode: 0o600 });
    await chmod(envFile, 0o600);

    const exactName = `^${ctx.checkName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`;
    const args = [
      "test",
      "--record",
      "--reporter", "json",
      "--retries", "0",
      "--location", ctx.location,
      "--grep", exactName,
      "--test-session-name", ctx.testSessionName,
      "--env-file", envFile,
    ];

    const startedAt = Date.now();
    const childResult = await new Promise<{ code: number | null }>((done) => {
      const child = spawn(cli, args, {
        cwd: candidateDir,
        env: {
          PATH: process.env.PATH ?? "",
          HOME: process.env.HOME ?? "",
          ...runtimeEnv,
          CI: "1",
          CHECKLY_API_KEY: process.env.CHECKLY_API_KEY ?? "",
          CHECKLY_ACCOUNT_ID: process.env.CHECKLY_ACCOUNT_ID ?? "",
          CHECKLY_REPORTER_JSON_OUTPUT: reportFile,
          CHECKLY_REPO_SHA: ctx.targetRevision ?? process.env.CHECKLY_REPO_SHA ?? "",
          CHECKLY_TEST_REPO_SHA: ctx.targetRevision ?? process.env.CHECKLY_TEST_REPO_SHA ?? "",
        },
        stdio: ["ignore", "ignore", "pipe"],
        detached: process.platform !== "win32",
      });
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        try {
          if (process.platform !== "win32" && child.pid) process.kill(-child.pid, "SIGKILL");
          else child.kill("SIGKILL");
        } catch {
          child.kill("SIGKILL");
        }
      }, ctx.timeoutMs ?? 15 * 60_000);
      child.stderr.on("data", () => { /* raw output is never retained */ });
      child.on("error", () => { clearTimeout(timer); done({ code: null }); });
      child.on("close", (code) => { clearTimeout(timer); done({ code: timedOut ? null : code }); });
    });
    const wallTimeMs = Date.now() - startedAt;
    return parseChecklyReport(boundedReport(reportFile), childResult.code, "", wallTimeMs,
      { name: ctx.checkName, location: ctx.location, checkType: ctx.checkType ?? "",
        accountId: process.env.CHECKLY_ACCOUNT_ID });
  } catch {
    return { passed: false, inconclusive: true, reason: "Checkly sandbox execution unavailable",
      testSessionId: null, checkResultIds: [], cloudRuns: 0, trace: [], exitCode: null, wallTimeMs: 0 };
  } finally {
    try { await rm(root, { recursive: true, force: true }); }
    catch { throw new Error("CHECKLY_SANDBOX_CLEANUP_FAILED"); }
  }
}
