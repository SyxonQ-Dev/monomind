// understand-analyze-ignore.mjs — .understandignore support (ported from
// ignore-filter.ts). File-size sweep: split out of understand-analyze.mjs.

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

export const DEFAULT_IGNORE_PATTERNS = [
  'node_modules/', '.git/', 'vendor/', 'venv/', '.venv/', '__pycache__/',
  'dist/', 'build/', 'out/', 'coverage/', '.next/', '.cache/', '.turbo/', 'target/', 'obj/',
  '*.lock', 'package-lock.json', 'yarn.lock', 'pnpm-lock.yaml',
  '*.png', '*.jpg', '*.jpeg', '*.gif', '*.svg', '*.ico', '*.woff', '*.woff2',
  '*.ttf', '*.eot', '*.mp3', '*.mp4', '*.pdf', '*.zip', '*.tar', '*.gz',
  '*.min.js', '*.min.css', '*.map', '*.generated.*',
  '.idea/', '.vscode/', '*.log',
];

export function loadIgnorePatterns(dir) {
  const patterns = [...DEFAULT_IGNORE_PATTERNS];
  const locations = [
    join(dir, '.understand-anything', '.understandignore'),
    join(dir, '.understandignore'),
  ];
  for (const p of locations) {
    if (existsSync(p)) {
      try {
        const lines = readFileSync(p, 'utf-8').split('\n')
          .map(l => l.trim()).filter(l => l && !l.startsWith('#'));
        patterns.push(...lines);
      } catch {}
    }
  }
  return patterns;
}

export function makeIgnoreMatcher(patterns) {
  return function isIgnored(filePath) {
    const norm = filePath.replace(/\\/g, '/');
    for (const pat of patterns) {
      if (pat.startsWith('!')) continue; // negation — skip for simplicity
      if (pat.endsWith('/')) {
        // directory pattern
        if (norm.includes('/' + pat.slice(0, -1) + '/') || norm.startsWith(pat)) return true;
      } else if (pat.startsWith('*.')) {
        // extension glob
        if (norm.endsWith(pat.slice(1))) return true;
      } else if (pat.includes('*')) {
        // simple wildcard — match anywhere in path
        const re = new RegExp('^' + pat.replace(/\./g, '\\.').replace(/\*/g, '.*') + '$');
        if (re.test(norm) || re.test(norm.split('/').pop() || '')) return true;
      } else {
        // exact segment or prefix
        if (norm === pat || norm.includes('/' + pat) || norm.startsWith(pat)) return true;
      }
    }
    return false;
  };
}
