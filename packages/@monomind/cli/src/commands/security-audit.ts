import { output } from '../output.js';
import {
  type AuditEvent,
  clearAuditLog,
  filterAuditEvents,
  readAuditEvents,
  resolveAuditLogPaths,
} from '../security/audit-log.js';
import type { Command, CommandContext, CommandResult } from '../types.js';

// ─── audit subcommand ────────────────────────────────────────────────────────

const printAuditTable = (events: AuditEvent[], limit: number): void => {
  if (events.length === 0) {
    output.writeln(output.dim('No audit events found.'));
    return;
  }
  output.printTable({
    columns: [
      { key: 'timestamp', header: 'Timestamp', width: 22 },
      { key: 'source', header: 'Source', width: 18 },
      { key: 'decision', header: 'Decision', width: 10 },
      { key: 'tool', header: 'Tool', width: 10 },
      { key: 'reason', header: 'Reason', width: 40 },
    ],
    // most-recent-first for display, oldest-first on disk
    data: [...events]
      .reverse()
      .slice(0, limit)
      .map((e) => ({
        timestamp: e.timestamp,
        source: e.source,
        decision: e.decision,
        tool: e.tool ?? '',
        reason: (e.reason ?? '').slice(0, 80),
      })),
  });
};

export const auditCommand: Command = {
  name: 'audit',
  description: 'Security audit logging and compliance',
  options: [
    {
      name: 'action',
      short: 'a',
      type: 'string',
      description: 'Action: list, log, export, clear',
      default: 'list',
    },
    {
      name: 'limit',
      short: 'l',
      type: 'number',
      description: 'Number of entries to show',
      default: '20',
    },
    {
      name: 'filter',
      short: 'f',
      type: 'string',
      description: 'Filter by source/decision/tool/reason (substring, case-insensitive)',
    },
    {
      name: 'follow',
      type: 'boolean',
      description: 'With --action log: keep tailing new events until Ctrl-C',
    },
    {
      name: 'output',
      short: 'o',
      type: 'string',
      description: 'With --action export: output file path (required)',
    },
  ],
  examples: [
    { command: 'monomind security audit --action list', description: 'List recent audit events' },
    {
      command: 'monomind security audit --action log --follow',
      description: 'Tail audit events as they happen',
    },
    {
      command: 'monomind security audit --action export -o ./audit.jsonl',
      description: 'Export the full audit trail',
    },
    {
      command: 'monomind security audit --action clear',
      description: 'Archive and truncate the audit trail',
    },
    {
      command: 'monomind security audit --filter secrets',
      description: 'Only secret-detection gate events',
    },
  ],
  action: async (ctx: CommandContext): Promise<CommandResult> => {
    const requestedAction = (ctx.flags.action as string) || 'list';
    const eventFilter = (ctx.flags.filter as string)?.trim();
    const cwd = ctx.cwd;

    if (requestedAction === 'clear') {
      const { archived, cleared } = clearAuditLog(cwd);
      if (!archived) {
        output.writeln(output.dim('No audit log to clear.'));
        return { success: true, data: { cleared: 0 } };
      }
      output.printSuccess(`Archived ${cleared} event(s) to ${archived} and cleared the audit log.`);
      return { success: true, data: { cleared, archived } };
    }

    if (requestedAction === 'export') {
      const outputPath = ctx.flags.output as string;
      if (!outputPath) {
        output.printError('--output/-o is required for --action export');
        return { success: false, exitCode: 1 };
      }
      const events = filterAuditEvents(readAuditEvents(cwd), eventFilter);
      const { writeFileSync } = await import('node:fs');
      writeFileSync(
        outputPath,
        events.map((e) => JSON.stringify(e)).join('\n') + (events.length ? '\n' : ''),
        'utf-8',
      );
      output.printSuccess(`Exported ${events.length} event(s) to ${outputPath}`);
      return { success: true, data: { written: events.length, outputPath } };
    }

    if (requestedAction === 'log') {
      const { file } = resolveAuditLogPaths(cwd);
      output.writeln(
        output.info(`audit log: ${file}${eventFilter ? ` (filter: ${eventFilter})` : ''}`),
      );
      const { existsSync, readFileSync } = await import('node:fs');
      let seenLines = 0;
      const drain = (): void => {
        if (!existsSync(file)) return;
        const lines = readFileSync(file, 'utf8').split('\n').filter(Boolean);
        for (let i = seenLines; i < lines.length; i++) {
          seenLines = i + 1;
          try {
            const evt = JSON.parse(lines[i]) as AuditEvent;
            if (filterAuditEvents([evt], eventFilter).length === 0) continue;
            output.writeln(
              `${evt.timestamp}  ${evt.source}  ${evt.decision}${evt.tool ? `  ${evt.tool}` : ''}  ${evt.reason ?? ''}`,
            );
          } catch {
            /* skip malformed line */
          }
        }
      };
      drain();
      if (ctx.flags.follow !== true) return { success: true };
      output.writeln(output.dim('following — Ctrl-C to stop'));
      await new Promise<void>((resolveWait) => {
        const iv = setInterval(drain, 500);
        process.once('SIGINT', () => {
          clearInterval(iv);
          resolveWait();
        });
        process.once('SIGTERM', () => {
          clearInterval(iv);
          resolveWait();
        });
      });
      return { success: true };
    }

    if (requestedAction !== 'list') {
      output.writeln();
      output.writeln(
        output.error(
          `security audit --action ${requestedAction} is not recognized. Use one of: list, log, export, clear.`,
        ),
      );
      return { success: false, message: `Unsupported action: ${requestedAction}`, exitCode: 1 };
    }

    output.writeln();
    output.writeln(output.bold('Security audit events'));
    output.writeln(output.dim('─'.repeat(60)));

    const events = readAuditEvents(cwd);
    const visibleEvents = filterAuditEvents(events, eventFilter);

    if (eventFilter && visibleEvents.length === 0) {
      const seen = [...new Set(events.map((e) => e.source))].sort();
      output.writeln(output.warning(`No audit events match "${eventFilter}".`));
      output.writeln(output.dim(`Sources present: ${seen.join(', ') || 'none'}`));
      return { success: true, data: { entries: [], filter: eventFilter } };
    }

    printAuditTable(visibleEvents, parseInt((ctx.flags.limit as string) || '20', 10));
    if (events.length === 0) {
      output.writeln(output.dim('No security gate has blocked anything yet in this project.'));
    }

    return { success: true, data: { entries: visibleEvents } };
  },
};
