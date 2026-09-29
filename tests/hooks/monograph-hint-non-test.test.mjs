/**
 * #447: [MONOGRAPH_HINT] lookups in pre-search / pre-bash took the first
 * matching row, often a test mock. They must prefer non-test definitions
 * (same test-path heuristic as @monoes/monograph's resolveNodeByName) and
 * skip the hint entirely when every match lives in a test file.
 */

import { execFileSync, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import { createRequire } from 'node:module';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const HELPERS = path.resolve(__dirname, '../../.claude/helpers');
const HANDLER = path.join(HELPERS, 'hook-handler.cjs');
const { _isTestPath } = require(path.join(HELPERS, 'utils', 'monograph.cjs'));

let tmp;

function git(...args) {
  return execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], {
    cwd: tmp,
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'ignore'],
  }).trim();
}

// A fresh graph (index_meta = HEAD) with the given nodes, plus a stub
// @monoes/monograph whose openDb() is node:sqlite. Test rows are inserted
// first so a plain `LIMIT 1` would pick them.
function freshGraphProject(nodes) {
  git('init', '-q');
  git('commit', '-q', '--allow-empty', '-m', 'c0');
  const { DatabaseSync } = require('node:sqlite');
  fs.mkdirSync(path.join(tmp, '.monomind'), { recursive: true });
  const db = new DatabaseSync(path.join(tmp, '.monomind', 'monograph.db'));
  db.exec('CREATE TABLE index_meta (key TEXT PRIMARY KEY, value TEXT)');
  db.exec(
    'CREATE TABLE nodes (id TEXT, name TEXT, label TEXT, file_path TEXT, start_line INTEGER)',
  );
  db.prepare("INSERT INTO index_meta VALUES ('last_commit_hash', ?)").run(git('rev-parse', 'HEAD'));
  const ins = db.prepare('INSERT INTO nodes VALUES (?, ?, ?, ?, ?)');
  nodes.forEach((n, i) => ins.run(String(i + 1), n[0], n[1], n[2], n[3] ?? null));
  db.close();
  const pkg = path.join(tmp, 'node_modules', '@monoes', 'monograph');
  fs.mkdirSync(pkg, { recursive: true });
  fs.writeFileSync(
    path.join(pkg, 'package.json'),
    JSON.stringify({ name: '@monoes/monograph', version: '0.0.0', main: 'index.cjs' }),
  );
  fs.writeFileSync(
    path.join(pkg, 'index.cjs'),
    "const { DatabaseSync } = require('node:sqlite');\n" +
      'exports.openDb = (p) => new DatabaseSync(p, { readOnly: true });\n',
  );
}

function runHook(command, input) {
  const env = { ...process.env, CLAUDE_PROJECT_DIR: tmp };
  delete env.MONOMIND_HOOK_QUIET;
  delete env.MONOMIND_SDK_AGENT;
  delete env.MONOMIND_GRAPH_GATE;
  return spawnSync(process.execPath, [HANDLER, command], {
    cwd: tmp,
    env,
    input: JSON.stringify(input),
    encoding: 'utf-8',
    timeout: 15000,
  });
}

function hintContext(r) {
  expect(r.status).toBe(0);
  return r.stdout ? JSON.parse(r.stdout).hookSpecificOutput.additionalContext : '';
}

const MOCK_AND_SRC = [
  ['bridgeStoreEntry', 'Function', 'packages/cli/src/__tests__/hooks-core.test.ts', 17],
  ['bridgeStoreEntry', 'Function', 'packages/cli/src/memory/memory-bridge.ts', 120],
];
const ONLY_TESTS = [
  ['mockOnlyHelper', 'Function', 'packages/cli/src/__tests__/a.test.ts', 3],
  ['mockOnlyHelper', 'Function', 'tests/hooks/b.spec.mjs', 9],
];

beforeEach(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hint-nt-')));
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('_isTestPath mirrors the monograph resolver heuristic (#447)', () => {
  it('flags test/mock paths and leaves source paths alone', () => {
    for (const p of [
      'src/__tests__/x.ts',
      'src/__mocks__/x.ts',
      'pkg/test/x.ts',
      'tests/x.mjs',
      'pkg/e2e/x.ts',
      'src/x.test.ts',
      'src/x.spec.js',
      'src\\__tests__\\x.ts',
    ]) {
      expect(_isTestPath(p)).toBe(true);
    }
    for (const p of ['src/memory/memory-bridge.ts', 'src/testing-utils.ts', '', null]) {
      expect(_isTestPath(p)).toBe(false);
    }
  });
});

describe('hints prefer non-test definitions (#447)', () => {
  it('pre-search points at the src definition, not the test mock', () => {
    freshGraphProject(MOCK_AND_SRC);
    const ctx = hintContext(
      runHook('pre-search', { tool_name: 'Grep', tool_input: { pattern: 'bridgeStoreEntry' } }),
    );
    expect(ctx).toContain(
      '[MONOGRAPH_HINT] bridgeStoreEntry found at packages/cli/src/memory/memory-bridge.ts:120',
    );
    expect(ctx).not.toContain('__tests__');
  });

  it('pre-bash grep points at the src definition, not the test mock', () => {
    freshGraphProject(MOCK_AND_SRC);
    const ctx = hintContext(
      runHook('pre-bash', {
        tool_name: 'Bash',
        tool_input: { command: 'grep -rn "bridgeStoreEntry" .' },
      }),
    );
    expect(ctx).toContain(
      '[MONOGRAPH_HINT] bridgeStoreEntry → packages/cli/src/memory/memory-bridge.ts:120',
    );
    expect(ctx).not.toContain('__tests__');
  });

  it('pre-search gives no hint when every match is a test file', () => {
    freshGraphProject(ONLY_TESTS);
    const r = runHook('pre-search', {
      tool_name: 'Grep',
      tool_input: { pattern: 'mockOnlyHelper' },
    });
    expect(r.status).toBe(0);
    expect(r.stdout).toBe('');
  });

  it('pre-bash grep gives no hint when every match is a test file', () => {
    freshGraphProject(ONLY_TESTS);
    const r = runHook('pre-bash', {
      tool_name: 'Bash',
      tool_input: { command: 'grep -rn "mockOnlyHelper" .' },
    });
    expect(hintContext(r)).not.toContain('[MONOGRAPH_HINT]');
  });

  it('file-name hints prefer the non-test file', () => {
    freshGraphProject([
      ['widget.ts', 'File', 'src/__tests__/fixtures/widget.ts'],
      ['widget.ts', 'File', 'src/widget.ts'],
    ]);
    const ctx = hintContext(
      runHook('pre-search', { tool_name: 'Grep', tool_input: { pattern: 'widget.ts' } }),
    );
    expect(ctx).toContain('[MONOGRAPH_HINT] file widget.ts found at src/widget.ts');
  });
});
