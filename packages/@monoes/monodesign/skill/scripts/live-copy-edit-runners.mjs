// Running the Codex/Claude CLI as a child process to apply a copy-edit
// batch, plus the provider-selection and error-message helpers around it.
// Split out of live-copy-edit-agent.mjs (file-size sweep — pure move, no
// behaviour change).

import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const DEFAULT_TIMEOUT_MS = 60_000;

export function parseCopyEditAgentResult(text) {
  const trimmed = String(text || '').trim();
  if (!trimmed) return null;

  const parsedOuter = tryParseJson(trimmed);
  if (parsedOuter) {
    if (typeof parsedOuter.result === 'string') {
      const nested = parseCopyEditAgentResult(parsedOuter.result);
      if (nested) return nested;
    }
    if (parsedOuter.status === 'done' || parsedOuter.status === 'partial' || parsedOuter.status === 'error') return parsedOuter;
  }

  const jsonMatch = trimmed.match(/\{[\s\S]*\}/);
  if (!jsonMatch) return null;
  const parsed = tryParseJson(jsonMatch[0]);
  if (parsed?.status === 'done' || parsed?.status === 'partial' || parsed?.status === 'error') return parsed;
  return null;
}

export function chooseCopyEditAgent({
  env = process.env,
  authCheck = commandAuthed,
  chatAvailable = () => false,
} = {}) {
  const mode = (env.MONODESIGN_LIVE_COPY_AGENT || 'auto').trim().toLowerCase();
  if (mode === '0' || mode === 'false' || mode === 'off' || mode === 'none') return null;
  if (mode === 'mock') return 'mock';
  if (mode === 'chat') return chatAvailable() ? 'chat' : null;
  if (mode === 'codex') return commandExists('codex') ? 'codex' : null;
  if (mode === 'claude') return commandExists('claude') ? 'claude' : null;
  if (mode !== 'auto') return null;
  if (authCheck('codex')) return 'codex';
  if (authCheck('claude')) return 'claude';
  if (chatAvailable()) return 'chat';
  return null;
}

function runCodex(prompt, { cwd, env, resultPath, logPath, timeoutMs = DEFAULT_TIMEOUT_MS }) {
  const args = [
    'exec',
    '--cd', cwd,
    '--dangerously-bypass-approvals-and-sandbox',
    '--ephemeral',
    '--output-last-message', resultPath,
    '-c', `model_reasoning_effort="${env.MONODESIGN_LIVE_COPY_AGENT_EFFORT || 'low'}"`,
  ];
  if (env.MONODESIGN_LIVE_COPY_AGENT_MODEL) {
    args.push('--model', env.MONODESIGN_LIVE_COPY_AGENT_MODEL);
  }
  args.push('-');
  return runAgentProcess('codex', args, prompt, { cwd, env, logPath, timeoutMs });
}

function runClaude(prompt, { cwd, env, resultPath, logPath, timeoutMs = DEFAULT_TIMEOUT_MS }) {
  const args = [
    '--print',
    '--permission-mode', 'bypassPermissions',
    '--output-format', 'json',
  ];
  if (env.MONODESIGN_LIVE_COPY_AGENT_MODEL) {
    args.push('--model', env.MONODESIGN_LIVE_COPY_AGENT_MODEL);
  }
  args.push(prompt);
  // Forward env as-is so CLAUDE_CODE_OAUTH_TOKEN and ANTHROPIC_API_KEY flow
  // through. On macOS, `claude /login` stores creds in the Keychain, which a
  // non-TTY subprocess cannot read; setting CLAUDE_CODE_OAUTH_TOKEN (via
  // `claude setup-token`) is the supported headless auth path.
  return runAgentProcess('claude', args, '', { cwd, env, logPath, timeoutMs, mirrorOutputPath: resultPath });
}

