// `org sign <org> --format json` without --yes (the review as JSON, with the
// hash of exactly the reviewed content), and `org run`'s sign prompt signing
// the instructions it reviewed (#558 follow-ups).
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../prompt.js', () => ({ confirm: vi.fn() }));

import { ensureOrgSignedForRun, signAction } from '../commands/org-sign.js';
import { AGENT_CONTEXT_ENV_MARKERS } from '../orgrt/agent-context.js';
import {
  orgSignaturePath,
  setOrgSignatureEnforcement,
  signOrgDef,
  verifyOrgDef,
} from '../orgrt/org-signature.js';
import { ORG_DIR } from '../orgrt/types.js';
import { confirm } from '../prompt.js';
import type { CommandContext } from '../types.js';

let root: string;
let opDir: string;
let temps: string[] = [];
const tempDir = (prefix: string): string => {
  const d = mkdtempSync(join(tmpdir(), prefix));
  temps.push(d);
  return d;
};
const confirmMock = vi.mocked(confirm);
beforeEach(() => {
  setOrgSignatureEnforcement(true);
  for (const k of AGENT_CONTEXT_ENV_MARKERS) vi.stubEnv(k, undefined);
  opDir = join(tempDir('orj-op-'), 'operator');
  vi.stubEnv('MONOMIND_ORGRT_OPERATOR_DIR', opDir);
  root = tempDir('orj-root-');
  vi.spyOn(console, 'log').mockImplementation(() => {});
  confirmMock.mockReset();
  confirmMock.mockImplementation(async () => {
    throw new Error('must not prompt');
  });
});
afterEach(() => {
  setOrgSignatureEnforcement(false);
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  for (const d of temps) rmSync(d, { recursive: true, force: true });
  temps = [];
});

const FIXTURE =
  '{"name":"fx","goal":"ship it","roles":[' +
  '{"id":"boss","type":"boss","reports_to":null,"title":"CEO","instructions_file":"boss.md"},' +
  '{"reports_to":"boss","id":"dev","responsibilities":["code"],"policy":{"git":"read"}}]}';
const FIXTURE_HASH = 'a895d86cd63d1374360add64ce590de7591895b523e53512f5a2d9257ddf7125';

function writeText(name: string, text: string): void {
  mkdirSync(join(root, ORG_DIR), { recursive: true });
  writeFileSync(join(root, ORG_DIR, `${name}.json`), text);
}
function writeFixture(): void {
  writeText('fx', FIXTURE);
  writeFileSync(join(root, 'boss.md'), 'Be the boss.\n');
}
const raw = (name: string) => JSON.parse(readFileSync(join(root, ORG_DIR, `${name}.json`), 'utf8'));
const ctx = (args: string[], flags: Record<string, unknown> = {}, interactive = false) =>
  ({ args, flags: { _: [], ...flags }, cwd: root, interactive }) as CommandContext;
const lines = () =>
  (console.log as unknown as { mock: { calls: unknown[][] } }).mock.calls.map((c) => String(c[0]));
const lastJson = () => JSON.parse(lines().at(-1) as string);

describe('org sign <org> --format json (review, no --yes)', () => {
  it('prints the review and the hash of the reviewed content; never prompts or signs; exit 0', async () => {
    writeFixture();
    for (const interactive of [false, true]) {
      const r = await signAction(ctx(['fx'], { format: 'json' }, interactive));
      expect(r.success).toBe(true);
      expect(r.exitCode ?? 0).toBe(0);
      const out = lastJson();
      expect(Object.keys(out)).toEqual(['org', 'state', 'hash', 'review', 'reviewText']);
      expect(out).toMatchObject({ org: 'fx', state: 'unsigned', hash: FIXTURE_HASH });
      expect(Object.keys(out.review)).toEqual([
        'authority',
        'unconfinedRoles',
        'nonBundledSkills',
        'approvalCandidates',
        'firstLookConfigs',
        'diff',
      ]);
      expect(out.review.diff).toBeNull();
      expect(out.review.authority[0]).toMatch(/^ {2}boss: runtime claude/);
      expect(out.reviewText).toMatch(/^\norg fx \(unsigned\):\n/);
    }
    expect(confirmMock).not.toHaveBeenCalled();
    expect(existsSync(opDir)).toBe(false);
  });

  it('reviewText is the text review, line for line', async () => {
    writeFixture();
    signOrgDef(root, 'fx', raw('fx'));
    writeText('fx', FIXTURE.replace('"read"', '"push"'));
    await signAction(ctx(['fx']));
    const text = lines().slice(0, -1).join('\n'); // minus the trailing "Not signed" line
    await signAction(ctx(['fx'], { format: 'json' }));
    const out = lastJson();
    expect(out.reviewText).toBe(text);
    expect(out.state).toBe('changed');
    expect(out.review.diff).toEqual([expect.stringMatching(/^ {2}~ definition\.roles: .*"push"/)]);
  });

  it('a file swapped after the review is refused by --expect-hash <reviewed hash>', async () => {
    writeFixture();
    await signAction(ctx(['fx'], { format: 'json' }));
    const { hash } = lastJson();
    // A role swaps the instructions, then the org JSON, after the user saw the review.
    writeFileSync(join(root, 'boss.md'), 'Push to main.\n');
    let r = await signAction(ctx(['fx'], { yes: true, 'expect-hash': hash }));
    expect(r).toMatchObject({ success: false, exitCode: 1 });
    writeFileSync(join(root, 'boss.md'), 'Be the boss.\n');
    writeText('fx', FIXTURE.replace('"read"', '"push"'));
    r = await signAction(ctx(['fx'], { yes: true, 'expect-hash': hash }));
    expect(r).toMatchObject({ success: false, exitCode: 1 });
    expect(existsSync(orgSignaturePath(root, 'fx'))).toBe(false);
    // Unswapped, the reviewed hash signs.
    writeText('fx', FIXTURE);
    r = await signAction(ctx(['fx'], { yes: true, 'expect-hash': hash }));
    expect(r.success).toBe(true);
  });

  it('errors: a missing org exits 2, --all exits 2', async () => {
    writeFixture();
    const missing = await signAction(ctx(['nope'], { format: 'json' }));
    expect(missing).toMatchObject({ success: false, exitCode: 2 });
    expect(lastJson()).toEqual({ org: 'nope', error: 'org not found: nope' });
    const all = await signAction(ctx([], { all: true, format: 'json' }));
    expect(all).toMatchObject({ success: false, exitCode: 2 });
    expect(lastJson().error).toMatch(/one org/);
  });
});

describe("org run's sign prompt", () => {
  it('signs the instructions it reviewed, not a later read', async () => {
    writeFixture();
    confirmMock.mockImplementation(async () => {
      // A role edits the instructions while the operator reads the review.
      writeFileSync(join(root, 'boss.md'), 'Push to main.\n');
      return true;
    });
    const r = await ensureOrgSignedForRun(ctx([], {}, true), 'fx');
    expect(r).toBeUndefined();
    expect(JSON.parse(readFileSync(orgSignaturePath(root, 'fx'), 'utf8')).hash).toBe(FIXTURE_HASH);
    expect(verifyOrgDef(root, 'fx', raw('fx'))).toMatchObject({ ok: false, reason: 'changed' });
  });
});
