/**
 * Transient rate limit vs exhausted quota (orgrt/provider-limit.ts), the
 * classifyStderr label every runner shares, and pi's own retry count —
 * wordings from this repo's fixtures and the runtimes' documented errors.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { classifyAgentError } from '../orgrt/agent-error-classify.js';
import { execErrorCode } from '../orgrt/agent-exec-errors.js';
import { parseCliLine } from '../orgrt/aider-runner-stream.js';
import { classifyStderr } from '../orgrt/kimicode-runner-parse.js';
import { parsePiLine } from '../orgrt/pi-runner-parse.js';
import { PiRunTracker } from '../orgrt/pi-runner-state.js';
import {
  classifyProviderLimit,
  parseRetryAfterMs,
  vendorRetriesOf,
  withVendorRetries,
} from '../orgrt/provider-limit.js';

const PI_429 = readFileSync(
  join(__dirname, '../../__tests__/orgrt/fixtures/pi-0.87/json-openrouter-429-retries.jsonl'),
  'utf8',
);

describe('classifyProviderLimit', () => {
  it.each([
    ['pi / OpenRouter upstream 429', PI_429.split('\n').find((l) => l.includes('finalError'))!],
    ['OpenRouter per-minute cap', 'Rate limit exceeded: free-models-per-min.'],
    ['litellm (aider, dsh)', 'litellm.RateLimitError: OpenrouterException - rate limited'],
    ['Anthropic', 'API Error: 429 {"type":"error","error":{"type":"rate_limit_error"}}'],
    ['codex', 'stream error: exceeded retry limit, last status: 429 Too Many Requests'],
    ['OpenAI', 'Rate limit reached for gpt-4o on requests per min (RPM). Please try again in 1.5s'],
    [
      'Gemini per-minute quota',
      'RESOURCE_EXHAUSTED: You exceeded your current quota. quotaId: GenerateRequestsPerMinutePerProjectPerModel-FreeTier',
    ],
    ['plain status', 'request failed with status 429'],
    [
      'opencode session error',
      'OpencodeAgentRunner: opencode session error (HTTP 429): Provider returned error',
    ],
  ])('%s → rate-limited', (_name, text) => {
    expect(classifyProviderLimit(text)).toBe('rate-limited');
  });

  it.each([
    ['OpenRouter daily cap', 'Rate limit exceeded: free-models-per-day. Add 10 credits to unlock'],
    ['OpenAI insufficient_quota', '429 insufficient_quota: You exceeded your current quota'],
    ['codex / claude plan', "You've hit your usage limit."],
    ['DeepSeek', 'Insufficient Balance'],
    ['billing', 'billing cycle exhausted'],
  ])('%s → quota', (_name, text) => {
    expect(classifyProviderLimit(text)).toBe('quota');
  });

  it('a bare 429 in counts or ids is not a rate limit', () => {
    expect(classifyProviderLimit('Tokens: 429 sent, 12 received. id 14290')).toBeUndefined();
  });
});

describe('parseRetryAfterMs', () => {
  it.each([
    ['Retry-After: 20', 20_000],
    ['please retry after 3 seconds', 3_000],
    ['Please try again in 1.5s.', 1_500],
    ['"retryDelay": "17s"', 17_000],
    ['retry in 500ms', 500],
    ['Retry-After: 3600', 30_000],
    ['opencode session error (HTTP 429): x (Retry-After: 12)', 12_000],
  ])('%s → %d ms', (text, ms) => {
    expect(parseRetryAfterMs(text)).toBe(ms);
  });

  it('no hint → undefined', () => {
    expect(parseRetryAfterMs('Please retry shortly')).toBeUndefined();
  });
});

describe('shared classifiers', () => {
  it('classifyStderr keeps a rate limit fatal for the daemon but marks it', () => {
    expect(classifyStderr(PI_429)).toEqual({
      fatal: true,
      label: 'provider rate limit (429)',
      rateLimited: true,
    });
    expect(classifyStderr('usage limit reached')).toEqual({
      fatal: true,
      label: 'provider quota/billing limit',
    });
    expect(classifyStderr('auth_error 401').label).toMatch(/auth/);
  });

  it('execErrorCode carries the hint and the runtime’s own retries', () => {
    const err = withVendorRetries(new Error('429 Too Many Requests; Retry-After: 9'), 3);
    expect(execErrorCode(err, err.message)).toEqual({
      code: 'rate-limited',
      rateLimit: { message: err.message, retryAfterMs: 9_000, vendorRetries: 3 },
    });
    expect(execErrorCode(undefined, 'quota exceeded').code).toBe('quota');
    expect(execErrorCode(undefined, 'boom').code).toBe('runner-error');
  });

  it('vendorRetriesOf: a tag, codex wording (count unknown), or nothing', () => {
    expect(vendorRetriesOf(withVendorRetries(new Error('x'), 'unknown'), 'x')).toBe(0);
    expect(vendorRetriesOf(withVendorRetries(new Error('x'), 0), 'x')).toBeUndefined();
    expect(vendorRetriesOf(undefined, 'exceeded retry limit, last status: 429')).toBe(0);
    expect(vendorRetriesOf(undefined, '429')).toBeUndefined();
  });

  it('agent test reports rate_limited', () => {
    expect(classifyAgentError({ code: 'rate-limited', message: 'x' })).toEqual({
      status: 'rate_limited',
      code: 'rate-limited',
    });
    expect(
      classifyAgentError({ code: 'runner-error', message: 'HTTP 429 Too Many Requests' }),
    ).toEqual({
      status: 'rate_limited',
      code: 'rate-limited',
    });
  });

  it('aider CLI fallback: RateLimitError → rate-limited, insufficient_quota → quota', () => {
    expect(
      parseCliLine('litellm.RateLimitError: RateLimitError: OpenrouterException'),
    ).toMatchObject({
      type: 'error',
      code: 'rate-limited',
    });
    expect(parseCliLine('Error: insufficient_quota')).toMatchObject({
      type: 'error',
      code: 'quota',
    });
  });

  it('pi fixture: the tracker counts the three auto-retries behind the final 429', () => {
    const tracker = new PiRunTracker();
    for (const line of PI_429.split('\n')) {
      const p = parsePiLine(line);
      if (p) tracker.observe(p);
    }
    expect(tracker.retries).toBe(3);
    expect(tracker.failure()).toMatch(/temporarily rate-limited upstream/);
  });
});
