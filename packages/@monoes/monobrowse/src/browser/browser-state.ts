// Split out of browser.ts (file-size sweep). Pure move: no behaviour change.

// Tracks the PID of Chrome instances *we* spawned, keyed by CDP port, so
// closeBrowser() has a kill fallback when the graceful `Browser.close` CDP
// command fails or times out (e.g. a hung renderer). Ports we merely attached
// to (already-running browser) are never recorded here — we only ever kill
// processes we launched ourselves.
export const launchedPids = new Map<number, number>();
// userDataDir per launched port — informational, persisted alongside the pid
// so a later process could clean up the temp profile dir too if ever needed.
export const launchedUserDataDirs = new Map<number, string>();

/** PID of the Chrome instance *this process* launched on `port`, if any. */
export function getLaunchedPid(port: number): number | undefined {
  return launchedPids.get(port);
}

/** userDataDir of the Chrome instance *this process* launched on `port`, if any. */
export function getLaunchedUserDataDir(port: number): string | undefined {
  return launchedUserDataDirs.get(port);
}
