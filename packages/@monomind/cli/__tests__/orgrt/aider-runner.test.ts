/**
 * AiderAgentRunner (monoes/monomind#383) over fixture streams. The shim
 * fixtures are real monomind_aider_shim.py output captured with aider 0.86.2
 * (model replies from litellm's mock_response, text chunks trimmed); the
 * plain-CLI lines are real aider 0.86.2 output for an invalid key.
 */
import * as cp from 'node:child_process';
import { EventEmitter } from 'node:events';
import { chmodSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import type { AgentMessage, AgentRunArgs } from '../../src/orgrt/agent-runner.js';
import { AIDER_FALLBACK_NOTICE, AiderAgentRunner } from '../../src/orgrt/aider-runner.js';
import { resolveAiderPython, shebangPython } from '../../src/orgrt/aider-runner-resolve.js';
import { parseCliLine, parseTokenCount } from '../../src/orgrt/aider-runner-stream.js';
import { classifyStderr } from '../../src/orgrt/kimicode-runner.js';

vi.mock('node:child_process', () => ({ spawn: vi.fn() }));

function mockChild(lines: string[], exitCode = 0, error?: NodeJS.ErrnoException): cp.ChildProcess {
  const child = new EventEmitter() as any;
  child.stdin = { write: vi.fn(), end: vi.fn(), on: vi.fn() };
  child.stdout = new EventEmitter();
  child.stdout[Symbol.asyncIterator] = async function* () {
    if (error) {
      setTimeout(() => child.emit('error', error), 0);
      return;
    }
    for (const line of lines) yield Buffer.from(`${line}\n`);
  };
  child.stderr = new EventEmitter();
  child.kill = vi.fn();
  child.exitCode = exitCode;
  if (!error) setTimeout(() => child.emit('close', exitCode), 5);
  return child as cp.ChildProcess;
}

const j = JSON.stringify;
const SID = 'aec29f1b635d45eaa2aace0c9ccf4cf7';
const W = '/w';
const head = (sid = SID) => [
  j({ session_id: sid, resumed: false, type: 'session' }),
  j({ message: 'aider: MCP servers are not supported on this runtime', type: 'status' }),
];
const texts = (...t: string[]) => t.map((text) => j({ text, type: 'text' }));
const FULL = [
  ...head(),
  ...texts('I will create it with a command.\n', '\n```bash\necho ran > ran.txt\n```\n'),
  j({
    id: 'aider-1',
    name: 'edit_file',
    kind: 'edit',
    input: { file_path: `${W}/a.txt`, old_string: 'one\n', new_string: 'two\n' },
    type: 'tool_start',
  }),
  j({ id: 'aider-1', ok: true, output: '', type: 'tool_end' }),
  j({
    id: 'aider-2',
    name: 'run_shell_command',
    kind: 'shell',
    input: { command: 'echo ran > ran.txt', cwd: W },
    type: 'tool_start',
  }),
  j({ id: 'aider-2', ok: true, output: '', exit_code: 0, type: 'tool_end' }),
  j({ input_tokens: 2386, output_tokens: 37, cost_usd: 0.0061, type: 'usage' }),
  j({ stop_reason: 'end_turn', text: '…', type: 'result' }),
];
const SCOPED = [
  ...head('0957517e78fc42fd8aa170a718ce5ff9'),
  ...texts('I will create it with a command.\n'),
  j({
    id: 'aider-1',
    name: 'run_shell_command',
    kind: 'shell',
    input: { command: 'echo ran > ran.txt' },
    type: 'tool_start',
  }),
  j({ id: 'aider-1', ok: false, output: 'declined: shell commands need --access full', type: 'tool_end' }),
  j({ input_tokens: 2386, output_tokens: 19, cost_usd: 0.0, type: 'usage' }),
  j({ stop_reason: 'end_turn', text: '…', type: 'result' }),
];
const AUTH = [
  ...head('d50955380cd14f39b888fffcc026f2d2'),
  j({ input_tokens: 0, output_tokens: 0, cost_usd: 0.0, type: 'usage' }),
  j({
    code: 'auth',
    message: 'AuthenticationError: litellm.AuthenticationError: AuthenticationError: invalid x-api-key',
    type: 'error',
  }),
];
const CLI_AUTH = [
  'Aider v0.86.2',
  'Main model: gpt-4o with diff edit format',
  'Weak model: gpt-4o-mini',
  'Git repo: .git with 0 files',
  'Repo-map: using 4096 tokens, auto refresh',
  'https://aider.chat/HISTORY.html#release-notes',
  'litellm.AuthenticationError: AuthenticationError: OpenAIException - Incorrect ',
  'API key provided: sk-inval***test. You can find your API key at ',
];

const SHIM = fileURLToPath(import.meta.url);
const stateDir = mkdtempSync(join(tmpdir(), 'aider-runner-test-'));

function args(extra: Partial<AgentRunArgs> = {}): AgentRunArgs {
  return {
    tools: [],
    prompt: (async function* () {
      yield 'go';
    })(),
    systemPrompt: 'SYS',
    cwd: W,
    env: {},
    maxTurns: 5,
    ...extra,
  };
}

function runner(python: string | null = '/py/python') {
  return new AiderAgentRunner({ aiderBin: '/bin/aider', python, shimPath: SHIM, stateDir });
}

async function collect(extra: Partial<AgentRunArgs> = {}, python: string | null = '/py/python') {
  const out: AgentMessage[] = [];
  for await (const m of runner(python).run(args(extra))) out.push(m);
  return out;
}

const call = (i: number) => vi.mocked(cp.spawn).mock.calls[i];
const request = (i: number) => {
  const child = vi.mocked(cp.spawn).mock.results[i].value as any;
  return JSON.parse(child.stdin.write.mock.calls[0][0]);
};

describe('AiderAgentRunner (shim)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('runs the shim with aider’s interpreter and maps edit + shell to matched tool activity', async () => {
    vi.mocked(cp.spawn).mockReturnValue(mockChild(FULL));
    const msgs = await collect({ access: 'full', effort: 'high', model: 'gpt-4o' });
    expect(call(0)[0]).toBe('/py/python');
    expect(call(0)[1]).toEqual(['-u', SHIM]);
    const req = request(0);
    expect(req).toMatchObject({
      access: 'full',
      settings: false,
      effort: 'high',
      model: 'gpt-4o',
      max_turns: 5,
      cwd: W,
      state_dir: stateDir,
    });
    expect(req.session_id).toBeUndefined();
    expect(req.prompt.startsWith('SYS')).toBe(true);

    const starts = msgs.filter((m) => m.type === 'tool_use');
    expect(starts).toEqual([
      expect.objectContaining({
        tool_use_id: 'aider-1',
        tool: 'edit_file',
        kind: 'edit',
        input: { file_path: '/w/a.txt', old_string: 'one\n', new_string: 'two\n' },
        session_id: SID,
      }),
      expect.objectContaining({ tool_use_id: 'aider-2', kind: 'shell', input: { command: 'echo ran > ran.txt', cwd: W } }),
    ]);
    const ends = msgs.filter((m) => m.type === 'tool_result');
    expect(ends[0]).toMatchObject({ tool_use_id: 'aider-1', is_error: false });
    expect(ends[0]).not.toHaveProperty('exit_code');
    expect(ends[1]).toMatchObject({ tool_use_id: 'aider-2', is_error: false, exit_code: 0 });
    expect(msgs.find((m) => m.type === 'status')?.text).toMatch(/MCP servers are not supported/);
    expect(msgs.filter((m) => m.type === 'assistant').map((m) => m.text)).toEqual([
      'I will create it with a command.\n\n```bash\necho ran > ran.txt\n```',
    ]);
    expect(msgs.at(-1)).toEqual({
      type: 'result',
      session_id: SID,
      subtype: 'success',
      input_tokens: 2386,
      output_tokens: 37,
      cost_usd: 0.0061,
    });
  });

  it('streams text chunks as they arrive for agent exec (includePartialMessages)', async () => {
    vi.mocked(cp.spawn).mockReturnValue(mockChild(FULL));
    const msgs = await collect({ extras: { includePartialMessages: true } });
    const chunks = msgs.filter((m) => m.type === 'assistant').map((m) => m.text);
    expect(chunks.length).toBe(2);
    expect(chunks.join('')).toBe('I will create it with a command.\n\n```bash\necho ran > ran.txt\n```\n');
  });

  it('scoped access sends access:"scoped"; a declined command ends with is_error and no exit code', async () => {
    vi.mocked(cp.spawn).mockReturnValue(mockChild(SCOPED));
    const msgs = await collect({ settingSources: ['user'] });
    expect(request(0)).toMatchObject({ access: 'scoped', settings: true });
    const end = msgs.find((m) => m.type === 'tool_result');
    expect(end).toMatchObject({ is_error: true, text: 'declined: shell commands need --access full' });
    expect(end).not.toHaveProperty('exit_code');
  });

  it('an auth error (shim exit 3) throws a fatal error agent exec classifies as auth', async () => {
    vi.mocked(cp.spawn).mockReturnValue(mockChild(AUTH, 3));
    const err = await collect().catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err.fatal).toBe(true);
    expect(err.message).toContain('invalid x-api-key');
    const cls = classifyStderr(err.message);
    expect(cls.fatal && /auth/i.test(cls.label ?? '')).toBe(true);
  });

  it('a non-zero exit without an error event still fails the turn', async () => {
    vi.mocked(cp.spawn).mockReturnValue(mockChild(head(), 1));
    await expect(collect()).rejects.toThrow(/aider failed \(exit 1\)/);
  });

  it('resume passes the session id and drops the system prompt; a fence round resumes the shim’s session', async () => {
    vi.mocked(cp.spawn).mockReturnValue(mockChild(FULL));
    await collect({ resume: 'old-session' });
    expect(request(0).session_id).toBe('old-session');
    expect(request(0).prompt).toBe('go');

    vi.clearAllMocks();
    const tool = {
      name: 'org_echo',
      description: 'echo',
      schema: { text: z.string() },
      handler: async (a: Record<string, unknown>) => ({ text: String(a.text) }),
    };
    const fence = '```tool_call\n{"name":"org_echo","arguments":{"text":"hi"}}\n```';
    vi.mocked(cp.spawn)
      .mockReturnValueOnce(mockChild([...head('s-1'), ...texts('calling\n', fence), j({ stop_reason: 'end_turn', text: '', type: 'result' })]))
      .mockReturnValueOnce(mockChild([...head('s-1'), ...texts('final'), j({ stop_reason: 'end_turn', text: '', type: 'result' })]));
    const msgs = await collect({ tools: [tool], canUseTool: async () => ({ behavior: 'allow' }) });
    expect(request(0).session_id).toBeUndefined();
    expect(request(1).session_id).toBe('s-1');
    expect(request(1).prompt).toContain('hi');
    const said = msgs.filter((m) => m.type === 'assistant').map((m) => m.text);
    expect(said).toEqual(['calling', 'final']);
  });

  it('a capped reflection loop ends with subtype error_max_turns', async () => {
    vi.mocked(cp.spawn).mockReturnValue(
      mockChild([...head(), ...texts('x'), j({ stop_reason: 'max_turns', text: 'x', type: 'result' })]),
    );
    const msgs = await collect({ maxTurns: 1 });
    expect(request(0).max_turns).toBe(1);
    expect(msgs.at(-1)).toMatchObject({ type: 'result', subtype: 'error_max_turns' });
  });

  it('a shim that cannot import aider (exit 4) falls back to the plain CLI for the same prompt', async () => {
    vi.mocked(cp.spawn)
      .mockReturnValueOnce(mockChild([j({ code: 'import', message: 'no aider', type: 'error' })], 4))
      .mockReturnValueOnce(mockChild(['Hello there', 'Tokens: 2.4k sent, 19 received. Cost: $0.01 message, $0.01 session.']));
    const msgs = await collect();
    expect(call(1)[0]).toBe('/bin/aider');
    expect(msgs.find((m) => m.type === 'status')?.text).toBe(AIDER_FALLBACK_NOTICE);
    expect(msgs.at(-1)).toMatchObject({ type: 'result', subtype: 'success', input_tokens: 2400, cost_usd: 0.01 });
  });

  it('a missing interpreter keeps ENOENT so agent exec reports missing-binary', async () => {
    vi.mocked(cp.spawn).mockReturnValue(mockChild([], 1, Object.assign(new Error('spawn'), { code: 'ENOENT' })));
    const err = await collect().catch((e) => e);
    expect(err.code).toBe('ENOENT');
    expect(err.message).toContain('uv tool install --python 3.12 aider-chat');
  });
});

