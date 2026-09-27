// packages/@monomind/cli/src/orgrt/cross-org-deferred.ts
// Split out of cross-org.ts (file-size sweep) — in-flight lazy-spawn tracking.
import type { RunningOrg } from './daemon.js';

/** BUG 1 FIX: roles genuinely "in flight" toward spawning — pendingRoles
 *  entry already consumed but the role not yet in `agents` (including the
 *  whole resource-pressure deferred-spawn window, which can run for up to
 *  ~30min via scheduler-integration's scheduleDeferredSpawn retry loop).
 *  Without this, a message arriving for such a role fell through to
 *  "unknown recipient" and was silently dropped — only the FIRST message
 *  that triggered the lazy spawn got queued.
 *
 *  Deliberately module-scoped (not a RunningOrg field) so cross-org.ts owns
 *  the whole lifecycle — mark, self-heal, and TTL — without touching
 *  daemon.ts's RunningOrg type or scheduler-integration.ts. Keyed by
 *  "orgName:role"; value is the deferral timestamp used for TTL cleanup so a
 *  role that never spawns doesn't leak an entry forever. */
const deferredSpawns = new Map<string, number>();
const DEFERRED_SPAWN_TTL_MS = 35 * 60_000; // scheduler-integration retries for ~30min before giving up

function deferredKey(orgName: string, role: string): string {
  return `${orgName}:${role}`;
}

/** Call once a role's spawn has been kicked off (pendingRoles entry consumed). */
export function markDeferredSpawn(orgName: string, role: string): void {
  deferredSpawns.set(deferredKey(orgName, role), Date.now());
}

/** Call once a role's spawn completes synchronously (no deferral needed). */
export function clearDeferredSpawn(orgName: string, role: string): void {
  deferredSpawns.delete(deferredKey(orgName, role));
}

/** True if `role` is still genuinely in-flight toward spawning. Self-heals:
 *  clears the entry if the role already made it into `agents`, or if it's
 *  been deferred past the TTL (treated as abandoned — stop queuing into a
 *  spawn that's never coming). */
export function isDeferredSpawn(
  org: RunningOrg | undefined,
  orgName: string,
  role: string,
): boolean {
  const key = deferredKey(orgName, role);
  const deferredAt = deferredSpawns.get(key);
  if (deferredAt === undefined) return false;
  if (org?.agents.has(role)) {
    deferredSpawns.delete(key); // spawn completed since — stale flag
    return false;
  }
  if (Date.now() - deferredAt >= DEFERRED_SPAWN_TTL_MS) {
    deferredSpawns.delete(key); // never spawned within TTL — avoid leaking/queuing forever
    return false;
  }
  return true;
}
