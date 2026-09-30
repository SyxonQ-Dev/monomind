// #558: `monomind org sign --check` (read-only, machine-readable) and
// `--project <dir>` (sign or check another project root than cwd).
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../prompt.js', () => ({
  confirm: async () => {
    throw new Error('--check must never prompt');
  },
}));

import { signAction } from '../commands/org-sign.js';
import { isReadOnlyProbe } from '../index.js';
import { AGENT_CONTEXT_ENV_MARKERS } from '../orgrt/agent-context.js';
import {
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
beforeEach(() => {
  setOrgSignatureEnforcement(true);
  for (const k of AGENT_CONTEXT_ENV_MARKERS) vi.stubEnv(k, undefined);
  opDir = join(mkdtempSync(join(tmpdir(), 'osk-op-')), 'operator');
  vi.stubEnv('MONOMIND_ORGRT_OPERATOR_DIR', opDir);
  root = mkdtempSync(join(tmpdir(), 'osk-root-'));
  elsewhere = mkdtempSync(join(tmpdir(), 'osk-cwd-'));
  vi.spyOn(console, 'log').mockImplementation(() => {});
});
afterEach(() => {
  setOrgSignatureEnforcement(false);
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

const def = (git = 'read') => ({
  name: 'o',
  goal: 'g',
  roles: [
    { id: 'boss', type: 'boss', reports_to: null },
    { id: 'dev', reports_to: 'boss', policy: { git } },
  ],
});
function writeText(name: string, text: string, dir = root): void {
  mkdirSync(join(dir, ORG_DIR), { recursive: true });
  writeFileSync(join(dir, ORG_DIR, `${name}.json`), text);
}
const writeDef = (name: string, body: unknown = def(), dir = root) =>
  writeText(name, JSON.stringify(body), dir);
const raw = (name: string, dir = root) =>
  JSON.parse(readFileSync(join(dir, ORG_DIR, `${name}.json`), 'utf8'));
const ctx = (args: string[], flags: Record<string, unknown> = {}, cwd = root) =>
  ({ args, flags: { _: [], ...flags }, cwd, interactive: false }) as CommandContext;
const lines = () =>
  (console.log as unknown as { mock: { calls: unknown[][] } }).mock.calls.map((c) => String(c[0]));
const lastJson = () => JSON.parse(lines().at(-1) as string);

/** Every file under `dir` with its size, mode, mtime and content hash. */
function snapshot(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  if (!existsSync(dir)) return out;
  const walk = (d: string): void => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      const st = statSync(p);
      if (e.isDirectory()) {
        out[`${p}/`] = `${st.mode}:${st.mtimeMs}`;
        walk(p);
      } else {
        const h = createHash('sha256').update(readFileSync(p)).digest('hex');
        out[p] = `${st.size}:${st.mode}:${st.mtimeMs}:${h}`;
      }
    }
  };
  walk(dir);
  return out;
}

/** One org per state `--check` reports. */
function writeEveryState(): void {
  writeDef('good');
  signOrgDef(root, 'good', raw('good'));
  writeDef('edited');
  signOrgDef(root, 'edited', raw('edited'));
  writeDef('edited', def('push'));
  writeDef('fresh');
  writeText(
    'evil',
    '{"name":"o","goal":"g","roles":[{"id":"boss","type":"boss","reports_to":null,"__proto__":{"x":1}}]}',
  );
}

describe('org sign --check', () => {
  it('reports each state, with JSON shape and exit codes', async () => {
    writeEveryState();
    const cases: Array<[string, string, number]> = [
      ['good', 'signed', 0],
      ['edited', 'changed', 1],
      ['fresh', 'unsigned', 1],
      ['evil', 'forbidden-key', 1],
      ['missing', 'not-found', 2],
    ];
    for (const [org, state, code] of cases) {
      const r = await signAction(ctx([org], { check: true, format: 'json' }));
      expect(r.exitCode ?? 0).toBe(code);
      expect(r.success).toBe(code === 0);
      const out = lastJson();
      expect(Object.keys(out)).toEqual(['orgs']);
      expect(out.orgs).toHaveLength(1);
      expect(out.orgs[0]).toMatchObject({ org, state });
      if (state === 'signed') {
        expect(out.orgs[0].signedAt).toMatch(/^\d{4}-\d\d-\d\dT/);
        expect(out.orgs[0].message).toBeUndefined();
      } else {
        expect(typeof out.orgs[0].message).toBe('string');
      }
    }
    const changed = await signAction(ctx(['edited'], { check: true, format: 'json' }));
    expect(changed.exitCode).toBe(1);
    expect(lastJson().orgs[0].signedAt).toMatch(/^\d{4}-/);
  });

  it('reports an unparseable definition as invalid', async () => {
    writeText('broken', '{ nope');
    const r = await signAction(ctx(['broken'], { check: true, format: 'json' }));
    expect(r.exitCode).toBe(1);
    expect(lastJson().orgs[0]).toMatchObject({ org: 'broken', state: 'invalid' });
  });

  it('prints one text line per org', async () => {
    writeEveryState();
    await signAction(ctx(['good'], { check: true }));
    expect(lines()).toEqual(['good: signed']);
  });

  it('usage errors exit 2', async () => {
    expect((await signAction(ctx([], { check: true }))).exitCode).toBe(2);
    expect((await signAction(ctx(['../x'], { check: true }))).exitCode).toBe(2);
    const r = await signAction(ctx([], { check: true, format: 'json' }));
    expect(r.exitCode).toBe(2);
    expect(lastJson()).toEqual({ error: expect.stringMatching(/org name required/) });
  });

  it('--check --all checks every org in the project', async () => {
    writeEveryState();
    const r = await signAction(ctx([], { check: true, all: true, format: 'json' }));
    expect(r.exitCode).toBe(1);
    const states = Object.fromEntries(
      lastJson().orgs.map((o: { org: string; state: string }) => [o.org, o.state]),
    );
    expect(states).toEqual({
      edited: 'changed',
      evil: 'forbidden-key',
      fresh: 'unsigned',
      good: 'signed',
    });
  });

  it('--check --all exits 0 when every org is signed and unchanged', async () => {
    for (const n of ['a', 'b']) {
      writeDef(n);
      signOrgDef(root, n, raw(n));
    }
    const r = await signAction(ctx([], { check: true, all: true }));
    expect(r).toEqual({ success: true });
    expect(lines()).toEqual(['a: signed', 'b: signed']);
  });

  it('writes nothing: the operator dir and the project are byte-for-byte the same', async () => {
    writeEveryState();
    const before = { op: snapshot(opDir), root: snapshot(root) };
    for (const args of [['good'], ['edited'], ['fresh'], ['evil'], ['missing'], []]) {
      await signAction(ctx(args, { check: true, all: args.length === 0, format: 'json' }));
      await signAction(ctx(args, { check: true, all: args.length === 0 }));
    }
    expect(snapshot(opDir)).toEqual(before.op);
    expect(snapshot(root)).toEqual(before.root);
  });

  it('writes nothing on a machine that never signed: no operator dir is created', async () => {
    writeDef('fresh');
    const r = await signAction(ctx(['fresh'], { check: true }));
    expect(r.exitCode).toBe(1);
    expect(existsSync(opDir)).toBe(false);
  });

  it('runs inside a role (read-only)', async () => {
    writeEveryState();
    vi.stubEnv('MONOMIND_ORG_ROLE', 'dev');
    const r = await signAction(ctx(['good'], { check: true }));
    expect(r.success).toBe(true);
    expect(lines()).toEqual(['good: signed']);
  });

  it('is a read-only probe for the CLI entry (no update check or subsystem init)', () => {
    expect(isReadOnlyProbe(['org', 'sign', 'o'], { check: true })).toBe(true);
    expect(isReadOnlyProbe(['org', 'sign'], { check: true, all: true })).toBe(true);
    expect(isReadOnlyProbe(['org', 'sign', 'o'], { yes: true })).toBe(false);
    expect(isReadOnlyProbe(['org', 'run', 'o'], { check: true })).toBe(false);
  });
});

describe('org sign --project', () => {
  it('signs the same signature as running from inside the directory', async () => {
    writeDef('o');
    // Through a symlink, from an unrelated cwd: the signature binds the real path.
    const link = join(elsewhere, 'link');
    symlinkSync(root, link);
    const r = await signAction(ctx(['o'], { yes: true, project: link }, elsewhere));
    expect(r.success).toBe(true);
    expect(verifyOrgDef(root, 'o', raw('o'))).toEqual({ ok: true });
    const viaProject = JSON.parse(readFileSync(orgSignaturePath(root, 'o'), 'utf8'));

    expect((await signAction(ctx(['o'], { yes: true }))).success).toBe(true);
    const fromInside = JSON.parse(readFileSync(orgSignaturePath(root, 'o'), 'utf8'));
    const bound = ({ v, org, root: r2, hash }: Record<string, unknown>) => ({
      v,
      org,
      root: r2,
      hash,
    });
    expect(bound(viaProject)).toEqual(bound(fromInside));
  });

  it('checks another project', async () => {
    writeDef('o');
    signOrgDef(root, 'o', raw('o'));
    const r = await signAction(ctx(['o'], { check: true, project: root }, elsewhere));
    expect(r.success).toBe(true);
    expect(lines()).toEqual(['o: signed']);
  });

  it('refuses a directory without .monomind/orgs, or a missing one (exit 2)', async () => {
    for (const flags of [{ check: true }, { yes: true }]) {
      const none = await signAction(ctx(['o'], { ...flags, project: elsewhere }, elsewhere));
      expect(none).toMatchObject({ success: false, exitCode: 2 });
      expect(none.message).toMatch(/has no \.monomind\/orgs directory/);
      const gone = await signAction(
        ctx(['o'], { ...flags, project: join(elsewhere, 'nope') }, elsewhere),
      );
      expect(gone).toMatchObject({ success: false, exitCode: 2 });
    }
  });

  it('still refuses to sign inside a role', async () => {
    writeDef('o');
    vi.stubEnv('MONOMIND_AGENT_EXEC', '1');
    const r = await signAction(ctx(['o'], { yes: true, project: root }, elsewhere));
    expect(r.message).toMatch(/refused: role context/);
    expect(verifyOrgDef(root, 'o', raw('o')).ok).toBe(false);
  });
});
