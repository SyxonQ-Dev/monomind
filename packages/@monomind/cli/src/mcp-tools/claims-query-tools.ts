/**
 * Claims MCP tools: claims_status, claims_list.
 *
 * Registered through `claimsTools` in claims-tools.ts, which keeps the
 * registration order.
 */

import {
  type ClaimStatus,
  formatClaimant,
  loadClaims,
  parseClaimant,
  saveClaims,
} from './claims-store.js';
import type { MCPTool } from './types.js';

export const claimsQueryTools: MCPTool[] = [
  {
    name: 'claims_status',
    description: 'Update claim status',
    category: 'claims',
    inputSchema: {
      type: 'object',
      properties: {
        issueId: {
          type: 'string',
          description: 'Issue ID',
        },
        status: {
          type: 'string',
          description: 'New status',
          enum: ['active', 'paused', 'blocked', 'review-requested', 'completed'],
        },
        claimant: {
          type: 'string',
          description: 'Claimant identifier (must match current owner)',
        },
        note: {
          type: 'string',
          description: 'Status note or reason',
        },
        progress: {
          type: 'number',
          description: 'Current progress percentage',
        },
      },
      required: ['issueId', 'status'],
    },
    handler: async (input) => {
      const issueId = input.issueId as string;
      const status = input.status as ClaimStatus;
      const claimantStr = input.claimant as string | undefined;
      // Cap note: stored as claim.blockReason in the claims JSON store on disk.
      const MAX_CLAIM_NOTE_LEN = 4 * 1024;
      const rawNote = input.note as string | undefined;
      const note =
        typeof rawNote === 'string' && rawNote.length > MAX_CLAIM_NOTE_LEN
          ? rawNote.slice(0, MAX_CLAIM_NOTE_LEN)
          : rawNote;
      const progress = input.progress as number | undefined;

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

      if (claimantStr) {
        const claimant = parseClaimant(claimantStr);
        if (!claimant) {
          return { success: false, error: 'Invalid claimant format' };
        }
        if (formatClaimant(claim.claimant) !== formatClaimant(claimant)) {
          return { success: false, error: 'Only the current claimant can update status' };
        }
      }

      const now = new Date().toISOString();
      claim.status = status;
      claim.statusChangedAt = now;
      if (status === 'blocked') {
        claim.blockReason = note;
      }
      if (progress !== undefined) {
        claim.progress = Math.min(100, Math.max(0, progress));
      }

      store.claims[issueId] = claim;
      saveClaims(store);

      return {
        success: true,
        claim,
        message: `Issue ${issueId} status updated to ${status}`,
      };
    },
  },

  {
    name: 'claims_list',
    description: 'List all claims or filter by criteria',
    category: 'claims',
    inputSchema: {
      type: 'object',
      properties: {
        status: {
          type: 'string',
          description: 'Filter by status',
          enum: ['active', 'paused', 'blocked', 'stealable', 'completed', 'all'],
        },
        claimant: {
          type: 'string',
          description: 'Filter by claimant',
        },
        agentType: {
          type: 'string',
          description: 'Filter by agent type',
        },
      },
    },
    handler: async (input) => {
      const status = input.status as string | undefined;
      const claimantFilter = input.claimant as string | undefined;
      const agentType = input.agentType as string | undefined;

      const store = loadClaims();
      let claims = Object.values(store.claims);

      if (status && status !== 'all') {
        claims = claims.filter((c) => c.status === status);
      }

      if (claimantFilter) {
        claims = claims.filter((c) => formatClaimant(c.claimant).includes(claimantFilter));
      }

      if (agentType) {
        claims = claims.filter(
          (c) => c.claimant.type === 'agent' && c.claimant.agentType === agentType,
        );
      }

      return {
        success: true,
        claims,
        count: claims.length,
        stealableCount: Object.keys(store.stealable).length,
      };
    },
  },
];
