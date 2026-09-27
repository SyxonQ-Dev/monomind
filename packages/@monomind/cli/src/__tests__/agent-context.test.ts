// #365: agent-context.ts's env-marker detection, in isolation.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { detectAgentContextMarker } from '../orgrt/agent-context.js';

const MARKERS = [
  'CLAUDECODE',
  'CLAUDE_CODE_ENTRYPOINT',
  'MONOMIND_ORG_ROLE',
  'MONOMIND_SDK_AGENT',
  'MONOMIND_AGENT_EXEC',
] as const;

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

  it('works against an injected env object, not just process.env', () => {
    expect(detectAgentContextMarker({ MONOMIND_SDK_AGENT: '1' })).toBe('MONOMIND_SDK_AGENT');
    expect(detectAgentContextMarker({})).toBeUndefined();
  });
});
