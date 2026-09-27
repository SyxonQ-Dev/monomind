// packages/@monomind/cli/src/orgrt/full-access-audit.ts
/**
 * Coder mode (#360 guardrail 3): one JSON line per full-access turn in
 * `~/.monomind/logs/agent-exec-full-access.log`, so there is a trace of what
 * ran with unrestricted tools even if the caller's own journal is lost.
 * Shared by `agent exec --access full` and full-access org roles (#365).
 *
 * Best effort by design: an audit write that fails must never fail the turn
 * (the caller's tool_activity stream is the primary audit trail).
 */

import { appendFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export interface FullAccessAuditRecord {
  /** ISO timestamp of the turn's end. */
  ts: string;
  cwd: string;
  runtime: string;
  sessionId?: string;
  exitCode: number;
  toolCalls: number;
  /** Set for org roles (#365). */
  org?: string;
  role?: string;
}

/** `MONOMIND_FULL_ACCESS_LOG` overrides the path (tests). */
export function fullAccessAuditLogPath(env: NodeJS.ProcessEnv = process.env): string {
  return (
    env.MONOMIND_FULL_ACCESS_LOG ||
    join(homedir(), '.monomind', 'logs', 'agent-exec-full-access.log')
  );
}

export function appendFullAccessAudit(
  record: FullAccessAuditRecord,
  env: NodeJS.ProcessEnv = process.env,
): void {
  try {
    const file = fullAccessAuditLogPath(env);
    mkdirSync(dirname(file), { recursive: true });
    appendFileSync(file, `${JSON.stringify(record)}\n`, { mode: 0o600 });
  } catch {
    /* best effort — never fail the turn over the audit line */
  }
}
