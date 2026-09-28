// End-to-end Multistep correction: two real Playwright API-fixture runs through
// the scene proxy AND the mandatory HTTPS bridge/reporter. The upstream app is
// locally constructed; these are mechanics, not real Checkly/cloud proof.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SceneExecutor, multistepRegionForLocation } from "../../src/executor/scene.ts";
import { runMultiStepSandbox } from "../../src/multistep/executor.ts";
import { buildReport } from "../../src/report/report.ts";
import type { Bundle, Scene } from "../../src/types.ts";

const WEB = new URL("../../examples/slots-booking/web/", import.meta.url).pathname;
const FILE = "checks/multistep-booking.spec.ts";
const SPEC = readFileSync(join(WEB, FILE), "utf8");
const CONSTRUCT = readFileSync(join(WEB, "checks/multistep-booking.check.ts"), "utf8");
const EAST = "synthetic-account-east";
const WEST = "synthetic-account-west";

interface App {
  origin: string;
  accounts: string[];
  paths: string[];
  stop(): Promise<void>;
}
function startApp(): Promise<App> {
  const accounts: string[] = [];
  const paths: string[] = [];
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown> : {};
      const route = req.url ?? "";
      paths.push(`${req.method} ${route}`);
      let data: Record<string, unknown> = {};
      let status = 200;
      const accountFromToken = typeof req.headers.authorization === "string" && req.headers.authorization.startsWith("Bearer token-")
        ? req.headers.authorization.slice("Bearer token-".length) : null;
      if (route === "/api/login" && req.method === "POST") {
        const account = body.account;
        if (typeof account === "string") accounts.push(account);
        data = { ok: true, account, version: 1, token: `token-${String(account)}`, store: "memory" };
      } else if (route === "/api/session" && accountFromToken) {
        data = { valid: true, account: accountFromToken, tokenVersion: 1, currentVersion: 1 };
      } else if (route === "/api/slots") {
        data = { slots: ["09:30", "10:00"], delayMs: 0 };
      } else if (route === "/api/book" && accountFromToken) {
        data = { confirmed: true, booking: "CONFIRMED", account: accountFromToken, slot: body.slot, version: 1 };
      } else { status = 401; data = { error: "unrecognized fixture request" }; }
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(data));
    });
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => {
    const addr = server.address();
    if (!addr || typeof addr !== "object") throw new Error("fixture app did not bind");
    resolve({ origin: `http://127.0.0.1:${addr.port}`, accounts, paths,
      stop: () => new Promise<void>((done) => server.close(() => done())) });
  }));
}
function scene(): Scene {
  return {
    sceneId: "two-regions", type: "REPRODUCTION", mode: "live-concurrent:2", state: "synthetic flat contract",
    environment: "target", verdict: { mustFail: false,
      provenance: { kind: "recorded", runId: "synthetic", artifactId: "recordings/failing.multistep.json" },
      envAssumptions: ["locations", "target-resolution"] },
    experiments: [{ repetitions: 1, durationSec: 30, expectStable: true }], assertionsInvolved: [],
  };
}
function bundle(locations: string[] = ["us-east-1", "eu-west-1"]): Bundle {
  return {
    schemaVersion: "v3", incidentId: "synthetic-region-transaction", incident: { title: "synthetic", description: "synthetic" },
    check: { repo: "", file: FILE, name: "slots booking multistep transaction", checkType: "MULTI_STEP", logicalId: "slots-booking-multistep", deployedId: "synthetic" },
    checkSource: SPEC, files: { [FILE]: SPEC, "checks/multistep-booking.check.ts": CONSTRUCT }, configFile: null,
    config: { runParallel: true, locations, frequencyMinutes: 5,
      environmentVariables: ["ENVIRONMENT_URL", "MULTISTEP_USER_US_EAST_1", "MULTISTEP_USER_EU_WEST_1"] },
    recordedOrigin: null, dir: WEB, playwright: null, api: null,
    multistep: { kind: "failing", steps: ["login", "session", "slots", "book 09:30"], problems: [] },
    scenes: [scene()], envAssumptions: [{ id: "locations", text: "fixture", verified: true }, { id: "target-resolution", text: "fixture", verified: true }],
    determinism: { targetRuns: 20, achieved: 20, sequentialPassRate: 1, overlapFailRate: 0, lastVerifiedAt: "2026-09-27" },
    runBudget: { maxPerScene: 1, used: 0 }, oracleProvenance: { recorded: 1, codeDerived: 0 },
  };
}

