// Records one daily-OHLCV fixture into legacy/historical_data/<TICKER>.json in the same shape as the existing files.
// Usage: node scripts/recordFixture.mjs GBTC BTC FBTC BITB   (reads Yahoo's public chart endpoint; no API key)
import fs from 'node:fs';
const START = '2024-01-01';
for (const t of process.argv.slice(2)) {
  const p1 = Math.floor(Date.parse(START + 'T00:00:00Z') / 1000), p2 = Math.floor(Date.now() / 1000);
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${t}?interval=1d&period1=${p1}&period2=${p2}&includePrePost=false&events=div,splits`;
  const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
  if (!res.ok) { console.error(t, 'HTTP', res.status); process.exit(1); }
  const j = await res.json();
  const r = j.chart.result[0];
  const off = r.meta.gmtoffset ?? 0;
  const q = r.indicators.quote[0];
  const out = { ticker: t, fetchedAt: new Date().toISOString(), requestedStart: START, realFirstTradeDate: null, barCount: 0, dates: [], opens: [], highs: [], lows: [], closes: [], volumes: [] };
  r.timestamp.forEach((ts, i) => {
    if (q.close[i] == null || q.open[i] == null || q.high[i] == null || q.low[i] == null) return;
    out.dates.push(new Date((ts + off) * 1000).toISOString().slice(0, 10));
    out.opens.push(q.open[i]); out.highs.push(q.high[i]); out.lows.push(q.low[i]); out.closes.push(q.close[i]); out.volumes.push(q.volume[i] ?? 0);
  });
  out.barCount = out.dates.length;
  out.realFirstTradeDate = out.dates[0] ?? null;
  out.splits = Object.values(r.events?.splits ?? {}).map((s) => ({ date: s.date, numerator: s.numerator, denominator: s.denominator }));
  out.dividends = Object.values(r.events?.dividends ?? {});
  fs.writeFileSync(new URL(`../legacy/historical_data/${t}.json`, import.meta.url), JSON.stringify(out));
  console.log(t, out.barCount, 'bars', out.dates[0], '->', out.dates.at(-1), 'splits', out.splits.length);
}
