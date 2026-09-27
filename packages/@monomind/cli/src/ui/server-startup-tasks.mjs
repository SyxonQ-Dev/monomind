import fs from 'node:fs';
import path from 'node:path';

// ── Second Brain live ingestion setup — extracted from startServer(). Called
// once at startup; runs the watcher + polling-sweep bootstrap for document
// ingestion when the project has a knowledge base. ─────────────────────────
function setupKnowledgeBridgeWarmup({
  projectDir,
  _getKnowledgeBridge,
  watchSafely,
  activeWatchers,
}) {
  try {
    if (
      fs.existsSync(
        path.join(projectDir || process.cwd(), '.monomind', 'knowledge', 'chunks.jsonl'),
      )
    ) {
      // Warm off the startup path: first hook request should hit a hot model.
      const _warmTimer = setTimeout(() => {
        _getKnowledgeBridge()
          .then((b) =>
            b?.bridgeSearchEntries?.({ query: 'warmup', namespace: 'knowledge:shared', limit: 1 }),
          )
          .catch(() => {
            /* warm-up is best-effort */
          });
      }, 3000);
      if (_warmTimer.unref) _warmTimer.unref();

      // ── Second Brain live ingestion ──────────────────────────────────
      // This server is the one long-lived local process AND holds the warm
      // embedding model — so it watches for document changes and ingests
      // in-process within seconds, instead of waiting for the next session
      // start. Best-effort: recursive fs.watch is unsupported on some
      // platforms/volumes; the session-start reindex remains the backstop.
      try {
        const _sbDocExts = new Set(['.md', '.txt', '.pdf', '.docx']);
        const _sbSkip =
          /(^|\/)(node_modules|\.git|dist|\.monomind|\.claude|\.next|__pycache__|\.venv|vendor)(\/|$)/;
        const _sbPending = new Map(); // file -> debounce timer
        const _sbRoot = path.resolve(projectDir || process.cwd());
        const _sbWatcher = watchSafely(
          fs.watch(_sbRoot, { recursive: true }, (_evt, rel) => {
            try {
              if (!rel) return;
              const relStr = String(rel);
              // Skip macOS AppleDouble resource forks (`._name`) at any depth.
              // The old `relStr.startsWith('.')` only caught dotfiles at the ROOT;
              // `._` forks in subdirectories sailed through. We match `._` per path
              // segment rather than all dotfiles — `.monodesign/` critique snapshots
              // are legitimate indexable documents.
              if (_sbSkip.test(relStr) || /(^|\/)\._./.test(relStr)) return;
              if (!_sbDocExts.has(path.extname(relStr).toLowerCase())) return;
              const full = path.join(_sbRoot, relStr);
              clearTimeout(_sbPending.get(full));
              _sbPending.set(
                full,
                setTimeout(async () => {
                  _sbPending.delete(full);
                  try {
                    if (!fs.existsSync(full)) return; // deleted — session-start reindex handles removal
                    const pipeline = await import('../knowledge/document-pipeline.js');
                    const r = await pipeline.ingestDocument(full, 'shared', _sbRoot);
                    if (r.chunksIndexed > 0 && !r.skipped) {
                      console.log(
                        `[knowledge] live-ingested ${path.basename(full)} (${r.chunksIndexed} chunks)`,
                      );
                    }
                  } catch (_) {
                    /* single-file ingest failure never matters here */
                  }
                }, 5000),
              );
            } catch (_) {
              /* watcher callback must never throw */
            }
          }),
        );
        activeWatchers.push(_sbWatcher);
      } catch (_) {
        /* recursive watch unavailable — the sweep below still covers it */
      }

      // Polling sweep backstop: fs.watch/fsevents silently stops delivering on
      // some volumes (exFAT/SMB — exactly where many projects live). Every 60s,
      // a bounded mtime walk ingests anything the watcher missed. Stat-only
      // when nothing changed; skips while a sweep is already running.
      try {
        const _sbDocExts2 = new Set(['.md', '.txt', '.pdf', '.docx']);
        const _sbSkipDirs = new Set([
          'node_modules',
          '.git',
          'dist',
          '.monomind',
          '.claude',
          '.next',
          '__pycache__',
          '.venv',
          'vendor',
        ]);
        const _sbSweepRoot = path.resolve(projectDir || process.cwd());
        let _sbLastSweep = Date.now();
        let _sbSweeping = false;
        const _sbSweepTimer = setInterval(async () => {
          if (_sbSweeping) return;
          _sbSweeping = true;
          const since = _sbLastSweep - 5000; // small overlap so boundary writes aren't missed
          _sbLastSweep = Date.now();
          try {
            const changed = [];
            let scanned = 0;
            const walk = (dir, depth) => {
              if (depth > 4 || scanned > 3000 || changed.length >= 20) return;
              let names;
              try {
                names = fs.readdirSync(dir, { withFileTypes: true });
              } catch (_) {
                return;
              }
              for (const ent of names) {
                if (scanned++ > 3000 || changed.length >= 20) return;
                if (ent.name.startsWith('.') || _sbSkipDirs.has(ent.name)) continue;
                const full = path.join(dir, ent.name);
                if (ent.isDirectory()) {
                  walk(full, depth + 1);
                  continue;
                }
                if (!_sbDocExts2.has(path.extname(ent.name).toLowerCase())) continue;
                try {
                  if (fs.statSync(full).mtimeMs > since) changed.push(full);
                } catch (_) {}
              }
            };
            walk(_sbSweepRoot, 0);
            if (changed.length) {
              const pipeline = await import('../knowledge/document-pipeline.js');
              for (const f of changed) {
                try {
                  const r = await pipeline.ingestDocument(f, 'shared', _sbSweepRoot);
                  if (r.chunksIndexed > 0 && !r.skipped)
                    console.log(
                      `[knowledge] sweep-ingested ${path.basename(f)} (${r.chunksIndexed} chunks)`,
                    );
                } catch (_) {
                  /* per-file failures never matter here */
                }
              }
            }
          } catch (_) {
            /* sweep is best-effort */
          } finally {
            _sbSweeping = false;
          }
        }, 60_000);
        if (_sbSweepTimer.unref) _sbSweepTimer.unref();
        activeWatchers.push({ close: () => clearInterval(_sbSweepTimer) });
      } catch (_) {
        /* non-fatal */
      }
    }
  } catch (_) {
    /* non-fatal */
  }
}

export { setupKnowledgeBridgeWarmup };
