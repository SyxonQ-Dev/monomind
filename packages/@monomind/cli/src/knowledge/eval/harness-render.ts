import type { EvalReport } from './harness-types.js';

// ── Human-readable rendering ────────────────────────────────────────

function pct(x: number): string {
  return `${(x * 100).toFixed(1)}%`;
}
function f3(x: number): string {
  return x.toFixed(3);
}

export function renderReport(r: EvalReport): string {
  const L: string[] = [];
  const m = r.method;
  L.push('');
  L.push('Second Brain retrieval scoreboard');
  L.push('='.repeat(72));
  L.push(
    `corpus        ${m.corpusDocs} distinct documents from ${m.corpusFiles} files / ${m.corpusChunks} chunks  (hash ${m.corpusHash})`,
  );
  L.push(
    `              ${m.duplicateGroupsCollapsed} byte-identical groups collapsed to one unit each; AppleDouble "._" files: ${m.appleDoubleCount} (asserted zero)`,
  );
  L.push(
    `eval store    ${m.evalStoreRows < 0 ? 'unknown' : `${m.evalStoreRows} rows`}${m.evalStoreRows >= 0 && m.evalStoreRows !== m.corpusChunks ? '  <- MISMATCH vs chunk count, superseded rows may have leaked in' : ''}`,
  );
  L.push(
    `split         ${m.split.toUpperCase()}${m.split === 'test' ? '  (SEALED — aggregates only, no per-query output)' : m.split === 'dev' ? '  (tunable; cannot satisfy the stop condition)' : '  (diagnostic; cannot satisfy the stop condition)'}`,
  );
  if (m.testExposureCount !== null)
    L.push(`exposure      TEST has now been run ${m.testExposureCount} time(s)`);
  L.push(
    `golden set    ${m.pairsScored} scored of ${m.pairsAuthored} in this split (${m.pairsAuthoredTotal} authored overall; ${m.pairsDroppedTrivial} dropped as trivially solvable)`,
  );
  L.push(`top_k         ${m.topK}  =  ${(m.kCorpusRatio * 100).toFixed(2)}% of corpus`);
  L.push(`embeddings    ${m.embeddingModel}`);
  L.push(`db driver     ${m.dbDriver}   search path probe: ${m.searchMethodProbe}`);
  L.push(
    `model weights ${m.modelPresence.present ? 'PRESENT before any query' : 'ABSENT'} ` +
      `(${(m.modelPresence.bytes / 1e6).toFixed(0)}MB, ${m.modelPresence.provenance})`,
  );
  L.push(`relevance     pinned to LIVE documents only (store rebuilt, no superseded versions)`);
  L.push(
    `hardware      ${m.hardware.cpuModel} x${m.hardware.cpus}, ${m.hardware.platform}/${m.hardware.arch}, node ${m.hardware.nodeVersion}`,
  );
  L.push(`store profile ${m.storeProfile}  (rows with a different profile are NOT comparable)`);
  L.push(`caveat        ${m.representativeness}`);
  L.push(`carve-out     ${r.networkFree.telemetryCarveOut}`);
  L.push(
    `network       ${r.networkFree.verdict.toUpperCase()} (${r.networkFree.attempts.length} attempts blocked during query phase` +
      (r.networkFree.unpatched.length ? `; UNPATCHED: ${r.networkFree.unpatched.join(', ')}` : '') +
      ')',
  );
  L.push('');

  const rows = Object.values(r.results);
  const w = Math.max(...rows.map((x) => x.name.length), 10);
  const head = [
    'retriever'.padEnd(w),
    'R@1'.padStart(7),
    'R@5'.padStart(7),
    'R@10'.padStart(7),
    'MRR@10'.padStart(7),
    'p50ms'.padStart(7),
    'p95ms'.padStart(7),
    'short'.padStart(7),
  ];
  L.push(head.join(' '));
  L.push('-'.repeat(head.join(' ').length));
  for (const row of rows) {
    const s = row.scoreboard;
    L.push(
      [
        row.name.padEnd(w),
        f3(s.recallAt1).padStart(7),
        f3(s.recallAt5).padStart(7),
        f3(s.recallAt10).padStart(7),
        f3(s.mrrAt10).padStart(7),
        String(s.latencyMsP50).padStart(7),
        String(s.latencyMsP95).padStart(7),
        pct(row.shortReturnRate).padStart(7),
      ].join(' '),
    );
  }
  L.push('');
  L.push('Recall@5 by IDF-weighted query/document overlap tercile');
  L.push(
    `  (tercile cuts: low < ${f3(r.overlap.tercileCutLow)} <= mid < ${f3(r.overlap.tercileCutHigh)} <= high)`,
  );
  L.push(
    ['retriever'.padEnd(w), 'low'.padStart(7), 'mid'.padStart(7), 'high'.padStart(7)].join(' '),
  );
  L.push('-'.repeat(w + 24));
  for (const row of rows) {
    L.push(
      [
        row.name.padEnd(w),
        f3(row.terciles.low.recallAt5).padStart(7),
        f3(row.terciles.mid.recallAt5).padStart(7),
        f3(row.terciles.high.recallAt5).padStart(7),
      ].join(' '),
    );
  }
  L.push('');
  L.push('Reading this scoreboard');
  L.push(
    `  gap over BM25-only      ${f3(r.headline.gapOverBm25)}  <- the real signal. A small gap means the`,
  );
  L.push('                                 golden set is too easy, not that the stack is good.');
  L.push(
    `  random floor Recall@5   ${f3(r.headline.randomFloorRecallAt5)}  <- anything but ~0 means a vacuous eval.`,
  );
  L.push(
    `  low-overlap Recall@5    ${f3(r.headline.lowOverlapRecallAt5)}  <- the closest proxy to real-world queries.`,
  );
  const ci = rows[0]?.scoreboard.hitRateAt5Ci95 ?? 0;
  L.push(
    `  95% CI half-width       ${f3(ci)}  <- a delta smaller than this is noise, not improvement.`,
  );
  L.push('');
  if (r.regressionSuite.length > 0) {
    L.push("Regression suite — every prior item's pre-registered signal, re-scored on this row");
    for (const sig of r.regressionSuite) {
      const cur = sig.currentValue === null ? '   n/a' : f3(sig.currentValue);
      const ref = sig.shipValue ?? sig.baselineValue;
      L.push(`  [${sig.verdict.padEnd(9)}] item ${sig.item.padEnd(3)} ${sig.id}`);
      L.push(
        `               now ${cur}` +
          (ref !== null && ref !== undefined ? `  vs ${f3(ref)} at ship/baseline` : '') +
          (sig.nullVerdict ? `  null-verdict: ${sig.nullVerdict}` : ''),
      );
      L.push(`               ${sig.note}`);
    }
    const decayed = r.regressionSuite.filter((x) => x.verdict === 'DECAYED');
    if (decayed.length > 0) {
      L.push(`  !! ${decayed.length} PRE-REGISTERED SIGNAL(S) HAVE DECAYED — a win recorded on an`);
      L.push(
        '     earlier row no longer holds. This is the only evidence that justifies a revert.',
      );
    }
    L.push('');
  }
  L.push('Corpus composition (distinct documents by top-level directory)');
  L.push(
    '  ' +
      Object.entries(r.corpusComposition.byTopLevel)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 8)
        .map(([k, v]) => `${k} ${v}`)
        .join('   '),
  );
  L.push('');
  L.push(`Stop condition: Recall@5 >= 0.900 and MRR@10 >= 0.800 on >= 500 documents.`);
  const s = r.results[r.headline.retriever].scoreboard;
  const met = s.recallAt5 >= 0.9 && s.mrrAt10 >= 0.8 && m.corpusDocs >= 500;
  if (!m.stopConditionEvaluable) {
    L.push(
      `  currently: Recall@5 ${f3(s.recallAt5)}, MRR@10 ${f3(s.mrrAt10)}, corpus ${m.corpusDocs}`,
    );
    L.push(
      `  NOT EVALUABLE on the ${m.split} split — the stop condition may only be checked on TEST.`,
    );
  } else {
    L.push(
      `  currently: Recall@5 ${f3(s.recallAt5)}, MRR@10 ${f3(s.mrrAt10)}, corpus ${m.corpusDocs} -> ${met ? 'MET' : 'NOT MET'}`,
    );
  }
  L.push('');
  return L.join('\n');
}
