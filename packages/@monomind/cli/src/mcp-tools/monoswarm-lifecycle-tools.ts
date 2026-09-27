/**
 * Monoswarm lifecycle tools: monoswarm_init, monoswarm_status,
 * monoswarm_scale, monoswarm_health, monoswarm_shutdown.
 *
 * Registered through `monoswarmTools` in monoswarm-tools.ts, which keeps the
 * registration order; see that module for what these tools do and do not do.
 */

import { randomBytes } from 'node:crypto';
import { existsSync, statSync } from 'node:fs';
import { agentTools, loadAgentStore, loadAgentStoreOrNull } from './agent-tools.js';
import {
  getMonoswarmStatePath,
  loadMonoswarmState,
  type MonoswarmState,
  saveAgentStore,
  saveMonoswarmState,
  VALID_TOPOLOGIES,
  type VoteStrategy,
} from './monoswarm-state.js';
import type { MCPTool } from './types.js';

export const monoswarmLifecycleTools: MCPTool[] = [
  {
    name: 'monoswarm_init',
    description:
      "Record a coordination topology, agent roster, and vote strategy in a JSON state file. Starts no process — agents are dispatched separately via Claude Code's Task tool.",
    category: 'monoswarm',
    inputSchema: {
      type: 'object',
      properties: {
        topology: {
          type: 'string',
          description:
            'Topology label (hierarchical, mesh, hierarchical-mesh, ring, star, hybrid, adaptive)',
        },
        maxAgents: { type: 'number', description: 'Maximum number of agents (1-50)' },
        strategy: {
          type: 'string',
          description: 'Agent role strategy (specialized, balanced, adaptive)',
        },
        coordinatorId: {
          type: 'string',
          description: 'Initial coordinator agent ID (formerly "queen")',
        },
        voteStrategy: {
          type: 'string',
          enum: ['majority', 'supermajority', 'unanimous', 'threshold'],
          description: 'Default vote strategy for monoswarm_vote. Default: majority.',
        },
      },
    },
    handler: async (input) => {
      const topology = (input.topology as string) || 'hierarchical-mesh';
      const maxAgents = Math.min(Math.max((input.maxAgents as number) || 8, 1), 50);
      const MAX_FIELD_LEN = 256;
      const rawStrategy = (input.strategy as string) || 'specialized';
      const strategy =
        typeof rawStrategy === 'string' && rawStrategy.length > MAX_FIELD_LEN
          ? rawStrategy.slice(0, MAX_FIELD_LEN)
          : rawStrategy;

      if (!VALID_TOPOLOGIES.has(topology)) {
        return {
          success: false,
          error: `Invalid topology: ${topology}. Valid: ${[...VALID_TOPOLOGIES].join(', ')}`,
        };
      }

      const VALID_VOTE_STRATEGIES: VoteStrategy[] = [
        'majority',
        'supermajority',
        'unanimous',
        'threshold',
      ];
      const rawVoteStrategy = (input.voteStrategy as string) || 'majority';
      const voteStrategy: VoteStrategy = (VALID_VOTE_STRATEGIES as string[]).includes(
        rawVoteStrategy,
      )
        ? (rawVoteStrategy as VoteStrategy)
        : 'majority';

      const rawCoordinatorId = (input.coordinatorId as string) || undefined;
      const coordinatorId =
        typeof rawCoordinatorId === 'string' && rawCoordinatorId.length > MAX_FIELD_LEN
          ? rawCoordinatorId.slice(0, MAX_FIELD_LEN)
          : rawCoordinatorId;

      const monoswarmId = `monoswarm-${Date.now()}-${randomBytes(6).toString('hex')}`;
      const now = new Date().toISOString();

      const state: MonoswarmState = {
        monoswarmId,
        initialized: true,
        topology,
        maxAgents,
        status: 'running',
        agents: [],
        coordinator: coordinatorId
          ? { agentId: coordinatorId, electedAt: now, term: 1 }
          : undefined,
        tasks: [],
        config: { topology, maxAgents, strategy },
        voteStrategy,
        votes: { pending: [], history: [] },
        sharedMemory: {},
        notices: [],
        createdAt: now,
        updatedAt: now,
      };

      saveMonoswarmState(state);

      return {
        success: true,
        monoswarmId,
        topology,
        strategy,
        maxAgents,
        voteStrategy,
        coordinatorId,
        initializedAt: now,
        config: state.config,
        persisted: true,
      };
    },
  },
  {
    name: 'monoswarm_status',
    description:
      'Read the merged coordination + vote state from the JSON state file — agent roster, topology, pending/resolved votes, shared memory key count.',
    category: 'monoswarm',
    inputSchema: {
      type: 'object',
      properties: {
        verbose: {
          type: 'boolean',
          description: 'Include worker details, vote history, and shared memory contents',
        },
      },
    },
    handler: async (input) => {
      const state = loadMonoswarmState();

      if (!state.initialized) {
        return {
          status: 'not_initialized',
          message: 'No monoswarm state recorded. Use monoswarm_init to create one.',
        };
      }

      const agentStore = loadAgentStore();
      const uptime = state.createdAt ? Date.now() - new Date(state.createdAt).getTime() : 0;

      let stateBytes = 0;
      try {
        const path = getMonoswarmStatePath();
        if (existsSync(path)) stateBytes = statSync(path).size;
      } catch {
        /* best-effort */
      }

      const summary = {
        monoswarmId: state.monoswarmId,
        status: state.status,
        topology: state.topology,
        maxAgents: state.maxAgents,
        agentCount: state.agents.length,
        taskCount: state.tasks.length,
        voteStrategy: state.voteStrategy ?? 'majority',
        coordinator: state.coordinator
          ? {
              agentId: state.coordinator.agentId,
              electedAt: state.coordinator.electedAt,
              term: state.coordinator.term,
            }
          : undefined,
        agents: state.agents.map((id) => {
          const agent = agentStore.agents[id];
          return {
            id,
            type: agent?.agentType || 'worker',
            status: agent?.status || 'unknown',
            tasksCompleted: agent?.taskCount || 0,
          };
        }),
        pendingVotes: state.votes.pending.length,
        voteHistoryCount: state.votes.history.length,
        sharedMemoryKeys: Object.keys(state.sharedMemory).length,
        stateSize: `${Math.round(stateBytes / 1024)} KB`,
        config: state.config,
        uptime,
        createdAt: state.createdAt,
        updatedAt: state.updatedAt,
      };

      if (input.verbose) {
        return {
          ...summary,
          voteHistory: state.votes.history.slice(-10),
          sharedMemory: state.sharedMemory,
          notices: state.notices.slice(-10),
        };
      }

      return summary;
    },
  },
  {
    name: 'monoswarm_scale',
    description:
      'Adjust the number of agent records in the roster to a target count by writing/removing bookkeeping entries in the state file. No process is started or stopped.',
    category: 'monoswarm',
    inputSchema: {
      type: 'object',
      properties: {
        targetAgents: { type: 'number', description: 'Target number of agents' },
        agentType: {
          type: 'string',
          description: 'Agent type for newly spawned agent records (default: worker)',
        },
      },
      required: ['targetAgents'],
    },
    handler: async (input) => {
      const targetAgents = input.targetAgents as number;
      const agentType = (input.agentType as string) || 'worker';

      if (!Number.isFinite(targetAgents) || targetAgents < 0 || !Number.isInteger(targetAgents)) {
        return { success: false, error: 'targetAgents must be a non-negative integer' };
      }

      const state = loadMonoswarmState();
      if (!state.initialized) {
        return { success: false, error: 'Monoswarm not initialized. Use monoswarm_init first.' };
      }

      const currentCount = state.agents.length;
      const delta = targetAgents - currentCount;

      const spawnTool = agentTools.find((t) => t.name === 'agent_spawn')!;
      const terminateTool = agentTools.find((t) => t.name === 'agent_terminate')!;

      const spawned: string[] = [];
      const terminated: string[] = [];

      if (delta > 0) {
        for (let i = 0; i < delta; i++) {
          const result = (await spawnTool.handler({ agentType })) as {
            success: boolean;
            agentId?: string;
          };
          if (result.success && result.agentId) {
            state.agents.push(result.agentId);
            spawned.push(result.agentId);
          }
        }
      } else if (delta < 0) {
        const toRemove = state.agents.slice(0, -delta);
        for (const agentId of toRemove) {
          const result = (await terminateTool.handler({ agentId })) as { success: boolean };
          if (result.success) {
            terminated.push(agentId);
          }
        }
        state.agents = state.agents.filter((id) => !terminated.includes(id));
      }

      state.maxAgents = Math.max(state.maxAgents, state.agents.length);
      saveMonoswarmState(state);

      const targetReached = state.agents.length === targetAgents;

      return {
        success: targetReached,
        error: targetReached
          ? undefined
          : `Reached ${state.agents.length}/${targetAgents} agents — some spawn/terminate operations failed`,
        monoswarmId: state.monoswarmId,
        previousCount: currentCount,
        currentCount: state.agents.length,
        targetAgents,
        spawned,
        terminated,
      };
    },
  },
  {
    name: 'monoswarm_health',
    description:
      'Inspect the state file and agent roster and report a derived healthy/degraded status — no live process is polled.',
    category: 'monoswarm',
    inputSchema: {
      type: 'object',
      properties: {},
    },
    handler: async () => {
      const state = loadMonoswarmState();

      if (!state.initialized) {
        return {
          status: 'not_initialized',
          healthy: false,
          checks: [
            { name: 'monoswarm_exists', status: 'fail', message: 'No monoswarm state recorded' },
          ],
          checkedAt: new Date().toISOString(),
        };
      }

      const isRunning = state.status === 'running';
      const stateFileExists = existsSync(getMonoswarmStatePath());

      const checks = [
        {
          name: 'monoswarm_exists',
          status: 'ok',
          message: `Monoswarm ${state.monoswarmId} recorded`,
        },
        {
          name: 'coordinator',
          status: isRunning ? 'ok' : 'warn',
          message: isRunning ? 'Status: running' : `Status: ${state.status}`,
        },
        {
          name: 'agents',
          status: state.agents.length > 0 ? 'ok' : 'info',
          message: `${state.agents.length} agents registered (max: ${state.maxAgents})`,
        },
        {
          name: 'persistence',
          status: stateFileExists ? 'ok' : 'warn',
          message: stateFileExists ? 'State file persisted' : 'State file missing',
        },
        {
          name: 'topology',
          status: 'ok',
          message: `Topology: ${state.topology}`,
        },
      ];

      const healthy = isRunning && stateFileExists;

      return {
        status: healthy ? 'healthy' : 'degraded',
        healthy,
        monoswarmId: state.monoswarmId,
        topology: state.topology,
        agentCount: state.agents.length,
        checks,
        checkedAt: new Date().toISOString(),
      };
    },
  },
  {
    name: 'monoswarm_shutdown',
    description:
      'Mark the state file terminated and remove roster agents from the agent store. No process is stopped because none was started.',
    category: 'monoswarm',
    inputSchema: {
      type: 'object',
      properties: {
        graceful: {
          type: 'boolean',
          description:
            'Refuse to shut down while votes are pending unless force is set (default: true)',
        },
        force: { type: 'boolean', description: 'Force immediate shutdown even with pending votes' },
      },
    },
    handler: async (input) => {
      const state = loadMonoswarmState();

      if (!state.initialized) {
        return { success: false, error: 'Monoswarm not initialized or already shut down' };
      }
      if (state.status === 'terminated') {
        return {
          success: false,
          monoswarmId: state.monoswarmId,
          error: 'Monoswarm already terminated',
        };
      }

      const graceful = input.graceful !== false;
      const force = input.force === true;
      const pendingVotes = state.votes.pending.length;

      if (graceful && pendingVotes > 0 && !force) {
        return {
          success: false,
          error: `Cannot gracefully shut down with ${pendingVotes} pending vote(s). Use force: true to override.`,
          pendingVotes,
          agentCount: state.agents.length,
        };
      }

      // Clear roster agents from the agent store. Must use the null-aware
      // loader here (this handler mutates and saves) — loadAgentStore() on a
      // corrupt/oversized store.json returns the empty default, and saving
      // that back would wipe every real agent, not just this roster.
      const agentStore = loadAgentStoreOrNull();
      if (!agentStore) {
        return {
          success: false,
          error:
            'Agent store is unreadable/corrupt — refusing to shut down to avoid overwriting real agent data.',
          pendingVotes,
          agentCount: state.agents.length,
        };
      }
      for (const agentId of state.agents) {
        if (agentStore.agents[agentId]) delete agentStore.agents[agentId];
      }
      saveAgentStore(agentStore);

      const shutdownTime = new Date().toISOString();
      const agentsTerminated = state.agents.length;
      const previousCoordinator = state.coordinator?.agentId;

      state.status = 'terminated';
      state.initialized = false;
      state.coordinator = undefined;
      state.agents = [];
      state.votes.pending = [];
      state.sharedMemory = {};

      saveMonoswarmState(state);

      return {
        success: true,
        monoswarmId: state.monoswarmId,
        terminated: true,
        graceful,
        agentsTerminated,
        previousCoordinator,
        votesCleared: pendingVotes,
        terminatedAt: shutdownTime,
      };
    },
  },
];
