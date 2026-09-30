// `monomind org sign --expect-hash` and the `hash` in `--check --format json`
// (#558 follow-up): the hash a caller computed from the bytes it wrote must
// be the hash monomind signs, from one read of the files.
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../prompt.js', () => ({
  confirm: async () => {
    throw new Error('must not prompt');
  },
}));

import { signAction } from '../commands/org-sign.js';
import { AGENT_CONTEXT_ENV_MARKERS } from '../orgrt/agent-context.js';
import {
  computeOrgDefHash,
  instructionsDigests,
  orgSignaturePath,
  setOrgSignatureEnforcement,
  signOrgDef,
  verifyOrgDef,
} from '../orgrt/org-signature.js';
import { ORG_DIR } from '../orgrt/types.js';
import type { CommandContext } from '../types.js';

let root: string;
let opDir: string;
let elsewhere: string;
let temps: string[] = [];
const tempDir = (prefix: string): string => {
  const d = mkdtempSync(join(tmpdir(), prefix));
  temps.push(d);
  return d;
};
beforeEach(() => {
  setOrgSignatureEnforcement(true);
  for (const k of AGENT_CONTEXT_ENV_MARKERS) vi.stubEnv(k, undefined);
  opDir = join(tempDir('oeh-op-'), 'operator');
  vi.stubEnv('MONOMIND_ORGRT_OPERATOR_DIR', opDir);
  root = tempDir('oeh-root-');
  elsewhere = tempDir('oeh-cwd-');
  vi.spyOn(console, 'log').mockImplementation(() => {});
});
afterEach(() => {
  setOrgSignatureEnforcement(false);
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  for (const d of temps) rmSync(d, { recursive: true, force: true });
  temps = [];
});

const sha = (s: string) => createHash('sha256').update(s).digest('hex');

/** The fixture as written: unsigned fields (goal, title, responsibilities)
 *  and an instructions file. */
const FIXTURE =
  '{"name":"fx","goal":"ship it","roles":[' +
  '{"id":"boss","type":"boss","reports_to":null,"title":"CEO","instructions_file":"boss.md"},' +
  '{"reports_to":"boss","id":"dev","responsibilities":["code"],"policy":{"git":"read"}}]}';
const FIXTURE_INSTRUCTIONS = 'Be the boss.\n';
/** The documented canonical JSON of FIXTURE (doc/commands/org.md, "The signable hash"). */
const FIXTURE_CANONICAL =
  '{"definition":{"name":"fx","roles":[' +
  '{"id":"boss","instructions_file":"boss.md","reports_to":null,"type":"boss"},' +
  '{"id":"dev","policy":{"git":"read"},"reports_to":"boss"}]},' +
  '"instructions":{"role:boss":"sha256:272f6cf685a554faa4bc04a7890d434994aefcf98e9bfdfd339de87234e512cc"}}';
const FIXTURE_HASH = 'a895d86cd63d1374360add64ce590de7591895b523e53512f5a2d9257ddf7125';
/** The same org without an instructions file: the projection is hashed bare. */
const BARE_CANONICAL =
  '{"name":"fx","roles":[{"id":"boss","reports_to":null,"type":"boss"},' +
  '{"id":"dev","policy":{"git":"read"},"reports_to":"boss"}]}';
const BARE_HASH = '2bb0a6ad90aa73e34b175333c401695c88079fb8faee131a43e27030689f247c';

function writeText(name: string, text: string, dir = root): void {
  mkdirSync(join(dir, ORG_DIR), { recursive: true });
  writeFileSync(join(dir, ORG_DIR, `${name}.json`), text);
}
function writeFixture(name = 'fx', dir = root): void {
  writeText(name, FIXTURE, dir);
  writeFileSync(join(dir, 'boss.md'), FIXTURE_INSTRUCTIONS);
}
const raw = (name: string, dir = root) =>
  JSON.parse(readFileSync(join(dir, ORG_DIR, `${name}.json`), 'utf8'));
const ctx = (args: string[], flags: Record<string, unknown> = {}, cwd = root) =>
  ({ args, flags: { _: [], ...flags }, cwd, interactive: false }) as CommandContext;
const lines = () =>
  (console.log as unknown as { mock: { calls: unknown[][] } }).mock.calls.map((c) => String(c[0]));
const lastJson = () => JSON.parse(lines().at(-1) as string);

