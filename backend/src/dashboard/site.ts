/**
 * The dashboard site folder (docs/DASHBOARD.md): the static app shell in backend/dashboard/ (copied as it is, never
 * generated), the data file, and two app icons drawn here as PNG (iOS "Add to Home Screen" wants a PNG touch icon).
 *
 *   <out>/index.html, manifest.webmanifest, icon.svg, _headers   copied from backend/dashboard/
 *   <out>/functions/api/run.js                                   copied (the Cloudflare Pages Function: Run buttons)
 *   <out>/data/dashboard.json                                    the data (dashboard/data.ts)
 *   <out>/apple-touch-icon.png (180 px), icon-512.png             drawn by iconPng
 *
 * Nothing here reads a secret or the network.
 */

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

/** The app shell folder, relative to backend/. */
export const APP_DIR = path.resolve(import.meta.dirname, '..', '..', 'dashboard');
/** The files copied from APP_DIR (paths relative to it). */
export const APP_FILES: readonly string[] = ['index.html', 'manifest.webmanifest', 'icon.svg', '_headers', 'functions/api/run.js'];
export const DATA_FILE = 'data/dashboard.json';

const crcTable = ((): Uint32Array => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) { let c = i; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[i] = c >>> 0; }
  return t;
})();
function crc32(buf: Uint8Array): number {
  let c = 0xffffffff;
  for (const b of buf) c = (crcTable[(c ^ b) & 0xff] as number) ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type: string, data: Uint8Array): Buffer {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), Buffer.from(data)]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}

/**
 * The app icon as a PNG: the accent blue square with three white rising bars (the Overview tab's glyph). Square
 * corners: iOS and Android round them.
 */
export function iconPng(size: number): Buffer {
  const bg = [0x24, 0x56, 0xc4], fg = [0xff, 0xff, 0xff];
  const u = size / 24; // the 24-unit grid of the tab icons: bars at x 5-8, 10.5-13.5, 16-19; heights 7, 11, 15 from y 19
  const bars: Array<[number, number, number]> = [[5, 8, 12], [10.5, 13.5, 8], [16, 19, 4]];
  const raw = Buffer.alloc((size * 3 + 1) * size);
  for (let y = 0; y < size; y++) {
    const row = y * (size * 3 + 1);
    raw[row] = 0;
    for (let x = 0; x < size; x++) {
      const gx = (x + 0.5) / u, gy = (y + 0.5) / u;
      const on = bars.some(([x0, x1, top]) => gx >= x0 && gx <= x1 && gy >= top && gy <= 19);
      const c = on ? fg : bg;
      raw[row + 1 + x * 3] = c[0] as number; raw[row + 2 + x * 3] = c[1] as number; raw[row + 3 + x * 3] = c[2] as number;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4); ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', new Uint8Array(0))]);
}

/** Writes the whole site into `outDir` (created; existing files overwritten). Returns the files written (relative). */
export function writeSite(outDir: string, dataJson: string, appDir: string = APP_DIR): string[] {
  const written: string[] = [];
  const put = (rel: string, body: string | Buffer): void => {
    const p = path.join(outDir, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, body);
    written.push(rel);
  };
  for (const f of APP_FILES) put(f, fs.readFileSync(path.join(appDir, f)));
  put(DATA_FILE, dataJson);
  put('apple-touch-icon.png', iconPng(180));
  put('icon-512.png', iconPng(512));
  return written;
}
