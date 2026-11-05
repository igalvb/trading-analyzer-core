/**
 * A minimal ZIP reader -- the replacement for Apps Script's
 * Utilities.unzip(), which legacy uses on exactly one input: State Street's
 * holdings .xlsx (dataLayerV1.gs:1324). An .xlsx is a ZIP of XML parts.
 *
 * Reads the central directory (authoritative for sizes even when entries
 * carry data descriptors), then each entry's data. Stored (0) and deflated
 * (8) entries are supported -- the two methods Excel and every common
 * writer use; anything else throws. Directory entries are skipped. ZIP64
 * archives (> 4 GB or > 65535 entries) are out of scope and throw.
 *
 * A body that is not a ZIP at all (an HTML error page served with 200) throws
 * ZipFormatError -- as Utilities.unzip throws -- and legacy's caller catches
 * it and returns null.
 *
 * Verified on a real Excel-written workbook: same 133 entries and
 * byte-identical part contents as the system `unzip` tool.
 */

import { inflateRawSync } from 'node:zlib';

export interface ZipEntry {
  readonly name: string;
  readonly data: Uint8Array;
  /** Utilities.unzip blob's getDataAsString(): UTF-8. */
  text(): string;
}

export class ZipFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ZipFormatError';
  }
}

const EOCD = 0x06054b50;
const CENTRAL = 0x02014b50;
const LOCAL = 0x04034b50;

export function unzip(bytes: Uint8Array): ZipEntry[] {
  const buf = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (buf.length < 22) throw new ZipFormatError('not a zip archive (too short)');
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
    if (buf.readUInt32LE(i) === EOCD) { eocd = i; break; }
  }
  if (eocd < 0) throw new ZipFormatError('not a zip archive (no end-of-central-directory record)');
  const count = buf.readUInt16LE(eocd + 10);
  const dirOffset = buf.readUInt32LE(eocd + 16);
  if (count === 0xffff || dirOffset === 0xffffffff) throw new ZipFormatError('ZIP64 archives are not supported');
  const out: ZipEntry[] = [];
  let p = dirOffset;
  for (let k = 0; k < count; k++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== CENTRAL) throw new ZipFormatError('corrupt central directory');
    const method = buf.readUInt16LE(p + 10);
    const compSize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOffset = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    p += 46 + nameLen + extraLen + commentLen;
    if (name.endsWith('/')) continue;
    if (localOffset + 30 > buf.length || buf.readUInt32LE(localOffset) !== LOCAL) throw new ZipFormatError('corrupt local header for ' + name);
    const start = localOffset + 30 + buf.readUInt16LE(localOffset + 26) + buf.readUInt16LE(localOffset + 28);
    const raw = buf.subarray(start, start + compSize);
    let data: Uint8Array;
    if (method === 0) data = new Uint8Array(raw);
    else if (method === 8) data = new Uint8Array(inflateRawSync(raw));
    else throw new ZipFormatError('unsupported compression method ' + method + ' for ' + name);
    out.push({ name, data, text: () => new TextDecoder('utf-8').decode(data) });
  }
  return out;
}
