/**
 * #409: [MONOGRAPH_HINT]s from the PreToolUse pre-search / pre-bash hooks
 * must reach the model. Claude Code only feeds PreToolUse stdout to the model
 * when it is a JSON object carrying hookSpecificOutput.additionalContext, so
 * plain console.log hints were invisible — yet they were credited as
 * "$ saved" in the status line. These tests pin the JSON contract, the
 * unchanged graph-gate block output, and the removal of the synthetic "$".
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
const STATUSLINE = path.join(HELPERS, 'statusline.cjs');

let tmp;

function git(...args) {
  return execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], {
    cwd: tmp,
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'ignore'],
  }).trim();
}

// A fresh graph (index_meta = HEAD) holding one symbol, plus a stub
// @monoes/monograph whose openDb() is node:sqlite — enough for the hooks.
function freshGraphProject() {
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
  db.prepare(
    "INSERT INTO nodes VALUES ('1', 'computeWidgetScore', 'Function', 'src/widget.ts', 42)",
  ).run();
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

function usage() {
  return JSON.parse(
    fs.readFileSync(path.join(tmp, '.monomind', 'metrics', 'graph-usage.json'), 'utf-8'),
  );
}

beforeEach(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hint-out-')));
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('pre-search / pre-bash hints reach the model (#409)', () => {
  it('pre-search emits one PreToolUse JSON document carrying the hint as additionalContext', () => {
    freshGraphProject();
    const r = runHook('pre-search', {
      tool_name: 'Grep',
      tool_input: { pattern: 'computeWidgetScore' },
    });
    expect(r.status).toBe(0);
    const out = JSON.parse(r.stdout);
    expect(out.hookSpecificOutput.hookEventName).toBe('PreToolUse');
    expect(out.hookSpecificOutput.additionalContext).toContain(
      '[MONOGRAPH_HINT] computeWidgetScore found at src/widget.ts:42',
    );
  });

  it('pre-bash grep emits the hint as PreToolUse JSON too', () => {
    freshGraphProject();
    const r = runHook('pre-bash', {
      tool_name: 'Bash',
      tool_input: { command: 'grep -rn "computeWidgetScore" src' },
    });
    expect(r.status).toBe(0);
    const out = JSON.parse(r.stdout);
    expect(out.hookSpecificOutput.hookEventName).toBe('PreToolUse');
    expect(out.hookSpecificOutput.additionalContext).toContain(
      '[MONOGRAPH_HINT] computeWidgetScore',
    );
  });

  it('folds the graph-gate reminder into the same JSON document', () => {
    freshGraphProject();
    const input = {
      session_id: 's1',
      tool_name: 'Grep',
      tool_input: { pattern: 'computeWidgetScore' },
    };
    expect(runHook('pre-search', input).status).toBe(2); // first call: gate block
    const r = runHook('pre-search', input);
    expect(r.status).toBe(0);
    const ctx = JSON.parse(r.stdout).hookSpecificOutput.additionalContext;
    expect(ctx).toContain('[MONOGRAPH_REMINDER]');
    expect(ctx).toContain('[MONOGRAPH_HINT] computeWidgetScore');
  });

  it('keeps the graph-gate block decision on stderr with exit 2 and a clean stdout', () => {
    freshGraphProject();
    const r = runHook('pre-search', {
      session_id: 's2',
      tool_name: 'Grep',
      tool_input: { pattern: 'computeWidgetScore' },
    });
    expect(r.status).toBe(2);
    expect(r.stdout).toBe('');
    expect(JSON.parse(r.stderr.trim()).decision).toBe('block');
  });

  it('keeps the destructive-ops block on stderr with exit 2 and a clean stdout', () => {
    freshGraphProject();
    const r = runHook('pre-bash', { tool_name: 'Bash', tool_input: { command: 'rm -rf /' } });
    expect(r.status).toBe(2);
    expect(r.stdout).toBe('');
  });

  it('prints nothing on stdout when there is no hint', () => {
    freshGraphProject();
    const r = runHook('pre-search', {
      tool_name: 'Grep',
      tool_input: { pattern: 'noSuchSymbolAnywhere' },
    });
    expect(r.status).toBe(0);
    expect(r.stdout).toBe('');
  });

  it('does not credit synthetic saved tokens/$ for a hint', () => {
    freshGraphProject();
    runHook('pre-search', { tool_name: 'Grep', tool_input: { pattern: 'computeWidgetScore' } });
    const d = usage();
    expect(d.graph_assist_search).toBe(1);
    expect(d.tokens_saved).toBeUndefined();
    expect(d.dollars_saved).toBeUndefined();
  });
});

describe('status line no longer shows unmeasured "$ saved" (#409)', () => {
  it('renders hint counts instead of dollars from graph-usage.json', () => {
    fs.mkdirSync(path.join(tmp, '.monomind', 'metrics'), { recursive: true });
    fs.writeFileSync(
      path.join(tmp, '.monomind', 'metrics', 'graph-usage.json'),
      JSON.stringify({
        graph_assist_search: 7,
        grep_call: 3,
        tokens_saved: 11900,
        dollars_saved: 3.21,
      }),
    );
    const out = execFileSync(process.execPath, [STATUSLINE], {
      cwd: tmp,
      env: { ...process.env, CLAUDE_PROJECT_DIR: tmp },
      encoding: 'utf-8',
      timeout: 20000,
    });
    expect(out).not.toContain('3.21');
    expect(out).not.toContain('💰');
    expect(out).toContain('7 hints');
  });
});
