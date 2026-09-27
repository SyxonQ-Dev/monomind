import * as fs from 'node:fs';
import * as path from 'node:path';
import { getMonomindDataRoot, getProjectCwd, migrateLegacyStoreFile } from '../utils/paths.js';

// Canonical paths — resolved through getMonomindDataRoot() so the CLI and the MCP
// tools (agent-tools.ts / monoswarm-tools.ts / task-tools.ts) read and write the
// SAME physical files: `.monomind/monoswarm/state.json`. This is a clean break from
// the pre-rename `.monomind/swarm/swarm-state.json` layout — no migration from that
// legacy path is performed.
const SWARM_STATE_SUBDIR = 'monoswarm';
const SWARM_STATE_FILE = 'state.json';
const AGENT_STORE_SUBDIR = 'agents';
const AGENT_STORE_FILE = 'store.json';

export function getSwarmDir(): string {
  return path.join(getMonomindDataRoot(), SWARM_STATE_SUBDIR);
}

// Canonical state.json path — `.monomind/monoswarm/state.json`, shared with the
// MCP tools.
export function getSwarmStateFile(): string {
  return path.join(getSwarmDir(), SWARM_STATE_FILE);
}

export function getAgentStoreFile(): string {
  const file = path.join(getMonomindDataRoot(), AGENT_STORE_SUBDIR, AGENT_STORE_FILE);
  migrateLegacyStoreFile(file, path.join(AGENT_STORE_SUBDIR, AGENT_STORE_FILE));
  return file;
}

// Get dynamic swarm status from MCP-canonical state files
export function getSwarmStatus(swarmId?: string) {
  const projectCwd = getProjectCwd();
  const sessionDir = path.join(projectCwd, '.claude', 'sessions');
  const memoryPaths = [
    path.join(projectCwd, '.monomind', 'memory.db'),
    path.join(projectCwd, '.claude', 'memory.db'),
  ];

  // Read swarm state from the MCP-canonical path
  const swarmStateFile = getSwarmStateFile();
  let swarmState: Record<string, unknown> | null = null;

  if (fs.existsSync(swarmStateFile)) {
    try {
      const swarmStatSz = fs.statSync(swarmStateFile).size;
      if (swarmStatSz <= 10_485_760) {
        const state = JSON.parse(fs.readFileSync(swarmStateFile, 'utf-8'));
        // monoswarm-tools.ts writes a single flat MonoswarmState object — there
        // is only one monoswarm per project, so there is no per-id map to look
        // up (a `swarmId` argument is accepted purely as a display override).
        if (state?.initialized) {
          swarmState = state;
        }
      }
    } catch {
      // Ignore parse errors
    }
  }

  // Count agents from the MCP-canonical agent store (the same physical file
  // agent_spawn writes to — see getAgentStoreFile()).
  let activeAgents = 0;
  let totalAgents = 0;
  const agentStoreFile = getAgentStoreFile();
  if (fs.existsSync(agentStoreFile)) {
    try {
      const agentSz = fs.statSync(agentStoreFile).size;
      if (agentSz <= 52_428_800) {
        const agentStore = JSON.parse(fs.readFileSync(agentStoreFile, 'utf-8'));
        if (agentStore?.agents && typeof agentStore.agents === 'object') {
          for (const agent of Object.values(agentStore.agents) as Array<Record<string, unknown>>) {
            totalAgents++;
            if (agent.status === 'idle' || agent.status === 'busy') {
              activeAgents++;
            }
          }
        }
      }
    } catch {
      // Ignore
    }
  }

  // Get session count
  let _sessionCount = 0;
  if (fs.existsSync(sessionDir)) {
    try {
      _sessionCount = fs.readdirSync(sessionDir).filter((f) => f.endsWith('.json')).length;
    } catch {
      // Ignore
    }
  }

  // Get memory size as rough indicator of activity
  let _memorySize = 0;
  for (const dbPath of memoryPaths) {
    if (fs.existsSync(dbPath)) {
      try {
        _memorySize = fs.statSync(dbPath).size;
        break;
      } catch {
        // Ignore
      }
    }
  }

  // Count task files if they exist
  let completedTasks = 0;
  let inProgressTasks = 0;
  let pendingTasks = 0;
  const tasksDir = path.join(getSwarmDir(), 'tasks');
  if (fs.existsSync(tasksDir)) {
    try {
      const taskFiles = fs.readdirSync(tasksDir).filter((f) => f.endsWith('.json'));
      for (const file of taskFiles) {
        try {
          const taskFilePath = path.join(tasksDir, file);
          const taskSz = fs.statSync(taskFilePath).size;
          if (taskSz <= 524_288) {
            const task = JSON.parse(fs.readFileSync(taskFilePath, 'utf-8'));
            if (task.status === 'completed' || task.status === 'done') {
              completedTasks++;
            } else if (task.status === 'in_progress' || task.status === 'running') {
              inProgressTasks++;
            } else {
              pendingTasks++;
            }
          }
        } catch {
          // Ignore
        }
      }
    } catch {
      // Ignore
    }
  }

  // Calculate dynamic progress based on actual state
  // If no swarm state, show 0%. Otherwise calculate from completed tasks
  const totalTasks = completedTasks + inProgressTasks + pendingTasks;
  let progress = 0;
  if (totalTasks > 0) {
    progress = Math.round((completedTasks / totalTasks) * 100);
  } else if (swarmState) {
    // Swarm initialized but no tasks yet
    progress = 5;
  }

  // Determine status
  let status = 'idle';
  if (inProgressTasks > 0 || activeAgents > 0) {
    status = 'running';
  } else if (completedTasks > 0 && pendingTasks === 0 && inProgressTasks === 0) {
    status = 'completed';
  } else if (swarmState) {
    status = 'ready';
  }

  const swarmConfig = (swarmState as { config?: Record<string, unknown> })?.config;

  return {
    id: swarmId || (swarmState as Record<string, string>)?.monoswarmId || 'no-active-swarm',
    topology: (swarmState as Record<string, string>)?.topology || 'none',
    status,
    // Not tracked in the merged monoswarm state — the state file records
    // topology/strategy/votes, not a free-text objective.
    objective: 'No active objective',
    strategy: (swarmConfig?.strategy as string) || 'none',
    agents: {
      total: totalAgents,
      active: activeAgents,
      idle: Math.max(0, totalAgents - activeAgents),
      // Not tracked anywhere — nothing distinguishes a "completed" agent
      // from an active/idle one in the agent store. '--' rather than a
      // fake 0.
      completed: '--',
    },
    progress,
    tasks: {
      total: totalTasks,
      completed: completedTasks,
      inProgress: inProgressTasks,
      pending: pendingTasks,
    },
    metrics: {
      // Token usage isn't tracked here — '--' rather than a fake 0.
      tokensUsed: '--',
      avgResponseTime: '--',
      successRate: totalTasks > 0 ? `${Math.round((completedTasks / totalTasks) * 100)}%` : '--',
      elapsedTime: '--',
    },
    hasActiveSwarm: !!swarmState || totalAgents > 0,
  };
}

