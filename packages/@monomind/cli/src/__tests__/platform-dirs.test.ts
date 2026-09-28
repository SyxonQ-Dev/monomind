// #372: which non-Claude directories an init run may create.
import { describe, expect, it } from 'vitest';
import { wantsAgentsDirs, wantsGeminiDirs } from '../init/platform-dirs.js';

describe('platform-dirs', () => {
  it('claude only: neither .gemini nor .agents', () => {
    expect(wantsGeminiDirs({ selectedPlatforms: ['claude'] })).toBe(false);
    expect(wantsAgentsDirs({ selectedPlatforms: ['claude'] })).toBe(false);
  });

  it('antigravity brings .gemini; any non-Claude platform brings .agents', () => {
    expect(wantsGeminiDirs({ selectedPlatforms: ['claude', 'antigravity'] })).toBe(true);
    expect(wantsGeminiDirs({ selectedPlatforms: ['codex'] })).toBe(false);
    expect(wantsAgentsDirs({ selectedPlatforms: ['claude', 'codex'] })).toBe(true);
  });

  it('no selection (legacy programmatic callers) keeps both', () => {
    expect(wantsGeminiDirs({})).toBe(true);
    expect(wantsAgentsDirs({})).toBe(true);
  });
});