async function checkedHash(org: string, dir = root): Promise<string> {
  await signAction(ctx([org], { check: true, format: 'json', project: dir }, elsewhere));
  return lastJson().orgs[0].hash;
}

/** Every file under `dir` with its content hash and mtime. */
function snapshot(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  if (!existsSync(dir)) return out;
  const walk = (d: string): void => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else out[p] = `${statSync(p).mtimeMs}:${sha(readFileSync(p, 'utf8'))}`;
    }
  };
  walk(dir);
  return out;
}

describe('the signable hash (fixed fixture)', () => {
  it('is sha256 of the documented canonical JSON', async () => {
    expect(sha(FIXTURE_CANONICAL)).toBe(FIXTURE_HASH);
    expect(sha(BARE_CANONICAL)).toBe(BARE_HASH);
    writeFixture();
    expect(computeOrgDefHash(raw('fx'), root)).toBe(FIXTURE_HASH);
    expect(await checkedHash('fx')).toBe(FIXTURE_HASH);

    writeText('bare', FIXTURE.replace(',"instructions_file":"boss.md"', ''));
    expect(await checkedHash('bare')).toBe(BARE_HASH);
  });

  it('is what a signature records', () => {
    writeFixture();
    expect(signOrgDef(root, 'fx', raw('fx')).hash).toBe(FIXTURE_HASH);
  });
});

