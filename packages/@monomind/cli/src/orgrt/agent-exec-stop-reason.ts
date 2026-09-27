// packages/@monomind/cli/src/orgrt/agent-exec-stop-reason.ts
// Split out of agent-exec.ts (file-size rule).

import type { Terminal } from './agent-exec-options.js';

export function mapStopReason(
  subtype: string | undefined,
  rawTexts: string[],
  terminal: Terminal | null,
): string {
  if (terminal?.code === 'timeout') return 'timeout';
  if (terminal?.code === 'cancelled') return 'cancelled';
  if ((subtype ?? '').includes('max_turns')) return 'max_turns';
  if (rawTexts.some((t) => t.includes('tool-call round cap'))) return 'tool_round_cap';
  return 'end_turn';
}
