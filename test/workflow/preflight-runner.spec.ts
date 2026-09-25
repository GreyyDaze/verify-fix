import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  main,
  writeOutput,
} from "../../.github/helpers/run-production-url-preflight.mjs";

// Evidence-contract tests for the preflight runner: what lands in
// GITHUB_OUTPUT and which exit code follows for invalid / waiting / ready
// evidence. All GitHub access is stubbed; no network, no secrets.

const SHA = "a".repeat(40);
const VERIFICATION_URL = "https://deploy-slug.vercel.app";
const MONITORING_URL = "https://monitoring.example.org";
const MARKER = "verify-fix:stable-alias-verified";

const ENV_KEYS = [
  "GITHUB_OUTPUT",
  "GITHUB_REPOSITORY",
  "GH_TOKEN",
  "DEPLOYMENT_ID",
  "DEPLOYMENT_SHA",
  "DEPLOYMENT_ENVIRONMENT",
  "EVENT_URL",
] as const;

type SavedEnv = Record<string, string | undefined>;

function primeEnv(outputFile: string): SavedEnv {
  const values: Record<(typeof ENV_KEYS)[number], string> = {
    GITHUB_OUTPUT: outputFile,
    GITHUB_REPOSITORY: "GreyyDaze/verify-fix",
    GH_TOKEN: "ghs_test_token_value_not_a_secret",
    DEPLOYMENT_ID: "41",
    DEPLOYMENT_SHA: SHA,
    DEPLOYMENT_ENVIRONMENT: "production",
    EVENT_URL: VERIFICATION_URL,
  };
  const saved: SavedEnv = {};
  for (const key of ENV_KEYS) {
    saved[key] = process.env[key];
    process.env[key] = values[key];
  }
  return saved;
}

function restoreEnv(saved: SavedEnv): void {
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key]!;
  }
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200 });
}

function deploymentRecord(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { id: 41, sha: SHA, environment: "production", ...overrides };
}

function stubFetch(responses: Response[]): () => void {
  const original = globalThis.fetch;
  globalThis.fetch = (async () => {
    const next = responses.shift();
    if (next === undefined) throw new Error("unexpected extra fetch call");
    return next;
  }) as unknown as typeof fetch;
  return () => {
    globalThis.fetch = original;
  };
}

async function runWithOutput(
  responses: Response[],
  body: (output: string, code: number) => void,
): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "verify-fix-preflight-"));
  const outputFile = join(dir, "github-output.txt");
  const saved = primeEnv(outputFile);
  const restoreFetch = stubFetch(responses);
  try {
    const code = await main();
    const output = readFileSync(outputFile, "utf8");
    body(output, code);
  } finally {
    restoreFetch();
    restoreEnv(saved);
    rmSync(dir, { recursive: true, force: true });
  }
}

test("invalid evidence writes ready=false and its stable reason to GITHUB_OUTPUT, no URL outputs, exits non-zero", async () => {
  // Both roles present but their origins overlap: resolver-level invalid.
  const generated = {
    id: 10,
    state: "success",
    description: null,
    environment_url: "https://same.example.org",
    creator: { login: "vercel[bot]", type: "Bot" },
    performed_via_github_app: { slug: "vercel" },
  };
  const manual = {
    id: 100,
    state: "success",
    description: MARKER,
    environment_url: "https://same.example.org",
    creator: { login: "alice", type: "User" },
    performed_via_github_app: null,
  };
  await runWithOutput(
    [jsonResponse(deploymentRecord()), jsonResponse([generated, manual])],
    (output, code) => {
      assert.equal(code, 1, "invalid evidence must exit non-zero");
      assert.match(output, /^ready=false$/m);
      assert.match(output, /^reason=overlapping-url-roles$/m);
      assert.doesNotMatch(output, /verification_url=/, "no URL output on invalid evidence");
      assert.doesNotMatch(output, /monitoring_url=/, "no URL output on invalid evidence");
      assert.doesNotMatch(output, /ready=true/, "invalid evidence is never ready");
    },
  );
});

test("invalid runner evidence (earlier failure path) also writes outputs, no URLs, exits non-zero", async () => {
  // Deployment id mismatch: fails before the resolver even runs.
  await runWithOutput(
    [jsonResponse(deploymentRecord({ id: 99 }))],
    (output, code) => {
      assert.equal(code, 1, "invalid evidence must exit non-zero");
      assert.match(output, /^ready=false$/m);
      assert.match(output, /^reason=deployment-id-mismatch$/m);
      assert.doesNotMatch(output, /verification_url=/);
      assert.doesNotMatch(output, /monitoring_url=/);
    },
  );
});

test("waiting evidence writes ready=false and its reason to GITHUB_OUTPUT, no URL outputs, exits 0", async () => {
  // Empty status history: waiting-for-both-statuses.
  await runWithOutput(
    [jsonResponse(deploymentRecord()), jsonResponse([])],
    (output, code) => {
      assert.equal(code, 0, "waiting evidence must exit 0");
      assert.match(output, /^ready=false$/m);
      assert.match(output, /^reason=waiting-for-both-statuses$/m);
      assert.doesNotMatch(output, /verification_url=/, "no URL output on waiting evidence");
      assert.doesNotMatch(output, /monitoring_url=/, "no URL output on waiting evidence");
      assert.doesNotMatch(output, /ready=true/, "waiting evidence is never ready");
    },
  );
});

