/**
 * Flag-parsing internals for CommandParser (tokenizing, merging, value
 * coercion, key normalization).
 * File-size sweep: split out of parser.ts. Mixed into
 * CommandParser.prototype at the bottom of parser.ts.
 *
 * @module v1/cli/parser-flags
 */

import type { CommandParser } from './parser.js';
import type { ParsedFlags } from './types.js';

/**
 * Reserved keys that would either pollute the prototype chain (`__proto__`,
 * `constructor`, `prototype`) or shadow `Object.prototype` methods that
 * downstream consumers commonly call (`hasOwnProperty`, `toString`,
 * `valueOf`, `isPrototypeOf`, `propertyIsEnumerable`). All are rejected.
 */
const RESERVED_FLAG_KEYS = new Set([
  '__proto__',
  'constructor',
  'prototype',
  'hasOwnProperty',
  'toString',
  'valueOf',
  'isPrototypeOf',
  'propertyIsEnumerable',
]);

export const parserFlagMethods = {
  setFlagSafe(
    this: CommandParser,
    flags: ParsedFlags,
    key: string,
    value: string | number | boolean,
  ): void {
    if (RESERVED_FLAG_KEYS.has(key)) return;
    flags[key] = value;
  },

  /**
   * Merge a single parsed flag (or set of `_` positionals) into the
   * accumulated result flags, collecting repeats into an array instead of
   * overwriting. Declared `type: 'array'` options always end up as an array
   * (even a single occurrence); any other repeated flag also becomes an
   * array on its second occurrence rather than silently dropping the first
   * value.
   */
  mergeParsedFlags(
    this: CommandParser,
    into: ParsedFlags,
    from: ParsedFlags,
    arrayFlags: Set<string>,
    booleanFlags?: Set<string>,
  ): void {
    for (const key of Object.keys(from)) {
      if (key === '_') {
        into._.push(...from._);
        continue;
      }
      if (RESERVED_FLAG_KEYS.has(key)) continue;
      const incoming = from[key];

      if (Array.isArray(into[key])) {
        (into[key] as string[]).push(...([] as unknown[]).concat(incoming).map(String));
      } else if (into[key] !== undefined && booleanFlags?.has(key)) {
        // Declared boolean flag repeated (e.g. `--dry-run --dry-run`) — last
        // value wins instead of promoting to an array. Callers throughout the
        // codebase check booleans with `flags['x'] === true`; an array value
        // would silently fail that check (e.g. guidance.ts's --dry-run,
        // which guards a destructive write).
        into[key] = incoming;
      } else if (into[key] !== undefined) {
        // Repeated flag not previously an array — promote to array so the
        // earlier value isn't lost.
        into[key] = [String(into[key]), String(incoming)];
      } else if (arrayFlags.has(key)) {
        // First occurrence of a declared array flag — still wrap in an array.
        into[key] = [String(incoming)];
      } else {
        into[key] = incoming;
      }
    }
  },

  /**
   * Convert a camelCase key to kebab-case (inverse of normalizeKey).
   */
  camelToKebab(this: CommandParser, key: string): string {
    return key.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);
  },

  /**
   * Ensure every flag is reachable under both its camelCase and
   * kebab-case spelling. Runs once, after all flags (including
   * defaults) have been merged into the result.
   */
  mirrorFlagKeys(this: CommandParser, flags: ParsedFlags): void {
    for (const key of Object.keys(flags)) {
      if (key === '_' || RESERVED_FLAG_KEYS.has(key)) continue;

      const camelKey = this.normalizeKey(key);
      if (camelKey !== key && flags[camelKey] === undefined && !RESERVED_FLAG_KEYS.has(camelKey)) {
        flags[camelKey] = flags[key];
      }

      const kebabKey = this.camelToKebab(key);
      if (kebabKey !== key && flags[kebabKey] === undefined && !RESERVED_FLAG_KEYS.has(kebabKey)) {
        flags[kebabKey] = flags[key];
      }
    }
  },

  /**
   * True when `value` looks like a space-separated negative number
   * (`-0.5`, `-42`) rather than a new flag. Scoped narrowly to "leading `-`
   * immediately followed by a digit" — a legitimate flag name never starts
   * with a digit, so this can't misfire on a genuine following flag while
   * still letting `--threshold -0.5` consume `-0.5` as the value instead of
   * being misparsed as a new (bogus) flag.
   */
  looksLikeNegativeNumber(this: CommandParser, value: string): boolean {
    return /^-\d/.test(value);
  },

  parseFlag(
    this: CommandParser,
    args: string[],
    index: number,
    aliases: Record<string, string>,
    booleanFlags: Set<string>,
  ): { flags: ParsedFlags; nextIndex: number } {
    const flags: ParsedFlags = { _: [] };
    const arg = args[index];
    let nextIndex = index + 1;

    if (arg.startsWith('--')) {
      // Long flag
      const equalIndex = arg.indexOf('=');

      if (equalIndex !== -1) {
        // --flag=value
        const key = arg.slice(2, equalIndex);
        const value = arg.slice(equalIndex + 1);
        this.setFlagSafe(flags, this.normalizeKey(key), this.parseValue(value));
      } else if (arg.startsWith('--no-')) {
        // --no-flag (boolean negation) — only accept for declared boolean flags
        // so attackers can't covertly toggle off arbitrary security controls
        // (--no-verify-signature, --no-confirm, etc.) when the underlying flag
        // doesn't exist as a boolean option. Unknown --no-X is treated as a
        // string flag passed verbatim, which validation can then reject.
        const key = arg.slice(5);
        const normalizedKey = this.normalizeKey(key);
        if (booleanFlags.has(normalizedKey)) {
          this.setFlagSafe(flags, normalizedKey, false);
        } else {
          // Record under the prefixed name so it surfaces as unknown rather
          // than silently downgrading any flag the user happens to spell.
          this.setFlagSafe(flags, this.normalizeKey(`no-${key}`), true);
        }
      } else {
        const key = arg.slice(2);
        const normalizedKey = this.normalizeKey(key);

        if (booleanFlags.has(normalizedKey)) {
          nextIndex = this.setBooleanFlag(flags, normalizedKey, args, nextIndex);
        } else if (
          nextIndex < args.length &&
          (!args[nextIndex].startsWith('-') || this.looksLikeNegativeNumber(args[nextIndex]))
        ) {
          this.setFlagSafe(flags, normalizedKey, this.parseValue(args[nextIndex]));
          nextIndex++;
        } else {
          this.setFlagSafe(flags, normalizedKey, true);
        }
      }
    } else if (arg.startsWith('-')) {
      // Short flag(s)
      const chars = arg.slice(1);

      if (chars.length === 1) {
        // Single short flag
        const key = aliases[chars] || chars;
        const normalizedKey = this.normalizeKey(key);

        if (booleanFlags.has(normalizedKey)) {
          nextIndex = this.setBooleanFlag(flags, normalizedKey, args, nextIndex);
        } else if (
          nextIndex < args.length &&
          (!args[nextIndex].startsWith('-') || this.looksLikeNegativeNumber(args[nextIndex]))
        ) {
          this.setFlagSafe(flags, normalizedKey, this.parseValue(args[nextIndex]));
          nextIndex++;
        } else {
          this.setFlagSafe(flags, normalizedKey, true);
        }
      } else {
        // Multiple short flags combined (e.g., -abc)
        for (const char of chars) {
          const key = aliases[char] || char;
          this.setFlagSafe(flags, this.normalizeKey(key), true);
        }
      }
    }

    return { flags, nextIndex };
  },

  /**
   * Set a declared boolean flag, consuming an immediately following literal
   * `true`/`false` as its value and returning the new cursor.
   *
   * Without this, `--success false` both set success=`true` AND left the token
   * "false" in the positional list — where any command that also accepts a
   * positional read it as that argument. `hooks post-task --task-id abc
   * --success false` therefore recorded task "false" as *successful* (issue
   * #269). `--flag=false` always worked; this makes the spaced form agree.
   */
  setBooleanFlag(
    this: CommandParser,
    flags: ParsedFlags,
    key: string,
    args: string[],
    nextIndex: number,
  ): number {
    const next = args[nextIndex];
    if (next === 'true' || next === 'false') {
      this.setFlagSafe(flags, key, next === 'true');
      return nextIndex + 1;
    }
    this.setFlagSafe(flags, key, true);
    return nextIndex;
  },

  parseValue(this: CommandParser, value: string): string | number | boolean {
    // Boolean
    if (value.toLowerCase() === 'true') return true;
    if (value.toLowerCase() === 'false') return false;

    // Number — only coerce if the string is unambiguously a canonical number.
    // The previous code coerced any numeric-looking string, which silently
    // dropped leading zeros ("00042" → 42), mangled IDs/tokens above
    // Number.MAX_SAFE_INTEGER, and could cause tenant/identity mix-ups when
    // downstream consumers strict-equal-compared against stored strings.
    if (value.trim() !== '' && /^-?(0|[1-9]\d*)(\.\d+)?([eE][+-]?\d+)?$/.test(value)) {
      const num = Number(value);
      if (
        (Number.isFinite(num) && Number.isSafeInteger(num)) ||
        (!Number.isInteger(num) && Number.isFinite(num))
      ) {
        return num;
      }
    }

    // String
    return value;
  },

  normalizeKey(this: CommandParser, key: string): string {
    // Convert kebab-case to camelCase
    return key.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
  },
};
