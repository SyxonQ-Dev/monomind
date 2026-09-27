/**
 * Unit tests for orgrt/agent-exec-settings.ts (#356): --settings flag
 * parsing and the exec-engine status/startup-watchdog handler.
 */

import { describe, expect, it, vi } from 'vitest';
import { createExecStatusHandler, parseSettingsFlag } from '../orgrt/agent-exec-settings.js';

describe('parseSettingsFlag (#356)', () => {
  it('undefined/null/empty/"none" all mean no sources', () => {
    expect(parseSettingsFlag(undefined)).toEqual({ sources: [] });
    expect(parseSettingsFlag(null)).toEqual({ sources: [] });
    expect(parseSettingsFlag('')).toEqual({ sources: [] });
    expect(parseSettingsFlag('none')).toEqual({ sources: [] });
  });

  it('parses a CSV of valid sources', () => {
    expect(parseSettingsFlag('user,project,local')).toEqual({
      sources: ['user', 'project', 'local'],
    });
    expect(parseSettingsFlag('project')).toEqual({ sources: ['project'] });
    expect(parseSettingsFlag(' user , project ')).toEqual({ sources: ['user', 'project'] });
  });

  it('rejects an invalid token with an actionable error', () => {
    const result = parseSettingsFlag('bogus');
    expect('error' in result).toBe(true);
    expect((result as { error: string }).error).toMatch(/invalid --settings value "bogus"/);
  });

  it('rejects a mix of a valid and an invalid token', () => {
    const result = parseSettingsFlag('user,bogus');
    expect('error' in result).toBe(true);
  });
});

describe('createExecStatusHandler (#356)', () => {
  it('disabled: never emits, never terminates, dispose is a no-op', () => {
    const emit = vi.fn();
    const terminate = vi.fn();
    const h = createExecStatusHandler({ enabled: false, timeoutMs: 5, emit, terminate });
    h.onMessage({ type: 'status', phase: 'ready' });
    h.dispose();
    expect(emit).not.toHaveBeenCalled();
    expect(terminate).not.toHaveBeenCalled();
  });

  it('emits a status NDJSON event for every status message, enabled or not-yet-timed-out', () => {
    const emit = vi.fn();
    const terminate = vi.fn();
    const h = createExecStatusHandler({ enabled: true, timeoutMs: 10_000, emit, terminate });
    h.onMessage({ type: 'status', phase: 'initializing' });
    h.onMessage({
      type: 'status',
      phase: 'ready',
      mcp_servers: [{ name: 'x', status: 'connected' }],
    });
    h.dispose();
    expect(emit).toHaveBeenCalledWith({ v: 1, type: 'status', phase: 'initializing' });
    expect(emit).toHaveBeenCalledWith({
      v: 1,
      type: 'status',
      phase: 'ready',
      mcp_servers: [{ name: 'x', status: 'connected' }],
    });
  });

  it('ignores non-status messages', () => {
    const emit = vi.fn();
    const terminate = vi.fn();
    const h = createExecStatusHandler({ enabled: true, timeoutMs: 10_000, emit, terminate });
    h.onMessage({ type: 'assistant' });
    h.dispose();
    expect(emit).not.toHaveBeenCalled();
  });

  it('terminates with runner-error if phase:"ready" never arrives before timeoutMs', async () => {
    const emit = vi.fn();
    const terminate = vi.fn();
    const h = createExecStatusHandler({ enabled: true, timeoutMs: 20, emit, terminate });
    h.onMessage({ type: 'status', phase: 'initializing' });
    await new Promise((r) => setTimeout(r, 60));
    expect(terminate).toHaveBeenCalledWith('runner-error', 1);
    expect(emit).toHaveBeenCalledWith(
      expect.objectContaining({
        v: 1,
        type: 'error',
        code: 'runner-error',
        fatal: false,
        message: expect.stringContaining('did not initialize'),
      }),
    );
    h.dispose();
  });

  it("does NOT time out once phase:'ready' has been seen", async () => {
    const emit = vi.fn();
    const terminate = vi.fn();
    const h = createExecStatusHandler({ enabled: true, timeoutMs: 20, emit, terminate });
    h.onMessage({ type: 'status', phase: 'ready', mcp_servers: [] });
    await new Promise((r) => setTimeout(r, 60));
    expect(terminate).not.toHaveBeenCalled();
    h.dispose();
  });

  it('dispose() before the timeout prevents the watchdog from firing', async () => {
    const emit = vi.fn();
    const terminate = vi.fn();
    const h = createExecStatusHandler({ enabled: true, timeoutMs: 20, emit, terminate });
    h.dispose();
    await new Promise((r) => setTimeout(r, 60));
    expect(terminate).not.toHaveBeenCalled();
  });
});
