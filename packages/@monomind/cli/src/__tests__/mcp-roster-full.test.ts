import { afterAll, describe, expect, it, vi } from 'vitest';

/**
 * MONOMIND_MCP_FULL=1 is read at module load, so set it before importing
 * the client (fresh module graph via vi.resetModules).
 */
describe('MCP roster with MONOMIND_MCP_FULL=1', () => {
  const prev = process.env.MONOMIND_MCP_FULL;
  afterAll(() => {
    if (prev === undefined) delete process.env.MONOMIND_MCP_FULL;
    else process.env.MONOMIND_MCP_FULL = prev;
  });

  it('advertises every registered tool, including the ones hidden by default', async () => {
    process.env.MONOMIND_MCP_FULL = '1';
    vi.resetModules();
    const { listMCPTools, getAllMCPTools } = await import('../mcp-client.js');
    const names = new Set((await listMCPTools()).map((t) => t.name));
    for (const n of [
      'agent_spawn',
      'task_create',
      'system_status',
      'hooks_route',
      'browser_open',
    ]) {
      expect(names.has(n), n).toBe(true);
    }
    expect(names.size).toBe((await getAllMCPTools()).length);
  });
});
