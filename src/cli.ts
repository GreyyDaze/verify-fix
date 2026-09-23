// verify-fix CLI.
//   verify-fix bundle --check <checkId> [--result <id>] [--project <dir>] [--out <dir>]
//                     [--measure N] [--measure-overlap M] [--target-url <url>]
//                     [--trigger-rca] [--bodies api|all|none] [--keep-raw] [--history N] [--json] [--verbose]
//   verify-fix verify --patch <file|dir> --bundle <dir> --target <url> [--project <dir>] [--env-file <file>]
//   verify-fix measure --bundle <dir> --target <url> --project <dir> [--runs 20] [--env-file <file>]
// Exit codes: 0 PASS/ok · 1 FAILED · 2 UNCERTAIN / usage / could not run.

import { readFileSync, existsSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { loadBundle } from "./bundle.ts";
import { verify } from "./verify.ts";
import { SceneExecutor } from "./executor/scene.ts";
import { HybridExecutor } from "./executor/hybrid.ts";
import { loadCandidateProject, loadPatch } from "./patch.ts";
import { parseEnvFile } from "./scene/env.ts";
import { measureLocalDeterminism } from "./measure-local.ts";
import { buildCostMatrix, costMatrixMarkdown } from "./cost-report.ts";
import { resolveCredentials, CREDENTIALS_HELP } from "./checkly/credentials.ts";
import { ChecklyClient, ChecklyApiError } from "./checkly/client.ts";
import { buildBundle } from "./bundle/build.ts";
import type { BodyPolicy } from "./trace/trace-to-har.ts";
import type { ExitCode } from "./types.ts";

const TOOL_VERSION = "0.1.0";

interface Args {
  command: string | null;
  patch: string | null;
  candidateProject: string | null;
  bundle: string | null;
  executor: "scene" | "hybrid";
  target: string | null;
  targetRevision: string | null;
  reportJson: string | null;
  reportMarkdown: string | null;
  envFile: string | null;
  envName: string | null;
  /** Legacy direct-API flag. Parsed only so it can be rejected safely. */
  dryRun: boolean;
  json: boolean;
  verbose: boolean;
  // bundle
  check: string | null;
  result: string | null;
  out: string | null;
  project: string | null;
  measure: number;
  measureOverlap: number;
  targetUrl: string | null;
  triggerRca: boolean;
  bodies: BodyPolicy;
  keepRaw: boolean;
  history: number;
  // local measure
  runs: number;
  // cost-report
  reports: string | null;
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    command: null, patch: null, candidateProject: null, bundle: null, executor: "scene", target: null, targetRevision: null, reportJson: null, reportMarkdown: null, envFile: null, envName: null, dryRun: false, json: false, verbose: false,
    check: null, result: null, out: null, project: null, measure: 0, measureOverlap: 0, targetUrl: null,
    triggerRca: false, bodies: "api", keepRaw: false, history: 100, runs: 20, reports: null,
  };
  const value = (i: number, a: string): string => {
    const eq = a.indexOf("=");
    if (eq !== -1) return a.slice(eq + 1);
    return argv[i + 1];
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const key = a.includes("=") ? a.slice(0, a.indexOf("=")) : a;
    const takes = !a.includes("=");
    switch (key) {
      case "--patch": args.patch = value(i, a); if (takes) i++; break;
      case "--candidate-project": args.candidateProject = value(i, a); if (takes) i++; break;
      case "--bundle": args.bundle = value(i, a); if (takes) i++; break;
      case "--executor": {
        const v = value(i, a);
        args.executor = v === "synthetic" ? "scene" : (v as Args["executor"]);
        if (takes) i++;
        break;
      }
      case "--target": args.target = value(i, a); if (takes) i++; break;
      case "--target-revision": args.targetRevision = value(i, a); if (takes) i++; break;
      case "--report-json": args.reportJson = value(i, a); if (takes) i++; break;
      case "--report-markdown": args.reportMarkdown = value(i, a); if (takes) i++; break;
      case "--env-file": args.envFile = value(i, a); if (takes) i++; break;
      case "--env-name": args.envName = value(i, a); if (takes) i++; break;
      case "--dry-run": args.dryRun = true; break;
      case "--json": args.json = true; break;
      case "--verbose": args.verbose = true; break;
      case "--check": args.check = value(i, a); if (takes) i++; break;
      case "--result": args.result = value(i, a); if (takes) i++; break;
      case "--out": args.out = value(i, a); if (takes) i++; break;
      case "--project": args.project = value(i, a); if (takes) i++; break;
      case "--measure": args.measure = Number(value(i, a)); if (takes) i++; break;
      case "--measure-overlap": args.measureOverlap = Number(value(i, a)); if (takes) i++; break;
      case "--target-url": args.targetUrl = value(i, a); if (takes) i++; break;
      case "--trigger-rca": args.triggerRca = true; break;
      case "--bodies": args.bodies = value(i, a) as BodyPolicy; if (takes) i++; break;
      case "--keep-raw": args.keepRaw = true; break;
      case "--history": args.history = Number(value(i, a)); if (takes) i++; break;
      case "--runs": args.runs = Number(value(i, a)); if (takes) i++; break;
      case "--reports": args.reports = value(i, a); if (takes) i++; break;
      case "--help": case "-h": args.command = "help"; break;
      default:
        if (!args.command && !a.startsWith("-")) args.command = a;
    }
  }
  return args;
}

