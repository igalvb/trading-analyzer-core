/**
 * The paper test's daily report (owner 2026-10-28): every night, one file to Telegram with
 *   1. the standings: every account and yardstick, best first, with its value, return, gap to QQQ, deepest fall,
 *      cash and number of positions;
 *   2. every account's bag: each holding with its size, price, value, share of the account and gain.
 * Values are before the tax on what is still held in the bag lines, after it in the standings (as everywhere).
 */

import { htmlEsc } from '../reports/pdf/workbookHtml.ts';
import { STRATEGIES, STRATEGY_LABEL, standings, pctOf, PAPER_CASH, type PaperState } from './paperTrading.ts';
import { LAB_SETUPS, LAB_LABEL, LILO_ID, ALL_ID, ALL_SHARES, ALL_LEAPS_ID, JAMES_IDS, JAMES_LILO_V2_ID, JAMES_GROUP, JAMES_MR_ID, JAMES_CYCLE_ID, JAMES_CYCLE_BTC_ID, JAMES_MM_ID, JAMES_LEAPS_IDS, JAMES_LEAPS_GROUP, OPTIONS_OFF_SETUPS, labAccount, leapsId } from './paperLab.ts';
import { CONTRACT } from './paperLeaps.ts';
import { CLAUDE_ID, CLAUDE_LABEL, CLAUDE_GROUP } from './paperClaude.ts';
import { EXIT_TAX_PCT } from '../portfolio/exitTax.ts';

export interface BagLine { readonly name: string; readonly qty: number; readonly unit: string; readonly price: number | null; readonly value: number; readonly cost: number }
export interface Bag { readonly id: string; readonly name: string; readonly group: string; readonly cash: number; readonly lines: readonly BagLine[] }

const contractName = (h: { ticker: string; strike: number; expUnix: number }): string => h.ticker + ' $' + h.strike + ' call ' + new Date(h.expUnix * 1000).toISOString().slice(0, 10);

