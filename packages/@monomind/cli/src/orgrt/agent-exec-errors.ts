// packages/@monomind/cli/src/orgrt/agent-exec-errors.ts
// ─── errors (§3.4 taxonomy) ─────────────────────────────────────────────────

export type ExecErrorCode =
  | 'auth'
  | 'quota'
  | 'missing-binary'
  | 'no-runner'
  | 'budget'
  | 'runner-error'
  | 'timeout'
  | 'cancelled'
  | 'bad-frame';

export const FATAL_CODES = new Set<ExecErrorCode>([
  'auth',
  'quota',
  'missing-binary',
  'no-runner',
  'budget',
]);