// The real adapter may take a few seconds to synthesize per-run certificates.
test("two locations receive DISTINCT trusted REGION accounts; ordered traffic, measured zero browsers and per-run costs propagate to report", { timeout: 180_000 }, async () => {
  const app = await startApp();
  const b = bundle();
  const executor = new SceneExecutor({ target: app.origin, projectDir: WEB,
    env: { MULTISTEP_USER_US_EAST_1: EAST, MULTISTEP_USER_EU_WEST_1: WEST }, barrierTimeoutMs: 25_000, sandboxTimeoutMs: 90_000 });
  try {
    assert.equal(multistepRegionForLocation("us-east-1"), "us-east-1");
    assert.equal(multistepRegionForLocation("eu-west-1"), "eu-west-1");
    const observation = await executor.runScene(b, SPEC, scene());
    assert.equal(observation.observed, "pass", observation.reason ?? JSON.stringify(observation.trace));
    assert.equal(observation.repetitions, 1);
    assert.deepEqual(app.accounts.slice().sort(), [WEST, EAST].sort(), "each monitoring location used its OWN account");
    assert.equal(app.paths.length, 8, "four ordered upstream requests per sandbox run");
    const byMethod = app.paths.reduce((counts, path) => (counts.set(path, (counts.get(path) ?? 0) + 1), counts), new Map<string, number>());
    assert.deepEqual([...byMethod.entries()].sort(), [["POST /api/login", 2], ["GET /api/session", 2], ["GET /api/slots", 2], ["POST /api/book", 2]].sort());
    const cost = executor.costReport();
    assert.deepEqual(cost.multiStepBrowserCounts, [0, 0], "actual per-run descendant process samples, not the declared browser project count");
    assert.deepEqual(cost.byScene[0]?.multiStepBrowserCounts, [0, 0]);
    assert.equal(cost.browserProcesses, 0);
    assert.equal(cost.httpRequests, 8);
    const report = buildReport({ bundle: b, determinismGate: { blocked: false }, unverifiedAssumptions: [] } as unknown as Parameters<typeof buildReport>[0],
      { verdict: "UNCERTAIN", exitCode: 2, rows: [], reasons: [], adequacy: null, weakness: null }, new Map(),
      { cost, multistep: b.multistep });
    assert.match(report.markdown, /Multistep browser-process measurements: 2 run\(s\), 2 measured, 0 unavailable; peak 0/);
    assert.deepEqual((report.json.cost as typeof cost).multiStepBrowserCounts, [0, 0]);
  } finally {
    await executor.close();
    await app.stop();
  }
});

test("project-level config cannot relabel a Multistep construct's two trusted locations as one region", { timeout: 180_000 }, async () => {
  const app = await startApp();
  const b = bundle();
  const executor = new SceneExecutor({ target: app.origin, projectDir: WEB,
    env: { MULTISTEP_USER_US_EAST_1: EAST, MULTISTEP_USER_EU_WEST_1: WEST } });
  try {
    const observation = await executor.runScene(b, SPEC, scene(), { phase: "candidate", files: b.files,
      config: { ...b.config!, locations: ["us-east-1"], runParallel: false } });
    assert.equal(observation.observed, "pass");
    assert.deepEqual(app.accounts.slice().sort(), [WEST, EAST].sort());
    assert.equal(app.paths.length, 8);
    assert.deepEqual(executor.costReport().multiStepBrowserCounts, [0, 0]);
  } finally {
    await executor.close();
    await app.stop();
  }
});

test("unknown or conflicting region is UNCERTAIN before a runner starts; CI is reserved inside the adapter", { timeout: 180_000 }, async () => {
  const app = await startApp();
  const unknown = new SceneExecutor({ target: app.origin, projectDir: WEB,
    env: { MULTISTEP_USER_US_EAST_1: EAST, MULTISTEP_USER_EU_WEST_1: WEST } });
  const conflict = new SceneExecutor({ target: app.origin, projectDir: WEB,
    env: { MULTISTEP_USER_US_EAST_1: EAST, MULTISTEP_USER_EU_WEST_1: WEST, REGION: "us-east-1" } });
  const dirty = new SceneExecutor({ target: app.origin, projectDir: WEB,
    env: { MULTISTEP_USER_US_EAST_1: `${EAST} `, MULTISTEP_USER_EU_WEST_1: EAST } });
  try {
    assert.equal(multistepRegionForLocation("ap-south-1"), null);
    const a = await unknown.runScene(bundle(["ap-south-1", "eu-west-1"]), SPEC, scene());
    assert.equal(a.observed, "uncertain");
    assert.match(a.reason ?? "", /both trusted regions/);
    assert.equal(unknown.costReport().localRuns, 0);
    const c = await conflict.runScene(bundle(), SPEC, scene());
    assert.equal(c.observed, "uncertain");
    assert.match(c.reason ?? "", /overrides a trusted runner key/);
    assert.equal(conflict.costReport().localRuns, 0);
    const d = await dirty.runScene(bundle(), SPEC, scene());
    assert.equal(d.observed, "uncertain");
    assert.match(d.reason ?? "", /both be present and distinct/);
    assert.equal(dirty.costReport().localRuns, 0);
    assert.equal(app.paths.length, 0);
    const out = await runMultiStepSandbox({ projectDir: WEB, baseUrl: app.origin,
      files: { [FILE]: SPEC }, checkFile: FILE, env: { CI: "0", REGION: "us-east-1", MULTISTEP_USER_US_EAST_1: EAST, MULTISTEP_USER_EU_WEST_1: "fixture-west-distinct" } });
    assert.equal(out.inconclusive, true);
    assert.equal(out.browserProcesses, null);
    assert.equal(out.environmentOrigin, null);
    assert.match(out.reason ?? "", /not a minimal approved Multistep environment/);
  } finally {
    await unknown.close();
    await conflict.close();
    await dirty.close();
    await app.stop();
  }
});

