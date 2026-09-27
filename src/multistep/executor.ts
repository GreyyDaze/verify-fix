// Multistep executor adapter — runs a MultiStepCheck transaction script
// locally through the customer's own @playwright/test install.
//
// The runner uses Playwright's API request fixture ONLY. This adapter never
// configures or launches a browser: there is no browser executable path, no
// browser project filter, and the candidate script itself is statically
// proven free of browser APIs before the run (staticBrowserFreeScript) — a
// browser-touching script is UNCERTAIN, never silently run. During the run
// `browserProcesses` is MEASURED (descendant process sampling), and the
// static proof plus the measurement together back the no-browser claim.
//
// Evidence comes from structured artifacts — the JSON reporter output
// (normalized through normalizeMultiStepCapture) and the trusted HTTPS
// origin bridge's structured request records — never from raw child-process
// stderr (`diagnostics.stderrBytes` counts bytes only; raw stderr is neither
// retained nor parsed). A missing or unparseable JSON report is inconclusive
// (UNCERTAIN), never PASS/FAIL. For bridged runs, bridge evidence is
// compared against reporter-recorded requests: any mismatch — including a
// zero-request bridge run — is UNCERTAIN, so a run the bridge never saw can
// never PASS.
//
// HTTPS origin boundary: the canonical check requires ENVIRONMENT_URL to be
// a bare https origin, while scene targets listen on plain http. For http
// targets this adapter starts the trusted origin bridge
// (src/multistep/origin-bridge.ts), which replaces ONLY the origin: the
// check receives https://127.0.0.1:<bridge-port> and every request is
// forwarded to the original target with method, path, query, body, and
// headers intact. If the bridge cannot be established safely (no openssl,
// TLS failure), the run is UNCERTAIN — never a relaxed-TLS fallback. https
// targets are also bridged: every run requires independent request evidence.
//
// Runner environment: the child gets a minimal environment — PATH, a FRESH
// empty HOME (removed with the run directory afterwards), a fully replaced
// NODE_OPTIONS (seed import only; the parent's NODE_OPTIONS is never
// inherited), CI, the derived ENVIRONMENT_URL/ENVIRONMENT_NAME/SEED, and —
// only when the bridge runs — NODE_EXTRA_CA_CERTS pointing at the per-run
// CA. LD_LIBRARY_PATH is never inherited. Candidate-supplied env keys that
// collide with these reserved runner keys are rejected as UNCERTAIN before
// anything executes.

import { spawn, execFile } from "node:child_process";
import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, normalize, resolve } from "node:path";
import { promisify } from "node:util";
import ts from "typescript";
import type { TraceStep } from "../types.ts";
import { SEED_MODULE } from "../sandbox.ts";
import { normalizeMultiStepCapture, type MultiStepCapture } from "./normalize.ts";
import { startOriginBridge, type BridgeRequestEvidence, type OriginBridge } from "./origin-bridge.ts";
import { knownRoute, knownStepTitle, routeFromUrl, UNKNOWN_ROUTE } from "./routes.ts";
import { MAX_REPORTER_AUDIT_BYTES, parseReporterAudit, TRUSTED_REQUEST_REPORTER, type ReporterRequestEvidence } from "./reporter.ts";
import { parseMultiStepScript } from "./source.ts";

const execFileAsync = promisify(execFile);

/** Maximum reporter stdout bytes retained as candidate evidence. */
export const MAX_REPORTER_STDOUT_BYTES = 16 * 1024 * 1024;
/** Maximum runner stderr bytes counted (content is never retained). */
export const MAX_STDERR_BYTES = 64 * 1024 * 1024;

/** Reserved runner environment keys — candidate env must not collide. */
const RESERVED_ENV_KEYS = new Set([
  "PATH",
  "HOME",
  "NODE_OPTIONS",
  "NODE_EXTRA_CA_CERTS",
  "LD_LIBRARY_PATH",
  "ENVIRONMENT_URL",
  "ENVIRONMENT_NAME",
  "SANDBOX_SEED",
  "CI",
]);

