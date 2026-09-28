// Bundle capture support for Multistep incidents.
//
// Reads downloaded result assets (from `checkly assets download --type all
// --dir …`, flat files or an assets.zip, optionally split into failing/ and
// passing/ subdirectories), normalizes them, extracts the structured
// transaction, and sanitizes it for storage. The bundle writes ONLY the
// sanitized recording — raw assets are hashed (BEFORE any parsing) for
// provenance and never stored. Missing/corrupt/truncated assets become
// `problems` (UNCERTAIN).
//
// Asset intake is bounded and structural: files are read through lstat (a
// symbolic link is rejected, never followed), each file has an explicit size
// bound, and assets.zip is read through the bounded ZIP reader (archive
// size, entry count, per-entry compressed/uncompressed sizes, total
// uncompressed bytes, compression ratio, duplicate names) with NO
// extraction to disk. When an explicit failing/ or passing/ path is given,
// an invalid result under that path is returned AS invalid — it never falls
// back to a different flat parent directory.

import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync } from "node:fs";
import { join } from "node:path";
import { ASSET_ZIP_BOUNDS, openZipBounded } from "../trace/zip.ts";
import { normalizeMultiStepCapture, type MultiStepCapture } from "./normalize.ts";
import { extractTransaction, type MultiStepTransaction } from "./transaction.ts";
import { multistepProblemCategory, sanitizeMultiStepCapture } from "./sanitize.ts";

export interface MultiStepTexts {
  testResults: string | null;
  checkRunData: string | null;
  logs: string | null;
  /** structural invalidity of an EXPLICIT asset location (never a fallback trigger) */
  invalid?: string;
}

export interface MultiStepAssetTexts extends MultiStepTexts {
  found: string[];
  missing: string[];
  /** sha256 + byte length of each raw asset file, hashed before parsing */
  hashes?: Record<string, { bytes: number; sha256: string }>;
}

export const MULTISTEP_RECORDING_SCHEMA = "multistep-recording-v2";

/** Maximum bytes for any single directly-read asset file. */
export const MAX_ASSET_FILE_BYTES = 32 * 1024 * 1024;
/** Maximum bytes for a directly-read assets.zip. */
export const MAX_ASSET_ZIP_BYTES = ASSET_ZIP_BOUNDS.maxArchiveBytes;

const REQUIRED_ASSET = "test-results.json";
const OPTIONAL_ASSETS = ["check-run-data.json", "logs.txt"];

function sha256(buf: Buffer): string {
  return createHash("sha256").update(buf).digest("hex");
}

function invalidTexts(reason: string): MultiStepAssetTexts {
  return {
    testResults: null,
    checkRunData: null,
    logs: null,
    found: [],
    missing: [REQUIRED_ASSET, "check-run-data.json", "logs.txt"],
    invalid: reason,
    hashes: {},
  };
}

/** Inspect without following symbolic links (including broken optional links). */
function assetStat(path: string): ReturnType<typeof lstatSync> | null {
  try {
    return lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

/** Descriptor read is bounded BEFORE allocation, including when a file grows
 * between lstat/fstat and read. No readFileSync(fd) unbounded growth window. */
function readBounded(fd: number, max: number): Buffer | null {
  const chunks: Buffer[] = [];
  let total = 0;
  while (total <= max) {
    const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, max + 1 - total));
    const n = readSync(fd, chunk, 0, chunk.length, null);
    if (n === 0) return Buffer.concat(chunks, total);
    total += n;
    if (total > max) return null;
    chunks.push(chunk.subarray(0, n));
  }
  return null;
}

/** Open with O_NOFOLLOW, then enforce the size on the opened descriptor. */
function resolveAssetFile(name: string, path: string): { buf: Buffer } | { invalid: string } {
  try {
    const stat = assetStat(path);
    if (!stat) return { invalid: `missing ${name}` };
    if (stat.isSymbolicLink()) return { invalid: `${name} is a symbolic link — symlinks are rejected, not followed` };
    if (!stat.isFile()) return { invalid: `${name} is not a regular file` };
    if (stat.size > MAX_ASSET_FILE_BYTES) return { invalid: `${name} exceeds the ${MAX_ASSET_FILE_BYTES}-byte bound` };
    const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      const opened = fstatSync(fd);
      if (!opened.isFile() || opened.size > MAX_ASSET_FILE_BYTES) return { invalid: `${name} is not a bounded regular file` };
      const buf = readBounded(fd, MAX_ASSET_FILE_BYTES);
      if (!buf) return { invalid: `${name} exceeds the ${MAX_ASSET_FILE_BYTES}-byte bound` };
      return { buf };
    } finally {
      closeSync(fd);
    }
  } catch {
    return { invalid: `${name} could not be read safely` };
  }
}

