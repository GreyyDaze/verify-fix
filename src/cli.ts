// verify-fix CLI.
//   verify-fix bundle --check <checkId> [--result <id>] [--project <dir>] [--out <dir>]
//                     [--measure N] [--measure-overlap M] [--target-url <url>]
//                     [--trigger-rca] [--bodies api|all|none] [--keep-raw] [--history N] [--json] [--verbose]
//   verify-fix verify (--patch <file|dir> | --candidate-project <dir> --base <ref> | --pr <url>)
//                     --bundle <dir> [--target <url>] [--project <dependency-dir>] [--env-file <file>]
//   verify-fix measure --bundle <dir> --target <url> --project <dir> [--runs 20] [--env-file <file>]
// Exit codes: 0 PASS/ok · 1 FAILED · 2 UNCERTAIN / usage / could not run.

import { readFileSync, existsSync, lstatSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadBundle } from "./bundle.ts";
import { verify } from "./verify.ts";
import { SceneExecutor } from "./executor/scene.ts";
import { HybridExecutor } from "./executor/hybrid.ts";
import { loadCandidateRevision, loadPatch } from "./patch.ts";
import {
  assertPullRequestStillCurrent,
  bindCandidateTarget,
  loadDeploymentMetadata,
  snapshotLocalCandidate,
  snapshotPullRequestCandidate,
  type CandidateRevision,
} from "./candidate/revision.ts";
import { parseEnvFile } from "./scene/env.ts";
import { measureLocalDeterminism } from "./measure-local.ts";
import { buildCostMatrix, costMatrixMarkdown } from "./cost-report.ts";
import { initConfirmation, mergePackageScripts, planInit } from "./init.ts";
import { mkdirSync, statSync } from "node:fs";

const isFile = (path: string): boolean => { try { return statSync(path).isFile(); } catch { return false; } };
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
  pr: string | null;
  base: string | null;
  projectPath: string;
  bundle: string | null;
  executor: "scene" | "hybrid";
  target: string | null;
  targetRevision: string | null;
  targetMetadata: string | null;
  cloudApproved: boolean;
  allowForkCloud: boolean;
  reportJson: string | null;
  reportMarkdown: string | null;
  envFile: string | null;
  envName: string | null;
  requirementsMode: "shadow" | "migration" | "enforce";
  requirementsDigest: string | null;
  /** Legacy direct-API flag. Parsed only so it can be rejected safely. */
  dryRun: boolean;
  json: boolean;
  verbose: boolean;
  // bundle
  check: string | null;
  result: string | null;
  out: string | null;
  project: string | null;
  assets: string | null;
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
  // init
  yes: boolean;
}

/** No option value, extra positional argument or misspelled flag is ever
 * silently ignored. In particular a token-looking argument is never echoed. */
const FLAG_OPTIONS = new Set(["--help", "-h", "--dry-run", "--json", "--verbose", "--cloud-approved",
  "--allow-fork-cloud", "--trigger-rca", "--keep-raw", "--yes", "-y"]);
const VALUE_OPTIONS = new Set(["--patch", "--candidate-project", "--pr", "--base", "--project-path", "--bundle",
  "--executor", "--target", "--target-revision", "--target-metadata", "--report-json", "--report-markdown",
  "--env-file", "--env-name", "--check", "--result", "--out", "--project", "--assets", "--measure",
  "--measure-overlap", "--target-url", "--bodies", "--history", "--runs", "--reports"]);
VALUE_OPTIONS.add("--requirements-mode");
VALUE_OPTIONS.add("--requirements-digest");

/** A target identifies one origin, never a credentialed URL, app path,
 * query, fragment, or host chosen by command-line ambiguity. */
export function safeTargetOrigin(raw: string): boolean {
  if (raw.length === 0 || raw.length > 2048 || /[\x00-\x20\x7f\\]/.test(raw)) return false;
  try {
    const target = new URL(raw);
    return (target.protocol === "https:" || target.protocol === "http:")
      && target.hostname !== "" && target.username === "" && target.password === ""
      && target.search === "" && target.hash === "" && (raw === target.origin || raw === `${target.origin}/`);
  } catch { return false; }
}

/** Private CLI input only, never put into a bundle or report. Reject partial,
 * duplicate and world-readable env files before a candidate can run. */
