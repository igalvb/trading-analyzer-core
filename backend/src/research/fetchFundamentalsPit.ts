/**
 * `node src/research/fetchFundamentalsPit.ts <outDir>` (James — Quality Gate, plan 10 section 5): downloads the SEC
 * XBRL company facts of RESEARCH_UNIVERSE (the research list included; QQQ, SPY and ^VIX skipped) and saves one
 * `<TICKER>.facts.json` per company (only the concepts the gate reads, every value with its filing date), for the
 * history test (`qualityGateCli.ts --facts=<outDir>`). Needs SEC_CONTACT_EMAIL (SEC blocks anonymous traffic) and a
 * network that reaches data.sec.gov (the research sandbox does not: its proxy answers 403; run it where the price
 * download runs and save the files next to the prices).
 */

import fs from 'node:fs';
import path from 'node:path';
import { HttpClient, LiveTransport } from '../net/http.ts';
import { secUserAgentsFromEnv, fetchSecEdgarCIK } from '../fetch/sec/edgar.ts';
import { fetchCompanyFacts } from '../fetch/sec/companyFacts.ts';
import { RESEARCH_UNIVERSE } from './fetchPrices.ts';
import { MemoryPropertyStore } from '../storage/kv.ts';

const SKIP = new Set(['QQQ', 'SPY', '^VIX']);

async function main(): Promise<void> {
  const outDir = process.argv[2];
  if (!outDir) throw new Error('usage: fetchFundamentalsPit.ts <outDir>');
  fs.mkdirSync(outDir, { recursive: true });
  const http = new HttpClient({ transport: new LiveTransport(), userAgentByHost: secUserAgentsFromEnv() });
  const kv = new MemoryPropertyStore();
  for (const t of RESEARCH_UNIVERSE.filter((x) => !SKIP.has(x))) {
    const cik = await fetchSecEdgarCIK({ http, kv }, t);
    const facts = cik ? await fetchCompanyFacts({ http }, cik) : null;
    process.stderr.write(t + ': ' + (facts ? Object.keys(facts).length + ' concepts' : 'NOT FETCHED') + '\n');
    if (facts) fs.writeFileSync(path.join(outDir, t + '.facts.json'), JSON.stringify({ ticker: t, cik, fetchedAt: new Date().toISOString(), facts }));
    await new Promise((r) => setTimeout(r, 250)); // SEC fair access: well under 10 requests a second
  }
}

if (import.meta.url === `file://${process.argv[1]}`) main().catch((e) => { process.stderr.write(String(e) + '\n'); process.exit(1); });
