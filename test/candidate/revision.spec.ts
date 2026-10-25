import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, test } from "node:test";
import { logicalEntries } from "../../src/candidate/check-identity.ts";
import {
  assertGitRevisionStillCurrent,
  bindCandidateTarget,
  loadDeploymentMetadata,
  parseGitHubPullRequestUrl,
  parsePullRequestIdentity,
  snapshotLocalCandidate,
  type CandidateRevision,
} from "../../src/candidate/revision.ts";

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

describe("pinned git revision gate", () => {
  test("an exact clean SHA is immutable and gate-eligible from any Git host", () => {
    const root = repository();
    mkdirSync(join(root, "web/checks"), { recursive: true });
    writeFileSync(join(root, "web/checks/booking.spec.ts"), "test\n");
    const base = commitAll(root);
    const revision = snapshotLocalCandidate(join(root, "web"), base, base);
    try {
      assert.equal(revision.metadata.source, "git-revision");
      assert.equal(revision.metadata.headSha, base);
      assert.equal(revision.metadata.dirty, false);
      const metadataDir = repository();
      const metadataPath = join(metadataDir, "deployment.json");
      writeFileSync(metadataPath, JSON.stringify({
        provider: "kubernetes",
        deploymentId: "rollout-42",
        revision: base,
        url: "https://preview.example/",
      }));
      const binding = bindCandidateTarget({
        revision,
        target: "https://preview.example",
        targetRevision: base,
        deployment: loadDeploymentMetadata(metadataPath),
        executor: "hybrid",
        cloudApproved: true,
        allowForkCloud: false,
      });
      assert.equal(binding.scope, "revision");
      assert.equal(binding.exactRevision, true);
      assert.equal(binding.gateEligible, true);
    } finally {
      revision.dispose();
    }
  });

  test("the pin must equal HEAD and the tree must be clean", () => {
    const root = repository();
    writeFileSync(join(root, "package.json"), "{}\n");
    const base = commitAll(root);
    assert.throws(() => snapshotLocalCandidate(root, base, "c".repeat(40)), /does not equal --candidate-revision/);
    writeFileSync(join(root, "package.json"), "{\"changed\":true}\n");
    assert.throws(() => snapshotLocalCandidate(root, base, base), /uncommitted changes/);
  });

  test("hybrid pinning needs cloud approval and an exact deployment binding", () => {
    const root = repository();
    writeFileSync(join(root, "package.json"), "{}\n");
    const base = commitAll(root);
    const revision = snapshotLocalCandidate(root, base, base);
    try {
      assert.throws(() => bindCandidateTarget({
        revision, target: "https://preview.example", targetRevision: base, deployment: null,
        executor: "hybrid", cloudApproved: false, allowForkCloud: false,
      }), /requires --cloud-approved/);
      const metadataDir = repository();
      const metadataPath = join(metadataDir, "deployment.json");
      writeFileSync(metadataPath, JSON.stringify({
        provider: "fly", deploymentId: "d1", revision: "c".repeat(40), url: "https://preview.example",
      }));
      assert.throws(() => bindCandidateTarget({
        revision, target: "https://preview.example", targetRevision: base,
        deployment: loadDeploymentMetadata(metadataPath),
        executor: "hybrid", cloudApproved: true, allowForkCloud: false,
      }), /does not equal --target-revision/);
    } finally {
      revision.dispose();
    }
  });

  test("a moving checkout is rejected after the run", () => {
    const root = repository();
    writeFileSync(join(root, "package.json"), "{}\n");
    const base = commitAll(root);
    const revision = snapshotLocalCandidate(root, base, base);
    try {
      git(root, "commit", "--allow-empty", "-qm", "moved");
      assert.throws(() => assertGitRevisionStillCurrent(revision), /moved during verification/);
    } finally {
      revision.dispose();
    }
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
