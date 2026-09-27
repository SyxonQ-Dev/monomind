/**
 * Memory MCP tools for the conversation/org knowledge graph: memory_causal_edge,
 * memory_kg_ingest, memory_kg_search, memory_kg_rollback, memory_kg_consolidate,
 * memory_kg_stats.
 *
 * Split out of memory-tools.ts, which re-exports these tools and registers them
 * in `memoryTools` in their original order.
 */

import {
  sanitizeError,
  validatePositiveInt,
  validateMcpString as validateString,
} from '../utils/input-guards.js';
import type { MCPTool } from './types.js';

// ===== memory_causal_edge — Record causal relationships =====

/** Provenance ref for one causal-edge assertion.
 *
 *  Every call used to ingest under the bare string `causal-edge-tool`, which
 *  made all of them one indivisible provenance bucket: a rollback aimed at one
 *  wrong edge withdrew every causal edge the tool had ever recorded. Keying on
 *  the asserted triple makes the ref unique per assertion and stable for it —
 *  re-asserting the same edge reinforces its existing support instead of
 *  minting a second ref that rollback would then have to chase separately.
 *
 *  Components are bounded like the graph's own name key (`normalizeName`
 *  slices at 200), so this inherits that identity resolution and adds no new
 *  collision class. */
export function causalEdgeOriginRef(source: string, relation: string, target: string): string {
  const part = (s: string, max: number) => s.trim().toLowerCase().slice(0, max);
  return `causal-edge:${part(source, 100)}|${part(relation, 50)}|${part(target, 100)}`;
}

export const memoryCausalEdge: MCPTool = {
  name: 'memory_causal-edge',
  description:
    'Record a causal relationship between two named things as a real knowledge-graph edge (traversable via memory_kg_search)',
  inputSchema: {
    type: 'object',
    properties: {
      sourceId: { type: 'string', description: 'Source entity name (or entry ID)' },
      targetId: { type: 'string', description: 'Target entity name (or entry ID)' },
      relation: {
        type: 'string',
        description: 'Relationship type — a snake_case label (e.g. causes, preceded, fixed_by)',
      },
      // `weight` used to be declared here and then dropped on the floor: the
      // graph's edge input has no weight field, so nothing could carry it.
      // Declaring an option the store cannot honour is the same boundary
      // dishonesty as declaring an unvalidated payload shape.
      description: { type: 'string', description: 'One-sentence concrete fact for this edge' },
    },
    required: ['sourceId', 'targetId', 'relation'],
  },
  handler: async (params: Record<string, unknown>) => {
    try {
      const sourceId = validateString(params.sourceId, 'sourceId', KG_MAX_NAME);
      const targetId = validateString(params.targetId, 'targetId', KG_MAX_NAME);
      const relation = validateString(params.relation, 'relation', KG_MAX_RELATION);
      if (!sourceId) return { success: false, error: 'sourceId is required (non-empty string)' };
      if (!targetId) return { success: false, error: 'targetId is required (non-empty string)' };
      if (!relation) return { success: false, error: 'relation is required (non-empty string)' };
      if (!KG_RELATION_RE.test(relation.trim()))
        return { success: false, error: relationReason(relation) };
      const kg = await import('../memory/memory-kg.js');
      const result = await kg.kgIngest({
        nodes: [{ name: sourceId }, { name: targetId }],
        edges: [
          {
            source: sourceId,
            target: targetId,
            relation,
            description:
              validateString(params.description, 'description', KG_MAX_TEXT) ?? undefined,
          },
        ],
        originRef: causalEdgeOriginRef(sourceId, relation, targetId),
      });
      return result;
    } catch (error) {
      return { success: false, error: sanitizeError(error) };
    }
  },
};
// ===== memory_kg_* — Conversation/org knowledge graph =====

// ── KG payload contract (K8) ────────────────────────────────────────
//
// This is the public write boundary of the knowledge graph. It used to declare
// nodes/edges/rules as bare `{type: 'object'}` arrays and cast them to `any[]`,
// which meant three things at once: a caller could not see the shape it was
// supposed to send, an item that the store rejected part-way through left the
// items ahead of it already persisted, and anything past the per-call caps was
// sliced off with the result reporting exactly as it would have for a payload
// that fit. Everything below exists so a caller can tell "all 40 nodes stored"
// from "20 stored, 20 dropped", and so a malformed payload never becomes a
// partial graph.

/** Per-call ceilings enforced by kgIngest/kgIngestRules. Mirrored here so an
 *  over-cap payload is reported as truncated instead of silently sliced.
 *  Keep in sync with the `.slice()` bounds in memory-kg-ingest.ts. */
const KG_MAX_NODES = 500;
const KG_MAX_EDGES = 1000;
const KG_MAX_RULES = 50;
const KG_MAX_NAME = 500;
const KG_MAX_TEXT = 2000;
const KG_MAX_RULE = 4000;
const KG_MAX_RELATION = 200;

