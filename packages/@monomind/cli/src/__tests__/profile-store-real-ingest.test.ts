/**
 * A browser capture filed into a fresh profile ingests, dedupes and reads back
 * through the REAL memory bridge (monoagent capture → `profile:<id>` store).
 *
 * profile-store.test.ts proves the routing with a fake bridge, and that is
 * exactly how this broke unnoticed: every chunk carries a `url:<canonical url>`
 * tag, and the real backend's tag validator refused `?`, `=` and `&`. So any
 * capture of a page with a query string — every YouTube video — failed with
 * "all chunk stores failed", in a profile or not, while the fake accepted it.
 * The envelope here is shaped like mono-agent's video capture: readable.md,
 * transcript.md and summary.md beside one meta.json, which also caught the
 * three members superseding each other under their shared URL.
 *
 * Runs in a throwaway directory with MONOMIND_GLOBAL_BRAIN_DIR pointed into it.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { MCPToolResult } from '../mcp-tools/types.js';

const ORIGINAL_CWD = process.cwd();
const ORIGINAL_GLOBAL = process.env.MONOMIND_GLOBAL_BRAIN_DIR;
const ORIGINAL_MM_CWD = process.env.MONOMIND_CWD;
const ROOT = fs.mkdtempSync(join(os.tmpdir(), 'mm-profile-real-'));
const BRAIN = join(ROOT, 'global-brain');

const A = '81ecb86c-2dcb-493f-bfd1-e11c013b3e12';
const B = 'personal';
const VIDEO_URL = 'https://www.youtube.com/watch?v=Pk7W7BKMwqo&list=PL1';
const B_URL = 'https://example.org/zebra?ref=feed&x=1';

function envelope(name: string, profile: string, url: string, files: Record<string, string>) {
  const dir = join(ROOT, 'monoagent', 'profiles', profile, '.monomind', 'inbox', name);
  fs.mkdirSync(dir, { recursive: true });
  for (const [file, body] of Object.entries(files)) fs.writeFileSync(join(dir, file), body);
  fs.writeFileSync(
    join(dir, 'meta.json'),
    JSON.stringify({
      url,
      canonicalUrl: url,
      title: `${name} title`,
      capturedAt: '2026-09-28T15:00:13.563Z',
      source: 'extension',
      profile,
    }),
  );
  return dir;
}

let VIDEO = '';
let ZEBRA = '';

beforeAll(() => {
  fs.mkdirSync(join(ROOT, '.monomind'), { recursive: true });
  process.env.MONOMIND_GLOBAL_BRAIN_DIR = BRAIN;
  delete process.env.MONOMIND_CWD;
  process.chdir(ROOT);
  VIDEO = envelope('video', A, VIDEO_URL, {
    'readable.md': '# Trading bot video\n\nThe description of a quokkatron trading engine.\n',
    'transcript.md': '# Transcript\n\n[0:01] The quokkatron engine sizes each position.\n',
    'summary.md': '# Summary\n\nA quokkatron classifier reads news fast.\n',
  });
  ZEBRA = envelope('zebra', B, B_URL, {
    'readable.md': '# Zebra husbandry\n\nFeeding the zebrafrond herd oats.\n',
  });
});

afterAll(() => {
  process.chdir(ORIGINAL_CWD);
  if (ORIGINAL_GLOBAL === undefined) delete process.env.MONOMIND_GLOBAL_BRAIN_DIR;
  else process.env.MONOMIND_GLOBAL_BRAIN_DIR = ORIGINAL_GLOBAL;
  if (ORIGINAL_MM_CWD !== undefined) process.env.MONOMIND_CWD = ORIGINAL_MM_CWD;
  try {
    fs.rmSync(ROOT, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
});

const pipeline = () => import('../knowledge/document-pipeline.js');

async function mcp(name: string, input: Record<string, unknown>) {
  const { knowledgeTools } = await import('../mcp-tools/knowledge-tools.js');
  const tool = knowledgeTools.find((t) => t.name === name);
  if (!tool) throw new Error(`no tool ${name}`);
  const res = (await tool.handler(input)) as MCPToolResult;
  return JSON.parse(String(res.content[0].text));
}

async function hits(query: string, scope: string) {
  const { searchKnowledge } = await pipeline();
  return searchKnowledge(query, { scope, rootDir: ROOT, limit: 20, minScore: 0 });
}

describe('a fresh profile store, through the real bridge', () => {
  it('ingests a capture with a query-string URL via doc ingest (ingestDirectory)', async () => {
    const { ingestDirectory } = await pipeline();
    const first = await ingestDirectory(VIDEO, 'shared', { rootDir: ROOT });
    expect(first.errors).toEqual([]);
    expect(first.filesProcessed).toBe(3);
    expect(first.totalChunks).toBeGreaterThanOrEqual(3);
    for (const r of first.results) expect(r.scope).toBe(`profile:${A}`);
    expect(fs.existsSync(join(BRAIN, 'profiles', A))).toBe(true);

    // Re-ingest is a no-op for every member — they no longer supersede each
    // other under the shared URL.
    const again = await ingestDirectory(VIDEO, 'shared', { rootDir: ROOT });
    expect(again.errors).toEqual([]);
    expect(again.filesSkipped).toBe(3);
    expect(again.totalChunks).toBe(0);

    const { listDocuments } = await pipeline();
    const live = listDocuments(join(BRAIN, 'profiles', A), `profile:${A}`);
    expect(live.map((d) => d.filePath.split('/').pop()).sort()).toEqual([
      'readable.md',
      'summary.md',
      'transcript.md',
    ]);
  });

  it('ingests via the MCP knowledge_ingest tool, and dedupes on repeat', async () => {
    const first = await mcp('knowledge_ingest', { path: join(ZEBRA, 'readable.md') });
    expect(first.error).toBeUndefined();
    expect(first.success).toBe(true);
    expect(first.chunksIndexed).toBeGreaterThan(0);
    expect(first.skipped).toBe(false);

    const again = await mcp('knowledge_ingest', { path: join(ZEBRA, 'readable.md') });
    expect(again.success).toBe(true);
    expect(again.skipped).toBe(true);
  });

  it('searches return the capture with provenance, only in its own profile', async () => {
    const own = await hits('quokkatron', `profile:${A}`);
    expect(own.length).toBeGreaterThan(0);
    expect(own[0].provenance?.url).toBe(VIDEO_URL);
    expect(own[0].provenance?.title).toBe('video title');
    expect(own[0].provenance?.capturedAt).toBe('2026-09-28T15:00:13.563Z');

    // Isolation: nothing from A's capture comes back from B, global or the
    // project, and the reverse. Asserted per hit rather than as "no results":
    // with an embedding model loaded and minScore 0, a store's OWN documents
    // come back as weak neighbours of any query, which is not a leak.
    const leaks = async (query: string, scope: string, foreignDir: string) => {
      const found = await hits(query, scope);
      for (const h of found) expect(h.scope, scope).toBe(scope);
      return found.filter((h) => h.filePath.startsWith(foreignDir));
    };
    for (const scope of [`profile:${B}`, 'global', 'shared']) {
      expect(await leaks('quokkatron', scope, VIDEO), scope).toEqual([]);
    }
    expect((await hits('zebrafrond', `profile:${B}`)).length).toBeGreaterThan(0);
    for (const scope of [`profile:${A}`, 'global', 'shared']) {
      expect(await leaks('zebrafrond', scope, ZEBRA), scope).toEqual([]);
    }

    const viaMcp = await mcp('knowledge_search', { query: 'quokkatron', scope: `profile:${A}` });
    expect(viaMcp.count).toBeGreaterThan(0);
    const fromA = await mcp('knowledge_search', { query: 'zebrafrond', scope: `profile:${A}` });
    const results = (fromA.results ?? []) as Array<{ filePath?: string }>;
    expect(results.filter((r) => r.filePath?.startsWith(ZEBRA))).toEqual([]);
  });

  it('cite, lookup and related resolve against the profile store given the project root', async () => {
    const { resolveCitation } = await import('../knowledge/citation.js');
    const cite = await resolveCitation(VIDEO_URL, { rootDir: ROOT, scope: `profile:${A}` });
    expect(cite.url).toBe(VIDEO_URL);
    expect(cite.title).toBe('video title');
    expect(cite.capturedAt).toBe('2026-09-28T15:00:13.563Z');
    await expect(
      resolveCitation(VIDEO_URL, { rootDir: ROOT, scope: `profile:${B}` }),
    ).rejects.toThrow(/not indexed/);

    const { lookupUrl } = await import('../knowledge/lookup.js');
    expect(lookupUrl(VIDEO_URL, { rootDir: ROOT, scope: `profile:${A}` }).saved).toBe(true);
    expect(lookupUrl(VIDEO_URL, { rootDir: ROOT, scope: `profile:${B}` }).saved).toBe(false);
    expect(lookupUrl(VIDEO_URL, { rootDir: ROOT, scope: 'global' }).saved).toBe(false);

    // A second page on the same site in A, and one in B: related sees only A's.
    const { ingestDirectory } = await pipeline();
    const { relatedDocuments } = await import('../knowledge/related.js');
    const other = envelope('other', A, 'https://www.youtube.com/watch?v=abc', {
      'readable.md': '# Sourdough\n\nA talk about bread.\n',
    });
    const bVideo = envelope('bvideo', B, 'https://www.youtube.com/watch?v=bbb', {
      'readable.md': '# B video\n\nSomething else.\n',
    });
    await ingestDirectory(other, 'shared', { rootDir: ROOT });
    await ingestDirectory(bVideo, 'shared', { rootDir: ROOT });
    const related = await relatedDocuments(VIDEO_URL, { rootDir: ROOT, scope: `profile:${A}` });
    expect(related.map((r) => r.url)).toEqual(['https://www.youtube.com/watch?v=abc']);
  });
});