describe('AiderAgentRunner (plain-CLI fallback)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('runs aider headless, says shell commands will not run, and reports start-only edits + usage', async () => {
    vi.mocked(cp.spawn).mockReturnValue(
      mockChild([
        'Aider v0.86.2',
        'Main model: gpt-4o with diff edit format',
        'Done.',
        'Applied edit to a.txt',
        'Commit 1a2b3c4 feat: update a.txt',
        'Tokens: 2.4k sent, 19 received. Cost: $0.0061 message, $0.0061 session.',
      ]),
    );
    const msgs = await collect({ model: 'gpt-4o', effort: 'xhigh' }, null);
    const [cmd, argv] = call(0) as [string, string[]];
    expect(cmd).toBe('/bin/aider');
    for (const flag of ['--yes-always', '--no-pretty', '--no-stream', '--no-check-update', '--analytics-disable', '--no-fancy-input', '--no-auto-commits', '--no-git']) {
      expect(argv).toContain(flag);
    }
    expect(argv[argv.indexOf('--message-file') + 1].startsWith(stateDir)).toBe(true);
    expect(argv[argv.indexOf('--chat-history-file') + 1].startsWith(stateDir)).toBe(true);
    expect(argv[argv.indexOf('--reasoning-effort') + 1]).toBe('high');
    expect(argv).not.toContain('--restore-chat-history');
    expect(msgs[0]).toEqual({ type: 'status', text: AIDER_FALLBACK_NOTICE });
    const tools = msgs.filter((m) => m.type === 'tool_use');
    expect(tools.map((m) => m.text)).toEqual(['edit_file', 'git_commit']);
    expect(tools.every((m) => m.tool_use_id === undefined)).toBe(true);
    expect(msgs.filter((m) => m.type === 'assistant').map((m) => m.text)).toEqual(['Done.']);
    const result = msgs.at(-1)!;
    expect(result).toMatchObject({ type: 'result', input_tokens: 2400, output_tokens: 19, cost_usd: 0.0061 });
    expect(result.session_id).toMatch(/^[0-9a-f]{32}$/);
  });

  it('resuming restores the chat history of that session', async () => {
    vi.mocked(cp.spawn).mockReturnValue(mockChild(['ok']));
    await collect({ resume: 'sess_1' }, null);
    const argv = call(0)[1] as string[];
    expect(argv).toContain('--restore-chat-history');
    expect(argv[argv.indexOf('--chat-history-file') + 1]).toBe(join(stateDir, 'sess_1.chat.history.md'));
  });

  it('an auth failure the CLI exits 0 on still fails the turn as fatal auth', async () => {
    vi.mocked(cp.spawn).mockReturnValue(mockChild(CLI_AUTH, 0));
    const err = await collect({}, null).catch((e) => e);
    expect(err.fatal).toBe(true);
    expect(classifyStderr(err.message).label).toMatch(/auth/);
  });
});