/** A relation is a short label, not prose: alphanumeric words joined by `_`,
 *  `-` or single spaces. kgIngest normalizes whatever it gets into an edge KEY,
 *  so free text silently becomes a different relation than the caller wrote —
 *  and an unbounded one partitions the graph into unqueryable singletons. */
const KG_RELATION_RE = /^[A-Za-z0-9]+(?:[ _-][A-Za-z0-9]+)*$/;

const relationReason = (v: string) =>
  `relation must be a label such as "causes" or "fixed_by", not ${JSON.stringify(v.slice(0, 60))}`;

/** One item the boundary refused. `index: -1` means the container itself
 *  (e.g. `nodes` was not an array) rather than an element of it. */
interface KgReject {
  field: 'nodes' | 'edges' | 'rules';
  index: number;
  reason: string;
}

const textReason = (field: string, max: number) =>
  `${field} must be a non-empty string of at most ${max} characters, without control characters`;

/** Optional string field: absent/null/'' is fine, anything else must be a
 *  clean bounded string. Returns a reason on failure, null when acceptable. */
function checkOptionalText(
  obj: Record<string, unknown>,
  field: string,
  max: number,
): string | null {
  const value = obj[field];
  if (value === undefined || value === null || value === '') return null;
  if (!validateString(value, field, max)) return textReason(field, max);
  return null;
}

function checkNode(item: unknown): string | null {
  if (!item || typeof item !== 'object' || Array.isArray(item)) return 'must be an object';
  const o = item as Record<string, unknown>;
  if (!validateString(o.name, 'name', KG_MAX_NAME)) return textReason('name', KG_MAX_NAME);
  return (
    checkOptionalText(o, 'type', KG_MAX_NAME) ??
    checkOptionalText(o, 'description', KG_MAX_TEXT) ??
    checkOptionalText(o, 'nodeSet', KG_MAX_NAME)
  );
}

function checkEdge(item: unknown): string | null {
  if (!item || typeof item !== 'object' || Array.isArray(item)) return 'must be an object';
  const o = item as Record<string, unknown>;
  if (!validateString(o.source, 'source', KG_MAX_NAME)) return textReason('source', KG_MAX_NAME);
  if (!validateString(o.target, 'target', KG_MAX_NAME)) return textReason('target', KG_MAX_NAME);
  const relation = validateString(o.relation, 'relation', KG_MAX_RELATION);
  if (!relation) return textReason('relation', KG_MAX_RELATION);
  if (!KG_RELATION_RE.test(relation.trim())) return relationReason(relation);
  return (
    checkOptionalText(o, 'description', KG_MAX_TEXT) ??
    checkOptionalText(o, 'sourceType', KG_MAX_NAME) ??
    checkOptionalText(o, 'targetType', KG_MAX_NAME)
  );
}

function checkRule(item: unknown): string | null {
  if (!item || typeof item !== 'object' || Array.isArray(item)) return 'must be an object';
  const o = item as Record<string, unknown>;
  if (!validateString(o.rule, 'rule', KG_MAX_RULE)) return textReason('rule', KG_MAX_RULE);
  return checkOptionalText(o, 'context', KG_MAX_TEXT);
}

const KG_CHECKS: Record<KgReject['field'], { check: (i: unknown) => string | null; cap: number }> =
  {
    nodes: { check: checkNode, cap: KG_MAX_NODES },
    edges: { check: checkEdge, cap: KG_MAX_EDGES },
    rules: { check: checkRule, cap: KG_MAX_RULES },
  };

interface KgPayload {
  nodes: unknown[];
  edges: unknown[];
  rules: unknown[];
  /** Items dropped for exceeding a per-call cap, by field. Only present when
   *  something was actually dropped. */
  truncated?: Partial<Record<KgReject['field'], number>>;
}

/** Validate the WHOLE nested payload up front. Any bad item rejects the entire
 *  call — including one past a cap that would have been dropped anyway, since
 *  a caller sending malformed items deserves to hear about them rather than
 *  have them quietly vanish. Nothing here writes; the first mutation only
 *  happens once this returns `ok`. */
function validateKgPayload(params: Record<string, unknown>): KgPayload & { rejected: KgReject[] } {
  const rejected: KgReject[] = [];
  const accepted: Record<KgReject['field'], unknown[]> = { nodes: [], edges: [], rules: [] };
  const truncated: Partial<Record<KgReject['field'], number>> = {};

  for (const field of ['nodes', 'edges', 'rules'] as const) {
    const raw = params[field];
    if (raw === undefined || raw === null) continue;
    if (!Array.isArray(raw)) {
      rejected.push({ field, index: -1, reason: `${field} must be an array` });
      continue;
    }
    const { check, cap } = KG_CHECKS[field];
    for (let i = 0; i < raw.length; i++) {
      const reason = check(raw[i]);
      if (reason) rejected.push({ field, index: i, reason });
    }
    accepted[field] = raw.slice(0, cap);
    if (raw.length > cap) truncated[field] = raw.length - cap;
  }

  return {
    ...accepted,
    ...(Object.keys(truncated).length ? { truncated } : {}),
    rejected,
  };
}

