/**
 * Hooks embedding — routing outcome persistence and SONA trajectory storage.
 * Extracted from hooks-embedding.ts.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { getProjectCwd } from './types.js';

// ── Runtime routing outcome persistence ──────────────────────────────
// Closes the learning loop: post-task records outcomes → route loads them.

// Evaluated lazily via getter so it uses runtime CWD, not import-time CWD
export function getRoutingOutcomesPath(): string {
  return join(getProjectCwd(), '.monomind', 'routing-outcomes.json');
}

export const ROUTING_STOPWORDS = new Set([
  'the',
  'a',
  'an',
  'is',
  'are',
  'was',
  'were',
  'be',
  'been',
  'being',
  'have',
  'has',
  'had',
  'do',
  'does',
  'did',
  'will',
  'would',
  'could',
  'should',
  'may',
  'might',
  'shall',
  'can',
  'to',
  'of',
  'in',
  'for',
  'on',
  'with',
  'at',
  'by',
  'from',
  'as',
  'into',
  'through',
  'during',
  'before',
  'after',
  'above',
  'below',
  'between',
  'under',
  'again',
  'further',
  'then',
  'once',
  'it',
  'its',
  'this',
  'that',
  'these',
  'those',
  'i',
  'me',
  'my',
  'we',
  'our',
  'you',
  'your',
  'he',
  'she',
  'they',
  'them',
  'and',
  'but',
  'or',
  'nor',
  'not',
  'no',
  'so',
  'if',
  'when',
  'than',
  'very',
  'just',
  'also',
  'only',
  'both',
  'each',
  'all',
  'any',
  'few',
  'more',
  'most',
  'other',
  'some',
  'such',
  'same',
  'new',
  'now',
  'here',
  'there',
  'where',
  'how',
  'what',
  'which',
  'who',
]);

interface RoutingOutcome {
  task: string;
  agent: string;
  success: boolean;
  quality: number;
  keywords: string[];
  timestamp: string;
}

export function extractKeywords(text: string): string[] {
  if (!text) return [];
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 2 && !ROUTING_STOPWORDS.has(w));
}

export function loadRoutingOutcomes(): RoutingOutcome[] {
  try {
    if (existsSync(getRoutingOutcomesPath())) {
      const data = JSON.parse(readFileSync(getRoutingOutcomesPath(), 'utf-8'));
      return data.outcomes || [];
    }
  } catch (e) {
    /* corrupt file, start fresh */
    if (process.env.DEBUG || process.env.MONOMIND_DEBUG)
      console.error('[hooks-embedding] routing-outcomes.json read/parse failed:', e);
  }
  return [];
}

/** Never throws; returns whether the outcomes were written. */
export function saveRoutingOutcomes(outcomes: RoutingOutcome[]): boolean {
  try {
    const dir = dirname(getRoutingOutcomesPath());
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    // Cap at 500 entries to bound file size
    const capped = outcomes.slice(-500);
    const tmp = `${getRoutingOutcomesPath()}.tmp`;
    writeFileSync(tmp, JSON.stringify({ outcomes: capped }, null, 2));
    renameSync(tmp, getRoutingOutcomesPath());
    return true;
  } catch (e) {
    /* non-critical */
    if (process.env.DEBUG || process.env.MONOMIND_DEBUG)
      console.error('[hooks-embedding] routing-outcomes.json write failed:', e);
    return false;
  }
}

// Trajectory storage for SONA learning
export interface TrajectoryStep {
  action: string;
  result: string;
  quality: number;
  timestamp: string;
}

export interface TrajectoryData {
  id: string;
  task: string;
  agent: string;
  steps: TrajectoryStep[];
  startedAt: string;
  success?: boolean;
  endedAt?: string;
}

// In-memory trajectory tracking (persisted on end)
export const activeTrajectories = new Map<string, TrajectoryData>();
