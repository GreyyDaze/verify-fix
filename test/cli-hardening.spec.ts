// Synthetic CLI-only boundary tests: never contact Checkly, GitHub, or a deployment.
import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = new URL("../", import.meta.url).pathname;
const cli = join(root, "src/cli.ts");
const bundle = join(root, "fixtures/slots-booking/bundle/incidents/slots-booking-overlap");
const patch = join(root, "fixtures/slots-booking/patches/03-weaken-assertion.ts");

test("CLI rejects ambiguous and secret-bearing inputs without echo or running a check", () => {
  const home = mkdtempSync(join(tmpdir(), "verify-fix-cli-hardening-"));
  try {
    const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, HOME: home, XDG_CONFIG_HOME: join(home, "config") };
    const run = (args: string[], environment = env) => {
      const out = spawnSync(process.execPath, ["--no-warnings", cli, ...args],
        { env: environment, encoding: "utf8", timeout: 10_000 });
      assert.equal(out.status, 2, `unexpected CLI exit for ${args[0]}`);
      assert.ok(!`${out.stdout}${out.stderr}`.includes("private-canary-value"), "no private input is echoed");
    };
    for (const args of [
      ["bundle", "--check", "some-check", "--check", "private-canary-value"],
      ["bundle", "--check", "some-check", "private-canary-value"],
      ["bundle", "--check", "some-check", "--bogus=private-canary-value"],
      ["bundle", "--check", "some-check", "--result=../private-canary-value"],
      ["bundle", "--check", "some-check", "--history=501"],
      ["bundle", "--check", "some-check", "--measure=Infinity"],
      ["bundle", "--check", "some-check", "--target-url=https://example.test/api?token=private-canary-value"],
      ["verify", "--patch", patch, "--bundle", bundle, "--target=https://user:private-canary-value@example.test"],
      ["verify", "--patch", patch, "--bundle", bundle, "--target=https://example.test/?token=private-canary-value"],
      ["verify", "--patch", patch, "--bundle", bundle, "--executor=hybrid", "--target=https://example.test",
        "--target-revision=" + "a".repeat(39), "--target-metadata=private-canary-value"],
      ["verify", "--patch", patch, "--bundle", bundle, "--cloud-approved"],
    ]) run(args);
    run(["bundle", "--check", "some-check"], { ...env, CHECKLY_API_KEY: "private-canary-value",
      CHECKLY_ACCOUNT_ID: "invalid/account" });
    run(["bundle", "--check", "some-check"], { ...env, CHECKLY_API_KEY: "private-canary-value" });
    const envFile = join(home, "inputs.env");
    writeFileSync(envFile, "MULTISTEP_USER_US_EAST_1=private-canary-value\nMULTISTEP_USER_US_EAST_1=second\n", { mode: 0o600 });
    run(["verify", "--patch", patch, "--bundle", bundle, "--env-file", envFile]);
    writeFileSync(envFile, "MULTISTEP_USER_US_EAST_1=private-canary-value\n");
    chmodSync(envFile, 0o644);
    run(["verify", "--patch", patch, "--bundle", bundle, "--env-file", envFile]);
    const link = join(home, "inputs-link.env");
    symlinkSync(envFile, link);
    run(["verify", "--patch", patch, "--bundle", bundle, "--env-file", link]);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