/** Every account's holdings tonight. */
export function bagsOf(state: PaperState, closeOf: (t: string) => number | null): Bag[] {
  const stock = (t: string, shares: number, cost: number): BagLine => {
    const px = closeOf(t);
    return { name: t, qty: shares, unit: 'shares', price: px, value: shares * (px ?? cost / shares), cost };
  };
  const out: Bag[] = [];
  for (const id of STRATEGIES) {
    const a = state.accounts[id];
    const lines = Object.entries(a.lots).map(([t, lots]) => stock(t, lots.reduce((s, l) => s + l.shares, 0), lots.reduce((s, l) => s + l.shares * l.price, 0))).filter((l) => l.qty > 0);
    out.push({ id, name: STRATEGY_LABEL[id], group: 'A original', cash: a.cash, lines });
  }
  const lab = state.lab;
  if (!lab) return out;
  const stockBag = (id: string): { cash: number; lines: BagLine[] } => {
    const a = labAccount(lab, id);
    return a ? { cash: a.cash, lines: Object.entries(a.pos).map(([t, p]) => stock(t, p.shares, p.cost)) } : { cash: 0, lines: [] };
  };
  const leapsBag = (id: string): { cash: number; lines: BagLine[] } => {
    const a = lab.leaps?.[id];
    if (!a) return { cash: 0, lines: [] };
    return {
      cash: a.cash,
      lines: [...a.held.map((h) => ({ name: contractName(h), qty: h.contracts, unit: 'contracts', price: h.mid, value: h.contracts * h.mid * CONTRACT, cost: h.cost })),
        ...(a.qqq.shares ? [stock('QQQ', a.qqq.shares, a.qqq.cost)] : [])],
    };
  };
  for (const st of LAB_SETUPS) { const b = stockBag(st.id); out.push({ id: st.id, name: st.label, group: 'B your list', ...b }); }
  for (const st of OPTIONS_OFF_SETUPS) if (lab.accounts[st.id]) out.push({ id: st.id, name: st.label, group: 'B your list', ...stockBag(st.id) });
  if (lab.lilo) {
    const k = lab.lilo;
    const lines = [...Object.entries(k.lines).filter(([, l]) => l.shares > 0).map(([t, l]) => stock(t, l.shares, l.cost)), ...(k.qqq.shares ? [stock('QQQ', k.qqq.shares, k.qqq.cost)] : [])];
    out.push({ id: LILO_ID, name: LAB_LABEL[LILO_ID] as string, group: 'B your list', cash: k.cash, lines });
  }
  for (const st of LAB_SETUPS) { const b = leapsBag(leapsId(st.id)); out.push({ id: leapsId(st.id), name: LAB_LABEL[leapsId(st.id)] as string, group: 'C LEAPS', ...b }); }
  const s = stockBag(ALL_SHARES.id), l = leapsBag(ALL_LEAPS_ID);
  out.push({ id: ALL_ID, name: LAB_LABEL[ALL_ID] as string, group: 'D everything', cash: s.cash + (lab.leaps?.[ALL_LEAPS_ID] ? l.cash : (ALL_SHARES.cash as number)), lines: [...s.lines, ...l.lines] });
  // James's models (phase 1)
  for (const id of JAMES_IDS) {
    if (id === JAMES_LILO_V2_ID) {
      const k = lab.liloV2;
      if (!k) continue;
      out.push({ id, name: LAB_LABEL[id] as string, group: JAMES_GROUP, cash: k.cash, lines: [...Object.entries(k.lines).filter(([, x]) => x.shares > 0).map(([t, x]) => stock(t, x.shares, x.cost)), ...(k.qqq.shares ? [stock('QQQ', k.qqq.shares, k.qqq.cost)] : [])] });
    } else if (id === JAMES_CYCLE_ID || id === JAMES_CYCLE_BTC_ID || id === JAMES_MM_ID) {
      // phase 3: the cycle book, the BTC sleeve book, the Market Maker signal book
      const lines: BagLine[] = [];
      if (id === JAMES_CYCLE_ID && lab.cycle) {
        const k = lab.cycle;
        for (const [t, x] of Object.entries(k.pos)) lines.push(stock(t, x.shares, x.cost));
        if (k.qqq.shares) lines.push(stock('QQQ', k.qqq.shares, k.qqq.cost));
        out.push({ id, name: LAB_LABEL[id] as string, group: JAMES_GROUP, cash: k.cash, lines });
      } else if (id === JAMES_CYCLE_BTC_ID && lab.cycleBtc) {
        const k = lab.cycleBtc;
        for (const [t, x] of Object.entries(k.core)) if (x.shares) lines.push(stock(t, x.shares, x.cost));
        if (k.sleeve.shares) lines.push(stock('IBIT', k.sleeve.shares, k.sleeve.cost));
        out.push({ id, name: LAB_LABEL[id] as string, group: JAMES_GROUP, cash: k.cash, lines });
      } else if (id === JAMES_MM_ID && lab.marketMaker) {
        const k = lab.marketMaker;
        for (const [t, x] of Object.entries(k.pos)) lines.push(stock(t, x.shares, x.cost));
        if (k.qqq.shares) lines.push(stock('QQQ', k.qqq.shares, k.qqq.cost));
        out.push({ id, name: LAB_LABEL[id] as string, group: JAMES_GROUP, cash: k.cash, lines });
      }
    } else if (id === JAMES_MR_ID || lab.pair?.[id] || lab.winners?.[id]) {
      // phase 2: the signal book, the pair book, the winners books
      const k = id === JAMES_MR_ID ? lab.meanRev : lab.pair?.[id] ?? lab.winners?.[id];
      if (!k) continue;
      const lines: BagLine[] = [];
      if ('pos' in k) { for (const [t, x] of Object.entries(k.pos)) lines.push(stock(t, x.shares, x.cost)); if (k.qqq.shares) lines.push(stock('QQQ', k.qqq.shares, k.qqq.cost)); }
      else { if (k.hold && k.pot.shares) lines.push(stock(k.hold, k.pot.shares, k.pot.cost)); for (const [t, x] of Object.entries(k.core)) if (x.shares) lines.push(stock(t, x.shares, x.cost)); }
      out.push({ id, name: LAB_LABEL[id] as string, group: JAMES_GROUP, cash: k.cash, lines });
    } else if (labAccount(lab, id)) out.push({ id, name: LAB_LABEL[id] as string, group: JAMES_GROUP, ...stockBag(id) });
  }
  // James's models, phase 4: James — LEAPS (calls, the shares an exercise gave, QQQ)
  for (const id of JAMES_LEAPS_IDS) {
    const a = lab.leaps?.[id];
    if (!a) continue;
    const b = leapsBag(id);
    out.push({ id, name: LAB_LABEL[id] as string, group: JAMES_LEAPS_GROUP, cash: b.cash, lines: [...b.lines, ...Object.entries(a.shares ?? {}).map(([t, p]) => stock(t, p.shares, p.cost))] });
  }
  // 🤖 Claude, free choice (from its first fill): shares at tonight's close, calls at the last middle of bid and ask
  const c = lab.claude;
  if (c?.joined) {
    out.push({ id: CLAUDE_ID, name: CLAUDE_LABEL, group: CLAUDE_GROUP, cash: c.cash, lines: Object.entries(c.pos).map(([n, p]) => p.kind === 'stock'
      ? { ...stock(p.ticker, p.qty, p.cost), ...(closeOf(p.ticker) == null && p.mark != null ? { price: p.mark, value: p.qty * p.mark } : {}) }
      : { name: n, qty: p.qty, unit: 'contracts', price: p.mark, value: p.qty * CONTRACT * (p.mark ?? p.cost / p.qty / CONTRACT), cost: p.cost }) });
  }
  return out;
}

const money = (v: number): string => (v < 0 ? '-' : '') + '$' + Math.round(Math.abs(v)).toLocaleString('en-US');
const pts = (v: number): string => (v >= 0 ? '+' : '') + v.toFixed(1);

