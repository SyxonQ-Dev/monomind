/**
 * CLI Command Parser
 * Advanced argument parsing with validation and type coercion
 *
 * File-size sweep: the class's method BODIES are grouped into sibling
 * modules — flag tokenizing/merging/coercion in parser-flags.ts, short-flag
 * alias and boolean/array flag-scope building in parser-aliases.ts, and
 * default application + flag validation in parser-validate.ts — mixed onto
 * CommandParser.prototype below. Each stays a real method here (same
 * signature, same visibility) so callers and TypeScript see no difference;
 * the body is just `return theSiblingImpl.call(this, ...args)`. Fields those
 * bodies read/write moved from `private` to `protected` (compile-time only;
 * no runtime change) — TypeScript allows a standalone function typed
 * `this: CommandParser` to reach `protected` members but not `private` ones,
 * so `protected` is the minimum visibility the split needs. The two
 * `private static` members with no external references (RESERVED_FLAG_KEYS,
 * asChain) don't have that this-typed escape hatch for static access, so
 * they moved wholesale into the sibling file that uses them instead.
 */

import { parserAliasMethods } from './parser-aliases.js';
import { parserFlagMethods } from './parser-flags.js';
import { parserValidateMethods } from './parser-validate.js';
import type { Command, CommandOption, ParsedFlags } from './types.js';

export interface ParseResult {
  command: string[];
  flags: ParsedFlags;
  positional: string[];
  raw: string[];
}

export interface ParserOptions {
  stopAtFirstNonFlag?: boolean;
  allowUnknownFlags?: boolean;
  booleanFlags?: string[];
  stringFlags?: string[];
  arrayFlags?: string[];
  aliases?: Record<string, string>;
  defaults?: Record<string, unknown>;
}

export class CommandParser {
  protected options: ParserOptions;
  protected commands: Map<string, Command> = new Map();
  protected globalOptions: CommandOption[] = [];

  constructor(options: ParserOptions = {}) {
    this.options = {
      stopAtFirstNonFlag: false,
      allowUnknownFlags: false,
      ...options,
    };

    this.initializeGlobalOptions();
  }

  private initializeGlobalOptions(): void {
    this.globalOptions = [
      {
        name: 'help',
        short: 'h',
        description: 'Show help information',
        type: 'boolean',
        default: false,
      },
      {
        name: 'version',
        short: 'V',
        description: 'Show version number',
        type: 'boolean',
        default: false,
      },
      {
        name: 'verbose',
        short: 'v',
        description: 'Enable verbose output',
        type: 'boolean',
        default: false,
      },
      {
        name: 'quiet',
        short: 'Q',
        description: 'Suppress non-essential output',
        type: 'boolean',
        default: false,
      },
      {
        name: 'config',
        short: 'c',
        description: 'Path to configuration file',
        type: 'string',
      },
      {
        name: 'format',
        // Note: removed global short flag 'f' — it collides with 50+ subcommand
        // flags (force, follow, file, feature, full) causing unpredictable behavior
        // depending on parser resolution order (#1425). Use --format instead.
        description: 'Output format (text, json, table)',
        type: 'string',
        default: 'text',
        choices: ['text', 'json', 'table'],
      },
      {
        name: 'color',
        description: 'Enable colored output (use --no-color to disable)',
        type: 'boolean',
        default: true,
      },
      {
        name: 'interactive',
        short: 'i',
        description: 'Enable interactive mode',
        type: 'boolean',
        default: true,
      },
      {
        name: 'update',
        description: 'Check for updates on startup (use --no-update to disable)',
        type: 'boolean',
        default: true,
      },
    ];
  }

  registerCommand(command: Command): void {
    this.commands.set(command.name, command);
    if (command.aliases) {
      for (const alias of command.aliases) {
        this.commands.set(alias, command);
      }
    }
  }

  getCommand(name: string): Command | undefined {
    return this.commands.get(name);
  }

  getAllCommands(): Command[] {
    // Return unique commands (filter out aliases)
    const seen = new Set<Command>();
    return Array.from(this.commands.values()).filter((cmd) => {
      if (seen.has(cmd)) return false;
      seen.add(cmd);
      return true;
    });
  }

  // Bodies live in parser-flags.ts (file-size sweep).
  protected setFlagSafe(flags: ParsedFlags, key: string, value: string | number | boolean): void {
    parserFlagMethods.setFlagSafe.call(this, flags, key, value);
  }

