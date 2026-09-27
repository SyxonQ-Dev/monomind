/**
 * CLI flag-validation tests for `--access` (#355), the commands/agent-exec.ts
 * layer (usage errors, exit 2, checked before the engine ever runs). Guard
 * behavior that needs the engine (root refusal, unsupported runtime, --cwd
 * validation) is covered in agent-exec.test.ts against runAgentExec directly.
 */

import { describe, expect, it } from 'vitest';
import { runExec } from '../commands/agent-exec.js';
import type { CommandContext } from '../types.js';

function makeCtx(flags: Record<string, string>): CommandContext {
  return { args: [], flags: { _: [], ...flags }, cwd: process.cwd(), interactive: false };
}

describe('agent exec CLI: --access flag validation', () => {
  it('rejects an unknown --access value, exit 2', async () => {
    const ctx = makeCtx({ runtime: 'claude', prompt: 'hi', access: 'yolo' });
    const code = await runExec(ctx, {});
    expect(code).toBe(2);
  });

  it('--access full combined with --allow-bash-prefix is a usage error, exit 2', async () => {
    const ctx = makeCtx({
      runtime: 'claude',
      prompt: 'hi',
      access: 'full',
      'allow-bash-prefix': 'monomind',
    });
    const code = await runExec(ctx, {});
    expect(code).toBe(2);
  });
});
