// Split out of browser.ts (file-size sweep). Pure move: no behaviour change.

import { execSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { connect } from 'node:net';
import { fetchTargets } from './cdp.js';
import { CHROME_EXECUTABLES } from './types.js';

export function findChrome(executablePath?: string): string {
  if (executablePath) {
    if (existsSync(executablePath)) return executablePath;
    throw new Error(`Chrome executable not found: ${executablePath}`);
  }
  for (const candidate of CHROME_EXECUTABLES) {
    if (existsSync(candidate)) return candidate;
  }
  // Try PATH
  try {
    const result = execSync(
      'which google-chrome chromium-browser chromium microsoft-edge microsoft-edge-stable 2>/dev/null',
      { encoding: 'utf8' },
    ).trim();
    const first = result.split('\n')[0];
    if (first) return first;
  } catch {
    // ignore
  }
  // A browser some other tool fetched for us (monomind sets this for its own
  // child processes). Last, so an installed browser always wins.
  const fromEnv = process.env.MONOBROWSE_CHROME_PATH;
  if (fromEnv && existsSync(fromEnv)) return fromEnv;
  throw new Error(
    'No supported browser found. Install Google Chrome, Microsoft Edge, or Chromium — or pass executablePath in BrowserConfig.',
  );
}

let chromeFallback: (() => Promise<string>) | undefined;

/**
 * Registers where launchBrowser() gets a browser when findChrome() finds none
 * (monomind downloads one on first use). Pass undefined to clear it.
 */
export function setChromeFallback(fallback: (() => Promise<string>) | undefined): void {
  chromeFallback = fallback;
}

/** findChrome(), then the registered fallback when no browser is installed.
 *  An explicit executablePath never falls back. */
export async function resolveChrome(executablePath?: string): Promise<string> {
  try {
    return findChrome(executablePath);
  } catch (err) {
    if (executablePath || !chromeFallback) throw err;
    return chromeFallback();
  }
}

export async function isPortOpen(port: number): Promise<boolean> {
  try {
    await fetchTargets(port);
    return true;
  } catch {
    return false;
  }
}

/**
 * Confirm the CDP endpoint on `port` actually identifies as Chrome/Chromium
 * via `/json/version`'s `Browser` field, rather than assuming any CDP-speaking
 * responder is "ours". Reduces (does not eliminate) the risk of silently
 * attaching to an unrelated real browser that happens to be listening there.
 */
export async function isChromeIdentity(port: number): Promise<boolean> {
  return (await chromeIdentity(port)) === 'chrome';
}

/** isChromeIdentity, telling "answered as something else" apart from "did
 *  not answer in time" ('unknown': a timeout, a refused or reset connection,
 *  a non-OK status or an unparseable body). */
export async function chromeIdentity(port: number): Promise<'chrome' | 'other' | 'unknown'> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/json/version`, {
      signal: AbortSignal.timeout(1000),
    });
    if (!res.ok) return 'unknown';
    const info = (await res.json()) as { Browser?: string };
    // Edge's Browser field is "Edg/<version>" with no "chrome"/"chromium"
    // substring, even though it's Chromium-based and CDP-compatible —
    // accept it alongside Chrome/Chromium rather than rejecting a valid target.
    return typeof info.Browser === 'string' && /chrom(e|ium)|edg/i.test(info.Browser)
      ? 'chrome'
      : 'other';
  } catch {
    return 'unknown';
  }
}

/** Raw TCP connect probe — distinguishes "nothing listening" from "something listening that isn't CDP". */
export function isTcpPortOpen(port: number, timeoutMs = 1000): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host: '127.0.0.1', port, timeout: timeoutMs });
    const done = (result: boolean) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(result);
    };
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
  });
}

/** The port Chrome wrote to `<userDataDir>/DevToolsActivePort` once its
 *  DevTools server was listening, or null if it has not (yet). */
export function readDevToolsActivePort(file: string): number | null {
  try {
    const port = Number.parseInt(readFileSync(file, 'utf8').split('\n')[0], 10);
    return Number.isInteger(port) && port > 0 && port <= 65535 ? port : null;
  } catch {
    return null;
  }
}

/** The per-process id in a browser-level CDP websocket URL
 *  (`ws://host:port/devtools/browser/<id>`), or null. */
export function browserIdOf(wsUrl: string | undefined): string | null {
  return wsUrl?.match(/\/devtools\/browser\/([^/?#\s]+)/)?.[1] ?? null;
}

/** Chrome's browser-level debugger endpoint, from /json/version — the
 *  connection `Browser.close` belongs on. Null if the port isn't answering as
 *  a Chrome/Chromium CDP endpoint (same identity check as isChromeIdentity). */
export async function fetchBrowserWebSocketUrl(port: number): Promise<string | null> {
  const res = await fetch(`http://127.0.0.1:${port}/json/version`, {
    signal: AbortSignal.timeout(1000),
  });
  if (!res.ok) return null;
  const info = (await res.json()) as { Browser?: string; webSocketDebuggerUrl?: string };
  if (typeof info.Browser !== 'string' || !/chrom(e|ium)|edg/i.test(info.Browser)) return null;
  return typeof info.webSocketDebuggerUrl === 'string' ? info.webSocketDebuggerUrl : null;
}
