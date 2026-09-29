/**
 * Unit tests for orgrt/agent-error-classify.ts (issue #390): the pure
 * mapping from an engine error (§3.4 code + message) to an `agent test`
 * status, with real error strings per runtime.
 */

import { describe, expect, it } from 'vitest';
import { classifyAgentError, isModelUnavailable } from '../orgrt/agent-error-classify.js';

// Captured from the installed CLIs with a bogus --model (2026-09-29) unless noted.
const MODEL_ERRORS: Array<[string, string]> = [
  [
    'claude',
    "There's an issue with the selected model (claude-nonexistent-9). It may not exist or you may not have access to it. Run --model to pick a different model.",
  ],
  [
    'claude stderr',
    '[claude-code:unrecognized_model] {"model":"claude-nonexistent-9","query_source":"sdk"}',
  ],
  [
    'anthropic api (documented)',
    'API Error: 404 {"type":"error","error":{"type":"not_found_error","message":"model: claude-nonexistent-9"}}',
  ],
  ['copilot', 'Error: Model "gpt-nonexistent-9" from --model flag is not available.'],
  [
    'pi',
    'Error: Model "nonexistent-model-9" not found. Use --list-models to see available models.',
  ],
  [
    'antigravity (agy)',
    'Error: invalid model selection (--model "nonexistent-model-9" --effort ""): model nonexistent-model-9 is not recognized as a known model or custom model in settings',
  ],
  ['antigravity runner fixture', 'AntigravityAgentRunner: agy turn failed: model not found'],
  ['crush', 'Failed to override models: large model "nonexistent-model-9" not found.'],
  [
    'codex (seen via agent test)',
    'CodexAgentRunner: codex exec failed (exit 1): {"type":"error","status":400,"error":{"type":"invalid_request_error","message":"The \'nonexistent-model-9\' model is not supported when using Codex with a ChatGPT account."}}',
  ],
  [
    'openai (documented)',
    'The model `gpt-nonexistent-9` does not exist or you do not have access to it. (code: model_not_found)',
  ],
  [
    'opencode (documented)',
    'OpencodeAgentRunner: opencode session error: ProviderModelNotFoundError',
  ],
  [
    'gemini api (documented)',
    'models/gemini-nonexistent is not found for API version v1beta, or is not supported for generateContent.',
  ],
  [
    'kimi / moonshot (documented)',
    "Error code: 404 - {'error': {'message': 'Not found the model kimi-x or Permission denied', 'type': 'resource_not_found_error'}}",
  ],
  ['qwen / dashscope (documented)', 'Model not exist.'],
  ['plan gate', 'This model is not available on your plan. Upgrade to use it.'],
];

describe('classifyAgentError: model_unavailable', () => {
  it.each(MODEL_ERRORS)('%s → model_unavailable', (_runtime, message) => {
    expect(isModelUnavailable(message)).toBe(true);
    expect(classifyAgentError({ code: 'runner-error', message })).toEqual({
      status: 'model_unavailable',
      code: 'model-unavailable',
    });
  });

  it('wins over an auth code (provider answered 403 for the model)', () => {
    const message = 'HTTP 403: model claude-opus-5 is not available on your plan';
    expect(classifyAgentError({ code: 'auth', message }).status).toBe('model_unavailable');
  });

  it('never overrides timeout or missing-binary codes', () => {
    const message = 'model not found';
    expect(classifyAgentError({ code: 'timeout', message }).status).toBe('timeout');
    expect(classifyAgentError({ code: 'missing-binary', message }).status).toBe('missing_binary');
  });

  it('does not fire on ordinary failures', () => {
    for (const message of [
      'runner stream ended without a result message',
      'turn failed (error_max_turns)',
      'You have hit your usage limit',
      'CodexAgentRunner: codex exec failed (exit 1): connection reset',
    ]) {
      expect(isModelUnavailable(message)).toBe(false);
    }
  });
});

