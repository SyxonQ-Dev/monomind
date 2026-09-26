/**
 * Memory Bridge — shared helpers: error logging, embedding validation,
 * limits, automem config and usage/feedback weights. Split out of
 * memory-bridge.ts, which re-exports the public symbols.
 */

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

// ===== Embedding validation =====

const MAX_EMBEDDING_DIMS = 8192;
const MAX_EMBEDDING_JSON_BYTES = MAX_EMBEDDING_DIMS * 32; // ~256KB ceiling

/**
 * R1: surface swallowed errors when DEBUG/MONOMIND_DEBUG is on. The bridge
 * has ~12 `} catch { return null; }` sites that collapse SQLITE_BUSY,
 * EACCES, disk-full, and schema mismatches into "no matches" with zero
 * diagnostic. Behavior contract (return null on failure) is unchanged;
 * observability is added. Caller passes the bridge fn name + the thrown
 * value so the log is greppable per call site.
 */
export function logBridgeError(label: string, err: unknown): void {
  if (!(process.env.DEBUG || process.env.MONOMIND_DEBUG)) return;
  const msg = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
  console.error(`[bridge:${label}] ${msg}`);
}

export function safeParseEmbedding(raw: string | null | undefined): number[] | null {
  if (typeof raw !== 'string' || raw.length === 0) return null;
  if (raw.length > MAX_EMBEDDING_JSON_BYTES) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    logBridgeError('safeParseEmbedding', e);
    return null;
  }
  if (!Array.isArray(parsed)) return null;
  if (parsed.length === 0 || parsed.length > MAX_EMBEDDING_DIMS) return null;
  for (let i = 0; i < parsed.length; i++) {
    const v = parsed[i];
    if (typeof v !== 'number' || !Number.isFinite(v)) return null;
  }
  return parsed as number[];
}

// ===== Constants =====

export const BRIDGE_EMBEDDING_MODEL = 'Alibaba-NLP/gte-modernbert-base';
export const BRIDGE_EMBEDDING_DIMS = 768;
export const BRIDGE_MAX_KEY_LEN = 4 * 1024;
export const BRIDGE_MAX_VALUE_LEN = 16 * 1024;
export const MAX_TAGS = 32;
export const MAX_TAG_LEN = 64;
// Search results serve the head of the stored content only — full values bloat
// every MCP payload. Entries needing the full text can read the entry by key.
const BRIDGE_RESULT_CONTENT_CAP = 500;

export function capResultContent(content: string): string {
  return content.length > BRIDGE_RESULT_CONTENT_CAP
    ? `${content.slice(0, BRIDGE_RESULT_CONTENT_CAP)}…`
    : content;
}

export function getAutomemConfig(): {
  dedupThreshold: number;
  staleDays: number;
  feedbackInfluence: number;
} {
  const defaults = { dedupThreshold: 0.85, staleDays: 7, feedbackInfluence: 0.2 };
  try {
    const configPath = path.join(process.cwd(), '.monomind', 'automem-config.json');
    if (!fs.existsSync(configPath)) return defaults;
    const stat = fs.statSync(configPath);
    if (stat.size > 64 * 1024) return defaults;
    const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    return {
      dedupThreshold:
        typeof config?.scaffold?.dedupThreshold === 'number'
          ? config.scaffold.dedupThreshold
          : defaults.dedupThreshold,
      staleDays:
        typeof config?.scaffold?.staleDays === 'number'
          ? config.scaffold.staleDays
          : defaults.staleDays,
      feedbackInfluence:
        typeof config?.scaffold?.feedbackInfluence === 'number'
          ? Math.max(0, Math.min(1, config.scaffold.feedbackInfluence))
          : defaults.feedbackInfluence,
    };
  } catch (e) {
    logBridgeError('loadBridgeConfig', e);
    return defaults;
  }
}

// ===== Usage/feedback weights (cognee-style, stored in entry metadata) =====
//
// feedback_weight (0..1, default 0.5): EWMA of explicit/auto ratings applied to
// the entries actually used to produce an answer. frequency_weight (>=0): how
// often the entry was returned by a search. Both live in the entry's metadata
// JSON — deliberately NOT backend schema columns, so no @monoes/memory publish
// is needed and both backends work unchanged.

const DEFAULT_FEEDBACK_WEIGHT = 0.5;
export const FEEDBACK_EWMA_ALPHA = 0.1;
/** frequency_weight normalization ceiling: 10+ uses counts as fully reinforced. */
const FREQUENCY_NORM_CAP = 10;

export function entryWeights(metadata: unknown): { feedback: number; frequency: number } {
  const md = (metadata ?? {}) as Record<string, unknown>;
  const fw =
    typeof md.feedback_weight === 'number' && Number.isFinite(md.feedback_weight)
      ? Math.max(0, Math.min(1, md.feedback_weight))
      : DEFAULT_FEEDBACK_WEIGHT;
  const freq =
    typeof md.frequency_weight === 'number' && Number.isFinite(md.frequency_weight)
      ? Math.max(0, md.frequency_weight)
      : 0;
  return { feedback: fw, frequency: freq };
}

/** Blend learned usefulness into a GENUINE embedding-similarity score.
 *  Cognee guard: never applied to keyword-fallback scores — those carry no
 *  real relevance signal, and blending there lets a high-feedback stale entry
 *  outrank relevant matches and self-reinforce (rich-get-richer). */
export function blendScore(
  cosineSim: number,
  weights: { feedback: number; frequency: number },
  influence: number,
): number {
  if (influence <= 0) return cosineSim;
  const usefulness =
    0.7 * weights.feedback + 0.3 * Math.min(1, weights.frequency / FREQUENCY_NORM_CAP);
  return (1 - influence) * cosineSim + influence * usefulness;
}

export function generateId(prefix: string): string {
  return `${prefix}_${Date.now()}_${crypto.randomBytes(8).toString('hex')}`;
}