function usage(): string {
  return [
    "verify-fix — pre-merge verification of an agent-proposed monitoring-check repair",
    "",
    "  verify-fix bundle --check <checkId> [--result <failingResultId>] [--project <checkly project dir>] [--out <dir>]",
    "                    [--measure N] [--measure-overlap M] [--target-url <url>] [--trigger-rca]",
    "                    [--bodies api|all|none] [--keep-raw] [--history N] [--json] [--verbose]",
    "      Captures an incident from Checkly into a bundle: check config, sources, failing + last passing",
    "      run (traces → HAR), error group, Rocky RCA, scenes with provenance. Credentials: CHECKLY_API_KEY +",
    "      CHECKLY_ACCOUNT_ID, or the login saved by `npx checkly login`. Secrets are never written.",
    "      --trigger-rca asks Rocky for a fresh analysis when the group has none, or when its RCA describes",
    "      an earlier, different failure of the same group (Rocky analyzes only a group's first failure).",
    "",
    "  verify-fix verify --patch <file|dir> --bundle <dir> --target <url> [--project <dir>]",
    "              or: --candidate-project <dir> --bundle <dir> --target <url>",
    "                    [--target-revision <sha>] [--env-file <file>] [--env-name <name>]",
    "                    [--executor scene|hybrid] [--report-json <file>] [--report-markdown <file>] [--json] [--verbose]",
    "      Grades a candidate fix against a bundle. --patch replaces captured check files for fixture testing.",
    "      --candidate-project reads only the captured monitoring files plus their relative imports from a real",
    "      customer project. --target is the exact app deployment under test. Hybrid mode runs HEALTHY and",
    "      REGRESSION through the project-local Checkly CLI. It keeps REPRODUCTION and DETECTION in the scene proxy.",
    "      Playwright bundles also need --project. It defaults to --candidate-project when that input is used.",
    "      --env-file gives the check its own variables (KEY=VALUE lines, like `checkly test --env-file`).",
    "",
    "  verify-fix measure --bundle <dir> --target <url> --project <dir> [--runs 20] [--env-file <file>] [--verbose]",
    "      Runs the original Playwright check locally through its reproduction mode, then writes measured",
    "      determinism numbers to manifest.json with method local-runner. No Checkly credentials are used.",
    "",
    "  verify-fix cost-report --reports <dir> [--json]",
    "      Aggregates saved verification JSON reports by candidate and verdict. It reports runs and wall time.",
    "",
    "Exit codes: 0 = PASS/ok · 1 = FAILED · 2 = UNCERTAIN / usage error",
    "",
  ].join("\n");
}

