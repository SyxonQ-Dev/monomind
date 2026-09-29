// packages/@monomind/cli/__tests__/orgrt/authority-mask.test.ts
/**
 * Human authority (operator credentials, the dashboard's human-auth secret,
 * the decision files) is kept from EVERY role: the SDK sandbox carries it for
 * Claude roles below push; everything else runs inside a minimal bubblewrap
 * layer (authority-mask.ts). The end-to-end cases run the real bwrap.
 */
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ClaudeAgentRunner } from '../../src/orgrt/agent-runner.js';
import {
  authorityFilePaths,
  authorityMaskArgs,
  authorityMaskAvailability,
  ensureAuthorityDirs,
  isAuthorityFile,
  maskedCommand,
} from '../../src/orgrt/authority-mask.js';
import { OrgBus } from '../../src/orgrt/bus.js';
import { prepareGitGuard, gitCommonDir } from '../../src/orgrt/git-guard.js';
import { PolicyEngine } from '../../src/orgrt/policy.js';
import { buildClaudeRestrictions, roleAuthorityMask } from '../../src/orgrt/role-sandbox.js';
import type { BusEvent } from '../../src/orgrt/types.js';

const scratch = (p: string) => realpathSync(mkdtempSync(join(tmpdir(), p)));

/** A fake $HOME and project with every kind of human-authority file. */
function world() {
  const home = scratch('am-home-');
  const root = scratch('am-root-');
  const env = {} as NodeJS.ProcessEnv;
  ensureAuthorityDirs(home, env);
  writeFileSync(join(home, '.monomind/orgrt-operator/acme.json'), '{"credential":"OPERATOR"}');
  writeFileSync(join(home, '.monomind/dashboard-auth/secret'), 'HUMAN');
  mkdirSync(join(root, '.monomind/orgs/acme'), { recursive: true });
  writeFileSync(join(root, '.monomind/dashboard-token'), 'TOKEN');
  writeFileSync(join(root, '.monomind/orgs/acme/gates.json'), '{"gates":[]}');
  writeFileSync(join(root, '.monomind/orgs/acme/inbox.jsonl'), '');
  writeFileSync(join(root, '.monomind/orgs/acme.json'), '{"name":"acme"}');
  writeFileSync(join(root, '.monomind/orgs/acme/runtime.json'), '{}');
  return { home, root, env };
}

/** #498: every authority file under .monomind/orgs/, and why it is one. */
const AUTHORITY = [
  'acme.json', // the org definition: every role's own policy
  'acme.yaml',
  'acme-state.json', // org artifacts beside the definition
  'acme-secrets.json',
  'acme-runstate.json',
  'acme-threads.jsonl',
  'remote-hosts.json',
  'acme/gates.json', // a human's decisions
  'acme/approvals.json',
  'acme/questions.json',
  'acme/inbox.jsonl',
  'acme/decisions.jsonl',
  'acme/runtime.json', // the resume checkpoint
  'acme/history.jsonl',
  'acme/idle-watchdog.json',
  'acme/run-1/bus.jsonl', // the run's event log, replayed from checkpoints
  'acme/run-1/sessions.json',
  'acme/git-guard/coder/hooks/pre-push', // the hooks that enforce policy.git
  'acme-memory/runtime.json',
];
/** Paths under .monomind/orgs/ that roles legitimately write. */
const ROLE_WRITABLE = [
  'acme/reports/2.19.0/summary.md', // the release org's reports
  'acme/work/src/packages/x/src/a.ts', // task artifacts and checkouts
  'acme/work/src/.monomind/config.json',
  'acme/workspace/notes.md', // run_config.workspace: 'isolated'
  'acme/worktree/src/a.ts', // run_config.workspace: 'worktree'
  'acme/.mail/m1.md',
  'acme/run-1/scratch.txt',
  'acme-memory/tacit.md', // the org's PARA memory (mastermind-memory)
  'acme-memory/knowledge/index.md',
];