function readEnvInputs(file: string | null): Record<string, string> {
  if (!file) return {};
  const stat = lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 64 * 1024
    || (stat.mode & 0o077) !== 0) throw new Error("PRIVATE_ENV_FILE_INVALID");
  const text = readFileSync(file, "utf8");
  const keys = new Set<string>();
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim() || line.trimStart().startsWith("#")) continue;
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line.trim());
    if (!match || keys.has(match[1]!)) throw new Error("PRIVATE_ENV_FILE_INVALID");
    keys.add(match[1]!);
  }
  return parseEnvFile(text);
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    command: null, patch: null, candidateProject: null, pr: null, base: null, projectPath: ".", bundle: null, executor: "scene", target: null, targetRevision: null, targetMetadata: null, cloudApproved: false, allowForkCloud: false, reportJson: null, reportMarkdown: null, envFile: null, envName: null, requirementsMode: "shadow", requirementsDigest: null, dryRun: false, json: false, verbose: false,
    check: null, result: null, out: null, project: null, assets: null, measure: 0, measureOverlap: 0, targetUrl: null,
    triggerRca: false, bodies: "api", keepRaw: false, history: 1000, runs: 20, reports: null, yes: false,
  };
  const seen = new Set<string>();
  const value = (i: number, a: string): string => {
    const eq = a.indexOf("=");
    const next = eq !== -1 ? a.slice(eq + 1) : argv[i + 1];
    if (!next || (eq === -1 && next.startsWith("-"))) throw new Error("CLI_ARGUMENT_INVALID");
    return next;
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    const key = a.includes("=") ? a.slice(0, a.indexOf("=")) : a;
    const takes = !a.includes("=");
    if (!key.startsWith("-")) {
      if (args.command) throw new Error("CLI_ARGUMENT_INVALID");
      args.command = key;
      continue;
    }
    if ((!FLAG_OPTIONS.has(key) && !VALUE_OPTIONS.has(key)) || seen.has(key)
      || (FLAG_OPTIONS.has(key) && !takes)) throw new Error("CLI_ARGUMENT_INVALID");
    seen.add(key);
    switch (key) {
      case "--patch": args.patch = value(i, a); if (takes) i++; break;
      case "--candidate-project": args.candidateProject = value(i, a); if (takes) i++; break;
      case "--pr": args.pr = value(i, a); if (takes) i++; break;
      case "--base": args.base = value(i, a); if (takes) i++; break;
      case "--project-path": args.projectPath = value(i, a); if (takes) i++; break;
      case "--bundle": args.bundle = value(i, a); if (takes) i++; break;
      case "--executor": {
        const v = value(i, a);
        args.executor = v as Args["executor"];
        if (takes) i++;
        break;
      }
      case "--target": args.target = value(i, a); if (takes) i++; break;
      case "--target-revision": args.targetRevision = value(i, a); if (takes) i++; break;
      case "--target-metadata": args.targetMetadata = value(i, a); if (takes) i++; break;
      case "--cloud-approved": args.cloudApproved = true; break;
      case "--allow-fork-cloud": args.allowForkCloud = true; break;
      case "--report-json": args.reportJson = value(i, a); if (takes) i++; break;
      case "--report-markdown": args.reportMarkdown = value(i, a); if (takes) i++; break;
      case "--env-file": args.envFile = value(i, a); if (takes) i++; break;
      case "--env-name": args.envName = value(i, a); if (takes) i++; break;
      case "--requirements-mode": args.requirementsMode = value(i, a) as Args["requirementsMode"]; if (takes) i++; break;
      case "--requirements-digest": args.requirementsDigest = value(i, a); if (takes) i++; break;
      case "--dry-run": args.dryRun = true; break;
      case "--json": args.json = true; break;
      case "--verbose": args.verbose = true; break;
      case "--check": args.check = value(i, a); if (takes) i++; break;
      case "--result": args.result = value(i, a); if (takes) i++; break;
      case "--out": args.out = value(i, a); if (takes) i++; break;
      case "--project": args.project = value(i, a); if (takes) i++; break;
      case "--assets": args.assets = value(i, a); if (takes) i++; break;
      case "--measure": args.measure = Number(value(i, a)); if (takes) i++; break;
      case "--measure-overlap": args.measureOverlap = Number(value(i, a)); if (takes) i++; break;
      case "--target-url": args.targetUrl = value(i, a); if (takes) i++; break;
      case "--trigger-rca": args.triggerRca = true; break;
      case "--bodies": args.bodies = value(i, a) as BodyPolicy; if (takes) i++; break;
      case "--keep-raw": args.keepRaw = true; break;
      case "--yes": case "-y": args.yes = true; break;
      case "--history": args.history = Number(value(i, a)); if (takes) i++; break;
      case "--runs": args.runs = Number(value(i, a)); if (takes) i++; break;
      case "--reports": args.reports = value(i, a); if (takes) i++; break;
      case "--help": case "-h": args.command = "help"; break;
      default: throw new Error("CLI_ARGUMENT_INVALID");
    }
  }
  const perCommand: Record<string, ReadonlySet<string>> = {
    bundle: new Set(["--check", "--result", "--out", "--project", "--assets", "--measure", "--measure-overlap",
      "--target-url", "--trigger-rca", "--bodies", "--keep-raw", "--history", "--json", "--verbose"]),
    verify: new Set(["--patch", "--candidate-project", "--pr", "--base", "--project-path", "--bundle",
      "--executor", "--target", "--target-revision", "--target-metadata", "--cloud-approved", "--allow-fork-cloud",
      "--report-json", "--report-markdown", "--env-file", "--env-name", "--dry-run", "--json", "--verbose", "--project",
      "--requirements-mode", "--requirements-digest"]),
    measure: new Set(["--bundle", "--target", "--project", "--runs", "--env-file", "--env-name", "--json", "--verbose"]),
    "cost-report": new Set(["--reports", "--json"]),
    init: new Set(["--yes", "-y"]),
    help: new Set(["--help", "-h"]),
  };
  if (args.command && perCommand[args.command] && [...seen].some((key) =>
    !perCommand[args.command!]!.has(key))) throw new Error("CLI_ARGUMENT_INVALID");
  return args;
}

