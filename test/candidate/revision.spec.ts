import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, test } from "node:test";
import { loadBundle } from "../../src/bundle.ts";
import { incidentLogicalId, logicalEntries, resolveCheckIdentity } from "../../src/candidate/check-identity.ts";
import {
  bindCandidateTarget,
  loadDeploymentMetadata,
  parseGitHubPullRequestUrl,
  parsePullRequestIdentity,
  snapshotLocalCandidate,
  type CandidateRevision,
} from "../../src/candidate/revision.ts";
import { loadCandidateRevision, patchedCheckSource, patchedFiles } from "../../src/patch.ts";
import { verify } from "../../src/verify.ts";

const ROOT = new URL("../../", import.meta.url).pathname.replace(/\/$/, "");
const temporary: string[] = [];

function command(cwd: string, command: string, args: string[]): string {
  return execFileSync(command, args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function git(cwd: string, ...args: string[]): string {
  return command(cwd, "git", args);
}

function repository(): string {
  const root = mkdtempSync(join(tmpdir(), "verify-fix-revision-test-"));
  temporary.push(root);
  git(root, "init", "-q");
  git(root, "config", "user.email", "test@example.com");
  git(root, "config", "user.name", "Test");
  return root;
}

function commitAll(root: string, message = "base"): string {
  git(root, "add", "-A");
  git(root, "commit", "-qm", message);
  return git(root, "rev-parse", "HEAD");
}

afterEach(() => {
  for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe("local candidate revision", () => {
  test("freezes staged, unstaged, untracked, renamed, and deleted final state with one digest", () => {
    const root = repository();
    mkdirSync(join(root, "monitoring/tests"), { recursive: true });
    writeFileSync(join(root, ".gitignore"), "node_modules/\n.next/\n.env\n");
    writeFileSync(join(root, "monitoring/package.json"), '{"name":"candidate","private":true}\n');
    writeFileSync(join(root, "monitoring/.env.example"), "TOKEN=replace-me\n");
    writeFileSync(join(root, "monitoring/tests/check.spec.ts"), "line one\nline two\nline three\n");
    writeFileSync(join(root, "monitoring/tests/rename-me.ts"), "export const renamed = true\n");
    writeFileSync(join(root, "monitoring/tests/delete-me.ts"), "delete me\n");
    const base = commitAll(root);

    writeFileSync(join(root, "monitoring/tests/check.spec.ts"), "changed first\nline two\nchanged third\n");
    git(root, "add", "monitoring/tests/check.spec.ts");
    writeFileSync(join(root, "monitoring/tests/check.spec.ts"), "changed first\nunstaged middle\nchanged third\n");
    git(root, "mv", "monitoring/tests/rename-me.ts", "monitoring/tests/renamed.ts");
    rmSync(join(root, "monitoring/tests/delete-me.ts"));
    writeFileSync(join(root, "monitoring/tests/new-helper.ts"), "export const helper = true\n");
    mkdirSync(join(root, "monitoring/node_modules/pkg"), { recursive: true });
    writeFileSync(join(root, "monitoring/node_modules/pkg/index.js"), "ignored\n");
    writeFileSync(join(root, "monitoring/.env"), "SECRET=ignored\n");

    const revision = snapshotLocalCandidate(join(root, "monitoring"), base);
    try {
      assert.equal(revision.metadata.baseSha, base);
      assert.equal(revision.metadata.headSha, base);
      assert.equal(revision.metadata.dirty, true);
      assert.equal(revision.metadata.projectPath, "monitoring");
      assert.match(revision.metadata.digest, /^[0-9a-f]{64}$/);
      assert.equal(readFileSync(join(revision.projectRoot, "tests/check.spec.ts"), "utf8"), "changed first\nunstaged middle\nchanged third\n");
      assert.equal(existsSync(join(revision.projectRoot, "tests/new-helper.ts")), true);
      assert.equal(existsSync(join(revision.projectRoot, "tests/delete-me.ts")), false);
      assert.equal(existsSync(join(revision.projectRoot, "node_modules")), false);
      assert.equal(existsSync(join(revision.projectRoot, ".env")), false);
      assert.equal(existsSync(join(revision.projectRoot, ".env.example")), false);
      assert.ok(revision.metadata.changes.some((change) => change.status === "renamed" && change.previousPath === "monitoring/tests/rename-me.ts" && change.path === "monitoring/tests/renamed.ts"));
      assert.ok(revision.metadata.changes.some((change) => change.status === "deleted" && change.path === "monitoring/tests/delete-me.ts"));
      assert.ok(revision.metadata.changes.some((change) => change.status === "added" && change.path === "monitoring/tests/new-helper.ts"));

      writeFileSync(join(root, "monitoring/tests/check.spec.ts"), "changed after snapshot\n");
      assert.equal(readFileSync(join(revision.projectRoot, "tests/check.spec.ts"), "utf8"), "changed first\nunstaged middle\nchanged third\n");
      revision.assertUnchanged();
      assert.throws(() => writeFileSync(join(revision.projectRoot, "tests/new.ts"), "blocked"), /EACCES|EPERM/);
    } finally {
      revision.dispose();
    }
  });

  test("the same final tree produces the same digest", () => {
    const root = repository();
    writeFileSync(join(root, "package.json"), "{}\n");
    const base = commitAll(root);
    const first = snapshotLocalCandidate(root, base);
    const second = snapshotLocalCandidate(root, base);
    try {
      assert.equal(first.metadata.digest, second.metadata.digest);
      assert.equal(first.metadata.fileCount, second.metadata.fileCount);
    } finally {
      first.dispose();
      second.dispose();
    }
  });

  test("rejects credential files, links leaving the repository, and submodules", () => {
    const credentialRepo = repository();
    writeFileSync(join(credentialRepo, "package.json"), "{}\n");
    writeFileSync(join(credentialRepo, ".npmrc"), "//registry/:_authToken=secret\n");
    const credentialBase = commitAll(credentialRepo);
    assert.throws(() => snapshotLocalCandidate(credentialRepo, credentialBase), /credential-bearing candidate file/);

    const linkRepo = repository();
    writeFileSync(join(linkRepo, "package.json"), "{}\n");
    symlinkSync("/etc/passwd", join(linkRepo, "outside"));
    git(linkRepo, "add", "-A");
    git(linkRepo, "commit", "-qm", "link");
    assert.throws(() => snapshotLocalCandidate(linkRepo, "HEAD"), /symbolic link is absolute/);

    const submoduleRepo = repository();
    writeFileSync(join(submoduleRepo, "package.json"), "{}\n");
    const commit = commitAll(submoduleRepo);
    git(submoduleRepo, "update-index", "--add", "--cacheinfo", `160000,${commit},external-module`);
    assert.throws(() => snapshotLocalCandidate(submoduleRepo, commit), /submodule is not allowed/);
  });
});

describe("stable check identity in a complete candidate", () => {
  test("logical identity ignores agent comments", () => {
    assert.deepEqual(logicalEntries("check.ts", "// logicalId: 'incident'\n/* new ApiCheck('also-fake', {}) */\n"), []);
  });

  test("follows the logical ID and Git rename, then loads the new helper from the final tree", () => {
    const root = repository();
    const project = join(root, "web");
    mkdirSync(join(project, "tests"), { recursive: true });
    cpSync(join(ROOT, "examples/slots-booking/web/checkly.config.ts"), join(project, "checkly.config.ts"));
    cpSync(join(ROOT, "examples/slots-booking/web/playwright.config.ts"), join(project, "playwright.config.ts"));
    cpSync(join(ROOT, "examples/slots-booking/web/tests/booking.spec.ts"), join(project, "tests/booking.spec.ts"));
    writeFileSync(join(project, "package.json"), '{"name":"web","private":true}\n');
    const base = commitAll(root);

    git(root, "mv", "web/tests/booking.spec.ts", "web/tests/booking-flow.spec.ts");
    git(root, "mv", "web/playwright.config.ts", "web/playwright.monitoring.config.ts");
    const renamed = join(project, "tests/booking-flow.spec.ts");
    writeFileSync(renamed, readFileSync(renamed, "utf8").replace("import { test, expect } from '@playwright/test'", "import { test, expect } from '@playwright/test'\nimport { slot } from './slot-helper'\nvoid slot"));
    writeFileSync(join(project, "tests/slot-helper.ts"), "export const slot = '09:30'\n");
    mkdirSync(join(project, "utils"), { recursive: true });
    writeFileSync(join(project, "utils/alias-helper.ts"), "export const aliasOnly = true\n");
    mkdirSync(join(project, "tests/fixtures"), { recursive: true });
    writeFileSync(join(project, "tests/fixtures/pixel.bin"), Buffer.from([0, 1, 2, 3]));
    writeFileSync(join(project, "checkly.config.ts"), readFileSync(join(project, "checkly.config.ts"), "utf8")
      .replace("name: 'slots booking flow'", "name: 'renamed booking monitor'")
      .replace("playwrightConfigPath: './playwright.config.ts'", "playwrightConfigPath: './playwright.monitoring.config.ts'"));

    const bundle = loadBundle(join(ROOT, "fixtures/bundles/slots-booking-drift")).bundle;
    assert.equal(incidentLogicalId(bundle), "slots-booking-flow");
    const revision = snapshotLocalCandidate(project, base);
    try {
      const identity = resolveCheckIdentity(bundle, revision);
      assert.equal(identity.logicalId, "slots-booking-flow");
      assert.equal(identity.name, "renamed booking monitor");
      assert.equal(identity.checkFile, "tests/booking-flow.spec.ts");
      const patch = loadCandidateRevision(revision, bundle);
      assert.equal(patch.complete, true);
      assert.equal(patch.checkFile, "tests/booking-flow.spec.ts");
      assert.equal(patch.playwrightConfigFile, "playwright.monitoring.config.ts");
      assert.equal(patch.checkName, "renamed booking monitor");
      assert.ok(Object.keys(patch.files).includes("tests/slot-helper.ts"));
      assert.ok(Object.keys(patch.files).includes("utils/alias-helper.ts"), "the complete project tree includes path-alias helpers");
      assert.deepEqual(patch.assets?.["tests/fixtures/pixel.bin"], Buffer.from([0, 1, 2, 3]));
      assert.match(patchedCheckSource(bundle, patch), /slot-helper/);
      assert.equal(patchedFiles(bundle, patch)["tests/booking.spec.ts"], undefined, "the captured path must not be restored");
    } finally {
      revision.dispose();
    }
  });

  test("removing the stable logical ID is a definite candidate rejection", async () => {
    const root = repository();
    const project = join(root, "web");
    mkdirSync(join(project, "tests"), { recursive: true });
    cpSync(join(ROOT, "examples/slots-booking/web/checkly.config.ts"), join(project, "checkly.config.ts"));
    cpSync(join(ROOT, "examples/slots-booking/web/playwright.config.ts"), join(project, "playwright.config.ts"));
    cpSync(join(ROOT, "examples/slots-booking/web/tests/booking.spec.ts"), join(project, "tests/booking.spec.ts"));
    writeFileSync(join(project, "package.json"), "{}\n");
    const base = commitAll(root);
    writeFileSync(join(project, "checkly.config.ts"), readFileSync(join(project, "checkly.config.ts"), "utf8").replace("logicalId: 'slots-booking-flow'", "logicalId: 'different-monitor'"));
    const bundle = loadBundle(join(ROOT, "fixtures/bundles/slots-booking-drift")).bundle;
    const revision = snapshotLocalCandidate(project, base);
    try {
      const patch = loadCandidateRevision(revision, bundle);
      assert.match(patch.rejection ?? "", /incident check logicalId.*missing/);
      assert.equal(patchedCheckSource(bundle, patch), "");
      const result = await verify({ bundle, patch });
      assert.equal(result.decision.verdict, "FAILED");
      assert.ok(result.decision.reasons.some((reason) => reason.includes("candidate identity")));
      assert.deepEqual(result.report.json.candidateCheck, { logicalId: "slots-booking-flow", name: "slots booking flow", file: null });
    } finally {
      revision.dispose();
    }
  });
});

describe("pull-request identity and target binding", () => {
  test("accepts only canonical GitHub PR URLs and validates immutable API identity", () => {
    const parsed = parseGitHubPullRequestUrl("https://github.com/acme/widgets/pull/42");
    assert.deepEqual(parsed, { owner: "acme", repository: "widgets", number: 42, url: "https://github.com/acme/widgets/pull/42" });
    assert.throws(() => parseGitHubPullRequestUrl("https://gitlab.com/acme/widgets/-/merge_requests/42"), /only https:\/\/github.com/);
    const pull = parsePullRequestIdentity({
      number: 42,
      state: "open",
      html_url: parsed.url,
      base: { sha: "a".repeat(40), repo: { full_name: "acme/widgets" } },
      head: { sha: "b".repeat(40), ref: "repair", repo: { full_name: "contributor/widgets" } },
    }, parsed);
    assert.equal(pull.fork, true);
    assert.equal(pull.headSha, "b".repeat(40));
  });

  test("local evidence is never gate eligible; PR cloud evidence needs approval, fork approval, and exact deployment metadata", () => {
    const local = fakeRevision("local", false);
    const localBinding = bindCandidateTarget({ revision: local, target: "https://preview.example", targetRevision: local.metadata.headSha, deployment: null, executor: "scene", cloudApproved: false, allowForkCloud: false });
    assert.equal(localBinding.gateEligible, false);
    assert.match(localBinding.reason, /local snapshot evidence/);

    const pull = fakeRevision("github-pr", true);
    assert.throws(() => bindCandidateTarget({ revision: pull, target: "https://preview.example", targetRevision: pull.metadata.headSha, deployment: null, executor: "hybrid", cloudApproved: false, allowForkCloud: false }), /requires --cloud-approved/);
    assert.throws(() => bindCandidateTarget({ revision: pull, target: "https://preview.example", targetRevision: "c".repeat(40), deployment: null, executor: "hybrid", cloudApproved: true, allowForkCloud: true }), /must equal the pinned PR head/);
    assert.throws(() => bindCandidateTarget({ revision: pull, target: "https://preview.example", targetRevision: pull.metadata.headSha, deployment: null, executor: "hybrid", cloudApproved: true, allowForkCloud: false }), /fork pull requests cannot receive/);

    const metadataDir = repository();
    const metadataPath = join(metadataDir, "deployment.json");
    writeFileSync(metadataPath, JSON.stringify({ provider: "github-deployment", deploymentId: "123", revision: pull.metadata.headSha, url: "https://preview.example/" }));
    const deployment = loadDeploymentMetadata(metadataPath);
    assert.equal(deployment.url, "https://preview.example");
    const binding = bindCandidateTarget({
      revision: pull,
      target: "https://preview.example",
      targetRevision: pull.metadata.headSha,
      deployment,
      executor: "hybrid",
      cloudApproved: true,
      allowForkCloud: true,
    });
    assert.equal(binding.exactRevision, true);
    assert.equal(binding.gateEligible, true);
  });
});

function fakeRevision(source: "local" | "github-pr", fork: boolean): CandidateRevision {
  const sha = "b".repeat(40);
  return {
    metadata: {
      source,
      sourceReference: source === "local" ? "/repo/project" : "https://github.com/acme/widgets/pull/1",
      repositoryRoot: source === "local" ? "/repo" : "acme/widgets",
      projectPath: ".",
      baseSha: "a".repeat(40),
      headSha: sha,
      dirty: source === "local",
      immutable: true,
      digestAlgorithm: "sha256",
      digest: "d".repeat(64),
      fileCount: 1,
      totalBytes: 2,
      changes: [],
      ...(source === "github-pr" ? { pullRequest: { url: "https://github.com/acme/widgets/pull/1", number: 1, state: "open", baseRepository: "acme/widgets", headRepository: fork ? "fork/widgets" : "acme/widgets", baseSha: "a".repeat(40), headSha: sha, headRef: "repair", fork } } : {}),
    },
    snapshotRoot: "/snapshot",
    projectRoot: "/snapshot",
    runtimeProjectRoot: null,
    files: [],
    assertUnchanged() {},
    dispose() {},
  };
}
