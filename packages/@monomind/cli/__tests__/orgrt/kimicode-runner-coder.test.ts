/**
 * Coder mode on kimicode: full access drops the org-role agent file (and its
 * `tools:` allowlist) and the empty --skills-dir so the user's own kimi agent
 * and skills load; `--settings` alone keeps the user's skills. kimi's tool
 * calls and results (kimi-code 2.x PromptJsonWriter shapes) become matched
 * tool_use/tool_result pairs. Driven through a fake `kimi` script — no real
 * CLI call.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { AgentMessage, AgentRunArgs } from '../../src/orgrt/agent-runner.js';
import { KimiCodeAgentRunner } from '../../src/orgrt/kimicode-runner.js';

const SCRIPT = `#!/usr/bin/env node
const fs = require('fs');
const prompt = fs.readFileSync(0, 'utf8');
fs.appendFileSync(process.env.FAKE_KIMI_LOG, JSON.stringify({ argv: process.argv.slice(2), prompt }) + '\\n');
const out = (o) => console.log(JSON.stringify(o));
out({ role: 'assistant', content: 'Listing.', tool_calls: [
  { type: 'function', id: 'tc_1', function: { name: 'Bash', arguments: '{"command":"ls"}' } },
] });
out({ role: 'tool', tool_call_id: 'tc_1', content: 'a.txt' });
out({ role: 'assistant', tool_calls: [
  { type: 'function', id: 'tc_2', function: { name: 'Edit', arguments: '{"path":"a.txt","old_string":"a","new_string":"b"}' } },
] });
out({ role: 'tool', tool_call_id: 'tc_2', content: 'ok' });
out({ role: 'assistant', content: 'done' });
out({ role: 'meta', type: 'session.resume_hint', session_id: 'session_c1' });
`;

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'monomind-kimi-coder-'));
  const bin = path.join(dir, 'kimi.cjs');
  fs.writeFileSync(bin, SCRIPT);
  fs.chmodSync(bin, 0o755);
  return { dir, bin, log: path.join(dir, 'argv.log') };
}

async function run(extra: Partial<AgentRunArgs>) {
  const { dir, bin, log } = setup();
  const messages: AgentMessage[] = [];
  const args: AgentRunArgs = {
    tools: [],
    prompt: (async function* () {
      yield 'do work';
    })(),
    systemPrompt: 'CODER SYSTEM PROMPT',
    cwd: dir,
    env: { KIMI_CODE_HOME: path.join(dir, 'home'), FAKE_KIMI_LOG: log },
    maxTurns: 5,
    ...extra,
  };
  for await (const m of new KimiCodeAgentRunner(bin).run(args)) messages.push(m);
  const calls = fs
    .readFileSync(log, 'utf8')
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l) as { argv: string[]; prompt: string });
  return { messages, calls };
}

describe('KimiCodeAgentRunner coder mode', () => {
  it('full access: no agent file, no empty skills dir, system prompt carried on the first prompt', async () => {
    const { calls } = await run({ access: 'full' });
    expect(calls[0].argv).not.toContain('--agent-file');
    expect(calls[0].argv).not.toContain('--skills-dir');
    expect(calls[0].prompt.startsWith('CODER SYSTEM PROMPT')).toBe(true);
    expect(calls[0].prompt.endsWith('do work')).toBe(true);
  });

  it('--settings alone keeps the org agent file but loads the user’s skills', async () => {
    const { calls } = await run({ settingSources: ['user', 'project'] });
    expect(calls[0].argv).toContain('--agent-file');
    expect(calls[0].argv).not.toContain('--skills-dir');
    expect(calls[0].prompt).toBe('do work');
  });

  it('default (org role): agent file + empty skills dir, unchanged', async () => {
    const { calls } = await run({});
    expect(calls[0].argv).toContain('--agent-file');
    expect(calls[0].argv).toContain('--skills-dir');
  });

  it('pairs kimi tool_calls with their role:"tool" results by call id, canonical inputs', async () => {
    const { messages } = await run({ access: 'full' });
    const starts = messages.filter((m) => m.type === 'tool_use' && m.tool_use_id);
    const ends = messages.filter((m) => m.type === 'tool_result');
    expect(starts.map((m) => [m.tool_use_id, m.tool, (m as { kind?: string }).kind])).toEqual([
      ['tc_1', 'Bash', 'shell'],
      ['tc_2', 'Edit', 'edit'],
    ]);
    expect(starts[0].input).toEqual({ command: 'ls' });
    expect(starts[1].input).toEqual({ file_path: 'a.txt', old_string: 'a', new_string: 'b' });
    expect(ends.map((m) => [m.tool_use_id, m.text])).toEqual([
      ['tc_1', 'a.txt'],
      ['tc_2', 'ok'],
    ]);
    const texts = messages.filter((m) => m.type === 'assistant').map((m) => m.text);
    expect(texts).toEqual(['Listing.', 'done']);
  });
});
