import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const require_ = createRequire(import.meta.url);
const __dirname = dirname(fileURLToPath(import.meta.url));
const TRACKER = join(__dirname, '..', '..', '.claude', 'helpers', 'token-tracker.cjs');

// Issue #42: `monomind tokens today` as a SessionStart hook hung Claude Code.
// quickSummary() needs a MONTH window, and on an active machine every
// transcript has been touched this month, so it cannot be narrowed by mtime —
// it was a full ~1GB parse taking ~9.4s against a 10s hook timeout, before npx
// overhead. Now it is cache-first and never computes inline.

let home: string;
let projects: string;

/** Writes a transcript with `n` assistant turns, back-dated to `mtime`. */
function writeTranscript(dir: string, name: string, n: number, mtime: Date) {
  mkdirSync(dir, { recursive: true });
  const file = join(dir, name);
  // A turn only forms after a user entry — groupAndClassify takes the turn's
  // timestamp from it, and _computeQuickTotals drops turns with no timestamp.
  const lines: string[] = [
    JSON.stringify({
      type: 'user',
      timestamp: mtime.toISOString(),
      message: { role: 'user', content: 'hello' },
    }),
  ];
  for (let i = 0; i < n; i++) {
    lines.push(
      JSON.stringify({
        type: 'assistant',
        timestamp: mtime.toISOString(),
        message: {
          id: `msg_${name}_${i}`,
          model: 'claude-sonnet-4-5',
          usage: { input_tokens: 100, output_tokens: 50 },
          content: [{ type: 'text', text: 'hi' }],
        },
      }),
    );
  }
  writeFileSync(file, `${lines.join('\n')}\n`);
  const secs = mtime.getTime() / 1000;
  utimesSync(file, secs, secs);
  return file;
}

function loadTracker() {
  delete require_.cache[require_.resolve(TRACKER)];
  return require_(TRACKER);
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'mm-tok-'));
  projects = join(home, 'projects');
  mkdirSync(projects, { recursive: true });
  process.env.CLAUDE_CONFIG_DIR = home;
});

