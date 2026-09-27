/**
 * Session-marker file search for live-accept.mjs: walking common source
 * directories to find the file containing a given session's markers.
 *
 * Split out of live-accept.mjs. See that file for context.
 */
import fs from 'node:fs';
import path from 'node:path';

const EXTENSIONS = ['.html', '.jsx', '.tsx', '.vue', '.svelte', '.astro'];

export function findSessionFile(id, cwd) {
  const marker = `monodesign-variants-start ${id}`;
  const searchDirs = ['src', 'app', 'pages', 'components', 'public', 'views', 'templates', '.'];
  const seen = new Set();

  for (const dir of searchDirs) {
    const absDir = path.join(cwd, dir);
    if (!fs.existsSync(absDir)) continue;
    const result = searchDir(absDir, marker, seen, 0);
    if (result) {
      const content = fs.readFileSync(result, 'utf-8');
      return { file: result, content, lines: content.split('\n') };
    }
  }
  return null;
}

function searchDir(dir, query, seen, depth) {
  if (depth > 5) return null;
  let realDir;
  try { realDir = fs.realpathSync(dir); } catch { return null; }
  if (seen.has(realDir)) return null;
  seen.add(realDir);

  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
  catch { return null; }

  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (!EXTENSIONS.includes(path.extname(entry.name).toLowerCase())) continue;
    const filePath = path.join(dir, entry.name);
    try {
      const content = fs.readFileSync(filePath, 'utf-8');
      if (content.includes(query)) return filePath;
    } catch { /* skip */ }
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (['node_modules', '.git', 'dist', 'build'].includes(entry.name)) continue;
    const result = searchDir(path.join(dir, entry.name), query, seen, depth + 1);
    if (result) return result;
  }

  return null;
}
