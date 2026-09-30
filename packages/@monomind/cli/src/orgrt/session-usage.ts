// packages/@monomind/cli/src/orgrt/session-usage.ts
// Extracted from session.ts — token metering and usage events for a role session.
import type { AgentMessage } from './agent-runner.js';
import type { OrgBus } from './bus.js';
import type { CumulativeMeter } from './cumulative-meter.js';
import type { TokenUsage } from './policy.js';

/** ADR-O001 D1 — token-metering helpers.
 *
 *  `cache_read_input_tokens` and `cache_creation_input_tokens` are siblings
 *  of `input_tokens` in the Anthropic API, not subsets of it, and both are
 *  billable. Everything below therefore sums all four. */
export function totalTokens(u: TokenUsage): number {
  return u.input + u.output + u.cacheRead + u.cacheCreation;
}

export function addTo(target: TokenUsage, add: TokenUsage): void {
  target.input += add.input;
  target.output += add.output;
  target.cacheRead += add.cacheRead;
  target.cacheCreation += add.cacheCreation;
}

/** One model turn's own usage, off an 'assistant' (or per-turn 'result')
 *  message. */
export function turnBreakdown(m: AgentMessage): TokenUsage {
  return {
    input: m.input_tokens ?? 0,
    output: m.output_tokens ?? 0,
    cacheRead: m.cache_read_input_tokens ?? 0,
    cacheCreation: m.cache_creation_input_tokens ?? 0,
  };
}

/** What a 'result' message says this mailbox message consumed.
 *
 *  When the runner reports `cumulative_tokens` (the Claude SDK's whole-pipeline
 *  `modelUsage`, which unlike `usage` includes Task subagents and sidechains),
 *  that value is CUMULATIVE per session — the same lifecycle as
 *  `total_cost_usd` — so it is converted to a delta by the meter (see
 *  cumulative-meter.ts). Without `cumulative_tokens` the per-turn fields are
 *  used as before. */
export function resultBreakdown(
  m: AgentMessage,
  tokenTotals: CumulativeMeter<TokenUsage> | undefined,
  sid: string,
): TokenUsage {
  const cum = m.cumulative_tokens;
  if (!cum) return turnBreakdown(m);
  const now: TokenUsage = {
    input: cum.input,
    output: cum.output,
    cacheRead: cum.cache_read,
    cacheCreation: cum.cache_creation,
  };
  return tokenTotals ? tokenTotals.delta(sid, now) : now;
}

/** ADR-O001 D1: the four quantities travel separately so every downstream
 *  consumer (forwarder → dashboard state.json, reporting, `org costs`) can
 *  record real values instead of the 0s they used to persist. `tokens` stays
 *  the single billable total. */
export function emitUsage(
  bus: OrgBus,
  from: string,
  t: TokenUsage,
  costUsd: number | undefined,
  subtype: string | undefined,
): void {
  bus.emit({
    type: 'usage',
    from,
    data: {
      tokens: totalTokens(t),
      // null, not omitted, when the runtime reported no cost (unknown ≠ $0).
      cost_usd: costUsd ?? null,
      subtype,
      tokens_in: t.input,
      tokens_out: t.output,
      cache_read: t.cacheRead,
      cache_creation: t.cacheCreation,
    },
  });
}
