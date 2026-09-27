import { output } from '../output.js';
import type { Command, CommandContext, CommandResult } from '../types.js';
import { formatDate, formatDuration } from './session-shared.js';

// Replay subcommand (session replay and inspection, merged from `replay` command)
const replayShowCommand: Command = {
  name: 'show',
  description: 'Show replay for a session',
  options: [{ name: 'json', type: 'boolean', description: 'Output as JSON', default: false }],
  action: async (ctx: CommandContext): Promise<CommandResult> => {
    // Cap session ID to prevent DoS via oversized string and unbounded output reflection.
    const sessionId = (ctx.args[0] || '').slice(0, 128);
    if (!sessionId) {
      output.printError('Session ID is required: session replay show <sessionId>');
      return { success: false, message: 'Missing session ID' };
    }

    try {
      const { ReplayReader } = await import('../observability/replay-reader.js');
      const reader = new ReplayReader();
      const data = await reader.show(sessionId);
      if (!data) {
        output.writeln(`No replay data for session ${sessionId}`);
        return { success: true, message: 'No replay data' };
      }

      if (ctx.flags.json as boolean) {
        output.writeln(JSON.stringify(data, null, 2));
        return { success: true, data };
      }

      // Human-readable summary derived from the session replay data
      const started = new Date(data.startedAt);
      const ended = data.endedAt ? new Date(data.endedAt) : null;
      const duration =
        ended && !Number.isNaN(started.getTime()) && !Number.isNaN(ended.getTime())
          ? formatDuration(ended.getTime() - started.getTime())
          : 'in progress';

      output.writeln();
      output.writeln(output.bold(`Replay: ${data.id}`));
      output.writeln();
      output.printTable({
        columns: [
          { key: 'property', header: 'Property', width: 18 },
          { key: 'value', header: 'Value', width: 45 },
        ],
        data: [
          {
            property: 'Started',
            value: Number.isNaN(started.getTime()) ? data.startedAt : started.toLocaleString(),
          },
          { property: 'Ended', value: ended ? ended.toLocaleString() : '-' },
          { property: 'Duration', value: duration },
          { property: 'Tasks', value: data.taskCount != null ? String(data.taskCount) : '-' },
          {
            property: 'Tokens',
            value: data.tokenUsage?.total != null ? String(data.tokenUsage.total) : '-',
          },
          { property: 'File', value: data.filePath },
        ],
      });

      // Key steps: surface recorded metrics from the raw session data if present
      const metrics = data.raw?.metrics;
      if (metrics && typeof metrics === 'object') {
        const entries = Object.entries(metrics as Record<string, unknown>).filter(
          ([, v]) => typeof v === 'number' || typeof v === 'string',
        );
        if (entries.length > 0) {
          output.writeln();
          output.writeln(output.bold('Metrics'));
          output.printList(entries.map(([k, v]) => `${k}: ${String(v)}`));
        }
      }

      return { success: true, data };
    } catch {
      output.writeln(`No replay data for session ${sessionId}`);
      return { success: true, message: 'No replay data' };
    }
  },
};

const replayListCommand: Command = {
  name: 'list',
  description: 'List available session replays',
  options: [
    { name: 'limit', short: 'n', type: 'number', description: 'Max entries', default: 20 },
    { name: 'json', type: 'boolean', description: 'Output as JSON', default: false },
  ],
  action: async (ctx: CommandContext): Promise<CommandResult> => {
    try {
      const { ReplayReader } = await import('../observability/replay-reader.js');
      const reader = new ReplayReader();
      const rawLimit = ctx.flags.limit as number;
      // Cap limit to prevent DoS
      const limit =
        typeof rawLimit === 'number' && Number.isFinite(rawLimit)
          ? Math.max(1, Math.min(Math.floor(rawLimit), 500))
          : 20;
      const data = await reader.list(limit);

      if (ctx.flags.json as boolean) {
        output.writeln(JSON.stringify(data, null, 2));
        return { success: true, data };
      }

      if (data.length === 0) {
        output.writeln('No replay sessions available');
        return { success: true, data };
      }

      output.writeln();
      output.writeln(output.bold(`Session Replays (${data.length})`));
      output.writeln();
      output.printTable({
        columns: [
          { key: 'id', header: 'ID', width: 26 },
          { key: 'started', header: 'Started', width: 20 },
          { key: 'ended', header: 'Ended', width: 20 },
          { key: 'tasks', header: 'Tasks', width: 8, align: 'right' },
        ],
        data: data.map((s) => ({
          id: s.id,
          started: formatDate(s.startedAt),
          ended: s.endedAt ? formatDate(s.endedAt) : '-',
          tasks: s.taskCount != null ? String(s.taskCount) : '-',
        })),
      });
      output.writeln();
      output.printInfo('Show details with: monomind session replay show <sessionId>');

      return { success: true, data };
    } catch {
      output.writeln('No replay sessions available');
      return { success: true, message: 'No sessions' };
    }
  },
};

export const replayCommand: Command = {
  name: 'replay',
  description: 'Session replay and inspection',
  subcommands: [replayShowCommand, replayListCommand],
  action: async (): Promise<CommandResult> => {
    output.writeln();
    output.writeln(output.bold('Session Replay'));
    output.writeln();
    output.writeln('Usage: monomind session replay <show|list> [options]');
    output.printList([
      `${output.highlight('show <sessionId>')} - Show replay for a session`,
      `${output.highlight('list')}             - List available session replays`,
    ]);
    return { success: true };
  },
};
