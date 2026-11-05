/**
 * GENERIC_PLAN P1: the per-user profile (§3b). Everything that ties a run to ONE user and is not a secret: their
 * lists, paper test dates, tax rate, labels, protected tabs, features, live bot settings. Keys, sheet IDs and chat
 * IDs are never here (they are per-user secrets), and neither are the long-only rails: no key of the schema can
 * allow puts, shorts, writing calls or margin (guard rule R8, test/genericGuard.test.ts).
 *
 * P1: nothing reads the profile yet. P2 moves the constants (paper/paperLab.ts, paper/paperTrading.ts, ...) onto it.
 *
 * Input: a plain JSON object (PROFILE_JSON, PROFILE_FILE, or the `⚙️ Profile` tab's key/value rows, profile/load.ts).
 * Unknown keys are refused, so a typo never passes silently. `tax.rate` is required: there is no default.
 */

export const PROFILE_VERSION = 1;

export interface PickerLists {
  /** The stock menu dialog (jobs/automation/tickerRuns.ts), without the trailing OTHER. */
  readonly stockMenu: readonly string[];
  /** The run dialog (reports/options/ui.ts), without OTHER. */
  readonly runDialog: readonly string[];
  /** The recommended-call dialog (reports/options/ui.ts), without OTHER. */
  readonly callDialog: readonly string[];
}

export interface LiveProfile {
  /** The paper account to follow: 'auto', 'none' or an account id (live/liveConfig.ts LIVE_FOLLOW_ACCOUNT). */
  readonly follow: string;
  readonly startValue: number;
  readonly fractional: boolean;
  readonly minTrade: number;
  readonly maxOrders: number;
  readonly capSlack: number;
  readonly targetMode: 'mirror' | 'equal';
  readonly alertFalls: readonly number[];
  /** The tickers the bot may buy (live/rails.ts ALLOW_LIST). The long-only rails are NOT here: they are engine. */
  readonly allowList: readonly string[];
}

export interface Profile {
  readonly version: number;
  readonly user: { readonly id: string; readonly timeZone: string };
  readonly lists: {
    /** The user's list (1-30 tickers). Its first ticker is the default ticker (charts, dialogs). */
    readonly core: readonly string[];
    /** The list the research was run on (owner: the first 14). Default = core. */
    readonly researchCore: readonly string[];
    readonly pickers: PickerLists;
    /** Seeds a brand-new Watchlist tab only. Default empty. */
    readonly watchlistSeed: readonly string[];
  };
  readonly paper: {
    /** YYYY-MM-DD; null = the first night the paper test runs (P2 resolves it). */
    readonly start: string | null;
    readonly end: string | null;
    readonly fixedUniverse: readonly string[];
  };
  readonly research: {
    readonly testAUniverse: readonly string[];
    /** The stock universe the research and its random bags draw from (research/fetchPrices.ts RESEARCH_UNIVERSE). */
    readonly universe: readonly string[];
    /** Extra price history downloaded with the research set but never drawn into a bag (fetchPrices.ts JAMES_EXTRA_TICKERS). */
    readonly extraTickers: readonly string[];
  };
  readonly models: { readonly pairs: ReadonlyArray<readonly [string, string]> };
  readonly tax: { readonly rate: number };
  readonly benchmarks: { readonly index: string };
  readonly labels: {
    /** How the reports name the list (the owner keeps today's words); "your list" for a new user. */
    readonly listName: string;
    /** The yardstick row of holding the research list equally (paper key lab.list14). */
    readonly holdResearchCore: string;
    /** The yardstick row of holding the whole list equally (paper key lab.list). */
    readonly holdCore: string;
    /** How the research CLIs name the research list in their tables (GENERIC_PLAN P3). Default = listName. */
    readonly researchName: string;
  };
  readonly sheets: {
    /** Personal tabs the robot never writes or deletes. */
    readonly protectedTabs: readonly string[];
    readonly portfolio: {
      /** Header name -> other accepted spellings (the first name wins when both exist). */
      readonly headerAliases: Readonly<Record<string, readonly string[]>>;
      /** The open-options table ends at a ticker cell equal to one of `exact` or containing one of `contains`. */
      readonly endMarkers: { readonly exact: readonly string[]; readonly contains: readonly string[] };
      /**
       * YYYY-MM-DD: a STOCK row with no usable purchase date is read as bought on this day (sheets/readers/portfolio.ts,
       * row 36). Default 2020-01-01 (the stock table has no purchase-date column: "bought over years and held long").
       */
      readonly assumedPurchaseDate: string;
    };
  };
  readonly features: { readonly paper: boolean; readonly liveBot: boolean; readonly myOptions: boolean; readonly ai: boolean };
  /**
   * Owner 2026-11-05: `weeklyStops` = the Exit report decides from the weekly chart and the owner's exit rules (stale
   * daily breach is an old signal, weekly chandelier stop, EXIT only on a large expected fall net of tax, coherent
   * targets, trims only at +25% after tax). Default false (built OFF; switched on after the owner sees the table).
   */
  readonly exit: { readonly weeklyStops: boolean };
  /** Absent = no live bot (the default for every user but the owner, open question Q5). */
  readonly live: LiveProfile | null;
  /** The results pack name (P4); null = "no history for your list yet". */
  readonly results: string | null;
}

