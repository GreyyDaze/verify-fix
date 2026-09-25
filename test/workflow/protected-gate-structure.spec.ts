import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

const gatePath = fileURLToPath(new URL("../../.github/workflows/gate.yml", import.meta.url));
const protectedPath = fileURLToPath(
  new URL("../../.github/workflows/protected-gate.yml", import.meta.url),
);
const gate = readFileSync(gatePath, "utf8");
const protectedGate = readFileSync(protectedPath, "utf8");

/** Non-comment lines of a job block (comments must not satisfy boundaries). */
function codeLines(block: string): string[] {
  return block.split("\n").filter((line) => !/^\s*#/.test(line));
}

/** Job blocks keyed by job id (from the `jobs:` section to the next 2-space key). */
function jobBlocks(text: string): Record<string, string> {
  const jobsIndex = text.indexOf("\njobs:\n");
  assert.notEqual(jobsIndex, -1, "workflow must have a jobs section");
  const section = text.slice(jobsIndex);
  const matches = [...section.matchAll(/^  ([a-z][a-z0-9-]*):$/gm)];
  const blocks: Record<string, string> = {};
  for (let i = 0; i < matches.length; i += 1) {
    const start = matches[i]!.index!;
    const end = i + 1 < matches.length ? matches[i + 1]!.index! : section.length;
    blocks[matches[i]![1]!] = section.slice(start, end);
  }
  return blocks;
}

const jobs = jobBlocks(protectedGate);

/**
 * The one known legacy caller pin: the protected-workflow ref that predates
 * the Stage 2 snapshot. Missing `trusted_ref` is valid ONLY here.
 */
const LEGACY_CALLER_PIN = "fd2fe8a2b2c8a2974aa3a082fe730f6d621c5d5d";

test("caller coupling supports exactly the two valid commit states", () => {
  const uses = gate.match(
    /uses:\s+GreyyDaze\/verify-fix\/\.github\/workflows\/protected-gate\.yml@([0-9a-f]{40})/,
  );
  assert.ok(uses, "gate must pin the reusable workflow by 40-hex SHA");

  const hasTrustedRefKey = /trusted_ref/.test(gate);
  const trustedRef = gate.match(/trusted_ref:\s*([0-9a-f]{40})/);

  if (!hasTrustedRefKey) {
    // Snapshot state: gate.yml is exactly the known legacy caller — old
    // pin, no trusted_ref. No other missing-trusted_ref state is valid.
    assert.equal(
      uses[1],
      LEGACY_CALLER_PIN,
      "without trusted_ref, gate must point at the known legacy pin only",
    );
    return;
  }

  // Final caller state: trusted_ref present, byte-identical to uses, and
  // moved off the legacy pin onto the new Stage 2 snapshot.
  assert.ok(trustedRef, "trusted_ref must be a 40-hex SHA when present");
  assert.equal(uses[1], trustedRef[1], "trusted_ref must equal the uses pin byte-for-byte");
  assert.notEqual(uses[1], LEGACY_CALLER_PIN, "final state must call the new snapshot, not the legacy pin");
  assert.match(gate, /Keep this pin byte-identical to the `uses:` ref/);
  assert.doesNotMatch(
    gate,
    /predates the Stage 2 helpers/,
    "the sequencing comment must be updated together with the pin",
  );
});

test("workflows never execute TypeScript entrypoints or experimental Node flags", () => {
  assert.doesNotMatch(protectedGate, /--experimental/);
  assert.doesNotMatch(protectedGate, /strip-types|transform-types|type-stripping/);
  assert.doesNotMatch(protectedGate, /\.github\/helpers\/[^"'\s]+\.ts\b/);
  const nodeRuns = protectedGate.split("\n").filter((line) => /run: node /.test(line));
  assert.ok(nodeRuns.length >= 3, `expected helper invocations, found ${nodeRuns.length}`);
  for (const line of nodeRuns) {
    assert.match(line, /\.github\/helpers\/[\w.-]+\.mjs/, `helper run must use .mjs: ${line}`);
    assert.doesNotMatch(line, /\.ts(\s|$)/, `helper run must not use .ts: ${line}`);
  }
});

test("every job that executes helpers runs setup-node with NODE_VERSION first", () => {
  const invokerJobs = Object.entries(jobs).filter(([, block]) =>
    /^\s*run: node .*\.github\/helpers\//m.test(block),
  );
  assert.deepEqual(
    invokerJobs.map(([name]) => name).sort(),
    ["preview-gate", "production-preflight", "production-verify-and-deploy"],
  );
  for (const [name, block] of invokerJobs) {
    const setupIndex = block.indexOf("uses: actions/setup-node@v4");
    const invokeIndex = block.search(/^\s*run: node .*\.github\/helpers\//m);
    assert.notEqual(setupIndex, -1, `${name} must install the pinned runtime`);
    assert.ok(
      setupIndex < invokeIndex,
      `${name} must run setup-node before any helper invocation`,
    );
    assert.match(
      block,
      /node-version: \$\{\{ env\.NODE_VERSION \}\}/,
      `${name} must use env.NODE_VERSION, not the runner system Node`,
    );
  }
});

test("production preflight is secret-free: no secrets, no environment, no Vercel API", () => {
  const preflight = jobs["production-preflight"];
  assert.ok(preflight, "production-preflight job must exist");
  const lines = codeLines(preflight);
  const joined = lines.join("\n");
  assert.ok(!joined.includes("secrets."), "preflight must not reference any secret");
  assert.ok(!joined.includes("VERCEL_TOKEN"), "preflight must never require VERCEL_TOKEN");
  assert.ok(!joined.includes("BYPASS"), "preflight must not touch the bypass interface");
  assert.ok(!/(^|\n)\s{4}environment:/.test(joined), "preflight must not use a GitHub environment");
  assert.ok(!/api\.vercel\.com|vercel\.com\/api/i.test(joined), "preflight makes no Vercel API call");
  assert.match(joined, /GH_TOKEN: \$\{\{ github\.token \}\}/, "preflight uses github.token only");
});

test("every helper-executing job checks out trusted code at inputs.trusted_ref with a pin guard", () => {
  const invokers = Object.entries(jobs).filter(([, block]) =>
    /^\s*run: node .*\.github\/helpers\//m.test(block),
  );
  for (const [name, block] of invokers) {
    assert.match(block, /ref: \$\{\{ inputs\.trusted_ref \}\}/, name);
    assert.match(block, /path: workflow-trusted/, name);
    assert.match(block, /\[\[ "\$TRUSTED_REF" =~ \^\[0-9a-f\]\{40\}\$ \]\]/, name);
    assert.match(block, /git -C workflow-trusted rev-parse HEAD/, name);
  }
});

test("bypass secret uses only the named interface; the header literal stays out of workflows", () => {
  const secretNames = [...protectedGate.matchAll(/secrets\.([A-Z0-9_]+)/g)].map((m) => m[1]!);
  assert.ok(secretNames.length > 0, "workflows reference existing secrets by name");
  for (const name of secretNames) {
    if (name.includes("BYPASS")) {
      assert.equal(
        name,
        "VERCEL_AUTOMATION_BYPASS_SECRET",
        `bypass must use the single named interface: ${name}`,
      );
    }
  }
  // The protection header itself is a helper-level named interface only.
  assert.doesNotMatch(protectedGate, /x-vercel-protection-bypass/i);
});

test("production deploy is gated on ready=true and waiting needs no approval", () => {
  const deployJob = jobs["production-verify-and-deploy"];
  assert.ok(deployJob, "production-verify-and-deploy job must exist");
  assert.match(deployJob, /needs: production-preflight/);
  assert.match(deployJob, /needs\.production-preflight\.outputs\.ready == 'true'/);
  // Waiting vs invalid: no approval machinery anywhere — waiting simply does
  // not satisfy the gate condition.
  assert.doesNotMatch(protectedGate, /wait_timer/);
  assert.doesNotMatch(protectedGate, /reviewers:/);
});

test("URL roles stay separated: verification is gated+verified, monitoring is deploy-only", () => {
  const preflight = jobs["production-preflight"]!;
  const deployJob = jobs["production-verify-and-deploy"]!;
  const preview = jobs["preview-gate"]!;

  // Outputs exist only on the preflight job.
  assert.match(preflight, /verification_url: \$\{\{ steps\.resolve\.outputs\.verification_url \}\}/);
  assert.match(preflight, /monitoring_url: \$\{\{ steps\.resolve\.outputs\.monitoring_url \}\}/);

  // Verification origin: readiness probe + verify target.
  assert.match(
    deployJob,
    /TARGET_URL: \$\{\{ needs\.production-preflight\.outputs\.verification_url \}\}/,
  );
  // Monitoring origin: the preview and force deploy steps only.
  const deployCode = codeLines(deployJob).join("\n");
  const environmentUrlLines = deployCode
    .split("\n")
    .filter((line) => line.includes("ENVIRONMENT_URL:"));
  assert.equal(
    environmentUrlLines.length,
    2,
    "exactly the preview and force steps bind ENVIRONMENT_URL",
  );
  const monitoringLines = deployCode
    .split("\n")
    .filter((line) => line.includes("outputs.monitoring_url"));
  assert.equal(
    monitoringLines.length,
    2,
    "monitoring_url appears only in the preview and force ENVIRONMENT_URL bindings",
  );
  for (const line of monitoringLines) {
    assert.match(
      line,
      /^ {10}ENVIRONMENT_URL: \$\{\{ needs\.production-preflight\.outputs\.monitoring_url \}\}$/,
      `monitoring_url may only be a deploy ENVIRONMENT_URL binding: ${line}`,
    );
  }
  for (const line of environmentUrlLines) {
    assert.ok(
      line.includes("needs.production-preflight.outputs.monitoring_url"),
      `ENVIRONMENT_URL must come from the stable monitoring alias: ${line}`,
    );
    assert.ok(
      !line.includes("verification_url") && !line.includes("inputs.environment_url"),
      `ENVIRONMENT_URL must never be a verification or raw event URL: ${line}`,
    );
  }

  // Preview probes only its raw event URL — no URL-role outputs reach it.
  assert.match(preview, /TARGET_URL: \$\{\{ inputs\.environment_url \}\}/);
  const previewCode = codeLines(preview).join("\n");
  assert.ok(!previewCode.includes("verification_url"), "preview never sees verification_url");
  assert.ok(!previewCode.includes("monitoring_url"), "preview never sees monitoring_url");
  assert.ok(!previewCode.includes("resolve."), "preview never calls the preflight resolver");
});

test("workflows contain no curl and the preflight never logs bodies or tokens", () => {
  assert.doesNotMatch(protectedGate, /\bcurl\b/);
  assert.doesNotMatch(protectedGate, /\becho .*GH_TOKEN\b/);
  const preflightCode = codeLines(jobs["production-preflight"]!).join("\n");
  assert.doesNotMatch(preflightCode, /console\.log\(.*body/);
});

test("trusted helper checkouts persist no credentials", () => {
  const invokers = Object.entries(jobs).filter(([, block]) =>
    /^\s*run: node .*\.github\/helpers\//m.test(block),
  );
  for (const [name, block] of invokers) {
    const checkoutSegments = block.split("uses: actions/checkout@v4");
    assert.ok(checkoutSegments.length >= 2, `${name} must check out code`);
    // Each checkout's `with:` block lives in the segment that follows its
    // `uses:` line — every one must disable persisted credentials.
    for (const segment of checkoutSegments.slice(1)) {
      assert.match(
        segment,
        /persist-credentials: false/,
        `${name} checkout must not persist credentials`,
      );
    }
    assert.ok(!block.includes("ssh-key"), `${name} must not configure SSH keys`);
    assert.ok(
      !block.includes("token: ${{ secrets."),
      `${name} checkout must not use a secret token`,
    );
  }
});

test("candidate and preview jobs never receive production verification outputs", () => {
  const candidate = jobs["candidate-preflight"]!;
  const candidateCode = codeLines(candidate).join("\n");
  assert.ok(!candidateCode.includes("verification_url"));
  assert.ok(!candidateCode.includes("monitoring_url"));
  assert.ok(!candidateCode.includes("trusted_ref"));
});

/** The environment-provided Multistep monitoring account secret names. */
const MULTISTEP_IDENTITY_NAMES = ["MULTISTEP_USER_US_EAST_1", "MULTISTEP_USER_EU_WEST_1"] as const;

test("multistep monitoring identities are wired only into the production Checkly deploy step as secret references", () => {
  const deployJob = jobs["production-verify-and-deploy"];
  assert.ok(deployJob, "production-verify-and-deploy job must exist");

  // Both secret references exist and are supplied to the Checkly deploy step.
  const runIdx = deployJob.indexOf("run: npx checkly deploy --force");
  assert.ok(runIdx !== -1, "the production Checkly deploy step must exist");
  const stepStart = deployJob.lastIndexOf("- name:", runIdx);
  assert.ok(stepStart !== -1 && stepStart < runIdx, "deploy step must carry a name header");
  const stepSegment = deployJob.slice(stepStart, runIdx);
  for (const name of MULTISTEP_IDENTITY_NAMES) {
    const ref = `${name}: \${{ secrets.${name} }}`;
    assert.ok(
      stepSegment.includes(ref),
      `the deploy step must supply ${name} from secrets.${name}`,
    );
  }

  // They occur only in the protected production job — nowhere else.
  for (const [jobName, block] of Object.entries(jobs)) {
    if (jobName === "production-verify-and-deploy") continue;
    for (const name of MULTISTEP_IDENTITY_NAMES) {
      assert.ok(!block.includes(name), `${name} must not appear in job ${jobName}`);
    }
  }
  const identityLines = protectedGate.split("\n").filter((line) => line.includes("MULTISTEP_USER"));
  assert.equal(
    identityLines.length,
    4,
    "exactly one env entry per identity in each of the two production deploy steps",
  );
  for (const line of identityLines) {
    // No value is committed: each line is exactly the bare name paired with
    // its OWN secret reference — nothing more.
    const matched = MULTISTEP_IDENTITY_NAMES.some(
      (name) => line.trim() === `${name}: \${{ secrets.${name} }}`,
    );
    assert.ok(matched, `identity line must be a pure secret reference: ${line}`);
  }

  // Browser identities and the API token stay separate entries alongside.
  assert.match(stepSegment, /TEST_USER_US_EAST_1: \$\{\{ secrets\.TEST_USER_US_EAST_1 \}\}/);
  assert.match(stepSegment, /TEST_USER_EU_WEST_1: \$\{\{ secrets\.TEST_USER_EU_WEST_1 \}\}/);
  assert.match(stepSegment, /API_TOKEN: \$\{\{ secrets\.API_TOKEN \}\}/);
  assert.ok(stepSegment.includes("MULTISTEP_USER_US_EAST_1"), "multistep identities are distinct from TEST_USER_*");
});

test("multistep monitoring identities never reach preflights, outputs, helpers, or the caller", () => {
  // Not passed to production-preflight or candidate-preflight (nor preview).
  for (const jobName of ["production-preflight", "candidate-preflight", "preview-gate"]) {
    const block = jobs[jobName];
    assert.ok(block, `${jobName} must exist`);
    for (const name of MULTISTEP_IDENTITY_NAMES) {
      assert.ok(!block!.includes(name), `${name} must not appear in ${jobName}`);
    }
  }
  // Not in the caller workflow at all.
  assert.ok(!gate.includes("MULTISTEP_USER"), "gate.yml must not reference multistep identities");
  // Never written to GITHUB_OUTPUT: no workflow line combines an identity
  // with any output mechanism, and neither workflow mentions GITHUB_OUTPUT.
  assert.ok(!protectedGate.includes("GITHUB_OUTPUT"));
  for (const line of protectedGate.split("\n")) {
    if (!line.includes("MULTISTEP_USER")) continue;
    assert.ok(!/output/i.test(line), `identity must not be written to an output: ${line}`);
  }
  // Helper sources (the only GITHUB_OUTPUT writers) never mention them.
  const helpersDir = fileURLToPath(new URL("../../.github/helpers/", import.meta.url));
  for (const file of readdirSync(helpersDir)) {
    const source = readFileSync(`${helpersDir}${file}`, "utf8");
    assert.ok(
      !source.includes("MULTISTEP_USER"),
      `${file} must not reference multistep identities`,
    );
  }
  // Existing URL-role and protected-verifier boundaries remain unchanged:
  // no helper source differs from the committed snapshot.
  const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
  const helperDiff = execFileSync(
    "git",
    ["diff", "HEAD", "--", ".github/helpers"],
    { cwd: repoRoot, encoding: "utf8" },
  );
  assert.equal(helperDiff, "", "helper boundaries must be unchanged by this wiring");
});

test("production Checkly deploy previews immediately before force with identical monitoring inputs", () => {
  const deployJob = jobs["production-verify-and-deploy"];
  assert.ok(deployJob, "production-verify-and-deploy job must exist");

  // Exactly one preview and one force deploy command exist workflow-wide.
  const previewLines = protectedGate
    .split("\n")
    .filter((line) => line.includes("checkly deploy --preview"));
  const forceLines = protectedGate
    .split("\n")
    .filter((line) => line.includes("checkly deploy --force"));
  assert.equal(previewLines.length, 1, "exactly one checkly deploy --preview");
  assert.equal(forceLines.length, 1, "exactly one checkly deploy --force");

  // Both commands exist only inside the protected production job.
  for (const jobName of ["candidate-preflight", "production-preflight", "preview-gate"]) {
    const block = jobs[jobName];
    assert.ok(block, `${jobName} must exist`);
    assert.doesNotMatch(block!, /checkly deploy --preview/, `${jobName} must not preview-deploy`);
    assert.doesNotMatch(block!, /checkly deploy --force/, `${jobName} must not force-deploy`);
  }

  const previewIdx = deployJob.indexOf("run: npx checkly deploy --preview");
  const forceIdx = deployJob.indexOf("run: npx checkly deploy --force");
  assert.ok(previewIdx !== -1, "the preview step must exist in the production job");
  assert.ok(forceIdx !== -1, "the force step must exist in the production job");
  assert.ok(previewIdx < forceIdx, "preview must execute before force");

  // Immediate execution-order adjacency: no other step starts between the
  // preview run line and the force step header, and the preview cannot be
  // skipped on failure.
  const forceHeaderIdx = deployJob.lastIndexOf("- name:", forceIdx);
  assert.ok(forceHeaderIdx > previewIdx, "force step header must follow the preview run");
  const between = deployJob.slice(previewIdx, forceHeaderIdx);
  assert.doesNotMatch(
    between,
    /^\s*-\s+(name|uses|run):/m,
    "no step may sit between preview and force",
  );

  // Both steps inherit the job-level production-preflight success gate and
  // run only after the verify-fix verification command has passed.
  assert.match(deployJob, /needs: production-preflight/);
  assert.match(deployJob, /needs\.production-preflight\.outputs\.ready == 'true'/);
  const verifyIdx = deployJob.search(/^\s+node bin\/verify-fix verify/m);
  assert.ok(verifyIdx !== -1, "the verify-fix verification command must exist");
  assert.ok(
    verifyIdx < previewIdx && verifyIdx < forceIdx,
    "both deploy commands must run only after verify-fix verification",
  );

  // Command arguments are fixed literals — no interpolation, no secrets,
  // nothing printed alongside them.
  const previewLine = deployJob.slice(previewIdx).split("\n")[0]!;
  const forceLine = deployJob.slice(forceIdx).split("\n")[0]!;
  assert.equal(previewLine.trim(), "run: npx checkly deploy --preview");
  assert.equal(forceLine.trim(), "run: npx checkly deploy --force");

  const previewHeaderIdx = deployJob.lastIndexOf("- name:", previewIdx);
  assert.ok(previewHeaderIdx !== -1 && previewHeaderIdx < previewIdx);
  const previewSegment = deployJob.slice(previewHeaderIdx, previewIdx);
  const forceSegment = deployJob.slice(forceHeaderIdx, forceIdx);
  assert.doesNotMatch(previewSegment, /continue-on-error/, "preview must pass before force starts");
  assert.doesNotMatch(previewSegment, /echo .*secrets\./, "preview must never print secrets");
  assert.doesNotMatch(forceSegment, /echo .*secrets\./, "force must never print secrets");

  // Identical environment: same names, same order, same reference values.
  const envEntries = (segment: string): string[][] => {
    const envStart = segment.indexOf("env:");
    assert.ok(envStart !== -1, "deploy step must declare env");
    const envText = segment.slice(envStart);
    return [...envText.matchAll(/^\s{10}([A-Z][A-Z0-9_]*):[ \t]*(.*)$/gm)].map((m) => [
      m[1]!,
      m[2]!.trim(),
    ]);
  };
  const previewEnv = envEntries(previewSegment);
  const forceEnv = envEntries(forceSegment);
  assert.deepEqual(
    previewEnv,
    forceEnv,
    "preview and force must receive identical environment names and values",
  );

  const names = previewEnv.map(([name]) => name);
  for (const required of [
    "CHECKLY_API_KEY",
    "CHECKLY_ACCOUNT_ID",
    "TEST_USER",
    "TEST_USER_US_EAST_1",
    "TEST_USER_EU_WEST_1",
    "API_TOKEN",
    "MULTISTEP_USER_US_EAST_1",
    "MULTISTEP_USER_EU_WEST_1",
    "ENVIRONMENT_URL",
  ]) {
    assert.ok(names.includes(required), `both deploy steps must receive ${required}`);
  }
  for (const [name, value] of previewEnv) {
    if (name === "ENVIRONMENT_URL") {
      assert.equal(
        value,
        "${{ needs.production-preflight.outputs.monitoring_url }}",
        "ENVIRONMENT_URL must be the stable monitoring alias for both commands",
      );
    } else {
      assert.match(
        value,
        /^\$\{\{ (secrets|vars)\.[A-Z0-9_]+ \}\}$/,
        `${name} must be a plain secret or variable reference`,
      );
    }
    assert.ok(
      !value.includes("verification_url") && !value.includes("inputs.environment_url"),
      `${name} must never bind a verification or raw event URL`,
    );
  }

  // No secret reference enters a preflight, a helper, a caller input, or a
  // job output.
  for (const jobName of ["candidate-preflight", "production-preflight"]) {
    const code = codeLines(jobs[jobName]!).join("\n");
    assert.ok(!code.includes("secrets."), `${jobName} must stay secret-free`);
  }
  assert.ok(
    !/secrets\.[A-Z0-9_]+/.test(gate),
    "the caller must not pass secret references as inputs",
  );
  for (const [jobName, block] of Object.entries(jobs)) {
    const outputs = block.match(/^    outputs:\n((?:^      .*\n?)*)/m);
    if (outputs) {
      assert.ok(!outputs[1].includes("secrets."), `${jobName} outputs must not carry secrets`);
    }
  }
  const helpersDir = fileURLToPath(new URL("../../.github/helpers/", import.meta.url));
  for (const file of readdirSync(helpersDir)) {
    const source = readFileSync(`${helpersDir}${file}`, "utf8");
    assert.ok(!source.includes("secrets."), `${file} must not reference secrets`);
  }
});
