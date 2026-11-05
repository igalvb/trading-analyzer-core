/**
 * Production adapter: the real @anthropic-ai/sdk behind the ClaudeSdk seam.
 *
 * The SDK's own retries are OFF (maxRetries: 0): claudeReview.ts owns the
 * retry policy, and two layers of retry would multiply attempts. The API key
 * is a parameter (env ANTHROPIC_API_KEY, claudeKeyFromEnv), never a literal.
 * Request and response cross the seam as plain objects; the casts below are
 * the only place this module's types meet the SDK's.
 *
 * Row 38 (V13 dual-AI plan s8 open question 4, "Enable Opus server-side refusal
 * fallbacks? Recommended: yes -- one parameter, converts a hard failure into a
 * degraded success"; logging plan decision 9 = yes): every request carries
 * `fallbacks: "default"` under the beta header SERVER_SIDE_FALLBACK_BETA. When
 * Opus's safety classifier declines, the API re-runs the request on the model
 * Anthropic recommends for that refusal category and returns that answer
 * (top-level `model` names the model that answered). If the fallback also
 * declines (or is not made), the response is still stop_reason "refusal" and
 * claudeReview.ts takes its existing refusal path: no text read, the curated
 * disclosure sentence, every number unaffected.
 */

import Anthropic from '@anthropic-ai/sdk';
import type { ClaudeCallOptions, ClaudeRequest, ClaudeResponse, ClaudeSdk } from './claudeReview.ts';

/** The beta that gates the `fallbacks: "default"` form (the array form uses a different header). */
export const SERVER_SIDE_FALLBACK_BETA = 'server-side-fallback-2026-07-01';
export const CLAUDE_FALLBACKS = 'default' as const;

export function createAnthropicSdk(apiKey: string, opts: { readonly fetch?: typeof fetch } = {}): ClaudeSdk {
  const client = new Anthropic({ apiKey, maxRetries: 0, ...(opts.fetch ? { fetch: opts.fetch } : {}) });
  return {
    async create(request: ClaudeRequest, options?: ClaudeCallOptions): Promise<ClaudeResponse> {
      const params = { ...request, fallbacks: CLAUDE_FALLBACKS, betas: [SERVER_SIDE_FALLBACK_BETA] };
      const message = await client.beta.messages.create(params as unknown as Anthropic.Beta.Messages.MessageCreateParamsNonStreaming, { signal: options?.signal, timeout: options?.timeout });
      return message as unknown as ClaudeResponse;
    },
  };
}
