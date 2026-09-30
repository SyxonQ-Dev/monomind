/**
 * PiRpcAgentRunner with no API key: it must fail fast with "missing API
 * key: set X" instead of waiting on the 10-minute silence watchdog.
 *
 * The rejected-prompt line is a live capture from pi 0.87.1 in `--mode rpc`
 * with an empty HOME and no key (2026-09-30): pi answers the prompt command
 * with `success:false` and sends nothing else.
 */
import { EventEmitter } from 'node:events';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentMessage, AgentRunArgs } from '../../src/orgrt/agent-runner.js';
import { PiRpcAgentRunner, type PiRpcProcess } from '../../src/orgrt/pi-rpc-runner.js';
import { missingPiApiKey, piAuthErrorFromText } from '../../src/orgrt/pi-rpc-runner-auth.js';

/** `env` with the variable `name` set; not a real key, only its presence matters. */
const withKey = (env: Record<string, string>, name: string) => ({ ...env, [name]: 'x' });

const REJECTED_PROMPT = JSON.stringify({
  type: 'response',
  command: 'prompt',
  success: false,
  error:
    'No API key found for openai.\n\nUse /login to log into a provider via OAuth or API key. See:\n  /pi/docs/providers.md\n  /pi/docs/models.md',
});

const tmpDirs: string[] = [];
afterEach(() => {
  for (const d of tmpDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});
function tempHome(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-rpc-auth-'));
  tmpDirs.push(d);
  return d;
}

function fakeProcess() {
  const emitter = new EventEmitter();
  const stdout = new EventEmitter();
  const stderr = new EventEmitter();
  const written: string[] = [];
  const proc: PiRpcProcess = {
    stdin: { write: (d: string) => void written.push(d) },
    stdout: { on: (e, cb) => void stdout.on(e, cb) },
    stderr: { on: (e, cb) => void stderr.on(e, cb) },
    on: (e: string, cb: (...a: unknown[]) => void) => void emitter.on(e, cb),
    kill: vi.fn(),
  };
  return {
    proc,
    written,
    out: (line: string) => stdout.emit('data', Buffer.from(`${line}\n`)),
    err: (text: string) => stderr.emit('data', Buffer.from(text)),
    close: (code: number) => emitter.emit('close', code),
  };
}

/** Run args with a temp HOME and every key variable the tests touch unset,
 *  so a key in the developer's own environment cannot leak in. */
function runArgs(home: string, overrides: Partial<AgentRunArgs> = {}): AgentRunArgs {
  return {
    tools: [],
    prompt: (async function* () {
      yield 'hello';
    })(),
    systemPrompt: 'test',
    cwd: home,
    env: { HOME: home, PI_CODING_AGENT_DIR: '', OPENAI_API_KEY: '', OPENROUTER_API_KEY: '' },
    maxTurns: 5,
    ...overrides,
  };
}

async function collect(iter: AsyncIterable<AgentMessage>): Promise<AgentMessage[]> {
  const out: AgentMessage[] = [];
  for await (const m of iter) out.push(m);
  return out;
}

describe('missingPiApiKey (up-front check)', () => {
  it('names the key variable when the provider has no key anywhere', () => {
    const home = tempHome();
    expect(missingPiApiKey('openai/gpt-5', { HOME: home }, home)).toEqual({
      provider: 'openai',
      keyEnv: 'OPENAI_API_KEY',
    });
  });

  it('passes when the variable is set', () => {
    const home = tempHome();
    expect(missingPiApiKey('openai/gpt-5', withKey({ HOME: home }, 'OPENAI_API_KEY'), home)).toBe(
      undefined,
    );
  });

  it('passes when pi auth.json holds a credential for the provider', () => {
    const home = tempHome();
    fs.mkdirSync(path.join(home, '.pi', 'agent'), { recursive: true });
    fs.writeFileSync(
      path.join(home, '.pi', 'agent', 'auth.json'),
      JSON.stringify({ openai: { type: 'api_key', key: 'sk-x' } }),
    );
    expect(missingPiApiKey('openai/gpt-5', { HOME: home }, home)).toBe(undefined);
  });

  it('passes when models.json defines a provider of that name', () => {
    const home = tempHome();
    const agentDir = path.join(home, 'agent');
    fs.mkdirSync(agentDir);
    fs.writeFileSync(
      path.join(agentDir, 'models.json'),
      JSON.stringify({ providers: { openai: { baseUrl: 'http://localhost:1' } } }),
    );
    expect(missingPiApiKey('openai/gpt-5', { HOME: home, PI_CODING_AGENT_DIR: agentDir }, home)).toBe(
      undefined,
    );
  });

  it('does not guess without a provider prefix or for a provider it does not know', () => {
    const home = tempHome();
    expect(missingPiApiKey(undefined, { HOME: home }, home)).toBe(undefined);
    expect(missingPiApiKey('gpt-5', { HOME: home }, home)).toBe(undefined);
    expect(missingPiApiKey('my-local/llama', { HOME: home }, home)).toBe(undefined);
  });
});

describe('piAuthErrorFromText', () => {
  it("maps pi's no-key wording to the provider's variable", () => {
    const err = piAuthErrorFromText('No API key found for openrouter.\n\nUse /login …', undefined);
    expect(err?.message).toContain('missing API key: set OPENROUTER_API_KEY');
    expect((err as Error & { fatal?: boolean }).fatal).toBe(true);
  });

  it('falls back to the model prefix when pi says "the selected model"', () => {
    const err = piAuthErrorFromText('No API key found for the selected model.', 'openai/gpt-5');
    expect(err?.message).toContain('set OPENAI_API_KEY');
  });

  it('ignores unrelated text', () => {
    expect(piAuthErrorFromText('Warning: No project session found', undefined)).toBe(undefined);
  });
});

describe('PiRpcAgentRunner without an API key', () => {
  it('fails before spawning pi when the model provider has no key', async () => {
    const home = tempHome();
    const spawn = vi.fn();
    const runner = new PiRpcAgentRunner('pi', spawn);
    await expect(collect(runner.run(runArgs(home, { model: 'openai/gpt-5' })))).rejects.toThrow(
      /missing API key: set OPENAI_API_KEY for provider openai/,
    );
    expect(spawn).not.toHaveBeenCalled();
  });

  it("fails at once on pi's rejected prompt instead of waiting for the watchdog", async () => {
    const home = tempHome();
    const fake = fakeProcess();
    const runner = new PiRpcAgentRunner('pi', () => fake.proc);
    const done = collect(runner.run(runArgs(home)));
    await new Promise((r) => setTimeout(r, 10));
    expect(fake.written[0]).toContain('"type":"prompt"');

    fake.out(REJECTED_PROMPT);

    const err = await done.then(
      () => undefined,
      (e: Error & { fatal?: boolean }) => e,
    );
    expect(err?.message).toMatch(/missing API key: set OPENAI_API_KEY/);
    expect(err?.message).toContain('No API key found for openai');
    expect(err?.fatal).toBe(true);
  });

  it('any other rejected prompt also fails the turn instead of hanging', async () => {
    const home = tempHome();
    const fake = fakeProcess();
    const runner = new PiRpcAgentRunner('pi', () => fake.proc);
    const done = collect(runner.run(runArgs(home)));
    await new Promise((r) => setTimeout(r, 10));
    fake.out(
      JSON.stringify({ type: 'response', command: 'prompt', success: false, error: 'busy' }),
    );
    await expect(done).rejects.toThrow(/pi rejected the prompt: busy/);
  });

  it('reports the missing key when pi prints it on stderr and exits', async () => {
    const home = tempHome();
    const fake = fakeProcess();
    const runner = new PiRpcAgentRunner('pi', () => fake.proc);
    // The key variable is set, so the up-front check lets pi start.
    const env = withKey(runArgs(home).env, 'OPENROUTER_API_KEY');
    const done = collect(runner.run(runArgs(home, { model: 'openrouter/some-model', env })));
    await new Promise((r) => setTimeout(r, 10));
    fake.err('Error: No API key found for the selected model.\n');
    fake.close(1);
    await expect(done).rejects.toThrow(/missing API key: set OPENROUTER_API_KEY/);
  });
});