test("ready evidence writes both role URLs and exits 0", async () => {
  const generated = {
    id: 10,
    state: "success",
    description: null,
    environment_url: VERIFICATION_URL,
    creator: { login: "vercel[bot]", type: "Bot" },
    performed_via_github_app: { slug: "vercel" },
  };
  const manual = {
    id: 100,
    state: "success",
    description: MARKER,
    environment_url: MONITORING_URL,
    creator: { login: "alice", type: "User" },
    performed_via_github_app: null,
  };
  await runWithOutput(
    [jsonResponse(deploymentRecord()), jsonResponse([generated, manual])],
    (output, code) => {
      assert.equal(code, 0, "ready evidence must exit 0");
      assert.match(output, /^ready=true$/m);
      assert.match(output, /^reason=complete-url-role-pair$/m);
      assert.match(output, new RegExp(`^verification_url=${VERIFICATION_URL}$`, "m"));
      assert.match(output, new RegExp(`^monitoring_url=${MONITORING_URL}$`, "m"));
    },
  );
});

test("unexpected exceptions print only stable runner-failed evidence — never the exception details", async () => {
  const CANARY_TOKEN = "ghp_CANARY_TOKEN_9f8e7d6c_not_a_real_secret";
  const CANARY_URL = "https://canary.example.org/leak?secret=do-not-print";
  const dir = mkdtempSync(join(tmpdir(), "verify-fix-preflight-"));
  const outputFile = join(dir, "github-output.txt");
  const saved = primeEnv(outputFile);

  const stdoutLines: string[] = [];
  const stderrLines: string[] = [];
  const originalLog = console.log;
  const originalError = console.error;
  const originalFetch = globalThis.fetch;
  console.log = (...args: unknown[]): void => {
    stdoutLines.push(args.map(String).join(" "));
  };
  console.error = (...args: unknown[]): void => {
    stderrLines.push(args.map(String).join(" "));
  };
  globalThis.fetch = (async () => {
    throw new Error(`connect failed: token=${CANARY_TOKEN} url=${CANARY_URL}`);
  }) as unknown as typeof fetch;
  try {
    const code = await main();
    assert.equal(code, 1, "an unexpected exception must exit non-zero");
  } finally {
    console.log = originalLog;
    console.error = originalError;
    globalThis.fetch = originalFetch;
    restoreEnv(saved);
  }

  const output = readFileSync(outputFile, "utf8");
  const observed = [...stdoutLines, ...stderrLines, output].join("\n");
  assert.ok(!observed.includes(CANARY_TOKEN), "canary token must never appear in stdout, stderr, or GITHUB_OUTPUT");
  assert.ok(!observed.includes(CANARY_URL), "canary URL must never appear in stdout, stderr, or GITHUB_OUTPUT");
  assert.ok(!observed.includes("connect failed"), "exception message text must never be printed");
  // The stable evidence contract still holds exactly.
  assert.match(output, /^ready=false$/m);
  assert.match(output, /^reason=runner-failed$/m);
  assert.doesNotMatch(output, /verification_url=/);
  assert.doesNotMatch(output, /monitoring_url=/);
  assert.ok(
    [...stdoutLines, ...stderrLines].some((line) => line.includes("runner-failed")),
    "a stable runner-failed message must be printed",
  );
  rmSync(dir, { recursive: true, force: true });
});

test("GITHUB_OUTPUT writes reject carriage-return and newline injection in names and values", () => {
  const dir = mkdtempSync(join(tmpdir(), "verify-fix-output-"));
  const outputFile = join(dir, "github-output.txt");
  const savedGhOutput = process.env.GITHUB_OUTPUT;
  process.env.GITHUB_OUTPUT = outputFile;
  try {
    // Names: strict safe identifier pattern — CR/LF (and anything else
    // outside [A-Za-z_][A-Za-z0-9_]*) is rejected.
    assert.throws(() => writeOutput("ready\nname", "x"), /invalid GITHUB_OUTPUT name/);
    assert.throws(() => writeOutput("ready\rname", "x"), /invalid GITHUB_OUTPUT name/);
    assert.throws(() => writeOutput("ready url", "x"), /invalid GITHUB_OUTPUT name/);
    assert.throws(() => writeOutput("1ready", "x"), /invalid GITHUB_OUTPUT name/);
    assert.throws(() => writeOutput("", "x"), /invalid GITHUB_OUTPUT name/);
    // Values: CR or LF would forge extra output lines — rejected.
    assert.throws(() => writeOutput("reason", "line1\nline2"), /invalid GITHUB_OUTPUT value/);
    assert.throws(() => writeOutput("reason", "line1\rline2"), /invalid GITHUB_OUTPUT value/);
    assert.throws(() => writeOutput("verification_url", "https://a.example.org\nready=true"), /invalid GITHUB_OUTPUT value/);
    assert.throws(() => writeOutput("verification_url", "https://a.example.org\rready=true"), /invalid GITHUB_OUTPUT value/);
    // Nothing was written by any rejected attempt.
    assert.ok(!existsSync(outputFile), "rejected writes must not touch the output file");
    // The single-line form still works for a safe pair.
    writeOutput("ready", "false");
    assert.equal(readFileSync(outputFile, "utf8"), "ready=false\n");
  } finally {
    if (savedGhOutput === undefined) delete process.env.GITHUB_OUTPUT;
    else process.env.GITHUB_OUTPUT = savedGhOutput;
    rmSync(dir, { recursive: true, force: true });
  }
});