function usage(): string {
  return [
    "verify-fix — pre-merge verification of an agent-proposed monitoring-check repair",
    "",
    "  verify-fix bundle --check <checkId> [--result <failingResultId>] [--project <checkly project dir>] [--out <dir>]",
    "                    [--assets <downloaded-dir>] [--measure N] [--measure-overlap M] [--target-url <url>] [--trigger-rca]",
    "                    [--bodies api|all|none] [--keep-raw] [--history N] [--json] [--verbose]",
    "      Captures an incident from Checkly into a bundle: check config, sources, failing + last passing",
    "      run (traces → HAR), error group, Rocky RCA, scenes with provenance. Credentials: CHECKLY_API_KEY +",
    "      CHECKLY_ACCOUNT_ID, or the login saved by `npx checkly login`. Secrets are never written.",
    "      --assets reads result assets you already downloaded with `checkly assets download --type all --dir <dir>`",
    "      instead of downloading them: flat files attach to the failing result, failing/ and passing/ subdirs to each.",
    "      For a MULTI_STEP check the downloaded assets (test-results.json, check-run-data.json, logs.txt) are",
    "      normalized into sanitized structured step evidence (recordings/<side>.multistep.json) — no HAR or trace is",
    "      invented, raw assets are never written, and missing/corrupt assets make the evidence UNCERTAIN, not PASS/FAIL.",
    "      --trigger-rca asks Rocky for a fresh analysis when the group has none, or when its RCA describes",
    "      an earlier, different failure of the same group (Rocky analyzes only a group's first failure).",
    "",
    "  verify-fix verify --patch <file|dir> --bundle <dir> [--target <url>] [--project <dir>]",
    "              or: --candidate-project <dir> --base <git-ref> --bundle <protected-dir> [--target <url>]",
    "              or: --pr <github-pull-url> --bundle <protected-dir> --target <url> --target-revision <sha>",
    "                    [--project-path <repo-relative-dir>] [--project <dependency-dir>]",
    "                    [--target-metadata <file>] [--cloud-approved] [--allow-fork-cloud]",
    "                    [--env-file <file>] [--env-name <name>] [--executor scene|hybrid]",
    "                    [--requirements-mode shadow|migration|enforce] [--requirements-digest <sha256>]",
    "                    [--report-json <file>] [--report-markdown <file>] [--json] [--verbose]",
    "      Grades a candidate fix against a protected incident bundle. --patch remains for fixtures and small experiments.",
    "      Local mode snapshots HEAD plus staged, unstaged, and non-ignored untracked files before any check runs.",
    "      PR mode resolves and fetches one exact GitHub head SHA. The full repository digest and Git changes enter the report.",
    "      --project-path locates a Checkly project in a monorepo. --project supplies already-installed dependencies;",
    "      verify-fix never runs package lifecycle scripts. --target identifies the running app and stays separate from --pr.",
    "      Hybrid PR mode requires protected approval. Deployment metadata makes an exact PR/preview binding gate-eligible.",
    "      --env-file gives the check its own variables (KEY=VALUE lines, like `checkly test --env-file`).",
    "",
    "  verify-fix measure --bundle <dir> --target <url> --project <dir> [--runs 20] [--env-file <file>] [--verbose]",
    "      Runs the original Playwright or Multistep check against its reproduction mode, then writes measured",
    "      determinism numbers to manifest.json with method local-runner. No Checkly credentials are used.",
    "",
    "  verify-fix init [--yes]",
  "      Prepares verify-fix inside an EXISTING Checkly project. Detects the project files, then writes",
  "      only the agreed CLI configuration and package scripts after confirmation. It never creates or",
  "      copies the example project, never provisions a service, and never reads or stores a credential.",
  "      To copy the worked example instead, use: npm create verify-fix@latest <dir> -- --template slots-booking-live",
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
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(args.check) || args.result && !/^[A-Za-z0-9_-]{1,128}$/.test(args.result)
    || args.targetUrl && !safeTargetOrigin(args.targetUrl)
    || !Number.isSafeInteger(args.history) || args.history < 1 || args.history > 5000
    || !Number.isSafeInteger(args.measure) || args.measure < 0 || args.measure > 500
    || !Number.isSafeInteger(args.measureOverlap) || args.measureOverlap < 0 || args.measureOverlap > 500) {
    process.stderr.write("bundle identifier, target origin or measurement bound is invalid\n");
    return 2;
  }
  if (!["api", "all", "none"].includes(args.bodies)) {
    process.stderr.write("--bodies must be api, all or none\n");
    return 2;
  }
  const creds = resolveCredentials();
  if (!creds || !/^[A-Za-z0-9_-]{1,128}$/.test(creds.accountId)) {
    process.stderr.write(CREDENTIALS_HELP + "\n");
    return 2;
  }
  const project = args.project ?? (["checkly.config.ts", "checkly.config.js", "checkly.config.mjs"].some((f) => existsSync(join(process.cwd(), f))) ? process.cwd() : null);
  const out = args.out ?? `./bundle-${args.check.slice(0, 8)}`;
  const log = (line: string) => {
    if (args.verbose) process.stderr.write(line + "\n");
  };
  log(`[bundle] credentials from ${creds.source}`);
  try {
    const client = new ChecklyClient(creds, { userAgent: `verify-fix-bundle/${TOOL_VERSION}` });
    const outcome = await buildBundle(
      {
        checkId: args.check,
        resultId: args.result,
        outDir: out,
        projectDir: project,
        assetsDir: args.assets,
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
      process.stderr.write(`Checkly request failed (HTTP ${err.status})\n`);
      return 2;
    }
    // Expose the ACTUAL failure: fixed multistep problem names and bounded
    // reader errors are safe verbatim; any other message is URL-redacted and
    // bounded before display. A generic message that hides the failing gate
    // made real scheduled evidence undiagnosable.
    const raw = err instanceof Error ? err.message : String(err);
    const bounded = raw.length > 300 ? `${raw.slice(0, 300)}…` : raw;
    const shown = /^(MULTISTEP_|MULTIPLE_|zip: )/.test(bounded) ? bounded
      : bounded.replace(/https?:\/\/[^\s)\]}>"]+/g, "<redacted-url>");
    process.stderr.write(`bundle failed: ${shown}\n`);
    return 2;
  }
}

