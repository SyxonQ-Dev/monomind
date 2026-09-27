// packages/@monomind/cli/src/orgrt/access-taint.ts
/**
 * #365 `org validate` taint checks for `policy.access: 'full'` roles: the
 * risk is untrusted content reaching a full-access role and steering it
 * (prompt injection), now with a real shell.
 *
 * There is no dedicated "untrusted input" flag on a role or a formal
 * messaging graph in the schema (RoleSchema has no allow-list of who may
 * `org_send` a role, only `review_input: 'artifact-only'`, which restricts a
 * DIFFERENT thing — cold review framing). This module uses the two concrete,
 * documented untrusted-content surfaces named in #365/#360 as its heuristic:
 * a non-empty `policy.webAllow`, and a `tool_providers` entry whose name
 * looks like a communications/social surface (mono-agent's own message/
 * people/social/email tool providers, which are ordinary `mcp-stdio`
 * providers from this schema's point of view — there is nothing else to key
 * on). The messaging graph is approximated by `reports_to` edges (a role can
 * be reached by, and can reach, its manager and its direct reports) — the
 * only reachability relationship this schema expresses; a richer messaging
 * model would replace this later.
 */

import type { OrgDef, OrgRole } from './types.js';

const UNTRUSTED_TOOL_PROVIDER_RE = /message|mail|email|social|people|communicat|inbox/i;

/** A role that reads inbound third-party content directly. */
export function isUntrustedInputRole(role: OrgRole): boolean {
  if ((role.policy?.webAllow?.length ?? 0) > 0) return true;
  return (role.tool_providers ?? []).some((p) => UNTRUSTED_TOOL_PROVIDER_RE.test(p.name));
}

/** Undirected adjacency over `reports_to` — the only reachability the schema
 *  expresses for "who can send this role a message". */
function reportsAdjacency(def: OrgDef): Map<string, Set<string>> {
  const ids = new Set(def.roles.map((r) => r.id));
  const adj = new Map<string, Set<string>>();
  const link = (a: string, b: string): void => {
    if (!adj.has(a)) adj.set(a, new Set());
    adj.get(a)?.add(b);
  };
  for (const r of def.roles) {
    if (r.reports_to && ids.has(r.reports_to)) {
      link(r.id, r.reports_to);
      link(r.reports_to, r.id);
    }
  }
  return adj;
}

/** Shortest path (role ids, inclusive of both ends) from `fromId` to `toId`
 *  over the reports_to graph, or `undefined` when unreachable. */
function shortestPath(
  adj: Map<string, Set<string>>,
  fromId: string,
  toId: string,
): string[] | undefined {
  if (fromId === toId) return undefined;
  const prev = new Map<string, string>();
  const seen = new Set([fromId]);
  const queue = [fromId];
  while (queue.length) {
    const cur = queue.shift();
    if (cur === undefined) break;
    for (const next of adj.get(cur) ?? []) {
      if (seen.has(next)) continue;
      seen.add(next);
      prev.set(next, cur);
      if (next === toId) {
        const path = [toId];
        let walk = toId;
        while (walk !== fromId) {
          const p = prev.get(walk);
          if (!p) break;
          path.unshift(p);
          walk = p;
        }
        return path;
      }
      queue.push(next);
    }
  }
  return undefined;
}

/** `org validate` findings for every `policy.access: 'full'` role in `def`.
 *
 *  Direct taint (the full-access role itself is an untrusted-input role):
 *  always an error — never overridable, matching #365 ("must not read
 *  inbound third-party content itself").
 *
 *  Indirect taint (an untrusted-input role can reach the full-access role
 *  via `reports_to`): an error unless the org's
 *  `run_config.accept_full_access_taint` names the path (either the full
 *  arrow-joined path, or just its two endpoints as `source→target`) — in
 *  which case it is downgraded to a warning so it stays visible without
 *  blocking `org validate`. Accepting a path is human-only and covered by
 *  the accepting role's `access_ack` hash (access-ack.ts), so an
 *  unacknowledged edit to the accept list suspends full access exactly like
 *  any other config drift. */
export function fullAccessTaintFindings(def: OrgDef): { errors: string[]; warnings: string[] } {
  const errors: string[] = [];
  const warnings: string[] = [];
  const fullRoles = def.roles.filter((r) => (r.policy?.access ?? 'scoped') === 'full');
  if (!fullRoles.length) return { errors, warnings };

  const untrustedIds = def.roles.filter(isUntrustedInputRole).map((r) => r.id);
  const accept = new Set(
    (
      (def.run_config as { accept_full_access_taint?: string[] }).accept_full_access_taint ?? []
    ).map((s) => s.replace(/\s*→\s*/g, '→')),
  );
  const adj = reportsAdjacency(def);

  for (const role of fullRoles) {
    if (untrustedIds.includes(role.id)) {
      errors.push(
        `role ${role.id}: policy.access 'full' but the role itself is an untrusted-input role (webAllow, or a message/social/email tool provider) — a full-access role must not read inbound third-party content directly`,
      );
    }
    for (const sourceId of untrustedIds) {
      if (sourceId === role.id) continue;
      const path = shortestPath(adj, sourceId, role.id);
      if (!path) continue;
      const pathLabel = path.join(' → ');
      const endpoints = `${path[0]}→${path[path.length - 1]}`;
      const accepted = accept.has(pathLabel.replace(/\s*→\s*/g, '→')) || accept.has(endpoints);
      const msg = `role ${role.id}: reachable from untrusted-input role "${sourceId}" via reports_to (${pathLabel}) — indirect prompt-injection path into a full-access role`;
      if (accepted) {
        warnings.push(`${msg} (accepted via run_config.accept_full_access_taint)`);
      } else {
        errors.push(
          `${msg} — add "${endpoints}" to run_config.accept_full_access_taint (human-only) to accept it`,
        );
      }
    }
  }
  return { errors, warnings };
}
