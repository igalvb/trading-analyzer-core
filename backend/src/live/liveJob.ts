/**
 * The nightly step 'live.dryRun' (phase 1, 1.6): after 'paper.trade', plans what the real $1,000 account WOULD trade
 * at the next open to match the followed paper account, checks the plan against every rail, appends it to 💵 Live Log
 * ('planned (dry run)' rows and the daily values row) and writes "💵 Live bot (dry run, $1,000): would SELL … / BUY …"
 * to the run log. Telegram gets ONE line only when the owner is needed (liveAttention: a fall alert, a refused plan,
 * a stale signal; notify/policy.ts). No broker, no server, no order is ever sent.
 *
 * The account followed: LIVE_FOLLOW_ACCOUNT, or by default ('auto') the best account of the fee report among those
 * that beat Hold QQQ and Hold the research list after fees and tax; none when no account does (a plain message says so).
 * A night is planned once: a re-run finds the day in the log and sends nothing. A stale signal (late or missing
 * Nightly) is refused and NOT logged, so a re-run after the paper test catches up can still plan the day.
 * Errors never reach the nightly: the step reports a plain degraded line instead.
 */

import type { TabStore, TabCell } from '../storage/tabStore.ts';
import type { FetchedChart } from '../types/chart.ts';
import { loadPaper, seriesFromChart } from '../paper/paperJob.ts';
import { appendNight } from '../paper/paperLog.ts';
import type { TelegramDeps } from '../notify/telegram.ts';
import { notifyIfNeeded } from '../notify/policy.ts';
import type { LiveConfig } from './liveConfig.ts';
import { lastClosedTradingDay } from './marketCalendar.ts';
import { supportOf, targetWeights } from './target.ts';
import { fileAccountSource, shadowAccount, accountingOf, fallAlerts, type RealAccount, type RealAccountSource } from './account.ts';
import { planTrades, type Plan } from './planner.ts';
import { checkRails, freshnessRail, type RailResult } from './rails.ts';
import { LIVE_LOG_TAB, LIVE_LOG_HEADER, LIVE_LOG_COLS, DAILY_VALUES, compareWithPaper, liveFall, liveLogRows } from './liveLog.ts';
import { buildFeeReport, feeReportSection, type ResearchFeeTable } from './feeReport.ts';
import { RESEARCH_FEES } from './researchFees.ts';
import { LABELS } from '../profile/labels.ts';

export interface LiveJobDeps {
  readonly store: TabStore;
  readonly timeZone: string;
  readonly fetchChart: (t: string) => Promise<FetchedChart | null>;
  readonly log: (m: string) => void;
  /** Fix 2026-11-07: the night's report text, always INFO (its ✅ / ❌ marks rate a strategy, they are not failures). Default `log`. */
  readonly logReport?: (m: string) => void;
  readonly config: LiveConfig;
  /** Tests: the clock. */
  readonly now?: () => number;
  readonly telegram?: { readonly deps: TelegramDeps; readonly chatId: string } | null;
  /** The real account; default: LIVE_ACCOUNT_FILE, else the dry run's own record in the log. */
  readonly account?: RealAccountSource | null;
  /** The stored research run of the fee report; default researchFees.ts. */
  readonly research?: ResearchFeeTable | null;
}

export interface LiveNight {
  readonly day: string | null;
  readonly account: string | null;
  readonly plan: Plan | null;
  readonly rails: RailResult | null;
  /** Rows appended to the log tonight (0 = the day was already there, or nothing to log). */
  readonly logged: number;
  /** The full night's text (the run log), or null for an already planned day. Telegram gets liveAttention only. */
  readonly message: string | null;
  /** Tonight's fall alerts (account.ts fallAlerts); empty or absent = none. */
  readonly alerts?: readonly string[];
  readonly outcome: string;
}

