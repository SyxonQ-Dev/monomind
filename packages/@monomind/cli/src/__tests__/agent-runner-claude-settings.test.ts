/**
 * Unit tests for resolveClaudeSettingsOverrides (orgrt/agent-runner-claude-settings.ts).
 *
 * Pure-function tests — no SDK/queryFn involved. See
 * agent-runner-claude-settings-sdk.test.ts for the actual SDK-options
 * snapshot proof through ClaudeAgentRunner itself.
 */

import { describe, expect, it } from 'vitest';
import { resolveClaudeSettingsOverrides } from '../orgrt/agent-runner-claude-settings.js';

describe('resolveClaudeSettingsOverrides (#356)', () => {
  it('settingSources: [] (--settings none, the default) reproduces the pre-#356 shape exactly', () => {
    const orgServer = { fake: 'server' };
    const result = resolveClaudeSettingsOverrides([], {
      systemPrompt: 'be helpful',
      orgServer,
      hasCallerTools: false,
    });
    expect(result).toEqual({
      settingSources: [],
      strictMcpConfig: true,
      mcpServers: { org: orgServer },
      systemPrompt: 'be helpful',
    });
  });

  it('settingSources: [] ignores hasCallerTools — mcpServers is always {org} on the default path', () => {
    const orgServer = { fake: 'server' };
    const result = resolveClaudeSettingsOverrides([], {
      systemPrompt: 'be helpful',
      orgServer,
      hasCallerTools: true,
    });
    expect(result.mcpServers).toEqual({ org: orgServer });
    expect(result.strictMcpConfig).toBe(true);
  });

  it('non-empty settingSources relaxes strictMcpConfig and wraps the system prompt in the claude_code preset', () => {
    const orgServer = { fake: 'server' };
    const result = resolveClaudeSettingsOverrides(['user', 'project', 'local'], {
      systemPrompt: 'be helpful',
      orgServer,
      hasCallerTools: false,
    });
    expect(result.settingSources).toEqual(['user', 'project', 'local']);
    expect(result.strictMcpConfig).toBe(false);
    expect(result.systemPrompt).toEqual({
      type: 'preset',
      preset: 'claude_code',
      append: 'be helpful',
    });
  });

  it('non-empty settingSources with no caller tools omits mcpServers entirely (no {} either)', () => {
    const result = resolveClaudeSettingsOverrides(['project'], {
      systemPrompt: '',
      orgServer: {},
      hasCallerTools: false,
    });
    expect('mcpServers' in result).toBe(false);
  });

  it('non-empty settingSources with caller tools merges the org server in', () => {
    const orgServer = { fake: 'server' };
    const result = resolveClaudeSettingsOverrides(['project'], {
      systemPrompt: '',
      orgServer,
      hasCallerTools: true,
    });
    expect(result.mcpServers).toEqual({ org: orgServer });
  });
});
