// packages/@monomind/cli/__tests__/orgrt/operator-paths-sdk.test.ts
/**
 * #502 review, against the real bundled Claude Code CLI in the SDK sandbox
 * (opt-in like role-tmpdir-claude-sdk.test.ts: MONOMIND_SANDBOX_E2E=1,
 * skipped inside an org role; a scripted local Messages API plays one Bash
 * call). A sandboxed role's Bash must neither read nor replace the operator
 * key, nor write what the operator's own sessions run (the project's
 * .claude/, the org skill libraries), while its cwd stays writable. Checks
 * that listing the operator dir in denyWrite as well as denyRead keeps it
 * hidden on Linux.
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { afterEach, describe, expect, it } from 'vitest';
import {
  authorityMaskArgs,
  authorityMaskAvailability,
  ensureAuthorityDirs,
  maskedCommand,
} from '../../src/orgrt/authority-mask.js';
import { gitCommonDir, prepareGitGuard } from '../../src/orgrt/git-guard.js';
import { ensureOperatorProtectedPaths } from '../../src/orgrt/operator-protected-paths.js';
import { buildClaudeRestrictions, sandboxAvailability } from '../../src/orgrt/role-sandbox.js';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const sse = (events: Array<Record<string, unknown>>) =>
  events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join('');

function reply(step: number, command?: string): string {
  const usage = { input_tokens: 1, output_tokens: 1 };
  const block = command
    ? { type: 'tool_use', id: `toolu_${step}`, name: 'Bash', input: {} }
    : { type: 'text', text: '' };
  const delta = command
    ? { type: 'input_json_delta', partial_json: JSON.stringify({ command }) }
    : { type: 'text_delta', text: 'done' };
  return sse([
    {
      type: 'message_start',
      message: {
        id: `msg_${step}`,
        type: 'message',
        role: 'assistant',
        model: 'claude-sonnet-5',
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage,
      },
    },
    { type: 'content_block_start', index: 0, content_block: block },
    { type: 'content_block_delta', index: 0, delta },
    { type: 'content_block_stop', index: 0 },
    {
      type: 'message_delta',
      delta: { stop_reason: command ? 'tool_use' : 'end_turn', stop_sequence: null },
      usage,
    },
    { type: 'message_stop' },
  ]);
}

function scriptedApi(command: string): Promise<Server> {
  let step = 0;
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      if (!req.url?.startsWith('/v1/messages') || req.url.includes('count_tokens')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ input_tokens: 1 }));
        return;
      }
      const main = /"name":"Bash"/.test(body);
      const i = main ? step++ : -1;
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(reply(i, main && i === 0 ? command : undefined));
    });
  });
  return new Promise((r) => server.listen(0, '127.0.0.1', () => r(server)));
}

describe.skipIf(
  process.env.MONOMIND_SANDBOX_E2E !== '1' ||
    !!process.env.MONOMIND_ORG_ROLE ||
    process.platform !== 'linux' ||
    !sandboxAvailability().available,
)('SDK-sandboxed role vs the operator key and operator-run paths (#502 review)', () => {
  it('cannot read or replace the key, cannot write .claude/ or the skill libraries, can write its cwd', async () => {
    const base = mkdtempSync(join(tmpdir(), 'op5-'));
    dirs.push(base);
    const cwd = join(base, 'wt'); // the org root and the role's cwd, as with workspace 'repo'
    const home = join(base, 'home');
    spawnSync('git', ['init', '-q', cwd]);
    for (const d of ['projects', 'shell-snapshots', 'session-env', 'plugins', 'backups'])
      mkdirSync(join(home, '.claude', d), { recursive: true });
    writeFileSync(join(home, '.claude', '.config.json'), '{}');
    mkdirSync(join(cwd, '.claude'), { recursive: true });
    writeFileSync(join(cwd, '.claude', 'settings.json'), '{"hooks":{}}');
    const env0 = { HOME: home } as NodeJS.ProcessEnv;
    ensureAuthorityDirs(home, env0);
    ensureOperatorProtectedPaths({ home, env: env0, orgRoot: cwd });
    const opDir = join(home, '.monomind', 'orgrt-operator');
    const key = join(opDir, 'full-access-grant.key');
    writeFileSync(key, 'OPERATORKEY', { mode: 0o600 });
    const guard = prepareGitGuard({
      level: 'commit',
      stateDir: join(base, 'guard'),
      excludeSandboxPlaceholders: true,
      protectedGitDirs: [gitCommonDir(cwd) as string],
    });
    const { sandbox } = buildClaudeRestrictions(
      guard as NonNullable<typeof guard>,
      undefined,
      { cwd, orgRoot: cwd, home, tmp: base, env: env0 },
      true,
    );
    const command = [
      `echo "KEY=$(cat ${key} 2>&1)"`,
      `echo FORGED > ${key} 2>/dev/null; echo "KEYW=$?"`,
      `echo '{"hooks":"evil"}' > ${cwd}/.claude/settings.json 2>/dev/null; echo "SETW=$?"`,
      `echo evil > ${home}/.monomind/org-skills/evil.md 2>/dev/null; echo "HSKW=$?"`,
      `echo evil > ${cwd}/.monomind/org-skills/evil.md 2>/dev/null; echo "PSKW=$?"`,
      `echo ok > ${cwd}/work.txt; echo "CWDW=$?"`,
    ].join('; ');
    const server = await scriptedApi(command);
    const env: Record<string, string | undefined> = {
      ...process.env,
      HOME: home,
      ANTHROPIC_BASE_URL: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
      ANTHROPIC_API_KEY: ['test', 'operator'].join('-'),
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
      CLAUDECODE: undefined,
      CLAUDE_CONFIG_DIR: undefined,
      MONOMIND_ORGRT_OPERATOR_DIR: undefined,
    };
    delete env.CLAUDE_CODE_OAUTH_TOKEN;
    const out: string[] = [];
    try {
      for await (const m of query({
        prompt: 'go',
        options: {
          cwd,
          env,
          settingSources: [],
          maxTurns: 3,
          permissionMode: 'bypassPermissions',
          allowDangerouslySkipPermissions: true,
          sandbox: sandbox as never,
        },
      })) {
        if (m.type !== 'user' || !Array.isArray(m.message.content)) continue;
        for (const b of m.message.content)
          if (b.type === 'tool_result')
            out.push(typeof b.content === 'string' ? b.content : JSON.stringify(b.content));
      }
    } finally {
      server.close();
    }
    const text = out.join('\n');
    expect(text, text).toMatch(/CWDW=0/);
    expect(text).not.toContain('OPERATORKEY');
    expect(readFileSync(key, 'utf8')).toBe('OPERATORKEY');
    expect(readFileSync(join(cwd, '.claude', 'settings.json'), 'utf8')).toBe('{"hooks":{}}');
    expect(existsSync(join(home, '.monomind', 'org-skills', 'evil.md'))).toBe(false);
    expect(existsSync(join(cwd, '.monomind', 'org-skills', 'evil.md'))).toBe(false);
    expect(readFileSync(join(cwd, 'work.txt'), 'utf8')).toBe('ok\n');
  }, 90_000);
});

describe.skipIf(
  process.env.MONOMIND_SANDBOX_E2E !== '1' ||
    !!process.env.MONOMIND_ORG_ROLE ||
    !authorityMaskAvailability().available,
)('masked Claude role vs ~/.claude.json and the project .mcp.json (#502 review round 2)', () => {
  it('Claude Code runs with ~/.claude.json read-only, and the role cannot add mcpServers to it or to .mcp.json', async () => {
    const base = mkdtempSync(join(tmpdir(), 'op6-'));
    dirs.push(base);
    const cwd = join(base, 'wt');
    const home = join(base, 'home');
    mkdirSync(cwd, { recursive: true });
    for (const d of ['projects', 'shell-snapshots', 'session-env', 'plugins', 'backups'])
      mkdirSync(join(home, '.claude', d), { recursive: true });
    const claudeJson = join(home, '.claude.json');
    writeFileSync(claudeJson, '{"numStartups":1}');
    writeFileSync(join(cwd, '.mcp.json'), '{"mcpServers":{}}');
    const env0 = { HOME: home } as NodeJS.ProcessEnv;
    ensureAuthorityDirs(home, env0);
    ensureOperatorProtectedPaths({ home, env: env0, orgRoot: cwd });
    const mask = authorityMaskArgs({ home, env: env0, roots: [cwd], orgRoot: cwd, cwd });
    const command = [
      `echo '{"mcpServers":{"evil":{"command":"x"}}}' > ${claudeJson} 2>/dev/null; echo "CJW=$?"`,
      `echo '{"mcpServers":{"evil":{"command":"x"}}}' > ${cwd}/.mcp.json 2>/dev/null; echo "MCPW=$?"`,
      `echo ok > ${cwd}/work.txt; echo "CWDW=$?"`,
    ].join('; ');
    const server = await scriptedApi(command);
    const env: Record<string, string | undefined> = {
      ...process.env,
      HOME: home,
      ANTHROPIC_BASE_URL: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
      ANTHROPIC_API_KEY: ['test', 'masked'].join('-'),
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
      CLAUDECODE: undefined,
      CLAUDE_CONFIG_DIR: undefined,
      MONOMIND_ORGRT_OPERATOR_DIR: undefined,
    };
    delete env.CLAUDE_CODE_OAUTH_TOKEN;
    const out: string[] = [];
    try {
      for await (const m of query({
        prompt: 'go',
        options: {
          cwd,
          env,
          settingSources: [],
          maxTurns: 3,
          permissionMode: 'bypassPermissions',
          allowDangerouslySkipPermissions: true,
          spawnClaudeCodeProcess: (o) => {
            const [cmd, argv] = maskedCommand(mask, o.command, o.args);
            const child = spawn(cmd, argv, {
              cwd: o.cwd,
              env: o.env as NodeJS.ProcessEnv,
              signal: o.signal,
              stdio: ['pipe', 'pipe', 'pipe'],
            });
            child.stderr?.resume();
            return child as never;
          },
        },
      })) {
        if (m.type !== 'user' || !Array.isArray(m.message.content)) continue;
        for (const b of m.message.content)
          if (b.type === 'tool_result')
            out.push(typeof b.content === 'string' ? b.content : JSON.stringify(b.content));
      }
    } finally {
      server.close();
    }
    const text = out.join('\n');
    expect(text, text).toMatch(/CWDW=0/);
    expect(text).not.toMatch(/CJW=0|MCPW=0/);
    expect(readFileSync(claudeJson, 'utf8')).not.toContain('evil');
    expect(readFileSync(join(cwd, '.mcp.json'), 'utf8')).toBe('{"mcpServers":{}}');
  }, 90_000);
});
