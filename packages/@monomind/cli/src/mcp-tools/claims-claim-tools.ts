/**
 * Claims MCP tools: claims_claim, claims_release, claims_handoff,
 * claims_accept-handoff.
 *
 * Registered through `claimsTools` in claims-tools.ts, which keeps the
 * registration order.
 */

import {
  formatClaimant,
  type IssueClaim,
  loadClaims,
  parseClaimant,
  saveClaims,
} from './claims-store.js';
import type { MCPTool } from './types.js';

export const claimsClaimTools: MCPTool[] = [
  {
    name: 'claims_claim',
    description: 'Claim an issue for work (human or agent)',
    category: 'claims',
    inputSchema: {
      type: 'object',
      properties: {
        issueId: {
          type: 'string',
          description: 'Issue ID or GitHub issue number',
        },
        claimant: {
          type: 'string',
          description: 'Claimant identifier (e.g., "human:user-1:Alice" or "agent:coder-1:coder")',
        },
        context: {
          type: 'string',
          description: 'Optional context about the work approach',
        },
      },
      required: ['issueId', 'claimant'],
    },
    handler: async (input) => {
      const issueId = input.issueId as string;
      const claimantStr = input.claimant as string;
      // Cap context: stored verbatim in the claim JSON record on disk.
      const MAX_CLAIM_CONTEXT_LEN = 4 * 1024;
      const rawContext = input.context as string | undefined;
      const context =
        typeof rawContext === 'string' && rawContext.length > MAX_CLAIM_CONTEXT_LEN
          ? rawContext.slice(0, MAX_CLAIM_CONTEXT_LEN)
          : rawContext;

      const RESERVED_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
      if (!issueId || issueId.length > 256 || RESERVED_KEYS.has(issueId)) {
        return { success: false, error: 'Invalid issueId' };
      }

      const claimant = parseClaimant(claimantStr);
      if (!claimant) {
        return {
          success: false,
          error: 'Invalid claimant format. Use "human:userId:name" or "agent:agentId:agentType"',
        };
      }

      const store = loadClaims();

      const MAX_CLAIMS = 10000;
      if (Object.keys(store.claims).length >= MAX_CLAIMS) {
        return { success: false, error: 'Claims store at capacity' };
      }

      // Check if already claimed (Object.hasOwn defends against bracket access
      // resolving to inherited Object.prototype methods like `toString`)
      if (Object.hasOwn(store.claims, issueId)) {
        const existing = store.claims[issueId];
        return {
          success: false,
          error: `Issue already claimed by ${formatClaimant(existing.claimant)}`,
          existingClaim: existing,
        };
      }

      const now = new Date().toISOString();
      const claim: IssueClaim = {
        issueId,
        claimant,
        claimedAt: now,
        status: 'active',
        statusChangedAt: now,
        progress: 0,
        context,
      };

      store.claims[issueId] = claim;
      saveClaims(store);

      return {
        success: true,
        claim,
        message: `Issue ${issueId} claimed by ${formatClaimant(claimant)}`,
      };
    },
  },

  {
    name: 'claims_release',
    description: 'Release a claim on an issue',
    category: 'claims',
    inputSchema: {
      type: 'object',
      properties: {
        issueId: {
          type: 'string',
          description: 'Issue ID to release',
        },
        claimant: {
          type: 'string',
          description: 'Claimant identifier (must match current owner)',
        },
        reason: {
          type: 'string',
          description: 'Reason for releasing',
        },
      },
      required: ['issueId', 'claimant'],
    },
    handler: async (input) => {
      const issueId = input.issueId as string;
      const claimantStr = input.claimant as string;
      const reason = input.reason as string | undefined;

      const RESERVED_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
      if (
        !issueId ||
        typeof issueId !== 'string' ||
        issueId.length > 256 ||
        RESERVED_KEYS.has(issueId)
      ) {
        return { success: false, error: 'Invalid issueId' };
      }

      const claimant = parseClaimant(claimantStr);
      if (!claimant) {
        return { success: false, error: 'Invalid claimant format' };
      }

      const store = loadClaims();
      if (!Object.hasOwn(store.claims, issueId)) {
        return { success: false, error: 'Issue is not claimed' };
      }
      const claim = store.claims[issueId];

      // Verify ownership
      if (formatClaimant(claim.claimant) !== formatClaimant(claimant)) {
        return { success: false, error: 'Only the current claimant can release' };
      }

      delete store.claims[issueId];
      delete store.stealable[issueId];
      saveClaims(store);

      return {
        success: true,
        message: `Issue ${issueId} released`,
        reason,
        previousClaim: claim,
      };
    },
  },

  {
    name: 'claims_handoff',
    description: 'Request handoff of an issue to another claimant',
    category: 'claims',
    inputSchema: {
      type: 'object',
      properties: {
        issueId: {
          type: 'string',
          description: 'Issue ID to handoff',
        },
        from: {
          type: 'string',
          description: 'Current claimant identifier',
        },
        to: {
          type: 'string',
          description: 'Target claimant identifier',
        },
        reason: {
          type: 'string',
          description: 'Reason for handoff',
        },
        progress: {
          type: 'number',
          description: 'Current progress percentage (0-100)',
        },
      },
      required: ['issueId', 'from', 'to'],
    },
    handler: async (input) => {
      const issueId = input.issueId as string;
      const fromStr = input.from as string;
      const toStr = input.to as string;
      // Cap handoff reason: stored as claim.handoffReason in the claims JSON store on disk.
      // Without a cap, an arbitrarily long reason inflates every write of the store file.
      const MAX_HANDOFF_REASON_LEN = 1024;
      const rawHandoffReason = input.reason as string | undefined;
      const reason =
        typeof rawHandoffReason === 'string' && rawHandoffReason.length > MAX_HANDOFF_REASON_LEN
          ? rawHandoffReason.slice(0, MAX_HANDOFF_REASON_LEN)
          : rawHandoffReason;
      const progress = (input.progress as number) || 0;

      const RESERVED_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
      if (
        !issueId ||
        typeof issueId !== 'string' ||
        issueId.length > 256 ||
        RESERVED_KEYS.has(issueId)
      ) {
        return { success: false, error: 'Invalid issueId' };
      }

      const from = parseClaimant(fromStr);
      const to = parseClaimant(toStr);

      if (!from || !to) {
        return { success: false, error: 'Invalid claimant format' };
      }

      const store = loadClaims();
      if (!Object.hasOwn(store.claims, issueId)) {
        return { success: false, error: 'Issue is not claimed' };
      }
      const claim = store.claims[issueId];

      if (formatClaimant(claim.claimant) !== formatClaimant(from)) {
        return { success: false, error: 'Only the current claimant can request handoff' };
      }

      const now = new Date().toISOString();
      claim.status = 'handoff-pending';
      claim.statusChangedAt = now;
      claim.handoffTo = to;
      claim.handoffReason = reason;
      claim.progress = progress;

      store.claims[issueId] = claim;
      saveClaims(store);

      return {
        success: true,
        claim,
        message: `Handoff requested from ${formatClaimant(from)} to ${formatClaimant(to)}`,
      };
    },
  },

  {
    name: 'claims_accept-handoff',
    description: 'Accept a pending handoff',
    category: 'claims',
    inputSchema: {
      type: 'object',
      properties: {
        issueId: {
          type: 'string',
          description: 'Issue ID with pending handoff',
        },
        claimant: {
          type: 'string',
          description: 'Claimant accepting the handoff',
        },
      },
      required: ['issueId', 'claimant'],
    },
    handler: async (input) => {
      const issueId = input.issueId as string;
      const claimantStr = input.claimant as string;

      const RESERVED_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
      if (
        !issueId ||
        typeof issueId !== 'string' ||
        issueId.length > 256 ||
        RESERVED_KEYS.has(issueId)
      ) {
        return { success: false, error: 'Invalid issueId' };
      }

      const claimant = parseClaimant(claimantStr);
      if (!claimant) {
        return { success: false, error: 'Invalid claimant format' };
      }

      const store = loadClaims();
      if (!Object.hasOwn(store.claims, issueId)) {
        return { success: false, error: 'Issue is not claimed' };
      }
      const claim = store.claims[issueId];

      if (claim.status !== 'handoff-pending') {
        return { success: false, error: 'No pending handoff for this issue' };
      }

      if (!claim.handoffTo || formatClaimant(claim.handoffTo) !== formatClaimant(claimant)) {
        return { success: false, error: 'You are not the target of this handoff' };
      }

      const previousOwner = claim.claimant;
      const now = new Date().toISOString();

      claim.claimant = claimant;
      claim.status = 'active';
      claim.statusChangedAt = now;
      claim.handoffTo = undefined;
      claim.handoffReason = undefined;

      store.claims[issueId] = claim;
      saveClaims(store);

      return {
        success: true,
        claim,
        previousOwner,
        message: `Handoff accepted. ${formatClaimant(claimant)} now owns issue ${issueId}`,
      };
    },
  },
];
