/**
 * Test helper (not a test file): a fake Claude Agent SDK `query()` for
 * ClaudeAgentRunner's `queryFn` seam, standing in for the Claude Code CLI.
 *
 * It does what the CLI does with the options the runner passes (checked
 * against Claude Code 2.1.226 for SDK 0.3.226):
 *  - each tool call goes through the programmatic PreToolUse hook, then
 *    `canUseTool` unless `permissionMode` is `bypassPermissions`;
 *  - caller tools (`mcp__org__*`) are called over MCP JSON-RPC on the
 *    in-process `org` server (`options.mcpServers.org.instance`);
 *  - the calls of one assistant message run concurrently only when every one
 *    is concurrency-safe: a read-only native tool, or an MCP tool whose
 *    `annotations.readOnlyHint` is true (the CLI's `isConcurrencySafe`);
 *    otherwise one after another.
 */

export interface FakeToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface FakeToolOutcome extends FakeToolCall {
  denied: boolean;
  text: string;
}

const SAFE_NATIVE = new Set(['Read', 'Grep', 'Glob', 'LS', 'WebFetch', 'WebSearch']);

/** Minimal in-memory MCP client for the SDK's in-process server. */
async function mcpClient(instance: any) {
  let nextId = 1;
  const pending = new Map<number, (r: any) => void>();
  const transport: any = {
    async start() {},
    async close() {},
    async send(msg: any) {
      if (msg.id !== undefined && pending.has(msg.id)) {
        pending.get(msg.id)!(msg);
        pending.delete(msg.id);
      }
    },
  };
  await instance.connect(transport);
  const request = (method: string, params: unknown) =>
    new Promise<any>((resolve) => {
      const id = nextId++;
      pending.set(id, resolve);
      transport.onmessage({ jsonrpc: '2.0', id, method, params });
    });
  await request('initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'fake-claude-cli', version: '1' },
  });
  transport.onmessage({ jsonrpc: '2.0', method: 'notifications/initialized' });
  const listed = await request('tools/list', {});
  const tools = new Map<string, any>(
    (listed.result?.tools ?? []).map((t: any) => [`mcp__org__${t.name}`, t]),
  );
  return {
    tools,
    async call(name: string, args: Record<string, unknown>): Promise<string> {
      const r = await request('tools/call', {
        name: name.replace(/^mcp__org__/, ''),
        arguments: args,
      });
      return r.result?.content?.[0]?.text ?? JSON.stringify(r.error ?? r.result);
    },
  };
}

/**
 * `steps`: one entry per assistant message, each a list of tool calls made
 * in that message. `outcomes` collects what each call returned.
 */
export function fakeClaudeQuery(steps: FakeToolCall[][], finalText = 'done') {
  const outcomes: FakeToolOutcome[] = [];
  const captured: { options?: any } = {};
  const queryFn = (({ options }: { options: any }) => {
    captured.options = options;
    return (async function* () {
      const S = 'sess_fake';
      yield { type: 'system', subtype: 'init', session_id: S };
      const org = options.mcpServers?.org?.instance;
      const client = org ? await mcpClient(org) : null;
      const pre = options.hooks?.PreToolUse?.[0]?.hooks?.[0];
      const runOne = async (c: FakeToolCall): Promise<FakeToolOutcome> => {
        const hook = pre
          ? await pre({
              hook_event_name: 'PreToolUse',
              tool_name: c.name,
              tool_input: c.input,
              tool_use_id: c.id,
            })
          : {};
        if (hook?.hookSpecificOutput?.permissionDecision === 'deny') {
          return { ...c, denied: true, text: hook.hookSpecificOutput.permissionDecisionReason };
        }
        if (options.permissionMode !== 'bypassPermissions' && options.canUseTool) {
          const d = await options.canUseTool(c.name, c.input, { toolUseID: c.id });
          if (d?.behavior === 'deny') return { ...c, denied: true, text: d.message };
        }
        if (c.name.startsWith('mcp__org__') && client) {
          return { ...c, denied: false, text: await client.call(c.name, c.input) };
        }
        return { ...c, denied: false, text: `ran ${c.name}` };
      };
      for (const calls of steps) {
        yield {
          type: 'assistant',
          session_id: S,
          parent_tool_use_id: null,
          message: {
            content: calls.map((c) => ({
              type: 'tool_use',
              id: c.id,
              name: c.name,
              input: c.input,
            })),
          },
        };
        const concurrent = calls.every((c) =>
          c.name.startsWith('mcp__')
            ? client?.tools.get(c.name)?.annotations?.readOnlyHint === true
            : SAFE_NATIVE.has(c.name),
        );
        const results: FakeToolOutcome[] = [];
        if (concurrent) results.push(...(await Promise.all(calls.map(runOne))));
        else for (const c of calls) results.push(await runOne(c));
        outcomes.push(...results);
        yield {
          type: 'user',
          session_id: S,
          parent_tool_use_id: null,
          message: {
            content: results.map((r) => ({
              type: 'tool_result',
              tool_use_id: r.id,
              content: r.text,
              is_error: r.denied,
            })),
          },
        };
      }
      yield {
        type: 'assistant',
        session_id: S,
        parent_tool_use_id: null,
        message: { content: [{ type: 'text', text: finalText }] },
      };
      yield {
        type: 'result',
        session_id: S,
        subtype: 'success',
        is_error: false,
        usage: { input_tokens: 10, output_tokens: 5 },
        total_cost_usd: 0.001,
      };
    })();
  }) as any;
  return { queryFn, outcomes, captured };
}