describe('isAuthorityFile', () => {
  it.each(AUTHORITY)('protects %s', (f) => {
    expect(isAuthorityFile(`/p/.monomind/orgs/${f}`)).toBe(true);
  });
  it.each(ROLE_WRITABLE)('leaves %s to the roles', (f) => {
    expect(isAuthorityFile(`/p/.monomind/orgs/${f}`)).toBe(false);
  });
  it('matches nothing outside .monomind/orgs/', () => {
    expect(isAuthorityFile('/p/src/gates.json')).toBe(false);
    expect(isAuthorityFile('/p/.monomind/config.json')).toBe(false);
    expect(isAuthorityFile('/p/orgs/acme.json')).toBe(false);
  });
});

describe('file tools cannot write authority files (#498)', () => {
  /** A project whose org root holds every authority file, plus the role-
   *  writable dirs; the role's workdir is `<root>/app`. */
  function orgTree() {
    const root = scratch('am-org-');
    for (const f of [...AUTHORITY, ...ROLE_WRITABLE]) {
      const p = join(root, '.monomind/orgs', f);
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, 'ORIGINAL');
    }
    mkdirSync(join(root, 'app'), { recursive: true });
    return root;
  }
  const engine = (root: string, policy: Record<string, unknown>, cwd = join(root, 'app')) =>
    new PolicyEngine('coder', policy as any, new OrgBus('o', 'r', scratch('am-bus-')), cwd, [root]);
  const write = (p: PolicyEngine, file: string) =>
    p.decide('Write', { file_path: file, content: '{}' });
  const edit = (p: PolicyEngine, file: string) =>
    p.decide('Edit', { file_path: file, old_string: 'ORIGINAL', new_string: 'x' });

  const scopes: Array<[string, (root: string) => PolicyEngine]> = [
    ["fileWrite ['../**'] from a subdir", (root) => engine(root, { fileWrite: ['../**'] })],
    ['the default unrestricted scope at the org root', (root) => engine(root, {}, root)],
    ['a directory scope covering the org root', (root) => engine(root, { fileWrite: ['.monomind/**'] }, root)],
    ['an absolute glob over .monomind/orgs', (root) => engine(root, { fileWrite: [`${root}/.monomind/orgs/**`] })],
  ];

  it.each(scopes)('denies Write, Edit, MultiEdit and NotebookEdit on every authority file with %s', async (_, make) => {
    const root = orgTree();
    const p = make(root);
    for (const f of AUTHORITY) {
      const file = join(root, '.monomind/orgs', f);
      const w = await write(p, file);
      expect(w.behavior, `Write ${f}`).toBe('deny');
      expect((w as { message: string }).message).toMatch(/org authority state/);
      expect((await edit(p, file)).behavior, `Edit ${f}`).toBe('deny');
      expect((await p.decide('MultiEdit', { file_path: file, edits: [] })).behavior, `MultiEdit ${f}`).toBe('deny');
      expect((await p.decide('NotebookEdit', { notebook_path: file, new_source: '' })).behavior, `NotebookEdit ${f}`).toBe('deny');
      expect((await p.decide('Read', { file_path: file })).behavior, `Read ${f}`).toBe('allow');
    }
  });

  it.each(scopes)('still allows the role-writable paths with %s', async (_, make) => {
    const root = orgTree();
    const p = make(root);
    for (const f of ROLE_WRITABLE) {
      const file = join(root, '.monomind/orgs', f);
      expect((await write(p, file)).behavior, `Write ${f}`).toBe('allow');
      expect((await edit(p, file)).behavior, `Edit ${f}`).toBe('allow');
    }
  });

  it('denies a new org definition, not just the existing ones', async () => {
    const root = orgTree();
    const p = engine(root, { fileWrite: ['../**'] });
    expect((await write(p, join(root, '.monomind/orgs/rogue.json'))).behavior).toBe('deny');
  });

  it('denies a write through a symlink to an authority file, or through a symlinked dir', async () => {
    const root = orgTree();
    const reports = join(root, '.monomind/orgs/acme/reports');
    symlinkSync(join(root, '.monomind/orgs/acme.json'), join(reports, 'def.json'));
    symlinkSync(join(root, '.monomind/orgs'), join(reports, 'orgs-link'));
    const p = engine(root, { fileWrite: ['.monomind/orgs/acme/reports/**'] }, root);
    expect((await write(p, join(reports, 'def.json'))).behavior).toBe('deny');
    expect((await edit(p, join(reports, 'def.json'))).behavior).toBe('deny');
    expect((await write(p, join(reports, 'orgs-link/acme/decisions.jsonl'))).behavior).toBe('deny');
    expect((await write(p, join(reports, 'orgs-link/new-org.json'))).behavior).toBe('deny');
    expect((await write(p, join(reports, 'real.md'))).behavior).toBe('allow');
  });

  it('lists every existing authority file for the Bash sandbox and the mask', () => {
    const root = orgTree();
    const paths = authorityFilePaths(root);
    const orgs = join(root, '.monomind/orgs');
    for (const f of AUTHORITY.filter((f) => !f.includes('git-guard')))
      expect(paths, f).toContain(join(orgs, f));
    expect(paths).toContain(join(orgs, 'acme/git-guard'));
    for (const f of ROLE_WRITABLE) expect(paths, f).not.toContain(join(orgs, f));
  });
});