export const memoryKgIngest: MCPTool = {
  name: 'memory_kg_ingest',
  description:
    'Merge LLM-extracted entities/relations/rules into the persistent knowledge graph; same-name entities merge idempotently. The whole payload is validated before anything is written, and the result reports accepted/rejected/truncated counts.',
  inputSchema: {
    type: 'object',
    properties: {
      nodes: {
        type: 'array',
        maxItems: KG_MAX_NODES,
        description: `Entities (max ${KG_MAX_NODES} per call; the excess is reported as truncated)`,
        items: {
          type: 'object',
          properties: {
            name: {
              type: 'string',
              description: 'Entity name — this IS the identity; same name merges',
            },
            type: { type: 'string', description: "Basic type: 'Person', 'Service', 'Tool'" },
            description: { type: 'string', description: 'One-sentence concrete fact' },
            nodeSet: { type: 'string', description: "Optional grouping, e.g. 'rules'" },
          },
          required: ['name'],
        },
      },
      edges: {
        type: 'array',
        maxItems: KG_MAX_EDGES,
        description: `Relations (max ${KG_MAX_EDGES} per call; the excess is reported as truncated)`,
        items: {
          type: 'object',
          properties: {
            source: { type: 'string', description: 'Source entity name' },
            target: { type: 'string', description: 'Target entity name' },
            relation: {
              type: 'string',
              description: "snake_case label, e.g. 'causes', 'fixed_by' — not free text",
            },
            description: {
              type: 'string',
              description: 'One-sentence concrete fact using the endpoint names',
            },
            sourceType: { type: 'string' },
            targetType: { type: 'string' },
          },
          required: ['source', 'target', 'relation'],
        },
      },
      rules: {
        type: 'array',
        maxItems: KG_MAX_RULES,
        description: `Distilled durable rules, deduped semantically against existing rules (max ${KG_MAX_RULES} per call)`,
        items: {
          type: 'object',
          properties: {
            rule: { type: 'string', description: 'The durable rule, in one sentence' },
            context: { type: 'string', description: 'When the rule applies' },
          },
          required: ['rule'],
        },
      },
      rawText: {
        type: 'string',
        description: 'Fallback: raw text for regex-based extraction (no LLM)',
      },
      originRef: {
        type: 'string',
        description:
          'Provenance ref (session/run/doc id) — enables memory_kg_rollback. Use a ref unique to this operation so a rollback withdraws only its work.',
      },
    },
    required: ['originRef'],
  },
  handler: async (params: Record<string, unknown>) => {
    try {
      const originRef = validateString(params.originRef, 'originRef', KG_MAX_NAME);
      if (!originRef)
        return { success: false, error: textReason('originRef', KG_MAX_NAME), rejected: [] };

      const payload = validateKgPayload(params);
      if (payload.rejected.length)
        return {
          success: false,
          error: `payload rejected before any write: ${payload.rejected.length} invalid item(s)`,
          rejected: payload.rejected,
        };

      const kg = await import('../memory/memory-kg.js');
      let { nodes, edges } = payload;
      // A caller-supplied payload is an assertion; text run through the
      // extractor is an inference. Which one produced these elements is stored
      // on the claim, so retrieval can weigh them differently.
      let method: 'asserted' | 'heuristic' = 'asserted';
      if (
        !nodes.length &&
        !edges.length &&
        typeof params.rawText === 'string' &&
        params.rawText.trim()
      ) {
        const extracted = kg.heuristicExtract(params.rawText, { sourceName: originRef });
        nodes = extracted.nodes.slice(0, KG_MAX_NODES);
        edges = extracted.edges.slice(0, KG_MAX_EDGES);
        method = 'heuristic';
      }

      const graph =
        nodes.length || edges.length
          ? await kg.kgIngest({ nodes: nodes as any[], edges: edges as any[], originRef, method })
          : { success: true, nodesAdded: 0, nodesMerged: 0, edgesAdded: 0, edgesMerged: 0 };
      const rules = payload.rules.length
        ? await kg.kgIngestRules({ rules: payload.rules as any[], originRef })
        : null;

      // Honesty over the whole call, not just the entity half: a refused rule
      // write must not be flattened into a graph-only `success: true`, and the
      // caller gets the rule verdicts and aggregate `accepted` count alongside
      // them so an `accepted` verdict with `accepted: 0` is visible.
      const rulesFailed = rules ? !rules.success : false;
      return {
        ...graph,
        success: graph.success && !rulesFailed,
        ...(graph.error || rulesFailed
          ? { error: graph.error ?? rules?.error ?? 'rule ingestion failed' }
          : {}),
        rules,
        /** How many items passed validation and were submitted to the store.
         *  Compare against nodesAdded+nodesMerged to see what actually landed. */
        accepted: { nodes: nodes.length, edges: edges.length, rules: payload.rules.length },
        ...(payload.truncated ? { truncated: payload.truncated } : {}),
      };
    } catch (error) {
      return { success: false, error: sanitizeError(error) };
    }
  },
};

