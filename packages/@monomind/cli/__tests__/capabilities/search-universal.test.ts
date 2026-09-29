import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import {
  formatSearchResults,
  groupByType,
  needsCodeIndexHint,
  searchUniversalCommand,
} from '../../src/commands/search-universal.js';
import type { SearchResult } from '../../src/capabilities/types.js';

const ftsSearch = vi.fn();
vi.mock('@monoes/monograph', () => ({
  openDb: vi.fn(() => ({})),
  closeDb: vi.fn(),
  ftsSearch: (...args: unknown[]) => ftsSearch(...args),
}));

describe('search formatting', () => {
  it('groups results by type', () => {
    const results: SearchResult[] = [
      { path: 'report.pdf', score: 0.9, snippet: 'quarterly report', type: 'documents' },
      { path: 'photo.jpg', score: 0.7, snippet: 'office photo', type: 'media' },
      { path: 'report2.md', score: 0.6, snippet: 'meeting notes', type: 'documents' },
    ];

    const grouped = groupByType(results);
    expect(grouped.documents?.length).toBe(2);
    expect(grouped.media?.length).toBe(1);
  });

  it('formats results with type headers', () => {
    const results: SearchResult[] = [
      { path: 'report.pdf', score: 0.9, snippet: 'quarterly report', type: 'documents' },
    ];

    const output = formatSearchResults(results);
    expect(output).toContain('Documents');
    expect(output).toContain('report.pdf');
    expect(output).toContain('quarterly report');
  });

  it('returns empty message when no results', () => {
    const output = formatSearchResults([]);
    expect(output).toContain('No results');
  });
});

describe('needsCodeIndexHint', () => {
  it('hints when code is active, unindexed, and search found nothing', () => {
    expect(needsCodeIndexHint(0, undefined, true, false)).toBe(true);
  });

  it('hints when the user explicitly filtered to --type code', () => {
    expect(needsCodeIndexHint(0, 'code', true, false)).toBe(true);
  });

  it('does not hint once the monograph DB exists (zero results is a real miss)', () => {
    expect(needsCodeIndexHint(0, undefined, true, true)).toBe(false);
  });

  it('does not hint when results were found', () => {
    expect(needsCodeIndexHint(3, undefined, true, false)).toBe(false);
  });

  it('does not hint when the code capability was never activated', () => {
    expect(needsCodeIndexHint(0, undefined, false, false)).toBe(false);
  });

  it('does not hint when the user filtered to a different type', () => {
    expect(needsCodeIndexHint(0, 'documents', true, false)).toBe(false);
  });
});

// Issue #322: `monomind search X [--type code]` missed symbols that
// `monomind monograph search -q X` found in the same project.
describe('search command — code symbols from the monograph index', () => {
  let dir: string;
  let logs: string[];

  async function run(flags: Record<string, unknown> = {}): Promise<string> {
    logs = [];
    const res = await searchUniversalCommand.action?.({
      args: ['QaCrossContentSymbol'],
      flags: { _: [], ...flags },
      cwd: dir,
      interactive: false,
    } as never);
    expect(res?.success).toBe(true);
    return logs.join('\n');
  }

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'monomind-search-322-'));
    const monomindDir = path.join(dir, '.monomind');
    fs.mkdirSync(monomindDir);
    // Enough matching docs to fill the default limit of 20 on their own.
    for (let i = 0; i < 25; i++) {
      fs.writeFileSync(path.join(dir, `note${i}.md`), `notes about QaCrossContentSymbol ${i}`);
    }
    fs.writeFileSync(path.join(dir, 'a.js'), 'function QaCrossContentSymbol() {}\n');
    // A fresh fingerprint taken before any code existed (as `init` writes one).
    const none = { confidence: 0, files: 0, signals: [] };
    fs.writeFileSync(
      path.join(monomindDir, 'fingerprint.json'),
      JSON.stringify({
        version: 1,
        root: dir,
        totalFiles: 25,
        git: false,
        scannedAt: new Date().toISOString(),
        capabilities: {
          code: none,
          documents: { confidence: 1, files: 25, signals: ['.md'] },
          media: none,
          data: none,
          graph: none,
          timeline: none,
        },
        filesByExtension: { '.md': 25 },
      }),
    );
    fs.writeFileSync(path.join(monomindDir, 'monograph.db'), '');
    ftsSearch.mockReturnValue([
      { name: 'QaCrossContentSymbol', label: 'Function', filePath: 'a.js', startLine: 1, rank: -1.2e-6 },
    ]);
    vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => {
      logs.push(a.join(' '));
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('includes the code hit in an unfiltered search', async () => {
    const out = await run();
    expect(out).toContain('a.js — Function QaCrossContentSymbol (line 1)');
    expect(out).toContain('Documents:');
  });

  it('returns the code hit for --type code', async () => {
    const out = await run({ type: 'code' });
    expect(out).toContain('a.js — Function QaCrossContentSymbol (line 1)');
    expect(out).not.toContain('Documents:');
  });

  it('keeps --type documents free of code hits', async () => {
    const out = await run({ type: 'documents' });
    expect(out).toContain('Documents:');
    expect(out).not.toContain('a.js');
  });

  it('points at `monograph build` when --type code has no index to search', async () => {
    fs.rmSync(path.join(dir, '.monomind', 'monograph.db'));
    fs.writeFileSync(path.join(dir, 'b.ts'), 'export const x = 1;\n');
    const fp = path.join(dir, '.monomind', 'fingerprint.json');
    const data = JSON.parse(fs.readFileSync(fp, 'utf-8'));
    data.capabilities.code = { confidence: 0.5, files: 2, signals: ['.js', '.ts'] };
    fs.writeFileSync(fp, JSON.stringify(data));
    const out = await run({ type: 'code' });
    expect(out).toContain('No results found.');
    expect(out).toContain('monomind monograph build');
  });
});

