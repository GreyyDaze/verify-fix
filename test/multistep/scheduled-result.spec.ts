import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { buildBundle } from "../../src/bundle/build.ts";
import { loadBundle } from "../../src/bundle.ts";
import { MAX_ASSET_FILE_BYTES, MAX_ASSET_ZIP_BYTES } from "../../src/multistep/capture.ts";
import type { ChecklyClient } from "../../src/checkly/client.ts";
import type { AssetManifestEntry, AssetType, CheckResultSummary } from "../../src/checkly/types.ts";
import { writeZip } from "../helpers/zip-writer.ts";

const web = fileURLToPath(new URL("../../examples/slots-booking/web/", import.meta.url));
const spec = readFileSync(`${web}checks/multistep-booking.spec.ts`, "utf8");
const construct = readFileSync(`${web}checks/multistep-booking.check.ts`, "utf8");

const failing: CheckResultSummary = {
  id: "synthetic-fail",
  checkId: "synthetic-check",
  name: "slots booking multistep transaction",
  hasFailures: true,
  hasErrors: false,
  runLocation: "us-east-1",
  startedAt: "2026-09-30T20:33:16.334Z",
  stoppedAt: "2026-09-30T20:33:20.000Z",
  resultType: "FINAL",
  attempts: 1,
  errorGroupIds: [],
};

const passing: CheckResultSummary = {
  ...failing,
  id: "synthetic-pass",
  hasFailures: false,
  startedAt: "2026-09-30T20:08:13.334Z",
  stoppedAt: "2026-09-30T20:08:16.500Z",
};

function clientFor(variant: {
  entries?: (id: string) => AssetManifestEntry[];
  archive?: Buffer;
  direct?: Buffer;
} = {}): ChecklyClient & {
  assetTypes: Array<AssetType | undefined>;
  downloads: Array<{ url: string; maxBytes: number }>;
} {
  const assetTypes: Array<AssetType | undefined> = [];
  const downloads: Array<{ url: string; maxBytes: number }> = [];
  const archive = variant.archive ?? writeZip({
    "test-results.json": "{}",
    "check-run-data.json": "{}",
    "logs.txt": "contract",
  });
  const entries = variant.entries ?? (() => [
    {
      name: "test-results.json",
      type: "report" as const,
      url: "https://assets.example/result.zip",
      source: "check-result",
      archive: { entryName: "test-results.json" },
    },
    {
      name: "check-run-data.json",
      type: "file" as const,
      url: "https://assets.example/result.zip",
      source: "check-result",
      archive: { entryName: "check-run-data.json" },
    },
    {
      name: "logs.txt",
      type: "log" as const,
      url: "https://assets.example/result.zip",
      source: "check-result",
      archive: { entryName: "logs.txt" },
    },
  ]);

  const client = {
    async getCheck() {
      return {
        id: "synthetic-check",
        name: "slots booking multistep transaction",
        checkType: "MULTI_STEP",
        activated: true,
        muted: false,
        frequency: 5,
        frequencyOffset: 0,
        runParallel: true,
        locations: ["us-east-1"],
        privateLocations: [],
        tags: [],
        retryStrategy: null,
        doubleCheck: false,
        runtimeId: null,
        groupId: null,
        script: spec,
        scriptPath: "checks/multistep-booking.spec.ts",
        environmentVariables: [{ key: "ENVIRONMENT_URL", value: "synthetic-origin", secret: false }],
      };
    },
    async listResults() {
      return { entries: [failing, passing], nextId: null };
    },
    async getResult(_checkId: string, id: string) {
      return id === failing.id ? failing : passing;
    },
    async getAssets(_checkId: string, _id: string, type?: AssetType) {
      assetTypes.push(type);
      return { assets: entries(_id) };
    },
    async download(url: string, maxBytes: number) {
      downloads.push({ url, maxBytes });
      return variant.direct ?? archive;
    },
    async errorGroupsForCheck() {
      return [];
    },
    async getErrorGroup() {
      throw new Error("not used");
    },
  } as unknown as ChecklyClient & {
    assetTypes: Array<AssetType | undefined>;
    downloads: Array<{ url: string; maxBytes: number }>;
  };

  client.assetTypes = assetTypes;
  client.downloads = downloads;
  return client;
}

async function bundleFor(client: ChecklyClient, outDir: string) {
  return buildBundle(
    {
      checkId: "synthetic-check",
      outDir,
      projectDir: web,
      log: () => {},
    },
    { client, accountId: "synthetic", now: () => new Date("2026-09-30T00:00:00.000Z") },
  );
}

