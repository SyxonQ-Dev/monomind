/**
 * disconnectSession() — drops this process's CDP connection without touching
 * the browser (#408).
 *
 * `monomind browse` runs inside a CLI that lets the event loop drain instead
 * of calling process.exit() (ADR-R001). A CDP websocket left open after the
 * subcommand printed its output kept every `monomind browse …` alive until the
 * 5 s force-exit watchdog. The embedder calls disconnectSession() once the
 * subcommand is done; the browser must survive it, because the next command
 * (a new process) reconnects to that same session.
 */

import { describe, expect, it, vi } from 'vitest';
import type { CdpClient } from '../browser/cdp.js';
import { disconnectSession } from '../cli/commands.js';
import { session } from '../cli/session.js';

describe('disconnectSession', () => {
  it('closes the CDP client and clears it, leaving the session record alone', () => {
    const close = vi.fn();
    const send = vi.fn();
    session.client = { close, send } as unknown as CdpClient;
    session.sessionId = 'sid-1';
    session.port = 9333;

    disconnectSession();

    expect(close).toHaveBeenCalledTimes(1);
    // No CDP command either: Browser.close would end the session others reuse.
    expect(send).not.toHaveBeenCalled();
    expect(session.client).toBeNull();
    expect(session.sessionId).toBe('');
    // The port pin survives so a later in-process command resolves the same session.
    expect(session.port).toBe(9333);
  });

  it('is a no-op when no client was ever connected', () => {
    session.client = null;
    expect(() => disconnectSession()).not.toThrow();
    expect(session.client).toBeNull();
  });
});
