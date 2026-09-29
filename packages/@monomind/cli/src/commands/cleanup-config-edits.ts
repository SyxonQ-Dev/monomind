/**
 * In-place edits `monomind cleanup` makes to config files it does not own
 * outright (GH #401). Each function removes only monomind's part of a shared
 * file and returns the new text, or null when there was nothing to remove.
 *
 *  - `.claude/settings.json` / `.gemini/settings.json`: hook entries and a
 *    statusLine whose command runs a helper that cleanup is removing. Left in
 *    place they fail on every prompt and tool call ("Cannot find module
 *    .../hook-handler.cjs").
 *  - `.codex/config.toml`: the `[mcp_servers.monomind]` table.
 *  - `opencode.json`: the bash permission rules init adds for monomind.
 */

import { OPENCODE_MONOMIND_BASH_RULES } from '../init/opencode-generator.js';

type Json = Record<string, unknown>;

const isObject = (v: unknown): v is Json =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** Project-relative helper paths (`.claude/helpers/x.cjs`) a command runs. */
export function helperRefs(command: string): string[] {
  const refs: string[] = [];
  for (const m of command.matchAll(/\.(claude|gemini)\/helpers\/([\w.\-/]+)/g)) {
    refs.push(`.${m[1]}/helpers/${m[2]}`);
  }
  return refs;
}

function renderLike(value: Json, source: string): string {
  const indent = source.match(/\r?\n([\t ]+)"/)?.[1];
  const rendered = JSON.stringify(
    value,
    null,
    indent?.includes('\t') ? '\t' : (indent?.length ?? 2),
  );
  return source.endsWith('\n') ? `${rendered}\n` : rendered;
}

/**
 * Remove every hook entry and the statusLine whose command runs a helper
 * `isGone` reports as removed, then the matcher groups, events and `hooks`
 * key that leaves empty. Everything else — other keys, user hooks — stays.
 * Returns null when nothing changes or the text is not a JSON object.
 */
export function stripDanglingHelperRefs(
  text: string,
  isGone: (rel: string) => boolean,
): string | null {
  let settings: unknown;
  try {
    settings = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isObject(settings)) return null;
  const dangling = (cmd: unknown): boolean =>
    typeof cmd === 'string' && helperRefs(cmd).some(isGone);
  let changed = false;

  if (isObject(settings.statusLine) && dangling(settings.statusLine.command)) {
    delete settings.statusLine;
    changed = true;
  }
  const hooks = settings.hooks;
  if (isObject(hooks)) {
    for (const [event, groups] of Object.entries(hooks)) {
      if (!Array.isArray(groups)) continue;
      const kept = groups.flatMap((group: unknown) => {
        if (!isObject(group) || !Array.isArray(group.hooks)) return [group];
        const entries = group.hooks.filter((h: unknown) => !(isObject(h) && dangling(h.command)));
        if (entries.length === group.hooks.length) return [group];
        changed = true;
        return entries.length ? [{ ...group, hooks: entries }] : [];
      });
      if (kept.length) hooks[event] = kept;
      else delete hooks[event];
    }
    if (Object.keys(hooks).length === 0) delete settings.hooks;
  }
  return changed ? renderLike(settings, text) : null;
}

/** A `[table]` / `[[array]]` header line's name, or null. */
function tomlHeader(line: string): string | null {
  return /^\s*\[\[?\s*([^\]]+?)\s*\]\]?\s*(?:#.*)?$/.exec(line)?.[1] ?? null;
}

/**
 * `.codex/config.toml` text without the `[mcp_servers.monomind]` table (and
 * any `mcp_servers.monomind.*` subtables). Returns null when there is none.
 */
export function stripCodexMcpTable(text: string): string | null {
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((l) => tomlHeader(l) === 'mcp_servers.monomind');
  if (start === -1) return null;
  let end = start + 1;
  while (end < lines.length) {
    const name = tomlHeader(lines[end]!);
    if (name !== null && !name.startsWith('mcp_servers.monomind.')) break;
    if (/^\s*(?:#|\/\/)\s*monomind:start\s/.test(lines[end]!)) break;
    end++;
  }
  const out = [...lines.slice(0, start), ...lines.slice(end)].join('\n');
  return `${out.replace(/\n{3,}/g, '\n\n').trimEnd()}\n`;
}

/**
 * `opencode.json` text without the `permission.bash` rules init adds for
 * monomind (only while they still hold init's value). Returns the text
 * unchanged when there are none; unparseable text is returned as is.
 */
export function stripOpencodeRules(text: string): string {
  let config: unknown;
  try {
    config = JSON.parse(text);
  } catch {
    return text;
  }
  if (!isObject(config) || !isObject(config.permission)) return text;
  const bash = config.permission.bash;
  if (!isObject(bash)) return text;
  let changed = false;
  for (const [rule, action] of Object.entries(OPENCODE_MONOMIND_BASH_RULES)) {
    if (bash[rule] === action) {
      delete bash[rule];
      changed = true;
    }
  }
  return changed ? renderLike(config, text) : text;
}
