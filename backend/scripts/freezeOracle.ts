/**
 * Writes legacy/checksums.json, locking the oracle.
 *
 * Run ONCE, after the .gs files are copied into legacy/ and after the four
 * API keys have been replaced with placeholders. From then on
 * oracle.test.ts asserts against this manifest, so any later edit to a
 * legacy file fails the suite loudly instead of silently invalidating every
 * parity number in the project.
 */

import fs from 'node:fs';
import { computeChecksums, MANIFEST_PATH, ORACLE_FILES, legacyFilesPresent, LEGACY_DIR } from '../test/oracle.ts';

if (!legacyFilesPresent()) {
  console.error(`legacy/ is not fully populated (looked in ${LEGACY_DIR}).`);
  console.error(`Expected all of: ${ORACLE_FILES.join(', ')}`);
  process.exit(1);
}

const src = fs.readFileSync(`${LEGACY_DIR}/fullStockAnalysisV10_9.gs`, 'utf8');
const unsafe = src
  .split('\n')
  .filter((l) => /^const (FMP_API_KEY|ALPHAVANTAGE_KEY|FINNHUB_KEY|GEMINI_API_KEY)\s*=/.test(l))
  .filter((l) => !(/=\s*'([^']*)'/.exec(l)?.[1] ?? '').toUpperCase().includes('PLACEHOLDER'));

if (unsafe.length > 0) {
  console.error('REFUSING TO FREEZE: real-looking API keys are still present in legacy/.');
  for (const l of unsafe) console.error(`  ${l.split('=')[0]?.trim()}`);
  console.error('Replace the values at fullStockAnalysisV10_9.gs:5311-5314 with placeholders first.');
  process.exit(1);
}

const checksums = computeChecksums();
fs.writeFileSync(MANIFEST_PATH, `${JSON.stringify(checksums, null, 2)}\n`);

console.log(`Froze ${ORACLE_FILES.length} oracle files -> ${MANIFEST_PATH}`);
for (const [file, hash] of Object.entries(checksums)) {
  console.log(`  ${file.padEnd(34)} ${hash.slice(0, 16)}…`);
}
