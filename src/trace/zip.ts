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
  crc32: number;
  flags: number;
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
  if (buf.length > ASSET_ZIP_BOUNDS.maxArchiveBytes) throw new Error("zip: archive exceeds byte bound");
  return listZipWithCountBound(buf, ASSET_ZIP_BOUNDS.maxEntries);
}

function listZipWithCountBound(buf: Buffer, maxEntries: number): ZipEntry[] {
  const eocd = findEndOfCentralDirectory(buf);
  if (eocd + 22 > buf.length) throw new Error("zip: truncated end record");
  const total = buf.readUInt16LE(eocd + 10);
  const cdirSize = buf.readUInt32LE(eocd + 12);
  const cdirOffset = buf.readUInt32LE(eocd + 16);
  if (cdirOffset === 0xffffffff || cdirSize === 0xffffffff || total === 0xffff) throw new Error("zip: ZIP64 archives are not supported");
  if (total > maxEntries) throw new Error("zip: entries exceed count bound");
  if (cdirOffset > eocd || cdirSize > eocd - cdirOffset) throw new Error("zip: truncated central directory");
  const entries: ZipEntry[] = [];
  let p = cdirOffset;
  for (let i = 0; i < total; i++) {
    if (p + 46 > eocd || buf.readUInt32LE(p) !== CDIR_SIG) throw new Error("zip: invalid central directory entry");
    const flags = buf.readUInt16LE(p + 8);
    const method = buf.readUInt16LE(p + 10);
    const crc32 = buf.readUInt32LE(p + 16);
    const compressedSize = buf.readUInt32LE(p + 20);
    const uncompressedSize = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localHeaderOffset = buf.readUInt32LE(p + 42);
    const next = p + 46 + nameLen + extraLen + commentLen;
    if (next > eocd || next > cdirOffset + cdirSize) throw new Error("zip: truncated central directory entry");
    const name = buf.toString("utf8", p + 46, p + 46 + nameLen);
    entries.push({ name, method, compressedSize, uncompressedSize, localHeaderOffset, crc32, flags });
    p = next;
  }
  if (p !== cdirOffset + cdirSize) throw new Error("zip: central directory size mismatch");
  return entries;
}

/** Legacy entry access also goes through the bounded integrity-checked map;
 * callers cannot bypass limits by choosing this public helper. */
export function readZipEntry(buf: Buffer, entry: ZipEntry): Buffer {
  const read = openZipBounded(buf).get(entry.name);
  if (!read) throw new Error("zip: requested entry missing or unsafe");
  return read();
}

/** Legacy name → reader API, now subject to the same mandatory bounds. */
export function openZip(buf: Buffer): Map<string, () => Buffer> {
  return openZipBounded(buf);
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

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let bit = 0; bit < 8; bit++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[i] = c >>> 0;
  }
  return table;
})();

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/**
 * Bounded ZIP reader. The central directory is validated before any entry
 * allocation; each lazy read then checks its LOCAL header, actual inflate
 * size and ratio, CRC32, and the aggregate remaining byte budget. A forged
 * central-directory size cannot circumvent an actual-output limit.
 */
