/**
 * Temporarily replaces oracle globals (an Apps Script service, a legacy
 * function) for the duration of `fn`, restoring them even on throw. The
 * generalised form of BC-5's withStubs. Synchronous only -- the oracle is.
 */

import { loadOracle } from './oracle.ts';

export function withOracleGlobals<T>(overrides: Readonly<Record<string, unknown>>, fn: () => T): T {
  const oracle = loadOracle();
  const saved = Object.keys(overrides).map((k) => [k, oracle.getGlobal(k)] as const);
  try {
    for (const [k, v] of Object.entries(overrides)) oracle.setGlobal(k, v);
    return fn();
  } finally {
    for (const [k, v] of saved) oracle.setGlobal(k, v);
  }
}
