/**
 * Hooks MCP Tools — pre/post edit and pre/post command.
 * Extracted from hooks-routing.ts.
 */

import { existsSync, mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { recordCommand } from '../monovector/command-outcomes.js';
import { validateMcpString } from '../utils/input-guards.js';
import {
  assessCommandRisk,
  getFileExtension,
  getMemoryPath,
  getRouteOutcomesBaseDir,
  loadMemoryStore,
  MEMORY_DIR,
  suggestAgentsForFile,
} from './hooks-embedding.js';
import { getProjectCwd, type MCPTool } from './types.js';

// MCP Tool implementations - return raw data for direct CLI use
export const hooksPreEdit: MCPTool = {
  name: 'hooks_pre-edit',
  description: 'Get context and agent suggestions before editing a file',
  inputSchema: {
    type: 'object',
    properties: {
      filePath: { type: 'string', description: 'Path to the file being edited' },
      operation: {
        type: 'string',
        description: 'Type of operation (create, update, delete, refactor)',
      },
      context: { type: 'string', description: 'Additional context' },
    },
    required: ['filePath'],
  },
  handler: async (params: Record<string, unknown>) => {
    // Cap filePath: passed to suggestAgentsForFile (O(n) regex) and reflected in
    // response.  Cap operation to prevent oversized strings in recommendations.
    const MAX_PRE_EDIT_PATH_LEN = 4 * 1024;
    const MAX_PRE_EDIT_OP_LEN = 64;
    const filePath = validateMcpString(params.filePath, 'filePath', MAX_PRE_EDIT_PATH_LEN);
    if (!filePath) {
      return { error: 'filePath is required (non-empty string, no control chars, max 4KB)' };
    }
    const operation =
      validateMcpString(params.operation, 'operation', MAX_PRE_EDIT_OP_LEN) ?? 'update';

    const suggestedAgents = suggestAgentsForFile(filePath);
    const ext = getFileExtension(filePath);

    return {
      filePath,
      operation,
      context: {
        fileExists: existsSync(resolve(getProjectCwd(), filePath)),
        fileType: ext || 'unknown',
        suggestedAgents,
        risks: operation === 'delete' ? ['File deletion is irreversible'] : [],
      },
      recommendations: [
        `Recommended agents: ${suggestedAgents.join(', ')}`,
        'Run tests after changes',
      ],
    };
  },
};

export const hooksPostEdit: MCPTool = {
  name: 'hooks_post-edit',
  description: 'Record editing outcome for learning',
  inputSchema: {
    type: 'object',
    properties: {
      filePath: { type: 'string', description: 'Path to the edited file' },
      success: { type: 'boolean', description: 'Whether the edit was successful' },
      agent: { type: 'string', description: 'Agent that performed the edit' },
    },
    required: ['filePath'],
  },
  handler: async (params: Record<string, unknown>) => {
    // Cap filePath: interpolated into taskId and task text forwarded to
    // bridgeRecordFeedback (which calls generateEmbedding — O(n) hash fallback).
    // Cap agent: stored in feedback record and forwarded to bridge.
    const MAX_POST_EDIT_PATH_LEN = 4 * 1024;
    const MAX_POST_EDIT_AGENT_LEN = 256;
    const filePath = validateMcpString(params.filePath, 'filePath', MAX_POST_EDIT_PATH_LEN);
    if (!filePath) {
      return { error: 'filePath is required (non-empty string, no control chars, max 4KB)' };
    }
    const success = params.success !== false;
    const agent = validateMcpString(params.agent, 'agent', MAX_POST_EDIT_AGENT_LEN) ?? undefined;

    // Wire recordFeedback through bridge (issue #1209)
    let feedbackResult: { success: boolean; id?: string; error?: string } | null = null;
    try {
      const bridge = await import('../memory/memory-bridge.js');
      feedbackResult = await bridge.bridgeRecordFeedback({
        taskType: agent ?? 'coder',
        action: `edit ${filePath}`,
        outcome: success ? 'success' : 'failure',
        confidence: success ? 0.85 : 0.3,
      });
    } catch (e) {
      // Bridge not available — continue with basic response
      if (process.env.DEBUG || process.env.MONOMIND_DEBUG)
        console.error('[hooks-post-edit] memory bridge feedback failed:', e);
    }

    return {
      // The feedback record is the only write this hook makes.
      recorded: feedbackResult?.success === true,
      filePath,
      success,
      timestamp: new Date().toISOString(),
      feedback: feedbackResult
        ? {
            recorded: feedbackResult.success,
            controller: feedbackResult.success ? 'sqlite' : 'unavailable',
            updates: feedbackResult.success ? 1 : 0,
          }
        : { recorded: false, controller: 'unavailable', updates: 0 },
    };
  },
};

export const hooksPreCommand: MCPTool = {
  name: 'hooks_pre-command',
  description: 'Assess risk before executing a command',
  inputSchema: {
    type: 'object',
    properties: {
      command: { type: 'string', description: 'Command to execute' },
    },
    required: ['command'],
  },
  handler: async (params: Record<string, unknown>) => {
    // Cap command length: assessCommandRisk runs O(n) string searches, and the
    // raw command is reflected verbatim in the response.  Limit to 4 KB which
    // is far beyond any realistic shell command.
    const MAX_CMD_LEN = 4 * 1024;
    const command = validateMcpString(params.command, 'command', MAX_CMD_LEN);
    if (!command) {
      return { error: 'command is required (non-empty string, no control chars, max 4KB)' };
    }
    const assessment = assessCommandRisk(command);

    const riskLevel =
      assessment.level >= 0.8
        ? 'critical'
        : assessment.level >= 0.6
          ? 'high'
          : assessment.level >= 0.3
            ? 'medium'
            : 'low';

    return {
      command,
      riskLevel,
      risks: assessment.warnings.map((warning, i) => ({
        type: `risk-${i + 1}`,
        severity: assessment.level >= 0.6 ? 'high' : 'medium',
        description: warning,
      })),
      recommendations:
        assessment.warnings.length > 0
          ? ['Review warnings before proceeding', 'Consider using safer alternative']
          : ['Command appears safe to execute'],
      safeAlternatives: [],
      shouldProceed: assessment.level < 0.7,
    };
  },
};

export const hooksPostCommand: MCPTool = {
  name: 'hooks_post-command',
  description: 'Record command execution outcome',
  inputSchema: {
    type: 'object',
    properties: {
      command: { type: 'string', description: 'Executed command' },
      exitCode: { type: 'number', description: 'Command exit code' },
      success: {
        type: 'boolean',
        description:
          'Whether the command succeeded. false records a failure even with exit code 0; a non-zero exit code is always a failure.',
      },
    },
    required: ['command'],
  },
  handler: async (params: Record<string, unknown>) => {
    // Cap command: it is stored in JSON memory store (line 824), forwarded to
    // bridgeStoreEntry which calls generateEmbedding by default — O(n) hash
    // fallback, and reflected verbatim in the response.  The recordCommand path
    // already caps to 200 chars; apply a consistent 4 KB cap here that still
    // covers any realistic shell command.
    const MAX_POST_CMD_LEN = 4 * 1024;
    const command = validateMcpString(params.command, 'command', MAX_POST_CMD_LEN);
    if (!command) {
      return { error: 'command is required (non-empty string, no control chars, max 4KB)' };
    }
    const exitCode =
      typeof params.exitCode === 'number' && Number.isFinite(params.exitCode)
        ? Math.floor(params.exitCode)
        : 0;
    // An explicit success: false wins over a 0 exit code (e.g. a command that
    // exited 0 but printed errors); a non-zero exit code is always a failure.
    const success = exitCode === 0 && params.success !== false;

    // Record the real exit code in the time-windowed command-outcome store so
    // post-task can derive a MEASURED success signal (grounded in actual exit
    // codes) when the caller does not explicitly assert --success. Non-fatal.
    await recordCommand(getRouteOutcomesBaseDir(), {
      ts: Date.now(),
      command: typeof command === 'string' ? command.slice(0, 200) : String(command).slice(0, 200),
      exitCode,
      success,
    });

    // Persist command outcome via memory backend
    let _storedIn: 'sqlite' | 'json-store' | 'none' = 'none';
    try {
      const bridge = await import('../memory/memory-bridge.js');
      const stored = await bridge.bridgeStoreEntry({
        key: `cmd-${Date.now()}`,
        value: JSON.stringify({ command, exitCode, success }),
        namespace: 'commands',
        tags: [success ? 'success' : 'error'],
      });
      // #293: bridgeStoreEntry RETURNS null when the backend cannot be loaded,
      // it does not throw. Claiming `_storedIn = 'sqlite'` on that return
      // reported `recorded: true` for a write that never happened AND skipped
      // the JSON fallback below, so the record was lost twice over.
      if (!stored?.success) throw new Error(stored?.error ?? 'memory backend unavailable');
      _storedIn = 'sqlite';
    } catch {
      // memory backend unavailable or refused the write — store in JSON
      try {
        const store = loadMemoryStore();
        const key = `cmd-${Date.now()}`;
        store.entries[key] = {
          key,
          value: JSON.stringify({ command, exitCode, success }),
          namespace: 'commands',
          createdAt: new Date().toISOString(),
        } as any;
        const memDir = join(getProjectCwd(), MEMORY_DIR);
        if (!existsSync(memDir)) mkdirSync(memDir, { recursive: true });
        const _mp = getMemoryPath();
        const _mptmp = `${_mp}.tmp`;
        writeFileSync(_mptmp, JSON.stringify(store, null, 2), 'utf-8');
        renameSync(_mptmp, _mp);
        _storedIn = 'json-store';
      } catch {
        /* non-critical */
      }
    }

    return {
      recorded: _storedIn !== 'none',
      command,
      exitCode,
      success,
      timestamp: new Date().toISOString(),
      _storedIn,
    };
  },
};
