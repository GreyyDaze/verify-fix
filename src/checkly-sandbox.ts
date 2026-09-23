// Checkly CLI boundary for Phase 5.
//
// Dependency metadata plus the restricted monitoring file set are copied.
// App source, build output, local dotenv files, registry credentials, and
// Vercel state stay out. The customer's own `checkly` binary executes that
// copy on Checkly's cloud runners. Runtime values live in a temporary
// dotenv file outside the copied project and are deleted with the sandbox.

import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, normalize, resolve } from "node:path";
import type { TraceStep } from "./types.ts";

export interface ChecklySandboxContext {
  projectDir: string;
  files: Record<string, string>;
  target: string;
  targetRevision?: string;
  env?: Record<string, string>;
  location: string;
  checkName: string;
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
  raw: string;
}

const PROJECT_METADATA = /^(?:package\.json|package-lock\.json|npm-shrinkwrap\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb?|(?:tsconfig|jsconfig)(?:\.[^.]+)*\.json)$/;

function safeRelativePath(path: string): string {
  const value = normalize(path).replaceAll("\\", "/");
  if (value.startsWith("/") || value === ".." || value.startsWith("../")) throw new Error(`unsafe candidate file path: ${path}`);
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

function resultId(link: string | null | undefined): string | null {
  if (!link) return null;
  const value = /\/results\/([^/?#]+)/.exec(link)?.[1];
  return value ? decodeURIComponent(value) : null;
}

/** Parse the file written by Checkly's JSON reporter. */
export function parseChecklyReport(raw: string, exitCode: number | null, stderr = "", wallTimeMs = 0): ChecklySandboxOutcome {
  let report: ChecklyJsonReport;
  try {
    report = JSON.parse(raw) as ChecklyJsonReport;
  } catch {
    const detail = (stderr.trim().split("\n").at(-1) || "no JSON report").slice(0, 400);
    return { passed: false, inconclusive: true, reason: `Checkly produced no JSON report: ${detail}`, testSessionId: null, checkResultIds: [], cloudRuns: 0, trace: [], exitCode, wallTimeMs, raw };
  }

  const checks = Array.isArray(report.checks) ? report.checks : [];
  const trace: TraceStep[] = checks.map((check, index) => ({
    index,
    kind: "step",
    what: `Checkly ${report.runLocation ?? "unknown location"}: ${check.name ?? "unnamed check"} → ${check.result ?? "unknown"}${check.runError ? ` — ${String(check.runError).slice(0, 240)}` : ""}`,
    outcome: check.result === "Pass" ? "ok" : check.result === "Fail" || check.result === "Degraded" ? "failed" : "skipped",
  }));

  if (!report.testSessionId) {
    return { passed: false, inconclusive: true, reason: "Checkly JSON has no recorded testSessionId", testSessionId: null, checkResultIds: [], cloudRuns: checks.length, trace, exitCode, wallTimeMs, raw };
  }
  if (!Number.isInteger(report.numChecks) || report.numChecks === 0 || checks.length === 0) {
    return { passed: false, inconclusive: true, reason: "Checkly ran zero checks", testSessionId: report.testSessionId, checkResultIds: [], cloudRuns: 0, trace, exitCode, wallTimeMs, raw };
  }
  if (report.numChecks !== checks.length) {
    return { passed: false, inconclusive: true, reason: `Checkly JSON is incomplete: expected ${report.numChecks} check result(s), received ${checks.length}`, testSessionId: report.testSessionId, checkResultIds: checks.map((c) => resultId(c.link)).filter((v): v is string => Boolean(v)), cloudRuns: checks.length, trace, exitCode, wallTimeMs, raw };
  }
  const checkResultIds = checks.map((check) => resultId(check.link)).filter((value): value is string => Boolean(value));
  if (checkResultIds.length !== checks.length) {
    return { passed: false, inconclusive: true, reason: "Checkly JSON has a recorded session but no result id for every check", testSessionId: report.testSessionId, checkResultIds, cloudRuns: checks.length, trace, exitCode, wallTimeMs, raw };
  }
  const retried = checks.filter((check) => (check.retries ?? 0) !== 0);
  if (retried.length > 0) {
    return { passed: false, inconclusive: true, reason: `Checkly reported unexpected retries for ${retried.map((c) => c.name ?? "unnamed check").join(", ")}`, testSessionId: report.testSessionId, checkResultIds: checks.map((c) => resultId(c.link)).filter((v): v is string => Boolean(v)), cloudRuns: checks.length, trace, exitCode, wallTimeMs, raw };
  }
  const unknown = checks.filter((check) => !["Pass", "Fail", "Degraded"].includes(check.result ?? ""));
  if (unknown.length > 0) {
    return { passed: false, inconclusive: true, reason: `Checkly check did not finish: ${unknown.map((c) => `${c.name ?? "unnamed"} (${c.result ?? "unknown"})`).join(", ")}`, testSessionId: report.testSessionId, checkResultIds: checks.map((c) => resultId(c.link)).filter((v): v is string => Boolean(v)), cloudRuns: checks.length, trace, exitCode, wallTimeMs, raw };
  }
  if (exitCode === null || (exitCode !== 0 && checks.every((check) => check.result === "Pass"))) {
    return { passed: false, inconclusive: true, reason: `Checkly CLI ended with ${exitCode === null ? "no exit code" : `exit ${exitCode}`} despite completed passing checks`, testSessionId: report.testSessionId, checkResultIds: checks.map((c) => resultId(c.link)).filter((v): v is string => Boolean(v)), cloudRuns: checks.length, trace, exitCode, wallTimeMs, raw };
  }

  const passed = exitCode === 0 && checks.every((check) => check.result === "Pass");
  return {
    passed,
    inconclusive: false,
    reason: null,
    testSessionId: report.testSessionId,
    checkResultIds: checks.map((check) => resultId(check.link)).filter((value): value is string => Boolean(value)),
    cloudRuns: checks.length,
    trace,
    exitCode,
    wallTimeMs,
    raw,
  };
}

export async function runChecklySandbox(ctx: ChecklySandboxContext): Promise<ChecklySandboxOutcome> {
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
    if (!existsSync(join(candidateDir, "checkly.config.ts")) && !existsSync(join(candidateDir, "checkly.config.js")) && !existsSync(join(candidateDir, "checkly.config.mjs"))) {
      throw new Error("candidate project has no checkly.config.ts/js/mjs");
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
    const childResult = await new Promise<{ code: number | null; stderr: string }>((done) => {
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
      let stderr = "";
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
      child.stderr.on("data", (chunk) => (stderr += String(chunk)));
      child.on("error", (error) => {
        clearTimeout(timer);
        done({ code: null, stderr: `${stderr}\n${String(error)}` });
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        if (timedOut) stderr += `\nCheckly timeout after ${ctx.timeoutMs ?? 15 * 60_000}ms`;
        done({ code, stderr });
      });
    });
    const wallTimeMs = Date.now() - startedAt;
    const raw = existsSync(reportFile) ? readFileSync(reportFile, "utf8") : "";
    const outcome = parseChecklyReport(raw, childResult.code, childResult.stderr, wallTimeMs);
    if (!outcome.inconclusive) {
      const report = JSON.parse(raw) as ChecklyJsonReport;
      if (report.runLocation !== ctx.location) {
        return { ...outcome, passed: false, inconclusive: true, reason: `Checkly reported location ${report.runLocation ?? "missing"}; expected ${ctx.location}` };
      }
      const wrongChecks = (report.checks ?? []).filter((check) => check.name !== ctx.checkName);
      if (wrongChecks.length > 0) {
        return { ...outcome, passed: false, inconclusive: true, reason: `Checkly ran an unexpected check; expected exactly ${ctx.checkName}` };
      }
    }
    return outcome;
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