describe.runIf(authorityMaskAvailability().available)('the bubblewrap mask (real bwrap)', () => {
  const inMask = (w: ReturnType<typeof world>, script: string) => {
    const [cmd, argv] = maskedCommand(
      authorityMaskArgs({ home: w.home, env: w.env, roots: [w.root], orgRoot: w.root }),
      'bash',
      ['-c', script],
    );
    return spawnSync(cmd, argv, { encoding: 'utf8' });
  };

  it('hides the credentials, including a file created after the mask was built', () => {
    const w = world();
    const args = authorityMaskArgs({ home: w.home, env: w.env, roots: [w.root], orgRoot: w.root });
    writeFileSync(join(w.home, '.monomind/orgrt-operator/late.json'), 'LATE');
    const [cmd, argv] = maskedCommand(args, 'bash', [
      '-c',
      `cat ${w.home}/.monomind/orgrt-operator/* ${w.home}/.monomind/dashboard-auth/* ${w.root}/.monomind/dashboard-token 2>/dev/null; true`,
    ]);
    const out = spawnSync(cmd, argv, { encoding: 'utf8' }).stdout;
    expect(out).not.toMatch(/OPERATOR|HUMAN|TOKEN|LATE/);
  });

  it('makes the decision files unwritable and unremovable, and leaves other work alone', () => {
    const w = world();
    const gates = join(w.root, '.monomind/orgs/acme/gates.json');
    const r = inMask(
      w,
      `echo forged > ${gates}; rm -f ${gates}; mkdir -p ${w.root}/work && echo ok > ${w.root}/work/out.txt`,
    );
    expect(readFileSync(gates, 'utf8')).toBe('{"gates":[]}');
    expect(readFileSync(join(w.root, 'work/out.txt'), 'utf8')).toBe('ok\n');
    expect(r.stderr).toMatch(/Read-only|busy/i);
  });

  it('makes the org definition and runtime state unwritable too (#498)', () => {
    const w = world();
    const def = join(w.root, '.monomind/orgs/acme.json');
    const rt = join(w.root, '.monomind/orgs/acme/runtime.json');
    mkdirSync(join(w.root, '.monomind/orgs/acme/reports'));
    inMask(
      w,
      `echo forged > ${def}; echo forged > ${rt}; rm -f ${def}; echo ok > ${w.root}/.monomind/orgs/acme/reports/r.md`,
    );
    expect(readFileSync(def, 'utf8')).toBe('{"name":"acme"}');
    expect(readFileSync(rt, 'utf8')).toBe('{}');
    expect(readFileSync(join(w.root, '.monomind/orgs/acme/reports/r.md'), 'utf8')).toBe('ok\n');
  });

  it('writes nothing the role puts in a hidden dir to the real one', () => {
    const w = world();
    inMask(w, `echo planted > ${w.home}/.monomind/dashboard-auth/secret2`);
    expect(existsSync(join(w.home, '.monomind/dashboard-auth/secret2'))).toBe(false);
  });
});