async function runMeasure(args: Args): Promise<ExitCode> {
  if (!args.bundle || !args.target || !args.project) {
    process.stderr.write("--bundle, --target and --project are required for local measurement\n\n" + usage());
    return 2;
  }
  if (!safeTargetOrigin(args.target)) {
    process.stderr.write("--target must be a bare http(s) origin without URL credentials\n");
    return 2;
  }
  if (!Number.isInteger(args.runs) || args.runs < 1) {
    process.stderr.write("--runs must be a positive integer\n");
    return 2;
  }
  try {
    const { bundle } = loadBundle(args.bundle);
    const env = readEnvInputs(args.envFile);
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
    const raw = err instanceof Error ? err.message : String(err);
    const safe = raw
      .replace(/https?:\/\/[^\s)\]}>"]+/g, "<redacted-url>")
      .replace(/\b((?:CHECKLY_)?(?:SECRET|TOKEN|KEY|USER)[A-Z0-9_]*)\s*=\s*[^\s,;]+/gi, "$1=<redacted>")
      .replace(/\/(?:Users|private|var|tmp)\/[^\s:]+/g, "<path>")
      .slice(0, 300);
    process.stderr.write(`measure unavailable: ${safe || "unknown measurement failure"}\n`);
    return 2;
  }
}

