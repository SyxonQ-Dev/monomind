/**
 * DshAgentRunner (DeepSeek Harness, monomind#384) driven by a fake spawn.
 *
 * Fixture provenance (dsh 0.1.7-rc.2, scratch HOME, 2026-09-29):
 *   - MISSING_CREDENTIAL, unknown session, cwd refusal: live captures, no key.
 *   - SUCCESS / FS_TOOLS / SCOPED: the real dsh talking to a local mock of
 *     the DeepSeek Messages API (DEEPSEEK_BASE_URL) — dsh's own events, tool
 *     executions and results; only the model replies were scripted.
 * Paths are shortened to /w.
 */
import * as cp from 'node:child_process';
import { EventEmitter } from 'node:events';
import * as fs from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import type { AgentMessage, AgentRunArgs } from '../../src/orgrt/agent-runner.js';
import { DshAgentRunner } from '../../src/orgrt/dsh-runner.js';

vi.mock('node:child_process', () => ({ spawn: vi.fn(), execFile: vi.fn(), spawnSync: vi.fn() }));

const SID = 'session-1ea44fe6-3134-432d-bee7-bfea7c76081d';
const SUCCESS = [
  `{"type":"session","sessionId":"${SID}","cwd":"/w"}`,
  '{"type":"status","phase":"turn_start","turn":1}',
  '{"type":"status","phase":"step_start","turn":1,"step":1}',
  '{"type":"thinking","text":"I will run a command."}',
  '{"type":"text","text":"Running it."}',
  '{"type":"tool_call","callId":"toolu_1","tool":"bash","input":{"command":"echo hi > f.txt && cat f.txt","description":"write a file"}}',
  '{"type":"tool_result","callId":"toolu_1","status":"completed","result":"hi\\n"}',
  '{"type":"status","phase":"step_end","turn":1,"step":1,"usage":{"inputTokens":101,"outputTokens":21,"cacheReadTokens":10,"totalTokens":132}}',
  '{"type":"status","phase":"step_start","turn":1,"step":2}',
  '{"type":"tool_call","callId":"toolu_2","tool":"str_replace_editor","input":{"command":"view","path":"/nonexistent/x.txt"}}',
  '{"type":"tool_result","callId":"toolu_2","status":"error","result":"Error: unknown tool \\"str_replace_editor\\""}',
  '{"type":"tool_call","callId":"toolu_3","tool":"bash","input":{"command":"exit 3","description":"fail"}}',
  '{"type":"tool_result","callId":"toolu_3","status":"completed","result":"(no output)\\n[exit code: 3]"}',
  '{"type":"status","phase":"step_end","turn":1,"step":2,"usage":{"inputTokens":103,"outputTokens":23,"cacheReadTokens":10,"totalTokens":136}}',
  '{"type":"status","phase":"step_start","turn":1,"step":3}',
  '{"type":"text","text":"done"}',
  '{"type":"status","phase":"step_end","turn":1,"step":3,"usage":{"inputTokens":104,"outputTokens":24,"cacheReadTokens":10,"totalTokens":138}}',
  '{"type":"status","phase":"turn_end","turn":1,"reason":{"kind":"completed"}}',
  '{"type":"final","text":"done"}',
];
const FS_TOOLS = [
  `{"type":"session","sessionId":"${SID}","cwd":"/w"}`,
  '{"type":"status","phase":"turn_start","turn":3}',
  '{"type":"status","phase":"step_start","turn":3,"step":1}',
  '{"type":"tool_call","callId":"toolu_r1","tool":"read","input":{"file_path":"f.txt"}}',
  '{"type":"tool_result","callId":"toolu_r1","status":"completed","result":"<path>/w/f.txt</path>\\n<type>file</type>\\n<content>\\n1: hi\\n\\n(End of file - total 1 lines)\\n</content>"}',
  '{"type":"tool_call","callId":"toolu_e1","tool":"edit","input":{"file_path":"f.txt","old_string":"hi","new_string":"hello"}}',
  '{"type":"tool_result","callId":"toolu_e1","status":"completed","result":"The file /w/f.txt has been updated successfully."}',
  '{"type":"tool_call","callId":"toolu_w1","tool":"write","input":{"file_path":"g.txt","content":"new file\\n"}}',
  '{"type":"tool_result","callId":"toolu_w1","status":"completed","result":"<path>/w/g.txt</path>\\n<type>file</type>\\n<content>\\nCreated file\\n</content>"}',
  '{"type":"tool_call","callId":"toolu_g1","tool":"grep","input":{"pattern":"hello","path":"."}}',
  '{"type":"tool_result","callId":"toolu_g1","status":"completed","result":"Found 1 matches\\n\\n./f.txt\\nLine 1: hello"}',
  '{"type":"tool_call","callId":"toolu_t1","tool":"todo_write","input":{"todos":[{"content":"finish","status":"in_progress"}]}}',
  '{"type":"tool_result","callId":"toolu_t1","status":"completed","result":"Updated todo list: 0 pending, 1 in progress, 0 completed."}',
  '{"type":"status","phase":"step_end","turn":3,"step":1,"usage":{"inputTokens":101,"outputTokens":21,"cacheReadTokens":10,"totalTokens":132}}',
  '{"type":"status","phase":"step_start","turn":3,"step":2}',
  '{"type":"text","text":"done"}',
  '{"type":"status","phase":"step_end","turn":3,"step":2,"usage":{"inputTokens":102,"outputTokens":22,"cacheReadTokens":10,"totalTokens":134}}',
  '{"type":"status","phase":"turn_end","turn":3,"reason":{"kind":"completed"}}',
  '{"type":"final","text":"done"}',
];
const MISSING_CREDENTIAL = [
  '{"type":"session","sessionId":"session-263f9353-d45f-457f-9b14-ae2fb3a1e453","cwd":"/w"}',
  '{"type":"status","phase":"turn_start","turn":1}',
  '{"type":"status","phase":"step_start","turn":1,"step":1}',
  '{"type":"status","phase":"step_end","turn":1,"step":1}',
  '{"type":"status","phase":"turn_end","turn":1,"reason":{"kind":"error","error":{"message":"llm-deepseek: no API key for provider route \\"deepseek-official\\"; store DEEPSEEK_API_KEY through the credentials service (the web Models page writes it), or export DEEPSEEK_API_KEY in the launching environment","code":"MISSING_CREDENTIAL"}}}',
  '{"type":"final","text":""}',
];
// Free model over the pi-ai adapter: the real dsh against a local
// OpenAI-compatible mock standing in for OpenRouter (no key available).
const FREE_SUCCESS = [
  '{"type":"session","sessionId":"session-2a1b329b-d689-4378-bdb6-62b98ed5cadb","cwd":"/w"}',
  '{"type":"status","phase":"turn_start","turn":1}',
  '{"type":"status","phase":"step_start","turn":1,"step":1}',
  '{"type":"text","text":"hello from free model"}',
  '{"type":"status","phase":"step_end","turn":1,"step":1,"usage":{"inputTokens":120,"outputTokens":7,"totalTokens":127}}',
  '{"type":"status","phase":"turn_end","turn":1,"reason":{"kind":"completed"}}',
  '{"type":"final","text":"hello from free model"}',
];
// Live captures, same setup: no OPENROUTER_API_KEY, and an effort the model lacks.
const FREE_NO_KEY = [
  FREE_SUCCESS[0],
  '{"type":"status","phase":"turn_end","turn":1,"reason":{"kind":"error","error":{"message":"llm-pi-ai: no credential for provider route \\"openrouter\\"; its profile resolves OPENROUTER_API_KEY, which is not set — store OPENROUTER_API_KEY through the credentials service (the web Models page writes it) or export it, and remove apiKeyEnv only if this provider should authenticate from pi-ai\'s own environment discovery","code":"MISSING_CREDENTIAL"}}}',
  '{"type":"final","text":""}',
];
const FREE_BAD_EFFORT = [
  FREE_SUCCESS[0],
  '{"type":"status","phase":"turn_end","turn":1,"reason":{"kind":"error","error":{"message":"provider \\"openrouter\\" model \\"z-ai/glm-5.2:free\\" does not support reasoning effort \\"minimal\\"","code":"UNSUPPORTED_REASONING_EFFORT"}}}',
  '{"type":"final","text":""}',
];
const CWD_REFUSAL = [
  '{"type":"error","message":"session \\"session-263f9353-d45f-457f-9b14-ae2fb3a1e453\\" was recorded in \\"/home/u/a\\", not \\"/w\\""}',
];
const NO_SESSION = [
  '{"type":"error","message":"session \\"nope\\" does not exist; omit --session-id to start a new Session"}',
];
const DUMP = [
  '# == @deepseek-ai/dsh-base',
  '- id: agent-default-model',
  "  name: '@deepseek-ai/dsh-agent-default-model'",
  '  config:',
  '    provider: deepseek-official',
  '    model: deepseek-flash',
  '- id: jobs',
].join('\n');

