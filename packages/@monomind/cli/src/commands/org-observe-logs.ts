// packages/@monomind/cli/src/commands/org-observe-logs.ts
//
// `monomind org logs | watch | events` — formatted, per-role and NDJSON
// tails of a run's bus events.

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { formatEvent } from '../orgrt/reporting.js';
import { type BusEvent, ORG_DIR } from '../orgrt/types.js';
import { output } from '../output.js';
import type { CommandContext, CommandResult } from '../types.js';
import { orgJson, printOrgJson, resolveRun } from './org-observe-shared.js';

const log = (text: string): void => {
  console.log(text);
};

/** `org logs <name> [--run id] [--role r] [--filter-tool t] [--filter-role r] [--tools-only] [--audit-filter allow|deny] [--follow]` — formatted bus.jsonl tail. */
export const logsAction = async (ctx: CommandContext, name: string): Promise<CommandResult> => {
  const run = resolveRun(ctx.cwd, name, ctx.flags.run);
  if (!run)
    return {
      success: false,
      message: `no runs found for org ${name} — start one with: monomind org run ${name}`,
    };
  const file = join(ctx.cwd, ORG_DIR, name, run, 'bus.jsonl');
  const roleFilter = typeof ctx.flags.role === 'string' ? ctx.flags.role : null;
  const filterTool = typeof ctx.flags['filter-tool'] === 'string' ? ctx.flags['filter-tool'] : null;
  const filterRole = typeof ctx.flags['filter-role'] === 'string' ? ctx.flags['filter-role'] : null;
  const auditFilter =
    typeof ctx.flags['audit-filter'] === 'string' ? ctx.flags['audit-filter'] : null;
  const toolsOnly = ctx.flags['tools-only'] === true;
  // Protocol JSON mode: full filtered event array, no live tail (§7.2 — the
  // streaming form is `org events --ndjson --follow`).
  if (orgJson(ctx)) {
    if (ctx.flags.follow === true)
      return { success: false, message: 'json output cannot --follow — use: org events --ndjson' };
    const items: BusEvent[] = [];
    const accept = (e: BusEvent): boolean =>
      (!toolsOnly || e.type === 'tool') &&
      (!roleFilter || e.from === roleFilter || e.to === roleFilter) &&
      (!filterTool || e.tool === filterTool) &&
      (!filterRole || e.from === filterRole) &&
      (!auditFilter || e.type !== 'tool' || e.decision === auditFilter);
    if (existsSync(file)) {
      for (const line of readFileSync(file, 'utf8').split('\n').filter(Boolean)) {
        try {
          const e = JSON.parse(line) as BusEvent;
          if (accept(e)) items.push(e);
        } catch {
          /* skip corrupt interior lines — same policy as the tail drain */
        }
      }
    }
    return printOrgJson({ v: 1, org: name, run, items });
  }
  const show = (e: BusEvent): void => {
    if (toolsOnly && e.type !== 'tool') return;
    if (roleFilter && e.from !== roleFilter && e.to !== roleFilter) return;
    if (filterTool && e.tool !== filterTool) return;
    if (filterRole && e.from !== filterRole) return;
    if (auditFilter && e.type === 'tool' && e.decision !== auditFilter) return;
    log(formatEvent(e));
  };
  log(
    output.info(
      `org ${name} — ${run}${roleFilter ? ` (role: ${roleFilter})` : ''}${filterTool ? ` (tool: ${filterTool})` : ''}${filterRole ? ` (filter-role: ${filterRole})` : ''}${auditFilter ? ` (audit-filter: ${auditFilter})` : ''}`,
    ),
  );
  let seenLines = 0;
  const drain = (): void => {
    if (!existsSync(file)) return;
    const lines = readFileSync(file, 'utf8').split('\n').filter(Boolean);
    for (let i = seenLines; i < lines.length; i++) {
      try {
        show(JSON.parse(lines[i]) as BusEvent);
        seenLines = i + 1;
      } catch {
        // Only the FINAL line can be a partial mid-append write worth
        // retrying; a corrupt interior line would otherwise stall the tail
        // forever — skip it and keep going.
        if (i === lines.length - 1) break;
        seenLines = i + 1;
      }
    }
  };
  drain();
  if (ctx.flags.follow !== true) return { success: true };
  log(output.info('following — Ctrl-C to stop'));
  await new Promise<void>((resolve) => {
    const iv = setInterval(drain, 500);
    process.once('SIGINT', () => {
      clearInterval(iv);
      resolve();
    });
    process.once('SIGTERM', () => {
      clearInterval(iv);
      resolve();
    });
  });
  return { success: true };
};

/**
 * `org watch <name> <role> [--verbose] [--stats]` — live-tail one role's
 * assistant chat text.
 *
 * Every runner (Claude included — this isn't specific to the subprocess CLI
 * runners) funnels through session.ts's shared message loop, which emits
 * each assistant-text chunk onto the bus as a `chat` event. This command is
 * just `logsAction` pre-filtered to that event type + role and formatted as
 * a plain transcript instead of the full annotated event line — a friendlier
 * front door onto infrastructure that already exists and already covers
 * every runtime uniformly. For the fuller event stream (tool calls, audit
 * decisions) use `org logs <name> --role <role> --follow` directly.
 *
 * --verbose additionally interleaves that role's `status` events (session
 * start/end, restart/crash/backoff, state changes) into the transcript, so
 * a human watching sees WHY a role went quiet instead of just silence.
 * --stats prints a running token/cost line off that role's `usage` events
 * (emitted per turn by session.ts, same as --verbose: already-existing bus
 * data, no new instrumentation).
 */
