/**
 * Deprecation notices for `monoswarm` and `autopilot` (#418). Both record
 * state and start no agents; they are removed in the next minor release.
 *
 * Shared by the CLI commands (a one-line notice on stderr) and the MCP tools
 * (a `deprecated` note on each tool's description and result).
 */

import { output } from './output.js';
import type { Command, CommandContext } from './types.js';

/** The release that removes monoswarm and autopilot (the next minor). */
export const MONOSWARM_AUTOPILOT_REMOVAL_VERSION = '2.21.0';

export const MONOSWARM_DEPRECATION = `monoswarm is deprecated and will be removed in the next minor release (${MONOSWARM_AUTOPILOT_REMOVAL_VERSION}); it records state and starts no agents. Use Claude Code's Task tool or 'monomind org run' instead.`;

/** Short prefix for deprecated MCP tool descriptions; the full notice goes in each result. */
export const DEPRECATED_TOOL_PREFIX = `DEPRECATED (removed in ${MONOSWARM_AUTOPILOT_REMOVAL_VERSION}; use the Task tool or 'monomind org run'):`;

export const AUTOPILOT_DEPRECATION = `autopilot is deprecated and will be removed in the next minor release (${MONOSWARM_AUTOPILOT_REMOVAL_VERSION}); it reads local task files and starts no agents. Use 'monomind org run' instead.`;

/**
 * Prints `notice` on stderr — never stdout, so a command's JSON output stays
 * clean — unless `-Q/--quiet` is set.
 */
export function printDeprecationNotice(ctx: CommandContext, notice: string): void {
  if (!ctx.flags.quiet && !output.isQuiet()) {
    output.writeErrorln(output.warning(`[DEPRECATED] ${notice}`));
  }
}

/**
 * Copy of `cmd` whose action, and every nested subcommand's action, first
 * prints `notice` on stderr — never stdout, so `--format json` stays a clean
 * document — unless `-Q/--quiet` is set.
 */
export function withDeprecationNotice(cmd: Command, notice: string): Command {
  const action = cmd.action;
  return {
    ...cmd,
    subcommands: cmd.subcommands?.map((sub) => withDeprecationNotice(sub, notice)),
    action: action
      ? async (ctx: CommandContext) => {
          printDeprecationNotice(ctx, notice);
          return action(ctx);
        }
      : undefined,
  };
}
