/**
 * `doc ingest a b c` ingests every path, one after another in one process
 * (#416: the session-start reindex passes docs/, doc/ and top-level *.md in a
 * single run instead of sweeping `.`).
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';

const PROJECT = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-doc-ingest-multi-'));
const calls: string[] = [];

vi.mock('../memory/memory-bridge.js', () => ({ getProjectRoot: () => PROJECT }));
vi.mock('../knowledge/document-pipeline.js', () => ({
  ingestDirectory: async (p: string) => {
    calls.push(p);
    return { totalChunks: 1, filesProcessed: 1, filesSkipped: 0, errors: [], results: [] };
  },
  ingestDocument: async (p: string) => {
    calls.push(p);
    return { filePath: p, chunksIndexed: 1, scope: 'shared', skipped: false };
  },
}));

import { ingestCommand } from '../commands/doc-ingest.js';

afterAll(() => fs.rmSync(PROJECT, { recursive: true, force: true }));

describe('doc ingest with several paths', () => {
  it('ingests each path in order', async () => {
    fs.mkdirSync(path.join(PROJECT, 'docs'));
    fs.writeFileSync(path.join(PROJECT, 'README.md'), '# r\n');
    const docs = path.join(PROJECT, 'docs');
    const readme = path.join(PROJECT, 'README.md');
    const r = await ingestCommand.action!({
      args: [docs, readme],
      flags: {},
      cwd: PROJECT,
    } as never);
    expect(r?.success).toBe(true);
    expect(calls).toEqual([docs, readme]);
  });

  it('fails the run when one path is missing but still ingests the rest', async () => {
    calls.length = 0;
    const readme = path.join(PROJECT, 'README.md');
    const r = await ingestCommand.action!({
      args: [path.join(PROJECT, 'missing'), readme],
      flags: {},
      cwd: PROJECT,
    } as never);
    expect(r?.success).toBe(false);
    expect(calls).toEqual([readme]);
  });
});
