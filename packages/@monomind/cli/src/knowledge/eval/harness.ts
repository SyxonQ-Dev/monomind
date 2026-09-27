/**
 * `monomind doc eval` — the Second Brain scoreboard.
 *
 * This harness is the arbiter of the retrieval work. Its job is to be HOSTILE
 * to its own result. Everything it does that could flatter the numbers is
 * either disabled or reported:
 *
 *  - Vacuous-eval assert: k must be a small fraction of the corpus. A retrieval
 *    window near corpus size makes recall 1.0 by construction. Hard failure.
 *  - Weak baselines: the same golden set is run through a seeded random picker
 *    and a plain BM25 scorer. The GAP is the signal; a high random score is the
 *    signature of a vacuous eval, and a high BM25 score means the set is too easy.
 *  - Anti-triviality: pairs whose query is near-verbatim in the target are
 *    dropped and counted, because those measure string matching.
 *  - Short-return instrumentation: a query that gets back fewer than k results
 *    cannot support an @k metric; those are counted and reported.
 *  - Network guard: the network is BLOCKED during the query phase, not assumed
 *    absent. Any attempt is recorded with its stack.
 *  - Live-doc pinning: the eval store is rebuilt from the corpus with exactly
 *    one ingest per document, so it holds no superseded versions.
 *
 * @module v1/cli/knowledge/eval/harness
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { buildCorpus, type Corpus, readDoc, resolveRepoRoot } from './corpus.js';
import { GOLDEN_SET, type GoldenPair, pairsForSplit, SPLIT_SCHEME } from './golden-set.js';
import {
  buildChunks,
  corpusComposition,
  detectDbDriver,
  partitionTrivialPairs,
} from './harness-prep.js';
import {
  type EvalOptions,
  type EvalReport,
  MAX_K_CORPUS_RATIO,
  type RetrieverResult,
} from './harness-types.js';
import {
  aggregate,
  buildIdf,
  dedupeByDoc,
  idfOverlap,
  type QueryOutcome,
  scoreQuery,
  terciles,
} from './metrics.js';
import { assertModelProvisioned } from './model-presence.js';
import { installNetworkGuard } from './network-guard.js';
import {
  Bm25Retriever,
  FnRetriever,
  RandomRetriever,
  type RawHit,
  type Retriever,
  RrfRetriever,
} from './retrievers.js';
import { scoreSignals } from './signals.js';

export { renderReport } from './harness-render.js';
export * from './harness-screen.js';
export * from './harness-types.js';

export async function runEval(opts: EvalOptions): Promise<EvalReport> {
  const k = opts.k ?? 10;
  const split = opts.split ?? 'dev';
  const sealed = split === 'test';
  const progress = opts.onProgress ?? (() => {});
  const t0 = Date.now();

  // Telemetry off for the duration. Condition (a) of the ruled carve-out: a
  // "0 attempts" verdict must be a fact about retrieval, not a coincidence.
  const prevCrash = process.env.MONOMIND_CRASH_REPORTING;
  process.env.MONOMIND_CRASH_REPORTING = 'off';

  // ── 1. Corpus ────────────────────────────────────────────────────
  const repoRoot = resolveRepoRoot(opts.repoRoot);
  const corpus: Corpus = buildCorpus(repoRoot);
  if (corpus.appleDoubleCount > 0) {
    throw new Error(
      `[doc eval] ${corpus.appleDoubleCount} AppleDouble "._" resource-fork files are in the eval corpus. ` +
        `These are binary junk that reads as markdown and pads the document count without being real. Corpus rejected.`,
    );
  }

  const ratio = corpus.contentUnits === 0 ? 1 : k / corpus.contentUnits;

  // Vacuous-eval assert. A retrieval window that approaches corpus size makes
  // recall 1.0 by construction — the single most common published error in
  // this field. Hard failure, never a warning.
  if (ratio > MAX_K_CORPUS_RATIO) {
    throw new Error(
      `[doc eval] VACUOUS EVAL REFUSED: k=${k} against a ${corpus.contentUnits}-document corpus ` +
        `is ${(ratio * 100).toFixed(1)}% of the corpus (limit ${(MAX_K_CORPUS_RATIO * 100).toFixed(0)}%). ` +
        `At this ratio recall approaches 1.0 by construction and measures nothing. ` +
        `Grow the corpus or lower k.`,
    );
  }
  progress(
    `corpus: ${corpus.docs.length} files -> ${corpus.contentUnits} distinct documents ` +
      `(${corpus.duplicateGroups} byte-identical groups collapsed, hash ${corpus.corpusHash})`,
  );

  const byId = new Map(corpus.docs.map((d) => [d.id, d]));
  /** Map any document path onto its content-unit representative. */
  const canon = (id: string): string => corpus.canonicalOf.get(id) ?? id;

  // ── 2. Golden-set validation + anti-triviality ───────────────────
  const scored: GoldenPair[] = [];
  const dropped: EvalReport['droppedPairs'] = [];
  const docTextCache = new Map<string, string>();
  const textOf = (id: string): string => {
    let t = docTextCache.get(id);
    if (t === undefined) {
      t = readDoc(byId.get(id)!);
      docTextCache.set(id, t);
    }
    return t;
  };

  const candidatePairs = pairsForSplit(split);
  partitionTrivialPairs(candidatePairs, byId, textOf, scored, dropped);
  progress(`golden set: ${scored.length} scored, ${dropped.length} dropped as trivially solvable`);
  if (scored.length === 0)
    throw new Error('[doc eval] no golden pairs survived the triviality filter');

  // After the deterministic corpus and golden-set assertions, but before ANY
  // dynamic import. Invalid input must report its own actionable guard failure
  // even on machines that have not provisioned the embedding model; once the
  // input is valid, the eval still refuses to fetch weights at query time.
  const modelPresence = assertModelProvisioned([
    repoRoot,
    path.resolve(new URL('../../../..', import.meta.url).pathname),
    process.cwd(),
  ]);

  // ── 3. Isolated eval store (live documents only) ─────────────────
  const storeRoot = opts.storeRoot ?? path.join(repoRoot, '.monomind', 'eval');
  const storeDir = path.join(storeRoot, `store-${corpus.corpusHash}`);
  const prevGlobal = process.env.MONOMIND_GLOBAL_BRAIN_DIR;
  process.env.MONOMIND_GLOBAL_BRAIN_DIR = storeDir;

  let ingestMs = 0;
  let report: EvalReport;
  try {
    const pipeline = await import('../document-pipeline.js');
    const stampPath = path.join(storeDir, 'eval-stamp.json');
    const fresh =
      !opts.rebuild &&
      fs.existsSync(stampPath) &&
      JSON.parse(fs.readFileSync(stampPath, 'utf8')).corpusHash === corpus.corpusHash;

    if (opts.rebuild && fs.existsSync(storeDir))
      fs.rmSync(storeDir, { recursive: true, force: true });
    fs.mkdirSync(storeDir, { recursive: true });

    if (!fresh) {
      const ti = Date.now();
      let n = 0;
      for (const d of corpus.docs) {
        // scope 'global' routes to MONOMIND_GLOBAL_BRAIN_DIR — an isolated
        // store that never touches the user's project or personal brain.
        await pipeline.ingestDocument(d.absPath, 'global', storeDir);
        if (++n % 50 === 0) progress(`ingested ${n}/${corpus.docs.length}`);
      }
      ingestMs = Date.now() - ti;
      fs.writeFileSync(
        stampPath,
        JSON.stringify(
          {
            corpusHash: corpus.corpusHash,
            docs: corpus.docs.length,
            builtAt: new Date().toISOString(),
          },
          null,
          2,
        ),
      );
      progress(`ingest complete in ${(ingestMs / 1000).toFixed(1)}s`);
    } else {
      progress('reusing existing eval store (corpus hash unchanged)');
    }

    // Row count of the isolated store. If this exceeds the chunk count, a
    // superseded version leaked in and the live-doc pinning claim is false.
    let evalStoreRows = -1;
    try {
      const bridge = await import('../../memory/memory-bridge.js');
      const listed = await bridge.bridgeListEntries({
        namespace: 'knowledge:global',
        limit: 1_000_000,
        dbPath: '@global',
      });
      if (listed?.success && Array.isArray(listed.entries)) evalStoreRows = listed.entries.length;
    } catch {
      /* diagnostic only */
    }

    // ── 4. Chunk mirror for the weak baselines ─────────────────────
    // Canonical documents only. The store keys chunks by CONTENT hash, so
    // byte-identical files collapse there too — mirroring that here keeps the
    // `evalStoreRows === corpusChunks` cross-check meaningful instead of
    // permanently red, and stops duplicates skewing BM25 document frequencies.
    const canonicalDocs = corpus.docs.filter((d) => corpus.canonicalOf.get(d.id) === d.id);
    const chunks = await buildChunks(canonicalDocs);
    progress(`chunk mirror: ${chunks.length} chunks`);

    // ── 5. IDF overlap characterisation ────────────────────────────
    const idf = buildIdf(corpus.docs.map((d) => textOf(d.id)));
    const overlapOf = (p: GoldenPair): number =>
      Math.max(...p.relevant.map((r) => idfOverlap(idf, p.query, textOf(r))));

    // ── 6. Retrievers ──────────────────────────────────────────────
    const denseRetriever = new FnRetriever(
      'dense-only (gte-modernbert-base)',
      'The current shipping stack: searchKnowledge over the local vector store',
      async (query, limit): Promise<RawHit[]> => {
        const hits = await pipeline.searchKnowledge(query, {
          limit,
          minScore: 0.0,
          store: 'global',
          rootDir: storeDir,
          includeSuperseded: false,
          skipRerank: true, // isolate dense-only baseline from the reranker
        });
        return hits.map((h) => ({
          docId: path.relative(repoRoot, h.filePath),
          chunkIndex: h.chunkIndex,
          score: h.similarity,
        }));
      },
    );
    const bm25Retriever = new Bm25Retriever(chunks);
    const retrievers: Retriever[] = [denseRetriever, bm25Retriever, new RandomRetriever(chunks)];
    // RRF fusion sweep: equal-weight, k ∈ {10, 20, 40, 60, 100}.
    // Null hypothesis row — expected to fail the low-overlap gate.
    const RRF_K_SWEEP = [10, 20, 40, 60, 100] as const;
    for (const rrfK of RRF_K_SWEEP) {
      retrievers.push(new RrfRetriever([denseRetriever, bm25Retriever], rrfK));
    }

    // ── 6b. Reranked retriever (ettin-32m cross-encoder) ──────────
    // Pre-load the reranker BEFORE the network guard goes up, so the model
    // download happens while we still have connectivity.
    let rerankerLoaded = false;
    if (process.env.MONOMIND_RERANKER !== '0') {
      try {
        const bridge = await import('../../memory/memory-bridge.js');
        await bridge.loadReranker();
        rerankerLoaded = true;
        progress('reranker loaded: cross-encoder/ettin-reranker-32m-v1');
      } catch (e) {
        progress(`reranker failed to load — skipping reranked retriever: ${e}`);
      }
    }
    if (rerankerLoaded) {
      // The reranked retriever uses the same searchKnowledge path but with
      // the reranker active (it was pre-loaded above). The dense-only
      // retriever is kept WITHOUT reranking (skipRerank) for comparison.
      const rerankedRetriever = new FnRetriever(
        'dense+rerank (ettin-32m)',
        'Dense retrieval + cross-encoder reranking via ettin-reranker-32m-v1',
        async (query, limit): Promise<RawHit[]> => {
          // searchKnowledge flows through bridgeSearchEntries which auto-reranks
          // when the reranker is loaded. Over-retrieval happens inside.
          const hits = await pipeline.searchKnowledge(query, {
            limit,
            minScore: 0.0,
            store: 'global',
            rootDir: storeDir,
            includeSuperseded: false,
          });
          return hits.map((h) => ({
            docId: path.relative(repoRoot, h.filePath),
            chunkIndex: h.chunkIndex,
            score: h.similarity,
          }));
        },
      );
      retrievers.push(rerankedRetriever);
    }

    // ── 7. Query phase, network blocked ────────────────────────────
    progress(
      `model provisioned: ${(modelPresence.bytes / 1e6).toFixed(0)}MB at ${modelPresence.resolvedPath}`,
    );
    const guard = installNetworkGuard();

    // The search-path probe runs INSIDE the guarded window. It used to run
    // outside it, which is exactly how a model download escaped the guard and
    // still reported "0 attempts". If this says "keyword" we are not measuring
    // semantic retrieval at all and the scoreboard must be read differently.
    let searchMethodProbe = 'unknown';
    const results: Record<string, RetrieverResult> = {};
    const te = Date.now();
    try {
      try {
        const bridge = await import('../../memory/memory-bridge.js');
        const probe = await bridge.bridgeSearchEntries({
          query: 'how are hooks dispatched',
          namespace: 'knowledge:global',
          limit: 3,
          threshold: 0.05,
          dbPath: '@global',
        });
        searchMethodProbe = String(probe?.searchMethod ?? 'unknown');
      } catch {
        /* probe is diagnostic; a blocked fetch here is recorded by the guard */
      }

      for (const r of retrievers) {
        const outcomes: QueryOutcome[] = [];
        let shortReturns = 0;
        for (const pair of scored) {
          const tq = Date.now();
          // Over-fetch at the chunk level: k documents need more than k chunks
          // when several chunks of one document rank highly.
          const raw = await r.search(pair.query, k * 5);
          const latencyMs = Date.now() - tq;
          // Collapse to content units BEFORE ranking is cut off, so a
          // byte-identical twin never consumes a top-k slot twice.
          const ranked = dedupeByDoc(
            raw.map((h) => ({ ...h, docId: canon(h.docId) })),
            k,
          );
          if (ranked.length < k) shortReturns++;
          outcomes.push(
            scoreQuery({
              queryId: pair.id,
              query: pair.query,
              relevant: pair.relevant.map(canon),
              ranked,
              latencyMs,
              overlap: overlapOf(pair),
            }),
          );
        }
        const agg = aggregate(outcomes);
        const terc = terciles(outcomes);
        results[r.name] = {
          name: r.name,
          description: r.description,
          scoreboard: agg,
          terciles: terc,
          // Sealed split: aggregates only. Withholding this is the whole point.
          outcomes: sealed ? [] : outcomes,
          shortReturns,
          shortReturnRate: shortReturns / outcomes.length,
        };
        progress(`${r.name}: Recall@5 ${results[r.name].scoreboard.recallAt5.toFixed(3)}`);
      }
    } finally {
      guard.release();
    }
    const evalMs = Date.now() - te;

    const allOverlaps = scored.map(overlapOf).sort((a, b) => a - b);
    const q = (p: number) =>
      allOverlaps[Math.min(allOverlaps.length - 1, Math.floor(p * allOverlaps.length))] ?? 0;

    const denseName = denseRetriever.name;
    const dense = results[denseName];
    const bm25 = results['bm25-only'];
    const rand = results.random;

    report = {
      schemaVersion: 1,
      generatedAt: new Date().toISOString(),
      method: {
        goldenSetVersion: 'v1 (2026-07-28)',
        split,
        testExposureCount: null,
        stopConditionEvaluable: sealed,
        corpusHash: corpus.corpusHash,
        corpusFiles: corpus.docs.length,
        corpusDocs: corpus.contentUnits,
        duplicateGroupsCollapsed: corpus.duplicateGroups,
        appleDoubleCount: corpus.appleDoubleCount,
        corpusChunks: chunks.length,
        evalStoreRows,
        corpusPinning:
          'git-tracked files at HEAD, content-addressed: corpusHash = sha256 over the sorted (path, sha256) pairs. ' +
          'The eval NEVER reads the live project or personal store — it builds a dedicated store, one ingest per document, ' +
          'so it holds zero superseded versions and cannot drift while a session re-ingests generated artefacts. ' +
          'Untracked generated files (e.g. GRAPH_REPORT.md) are absent from the corpus by construction.',
        storeProfile: 'fresh',
        representativeness:
          'REPRODUCIBLE BUT NOT REPRESENTATIVE: this corpus is a clean git-HEAD snapshot with no version history, ' +
          'no ingest churn and no dangling entries pointing at deleted files. A real user store has all three. ' +
          'Numbers here are an upper bound on live behaviour and will diverge from it.',
        topK: k,
        kCorpusRatio: ratio,
        pairsAuthored: candidatePairs.length,
        pairsAuthoredTotal: GOLDEN_SET.length,
        pairsScored: scored.length,
        pairsDroppedTrivial: dropped.length,
        relevancePinnedToLiveDocs: true,
        embeddingModel: 'Alibaba-NLP/gte-modernbert-base (768d, q8, local)',
        dbDriver: detectDbDriver(),
        searchMethodProbe,
        modelPresence,
        provisioningIntact:
          modelPresence.present && guard.attempts.length === 0 && guard.unpatched.length === 0
            ? 1
            : 0,
        includesGlobalBrain: false,
        hardware: {
          platform: process.platform,
          arch: process.arch,
          cpus: os.cpus().length,
          cpuModel: os.cpus()[0]?.model ?? 'unknown',
          nodeVersion: process.version,
        },
      },
      networkFree: {
        verdict:
          guard.attempts.length > 0
            ? 'violated'
            : guard.unpatched.length > 0
              ? 'partial'
              : 'proven-blocked',
        method:
          'fetch/http/https/net/tls/dns replaced with throwing stubs for the whole query phase; every attempt recorded with its stack. Does not cover sockets opened inside a native addon — see lsof corroboration in the baseline report.',
        attempts: guard.attempts,
        unpatched: guard.unpatched,
        telemetryCarveOut:
          'Clause 4 scope = the retrieval path (whatever a query requires or triggers to return ' +
          'results). Crash reporting and the update checker are carved out, and are DISABLED for ' +
          'the duration of this run (MONOMIND_CRASH_REPORTING=off), so a zero here describes ' +
          'retrieval rather than the absence of a crash. Both remain user-disableable in normal use.',
      },
      droppedPairs: sealed ? dropped.map((d) => ({ ...d, id: '<sealed>' })) : dropped,
      overlap: {
        p25: q(0.25),
        p50: q(0.5),
        p75: q(0.75),
        tercileCutLow: dense.terciles.cutLow,
        tercileCutHigh: dense.terciles.cutHigh,
      },
      results,
      headline: {
        retriever: denseName,
        recallAt1: dense.scoreboard.recallAt1,
        recallAt5: dense.scoreboard.recallAt5,
        recallAt10: dense.scoreboard.recallAt10,
        mrrAt10: dense.scoreboard.mrrAt10,
        lowOverlapRecallAt5: dense.terciles.low.recallAt5,
        bm25FloorRecallAt5: bm25?.scoreboard.recallAt5 ?? 0,
        randomFloorRecallAt5: rand?.scoreboard.recallAt5 ?? 0,
        gapOverBm25: dense.scoreboard.recallAt5 - (bm25?.scoreboard.recallAt5 ?? 0),
      },
      regressionSuite: [],
      corpusComposition: corpusComposition(corpus),
      timings: { ingestMs, evalMs },
    };

    // Re-score every prior item's pre-registered signal against THIS row.
    report.regressionSuite = scoreSignals(report, 'fresh', dense.scoreboard.hitRateAt5Ci95, {
      corpusHash: corpus.corpusHash,
      goldenSetVersion: report.method.goldenSetVersion,
      splitScheme: SPLIT_SCHEME,
    });

    // Exposure ledger. A sealed set run forty times with tuning in between is
    // no longer sealed; the count is the only way anyone finds out.
    if (sealed) {
      const ledger = path.join(storeRoot, 'test-exposure-ledger.jsonl');
      fs.mkdirSync(storeRoot, { recursive: true });
      const prior = fs.existsSync(ledger)
        ? fs.readFileSync(ledger, 'utf8').split('\n').filter(Boolean).length
        : 0;
      report.method.testExposureCount = prior + 1;
      fs.appendFileSync(
        ledger,
        `${JSON.stringify({
          at: report.generatedAt,
          exposure: prior + 1,
          corpusHash: corpus.corpusHash,
          goldenSetVersion: report.method.goldenSetVersion,
          topK: k,
          recallAt5: report.headline.recallAt5,
          mrrAt10: report.headline.mrrAt10,
        })}\n`,
      );
    }
  } finally {
    if (prevGlobal === undefined) delete process.env.MONOMIND_GLOBAL_BRAIN_DIR;
    else process.env.MONOMIND_GLOBAL_BRAIN_DIR = prevGlobal;
    if (prevCrash === undefined) delete process.env.MONOMIND_CRASH_REPORTING;
    else process.env.MONOMIND_CRASH_REPORTING = prevCrash;
  }

  void t0;
  return report;
}
