/**
 * #430: `monomind route task` and the routing MCP tools answer with the
 * central picker's result (pickForTask → rankForTask), so they cannot disagree
 * with `monomind pick` — including when pick has no confident match.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const rankForTask = vi.fn();
const agentCatalog = vi.fn();
const taskSkillCatalog = vi.fn();
const recordRoute = vi.fn(async () => {});

vi.mock('../decision/picks.js', () => ({ rankForTask }));
vi.mock('../decision/catalogs.js', () => ({ agentCatalog, taskSkillCatalog }));
vi.mock('../monovector/route-outcomes.js', async (orig) => ({
  ...(await orig<typeof import('../monovector/route-outcomes.js')>()),
  recordRoute,
}));
vi.mock('../mcp-tools/hooks-embedding.js', async (orig) => ({
  ...(await orig<typeof import('../mcp-tools/hooks-embedding.js')>()),
  getRealSearchFunction: async () => null,
}));

const { pickCommand } = await import('../commands/pick.js');
const { routeCommand } = await import('../commands/route.js');
const { hooksExplain, hooksPreTask, hooksRoute } = await import('../mcp-tools/hooks-routing.js');

const CONFIDENT = {
  agents: {
    method: 'keyword',
    source: 'keyword',
    lowConfidence: false,
    confident: true,
    ranked: [
      { id: 'engineering-security-engineer', name: 'Security Engineer', score: 7 },
      { id: 'coder', name: 'coder', score: 3 },
    ],
  },
  skills: {
    method: 'keyword',
    source: 'keyword',
    lowConfidence: false,
    confident: false,
    ranked: [],
  },
};
const UNCONFIDENT = {
  ...CONFIDENT,
  agents: {
    ...CONFIDENT.agents,
    confident: false,
    ranked: [{ id: 'cro', name: 'CRO Specialist', score: 2 }],
  },
};
const EMPTY = { ...CONFIDENT, agents: { ...CONFIDENT.agents, confident: false, ranked: [] } };

const routeTask = routeCommand.subcommands?.find((c) => c.name === 'task');
let logs: string[] = [];

beforeEach(() => {
  rankForTask.mockReset();
  recordRoute.mockClear();
  agentCatalog.mockReset().mockReturnValue([
    { id: 'engineering-security-engineer', name: 'Security Engineer', category: 'engineering' },
    { id: 'coder', name: 'coder', category: 'core' },
  ]);
  taskSkillCatalog.mockReset().mockReturnValue([]);
  logs = [];
  vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => {
    logs.push(a.join(' '));
  });
});
afterEach(() => vi.restoreAllMocks());

async function capture(run: () => Promise<unknown>): Promise<string> {
  logs = [];
  await run();
  return logs.join('\n');
}

const ctx = (args: string[], flags: Record<string, unknown>) =>
  ({ args, flags, cwd: process.cwd(), interactive: false }) as never;

describe('monomind route task = monomind pick --agents', () => {
  for (const [label, ranking] of [
    ['confident', CONFIDENT],
    ['unconfident', UNCONFIDENT],
    ['empty', EMPTY],
  ] as const) {
    for (const json of [true, false]) {
      it(`prints the same output (${label}, json=${json})`, async () => {
        rankForTask.mockResolvedValue(ranking);
        const picked = await capture(() =>
          pickCommand.action!(ctx([], { task: 'secure the login', agents: true, json })),
        );
        const routed = await capture(() => routeTask!.action!(ctx(['secure the login'], { json })));
        expect(routed).toBe(picked);
        expect(routed.length).toBeGreaterThan(0);
      });
    }
  }

  it('names the agent only when pick is confident', async () => {
    rankForTask.mockResolvedValue(CONFIDENT);
    const yes = await routeTask!.action!(ctx(['secure the login'], { json: true }));
    expect((yes?.data as { agentId: string | null }).agentId).toBe('Security Engineer');
    rankForTask.mockResolvedValue(UNCONFIDENT);
    const no = await routeTask!.action!(ctx(['hello'], { json: true }));
    expect((no?.data as { agentId: string | null }).agentId).toBeNull();
  });

  it('the bare `monomind route "<task>"` form answers the same way', async () => {
    rankForTask.mockResolvedValue(CONFIDENT);
    const picked = await capture(() =>
      pickCommand.action!(ctx([], { task: 'secure the login', agents: true, json: true })),
    );
    const routed = await capture(() =>
      routeCommand.action!(ctx(['secure the login'], { json: true })),
    );
    expect(routed).toBe(picked);
  });
});

describe('routing MCP tools carry the pick verdict', () => {
  it('hooks_route returns the pick ranking and its confidence verdict', async () => {
    rankForTask.mockResolvedValue(UNCONFIDENT);
    const r = (await hooksRoute.handler({ task: 'design a landing page' })) as {
      primaryAgent: { type: string };
      confident: boolean;
      summary: string;
    };
    expect(r.primaryAgent.type).toBe('CRO Specialist');
    expect(r.confident).toBe(false);
    expect(r.summary).toBe('no confident match');

    rankForTask.mockResolvedValue(CONFIDENT);
    const c = (await hooksRoute.handler({ task: 'secure the login' })) as typeof r;
    expect(c).toMatchObject({ confident: true, summary: 'agent: Security Engineer' });
  });

  it('hooks_pre-task only recommends a primary agent pick is confident about', async () => {
    rankForTask.mockResolvedValue(UNCONFIDENT);
    const r = (await hooksPreTask.handler({ taskId: 't', description: 'landing page' })) as {
      recommendations: string[];
      confident: boolean;
    };
    expect(r.confident).toBe(false);
    expect(r.recommendations.join('\n')).not.toContain('as primary agent');
  });

  it('hooks_explain says when pick has no confident match', async () => {
    rankForTask.mockResolvedValue(EMPTY);
    const r = (await hooksExplain.handler({ task: 'hello' })) as { explanation: string };
    expect(r.explanation).toContain('no confident match');
  });
});
