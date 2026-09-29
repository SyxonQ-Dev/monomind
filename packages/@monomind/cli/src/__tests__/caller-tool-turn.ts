/**
 * Test helper (not a test file) for #389: one `agent exec --access full
 * --tools stdio` turn through runAgentExec with a real runner (its CLI
 * mocked by the calling test), where the caller answers every `tool_call`
 * frame on stdin the way mono-agent does.
 *
 * The runner's fake CLI is expected to ask for `org_roster` (fence runners:
 * emit `callerFence(team)` in its assistant text; claude: call
 * `mcp__org__org_roster`) and, on its next invocation, to be handed
 * `rosterResult(team)` back.
 */

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { expect } from 'vitest';
import { runAgentExec } from '../orgrt/agent-exec.js';
import type { AgentRunner } from '../orgrt/agent-runner.js';

export const CALLER_TOOL = {
  name: 'org_roster',
  description: 'List the members of a team.',
  schema: { type: 'object', properties: { team: { type: 'string' } }, required: ['team'] },
};

/** A fence-protocol call to the caller tool, as a model would write it. */
export const callerFence = (team: string): string =>
  `\`\`\`tool_call\n{"name": "org_roster", "arguments": {"team": "${team}"}}\n\`\`\``;

/** What the caller answers for `team`. */
export const rosterResult = (team: string): string => `roster(${team}): lead, qa`;

export interface CallerToolTurn {
  code: number;
  events: Record<string, any>[];
}

/**
 * Run the turn. `expectCalls`: how many tool_call frames the caller waits
 * for before answering any (answers then go out in reverse order), so a
 * parallel fixture proves every call was sent before any result came back.
 */
export async function runFullAccessToolTurn(
  runtime: string,
  runner: AgentRunner,
  opts: { expectCalls?: number; toolTimeoutMs?: number } = {},
): Promise<CallerToolTurn> {
  const expectCalls = opts.expectCalls ?? 1;
  const events: Record<string, any>[] = [];
  const stdin = new PassThrough();
  const waiting: Record<string, any>[] = [];
  const answer = (call: Record<string, any>) =>
    stdin.write(
      `${JSON.stringify({
        v: 1,
        type: 'tool_result',
        id: call.id,
        ok: true,
        result: { text: rosterResult(String(call.args?.team)) },
      })}\n`,
    );
  const cwd = mkdtempSync(join(tmpdir(), 'mm-389-'));
  // The full-access audit line goes to the scratch dir, not ~/.monomind.
  const savedLog = process.env.MONOMIND_FULL_ACCESS_LOG;
  process.env.MONOMIND_FULL_ACCESS_LOG = join(cwd, 'fa.log');
  const code = await runAgentExec({
    runtime,
    access: 'full',
    cwd,
    prompt: 'who is on the team?',
    maxTurns: 5,
    toolTimeoutMs: opts.toolTimeoutMs ?? 10_000,
    toolSpecs: [CALLER_TOOL],
    stdioFrames: true,
    runnerOverride: runner,
    stdin,
    emit: (ev) => {
      events.push(ev);
      if (ev.type !== 'tool_call') return;
      waiting.push(ev);
      if (waiting.length >= expectCalls) for (const c of waiting.splice(0).reverse()) answer(c);
    },
  }).finally(() => {
    if (savedLog === undefined) delete process.env.MONOMIND_FULL_ACCESS_LOG;
    else process.env.MONOMIND_FULL_ACCESS_LOG = savedLog;
  });
  return { code, events };
}

/** The protocol-level round trip: tool_call → tool_result, then a successful result. */
export function expectCallerRoundTrip(turn: CallerToolTurn, teams: string[] = ['core']): void {
  const { code, events } = turn;
  expect(events.find((e) => e.type === 'error')).toBeUndefined();
  expect(code).toBe(0);
  expect(events[0]).toMatchObject({ type: 'start', access: 'full' });
  const calls = events.filter((e) => e.type === 'tool_call');
  const results = events.filter((e) => e.type === 'tool_result');
  expect(calls.map((c) => c.args)).toEqual(teams.map((team) => ({ team })));
  expect(calls.every((c) => c.name === 'org_roster')).toBe(true);
  expect(results.map((r) => r.ok)).toEqual(teams.map(() => true));
  expect(new Set(results.map((r) => r.id))).toEqual(new Set(calls.map((c) => c.id)));
  for (const r of results) {
    const call = calls.find((c) => c.id === r.id)!;
    expect(r.result).toEqual({ text: rosterResult(call.args.team) });
  }
  expect(events.find((e) => e.type === 'result')).toMatchObject({ subtype: 'success' });
  expect(events.at(-1)).toMatchObject({ type: 'done', exit_code: 0 });
}

/** Parallel calls: every tool_call frame precedes the first tool_result. */
export function expectAllCallsBeforeResults(turn: CallerToolTurn, n: number): void {
  const kinds = turn.events
    .filter((e) => e.type === 'tool_call' || e.type === 'tool_result')
    .map((e) => e.type);
  expect(kinds).toEqual([...Array(n).fill('tool_call'), ...Array(n).fill('tool_result')]);
}
