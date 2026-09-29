// #365: agent-context.ts's env-marker detection, in isolation.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AGENT_CONTEXT_ENV_MARKERS, detectAgentContextMarker } from '../orgrt/agent-context.js';

const MARKERS = AGENT_CONTEXT_ENV_MARKERS;

beforeEach(() => {
  for (const k of MARKERS) vi.stubEnv(k, undefined);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('detectAgentContextMarker', () => {
  it('returns undefined when no marker is set', () => {
    expect(detectAgentContextMarker()).toBeUndefined();
  });

  it('returns undefined for an explicit empty-string value', () => {
    vi.stubEnv('CLAUDECODE', '');
    expect(detectAgentContextMarker()).toBeUndefined();
  });

  for (const marker of MARKERS) {
    it(`detects ${marker}`, () => {
      vi.stubEnv(marker, '1');
      expect(detectAgentContextMarker()).toBe(marker);
    });
  }

  it('covers every full-access runtime CLI plus the AI_AGENT convention', () => {
    for (const k of [
      'AI_AGENT',
      'CODEX_THREAD_ID',
      'OPENCODE',
      'ANTIGRAVITY_AGENT',
      'GROK_SESSION_ID',
      'COPILOT_CLI_BINARY_VERSION',
      'CRUSH',
      'PI_CODING_AGENT',
      'QWEN_CODE',
    ])
      expect(MARKERS, k).toContain(k);
  });

  it('works against an injected env object, not just process.env', () => {
    expect(detectAgentContextMarker({ MONOMIND_SDK_AGENT: '1' })).toBe('MONOMIND_SDK_AGENT');
    expect(detectAgentContextMarker({})).toBeUndefined();
  });
});