function mockChild(lines: string[], exitCode = 0, stderr = ''): cp.ChildProcess {
  const child = new EventEmitter() as any;
  child.stdout = new EventEmitter();
  child.stdout[Symbol.asyncIterator] = async function* () {
    if (stderr) child.stderr.emit('data', Buffer.from(stderr));
    for (const line of lines) yield Buffer.from(`${line}\n`);
  };
  child.stderr = new EventEmitter();
  child.stdin = { on: vi.fn(), end: vi.fn() };
  child.kill = vi.fn();
  child.exitCode = exitCode;
  child.signalCode = null;
  setTimeout(() => child.emit('close', exitCode), 5);
  return child as cp.ChildProcess;
}

function mockExecFile(version = '0.1.7-rc.2\n', dump = DUMP) {
  vi.mocked(cp.execFile).mockImplementation(((_b: string, argv: string[], _o: unknown, cb: any) => {
    if (argv[0] === '--version') cb(null, version, '');
    else cb(null, dump, '');
  }) as any);
}

function args(extra: Partial<AgentRunArgs> = {}): AgentRunArgs {
  return {
    tools: [],
    prompt: (async function* () {
      yield 'go';
    })(),
    systemPrompt: 'SYS',
    cwd: '/w',
    env: {},
    maxTurns: 25,
    ...extra,
  };
}

