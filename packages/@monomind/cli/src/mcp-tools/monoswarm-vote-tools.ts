/**
 * Monoswarm vote tool: monoswarm_vote (vote-count thresholds, not
 * distributed consensus).
 *
 * Registered through `monoswarmTools` in monoswarm-tools.ts, which keeps the
 * registration order; see that module for what these tools do and do not do.
 */

import { join } from 'node:path';
import {
  calculateRequiredVotes,
  detectDuplicateVotes,
  getOrCreateAuditKey,
  loadMonoswarmState,
  saveMonoswarmState,
  tryResolveProposal,
  type VoteProposal,
  type VoteStrategy,
} from './monoswarm-state.js';
import { getProjectCwd, type MCPTool } from './types.js';

export const monoswarmVoteTools: MCPTool[] = [
  {
    name: 'monoswarm_vote',
    description:
      "Create or vote on a proposal; passes when the vote count meets the chosen strategy's threshold (majority / supermajority / unanimous / a custom threshold) — single in-process tally, not a distributed consensus protocol.",
    category: 'monoswarm',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['propose', 'vote', 'status', 'list'],
          description: 'Vote action',
        },
        proposalId: { type: 'string', description: 'Proposal ID (for vote/status)' },
        type: { type: 'string', description: 'Proposal type (for propose)' },
        value: { description: 'Proposal value (for propose)' },
        vote: { type: 'boolean', description: 'Vote (true=for, false=against)' },
        voterId: { type: 'string', description: 'Voter agent ID' },
        strategy: {
          type: 'string',
          enum: ['majority', 'supermajority', 'unanimous', 'threshold'],
          description:
            'Vote strategy (default: the strategy chosen at monoswarm_init, else majority)',
        },
        minVotes: {
          type: 'number',
          description: 'Explicit vote count required (for threshold strategy)',
        },
        minDivergenceRounds: {
          type: 'number',
          description:
            'Anti-groupthink delay: minimum rounds with divergent votes required before resolution. Default: 0 (disabled).',
        },
      },
      required: ['action'],
    },
    handler: async (input) => {
      const state = loadMonoswarmState();
      const action = input.action as string;
      const rawStrategy = (input.strategy as string) || state.voteStrategy || 'majority';
      const VALID_STRATEGIES: VoteStrategy[] = [
        'majority',
        'supermajority',
        'unanimous',
        'threshold',
      ];
      if (!(VALID_STRATEGIES as string[]).includes(rawStrategy)) {
        return {
          action,
          error: `Unknown strategy "${rawStrategy}". Available strategies: ${VALID_STRATEGIES.join(', ')}.`,
          availableStrategies: VALID_STRATEGIES,
        };
      }
      const strategy = rawStrategy as VoteStrategy;
      const totalVoters = state.agents.length;

      if (action === 'propose') {
        const proposalId = `proposal-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        const minVotes = strategy === 'threshold' ? (input.minVotes as number) : undefined;

        const required = calculateRequiredVotes(strategy, totalVoters, minVotes);

        const minDivergenceRounds =
          typeof input.minDivergenceRounds === 'number'
            ? Math.max(0, input.minDivergenceRounds as number)
            : 0;

        const MAX_TYPE_LEN = 128;
        const MAX_VOTER_ID_LEN = 256;
        const MAX_VALUE_BYTES = 64 * 1024;
        const rawType = (input.type as string) || 'general';
        const proposalType =
          typeof rawType === 'string' && rawType.length > MAX_TYPE_LEN
            ? rawType.slice(0, MAX_TYPE_LEN)
            : rawType;
        const rawVoterId = (input.voterId as string) || 'system';
        const proposedBy =
          typeof rawVoterId === 'string' && rawVoterId.length > MAX_VOTER_ID_LEN
            ? rawVoterId.slice(0, MAX_VOTER_ID_LEN)
            : rawVoterId;
        const rawValue = input.value;
        const cappedValue =
          typeof rawValue === 'string' && rawValue.length > MAX_VALUE_BYTES
            ? rawValue.slice(0, MAX_VALUE_BYTES)
            : rawValue;

        const proposal: VoteProposal = {
          proposalId,
          type: proposalType,
          value: cappedValue,
          proposedBy,
          proposedAt: new Date().toISOString(),
          votes: {},
          status: 'pending',
          strategy,
          minVotes: strategy === 'threshold' ? required : undefined,
          duplicateVoters: undefined,
          minDivergenceRounds: minDivergenceRounds > 0 ? minDivergenceRounds : undefined,
          divergenceRoundsSeen: 0,
        };

        state.votes.pending.push(proposal);
        saveMonoswarmState(state);

        return {
          action,
          proposalId,
          type: proposal.type,
          strategy,
          status: 'pending',
          required,
          totalVoters,
          minVotes: proposal.minVotes,
          minDivergenceRounds: proposal.minDivergenceRounds,
        };
      }

      if (action === 'vote') {
        const proposal = state.votes.pending.find((p) => p.proposalId === input.proposalId);
        if (!proposal) {
          return { action, error: 'Proposal not found or already resolved' };
        }

        const voterId = input.voterId as string;
        if (!voterId) {
          return { action, error: 'voterId is required for voting' };
        }
        if (totalVoters === 0) {
          return { action, error: 'No agents in roster — cannot vote' };
        }
        if (!state.agents.includes(voterId)) {
          return { action, error: `Voter ${voterId} is not a member of this roster` };
        }

        const voteValue = input.vote as boolean;
        const proposalStrategy = proposal.strategy || 'majority';
        const required = calculateRequiredVotes(proposalStrategy, totalVoters, proposal.minVotes);

        if (voterId in proposal.votes) {
          const previousVote = proposal.votes[voterId];
          if (previousVote === voteValue) {
            return {
              action,
              error: `Voter ${voterId} has already cast the same vote on this proposal`,
              proposalId: proposal.proposalId,
              existingVote: previousVote,
            };
          }
          // Conflicting vote from the same voter — flag it and drop the vote.
          if (!proposal.duplicateVoters) proposal.duplicateVoters = [];
          if (!proposal.duplicateVoters.includes(voterId)) {
            proposal.duplicateVoters.push(voterId);
          }
          delete proposal.votes[voterId];
          saveMonoswarmState(state);

          return {
            action,
            proposalId: proposal.proposalId,
            voterId,
            duplicateVoteDetected: true,
            message: `Voter ${voterId} attempted a conflicting vote. Previous vote invalidated.`,
            duplicateVoters: proposal.duplicateVoters,
            status: proposal.status,
          };
        }

        // Cross-proposal duplicate-vote check (same voter, same proposal type, conflicting votes).
        const isDuplicate = detectDuplicateVotes(state.votes.pending, proposal, voterId, voteValue);
        if (isDuplicate) {
          if (!proposal.duplicateVoters) proposal.duplicateVoters = [];
          if (!proposal.duplicateVoters.includes(voterId)) {
            proposal.duplicateVoters.push(voterId);
          }
          saveMonoswarmState(state);
          return {
            action,
            proposalId: proposal.proposalId,
            voterId,
            duplicateVoteDetected: true,
            message: `Voter ${voterId} cast conflicting votes across proposals of the same type. Vote rejected.`,
            duplicateVoters: proposal.duplicateVoters,
            status: proposal.status,
          };
        }

        proposal.votes[voterId] = voteValue;

        const votesFor = Object.values(proposal.votes).filter((v) => v).length;
        const votesAgainst = Object.values(proposal.votes).filter((v) => !v).length;

        const allVotes = Object.values(proposal.votes);
        const isUnanimous = allVotes.every((v) => v) || allVotes.every((v) => !v);
        if (!isUnanimous && allVotes.length >= 2) {
          proposal.divergenceRoundsSeen = (proposal.divergenceRoundsSeen ?? 0) + 1;
        }

        const totalVotesCast = Object.keys(proposal.votes).length;
        const electorateExhausted = totalVoters > 0 && totalVotesCast >= totalVoters;
        const divergenceGateOpen =
          !proposal.minDivergenceRounds ||
          (proposal.divergenceRoundsSeen ?? 0) >= proposal.minDivergenceRounds ||
          electorateExhausted;

        const resolution = divergenceGateOpen ? tryResolveProposal(proposal, totalVoters) : null;
        let resolved = false;

        if (resolution !== null) {
          resolved = true;
          proposal.status = resolution;
          state.votes.history.push({
            proposalId: proposal.proposalId,
            type: proposal.type,
            result: resolution,
            votes: { for: votesFor, against: votesAgainst },
            decidedAt: new Date().toISOString(),
            strategy: proposalStrategy,
            duplicateVotersDetected: proposal.duplicateVoters?.length
              ? proposal.duplicateVoters
              : undefined,
          });
          if (state.votes.history.length > 1000) {
            state.votes.history = state.votes.history.slice(-1000);
          }
          state.votes.pending = state.votes.pending.filter(
            (p) => p.proposalId !== proposal.proposalId,
          );
        }

        saveMonoswarmState(state);

        if (resolved) {
          try {
            const bridge = await import('../memory/memory-bridge.js');
            await bridge.bridgeStoreEntry({
              key: `monoswarm-vote-${proposal.proposalId}`,
              value: JSON.stringify({
                proposalId: proposal.proposalId,
                type: proposal.type,
                strategy: proposalStrategy,
                status: proposal.status,
                votes: proposal.votes,
                resolvedAt: new Date().toISOString(),
              }),
              namespace: 'monoswarm-votes',
              tags: [proposal.type, proposalStrategy, proposal.status],
            });
          } catch {
            /* SQLite memory backend not available — JSON store is primary */
          }

          const hk = getOrCreateAuditKey();
          try {
            const { AuditWriter } = await import('../consensus/audit-writer.js');
            const auditDir = join(getProjectCwd(), '.monomind', 'consensus');
            const writer = new AuditWriter(auditDir);
            const now = new Date().toISOString();
            const voteEntries = Object.entries(proposal.votes).map(([agentId, vote]) => ({
              agentId,
              agentSlug: agentId,
              vote,
              votedAt: now,
            }));
            writer.record({
              decisionId: proposal.proposalId,
              swarmId: state.monoswarmId,
              protocol: proposalStrategy as
                | 'majority'
                | 'supermajority'
                | 'unanimous'
                | 'threshold',
              topic: proposal.type,
              decision: resolution,
              votes: voteEntries,
              quorumRequired: required,
              quorumThreshold: required / Math.max(totalVoters, 1),
              round: (proposal.divergenceRoundsSeen ?? 0) + 1,
              startedAt: proposal.proposedAt,
              completedAt: now,
              sessionSecret: hk,
            });
          } catch (e) {
            if (process.env.MONOMIND_LOG_LEVEL === 'debug') {
              process.stderr.write(
                `[monoswarm-vote] Audit write failed: ${(e as Error).message}\n`,
              );
            }
          }
        }

        return {
          action,
          proposalId: proposal.proposalId,
          voterId,
          vote: voteValue,
          strategy: proposalStrategy,
          votesFor,
          votesAgainst,
          required,
          totalVoters,
          resolved,
          result: resolved ? resolution : undefined,
          status: proposal.status,
          duplicateVoters: proposal.duplicateVoters?.length ? proposal.duplicateVoters : undefined,
          divergenceGateOpen,
          divergenceRoundsSeen: proposal.divergenceRoundsSeen ?? 0,
          minDivergenceRounds: proposal.minDivergenceRounds,
          divergenceHint: !divergenceGateOpen
            ? `Anti-groupthink delay: ${proposal.divergenceRoundsSeen ?? 0}/${proposal.minDivergenceRounds} divergent rounds seen. Resolution deferred.`
            : undefined,
        };
      }

      if (action === 'status') {
        const proposal = state.votes.pending.find((p) => p.proposalId === input.proposalId);
        if (!proposal) {
          const historical = state.votes.history.find((h) => h.proposalId === input.proposalId);
          if (historical) {
            return { action, ...historical, historical: true, resolved: true };
          }
          return { action, error: 'Proposal not found' };
        }

        const votesFor = Object.values(proposal.votes).filter((v) => v).length;
        const votesAgainst = Object.values(proposal.votes).filter((v) => !v).length;
        const proposalStrategy = proposal.strategy || 'majority';
        const required = calculateRequiredVotes(proposalStrategy, totalVoters, proposal.minVotes);

        return {
          action,
          proposalId: proposal.proposalId,
          type: proposal.type,
          strategy: proposalStrategy,
          status: proposal.status,
          votesFor,
          votesAgainst,
          totalVotes: Object.keys(proposal.votes).length,
          required,
          totalVoters,
          resolved: false,
          minVotes: proposal.minVotes,
          duplicateVoters: proposal.duplicateVoters?.length ? proposal.duplicateVoters : undefined,
        };
      }

      if (action === 'list') {
        return {
          action,
          pending: state.votes.pending.map((p) => ({
            proposalId: p.proposalId,
            type: p.type,
            strategy: p.strategy || 'majority',
            proposedAt: p.proposedAt,
            totalVotes: Object.keys(p.votes).length,
            required: calculateRequiredVotes(p.strategy || 'majority', totalVoters, p.minVotes),
            status: p.status,
          })),
          recentHistory: state.votes.history.slice(-5),
        };
      }

      return { action, error: 'Unknown action' };
    },
  },
];
