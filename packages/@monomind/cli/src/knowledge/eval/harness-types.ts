import type { Split } from './golden-set.js';
import type { QueryOutcome, Scoreboard, terciles } from './metrics.js';
import type { ModelPresence } from './model-presence.js';
import type { NetworkAttempt } from './network-guard.js';
import type { SignalResult } from './signals.js';

/** Which kind of store produced a row. Rows with different profiles are NOT comparable. */
export type StoreProfile = 'fresh' | 'polluted-live' | 'eval-fixture';

/** k must be at most this share of the corpus, else the eval is vacuous. */
export const MAX_K_CORPUS_RATIO = 0.05;

export interface EvalOptions {
  repoRoot: string;
  /** Retrieval cutoff. Metrics are reported at 1/5/10 regardless. */
  k?: number;
  /** Rebuild the eval store from scratch even if a matching one exists. */
  rebuild?: boolean;
  /** Where the isolated eval store lives. Default: <repo>/.monomind/eval. */
  storeRoot?: string;
  /**
   * Which half of the golden set to score.
   *  - 'dev'  freely inspectable; tune against it.
   *  - 'test' SEALED. No per-query output. The only split the stop condition
   *           may be evaluated on. Every run is appended to the exposure ledger.
   *  - 'all'  diagnostic only; can never satisfy the stop condition.
   */
  split?: Split | 'all';
  onProgress?: (msg: string) => void;
}

export interface RetrieverResult {
  name: string;
  description: string;
  scoreboard: Scoreboard;
  terciles: ReturnType<typeof terciles>;
  /** ALWAYS EMPTY on the test split — seeing which queries failed is how a
   *  held-out set silently becomes a tuned one. */
  outcomes: QueryOutcome[];
  /** Queries that came back with fewer than k results — their @k is unsupported. */
  shortReturns: number;
  shortReturnRate: number;
}

export interface EvalReport {
  schemaVersion: 1;
  generatedAt: string;
  method: {
    goldenSetVersion: string;
    split: Split | 'all';
    /** How many times TEST has been run. Repeated exposure turns it into a dev set. */
    testExposureCount: number | null;
    stopConditionEvaluable: boolean;
    corpusHash: string;
    corpusFiles: number;
    corpusDocs: number;
    duplicateGroupsCollapsed: number;
    appleDoubleCount: number;
    corpusChunks: number;
    /** Rows actually present in the isolated eval store. Must equal
     *  corpusChunks: any excess means superseded versions leaked in. */
    evalStoreRows: number;
    /** How the corpus is frozen, stated in the artefact rather than in prose. */
    corpusPinning: string;
    /** The standing limitation of this corpus, carried on the artefact itself. */
    representativeness: string;
    /**
     * Which kind of store produced this row. Mandatory, and a required field
     * rather than a convention: a labelling rule enforced by prose decays,
     * one enforced by a field that must be filled cannot be quietly omitted.
     *  - 'fresh'        rebuilt from a clean corpus, one ingest per document
     *  - 'polluted-live' the user's real store, with its churn and dangling rows
     *  - 'eval-fixture' deliberately versioned/dangling fixture (items 4, 4b, 7)
     * Rows with different store profiles are NOT comparable.
     */
    storeProfile: StoreProfile;
    topK: number;
    kCorpusRatio: number;
    pairsAuthored: number;
    pairsAuthoredTotal: number;
    pairsScored: number;
    pairsDroppedTrivial: number;
    relevancePinnedToLiveDocs: true;
    embeddingModel: string;
    dbDriver: string;
    searchMethodProbe: string;
    /** Proof the weights were on disk BEFORE any query ran. */
    modelPresence: ModelPresence;
    /**
     * Item 0b's pre-registered signal, as a single scoreable number: 1 only if
     * the weights were present before any query AND the query phase was
     * network-blocked AND nothing was fetched. Expressed numerically so the
     * regression suite can score it like any other signal rather than needing
     * a special case — a special case is a place a check goes to be forgotten.
     */
    provisioningIntact: number;
    includesGlobalBrain: boolean;
    hardware: {
      platform: string;
      arch: string;
      cpus: number;
      cpuModel: string;
      nodeVersion: string;
    };
  };
  networkFree: {
    verdict: 'proven-blocked' | 'partial' | 'violated';
    method: string;
    attempts: NetworkAttempt[];
    /** Entry points the guard could not replace. Non-empty => 'partial'. */
    unpatched: string[];
    /**
     * Ruled carve-out, stated on the artefact rather than left implicit.
     * Clause 4's scope is the RETRIEVAL path: everything a query requires or
     * triggers in order to return results. Crash reporting and the update
     * checker are outside it — neither is required for a query to succeed and
     * neither runs on the success path — but both are DISABLED for the run, so
     * "0 attempts" is a statement about retrieval and not an artifact of
     * nothing having crashed.
     */
    telemetryCarveOut: string;
  };
  droppedPairs: Array<{
    id: string;
    reason: string;
    maxContiguousRun: number;
    overlapRatio: number;
  }>;
  overlap: { p25: number; p50: number; p75: number; tercileCutLow: number; tercileCutHigh: number };
  results: Record<string, RetrieverResult>;
  /**
   * Every prior item's pre-registered signal, re-scored on THIS row. Without
   * this the table can only report novelty: an item's win is measured once and
   * never again, so a win that later evaporates is invisible forever.
   */
  regressionSuite: SignalResult[];
  /** What the corpus is actually made of — a corpus that silently became 40%
   *  one generated subtree would otherwise pass every check we have. */
  corpusComposition: { byTopLevel: Record<string, number>; byExtension: Record<string, number> };
  /** The headline row for the scoreboard-history table. */
  headline: {
    retriever: string;
    recallAt1: number;
    recallAt5: number;
    recallAt10: number;
    mrrAt10: number;
    lowOverlapRecallAt5: number;
    bm25FloorRecallAt5: number;
    randomFloorRecallAt5: number;
    gapOverBm25: number;
  };
  timings: { ingestMs: number; evalMs: number };
}
