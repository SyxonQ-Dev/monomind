/**
 * Cline runner helpers (monomind#382): tool mapping, stream parsing, the
 * history match, the hub-daemon finder and the ACP auth env.
 */
import { describe, expect, it } from 'vitest';
import { acpEnv, providerKeyEnv, rowUsage } from '../../src/orgrt/cline-runner-acp.js';
import { matchHistoryRow, turnHubDaemons } from '../../src/orgrt/cline-runner-host.js';
import { ClineJsonParser, parseAcpUpdate, stderrErrorMessage } from '../../src/orgrt/cline-runner-parse.js';
import { acpToolName, clineCanonicalTool, ClineToolCalls } from '../../src/orgrt/cline-runner-tools.js';
import { fakeHost, fixture } from './cline/fake-cline.js';

describe('clineCanonicalTool', () => {
  it.each([
    ['run_commands', { commands: ['ls', { command: 'git', args: ['log', '-1 x'] }] }, 'shell', { command: 'ls\ngit log "-1 x"' }],
    ['run_commands', { commands: 'cat f' }, 'shell', { command: 'cat f' }],
    ['editor', { path: 'a.ts', new_text: 'x' }, 'write', { file_path: 'a.ts', content: 'x' }],
    ['editor', { path: 'a.ts', old_text: 'a', new_text: 'b' }, 'edit', { file_path: 'a.ts', old_string: 'a', new_string: 'b' }],
    ['editor', { path: 'a.ts', new_text: 'b', insert_line: 3 }, 'patch', { files: [{ file_path: 'a.ts', action: 'update' }] }],
    ['read_files', { files: [{ path: 'a' }] }, 'read', { file_path: 'a' }],
    ['read_files', { file_paths: ['a', 'b'] }, 'read', { file_path: 'a', file_paths: ['a', 'b'] }],
    ['search_codebase', { queries: ['foo'] }, 'search', { pattern: 'foo' }],
    ['search_codebase', { queries: ['a', 'b'] }, 'search', { pattern: '(?:a)|(?:b)' }],
    ['fetch_web_content', { requests: [{ url: 'https://x', prompt: 'p' }] }, 'web', { url: 'https://x' }],
    ['spawn_agent', { task: 't' }, 'task', { task: 't' }],
    ['team_run_task', { task: 't' }, 'task', { task: 't' }],
    ['ask_question', { q: 1 }, 'other', { q: 1 }],
    ['submit_and_exit', {}, 'other', {}],
  ])('%s %j → %s', (name, input, kind, canonical) => {
    expect(clineCanonicalTool(name, input)).toEqual({ kind, input: canonical });
  });

  it('maps apply_patch and mcp tools through the shared table', () => {
    const patch = '*** Begin Patch\n*** Add File: n.txt\n+hi\n*** End Patch';
    expect(clineCanonicalTool('apply_patch', { input: patch }).kind).toBe('patch');
    expect(clineCanonicalTool('mcp__monomind__memory_search', { q: 'x' }).kind).toBe('mcp');
  });

  it('names ACP tool calls by their ACP kind', () => {
    expect(acpToolName('execute', { commands: 'ls' }, 'run_commands: ls')).toBe('run_commands');
    expect(acpToolName('edit', { path: 'a', new_text: 'b' }, '')).toBe('editor');
    expect(acpToolName('edit', { input: '*** Begin Patch' }, '')).toBe('apply_patch');
    expect(acpToolName('other', {}, 'skills')).toBe('skills');
  });
});

describe('ClineToolCalls', () => {
  it('pairs on the call id and flags a failed operation', () => {
    const t = new ClineToolCalls();
    expect(t.start('c1', 'run_commands', { commands: 'false' })?.kind).toBe('shell');
    const [end] = t.end('c1', 'run_commands', [{ query: 'false', result: '', error: 'exit 1', success: false }], undefined);
    expect(end).toMatchObject({ type: 'tool_result', tool_use_id: 'c1', is_error: true, text: 'exit 1' });
  });

  it('synthesizes the start of an end that arrives alone', () => {
    const msgs = new ClineToolCalls().end('c9', 'read_files', 'body', 'boom');
    expect(msgs.map((m) => [m.type, m.tool_use_id])).toEqual([
      ['tool_use', 'c9'],
      ['tool_result', 'c9'],
    ]);
    expect(msgs[1]).toMatchObject({ is_error: true, text: 'boom' });
  });
});