/** Every key the input may carry (dotted). Guard R8 checks this list; validation refuses any other key. */
export const PROFILE_KEYS: readonly string[] = [
  'version',
  'user.id', 'user.timeZone',
  'lists.core', 'lists.researchCore', 'lists.pickers.stockMenu', 'lists.pickers.runDialog', 'lists.pickers.callDialog', 'lists.watchlistSeed',
  'paper.start', 'paper.end', 'paper.fixedUniverse',
  'research.testAUniverse', 'research.universe', 'research.extraTickers',
  'models.pairs',
  'tax.rate',
  'benchmarks.index',
  'labels.listName', 'labels.holdResearchCore', 'labels.holdCore', 'labels.researchName',
  'sheets.protectedTabs', 'sheets.portfolio.headerAliases', 'sheets.portfolio.endMarkers.exact', 'sheets.portfolio.endMarkers.contains', 'sheets.portfolio.assumedPurchaseDate',
  'features.paper', 'features.liveBot', 'features.myOptions', 'features.ai',
  'exit.weeklyStops',
  'live.follow', 'live.startValue', 'live.fractional', 'live.minTrade', 'live.maxOrders', 'live.capSlack', 'live.targetMode', 'live.alertFalls', 'live.allowList',
  'results',
];

export const MAX_CORE_TICKERS = 30;
export const MAX_TAX_RATE = 0.6;
const TICKER = /^[A-Z0-9^][A-Z0-9.\-=^]{0,11}$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const USER_ID = /^[a-z][a-z0-9_-]{0,31}$/;

export type ProfileResult = { readonly ok: true; readonly profile: Profile } | { readonly ok: false; readonly errors: readonly string[] };

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** The dotted keys of an input object (a value that is an array or a map-typed key ends the walk). */
function keysOf(o: Record<string, unknown>, prefix = ''): string[] {
  const out: string[] = [];
  for (const [k, v] of Object.entries(o)) {
    const key = prefix + k;
    if (isObj(v) && key !== 'sheets.portfolio.headerAliases') out.push(...keysOf(v, key + '.'));
    else out.push(key);
  }
  return out;
}

function at(o: Record<string, unknown>, key: string): unknown {
  let v: unknown = o;
  for (const p of key.split('.')) { if (!isObj(v)) return undefined; v = v[p]; }
  return v;
}

export function isValidTimeZone(z: string): boolean {
  try { new Intl.DateTimeFormat('en-US', { timeZone: z }); return true; } catch { return false; }
}

