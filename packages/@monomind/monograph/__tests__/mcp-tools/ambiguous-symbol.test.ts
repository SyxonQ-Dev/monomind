import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { unlinkSync, existsSync } from 'node:fs';
import { openDb, closeDb } from '../../src/storage/db.js';
import { insertNode } from '../../src/storage/node-store.js';
import { insertEdge } from '../../src/storage/edge-store.js';
import { getMonographImpact } from '../../src/mcp-tools/impact.js';
import { getMonographContext } from '../../src/mcp-tools/context.js';
import type { MonographNode, MonographEdge } from '../../src/types.js';

// Issue #405: `bridgeStoreEntry` is defined for real in src/ and mocked in a
// test file. The mock is inserted first, so a `LIMIT 1` lookup picks it and
// reports "0 callers, Risk LOW" for a symbol with real callers.

const dbPath = join(tmpdir(), `monograph-ambiguous-${Date.now()}.db`);
let db: ReturnType<typeof openDb>;

const fn = (id: string, name: string, filePath: string): MonographNode => ({
  id,
  label: 'Function',
  name,
  normLabel: name.toLowerCase(),
  filePath,
  startLine: 1,
  isExported: true,
});
const calls = (sourceId: string, targetId: string): MonographEdge => ({
  id: `e_${sourceId}_${targetId}`,
  sourceId,
  targetId,
  relation: 'CALLS',
  confidence: 'EXTRACTED',
  confidenceScore: 1.0,
});

beforeAll(() => {
  db = openDb(dbPath);
  insertNode(db, fn('mock', 'bridgeStoreEntry', 'src/__tests__/bridge.test.ts'));
  insertNode(db, fn('real', 'bridgeStoreEntry', 'src/memory/bridge.ts'));
  insertNode(db, fn('c1', 'storeA', 'src/a.ts'));
  insertNode(db, fn('c2', 'storeB', 'src/b.ts'));
  insertEdge(db, calls('c1', 'real'));
  insertEdge(db, calls('c2', 'real'));
});

afterAll(() => {
  closeDb(db);
  for (const p of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) {
    if (existsSync(p)) unlinkSync(p);
  }
});

describe('getMonographImpact with a name matching several definitions', () => {
  it('returns the candidates, non-test first, instead of a risk verdict', () => {
    const result = getMonographImpact(db, { name: 'bridgeStoreEntry' });
    expect(result.ambiguous).toBe(true);
    expect(result.node).toBeNull();
    expect(result.directCallers).toHaveLength(0);
    expect(result.candidates?.map((c) => c.filePath)).toEqual([
      'src/memory/bridge.ts',
      'src/__tests__/bridge.test.ts',
    ]);
  });

  it('computes normally once filePath picks one definition', () => {
    const result = getMonographImpact(db, {
      name: 'bridgeStoreEntry',
      filePath: 'src/memory/bridge.ts',
    });
    expect(result.ambiguous).toBe(false);
    expect(result.node?.id).toBe('real');
    expect(result.directCallers.map((n) => n.id).sort()).toEqual(['c1', 'c2']);
  });

  it('accepts a trailing path fragment as the disambiguator', () => {
    const result = getMonographImpact(db, { name: 'bridgeStoreEntry', filePath: 'bridge.ts' });
    expect(result.node?.id).toBe('real');
  });

  it('accepts a nodeId as the disambiguator', () => {
    const result = getMonographImpact(db, { name: 'bridgeStoreEntry', nodeId: 'mock' });
    expect(result.node?.id).toBe('mock');
    expect(result.directCallers).toHaveLength(0);
  });
});

describe('getMonographContext with a name matching several definitions', () => {
  it('returns the candidates, non-test first, instead of one node', () => {
    const result = getMonographContext(db, { name: 'bridgeStoreEntry' });
    expect(result.ambiguous).toBe(true);
    expect(result.node).toBeNull();
    expect(result.callers).toHaveLength(0);
    expect(result.candidates?.map((c) => c.id)).toEqual(['real', 'mock']);
  });

  it('computes normally once filePath picks one definition', () => {
    const result = getMonographContext(db, {
      name: 'bridgeStoreEntry',
      filePath: 'src/memory/bridge.ts',
    });
    expect(result.ambiguous).toBe(false);
    expect(result.node?.id).toBe('real');
    expect(result.callers.map((n) => n.id).sort()).toEqual(['c1', 'c2']);
  });
});
