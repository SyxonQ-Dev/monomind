// packages/@monomind/cli/__tests__/orgrt/deps-hardening-sdk.test.ts
/**
 * #526, against the real bundled Claude Code CLI in the SDK sandbox (opt-in
 * like operator-paths-sdk.test.ts: MONOMIND_SANDBOX_E2E=1, skipped inside an
 * org role; a scripted local Messages API plays one Bash call). With a temp
 * HOME and a custom MONOMIND_HOME inside the role's own cwd, the role's Bash
 * can neither rename an ancestor of MONOMIND_HOME aside nor plant a deps dir
 * (3), nor create or write the npm and shell config that was missing before
 * the role started (2), while its cwd stays writable.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { afterEach, describe, expect, it } from 'vitest';
import { ensureAuthorityDirs } from '../../src/orgrt/authority-mask.js';
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
)('SDK-sandboxed role vs the deps dir and missing npm/shell config (#526)', () => {
  it('cannot rename MONOMIND_HOME aside through an ancestor, plant deps, or write ~/.npmrc, ~/.config/npm, ~/.bashrc', async () => {
    const base = mkdtempSync(join(tmpdir(), 'dh5-'));
    dirs.push(base);
    const cwd = join(base, 'wt');
    const home = join(base, 'home');
    const mm = join(cwd, 'x', 'mm');
    spawnSync('git', ['init', '-q', cwd]);
    mkdirSync(mm, { recursive: true });
    for (const d of ['projects', 'shell-snapshots', 'session-env', 'plugins', 'backups'])
      mkdirSync(join(home, '.claude', d), { recursive: true });
    const env0 = { HOME: home, MONOMIND_HOME: mm } as NodeJS.ProcessEnv;
    ensureAuthorityDirs(home, env0);
    ensureOperatorProtectedPaths({ home, env: env0, orgRoot: cwd });
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
      `mv ${cwd}/x ${cwd}/x-aside 2>/dev/null; echo "ANCESTOR=$?"`,
      `mv ${mm} ${cwd}/x/mm-aside 2>/dev/null; echo "HOME=$?"`,
      `mkdir ${mm}/deps/planted 2>/dev/null; echo "PLANT=$?"`,
      `echo registry=evil > ${home}/.npmrc 2>/dev/null; echo "NPMRC=$?"`,
      `echo registry=evil > ${home}/.config/npm/npmrc 2>/dev/null; echo "XDGNPM=$?"`,
      `echo evil >> ${home}/.bashrc 2>/dev/null; echo "BASHRC=$?"`,
      `echo ok > ${cwd}/work.txt; echo "CWDW=$?"`,
    ].join('; ');
    const server = await scriptedApi(command);
    const env: Record<string, string | undefined> = {
      ...process.env,
      HOME: home,
      ANTHROPIC_BASE_URL: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
      ANTHROPIC_API_KEY: ['test', 'deps'].join('-'),
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
    expect(text).not.toMatch(/(ANCESTOR|HOME|PLANT|NPMRC|XDGNPM|BASHRC)=0/);
    expect(existsSync(join(cwd, 'x-aside'))).toBe(false);
    expect(readdirSync(join(mm, 'deps'))).toEqual([]);
    expect(readFileSync(join(home, '.npmrc'), 'utf8')).toBe('');
    expect(existsSync(join(home, '.config', 'npm', 'npmrc'))).toBe(false);
    expect(readFileSync(join(home, '.bashrc'), 'utf8')).toBe('');
  }, 90_000);
});
