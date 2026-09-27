/**
 * Claims MCP tools for work stealing: claims_mark-stealable, claims_steal,
 * claims_stealable.
 *
 * Registered through `claimsTools` in claims-tools.ts, which keeps the
 * registration order.
 */

import {
  formatClaimant,
  loadClaims,
  parseClaimant,
  type StealReason,
  saveClaims,
} from './claims-store.js';
import type { MCPTool } from './types.js';

export const claimsStealTools: MCPTool[] = [
  {
    name: 'claims_mark-stealable',
    description: 'Mark an issue as stealable by other agents',
    category: 'claims',
    inputSchema: {
      type: 'object',
      properties: {
        issueId: {
          type: 'string',
          description: 'Issue ID to mark stealable',
        },
        reason: {
          type: 'string',
          description: 'Reason for marking stealable',
          enum: ['overloaded', 'stale', 'blocked-timeout', 'voluntary'],
        },
        preferredTypes: {
          type: 'array',
          description: 'Preferred agent types to steal',
          items: { type: 'string' },
        },
        context: {
          type: 'string',
          description: 'Handoff context for the stealer',
        },
      },
      required: ['issueId', 'reason'],
    },
    handler: async (input) => {
      const issueId = input.issueId as string;
      // Runtime-validate StealReason: JSON schema declares an enum, but callers
      // that bypass schema validation (raw MCP calls) can pass arbitrary strings,
      // which would be persisted verbatim in store.stealable[issueId].reason.
      const VALID_STEAL_REASONS = new Set<string>([
        'overloaded',
        'stale',
        'blocked-timeout',
        'voluntary',
      ]);
      const rawStealReason = input.reason as string;
      if (!rawStealReason || !VALID_STEAL_REASONS.has(rawStealReason)) {
        return {
          success: false,
          error: `Invalid reason "${rawStealReason}". Must be one of: overloaded, stale, blocked-timeout, voluntary`,
        };
      }
      const reason = rawStealReason as StealReason;
      const preferredTypes = input.preferredTypes as string[] | undefined;
      // Cap context: stored verbatim in the stealable record on disk.
      const MAX_STEAL_CONTEXT_LEN = 4 * 1024;
      const rawStealContext = input.context as string | undefined;
      const context =
        typeof rawStealContext === 'string' && rawStealContext.length > MAX_STEAL_CONTEXT_LEN
          ? rawStealContext.slice(0, MAX_STEAL_CONTEXT_LEN)
          : rawStealContext;

      const RESERVED_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
      if (
        !issueId ||
        typeof issueId !== 'string' ||
        issueId.length > 256 ||
        RESERVED_KEYS.has(issueId)
      ) {
        return { success: false, error: 'Invalid issueId' };
      }

      const store = loadClaims();
      if (!Object.hasOwn(store.claims, issueId)) {
        return { success: false, error: 'Issue is not claimed' };
      }
      const claim = store.claims[issueId];

      const now = new Date().toISOString();
      claim.status = 'stealable';
      claim.statusChangedAt = now;

      store.stealable[issueId] = {
        reason,
        stealableAt: now,
        preferredTypes,
        progress: claim.progress,
        context,
      };

      store.claims[issueId] = claim;
      saveClaims(store);

      return {
        success: true,
        claim,
        stealableInfo: store.stealable[issueId],
        message: `Issue ${issueId} marked as stealable (${reason})`,
      };
    },
  },

  {
    name: 'claims_steal',
    description: 'Steal a stealable issue',
    category: 'claims',
    inputSchema: {
      type: 'object',
      properties: {
        issueId: {
          type: 'string',
          description: 'Issue ID to steal',
        },
        stealer: {
          type: 'string',
          description: 'Claimant stealing the issue',
        },
      },
      required: ['issueId', 'stealer'],
    },
    handler: async (input) => {
      const issueId = input.issueId as string;
      const stealerStr = input.stealer as string;

      const RESERVED_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
      if (
        !issueId ||
        typeof issueId !== 'string' ||
        issueId.length > 256 ||
        RESERVED_KEYS.has(issueId)
      ) {
        return { success: false, error: 'Invalid issueId' };
      }

      const stealer = parseClaimant(stealerStr);
      if (!stealer) {
        return { success: false, error: 'Invalid claimant format' };
      }

      const store = loadClaims();
      if (!Object.hasOwn(store.claims, issueId)) {
        return { success: false, error: 'Issue is not claimed' };
      }
      const claim = store.claims[issueId];
      const stealableInfo = Object.hasOwn(store.stealable, issueId)
        ? store.stealable[issueId]
        : undefined;

      if (!stealableInfo) {
        return { success: false, error: 'Issue is not stealable' };
      }

      // Check preferred types
      if (stealableInfo.preferredTypes && stealableInfo.preferredTypes.length > 0) {
        if (
          stealer.type === 'agent' &&
          !stealableInfo.preferredTypes.includes(stealer.agentType!)
        ) {
          return {
            success: false,
            error: `Issue prefers agent types: ${stealableInfo.preferredTypes.join(', ')}`,
          };
        }
      }

      const previousOwner = claim.claimant;
      const now = new Date().toISOString();

      claim.claimant = stealer;
      claim.status = 'active';
      claim.statusChangedAt = now;
      claim.context = stealableInfo.context;

      delete store.stealable[issueId];
      store.claims[issueId] = claim;
      saveClaims(store);

      return {
        success: true,
        claim,
        previousOwner,
        stealableInfo,
        message: `Issue ${issueId} stolen by ${formatClaimant(stealer)}`,
      };
    },
  },

  {
    name: 'claims_stealable',
    description: 'List all stealable issues',
    category: 'claims',
    inputSchema: {
      type: 'object',
      properties: {
        agentType: {
          type: 'string',
          description: 'Filter by preferred agent type',
        },
      },
    },
    handler: async (input) => {
      const agentType = input.agentType as string | undefined;

      const store = loadClaims();
      let stealableIssues = Object.entries(store.stealable).map(([issueId, info]) => ({
        issueId,
        ...info,
        claim: store.claims[issueId],
      }));

      if (agentType) {
        stealableIssues = stealableIssues.filter(
          (s) =>
            !s.preferredTypes ||
            s.preferredTypes.length === 0 ||
            s.preferredTypes.includes(agentType),
        );
      }

      return {
        success: true,
        stealable: stealableIssues,
        count: stealableIssues.length,
      };
    },
  },
];