describe('classifyAgentError: other statuses', () => {
  it('passes through the engine auth/quota/timeout/missing-binary codes', () => {
    expect(classifyAgentError({ code: 'auth', message: 'x' })).toEqual({
      status: 'auth',
      code: 'auth',
    });
    expect(classifyAgentError({ code: 'quota', message: 'x' })).toEqual({
      status: 'quota',
      code: 'quota',
    });
    expect(classifyAgentError({ code: 'timeout', message: '' })).toEqual({
      status: 'timeout',
      code: 'timeout',
    });
    expect(classifyAgentError({ code: 'missing-binary' })).toEqual({
      status: 'missing_binary',
      code: 'missing-binary',
    });
  });

  it('maps runners that rethrow ENOENT as prose to missing_binary', () => {
    const message =
      'CodexAgentRunner requires the Codex CLI (codex) on PATH. Install it: npm install -g @openai/codex';
    expect(classifyAgentError({ code: 'runner-error', message })).toEqual({
      status: 'missing_binary',
      code: 'missing-binary',
    });
  });

  it.each([
    ['claude', 'Invalid API key · Please run /login'],
    ['claude', 'Not logged in · Please run /login'],
    // grok (seen)
    [
      'grok',
      'Error: Not signed in. To authenticate without a browser, run:\n  grok login --device-code',
    ],
    // hermes (seen)
    [
      'hermes',
      "No inference provider configured. Run 'hermes model' to choose a provider and model",
    ],
    ['codex', 'CodexAgentRunner: codex exec failed (exit 1): 401 Unauthorized'],
    // #473 crush 0.96.1, no providers set up (reported in issue #473 from a HOME
    // without runtime credentials)
    [
      'crush',
      "CrushAgentRunner: crush run failed (exit 1)\nstderr: No providers configured - please run 'crush' to set up a provider interactively.",
    ],
    // #473 crush 0.96.1 (seen 2026-09-29, empty CRUSH_GLOBAL_CONFIG/DATA, ~/.aws present)
    [
      'crush (bedrock, seen)',
      'CrushAgentRunner: crush run failed (exit 1)\nstderr: ERROR Agent processing failed: failed to start agent processing stream: authentication error: failed to refresh cached credentials, no EC2 IMDS role found',
    ],
    // #473 pi 0.87.1 (seen 2026-09-29 with an empty PI_CODING_AGENT_DIR; also in issue #473)
    [
      'pi',
      'PiAgentRunner: pi failed (exit 1)\nstderr: No API key found for the selected model.\n\nUse /login to log into a provider via OAuth or API key. See:\n  /home/u/.local/share/mise/installs/pi/0.87.1/pi/docs/providers.md',
    ],
    ['no api key configured', 'Error: no API key configured for provider openrouter'],
    ['use /login alone', 'Use /login to log into a provider via OAuth or API key.'],
  ])('%s runner-error auth wording → auth', (_rt, message) => {
    expect(classifyAgentError({ code: 'runner-error', message })).toEqual({
      status: 'auth',
      code: 'auth',
    });
  });

  it('#473 sign-in wording does not swallow model-unavailable or quota errors', () => {
    // pi (seen): unknown model with no key set still reports the model first.
    expect(
      classifyAgentError({
        code: 'runner-error',
        message:
          'Error: Model "nonexistent-model-9" not found. Use --list-models to see available models.',
      }).status,
    ).toBe('model_unavailable');
    expect(
      classifyAgentError({
        code: 'runner-error',
        message: 'large model "x" not found. No providers configured',
      }).status,
    ).toBe('model_unavailable');
    for (const message of [
      "You've hit your usage limit.",
      'insufficient_quota: check your API key billing details',
    ]) {
      expect(classifyAgentError({ code: 'runner-error', message }).status).not.toBe('auth');
    }
  });

  it('runner-error quota wording → quota', () => {
    expect(
      classifyAgentError({ code: 'runner-error', message: "You've hit your usage limit." }),
    ).toEqual({ status: 'quota', code: 'quota' });
  });

  it('everything else → error, keeping the engine code', () => {
    expect(classifyAgentError({ code: 'runner-error', message: 'boom' })).toEqual({
      status: 'error',
      code: 'runner-error',
    });
    expect(classifyAgentError({ code: 'no-runner', message: 'unknown runtime' })).toEqual({
      status: 'error',
      code: 'no-runner',
    });
    expect(classifyAgentError({})).toEqual({ status: 'error', code: 'runner-error' });
  });
});
