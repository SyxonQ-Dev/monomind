// #572 follow-up (SEC): when the daemon hosting this project's org REFUSES a
// human decision — 403 without the operator credential, for one — `org
// answer`, `org approve`, `org deny` and `org gate-approve/-reject` used to
// fall back to writing the state file directly, resolving the decision without
// the operator check, the audit event or delivery. They must now fail with
// nothing written or queued, and only a daemon that is unreachable (or hosts a
// same-named org from another project) leads to the offline write.

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  answerAction,
  approveAction,
  denyAction,
  gateResolveAction,
} from '../commands/org-observe.js';
import { registerOrg } from '../orgrt/broker.js';
import type { CommandContext } from '../types.js';

const ORG = 'refuseorg';
let cwd: string;
let brokerDir: string;
const prev = {
  broker: process.env.MONOMIND_ORGRT_BROKER_DIR,
  operator: process.env.MONOMIND_ORGRT_OPERATOR_DIR,
};
const orgDir = () => join(cwd, '.monomind/orgs', ORG);
const readOrg = (f: string) => readFileSync(join(orgDir(), f), 'utf8');
const ctx = (args: string[]): CommandContext => ({
  args,
  flags: { _: [] },
  cwd,
  interactive: false,
});

const FILES = {
  'questions.json': {
    questions: [
      { questionId: 'q1', role: 'coder', question: 'ship?', ts: 1, answer: null, answeredAt: null },
    ],
  },
  'approvals.json': {
    approvals: [
      {
        roleId: 'coder',
        action: 'Bash',
        ts: 1,
        approved: null,
        requestId: 'apr-1',
        question: 'ok?',
      },
    ],
  },
  'gates.json': {
    gates: [
      {
        id: 'g1',
        name: 'Publish',
        description: 'go?',
        roleId: 'boss',
        status: 'pending',
        createdAt: 1,
      },
    ],
  },
};

/** A daemon that refuses every call the way server.ts does without the
 *  operator credential. */
async function refusingDaemon(root: string) {
  const urls: string[] = [];
  const server = http.createServer((req, res) => {
    urls.push(req.url ?? '');
    req.resume();
    req.on('end', () => {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'operator credential required' }));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  registerOrg(ORG, url, brokerDir, 'agent-cred', root);
  return { urls, close: () => new Promise<void>((r) => server.close(() => r())) };
}

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), 'org-refusal-572-'));
  brokerDir = join(cwd, 'broker');
  process.env.MONOMIND_ORGRT_BROKER_DIR = brokerDir;
  process.env.MONOMIND_ORGRT_OPERATOR_DIR = join(cwd, 'operator');
  mkdirSync(orgDir(), { recursive: true });
  writeFileSync(
    join(cwd, '.monomind/orgs', `${ORG}.json`),
    JSON.stringify({ name: ORG, goal: 'g', roles: [{ id: 'coder' }, { id: 'boss' }] }),
  );
  for (const [f, data] of Object.entries(FILES))
    writeFileSync(join(orgDir(), f), JSON.stringify(data));
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  for (const [k, v] of [
    ['MONOMIND_ORGRT_BROKER_DIR', prev.broker],
    ['MONOMIND_ORGRT_OPERATOR_DIR', prev.operator],
  ] as const) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  rmSync(cwd, { recursive: true, force: true });
});

const unchanged = () => {
  for (const [f, data] of Object.entries(FILES)) expect(JSON.parse(readOrg(f))).toEqual(data);
  expect(existsSync(join(orgDir(), 'inbox.jsonl'))).toBe(false);
};

describe('a refusing daemon hosting this project’s org', () => {
  const cases: Array<[string, string, () => Promise<{ success: boolean; message?: string }>]> = [
    ['answer', '/api/answer-question', () => answerAction(ctx([ORG, 'q1', 'yes']), ORG)],
    ['approve', '/api/set-approval', () => approveAction(ctx([ORG, 'coder', 'Bash']), ORG)],
    ['deny', '/api/set-approval', () => denyAction(ctx([ORG, 'coder', 'Bash']), ORG)],
    ['gate-approve', '/api/resolve-gate', () => gateResolveAction(ctx([ORG, 'g1']), ORG, true)],
  ];
  it.each(cases)('%s: fails on 403 and writes or queues nothing', async (_n, route, run) => {
    const d = await refusingDaemon(cwd);
    try {
      const res = await run();
      expect(res.success).toBe(false);
      expect(res.message).toMatch(/rejected: operator credential required/);
      expect(d.urls).toEqual([route]);
      unchanged();
    } finally {
      await d.close();
    }
  });
});

describe('a daemon that hosts a same-named org from ANOTHER project', () => {
  it('is not asked; the decision is recorded offline for this project', async () => {
    const d = await refusingDaemon(join(cwd, 'elsewhere'));
    try {
      expect((await answerAction(ctx([ORG, 'q1', 'yes']), ORG)).success).toBe(true);
      expect((await approveAction(ctx([ORG, 'coder', 'Bash']), ORG)).success).toBe(true);
      expect(d.urls).toEqual([]);
      expect(JSON.parse(readOrg('questions.json')).questions[0].answer).toBe('yes');
      expect(JSON.parse(readOrg('approvals.json')).approvals[0].approved).toBe(true);
    } finally {
      await d.close();
    }
  });
});
