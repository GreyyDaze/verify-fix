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

export function isZip(buf: Buffer): boolean {
  return buf.length >= 4 && buf.readUInt32LE(0) === LOCAL_SIG;
}
