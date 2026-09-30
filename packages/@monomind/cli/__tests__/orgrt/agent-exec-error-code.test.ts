/**
 * §3.4: a credential that was never set is an `auth` error on every
 * runtime, like a rejected one (#532).
 */
import { describe, expect, it } from 'vitest';
import { execErrorCode, FATAL_CODES } from '../../src/orgrt/agent-exec-errors.js';

describe('execErrorCode: missing API key', () => {
  it.each([
    'PiRpcAgentRunner: missing API key: set OPENAI_API_KEY for provider openai, or run `pi` then /login.',
    'pi reported an error: No API key found for the selected model.',
    'Error: no API key configured for this provider',
  ])('%s → auth (fatal)', (message) => {
    const { code } = execErrorCode(new Error(message), message);
    expect(code).toBe('auth');
    expect(FATAL_CODES.has(code)).toBe(true);
  });

  it('leaves other failures alone', () => {
    expect(execErrorCode(undefined, 'boom').code).toBe('runner-error');
    expect(execErrorCode(undefined, 'the API key field is shown below').code).toBe('runner-error');
  });
});
