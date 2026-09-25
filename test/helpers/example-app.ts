// Starts the example app (examples/slots-booking/web) the way CI would: a
// production build served by `next start`, in-memory store, on a free local
// port. This is the real target for the seeded suite — no simulator.
//
// `next build` runs only when .next/BUILD_ID is missing (≈6 s warm, longer cold).

import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";

export const EXAMPLE_APP_DIR = join(import.meta.dirname, "..", "..", "examples", "slots-booking", "web");

export interface RunningApp {
  url: string;
  stop(): Promise<void>;
}

export async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.listen(0, "127.0.0.1", () => {
      const addr = s.address();
      const port = addr && typeof addr === "object" ? addr.port : 0;
      s.close(() => (port ? resolve(port) : reject(new Error("no port"))));
    });
    s.on("error", reject);
  });
}

async function waitForHealth(url: string, child: ChildProcess, timeoutMs: number, log: () => string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`example app exited with ${child.exitCode}\n${log()}`);
    try {
      const res = await fetch(`${url}/api/health`);
      if (res.ok) return;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`example app did not answer /api/health within ${timeoutMs} ms\n${log()}`);
}

export async function startExampleApp(opts: { timeoutMs?: number } = {}): Promise<RunningApp> {
  if (!existsSync(join(EXAMPLE_APP_DIR, "node_modules", "next"))) {
    throw new Error(`example app dependencies missing: run \`npm ci\` in ${EXAMPLE_APP_DIR}`);
  }
  if (!existsSync(join(EXAMPLE_APP_DIR, ".next", "BUILD_ID"))) {
    const build = spawnSync("npx", ["next", "build"], { cwd: EXAMPLE_APP_DIR, stdio: "pipe", encoding: "utf8", env: { ...process.env, NEXT_TELEMETRY_DISABLED: "1" } });
    if (build.status !== 0) throw new Error(`next build failed (${build.status}):\n${build.stdout}\n${build.stderr}`);
  }
  const port = await freePort();
  // No Upstash/KV variables → MemoryStore: the app's state lives in this process only.
  const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, HOME: process.env.HOME, NODE_ENV: "production", NEXT_TELEMETRY_DISABLED: "1", PORT: String(port), HOSTNAME: "127.0.0.1" };
  // The next binary directly (not via npx) and in its own process group, so
  // stop() can kill the whole tree and no orphan keeps the port or our pipes.
  const nextBin = join(EXAMPLE_APP_DIR, "node_modules", "next", "dist", "bin", "next");
  const child = spawn(process.execPath, [nextBin, "start", "-p", String(port), "-H", "127.0.0.1"], { cwd: EXAMPLE_APP_DIR, env, stdio: ["ignore", "pipe", "pipe"], detached: true });
  let output = "";
  child.stdout?.on("data", (d) => (output += String(d)));
  child.stderr?.on("data", (d) => (output += String(d)));
  const url = `http://127.0.0.1:${port}`;
  await waitForHealth(url, child, opts.timeoutMs ?? 30_000, () => output.slice(-2000));
  return {
    url,
    stop: () =>
      new Promise<void>((resolve) => {
        if (child.exitCode !== null) return resolve();
        child.once("exit", () => resolve());
        const signal = (sig: NodeJS.Signals) => {
          try {
            process.kill(-child.pid!, sig);
          } catch {
            child.kill(sig);
          }
        };
        signal("SIGTERM");
        setTimeout(() => {
          if (child.exitCode === null) signal("SIGKILL");
        }, 3000).unref();
      }),
  };
}
