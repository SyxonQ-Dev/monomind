/**
 * Alias- and flag-scope-building for CommandParser (global + per-command
 * short-flag aliases, boolean/array flag sets).
 * File-size sweep: split out of parser.ts. Mixed into
 * CommandParser.prototype at the bottom of parser.ts.
 *
 * @module v1/cli/parser-aliases
 */

import type { CommandParser } from './parser.js';
import type { Command } from './types.js';

/** Normalize a single command or a resolved chain into an array. */
function asChain(scope?: Command | Command[]): Command[] {
  if (!scope) return [];
  return Array.isArray(scope) ? scope : [scope];
}

export const parserAliasMethods = {
  buildAliases(this: CommandParser): Record<string, string> {
    const aliases: Record<string, string> = {};

    // Add aliases from all commands and subcommands first (lowest priority) —
    // any command's own options may still be re-applied by buildScopedAliases()
    // once the resolved command is known.
    for (const cmd of this.commands.values()) {
      if (cmd.options) {
        for (const opt of cmd.options) {
          if (opt.short) {
            aliases[opt.short] = opt.name;
          }
        }
      }
      // Also include subcommands' options
      if (cmd.subcommands) {
        for (const sub of cmd.subcommands) {
          if (sub.options) {
            for (const opt of sub.options) {
              if (opt.short) {
                aliases[opt.short] = opt.name;
              }
            }
          }
        }
      }
    }

    // Global options are applied last so an unrelated command's short flag
    // (e.g. "security scan --quick, -Q") can't silently shadow a global flag
    // of the same letter (e.g. global "-Q, --quiet") for every other command.
    for (const opt of this.globalOptions) {
      if (opt.short) {
        aliases[opt.short] = opt.name;
      }
    }

    return { ...aliases, ...this.options.aliases };
  },

  /**
   * Build aliases scoped to a specific command/subcommand.
   * The resolved command's short flags take priority over global ones,
   * fixing collisions where multiple subcommands use the same short flag (e.g. -t).
   */
  buildScopedAliases(this: CommandParser, scope?: Command | Command[]): Record<string, string> {
    // Start with global aliases as base
    const aliases = this.buildAliases();

    // Override with the resolved chain's own options (these take priority);
    // deepest subcommand last, so it wins over its ancestors.
    for (const cmd of asChain(scope)) {
      for (const opt of cmd.options ?? []) {
        if (opt.short) {
          aliases[opt.short] = opt.name;
        }
      }
    }

    return aliases;
  },

  /**
   * Get boolean flags scoped to a specific command/subcommand chain.
   */
  getScopedBooleanFlags(this: CommandParser, scope?: Command | Command[]): Set<string> {
    const flags = this.getBooleanFlags();

    for (const cmd of asChain(scope)) {
      for (const opt of cmd.options ?? []) {
        if (opt.type === 'boolean') {
          flags.add(this.normalizeKey(opt.name));
        }
      }
    }

    return flags;
  },

  /**
   * Get flags declared `type: 'array'`, scoped to a specific command/subcommand chain.
   */
  getScopedArrayFlags(this: CommandParser, scope?: Command | Command[]): Set<string> {
    const flags = new Set<string>();
    for (const cmd of asChain(scope)) {
      for (const opt of cmd.options ?? []) {
        if (opt.type === 'array') {
          flags.add(this.normalizeKey(opt.name));
        }
      }
    }
    return flags;
  },

  getBooleanFlags(this: CommandParser): Set<string> {
    const flags = new Set<string>();

    for (const opt of this.globalOptions) {
      if (opt.type === 'boolean') {
        flags.add(this.normalizeKey(opt.name));
      }
    }

    // Add boolean flags from all commands and subcommands
    for (const cmd of this.commands.values()) {
      if (cmd.options) {
        for (const opt of cmd.options) {
          if (opt.type === 'boolean') {
            flags.add(this.normalizeKey(opt.name));
          }
        }
      }
      // Also include subcommands' boolean flags
      if (cmd.subcommands) {
        for (const sub of cmd.subcommands) {
          if (sub.options) {
            for (const opt of sub.options) {
              if (opt.type === 'boolean') {
                flags.add(this.normalizeKey(opt.name));
              }
            }
          }
        }
      }
    }

    if (this.options.booleanFlags) {
      for (const flag of this.options.booleanFlags) {
        flags.add(this.normalizeKey(flag));
      }
    }

    return flags;
  },
};
