/**
 * `monomind.memory.learningBridge`, `memoryGraph` and `agentScopes` were
 * written by init/upgrade but no code, helper or hook ever read them. Init no
 * longer writes them; configs from older installs that still carry them must
 * keep loading and keep their keys.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { generateSettings } from '../init/settings-generator.js';
import { DEFAULT_INIT_OPTIONS, detectPlatform, type InitResult } from '../init/types.js';
import { mergeSettingsForUpgrade } from '../init/upgrade-steps.js';
import { writeRuntimeConfig } from '../init/write-runtime-config.js';

const DEAD = ['learningBridge', 'memoryGraph', 'agentScopes'];

let targetDir: string;
beforeEach(() => {
  targetDir = mkdtempSync(join(tmpdir(), 'monomind-dead-flags-'));
  mkdirSync(join(targetDir, '.monomind'), { recursive: true });
});
afterEach(() => rmSync(targetDir, { recursive: true, force: true }));

describe('dead memory flags', () => {
  it('settings.json from init has no learningBridge/memoryGraph/agentScopes', () => {
    const settings = generateSettings({ ...DEFAULT_INIT_OPTIONS, targetDir }) as {
      monomind: { memory: Record<string, unknown>; neural: { enabled: boolean } };
    };
    for (const key of DEAD) expect(settings.monomind.memory).not.toHaveProperty(key);
    // neural.enabled is read by session-restore-handler.cjs and stays.
    expect(settings.monomind.neural).toHaveProperty('enabled');
  });

  it('config.yaml from init has no learningBridge/agentScopes', async () => {
    const result: InitResult = {
      success: true,
      platform: detectPlatform(),
      created: { directories: [], files: [] },
      updated: [],
      skipped: [],
      removed: [],
      errors: [],
      summary: { skillsCount: 0, commandsCount: 0, agentsCount: 0, hooksEnabled: 0 },
    };
    await writeRuntimeConfig(targetDir, { ...DEFAULT_INIT_OPTIONS, targetDir }, result);
    const yaml = readFileSync(join(targetDir, '.monomind', 'config.yaml'), 'utf-8');
    expect(yaml).not.toContain('learningBridge');
    expect(yaml).not.toContain('agentScopes');
  });

  it('upgrade neither adds the keys nor drops them from an existing config', () => {
    const fresh = mergeSettingsForUpgrade({ monomind: { memory: { backend: 'hybrid' } } });
    const freshMemory = (fresh.monomind as { memory: Record<string, unknown> }).memory;
    for (const key of DEAD) expect(freshMemory).not.toHaveProperty(key);
    expect(freshMemory.backend).toBe('hybrid');

    const none = mergeSettingsForUpgrade({ monomind: { version: '3.0.0' } });
    expect(none.monomind).not.toHaveProperty('memory');

    const legacy = mergeSettingsForUpgrade({
      monomind: { memory: { backend: 'hybrid', learningBridge: { enabled: false } } },
    });
    const legacyMemory = (legacy.monomind as { memory: Record<string, unknown> }).memory;
    expect(legacyMemory.learningBridge).toEqual({ enabled: false });
  });
});
