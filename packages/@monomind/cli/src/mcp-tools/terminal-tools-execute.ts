import { execSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import {
  type ExecError,
  filterSecretEnvVars,
  isExecuteEnabled,
  isProjectFlagFilePresent,
  loadTerminalStoreOrNull,
  saveTerminalStore,
  type TerminalSession,
} from './terminal-tools-core.js';
import type { MCPTool } from './types.js';
import { getProjectCwd } from './types.js';

export const terminalExecuteTool: MCPTool = {
  name: 'terminal_execute',
  description: 'Execute a command in a terminal session',
  category: 'terminal',
  inputSchema: {
    type: 'object',
    properties: {
      sessionId: { type: 'string', description: 'Terminal session ID' },
      command: { type: 'string', description: 'Command to execute' },
      timeout: { type: 'number', description: 'Command timeout in ms' },
      captureOutput: { type: 'boolean', description: 'Capture command output' },
    },
    required: ['command'],
  },
  handler: async (input: Record<string, unknown>) => {
    // C2 / i-032a: refuse execution unless the USER (not the project) has
    // opted in. See isExecuteEnabled() for the rationale and accepted
    // opt-in signals.
    if (!isExecuteEnabled()) {
      const projectFlagHint = isProjectFlagFilePresent()
        ? ' Found .monomind/enable-terminal.json in this project — project files no longer grant terminal access (i-032a); it is ignored.'
        : '';
      return {
        success: false,
        error: `terminal_execute is disabled by default. Set MONOMIND_ENABLE_TERMINAL=1 or write ~/.monomind/enable-terminal.json with {"enabled": true} to opt in. The metacharacter denylist cannot prevent exfiltration via direct binaries (curl, aws, scp).${projectFlagHint}`,
      };
    }
    const store = loadTerminalStoreOrNull();
    if (!store) {
      return {
        success: false,
        error:
          'Terminal store is unreadable/corrupt — refusing to execute to avoid overwriting real session data.',
      };
    }
    const sessionId = input.sessionId as string | undefined;
    // Cap command: the metacharacter regex check at line 220 is O(n), and the
    // raw command is stored verbatim in session history (up to 200 entries).
    // A realistic shell command is well under 64 KB; cap there.
    const MAX_TERMINAL_COMMAND_LEN = 64 * 1024;
    const rawCommand = input.command as string;
    const command =
      typeof rawCommand === 'string' && rawCommand.length > MAX_TERMINAL_COMMAND_LEN
        ? rawCommand.slice(0, MAX_TERMINAL_COMMAND_LEN)
        : rawCommand;
    const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
    // Reject inherited keys (incl. toString/hasOwnProperty/etc.) so a tampered
    // store.json can't redirect bracket access into Object.prototype.
    if (
      sessionId &&
      (typeof sessionId !== 'string' ||
        FORBIDDEN_KEYS.has(sessionId) ||
        !Object.hasOwn(store.sessions, sessionId))
    ) {
      return { success: false, error: 'Invalid sessionId' };
    }
    // Find or create default session
    let session: TerminalSession | undefined = sessionId
      ? store.sessions[sessionId]
      : Object.values(store.sessions).find((s) => s.status === 'active');
    if (!session) {
      // Create default session
      const id = `term-${Date.now()}-${randomBytes(4).toString('hex')}`;
      session = {
        id,
        name: 'Default Terminal',
        status: 'active',
        createdAt: new Date().toISOString(),
        lastActivity: new Date().toISOString(),
        workingDir: getProjectCwd(),
        history: [],
        env: {},
      };
      store.sessions[id] = session;
    }
    // Reject shell metacharacters AND env-prefix syntax. The previous regex
    // allowed `=`, which `/bin/sh` interprets as a per-command env override
    // (`PATH=/tmp/evil ls`, `LD_PRELOAD=/tmp/x.so cmd`) — turning the
    // metacharacter denylist into RCE. Also reject leading-dash so the
    // first arg can't be misinterpreted by the spawned binary as a flag,
    // and reject glob/expansion characters that may evaluate paths.
    if (/[|;&`$\n\r<>=*?~(){}[\]#!\\"']/.test(command)) {
      return { error: 'Command contains disallowed shell metacharacters', allowed: false };
    }
    if (/^\s*-/.test(command)) {
      return { error: 'Command must not start with "-"', allowed: false };
    }
    const rawTimeout = Number(input.timeout);
    const timeout =
      Number.isFinite(rawTimeout) && rawTimeout > 0 ? Math.min(rawTimeout, 5 * 60_000) : 30_000;
    const cwd = session.workingDir || getProjectCwd();
    const startTime = Date.now();
    let output: string;
    let exitCode: number;
    try {
      output = execSync(command, {
        cwd,
        encoding: 'utf-8',
        timeout,
        maxBuffer: 5 * 1024 * 1024,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...filterSecretEnvVars(process.env), ...session.env },
      });
      exitCode = 0;
    } catch (err) {
      const e = err as ExecError;
      output = (e.stdout?.toString() || '') + (e.stderr ? `\n[stderr] ${e.stderr.toString()}` : '');
      exitCode = e.status ?? 1;
    }
    const duration = Date.now() - startTime;
    const timestamp = new Date().toISOString();
    // Record in history (cap output size and total entries to prevent unbounded growth)
    const MAX_OUTPUT_BYTES = 64 * 1024;
    const MAX_HISTORY = 200;
    const truncatedOutput =
      output.length > MAX_OUTPUT_BYTES
        ? `${output.slice(0, MAX_OUTPUT_BYTES)}\n[... truncated ...]`
        : output;
    session.history.push({ command, output: truncatedOutput, timestamp, exitCode });
    if (session.history.length > MAX_HISTORY) {
      session.history.splice(0, session.history.length - MAX_HISTORY);
    }
    session.lastActivity = timestamp;
    session.status = 'active';
    saveTerminalStore(store);
    return {
      success: exitCode === 0,
      sessionId: session.id,
      command,
      output,
      exitCode,
      executedAt: timestamp,
      duration,
    };
  },
};
