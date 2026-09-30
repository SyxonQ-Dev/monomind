/**
 * Monoswarm MCP Tools for CLI
 *
 * Merged replacement for the former swarm-tools.ts + hive-mind-tools.ts.
 * Every tool here does one of two things: read/write a single JSON state
 * file (`.monomind/monoswarm/state.json`), or tally votes already recorded
 * in that file against a threshold. Nothing here starts a process, thread,
 * or network connection — real concurrent work happens only when the caller
 * separately dispatches subagents with Claude Code's Task tool.
 *
 * This is a clean break, not a migration: the old `.monomind/swarm/` and
 * `.monomind/hive-mind/` state files are abandoned in place (a later cleanup
 * phase purges them) rather than imported here.
 *
 * State helpers live in monoswarm-state.ts; the tools are grouped by family in
 * the monoswarm-*-tools.ts siblings and registered here in their original order.
 */

import { MONOSWARM_DEPRECATION } from '../deprecations.js';
import { deprecateTools } from './deprecated-tools.js';
import { monoswarmCoordinationTools } from './monoswarm-coordination-tools.js';
import { monoswarmLifecycleTools } from './monoswarm-lifecycle-tools.js';
import { monoswarmMembershipTools } from './monoswarm-membership-tools.js';
import { monoswarmVoteTools } from './monoswarm-vote-tools.js';
import type { MCPTool } from './types.js';

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

// Deprecated (#418): each description and result carries the removal note.
export const monoswarmTools: MCPTool[] = deprecateTools(
  [
    ...monoswarmLifecycleTools,
    ...monoswarmMembershipTools,
    ...monoswarmVoteTools,
    ...monoswarmCoordinationTools,
  ],
  MONOSWARM_DEPRECATION,
);