async function runBundle(args: Args): Promise<ExitCode> {
  if (!args.check) {
    process.stderr.write("--check <checkId> is required\n\n" + usage());
    return 2;
  }
  if (!["api", "all", "none"].includes(args.bodies)) {
    process.stderr.write("--bodies must be api, all or none\n");
    return 2;
  }
  const creds = resolveCredentials();
  if (!creds) {
    process.stderr.write(CREDENTIALS_HELP + "\n");
    return 2;
  }
  const project = args.project ?? (["checkly.config.ts", "checkly.config.js", "checkly.config.mjs"].some((f) => existsSync(join(process.cwd(), f))) ? process.cwd() : null);
  const out = args.out ?? `./bundle-${args.check.slice(0, 8)}`;
  const log = (line: string) => {
    if (args.verbose) process.stderr.write(line + "\n");
  };
  log(`[bundle] credentials from ${creds.source}`);
  const client = new ChecklyClient(creds, { userAgent: `verify-fix-bundle/${TOOL_VERSION}` });
  try {
    const outcome = await buildBundle(
      {
        checkId: args.check,
        resultId: args.result,
        outDir: out,
        projectDir: project,
        measure: args.measure,
        measureOverlap: args.measureOverlap,
        targetUrl: args.targetUrl ?? undefined,
        triggerRca: args.triggerRca,
        bodies: args.bodies,
        keepRaw: args.keepRaw,
        historyLimit: args.history,
        log,
      },
      { client, accountId: creds.accountId, toolVersion: TOOL_VERSION },
    );
    const m = outcome.manifest;
    if (args.json) {
      process.stdout.write(JSON.stringify({ outDir: outcome.outDir, incidentId: m.incidentId, status: m.incident.status, scenes: m.scenes.map((s) => ({ id: s.sceneId, type: s.type, mode: s.mode })), reproduction: m.reproduction.mode, failurePoint: m.failurePoint, warnings: outcome.warnings }, null, 2) + "\n");
    } else {
      const lines = [
        `bundle written to ${outcome.outDir}`,
        `  incident:      ${m.incidentId} (${m.incident.status})`,
        `  check:         ${m.check.name} [${m.check.checkType}] every ${m.config.frequencyMinutes ?? "?"} min from ${m.config.locations.join(", ")}${m.config.runParallel ? " (parallel)" : ""}`,
        `  failing run:   ${m.results.failing ? `${m.results.failing.id} @ ${m.results.failing.runLocation}` : "none yet"}`,
        `  passing run:   ${m.results.passing ? `${m.results.passing.id} @ ${m.results.passing.runLocation}` : "none"}`,
        `  recordings:    ${[m.recordings.failing, m.recordings.passing].filter(Boolean).join(", ") || "none"}`,
        `  rca:           ${m.rca ? `${m.rca.classification}` : "none"}`,
        `  reproduction:  ${m.reproduction.mode}`,
        `  failure point: ${m.failurePoint?.request ? `${m.failurePoint.request.method} ${m.failurePoint.request.path} → ${m.failurePoint.request.status}` : "n/a"}`,
        `  scenes:        ${m.scenes.map((s) => `${s.sceneId}(${s.mode})`).join(", ") || "none"}`,
        `  assertions:    ${m.assertions?.totalAssertions ?? 0} from ${m.check.file ?? "no source"}`,
        `  history:       ${m.determinism.history.passed}/${m.determinism.history.finalRuns} passed`,
      ];
      if (outcome.warnings.length) lines.push("  warnings:", ...outcome.warnings.map((w) => `    - ${w}`));
      process.stdout.write(lines.join("\n") + "\n");
    }
    return 0;
  } catch (err) {
    if (err instanceof ChecklyApiError) {
      const hint = err.status === 401 || err.status === 403 ? " (check CHECKLY_API_KEY / CHECKLY_ACCOUNT_ID, or run `npx checkly login`)" : err.status === 404 ? " (is the check id right? `npx checkly checks list`)" : "";
      process.stderr.write(`${err.message}${hint}\n`);
      return 2;
    }
    process.stderr.write(`bundle failed: ${(err as Error).message}\n`);
    if (args.verbose && (err as Error).stack) process.stderr.write((err as Error).stack + "\n");
    return 2;
  }
}

async function runMeasure(args: Args): Promise<ExitCode> {
  if (!args.bundle || !args.target || !args.project) {
    process.stderr.write("--bundle, --target and --project are required for local measurement\n\n" + usage());
    return 2;
  }
  if (!/^https?:\/\//.test(args.target)) {
    process.stderr.write("--target must be an http(s) origin, e.g. https://staging.example.com\n");
    return 2;
  }
  if (!Number.isInteger(args.runs) || args.runs < 1) {
    process.stderr.write("--runs must be a positive integer\n");
    return 2;
  }
  const { bundle } = loadBundle(args.bundle);
  const env = args.envFile ? parseEnvFile(readFileSync(args.envFile, "utf8")) : {};
  try {
    const measured = await measureLocalDeterminism({
      bundle,
      target: args.target,
      env,
      environmentName: args.envName ?? undefined,
      projectDir: args.project,
      runs: args.runs,
      verbose: args.verbose,
      browserExecutablePath: process.env.VERIFY_FIX_BROWSER_PATH,
    });
    const result = {
      bundle: bundle.dir,
      method: "local-runner",
      reproductionMode: measured.reproductionMode,
      sequential: measured.sequential,
      overlap: measured.overlap,
    };
    if (args.json) process.stdout.write(JSON.stringify(result, null, 2) + "\n");
    else {
      process.stdout.write([
        `measurement written to ${join(bundle.dir, "manifest.json")}`,
        `  method:       local-runner`,
        `  reproduction: ${measured.reproductionMode}`,
        `  sequential:   ${measured.sequential.passed}/${measured.sequential.runs} passed`,
        `  overlap:      ${measured.overlap ? `${measured.overlap.pairsWithFailure}/${measured.overlap.pairs} pairs reproduced the failure` : "not required for this mode"}`,
      ].join("\n") + "\n");
    }
    return 0;
  } catch (err) {
    process.stderr.write(`measure failed: ${(err as Error).message}\n`);
    if (args.verbose && (err as Error).stack) process.stderr.write((err as Error).stack + "\n");
    return 2;
  }
}

