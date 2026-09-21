// verify-fix CLI: pre-merge verification of an agent-proposed monitor repair.
//   verify-fix verify --patch check.patch.ts --bundle incidents/<id> [--executor synthetic|checkly] [--dry-run] [--json] [--verbose]
// Exit codes: 0 PASS · 1 FAILED · 2 UNCERTAIN.

import { readFileSync } from "node:fs";
import { loadBundle } from "./bundle.ts";
import { verify } from "./verify.ts";
import { SyntheticExecutor } from "./executor/synthetic.ts";
import { ChecklyExecutor } from "./executor/checkly.ts";
import type { ExitCode } from "./types.ts";

interface Args {
  command: string | null;
  patch: string | null;
  bundle: string | null;
  executor: "synthetic" | "checkly" | "auto";
  dryRun: boolean;
  json: boolean;
  verbose: boolean;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { command: null, patch: null, bundle: null, executor: "auto", dryRun: false, json: false, verbose: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--patch") args.patch = argv[++i];
    else if (a === "--bundle") args.bundle = argv[++i];
    else if (a.startsWith("--executor=")) args.executor = a.split("=")[1] as Args["executor"];
    else if (a === "--executor") args.executor = argv[++i] as Args["executor"];
    else if (a === "--dry-run") args.dryRun = true;
    else if (a === "--json") args.json = true;
    else if (a === "--verbose") args.verbose = true;
    else if (a === "--help" || a === "-h") args.command = "help";
    else if (!args.command) args.command = a;
  }
  return args;
}

function usage(): string {
  return [
    "verify-fix — pre-merge verification of an agent-proposed monitoring-check repair",
    "",
    "  verify-fix verify --patch <file> --bundle <incidents/<id>> [--executor synthetic|checkly] [--dry-run] [--json] [--verbose]",
    "",
    "Exit codes: 0 = PASS · 1 = FAILED · 2 = UNCERTAIN",
    "",
  ].join("\n");
}

async function main(): Promise<ExitCode> {
  const args = parseArgs(process.argv.slice(2));
  if (args.command === "help" || (!args.command && !args.patch && !args.bundle)) {
    process.stdout.write(usage());
    return 2;
  }
  if (args.command !== "verify") {
    process.stderr.write(`unknown command: ${args.command}\n\n${usage()}`);
    return 2;
  }
  if (!args.patch || !args.bundle) {
    process.stderr.write("--patch and --bundle are required\n\n" + usage());
    return 2;
  }

  const patchSource = readFileSync(args.patch, "utf8");
  const { bundle, appSimPath } = loadBundle(args.bundle);

  let executor;
  if (args.executor === "synthetic") {
    executor = new SyntheticExecutor(appSimPath ?? "", { verbose: args.verbose });
  } else if (args.executor === "checkly") {
    executor = new ChecklyExecutor({ dryRunOnly: args.dryRun || !process.env.CHECKLY_API_KEY, verbose: args.verbose });
  } else {
    executor = appSimPath
      ? new SyntheticExecutor(appSimPath, { verbose: args.verbose })
      : new ChecklyExecutor({ dryRunOnly: args.dryRun || !process.env.CHECKLY_API_KEY, verbose: args.verbose });
  }

  const result = await verify({ bundle, patchSource, executor, verbose: args.verbose });

  if (args.json) {
    process.stdout.write(JSON.stringify(result.report.json, null, 2) + "\n");
  } else {
    process.stdout.write(result.report.markdown);
  }
  if (args.verbose) {
    process.stderr.write(`\n[verify-fix] cost: ${result.cost.scenes} scenes, ${result.cost.runs} sandbox/live runs\n`);
  }
  return result.decision.exitCode;
}

const code = await main();
process.exit(code);