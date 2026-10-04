import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

import { buildBundle } from "../src/bundle/build.ts";
import { loadBundle } from "../src/bundle.ts";
import { resolveCredentials } from "../src/checkly/credentials.ts";
import { ChecklyClient, ChecklyApiError } from "../src/checkly/client.ts";
import { loadPatch } from "../src/patch.ts";

const execFileAsync = promisify(execFile);
const ROOT = resolve(import.meta.dirname, "..");

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error("REAL_CHECKLY_VERIFY_ACCEPTANCE_CONFIG: missing " + name);
  return value;
}

function safeOrigin(raw: string): boolean {
  if (raw.length === 0 || raw.length > 2048 || /[\x00-\x20\x7f\\]/.test(raw)) return false;
  try {
    const url = new URL(raw);
    return (url.protocol === "https:" || url.protocol === "http:")
      && url.hostname !== "" && !url.username && !url.password
      && !url.search && !url.hash && (raw === url.origin || raw === url.origin + "/");
  } catch {
    return false;
  }
}

async function runCli(args: string[]) {
  try {
    const result = await execFileAsync(process.execPath, [join(ROOT, "src/cli.ts"), ...args], {
      cwd: ROOT,
      env: { ...process.env },
      maxBuffer: 4 * 1024 * 1024,
    });
    return { code: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    const e = error as { code?: number | string; stdout?: string; stderr?: string; message?: string };
    return {
      code: typeof e.code === "number" ? e.code : Number(e.code ?? 2),
      stdout: e.stdout ?? "",
      stderr: e.stderr ?? e.message ?? "",
    };
  }
}

function assertCode(label: string, actual: number, expected: number, output: string): void {
  if (actual !== expected) {
    throw new Error("REAL_CHECKLY_VERIFY_ACCEPTANCE_FAILED: " + label + " expected exit " + expected + ", got " + actual + "\n" + output);
  }
}

function json(raw: string): { verdict?: string; exitCode?: number } | null {
  try { return JSON.parse(raw) as { verdict?: string; exitCode?: number }; } catch { return null; }
}

async function main(): Promise<void> {
  const checkId = required("VERIFY_FIX_ACCEPTANCE_CHECK_ID");
  const resultId = required("VERIFY_FIX_ACCEPTANCE_RESULT_ID");
  const passingResultId = required("VERIFY_FIX_ACCEPTANCE_PASS_RESULT_ID");
  const target = required("VERIFY_FIX_ACCEPTANCE_TARGET");
  const envFile = required("VERIFY_FIX_ACCEPTANCE_ENV_FILE");
  const patchDir = resolve(required("VERIFY_FIX_ACCEPTANCE_PATCH"));
  const projectDir = resolve(required("VERIFY_FIX_ACCEPTANCE_PROJECT"));
  if (!safeOrigin(target)) throw new Error("REAL_CHECKLY_VERIFY_ACCEPTANCE_CONFIG: target must be an origin URL");

  const outDir = resolve(process.env.VERIFY_FIX_ACCEPTANCE_OUT ?? mkdtempSync(join(tmpdir(), "verify-fix-real-")));
  const creds = resolveCredentials();
  if (!creds) throw new Error("REAL_CHECKLY_VERIFY_ACCEPTANCE_CONFIG: Checkly credentials are unavailable");

  mkdirSync(outDir, { recursive: true });
  const client = new ChecklyClient(creds, { userAgent: "verify-fix-real-verification-acceptance/0.1.0" });

  let outcome;
  try {
    outcome = await buildBundle({
      checkId,
      resultId,
      passingResultId,
      outDir,
      projectDir,
      historyLimit: 100,
      bodies: "api",
      keepRaw: false,
    }, { client, accountId: creds.accountId, toolVersion: "0.1.0" });
  } catch (error) {
    if (error instanceof ChecklyApiError) throw new Error("REAL_CHECKLY_VERIFY_ACCEPTANCE_FAILED: Checkly HTTP " + error.status);
    throw error;
  }

  const manifest = outcome.manifest;
  if (manifest.results.failing?.id !== resultId) throw new Error("REAL_CHECKLY_VERIFY_ACCEPTANCE_FAILED: requested failing result was not captured");
  if (manifest.results.passing?.id !== passingResultId) throw new Error("REAL_CHECKLY_VERIFY_ACCEPTANCE_FAILED: requested passing result was not captured");
  if (manifest.check.checkType !== "PLAYWRIGHT") {
    throw new Error("REAL_CHECKLY_VERIFY_ACCEPTANCE_CONFIG: full verification acceptance currently targets the Playwright slots-booking check; got " + manifest.check.checkType);
  }
  if (!manifest.recordings.failing && !manifest.recordings.passing) {
    throw new Error("REAL_CHECKLY_VERIFY_ACCEPTANCE_FAILED: no real browser evidence was captured");
  }

  const loaded = loadBundle(outcome.outDir).bundle;
  const noOpPatch = join(outDir, "original-check.noop.ts");
  writeFileSync(noOpPatch, loaded.checkSource, "utf8");
  const reportDir = join(outDir, "reports");
  mkdirSync(reportDir, { recursive: true });

  // Measure the captured baseline before candidate verification so the determinism gate
  // has real repeated-run evidence instead of silently remaining at 0/20.
  const measurement = await runCli([
    "measure", "--bundle", outcome.outDir,
    "--target", target, "--project", projectDir, "--env-file", envFile,
    "--runs", "20", "--json",
  ]);
  assertCode("20-run determinism measurement", measurement.code, 0, measurement.stdout + measurement.stderr);
  let determinism: Record<string, unknown>;
  try {
    determinism = JSON.parse(measurement.stdout) as Record<string, unknown>;
  } catch {
    throw new Error("REAL_CHECKLY_VERIFY_ACCEPTANCE_FAILED: determinism measurement returned invalid JSON");
  }

  const good = await runCli([
    "verify", "--patch", patchDir, "--bundle", outcome.outDir,
    "--target", target, "--project", projectDir, "--env-file", envFile, "--json",
    "--report-json", join(reportDir, "good.json"),
    "--report-markdown", join(reportDir, "good.md"),
  ]);
  assertCode("known valid repair", good.code, 0, good.stdout + good.stderr);

  const noOp = await runCli([
    "verify", "--patch", noOpPatch, "--bundle", outcome.outDir,
    "--target", target, "--project", projectDir, "--env-file", envFile, "--json",
    "--report-json", join(reportDir, "noop.json"),
    "--report-markdown", join(reportDir, "noop.md"),
  ]);
  assertCode("no-op candidate", noOp.code, 1, noOp.stdout + noOp.stderr);

  const uncertain = await runCli([
    "verify", "--patch", patchDir, "--bundle", outcome.outDir,
    "--project", projectDir, "--env-file", envFile, "--json",
  ]);
  assertCode("missing-target candidate", uncertain.code, 2, uncertain.stdout + uncertain.stderr);

  const goodJson = json(good.stdout);
  const noOpJson = json(noOp.stdout);
  const uncertainJson = json(uncertain.stdout);
  if (goodJson?.verdict !== "PASS" || goodJson.exitCode !== 0) throw new Error("REAL_CHECKLY_VERIFY_ACCEPTANCE_FAILED: good candidate report is not PASS/0");
  if (noOpJson?.verdict !== "FAILED" || noOpJson.exitCode !== 1) throw new Error("REAL_CHECKLY_VERIFY_ACCEPTANCE_FAILED: no-op report is not FAILED/1");
  if (uncertainJson?.verdict !== "UNCERTAIN" || uncertainJson.exitCode !== 2) throw new Error("REAL_CHECKLY_VERIFY_ACCEPTANCE_FAILED: missing-target report is not UNCERTAIN/2");

  const patch = loadPatch(patchDir, loaded);
  if (Object.keys(patch.files).length === 0) throw new Error("REAL_CHECKLY_VERIFY_ACCEPTANCE_FAILED: known repair patch is empty");

  process.stdout.write(JSON.stringify({
    check: { id: manifest.check.id, name: manifest.check.name, type: manifest.check.checkType },
    results: { failing: resultId, passing: passingResultId },
    evidence: { failingRecording: manifest.recordings.failing, passingRecording: manifest.recordings.passing, outDir: outcome.outDir },
    determinism,
    verification: {
      goodRepair: { verdict: goodJson?.verdict, exitCode: goodJson?.exitCode },
      noOp: { verdict: noOpJson?.verdict, exitCode: noOpJson?.exitCode },
      missingTarget: { verdict: uncertainJson?.verdict, exitCode: uncertainJson?.exitCode },
    },
    reports: reportDir,
  }, null, 2) + "\n");
}

main().catch((error) => {
  process.stderr.write((error instanceof Error ? error.message : String(error)) + "\n");
  process.exitCode = 2;
});