export interface MultiStepSandboxOptions {
  baseUrl: string;
  environmentName?: string;
  env?: Record<string, string>;
  timeoutMs?: number;
  /** Directory whose node_modules contains the customer's @playwright/test. */
  projectDir: string;
  /** Every UTF-8 file in the final candidate check tree. */
  files: Record<string, string>;
  /** Main Multistep spec path. */
  checkFile: string;
  seed?: number;
}

export interface MultiStepSandboxOutcome {
  passed: boolean;
  inconclusive: boolean;
  reason: string | null;
  trace: TraceStep[];
  /** normalized structured evidence from the JSON reporter output */
  capture: MultiStepCapture | null;
  exitCode: number | null;
  /**
   * Measured browser processes among the run's descendants — the adapter
   * launches none; null when no run happened to measure (never a claim of 0
   * for a run that never started).
   */
  browserProcesses: number | null;
  /** the exact origin the check saw as ENVIRONMENT_URL (always https when a bridge runs) */
  environmentOrigin: string | null;
  /** structured request evidence from the mandatory trusted origin bridge */
  proxyEvidence: BridgeRequestEvidence[];
  /** independent, values-free Playwright reporter request evidence */
  reporterEvidence: ReporterRequestEvidence[];
  /** stderr byte count for diagnostics ONLY — content is never retained or parsed */
  diagnostics: { stderrBytes: number; timedOut: boolean };
}