afterEach(() => {
  delete process.env.CLAUDE_CONFIG_DIR;
  // quickSummary() (tested below) spawns a REAL detached child process to
  // refresh the cache out of band (by design — see _spawnQuickRefresh in
  // token-tracker.cjs) and never gives the caller a handle to await it. If
  // that child is still writing into `home` when this runs, a plain rmSync
  // can throw ENOTEMPTY — force:true only swallows ENOENT, not a concurrent
  // writer. maxRetries/retryDelay is Node's own documented answer to exactly
  // this race (rm retries on ENOTEMPTY/EBUSY/etc.); it does nothing to the
  // default single-attempt behavior when the dir was already empty.
  rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

const cachePath = () => join(home, '.monomind-token-summary.json');

describe('quickSummary is cache-first and never blocks (#42)', () => {
  it('returns null on a cold cache rather than computing inline', () => {
    writeTranscript(join(projects, 'proj-a'), 'a.jsonl', 3, new Date());
    const tracker = loadTracker();

    // The whole point: a missing cache must not trigger the ~9s parse on the
    // caller's thread. Printing nothing once beats hanging the editor.
    expect(tracker.quickSummary()).toBeNull();
  });

  it('serves a fresh cache without touching the filesystem scan', () => {
    writeTranscript(join(projects, 'proj-a'), 'a.jsonl', 3, new Date());
    const tracker = loadTracker();

    expect(tracker.refreshQuickSummary()).toBeTruthy();
    expect(existsSync(cachePath())).toBe(true);

    const line = tracker.quickSummary();
    expect(line).toMatch(/^\[TOKEN_USAGE\] Today: \$/);
    expect(line).toMatch(/Month: \$/);
  });

  it('serves a stale figure rather than nothing once a cache exists', () => {
    writeTranscript(join(projects, 'proj-a'), 'a.jsonl', 3, new Date());
    const tracker = loadTracker();
    tracker.refreshQuickSummary();

    // Age the cache past the TTL.
    const cache = JSON.parse(readFileSync(cachePath(), 'utf-8'));
    const stale = { ...cache, computedAt: Date.now() - 60 * 60 * 1000 };
    writeFileSync(cachePath(), JSON.stringify(stale));

    // Stale beats blank; the refresh happens out of band.
    expect(tracker.quickSummary()).toMatch(/^\[TOKEN_USAGE\]/);
  });

  it('survives a corrupt cache file', () => {
    writeTranscript(join(projects, 'proj-a'), 'a.jsonl', 3, new Date());
    writeFileSync(cachePath(), '{ not json');
    const tracker = loadTracker();
    expect(() => tracker.quickSummary()).not.toThrow();
    expect(tracker.quickSummary()).toBeNull();
  });

  it('cached output equals a full blocking computation', () => {
    writeTranscript(join(projects, 'proj-a'), 'a.jsonl', 4, new Date());
    writeTranscript(join(projects, 'proj-b'), 'b.jsonl', 2, new Date());
    const tracker = loadTracker();

    const blocking = tracker.quickSummaryBlocking();
    expect(blocking).toBeTruthy();
    // Caching must not change the numbers, only when they are computed.
    expect(tracker.quickSummary()).toBe(blocking);
  });
});

// Issue #403: session-restore also called quickSummaryData(), which still ran
// the full synchronous parse — a half-fix of #42 that blocked SessionStart for
// tens of seconds on active machines. It must be cache-first too.
describe('quickSummaryData is cache-first and never blocks (#403)', () => {
  /** Counts synchronous reads of transcript files while `fn` runs. */
  function countTranscriptReads(fn: () => unknown) {
    const fs = require_('node:fs');
    const orig = fs.readFileSync;
    let reads = 0;
    fs.readFileSync = (file: unknown, ...rest: unknown[]) => {
      if (String(file).endsWith('.jsonl')) reads++;
      return orig.call(fs, file, ...rest);
    };
    try {
      return { result: fn(), reads };
    } finally {
      fs.readFileSync = orig;
    }
  }

  it('returns null on a cold cache without parsing any transcript', () => {
    writeTranscript(join(projects, 'proj-a'), 'a.jsonl', 3, new Date());
    const tracker = loadTracker();

    const { result, reads } = countTranscriptReads(() => tracker.quickSummaryData());
    expect(result).toBeNull();
    expect(reads).toBe(0);
  });

  it('serves the cached totals, not a fresh parse, over a large fixture', () => {
    for (let f = 0; f < 20; f++) {
      writeTranscript(join(projects, `proj-${f % 4}`), `t${f}.jsonl`, 2000, new Date());
    }
    // Sentinel figures no parse of the fixture could produce.
    const totals = { todayCost: 1.23, todayCalls: 7, monthCost: 45.6, monthCalls: 89 };
    writeFileSync(cachePath(), JSON.stringify({ computedAt: Date.now(), totals }));
    const tracker = loadTracker();

    const started = Date.now();
    const { result, reads } = countTranscriptReads(() => tracker.quickSummaryData());
    expect(Date.now() - started).toBeLessThan(2000);
    expect(reads).toBe(0);
    expect(result).toEqual(totals);
  });

  it('serves stale totals rather than recomputing inline', () => {
    writeTranscript(join(projects, 'proj-a'), 'a.jsonl', 3, new Date());
    const totals = { todayCost: 1, todayCalls: 1, monthCost: 2, monthCalls: 2 };
    writeFileSync(cachePath(), JSON.stringify({ computedAt: Date.now() - 60 * 60 * 1000, totals }));
    const tracker = loadTracker();

    const { result, reads } = countTranscriptReads(() => tracker.quickSummaryData());
    expect(reads).toBe(0);
    expect(result).toEqual(totals);
  });
});

describe('parseAllSessions skips transcripts older than the window', () => {
  it('ignores a file whose mtime predates dateStart', () => {
    const now = new Date();
    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const lastYear = new Date(now.getTime() - 400 * 24 * 60 * 60 * 1000);

    writeTranscript(join(projects, 'proj-old'), 'old.jsonl', 5, lastYear);
    writeTranscript(join(projects, 'proj-new'), 'new.jsonl', 2, now);

    const tracker = loadTracker();
    const result = tracker.parseAllSessions(todayStart, now);
    const names = result.map((p: { project: string }) => p.project);

    expect(names).toContain('proj-new');
    expect(names).not.toContain('proj-old');
  });

  it('still reads everything when no start bound is given', () => {
    const now = new Date();
    const lastYear = new Date(now.getTime() - 400 * 24 * 60 * 60 * 1000);
    writeTranscript(join(projects, 'proj-old'), 'old.jsonl', 5, lastYear);

    const tracker = loadTracker();
    // The skip is an optimisation for bounded queries only — an unbounded
    // query must not silently lose history.
    const result = tracker.parseAllSessions(null, null);
    expect(result.map((p: { project: string }) => p.project)).toContain('proj-old');
  });
});
