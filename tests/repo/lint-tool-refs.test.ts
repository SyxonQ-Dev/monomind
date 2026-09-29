/**
 * scripts/lint-tool-refs.mjs (GH #421) fails when shipped markdown names an
 * `mcp__monomind__<tool>` the MCP server never registers, when the guidance
 * catalog lists a tool or command that does not exist, or when an agent
 * definition tells the model to run a `monomind <cmd>` the CLI does not have.
 * Every such reference costs the model a failed call. Needs the built CLI.
 */

import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { extractToolRefs, loadMcpToolNames, toolResolves } from '../../scripts/lint-tool-refs.mjs';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCRIPT = join(REPO_ROOT, 'scripts', 'lint-tool-refs.mjs');

describe('lint-tool-refs', () => {
  it('extracts tool names, including prefix wildcards', () => {
    const md = [
      'Call `mcp__monomind__memory_pattern-store` then',
      'mcp__monomind__monograph_*` and mcp__monomind__hooks_pre-task({ x })',
    ].join('\n');
    expect(extractToolRefs(md)).toEqual([
      { name: 'memory_pattern-store', line: 1 },
      { name: 'monograph_*', line: 2 },
      { name: 'hooks_pre-task', line: 2 },
    ]);
  });

  it('resolves against the full MCP registry, not just the advertised core roster', async () => {
    const tools = await loadMcpToolNames(REPO_ROOT);
    expect(toolResolves('monoswarm_init', tools)).toBe(true); // non-core category
    expect(toolResolves('memory_hierarchical-store', tools)).toBe(true);
    expect(toolResolves('monograph_*', tools)).toBe(true);
    expect(toolResolves('swarm_init', tools)).toBe(false);
    expect(toolResolves('memory_usage', tools)).toBe(false);
    expect(toolResolves('hooks_pre_task', tools)).toBe(false); // real name is hooks_pre-task
    expect(toolResolves('nothing_*', tools)).toBe(false);
  });

  it('passes on the repo', () => {
    const run = spawnSync('node', [SCRIPT], { cwd: REPO_ROOT, encoding: 'utf8' });
    expect(run.stderr).toBe('');
    expect(run.stdout).toMatch(/Tool\/command reference lint passed/);
    expect(run.status).toBe(0);
  });
});
