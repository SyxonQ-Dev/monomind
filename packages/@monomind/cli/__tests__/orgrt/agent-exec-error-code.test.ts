/**
 * §3.4: a credential that was never set is an `auth` error on every
 * runtime, like a rejected one (#532); text a runner marks as not its own
 * (model output, a CLI's stdout) is never classified.
 */
import { describe, expect, it } from 'vitest';
import {
  execErrorCode,
  FATAL_CODES,
  UNCLASSIFIED_MARKER,
} from '../../src/orgrt/agent-exec-errors.js';
import { clineTurnFailure } from '../../src/orgrt/cline-runner.js';

describe('execErrorCode: missing API key', () => {
  it.each([
    'PiRpcAgentRunner: missing API key: set OPENAI_API_KEY for provider openai, or run `pi` then /login.',
    'pi reported an error: No API key found for the selected model.',
    'Error: no API key configured for this provider',
    // hermes 0.19.0 (hermes_cli/auth.py and its first-run notice)
    "HermesAgentRunner: hermes chat failed (exit 1): No inference provider configured. Run 'hermes model' to choose a provider and model, or set an API key (OPENROUTER_API_KEY, OPENAI_API_KEY, etc.) in ~/.hermes/.env.",
    "HermesAgentRunner: hermes chat failed (exit 1): It looks like Hermes isn't configured yet -- no API keys or providers found.",
  ])('%s → auth (fatal)', (message) => {
    const { code } = execErrorCode(new Error(message), message);
    expect(code).toBe('auth');
    expect(FATAL_CODES.has(code)).toBe(true);
  });

  it('leaves other failures alone', () => {
    expect(execErrorCode(undefined, 'boom').code).toBe('runner-error');
    expect(execErrorCode(undefined, 'the API key field is shown below').code).toBe('runner-error');
  });

  it('ignores everything after UNCLASSIFIED_MARKER', () => {
    const message = `X: turn failed${UNCLASSIFIED_MARKER}model said: 401 unauthorized, missing API key, 429`;
    expect(execErrorCode(new Error(message), message).code).toBe('runner-error');
  });
});

describe('cline: final model text is shown but never classified', () => {
  it('a stopped turn whose last text mentions auth/quota stays a plain runner-error', () => {
    const err = clineTurnFailure(
      {
        exitCode: 1,
        stderrTail: '',
        timedOut: false,
        maxTurnsHit: false,
        finishReason: 'mistake_limit',
        resultText: 'I got a 401 auth_error and quota exceeded; missing API key for the service.',
      },
      false,
    );
    expect(err?.message).toContain('ClineAgentRunner: cline stopped: mistake_limit');
    expect(err?.message).toContain(`${UNCLASSIFIED_MARKER}cline final text: I got a 401`);
    expect((err as Error & { fatal?: boolean }).fatal).toBeUndefined();
    expect(execErrorCode(err, err?.message ?? '').code).toBe('runner-error');
  });

  it('a real cline error message is still classified', () => {
    const err = clineTurnFailure(
      {
        exitCode: 1,
        stderrTail: '',
        timedOut: false,
        maxTurnsHit: false,
        errorMessage: '401 Unauthorized',
        resultText: 'irrelevant',
      },
      false,
    );
    expect(err?.message).not.toContain(UNCLASSIFIED_MARKER);
    expect(execErrorCode(err, err?.message ?? '').code).toBe('auth');
  });
});