describe('roleAuthorityMask', () => {
  const bus = () => new OrgBus('o', 'r', scratch('am-bus-'));
  const audits = (b: OrgBus) => {
    const seen: BusEvent[] = [];
    b.subscribe((e) => seen.push(e));
    return seen;
  };
  const base = { roleId: 'coder', cwd: '/w', orgRoot: '/w', home: '/h', env: {} };

  it('is not applied on top of the SDK sandbox, nor to an in-process runtime', () => {
    const available = { available: true };
    expect(roleAuthorityMask({ ...base, bus: bus(), inSdkSandbox: true, inProcess: false, availability: available })).toBeUndefined();
    expect(roleAuthorityMask({ ...base, bus: bus(), inSdkSandbox: false, inProcess: true, availability: available })).toBeUndefined();
  });

  it('wraps a role outside the SDK sandbox', () => {
    const mask = roleAuthorityMask({ ...base, bus: bus(), inSdkSandbox: false, inProcess: false, availability: { available: true } });
    expect(mask?.slice(0, 3)).toEqual(['--dev-bind', '/', '/']);
  });

  it('fails open with a loud audit when bubblewrap cannot run', () => {
    const b = bus();
    const seen = audits(b);
    const mask = roleAuthorityMask({ ...base, bus: b, inSdkSandbox: false, inProcess: false, availability: { available: false, reason: 'bwrap not found' } });
    expect(mask).toBeUndefined();
    expect(seen).toContainEqual(expect.objectContaining({ type: 'audit', reason: 'authority-mask-unavailable' }));
  });
});

describe('SDK sandbox and file tools carry the same protection', () => {
  it('denies the dashboard-auth dir and the decision files to a sandboxed Claude role', () => {
    const w = world();
    spawnSync('git', ['init', '-q', w.root]);
    const guard = prepareGitGuard({ level: 'read', stateDir: join(w.root, 'guard'), protectedGitDirs: [gitCommonDir(w.root)!] })!;
    const r = buildClaudeRestrictions(guard, undefined, { cwd: w.root, orgRoot: w.root, home: w.home, tmp: '/tmp', env: w.env }, true);
    const sb = r.sandbox as any;
    expect(sb.filesystem.denyRead).toContain(join(w.home, '.monomind/dashboard-auth'));
    expect(sb.filesystem.denyWrite).toContain(join(w.root, '.monomind/orgs/acme/gates.json'));
    expect(r.disallowedTools).toContain(`Edit(/${join(w.root, '.monomind/orgs/*/gates.json')})`);
    // #498: the org definition and the daemon's state, for Bash and the SDK.
    expect(sb.filesystem.denyWrite).toContain(join(w.root, '.monomind/orgs/acme.json'));
    expect(sb.filesystem.denyWrite).toContain(join(w.root, '.monomind/orgs/acme/runtime.json'));
    expect(r.disallowedTools).toContain(`Edit(/${join(w.root, '.monomind/orgs/*.json')})`);
    expect(r.disallowedTools).toContain(`Edit(/${join(w.root, '.monomind/orgs/*/decisions.jsonl')})`);
    expect(r.disallowedTools).toContain(`Edit(/${join(w.root, '.monomind/orgs/*/git-guard')}/**)`);
    expect(r.disallowedTools).toContain(`Read(/${join(w.home, '.monomind/dashboard-auth')}/**)`);
  });

  it('refuses a file-tool write to a decision file but still allows reading it', async () => {
    const w = world();
    const p = new PolicyEngine('coder', {}, new OrgBus('o', 'r', scratch('am-bus-')), w.root);
    const file = join(w.root, '.monomind/orgs/acme/gates.json');
    expect((await p.decide('Write', { file_path: file, content: '{}' })).behavior).toBe('deny');
    expect((await p.decide('Read', { file_path: file })).behavior).toBe('allow');
  });
});

describe('ClaudeAgentRunner', () => {
  it('launches the Claude Code process inside the mask when it is given one', async () => {
    let options: any;
    const runner = new ClaudeAgentRunner(((a: any) => {
      options = a.options;
      return (async function* () {})();
    }) as any);
    const run = (authorityMask?: string[]) =>
      runner.run({ tools: [], prompt: (async function* () {})(), systemPrompt: '', cwd: '/tmp', env: {}, maxTurns: 1, authorityMask } as any);
    for await (const _ of run(['--dev-bind', '/', '/']));
    expect(typeof options.spawnClaudeCodeProcess).toBe('function');
    for await (const _ of run(undefined));
    expect('spawnClaudeCodeProcess' in options).toBe(false);
  });
});
