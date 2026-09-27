import { createRequire } from 'node:module';
import * as path from 'node:path';

import { type Corpus, type CorpusDoc, readDoc } from './corpus.js';
import type { GoldenPair } from './golden-set.js';
import type { EvalReport } from './harness-types.js';
import { assessTriviality } from './metrics.js';
import type { EvalChunk } from './retrievers.js';

export function detectDbDriver(): string {
  try {
    const req = createRequire(import.meta.url);
    req.resolve('better-sqlite3');
    try {
      req('better-sqlite3');
      return 'better-sqlite3';
    } catch {
      return 'sql.js (better-sqlite3 present but failed to load)';
    }
  } catch {
    return 'sql.js (WASM fallback)';
  }
}

export async function buildChunks(docs: CorpusDoc[]): Promise<EvalChunk[]> {
  let chunker: ((id: string, text: string) => any) | null = null;
  try {
    const mem: any = await import('@monoes/memory');
    if (typeof mem.chunkDocument === 'function') chunker = mem.chunkDocument;
  } catch {
    /* fall through to whole-document chunks */
  }

  const out: EvalChunk[] = [];
  for (const d of docs) {
    const text = readDoc(d);
    if (!chunker) {
      out.push({ docId: d.id, chunkIndex: 0, text });
      continue;
    }
    const chunks = await chunker(d.id, text);
    const list = Array.isArray(chunks) ? chunks : [];
    if (list.length === 0) {
      out.push({ docId: d.id, chunkIndex: 0, text });
      continue;
    }
    for (const c of list)
      out.push({ docId: d.id, chunkIndex: c.chunkIndex ?? 0, text: c.text ?? '' });
  }
  return out;
}

/** Validate each golden pair against the corpus and drop the trivially solvable ones. */
export function partitionTrivialPairs(
  candidatePairs: GoldenPair[],
  byId: Map<string, CorpusDoc>,
  textOf: (id: string) => string,
  scored: GoldenPair[],
  dropped: EvalReport['droppedPairs'],
): void {
  for (const pair of candidatePairs) {
    const unknown = pair.relevant.filter((r) => !byId.has(r));
    if (unknown.length > 0) {
      // Never a silent skip: a golden set pointing at documents the corpus does
      // not contain is a broken set, and a broken set produces a fake number.
      throw new Error(
        `[doc eval] golden pair "${pair.id}" references documents not in the corpus: ${unknown.join(', ')}`,
      );
    }
    let worst = { trivial: false, reason: '', maxContiguousRun: 0, overlapRatio: 0 };
    for (const r of pair.relevant) {
      const t = assessTriviality(pair.query, textOf(r));
      if (t.maxContiguousRun > worst.maxContiguousRun) {
        worst = {
          trivial: t.trivial,
          reason: t.reason ?? '',
          maxContiguousRun: t.maxContiguousRun,
          overlapRatio: t.overlapRatio,
        };
      }
    }
    if (worst.trivial) {
      dropped.push({
        id: pair.id,
        reason: worst.reason,
        maxContiguousRun: worst.maxContiguousRun,
        overlapRatio: worst.overlapRatio,
      });
    } else {
      scored.push(pair);
    }
  }
}

/** Distinct documents by top-level directory and by extension. */
export function corpusComposition(corpus: Corpus): EvalReport['corpusComposition'] {
  const byTopLevel: Record<string, number> = {};
  const byExtension: Record<string, number> = {};
  for (const d of corpus.docs) {
    if (corpus.canonicalOf.get(d.id) !== d.id) continue;
    const top = d.id.includes('/') ? d.id.split('/')[0] : '<root>';
    byTopLevel[top] = (byTopLevel[top] ?? 0) + 1;
    const ext = path.extname(d.id).toLowerCase() || '<none>';
    byExtension[ext] = (byExtension[ext] ?? 0) + 1;
  }
  return { byTopLevel, byExtension };
}
