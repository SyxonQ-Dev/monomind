/**
 * Claims store — claim/claimant types and the file-backed claims.json
 * persistence shared by the claims_* MCP tool modules (ADR-016).
 *
 * Registered through `claimsTools` in claims-tools.ts, which keeps the
 * registration order.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

// Inline claim service since we can't import external modules
export interface Claimant {
  type: 'human' | 'agent';
  userId?: string;
  name?: string;
  agentId?: string;
  agentType?: string;
}

export type ClaimStatus =
  | 'active'
  | 'paused'
  | 'handoff-pending'
  | 'review-requested'
  | 'blocked'
  | 'stealable'
  | 'completed';
export type StealReason = 'overloaded' | 'stale' | 'blocked-timeout' | 'voluntary';

export interface IssueClaim {
  issueId: string;
  claimant: Claimant;
  claimedAt: string;
  status: ClaimStatus;
  statusChangedAt: string;
  expiresAt?: string;
  handoffTo?: Claimant;
  handoffReason?: string;
  blockReason?: string;
  progress: number;
  context?: string;
}

interface ClaimsStore {
  claims: Record<string, IssueClaim>;
  stealable: Record<
    string,
    {
      reason: StealReason;
      stealableAt: string;
      preferredTypes?: string[];
      progress: number;
      context?: string;
    }
  >;
  contests: Record<string, { originalClaimant: Claimant; contestedAt: string; reason: string }>;
}

// File-based persistence
const CLAIMS_DIR = '.monomind/claims';
const CLAIMS_FILE = 'claims.json';

function getClaimsPath(): string {
  return resolve(join(CLAIMS_DIR, CLAIMS_FILE));
}

function ensureClaimsDir(): void {
  const dir = resolve(CLAIMS_DIR);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

const MAX_CLAIMS_STORE_BYTES = 10 * 1024 * 1024; // 10 MB

export function loadClaims(): ClaimsStore {
  try {
    const path = getClaimsPath();
    if (existsSync(path) && statSync(path).size <= MAX_CLAIMS_STORE_BYTES) {
      return JSON.parse(readFileSync(path, 'utf-8'));
    }
  } catch (e) {
    // Return empty store on error
    if (process.env.DEBUG || process.env.MONOMIND_DEBUG)
      console.error('[claims-tools] failed to load claims.json, starting fresh:', e);
  }
  return { claims: {}, stealable: {}, contests: {} };
}

export function saveClaims(store: ClaimsStore): void {
  ensureClaimsDir();
  const dest = getClaimsPath();
  const tmp = `${dest}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, JSON.stringify(store, null, 2), 'utf-8');
  renameSync(tmp, dest);
}

export function formatClaimant(claimant: Claimant): string {
  return claimant.type === 'human'
    ? `human:${claimant.userId}:${claimant.name}`
    : `agent:${claimant.agentId}:${claimant.agentType}`;
}

export function parseClaimant(str: string): Claimant | null {
  const parts = str.split(':');
  if (parts[0] === 'human' && parts.length >= 3) {
    return { type: 'human', userId: parts[1], name: parts.slice(2).join(':') };
  } else if (parts[0] === 'agent' && parts.length >= 3) {
    return { type: 'agent', agentId: parts[1], agentType: parts[2] };
  }
  return null;
}
