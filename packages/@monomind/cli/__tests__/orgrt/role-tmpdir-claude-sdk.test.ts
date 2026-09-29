// packages/@monomind/cli/__tests__/orgrt/role-tmpdir-claude-sdk.test.ts
/**
 * #503: a claude-runtime role's Bash tool, against the real bundled Claude
 * Code CLI. Opt-in like sandbox-stubs-sdk.test.ts (MONOMIND_SANDBOX_E2E=1,
 * skipped inside an org role); a scripted local Messages API plays one Bash
 * call, so no model is involved.
 *
 * Claude Code takes its temp root from CLAUDE_CODE_TMPDIR before TMPDIR, and
 * exports CLAUDE_CODE_TMPDIR to every command its Bash tool runs. An org
 * started from a Claude Code session's Bash tool (the release org's QA roles
 * run `monomind org run` that way) inherits it, so each role's CLI ignored the
 * role TMPDIR: the 2.20.0 drill printed `$HOME/mrg-tmp/claude-1000/claude-1000`,
 * a directory every such role shares. The role env now sets
 * CLAUDE_CODE_TMPDIR to the role dir as well; Claude Code adds its own
 * `claude-<uid>/` under it.
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { afterEach, describe, expect, it } from 'vitest';
import { gitCommonDir, prepareGitGuard } from '../../src/orgrt/git-guard.js';
import { buildClaudeRestrictions, sandboxAvailability } from '../../src/orgrt/role-sandbox.js';
import { createRoleTmpdir, releaseRunTmpdirs, roleTmpEnv } from '../../src/orgrt/role-tmpdir.js';

const dirs: string[] = [];
afterEach(() => {
  releaseRunTmpdirs('o', 'e2e');
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

/** A role's Bash tool runs `command` with the role env on top of an env that
 *  came from a Claude Code session's Bash tool; resolves to the tool output. */
async function roleBash(sandboxed: boolean, command: string) {
  // Short: bwrap's bridge sockets live under the temp root.
  const base = mkdtempSync(join(tmpdir(), 'r5-'));
  dirs.push(base);
  const cwd = join(base, 'wt');
  const home = join(base, 'home');
  spawnSync('git', ['init', '-q', cwd]);
  for (const d of ['projects', 'shell-snapshots', 'session-env', 'plugins', 'backups'])
    mkdirSync(join(home, '.claude', d), { recursive: true });
  writeFileSync(join(home, '.claude', '.config.json'), '{}');
  const roleDir = createRoleTmpdir({ org: 'o', role: 'w', run: 'e2e', root: base, base }) as string;
  // What the outer session's Bash tool exported: its own per-uid temp dir.
  const outer = join(base, `claude-${process.getuid?.() ?? 0}`);
  const guard = prepareGitGuard({
    level: 'commit',
    stateDir: join(base, 'guard'),
    excludeSandboxPlaceholders: true,
    protectedGitDirs: [gitCommonDir(cwd) as string],
  });
  const { sandbox } = buildClaudeRestrictions(
    guard as NonNullable<typeof guard>,
    undefined,
    { cwd, orgRoot: base, home, tmp: base },
    true,
  );
  const server = await scriptedApi(command);
  const env: Record<string, string | undefined> = {
    ...process.env,
    HOME: home,
    TMPDIR: outer,
    CLAUDE_CODE_TMPDIR: outer,
    ...roleTmpEnv(roleDir),
    ANTHROPIC_BASE_URL: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    // Not a credential: the scripted API accepts anything.
    ANTHROPIC_API_KEY: ['test', 'tmpdir'].join('-'),
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    CLAUDECODE: undefined,
    CLAUDE_CONFIG_DIR: undefined,
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
        ...(sandboxed ? { sandbox: sandbox as never } : {}),
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
  return { out: out.join('\n'), roleDir };
}

const CMD = 'echo "TMPDIR_IS=$TMPDIR"; echo "CCT_IS=$CLAUDE_CODE_TMPDIR"; echo "MKTEMP_IS=$(mktemp -d)"';
const field = (out: string, k: string) => out.match(new RegExp(`${k}=(\\S+)`))?.[1];

describe.skipIf(process.env.MONOMIND_SANDBOX_E2E !== '1' || !!process.env.MONOMIND_ORG_ROLE)(
  "claude role's Bash tool uses the role TMPDIR (#503)",
  () => {
    const cases = [
      { name: 'unsandboxed', sandboxed: false },
      ...(process.platform === 'linux' && sandboxAvailability().available
        ? [{ name: 'in the SDK sandbox', sandboxed: true }]
        : []),
    ];
    for (const { name, sandboxed } of cases)
      it(`${name}: TMPDIR, mktemp -d and CLAUDE_CODE_TMPDIR stay inside the role dir despite an inherited CLAUDE_CODE_TMPDIR`, async () => {
        const { out, roleDir } = await roleBash(sandboxed, CMD);
        const inRole = (p?: string) => p === roleDir || !!p?.startsWith(`${roleDir}/`);
        // TMPDIR as the command sees it, where a bare mktemp lands, and the
        // CLAUDE_CODE_TMPDIR a nested `claude` it starts would use.
        for (const k of ['TMPDIR_IS', 'MKTEMP_IS', 'CCT_IS']) expect(inRole(field(out, k)), `${k}\n${out}`).toBe(true);
        expect(field(out, 'MKTEMP_IS')).not.toBe(roleDir);
      }, 60_000);
  },
);