export const watchAction = async (ctx: CommandContext, name: string): Promise<CommandResult> => {
  const role = ctx.args[1];
  if (!role) return { success: false, message: 'usage: monomind org watch <org> <role>' };
  const run = resolveRun(ctx.cwd, name, ctx.flags.run);
  if (!run)
    return {
      success: false,
      message: `no runs found for org ${name} — start one with: monomind org run ${name}`,
    };
  const file = join(ctx.cwd, ORG_DIR, name, run, 'bus.jsonl');
  const verbose = ctx.flags.verbose === true;
  const stats = ctx.flags.stats === true;

  let totalTokens = 0;
  let totalCostUsd = 0;

  const show = (e: BusEvent): void => {
    if (e.from !== role) return;
    if (e.type === 'chat') {
      log(`${output.info(`${role}:`)} ${e.msg ?? ''}`);
      return;
    }
    if (verbose && e.type === 'status') {
      log(output.warning(`[${e.reason ?? 'status'}] ${e.msg ?? ''}`));
      return;
    }
    if (stats && e.type === 'usage') {
      const tokens = typeof e.data?.tokens === 'number' ? e.data.tokens : 0;
      const costDelta = typeof e.data?.cost_usd === 'number' ? e.data.cost_usd : 0;
      totalTokens += tokens;
      totalCostUsd += costDelta;
      log(
        output.info(
          `[stats] +${tokens} tokens (total ${totalTokens}) · +$${costDelta.toFixed(4)} (total $${totalCostUsd.toFixed(4)})`,
        ),
      );
    }
  };
  log(
    output.info(
      `watching ${name}/${role} — ${run} (Ctrl-C to stop; org logs ${name} --role ${role} --follow for the full event stream)`,
    ),
  );
  let seenLines = 0;
  const drain = (): void => {
    if (!existsSync(file)) return;
    const lines = readFileSync(file, 'utf8').split('\n').filter(Boolean);
    for (let i = seenLines; i < lines.length; i++) {
      try {
        show(JSON.parse(lines[i]) as BusEvent);
        seenLines = i + 1;
      } catch {
        if (i === lines.length - 1) break; // only the final line may be a mid-append partial write
        seenLines = i + 1;
      }
    }
  };
  drain();
  if (ctx.flags.follow === false) return { success: true }; // --follow=false opts out of the default live tail
  await new Promise<void>((resolve) => {
    const iv = setInterval(drain, 500);
    process.once('SIGINT', () => {
      clearInterval(iv);
      resolve();
    });
    process.once('SIGTERM', () => {
      clearInterval(iv);
      resolve();
    });
  });
  return { success: true };
};

// ─── org events — the only genuinely new org command (plan D12) ─────────────

/** Resolve a `--since` cursor: an event id (skip everything at/before it) or
 *  an ISO-8601 timestamp (skip older events). Returns null when unusable. */
function parseSinceCursor(raw: unknown): { id?: string; iso?: string } | null {
  if (typeof raw !== 'string' || !raw) return null;
  if (/^run-[A-Za-z0-9-]+/.test(raw)) return { id: raw };
  const ts = Date.parse(raw);
  return Number.isFinite(ts) ? { iso: raw } : null;
}

/** `org events <name> [--run id] [--follow] [--since <eventId|iso>] [--ndjson]`
 *  — live tail of a run's bus.jsonl as NDJSON, one BusEvent per line
 *  (protocol §7.3). This is the machine streaming surface; `org logs` stays
 *  the human one. NDJSON is the only output mode (--ndjson accepted for
 *  spec symmetry). */
export const eventsAction = async (ctx: CommandContext, name: string): Promise<CommandResult> => {
  const run = resolveRun(ctx.cwd, name, ctx.flags.run);
  if (!run)
    return {
      success: false,
      message: `no runs found for org ${name} — start one with: monomind org run ${name}`,
    };
  const file = join(ctx.cwd, ORG_DIR, name, run, 'bus.jsonl');
  const since = parseSinceCursor(ctx.flags.since);

  let skippedPastId = !since?.id; // true = no id cursor, nothing to skip
  let seenLines = 0;
  const emitLine = (line: string): void => {
    let e: BusEvent;
    try {
      e = JSON.parse(line) as BusEvent;
    } catch {
      return; // corrupt interior line — skip, same policy as logsAction
    }
    if (since?.id) {
      if (!skippedPastId) {
        if (e.id === since.id) skippedPastId = true;
        return; // everything strictly before the cursor is replay-suppressed
      }
    }
    if (since?.iso && Date.parse(since.iso) && new Date(e.ts).getTime() < Date.parse(since.iso))
      return;
    process.stdout.write(`${JSON.stringify(e)}\n`);
  };

  const drain = (): void => {
    if (!existsSync(file)) return;
    const lines = readFileSync(file, 'utf8').split('\n').filter(Boolean);
    for (let i = seenLines; i < lines.length; i++) {
      // Only the FINAL line can be a partial mid-append write worth retrying.
      if (i === lines.length - 1) {
        try {
          JSON.parse(lines[i]);
        } catch {
          break;
        }
      }
      emitLine(lines[i]);
      seenLines = i + 1;
    }
  };
  drain();
  if (ctx.flags.follow !== true) return { success: true };
  await new Promise<void>((resolve) => {
    const iv = setInterval(drain, 500);
    process.once('SIGINT', () => {
      clearInterval(iv);
      resolve();
    });
    process.once('SIGTERM', () => {
      clearInterval(iv);
      resolve();
    });
  });
  return { success: true };
};
