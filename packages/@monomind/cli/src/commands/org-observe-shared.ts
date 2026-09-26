// packages/@monomind/cli/src/commands/org-observe-shared.ts
//
// Helpers shared by the org observe subcommand modules: protocol JSON output,
// the --by resolver flag, endpoint-role ids and --run resolution.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { listRunDirs } from '../orgrt/reporting.js';
import { ORG_DIR } from '../orgrt/types.js';
import type { CommandContext, CommandResult } from '../types.js';

// ─── Agent Exec Protocol JSON output (doc/agent-exec-protocol.md §7) ────────
// Org observe commands emit machine JSON under the global `--format json`
// flag: one JSON object on stdout, diagnostics on stderr only. Envelope for
// lists {v, org, items}; singletons are bare objects carrying v.

/** True when this invocation asked for protocol JSON output. */
export const orgJson = (ctx: CommandContext): boolean => ctx.flags.format === 'json';

/** Print one protocol JSON payload on stdout (compact — one line, NDJSON-safe
 *  for line-oriented callers) and return a success result. */
export const printOrgJson = (payload: Record<string, unknown>): CommandResult => {
  process.stdout.write(`${JSON.stringify(payload)}\n`);
  return { success: true, data: payload };
};

/** M5: `--by <resolver>` — who resolved a decision (default `human`). Returns
 *  an error string for an invalid value. */
export const resolverFlag = async (
  ctx: CommandContext,
): Promise<{ ok: true; by: string } | { ok: false; message: string }> => {
  const raw = ctx.flags.by;
  if (raw === undefined || raw === false) return { ok: true, by: 'human' };
  const { normalizeResolver } = await import('../orgrt/approvals.js');
  const by = normalizeResolver(raw);
  if (!by) return { ok: false, message: '--by must be 1-128 printable characters' };
  return { ok: true, by };
};

/** M2: ids of the org's endpoint roles (automations, not agents) — excluded
 *  from the costs/report/flow role tables. Unreadable config → none. */
export const endpointRoleIds = (cwd: string, name: string): Set<string> => {
  try {
    const raw = JSON.parse(readFileSync(join(cwd, ORG_DIR, `${name}.json`), 'utf8')) as {
      roles?: Array<{ id?: unknown; kind?: unknown }>;
    };
    return new Set(
      (Array.isArray(raw.roles) ? raw.roles : [])
        .filter((r) => r?.kind === 'endpoint' && typeof r.id === 'string')
        .map((r) => r.id as string),
    );
  } catch {
    return new Set();
  }
};

// Run ids are joined into filesystem paths — enforce the daemon's own id shape
// so a crafted --run can't traverse out of the org directory (same reason the
// org-name guard exists).
const RUN_ID_RE = /^run-[A-Za-z0-9-]+$/;
export const resolveRun = (cwd: string, name: string, runFlag: unknown): string | null => {
  if (typeof runFlag === 'string' && runFlag) return RUN_ID_RE.test(runFlag) ? runFlag : null;
  return listRunDirs(cwd, name)[0] ?? null;
};
