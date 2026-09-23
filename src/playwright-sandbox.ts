// Playwright sandbox — runs a captured Playwright check without changing it.
//
// The bundle's check/ tree is copied to a temporary directory. The candidate
// files replace their captured versions there. The customer's own
// @playwright/test install is resolved from --project, then its CLI runs with
// one worker, no retries, and the JSON reporter. ENVIRONMENT_URL points at the
// scene proxy, not directly at the app.
//
// A non-zero exit is a valid observed check failure when the JSON report is
// present. Missing reports, zero tests, skipped/interrupted tests, and runner
// crashes are inconclusive and must never become PASS or FAIL evidence.

import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, normalize, resolve } from "node:path";
import type { TraceStep } from "./types.ts";
import { SEED_MODULE } from "./sandbox.ts";

export interface PlaywrightSandboxContext {
  baseUrl: string;
  environmentName?: string;
  env?: Record<string, string>;
  timeoutMs?: number;
  /** Directory whose node_modules contains the customer's @playwright/test. */
  projectDir: string;
  configFile: string;
  projects?: string[];
  /** Every file under bundle check/, after applying the candidate patch. */
  files: Record<string, string>;
  /** Main spec path under check/. */
  checkFile: string;
  /** Reproducible Math.random in the Playwright runner process. */
  seed?: number;
  /** Optional custom Chromium/Chrome binary. Normal users do not need this. */
  browserExecutablePath?: string;
}

export interface PlaywrightTestResult {
  title: string;
  status: string;
  error: string | null;
}

export interface PlaywrightSandboxOutcome {
  passed: boolean;
  inconclusive: boolean;
  reason: string | null;
  tests: PlaywrightTestResult[];
  trace: TraceStep[];
  exitCode: number | null;
  raw: string;
}

interface JsonResult {
  status?: string;
  error?: { message?: string; stack?: string };
  errors?: Array<{ message?: string; stack?: string }>;
}
interface JsonTest {
  projectName?: string;
  results?: JsonResult[];
}
interface JsonSpec {
  title?: string;
  tests?: JsonTest[];
}
interface JsonSuite {
  title?: string;
  suites?: JsonSuite[];
  specs?: JsonSpec[];
}
interface JsonReport {
  suites?: JsonSuite[];
  errors?: Array<{ message?: string; stack?: string }>;
}

