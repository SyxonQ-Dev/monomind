/**
 * #398: `providers configure -k` writes the API key in plain text to
 * `monomind.config.json`, and `.swarm/` / `.claude/memory.db` hold
 * session-derived memory — none were gitignored after init, and doctor's
 * coverage check passed anyway. Uses the real `git check-ignore` matcher.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { checkGitignoreCoverage, fixGitignoreCoverage } from '../commands/doctor-project-checks.js';
import { output } from '../output.js';

const SENSITIVE = ['monomind.config.json', '.swarm/memory.db', '.claude/memory.db'];

let dir: string;
let cwd: string;

beforeEach(() => {
  cwd = process.cwd();
  dir = mkdtempSync(join(tmpdir(), 'mm-gitignore-398-'));
  execFileSync('git', ['init', '--quiet'], { cwd: dir });
  process.chdir(dir);
});

afterEach(() => {
  process.chdir(cwd);
  vi.restoreAllMocks();
  rmSync(dir, { recursive: true, force: true });
});

const ignored = (rel: string): boolean => {
  try {
    execFileSync('git', ['check-ignore', '-q', rel], { cwd: dir, stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
};

describe('doctor --fix (run by init) ignores the provider key file and memory DBs', () => {
  it('with no .gitignore', async () => {
    expect(await fixGitignoreCoverage(dir)).toBe(true);
    for (const p of SENSITIVE) expect(ignored(p), p).toBe(true);
  });

  it('with an existing .gitignore', async () => {
    writeFileSync(join(dir, '.gitignore'), 'node_modules/\n');
    expect(await fixGitignoreCoverage(dir)).toBe(true);
    for (const p of SENSITIVE) expect(ignored(p), p).toBe(true);
  });
});

describe('doctor gitignore check requires them', () => {
  for (const pattern of ['monomind.config.json', '.swarm/', '.claude/memory.db']) {
    it(`warns when ${pattern} is missing`, async () => {
      await fixGitignoreCoverage(dir);
      const gitignore = join(dir, '.gitignore');
      const lines = readFileSync(gitignore, 'utf-8').split('\n');
      writeFileSync(gitignore, lines.filter((l) => l !== pattern).join('\n'));
      const result = await checkGitignoreCoverage(dir);
      expect(result.status).toBe('warn');
      expect(result.message).toContain(pattern);
    });
  }
});

describe('providers configure warns when the key file is not gitignored', () => {
  async function configure(): Promise<string> {
    const lines: string[] = [];
    vi.spyOn(output, 'writeln').mockImplementation((s?: string) => {
      lines.push(String(s ?? ''));
    });
    const { providersCommand } = await import('../commands/providers.js');
    const sub = providersCommand.subcommands?.find((c) => c.name === 'configure');
    const res = await sub?.action?.({
      args: [],
      flags: { provider: 'openai', key: 'test-key-398-value' },
      cwd: dir,
    } as never);
    expect(res && (res as { success?: boolean }).success).toBe(true);
    return lines.join('\n');
  }

  it('warns and names the file', async () => {
    const out = await configure();
    expect(out).toContain(join(dir, 'monomind.config.json'));
    expect(out).toMatch(/not gitignored/i);
  });

  it('stays quiet about gitignore once the file is ignored', async () => {
    writeFileSync(join(dir, '.gitignore'), 'monomind.config.json\n');
    const out = await configure();
    expect(out).not.toMatch(/not gitignored/i);
  });
});
