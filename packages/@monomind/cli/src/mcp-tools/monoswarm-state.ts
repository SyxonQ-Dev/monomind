/**
 * Monoswarm state helpers — the JSON state file, audit key, agent store
 * writer and vote-threshold math shared by the monoswarm_* tool modules.
 *
 * Registered through `monoswarmTools` in monoswarm-tools.ts, which keeps the
 * registration order; see that module for what these tools do and do not do.
 */

import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { getMonomindDataRoot } from './types.js';

// ---------------------------------------------------------------------------
// State persistence — single file under the git-safe data root.
// ---------------------------------------------------------------------------

export const MONOSWARM_DIR = 'monoswarm';
export const MONOSWARM_STATE_FILE = 'state.json';

/** Vote-count threshold strategies (see module note — not distributed consensus). */
export type VoteStrategy = 'majority' | 'supermajority' | 'unanimous' | 'threshold';

export interface VoteProposal {
  proposalId: string;
  type: string;
  value: unknown;
  proposedBy: string;
  proposedAt: string;
  votes: Record<string, boolean>;
  status: 'pending' | 'approved' | 'rejected';
  strategy: VoteStrategy;
  minVotes?: number; // threshold strategy: explicit required vote count
  duplicateVoters?: string[]; // voters caught casting conflicting votes on this proposal
  /**
   * Anti-groupthink delay: minimum number of voting rounds that must show
   * divergent votes (not unanimous) before the proposal can resolve, even if
   * the vote threshold is already met.
   */
  minDivergenceRounds?: number;
  /** Counter: number of rounds so far where votes were not unanimous. */
  divergenceRoundsSeen?: number;
}

export interface VoteResult {
  proposalId: string;
  type: string;
  result: 'approved' | 'rejected';
  votes: { for: number; against: number };
  decidedAt: string;
  strategy: VoteStrategy;
  duplicateVotersDetected?: string[];
}

export interface MonoswarmState {
  monoswarmId: string;
  initialized: boolean;
  topology: string;
  maxAgents: number;
  status: 'initializing' | 'running' | 'paused' | 'shutting_down' | 'terminated';
  /** Agent roster — hive "workers" and swarm "agents" are the same list here. */
  agents: string[];
  /** Optional elected coordinator, carried over from hive-mind's "queen" concept. */
  coordinator?: {
    agentId: string;
    electedAt: string;
    term: number;
  };
  tasks: string[];
  config: Record<string, unknown>;
  /** Vote strategy chosen at monoswarm_init; the default for monoswarm_vote when unspecified. */
  voteStrategy?: VoteStrategy;
  votes: {
    pending: VoteProposal[];
    history: VoteResult[];
  };
  sharedMemory: Record<string, unknown>;
  notices: Array<{
    noticeId: string;
    message: string;
    priority: string;
    fromId: string;
    timestamp: string;
  }>;
  createdAt: string;
  updatedAt: string;
}

export function getMonoswarmDir(): string {
  return join(getMonomindDataRoot(), MONOSWARM_DIR);
}

export function getMonoswarmStatePath(): string {
  return join(getMonoswarmDir(), MONOSWARM_STATE_FILE);
}

export function ensureMonoswarmDir(): void {
  const dir = getMonoswarmDir();
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
}

export const MAX_MONOSWARM_STATE_BYTES = 10 * 1024 * 1024; // 10 MB

export function defaultState(): MonoswarmState {
  const now = new Date().toISOString();
  return {
    monoswarmId: '',
    initialized: false,
    topology: 'mesh',
    maxAgents: 8,
    status: 'initializing',
    agents: [],
    tasks: [],
    config: {},
    votes: { pending: [], history: [] },
    sharedMemory: {},
    notices: [],
    createdAt: now,
    updatedAt: now,
  };
}

export function loadMonoswarmState(): MonoswarmState {
  try {
    const path = getMonoswarmStatePath();
    if (existsSync(path)) {
      if (statSync(path).size > MAX_MONOSWARM_STATE_BYTES) return defaultState();
      return JSON.parse(readFileSync(path, 'utf-8'));
    }
  } catch (e) {
    if (process.env.DEBUG || process.env.MONOMIND_DEBUG)
      console.error(
        '[monoswarm-tools] failed to parse state.json — resetting to default state:',
        e,
      );
  }
  return defaultState();
}

