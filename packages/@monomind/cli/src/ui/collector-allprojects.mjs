import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// ---------------------------------------------------------------------------
// Global: all projects on this machine (~/.claude/projects/)
// ---------------------------------------------------------------------------

function _slugToPath(slug) {
  return resolveSlugPath(slug);
}

// Reconstruct the real filesystem path from a Claude project slug.
// Slugs encode the path with every '/' AND '.' replaced by '-' (so a hidden
// directory like '.claude' shows up as a bare '--claude', i.e. an empty split
// token immediately before 'claude' — e.g. the real path
// '/monomind/.claude/worktrees/foo' slugs to '-monomind--claude-worktrees-foo').
// Also lossy when directory names contain literal hyphens (e.g.
// /Desktop/agent-f/accounting). Strategy: naive replace first; if not found,
// greedy DFS through the filesystem trying longest-possible segment (with
// embedded hyphens) at each level.
function resolveSlugPath(slug) {
  const naive = `/${slug.replace(/^-/, '').replace(/-/g, '/')}`;
  try {
    if (fs.existsSync(naive)) return naive;
  } catch {}

  // An empty token between two hyphens marks a collapsed '.' — reattach it to
  // the following token instead of dropping it, so hidden directories survive
  // reconstruction (dropping it silently turns '.claude' into 'claude', which
  // never exists on disk, sending the walk down the wrong path entirely).
  const rawTokens = slug.replace(/^-/, '').split('-');
  const tokens = [];
  let pendingDot = false;
  for (const part of rawTokens) {
    if (part === '') {
      pendingDot = true;
      continue;
    }
    tokens.push(pendingDot ? `.${part}` : part);
    pendingDot = false;
  }

  function walk(idx, dir) {
    if (idx === tokens.length) return dir;
    // Try longest span first (greedy) so "agent-f" is preferred over "agent"+"f"
    for (let end = tokens.length; end > idx; end--) {
      const segment = tokens.slice(idx, end).join('-');
      const candidate = path.join(dir, segment);
      try {
        if (fs.statSync(candidate).isDirectory()) {
          const result = walk(end, candidate);
          if (result !== null) return result;
        }
      } catch {}
    }
    return null;
  }

  return walk(0, '/') || naive;
}

let _apCache = null;
let _apCacheTs = 0;
const AP_TTL = 5_000;

export function collectAllProjects() {
  const now = Date.now();
  if (_apCache !== null && now - _apCacheTs < AP_TTL) return _apCache;
  const homeDir = os.homedir();
  const projectsRoot = path.join(homeDir, '.claude', 'projects');
  const result = [];

  let slugs = [];
  try {
    slugs = fs.readdirSync(projectsRoot);
  } catch {
    return result;
  }

  for (const slug of slugs) {
    const projectClaudeDir = path.join(projectsRoot, slug);
    let stat;
    try {
      stat = fs.statSync(projectClaudeDir);
    } catch {
      continue;
    }
    if (!stat.isDirectory()) continue;

    // Find session files (.jsonl) and subdirs (session folders)
    let entries = [];
    try {
      entries = fs.readdirSync(projectClaudeDir);
    } catch {
      continue;
    }

    const sessionFiles = entries.filter((e) => e.endsWith('.jsonl'));
    const sessions = sessionFiles
      .map((f) => {
        const fp = path.join(projectClaudeDir, f);
        let fstat = null;
        try {
          fstat = fs.statSync(fp);
        } catch {}
        // Peek at first line for model/type info
        let firstTurn = null;
        try {
          const buf = Buffer.alloc(512);
          const fd = fs.openSync(fp, 'r');
          try {
            fs.readSync(fd, buf, 0, 512, 0);
          } finally {
            fs.closeSync(fd);
          }
          const line = buf.toString('utf8').split('\n')[0];
          firstTurn = JSON.parse(line);
        } catch {}
        return {
          id: path.basename(f, '.jsonl'),
          file: fp,
          mtime: fstat ? fstat.mtimeMs : null,
          size: fstat ? fstat.size : null,
          lines: null, // skip line count for perf
          model: firstTurn?.model ? firstTurn.model : null,
        };
      })
      .sort((a, b) => (b.mtime || 0) - (a.mtime || 0));

    // Resolve the actual filesystem path (handles hyphens in directory names)
    const diskPath = resolveSlugPath(slug);
    const parts = diskPath.split('/').filter(Boolean);
    const name = parts[parts.length - 1] || slug;
    const exists = fs.existsSync(diskPath);

    // Last activity = most recent session mtime
    const lastActivity = sessions.length ? sessions[0].mtime : null;

    // Count auto-memory files from ~/.claude/projects/<slug>/memory/
    let memoryCount = 0;
    try {
      const memDir = path.join(os.homedir(), '.claude', 'projects', slug, 'memory');
      if (fs.existsSync(memDir)) {
        memoryCount = fs
          .readdirSync(memDir)
          .filter((f) => f.endsWith('.md') && f !== 'MEMORY.md').length;
      }
    } catch {}

    result.push({
      slug,
      name,
      path: diskPath,
      exists,
      sessionCount: sessions.length,
      sessions: sessions.slice(0, 5), // top 5 most recent
      lastActivity,
      memoryCount,
      totalSize: sessions.reduce((sum, s) => sum + (s.size || 0), 0),
    });
  }

  // Sort by most recently active
  result.sort((a, b) => (b.lastActivity || 0) - (a.lastActivity || 0));
  _apCache = result;
  _apCacheTs = Date.now();
  return result;
}
