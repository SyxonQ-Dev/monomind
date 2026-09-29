/**
 * `monomind init --target aider`: aider reads `CONVENTIONS.md` only when a
 * `read:` entry names it, so next to the adapter's CONVENTIONS.md this adds
 * `CONVENTIONS.md` to `.aider.conf.yml`'s `read:` list — merged into an
 * existing file, never overwriting it (https://aider.chat/docs/usage/conventions.html).
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { atomicWriteFile } from './fs-helpers.js';
import type { InitOptions, InitResult } from './types.js';

const CONF = '.aider.conf.yml';
const ENTRY = 'CONVENTIONS.md';

/**
 * `text` with `CONVENTIONS.md` in its top-level `read:` value: unchanged when
 * already there, appended as a new key when absent, added to a scalar, flow
 * (`[a, b]`) or block (`- a`) list. `null` when the value has a shape this
 * cannot edit safely (comments, quotes with separators, nested maps).
 */
export function mergeAiderRead(text: string): string | null {
  const lines = text.split('\n');
  const at = lines.findIndex((l) => /^read:/.test(l));
  if (at === -1) {
    const body = text.length === 0 || text.endsWith('\n') ? text : `${text}\n`;
    return `${body}read: [${ENTRY}]\n`;
  }
  const value = lines[at].slice('read:'.length).trim();
  if (value === '') {
    // Block list: `- item` lines right below, at one indentation.
    let end = at + 1;
    let indent: string | null = null;
    while (end < lines.length) {
      const m = /^(\s*)-\s+(.*)$/.exec(lines[end]);
      if (!m || (indent !== null && m[1] !== indent)) break;
      indent = m[1];
      if (m[2].replace(/^['"]|['"]$/g, '').trim() === ENTRY) return text;
      end++;
    }
    if (indent === null) return null;
    lines.splice(end, 0, `${indent}- ${ENTRY}`);
    return lines.join('\n');
  }
  if (value.includes('#')) return null;
  const flow = /^\[(.*)\]$/.exec(value);
  const items = flow
    ? flow[1]
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
    : [value];
  if (items.some((i) => /[[\]{}]/.test(i) || (!flow && i.includes(',')))) return null;
  if (items.some((i) => i.replace(/^['"]|['"]$/g, '') === ENTRY)) return text;
  lines[at] = `read: [${[...items, ENTRY].join(', ')}]`;
  return lines.join('\n');
}

export async function writeAiderConf(
  targetDir: string,
  options: InitOptions,
  result: InitResult,
): Promise<void> {
  const file = path.join(targetDir, CONF);
  if (!fs.existsSync(file)) {
    atomicWriteFile(file, `read: [${ENTRY}]\n`);
    result.created.files.push(CONF);
    return;
  }
  if (options.ifMissing) {
    result.skipped.push(CONF);
    return;
  }
  const current = fs.readFileSync(file, 'utf8');
  const merged = mergeAiderRead(current);
  if (merged === null) {
    result.skipped.push(CONF);
    (result.warnings ??= []).push(
      `${CONF}: its read: value could not be merged safely; add ${ENTRY} to it so aider loads the monomind conventions`,
    );
    return;
  }
  if (merged === current) {
    result.skipped.push(CONF);
    return;
  }
  atomicWriteFile(file, merged);
  result.updated.push(`${CONF} (read: ${ENTRY})`);
}