export function saveMonoswarmState(state: MonoswarmState): void {
  ensureMonoswarmDir();
  state.updatedAt = new Date().toISOString();
  const dest = getMonoswarmStatePath();
  const tmp = `${dest}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf-8');
  renameSync(tmp, dest);
}

export const AUDIT_KEY_FILE = 'audit-key';

/**
 * Resolve the HMAC signing key used for vote/audit records. Falls back to a
 * per-project key generated once and persisted alongside the monoswarm
 * state (kept out of state.json and never returned by any tool).
 * MONOMIND_SESSION_SECRET still takes precedence for callers that want to
 * manage/rotate the key themselves.
 */
export function getOrCreateAuditKey(): string {
  const envKey = process.env.MONOMIND_SESSION_SECRET;
  if (envKey) return envKey;

  const path = join(getMonoswarmDir(), AUDIT_KEY_FILE);
  try {
    if (existsSync(path)) {
      const existing = readFileSync(path, 'utf-8').trim();
      if (existing) return existing;
    }
  } catch {
    /* fall through to regeneration */
  }

  try {
    ensureMonoswarmDir();
    const key = randomBytes(32).toString('hex');
    const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
    writeFileSync(tmp, key, 'utf-8');
    renameSync(tmp, path);
    return key;
  } catch {
    // Filesystem unavailable — fall back to an ephemeral in-process key.
    return randomBytes(32).toString('hex');
  }
}

export function saveAgentStore(store: { agents: Record<string, unknown> }): void {
  const storeDir = join(getMonomindDataRoot(), 'agents');
  if (!existsSync(storeDir)) {
    mkdirSync(storeDir, { recursive: true });
  }
  const dest = join(storeDir, 'store.json');
  const tmp = `${dest}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, JSON.stringify(store, null, 2), 'utf-8');
  renameSync(tmp, dest);
}

export const RESERVED_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

export const VALID_TOPOLOGIES = new Set([
  'hierarchical',
  'mesh',
  'hierarchical-mesh',
  'ring',
  'star',
  'hybrid',
  'adaptive',
]);

// ---------------------------------------------------------------------------
// Vote-threshold math
// ---------------------------------------------------------------------------

/** Calculate required votes for a given strategy and total voter count. */
export function calculateRequiredVotes(
  strategy: VoteStrategy,
  totalVoters: number,
  minVotes?: number,
): number {
  if (totalVoters <= 0) return 1;
  switch (strategy) {
    case 'supermajority':
      return Math.floor((totalVoters * 2) / 3) + 1;
    case 'unanimous':
      return totalVoters;
    case 'threshold':
      return Math.min(Math.max(1, minVotes ?? Math.floor(totalVoters / 2) + 1), totalVoters);
    default:
      return Math.floor(totalVoters / 2) + 1;
  }
}

/**
 * Detect a voter who cast conflicting votes across proposals of the same
 * type — a double-vote check, not real Byzantine fault detection.
 */
export function detectDuplicateVotes(
  pending: VoteProposal[],
  currentProposal: VoteProposal,
  voterId: string,
  newVote: boolean,
): boolean {
  for (const p of pending) {
    if (p.proposalId === currentProposal.proposalId) continue;
    if (p.type !== currentProposal.type) continue;
    if (voterId in p.votes && p.votes[voterId] !== newVote) {
      return true; // Conflicting vote detected
    }
  }
  return false;
}

/**
 * Try to resolve a proposal based on its strategy. Returns 'approved',
 * 'rejected', or null if still pending.
 */
export function tryResolveProposal(
  proposal: VoteProposal,
  totalVoters: number,
): 'approved' | 'rejected' | null {
  const votesFor = Object.values(proposal.votes).filter((v) => v).length;
  const votesAgainst = Object.values(proposal.votes).filter((v) => !v).length;
  const required = calculateRequiredVotes(proposal.strategy, totalVoters, proposal.minVotes);

  if (votesFor >= required) return 'approved';
  if (votesAgainst >= required) return 'rejected';

  if (proposal.strategy === 'unanimous' && votesAgainst > 0) {
    return 'rejected';
  }

  const totalVotes = Object.keys(proposal.votes).length;
  const remaining = totalVoters - totalVotes;
  if (votesFor + remaining < required && votesAgainst + remaining < required) {
    return 'rejected'; // Deadlock: neither side can win
  }

  return null;
}