function safeRelativePath(path: string): string {
  const n = normalize(path).replaceAll("\\", "/");
  if (isAbsolute(n) || n === ".." || n.startsWith("../")) throw new Error(`unsafe file path in bundle: ${path}`);
  return n.replace(/^\.\//, "");
}

/** Resolve from the customer's project. The tool does not download a second Playwright. */
export function resolvePlaywrightCli(projectDir: string): string {
  const require = createRequire(join(projectDir, "package.json"));
  try {
    return require.resolve("@playwright/test/cli");
  } catch {
    throw new Error(`@playwright/test was not found under --project ${projectDir}; install the project's dependencies first`);
  }
}

function collectTests(report: JsonReport): PlaywrightTestResult[] {
  const out: PlaywrightTestResult[] = [];
  const walk = (suite: JsonSuite, parents: string[]) => {
    const here = suite.title ? [...parents, suite.title] : parents;
    for (const spec of suite.specs ?? []) {
      for (const test of spec.tests ?? []) {
        const last = test.results?.at(-1);
        const err = last?.error?.message ?? last?.errors?.[0]?.message ?? null;
        const project = test.projectName ? `[${test.projectName}] ` : "";
        out.push({ title: `${project}${[...here, spec.title ?? "unnamed test"].filter(Boolean).join(" › ")}`, status: last?.status ?? "not-run", error: err });
      }
    }
    for (const child of suite.suites ?? []) walk(child, here);
  };
  for (const suite of report.suites ?? []) walk(suite, []);
  return out;
}

/** Exported so report classification is tested without needing a browser binary. */
export function parsePlaywrightReport(raw: string, exitCode: number | null, stderr = ""): PlaywrightSandboxOutcome {
  let report: JsonReport;
  try {
    report = JSON.parse(raw) as JsonReport;
  } catch {
    const detail = (stderr.trim().split("\n").at(-1) ?? raw.trim().slice(0, 300) ?? "no output").slice(0, 400);
    return { passed: false, inconclusive: true, reason: `Playwright produced no JSON report: ${detail}`, tests: [], trace: [], exitCode, raw };
  }
  const tests = collectTests(report);
  const trace: TraceStep[] = tests.map((t, index) => ({
    index,
    kind: "step",
    what: `Playwright ${t.title}: ${t.status}${t.error ? ` — ${t.error.split("\n")[0].replace(/^Error:\s*/, "").slice(0, 240)}` : ""}`,
    outcome: t.status === "passed" ? "ok" : t.status === "failed" || t.status === "timedOut" ? "failed" : "skipped",
  }));
  if (tests.length === 0) {
    const top = report.errors?.[0]?.message ?? stderr.trim().split("\n").at(-1) ?? "the report contains zero tests";
    return { passed: false, inconclusive: true, reason: `Playwright ran no test: ${top.slice(0, 400)}`, tests, trace, exitCode, raw };
  }
  const nonEvidence = tests.filter((t) => !["passed", "failed", "timedOut"].includes(t.status));
  if (nonEvidence.length > 0) {
    return { passed: false, inconclusive: true, reason: `Playwright test did not finish: ${nonEvidence.map((t) => `${t.title} (${t.status})`).join(", ")}`, tests, trace, exitCode, raw };
  }
  const passed = exitCode === 0 && tests.every((t) => t.status === "passed");
  return { passed, inconclusive: false, reason: null, tests, trace, exitCode, raw };
}

function wrapperSource(configFile: string): string {
  const rel = "./" + safeRelativePath(configFile);
  return [
    `import original from ${JSON.stringify(rel)}`,
    `const path = process.env.VERIFY_FIX_BROWSER_PATH`,
    `if (path) {`,
    `  const cfg = original as any`,
    `  const projects = cfg.projects?.length ? cfg.projects : [{ name: "chromium" }]`,
    `  cfg.projects = projects.map((project: any) => ({`,
    `    ...project,`,
    `    use: { ...project.use, launchOptions: { ...project.use?.launchOptions, executablePath: path, args: [...(project.use?.launchOptions?.args ?? []), "--no-sandbox"] } },`,
    `  }))`,
    `}`,
    `export default original`,
    ``,
  ].join("\n");
}

export async function runPlaywrightSandbox(ctx: PlaywrightSandboxContext): Promise<PlaywrightSandboxOutcome> {
  const projectDir = resolve(ctx.projectDir);
  const cli = resolvePlaywrightCli(projectDir);
  const nodeModules = join(projectDir, "node_modules");
  if (!existsSync(nodeModules)) throw new Error(`node_modules not found under --project ${projectDir}; install the project's dependencies first`);
  const dir = await mkdtemp(join(tmpdir(), "verify-fix-playwright-"));
  try {
    for (const [rawPath, content] of Object.entries(ctx.files)) {
      const path = safeRelativePath(rawPath);
      const dest = join(dir, path);
      await mkdir(dirname(dest), { recursive: true });
      await writeFile(dest, content, "utf8");
    }
    if (!existsSync(join(dir, safeRelativePath(ctx.checkFile)))) throw new Error(`main Playwright spec ${ctx.checkFile} is missing from the candidate files`);
    if (!existsSync(join(dir, safeRelativePath(ctx.configFile)))) throw new Error(`Playwright config ${ctx.configFile} is missing from the bundle`);
    await symlink(nodeModules, join(dir, "node_modules"), "junction");
    const seedFile = join(dir, "verify-fix-seed.mjs");
    await writeFile(seedFile, SEED_MODULE, "utf8");

    const config = ctx.browserExecutablePath ? "verify-fix.playwright.config.ts" : safeRelativePath(ctx.configFile);
    if (ctx.browserExecutablePath) await writeFile(join(dir, config), wrapperSource(ctx.configFile), "utf8");
    const args = [cli, "test", "--config", join(dir, config), "--workers=1", "--retries=0", "--reporter=json"];
    for (const project of ctx.projects ?? []) args.push("--project", project);

    const childResult = await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve) => {
      const child = spawn(process.execPath, args, {
        cwd: dir,
        env: {
          PATH: process.env.PATH ?? "",
          HOME: process.env.HOME ?? "",
          NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --import=${seedFile}`.trim(),
          LD_LIBRARY_PATH: process.env.LD_LIBRARY_PATH ?? "",
          CI: "1",
          ...(ctx.env ?? {}),
          ENVIRONMENT_URL: ctx.baseUrl,
          ENVIRONMENT_NAME: ctx.environmentName ?? "verify-fix",
          VERIFY_FIX_BROWSER_PATH: ctx.browserExecutablePath ?? "",
          SANDBOX_SEED: ctx.seed === undefined ? "" : String(ctx.seed >>> 0),
        },
        stdio: ["ignore", "pipe", "pipe"],
        detached: process.platform !== "win32",
      });
      let stdout = "";
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
      }, ctx.timeoutMs ?? 90_000);
      child.stdout.on("data", (d) => (stdout += String(d)));
      child.stderr.on("data", (d) => (stderr += String(d)));
      child.on("error", (err) => {
        clearTimeout(timer);
        resolve({ code: null, stdout, stderr: `${stderr}\n${String(err)}` });
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        if (timedOut) stderr += `\nPlaywright timeout after ${ctx.timeoutMs ?? 90_000}ms`;
        resolve({ code, stdout, stderr });
      });
    });
    return parsePlaywrightReport(childResult.stdout, childResult.code, childResult.stderr);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
