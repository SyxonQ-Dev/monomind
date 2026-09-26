/**
 * Memory Knowledge Graph — rules (two-stage distillation support):
 * kgIngestRules with per-rule verdicts, origin reinforcement, and
 * kgListRules. Split out of memory-kg.ts, which re-exports the public
 * symbols.
 */

import {
  bridgeGetEntry,
  bridgeListEntries,
  bridgeSearchEntries,
  bridgeStoreEntry,
} from './memory-bridge.js';
import { applyClaim } from './memory-kg-claims.js';
import { onEntrySupported } from './memory-kg-index.js';
import { kgIngest } from './memory-kg-ingest.js';
import type { KgScope } from './memory-kg-model.js';
import {
  KG_ID_VERSION,
  kgNamespaces,
  kgQualifyOrigin,
  legacyRuleKey,
  MAX_RULES_PER_CALL,
  ruleKey,
} from './memory-kg-model.js';
import { FailureLog } from './memory-kg-scan.js';

// ── Rules (two-stage distillation support) ──────────────────────────

export interface RuleVerdict {
  rule: string;
  /** `failed` — the candidate was fine, but a write the caller was told about
   *  did not land. It is neither `invalid` (which blames the caller's input)
   *  nor `accepted`/`already_known` (which claim the graph now holds it). Both
   *  of those used to be reported unconditionally, so a caller reading verdicts
   *  saw every rule land while the aggregate `accepted` count said zero. */
  verdict: 'accepted' | 'already_known' | 'invalid' | 'failed';
  similarTo?: string;
}

/** Stage-2 of cognee's curator/writer distillation: the CALLER (an LLM agent)
 *  proposes candidate rules; this accepts each unless a semantically
 *  near-identical rule exists (embedding dedup — deterministic keys can't
 *  collapse paraphrases). Accepted rules are stored both as KG nodes
 *  (node_set=rules) and as plain `rules`-namespace entries so the existing
 *  injection/search surfaces pick them up with zero new plumbing.
 *
 *  A candidate that dedups against an existing rule still ADDS its origin to
 *  that rule's support set: two independent runs asserting the same rule mean
 *  the rule survives either one being rolled back. Dropping the second origin
 *  (as this used to) made rollback of the FIRST run delete knowledge the
 *  second run independently vouched for.
 *
 *  Like `kgIngest`, NOT atomic — see that function's note. */