async function runVerify(args: Args): Promise<ExitCode> {
  const candidateInputs = [args.patch, args.candidateProject, args.pr].filter(Boolean).length;
  if (!args.bundle || candidateInputs !== 1) {
    process.stderr.write("--bundle and exactly one of --patch, --candidate-project, or --pr are required\n\n" + usage());
    return 2;
  }
  if (args.candidateProject && !args.base) {
    process.stderr.write("--candidate-project requires --base <git-ref> so changes have a fixed comparison point\n");
    return 2;
  }
  if (args.base && !args.candidateProject) {
    process.stderr.write("--base is used only with --candidate-project\n");
    return 2;
  }
  if (args.dryRun) {
    process.stderr.write("--dry-run belonged to the retired direct-API executor; use --executor scene or --executor hybrid\n");
    return 2;
  }
  if (args.target && !safeTargetOrigin(args.target)) {
    process.stderr.write("--target must be a bare http(s) origin without URL credentials\n");
    return 2;
  }
  if (!["shadow", "migration", "enforce"].includes(args.requirementsMode)
    || args.requirementsDigest !== null && !/^[a-f0-9]{64}$/.test(args.requirementsDigest)) {
    process.stderr.write("protected requirements mode or digest is invalid\n");
    return 2;
  }
  if (args.executor === "hybrid" && (!args.target || !args.targetRevision)) {
    process.stderr.write("--executor hybrid requires the exact deployment --target <url> and --target-revision <sha>\n");
    return 2;
  }
  if (args.targetRevision && !/^[0-9a-f]{40}$/.test(args.targetRevision)
    || args.targetMetadata && args.executor !== "hybrid"
    || args.allowForkCloud && (!args.cloudApproved || !args.pr)
    || args.cloudApproved && (!args.pr || args.executor !== "hybrid")
    || args.executor === "hybrid" && (!args.candidateProject && !args.pr || !args.targetMetadata)
    || args.executor === "hybrid" && (!process.env.CHECKLY_API_KEY || !process.env.CHECKLY_ACCOUNT_ID
      || !/^[A-Za-z0-9_-]{1,128}$/.test(process.env.CHECKLY_ACCOUNT_ID))) {
    process.stderr.write("cloud verification requires a bound candidate, 40-hex revision, approved account and deployment metadata\n");
    return 2;
  }
  if (!["scene", "hybrid"].includes(args.executor)) {
    process.stderr.write("--executor must be scene or hybrid\n");
    return 2;
  }

  let revision: CandidateRevision | null = null;
  try {
    const { bundle } = loadBundle(args.bundle);
    if (args.candidateProject) revision = snapshotLocalCandidate(args.candidateProject, args.base!);
    if (args.pr) revision = snapshotPullRequestCandidate(args.pr, args.projectPath);
    const patch = revision ? loadCandidateRevision(revision, bundle) : loadPatch(args.patch!, bundle);
    const env = readEnvInputs(args.envFile);
    const project = args.project ?? revision?.runtimeProjectRoot ?? null;
    if (bundle.playwright && !project) {
      process.stderr.write("Playwright verification needs --project <dir> containing already-installed dependencies\n");
      return 2;
    }
    const deployment = args.targetMetadata ? loadDeploymentMetadata(args.targetMetadata) : null;
    const binding = revision ? bindCandidateTarget({
      revision,
      target: args.target,
      targetRevision: args.targetRevision,
      deployment,
      executor: args.executor,
      cloudApproved: args.cloudApproved,
      allowForkCloud: args.allowForkCloud,
    }) : null;

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

    const result = await verify({
      bundle,
      patch,
      executor,
      target: args.target,
      targetRevision: args.targetRevision ?? undefined,
      candidateProject: revision?.metadata.sourceReference ?? null,
      candidateRevision: revision?.metadata ?? null,
      targetBinding: binding,
      protectedRequirementsMode: args.requirementsMode,
      protectedRequirementsDigest: args.requirementsDigest,
      env,
      environmentName: args.envName ?? undefined,
      projectDir: project,
      verbose: args.verbose,
    });

    revision?.assertUnchanged();
    if (revision?.metadata.source === "github-pr") assertPullRequestStillCurrent(revision);

    if (args.reportJson) writeFileSync(args.reportJson, JSON.stringify(result.report.json, null, 2) + "\n");
    if (args.reportMarkdown) writeFileSync(args.reportMarkdown, result.report.markdown);
    if (args.json) process.stdout.write(JSON.stringify(result.report.json, null, 2) + "\n");
    else process.stdout.write(result.report.markdown);
    if (args.verbose) {
      process.stderr.write(`\n[verify-fix] cost: ${result.cost.checklyCloudRuns} Checkly cloud run(s), ${result.cost.localRuns} local run(s), ${result.cost.browserProcesses} browser process(es), ${(result.cost.wallTimeMs / 1000).toFixed(1)}s wall time\n`);
    }
    return result.decision.exitCode;
  } catch (error) {
    process.stderr.write("verify unavailable: candidate, target binding or private input rejected\n");
    return 2;
  } finally {
    revision?.dispose();
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
    process.stderr.write("cost report unavailable\n");
    return 2;
  }
}

