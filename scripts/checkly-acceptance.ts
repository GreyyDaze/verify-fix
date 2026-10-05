import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ChecklyClient, ChecklyApiError } from "../src/checkly/client.ts";
import { resolveCredentials } from "../src/checkly/credentials.ts";
import { buildBundle } from "../src/bundle/build.ts";

const checkId = process.env.VERIFY_FIX_ACCEPTANCE_CHECK_ID;
if (!checkId || !/^[A-Za-z0-9_-]{1,128}$/.test(checkId)) {
  throw new Error("VERIFY_FIX_ACCEPTANCE_CHECK_ID is required");
}

const creds = resolveCredentials();
if (!creds) throw new Error("Checkly credentials not found. Set CHECKLY_API_KEY + CHECKLY_ACCOUNT_ID or run checkly login.");

const outDir = process.env.VERIFY_FIX_ACCEPTANCE_OUT
  ?? join(tmpdir(), `verify-fix-checkly-acceptance-${Date.now()}`);
const projectDir = process.env.VERIFY_FIX_ACCEPTANCE_PROJECT || null;
const resultId = process.env.VERIFY_FIX_ACCEPTANCE_RESULT_ID || process.env.VERIFY_FIX_ACCEPTANCE_FAIL_RESULT_ID || undefined;
const passingResultId = process.env.VERIFY_FIX_ACCEPTANCE_PASS_RESULT_ID || undefined;
mkdirSync(outDir, { recursive: true });

const client = new ChecklyClient(creds, { userAgent: "verify-fix-real-checkly-acceptance/0.1.0" });

try {
  const check = await client.getCheck(checkId);
  if (check.id !== checkId) throw new Error(`CHECK_ID_MISMATCH: expected ${checkId}, got ${check.id}`);

  const outcome = await buildBundle(
    {
      checkId,
      resultId,
      passingResultId,
      outDir,
      projectDir,
      // Explicit result IDs may be several days old. Page through bounded history
      // instead of trying the detail endpoint for an ID Checkly can still serve assets for.
      historyLimit: 10000,
      bodies: "api",
      log: (line) => process.stderr.write(`[acceptance] ${line}\n`),
    },
    { client, accountId: creds.accountId, toolVersion: "0.1.0" },
  );

  const m = outcome.manifest;
  if (!m.results.failing || !m.results.passing) {
    throw new Error("REAL_CHECKLY_ACCEPTANCE_INCOMPLETE: expected both failing and passing result evidence");
  }

  if (m.check.checkType === "MULTI_STEP") {
    // Multistep evidence is bound into the v3 multistep capture. Checkly does
    // not expose it as a generic HAR/trace recording.
    if (!m.recordings.multistepFailing || !m.recordings.multistepPassing) {
      throw new Error("REAL_CHECKLY_ACCEPTANCE_INCOMPLETE: bound Multistep evidence was not captured for both selected results");
    }
  } else if (m.check.checkType === "API") {
    if (!m.recordings.apiFailing || !m.recordings.apiPassing) {
      throw new Error("REAL_CHECKLY_ACCEPTANCE_INCOMPLETE: API recordings were not captured for both selected results");
    }
  } else {
    // Checkly may retain a trace for only one of the selected runs. Require
    // actual trace-derived evidence, but do not assume both runs have traces.
    if (!m.recordings.failing && !m.recordings.passing) {
      throw new Error("REAL_CHECKLY_ACCEPTANCE_INCOMPLETE: no real Checkly trace recording was captured");
    }
  }

  if (resultId && m.results.failing?.id !== resultId) {
    throw new Error(`REAL_CHECKLY_ACCEPTANCE_INCOMPLETE: requested failing result ${resultId} was not captured`);
  }
  if (passingResultId && m.results.passing?.id !== passingResultId) {
    throw new Error(`REAL_CHECKLY_ACCEPTANCE_INCOMPLETE: requested passing result ${passingResultId} was not captured`);
  }

  console.log(JSON.stringify({
    evidence: "real-checkly-acceptance",
    checkId,
    checkType: m.check.checkType,
    checkName: m.check.name,
    failingResult: m.results.failing.id,
    passingResult: m.results.passing.id,
    failingLocation: m.results.failing.runLocation,
    passingLocation: m.results.passing.runLocation,
    historyRuns: m.determinism.history.finalRuns,
    historyPassed: m.determinism.history.passed,
    historyFailed: m.determinism.history.failed,
    assetCount: m.provenance.assets.length,
    recordings: m.recordings,
    outDir,
  }, null, 2));
} catch (error) {
  if (error instanceof ChecklyApiError) {
    throw new Error(`REAL_CHECKLY_API_ERROR: HTTP ${error.status}`);
  }
  throw error;
}