/** The report as one HTML page (printed to PDF, or sent as it is). */
export function dailyReportHtml(state: PaperState, closeOf: (t: string) => number | null): string {
  const day = state.lastDay ?? '';
  const st = standings(state);
  const q = st.find((r) => r.name === 'Hold QQQ');
  const qPct = q ? (q.value / PAPER_CASH - 1) * 100 : 0;
  const bags = new Map(bagsOf(state, closeOf).map((b) => [b.name, b]));
  const head = `<style>body{font-family:Arial,Helvetica,sans-serif;font-size:11px;color:#111;margin:18px}h1{font-size:18px;margin:0 0 4px}h2{font-size:14px;margin:18px 0 6px}
table{border-collapse:collapse;width:100%;margin-bottom:8px}th,td{border:1px solid #ccc;padding:3px 5px;text-align:right}th{background:#eef2f7}td.l,th.l{text-align:left}
tr.bench td{background:#fff7d6;font-weight:bold}.up{color:#0a7a2f}.down{color:#b3261e}.small{color:#555}.bag{page-break-inside:avoid}</style>`;
  const cls = (v: number): string => (v >= 0 ? 'up' : 'down');
  const rows = st.map((r, i) => {
    const b = bags.get(r.name);
    const ret = (r.value / PAPER_CASH - 1) * 100;
    return `<tr class="${r.bench ? 'bench' : ''}"><td>${i + 1}</td><td class="l">${r.bench ? '📊 ' : ''}${htmlEsc(r.name)}</td><td class="l">${htmlEsc(b?.group ?? 'yardstick')}</td>`
      + `<td>${money(r.value)}</td><td class="${cls(ret)}">${pctOf(r.value)}</td><td class="${cls(ret - qPct)}">${r.name === 'Hold QQQ' ? '—' : pts(ret - qPct)}</td>`
      + `<td>${r.maxDrawdownPct >= 0.05 ? '-' + r.maxDrawdownPct.toFixed(1) + '%' : '0%'}</td><td>${b ? money(b.cash) : '—'}</td><td>${r.positions}</td></tr>`;
  }).join('');
  const bagHtml = [...bags.values()].map((b) => {
    const total = b.cash + b.lines.reduce((s, l) => s + l.value, 0);
    const lines = [...b.lines].sort((x, y) => y.value - x.value).map((l) => {
      const g = l.cost > 0 ? (l.value / l.cost - 1) * 100 : 0;
      return `<tr><td class="l">${htmlEsc(l.name)}</td><td>${l.qty.toLocaleString('en-US')} ${l.unit}</td><td>${l.price != null ? '$' + l.price.toFixed(2) : '—'}</td><td>${money(l.value)}</td><td>${total > 0 ? ((l.value / total) * 100).toFixed(1) + '%' : ''}</td><td class="${cls(g)}">${(g >= 0 ? '+' : '') + g.toFixed(1)}%</td></tr>`;
    }).join('');
    return `<div class="bag"><h2>${htmlEsc(b.name)} <span class="small">(${htmlEsc(b.group)}) — ${money(total)} before tax</span></h2>`
      + `<table><tr><th class="l">Holding</th><th>Size</th><th>Price</th><th>Value</th><th>Of the account</th><th>Gain</th></tr>${lines}`
      + `<tr><td class="l">Cash</td><td></td><td></td><td>${money(b.cash)}</td><td>${total > 0 ? ((b.cash / total) * 100).toFixed(1) + '%' : ''}</td><td></td></tr></table></div>`;
  }).join('');
  return `<!doctype html><html><head><meta charset="utf-8"><title>Paper test ${htmlEsc(day)}</title>${head}</head><body>`
    + `<h1>📝 Paper test — ${htmlEsc(day)}</h1><div class="small">$100,000 per account from ${htmlEsc(state.start)} to ${htmlEsc(state.end)}. Decided at each close, traded at the next open, ${EXIT_TAX_PCT} tax on gains. Standings are after the tax on what is still held. 📊 = what we compare against.</div>`
    + `<h2>Standings</h2><table><tr><th>#</th><th class="l">Account</th><th class="l">Group</th><th>Value</th><th>Return</th><th>vs QQQ (points)</th><th>Deepest fall</th><th>Cash</th><th>Positions</th></tr>${rows}</table>`
    + `<h2>What each account holds</h2>${bagHtml}</body></html>`;
}

/** The short Telegram message that goes with the file. */
export function dailyMessage(state: PaperState): string {
  const st = standings(state);
  const top = st.filter((r) => !r.bench).slice(0, 5);
  const bench = st.filter((r) => r.bench && (r.key === 'qqq' || r.key === 'lab.list14'));
  return ['📝 Paper test — ' + state.lastDay, '', 'Top 5:', ...top.map((r, i) => (i + 1) + '. ' + r.name + ': ' + pctOf(r.value) + ' (' + money(r.value) + ')'),
    '', ...bench.map((r) => '📊 ' + r.name + ': ' + pctOf(r.value) + ' (' + money(r.value) + ')'), '', 'Full standings and every account\'s holdings in the file.'].join('\n');
}

