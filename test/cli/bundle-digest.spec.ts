// `verify --bundle-digest` must fail closed on a fingerprint that does not
// match the on-disk bundle, before any scene or candidate code runs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

const root = new URL("../../", import.meta.url).pathname;
const cli = join(root, "src/cli.ts");
const bundle = join(root, "fixtures/slots-booking/bundle/incidents/slots-booking-overlap");
const patch = join(root, "fixtures/slots-booking/patches/03-weaken-assertion.ts");

function run(args: string[]) {
  return spawnSync(process.execPath, ["--no-warnings", cli, ...args],
    { encoding: "utf8", timeout: 30_000 });
}

test("verify rejects a malformed --bundle-digest before running", () => {
  const out = run(["verify", "--patch", patch, "--bundle", bundle, "--bundle-digest", "not-a-digest"]);
  assert.equal(out.status, 2);
  assert.match(out.stderr, /--bundle-digest must be a 64-hex sha256 fingerprint/);
});

test("verify stops on a fingerprint mismatch instead of grading the bundle", () => {
  const wrong = "0".repeat(64);
  const out = run(["verify", "--patch", patch, "--bundle", bundle, "--bundle-digest", wrong]);
  assert.equal(out.status, 2);
  assert.match(out.stderr, /bundle fingerprint mismatch/);
  assert.match(out.stderr, /pinned sha256:0{64}/);
});
