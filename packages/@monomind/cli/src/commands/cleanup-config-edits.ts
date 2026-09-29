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

import { readFileSync } from 'node:fs';
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

/**
 * The statusLine and hook commands in settings `text` that run a helper
 * `isGone` reports as removed (GH #448: listed when the file is git-tracked
 * and so cannot be edited). Empty when none, or the text is not JSON.
 */
export function danglingHelperCommands(text: string, isGone: (rel: string) => boolean): string[] {
  let settings: unknown;
  try {
    settings = JSON.parse(text);
  } catch {
    return [];
  }
  if (!isObject(settings)) return [];
  const commands: unknown[] = [];
  if (isObject(settings.statusLine)) commands.push(settings.statusLine.command);
  for (const groups of isObject(settings.hooks) ? Object.values(settings.hooks) : []) {
    for (const group of Array.isArray(groups) ? groups : []) {
      if (!isObject(group) || !Array.isArray(group.hooks)) continue;
      for (const h of group.hooks) if (isObject(h)) commands.push(h.command);
    }
  }
  const dangling = commands.filter(
    (c): c is string => typeof c === 'string' && helperRefs(c).some(isGone),
  );
  return [...new Set(dangling)];
}

/**
 * For a git-tracked settings file at `abs`, which cleanup never edits:
 * `covers` matches the helpers directories its dangling commands run (kept
 * whole, since helpers require their siblings) and any parent of them;
 * `notice` is the manual edit that completes the uninstall. Null when no
 * command runs a removed helper.
 */
export function helpersToKeep(
  rel: string,
  abs: string,
  isGone: (rel: string) => boolean,
): { covers: (path: string) => boolean; notice: string } | null {
  let text = '';
  try {
    text = readFileSync(abs, 'utf8');
  } catch {}
  const commands = danglingHelperCommands(text, isGone);
  if (commands.length === 0) return null;
  const roots = [
    ...new Set(
      commands
        .flatMap((c) => helperRefs(c).filter(isGone))
        .map((r) => r.replace(/\/helpers\/.*$/, '/helpers')),
    ),
  ];
  const covers = (path: string) =>
    roots.some((r) => path === r || path.startsWith(`${r}/`) || r.startsWith(`${path}/`));
  const notice =
    `${rel} is tracked by git, so cleanup kept ${roots.join(', ')}, which it runs:\n` +
    commands.map((c) => `    ${c}`).join('\n') +
    `\n  To fully uninstall, delete those hook entries (and the statusLine, if listed) from ${rel}, commit, then re-run cleanup --force.`;
  return { covers, notice };
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
