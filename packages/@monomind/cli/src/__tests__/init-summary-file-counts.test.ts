/**
 * #420: init's summary counts files on disk. The item lists it used before
 * reported "267 created, 101 already exist" for an empty repo that got ~2,060.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { countInitFiles, formatInitFileCounts, snapshotInitFiles } from '../init/written-files.js';

function write(root: string, rel: string, body = 'x'): void {
  fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
  fs.writeFileSync(path.join(root, rel), body);
}

describe('init summary file counts (#420)', () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'init-counts-'));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('counts every file written across platform trees in an empty repo', () => {
    const before = snapshotInitFiles(dir);
    // One "item" (a skill folder) holding several files, in several trees.
    for (const tree of ['.claude', '.agents', '.gemini', '.kimi-code', '.codex']) {
      write(dir, `${tree}/skills/demo/SKILL.md`);
      write(dir, `${tree}/skills/demo/references/a.md`);
    }
    write(dir, 'CLAUDE.md');
    write(dir, 'AGENTS.md');

    const counts = countInitFiles(dir, before);
    expect(counts).toEqual({
      filesCreated: 12,
      filesUpdated: 0,
      filesUnchanged: 0,
      directoriesCreated: 5 * 4,
    });
    expect(formatInitFileCounts(counts)).toEqual(['Directories: 20 created', 'Files: 12 created']);
  });

  it('splits existing init files into updated and unchanged, ignoring user files and the graph', () => {
    write(dir, '.claude/settings.json');
    write(dir, '.claude/agents/kept.md');
    write(dir, 'package.json');
    write(dir, 'src/app.ts');
    const old = new Date(Date.now() - 60_000);
    for (const rel of ['.claude/settings.json', '.claude/agents/kept.md', 'package.json']) {
      fs.utimesSync(path.join(dir, rel), old, old);
    }

    const before = snapshotInitFiles(dir);
    write(dir, '.claude/settings.json', 'rewritten');
    write(dir, 'src/new.ts');
    write(dir, '.monomind/graph/monograph.db');
    write(dir, '.git/HEAD');

    const counts = countInitFiles(dir, before);
    expect(counts).toEqual({
      filesCreated: 0,
      filesUpdated: 1,
      filesUnchanged: 1,
      directoriesCreated: 1,
    });
    expect(formatInitFileCounts(counts)).toEqual([
      'Directories: 1 created',
      'Updated: 1 existing files',
      'Unchanged: 1 existing files left as they were',
    ]);
  });
});
