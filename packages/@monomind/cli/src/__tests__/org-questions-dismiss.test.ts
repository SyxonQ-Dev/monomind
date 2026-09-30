// #572: `monomind org questions dismiss`, the dashboard's dismiss route and
// the offline answer/dismiss paths for a role removed from the org definition.

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { orgCommand } from '../commands/org.js';
import { answerAction, dismissAction } from '../commands/org-observe.js';
import type { CommandContext } from '../types.js';
import * as hil from '../ui/org-hil.mjs';
import { handleOrgRoutes } from '../ui/routes-org.mjs';

const ORG = 'testorg';
let cwd: string;
let prevBroker: string | undefined;

const orgDir = () => join(cwd, '.monomind/orgs', ORG);
const qPath = () => join(orgDir(), 'questions.json');
const inboxPath = () => join(orgDir(), 'inbox.jsonl');
const questions = () =>
  (JSON.parse(readFileSync(qPath(), 'utf8')) as { questions: Array<Record<string, unknown>> })
    .questions;

const question = (id: string, role: string, answer: string | null = null) => ({
  questionId: id,
  role,
  question: `q ${id}`,
  ts: 1,
  answer,
  answeredAt: null,
  blocking: true,
});

const ctx = (args: string[], flags: Record<string, unknown> = {}): CommandContext => ({
  args,
  flags: { _: [], ...flags },
  cwd,
  interactive: false,
});

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), 'org-dismiss-572-'));
  prevBroker = process.env.MONOMIND_ORGRT_BROKER_DIR;
  process.env.MONOMIND_ORGRT_BROKER_DIR = join(cwd, 'broker');
  mkdirSync(orgDir(), { recursive: true });
  writeFileSync(
    join(cwd, '.monomind/orgs', `${ORG}.json`),
    JSON.stringify({ name: ORG, goal: 'g', roles: [{ id: 'coder' }, { id: 'boss' }] }),
  );
  writeFileSync(
    qPath(),
    JSON.stringify({
      questions: [
        question('q1', 'coder'),
        question('q2', 'ghost'),
        question('q3', 'coder', 'done'),
      ],
    }),
  );
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  if (prevBroker === undefined) delete process.env.MONOMIND_ORGRT_BROKER_DIR;
  else process.env.MONOMIND_ORGRT_BROKER_DIR = prevBroker;
  rmSync(cwd, { recursive: true, force: true });
});

describe('org questions dismiss (CLI, org not running)', () => {
  it('is wired as a subcommand of `org questions`', () => {
    const qs = orgCommand.subcommands?.find((c) => c.name === 'questions');
    expect(qs?.subcommands?.map((c) => c.name)).toContain('dismiss');
  });

  it('records the dismissal and queues a note for the asking role', async () => {
    const res = await dismissAction(ctx([ORG, 'q1'], { reason: 'moot' }), ORG);
    expect(res.success).toBe(true);
    const q1 = questions().find((q) => q.questionId === 'q1');
    expect(q1).toMatchObject({
      state: 'dismissed',
      dismissReason: 'moot',
      answer: null,
      resolvedBy: 'human',
    });
    expect(typeof q1?.dismissedAt).toBe('number');
    const inbox = readFileSync(inboxPath(), 'utf8');
    expect(inbox).toContain('dismissed:q1');
    expect(inbox).toContain('moot');
    // siblings untouched
    expect(questions().map((q) => q.questionId)).toEqual(['q1', 'q2', 'q3']);
  });

  it("dismisses a removed role's question without queueing anything", async () => {
    const res = await dismissAction(ctx([ORG, 'q2']), ORG);
    expect(res.success).toBe(true);
    expect(questions().find((q) => q.questionId === 'q2')?.state).toBe('dismissed');
    expect(existsSync(inboxPath())).toBe(false);
  });

  it('fails with a clear message for an unknown or already answered id', async () => {
    const unknown = await dismissAction(ctx([ORG, 'q-nope']), ORG);
    expect(unknown).toEqual({ success: false, message: 'question not found' });
    const answered = await dismissAction(ctx([ORG, 'q3']), ORG);
    expect(answered).toEqual({ success: false, message: 'question "q3" was already answered' });
    const again = await dismissAction(ctx([ORG, 'q1']), ORG).then(() =>
      dismissAction(ctx([ORG, 'q1']), ORG),
    );
    expect(again).toEqual({ success: false, message: 'question "q1" was already dismissed' });
  });

  it('refuses to answer a dismissed question', async () => {
    await dismissAction(ctx([ORG, 'q1']), ORG);
    const res = await answerAction(ctx([ORG, 'q1', 'late']), ORG);
    expect(res).toEqual({ success: false, message: 'question "q1" was already dismissed' });
  });
});

describe('org answer — removed role (CLI, org not running)', () => {
  it('records the answer and skips queueing instead of failing', async () => {
    const res = await answerAction(ctx([ORG, 'q2', 'yes']), ORG);
    expect(res.success).toBe(true);
    expect(questions().find((q) => q.questionId === 'q2')?.answer).toBe('yes');
    expect(existsSync(inboxPath())).toBe(false);
  });
});

describe('dashboard dismiss (org-hil + route)', () => {
  it('dismisses offline and queues a note', async () => {
    await expect(hil.dismissQuestion(cwd, ORG, 'q1', 'no longer relevant')).resolves.toEqual({
      delivery: 'queued',
      role: 'coder',
    });
    expect(questions().find((q) => q.questionId === 'q1')).toMatchObject({
      state: 'dismissed',
      resolvedBy: hil.DASHBOARD_RESOLVER,
    });
  });

  it("answers and dismisses a removed role's question without queueing", async () => {
    await expect(hil.answerQuestion(cwd, ORG, 'q2', 'y')).resolves.toEqual({
      delivery: 'skipped',
      role: 'ghost',
    });
    expect(existsSync(inboxPath())).toBe(false);
    await expect(hil.dismissQuestion(cwd, ORG, 'q2')).rejects.toThrow(/already answered/);
  });

  it('POST /api/questions/dismiss answers 409 for an answered question and 404 for an unknown one', async () => {
    const post = async (body: unknown) => {
      const payload = JSON.stringify(body);
      const req: any = {
        method: 'POST',
        url: '/api/questions/dismiss',
        async *[Symbol.asyncIterator]() {
          yield payload;
        },
      };
      const res: any = { statusCode: 0, body: '' };
      res.writeHead = (c: number) => {
        res.statusCode = c;
      };
      res.end = (c?: string) => {
        if (c) res.body += c;
      };
      const events: any[] = [];
      const c = {
        projectDir: cwd,
        appendToFile: async () => {},
        broadcastMm: (e: any) => events.push(e),
      };
      expect(await handleOrgRoutes(req, res, '/api/questions/dismiss', null, c)).toBe(true);
      return { status: res.statusCode, body: JSON.parse(res.body), events };
    };
    expect((await post({ org: ORG, questionId: 'q3' })).status).toBe(409);
    expect((await post({ org: ORG, questionId: 'q-nope' })).status).toBe(404);
    const ok = await post({ org: ORG, questionId: 'q1', reason: 'moot' });
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ ok: true, delivery: 'queued', role: 'coder' });
    expect(ok.events.some((e) => e.type === 'org:question-answered' && e.dismissed)).toBe(true);
  });
});
