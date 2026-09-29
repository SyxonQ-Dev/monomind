/**
 * #495: with a machine output format (`-o json|sarif`, `--json`) stdout must
 * carry only the document. Banners, spinner progress and summaries go to
 * stderr, and `-Q/--quiet` drops them entirely.
 */

import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../memory/memory-initializer.js', () => ({
  generateEmbedding: vi.fn(async () => ({ embedding: [] })),
  batchCosineSim: vi.fn(() => []),
  flashAttentionSearch: vi.fn(() => []),
  getHNSWStatus: vi.fn(async () => ({ available: false })),
  storeEntry: vi.fn(async () => ({})),
  searchEntries: vi.fn(async () => ({ results: [] })),
}));
vi.mock('../memory/intelligence.js', () => ({
  benchmarkAdaptation: vi.fn(() => ({})),
  initializeIntelligence: vi.fn(async () => undefined),
}));

vi.mock('monofence-ai', () => ({
  createMonoDefence: () => ({
    detect: async () => ({ safe: true, threats: [], piiFound: false }),
  }),
}));

import { coverageGapsCommand } from '../commands/hooks-coverage-gaps.js';
import { benchmarkCommand } from '../commands/performance-benchmark.js';
import { cveCommand } from '../commands/security-cve.js';
import { defendCommand } from '../commands/security-defend.js';
import { scanCommand } from '../commands/security-scan.js';
import { output } from '../output.js';
import type { CommandContext } from '../types.js';

let dir: string;
let prevCwd: string;
let stdout: string;
let stderr: string;

function ctx(flags: Record<string, unknown>): CommandContext {
  return {
    args: [],
    flags: { _: [], ...flags } as CommandContext['flags'],
    cwd: dir,
    interactive: false,
  };
}

beforeEach(() => {
  prevCwd = process.cwd();
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'mm495-')));
  writeFileSync(join(dir, 'app.js'), 'const x = eval(input);\n');
  process.chdir(dir);
  stdout = '';
  stderr = '';
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
    stdout += String(chunk);
    return true;
  });
  vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => {
    stderr += String(chunk);
    return true;
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  output.setVerbosity('normal');
  process.chdir(prevCwd);
  rmSync(dir, { recursive: true, force: true });
});

describe('security scan machine output (#495)', () => {
  it('-o json: stdout is exactly one JSON document, banner goes to stderr', async () => {
    await scanCommand.action!(ctx({ output: 'json', type: 'code' }));
    const doc = JSON.parse(stdout);
    expect(doc.findings.length).toBeGreaterThan(0);
    expect(stderr).toContain('Security Scan');
  });

  it('-o sarif: stdout is exactly one SARIF document', async () => {
    await scanCommand.action!(ctx({ output: 'sarif', type: 'code' }));
    const doc = JSON.parse(stdout);
    expect(doc.version).toBe('2.1.0');
    expect(Array.isArray(doc.runs)).toBe(true);
  });

  it('-o sarif -Q: the human lines are dropped, not just moved', async () => {
    output.setVerbosity('quiet');
    await scanCommand.action!(ctx({ output: 'sarif', type: 'code' }));
    expect(JSON.parse(stdout).version).toBe('2.1.0');
    expect(stderr).not.toContain('Security Scan');
    expect(stderr).not.toContain('Scan complete');
  });

  it('text -Q: the banner and progress lines are suppressed, results remain', async () => {
    output.setVerbosity('quiet');
    await scanCommand.action!(ctx({ type: 'code' }));
    const all = stdout + stderr;
    expect(all).not.toContain('Security Scan\n');
    expect(all).not.toContain('Scan complete');
    expect(all).toContain('Scan Summary');
  });
});

describe('security cve --json (#495)', () => {
  it('--check with --json: stdout is exactly the CVE document', async () => {
    const cacheDir = join(dir, '.monomind', 'cache', 'cve');
    mkdirSync(cacheDir, { recursive: true });
    writeFileSync(
      join(cacheDir, 'CVE-2024-12345.json'),
      JSON.stringify({ _source: 'osv', id: 'CVE-2024-12345' }),
    );
    await cveCommand.action!(ctx({ check: 'CVE-2024-12345', json: true }));
    expect(JSON.parse(stdout).id).toBe('CVE-2024-12345');
    expect(stderr).toContain('CVE / Vulnerability Scanner');
  });
});

describe('performance benchmark -o json (#495)', () => {
  it('stdout is exactly the results document', async () => {
    await benchmarkCommand.action!(
      ctx({ output: 'json', suite: 'wasm', iterations: '1', warmup: '0' }),
    );
    const doc = JSON.parse(stdout);
    expect(doc.suite).toBe('wasm');
    expect(stderr).toContain('Performance Benchmark');
  });
});

describe('security defend -o json (#495)', () => {
  it('stdout is exactly the detection document', async () => {
    await defendCommand.action!(ctx({ output: 'json', input: 'hello there' }));
    expect(JSON.parse(stdout).safe).toBe(true);
    expect(stderr).toContain('MonoFence');
  });
});

describe('spinner status lines never reach stdout (#495)', () => {
  it('hooks coverage-gaps --format json: stdout is exactly the gaps document', async () => {
    mkdirSync(join(dir, 'coverage'));
    const pct = { total: 10, covered: 5, skipped: 0, pct: 50 };
    writeFileSync(
      join(dir, 'coverage', 'coverage-summary.json'),
      JSON.stringify({
        total: { lines: pct, branches: pct, functions: pct, statements: pct },
        [join(dir, 'app.js')]: { lines: pct, branches: pct, functions: pct, statements: pct },
      }),
    );
    await coverageGapsCommand.action!(ctx({ format: 'json' }));
    expect(JSON.parse(stdout).success).toBe(true);
    expect(stderr).toContain('Analyzing project coverage gaps');
  });
});
