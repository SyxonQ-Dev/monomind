/**
 * #273: the release org's (then release-gate's) SETUP and CLEAN UP steps told the coordinator to
 * "empty {{home}}/mrg-tmp" — the shared TMPDIR every role (and the agent
 * harness's own per-session sandbox bridge) writes into. During the 2.11.1 run,
 * `find {{home}}/mrg-tmp -mindepth 1 -delete` deleted the live socket of the
 * session running it and permanently broke that role's Bash tool for the rest of
 * the ~4 hour run.
 *
 * The shipped config must never instruct a role to empty a directory that holds
 * its own scratch or any live run's.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const configPath = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'config',
  'orgs',
  'release.json',
);

const raw = readFileSync(configPath, 'utf8');

/** The shared scratch root the org mandates as TMPDIR for every command
 *  ({{home}} is expanded by the runtime; see orgrt/prompt-vars.ts). Escaped
 *  for use inside the RegExps below. */
const SHARED_TMPDIR = '\\{\\{home\\}\\}/mrg-tmp';

describe('release org config', () => {
  const def = JSON.parse(raw) as {
    name: string;
    roles: { id: string; responsibilities?: string[] }[];
  };

  it('is valid JSON with the expected roles', () => {
    expect(def.name).toBe('release');
    expect(def.roles.map((r) => r.id)).toContain('release-captain');
  });

  const instructions = (): string[] =>
    def.roles.flatMap((r) => (r.responsibilities ?? []).map((line) => `${r.id}: ${line}`));

  /** A blanket-wipe phrasing only counts as an instruction when it is not
   *  being forbidden — the config names these commands in order to ban them. */
  const forbiddenNearby = (line: string, at: number): boolean =>
    /\b(?:no|not|never)\b[^.]{0,40}$/i.test(line.slice(Math.max(0, at - 60), at));

  it('never tells a role to empty or recursively delete the shared TMPDIR root', () => {
    const wipePatterns = [
      new RegExp(`empty\\s+(?:it\\s+)?${SHARED_TMPDIR}(?![\\w/-])`, 'gi'),
      new RegExp(`rm\\s+-rf\\s+${SHARED_TMPDIR}(?:/\\*)?(?![\\w/-])`, 'g'),
      new RegExp(`${SHARED_TMPDIR}\\s+-mindepth\\s+1\\s+-delete`, 'g'),
    ];
    const offenders = instructions().filter((line) =>
      wipePatterns.some((re) => {
        re.lastIndex = 0;
        for (let m = re.exec(line); m; m = re.exec(line)) {
          if (!forbiddenNearby(line, m.index)) return true;
        }
        return false;
      }),
    );
    expect(offenders).toEqual([]);
  });

  it('spells out the narrow, run-scoped pruning rule instead', () => {
    const all = instructions().join('\n');
    expect(all).toMatch(/issue #273/);
    // The rule has to say both halves: never the root, only this org's own
    // run-scoped subdirectories.
    expect(all).toMatch(new RegExp(`never .{0,120}${SHARED_TMPDIR}`, 'i'));
    expect(all).toMatch(/short-sha/i);
  });

  /** Parallel sessions (2026-09-26, 2.16.7 … 2.16.12 released back to back). */
  describe('parallel sessions', () => {
    const rules = readFileSync(
      join(
        configPath,
        '..',
        '..',
        '..',
        '.monomind',
        'org-skills',
        'monomind-release-rules',
        'SKILL.md',
      ),
      'utf8',
    );
    const role = (id: string) =>
      (def.roles.find((r) => r.id === id)?.responsibilities ?? []).join('\n');

    it('captain takes the release lock before PREFLIGHT and releases it in CLEAN UP', () => {
      const captain = role('release-captain');
      expect(captain.indexOf('RELEASE LOCK')).toBeGreaterThan(-1);
      expect(captain.indexOf('RELEASE LOCK')).toBeLessThan(captain.indexOf('PREFLIGHT —'));
      expect(captain).toMatch(/release the release lock[^.]*and org_complete/);
      expect(rules).toMatch(/node scripts\/release-lock\.mjs acquire --runtime /);
      expect(rules).toMatch(/node scripts\/release-lock\.mjs release --runtime /);
      expect(rules).toMatch(
        /exit 3:[\s\S]{0,400}org_complete` with outcome `partial`, blocker\s+`external`/,
      );
    });

    it('a version named in the task is reported when it differs, never treated as an error', () => {
      expect(rules).toMatch(/VERSION: task named X, npm already has Y, releasing\s+Z/);
      expect(role('release-captain')).not.toMatch(/if the task states one, use it\. /);
    });

    it('local main sync merges with the CHANGELOG.md driver and never rewrites the owner commits', () => {
      expect(rules).toMatch(
        /-c merge\.monomind-changelog\.driver="node SRC\/scripts\/merge-changelog\.mjs %O %A %B"/,
      );
      expect(rules).toMatch(/Never rebase, reset, amend or cherry-pick local main's commits/);
      expect(role('publisher')).not.toMatch(/git merge --no-ff origin\/main/);
      expect(role('publisher')).toMatch(/LOCAL MAIN SYNC[^.]*'Parallel sessions'/);
    });
  });
});