// Swarm topologies
export const TOPOLOGIES = [
  {
    value: 'hierarchical',
    label: 'Hierarchical',
    hint: 'Queen-led coordination with worker agents',
  },
  { value: 'mesh', label: 'Mesh', hint: 'Fully connected peer-to-peer network' },
  { value: 'ring', label: 'Ring', hint: 'Circular communication pattern' },
  { value: 'star', label: 'Star', hint: 'Central coordinator with spoke agents' },
  { value: 'hybrid', label: 'Hybrid', hint: 'Hierarchical mesh for maximum flexibility' },
  {
    value: 'hierarchical-mesh',
    label: 'Hierarchical Mesh',
    hint: 'v1 15-agent queen + peer communication (recommended)',
  },
];

// Swarm strategies
export const STRATEGIES = [
  { value: 'specialized', label: 'Specialized', hint: 'Clear roles, no overlap (anti-drift)' },
  { value: 'balanced', label: 'Balanced', hint: 'Even distribution of work' },
  { value: 'adaptive', label: 'Adaptive', hint: 'Dynamic strategy based on task' },
  { value: 'research', label: 'Research', hint: 'Distributed research and analysis' },
  { value: 'development', label: 'Development', hint: 'Collaborative code development' },
  { value: 'testing', label: 'Testing', hint: 'Comprehensive test coverage' },
  { value: 'optimization', label: 'Optimization', hint: 'Performance optimization' },
  { value: 'maintenance', label: 'Maintenance', hint: 'Codebase maintenance and refactoring' },
  { value: 'analysis', label: 'Analysis', hint: 'Code analysis and documentation' },
];
