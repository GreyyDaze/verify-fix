// Minimal ZIP reader (no dependencies). Enough for Playwright trace archives
// and Checkly asset archives: STORE (0) and DEFLATE (8) entries, read through
// the central directory. ZIP64 is not supported (trace files are far below 4 GB).

import { inflateRawSync } from "node:zlib";

export interface ZipEntry {
  name: string;
  method: number;
  compressedSize: number;
  uncompressedSize: number;
  localHeaderOffset: number;
}

const EOCD_SIG = 0x06054b50;
const CDIR_SIG = 0x02014b50;
const LOCAL_SIG = 0x04034b50;

function findEndOfCentralDirectory(buf: Buffer): number {
  const min = Math.max(0, buf.length - 22 - 0xffff);
  for (let i = buf.length - 22; i >= min; i--) {
    if (buf.readUInt32LE(i) === EOCD_SIG) return i;
  }
  throw new Error("zip: end of central directory not found (not a zip file?)");
}

export function listZip(buf: Buffer): ZipEntry[] {
  const eocd = findEndOfCentralDirectory(buf);
  const total = buf.readUInt16LE(eocd + 10);
  const cdirOffset = buf.readUInt32LE(eocd + 16);
  if (cdirOffset === 0xffffffff) throw new Error("zip: ZIP64 archives are not supported");
  const entries: ZipEntry[] = [];
  let p = cdirOffset;
  for (let i = 0; i < total; i++) {
    if (buf.readUInt32LE(p) !== CDIR_SIG) throw new Error(`zip: bad central directory entry at ${p}`);
    const method = buf.readUInt16LE(p + 10);
    const compressedSize = buf.readUInt32LE(p + 20);
    const uncompressedSize = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localHeaderOffset = buf.readUInt32LE(p + 42);
    const name = buf.toString("utf8", p + 46, p + 46 + nameLen);
    entries.push({ name, method, compressedSize, uncompressedSize, localHeaderOffset });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

export function readZipEntry(buf: Buffer, entry: ZipEntry): Buffer {
  const h = entry.localHeaderOffset;
  if (buf.readUInt32LE(h) !== LOCAL_SIG) throw new Error(`zip: bad local header for ${entry.name}`);
  const nameLen = buf.readUInt16LE(h + 26);
  const extraLen = buf.readUInt16LE(h + 28);
  const start = h + 30 + nameLen + extraLen;
  const data = buf.subarray(start, start + entry.compressedSize);
  if (entry.method === 0) return Buffer.from(data);
  if (entry.method === 8) return inflateRawSync(data);
  throw new Error(`zip: unsupported compression method ${entry.method} for ${entry.name}`);
}

/** name → lazy reader, for archives where only a few entries are needed. */
export function openZip(buf: Buffer): Map<string, () => Buffer> {
  const map = new Map<string, () => Buffer>();
  for (const e of listZip(buf)) {
    if (e.name.endsWith("/")) continue; // directory marker
    map.set(e.name, () => readZipEntry(buf, e));
  }
  return map;
}

/** Explicit bounds applied to candidate-supplied archives (asset capture). */
export interface ZipBounds {
  /** maximum archive byte length accepted at all */
  maxArchiveBytes: number;
  /** maximum number of central-directory entries */
  maxEntries: number;
  /** maximum declared compressed size of a single entry */
  maxEntryCompressedBytes: number;
  /** maximum decompressed size of a single entry (declared AND actual) */
  maxEntryUncompressedBytes: number;
  /** maximum total decompressed bytes across all reads */
  maxTotalUncompressedBytes: number;
  /** maximum uncompressed/compressed ratio for a single deflated entry */
  maxCompressionRatio: number;
}

/** Default bounds for downloaded Checkly asset archives. */
export const ASSET_ZIP_BOUNDS: ZipBounds = {
  maxArchiveBytes: 64 * 1024 * 1024,
  maxEntries: 64,
  maxEntryCompressedBytes: 32 * 1024 * 1024,
  maxEntryUncompressedBytes: 32 * 1024 * 1024,
  maxTotalUncompressedBytes: 96 * 1024 * 1024,
  maxCompressionRatio: 200,
};

/**
 * Bounded ZIP reader for asset capture: archive size, entry count, per-entry
 * compressed and decompressed sizes, total decompressed bytes, compression
 * ratio, and duplicate entry names are all enforced before any content is
 * returned. Nothing is ever extracted to disk. Malformed archives throw.
 */
export function openZipBounded(buf: Buffer, bounds: ZipBounds = ASSET_ZIP_BOUNDS): Map<string, () => Buffer> {
  if (buf.length > bounds.maxArchiveBytes) {
    throw new Error(`zip: archive of ${buf.length} bytes exceeds the ${bounds.maxArchiveBytes}-byte bound`);
  }
  const entries = listZip(buf);
  if (entries.length > bounds.maxEntries) {
    throw new Error(`zip: ${entries.length} entries exceed the ${bounds.maxEntries}-entry bound`);
  }
  const seen = new Set<string>();
  let declaredTotal = 0;
  for (const e of entries) {
    if (e.name.endsWith("/")) continue;
    if (seen.has(e.name)) throw new Error(`zip: duplicate entry name ${JSON.stringify(e.name)}`);
    seen.add(e.name);
    declaredTotal += e.uncompressedSize;
    if (declaredTotal > bounds.maxTotalUncompressedBytes) {
      throw new Error(`zip: declared total uncompressed size exceeds the ${bounds.maxTotalUncompressedBytes}-byte bound`);
    }
    if (e.compressedSize > bounds.maxEntryCompressedBytes) {
      throw new Error(`zip: entry ${JSON.stringify(e.name)} compressed size ${e.compressedSize} exceeds bound`);
    }
    if (e.uncompressedSize > bounds.maxEntryUncompressedBytes) {
      throw new Error(`zip: entry ${JSON.stringify(e.name)} uncompressed size ${e.uncompressedSize} exceeds bound`);
    }
    if (e.method === 8 && e.compressedSize > 0 && e.uncompressedSize / e.compressedSize > bounds.maxCompressionRatio) {
      throw new Error(`zip: entry ${JSON.stringify(e.name)} compression ratio exceeds ${bounds.maxCompressionRatio}:1`);
    }
  }
  const map = new Map<string, () => Buffer>();
  let totalUncompressed = 0;
  for (const e of entries) {
    if (e.name.endsWith("/")) continue;
    map.set(e.name, () => {
      const data = readZipEntryBounded(buf, e, bounds);
      totalUncompressed += data.length;
      if (totalUncompressed > bounds.maxTotalUncompressedBytes) {
        throw new Error(`zip: total decompressed bytes exceed the ${bounds.maxTotalUncompressedBytes}-byte bound`);
      }
      return data;
    });
  }
  return map;
}

function readZipEntryBounded(buf: Buffer, entry: ZipEntry, bounds: ZipBounds): Buffer {
  const h = entry.localHeaderOffset;
  if (buf.readUInt32LE(h) !== LOCAL_SIG) throw new Error(`zip: bad local header for ${entry.name}`);
  const nameLen = buf.readUInt16LE(h + 26);
  const extraLen = buf.readUInt16LE(h + 28);
  const start = h + 30 + nameLen + extraLen;
  if (start + entry.compressedSize > buf.length) throw new Error(`zip: entry ${entry.name} extends past the end of the archive`);
  const data = buf.subarray(start, start + entry.compressedSize);
  if (entry.method === 0) {
    if (data.length > bounds.maxEntryUncompressedBytes) throw new Error(`zip: entry ${entry.name} exceeds the per-entry size bound`);
    return Buffer.from(data);
  }
  if (entry.method === 8) {
    // maxOutputLength caps the ACTUAL decompression output, independent of
    // what the (possibly lying) central directory declared.
    return inflateRawSync(data, { maxOutputLength: bounds.maxEntryUncompressedBytes });
  }
  throw new Error(`zip: unsupported compression method ${entry.method} for ${entry.name}`);
}

export function isZip(buf: Buffer): boolean {
  return buf.length >= 4 && buf.readUInt32LE(0) === LOCAL_SIG;
}