/**
 * `verify-fix init` — Phase 8 task 8.1.
 *
 * Prepares verify-fix inside an EXISTING Checkly project. It never creates or
 * copies the example, never provisions a service, and never reads or stores a
 * credential. Nothing is written until the user confirms.
 */
function runInit(args: Args): ExitCode {
  const plan = planInit(process.cwd());
  if (!plan.project.configFile) {
    for (const note of plan.notes) process.stderr.write(`${note}\n`);
    return 2;
  }
  process.stdout.write(`${initConfirmation(plan)}\n`);
  for (const note of plan.notes) process.stdout.write(`- ${note}\n`);
  if (!plan.actions.length) return 0;

  if (!args.yes && !process.stdin.isTTY) {
    process.stderr.write("refusing to write without confirmation. Re-run with --yes.\n");
    return 2;
  }
  if (!args.yes) {
    process.stderr.write("refusing to write without an interactive confirmation. Re-run with --yes.\n");
    return 2;
  }

  try {
    for (const action of plan.actions) {
      if (action.path === "incidents/") mkdirSync(action.path, { recursive: true });
      else if (action.path === "package.json" && isFile(action.path)) {
        writeFileSync(action.path, mergePackageScripts(readFileSync(action.path, "utf8")), "utf8");
      }
    }
  } catch (error) {
    process.stderr.write(`init failed: ${(error as Error).message}\n`);
    return 2;
  }
  process.stdout.write("\nWrote the actions listed above.\n");
  return 0;
}

async function main(): Promise<ExitCode> {
  let args: Args;
  try { args = parseArgs(process.argv.slice(2)); }
  catch { process.stderr.write("invalid or ambiguous CLI arguments\n"); return 2; }
  if (args.command === "help" || !args.command) {
    process.stdout.write(usage());
    return 2;
  }
  if (args.command === "bundle") return runBundle(args);
  if (args.command === "measure") return runMeasure(args);
  if (args.command === "verify") return runVerify(args);
  if (args.command === "cost-report") return runCostReport(args);
  if (args.command === "init") return runInit(args);
  process.stderr.write("unknown command\n\n" + usage());
  return 2;
}

const code = await main();
process.exit(code);
