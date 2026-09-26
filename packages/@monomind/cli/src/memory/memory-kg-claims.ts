/**
 * Memory Knowledge Graph — the claims ledger: per-origin support from which
 * an element's description, extraction method and conflict flag are
 * derived, and origin withdrawal. Split out of memory-kg.ts, which
 * re-exports the public symbols.
 */

import { MAX_CLAIMS } from './memory-kg-model.js';

// ── Claims (per-origin support, from which summaries are derived) ────

/** How a claim came to exist.
 *
 *  `asserted` — someone stated it: an LLM distillation, an explicit
 *  `memory_kg_ingest`, an org's `org_learn`.
 *  `heuristic` — `heuristicExtract` inferred it from two names appearing in one
 *  sentence. Nobody asserted it, and the module header has always called it
 *  lower-trust; until now nothing downstream could tell the two apart. */
export type KgExtractionMethod = 'asserted' | 'heuristic';

/** One origin's assertion about an element. An origin re-asserting replaces its
 *  own contribution — a run stands behind its latest word, not its first. */
export interface KgClaim {
  origin: string;
  description: string;
  /** Assertion time, and the ordering that decides which claim is current. */
  at: number;
  /** Absent on rows written before extraction method was recorded. Absent means
   *  UNKNOWN, never `asserted` — defaulting an unrecorded method to the higher
   *  trust would relabel every old co-occurrence guess as a stated fact. */
  method?: KgExtractionMethod;
}

/** The stored fields derived from a claim ledger. `description` is DERIVED, so
 *  no caller can set it directly and no merge rule has to guess which of two
 *  strings is truer. */
export interface DerivedClaims {
  claims: KgClaim[];
  description: string;
  origin_refs: string[];
  provenance_complete: boolean;
  origins_dropped: number;
  /** Two or more live origins assert materially different descriptions. The
   *  summary is still the latest one; this says the graph knows it is disputed
   *  rather than settled. */
  conflict: boolean;
  /** The element's standing, projected from its claims. Absent when any live
   *  claim predates method recording — "not recorded", which is not the same
   *  answer as `asserted`. */
  method?: KgExtractionMethod;
}

function claimsOf(md: Record<string, unknown>): KgClaim[] {
  const raw = md.claims;
  if (Array.isArray(raw))
    return (raw as KgClaim[])
      .filter((c) => c && typeof c.origin === 'string')
      .map((c) => ({
        origin: c.origin,
        description: typeof c.description === 'string' ? c.description : '',
        at: typeof c.at === 'number' ? c.at : 0,
        ...(c.method === 'asserted' || c.method === 'heuristic' ? { method: c.method } : {}),
      }));
  // Pre-ledger row (including every entry written before KG_ID_VERSION 2):
  // seed one contribution per recorded origin, all carrying the one description
  // the merge left behind. That is the honest reconstruction — the old merge
  // destroyed which origin said what — and it preserves current rollback
  // behaviour exactly: withdrawing one of several origins leaves the summary
  // unchanged, withdrawing the last deletes the element.
  const origins = Array.isArray(md.origin_refs) ? (md.origin_refs as string[]) : [];
  const description = typeof md.description === 'string' ? md.description : '';
  const at = typeof md.valid_from === 'number' ? md.valid_from : 0;
  return origins.map((origin) => ({ origin, description, at }));
}

/** Add or replace `origin`'s contribution and re-derive everything that hangs
 *  off the ledger. */
export function applyClaim(
  md: Record<string, unknown>,
  origin: string,
  description: string,
  now: number,
  method: KgExtractionMethod = 'asserted',
): DerivedClaims {
  const existing = claimsOf(md);
  const dropped = typeof md.origins_dropped === 'number' ? md.origins_dropped : 0;

  // An EMPTY description is support without content — "this entity exists",
  // which is what naming an edge endpoint asserts. It must never overwrite what
  // the same origin already said, or an edge listing a node the same payload
  // described would blank that description out.
  const prior = existing.find((c) => c.origin === origin);
  if (!description.trim() && prior?.description.trim()) return deriveClaims(existing, dropped);

  const claims = existing.filter((c) => c.origin !== origin);
  claims.push({ origin, description, at: now, method });
  return deriveClaims(claims, dropped);
}

/** The element's standing, from its surviving claims.
 *
 *  One asserted claim outranks any number of co-occurrence guesses: a fact
 *  someone stated does not become less stated because a heuristic also stumbled
 *  onto it. A claim with no recorded method makes the whole projection UNKNOWN
 *  rather than voting — an old row cannot be read as evidence either way. */
function deriveMethod(claims: KgClaim[]): KgExtractionMethod | undefined {
  if (!claims.length || claims.some((c) => !c.method)) return undefined;
  return claims.some((c) => c.method === 'asserted') ? 'asserted' : 'heuristic';
}

function deriveClaims(claims: KgClaim[], alreadyDropped: number): DerivedClaims {
  let dropped = alreadyDropped;
  if (claims.length > MAX_CLAIMS) {
    // Oldest support goes first, and the loss is RECORDED. The scheme this
    // replaced did the same drop silently and left the entry claiming a
    // complete history it no longer had.
    dropped += claims.length - MAX_CLAIMS;
    claims = claims.slice(-MAX_CLAIMS);
  }
  return {
    claims,
    description: currentDescription(claims),
    origin_refs: claims.map((c) => c.origin),
    provenance_complete: dropped === 0,
    origins_dropped: dropped,
    conflict: new Set(claims.map((c) => c.description.trim()).filter(Boolean)).size > 1,
    method: deriveMethod(claims),
  };
}

/** The current summary: the most recent contribution that actually says
 *  something. LATEST wins, not longest — length measures verbosity, and
 *  "longest wins" is why re-ingesting a corrected "Now PostgreSQL" left the
 *  stale MySQL blurb in place. */
function currentDescription(claims: KgClaim[]): string {
  let best: KgClaim | undefined;
  for (const c of claims) {
    if (!c.description.trim()) continue;
    if (!best || c.at >= best.at) best = c;
  }
  return best?.description ?? '';
}

/** Withdraw one origin. Returns null when nothing supports the element any
 *  more (the caller deletes it); otherwise the RE-DERIVED state, which is what
 *  restores a previous correct description after a bad update is rolled back. */
export function withoutOrigin(md: Record<string, unknown>, origin: string): DerivedClaims | null {
  const remaining = claimsOf(md).filter((c) => c.origin !== origin);
  if (!remaining.length) return null;
  return deriveClaims(remaining, typeof md.origins_dropped === 'number' ? md.origins_dropped : 0);
}