async function collect(extra: Partial<AgentRunArgs> = {}, runner = new DshAgentRunner('/bin/dsh')) {
  const out: AgentMessage[] = [];
  for await (const m of runner.run(args(extra))) out.push(m);
  return out;
}

const spawnCall = (i: number) => vi.mocked(cp.spawn).mock.calls[i] as unknown as [string, string[], any];

describe('DshAgentRunner', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockExecFile();
  });

  it('pairs tool_call/tool_result by callId, reads shell exit codes and sums step_end usage', async () => {
    vi.mocked(cp.spawn).mockReturnValue(mockChild(SUCCESS));
    const msgs = await collect();
    const starts = msgs.filter((m) => m.type === 'tool_use' && m.tool_use_id);
    expect(starts.map((m) => [m.tool_use_id, m.tool, m.kind])).toEqual([
      ['toolu_1', 'bash', 'shell'],
      ['toolu_2', 'str_replace_editor', 'read'],
      ['toolu_3', 'bash', 'shell'],
    ]);
    expect(starts[0].input).toEqual({ command: 'echo hi > f.txt && cat f.txt', description: 'write a file' });
    const ends = msgs.filter((m) => m.type === 'tool_result');
    expect(ends.map((m) => [m.tool_use_id, m.is_error, m.exit_code])).toEqual([
      ['toolu_1', false, 0],
      ['toolu_2', true, undefined],
      ['toolu_3', false, 3],
    ]);
    expect(msgs.filter((m) => m.type === 'assistant').map((m) => m.text)).toEqual(['Running it.', 'done']);
    expect(msgs.at(-1)).toEqual({
      type: 'result',
      session_id: SID,
      subtype: 'success',
      input_tokens: 308,
      output_tokens: 68,
      cache_read_input_tokens: 30,
    });
    expect(msgs.at(-1)).not.toHaveProperty('cost_usd');
  });

  it('maps dsh fs tools to canonical kinds and inputs', async () => {
    vi.mocked(cp.spawn).mockReturnValue(mockChild(FS_TOOLS));
    const msgs = await collect();
    const starts = msgs.filter((m) => m.type === 'tool_use' && m.tool_use_id);
    expect(starts.map((m) => [m.kind, m.input])).toEqual([
      ['read', { file_path: 'f.txt' }],
      ['edit', { file_path: 'f.txt', old_string: 'hi', new_string: 'hello' }],
      ['write', { file_path: 'g.txt', content: 'new file\n' }],
      ['search', { pattern: 'hello', path: '.' }],
      ['todo', { todos: [{ content: 'finish', status: 'in_progress' }] }],
    ]);
    expect(msgs.filter((m) => m.type === 'tool_result').every((m) => m.is_error === false && m.exit_code === undefined)).toBe(true);
  });

  it('invocation: headless --json, task on stdin, cwd set, system prompt on the first prompt', async () => {
    const child = mockChild(SUCCESS);
    vi.mocked(cp.spawn).mockReturnValue(child);
    await collect();
    const [bin, argv, opts] = spawnCall(0);
    expect(bin).toBe('/bin/dsh');
    expect(argv).toEqual(['--profile', 'headless', '--json', '-']);
    expect(opts.cwd).toBe('/w');
    expect(vi.mocked((child as any).stdin.end).mock.calls[0][0]).toMatch(/^SYS[\s\S]*---\n\ngo$/);
    // no model/effort: no --patch and no --dump-config probe
    expect(vi.mocked(cp.execFile).mock.calls.map((c) => (c[1] as string[])[0])).toEqual(['--version']);
  });

  it('full access runs danger-full-access in its own process group; scoped stays workspace-write', async () => {
    const prev = process.env.DSH_PERMISSION_MODE;
    process.env.DSH_PERMISSION_MODE = 'danger-full-access';
    try {
      vi.mocked(cp.spawn).mockImplementation(() => mockChild(SUCCESS));
      await collect();
      await collect({ access: 'full' });
      await collect({ env: { DSH_PERMISSION_MODE: 'read-only' } });
      await collect({ env: { DSH_PERMISSION_MODE: 'danger-full-access' } });
    } finally {
      if (prev === undefined) delete process.env.DSH_PERMISSION_MODE;
      else process.env.DSH_PERMISSION_MODE = prev;
    }
    const mode = (i: number) => spawnCall(i)[2].env.DSH_PERMISSION_MODE;
    expect(mode(0)).toBe('workspace-write');
    expect(mode(1)).toBe('danger-full-access');
    expect(spawnCall(1)[2].detached).toBe(process.platform !== 'win32');
    expect(spawnCall(0)[2].detached).toBeUndefined();
    expect(mode(2)).toBe('read-only');
    expect(mode(3)).toBe('workspace-write');
  });

  it('model + effort go through a generated --patch placed before --json, then removed', async () => {
    let patchText = '';
    let patchPath = '';
    vi.mocked(cp.spawn).mockImplementation(((_b: string, argv: string[]) => {
      patchPath = argv[argv.indexOf('--patch') + 1];
      patchText = fs.readFileSync(patchPath, 'utf8');
      return mockChild(SUCCESS);
    }) as any);
    await collect({ model: 'deepseek-v4-pro', effort: 'xhigh' });
    const argv = spawnCall(0)[1];
    expect(argv.indexOf('--patch')).toBeLessThan(argv.indexOf('--json'));
    expect(patchText).toContain('- id: agent-default-model');
    expect(patchText).toContain('provider: "deepseek-official"');
    expect(patchText).toContain('model: "deepseek-v4-pro"');
    expect(patchText).toContain('reasoningEffort: "max"');
    expect(fs.existsSync(patchPath)).toBe(false);
    const probe = vi.mocked(cp.execFile).mock.calls[1];
    expect(probe[1]).toEqual(['--profile', 'headless', '--dump-config']);
  });

  it('effort alone keeps the profile’s own provider and model', async () => {
    mockExecFile('0.2.0-rc.1\n', DUMP.replace('deepseek-official', 'openrouter').replace('deepseek-flash', 'qwen/qwen3'));
    let patchText = '';
    vi.mocked(cp.spawn).mockImplementation(((_b: string, argv: string[]) => {
      patchText = fs.readFileSync(argv[argv.indexOf('--patch') + 1], 'utf8');
      return mockChild(SUCCESS);
    }) as any);
    await collect({ effort: 'medium' });
    expect(patchText).toContain('provider: "openrouter"');
    expect(patchText).toContain('model: "qwen/qwen3"');
    expect(patchText).toContain('reasoningEffort: "medium"');
  });

  it('a free model: <route>/<model> selects the route and turns it on in the patch', async () => {
    let patchText = '';
    vi.mocked(cp.spawn).mockImplementation(((_b: string, argv: string[]) => {
      patchText = fs.readFileSync(argv[argv.indexOf('--patch') + 1], 'utf8');
      return mockChild(FREE_SUCCESS);
    }) as any);
    const msgs = await collect({ model: 'openrouter/nvidia/nemotron-3-ultra-550b-a55b:free', effort: 'max' });
    expect(patchText).toContain('provider: "openrouter"');
    expect(patchText).toContain('model: "nvidia/nemotron-3-ultra-550b-a55b:free"');
    expect(patchText).toContain('reasoningEffort: "high"'); // clamped: nemotron-3-ultra has no max
    expect(patchText).toContain('- id: llm-pi-ai\n  config:\n    providers:\n      "openrouter":\n        apiKeyEnv: "OPENROUTER_API_KEY"');
    expect(msgs.at(-1)).toMatchObject({ type: 'result', subtype: 'success', input_tokens: 120, output_tokens: 7 });
  });

  it('a free route without its key is a fatal error naming that key', async () => {
    vi.mocked(cp.spawn).mockReturnValue(mockChild(FREE_NO_KEY, 1));
    const err = await collect({ model: 'openrouter/z-ai/glm-5.2:free' }).catch((e) => e);
    expect(err.message).toMatch(/MISSING_CREDENTIAL/);
    expect(err.message).toMatch(/— export OPENROUTER_API_KEY/);
    expect(err.fatal).toBe(true);
  });

  it('an effort the model does not support is a fatal, named error', async () => {
    vi.mocked(cp.spawn).mockReturnValue(mockChild(FREE_BAD_EFFORT, 1));
    const err = await collect().catch((e) => e);
    expect(err.message).toMatch(/UNSUPPORTED_REASONING_EFFORT.*pick another effort or model/);
    expect(err.fatal).toBe(true);
  });

  it('missing credential is a fatal error naming DEEPSEEK_API_KEY', async () => {
    vi.mocked(cp.spawn).mockReturnValue(mockChild(MISSING_CREDENTIAL, 1));
    const err = await collect().catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toMatch(/MISSING_CREDENTIAL/);
    expect(err.message).toMatch(/export DEEPSEEK_API_KEY/);
    expect(err.fatal).toBe(true);
  });

  it('resume passes --session-id; a cwd-mismatch refusal is a clear fatal error', async () => {
    vi.mocked(cp.spawn).mockReturnValue(mockChild(CWD_REFUSAL, 1));
    const err = await collect({ resume: 'session-263f9353-d45f-457f-9b14-ae2fb3a1e453' }).catch((e) => e);
    expect(spawnCall(0)[1]).toEqual([
      '--profile',
      'headless',
      '--json',
      '--session-id',
      'session-263f9353-d45f-457f-9b14-ae2fb3a1e453',
      '-',
    ]);
    expect(err.message).toMatch(/refuses to resume session session-263f9353.*recorded in \/home\/u\/a, not \/w/);
    expect(err.fatal).toBe(true);
  });

  it('an unknown session id is a clear fatal error; resumed prompts carry no system prompt', async () => {
    const child = mockChild(NO_SESSION, 1);
    vi.mocked(cp.spawn).mockReturnValue(child);
    const err = await collect({ resume: 'nope' }).catch((e) => e);
    expect(err.message).toMatch(/no session nope/);
    expect(err.fatal).toBe(true);
    expect(vi.mocked((child as any).stdin.end).mock.calls[0][0]).toBe('go');
  });

  it('fence tool rounds resume the captured session', async () => {
    const tool = {
      name: 'org_echo',
      description: 'echo',
      schema: { text: z.string() },
      handler: async (a: Record<string, unknown>) => ({ text: String(a.text) }),
    };
    const fence = '```tool_call\\n{\\"name\\":\\"org_echo\\",\\"arguments\\":{\\"text\\":\\"hi\\"}}\\n```';
    const first = [SUCCESS[0], `{"type":"text","text":"${fence}"}`, SUCCESS.at(-2) as string];
    vi.mocked(cp.spawn).mockReturnValueOnce(mockChild(first)).mockReturnValueOnce(mockChild(SUCCESS));
    await collect({ tools: [tool], canUseTool: async () => ({ behavior: 'allow' }) });
    expect(spawnCall(0)[1]).not.toContain('--session-id');
    expect(spawnCall(1)[1]).toContain(SID);
  });

  it('emulates max turns: the step past the cap kills the tree and ends error_max_turns', async () => {
    const child = mockChild(SUCCESS);
    vi.mocked(cp.spawn).mockReturnValue(child);
    const msgs = await collect({ maxTurns: 2 });
    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
    expect(msgs.at(-1)).toMatchObject({ type: 'result', subtype: 'error_max_turns' });
  });

  it('gates on dsh --version and reports a missing binary with the install hint', async () => {
    mockExecFile('0.0.9\n');
    await expect(collect()).rejects.toThrow(/supports dsh >=0\.1\.7-0 <0\.3\.0.*found 0\.0\.9/);
    vi.mocked(cp.execFile).mockImplementation(((_b: string, _a: string[], _o: unknown, cb: any) => {
      cb(Object.assign(new Error('spawn dsh ENOENT'), { code: 'ENOENT' }));
    }) as any);
    await expect(collect()).rejects.toThrow(/npm i -g @deepseek-ai\/dsh/);
    expect(cp.spawn).not.toHaveBeenCalled();
  });
});