async function runVerify(args: Args): Promise<ExitCode> {
  if (!args.bundle || (!args.patch && !args.candidateProject) || (args.patch && args.candidateProject)) {
    process.stderr.write("--bundle and exactly one of --patch or --candidate-project are required\n\n" + usage());
    return 2;
  }
  if (args.dryRun) {
    process.stderr.write("--dry-run belonged to the retired direct-API executor; use --executor scene or --executor hybrid\n");
    return 2;
  }
  if (args.target && !/^https?:\/\//.test(args.target)) {
    process.stderr.write("--target must be an http(s) origin, e.g. https://preview.example.com\n");
    return 2;
  }
  if (args.executor === "hybrid" && (!args.target || !args.targetRevision)) {
    process.stderr.write("--executor hybrid requires the exact deployment --target <url> and --target-revision <sha>\n");
    return 2;
  }
  const { bundle } = loadBundle(args.bundle);
  const patch = args.candidateProject ? loadCandidateProject(args.candidateProject, bundle) : loadPatch(args.patch!, bundle);
  const env = args.envFile ? parseEnvFile(readFileSync(args.envFile, "utf8")) : {};
  const project = args.project ?? args.candidateProject;
  if (bundle.playwright && !project) {
    process.stderr.write("Playwright verification needs --project <dir> or --candidate-project <dir>\n");
    return 2;
  }
  if (!["scene", "hybrid"].includes(args.executor)) {
    process.stderr.write("--executor must be scene or hybrid\n");
    return 2;
  }

  const shared = {
    target: args.target,
    env,
    environmentName: args.envName ?? undefined,
    projectDir: project,
    browserExecutablePath: process.env.VERIFY_FIX_BROWSER_PATH,
    verbose: args.verbose,
  };
  const executor = args.executor === "hybrid"
    ? new HybridExecutor({ ...shared, targetRevision: args.targetRevision ?? undefined })
    : new SceneExecutor(shared);

  try {
    const result = await verify({
      bundle,
      patch,
      executor,
      target: args.target,
      targetRevision: args.targetRevision ?? undefined,
      candidateProject: args.candidateProject ? resolve(args.candidateProject) : null,
      env,
      environmentName: args.envName ?? undefined,
      projectDir: project,
      verbose: args.verbose,
    });

    if (args.reportJson) writeFileSync(args.reportJson, JSON.stringify(result.report.json, null, 2) + "\n");
    if (args.reportMarkdown) writeFileSync(args.reportMarkdown, result.report.markdown);
    if (args.json) process.stdout.write(JSON.stringify(result.report.json, null, 2) + "\n");
    else process.stdout.write(result.report.markdown);
    if (args.verbose) {
      process.stderr.write(`\n[verify-fix] cost: ${result.cost.checklyCloudRuns} Checkly cloud run(s), ${result.cost.localRuns} local run(s), ${result.cost.browserProcesses} browser process(es), ${(result.cost.wallTimeMs / 1000).toFixed(1)}s wall time\n`);
    }
    return result.decision.exitCode;
  } catch (error) {
    process.stderr.write(`verify failed: ${(error as Error).message}\n`);
    if (args.verbose && (error as Error).stack) process.stderr.write((error as Error).stack + "\n");
    return 2;
  }
}

function runCostReport(args: Args): ExitCode {
  if (!args.reports) {
    process.stderr.write("--reports <dir> is required\n\n" + usage());
    return 2;
  }
  try {
    const matrix = buildCostMatrix(args.reports);
    if (args.json) process.stdout.write(JSON.stringify(matrix, null, 2) + "\n");
    else process.stdout.write(costMatrixMarkdown(matrix));
    return 0;
  } catch (error) {
    process.stderr.write(`cost report failed: ${(error as Error).message}\n`);
    return 2;
  }
}

async function main(): Promise<ExitCode> {
  const args = parseArgs(process.argv.slice(2));
  if (args.command === "help" || !args.command) {
    process.stdout.write(usage());
    return 2;
  }
  if (args.command === "bundle") return runBundle(args);
  if (args.command === "measure") return runMeasure(args);
  if (args.command === "verify") return runVerify(args);
  if (args.command === "cost-report") return runCostReport(args);
  process.stderr.write(`unknown command: ${args.command}\n\n${usage()}`);
  return 2;
}

const code = await main();
process.exit(code);