// Issue #479: `monomind search X` missed a document `doc ingest` had just
// indexed until `monomind search scan` was run — the fingerprint taken before
// the document existed kept the documents capability switched off.
describe('search command — freshly ingested documents (#479)', () => {
  let dir: string;
  let logs: string[];
  const fpPath = () => path.join(dir, '.monomind', 'fingerprint.json');

  async function run(query: string): Promise<string> {
    logs = [];
    const res = await searchUniversalCommand.action?.({
      args: [query],
      flags: { _: [] },
      cwd: dir,
      interactive: false,
    } as never);
    expect(res?.success).toBe(true);
    return logs.join('\n');
  }

  /** What `doc ingest` leaves behind: the file plus a metadata-log record. */
  function ingest(rel: string, content: string): void {
    const abs = path.join(dir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
    const knowledge = path.join(dir, '.monomind', 'knowledge');
    fs.mkdirSync(knowledge, { recursive: true });
    fs.appendFileSync(
      path.join(knowledge, 'doc-metadata.jsonl'),
      `${JSON.stringify({
        filePath: abs,
        contentHash: 'h',
        chunkCount: 1,
        indexedAt: new Date().toISOString(),
        scope: 'shared',
        size: content.length,
        version: 1,
      })}\n`,
    );
  }

  /** A code-only fingerprint, taken (as `init` takes one) an hour ago. */
  function writeCodeOnlyFingerprint(): void {
    const none = { confidence: 0, files: 0, signals: [] };
    fs.writeFileSync(
      fpPath(),
      JSON.stringify({
        version: 1,
        root: dir,
        totalFiles: 2,
        git: true,
        scannedAt: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
        capabilities: {
          code: { confidence: 1, files: 2, signals: ['.ts'] },
          documents: none,
          media: none,
          data: none,
          graph: none,
          timeline: none,
        },
        filesByExtension: { '.ts': 2 },
      }),
    );
  }

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'monomind-search-479-'));
    // A `.git` marker makes `dir` the project root the doc store resolves to.
    fs.mkdirSync(path.join(dir, '.git'));
    fs.mkdirSync(path.join(dir, '.monomind'));
    fs.mkdirSync(path.join(dir, 'src'));
    fs.writeFileSync(path.join(dir, 'src', 'a.ts'), 'export const a = 1;\n');
    fs.writeFileSync(path.join(dir, 'src', 'b.ts'), 'export const b = 2;\n');
    fs.writeFileSync(path.join(dir, '.monomind', 'monograph.db'), '');
    ftsSearch.mockReturnValue([]);
    vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => {
      logs.push(a.join(' '));
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('finds a document ingested after the last scan, with no manual scan', async () => {
    writeCodeOnlyFingerprint();
    ingest('docs/ingest-me.md', 'Notes about QUOKKA-PARROT-9921 here.');
    const out = await run('QUOKKA-PARROT-9921');
    expect(out).toContain('Documents:');
    expect(out).toContain(path.join('docs', 'ingest-me.md'));
  });

  it('finds an ingested document even when documents are a tiny share of the tree', async () => {
    for (let i = 0; i < 40; i++) {
      fs.writeFileSync(path.join(dir, 'src', `m${i}.ts`), `export const m${i} = ${i};\n`);
    }
    writeCodeOnlyFingerprint();
    ingest('docs/ingest-me.md', 'Notes about QUOKKA-PARROT-9921 here.');
    const out = await run('QUOKKA-PARROT-9921');
    expect(out).toContain(path.join('docs', 'ingest-me.md'));
  });

  it('does not rescan when the doc store has not changed since the last scan', async () => {
    ingest('docs/ingest-me.md', 'Notes about QUOKKA-PARROT-9921 here.');
    const logFile = path.join(dir, '.monomind', 'knowledge', 'doc-metadata.jsonl');
    const past = new Date(Date.now() - 2 * 60 * 60 * 1000);
    fs.utimesSync(logFile, past, past);
    writeCodeOnlyFingerprint();
    const before = fs.readFileSync(fpPath(), 'utf-8');
    const out = await run('QUOKKA-PARROT-9921');
    expect(out).not.toContain('rescanning');
    expect(fs.readFileSync(fpPath(), 'utf-8')).toBe(before);
    // Still found: ingested documents switch the documents type on.
    expect(out).toContain(path.join('docs', 'ingest-me.md'));
  });

  it('does not rescan when there is no doc store at all', async () => {
    writeCodeOnlyFingerprint();
    const before = fs.readFileSync(fpPath(), 'utf-8');
    const out = await run('anything');
    expect(out).not.toContain('rescanning');
    expect(fs.readFileSync(fpPath(), 'utf-8')).toBe(before);
  });
});

