/**
 * Claims MCP tools for load balancing: claims_load, claims_board,
 * claims_rebalance.
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

export const claimsBalanceTools: MCPTool[] = [
  {
    name: 'claims_load',
    description: 'Get agent load information',
    category: 'claims',
    inputSchema: {
      type: 'object',
      properties: {
        agentId: {
          type: 'string',
          description: 'Specific agent ID (optional)',
        },
        agentType: {
          type: 'string',
          description: 'Filter by agent type',
        },
      },
    },
    handler: async (input) => {
      const agentId = input.agentId as string | undefined;
      const agentType = input.agentType as string | undefined;

      const store = loadClaims();
      const claims = Object.values(store.claims);

      // Group claims by agent
      const agentLoads = new Map<
        string,
        {
          agentId: string;
          agentType: string;
          claims: IssueClaim[];
          blockedCount: number;
        }
      >();

      for (const claim of claims) {
        if (claim.claimant.type !== 'agent') continue;

        const key = claim.claimant.agentId!;
        if (!agentLoads.has(key)) {
          agentLoads.set(key, {
            agentId: key,
            agentType: claim.claimant.agentType!,
            claims: [],
            blockedCount: 0,
          });
        }

        const load = agentLoads.get(key)!;
        load.claims.push(claim);
        if (claim.status === 'blocked') {
          load.blockedCount++;
        }
      }

      let loads = Array.from(agentLoads.values());

      if (agentId) {
        loads = loads.filter((l) => l.agentId === agentId);
      }

      if (agentType) {
        loads = loads.filter((l) => l.agentType === agentType);
      }

      const result = loads.map((l) => ({
        agentId: l.agentId,
        agentType: l.agentType,
        claimCount: l.claims.length,
        maxClaims: 5, // Default max
        utilization: l.claims.length / 5,
        blockedCount: l.blockedCount,
        claims: l.claims.map((c) => ({
          issueId: c.issueId,
          status: c.status,
          progress: c.progress,
        })),
      }));

      return {
        success: true,
        loads: result,
        totalAgents: result.length,
        totalClaims: claims.filter((c) => c.claimant.type === 'agent').length,
        avgUtilization:
          result.length > 0 ? result.reduce((sum, l) => sum + l.utilization, 0) / result.length : 0,
      };
    },
  },

  {
    name: 'claims_board',
    description: 'Get a visual board view of all claims',
    category: 'claims',
    inputSchema: {
      type: 'object',
      properties: {},
    },
    handler: async () => {
      const store = loadClaims();
      const claims = Object.values(store.claims);

      const byStatus: Record<string, IssueClaim[]> = {
        active: [],
        paused: [],
        blocked: [],
        'handoff-pending': [],
        'review-requested': [],
        stealable: [],
        completed: [],
      };

      for (const claim of claims) {
        if (byStatus[claim.status]) {
          byStatus[claim.status].push(claim);
        }
      }

      const humanClaims = claims.filter((c) => c.claimant.type === 'human');
      const agentClaims = claims.filter((c) => c.claimant.type === 'agent');

      return {
        success: true,
        board: {
          active: byStatus.active.map((c) => ({
            issueId: c.issueId,
            claimant: formatClaimant(c.claimant),
            progress: c.progress,
          })),
          paused: byStatus.paused.map((c) => ({
            issueId: c.issueId,
            claimant: formatClaimant(c.claimant),
          })),
          blocked: byStatus.blocked.map((c) => ({
            issueId: c.issueId,
            claimant: formatClaimant(c.claimant),
            reason: c.blockReason,
          })),
          'handoff-pending': byStatus['handoff-pending'].map((c) => ({
            issueId: c.issueId,
            from: formatClaimant(c.claimant),
            to: c.handoffTo ? formatClaimant(c.handoffTo) : null,
          })),
          'review-requested': byStatus['review-requested'].map((c) => ({
            issueId: c.issueId,
            claimant: formatClaimant(c.claimant),
          })),
          stealable: byStatus.stealable.map((c) => ({
            issueId: c.issueId,
            claimant: formatClaimant(c.claimant),
          })),
          completed: byStatus.completed.map((c) => ({
            issueId: c.issueId,
            claimant: formatClaimant(c.claimant),
          })),
        },
        summary: {
          total: claims.length,
          active: byStatus.active.length,
          blocked: byStatus.blocked.length,
          stealable: byStatus.stealable.length,
          humanClaims: humanClaims.length,
          agentClaims: agentClaims.length,
        },
      };
    },
  },

  {
    name: 'claims_rebalance',
    description: 'Suggest or apply load rebalancing across agents',
    category: 'claims',
    inputSchema: {
      type: 'object',
      properties: {
        dryRun: {
          type: 'boolean',
          description: 'Preview rebalancing without applying',
          default: true,
        },
        targetUtilization: {
          type: 'number',
          description: 'Target utilization (0-1)',
          default: 0.7,
        },
      },
    },
    handler: async (input) => {
      const dryRun = input.dryRun !== false;
      const targetUtilization = (input.targetUtilization as number) || 0.7;

      const store = loadClaims();
      const claims = Object.values(store.claims);

      // Group by agent
      const agentLoads = new Map<
        string,
        { agentId: string; agentType: string; claims: IssueClaim[] }
      >();

      for (const claim of claims) {
        if (claim.claimant.type !== 'agent') continue;

        const key = claim.claimant.agentId!;
        if (!agentLoads.has(key)) {
          agentLoads.set(key, { agentId: key, agentType: claim.claimant.agentType!, claims: [] });
        }
        agentLoads.get(key)?.claims.push(claim);
      }

      const loads = Array.from(agentLoads.values());
      const maxClaims = 5;
      const avgLoad =
        loads.length > 0 ? loads.reduce((sum, l) => sum + l.claims.length, 0) / loads.length : 0;

      const overloaded = loads.filter((l) => l.claims.length > maxClaims * targetUtilization * 1.5);
      const underloaded = loads.filter(
        (l) => l.claims.length < maxClaims * targetUtilization * 0.5,
      );

      const suggestions: Array<{ issueId: string; from: string; to: string; reason: string }> = [];

      for (const over of overloaded) {
        // Find low-progress claims to redistribute
        const movable = over.claims
          .filter((c) => c.progress < 25 && c.status === 'active')
          .slice(0, over.claims.length - Math.ceil(maxClaims * targetUtilization));

        for (const claim of movable) {
          const target = underloaded.find(
            (u) => u.agentType === over.agentType && u.claims.length < maxClaims,
          );
          if (target) {
            suggestions.push({
              issueId: claim.issueId,
              from: `agent:${over.agentId}:${over.agentType}`,
              to: `agent:${target.agentId}:${target.agentType}`,
              reason: 'Load balancing',
            });
          }
        }
      }

      // When not a dry run, execute the suggested moves
      if (!dryRun) {
        for (const suggestion of suggestions) {
          const claim = store.claims[suggestion.issueId];
          if (claim) {
            const newOwner = parseClaimant(suggestion.to);
            if (newOwner) {
              claim.claimant = newOwner;
              claim.statusChangedAt = new Date().toISOString();
              store.claims[suggestion.issueId] = claim;
            }
          }
        }
        saveClaims(store);
      }

      return {
        success: true,
        dryRun,
        suggestions,
        metrics: {
          totalAgents: loads.length,
          avgLoad,
          overloadedCount: overloaded.length,
          underloadedCount: underloaded.length,
          targetUtilization,
        },
        message: dryRun
          ? `Found ${suggestions.length} rebalancing opportunities (dry run)`
          : `Applied ${suggestions.length} rebalancing moves`,
      };
    },
  },
];