function runAgentProcess(command, args, stdin, { cwd, env, logPath, timeoutMs, mirrorOutputPath }) {
  return new Promise((resolve, reject) => {
    const log = fs.createWriteStream(logPath, { flags: 'a' });
    const child = spawn(command, args, {
      cwd,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let output = '';
    let settled = false;
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      rejectOnce(new Error(`AI copy-edit worker timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    const rejectOnce = (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      log.end();
      reject(err);
    };
    const resolveOnce = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (mirrorOutputPath) fs.writeFileSync(mirrorOutputPath, output);
      log.end();
      resolve();
    };

    process.once('SIGTERM', () => {
      try { child.kill('SIGTERM'); } catch {}
    });
    child.stdout.on('data', (chunk) => {
      output += chunk.toString();
      log.write(chunk);
    });
    child.stderr.on('data', (chunk) => {
      log.write(chunk);
    });
    child.on('error', rejectOnce);
    child.on('exit', (code, signal) => {
      if (code === 0) {
        resolveOnce();
      } else {
        const hint = extractRunnerErrorMessage(output, command);
        rejectOnce(new Error(hint || `${command} exited with ${signal || code}`));
      }
    });
    if (stdin) child.stdin.end(stdin);
    else child.stdin.end();
  });
}

function isPathInsideOrEqual(cwd, file) {
  const relative = path.relative(path.resolve(cwd), path.resolve(file)).split(path.sep).join('/');
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function tryParseJson(text) {
  try { return JSON.parse(text); } catch { return null; }
}

function truncate(value, max) {
  if (typeof value !== 'string') return value;
  if (value.length <= max) return value;
  return `${value.slice(0, max)}... [truncated ${value.length - max} chars]`;
}

function commandExists(command) {
  const result = spawnSync(command, ['--version'], { stdio: 'ignore' });
  return !result.error && result.status === 0;
}

/**
 * Build a diagnostic error message explaining why no AI runner is usable.
 * Splits the previous "Install/authenticate Codex or Claude" lump into a
 * per-provider summary so the user knows exactly which step unblocks them.
 */
export function describeNoProviderError({
  exists = commandExists,
  chatAvailable = () => false,
  env = process.env,
} = {}) {
  const lines = ['No live copy-edit AI runner is available.'];
  if (exists('claude')) {
    if (env.CLAUDE_CODE_OAUTH_TOKEN) {
      lines.push('  • Claude CLI: installed; CLAUDE_CODE_OAUTH_TOKEN is set but the CLI still rejected it. The token may be expired or invalid.');
    } else {
      lines.push('  • Claude CLI: installed but not selected. If Apply still fails, the subprocess may be unable to read your `claude /login` credentials (on macOS, the Keychain can be unreachable from a no-TTY child).');
      lines.push('      Headless fix: run `claude setup-token` once, then `export CLAUDE_CODE_OAUTH_TOKEN=<the printed sk-ant-oat01-… token>` before starting `live-server.mjs`.');
      lines.push('      Alternative: `export ANTHROPIC_API_KEY=<key>` if you have console.anthropic.com credits.');
    }
  } else {
    lines.push('  • Claude CLI: not installed.');
  }
  if (exists('codex')) {
    lines.push('  • Codex CLI: installed. If Apply still fails, run `codex login` to authenticate.');
  } else {
    lines.push('  • Codex CLI: not installed.');
  }
  if (chatAvailable()) {
    lines.push('  • Chat: an Monodesign live session is polling but selection chose another provider — unexpected; please report.');
  } else {
    lines.push('  • Chat: no Monodesign live session is currently polling on this server. Start Monodesign live in your chat to route Apply through the chat agent.');
  }
  lines.push('Fix one of the above, or set MONODESIGN_LIVE_COPY_AGENT=mock for tests.');
  return lines.join('\n');
}

/**
 * Pull a human-readable failure reason out of a subprocess's stdout when the
 * process exited non-zero. Recognizes:
 *   - Claude CLI `--output-format json` errors:
 *     {"is_error": true, "result": "Not logged in · Please run /login", ...}
 *   - Generic JSON payloads with `message` or `error` strings.
 *   - The last non-empty line of unstructured output.
 * Returns null when nothing meaningful surfaces, so the caller can fall back
 * to its existing "X exited with N" message.
 */
export function extractRunnerErrorMessage(output, command) {
  const text = String(output || '').trim();
  if (!text) return null;
  const candidates = [];
  const direct = tryParseJson(text);
  if (direct) candidates.push(direct);
  const trailingMatch = text.match(/\{[\s\S]*\}\s*$/);
  if (trailingMatch) {
    const tail = tryParseJson(trailingMatch[0]);
    if (tail && tail !== direct) candidates.push(tail);
  }
  for (const parsed of candidates) {
    if (!parsed || typeof parsed !== 'object') continue;
    if (parsed.is_error === true && typeof parsed.result === 'string' && parsed.result.trim()) {
      return `${command} CLI: ${parsed.result.trim()}`;
    }
    if (typeof parsed.message === 'string' && parsed.message.trim()) {
      return `${command} CLI: ${parsed.message.trim()}`;
    }
    if (typeof parsed.error === 'string' && parsed.error.trim()) {
      return `${command} CLI: ${parsed.error.trim()}`;
    }
  }
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (lines.length > 0) {
    const last = lines[lines.length - 1];
    if (last.length > 0 && last.length < 400) return `${command}: ${last}`;
  }
  return null;
}

/**
 * Pre-flight a CLI provider with a trivial prompt and report whether it can
 * actually do work. Cached per process so the `auto` branch of
 * chooseCopyEditAgent only pays the cost once per server boot.
 *
 * For claude we run the same `--print --output-format json` invocation we use
 * for real batches; an unauthenticated CLI fails in ~36 ms with
 * { is_error: true, result: "Not logged in · ..." }.
 * For codex we only confirm the binary exists — `codex exec` always burns a
 * real LLM call, so checking auth without spending tokens is not possible
 * here; if the user has codex installed but unauthed, the runtime error from
 * runCodex (now improved by extractRunnerErrorMessage) will surface clearly.
 */
const COMMAND_AUTH_CACHE = new Map();

function commandAuthed(command) {
  if (COMMAND_AUTH_CACHE.has(command)) return COMMAND_AUTH_CACHE.get(command);
  const ok = computeCommandAuthed(command);
  COMMAND_AUTH_CACHE.set(command, ok);
  return ok;
}

function computeCommandAuthed(command) {
  if (!commandExists(command)) return false;
  if (command === 'codex') return true;
  if (command !== 'claude') return false;
  let result;
  try {
    result = spawnSync('claude', [
      '--print',
      '--output-format', 'json',
      'ping',
    ], {
      encoding: 'utf-8',
      timeout: 10000,
      env: process.env,
    });
  } catch {
    return false;
  }
  if (result.error || result.signal) return false;
  const stdout = String(result.stdout || '').trim();
  if (result.status !== 0) {
    // Non-zero exit: probably an auth or config error. Definitely not usable.
    return false;
  }
  if (!stdout) return true;
  const parsed = tryParseJson(stdout) || tryParseJson(stdout.match(/\{[\s\S]*\}\s*$/)?.[0] || '');
  if (parsed && parsed.is_error === true) return false;
  return true;
}

export {
  runCodex,
  runClaude,
  runAgentProcess,
  isPathInsideOrEqual,
  tryParseJson,
  truncate,
  commandExists,
  commandAuthed,
  computeCommandAuthed,
};