test("a real browser-like DESCENDANT process is sampled, propagated to scene costs, and never mistaken for API-only execution", { timeout: 180_000 }, async () => {
  // A synthetic CLI is used only to exercise the process sampler. It launches
  // a browser-named descendant but produces no trustworthy request evidence;
  // no result from this case can prove a passing check.
  const projectDir = mkdtempSync(join(tmpdir(), "verify-fix-browser-sample-"));
  const moduleDir = join(projectDir, "node_modules", "@playwright", "test");
  mkdirSync(moduleDir, { recursive: true });
  writeFileSync(join(moduleDir, "package.json"), JSON.stringify({ name: "@playwright/test", exports: { "./cli": "./cli.js" } }));
  writeFileSync(join(moduleDir, "cli.js"), [
    "const { spawn } = require('node:child_process')",
    "const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 10000)'],",
    "  { argv0: 'chromium', env: { PATH: process.env.PATH || '' }, stdio: 'ignore' })",
    "setTimeout(() => { child.kill(); process.exit(0) }, 1800)",
  ].join("\n"));
  const app = await startApp();
  const executor = new SceneExecutor({ target: app.origin, projectDir,
    env: { MULTISTEP_USER_US_EAST_1: EAST, MULTISTEP_USER_EU_WEST_1: WEST } });
  try {
    const observation = await executor.runScene(bundle(), SPEC, { ...scene(), mode: "live" });
    assert.equal(observation.observed, "uncertain", "a stub CLI cannot satisfy the bridge/reporter proof");
    assert.equal(app.paths.length, 0);
    const counts = executor.costReport().multiStepBrowserCounts;
    assert.ok(counts && counts[0] !== null && counts[0] >= 1, JSON.stringify(counts));
    assert.equal(executor.costReport().browserProcesses, counts[0]);
    assert.deepEqual(executor.costReport().byScene[0]?.multiStepBrowserCounts, counts);
  } finally {
    await executor.close();
    await app.stop();
  }
});

test("successful ordered bridge+reporter traffic without browser sampling remains UNCERTAIN (no inferred zero)", { timeout: 180_000 }, async () => {
  const app = await startApp();
  const fakeBin = mkdtempSync(join(tmpdir(), "verify-fix-sampling-unavailable-"));
  const ps = join(fakeBin, "ps");
  writeFileSync(ps, "#!/bin/sh\nexit 1\n", { mode: 0o755 });
  const saved = process.env.PATH;
  try {
    process.env.PATH = `${fakeBin}:${saved ?? ""}`;
    const out = await runMultiStepSandbox({ projectDir: WEB, baseUrl: app.origin,
      files: { [FILE]: SPEC }, checkFile: FILE, env: { REGION: "us-east-1", MULTISTEP_USER_US_EAST_1: EAST, MULTISTEP_USER_EU_WEST_1: "fixture-west-distinct" } });
    assert.equal(app.paths.length, 4, "the transaction actually ran");
    assert.equal(out.proxyEvidence.length, 4);
    assert.equal(out.reporterEvidence.length, 4);
    assert.equal(out.inconclusive, true);
    assert.equal(out.passed, false);
    assert.equal(out.browserProcesses, null);
    assert.match(out.reason ?? "", /measurement unavailable/);
  } finally {
    process.env.PATH = saved;
    await app.stop();
  }
});

test("concurrency one runs BOTH trusted regions sequentially, not only the first account", { timeout: 180_000 }, async () => {
  const app = await startApp();
  const b = bundle();
  b.config!.runParallel = false; // canonical two-region check scheduled one at a time
  const executor = new SceneExecutor({ target: app.origin, projectDir: WEB,
    env: { MULTISTEP_USER_US_EAST_1: EAST, MULTISTEP_USER_EU_WEST_1: WEST } });
  try {
    const observation = await executor.runScene(b, SPEC, scene());
    assert.equal(observation.observed, "pass", observation.reason);
    assert.deepEqual(app.accounts, [EAST, WEST]);
    assert.equal(app.paths.length, 8);
    assert.deepEqual(executor.costReport().multiStepBrowserCounts, [0, 0]);
    assert.equal(executor.costReport().httpRequests, 8);
  } finally {
    await executor.close();
    await app.stop();
  }
});
