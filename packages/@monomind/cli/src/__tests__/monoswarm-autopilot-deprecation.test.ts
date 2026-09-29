/**
 * #418: monoswarm and autopilot are deprecated and removed in the next minor
 * release. Every subcommand prints a one-line notice on stderr — never on
 * stdout, so `--format json` / `--json` output still parses — and `-Q` drops
 * it. The MCP tools carry the note in their descriptions and results.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AUTOPILOT_DEPRECATION,
  MONOSWARM_AUTOPILOT_REMOVAL_VERSION,
  MONOSWARM_DEPRECATION,
} from '../deprecations.js';
import { CLI } from '../index.js';
import { generateClaudeMd } from '../init/claudemd-generator.js';
import { MONOSWARM_DEPRECATED_LINE } from '../init/claudemd-sections-core.js';
import { DEFAULT_INIT_OPTIONS } from '../init/types.js';
import { autopilotTools } from '../mcp-tools/autopilot-tools.js';
import { withDeprecatedField } from '../mcp-tools/deprecated-tools.js';
import { monoswarmTools } from '../mcp-tools/monoswarm-tools.js';
import { output } from '../output.js';

let tmpCwd: string;
let originalCwd: string;
let stdout: string;
let stderr: string;

beforeEach(() => {
  originalCwd = process.cwd();
  tmpCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-deprec-'));
  process.chdir(tmpCwd);
  process.env.MONOMIND_CWD = tmpCwd;
  // autopilot's team-tasks source reads ~/.claude/tasks.
  vi.stubEnv('HOME', tmpCwd);
  stdout = '';
  stderr = '';
  vi.spyOn(process.stdout, 'write').mockImplementation((s: string | Uint8Array) => {
    stdout += String(s);
    return true;
  });
  vi.spyOn(process.stderr, 'write').mockImplementation((s: string | Uint8Array) => {
    stderr += String(s);
    return true;
  });
  vi.spyOn(process, 'exit').mockImplementation((code?: string | number | null) => {
    throw new Error(`process.exit: ${code}`);
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  output.setVerbosity('normal');
  process.chdir(originalCwd);
  delete process.env.MONOMIND_CWD;
  fs.rmSync(tmpCwd, { recursive: true, force: true });
});

const run = (...args: string[]) => new CLI({ interactive: false }).run([...args, '--no-update']);

describe('monoswarm CLI deprecation notice (#418)', () => {
  it('names the removal release and the replacements', () => {
    expect(MONOSWARM_AUTOPILOT_REMOVAL_VERSION).toBe('2.21.0');
    expect(MONOSWARM_DEPRECATION).toMatch(/deprecated.*next minor release/);
    expect(MONOSWARM_DEPRECATION).toMatch(/starts no agents/);
    expect(MONOSWARM_DEPRECATION).toMatch(/Task tool/);
    expect(MONOSWARM_DEPRECATION).toMatch(/monomind org run/);
  });

  it('text mode: notice on stderr, not stdout', async () => {
    await run('monoswarm', 'status');
    expect(stderr).toContain(MONOSWARM_DEPRECATION);
    expect(stdout).not.toContain('deprecated and will be removed');
    expect(stdout).toMatch(/No active swarm/);
  });

  it('--format json: notice on stderr, stdout parses as JSON', async () => {
    await run('monoswarm', 'status', '--format', 'json');
    expect(stderr).toContain(MONOSWARM_DEPRECATION);
    expect(() => JSON.parse(stdout)).not.toThrow();
    expect(JSON.parse(stdout)).toHaveProperty('hasActiveSwarm', false);
  });

  it('init --format json prints only the result document on stdout', async () => {
    await run('monoswarm', 'init', '--format', 'json');
    const doc = JSON.parse(stdout);
    expect(doc.monoswarmId).toMatch(/^monoswarm-/);
    expect(doc.deprecated).toBe(MONOSWARM_DEPRECATION);
    expect(stderr).toContain(MONOSWARM_DEPRECATION);
    expect(stderr).toMatch(/no agents started/);
  });

  it('-Q suppresses the notice', async () => {
    await run('monoswarm', 'status', '--format', 'json', '-Q');
    expect(stderr).not.toContain(MONOSWARM_DEPRECATION);
    expect(() => JSON.parse(stdout)).not.toThrow();
  });

  it('every monoswarm subcommand prints the notice', async () => {
    const { monoswarmCommand } = await import('../commands/monoswarm.js');
    for (const sub of monoswarmCommand.subcommands ?? []) {
      stderr = '';
      // Missing required args make most of them fail fast — the notice
      // must still come first.
      await sub.action?.({ args: [], flags: { _: [] }, cwd: tmpCwd, interactive: false });
      expect(stderr, sub.name).toContain(MONOSWARM_DEPRECATION);
    }
  });
});

describe('autopilot CLI deprecation notice (#418)', () => {
  it('text mode: notice on stderr, not stdout', async () => {
    await run('autopilot', 'status');
    expect(stderr).toContain(AUTOPILOT_DEPRECATION);
    expect(stdout).not.toMatch(/deprecated/i);
    expect(stdout).toMatch(/Autopilot:/);
  });

  it('--json: notice on stderr, stdout parses as JSON', async () => {
    await run('autopilot', 'status', '--json');
    expect(stderr).toContain(AUTOPILOT_DEPRECATION);
    expect(JSON.parse(stdout)).toHaveProperty('enabled');
  });

  it('-Q suppresses the notice', async () => {
    await run('autopilot', 'log', '--json', '-Q');
    expect(stderr).not.toContain(AUTOPILOT_DEPRECATION);
    expect(JSON.parse(stdout)).toEqual([]);
  });
});

describe('monoswarm/autopilot MCP tools are marked deprecated (#418)', () => {
  it('every description carries the deprecation', () => {
    expect(monoswarmTools.length).toBeGreaterThan(0);
    for (const tool of monoswarmTools) {
      expect(tool.description, tool.name).toMatch(/^DEPRECATED: /);
      expect(tool.description, tool.name).toContain(MONOSWARM_DEPRECATION);
    }
    expect(autopilotTools.length).toBeGreaterThan(0);
    for (const tool of autopilotTools) {
      expect(tool.description, tool.name).toMatch(/^DEPRECATED: /);
      expect(tool.description, tool.name).toContain(AUTOPILOT_DEPRECATION);
    }
  });

  it('monoswarm results carry a deprecated field', async () => {
    const status = monoswarmTools.find((t) => t.name === 'monoswarm_status');
    const result = (await status?.handler({})) as Record<string, unknown>;
    expect(result.deprecated).toBe(MONOSWARM_DEPRECATION);
  });

  it('autopilot results carry a deprecated field inside the JSON text', async () => {
    const status = autopilotTools.find((t) => t.name === 'autopilot_status');
    const result = (await status?.handler({})) as { content: Array<{ text: string }> };
    expect(result.content).toHaveLength(1);
    expect(JSON.parse(result.content[0].text).deprecated).toBe(AUTOPILOT_DEPRECATION);
  });

  it('non-JSON content gets the note as an extra text item; primitives pass through', () => {
    expect(withDeprecatedField({ content: [{ type: 'text', text: 'plain' }] }, 'n')).toEqual({
      content: [
        { type: 'text', text: 'plain' },
        { type: 'text', text: 'n' },
      ],
    });
    expect(withDeprecatedField('x', 'n')).toBe('x');
    expect(withDeprecatedField([1], 'n')).toEqual([1]);
  });
});

describe('generated CLAUDE.md marks monoswarm deprecated (#418)', () => {
  const md = (template: 'full' | 'security' | 'performance' | 'standard') =>
    generateClaudeMd({ ...DEFAULT_INIT_OPTIONS, targetDir: tmpCwd }, template);

  it.each(['full', 'security', 'performance'] as const)(
    '%s: every monoswarm section carries the deprecation, headings unchanged',
    (template) => {
      const out = md(template);
      for (const heading of [
        '## Monoswarm Orchestration',
        '## Monoswarm Configuration & Anti-Drift',
        '## Monoswarm Execution Rules',
      ]) {
        const start = out.indexOf(heading);
        expect(start, heading).toBeGreaterThanOrEqual(0);
        const next = out.indexOf('\n## ', start + heading.length);
        const section = out.slice(start, next === -1 ? undefined : next);
        expect(section, heading).toContain(MONOSWARM_DEPRECATED_LINE);
      }
      expect(out).not.toContain('npx monomind monoswarm init');
    },
  );

  it('the deprecation line names the removal release and the replacements', () => {
    expect(MONOSWARM_DEPRECATED_LINE).toContain(MONOSWARM_AUTOPILOT_REMOVAL_VERSION);
    expect(MONOSWARM_DEPRECATED_LINE).toMatch(/Task tool/);
    expect(MONOSWARM_DEPRECATED_LINE).toMatch(/monomind org run/);
  });

  it('the lean standard template still carries no monoswarm section', () => {
    expect(md('standard')).not.toMatch(/## Monoswarm/);
  });
});
