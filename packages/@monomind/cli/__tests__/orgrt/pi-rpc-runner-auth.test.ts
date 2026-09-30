/**
 * PiRpcAgentRunner with no API key: it must fail fast with "missing API
 * key: set X" instead of waiting on the 10-minute silence watchdog.
 *
 * The rejected-prompt line is a live capture from pi 0.87.1 in `--mode rpc`
 * with an empty HOME and no key (2026-09-30): pi answers the prompt command
 * with `success:false` and sends nothing else. The `pi auth check --json`
 * lines are live captures from the same pi (2026-09-30).
 */
import { EventEmitter } from 'node:events';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentMessage, AgentRunArgs } from '../../src/orgrt/agent-runner.js';
import { PiRpcAgentRunner, type PiRpcProcess } from '../../src/orgrt/pi-rpc-runner.js';
import { piAuthErrorFromText } from '../../src/orgrt/pi-rpc-runner-auth.js';

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

/**
 * A fake `pi` whose `auth check` prints FAKE_PI_AUTH (a JSON line) and exits
 * FAKE_PI_AUTH_EXIT; FAKE_PI_AUTH=unavailable mimics a pi without the
 * command. Each call's argv is logged to FAKE_PI_LOG.
 */
function fakePiBin(dir: string): string {
  const bin = path.join(dir, 'fake-pi.cjs');
  fs.writeFileSync(
    bin,
    `#!/usr/bin/env node
const fs = require('fs');
fs.appendFileSync(process.env.FAKE_PI_LOG, JSON.stringify(process.argv.slice(2)) + '\\n');
if (process.env.FAKE_PI_AUTH === 'unavailable') {
  console.error('Error: unknown command "auth"');
  process.exit(2);
}
console.log(process.env.FAKE_PI_AUTH);
process.exit(Number(process.env.FAKE_PI_AUTH_EXIT || 0));
`,
  );
  fs.chmodSync(bin, 0o755);
  return bin;
}

/** Run args for the fake pi: `auth` is what its `auth check` answers. */
function checkedArgs(home: string, model: string, auth: string, exit = 0): AgentRunArgs {
  const base = runArgs(home, { model });
  return {
    ...base,
    env: {
      ...base.env,
      FAKE_PI_LOG: path.join(home, 'pi.log'),
      FAKE_PI_AUTH: auth,
      FAKE_PI_AUTH_EXIT: String(exit),
    },
  };
}

const READY_OPENROUTER = '{"status":"ready","provider":"openrouter","authType":"api_key"}';

describe('pi auth check before spawning (piAuthPrecheck)', () => {
  it('an OpenRouter-routed id (deepseek/…) that pi reports ready starts pi', async () => {
    const home = tempHome();
    const fake = fakeProcess();
    const spawn = vi.fn(() => fake.proc);
    const runner = new PiRpcAgentRunner(fakePiBin(home), spawn);
    const done = collect(
      runner.run(checkedArgs(home, 'deepseek/deepseek-chat-v3.1', READY_OPENROUTER)),
    );
    await new Promise((r) => setTimeout(r, 500));
    expect(spawn).toHaveBeenCalledTimes(1);
    const calls = fs.readFileSync(path.join(home, 'pi.log'), 'utf8').trim().split('\n');
    expect(JSON.parse(calls[0])).toEqual([
      'auth',
      'check',
      '--model',
      'deepseek/deepseek-chat-v3.1',
      '--json',
    ]);
    fake.close(0);
    await done.catch(() => {});
  });

  it('not_ready (credentials_not_configured) fails before spawning with the missing-key error', async () => {
    const home = tempHome();
    const spawn = vi.fn();
    const runner = new PiRpcAgentRunner(fakePiBin(home), spawn);
    const notReady =
      '{"status":"not_ready","provider":"openrouter","reason":"credentials_not_configured"}';
    const err = await collect(
      runner.run(checkedArgs(home, 'deepseek/deepseek-chat-v3.1', notReady, 1)),
    ).then(
      () => undefined,
      (e: Error & { fatal?: boolean }) => e,
    );
    expect(err?.message).toMatch(/missing API key: set OPENROUTER_API_KEY for provider openrouter/);
    expect(err?.fatal).toBe(true);
    expect(spawn).not.toHaveBeenCalled();
  });

  it('not_ready for another reason says not logged in / login expired, not missing key', async () => {
    const home = tempHome();
    const spawn = vi.fn();
    const runner = new PiRpcAgentRunner(fakePiBin(home), spawn);
    const expired = '{"status":"not_ready","provider":"openai","reason":"credentials_expired"}';
    const err = await collect(runner.run(checkedArgs(home, 'openai/gpt-5', expired, 1))).then(
      () => undefined,
      (e: Error) => e,
    );
    expect(err?.message).toMatch(/not logged in or the login expired/);
    expect(err?.message).not.toMatch(/missing API key/);
    expect(spawn).not.toHaveBeenCalled();
  });

  it.each([
    ['auth check unavailable (older pi)', 'unavailable', 2],
    ['not JSON', 'garbage', 0],
    ['invalid model', '{"status":"invalid","provider":"x/y","reason":"invalid_state"}', 2],
  ])('%s: skips the pre-check and starts pi', async (_name, auth, exit) => {
    const home = tempHome();
    const fake = fakeProcess();
    const spawn = vi.fn(() => fake.proc);
    const runner = new PiRpcAgentRunner(fakePiBin(home), spawn);
    const done = collect(runner.run(checkedArgs(home, 'openai/gpt-5', auth, exit)));
    await new Promise((r) => setTimeout(r, 500));
    expect(spawn).toHaveBeenCalledTimes(1);
    fake.close(0);
    await done.catch(() => {});
  });

  it('runs no check without a model', async () => {
    const home = tempHome();
    const fake = fakeProcess();
    const runner = new PiRpcAgentRunner(fakePiBin(home), () => fake.proc);
    const done = collect(runner.run(checkedArgs(home, '', READY_OPENROUTER)));
    await new Promise((r) => setTimeout(r, 50));
    expect(fs.existsSync(path.join(home, 'pi.log'))).toBe(false);
    fake.close(0);
    await done.catch(() => {});
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

  it('a bare "Use /login" (e.g. an expired login) is not a missing key', () => {
    expect(piAuthErrorFromText('Login expired. Use /login to sign in again.', 'openai/gpt-5')).toBe(
      undefined,
    );
  });
});

describe('PiRpcAgentRunner without an API key', () => {
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
    // pi's auth check says ready, so the run starts.
    const runner = new PiRpcAgentRunner(fakePiBin(home), () => fake.proc);
    const done = collect(
      runner.run(checkedArgs(home, 'openrouter/some-model', READY_OPENROUTER)),
    );
    await new Promise((r) => setTimeout(r, 500));
    fake.err('Error: No API key found for the selected model.\n');
    fake.close(1);
    await expect(done).rejects.toThrow(/missing API key: set OPENROUTER_API_KEY/);
  });
});