describe('ClineJsonParser', () => {
  it('reads the live success stream: one text block, usage totals, the result', () => {
    const p = new ClineJsonParser();
    const texts: string[] = [];
    let usage;
    let result;
    const iterations: number[] = [];
    for (const l of fixture('json-success.ndjson')) {
      const r = p.feed(l);
      for (const e of r.events) if (e.kind === 'text') texts.push(e.text);
      if (r.usage) usage = r.usage;
      if (r.result) result = r.result;
      if (r.iteration !== undefined) iterations.push(r.iteration);
    }
    expect(texts).toEqual(['done']);
    expect(iterations).toEqual([1, 2, 3]);
    expect(usage).toEqual({ inputTokens: 19305, outputTokens: 201, cacheReadTokens: 0, cacheWriteTokens: 0, totalCost: 0 });
    expect(result).toMatchObject({ finishReason: 'completed', text: 'done' });
  });

  it('takes the unrecoverable error of the live provider failure', () => {
    const p = new ClineJsonParser();
    const errors = fixture('json-provider-error.ndjson').map((l) => p.feed(l).error).filter(Boolean);
    expect(errors).toEqual(['Provider returned error']);
  });

  it('ignores a subagent\'s text, iterations and usage', () => {
    const p = new ClineJsonParser();
    const ev = (e: object) => JSON.stringify({ type: 'agent_event', event: { parentAgentId: 'a1', ...e } });
    expect(p.feed(ev({ type: 'iteration_start', iteration: 9 })).iteration).toBeUndefined();
    expect(p.feed(ev({ type: 'usage', totalInputTokens: 5 })).usage).toBeUndefined();
    p.feed(ev({ type: 'content_start', contentType: 'text', text: 'sub' }));
    const out: unknown[] = [];
    p.flush(out as never);
    expect(out).toEqual([]);
  });

  it('reads the JSON diagnostic cline prints on stderr', () => {
    expect(stderrErrorMessage('noise\n{"ts":"t","type":"error","message":"boom"}\n')).toBe('boom');
  });

  it('parses ACP updates', () => {
    expect(parseAcpUpdate({ sessionUpdate: 'tool_call_update', toolCallId: 'x', status: 'in_progress' })).toEqual({});
    expect(parseAcpUpdate({ sessionUpdate: 'tool_call_update', toolCallId: 'x', status: 'failed', rawOutput: 'e' })).toEqual({
      toolEnd: { id: 'x', failed: true, output: 'e' },
    });
  });
});

describe('matchHistoryRow', () => {
  const since = Date.parse('2026-09-29T09:12:29Z');
  const row = (o: object) => ({ sessionId: 's', cwd: '/w', startedAt: '2026-09-29T09:12:30Z', ...o });

  it('matches a hub-run row by its wrapped prompt over a stale pid', () => {
    const rows = [
      row({ sessionId: 'other', prompt: 'Complete the task below.\n\nB', pid: 7 }),
      row({ sessionId: 'mine', prompt: '<user_input mode="act">Complete the task below.\n\nA</user_input>', pid: 99 }),
    ];
    expect(matchHistoryRow(rows, { cwd: '/w', prompt: 'Complete the task below.\n\nA', pid: 7, sinceMs: since })?.sessionId).toBe('mine');
  });

  it('skips subagents, other cwds and older rows', () => {
    const rows = [
      row({ isSubagent: true }),
      row({ cwd: '/elsewhere' }),
      row({ startedAt: '2026-09-29T08:00:00Z' }),
    ];
    expect(matchHistoryRow(rows, { cwd: '/w', prompt: 'x', sinceMs: since })).toBeUndefined();
  });
});

describe('turnHubDaemons', () => {
  it('finds a new hub-lock daemon and leaves one that predates the turn', () => {
    const host = fakeHost();
    host.hubLockPids = () => [10, 11];
    host.cmdline = () => 'cline --cline-hub-daemon';
    expect(turnHubDaemons(host, 'm', '/d', new Set([10]))).toEqual([11]);
  });
});

describe('ACP auth env', () => {
  it('fills CLINE_API_KEY from the provider key variable', () => {
    expect(acpEnv({ OPENROUTER_API_KEY: 'k' }, 'openrouter', 'm/x:free')).toEqual({
      env: { OPENROUTER_API_KEY: 'k', CLINE_PROVIDER: 'openrouter', CLINE_MODEL: 'm/x:free', CLINE_API_KEY: 'k' },
    });
  });

  it('relies on the stored sign-in for cline\'s own providers', () => {
    expect(acpEnv({}, 'cline', undefined)).toEqual({ env: { CLINE_PROVIDER: 'cline' } });
  });

  it('keeps an explicit CLINE_API_KEY', () => {
    expect(acpEnv({ CLINE_API_KEY: 'c', ANTHROPIC_API_KEY: 'a' }, 'anthropic', undefined)).toMatchObject({
      env: { CLINE_API_KEY: 'c' },
    });
  });

  it('names provider key variables', () => {
    expect(providerKeyEnv('openai-native')).toEqual(['OPENAI_API_KEY']);
    expect(providerKeyEnv('deepseek')).toEqual(['DEEPSEEK_API_KEY']);
  });

  it('reads a history row\'s cumulative usage', () => {
    expect(rowUsage({ sessionId: 's', metadata: { totalCost: 0.2, usage: { inputTokens: 3, outputTokens: 4 } } })).toEqual({
      inputTokens: 3,
      outputTokens: 4,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      totalCost: 0.2,
    });
  });
});
