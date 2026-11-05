/**
 * Cross-realm normalisation for oracle output.
 *
 * WHY THIS EXISTS: vm.createContext() creates a separate JavaScript realm
 * with its own intrinsics. Arrays and objects built inside the oracle
 * therefore carry the VM realm's prototypes, not the host's:
 *
 *     Array.isArray(fromVm)                        -> true
 *     JSON.stringify(fromVm) === JSON.stringify(x) -> true
 *     Object.getPrototypeOf(fromVm) === Array.prototype -> FALSE
 *     fromVm instanceof Array                      -> FALSE
 *
 * assert.deepStrictEqual compares prototypes, so structurally identical data
 * fails with "Values have same structure but are not reference-equal".
 * assert.deepEqual (loose) fails too.
 *
 * Found on 2026-09-13 while porting the leaf utilities: the 3 array-returning
 * functions failed 130/130 while the 5 primitive-returning ones passed
 * 130/130 -- a perfect split on return type, with byte-identical values.
 *
 * Without this, EVERY differential test over an array or object would fail,
 * and the parity strategy would only ever have worked on scalars.
 *
 * structuredClone rebuilds the value using HOST intrinsics, including
 * correctly re-homing Date objects (verified: a VM Date fails
 * `instanceof Date` before cloning and passes after).
 */

/**
 * Re-homes a value from the oracle's realm into this one.
 *
 * Primitives pass through untouched -- they have no prototype identity, and
 * cloning them would be pointless work on large runs.
 *
 * Throws on non-cloneable values (functions, symbols). That is deliberate:
 * an oracle result containing a function is something the port author needs
 * to know about, not something to silently paper over.
 */
export function normalizeFromOracle<T>(value: T): T {
  if (value === null || typeof value !== 'object') return value;
  return structuredClone(value);
}

/**
 * Pairs a port result with an oracle result, both normalised, ready for
 * assert.deepStrictEqual.
 */
export function comparable<T>(portValue: T, oracleValue: T): [T, T] {
  return [normalizeFromOracle(portValue), normalizeFromOracle(oracleValue)];
}
