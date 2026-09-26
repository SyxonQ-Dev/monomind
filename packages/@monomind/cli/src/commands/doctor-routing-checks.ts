/**
 * Doctor — routing checks: routing learning (route-outcome accuracy) and the
 * agent registry the picker ranks. Extracted from doctor-project-checks.ts.
 */

import { existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { HealthCheck } from './doctor-env-checks.js';

function fmtPct(v: number | null): string {
  return v === null ? 'n/a' : `${Math.round(v * 100)}%`;
}

async function routingAccuracyLine(): Promise<string> {
  try {
    const { computeRoutingAccuracy, computeAdherence } = await import(
      '../monovector/route-outcomes.js'
    );
    const baseDir = join(process.cwd(), '.monomind');
    const acc = await computeRoutingAccuracy(baseDir, 100);
    const adh = await computeAdherence(baseDir);
    const adhStr = ` | adherence ${fmtPct(adh.adherence)} (n=${adh.sample})`;
    if (acc.accuracy === null) return `routing accuracy (last 100): no outcome data yet${adhStr}`;
    const trend =
      acc.recentVsPrior === null
        ? ''
        : ` trend ${acc.recentVsPrior >= 0 ? '+' : ''}${Math.round(acc.recentVsPrior * 100)}%`;
    return `routing accuracy (last ${acc.window}): ${fmtPct(acc.accuracy)} [native ${fmtPct(acc.byMode.native)} / js ${fmtPct(acc.byMode.js)}]${trend}${adhStr}`;
  } catch (e) {
    if (process.env.DEBUG || process.env.MONOMIND_DEBUG)
      console.error('[routingAccuracyLine] compute failed:', e);
    return 'routing accuracy (last 100): no outcome data yet';
  }
}

/** Fallback when route-outcomes.jsonl has no data: summarize .monomind/routing-feedback.jsonl honestly. */
function routingFeedbackFallback(): { message: string; degenerate: boolean } | null {
  try {
    const p = join(process.cwd(), '.monomind', 'routing-feedback.jsonl');
    if (!existsSync(p) || statSync(p).size > 512 * 1024) return null;
    const records = readFileSync(p, 'utf-8')
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((l) => {
        try {
          return JSON.parse(l) as Record<string, unknown>;
        } catch {
          return null;
        }
      })
      .filter((r): r is Record<string, unknown> => r !== null);
    if (records.length === 0) return null;
    const sessions = new Set(records.map((r) => r.sessionId).filter(Boolean));
    const byAgent = new Map<string, number>();
    for (const r of records) {
      const a = typeof r.suggestedAgent === 'string' ? r.suggestedAgent : 'unknown';
      byAgent.set(a, (byAgent.get(a) ?? 0) + 1);
    }
    const top = [...byAgent.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([a, n]) => `${a}=${n}`)
      .join(', ');
    const flags = records
      .map((r) => r.intelligenceFeedback)
      .filter((v): v is boolean => typeof v === 'boolean');
    const trueCount = flags.filter(Boolean).length;
    const base = `routing feedback (fallback): ${records.length} decisions across ${sessions.size} sessions; top agents: ${top}`;
    if (flags.length > 0 && trueCount === flags.length) {
      return {
        message: `${base}; success flag is degenerate (100% true — sessionSuccess heuristic never records failure)`,
        degenerate: true,
      };
    }
    if (flags.length === 0)
      return { message: `${base}; no evidence-based success flags yet`, degenerate: true };
    return {
      message: `${base}; success rate ${Math.round((trueCount / flags.length) * 100)}% (n=${flags.length})`,
      degenerate: false,
    };
  } catch (e) {
    if (process.env.DEBUG || process.env.MONOMIND_DEBUG)
      console.error('[routingFeedbackFallback] parse failed:', e);
    return null;
  }
}

export async function checkMonoesIntegration(): Promise<HealthCheck> {
  try {
    const line = await routingAccuracyLine();
    if (line.startsWith('routing accuracy (last 100): no outcome data yet')) {
      const fb = routingFeedbackFallback();
      if (fb)
        return {
          name: 'Routing Learning',
          status: fb.degenerate ? 'warn' : 'pass',
          message: fb.message,
        };
    }
    return { name: 'Routing Learning', status: 'pass', message: line };
  } catch (err) {
    return {
      name: 'Routing Learning',
      status: 'warn',
      message: `Could not compute routing accuracy: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

export async function checkAgentRegistry(opts: { readOnly?: boolean } = {}): Promise<HealthCheck> {
  try {
    const { buildUnifiedRegistry, computeAgentRoots } = await import(
      '../agents/registry-builder.js'
    );
    const { findProjectRoot, registryPath } = await import('../agents/registry-freshness.js');
    const project = findProjectRoot(process.cwd());
    const cwd = project ?? process.cwd();
    const roots = computeAgentRoots(cwd);
    const write = project !== null && !opts.readOnly;
    if (write) mkdirSync(join(cwd, '.monomind'), { recursive: true });
    // Rebuilds fresh in-memory (and, inside a project, refreshes
    // .monomind/registry.json on disk, never replacing a non-empty registry
    // with an empty one) rather than reading a file a separate startup task
    // may also be writing. Outside a project, and in read-only mode (issue
    // #335), nothing is written.
    const registry = buildUnifiedRegistry(roots, write ? registryPath(cwd) : undefined, {
      base: cwd,
    });
    const entries = registry.agents;
    // An extra root (MONOMIND_EXTRA_AGENT_PATHS or a sibling agency-agents dir)
    // wins slug conflicts over .claude/agents — say so instead of hiding it.
    const extras = roots.filter((r) => r.origin === 'extra').map((r) => r.dir);
    // User agents (~/.claude/agents) are indexed too; project agents win.
    const shadowed = registry.shadowed.length;
    const extraNote =
      `; ${registry.counts.user} from ~/.claude/agents` +
      (shadowed ? ` (${shadowed} shadowed by a project agent)` : '') +
      (extras.length ? `; extra agent roots (win on conflict): ${extras.join(', ')}` : '');
    if (entries.length === 0) {
      return {
        name: 'Agent Registry',
        status: 'warn',
        message: `No agents found under .claude/agents or ~/.claude/agents${extraNote}`,
        fix: 'monomind init  (installs agent definitions)',
      };
    }
    let missingSlug = 0,
      missingName = 0,
      missingDescription = 0,
      missingWhenToUse = 0;
    for (const agent of entries) {
      if (!agent.slug) missingSlug++;
      if (!agent.name) missingName++;
      if (!agent.description) missingDescription++;
      // The pick index leads with when_to_use; older installs lack it.
      if (!agent.whenToUse) missingWhenToUse++;
    }
    const dupes = registry.duplicates;
    const total = missingSlug + missingName + missingDescription + missingWhenToUse + dupes.length;
    if (total === 0) {
      return {
        name: 'Agent Registry',
        status: 'pass',
        message: `${entries.length} agent(s), all metadata complete${extraNote}`,
      };
    }
    const parts = [
      missingSlug > 0 ? `${missingSlug} missing slug` : null,
      missingName > 0 ? `${missingName} missing name` : null,
      missingDescription > 0 ? `${missingDescription} missing description` : null,
      missingWhenToUse > 0 ? `${missingWhenToUse} missing when_to_use` : null,
      dupes.length > 0
        ? `duplicate slug ${dupes.map((d) => `"${d.slug}" (kept ${d.kept}, dropped ${d.dropped.join(', ')})`).join('; ')}`
        : null,
    ]
      .filter(Boolean)
      .join(', ');
    return {
      name: 'Agent Registry',
      status: 'warn',
      message: `${total} metadata issue(s) across ${entries.length} agent(s): ${parts}${extraNote}`,
      fix: dupes.length
        ? 'Give each duplicated agent a unique `slug:` in its frontmatter'
        : missingWhenToUse > 0
          ? 'monomind init upgrade  (refreshes unedited bundled agents; add `when_to_use:` to your own agents in .claude/agents/*.md)'
          : 'Add the missing field(s) to frontmatter in .claude/agents/*.md',
    };
  } catch {
    return {
      name: 'Agent Registry',
      status: 'warn',
      message: 'Could not build/parse agent registry',
    };
  }
}
