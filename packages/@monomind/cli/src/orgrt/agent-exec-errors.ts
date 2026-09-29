// packages/@monomind/cli/src/orgrt/agent-exec-errors.ts
import { classifyStderr } from './kimicode-runner-parse.js';
import { parseRetryAfterMs, vendorRetriesOf } from './provider-limit.js';

// ─── errors (§3.4 taxonomy) ─────────────────────────────────────────────────

export type ExecErrorCode =
  | 'auth'
  | 'quota'
  | 'rate-limited'
  | 'missing-binary'
  | 'no-runner'
  | 'budget'
  | 'runner-error'
  | 'timeout'
  | 'cancelled'
  | 'bad-frame'
  | 'unsafe'
  | 'unsupported';

export const FATAL_CODES = new Set<ExecErrorCode>([
  'auth',
  'quota',
  // rev 20: only ever emitted once agent-exec-retry.ts has given up.
  'rate-limited',
  'missing-binary',
  'no-runner',
  'budget',
  'unsafe',
  'unsupported',
]);

/** A turn that failed on a transient provider rate limit (rev 20). */
export interface RateLimitHit {
  /** The runner's own error text. */
  message: string;
  /** The provider's Retry-After hint, capped (provider-limit.ts). */
  retryAfterMs?: number;
  /** Retries the runtime's CLI already made itself (0 = count unknown);
   *  undefined when it made none. */
  vendorRetries?: number;
}

/** §3.4 code for a runner failure's text (anything but a missing binary). */
export function execErrorCode(
  err: unknown,
  message: string,
): { code: ExecErrorCode; rateLimit?: RateLimitHit } {
  const cls = classifyStderr(message);
  if (!cls.fatal) return { code: 'runner-error' };
  if (/auth/i.test(cls.label ?? '')) return { code: 'auth' };
  if (!cls.rateLimited) return { code: 'quota' };
  const retryAfterMs = parseRetryAfterMs(message);
  const vendorRetries = vendorRetriesOf(err, message);
  return {
    code: 'rate-limited',
    rateLimit: {
      message,
      ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
      ...(vendorRetries !== undefined ? { vendorRetries } : {}),
    },
  };
}
