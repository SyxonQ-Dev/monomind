// understand-analyze-detect.mjs — Language and framework detection (slim
// ports of language-registry.ts / framework-registry.ts).
// File-size sweep: split out of understand-analyze.mjs.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createRequire } from 'node:module';

// ── Language detection (slim port of language-registry.ts) ──────────────────
const LANGUAGE_BY_EXT = {
  '.ts': 'TypeScript', '.tsx': 'TypeScript',
  '.js': 'JavaScript', '.jsx': 'JavaScript', '.mjs': 'JavaScript', '.cjs': 'JavaScript',
  '.py': 'Python', '.pyi': 'Python',
  '.rs': 'Rust', '.go': 'Go',
  '.java': 'Java', '.kt': 'Kotlin', '.scala': 'Scala',
  '.rb': 'Ruby', '.php': 'PHP', '.swift': 'Swift',
  '.c': 'C', '.h': 'C', '.cpp': 'C++', '.cc': 'C++', '.hpp': 'C++', '.hxx': 'C++',
  '.cs': 'C#', '.fs': 'F#',
  '.sh': 'Shell', '.bash': 'Shell', '.zsh': 'Shell',
  '.lua': 'Lua', '.r': 'R', '.dart': 'Dart', '.ex': 'Elixir', '.exs': 'Elixir',
  '.sol': 'Solidity', '.zig': 'Zig', '.nim': 'Nim',
  '.html': 'HTML', '.css': 'CSS', '.scss': 'SCSS', '.vue': 'Vue', '.svelte': 'Svelte',
};

export function detectLanguages(fileNodes) {
  const counts = new Map();
  for (const n of fileNodes) {
    if (!n.file_path) continue;
    const lastDot = n.file_path.lastIndexOf('.');
    if (lastDot === -1) continue;
    const ext = n.file_path.slice(lastDot).toLowerCase();
    const lang = LANGUAGE_BY_EXT[ext];
    if (lang) counts.set(lang, (counts.get(lang) || 0) + 1);
  }
  // Return languages with >=3 files, sorted by count desc
  return [...counts.entries()]
    .filter(([, c]) => c >= 3)
    .sort((a, b) => b[1] - a[1])
    .map(([lang]) => lang);
}

// ── Framework detection (slim port of framework-registry.ts) ────────────────
const FRAMEWORK_SIGNATURES = [
  // [name, manifestFile, keywords[]]
  ['React',        'package.json',     ['"react"']],
  ['Next.js',      'package.json',     ['"next"']],
  ['Vue',          'package.json',     ['"vue"']],
  ['Svelte',       'package.json',     ['"svelte"']],
  ['Angular',      'package.json',     ['"@angular/core"']],
  ['Express',      'package.json',     ['"express"']],
  ['Fastify',      'package.json',     ['"fastify"']],
  ['NestJS',       'package.json',     ['"@nestjs/core"']],
  ['Vite',         'package.json',     ['"vite"']],
  ['Webpack',      'package.json',     ['"webpack"']],
  ['TypeScript',   'package.json',     ['"typescript"']],
  ['Claude Code',  'package.json',     ['"@anthropic-ai/claude-code"']],
  ['Django',       'requirements.txt', ['django']],
  ['Flask',        'requirements.txt', ['flask']],
  ['FastAPI',      'requirements.txt', ['fastapi']],
  ['Rails',        'Gemfile',          ['rails']],
  ['Spring Boot',  'pom.xml',          ['spring-boot']],
  ['Axum',         'Cargo.toml',       ['axum']],
  ['Actix',        'Cargo.toml',       ['actix-web']],
  ['Tokio',        'Cargo.toml',       ['tokio']],
  ['Gin',          'go.mod',           ['gin-gonic/gin']],
];

export function findManifests(dir, manifestName, maxDepth = 4) {
  const fs = createRequire(import.meta.url)('node:fs');
  const results = [];
  function walk(d, depth) {
    if (depth > maxDepth) return;
    let entries;
    try { entries = fs.readdirSync(d, { withFileTypes: true }); }
    catch { return; }
    for (const e of entries) {
      if (e.name === 'node_modules' || e.name === 'dist' || e.name.startsWith('.')) continue;
      const full = join(d, e.name);
      if (e.isDirectory()) walk(full, depth + 1);
      else if (e.name === manifestName) results.push(full);
    }
  }
  walk(dir, 0);
  return results;
}

export function detectFrameworks(dir) {
  const detected = [];
  const seen = new Set();
  // Cache manifest contents by name to avoid re-reading
  const manifestCache = new Map();
  for (const [name, manifest, keywords] of FRAMEWORK_SIGNATURES) {
    if (seen.has(name)) continue;
    let manifestPaths = manifestCache.get(manifest);
    if (!manifestPaths) {
      manifestPaths = findManifests(dir, manifest);
      manifestCache.set(manifest, manifestPaths);
    }
    for (const p of manifestPaths) {
      try {
        const content = readFileSync(p, 'utf-8').toLowerCase();
        if (keywords.some(k => content.includes(k.toLowerCase()))) {
          detected.push(name);
          seen.add(name);
          break;
        }
      } catch {}
    }
  }
  return detected;
}
