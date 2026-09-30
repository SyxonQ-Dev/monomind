// packages/@monomind/cli/src/commands/org-observe-gates.ts
//
// `monomind org gates | gate-approve | gate-reject` — decision gates.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { type DecisionGate, ORG_DIR } from '../orgrt/types.js';
import { output } from '../output.js';
import type { CommandContext, CommandResult } from '../types.js';
import { hostingDaemonFor, orgJson, printOrgJson, resolverFlag } from './org-observe-shared.js';

const log = (text: string): void => {
  console.log(text);
};

// ── Decision gates ──────────────────────────────────────────────────────

function readGatesFile(cwd: string, org: string): { gates: DecisionGate[] } {
  try {
    return JSON.parse(readFileSync(join(cwd, ORG_DIR, org, 'gates.json'), 'utf8'));
  } catch {
    return { gates: [] };
  }
}

/** Read gates.json for a write path. A MISSING file legitimately means "no gates" → [].
 *  Any other failure (unreadable, malformed — e.g. a partial daemon write) THROWS:
 *  gateResolveAction rewrites this file from what this returns, so silently coercing a
 *  failed read to [] would surface a real I/O error as "gate not found" and a
 *  subsequent write would replace every recorded gate with just this one. */
function readGatesFileStrict(cwd: string, org: string): { gates: DecisionGate[] } {
  const path = join(cwd, ORG_DIR, org, 'gates.json');
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { gates: [] };
    throw new Error(`cannot read ${path}: ${err instanceof Error ? err.message : String(err)}`);
  }
  let parsed: { gates?: DecisionGate[] };
  try {
    parsed = JSON.parse(raw) as { gates?: DecisionGate[] };
  } catch (err) {
    throw new Error(
      `${path} is not valid JSON (${err instanceof Error ? err.message : String(err)})`,
    );
  }
  if (parsed?.gates === undefined || parsed.gates === null) return { gates: [] };
  if (!Array.isArray(parsed.gates)) throw new Error(`${path}: "gates" is not an array`);
  return { gates: parsed.gates };
}

export const gatesAction = async (ctx: CommandContext, name: string): Promise<CommandResult> => {
  const data = readGatesFile(ctx.cwd, name);
  const showAll = ctx.flags.all === true;
  const gates = showAll ? data.gates : data.gates.filter((g) => g.status === 'pending');

  if (orgJson(ctx)) return printOrgJson({ v: 1, org: name, items: gates });

  if (!gates.length) {
    log(
      output.info(
        showAll
          ? `No gates for org "${name}"`
          : `No pending gates for org "${name}" (use --all to include resolved)`,
      ),
    );
    return { success: true };
  }

  log(output.info(`${showAll ? 'All' : 'Pending'} gates for org "${name}" (${gates.length}):\n`));
  for (const g of gates) {
    const status =
      g.status === 'pending'
        ? '⏳ pending'
        : g.status === 'approved'
          ? '✅ approved'
          : '❌ rejected';
    log(output.info(`  ${g.id}  ${status}  role:${g.roleId}`));
    log(output.info(`    name: ${g.name}`));
    log(output.info(`    desc: ${g.description}`));
    if (g.resolution) log(output.info(`    resolution: ${g.resolution}`));
    log('');
  }
  return { success: true, message: `${gates.length} gate(s)` };
};

