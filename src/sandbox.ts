// Sandbox runner: execute the patched check source in an isolated temp dir
// using Node's native TypeScript support, with the deterministic app-sim as the
// system under test. Verdicts come from the recorded JSON trace, never from
// inference.

import { mkdtemp, writeFile, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import type { CheckRunResult } from "./check-api.ts";

export interface SandboxContext {
  baseUrl: string;
  account: string;
  concurrentRuns?: number;
  timeoutMs?: number;
}

export interface SandboxOutcome {
  passed: boolean;
  results: CheckRunResult[];
  raw: string;
}

/** Maps @checkly/playwright (real SDK) to the sandbox DSL, so the *authentic*
 * check file runs unmodified here and on real Checkly. */
export function remapImports(source: string): string {
  return source
    .replace(/@checkly\/playwright/g, "./check-api.ts")
    .replace(/@checkly\/cli/g, "./check-api.ts");
}

export async function runSandbox(checkSource: string, ctx: SandboxContext): Promise<SandboxOutcome> {
  const dir = await mkdtemp(join(tmpdir(), "verify-fix-sandbox-"));
  try {
    const checkApi = await readFile(join(import.meta.dirname, "check-api.ts"), "utf8");
    const idSrc = await readFile(join(import.meta.dirname, "assertion", "id.ts"), "utf8");
    const remapped = remapImports(checkSource);

    await writeFile(join(dir, "check.ts"), remapped, "utf8");
    await writeFile(join(dir, "id.ts"), idSrc, "utf8");
    await writeFile(join(dir, "check-api.ts"), checkApi.replace("./assertion/id.ts", "./id.ts"), "utf8");

    const driver = [
      `import { runCollected } from "./check-api.ts";`,
      `const concurrent = Number(process.env.CONCURRENT_RUNS ?? 1);`,
      `await runCollected({`,
      `  baseUrl: process.env.APP_BASE_URL ?? "http://127.0.0.1:1",`,
      `  account: process.env.ACCOUNT ?? "demo",`,
      `  concurrentRuns: concurrent,`,
      `});`,
      ``,
    ].join("\n");
    await writeFile(join(dir, "driver.ts"), driver, "utf8");

    const raw = await new Promise<string>((resolve, reject) => {
      const child = spawn("node", ["driver.ts"], {
        cwd: dir,
        env: {
          ...process.env,
          APP_BASE_URL: ctx.baseUrl,
          ACCOUNT: ctx.account,
          CONCURRENT_RUNS: String(ctx.concurrentRuns ?? 1),
        },
      });
      let stdout = "";
      let stderr = "";
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        reject(new Error(`sandbox timeout after ${ctx.timeoutMs ?? 20000}ms; stderr: ${stderr.slice(0, 400)}`));
      }, ctx.timeoutMs ?? 20000);
      child.stdout.on("data", (d) => (stdout += String(d)));
      child.stderr.on("data", (d) => (stderr += String(d)));
      child.on("error", (e) => {
        clearTimeout(timer);
        reject(e);
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        if (code === 0) resolve(stdout);
        else reject(new Error(`sandbox exited ${code}: ${stderr.slice(0, 600)}\nstdout: ${stdout.slice(0, 400)}`));
      });
    });

    const jsonLine = raw
      .trim()
      .split("\n")
      .reverse()
      .find((l) => l.startsWith("{"));
    if (!jsonLine) throw new Error(`no JSON result from sandbox: ${raw.slice(0, 300)}`);
    const parsed = JSON.parse(jsonLine) as { results: CheckRunResult[] };
    const passed = parsed.results.every((r) => r.passed);
    return { passed, results: parsed.results, raw };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}