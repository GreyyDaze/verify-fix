// CLI entry for `create-verify-fix`.

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";
import { createFromTemplate, TEMPLATE_NAME } from "./create.ts";

const USAGE = `create-verify-fix <dir> [--template ${TEMPLATE_NAME}] [--yes]

Copies the maintained slots-booking example from the verify-fix repository
into a standalone learning project.

  <dir>              destination directory. Must be absent or empty.
  --template         template name. Only "${TEMPLATE_NAME}" is maintained.
  --yes              non-interactive; write without prompting

The copy starts with an EMPTY incidents/ directory: no captured incident,
mock, secret, build cache, report, or raw trace is copied, and no captured
incident is shipped with the project.
`;

export async function runCreate(argv: string[], moduleUrl: string): Promise<number> {
  const positional: string[] = [];
  let template: string | undefined;
  let confirm = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--help" || arg === "-h") { process.stdout.write(USAGE); return 0; }
    if (arg === "--yes" || arg === "-y") { confirm = true; continue; }
    if (arg === "--template") {
      const value = argv[++i];
      if (!value) { process.stderr.write("--template requires a value\n"); return 2; }
      template = value;
      continue;
    }
    if (arg.startsWith("--template=")) { template = arg.slice("--template=".length); continue; }
    if (arg.startsWith("-")) { process.stderr.write(`unknown option ${arg}\n`); return 2; }
    positional.push(arg);
  }

  if (positional.length !== 1) {
    process.stderr.write(`create-verify-fix needs exactly one destination directory\n\n${USAGE}`);
    return 2;
  }

  // The maintained example lives in the verify-fix repository, discovered from
  // this module's own location. This package carries no second implementation.
  const repoRoot = resolve(dirname(fileURLToPath(moduleUrl)), "..", "..", "..");
  if (!existsSync(resolve(repoRoot, "examples", "slots-booking", "web"))) {
    process.stderr.write("maintained example not found; run this from the verify-fix repository\n");
    return 2;
  }

  const destination = resolve(positional[0]!);
  const result = createFromTemplate({ repoRoot, destination, template, confirm });
  if (result.status === "refused") {
    process.stderr.write(`refused: ${result.reason}\n`);
    return 2;
  }
  process.stdout.write(
    `Copied the maintained example into ${result.destination} (${result.copiedFiles} files).\n`
    + "incidents/ is empty: capture your own with `verify-fix bundle`.\n"
    + "Follow the copied README for the full workshop.\n",
  );
  return 0;
}