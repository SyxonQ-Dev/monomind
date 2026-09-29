/**
 * Test doubles for ClineAgentRunner: fake cline children (json and ACP) for a
 * mocked `spawn`, a fake ClineHost, and the captured fixtures.
 *
 * Fixture provenance (cline 3.0.65, scratch HOME, OpenRouter free models,
 * 2026-09-29; paths shortened to /w, no credentials in any line):
 *   json-success.ndjson        live `cline --json` turn (nemotron-3-super
 *                              :free) — editor write, run_commands, text,
 *                              usage, run_result completed.
 *   json-provider-error.ndjson live turn whose provider call failed
 *                              (qwen3.8-27b:free) — agent_event error +
 *                              run_result error.
 *   acp-resume.ndjson          live `cline --acp` session/load (replaying the
 *                              turn above) + session/prompt that ran `ls`.
 *                              Only the id:2 load response is shortened (its
 *                              model list was cut in the capture).
 */
import type * as cp from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { vi } from 'vitest';
import type { ClineHistoryRow, ClineHost } from '../../../src/orgrt/cline-runner-types.js';

export function fixture(name: string): string[] {
  return readFileSync(join(__dirname, name), 'utf8').split('\n').filter((l) => l.trim());
}

type Kill = ReturnType<typeof vi.fn>;
export type FakeChild = cp.ChildProcess & { kill: Kill; written: string[] };

function base(): FakeChild {
  const child = new EventEmitter() as FakeChild;
  (child as any).stdout = new PassThrough();
  (child as any).stderr = new PassThrough();
  (child as any).exitCode = null;
  (child as any).signalCode = null;
  (child as any).pid = undefined;
  child.written = [];
  return child;
}

function close(child: FakeChild, code: number): void {
  if ((child as any).closed) return;
  (child as any).closed = true;
  (child as any).exitCode = code;
  (child.stdout as PassThrough).end();
  setTimeout(() => child.emit('close', code), 2);
}

/** A `cline --json` child printing `lines`. With `hold`, it keeps running
 *  after them until killed (then exits 143 with the `onKill` lines). */
export function jsonChild(
  lines: string[],
  opts: { exitCode?: number; stderr?: string; hold?: boolean; onKill?: string[] } = {},
): FakeChild {
  const child = base();
  child.kill = vi.fn(() => {
    for (const l of opts.onKill ?? []) (child.stdout as PassThrough).write(`${l}\n`);
    close(child, 143);
    return true;
  });
  setTimeout(() => {
    if (opts.stderr) (child.stderr as PassThrough).write(opts.stderr);
    for (const l of lines) (child.stdout as PassThrough).write(`${l}\n`);
    if (!opts.hold) close(child, opts.exitCode ?? 0);
  }, 2);
  return child;
}

/** A `cline --acp` child: each client request id N releases the fixture
 *  lines up to and including cline's response with id N; stdin end exits. */
export function acpChild(lines: string[]): FakeChild {
  const child = base();
  child.kill = vi.fn(() => {
    close(child, 143);
    return true;
  });
  let next = 0;
  (child as any).stdin = {
    destroyed: false,
    writable: true,
    write: (s: string) => {
      child.written.push(s.trim());
      const msg = JSON.parse(s);
      if (msg.method === undefined || msg.id === undefined) return true;
      setTimeout(() => {
        while (next < lines.length) {
          const l = lines[next++];
          (child.stdout as PassThrough).write(`${l}\n`);
          if (JSON.parse(l).id === msg.id) break;
        }
      }, 1);
      return true;
    },
    end: () => setTimeout(() => close(child, 0), 3),
  };
  return child;
}

export interface FakeHost extends ClineHost {
  kill: ReturnType<typeof vi.fn> & ClineHost['kill'];
  history: ReturnType<typeof vi.fn> & ClineHost['history'];
}

/** A ClineHost whose `history` answers each call with the next entry of
 *  `histories` (the last one repeats); `daemonPid` is reported as a hub
 *  daemon carrying whichever turn marker is asked for. */
export function fakeHost(
  opts: { histories?: ClineHistoryRow[][]; daemonPid?: number; scopedDir?: string } = {},
): FakeHost {
  const histories = opts.histories ?? [[]];
  let calls = 0;
  const alive = new Set<number>(opts.daemonPid ? [opts.daemonPid] : []);
  return {
    history: vi.fn(async () => histories[Math.min(calls++, histories.length - 1)]),
    hubLockPids: () => [],
    pidsWithEnv: () => (opts.daemonPid && alive.has(opts.daemonPid) ? [opts.daemonPid] : []),
    cmdline: (pid: number) =>
      pid === opts.daemonPid ? `cline --cline-hub-daemon --cwd /w --port 25463` : undefined,
    kill: vi.fn((pid: number, signal: NodeJS.Signals | 0) => {
      if (signal !== 0) alive.delete(pid);
      return signal === 0 ? alive.has(pid) : true;
    }),
    scopedDir: () => opts.scopedDir ?? mkdtempSync(join(tmpdir(), 'cline-scoped-test-')),
  } as FakeHost;
}

export const SID = '1790673149945_klj0i';
export const MODEL = 'nvidia/nemotron-3-super-120b-a12b:free';

/** The history row of the json-success turn as `cline history --json`
 *  printed it (hub-run: daemon pid, wrapped prompt). */
export function successRow(prompt: string, usage = { inputTokens: 19305, outputTokens: 201 }): ClineHistoryRow {
  return {
    sessionId: SID,
    pid: 121959,
    cwd: '/w',
    provider: 'openrouter',
    model: MODEL,
    startedAt: new Date().toISOString(),
    isSubagent: false,
    prompt: `<user_input mode="act">${prompt}</user_input>`,
    metadata: {
      totalCost: 0,
      usage: { ...usage, cacheReadTokens: 0, cacheWriteTokens: 0, totalCost: 0 },
    },
  };
}