  private mergeParsedFlags(
    into: ParsedFlags,
    from: ParsedFlags,
    arrayFlags: Set<string>,
    booleanFlags?: Set<string>,
  ): void {
    parserFlagMethods.mergeParsedFlags.call(this, into, from, arrayFlags, booleanFlags);
  }

  parse(args: string[]): ParseResult {
    const result: ParseResult = {
      command: [],
      flags: { _: [] },
      positional: [],
      raw: [...args],
    };

    // Pass 1: Identify the command and its subcommand chain (skip flags).
    //
    // This walks the WHOLE tree, not just one subcommand level. It used to
    // stop after depth 1 (`resolvedCmd` + `resolvedSub`), so options declared
    // on a subcommand nested 2+ levels deep were invisible to the alias and
    // boolean scans below: `hooks worker run -n audit` resolved `-n` from the
    // global last-write-wins alias pool (where it happened to mean `--limit`)
    // instead of `run`'s own `-n, --name`, and the command then failed with
    // "Worker name is required" while `--name audit` worked.
    const scopeChain: Command[] = [];
    let resolvedCmd: Command | undefined;
    for (const arg of args) {
      if (arg.startsWith('-')) continue;
      if (!resolvedCmd) {
        const top = this.commands.get(arg);
        if (top) {
          resolvedCmd = top;
          scopeChain.push(top);
        }
        continue;
      }
      const next = resolvedCmd.subcommands?.find(
        (sc) => sc.name === arg || sc.aliases?.includes(arg),
      );
      if (next) {
        resolvedCmd = next;
        scopeChain.push(next);
      }
    }

    // Pass 2: Build aliases scoped to the resolved subcommand chain.
    // Subcommand-specific aliases take priority over global ones, and the
    // deepest subcommand wins over its ancestors. The top-level command is
    // excluded when it has a resolved subcommand (preserving the previous
    // `resolvedSub || resolvedCmd` precedence exactly for depth <= 1).
    const scope = scopeChain.length > 1 ? scopeChain.slice(1) : scopeChain;
    const aliases = this.buildScopedAliases(scope);
    const booleanFlags = this.getScopedBooleanFlags(scope);
    const arrayFlags = this.getScopedArrayFlags(scope);

    let i = 0;
    let parsingFlags = true;
    // Once a non-flag token has been seen that is NOT a registered command,
    // no later token may be promoted to "the command". Without this, an
    // unrecognised first token was silently discarded and the SECOND token
    // dispatched instead — `monomind typo status` ran `status`. A mistyped
    // command must never run something the user did not ask for.
    let commandSearchClosed = false;

    while (i < args.length) {
      const arg = args[i];

      // Check for end of flags marker
      if (arg === '--') {
        parsingFlags = false;
        i++;
        continue;
      }

      // Handle flags
      if (parsingFlags && arg.startsWith('-')) {
        const parseResult = this.parseFlag(args, i, aliases, booleanFlags);

        // Merge into result flags. A plain Object.assign here would silently
        // drop earlier values whenever the same flag is passed more than once
        // (`-p a=1 -p b=2` kept only `b=2`) — options declared `type: 'array'`
        // (e.g. browse-action.ts's --params/-p, swarm.ts) are meant to
        // collect every occurrence, and even a flag NOT declared array
        // shouldn't silently lose data on repetition.
        this.mergeParsedFlags(result.flags, parseResult.flags, arrayFlags, booleanFlags);
        i = parseResult.nextIndex;
        continue;
      }

      // Handle positional arguments
      if (result.command.length === 0 && !commandSearchClosed && this.commands.has(arg)) {
        // This is a command
        result.command.push(arg);

        // Check for subcommand (level 1)
        const cmd = this.commands.get(arg);
        resolvedCmd = cmd;
        if (cmd?.subcommands && i + 1 < args.length) {
          const nextArg = args[i + 1];
          const subCmd = cmd.subcommands.find(
            (sc) => sc.name === nextArg || sc.aliases?.includes(nextArg),
          );
          if (subCmd) {
            result.command.push(nextArg);
            resolvedCmd = subCmd;
            i++;

            // Check for nested subcommand (level 2)
            if (subCmd.subcommands && i + 1 < args.length) {
              const nestedArg = args[i + 1];
              const nestedCmd = subCmd.subcommands.find(
                (sc) => sc.name === nestedArg || sc.aliases?.includes(nestedArg),
              );
              if (nestedCmd) {
                result.command.push(nestedArg);
                resolvedCmd = nestedCmd;
                i++;

                // Check for deeply nested subcommand (level 3)
                if (nestedCmd.subcommands && i + 1 < args.length) {
                  const deepArg = args[i + 1];
                  const deepCmd = nestedCmd.subcommands.find(
                    (sc) => sc.name === deepArg || sc.aliases?.includes(deepArg),
                  );
                  if (deepCmd) {
                    result.command.push(deepArg);
                    resolvedCmd = deepCmd;
                    i++;
                  }
                }
              }
            }
          }
        }
      } else {
        // Positional argument. If we haven't resolved a command yet, this
        // token was the user's attempt at one — close the search so a later
        // token can't be silently dispatched in its place.
        if (result.command.length === 0) commandSearchClosed = true;
        result.positional.push(arg);
        result.flags._.push(arg);
      }

      i++;
    }

    // Apply defaults — the resolved (sub)command's own option definitions
    // shadow same-name global options (e.g. `browse screenshot --format` is an
    // image format, not the global text|json|table output format).
    this.applyDefaults(result.flags, resolvedCmd);

    // Dual-write flag keys: every flag ends up stored under BOTH its
    // camelCase form (`keepConfig`) and its original kebab-case form
    // (`keep-config`). Historically only the camelCase key was ever set,
    // but dozens of command action functions across the codebase read
    // `ctx.flags['kebab-case']` directly — which was always `undefined`,
    // silently disabling those flags (see AUDIT-BACKLOG P0-10). Running
    // this as a single pass over the fully-merged flags object (long
    // flags, `--no-x` negation, short-flag aliases, and defaults are all
    // merged into `result.flags` by this point) covers every entry point
    // in one place instead of touching each call site individually.
    this.mirrorFlagKeys(result.flags);

    return result;
  }

