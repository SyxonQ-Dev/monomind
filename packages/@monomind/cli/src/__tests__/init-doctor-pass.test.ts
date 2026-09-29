/**
 * #425: init's embedded doctor pass contradicted itself ("No .gitignore found"
 * then "All … gitignored") because it printed each check, fixed it, then
 * printed the re-check — and it ran before init's last writes. It now runs
 * once, after every write, printing only the final warnings/failures.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const calls = vi.hoisted((): string[] => []);

vi.mock('../init/index.js', async () => {
  const { DEFAULT_INIT_OPTIONS } = await import('../init/types.js');
  return {
    DEFAULT_INIT_OPTIONS,
    executeInit: vi.fn(async (options: { deferDoctor?: boolean }) => {
      calls.push(`executeInit(deferDoctor=${options.deferDoctor})`);
      return {
        success: true,
        created: { directories: [], files: [] },
        updated: [],
        skipped: [],
        removed: [],
        errors: [],
        summary: { skillsCount: 0, commandsCount: 0, agentsCount: 0, hooksEnabled: 0 },
      };
    }),
  };
});
vi.mock('../init/write-sample-org.js', () => ({
  writeSampleOrg: vi.fn(() => calls.push('writeSampleOrg')),
}));
vi.mock('../init/init-post-steps.js', () => ({
  runDoctorFix: vi.fn(async () => calls.push('runDoctorFix')),
}));
vi.mock('../routing/model-download.js', () => ({
  EMBEDDING_MODEL_SIZE_LABEL: '0 MB',
  downloadEmbeddingModel: vi.fn(),
  embeddingDownloadDecision: vi.fn(() => {
    calls.push('embeddingDecision');
    return 'already-cached';
  }),
  isEmbeddingModelCached: vi.fn(() => true),
}));

let dir: string;

beforeEach(() => {
  calls.length = 0;
  dir = mkdtempSync(join(tmpdir(), 'init-doctor-pass-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('monomind init doctor pass', () => {
  it('runs the doctor once, after executeInit and every later write', async () => {
    const { initAction } = await import('../commands/init-action.js');
    const res = await initAction({
      args: [],
      flags: { yes: true, 'no-start-all': true, watch: false },
      cwd: dir,
      interactive: false,
    } as never);
    expect(res.success).toBe(true);
    expect(calls.filter((c) => c === 'runDoctorFix')).toHaveLength(1);
    expect(calls[0]).toBe('executeInit(deferDoctor=true)');
    expect(calls.at(-1)).toBe('runDoctorFix');
    expect(calls.indexOf('runDoctorFix')).toBeGreaterThan(calls.indexOf('writeSampleOrg'));
    expect(calls.indexOf('runDoctorFix')).toBeGreaterThan(calls.indexOf('embeddingDecision'));
  });
});

describe('doctor problemsOnly', () => {
  it('prints only final non-pass lines — no pre-fix line a fix contradicts', async () => {
    const { output } = await import('../output.js');
    const lines: string[] = [];
    const spy = vi.spyOn(output, 'writeln').mockImplementation((t?: string) => {
      lines.push(t ?? '');
    });
    try {
      const { doctorCommand } = await import('../commands/doctor.js');
      // No .gitignore: the check warns, --fix writes one, the re-check passes.
      const res = await doctorCommand.action?.({
        args: [],
        flags: { fix: true, problemsOnly: true, component: 'gitignore' },
        cwd: dir,
      } as never);
      expect(res?.success).toBe(true);
    } finally {
      spy.mockRestore();
    }
    const text = lines.join('\n');
    expect(text).not.toContain('No .gitignore found');
    expect(text).not.toContain('gitignored');
    expect(text).not.toContain('MonoMind Doctor');
    expect(text).not.toContain('Summary:');
  });

  it('still prints a warning that survives the fix pass', async () => {
    const { output } = await import('../output.js');
    const lines: string[] = [];
    const spy = vi.spyOn(output, 'writeln').mockImplementation((t?: string) => {
      lines.push(t ?? '');
    });
    try {
      const { doctorCommand } = await import('../commands/doctor.js');
      await doctorCommand.action?.({
        args: [],
        flags: { problemsOnly: true, component: 'gitignore' },
        cwd: dir,
      } as never);
    } finally {
      spy.mockRestore();
    }
    expect(lines.join('\n')).toContain('No .gitignore found');
  });
});
