/**
 * Regression coverage: the CLI and the MCP tools must resolve the SAME data root.
 *
 * CLI commands used to build their store paths from `process.cwd()`, while
 * every MCP tool (agent-tools.ts, task-tools.ts, ...) resolves through
 * `getMonomindDataRoot()` — which, inside a git repo, is `<repo>/.git/monomind`.
 * The two only coincide when there is no `.git` at all, so these tests run in a
 * tmpdir with a real `.git` DIRECTORY — the only configuration in which a
 * divergence is observable. They use the real filesystem and the real
 * in-process MCP tool handlers; nothing about the store layer is mocked.
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { listCommand, spawnCommand } from '../commands/agent-lifecycle.js';
import { getMonomindDataRoot } from '../mcp-tools/types.js';
import { output } from '../output.js';
import type { CommandContext, CommandResult } from '../types.js';

function makeCtx(overrides: Partial<CommandContext> = {}): CommandContext {
  return { args: [], flags: { _: [] }, cwd: process.cwd(), interactive: false, ...overrides };
}

let dir: string;
let originalCwd: () => string;
let writeSpy: ReturnType<typeof vi.spyOn>;
let savedDataDir: string | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'monoswarm-data-root-'));
  // A real .git DIRECTORY — this is what makes getMonomindDataRoot() resolve to
  // <dir>/.git/monomind instead of <dir>/.monomind.
  mkdirSync(join(dir, '.git'), { recursive: true });
  savedDataDir = process.env.MONOMIND_DATA_DIR;
  delete process.env.MONOMIND_DATA_DIR; // must not short-circuit the git resolution
  process.env.MONOMIND_CWD = dir;
  originalCwd = process.cwd;
  process.cwd = () => dir;
  writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
});

afterEach(() => {
  writeSpy.mockRestore();
  process.cwd = originalCwd;
  delete process.env.MONOMIND_CWD;
  if (savedDataDir === undefined) delete process.env.MONOMIND_DATA_DIR;
  else process.env.MONOMIND_DATA_DIR = savedDataDir;
  rmSync(dir, { recursive: true, force: true });
});

describe('data-root agreement between the agent CLI and the MCP tools', () => {
  it('resolves the canonical root under .git/monomind (precondition for the rest)', () => {
    expect(getMonomindDataRoot(dir)).toBe(join(dir, '.git', 'monomind'));
  });

  it('agent spawn writes through the real agent_spawn MCP path into the canonical root', async () => {
    await spawnCommand.action?.(makeCtx({ flags: { type: 'coder', name: 'x', _: [] } }));
    await spawnCommand.action?.(makeCtx({ flags: { type: 'tester', name: 'y', _: [] } }));

    const storePath = join(getMonomindDataRoot(dir), 'agents', 'store.json');
    expect(existsSync(storePath)).toBe(true);
    const onDisk = JSON.parse(readFileSync(storePath, 'utf-8'));
    expect(Object.keys(onDisk.agents)).toHaveLength(2);
    expect(existsSync(join(dir, '.monomind', 'agents', 'store.json'))).toBe(false);
  });
});

describe('agent list ID column', () => {
  it('renders the agentId returned by agent_list instead of a blank cell', async () => {
    const spawned = (await spawnCommand.action?.(
      makeCtx({ flags: { type: 'coder', name: 'x', _: [] } }),
    )) as CommandResult;
    const spawnedId =
      (spawned.data as { agentId?: string; id?: string }).agentId ??
      (spawned.data as { id?: string }).id;
    expect(typeof spawnedId).toBe('string');
    expect(spawnedId).toBeTruthy();

    const tableSpy = vi.spyOn(output, 'printTable').mockImplementation(() => undefined);
    try {
      const result = (await listCommand.action?.(makeCtx())) as CommandResult;
      expect(result.success).toBe(true);
      expect(tableSpy).toHaveBeenCalled();
      const rows = tableSpy.mock.calls[0][0].data as Array<Record<string, unknown>>;
      expect(rows).toHaveLength(1);
      expect(rows[0].id).toBe(spawnedId);
      expect(rows[0].type).toBe('coder');
    } finally {
      tableSpy.mockRestore();
    }
  });
});
