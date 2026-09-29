import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { scanPhase } from '../../../pipeline/phases/scan.js';

function makeCtx(repoPath: string): any {
  return { repoPath, options: { ignore: [], codeOnly: false }, onProgress: undefined };
}

function write(root: string, rel: string, content = 'export const x = 1;'): void {
  const full = join(root, rel);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, content);
}

async function scannedPaths(root: string): Promise<string[]> {
  const out = await scanPhase.execute(makeCtx(root), new Map());
  return out.filePaths.map((p: string) => p.slice(root.length + 1));
}

describe('scanPhase monomind asset mirrors (#404)', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'scan-mirrors-test-'));
    write(tmpDir, 'src/app.ts');
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('skips the platform asset mirror trees, its own cache and the mail dir', async () => {
    const dirs = ['.agents', '.gemini', '.kimi-code', '.opencode', '.codex', '.monograph', '.mail'];
    for (const dir of dirs) write(tmpDir, `${dir}/helpers/hook-handler.js`);
    const paths = await scannedPaths(tmpDir);
    for (const dir of dirs) {
      expect(paths.some((p) => p.startsWith(`${dir}/`))).toBe(false);
    }
    expect(paths).toContain('src/app.ts');
  });
});

describe('scanPhase .gitignore (#404)', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'scan-gitignore-test-'));
    execFileSync('git', ['init', '-q'], { cwd: tmpDir });
    write(tmpDir, 'src/app.ts');
    write(tmpDir, 'src/untracked.ts');
    write(tmpDir, 'venv/lib/site.py', 'x = 1');
    write(tmpDir, 'src/secret-gen.ts');
    write(tmpDir, 'logs/run.log', 'log');
    write(tmpDir, '.gitignore', 'venv/\nsrc/secret-gen.ts\n*.log\n');
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('does not scan gitignored files or directories', async () => {
    const paths = await scannedPaths(tmpDir);
    expect(paths).toContain('src/app.ts');
    expect(paths).toContain('src/untracked.ts');
    expect(paths.some((p) => p.startsWith('venv/'))).toBe(false);
    expect(paths).not.toContain('src/secret-gen.ts');
    expect(paths).not.toContain('logs/run.log');
  });

  it('keeps tracked files even when they match .gitignore', async () => {
    execFileSync('git', ['add', '-f', 'src/secret-gen.ts'], { cwd: tmpDir });
    const paths = await scannedPaths(tmpDir);
    expect(paths).toContain('src/secret-gen.ts');
  });

  it('lets a .monographignore negation rescue a gitignored file', async () => {
    write(tmpDir, '.monographignore', '!src/secret-gen.ts\n');
    const paths = await scannedPaths(tmpDir);
    expect(paths).toContain('src/secret-gen.ts');
  });

  it('honours .gitignore when the scan root is a subdirectory of the repo', async () => {
    const paths = await scannedPaths(join(tmpDir, 'src'));
    expect(paths).toContain('app.ts');
    expect(paths).not.toContain('secret-gen.ts');
  });

  it('falls back to a plain walk outside a git repository', async () => {
    rmSync(join(tmpDir, '.git'), { recursive: true, force: true });
    const paths = await scannedPaths(tmpDir);
    expect(paths.some((p) => p.startsWith('venv/'))).toBe(true);
    expect(paths).toContain('src/app.ts');
  });
});
