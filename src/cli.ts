// verify-fix CLI.
//   verify-fix bundle --check <checkId> [--result <id>] [--project <dir>] [--out <dir>]
//                     [--measure N] [--measure-overlap M] [--target-url <url>]
//                     [--trigger-rca] [--bodies api|all|none] [--keep-raw] [--history N] [--json] [--verbose]
//   verify-fix verify --patch <file|dir> --bundle <dir> --target <url> [--project <dir>] [--env-file <file>]
//   verify-fix measure --bundle <dir> --target <url> --project <dir> [--runs 20] [--env-file <file>]
// Exit codes: 0 PASS/ok · 1 FAILED · 2 UNCERTAIN / usage / could not run.

import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { loadBundle } from "./bundle.ts";
import { verify } from "./verify.ts";
import { SceneExecutor } from "./executor/scene.ts";
import { ChecklyExecutor } from "./executor/checkly.ts";
import { loadPatch } from "./patch.ts";
import { parseEnvFile } from "./scene/env.ts";
import { measureLocalDeterminism } from "./measure-local.ts";
import { resolveCredentials, CREDENTIALS_HELP } from "./checkly/credentials.ts";
import { ChecklyClient, ChecklyApiError } from "./checkly/client.ts";
import { buildBundle } from "./bundle/build.ts";
import type { BodyPolicy } from "./trace/trace-to-har.ts";
import type { ExitCode } from "./types.ts";

const TOOL_VERSION = "0.1.0";

interface Args {
  command: string | null;
  patch: string | null;
  bundle: string | null;
  executor: "scene" | "checkly";
  target: string | null;
  envFile: string | null;
  envName: string | null;
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
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    command: null, patch: null, bundle: null, executor: "scene", target: null, envFile: null, envName: null, dryRun: false, json: false, verbose: false,
    check: null, result: null, out: null, project: null, measure: 0, measureOverlap: 0, targetUrl: null,
    triggerRca: false, bodies: "api", keepRaw: false, history: 100, runs: 20,
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
      case "--bundle": args.bundle = value(i, a); if (takes) i++; break;
      case "--executor": {
        const v = value(i, a);
        args.executor = v === "synthetic" ? "scene" : (v as Args["executor"]);
        if (takes) i++;
        break;
      }
      case "--target": args.target = value(i, a); if (takes) i++; break;
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
    "                    [--env-file <file>] [--env-name <name>] [--executor scene|checkly] [--dry-run] [--json] [--verbose]",
    "      Grades a candidate fix against a bundle. --patch is the new check file, or a directory whose files",
    "      replace the bundle's check/ files (spec and/or checkly.config.ts). --target is the app the live",
    "      scenes run against (becomes ENVIRONMENT_URL, Checkly's convention); the tool never picks one.",
    "      Playwright bundles also need --project: the customer's project with @playwright/test installed.",
    "      --env-file gives the check its own variables (KEY=VALUE lines, like `checkly test --env-file`).",
    "",
    "  verify-fix measure --bundle <dir> --target <url> --project <dir> [--runs 20] [--env-file <file>] [--verbose]",
    "      Runs the original Playwright check locally through its reproduction mode, then writes measured",
    "      determinism numbers to manifest.json with method local-runner. No Checkly credentials are used.",
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
  if (!args.patch || !args.bundle) {
    process.stderr.write("--patch and --bundle are required\n\n" + usage());
    return 2;
  }
  const { bundle } = loadBundle(args.bundle);
  const patch = loadPatch(args.patch, bundle);
  const env = args.envFile ? parseEnvFile(readFileSync(args.envFile, "utf8")) : {};
  if (args.target && !/^https?:\/\//.test(args.target)) {
    process.stderr.write("--target must be an http(s) origin, e.g. https://staging.example.com\n");
    return 2;
  }

  const executor =
    args.executor === "checkly"
      ? new ChecklyExecutor({ dryRunOnly: args.dryRun || !process.env.CHECKLY_API_KEY, verbose: args.verbose })
      : new SceneExecutor({
          target: args.target,
          env,
          environmentName: args.envName ?? undefined,
          projectDir: args.project,
          browserExecutablePath: process.env.VERIFY_FIX_BROWSER_PATH,
          verbose: args.verbose,
        });

  const result = await verify({ bundle, patch, executor, target: args.target, env, environmentName: args.envName ?? undefined, verbose: args.verbose });

  if (args.json) {
    process.stdout.write(JSON.stringify(result.report.json, null, 2) + "\n");
  } else {
    process.stdout.write(result.report.markdown);
  }
  if (args.verbose) {
    process.stderr.write(`\n[verify-fix] cost: ${result.cost.scenes} scenes, ${result.cost.runs} sandbox/live runs\n`);
  }
  return result.decision.exitCode;
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
  process.stderr.write(`unknown command: ${args.command}\n\n${usage()}`);
  return 2;
}

const code = await main();
process.exit(code);
