// Decompression-bomb guard for XLSX imports (BP §16 "upload mime/size/magic-byte checks").
// exceljs inflates the whole workbook in memory (JSZip) before any row or cell limit can apply, so a
// few hundred KB of zip can carry hundreds of MB of sheet XML. Before exceljs sees the buffer this
// walks the zip central directory and really inflates every entry as a stream, counting the output
// and discarding it, and refuses as soon as an entry or the whole archive unpacks past the limits.
// Declared sizes in the zip headers are never trusted (they can lie); only real output is counted.
import { createInflateRaw } from 'node:zlib';
import { unsupportedFile } from '../../../shared/errors.js';

export interface ZipLimits {
  /** Largest allowed unpacked size of one entry (bytes). */
  maxEntryBytes: number;
  /** Largest allowed unpacked size of all entries together (bytes). */
  maxTotalBytes: number;
  /** Most entries allowed in the archive. */
  maxEntries: number;
}

/**
 * Generous for a real import: IMPORT_MAX_ROWS (5000) rows × 30 columns of sheet XML is ≈ 6–10 MB,
 * shared strings a few MB more. A bomb of this size still keeps the exceljs model well under 100 MB.
 */
export const XLSX_IMPORT_LIMITS: Readonly<ZipLimits> = Object.freeze({
  maxEntryBytes: 24 * 1024 * 1024,
  maxTotalBytes: 32 * 1024 * 1024,
  maxEntries: 500,
});

const EOCD_SIG = 0x06054b50;
const CDH_SIG = 0x02014b50;
const LFH_SIG = 0x04034b50;

const unreadable = () => unsupportedFile('The spreadsheet could not be read. Save it as .xlsx or .csv and try again.');
const tooLarge = () => unsupportedFile('The spreadsheet is too large when unpacked. Remove unused sheets, images or very long cell values, or split it into smaller files.');

interface Entry {
  method: number;
  compressedSize: number;
  localOffset: number;
}

function findEocd(buf: Buffer): number {
  const min = Math.max(0, buf.length - (22 + 0xffff));
  for (let i = buf.length - 22; i >= min; i -= 1) if (buf.readUInt32LE(i) === EOCD_SIG) return i;
  return -1;
}

/** Central directory → entries (method, compressed size, local header offset). */
export function readZipEntries(buf: Buffer, maxEntries: number): Entry[] {
  if (buf.length < 22) throw unreadable();
  const eocd = findEocd(buf);
  if (eocd < 0) throw unreadable();
  const count = buf.readUInt16LE(eocd + 10);
  const cdSize = buf.readUInt32LE(eocd + 12);
  const cdOffset = buf.readUInt32LE(eocd + 16);
  // ZIP64 archives (count/offset markers) are never needed for a file within the 5 MB import limit.
  if (count === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) throw unreadable();
  if (count > maxEntries) throw tooLarge();
  if (cdOffset + cdSize > eocd) throw unreadable();
  const entries: Entry[] = [];
  let p = cdOffset;
  for (let n = 0; n < count; n += 1) {
    if (p + 46 > eocd || buf.readUInt32LE(p) !== CDH_SIG) throw unreadable();
    const method = buf.readUInt16LE(p + 10);
    const compressedSize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOffset = buf.readUInt32LE(p + 42);
    if (compressedSize === 0xffffffff || localOffset === 0xffffffff) throw unreadable();
    entries.push({ method, compressedSize, localOffset });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

/** Inflates `data` as a stream and returns the real output size; rejects as soon as it passes `cap`. */
function inflatedSize(data: Buffer, cap: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const inflate = createInflateRaw();
    let total = 0;
    let done = false;
    const finish = (err: Error | null, size = 0) => {
      if (done) return;
      done = true;
      if (err) {
        inflate.destroy();
        reject(err);
      } else resolve(size);
    };
    inflate.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > cap) finish(tooLarge());
    });
    inflate.on('error', () => finish(unreadable()));
    inflate.on('end', () => finish(null, total));
    inflate.end(data);
  });
}

/** Throws UNSUPPORTED_FILE when the zip is malformed or unpacks past `limits`. */
export async function assertZipWithinLimits(buf: Buffer, limits: ZipLimits = XLSX_IMPORT_LIMITS): Promise<void> {
  const entries = readZipEntries(buf, limits.maxEntries);
  let total = 0;
  for (const e of entries) {
    const lfh = e.localOffset;
    if (lfh + 30 > buf.length || buf.readUInt32LE(lfh) !== LFH_SIG) throw unreadable();
    const start = lfh + 30 + buf.readUInt16LE(lfh + 26) + buf.readUInt16LE(lfh + 28);
    const end = start + e.compressedSize;
    if (end > buf.length) throw unreadable();
    const data = buf.subarray(start, end);
    const remaining = limits.maxTotalBytes - total;
    let size: number;
    if (e.method === 0) size = data.length;
    else if (e.method === 8) size = await inflatedSize(data, Math.min(limits.maxEntryBytes, remaining));
    else throw unreadable(); // JSZip (exceljs) only supports stored and deflated entries
    if (size > limits.maxEntryBytes || size > remaining) throw tooLarge();
    total += size;
  }
}
