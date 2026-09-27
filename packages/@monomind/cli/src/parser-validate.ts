/**
 * Default application and flag validation for CommandParser.
 * File-size sweep: split out of parser.ts. Mixed into
 * CommandParser.prototype at the bottom of parser.ts.
 *
 * @module v1/cli/parser-validate
 */

import type { CommandParser } from './parser.js';
import type { Command, CommandOption, ParsedFlags } from './types.js';

export const parserValidateMethods = {
  applyDefaults(this: CommandParser, flags: ParsedFlags, resolvedCmd?: Command): void {
    // The resolved command's own options shadow same-name globals: apply the
    // command's defaults and suppress the global default for those names.
    const shadowed = new Set<string>();
    if (resolvedCmd?.options) {
      for (const opt of resolvedCmd.options) {
        const key = this.normalizeKey(opt.name);
        shadowed.add(key);
        if (flags[key] === undefined && opt.default !== undefined) {
          flags[key] = opt.default as string | boolean | number | string[];
        }
      }
    }

    // Apply global option defaults
    for (const opt of this.globalOptions) {
      const key = this.normalizeKey(opt.name);
      if (shadowed.has(key)) continue;
      if (flags[key] === undefined && opt.default !== undefined) {
        flags[key] = opt.default as string | boolean | number | string[];
      }
    }

    // Apply custom defaults
    if (this.options.defaults) {
      for (const [key, value] of Object.entries(this.options.defaults)) {
        const normalizedKey = this.normalizeKey(key);
        if (flags[normalizedKey] === undefined) {
          flags[normalizedKey] = value as string | boolean | number | string[];
        }
      }
    }
  },

  validateFlags(this: CommandParser, flags: ParsedFlags, command?: Command): string[] {
    const errors: string[] = [];
    // Command options shadow same-name globals — validate against the
    // command's definition (its choices/validators), not the global's.
    const byName = new Map<string, CommandOption>();
    for (const opt of this.globalOptions) byName.set(opt.name, opt);
    if (command?.options) {
      for (const opt of command.options) byName.set(opt.name, opt);
    }
    const allOptions = [...byName.values()];

    // Check required flags
    for (const opt of allOptions) {
      const key = this.normalizeKey(opt.name);

      if (opt.required && (flags[key] === undefined || flags[key] === '')) {
        errors.push(`Required option missing: --${opt.name}`);
      }

      // Check choices
      if (opt.choices && flags[key] !== undefined) {
        const value = String(flags[key]);
        if (!opt.choices.includes(value)) {
          errors.push(
            `Invalid value for --${opt.name}: ${value}. Must be one of: ${opt.choices.join(', ')}`,
          );
        }
      }

      // Run custom validator
      if (opt.validate && flags[key] !== undefined) {
        const result = opt.validate(flags[key]);
        if (result !== true) {
          errors.push(typeof result === 'string' ? result : `Invalid value for --${opt.name}`);
        }
      }
    }

    // Check for unknown flags if not allowed
    if (!this.options.allowUnknownFlags) {
      // Include both the camelCase and original (kebab-case) spelling of
      // each option name — parse() now mirrors flags under both forms, so
      // validation must recognize both or the mirrored key would be
      // flagged as an unknown option.
      const knownFlags = new Set<string>();
      for (const opt of allOptions) {
        knownFlags.add(this.normalizeKey(opt.name));
        knownFlags.add(opt.name);
      }
      knownFlags.add('_'); // Positional args

      for (const key of Object.keys(flags)) {
        if (!knownFlags.has(key) && key !== '_') {
          errors.push(`Unknown option: --${key}`);
        }
      }
    }

    return errors;
  },
};