function textsFromBuffers(files: Record<string, Buffer | null>): MultiStepAssetTexts {
  const found: string[] = [];
  const missing: string[] = [];
  const hashes: Record<string, { bytes: number; sha256: string }> = {};
  const text = (name: string, optionalLabel?: string): string | null => {
    const buf = files[name];
    if (!buf) {
      missing.push(optionalLabel ?? name);
      return null;
    }
    found.push(name);
    // hash BEFORE parsing: provenance is a property of the raw bytes
    hashes[name] = { bytes: buf.byteLength, sha256: sha256(buf) };
    return buf.toString("utf8");
  };
  const testResults = text(REQUIRED_ASSET);
  const checkRunData = text("check-run-data.json", "check-run-data.json (optional)");
  const logs = text("logs.txt", "logs.txt (optional)");
  return { testResults, checkRunData, logs, found, missing, hashes };
}

function fromDirectory(dir: string): MultiStepAssetTexts {
  const root = assetStat(dir);
  if (!root || !root.isDirectory() || root.isSymbolicLink()) return invalidTexts("asset directory is not a safe directory");
  const readDirect = (): { files: Record<string, Buffer | null> } | { invalid: string } => {
    const files: Record<string, Buffer | null> = {};
    for (const name of [REQUIRED_ASSET, ...OPTIONAL_ASSETS]) {
      const path = join(dir, name);
      if (!assetStat(path)) {
        files[name] = null;
        continue;
      }
      const resolved = resolveAssetFile(name, path);
      if ("invalid" in resolved) return { invalid: resolved.invalid }; // present optional corruption is NOT absence
      files[name] = resolved.buf;
    }
    return { files };
  };
  const zipPath = join(dir, "assets.zip");
  const hasDirectRequired = assetStat(join(dir, REQUIRED_ASSET)) !== null;
  const hasArchive = assetStat(zipPath) !== null;
  if (hasDirectRequired && hasArchive) return invalidTexts("assets.zip conflicts with direct test-results.json — ambiguous evidence");
  if (!hasDirectRequired && hasArchive) {
    // assets.zip from `checkly assets download` — bounded reader, no extraction
    try {
      const zipStat = lstatSync(zipPath);
      if (zipStat.isSymbolicLink()) return invalidTexts("assets.zip is a symbolic link — symlinks are rejected, not followed");
      if (!zipStat.isFile()) return invalidTexts("assets.zip is not a regular file");
      if (zipStat.size > MAX_ASSET_ZIP_BYTES) return invalidTexts(`assets.zip exceeds the ${MAX_ASSET_ZIP_BYTES}-byte bound`);
      // Reuse the no-follow descriptor and actual-read bound for the archive.
      const fd = openSync(zipPath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      let zipBuf: Buffer;
      try {
        const opened = fstatSync(fd);
        if (!opened.isFile() || opened.size > MAX_ASSET_ZIP_BYTES) return invalidTexts("assets.zip exceeds archive byte bound");
        const bounded = readBounded(fd, MAX_ASSET_ZIP_BYTES);
        if (!bounded) return invalidTexts("assets.zip exceeds archive byte bound");
        zipBuf = bounded;
      } finally {
        closeSync(fd);
      }
      const zip = openZipBounded(zipBuf, ASSET_ZIP_BOUNDS);
      const files: Record<string, Buffer | null> = {};
      for (const name of [REQUIRED_ASSET, ...OPTIONAL_ASSETS]) files[name] = zip.has(name) ? zip.get(name)!() : null;
      if (files[REQUIRED_ASSET] === null) return invalidTexts(`assets.zip does not contain ${REQUIRED_ASSET}`);
      return textsFromBuffers(files);
    } catch (error) {
      const cause = error instanceof Error && /^zip: [a-zA-Z0-9 :()-]+$/.test(error.message) ? error.message : "zip: unreadable archive";
      return invalidTexts(`assets.zip is invalid (${cause})`);
    }
  }
  const direct = readDirect();
  if ("invalid" in direct) return invalidTexts(direct.invalid);
  return textsFromBuffers(direct.files);
}

/**
 * Read downloaded assets from a directory:
 *  - flat files            → the failing result's assets
 *  - failing/ + passing/   → each result's assets
 *  - assets.zip            → entries from the zip (flat or per-result subdirs)
 *
 * An EXPLICIT failing/ or passing/ path that is invalid returns `invalid`
 * instead of falling back to the flat parent directory.
 */
export function readMultiStepAssets(dir: string): { failing: MultiStepAssetTexts | null; passing: MultiStepAssetTexts | null } {
  const failingDir = join(dir, "failing");
  const passingDir = join(dir, "passing");
  if (assetStat(failingDir)) {
    return {
      failing: fromDirectory(failingDir),
      passing: assetStat(passingDir) ? fromDirectory(passingDir) : null,
    };
  }
  if (assetStat(passingDir)) {
    // passing/ without failing/: passing is explicit, failing comes from flat
    return { failing: fromDirectory(dir), passing: fromDirectory(passingDir) };
  }
  return { failing: fromDirectory(dir), passing: null };
}

export interface MultiStepCaptureInput {
  texts: MultiStepTexts;
  attempts?: number | null;
}

export interface MultiStepRecording {
  schemaVersion: typeof MULTISTEP_RECORDING_SCHEMA;
  /** Set only by bundle creation after the trusted source/result is selected.
   * Standalone mechanics fixtures are deliberately unbound and cannot load. */
  binding?: {
    side: "failing" | "passing";
    checkId: string;
    resultId: string;
    runLocation: string;
    startedAt: string;
    stoppedAt: string | null;
    sourceFile: string;
    sourceSha256: string;
    testResultsSha256: string;
    reporter: "playwright-json-nested";
    bridge: "required-at-local-execution";
  };
  kind: MultiStepCapture["kind"];
  stats: MultiStepCapture["stats"];
  steps: MultiStepCapture["steps"];
  checkRunData: MultiStepCapture["checkRunData"];
  logs: MultiStepCapture["logs"];
  recurrence: MultiStepCapture["recurrence"];
  transaction: {
    steps: MultiStepTransaction["steps"];
    account: MultiStepTransaction["account"] extends null ? null : { label: string; sites: string[] };
    token: MultiStepTransaction["token"] extends null ? null : { label: string; sites: string[]; occurrences: number };
    slot: MultiStepTransaction["slot"];
    version: MultiStepTransaction["version"];
  } | null;
  problems: string[];
  evidenceNote: string;
}

export const MECHANICS_ONLY_NOTE =
  "Recorded captures are evidence of that recorded run; locally constructed fixtures prove mechanics only — they are never real Checkly, browser, deployment, or cloud proof.";

export type CaptureRecordingResult =
  | { ok: true; recording: MultiStepRecording; capture: MultiStepCapture; secrets: string[] }
  | { ok: false; reason: string; problems: string[] };

/** Normalize → extract relationships → sanitize. Storage gets sanitized output only. */
export function buildMultiStepRecording(input: MultiStepCaptureInput): CaptureRecordingResult {
  if (input.texts.invalid) {
    const reason = multistepProblemCategory(input.texts.invalid);
    return { ok: false, reason, problems: [reason] };
  }
  const capture = normalizeMultiStepCapture({
    testResults: input.texts.testResults,
    checkRunData: input.texts.checkRunData,
    logs: input.texts.logs,
    attempts: input.attempts ?? null,
  });
  if (capture.problems.length > 0) {
    const problems = [...new Set(capture.problems.map(multistepProblemCategory))];
    return { ok: false, reason: problems[0]!, problems };
  }
  const transaction = extractTransaction(capture);
  const sanitized = sanitizeMultiStepCapture(capture, transaction);
  if (!sanitized.ok) {
    return { ok: false, reason: sanitized.reason, problems: [sanitized.reason] };
  }
  // Re-extract from the VALUES-FREE capture. In particular, raw transaction
  // steps, request paths, errors, sites and values must never enter storage.
  const safeTransaction = extractTransaction(sanitized.capture);
  if (safeTransaction.problems.length) {
    const reason = multistepProblemCategory(safeTransaction.problems[0]!);
    return { ok: false, reason, problems: [reason] };
  }
  const recording: MultiStepRecording = {
    schemaVersion: MULTISTEP_RECORDING_SCHEMA,
    kind: sanitized.capture.kind,
    stats: sanitized.capture.stats,
    steps: sanitized.capture.steps,
    checkRunData: sanitized.capture.checkRunData,
    logs: sanitized.capture.logs,
    recurrence: sanitized.capture.recurrence,
    transaction: safeTransaction.account && safeTransaction.token
      ? {
          steps: safeTransaction.steps,
          account: { label: "<account>", sites: safeTransaction.account.sites },
          token: { label: "<token>", sites: safeTransaction.token.sites, occurrences: safeTransaction.token.occurrences },
          slot: safeTransaction.slot,
          version: safeTransaction.version,
        }
      : null,
    problems: sanitized.capture.problems,
    evidenceNote: MECHANICS_ONLY_NOTE,
  };
  return { ok: true, recording, capture: sanitized.capture, secrets: sanitized.secrets };
}
