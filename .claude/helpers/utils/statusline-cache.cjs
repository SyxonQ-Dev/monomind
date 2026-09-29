'use strict';
/**
 * Segment cache for statusline.cjs (#429).
 *
 * Claude Code re-runs the statusline on nearly every message update, so the
 * segments that spawn a process (git, sqlite3, curl, npm) are cached in one
 * small JSON file with a per-segment TTL. A render with a warm cache is file
 * reads plus formatting; an expired segment is recomputed on the render that
 * finds it expired (lazy refresh) and written back.
 */
const fs = require('fs');
const path = require('path');

/**
 * @param {string} file  cache path, e.g. <project>/.monomind/cache/statusline.json
 * @param {() => number} [now]
 * @returns {(key: string, ttlMs: number, compute: () => unknown) => unknown}
 */
function createSegmentCache(file, now = Date.now) {
  let data = null;

  function load() {
    if (data) return data;
    try { data = JSON.parse(fs.readFileSync(file, 'utf-8')); } catch { data = {}; }
    if (!data || typeof data !== 'object' || Array.isArray(data)) data = {};
    return data;
  }

  function save() {
    // Only projects that already have .monomind/ get a cache; never create it.
    if (!fs.existsSync(path.dirname(path.dirname(file)))) return;
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const tmp = `${file}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(data));
      fs.renameSync(tmp, file);
    } catch { /* a missed write only costs a recompute next render */ }
  }

  return function cached(key, ttlMs, compute) {
    const d = load();
    const entry = d[key];
    const t = now();
    if (entry && typeof entry.at === 'number' && t >= entry.at && t - entry.at < ttlMs) {
      return entry.v;
    }
    const v = compute();
    d[key] = { at: t, v };
    save();
    return v;
  };
}

module.exports = { createSegmentCache };