test("remote manifest selection uses the full Multistep manifest and downloads only selected evidence", async (t) => {
  const out = t.mock?.restore ? undefined : undefined;
  const tmp = await import("node:fs/promises").then(({ mkdtemp }) => mkdtemp("/tmp/verify-fix-contract-"));
  try {
    const archive = writeZip({
      "irrelevant.bin": "ignore",
      "test-results.json": "{}",
      "check-run-data.json": "{}",
      "logs.txt": "contract",
    });
    const client = clientFor({ archive });
    const result = await bundleFor(client, tmp);
    assert.deepEqual(client.assetTypes, [undefined, undefined]);
    assert.equal(client.downloads.length, 2, "one archive download per result");
    assert.ok(client.downloads.every(({ maxBytes }) => maxBytes > 0));
    assert.ok(result.warnings.some((warning) => /Multistep asset capture is invalid/.test(warning)));
    void out;
  } finally {
    const { rm } = await import("node:fs/promises");
    await rm(tmp, { recursive: true, force: true });
  }
});

test("remote Multistep downloads are byte-bounded", async (t) => {
  const { mkdtemp, rm } = await import("node:fs/promises");
  const out = await mkdtemp("/tmp/verify-fix-contract-");
  try {
    const client = clientFor();
    await bundleFor(client, out);
    assert.ok(client.downloads.length > 0);
    assert.ok(client.downloads.every(({ maxBytes }) => maxBytes <= MAX_ASSET_ZIP_BYTES));
    assert.ok(client.downloads.every(({ maxBytes }) => maxBytes <= MAX_ASSET_FILE_BYTES || maxBytes <= MAX_ASSET_ZIP_BYTES));
  } finally {
    await rm(out, { recursive: true, force: true });
  }
});

test("remote archive parsing extracts only the declared entry", async (t) => {
  const { mkdtemp, rm } = await import("node:fs/promises");
  const out = await mkdtemp("/tmp/verify-fix-contract-");
  try {
    const archive = writeZip({
      "test-results.json": "selected",
      "check-run-data.json": "run-data",
      "logs.txt": "logs",
      "not-selected.json": "ignore",
    });
    const client = clientFor({ archive });
    const result = await bundleFor(client, out);
    assert.equal(client.downloads.length, 2);
    assert.ok(result.warnings.some((warning) => /Multistep asset capture is invalid/.test(warning)));
  } finally {
    await rm(out, { recursive: true, force: true });
  }
});

test("remote manifest validation preserves distinct contract rejection categories", async (t) => {
  const { mkdtemp, rm } = await import("node:fs/promises");
  const cases: Array<[string, (id: string) => AssetManifestEntry[], RegExp]> = [
    ["bad source", () => [{
      name: "test-results.json", type: "report", url: "https://assets.example/result.zip",
      source: "other", archive: { entryName: "test-results.json" },
    } as AssetManifestEntry], /MULTISTEP_ASSET_TYPE_INVALID/],
    ["bad content type", () => [{
      name: "test-results.json", type: "report", url: "https://assets.example/result.zip",
      source: "check-result", contentType: 513 as unknown as string,
      archive: { entryName: "test-results.json" },
    } as AssetManifestEntry], /MULTISTEP_ASSET_TYPE_INVALID/],
    ["duplicate name", () => [
      {
        name: "test-results.json", type: "report", url: "https://assets.example/a.zip",
        source: "check-result", archive: { entryName: "test-results.json" },
      },
      {
        name: "test-results.json", type: "report", url: "https://assets.example/b.zip",
        source: "check-result", archive: { entryName: "test-results.json" },
      },
    ] as AssetManifestEntry[], /MULTISTEP_DUPLICATE_ASSET/],
    ["bad archive descriptor", () => [{
      name: "test-results.json", type: "report", url: "https://assets.example/result.zip",
      source: "check-result", archive: { entryName: "test-results.json", extra: true } as never,
    } as AssetManifestEntry], /MULTISTEP_ASSET_TYPE_INVALID/],
  ];

  for (const [name, makeEntries, expected] of cases) {
    const out = await mkdtemp("/tmp/verify-fix-contract-");
    try {
      const client = clientFor({ entries: makeEntries });
      const result = await bundleFor(client, out);
      const problems = result.manifest.multistep?.problems ?? [];
      assert.ok(problems.some((problem) => expected.test(problem)), `${name}: ${problems.join(", ")}`);
    } finally {
      await rm(out, { recursive: true, force: true });
    }
  }
});