export const memoryKgSearch: MCPTool = {
  name: 'memory_kg_search',
  description:
    'Search the memory knowledge graph (remembered entities and relations — not the Monograph code graph): entities are seeded via the memory bridge (semantic when embeddings are available, keyword otherwise) and expanded to ranked relationship triplets. `method` reports which retrieval actually ran. Each triplet carries how it was obtained — `asserted` (someone stated it) or `heuristic` (inferred from co-occurrence, lower trust) — and `conflict` when its origins disagree; absent `method` means the edge predates that recording. Returns rendered context lines plus seed entry ids (rate them via memory_feedback).',
  inputSchema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Natural-language query' },
      limit: { type: 'number', description: 'Max triplets (default 8)' },
      nodeSet: { type: 'string', description: "Filter to a node set (e.g. 'rules')" },
    },
    required: ['query'],
  },
  handler: async (params: Record<string, unknown>) => {
    try {
      const query = validateString(params.query, 'query', 2000);
      if (!query) return { success: false, error: 'query is required' };
      const kg = await import('../memory/memory-kg.js');
      return await kg.kgSearch({
        query,
        limit: validatePositiveInt(params.limit, 8, 50),
        nodeSet: validateString(params.nodeSet, 'nodeSet', 100) ?? undefined,
      });
    } catch (error) {
      return { success: false, error: sanitizeError(error) };
    }
  },
};

export const memoryKgRollback: MCPTool = {
  name: 'memory_kg_rollback',
  description:
    'Delete all knowledge-graph nodes/edges/rules whose only provenance is the given originRef (bad-ingest recovery). Elements shared with other origins are retained.',
  inputSchema: {
    type: 'object',
    properties: {
      originRef: {
        type: 'string',
        description: 'The provenance ref to roll back (session/run/doc id)',
      },
    },
    required: ['originRef'],
  },
  handler: async (params: Record<string, unknown>) => {
    try {
      const originRef = validateString(params.originRef, 'originRef', 500);
      if (!originRef) return { success: false, error: 'originRef is required' };
      const kg = await import('../memory/memory-kg.js');
      return await kg.kgRollback({ originRef });
    } catch (error) {
      return { success: false, error: sanitizeError(error) };
    }
  },
};

export const memoryKgConsolidate: MCPTool = {
  name: 'memory_kg_consolidate',
  description:
    "List knowledge-graph entities whose descriptions lag their connectivity, with neighborhood facts. YOU do the consolidation: rewrite each candidate's description as one canonical paragraph merging the facts, then resubmit via memory_kg_ingest. Your resubmission becomes the current description because it is the most recent claim from your origin — not because it is longer, so do not pad it.",
  inputSchema: {
    type: 'object',
    properties: {
      minEdges: { type: 'number', description: 'Minimum relations for a candidate (default 3)' },
      limit: { type: 'number', description: 'Max candidates (default 10)' },
    },
  },
  handler: async (params: Record<string, unknown>) => {
    try {
      const kg = await import('../memory/memory-kg.js');
      const candidates = await kg.kgConsolidateCandidates({
        minEdges: validatePositiveInt(params.minEdges, 3, 100),
        limit: validatePositiveInt(params.limit, 10, 50),
      });
      return { success: true, candidates };
    } catch (error) {
      return { success: false, error: sanitizeError(error) };
    }
  },
};

export const memoryKgStats: MCPTool = {
  name: 'memory_kg_stats',
  description:
    'Knowledge graph size: node, edge, and rule counts (plus the entity glossary for extraction prompts)',
  inputSchema: {
    type: 'object',
    properties: {
      glossary: { type: 'boolean', description: 'Include top entity names (default false)' },
    },
  },
  handler: async (params: Record<string, unknown>) => {
    try {
      const kg = await import('../memory/memory-kg.js');
      const stats = await kg.kgStats();
      const glossary = params.glossary === true ? await kg.kgGlossary() : undefined;
      return { success: true, ...stats, ...(glossary ? { glossary } : {}) };
    } catch (error) {
      return { success: false, error: sanitizeError(error) };
    }
  },
};
