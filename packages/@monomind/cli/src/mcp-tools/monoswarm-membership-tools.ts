/**
 * Monoswarm membership tools: monoswarm_agent_add, monoswarm_join,
 * monoswarm_leave.
 *
 * Registered through `monoswarmTools` in monoswarm-tools.ts, which keeps the
 * registration order; see that module for what these tools do and do not do.
 */

import { loadAgentStoreOrNull } from './agent-tools.js';
import {
  loadMonoswarmState,
  RESERVED_KEYS,
  saveAgentStore,
  saveMonoswarmState,
} from './monoswarm-state.js';
import type { MCPTool } from './types.js';

export const monoswarmMembershipTools: MCPTool[] = [
  {
    name: 'monoswarm_agent_add',
    description:
      'Add an agent record (id, role) to the roster in the state file, and write a matching record into the agent store. Starts nothing.',
    category: 'monoswarm',
    inputSchema: {
      type: 'object',
      properties: {
        count: {
          type: 'number',
          description: 'Number of agent records to add (default: 1)',
          default: 1,
        },
        role: {
          type: 'string',
          enum: ['worker', 'specialist', 'scout'],
          description: 'Agent role',
          default: 'worker',
        },
        agentType: {
          type: 'string',
          description: 'Agent type for added agents',
          default: 'worker',
        },
        prefix: { type: 'string', description: 'Prefix for agent IDs', default: 'monoswarm-agent' },
      },
    },
    handler: async (input) => {
      const state = loadMonoswarmState();

      if (!state.initialized) {
        return { success: false, error: 'Monoswarm not initialized. Run monoswarm_init first.' };
      }

      const count = Math.min(Math.max(1, (input.count as number) || 1), 20);
      const MAX_ROLE_LEN = 256;
      const MAX_PREFIX_LEN = 128;
      const rawRole = (input.role as string) || 'worker';
      const role =
        typeof rawRole === 'string' && rawRole.length > MAX_ROLE_LEN
          ? rawRole.slice(0, MAX_ROLE_LEN)
          : rawRole;
      const rawAgentType = (input.agentType as string) || 'worker';
      const agentType =
        typeof rawAgentType === 'string' && rawAgentType.length > MAX_ROLE_LEN
          ? rawAgentType.slice(0, MAX_ROLE_LEN)
          : rawAgentType;
      const rawPrefix = (input.prefix as string) || 'monoswarm-agent';
      const prefix =
        typeof rawPrefix === 'string' && rawPrefix.length > MAX_PREFIX_LEN
          ? rawPrefix.slice(0, MAX_PREFIX_LEN)
          : rawPrefix;

      const agentStore = loadAgentStoreOrNull();
      if (!agentStore) {
        return {
          success: false,
          error:
            'Agent store is unreadable/corrupt — refusing to add agents to avoid overwriting real agent data.',
        };
      }

      const added: Array<{ agentId: string; role: string; joinedAt: string }> = [];

      for (let i = 0; i < count; i++) {
        const agentId = `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
        if (RESERVED_KEYS.has(agentId)) continue;

        agentStore.agents[agentId] = {
          agentId,
          agentType,
          status: 'idle',
          health: 1.0,
          taskCount: 0,
          config: { role },
          createdAt: new Date().toISOString(),
          domain: 'monoswarm',
        };

        const MAX_AGENTS = 100;
        if (!state.agents.includes(agentId)) {
          if (state.agents.length >= MAX_AGENTS) {
            return {
              success: false,
              error: `Monoswarm has reached max agent capacity (${MAX_AGENTS})`,
            };
          }
          state.agents.push(agentId);
        }

        added.push({ agentId, role, joinedAt: new Date().toISOString() });
      }

      saveAgentStore(agentStore);
      saveMonoswarmState(state);

      return {
        success: true,
        added: count,
        agents: added,
        totalAgents: state.agents.length,
        message: `Added ${count} agent record(s) to the roster`,
      };
    },
  },
  {
    name: 'monoswarm_join',
    description:
      'Append an agent id to the roster array in the state file. No membership handshake occurs — this is a list append.',
    category: 'monoswarm',
    inputSchema: {
      type: 'object',
      properties: {
        agentId: { type: 'string', description: 'Agent ID to add to the roster' },
        role: {
          type: 'string',
          enum: ['worker', 'specialist', 'scout'],
          description: 'Agent role',
        },
      },
      required: ['agentId'],
    },
    handler: async (input) => {
      const state = loadMonoswarmState();
      const agentId = input.agentId as string;

      if (
        typeof agentId !== 'string' ||
        agentId.length === 0 ||
        agentId.length > 128 ||
        RESERVED_KEYS.has(agentId) ||
        !/^[a-zA-Z0-9_-]+$/.test(agentId)
      ) {
        return { success: false, error: 'Invalid agentId' };
      }

      if (!state.initialized) {
        return { success: false, error: 'Monoswarm not initialized' };
      }

      const MAX_AGENTS = 100;
      if (!state.agents.includes(agentId)) {
        if (state.agents.length >= MAX_AGENTS) {
          return {
            success: false,
            error: `Monoswarm has reached max agent capacity (${MAX_AGENTS})`,
          };
        }
        state.agents.push(agentId);
        saveMonoswarmState(state);
      }

      return {
        success: true,
        agentId,
        role: input.role || 'worker',
        totalAgents: state.agents.length,
        joinedAt: new Date().toISOString(),
      };
    },
  },
  {
    name: 'monoswarm_leave',
    description: 'Remove an agent id from the roster array in the state file.',
    category: 'monoswarm',
    inputSchema: {
      type: 'object',
      properties: {
        agentId: { type: 'string', description: 'Agent ID to remove' },
      },
      required: ['agentId'],
    },
    handler: async (input) => {
      const state = loadMonoswarmState();
      const agentId = input.agentId as string;

      if (
        typeof agentId !== 'string' ||
        agentId.length === 0 ||
        agentId.length > 128 ||
        RESERVED_KEYS.has(agentId) ||
        !/^[a-zA-Z0-9_-]+$/.test(agentId)
      ) {
        return { success: false, error: 'Invalid agentId' };
      }

      const index = state.agents.indexOf(agentId);
      if (index > -1) {
        state.agents.splice(index, 1);
        saveMonoswarmState(state);
        return {
          success: true,
          agentId,
          leftAt: new Date().toISOString(),
          remainingAgents: state.agents.length,
        };
      }

      return { success: false, agentId, error: 'Agent not in roster' };
    },
  },
];
