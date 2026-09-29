/** Model routing of the dsh runner: `<route>/<model>` splitting, the curated
 *  list (incl. free models), effort clamping and the llm-pi-ai patch row. */
import { describe, expect, it } from 'vitest';
import {
  clampEffort,
  DSH_MODELS,
  dshCuratedModel,
  dshEffortFor,
  dshPiAiRow,
  dshSplitModel,
} from '../../src/orgrt/dsh-runner-models.js';

const DUMP_EMPTY = [
  '- id: llm-pi-ai',
  "  name: '@deepseek-ai/dsh-llm-pi-ai'",
  '- id: session-persistence-jsonl',
  '  config:',
  "    root: !!js dshHomePath('sessions')",
].join('\n');

// A Models-page route (groq) already in the profile patch.
const DUMP_GROQ = [
  '- id: llm-pi-ai',
  "  name: '@deepseek-ai/dsh-llm-pi-ai'",
  '  config:',
  '    providers:',
  '      groq:',
  '        apiKeyEnv: GROQ_API_KEY',
  '    retryPolicy: x',
  '# == @deepseek-ai/dsh-base',
  '- id: session-persistence-jsonl',
].join('\n');

describe('dshSplitModel', () => {
  it('takes a known route prefix only', () => {
    expect(dshSplitModel('deepseek-v4-pro')).toEqual({ model: 'deepseek-v4-pro' });
    expect(dshSplitModel('openrouter/z-ai/glm-5.2:free')).toEqual({ provider: 'openrouter', model: 'z-ai/glm-5.2:free' });
    expect(dshSplitModel('nvidia/deepseek-ai/deepseek-v4-flash-0731')).toEqual({
      provider: 'nvidia',
      model: 'deepseek-ai/deepseek-v4-flash-0731',
    });
    expect(dshSplitModel('deepseek-official/deepseek-flash')).toEqual({ provider: 'deepseek-official', model: 'deepseek-flash' });
    // a bare pi-ai id: `z-ai` is not a route, so the profile's route applies
    expect(dshSplitModel('z-ai/glm-5.2:free')).toEqual({ model: 'z-ai/glm-5.2:free' });
    expect(dshSplitModel('openrouter/')).toEqual({ model: 'openrouter/' });
  });
});

describe('curated models', () => {
  it('lists DeepSeek first, then free models on openrouter and nvidia with their key', () => {
    expect(DSH_MODELS.filter((m) => m.default).map((m) => m.id)).toEqual(['deepseek-flash']);
    const free = DSH_MODELS.filter((m) => m.free);
    expect(free.length).toBeGreaterThanOrEqual(5);
    for (const m of free) {
      expect(m.id).toMatch(/^(openrouter|nvidia)\//);
      expect(m.key_env).toBe(m.id.startsWith('nvidia/') ? 'NVIDIA_API_KEY' : 'OPENROUTER_API_KEY');
      expect(m.effort_levels?.[0]).toBe('off');
      expect(dshSplitModel(m.id).provider).toBeDefined();
    }
    // OpenCode Zen refuses its free tier outside OpenCode: not offered.
    expect(DSH_MODELS.some((m) => m.id.startsWith('opencode'))).toBe(false);
    expect(dshCuratedModel('nvidia', 'deepseek-ai/deepseek-v4-pro-0813')?.free).toBe(true);
    expect(dshCuratedModel('deepseek-official', 'deepseek-v4-pro')?.key_env).toBe('DEEPSEEK_API_KEY');
  });

  it('clamps effort to the model’s levels like pi-ai (up first, then down)', () => {
    expect(clampEffort(['off', 'high', 'xhigh'], 'medium')).toBe('high');
    expect(clampEffort(['off', 'high', 'xhigh'], 'max')).toBe('xhigh');
    expect(clampEffort(['off', 'medium', 'high'], 'low')).toBe('medium');
    // captured live: glm-5.2:free refuses minimal/medium/max
    expect(dshEffortFor('openrouter', 'z-ai/glm-5.2:free', 'max')).toBe('xhigh');
    expect(dshEffortFor('openrouter', 'z-ai/glm-5.2:free', 'medium')).toBe('high');
    expect(dshEffortFor('nvidia', 'deepseek-ai/deepseek-v4-flash-0731', 'xhigh')).toBe('max');
    expect(dshEffortFor('openrouter', 'some/uncurated', 'xhigh')).toBe('xhigh');
  });
});

describe('dshPiAiRow', () => {
  it('needs no row for dsh’s own DeepSeek routes', () => {
    expect(dshPiAiRow('deepseek-official', DUMP_EMPTY)).toBeNull();
  });

  it('turns a dormant adapter on for the route, keyed by its env var', () => {
    expect(dshPiAiRow('openrouter', DUMP_EMPTY)).toBe(
      ['- id: llm-pi-ai', '  config:', '    providers:', '      "openrouter":', '        apiKeyEnv: "OPENROUTER_API_KEY"'].join('\n'),
    );
    expect(dshPiAiRow('openrouter', '')).toContain('"openrouter":');
    expect(dshPiAiRow('anthropic', '')).toContain('      "anthropic": {}');
  });

  it('keeps the profile’s other routes and fields (a patch replaces the whole config)', () => {
    expect(dshPiAiRow('nvidia', DUMP_GROQ)).toBe(
      [
        '- id: llm-pi-ai',
        '  config:',
        '    providers:',
        '      "nvidia":',
        '        apiKeyEnv: "NVIDIA_API_KEY"',
        '      groq:',
        '        apiKeyEnv: GROQ_API_KEY',
        '    retryPolicy: x',
      ].join('\n'),
    );
  });

  it('leaves a route the profile already configures alone', () => {
    expect(dshPiAiRow('groq', DUMP_GROQ)).toBeNull();
  });
});