describe('aider helpers', () => {
  it('parses aider token counts and CLI lines', () => {
    expect(parseTokenCount('2.4k')).toBe(2400);
    expect(parseTokenCount('1.1M')).toBe(1_100_000);
    expect(parseTokenCount('950')).toBe(950);
    expect(parseCliLine('Tokens: 3.1k sent, 1.2k cache write, 250 received.')).toEqual({
      type: 'usage',
      input_tokens: 3100,
      output_tokens: 250,
      cost_usd: 0,
    });
    expect(parseCliLine('Main model: gpt-4o with diff edit format')).toBeUndefined();
  });

  it('finds aider’s interpreter from the entry point’s shebang (absolute and env forms)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'aider-resolve-'));
    const bin = join(dir, 'venv', 'bin');
    mkdirSync(bin, { recursive: true });
    const py = join(bin, 'python3.12');
    writeFileSync(py, '');
    chmodSync(py, 0o755);
    const entry = join(bin, 'aider');
    writeFileSync(entry, `#!${py}\nimport sys\n`);
    const onPath = join(dir, 'path');
    mkdirSync(onPath);
    symlinkSync(entry, join(onPath, 'aider'));
    expect(resolveAiderPython('aider', { PATH: onPath, HOME: dir })).toBe(py);
    expect(shebangPython('#!/usr/bin/env python3.12', bin)).toBe(py);
    expect(shebangPython('#!/bin/sh', bin)).toBeUndefined();
    expect(resolveAiderPython('aider', { PATH: join(dir, 'nowhere'), HOME: dir })).toBeUndefined();
    expect(resolveAiderPython('aider', { MONOMIND_AIDER_PYTHON: py })).toBe(py);
  });
});
