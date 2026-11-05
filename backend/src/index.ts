/**
 * Entry-point stub.
 *
 * This project has no single "main" -- it has several real entry points,
 * each invoked by its own npm script and its own GitHub Actions workflow:
 *
 *   npm run smoke    src/smoke.ts    phase-0 connectivity gate  [EXISTS]
 *   npm run nightly  src/nightly.ts  full pipeline, no AI       [phase 3]
 *   npm run ai       src/ai.ts       Gemini/Opus narrative      [phase 6]
 *   npm run ticker   src/ticker.ts   single-ticker analysis     [phase 6]
 *
 * This file exists so the package has a valid, importable entry point and
 * so `tsc` has something to compile at phase 0. It is deliberately not a
 * dispatcher -- routing between entry points is the workflows' job, and
 * adding an argv parser here would duplicate that for no benefit.
 */

export const VERSION = '0.1.0';

export const PHASE = 'phase-0: scaffolding' as const;

// Running this file directly is almost always a mistake -- say so clearly
// rather than exiting silently and looking like it worked.
if (import.meta.url === `file://${process.argv[1]}`) {
  console.log(`stock-analyzer-backend v${VERSION} (${PHASE})`);
  console.log('This file is not a runnable entry point. Use one of:');
  console.log('  npm run smoke     -- verify Sheets connectivity (phase 0)');
  console.log('  npm run nightly   -- full pipeline, no AI      (not yet implemented)');
  console.log('  npm run ai        -- add AI narrative          (not yet implemented)');
  console.log('  npm run ticker    -- single-ticker analysis    (not yet implemented)');
}