export async function kgIngestRules(options: {
  rules: { rule: string; context?: string }[];
  originRef: string;
  /** Owner of these rules. Omit for project-shared knowledge. */
  scope?: KgScope;
  dbPath?: string;
  /** Similarity above which a candidate is already_known (default 0.78 —
   *  MiniLM paraphrases of the same rule commonly land 0.78-0.9; cognee's
   *  equivalent control is prompt-injected LLM judgment, which we approximate). */
  dedupThreshold?: number;
}): Promise<{
  success: boolean;
  verdicts: RuleVerdict[];
  accepted: number;
  failures?: string[];
  error?: string;
  /** Candidates dropped by the per-call cap, reported rather than sliced away
   *  in silence. */
  rulesTruncated?: number;
}> {
  const verdicts: RuleVerdict[] = [];
  const threshold = options.dedupThreshold ?? 0.78;
  const failures = new FailureLog();
  const ns = kgNamespaces(options.scope);
  // Direct writes here store the qualified ref; nested kgIngest calls get the
  // RAW ref plus the scope and qualify it themselves, so it is stamped once.
  const originRef = kgQualifyOrigin(options.originRef, options.scope);
  let accepted = 0;
  const all = options.rules ?? [];
  const batch = all.slice(0, MAX_RULES_PER_CALL);
  const rulesTruncated = all.length - batch.length;

  try {
    for (const r of batch) {
      const rule = r?.rule?.trim();
      if (!rule || rule.length < 8) {
        verdicts.push({ rule: r?.rule ?? '', verdict: 'invalid' });
        continue;
      }

      const similar = await bridgeSearchEntries({
        query: rule,
        namespace: ns.rules,
        limit: 1,
        threshold,
        dbPath: options.dbPath,
      });
      const top = similar?.results?.[0];
      // Issue #111: FTS5 keyword scores are min-max normalized per batch.
      // With limit:1, the sole result always scores 1.0 — any rule sharing
      // even one keyword was falsely marked as a duplicate.
      //
      // Only trust embedding-backed (semantic) cosine scores for dedup.
      // Keyword-only matches can't distinguish paraphrases from merely
      // overlapping vocabulary — fall back to exact-text comparison.
      // (Key-based upsert on store already handles identical keys.)
      const provenance = top?.provenance;
      let isDuplicate = false;
      if (top && provenance?.startsWith('semantic:')) {
        const rawCosine = parseFloat(provenance.slice('semantic:'.length));
        isDuplicate = rawCosine >= threshold;
      } else if (top) {
        // Keyword-only: only suppress true near-exact duplicates.
        const existing = (top.content || '').replace(/\s+/g, ' ').trim().toLowerCase();
        const candidate = rule.replace(/\s+/g, ' ').trim().toLowerCase();
        isDuplicate = existing === candidate;
      }
      if (isDuplicate && top?.key) {
        // `already_known` is a claim that this origin now supports the existing
        // rule. If reinforcement did not land, it does not — and a later
        // rollback of the OTHER origin would delete a rule this run believes it
        // vouched for.
        const reinforced = await reinforceRuleOrigin(
          top.key,
          top.content,
          options.originRef,
          options.scope,
          options.dbPath,
          failures,
        );
        verdicts.push({
          rule,
          verdict: reinforced ? 'already_known' : 'failed',
          similarTo: top.key,
        });
        continue;
      }

      // Identity is the full rule text. The old key truncated at 120 normalized
      // characters, so two rules sharing a long preamble were the same rule.
      // A rule stored under that scheme is adopted in place rather than
      // duplicated under the new key.
      let key = ruleKey(rule);
      let priorMd: Record<string, unknown> = {};
      const current = await bridgeGetEntry({ key, namespace: ns.rules, dbPath: options.dbPath });
      if (current?.found && current.entry) priorMd = current.entry.metadata as typeof priorMd;
      else {
        const legacy = legacyRuleKey(rule);
        const hit = await bridgeGetEntry({
          key: legacy,
          namespace: ns.rules,
          dbPath: options.dbPath,
        });
        if (hit?.found && hit.entry) {
          key = legacy;
          priorMd = hit.entry.metadata as typeof priorMd;
        }
      }
      // The mirrored KG node is named by the FULL rule text. Truncating it to
      // 200 characters put two rules sharing a long preamble on one node — the
      // same collision `ruleKey` was just widened to prevent, reintroduced one
      // namespace over.
      const ruleName = rule;
      const stored = await bridgeStoreEntry({
        key,
        value: rule + (r.context ? `\n(context: ${r.context.slice(0, 500)})` : ''),
        namespace: ns.rules,
        dbPath: options.dbPath,
        upsert: true,
        tags: ['rule'],
        metadata: {
          ...priorMd,
          ...applyClaim(priorMd, originRef, rule, Date.now()),
          id_version: KG_ID_VERSION,
          derived_from: originRef,
          // Lets the dedup path reinforce the matching KG node without having
          // to re-derive the node name from the stored value (which may carry
          // an appended context block).
          rule: ruleName,
        },
      });
      const nodeRes = await kgIngest({
        nodes: [{ name: ruleName, type: 'Rule', description: rule, nodeSet: 'rules' }],
        originRef: options.originRef,
        scope: options.scope,
        dbPath: options.dbPath,
      });
      const ruleFailed = failures.add(stored, `rule ${key}`);
      if (!ruleFailed) await onEntrySupported(ns, ns.rules, key, originRef, options.dbPath);
      if (nodeRes.failures?.length) for (const m of nodeRes.failures) failures.note(m);
      // Only count a rule as accepted when BOTH of its writes landed; a rule
      // present in one namespace only is not the state the caller was told
      // about. The per-rule verdict now says the same thing — it read
      // `accepted` unconditionally, so the two halves of one result disagreed.
      const landed = !ruleFailed && nodeRes.success;
      if (landed) accepted++;
      verdicts.push({ rule, verdict: landed ? 'accepted' : 'failed' });
    }
    return {
      success: !failures.failed,
      verdicts,
      accepted,
      ...(failures.failed ? { failures: failures.messages, error: failures.summary() } : {}),
      ...(rulesTruncated ? { rulesTruncated } : {}),
    };
  } catch (err) {
    return {
      success: false,
      verdicts,
      accepted,
      ...(failures.messages.length ? { failures: failures.messages } : {}),
      ...(rulesTruncated ? { rulesTruncated } : {}),
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/** Add `originRef` to an already-stored rule's support set — both the
 *  `rules`-namespace entry and its `node_set=rules` KG node. Idempotent in
 *  effect: re-asserting an origin the rule already carries leaves the support
 *  set unchanged.
 *
 *  @returns true when the rule genuinely carries this origin afterwards —
 *  including the no-op case where it already did. False means the support set
 *  is not what the caller is about to be told it is. */
async function reinforceRuleOrigin(
  matchedKey: string,
  matchedContent: string,
  /** RAW ref — qualified here for the rules entry, and passed on unqualified
   *  to `kgIngest`, which qualifies it once with the same scope. */
  originRef: string,
  scope: KgScope | undefined,
  dbPath: string | undefined,
  failures: FailureLog,
): Promise<boolean> {
  const ns = kgNamespaces(scope);
  const qualified = kgQualifyOrigin(originRef, scope);
  const existing = await bridgeGetEntry({ key: matchedKey, namespace: ns.rules, dbPath });
  if (!existing?.found || !existing.entry) {
    // The dedup hit came from search; if the entry can't be re-read by key the
    // support set cannot be updated, and silently proceeding is exactly the
    // provenance loss this function exists to prevent.
    failures.note(`rule ${matchedKey}: matched by dedup but not readable by key`);
    return false;
  }
  const entry = existing.entry;
  const md = entry.metadata as Record<string, unknown>;
  const origins = Array.isArray(md.origin_refs) ? (md.origin_refs as string[]) : [];
  // The KG node's name: recorded at accept time, else the first line of the
  // stored value (any context block is appended after a newline).
  const ruleName =
    typeof md.rule === 'string' && md.rule
      ? md.rule
      : (matchedContent || entry.content).split('\n')[0];

  // Both writes are attempted regardless: skipping the node write because the
  // entry write failed would leave the two halves disagreeing about who
  // supports this rule. Only the REPORT changes.
  let ok = true;
  if (!origins.includes(qualified)) {
    const res = await bridgeStoreEntry({
      key: entry.key,
      value: entry.content,
      namespace: ns.rules,
      dbPath,
      upsert: true,
      generateEmbeddingFlag: entry.hasEmbedding,
      tags: entry.tags,
      metadata: {
        ...md,
        rule: ruleName,
        // A dedup hit is SUPPORT, not a correction: the candidate asserts the
        // rule the entry already holds. Its contribution therefore carries no
        // description of its own — passing one here (the truncated `rule` name,
        // as this did) made the newest claim disagree with the stored text and
        // flagged the rule as conflicted with a truncation of itself.
        ...applyClaim(md, qualified, '', Date.now()),
      },
    });
    if (failures.add(res, `rule ${entry.key}`)) ok = false;
    else await onEntrySupported(ns, ns.rules, entry.key, qualified, dbPath);
  }

  // The rule's KG node needs the same origin — rollback walks nodes separately.
  const nodeRes = await kgIngest({
    nodes: [{ name: ruleName, type: 'Rule', description: '', nodeSet: 'rules' }],
    originRef,
    scope,
    dbPath,
  });
  if (nodeRes.failures?.length) for (const m of nodeRes.failures) failures.note(m);
  return ok && nodeRes.success;
}

/** List stored rules (for injection or review). */
export async function kgListRules(options?: {
  dbPath?: string;
  limit?: number;
  scope?: KgScope;
}): Promise<{ rule: string; key: string }[]> {
  const res = await bridgeListEntries({
    namespace: kgNamespaces(options?.scope).rules,
    limit: options?.limit ?? 50,
    dbPath: options?.dbPath,
  });
  return (res?.entries ?? []).map((e) => ({ rule: e.content, key: e.key }));
}
