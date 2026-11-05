/**
 * HTML -> PDF with headless Chrome (installed on GitHub's runners; no npm package needed).
 * CHROME_PATH picks the browser; otherwise the usual names are tried in order.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';

const CANDIDATES = ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser', '/opt/pw-browsers/chromium'];

function onPath(name: string): string | null {
  if (name.includes('/')) return fs.existsSync(name) ? name : null;
  for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
    const p = path.join(dir, name);
    if (dir && fs.existsSync(p)) return p;
  }
  return null;
}

export function findChrome(env: Readonly<Record<string, string | undefined>> = process.env): string | null {
  if (env.CHROME_PATH) return fs.existsSync(env.CHROME_PATH) ? env.CHROME_PATH : null;
  for (const c of CANDIDATES) { const p = onPath(c); if (p) return p; }
  return null;
}

/** Writes `html` to a temporary file and prints it to `pdfPath`. Scripts (the chart) get up to 15 s. */
export async function htmlToPdf(html: string, pdfPath: string, chrome: string): Promise<void> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'report-'));
  const htmlPath = path.join(dir, 'report.html');
  fs.writeFileSync(htmlPath, html);
  try {
    await new Promise<void>((resolve, reject) => {
      execFile(chrome, [
        '--headless', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage', '--no-pdf-header-footer',
        '--virtual-time-budget=15000', '--user-data-dir=' + path.join(dir, 'profile'), '--print-to-pdf=' + path.resolve(pdfPath), 'file://' + htmlPath,
      ], { timeout: 120_000 }, (err, _out, stderr) => (err ? reject(new Error('Chrome could not make the PDF: ' + (stderr || err.message).slice(0, 500))) : resolve()));
    });
    if (!fs.existsSync(pdfPath) || fs.statSync(pdfPath).size === 0) throw new Error('Chrome made no PDF');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