function safeRelativePath(path: string): string {
  const n = normalize(path).replaceAll("\\", "/");
  if (isAbsolute(n) || n === ".." || n.startsWith("../")) throw new Error("unsafe file path in candidate tree");
  return n.replace(/^\.\//, "");
}

/** Resolve from the customer's project — no second Playwright is downloaded. */
export function resolvePlaywrightCli(projectDir: string): string {
  const require = createRequire(join(projectDir, "package.json"));
  try {
    return require.resolve("@playwright/test/cli");
  } catch {
    throw new Error(`@playwright/test was not found under --project ${projectDir}; install the project's dependencies first`);
  }
}

function traceOf(capture: MultiStepCapture): TraceStep[] {
  return capture.steps.map((step, index) => ({
    index,
    kind: "step" as const,
    what: `test.step '${knownStepTitle(step.title) ?? "<unknown-step>"}': ${step.status}${step.error ? " — step error (details omitted)" : ""}`,
    outcome: step.status === "passed" ? ("ok" as const) : step.status === "failed" ? ("failed" as const) : ("skipped" as const),
  }));
}

const MULTISTEP_CONFIG = `import { defineConfig } from '@playwright/test'

// verify-fix synthesizes this config for local Multistep runs: the API
// request fixture needs no browser project and no launch options.
export default defineConfig({
  testDir: '.',
})
`;

/**
 * Deterministic static proof that a script never requests or launches a
 * browser: no chromium/firefox/webkit/browserType references, no launch or
 * connect calls, no `browser.*` or `page.*` usage. AST-based — comments and
 * strings are not evidence. Used both as a pre-run gate (a browser-touching
 * script is UNCERTAIN, because this adapter never launches one) and as the
 * proof that the canonical API-only spec is browser-free.
 */
export function staticBrowserFreeScript(file: string, source: string): { free: boolean; findings: string[] } {
  const findings: string[] = [];
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, file.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const visit = (node: ts.Node): void => {
    if (ts.isIdentifier(node)) {
      const name = node.text;
      if (name === "chromium" || name === "firefox" || name === "webkit" || name === "browserType" || name === "browser") {
        findings.push(`browser reference \`${name}\` at ${file}:${sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1}`);
      }
    }
    if (ts.isPropertyAccessExpression(node)) {
      const name = node.name.text;
      const receiver = ts.isIdentifier(node.expression) ? node.expression.text : null;
      if (name === "launch" || name === "launchPersistentContext" || name === "connect" || name === "connectOverCDP") {
        findings.push(`browser ${name}() call at ${file}:${sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1}`);
      }
      if (receiver === "page" || receiver === "context" || receiver === "browser") {
        findings.push(`browser \`${receiver}.${name}\` usage at ${file}:${sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1}`);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return { free: findings.length === 0, findings: [...new Set(findings)] };
}

/**
 * Independent observations must agree in ORDER, route, method and (where the
 * JSON report carries it) status. Zero/missing reporter evidence is NEVER a
 * match. Raw paths, query names and values are never interpolated in reasons.
 */
export function bridgeReporterMismatch(
  bridge: BridgeRequestEvidence[], capture: MultiStepCapture, audit: ReporterRequestEvidence[] | null = null,
): string | null {
  const jsonRequests = capture.steps.flatMap((s) => s.requests.map((r) => ({
    method: r.method ?? "OTHER",
    path: r.url ? routeFromUrl(r.url) ?? UNKNOWN_ROUTE : knownRoute(r.path) ?? UNKNOWN_ROUTE,
    status: r.status,
    step: knownStepTitle(s.title) ?? "<unknown-step>",
    originMatches: true,
    hasQuery: Boolean(r.url && (() => { try { return new URL(r.url).search !== ""; } catch { return true; } })()),
  })));
  if (bridge.length === 0) return "the HTTPS origin bridge recorded zero requests — no execution traffic can PASS";
  // The JSON reporter is advisory: Playwright normally filters pw:api steps
  // from it, and an untrusted CLI can print a forged JSON result. The trusted
  // fd-3 reporter is MANDATORY even when the JSON document lists requests.
  if (!audit || audit.length === 0) return "bridge/reporter dedicated request audit missing — no trustworthy execution evidence";
  if (jsonRequests.length > 0 && (audit.length !== jsonRequests.length
    || audit.some((r, i) => r.method !== jsonRequests[i]?.method || r.path !== jsonRequests[i]?.path || r.step !== jsonRequests[i]?.step))) {
    return "bridge/reporter JSON and request-audit evidence disagree — no trustworthy execution evidence";
  }
  const reporter = audit;
  if (bridge.length !== reporter.length) return `bridge/reporter request-count mismatch (bridge ${bridge.length}, reporter ${reporter.length}) — no trustworthy execution evidence`;
  for (let i = 0; i < bridge.length; i++) {
    const b = bridge[i]!;
    const r = reporter[i]!;
    if (!knownRoute(b.path) || !knownRoute(r.path) || b.hasQuery || r.hasQuery || r.originMatches === false || r.step === "<unknown-step>") {
      return `bridge/reporter unrecognized route, origin, query or step at request ${i + 1} — no trustworthy execution evidence`;
    }
    if (b.method !== r.method) return `bridge/reporter method mismatch at request ${i + 1} — no trustworthy execution evidence`;
    if (b.path !== r.path) return `bridge/reporter path mismatch at request ${i + 1} — no trustworthy execution evidence`;
    const expectedStep: Record<string, string> = { "/api/login": "login", "/api/session": "session", "/api/slots": "slots", "/api/book": "book 09:30" };
    if (r.step !== expectedStep[r.path] || !capture.steps.some((s) => s.title === r.step)) {
      return `bridge/reporter request-step mismatch at request ${i + 1} — no trustworthy execution evidence`;
    }
    // The dedicated reporter records requests on begin (before a response
    // exists). Bind the HTTP status in the JSON result to the independently
    // measured bridge status; a forged passing response cannot override a
    // real 401/500 while preserving the four request names.
    if (typeof jsonRequests[i]?.status === "number" && b.status !== jsonRequests[i]!.status) {
      return `bridge/reporter status mismatch at request ${i + 1} — no trustworthy execution evidence`;
    }
    // The baseline has hard status-200 assertions for all four requests. On
    // real Playwright JSON output pw:api steps may be filtered out, so a
    // fabricated passing assertion must not overrule a bridge-observed 401.
    if (capture.kind === "passing" && b.status !== 200) {
      return `bridge/reporter passing result contradicts HTTP status at request ${i + 1} — no trustworthy execution evidence`;
    }
    const needsAuthorization = b.path === "/api/session" || b.path === "/api/book";
    if (b.authorization !== needsAuthorization) {
      return `bridge/reporter authorization-site mismatch at request ${i + 1} — no trustworthy execution evidence`;
    }
  }
  return null;
}

const BROWSER_ARGS_RE = /(?:^|[\s/])(?:headless_shell|chrome|chromium|firefox|webkit|MiniBrowser)(?:[\s/]|$)|--headless\b/i;

/** Count browser-like processes among the descendants of `rootPid`. */
async function countBrowserProcesses(rootPid: number): Promise<number | null> {
  try {
    const { stdout } = await execFileAsync("ps", ["-eo", "pid=,ppid=,args="], { maxBuffer: 8 * 1024 * 1024, timeout: 10_000 });
    const rows = stdout.split("\n");
    const byPid = new Map<number, { ppid: number; args: string }>();
    for (const row of rows) {
      const m = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(row);
      if (m) byPid.set(Number(m[1]), { ppid: Number(m[2]), args: m[3] ?? "" });
    }
    // transitive descendants of rootPid
    const descendants = new Set<number>();
    let changed = true;
    while (changed) {
      changed = false;
      for (const [pid, info] of byPid) {
        if (pid === rootPid || descendants.has(pid)) continue;
        if (info.ppid === rootPid || descendants.has(info.ppid)) {
          descendants.add(pid);
          changed = true;
        }
      }
    }
    let count = 0;
    for (const pid of descendants) {
      const info = byPid.get(pid);
      if (info && BROWSER_ARGS_RE.test(info.args)) count += 1;
    }
    return count;
  } catch {
    return null;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export async function runMultiStepSandbox(ctx: MultiStepSandboxOptions): Promise<MultiStepSandboxOutcome> {
  const inconclusive = (reason: string, extra?: Partial<MultiStepSandboxOutcome>): MultiStepSandboxOutcome => ({
    passed: false,
    inconclusive: true,
    reason,
    trace: [],
    capture: null,
    exitCode: null,
    browserProcesses: null,
    environmentOrigin: null,
    proxyEvidence: [],
    reporterEvidence: [],
    diagnostics: { stderrBytes: 0, timedOut: false },
    ...extra,
  });

  // Reserved runner keys must be under this adapter's control — a candidate
  // that tries to set one is UNCERTAIN before anything executes.
  for (const key of Object.keys(ctx.env ?? {})) {
    if (RESERVED_ENV_KEYS.has(key.toUpperCase())) {
      return inconclusive("candidate environment collides with a reserved runner key — no trustworthy execution environment");
    }
  }

  // The candidate spec must be provably API-only: this adapter launches no
  // browser, so a script that references one cannot be executed faithfully.
  let checkFile: string;
  try {
    checkFile = safeRelativePath(ctx.checkFile);
    for (const path of Object.keys(ctx.files)) safeRelativePath(path);
  } catch {
    return inconclusive("Multistep candidate file path is unsafe — no runner was started");
  }
  const checkSource = ctx.files[ctx.checkFile] ?? ctx.files[checkFile];
  if (checkSource === undefined) return inconclusive("Multistep check file is missing — no runner was started");
  const browserFree = staticBrowserFreeScript(checkFile, checkSource);
  if (!browserFree.free) {
    return inconclusive("Multistep script uses browser APIs the adapter never launches — no trustworthy execution evidence");
  }
  const sourceModel = parseMultiStepScript(checkFile, checkSource, new Map(Object.entries(ctx.files)));
  if (sourceModel.errors.length > 0) return inconclusive("Multistep source is unsupported before execution — no runner was started");

  // Dependency lookup is also an evidence gate, not a thrown filesystem path
  // in a report. Crucially it runs AFTER source preflight: unsupported source
  // is rejected before attempting to resolve or execute any CLI.
  const projectDir = resolve(ctx.projectDir);
  const nodeModules = join(projectDir, "node_modules");
  if (!existsSync(nodeModules)) return inconclusive("Multistep runner dependencies are unavailable — no runner was started");
  let cli: string;
  try { cli = resolvePlaywrightCli(projectDir); }
  catch { return inconclusive("Multistep runner dependencies are unavailable — no runner was started"); }

  const dir = await mkdtemp(join(tmpdir(), "verify-fix-multistep-"));
  let bridge: OriginBridge | null = null;
  try {
    // Always establish the independent bridge, even for HTTPS upstreams.
    // Unbridged HTTPS runs cannot prove bridge↔reporter request agreement.
    let environmentOrigin: string;
    try {
      bridge = await startOriginBridge(ctx.baseUrl);
      environmentOrigin = bridge.origin;
    } catch {
      return inconclusive("Multistep HTTPS origin bridge could not be established safely — no runner was started");
    }
    for (const [rawPath, content] of Object.entries(ctx.files)) {
      const path = safeRelativePath(rawPath);
      const dest = join(dir, path);
      await mkdir(dirname(dest), { recursive: true });
      await writeFile(dest, content, "utf8");
    }
    if (!existsSync(join(dir, checkFile))) throw new Error(`Multistep script ${ctx.checkFile} is missing from the candidate files`);
    await symlink(nodeModules, join(dir, "node_modules"), "junction");
    const seedFile = join(dir, "verify-fix-seed.mjs");
    await writeFile(seedFile, SEED_MODULE, "utf8");
    const configPath = "verify-fix.multistep.config.ts";
    await writeFile(join(dir, configPath), MULTISTEP_CONFIG, "utf8");
    const auditReporter = join(dir, "verify-fix-request-reporter.cjs");
    await writeFile(auditReporter, TRUSTED_REQUEST_REPORTER, "utf8");

    // FRESH HOME for the run: nothing under the parent's home (playwright
    // caches, ~/.auth, saved storage state) can be read or written. It lives
    // inside the run directory and is removed with it in `finally`.
    const freshHome = join(dir, "sandbox-home");
    await mkdir(freshHome, { recursive: true });

    const args = [cli, "test", "--config", join(dir, configPath), checkFile, "--workers=1", "--retries=0", `--reporter=json,${auditReporter}`];

    let browserProcesses: number | null = null;
    const childResult = await new Promise<{ code: number | null; stdout: string; audit: string; stderrBytes: number; timedOut: boolean; spawnError: boolean }>((done) => {
      const child = spawn(process.execPath, args, {
        cwd: dir,
        env: {
          // candidate-supplied env first; reserved runner keys below always win
          ...(ctx.env ?? {}),
          PATH: process.env.PATH ?? "",
          HOME: freshHome,
          // fully replaced: the parent's NODE_OPTIONS is never inherited
          NODE_OPTIONS: `--import=${seedFile}`,
          CI: "1",
          ENVIRONMENT_URL: environmentOrigin,
          ENVIRONMENT_NAME: ctx.environmentName ?? "verify-fix",
          SANDBOX_SEED: ctx.seed === undefined ? "" : String(ctx.seed >>> 0),
          // Narrow TLS scoping: only the bridged run gets the per-run CA,
          // only in this one child's environment, and only as an ADDITION to
          // the trust store — certificate validation stays fully enabled.
          ...(bridge ? { NODE_EXTRA_CA_CERTS: bridge.caPath } : {}),
          // LD_LIBRARY_PATH is deliberately absent: never inherited.
        },
        stdio: ["ignore", "pipe", "pipe", "pipe"],
        detached: process.platform !== "win32",
      });
      let stdout = "";
      let stdoutBytes = 0;
      let stdoutTruncated = false;
      let audit = "";
      let auditBytes = 0;
      let auditTruncated = false;
      let stderrBytes = 0;
      let timedOut = false;
      let sampling = true;
      const sample = async (): Promise<void> => {
        if (!child.pid) return;
        const count = await countBrowserProcesses(child.pid);
        if (count !== null) browserProcesses = Math.max(browserProcesses ?? 0, count);
      };
      const sampleLoop = (async (): Promise<void> => {
        while (sampling) {
          await sample();
          await sleep(400);
        }
        await sample(); // final sample at process exit
      })();
      const timer = setTimeout(() => {
        timedOut = true;
        try {
          if (process.platform !== "win32" && child.pid) process.kill(-child.pid, "SIGKILL");
          else child.kill("SIGKILL");
        } catch {
          child.kill("SIGKILL");
        }
      }, ctx.timeoutMs ?? 90_000);
      child.stdout!.on("data", (d: Buffer) => {
        if (stdoutTruncated) return;
        if (stdoutBytes + d.length > MAX_REPORTER_STDOUT_BYTES) {
          stdoutTruncated = true;
          stdout = ""; // over the bound: partial output is not admissible
          return;
        }
        stdoutBytes += d.length;
        stdout += String(d);
      });
      child.stdio[3]?.on("data", (d: Buffer) => {
        if (auditTruncated) return;
        if (auditBytes + d.length > MAX_REPORTER_AUDIT_BYTES) {
          auditTruncated = true;
          audit = "";
          return;
        }
        auditBytes += d.length;
        audit += String(d);
      });
      child.stderr!.on("data", (d: Buffer) => {
        stderrBytes = Math.min(MAX_STDERR_BYTES, stderrBytes + d.length); // counted only — content discarded
      });
      let settled = false;
      const finish = (code: number | null, spawnError: boolean): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        sampling = false;
        void sampleLoop.then(() => done({ code, stdout: stdoutTruncated ? "" : stdout, audit: auditTruncated ? "" : audit, stderrBytes, timedOut, spawnError }));
      };
      child.on("error", () => finish(null, true));
      child.on("close", (code) => finish(code, false));
    });

    if (childResult.spawnError) {
      return inconclusive("Multistep runner failed to start — no trustworthy execution evidence", { browserProcesses });
    }

    if (childResult.timedOut) {
      return inconclusive(`Multistep runner timed out after ${ctx.timeoutMs ?? 90_000}ms — killed; partial output is not admissible evidence`, {
        browserProcesses,
        environmentOrigin,
        proxyEvidence: bridge ? [...bridge.evidence] : [],
        diagnostics: { stderrBytes: childResult.stderrBytes, timedOut: true },
      });
    }

    const capture = normalizeMultiStepCapture({ testResults: childResult.stdout });
    const audit = parseReporterAudit(childResult.audit);
    const reporterEvidence = audit ?? [];
    const proxyEvidence: BridgeRequestEvidence[] = bridge ? [...bridge.evidence] : [];
    const diagnostics = { stderrBytes: childResult.stderrBytes, timedOut: childResult.timedOut };

    if (bridge && bridge.evidence.some((e) => e.forwardError)) {
      return inconclusive("Multistep HTTPS origin bridge could not reach the upstream target (forward error) — no trustworthy execution evidence", {
        trace: traceOf(capture),
        capture,
        exitCode: childResult.code,
        browserProcesses,
        environmentOrigin: bridge.origin,
        proxyEvidence,
        reporterEvidence,
        diagnostics,
      });
    }
    if (capture.problems.length > 0 || capture.steps.length === 0) {
      return inconclusive("Multistep runner produced no admissible JSON step evidence", { trace: traceOf(capture), capture, exitCode: childResult.code, browserProcesses, environmentOrigin, proxyEvidence, reporterEvidence, diagnostics });
    }
    // Bridged execution: bridge evidence must corroborate the reporter.
    // Zero bridge requests with reporter traffic is UNCERTAIN by construction.
    const mismatch = bridgeReporterMismatch(bridge.evidence, capture, audit);
    if (mismatch) {
      return inconclusive(mismatch, { trace: traceOf(capture), capture, exitCode: childResult.code, browserProcesses, environmentOrigin: bridge.origin, proxyEvidence, reporterEvidence, diagnostics });
    }
    if (browserProcesses === null || browserProcesses > 0) {
      return inconclusive(browserProcesses === null
        ? "Multistep browser-process measurement unavailable — no zero-browser claim"
        : "Multistep browser process observed — API-only execution not proven",
      { trace: traceOf(capture), capture, exitCode: childResult.code, browserProcesses, environmentOrigin, proxyEvidence, reporterEvidence, diagnostics });
    }
    const failed = capture.stats !== null
      ? capture.stats.unexpected > 0
      : capture.steps.some((s) => s.status === "failed");
    const passed = childResult.code === 0 && !failed;
    return {
      passed,
      inconclusive: false,
      reason: null,
      trace: traceOf(capture),
      capture,
      exitCode: childResult.code,
      browserProcesses,
      environmentOrigin,
      proxyEvidence,
      reporterEvidence,
      diagnostics,
    };
  } finally {
    // Both cleanup operations run even if one fails; teardown never masks
    // the outcome that was already determined.
    await Promise.allSettled([rm(dir, { recursive: true, force: true }), bridge ? bridge.close() : Promise.resolve()]);
  }
}
