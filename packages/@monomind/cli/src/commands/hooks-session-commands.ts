import { callMCPTool, MCPClientError } from '../mcp-client.js';
import { output } from '../output.js';
import type { Command, CommandContext, CommandResult } from '../types.js';

// Session-end subcommand
export const sessionEndCommand: Command = {
  name: 'session-end',
  description: 'End current session and persist state',
  options: [
    {
      name: 'save-state',
      short: 's',
      description: 'Save session state for later restoration',
      type: 'boolean',
      default: true,
    },
  ],
  examples: [
    { command: 'monomind hooks session-end', description: 'End and save session' },
    { command: 'monomind hooks session-end --save-state false', description: 'End without saving' },
  ],
  action: async (ctx: CommandContext): Promise<CommandResult> => {
    output.printInfo('Ending session...');

    try {
      const result = await callMCPTool<{
        sessionId: string;
        sessionPersistence: { controller: string; persisted: boolean };
        summary: {
          tasksExecuted: number;
          agentsSpawned: number;
          pendingInsights: number;
          memoryEntries: number;
        };
        learningUpdates: { patternsLearned: number; trajectoriesRecorded: number };
        kgNudge?: { empty: boolean; prompt?: string };
      }>('hooks_session-end', {
        saveState: ctx.flags['save-state'] ?? true,
        timestamp: Date.now(),
      });

      if (ctx.flags.format === 'json') {
        output.printJson(result);
        return { success: true, data: result };
      }

      output.writeln();
      output.printSuccess(`Session ${result.sessionId} ended`);

      output.writeln();
      output.writeln(output.bold('Session Summary'));
      output.printTable({
        columns: [
          { key: 'metric', header: 'Metric', width: 25 },
          { key: 'value', header: 'Value', width: 15, align: 'right' },
        ],
        data: [
          { metric: 'Tasks Executed', value: result.summary.tasksExecuted },
          { metric: 'Agents Spawned', value: result.summary.agentsSpawned },
          { metric: 'Patterns Learned', value: result.learningUpdates.patternsLearned },
          { metric: 'Trajectories Recorded', value: result.learningUpdates.trajectoriesRecorded },
          { metric: 'Pending Insights', value: result.summary.pendingInsights },
          { metric: 'Memory Entries', value: result.summary.memoryEntries },
        ],
      });

      output.writeln();
      output.writeln(
        output.dim(
          `Session state: ${result.sessionPersistence.persisted ? `saved (${result.sessionPersistence.controller})` : 'not saved'}`,
        ),
      );

      if (result.kgNudge?.empty && result.kgNudge.prompt) {
        output.writeln();
        output.printWarning('Knowledge Graph nudge:');
        for (const line of result.kgNudge.prompt.split('\n')) {
          output.writeln(`  ${line}`);
        }
      }

      return { success: true, data: result };
    } catch (error) {
      if (error instanceof MCPClientError) {
        output.printError(`Session-end hook failed: ${error.message}`);
      } else {
        output.printError(`Unexpected error: ${String(error)}`);
      }
      return { success: false, exitCode: 1 };
    }
  },
};

// Session-restore subcommand
export const sessionRestoreCommand: Command = {
  name: 'session-restore',
  description: 'Restore a previous session',
  options: [
    {
      name: 'session-id',
      short: 'i',
      description: 'Session ID to restore (use "latest" for most recent)',
      type: 'string',
      default: 'latest',
    },
    {
      name: 'restore-agents',
      short: 'a',
      description: 'Restore spawned agents',
      type: 'boolean',
      default: true,
    },
    {
      name: 'restore-tasks',
      short: 't',
      description: 'Restore active tasks',
      type: 'boolean',
      default: true,
    },
  ],
  examples: [
    { command: 'monomind hooks session-restore', description: 'Restore latest session' },
    {
      command: 'monomind hooks session-restore -i session-12345',
      description: 'Restore specific session',
    },
  ],
  action: async (ctx: CommandContext): Promise<CommandResult> => {
    const sessionId = ctx.args[0] || (ctx.flags['session-id'] as string) || 'latest';

    output.printInfo(`Restoring session: ${output.highlight(sessionId)}`);

    try {
      const result = await callMCPTool<{
        sessionId: string;
        originalSessionId: string;
        restoredState: {
          tasksRestored: number;
          agentsRestored: number;
          memoryBridgeInitialized: boolean;
        };
        warnings?: string[];
      }>('hooks_session-restore', {
        sessionId,
        restoreAgents: ctx.flags['restore-agents'] ?? true,
        restoreTasks: ctx.flags['restore-tasks'] ?? true,
        timestamp: Date.now(),
      });

      if (ctx.flags.format === 'json') {
        output.printJson(result);
        return { success: true, data: result };
      }

      output.writeln();
      output.printSuccess(`Session restored from ${result.originalSessionId}`);
      output.writeln(output.dim(`New session ID: ${result.sessionId}`));

      output.writeln();
      output.writeln(output.bold('Restored State'));
      output.printTable({
        columns: [
          { key: 'item', header: 'Item', width: 25 },
          { key: 'count', header: 'Count', width: 15, align: 'right' },
        ],
        data: [
          { item: 'Tasks', count: result.restoredState.tasksRestored },
          { item: 'Agents', count: result.restoredState.agentsRestored },
          {
            item: 'Memory Bridge',
            count: result.restoredState.memoryBridgeInitialized ? 'ready' : 'unavailable',
          },
        ],
      });

      if (result.warnings && result.warnings.length > 0) {
        output.writeln();
        output.writeln(output.bold(output.warning('Warnings')));
        output.printList(result.warnings.map((w) => output.warning(w)));
      }

      return { success: true, data: result };
    } catch (error) {
      if (error instanceof MCPClientError) {
        output.printError(`Session-restore hook failed: ${error.message}`);
      } else {
        output.printError(`Unexpected error: ${String(error)}`);
      }
      return { success: false, exitCode: 1 };
    }
  },
};
