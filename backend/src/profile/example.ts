/**
 * GENERIC_PLAN P1: the example profile, a made-up user with a short neutral list. Tests of the core use it (P2 on)
 * to prove a module needs no owner value. It is NOT the owner's (src/owner/profile.ts) and holds no owner data.
 */

export const EXAMPLE_PROFILE_INPUT = {
  version: 1,
  user: { id: 'example', timeZone: 'Europe/London' },
  lists: { core: ['AAPL', 'MSFT', 'KO', 'JNJ'] },
  tax: { rate: 0.2 },
  labels: { listName: 'your list' },
} as const;