export const gateResolveAction = async (
  ctx: CommandContext,
  name: string,
  approved: boolean,
): Promise<CommandResult> => {
  const gateId = ctx.args[1];
  const resolution = ctx.args.slice(2).join(' ') || undefined;
  if (!gateId)
    return {
      success: false,
      message: `usage: monomind org gate-${approved ? 'approve' : 'reject'} ${name} <gate-id> [resolution]`,
    };

  let data: { gates: DecisionGate[] };
  try {
    data = readGatesFileStrict(ctx.cwd, name);
  } catch (err) {
    log(
      output.error(
        `Cannot read gates for org ${name}: ${err instanceof Error ? err.message : String(err)}`,
      ),
    );
    return { success: false, message: 'gates.json unreadable — gate not resolved' };
  }
  const gate = data.gates.find((g) => g.id === gateId);
  if (!gate) return { success: false, message: `gate "${gateId}" not found for org "${name}"` };
  if (gate.status !== 'pending')
    return { success: false, message: `gate "${gateId}" already resolved (${gate.status})` };
  const byFlag = await resolverFlag(ctx);
  if (!byFlag.ok) return { success: false, message: byFlag.message };
  const resolvedBy = byFlag.by;

  // SEC: gate resolution is a human decision — operator credential only.
  const { readOperatorCredential } = await import('../orgrt/broker.js');
  const remote = await hostingDaemonFor(ctx.cwd, name);
  if (remote) {
    const cred = readOperatorCredential(name);
    try {
      const res = await fetch(`${remote.url}/api/resolve-gate`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(cred ? { 'x-monomind-cred': cred } : {}),
        },
        body: JSON.stringify({ org: name, gateId, approved, resolution, resolvedBy }),
        signal: AbortSignal.timeout(10_000),
      });
      const d = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
      if (res.ok && d.ok) {
        if (orgJson(ctx))
          return printOrgJson({
            v: 1,
            org: name,
            gate_id: gateId,
            status: approved ? 'approved' : 'rejected',
            delivery: 'live',
            resolvedBy,
          });
        log(output.success(`Gate ${gateId} ${approved ? 'approved' : 'rejected'} (live).`));
        return { success: true, message: `gate ${approved ? 'approved' : 'rejected'}` };
      }
      // SEC: a refusal must not fall through to writing gates.json (see hostingDaemonFor).
      log(output.error(`Live resolution rejected (${d.error ?? res.status}) — nothing recorded.`));
      return { success: false, message: `gate resolution rejected: ${d.error ?? res.status}` };
    } catch (err) {
      log(
        output.warning(
          `Hosting daemon unreachable (${err instanceof Error ? err.message : 'error'}) — falling back to offline queue.`,
        ),
      );
    }
  }

  // Offline path: no live daemon hosts this org (or the live call failed) —
  // resolve gates.json directly, same as resolveApproval's offline branch.
  // Re-read fresh (mirrors answerAction/resolveApproval) in case a live
  // daemon resolved this gate concurrently while the live call above was
  // in flight or timing out.
  const { writeGates } = await import('../orgrt/decisions.js');
  let fresh: { gates: DecisionGate[] };
  try {
    fresh = readGatesFileStrict(ctx.cwd, name);
  } catch (err) {
    log(
      output.error(
        `Refusing to rewrite gates.json — ${err instanceof Error ? err.message : String(err)}`,
      ),
    );
    log(
      output.warning(
        `The gate was NOT resolved. Fix or restore ${join(ctx.cwd, ORG_DIR, name, 'gates.json')}, then retry.`,
      ),
    );
    return { success: false, message: 'gates.json unreadable — gate not resolved' };
  }
  const idx = fresh.gates.findIndex((g) => g.id === gateId);
  if (idx === -1)
    return { success: false, message: `gate "${gateId}" not found for org "${name}"` };
  if (fresh.gates[idx].status !== 'pending') {
    return {
      success: false,
      message: `gate "${gateId}" already resolved (${fresh.gates[idx].status})`,
    };
  }
  fresh.gates[idx] = {
    ...fresh.gates[idx],
    status: approved ? 'approved' : 'rejected',
    resolvedAt: Date.now(),
    resolvedBy,
    resolution,
  };
  writeGates(ctx.cwd, name, fresh);

  if (orgJson(ctx))
    return printOrgJson({
      v: 1,
      org: name,
      gate_id: gateId,
      status: approved ? 'approved' : 'rejected',
      delivery: 'recorded',
      resolvedBy,
    });
  log(
    output.success(
      `Gate ${gateId} ${approved ? 'approved' : 'rejected'} — ${name} picks it up on its next cycle.`,
    ),
  );
  return { success: true, message: `gate ${approved ? 'approved' : 'rejected'} (queued)` };
};