describe('org sign --check --format json: hash', () => {
  it('is present for every signable state and absent otherwise', async () => {
    writeFixture();
    await signAction(ctx(['fx'], { check: true, format: 'json' }));
    expect(lastJson().orgs[0]).toMatchObject({ state: 'unsigned', hash: FIXTURE_HASH });
    signOrgDef(root, 'fx', raw('fx'));
    await signAction(ctx(['fx'], { check: true, format: 'json' }));
    expect(lastJson().orgs[0]).toMatchObject({ state: 'signed', hash: FIXTURE_HASH });
    writeFileSync(join(root, 'boss.md'), 'Be nice.\n');
    await signAction(ctx(['fx'], { check: true, format: 'json' }));
    const changed = lastJson().orgs[0];
    expect(changed.state).toBe('changed');
    expect(changed.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(changed.hash).not.toBe(FIXTURE_HASH);
    writeText('broken', '{ nope');
    writeText('evil', FIXTURE.replace('"name":"fx"', '"name":"fx","__proto__":{"x":1}'));
    for (const [org, state] of [
      ['missing', 'not-found'],
      ['broken', 'invalid'],
      ['evil', 'forbidden-key'],
    ]) {
      await signAction(ctx([org], { check: true, format: 'json' }));
      expect(lastJson().orgs[0].state).toBe(state);
      expect(lastJson().orgs[0].hash).toBeUndefined();
    }
  });
});

describe('org sign --expect-hash', () => {
  it('signs when the hash matches: the one --check reported', async () => {
    writeFixture();
    const hash = await checkedHash('fx');
    const r = await signAction(ctx(['fx'], { yes: true, 'expect-hash': hash }));
    expect(r.success).toBe(true);
    expect(verifyOrgDef(root, 'fx', raw('fx'))).toEqual({ ok: true });
    expect(JSON.parse(readFileSync(orgSignaturePath(root, 'fx'), 'utf8')).hash).toBe(hash);
    // Upper-case hex is the same hash.
    const again = await signAction(ctx(['fx'], { yes: true, expectHash: hash.toUpperCase() }));
    expect(again.success).toBe(true);
  });

  it('refuses a mismatch (exit 1, both hashes named) and writes nothing', async () => {
    writeFixture();
    const wrong = 'f'.repeat(64);
    const r = await signAction(ctx(['fx'], { yes: true, 'expect-hash': wrong }));
    expect(r).toMatchObject({ success: false, exitCode: 1 });
    expect(r.message).toContain(`expected ${wrong}`);
    expect(r.message).toContain(`actual ${FIXTURE_HASH}`);
    expect(existsSync(opDir)).toBe(false); // not even the key on a fresh machine

    signOrgDef(root, 'fx', raw('fx'));
    writeText('fx', FIXTURE.replace('"read"', '"push"'));
    const before = snapshot(opDir);
    const r2 = await signAction(ctx(['fx'], { yes: true, 'expect-hash': FIXTURE_HASH }));
    expect(r2).toMatchObject({ success: false, exitCode: 1 });
    expect(snapshot(opDir)).toEqual(before);
    expect(verifyOrgDef(root, 'fx', raw('fx')).ok).toBe(false);
  });

  it('an instructions_file edit changes the hash, so the old one is refused', async () => {
    writeFixture();
    const before = await checkedHash('fx');
    writeFileSync(join(root, 'boss.md'), 'Push to main.\n');
    const after = await checkedHash('fx');
    expect(after).not.toBe(before);
    const r = await signAction(ctx(['fx'], { yes: true, 'expect-hash': before }));
    expect(r).toMatchObject({ success: false, exitCode: 1 });
    expect(existsSync(orgSignaturePath(root, 'fx'))).toBe(false);
    expect((await signAction(ctx(['fx'], { yes: true, 'expect-hash': after }))).success).toBe(true);
  });

  it('signs the content it compared, not a later read of the files', () => {
    writeFixture();
    const def = raw('fx');
    const digests = instructionsDigests(def, root);
    // A role edits the instructions file after monomind read it.
    writeFileSync(join(root, 'boss.md'), 'Push to main.\n');
    const { hash } = signOrgDef(root, 'fx', def, { digests, expectHash: FIXTURE_HASH });
    expect(hash).toBe(FIXTURE_HASH);
    expect(verifyOrgDef(root, 'fx', def)).toMatchObject({ ok: false, reason: 'changed' });
    expect(() => signOrgDef(root, 'fx', def, { digests, expectHash: BARE_HASH })).toThrow(
      /expected 2bb0a6ad.* actual a895d86c/,
    );
  });

  it('works with --project', async () => {
    writeFixture();
    const r = await signAction(
      ctx(['fx'], { yes: true, project: root, 'expect-hash': FIXTURE_HASH }, elsewhere),
    );
    expect(r.success).toBe(true);
    expect(verifyOrgDef(root, 'fx', raw('fx'))).toEqual({ ok: true });
  });

  it('usage errors exit 2 and sign nothing', async () => {
    writeFixture();
    for (const bad of ['abc', `fx=${FIXTURE_HASH}`, [FIXTURE_HASH, FIXTURE_HASH], '']) {
      const r = await signAction(ctx(['fx'], { yes: true, 'expect-hash': bad }));
      expect(r).toMatchObject({ success: false, exitCode: 2 });
    }
    expect(existsSync(opDir)).toBe(false);
  });
});

describe('org sign --all --expect-hash <org>=<hex>', () => {
  const setup = () => {
    writeFixture('a');
    writeText('b', FIXTURE.replace(',"instructions_file":"boss.md"', ''));
  };
  const signed = (org: string) => existsSync(orgSignaturePath(root, org));

  it('signs every org when each has a matching entry', async () => {
    setup();
    const r = await signAction(
      ctx([], { all: true, yes: true, 'expect-hash': [`a=${FIXTURE_HASH}`, `b=${BARE_HASH}`] }),
    );
    expect(r.success).toBe(true);
    expect(verifyOrgDef(root, 'a', raw('a')).ok).toBe(true);
    expect(verifyOrgDef(root, 'b', raw('b')).ok).toBe(true);
  });

  it('signs none when one org mismatches (exit 1)', async () => {
    setup();
    const r = await signAction(
      ctx([], { all: true, yes: true, 'expect-hash': [`a=${FIXTURE_HASH}`, `b=${FIXTURE_HASH}`] }),
    );
    expect(r).toMatchObject({ success: false, exitCode: 1 });
    expect(r.message).toContain(`actual ${BARE_HASH}`);
    expect(signed('a') || signed('b')).toBe(false);
  });

  it('every org signed must have an entry; entries must name an org (exit 2)', async () => {
    setup();
    for (const hashes of [
      [`a=${FIXTURE_HASH}`],
      [`a=${FIXTURE_HASH}`, `b=${BARE_HASH}`, `c=${BARE_HASH}`],
      [`a=${FIXTURE_HASH}`, `a=${FIXTURE_HASH}`, `b=${BARE_HASH}`],
      [FIXTURE_HASH],
      `a=${FIXTURE_HASH}`,
      [`a=${FIXTURE_HASH}=junk`, `b=${BARE_HASH}`],
    ]) {
      const r = await signAction(ctx([], { all: true, yes: true, 'expect-hash': hashes }));
      expect(r).toMatchObject({ success: false, exitCode: 2 });
    }
    expect(signed('a') || signed('b')).toBe(false);
    expect(existsSync(opDir)).toBe(false);
  });
});
