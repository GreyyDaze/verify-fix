import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";

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

/** The caller remains byte-for-byte at the earlier Stage 2 pin. The
 * reviewed verifier V and later workflow snapshot W are separate FUTURE
 * inputs; this staged reusable workflow is not active at the old caller. */
test("the Stage 2 caller stays byte-identical and does not activate V or W", () => {
  assert.equal(createHash("sha256").update(gate).digest("hex"),
    "3d984b94e436971a01717893ffb1d1dd974ce1be222534cec0db208264a684e5");
  assert.match(gate, /protected-gate\.yml@9b4322c6e4f14d71ce89274a28c7a18444b00a61/);
  assert.match(gate, /trusted_ref: 9b4322c6e4f14d71ce89274a28c7a18444b00a61/);
  assert.doesNotMatch(gate, /verifier_ref:|workflow_ref:/);
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
  assert.match(protectedGate, /NODE_VERSION: "24\.21\.0"/);
  const invokerJobs = Object.entries(jobs).filter(([, block]) =>
    /^\s*run: node .*\.github\/helpers\//m.test(block),
  );
  assert.deepEqual(
    invokerJobs.map(([name]) => name).sort(),
    ["preview-gate", "production-preflight", "production-verify-and-deploy"],
  );
  for (const [name, block] of invokerJobs) {
    const setupIndex = block.indexOf("uses: actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020");
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

test("every helper-executing job checks out the later W helpers with a pin guard", () => {
  const invokers = Object.entries(jobs).filter(([, block]) =>
    /^\s*run: node .*\.github\/helpers\//m.test(block),
  );
  for (const [name, block] of invokers) {
    assert.match(block, /ref: \$\{\{ inputs\.workflow_ref \}\}/, name);
    assert.match(block, /path: workflow-trusted/, name);
    assert.match(block, /\[\[ "\$WORKFLOW_REF" =~ \^\[0-9a-f\]\{40\}\$ \]\]/, name);
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
  // Other references to monitoring_url may compare the approved status pair
  // after the protected approval; none may send it as a verification target.
  assert.doesNotMatch(deployCode, /TARGET_URL: .*outputs\.monitoring_url/);
  assert.doesNotMatch(deployCode, /VERIFIED_URL: .*outputs\.monitoring_url/);
  assert.match(deployCode, /APPROVED_MONITORING: .*outputs\.monitoring_url/);
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
    const checkoutSegments = block.split("uses: actions/checkout@11d5960a326750d5838078e36cf38b85af677262");
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

test("preview deployment status lookups reject full and oversized pages rather than guessing the latest URL", () => {
  const preflight = jobs["candidate-preflight"]!;
  assert.match(preflight, /per_page: 100/);
  assert.match(preflight, /!Array\.isArray\(statuses\) \|\| statuses\.length >= 100/);
  assert.doesNotMatch(preflight, /statuses\.length === 100/);
});

test("candidate and preview jobs never receive production verification outputs", () => {
  const candidate = jobs["candidate-preflight"]!;
  const candidateCode = codeLines(candidate).join("\n");
  assert.ok(!candidateCode.includes("verification_url"));
  assert.ok(!candidateCode.includes("monitoring_url"));
  assert.match(candidateCode, /VERIFIER_REF: \$\{\{ inputs\.verifier_ref \}\}/);
  assert.ok(!candidateCode.includes("outputs.generated_status_id"));
  assert.ok(!candidateCode.includes("outputs.stable_status_id"));
});

/** The environment-provided Multistep monitoring account secret names. */
const MULTISTEP_IDENTITY_NAMES = ["MULTISTEP_USER_US_EAST_1", "MULTISTEP_USER_EU_WEST_1"] as const;

test("approved verifier inputs and both production deploy steps receive regional identities from secret references", () => {
  const prod = jobs["production-verify-and-deploy"]!;
  const preview = jobs["preview-gate"]!;
  const deployStart = prod.indexOf("- name: Preview monitoring source before force");
  const deploySegment = prod.slice(deployStart, prod.indexOf("- name: Upload production", deployStart));
  for (const name of MULTISTEP_IDENTITY_NAMES) {
    const line = `${name}: \${{ secrets.${name} }}`;
    assert.equal(prod.split("\n").filter((entry) => entry.trim() === line).length, 3,
      `${name}: once in verifier file builder, twice in Checkly deploy`);
    assert.equal(preview.split("\n").filter((entry) => entry.trim() === line).length, 1,
      `${name}: scoped to approved preview verifier input builder`);
    assert.equal(deploySegment.split("\n").filter((entry) => entry.trim() === line).length, 2);
    assert.match(prod, new RegExp(`input_names=.*${name}`));
  }
  assert.match(prod, /Multistep and browser identities overlap/);
  assert.match(preview, /Legacy API\/Playwright preview jobs never expose Multistep account/);
  assert.match(preview, /if \[\[ "\$bundle_type" == MULTI_STEP \]\]; then/);
  assert.match(deploySegment, /TEST_USER_US_EAST_1: \$\{\{ secrets\.TEST_USER_US_EAST_1 \}\}/);
  assert.match(deploySegment, /TEST_USER_EU_WEST_1: \$\{\{ secrets\.TEST_USER_EU_WEST_1 \}\}/);
  assert.match(deploySegment, /API_TOKEN: \$\{\{ secrets\.API_TOKEN \}\}/);
});

test("multistep monitoring identities never reach preflights, outputs, helpers, or the caller", () => {
  // Never exposed before a protected approval. Preview identities are scoped
  // to its approved job and only written for a Multistep incident.
  for (const jobName of ["production-preflight", "candidate-preflight"]) {
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
  // Helpers are reviewed in this phase; a Git diff against HEAD is not a
  // security boundary. Assert the surviving secret and network invariants.
  for (const file of readdirSync(helpersDir)) {
    const source = readFileSync(`${helpersDir}${file}`, "utf8");
    assert.doesNotMatch(source, /process\.env\.VERCEL_TOKEN|api\.vercel\.com/);
    assert.doesNotMatch(source, /process\.env\.MULTISTEP_USER_/);
  }
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

  const previewIdx = deployJob.indexOf("run: ./node_modules/.bin/checkly deploy --preview");
  const forceIdx = deployJob.indexOf("run: ./node_modules/.bin/checkly deploy --force");
  assert.ok(previewIdx !== -1, "the preview step must exist in the production job");
  assert.ok(forceIdx !== -1, "the force step must exist in the production job");
  assert.ok(previewIdx < forceIdx, "preview must execute before force");

  // Final status/identity recheck is intentionally *after* preview and
  // directly before force: a long preview must not hide a revoked status.
  const forceHeaderIdx = deployJob.lastIndexOf("- name:", forceIdx);
  assert.ok(forceHeaderIdx > previewIdx, "force step header must follow the preview run");
  const between = deployJob.slice(previewIdx, forceHeaderIdx);
  assert.deepEqual([...between.matchAll(/^\s*- name: (.+)$/gm)].map((m) => m[1]), [
    "Recheck current main and both status IDs immediately before deploy",
    "Preserve the approved role identities and PASS as bounded evidence",
  ]);
  assert.match(between, /run-production-url-preflight\.mjs/);
  assert.match(between, /test "\$FINAL_STABLE_ID" = "\$APPROVED_STABLE_ID"/);

  // Both steps inherit the job-level production-preflight success gate and
  // run only after the verify-fix verification command has passed.
  assert.match(deployJob, /needs: production-preflight/);
  assert.match(deployJob, /needs\.production-preflight\.outputs\.ready == 'true'/);
  const verifyIdx = deployJob.search(/^\s+node trusted\/bin\/verify-fix verify/m);
  assert.ok(verifyIdx !== -1, "the pinned verify-fix verification command must exist");
  assert.ok(
    verifyIdx < previewIdx && verifyIdx < forceIdx,
    "both deploy commands must run only after verify-fix verification",
  );

  // Command arguments are fixed literals — no interpolation, no secrets,
  // nothing printed alongside them.
  const previewLine = deployJob.slice(previewIdx).split("\n")[0]!;
  const forceLine = deployJob.slice(forceIdx).split("\n")[0]!;
  assert.equal(previewLine.trim(), "run: ./node_modules/.bin/checkly deploy --preview");
  assert.equal(forceLine.trim(), "run: ./node_modules/.bin/checkly deploy --force");

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

test("current-main production preflight precedes protected approval; non-main deployments cannot ask for approval", () => {
  const preflight = jobs["production-preflight"]!;
  const protectedJob = jobs["production-verify-and-deploy"]!;
  const code = codeLines(preflight).join("\n");
  assert.match(preflight, /if: >-\n\s+inputs\.environment_url != '' && inputs\.environment == 'Production'/);
  assert.match(code, /run-production-url-preflight\.mjs/);
  assert.match(preflight, /deployment_id: \$\{\{ steps\.resolve\.outputs\.deployment_id \}\}/);
  assert.match(preflight, /deployment_sha: \$\{\{ steps\.resolve\.outputs\.deployment_sha \}\}/);
  assert.match(preflight, /generated_status_id: \$\{\{ steps\.resolve\.outputs\.generated_status_id \}\}/);
  assert.match(preflight, /stable_status_id: \$\{\{ steps\.resolve\.outputs\.stable_status_id \}\}/);
  assert.doesNotMatch(preflight, /secrets\.(?!GITHUB_TOKEN)/, "preflight needs no production secrets");
  assert.match(protectedJob, /needs\.production-preflight\.outputs\.ready == 'true'/);
  assert.match(protectedJob, /environment: verify-fix-production/);
  assert.match(protectedJob, /needs: production-preflight/);
  const runner = readFileSync(new URL("../../.github/helpers/run-production-url-preflight.mjs", import.meta.url), "utf8");
  const main = runner.indexOf("/branches/main");
  const statuses = runner.indexOf("const statusesOutcome = await fetchAllStatuses");
  assert.ok(main > 0 && statuses > main, "check current main before deployment status history");
  assert.match(runner, /default_branch !== "main"/);
  assert.match(runner, /main-revision-mismatch/);
});

test("protected job uses pinned verifier, private target metadata and complete bounded role rechecks before force", () => {
  const job = jobs["production-verify-and-deploy"]!;
  const checkout = job.indexOf("path: trusted\n");
  const runtime = job.indexOf("path: candidate-runtime\n");
  const verify = job.indexOf("node trusted/bin/verify-fix verify");
  const preview = job.indexOf("./node_modules/.bin/checkly deploy --preview");
  const final = job.indexOf("id: final-roles");
  const comparison = job.indexOf("FINAL_GENERATED_ID");
  const force = job.indexOf("./node_modules/.bin/checkly deploy --force");
  assert.ok(runtime > 0 && checkout > runtime && verify > checkout, "trusted verifier checkout is distinct from deployed source");
  assert.ok(verify < preview && preview < final && final < comparison && comparison < force,
    "PASS then preview then latest identity/status recheck then deploy");
  assert.doesNotMatch(job, /\bnode bin\/verify-fix verify\b/, "never run an untrusted verifier from candidate source");
  assert.match(job, /--bundle "trusted\/\$VERIFY_FIX_BUNDLE"/);
  assert.match(job, /APPROVED_BUNDLE: \$\{\{ vars\.VERIFY_FIX_BUNDLE \}\}/);
  assert.match(job, /Require a reviewed Phase 7 Multistep incident bundle/);
  assert.match(job, /\.check\.checkType == "MULTI_STEP"/);
  assert.match(job, /--candidate-project candidate-runtime/);
  assert.match(job, /--project "candidate-runtime\/\$CANDIDATE_PROJECT_PATH"/);
  assert.match(job, /--target-metadata "\$VERIFY_FIX_TARGET_METADATA"/);
  assert.match(job, /--target "\$TARGET_URL"/);
  assert.match(job, /test "\$\(jq -r \.verdict artifacts\/verify-fix-production\.json\)" = PASS/g);
  assert.match(job, /candidateRevision\.headSha artifacts\/verify-fix-production\.json\)" = "\$TARGET_REVISION"/);
  assert.match(job, /candidateRevision\.dirty artifacts\/verify-fix-production\.json\)" = false/);
  assert.match(job, /targetBinding\.deployment\.deploymentId artifacts\/verify-fix-production\.json\)" = "\$APPROVED_DEPLOYMENT_ID"/);
  assert.match(job, /test "\$FINAL_VERIFICATION" = "\$APPROVED_VERIFICATION"/);
  assert.match(job, /test "\$FINAL_MONITORING" = "\$APPROVED_MONITORING"/);
  assert.match(job, /test "\$FINAL_GENERATED_ID" = "\$APPROVED_GENERATED_ID"/);
  assert.match(job, /test "\$FINAL_STABLE_ID" = "\$APPROVED_STABLE_ID"/);
  assert.match(job, /test "\$FINAL_SHA" = "\$APPROVED_SHA"/);
  assert.match(job, /DEPLOYMENT_SHA: \$\{\{ inputs\.deployment_sha \}\}/);
  assert.match(job, /name: Require the protected production bypass to be configured/);
  assert.match(job, /test -n "\$BYPASS"/);
  assert.match(job, /name: Require the verification target to be ready/);
  assert.match(job, /working-directory: candidate-runtime\/\$\{\{ env\.CANDIDATE_PROJECT_PATH \}\}/);
  assert.doesNotMatch(job, /VERCEL_TOKEN|api\.vercel\.com/);
});

test("temporary browser/Multistep inputs are 0600, separated, never printed, and cleaned even after failure", () => {
  for (const jobName of ["preview-gate", "production-verify-and-deploy"]) {
    const job = jobs[jobName]!;
    assert.match(job, /mktemp "\$RUNNER_TEMP\/verify-fix-[^"\s]+XXXXXX"/);
    assert.match(job, /chmod 0600 "\$env_file" "\$metadata_file"/);
    assert.match(job, /umask 077/);
    assert.match(job, /trap 'rm -f -- "\$env_file" "\$metadata_file"' ERR/);
    assert.match(job, /if: always\(\)[\s\S]*?run: \|[\s\S]*?for file in "\$\{VERIFY_FIX_ENV_FILE:-\}"/);
    assert.doesNotMatch(job, /set -x|cat "\$VERIFY_FIX_ENV_FILE"/);
  }
  const prod = jobs["production-verify-and-deploy"]!;
  assert.match(prod, /--env-file "\$VERIFY_FIX_ENV_FILE"/);
  assert.match(prod, /--executor hybrid/);
  assert.match(prod, /BYPASS: \$\{\{ secrets\.VERCEL_AUTOMATION_BYPASS_SECRET \}\}/);
  assert.match(prod, /MULTISTEP_USER_US_EAST_1: \$\{\{ secrets\.MULTISTEP_USER_US_EAST_1 \}\}/);
  assert.match(prod, /MULTISTEP_USER_EU_WEST_1: \$\{\{ secrets\.MULTISTEP_USER_EU_WEST_1 \}\}/);
  assert.match(prod, /chmod 0600 "\$env_file" "\$metadata_file"/);
  assert.match(prod, /rm -f -- "\$file"/);
  // The Checkly deployment receives monitoring identities; the pinned
  // verifier reads them from the private file, not a command-line argument.
  const verifyStep = prod.slice(prod.indexOf("- name: Verify production"), prod.indexOf("- name: Preview monitoring"));
  assert.doesNotMatch(verifyStep, /MULTISTEP_USER_US_EAST_1: \$\{\{ secrets/);
  assert.doesNotMatch(verifyStep, /MULTISTEP_USER_EU_WEST_1: \$\{\{ secrets/);
});

test("all multiline workflow shell blocks parse under bash -n", () => {
  // Static syntax check: no GitHub calls, tokens, checkout, Checkly deploy or
  // deployment implied. The installed runner uses bash on ubuntu-latest.
  let count = 0;
  const lines = protectedGate.split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    if (!/^ {8}run: \|$/.test(lines[index]!)) continue;
    const script: string[] = [];
    for (let next = index + 1; next < lines.length; next += 1) {
      const line = lines[next]!;
      if (line.trim() && !line.startsWith("          ")) break;
      script.push(line.slice(10));
    }
    execFileSync("bash", ["-n"], { input: script.join("\n"), encoding: "utf8" });
    count += 1;
  }
  assert.ok(count >= 13, `checked only ${count} multiline run blocks`);
});

test("V verifier and later W helpers have separate checked-out refs; action pins are official immutable SHAs", () => {
  assert.doesNotMatch(protectedGate, /run: npx /, "the workflow may execute only installed, lockfile-bound CLIs");
  assert.equal([...protectedGate.matchAll(/^\s+path: trusted$/gm)].length, 3);
  assert.equal([...protectedGate.matchAll(/^\s+ref: \$\{\{ inputs\.verifier_ref \}\}$/gm)].length, 3,
    "three V verifier checkouts");
  assert.equal([...protectedGate.matchAll(/^\s+ref: \$\{\{ inputs\.workflow_ref \}\}$/gm)].length, 3,
    "three distinct W helper checkouts");
  assert.equal([...protectedGate.matchAll(/Require the protected verifier checkout to equal the trusted pin/g)].length, 3);
  assert.equal([...protectedGate.matchAll(/Require the helper checkout to equal the trusted pin/g)].length, 3);
  assert.doesNotMatch(protectedGate, /inputs\.trusted_ref|9b39750e61daabc21d80fd7ea3e17d651c3b6088/);
  const official = {
    "actions/github-script": "f28e40c7f34bde8b3046d885e986cb6290c5673b", // verified official v7
    "actions/checkout": "11d5960a326750d5838078e36cf38b85af677262", // verified official v4
    "actions/setup-node": "49933ea5288caeca8642d1e84afbd3f7d6820020", // verified official v4
    "actions/upload-artifact": "ea165f8d65b6e75b540449e92b4886f43607fa02", // verified official v4
  };
  for (const match of protectedGate.matchAll(/^\s+uses: (actions\/[a-z-]+)@([^\s]+)$/gm)) {
    assert.equal(match[2], official[match[1] as keyof typeof official], `${match[1]} must be pinned`);
    assert.match(match[2]!, /^[0-9a-f]{40}$/);
  }
});