/** Checks a profile input and returns the full profile (defaults filled in), or every problem found. */
export function validateProfile(input: unknown): ProfileResult {
  const errors: string[] = [];
  if (!isObj(input)) return { ok: false, errors: ['the profile must be an object'] };
  for (const k of keysOf(input)) if (!PROFILE_KEYS.includes(k)) errors.push('unknown key ' + k);

  const str = (key: string, required: boolean, re?: RegExp): string | null => {
    const v = at(input, key);
    if (v === undefined || v === null) { if (required) errors.push(key + ' is required'); return null; }
    if (typeof v !== 'string' || v.trim() === '') { errors.push(key + ' must be text'); return null; }
    if (re && !re.test(v)) { errors.push(key + ' is not valid'); return null; }
    return v;
  };
  const tickers = (key: string, opt: { min?: number; max?: number; fallback: readonly string[] }): readonly string[] => {
    const v = at(input, key);
    if (v === undefined || v === null) return opt.fallback;
    if (!Array.isArray(v)) { errors.push(key + ' must be a list of tickers'); return opt.fallback; }
    const bad = v.filter((t) => typeof t !== 'string' || !TICKER.test(t));
    if (bad.length) errors.push(key + ' has ' + bad.length + ' entry(ies) that are not tickers');
    if (new Set(v).size !== v.length) errors.push(key + ' lists a ticker twice');
    if (opt.min != null && v.length < opt.min) errors.push(key + ' needs at least ' + opt.min + ' ticker(s)');
    if (opt.max != null && v.length > opt.max) errors.push(key + ' takes at most ' + opt.max + ' tickers');
    return v as string[];
  };
  const texts = (key: string, fallback: readonly string[]): readonly string[] => {
    const v = at(input, key);
    if (v === undefined || v === null) return fallback;
    if (!Array.isArray(v) || v.some((t) => typeof t !== 'string' || t === '')) { errors.push(key + ' must be a list of texts'); return fallback; }
    return v as string[];
  };
  const bool = (key: string, fallback: boolean): boolean => {
    const v = at(input, key);
    if (v === undefined || v === null) return fallback;
    if (typeof v !== 'boolean') { errors.push(key + ' must be true or false'); return fallback; }
    return v;
  };
  const num = (key: string, lo: number, hi: number, required: boolean, fallback: number): number => {
    const v = at(input, key);
    if (v === undefined || v === null) { if (required) errors.push(key + ' is required (no default)'); return fallback; }
    if (typeof v !== 'number' || !Number.isFinite(v) || v < lo || v > hi) { errors.push(key + ' must be a number from ' + lo + ' to ' + hi); return fallback; }
    return v;
  };

  const version = num('version', PROFILE_VERSION, PROFILE_VERSION, false, PROFILE_VERSION);
  const id = str('user.id', true, USER_ID) ?? '';
  const timeZone = str('user.timeZone', true) ?? '';
  if (timeZone && !isValidTimeZone(timeZone)) errors.push('user.timeZone is not a known time zone');
  const core = tickers('lists.core', { min: 1, max: MAX_CORE_TICKERS, fallback: [] });
  if (at(input, 'lists.core') === undefined) errors.push('lists.core is required');
  const researchCore = tickers('lists.researchCore', { min: 1, fallback: core });
  const pickers: PickerLists = {
    stockMenu: tickers('lists.pickers.stockMenu', { min: 1, fallback: core }),
    runDialog: tickers('lists.pickers.runDialog', { min: 1, fallback: core }),
    callDialog: tickers('lists.pickers.callDialog', { min: 1, fallback: core }),
  };
  const watchlistSeed = tickers('lists.watchlistSeed', { fallback: [] });

  const start = str('paper.start', false, DAY), end = str('paper.end', false, DAY);
  if (start && end && end <= start) errors.push('paper.end must be after paper.start');
  const fixedUniverse = tickers('paper.fixedUniverse', { min: 1, fallback: core });
  const testAUniverse = tickers('research.testAUniverse', { min: 1, fallback: core });

  let pairs: ReadonlyArray<readonly [string, string]> = [];
  const rawPairs = at(input, 'models.pairs');
  if (rawPairs !== undefined && rawPairs !== null) {
    if (!Array.isArray(rawPairs) || rawPairs.some((p) => !Array.isArray(p) || p.length !== 2 || p.some((t) => typeof t !== 'string' || !TICKER.test(t)) || p[0] === p[1])) {
      errors.push('models.pairs must be a list of [ticker, other ticker] pairs');
    } else pairs = rawPairs as Array<[string, string]>;
  }

  const rate = num('tax.rate', 0, MAX_TAX_RATE, true, NaN);
  const index = str('benchmarks.index', false, TICKER) ?? 'QQQ';
  // A new user's research universe: their list, the index, SPY and the VIX (the research reads the last three).
  const universe = tickers('research.universe', { min: 1, fallback: [...new Set([...core, index, 'SPY', '^VIX'])] });
  // The crypto history James's models read (model data, not a user's picks).
  const extraTickers = tickers('research.extraTickers', { fallback: ['BTC-USD', 'ETH-USD', 'SOL-USD'] });
  const listName = str('labels.listName', false) ?? 'your list';
  const holdResearchCore = str('labels.holdResearchCore', false) ?? 'Hold ' + listName + ' equally';
  const holdCore = str('labels.holdCore', false) ?? 'Hold ' + listName + ' equally';
  const researchName = str('labels.researchName', false) ?? listName;

  const protectedTabs = texts('sheets.protectedTabs', []);
  let headerAliases: Record<string, readonly string[]> = {};
  const rawAliases = at(input, 'sheets.portfolio.headerAliases');
  if (rawAliases !== undefined && rawAliases !== null) {
    if (!isObj(rawAliases) || Object.values(rawAliases).some((v) => !Array.isArray(v) || v.some((t) => typeof t !== 'string' || t === ''))) {
      errors.push('sheets.portfolio.headerAliases must map a header to a list of other spellings');
    } else headerAliases = rawAliases as Record<string, string[]>;
  }
  const endMarkers = { exact: texts('sheets.portfolio.endMarkers.exact', []), contains: texts('sheets.portfolio.endMarkers.contains', ['CLOSED']) };
  const assumedPurchaseDate = str('sheets.portfolio.assumedPurchaseDate', false, DAY) ?? '2020-01-01';

  const exit = { weeklyStops: bool('exit.weeklyStops', false) };
  const features = { paper: bool('features.paper', true), liveBot: bool('features.liveBot', false), myOptions: bool('features.myOptions', true), ai: bool('features.ai', false) };

  let live: LiveProfile | null = null;
  if (at(input, 'live') !== undefined && at(input, 'live') !== null) {
    const mode = str('live.targetMode', false) ?? 'mirror';
    if (mode !== 'mirror' && mode !== 'equal') errors.push('live.targetMode must be mirror or equal');
    const falls = at(input, 'live.alertFalls');
    if (falls !== undefined && (!Array.isArray(falls) || falls.some((f) => typeof f !== 'number' || !(f > 0 && f < 1)))) errors.push('live.alertFalls must be a list of falls between 0 and 1');
    live = {
      follow: str('live.follow', false) ?? 'auto',
      startValue: num('live.startValue', 0, 1e9, true, 0),
      fractional: bool('live.fractional', true),
      minTrade: num('live.minTrade', 0, 1e9, false, 50),
      maxOrders: num('live.maxOrders', 1, 100, false, 10),
      capSlack: num('live.capSlack', 0, 1, false, 0.10),
      targetMode: mode === 'equal' ? 'equal' : 'mirror',
      alertFalls: Array.isArray(falls) ? (falls as number[]) : [0.20, 0.35],
      allowList: tickers('live.allowList', { min: 1, fallback: [...core, index] }),
    };
  }
  if (features.liveBot && !live) errors.push('features.liveBot needs the live settings');
  const results = str('results', false);

  if (errors.length) return { ok: false, errors };
  return {
    ok: true,
    profile: {
      version, user: { id, timeZone }, lists: { core, researchCore, pickers, watchlistSeed },
      paper: { start, end, fixedUniverse }, research: { testAUniverse, universe, extraTickers }, models: { pairs }, tax: { rate },
      benchmarks: { index }, labels: { listName, holdResearchCore, holdCore, researchName },
      sheets: { protectedTabs, portfolio: { headerAliases, endMarkers, assumedPurchaseDate } }, features, exit, live, results,
    },
  };
}

/** The ticker the charts and dialogs open on when none is given (today TSLA for the owner). */
export const defaultTickerOf = (p: Profile): string => p.lists.core[0] as string;