  protected camelToKebab(key: string): string {
    return parserFlagMethods.camelToKebab.call(this, key);
  }

  private mirrorFlagKeys(flags: ParsedFlags): void {
    parserFlagMethods.mirrorFlagKeys.call(this, flags);
  }

  protected looksLikeNegativeNumber(value: string): boolean {
    return parserFlagMethods.looksLikeNegativeNumber.call(this, value);
  }

  private parseFlag(
    args: string[],
    index: number,
    aliases: Record<string, string>,
    booleanFlags: Set<string>,
  ): { flags: ParsedFlags; nextIndex: number } {
    return parserFlagMethods.parseFlag.call(this, args, index, aliases, booleanFlags);
  }

  protected setBooleanFlag(
    flags: ParsedFlags,
    key: string,
    args: string[],
    nextIndex: number,
  ): number {
    return parserFlagMethods.setBooleanFlag.call(this, flags, key, args, nextIndex);
  }

  protected parseValue(value: string): string | number | boolean {
    return parserFlagMethods.parseValue.call(this, value);
  }

  protected normalizeKey(key: string): string {
    return parserFlagMethods.normalizeKey.call(this, key);
  }

  // Bodies live in parser-aliases.ts (file-size sweep).
  protected buildAliases(): Record<string, string> {
    return parserAliasMethods.buildAliases.call(this);
  }

  private buildScopedAliases(scope?: Command | Command[]): Record<string, string> {
    return parserAliasMethods.buildScopedAliases.call(this, scope);
  }

  private getScopedBooleanFlags(scope?: Command | Command[]): Set<string> {
    return parserAliasMethods.getScopedBooleanFlags.call(this, scope);
  }

  private getScopedArrayFlags(scope?: Command | Command[]): Set<string> {
    return parserAliasMethods.getScopedArrayFlags.call(this, scope);
  }

  protected getBooleanFlags(): Set<string> {
    return parserAliasMethods.getBooleanFlags.call(this);
  }

  // Bodies live in parser-validate.ts (file-size sweep).
  private applyDefaults(flags: ParsedFlags, resolvedCmd?: Command): void {
    parserValidateMethods.applyDefaults.call(this, flags, resolvedCmd);
  }

  validateFlags(flags: ParsedFlags, command?: Command): string[] {
    return parserValidateMethods.validateFlags.call(this, flags, command);
  }

  getGlobalOptions(): CommandOption[] {
    return [...this.globalOptions];
  }
}

// Export singleton parser instance
export const commandParser = new CommandParser({ allowUnknownFlags: true });
