// Browser-runner boundary. A fake @playwright/test CLI proves file copying,
// project-local dependency resolution, ENVIRONMENT_URL, JSON classification,
// and the no-evidence cases without requiring a browser download in CI.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parsePlaywrightReport, runPlaywrightSandbox } from "../src/playwright-sandbox.ts";

function report(status: string, error?: string): string {
  return JSON.stringify({
    suites: [{ title: "tests/booking.spec.ts", specs: [{ title: "books", tests: [{ projectName: "booking", results: [{ status, ...(error ? { error: { message: error } } : {}) }] }] }] }],
    errors: [],
  });
}

describe("Playwright JSON evidence", () => {
  test("passed and failed tests are observations; zero/skipped/malformed reports are inconclusive", () => {
    assert.equal(parsePlaywrightReport(report("passed"), 0).passed, true);
    const failed = parsePlaywrightReport(report("failed", "Error: expected 200"), 1);
    assert.equal(failed.passed, false);
    assert.equal(failed.inconclusive, false);
    assert.match(failed.trace[0].what, /expected 200/);
    assert.equal(parsePlaywrightReport(report("skipped"), 0).inconclusive, true);
    assert.equal(parsePlaywrightReport(JSON.stringify({ suites: [] }), 0).inconclusive, true);
    assert.equal(parsePlaywrightReport("not json", 1, "runner crashed").inconclusive, true);
  });

  test("uses the project's Playwright CLI, copies the candidate tree, and points it at ENVIRONMENT_URL", async () => {
    const project = mkdtempSync(join(tmpdir(), "verify-fix-fake-pw-project-"));
    const pkg = join(project, "node_modules", "@playwright", "test");
    mkdirSync(pkg, { recursive: true });
    writeFileSync(join(pkg, "package.json"), JSON.stringify({ name: "@playwright/test", exports: { "./cli": "./cli.js" } }));
    writeFileSync(join(pkg, "cli.js"), [
      `const fs = require("node:fs");`,
      `const source = fs.readFileSync("tests/booking.spec.ts", "utf8");`,
      `fetch(process.env.ENVIRONMENT_URL + "/api/probe").then(async (r) => {`,
      `  const status = source.includes("CANDIDATE") && r.status === 204 ? "passed" : "failed";`,
      `  console.log(JSON.stringify({ suites: [{ title: "tests/booking.spec.ts", specs: [{ title: "books", tests: [{ projectName: "booking", results: [{ status }] }] }] }], errors: [] }));`,
      `  process.exitCode = status === "passed" ? 0 : 1;`,
      `});`,
    ].join("\n"));

    let hits = 0;
    const server = createServer((_req, res) => { hits++; res.writeHead(204).end(); });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("no test port");
    try {
      const outcome = await runPlaywrightSandbox({
        baseUrl: `http://127.0.0.1:${address.port}`,
        projectDir: project,
        configFile: "playwright.config.ts",
        projects: ["booking"],
        checkFile: "tests/booking.spec.ts",
        files: { "playwright.config.ts": "export default {}", "tests/booking.spec.ts": "// CANDIDATE" },
        seed: 123,
      });
      assert.equal(outcome.passed, true, outcome.reason ?? outcome.raw);
      assert.equal(outcome.inconclusive, false);
      assert.equal(hits, 1);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
