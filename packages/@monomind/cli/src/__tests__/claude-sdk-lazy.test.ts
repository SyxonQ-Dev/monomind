/**
 * #428: the Claude Agent SDK is loaded through ensureOptionalDependency at
 * each call site. When it is missing and cannot be installed (offline, or
 * MONOMIND_NO_AUTO_INSTALL), the caller gets the helper's message, never a
 * crash or a bare ERR_MODULE_NOT_FOUND.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const ensure = vi.fn();
vi.mock('../utils/optional-deps.js', async (orig) => ({
  ...(await orig<typeof import('../utils/optional-deps.js')>()),
  ensureOptionalDependency: (...a: unknown[]) => ensure(...a),
}));

const { OptionalDependencyError } = await import('../utils/optional-deps.js');
const { ClaudeAgentRunner } = await import('../orgrt/agent-runner-claude.js');
const { listRuntimeModels } = await import('../orgrt/agent-models.js');

const MESSAGE =
  'The Claude runtime needs @anthropic-ai/claude-agent-sdk@0.3.226, which is not installed, and ' +
  'MONOMIND_NO_AUTO_INSTALL is set. Install it with:\n  npm install --prefix "/h/deps/x" ...';

const runArgs = () =>
  ({
    prompt: 'hi',
    systemPrompt: '',
    tools: [],
    cwd: process.cwd(),
    model: 'haiku',
    maxTurns: 1,
  }) as never;

beforeEach(() => {
  ensure.mockReset();
  ensure.mockRejectedValue(new OptionalDependencyError(MESSAGE));
});

describe('Claude SDK call sites load it lazily', () => {
  it('ClaudeAgentRunner.run() rejects with the install message', async () => {
    const runner = new ClaudeAgentRunner();
    const drain = async () => {
      for await (const _ of runner.run(runArgs())) {
        // nothing is yielded before the SDK loads
      }
    };
    await expect(drain()).rejects.toThrow(MESSAGE);
    expect(ensure).toHaveBeenCalledWith('@anthropic-ai/claude-agent-sdk');
  });

  it('constructing a runner does not load the SDK', () => {
    new ClaudeAgentRunner();
    expect(ensure).not.toHaveBeenCalled();
  });

  it('uses the loaded SDK when queryFn is not injected', async () => {
    const query = vi.fn(() =>
      (async function* () {
        yield { type: 'result', session_id: 's', subtype: 'success', is_error: false };
      })(),
    );
    const runner = new ClaudeAgentRunner(undefined, async () => ({
      query: query as never,
      tool: (() => ({})) as never,
      createSdkMcpServer: (() => ({})) as never,
    }));
    const out: unknown[] = [];
    for await (const m of runner.run(runArgs())) out.push(m);
    expect(query).toHaveBeenCalledOnce();
    expect(ensure).not.toHaveBeenCalled();
  });

  it('`agent models --runtime claude` reports list-failed with the message', async () => {
    const r = await listRuntimeModels('claude', { timeoutMs: 1000 });
    expect(r.supported).toBe(true);
    expect(r.models).toEqual([]);
    expect(r.error).toEqual({ code: 'list-failed', message: MESSAGE });
  });
});