export function openZipBounded(buf: Buffer, bounds: ZipBounds = ASSET_ZIP_BOUNDS): Map<string, () => Buffer> {
  if (buf.length > bounds.maxArchiveBytes) throw new Error("zip: archive exceeds byte bound");
  // Check the central-directory count BEFORE building its entry array. The
  // public legacy listZip helper uses the fixed default bounds as well.
  const entries = listZipWithCountBound(buf, bounds.maxEntries);
  const seen = new Set<string>();
  let declaredTotal = 0;
  for (const e of entries) {
    if (seen.has(e.name)) throw new Error("zip: duplicate entry name");
    seen.add(e.name);
    if (!e.name || e.name.startsWith("/") || e.name.includes("\\") || e.name.split("/").includes("..")) {
      throw new Error("zip: unsafe entry name");
    }
    if (e.flags & ~(0x0008 | 0x0800)) throw new Error("zip: encrypted or unsupported entry flags");
    if (e.method !== 0 && e.method !== 8) throw new Error("zip: unsupported compression method");
    if (e.compressedSize > bounds.maxEntryCompressedBytes) throw new Error("zip: compressed size exceeds bound");
    if (e.uncompressedSize > bounds.maxEntryUncompressedBytes) throw new Error("zip: uncompressed size exceeds bound");
    if (e.method === 0 && e.compressedSize !== e.uncompressedSize) throw new Error("zip: stored entry size mismatch");
    if (e.compressedSize === 0 && e.uncompressedSize !== 0) throw new Error("zip: invalid zero-length compressed entry");
    if (e.method === 8 && e.compressedSize && e.uncompressedSize / e.compressedSize > bounds.maxCompressionRatio) {
      throw new Error("zip: declared compression ratio exceeds bound");
    }
    declaredTotal += e.uncompressedSize;
    if (declaredTotal > bounds.maxTotalUncompressedBytes) throw new Error("zip: declared total uncompressed size exceeds bound");
  }
  const map = new Map<string, () => Buffer>();
  let totalUncompressed = 0;
  for (const e of entries) {
    if (e.name.endsWith("/")) continue;
    let cached: Buffer | null = null;
    map.set(e.name, () => {
      if (cached) return cached;
      const remaining = bounds.maxTotalUncompressedBytes - totalUncompressed;
      if (remaining < 0) throw new Error("zip: total decompressed bytes exceed bound");
      const data = readZipEntryBounded(buf, e, bounds, remaining);
      totalUncompressed += data.length;
      cached = data;
      return data;
    });
  }
  return map;
}

function readZipEntryBounded(buf: Buffer, entry: ZipEntry, bounds: ZipBounds, remaining: number): Buffer {
  const h = entry.localHeaderOffset;
  if (h > buf.length - 30 || buf.readUInt32LE(h) !== LOCAL_SIG) throw new Error("zip: invalid local header");
  const flags = buf.readUInt16LE(h + 6);
  const method = buf.readUInt16LE(h + 8);
  const nameLen = buf.readUInt16LE(h + 26);
  const extraLen = buf.readUInt16LE(h + 28);
  const start = h + 30 + nameLen + extraLen;
  if (start > buf.length || start + entry.compressedSize > buf.length) throw new Error("zip: truncated entry data");
  if (method !== entry.method || flags !== entry.flags || buf.toString("utf8", h + 30, h + 30 + nameLen) !== entry.name) {
    throw new Error("zip: local and central headers disagree");
  }
  if (!(flags & 0x0008) && (buf.readUInt32LE(h + 14) !== entry.crc32 || buf.readUInt32LE(h + 18) !== entry.compressedSize || buf.readUInt32LE(h + 22) !== entry.uncompressedSize)) {
    throw new Error("zip: local and central integrity fields disagree");
  }
  const packed = buf.subarray(start, start + entry.compressedSize);
  const cap = Math.min(bounds.maxEntryUncompressedBytes, remaining);
  let data: Buffer;
  if (entry.method === 0) {
    if (packed.length > cap) throw new Error("zip: aggregate decompressed bytes exceed bound");
    data = Buffer.from(packed);
  } else {
    // Node's maxOutputLength stops inflation BEFORE the unchecked output is
    // allocated, even when the declared size in the central directory lies.
    try {
      data = inflateRawSync(packed, { maxOutputLength: Math.max(1, cap) });
    } catch {
      throw new Error("zip: actual inflate exceeds bound or is corrupt");
    }
  }
  if (data.length > cap) throw new Error("zip: total decompressed bytes exceed bound");
  if (entry.method === 8 && data.length / Math.max(1, packed.length) > bounds.maxCompressionRatio) {
    throw new Error("zip: actual compression ratio exceeds bound");
  }
  if (data.length !== entry.uncompressedSize) throw new Error("zip: actual and declared sizes disagree");
  if (crc32(data) !== entry.crc32) throw new Error("zip: CRC32 integrity mismatch");
  return data;
}

export function isZip(buf: Buffer): boolean {
  return buf.length >= 4 && buf.readUInt32LE(0) === LOCAL_SIG;
}
