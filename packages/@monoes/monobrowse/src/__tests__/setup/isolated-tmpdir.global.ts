/**
 * Vitest globalSetup: run every monobrowse test worker against a throwaway
 * TMPDIR (#395).
 *
 * launchBrowser() sweeps stale `monomind-browser-*` / `monomind-browse-*`
 * profile dirs out of os.tmpdir() on every launch. The sweep only removes
 * dead, idle, unused dirs, but a test run must never touch the real /tmp at
 * all: other sessions' live Chrome profiles live there. Set in the main
 * process before any worker starts, so workers and the CLI processes tests
 * spawn inherit it.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export default function setup(): () => void {
  const saved = process.env.TMPDIR;
  // Short on purpose: real-Chrome tests nest their own dirs under it, and
  // Chrome aborts at startup (SIGABRT) once the unix socket path it makes in
  // TMPDIR (…/org.chromium.Chromium.XXXXXX/SingletonSocket) passes ~107 bytes.
  const dir = mkdtempSync(join(tmpdir(), 'mb-'));
  process.env.TMPDIR = dir;
  return () => {
    if (saved === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = saved;
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  };
}
