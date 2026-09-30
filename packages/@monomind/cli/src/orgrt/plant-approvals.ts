// packages/@monomind/cli/src/orgrt/plant-approvals.ts
/**
 * #502 review round 5: the operator approving a path the plant watch
 * (planted-paths.ts) would otherwise quarantine — explicitly, one path at a
 * time, with `monomind org approve-paths <path>…`. Signing an org never
 * approves anything as a side effect.
 *
 * Candidates are the paths the watch would quarantine at its next check:
 * a protected path that was recorded missing and now exists, and a Claude
 * Code global config that was not there at the first look. Before the first
 * look (#548) no Claude config is a candidate: `strayClaudeConfigs` trusts
 * every one present when it records that look.
 */

import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { defaultOperatorDir } from './broker.js';
import {
  claudeConfigCandidates,
  exists,
  isStubOnly,
  readBaseline,
  readConfigRecord,
  writeBaseline,
  writeConfigRecord,
} from './planted-paths.js';

export interface ApprovalCtx {
  root: string;
  operatorDir?: string;
  home?: string;
  env?: NodeJS.ProcessEnv;
}

function ctxOf(c: ApprovalCtx) {
  return {
    root: c.root,
    operatorDir: c.operatorDir ?? defaultOperatorDir(),
    home: c.home ?? homedir(),
    env: c.env ?? process.env,
  };
}

/** What `approve-paths` could newly trust (and the watch would quarantine). */
export function approvalCandidates(c: ApprovalCtx): string[] {
  const { root, operatorDir, home, env } = ctxOf(c);
  const baseline = [...readBaseline(root, operatorDir)].filter((p) => exists(p) && !isStubOnly(p));
  const recorded = readConfigRecord(operatorDir)?.[home];
  const trusted = new Set(recorded ?? []);
  const configs = recorded ? claudeConfigCandidates(home, env).filter((p) => !trusted.has(p)) : [];
  return [...new Set([...baseline, ...configs])].sort();
}

/** Claude configs monomind's first look will trust — empty once it is recorded. */
export function firstLookConfigs(c: ApprovalCtx): string[] {
  const { operatorDir, home, env } = ctxOf(c);
  return readConfigRecord(operatorDir)?.[home] ? [] : claudeConfigCandidates(home, env).sort();
}

/** Approve exactly `paths`. Returns what was approved and what was not a
 *  candidate (left untouched). */
export function approvePaths(
  c: ApprovalCtx,
  paths: string[],
): { approved: string[]; notCandidates: string[] } {
  const { root, operatorDir, home, env } = ctxOf(c);
  const wanted = new Set(paths.map((p) => resolve(p)));
  const candidates = new Set(approvalCandidates(c));
  const approved = [...wanted].filter((p) => candidates.has(p));
  const notCandidates = [...wanted].filter((p) => !candidates.has(p));
  const baseline = readBaseline(root, operatorDir);
  const before = baseline.size;
  for (const p of approved) baseline.delete(p);
  if (baseline.size !== before) writeBaseline(root, operatorDir, baseline);
  const configs = new Set(claudeConfigCandidates(home, env));
  const newlyTrusted = approved.filter((p) => configs.has(p));
  if (newlyTrusted.length) {
    const rec = readConfigRecord(operatorDir) ?? {};
    writeConfigRecord(operatorDir, {
      ...rec,
      [home]: [...new Set([...(rec[home] ?? []), ...newlyTrusted])],
    });
  }
  return { approved, notCandidates };
}
