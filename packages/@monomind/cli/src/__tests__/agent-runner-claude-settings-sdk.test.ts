/**
 * SDK-options snapshot tests for coder mode (#356), through the real
 * ClaudeAgentRunner (mocked queryFn — no real SDK/CLI calls). Proves:
 *  - the default (`settingSources` unset, matching every existing caller
 *    including session.ts/org runtime) sends the exact pre-#356 options —
 *    this is the "byte-identical default path" the issue requires.
 *  - a non-empty `settingSources` produces the coder-mode options and the
 *    new `status` AgentMessage, gated so it never fires on the default path.
 */

import { describe, expect, it } from 'vitest';
import { ClaudeAgentRunner } from '../orgrt/agent-runner.js';

function makePrompt(text = 'hello') {
  return (async function* () {
    yield {
      type: 'user',
      message: { role: 'user', content: text },
      parent_tool_use_id: null,
      session_id: undefined,
    };
  })();
}

function baseArgs(overrides: Record<string, unknown> = {}) {
  return {
    tools: [],
    prompt: makePrompt(),
    systemPrompt: 'be helpful',
    cwd: '/tmp',
    env: {},
    maxTurns: 5,
    ...overrides,
  } as any;
}

function scriptedStream(messages: any[]) {
  return (async function* () {
    for (const m of messages) yield m;
  })();
}

const successResult = {
  type: 'result',
  session_id: 's1',
  subtype: 'success',
  is_error: false,
  usage: { input_tokens: 1, output_tokens: 1 },
};

describe('ClaudeAgentRunner settingSources SDK options (#356)', () => {
  it('settingSources unset (every pre-#356 caller): byte-identical to the old hard-coded options', async () => {
    let capturedOptions: any;
    const mockQueryFn = (args: any) => {
      capturedOptions = args.options;
      return scriptedStream([successResult]);
    };
    const runner = new ClaudeAgentRunner(mockQueryFn as any);
    const messages: any[] = [];
    for await (const m of runner.run(baseArgs())) messages.push(m);

    expect(capturedOptions.settingSources).toEqual([]);
    expect(capturedOptions.strictMcpConfig).toBe(true);
    expect(capturedOptions.mcpServers).toEqual({ org: expect.anything() });
    expect(capturedOptions.systemPrompt).toBe('be helpful'); // plain string, not a preset object
    // No status events on the default path, ever.
    expect(messages.some((m) => m.type === 'status')).toBe(false);
  });

  it('settingSources: [] explicitly is identical to unset', async () => {
    let capturedOptions: any;
    const mockQueryFn = (args: any) => {
      capturedOptions = args.options;
      return scriptedStream([successResult]);
    };
    const runner = new ClaudeAgentRunner(mockQueryFn as any);
    for await (const _ of runner.run(baseArgs({ settingSources: [] }))) {
      // drain
    }
    expect(capturedOptions.settingSources).toEqual([]);
    expect(capturedOptions.strictMcpConfig).toBe(true);
    expect(capturedOptions.systemPrompt).toBe('be helpful');
  });

  it("settingSources: ['user','project','local'] with no caller tools: relaxed MCP config, preset+append system prompt, no mcpServers override", async () => {
    let capturedOptions: any;
    const mockQueryFn = (args: any) => {
      capturedOptions = args.options;
      return scriptedStream([successResult]);
    };
    const runner = new ClaudeAgentRunner(mockQueryFn as any);
    for await (const _ of runner.run(baseArgs({ settingSources: ['user', 'project', 'local'] }))) {
      // drain
    }
    expect(capturedOptions.settingSources).toEqual(['user', 'project', 'local']);
    expect(capturedOptions.strictMcpConfig).toBe(false);
    expect(capturedOptions.systemPrompt).toEqual({
      type: 'preset',
      preset: 'claude_code',
      append: 'be helpful',
    });
    expect('mcpServers' in capturedOptions).toBe(false);
  });

  it('settingSources non-empty WITH caller tools: the org MCP server is still merged in', async () => {
    let capturedOptions: any;
    const mockQueryFn = (args: any) => {
      capturedOptions = args.options;
      return scriptedStream([successResult]);
    };
    const runner = new ClaudeAgentRunner(mockQueryFn as any);
    const tools = [
      {
        name: 'x',
        description: 'x',
        schema: {},
        handler: async () => ({ text: 'ok' }),
      },
    ];
    for await (const _ of runner.run(baseArgs({ settingSources: ['project'], tools }))) {
      // drain
    }
    expect(capturedOptions.mcpServers).toEqual({ org: expect.anything() });
  });

  it('emits status:initializing immediately, then status:ready from system/init, only when settingSources is non-empty', async () => {
    const mockQueryFn = () =>
      scriptedStream([
        {
          type: 'system',
          subtype: 'init',
          session_id: 's1',
          mcp_servers: [{ name: 'monomind', status: 'connected' }],
        },
        {
          type: 'assistant',
          session_id: 's1',
          message: { content: [{ type: 'text', text: 'hi' }] },
        },
        successResult,
      ]);
    const runner = new ClaudeAgentRunner(mockQueryFn as any);
    const messages: any[] = [];
    for await (const m of runner.run(baseArgs({ settingSources: ['project'] }))) messages.push(m);

    const statuses = messages.filter((m) => m.type === 'status');
    expect(statuses).toHaveLength(2);
    expect(statuses[0]).toMatchObject({ type: 'status', phase: 'initializing' });
    expect(statuses[1]).toMatchObject({
      type: 'status',
      phase: 'ready',
      mcp_servers: [{ name: 'monomind', status: 'connected' }],
    });
  });

  it('a system/init message is silently ignored (no status event) when settingSources is unset — org runtime unchanged', async () => {
    const mockQueryFn = () =>
      scriptedStream([
        { type: 'system', subtype: 'init', session_id: 's1', mcp_servers: [] },
        successResult,
      ]);
    const runner = new ClaudeAgentRunner(mockQueryFn as any);
    const messages: any[] = [];
    for await (const m of runner.run(baseArgs())) messages.push(m);

    expect(messages.some((m) => m.type === 'status')).toBe(false);
  });
});
