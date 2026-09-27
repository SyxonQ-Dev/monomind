/**
 * #360 guardrail 1: "no transitive escalation" — `--access full` must only
 * ever be reachable from a human-typed CLI invocation
 * (`commands/agent-exec.ts` parsing `--access full`), never from something
 * an agent, MCP client, workflow/routine node, hook, or the local dashboard
 * UI can drive on its own.
 *
 * These are regression tripwires, not a test of a live exploit — as of this
 * issue, NOTHING in this codebase other than commands/agent-exec.ts sets
 * `AgentExecOptions.access`/`AgentRunArgs.access` (verified by direct
 * source inspection: no MCP tool module imports the agent-exec engine, no
 * UI server route does either, and the org runtime's own AgentRunArgs
 * builder — session-stream.ts's `sessionRunArgs` — never sets `access` at
 * all, so every org-runtime session runs `permissionMode: 'default'`
 * unconditionally regardless of role policy). The point of these tests is
 * to fail loudly the moment any of that changes without an explicit,
 * reviewed guard — see doc/concepts/coder-mode-security.md's "No transitive
 * escalation" section for the full audit and the write paths (#365's org
 * MCP tools / role hiring / import) that still need their own guard when
 * they're built.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SRC_ROOT = join(__dirname, '..'); // packages/@monomind/cli/src

function listFiles(dir: string, exts: string[]): string[] {
  return (readdirSync(dir, { recursive: true, withFileTypes: true }) as any[])
    .filter((e) => e.isFile() && exts.some((ext) => e.name.endsWith(ext)))
    .map((e) => join(e.parentPath ?? e.path, e.name));
}

/** Every `.ts` file under `src/`, excluding tests and the engine's own
 *  modules (which legitimately reference themselves / are exercised by
 *  tests that construct `access: 'full'` directly as test fixtures). */
function allSourceFiles(): string[] {
  return listFiles(SRC_ROOT, ['.ts']).filter(
    (f) => !f.includes(`${join('__tests__')}/`) && !f.endsWith('.test.ts'),
  );
}

describe('#360: no transitive escalation to --access full', () => {
  it('no MCP tool module (src/mcp-tools/**, src/mcp/**) imports the agent-exec engine or resolveExecRunner', () => {
    const mcpDirs = [join(SRC_ROOT, 'mcp-tools'), join(SRC_ROOT, 'mcp')];
    const offenders: string[] = [];
    for (const dir of mcpDirs) {
      for (const file of listFiles(dir, ['.ts'])) {
        const text = readFileSync(file, 'utf8');
        if (/from ['"].*orgrt\/agent-exec(?:-access)?\.js['"]/.test(text)) offenders.push(file);
        if (/resolveExecRunner|runAgentExec\b/.test(text)) offenders.push(file);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('no UI server route (src/ui/**) references the agent-exec engine', () => {
    const uiDir = join(SRC_ROOT, 'ui');
    const offenders: string[] = [];
    for (const file of listFiles(uiDir, ['.mjs', '.ts'])) {
      const text = readFileSync(file, 'utf8');
      if (/orgrt\/agent-exec|resolveExecRunner|runAgentExec\b/.test(text)) offenders.push(file);
    }
    expect(offenders).toEqual([]);
  });

  it('runAgentExec is only ever called from the human-typed CLI layer (commands/agent-exec.ts)', () => {
    const allowedCallers = new Set([join(SRC_ROOT, 'commands', 'agent-exec.ts')]);
    const offenders: string[] = [];
    for (const file of allSourceFiles()) {
      if (file === join(SRC_ROOT, 'orgrt', 'agent-exec.ts')) continue; // the definition itself
      const text = readFileSync(file, 'utf8');
      if (/\brunAgentExec\(/.test(text) && !allowedCallers.has(file)) offenders.push(file);
    }
    expect(offenders).toEqual([]);
  });

  it("the org runtime's own AgentRunArgs builder (session-stream.ts's sessionRunArgs) never sets `access`", () => {
    const file = join(SRC_ROOT, 'orgrt', 'session-stream.ts');
    const text = readFileSync(file, 'utf8');
    // Extract the sessionRunArgs function body (from its `export function`
    // signature to the matching closing brace) rather than scanning the
    // whole file, so an unrelated `access` identifier elsewhere in the
    // module (there is none today) couldn't produce a false pass.
    const start = text.indexOf('export function sessionRunArgs');
    expect(start).toBeGreaterThan(-1);
    const body = text.slice(start);
    expect(body).not.toMatch(/\baccess\s*:/);
  });

  it('RUNNER_SPECS: only "claude" advertises supportsFullAccess (every other runtime rejects --access full)', async () => {
    const { RUNNER_SPECS } = await import('../orgrt/runner-registry.js');
    const fullAccessRuntimes = RUNNER_SPECS.filter((s) => s.supportsFullAccess).map((s) => s.id);
    expect(fullAccessRuntimes).toEqual(['claude']);
  });
});

describe('#360: ClaudeAgentRunner ignores anything but the exact literal access: "full"', () => {
  it('near-miss access values never enable bypassPermissions (strict equality, no coercion)', async () => {
    const { ClaudeAgentRunner } = await import('../orgrt/agent-runner-claude.js');
    const nearMisses: unknown[] = ['FULL', 'Full', true, 1, 'scoped', '', null, undefined];
    for (const access of nearMisses) {
      let captured: any;
      const stubQuery = ((opts: any) => {
        captured = opts.options;
        return (async function* () {})();
      }) as any;
      const runner = new ClaudeAgentRunner(stubQuery);
      const args: any = {
        tools: [],
        prompt: (async function* () {
          yield 'hi';
        })(),
        systemPrompt: '',
        cwd: process.cwd(),
        env: {},
        maxTurns: 1,
        access,
      };
      // eslint-disable-next-line no-empty
      for await (const _m of runner.run(args)) {
      }
      expect(captured.permissionMode).toBe('default');
      expect(captured.allowDangerouslySkipPermissions).toBeUndefined();
    }
  });
});
