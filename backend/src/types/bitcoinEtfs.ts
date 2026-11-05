/**
 * The spot Bitcoin ETFs the user holds or watches -- ONE list (dedupe cluster 12). They track the same
 * underlying asset, so the Buy report ranks them as one idea, the Exit report shows one shared thesis,
 * and the correlated-group cap treats them as one exposure.
 */
export const BITCOIN_ETF_TICKERS: readonly string[] = ['GBTC', 'BTC', 'FBTC', 'BITB', 'IBIT'];
