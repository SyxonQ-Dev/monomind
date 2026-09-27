import { buildCorpus, readDoc, resolveRepoRoot } from './corpus.js';
import { assessTriviality, buildIdf, idfOverlap } from './metrics.js';

// -- Authoring-time candidate screening ------------------------------
//
// The expansion's real risk is drift under volume: authoring 300 queries is
// tedious in a way authoring 96 is not, and the path of least resistance is to
// open the document and paraphrase it. That is precisely how the v1 set became
// high-overlap dominated, which is why BM25 wins its aggregate. Screening
// candidates AS THEY ARE AUTHORED — rather than measuring the distribution
// afterwards and being disappointed — is the only defence that survives
// tedium.

export interface ScreenedCandidate {
  id: string;
  query: string;
  relevant: string[];
  idfOverlap: number;
  maxContiguousRun: number;
  band: 'low' | 'mid' | 'high';
  accepted: boolean;
  reason?: string;
}

export interface ScreenReport {
  corpusHash: string;
  total: number;
  accepted: number;
  rejected: number;
  bands: { low: number; mid: number; high: number };
  candidates: ScreenedCandidate[];
}

/**
 * @param bandCuts overlap thresholds; defaults match the v1 TEST terciles so a
 *                 candidate is judged against the distribution we are trying
 *                 to move, not against the one it would itself create.
 */
export async function screenCandidates(
  repoRootIn: string,
  candidates: Array<{ id: string; query: string; relevant: string[] }>,
  bandCuts: { low: number; high: number } = { low: 0.247, high: 0.455 },
): Promise<ScreenReport> {
  const repoRoot = resolveRepoRoot(repoRootIn);
  const corpus = buildCorpus(repoRoot);
  const byId = new Map(corpus.docs.map((d) => [d.id, d]));
  const cache = new Map<string, string>();
  const textOf = (id: string): string => {
    let t = cache.get(id);
    if (t === undefined) {
      t = readDoc(byId.get(id)!);
      cache.set(id, t);
    }
    return t;
  };
  const idf = buildIdf(corpus.docs.map((d) => textOf(d.id)));

  const seen = new Set<string>();
  const out: ScreenedCandidate[] = [];
  for (const c of candidates) {
    const missing = c.relevant.filter((r) => !byId.has(r));
    if (missing.length > 0) {
      out.push({
        ...c,
        idfOverlap: 0,
        maxContiguousRun: 0,
        band: 'low',
        accepted: false,
        reason: `target not in corpus: ${missing.join(', ')}`,
      });
      continue;
    }
    if (seen.has(c.id)) {
      out.push({
        ...c,
        idfOverlap: 0,
        maxContiguousRun: 0,
        band: 'low',
        accepted: false,
        reason: 'duplicate id',
      });
      continue;
    }
    seen.add(c.id);

    const overlap = Math.max(...c.relevant.map((r) => idfOverlap(idf, c.query, textOf(r))));
    const run = Math.max(
      ...c.relevant.map((r) => assessTriviality(c.query, textOf(r)).maxContiguousRun),
    );
    const trivial = c.relevant.some((r) => assessTriviality(c.query, textOf(r)).trivial);
    const band: 'low' | 'mid' | 'high' =
      overlap < bandCuts.low ? 'low' : overlap < bandCuts.high ? 'mid' : 'high';

    out.push({
      ...c,
      idfOverlap: overlap,
      maxContiguousRun: run,
      band,
      accepted: !trivial,
      ...(trivial
        ? {
            reason: `trivially solvable: ${run}-token verbatim run from the query appears in the target`,
          }
        : {}),
    });
  }

  const acc = out.filter((c) => c.accepted);
  return {
    corpusHash: corpus.corpusHash,
    total: out.length,
    accepted: acc.length,
    rejected: out.length - acc.length,
    bands: {
      low: acc.filter((c) => c.band === 'low').length,
      mid: acc.filter((c) => c.band === 'mid').length,
      high: acc.filter((c) => c.band === 'high').length,
    },
    candidates: out,
  };
}