const usd = (v: number | null): string => (v == null ? '—' : (v < 0 ? '-$' : '$') + Math.abs(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
const qtyTxt = (q: number): string => String(Math.round(q * 10_000) / 10_000);

/** "would SELL … / BUY …" with the rails and drift. */
export function planLine(plan: Plan, rails: RailResult): string {
  const list = (side: 'BUY' | 'SELL'): string => plan.orders.filter((o) => o.side === side).map((o) => qtyTxt(o.qty) + ' ' + o.ticker + ' (' + usd(o.value) + ')').join(', ');
  const sells = list('SELL'), buys = list('BUY');
  const what = !plan.orders.length ? 'would trade nothing (already matches the twin)' : 'would ' + [sells ? 'SELL ' + sells : '', buys ? 'BUY ' + buys : ''].filter(Boolean).join(' / ');
  const railTxt = rails.planRefusals.length ? 'REFUSED: ' + rails.planRefusals.join('; ')
    : rails.orderRefusals.length ? 'rails refused ' + rails.orderRefusals.map((r) => r.ticker + ' (' + r.why + ')').join(', ') : 'rails OK';
  const big = [...plan.drift].sort((x, y) => Math.abs(y.afterPct - y.targetPct) - Math.abs(x.afterPct - x.targetPct))[0];
  const drift = 'drift after the plan ' + plan.driftPct.toFixed(1) + '% of the account' + (big && Math.abs(big.afterPct - big.targetPct) >= 0.05 ? ' (biggest ' + big.ticker + ' ' + (big.afterPct - big.targetPct >= 0 ? '+' : '') + (big.afterPct - big.targetPct).toFixed(1) + ' pts)' : '');
  return what + ' — ' + railTxt + '; ' + drift;
}

/** Tonight's closes of `tickers` on `day` and the day each price is from (null = no price). */
async function pricesOn(d: LiveJobDeps, tickers: readonly string[], day: string): Promise<{ close: Map<string, number>; days: Map<string, string | null> }> {
  const close = new Map<string, number>(), days = new Map<string, string | null>();
  for (const t of tickers) {
    const c = await d.fetchChart(t).catch((e: unknown) => { d.log('⚠️ live bot: ' + t + ' chart fetch failed (no price tonight): ' + String(e)); return null; });
    if (!c || !c.dates.length) { days.set(t, null); continue; }
    const s = seriesFromChart(t, c, d.timeZone);
    const i = s.dates.lastIndexOf(day);
    if (i >= 0 && (s.closes[i] as number) > 0) { close.set(t, s.closes[i] as number); days.set(t, day); } else days.set(t, s.dates[s.dates.length - 1] ?? null);
  }
  return { close, days };
}

/** Plans one night and writes the log; does not send. */
export async function planLiveNight(d: LiveJobDeps): Promise<LiveNight> {
  const cfg = d.config;
  const head = '💵 Live bot (dry run, ' + usd(cfg.startValue).replace('.00', '') + ')';
  const stored = await loadPaper(d.store);
  if (!stored?.state.lastDay) return { day: null, account: null, plan: null, rails: null, logged: 0, message: null, outcome: 'Live bot (dry run): no paper test saved yet; nothing to plan.' };
  const state = stored.state, day = state.lastDay!;
  const report = buildFeeReport(stored, d.research === undefined ? RESEARCH_FEES : d.research, cfg);
  const feeLines = feeReportSection(report);
  const logRows = ((await d.store.read(LIVE_LOG_TAB, LIVE_LOG_COLS)) ?? []).slice(1);
  const blank = (why: string): TabCell[] => [day, 'no account (dry run)', '', '', '', '', '', '', why, '', '', '', ...Array.from({ length: LIVE_LOG_COLS - 12 }, () => '')];

  // 1. which paper account
  let id: string | null = null, why = '';
  if (cfg.follow === 'none') why = 'LIVE_FOLLOW_ACCOUNT is "none": no account is followed.';
  else if (cfg.follow === 'auto') { id = report.best; if (!id) why = report.line; }
  else { const s = supportOf(cfg.follow); if (s.ok) id = cfg.follow; else why = 'LIVE_FOLLOW_ACCOUNT "' + cfg.follow + '" cannot be followed: ' + s.why + '.'; }
  if (!id) {
    const logged = await appendNight(d.store, LIVE_LOG_TAB, LIVE_LOG_HEADER, day, [blank(why)]);
    return { day, account: null, plan: null, rails: null, logged, message: logged ? [head + ' — ' + day, why, '', ...feeLines].join('\n') : null, outcome: 'Live bot (dry run) ' + day + ': ' + why };
  }
  const sup = supportOf(id);
  const label = sup.ok ? sup.setup.label : id;

  // 2. the real account (phase 1: a fake)
  // The live start: the first night with a values row (a night with no account followed does not count).
  const startDay = String(logRows.find((r) => String(r[1]) === DAILY_VALUES)?.[0] ?? day);
  const src: RealAccountSource = d.account ?? (cfg.accountFile ? fileAccountSource(cfg.accountFile)
    : { name: 'the dry run\'s own record', read: async () => shadowAccount(logRows.filter((r) => String(r[0]) < day), { day: startDay, value: cfg.startValue }) });
  const acct: RealAccount = await src.read();

  // 3. tonight's prices: the twin's holdings and buys, QQQ, and what the real account holds
  const a = state.lab?.accounts[id];
  const tickers = [...new Set([...Object.keys(a?.pos ?? {}), ...(a?.toBuy ?? []), 'QQQ', ...acct.positions.map((p) => p.ticker)])].sort();
  const px = await pricesOn(d, tickers, day);
  const closeOf = (t: string): number | null => px.close.get(t) ?? null;

  // 4. target, plan, rails
  const tr = targetWeights(state, id, closeOf, cfg.targetMode);
  if (!tr.ok) {
    const logged = await appendNight(d.store, LIVE_LOG_TAB, LIVE_LOG_HEADER, day, [blank(label + ': ' + tr.why)]);
    return { day, account: id, plan: null, rails: null, logged, message: logged ? [head + ' — ' + day, 'Following ' + label + ': ' + tr.why + '.', '', ...feeLines].join('\n') : null, outcome: 'Live bot (dry run) ' + day + ': ' + tr.why };
  }
  const plan = planTrades(tr.target, acct, closeOf, cfg);
  const held = new Map<string, number>(), heldCalls = new Map<string, number>();
  for (const p of acct.positions) (p.kind === 'call' ? heldCalls : held).set(p.ticker, ((p.kind === 'call' ? heldCalls : held).get(p.ticker) ?? 0) + p.shares);
  const priceDays = new Map([...px.days].filter(([t]) => (tr.target.weights[t] ?? 0) > 0 || held.has(t) || plan.orders.some((o) => o.ticker === t)));
  const lastTradingDay = lastClosedTradingDay((d.now ?? Date.now)());
  const rails = checkRails({
    orders: plan.orders, held, heldCalls, slots: plan.slots, accountValue: plan.accountValue, settledCash: acct.settledCash, maxOrders: cfg.maxOrders, capSlack: cfg.capSlack,
    halted: cfg.halted || acct.halted === true, decisionDay: day, lastTradingDay, priceDays,
  });

  // 5. values after tax, on the same basis as the paper test
  const acc = accountingOf(acct, closeOf, day.slice(0, 4));
  const cmp = compareWithPaper(state, id, acct.start);
  const fall = liveFall(logRows.filter((r) => String(r[0]) < day), acc.valueAfterTax, acct.start.value);
  const stale = freshnessRail({ decisionDay: day, lastTradingDay, priceDays }) != null;
  const logged = stale ? 0 : await appendNight(d.store, LIVE_LOG_TAB, LIVE_LOG_HEADER, day, liveLogRows(day, plan, rails, acc, cmp, fall, id));
  const alerts = fallAlerts(acc.value, acct.start.value, cfg.alertFalls);
  const message = stale || logged ? [
    head + ' — ' + day + ', following ' + label,
    planLine(plan, rails),
    ...(plan.skipped.length ? ['Skipped: ' + plan.skipped.map((s) => s.ticker + ' ' + s.side + ' ' + usd(s.value) + ' (' + s.why + ')').join(', ')] : []),
    'Value ' + usd(acc.value) + ' · tax owed this year ' + usd(acc.taxOwed) + ' · after tax ' + usd(acc.valueAfterTax) + (acc.moneyAddedForTax ? ' (after ' + usd(acc.moneyAddedForTax) + ' added for tax)' : ''),
    'Twin ' + usd(cmp.twin) + ' · 📊 Hold QQQ ' + usd(cmp.qqq) + ' · 📊 ' + LABELS.holdList + ' ' + usd(cmp.list14) + ' (all after tax; deepest falls: live -' + fall.toFixed(1) + '%, twin -' + cmp.twinFall.toFixed(1) + '%, QQQ -' + cmp.qqqFall.toFixed(1) + '%, ' + LABELS.list + ' -' + cmp.list14Fall.toFixed(1) + '%)',
    ...alerts, '', ...feeLines, '', 'Dry run: no broker is connected; nothing was sent. Account: ' + src.name + '.',
  ].join('\n') : null;
  const outcome = 'Live bot (dry run) ' + day + ', ' + id + ': ' + (stale ? 'refused (stale signal), not logged' : logged ? plan.orders.length + ' order(s) planned, ' + (rails.ok ? 'rails OK' : 'rails refused some') : 'already planned');
  return { day, account: id, plan, rails, logged, message, outcome, alerts };
}

/**
 * The ONE line the owner needs from tonight's dry run, or null (clean policy, notify/policy.ts): a fall past an alert
 * level, a plan the rails refused, or a stale signal. A normal night (plan logged, rails OK) sends nothing.
 */
export function liveAttention(n: LiveNight, alerts: readonly string[] = []): string | null {
  if (!n.day) return null;
  if (alerts.length) return '💵 Live bot ' + n.day + ': ' + alerts.join(' ');
  if (n.outcome.includes('refused (stale signal)')) return '💵 Live bot ' + n.day + ': the signal is stale (late or missing Nightly); nothing was planned.';
  if (n.rails && n.rails.planRefusals.length) return '💵 Live bot ' + n.day + ': the rails REFUSED the plan: ' + n.rails.planRefusals.join('; ');
  return null;
}

/** One night: plan and log; the full text goes to the run log, Telegram gets one line only when needed (liveAttention). */
export async function runLiveDryRun(d: LiveJobDeps): Promise<string> {
  const n = await planLiveNight(d);
  // Fix 2026-11-06: one line at a time, so each line gets its own level (the whole text was one ERROR line when any
  // single line carried a failure mark, e.g. a ❌ next to one stock).
  const report = d.logReport ?? d.log;
  if (n.message) for (const line of n.message.split('\n')) if (line.trim()) report(line);
  if (d.telegram && n.message) await notifyIfNeeded(d.telegram, liveAttention(n, n.alerts ?? []), (m) => d.log('live bot: ' + m));
  return n.outcome;
}
