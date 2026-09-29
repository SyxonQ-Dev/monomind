/**
 * GH-413: the fallback hook-handler.cjs that `generateHookHandler()` emits
 * used to hard-block the first grep/Grep of a session when a monograph DB
 * existed. It now passes the search and adds a one-time nudge as PreToolUse
 * additionalContext — never for piped greps or non-source paths.
 */

import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { generateHookHandler } from '../src/init/helpers-hook-handler.js';

describe('fallback hook-handler graph gate is a one-time nudge (GH-413)', () => {
  let dir: string;
  let script: string;

  beforeEach(() => {
    dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'fallback-hook-413-')));
    script = path.join(dir, 'hook-handler.cjs');
    fs.writeFileSync(script, generateHookHandler());
    fs.mkdirSync(path.join(dir, '.monomind'));
    fs.writeFileSync(path.join(dir, '.monomind', 'monograph.db'), 'not-empty');
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const run = (event: string, toolName: string, toolInput: Record<string, unknown>) =>
    spawnSync(process.execPath, [script, event], {
      cwd: dir,
      input: JSON.stringify({
        hook_event_name: 'PreToolUse',
        session_id: 'sess-413',
        tool_name: toolName,
        tool_input: toolInput,
      }),
      encoding: 'utf8',
      timeout: 15_000,
    });
  const context = (stdout: string) =>
    stdout.trim() ? JSON.parse(stdout).hookSpecificOutput.additionalContext : '';

  it('passes the first grep (exit 0) and nudges once per session', () => {
    const first = run('pre-bash', 'Bash', { command: 'grep -rn foo src' });
    expect(first.status).toBe(0);
    expect(first.stderr).not.toContain('"decision"');
    expect(context(first.stdout)).toContain('[MONOGRAPH_REMINDER]');

    const second = run('pre-bash', 'Bash', { command: 'grep -rn bar src' });
    expect(second.status).toBe(0);
    expect(context(second.stdout)).toBe('');

    const search = run('pre-search', 'Grep', { pattern: 'baz' });
    expect(search.status).toBe(0);
    expect(context(search.stdout)).toBe('');
  });

  it('never nudges a piped grep or a non-source search, and they keep the nudge', () => {
    for (const command of ['git log | grep foo', 'grep -rn foo node_modules/x', 'grep foo a.log']) {
      const res = run('pre-bash', 'Bash', { command });
      expect(res.status, command).toBe(0);
      expect(context(res.stdout), command).toBe('');
    }
    const glob = run('pre-search', 'Glob', { pattern: '**/*.md' });
    expect(context(glob.stdout)).toBe('');

    const search = run('pre-search', 'Grep', { pattern: 'foo' });
    expect(search.status).toBe(0);
    expect(context(search.stdout)).toContain('[MONOGRAPH_REMINDER]');
  });
});
