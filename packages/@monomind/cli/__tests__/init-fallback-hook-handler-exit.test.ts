/**
 * GH-446: the fallback hook-handler.cjs that `generateHookHandler()` emits
 * (used when the full helpers can't be copied) ended with an unconditional
 * `process.exit(0)`, overriding the exit code 2 a PreToolUse gate sets to
 * block, so its blocks never reached Claude Code. Since #413 the fallback
 * graph gate only nudges, so the exit-code guarantee is pinned statically.
 */

import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { generateHookHandler } from '../src/init/helpers-hook-handler.js';

describe('fallback hook-handler exit code (GH-446)', () => {
  let dir: string;
  let script: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fallback-hook-446-'));
    script = path.join(dir, 'hook-handler.cjs');
    fs.writeFileSync(script, generateHookHandler());
    // The fallback graph gate only blocks when a monograph DB exists.
    fs.mkdirSync(path.join(dir, '.monomind'));
    fs.writeFileSync(path.join(dir, '.monomind', 'monograph.db'), '');
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const runPreBash = (command: string) =>
    spawnSync(process.execPath, [script, 'pre-bash'], {
      cwd: dir,
      input: JSON.stringify({
        hook_event_name: 'PreToolUse',
        session_id: 'sess-446',
        tool_name: 'Bash',
        tool_input: { command },
      }),
      encoding: 'utf8',
      timeout: 15_000,
    });

  it('keeps a gate-set exit code instead of forcing exit 0', () => {
    // No fallback gate blocks since #413, but a future one must still reach
    // Claude Code: the script has to exit with process.exitCode.
    expect(generateHookHandler()).toContain('process.exit(process.exitCode ?? 0)');
    expect(generateHookHandler()).not.toMatch(/process\.exit\(0\)/);
  });

  it('does not block a source grep (#413: the graph gate is a nudge now)', () => {
    const res = runPreBash('grep -rn foo src');
    expect(res.status).toBe(0);
    expect(res.stderr).not.toContain('"decision":"block"');
  });

  it('exits 0 for a harmless command', () => {
    const res = runPreBash('ls -la');
    expect(res.status).toBe(0);
    expect(res.stderr).toBe('');
  });
});
