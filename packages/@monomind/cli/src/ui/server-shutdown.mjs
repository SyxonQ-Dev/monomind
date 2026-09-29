import fs from 'node:fs';
import { activeWatchers } from './server-net.mjs';
import { _closeRunDb, _writeQueue, runStreamClients } from './server-rundb.mjs';
import { closeAllSseClients } from './sse-manager.mjs';

// Longest a SIGTERM/SIGINT/SIGHUP (or /api/control/stop) shutdown may take
// before the process exits anyway (#477).
export const SHUTDOWN_HARD_EXIT_MS = 5000;

/**
 * Graceful shutdown for one started server, extracted from startServer().
 * Idempotent: SIGHUP, SIGTERM and /api/control/stop can all arrive. A process
 * whose server.close() never completed used to stay alive with no port and
 * ignore every later SIGTERM (#477); the unref'd timer guarantees an exit.
 * `onClosed` runs just before the exit, once the HTTP server has closed.
 */
export function createShutdown({ server, stopBackgroundTasks, tokenState, onClosed }) {
  let shuttingDown = false;
  return function shutdown() {
    if (shuttingDown) return;
    shuttingDown = true;
    const hardExit = setTimeout(() => {
      process.stderr.write(
        `[server] shutdown still pending after ${SHUTDOWN_HARD_EXIT_MS}ms — exiting anyway\n`,
      );
      process.exit(0);
    }, SHUTDOWN_HARD_EXIT_MS);
    hardExit.unref();
    stopBackgroundTasks();
    // Flush SQLite run-event index to disk before exit (bypasses 1000ms debounce
    // timer) and release it.
    _closeRunDb();
    for (const w of activeWatchers) {
      try {
        w.close();
      } catch {
        // Already closed
      }
    }
    activeWatchers.length = 0;

    // Close all SSE connections — general, mastermind and per-org run streams.
    // Any one left open kept server.close() below from ever completing (#477).
    closeAllSseClients(runStreamClients.values());
    runStreamClients.clear();

    // i-052 commit 4: best-effort cleanup of the credential THIS process
    // wrote (primary `dashboard-token`, or this process's own
    // `dashboard-token-<port>` secondary) — belt-and-braces only.
    // writeDashboardToken's age-based sweep is the actual backstop for a
    // dirty death: SIGKILL never reaches this handler at all, and a
    // failed unlink here (permissions, already-gone) must not block the
    // rest of shutdown.
    if (tokenState.path) {
      try {
        fs.unlinkSync(tokenState.path);
      } catch (_) {
        /* already gone, or unremovable — the age sweep is the backstop */
      }
    }

    // Drain in-flight JSONL appends before closing (prevents truncated writes on fast SIGTERM)
    Promise.all([..._writeQueue.values()])
      .catch(() => {})
      .finally(() => {
        server.close(() => {
          clearTimeout(hardExit);
          onClosed();
          process.exit(0);
        });
        // close() waits for every open socket, keep-alive and /api/events-stream
        // included; drop them so the callback above can run.
        server.closeAllConnections();
      });
  };
}
