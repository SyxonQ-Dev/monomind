/**
 * Hooks MCP Tools — session start, restore and end.
 * Extracted from hooks-routing.ts.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { validateMcpString } from '../utils/input-guards.js';
import { activeTrajectories, loadMemoryStore } from './hooks-embedding.js';
import { getProjectCwd, type MCPTool } from './types.js';

// Session start hook
export const hooksSessionStart: MCPTool = {
  name: 'hooks_session-start',
  description: 'Initialize a new session',
  inputSchema: {
    type: 'object',
    properties: {
      sessionId: { type: 'string', description: 'Optional session ID' },
      restoreLatest: {
        type: 'boolean',
        description:
          'Load the most recent previous session record and return it as previousSession',
      },
    },
  },
  handler: async (params: Record<string, unknown>) => {
    const sessionId =
      validateMcpString(params.sessionId, 'sessionId', 256) ?? `session-${Date.now()}`;
    const restoreLatest = params.restoreLatest === true;

    // Look up the previous session before this one's row is written, and
    // report only what that row actually holds — nothing when there is none.
    let previousSession: Awaited<
      ReturnType<typeof import('../memory/memory-bridge.js').bridgeLatestSession>
    > = null;
    let controller = 'none';
    try {
      const bridge = await import('../memory/memory-bridge.js');
      if (restoreLatest) {
        previousSession = await bridge.bridgeLatestSession({ excludeSessionId: sessionId });
      }
      const result = await bridge.bridgeSessionStart({
        sessionId,
        metadata: { context: restoreLatest ? 'restore previous session patterns' : 'new session' },
      });
      if (result?.success) controller = 'sqlite';
    } catch (e) {
      // Bridge not available
      if (process.env.DEBUG || process.env.MONOMIND_DEBUG)
        console.error('[hooks-session-start] memory bridge failed:', e);
    }

    return {
      sessionId,
      started: new Date().toISOString(),
      restored: previousSession !== null,
      sessionMemory: { controller },
      previousSession,
    };
  },
};

// Session restore hook — hooks.ts's `hooks session-restore` (and its
// `session-start` alias) called this tool name, but it was never registered
// anywhere in the tool registry, so both always failed. This repo has no
// per-session snapshot of agents/tasks to restore from, so "restore" here
// means: report the currently-live (non-terminated/non-terminal) agents and
// tasks as "carried forward", and reinitialize the memory-bridge session
// context the same way hooks_session-start does — an honest, working
// implementation rather than a fabricated one.
export const hooksSessionRestore: MCPTool = {
  name: 'hooks_session-restore',
  description:
    'Restore a previous session — reports currently-live agents/tasks and reinitializes memory-bridge session context',
  inputSchema: {
    type: 'object',
    properties: {
      sessionId: { type: 'string', description: 'Session ID to restore, or "latest"' },
      restoreAgents: {
        type: 'boolean',
        description: 'Include a count of currently-live agents (default true)',
      },
      restoreTasks: {
        type: 'boolean',
        description: 'Include a count of currently-live tasks (default true)',
      },
    },
  },
  handler: async (params: Record<string, unknown>) => {
    const originalSessionId = validateMcpString(params.sessionId, 'sessionId', 256) ?? 'latest';
    const newSessionId = `session-${Date.now()}`;
    const warnings: string[] = [];

    let agentsRestored = 0;
    if (params.restoreAgents !== false) {
      try {
        const { loadAgentStore } = await import('./agent-tools.js');
        const store = loadAgentStore();
        agentsRestored = Object.values(store.agents).filter(
          (a) => a.status !== 'terminated',
        ).length;
      } catch (e) {
        warnings.push('Agent store unavailable — agent count not restored');
        if (process.env.DEBUG || process.env.MONOMIND_DEBUG)
          console.error('[hooks-session-restore] agent store read failed:', e);
      }
    }

    let tasksRestored = 0;
    if (params.restoreTasks !== false) {
      try {
        const { loadTaskStore } = await import('./task-tools.js');
        const store = loadTaskStore();
        tasksRestored = Object.values(store.tasks).filter(
          (t) => t.status === 'pending' || t.status === 'in_progress',
        ).length;
      } catch (e) {
        warnings.push('Task store unavailable — task count not restored');
        if (process.env.DEBUG || process.env.MONOMIND_DEBUG)
          console.error('[hooks-session-restore] task store read failed:', e);
      }
    }

    // bridgeSessionStart only stores a new "session active" marker entry —
    // it has no pattern-restoration data to count, so there is no real
    // "memoryRestored" number to report. Track whether the bridge itself
    // came up instead of faking a count.
    let memoryBridgeInitialized = false;
    try {
      const bridge = await import('../memory/memory-bridge.js');
      const result = await bridge.bridgeSessionStart({
        sessionId: newSessionId,
        metadata: { context: 'restore previous session patterns' },
      });
      if (result) {
        memoryBridgeInitialized = result.success;
      } else {
        warnings.push('Memory bridge unavailable — pattern restoration skipped');
      }
    } catch (e) {
      warnings.push('Memory bridge failed to initialize');
      if (process.env.DEBUG || process.env.MONOMIND_DEBUG)
        console.error('[hooks-session-restore] memory bridge failed:', e);
    }

    return {
      sessionId: newSessionId,
      originalSessionId,
      restoredState: { tasksRestored, agentsRestored, memoryBridgeInitialized },
      warnings: warnings.length > 0 ? warnings : undefined,
    };
  },
};

// Session end hook - persists state
export const hooksSessionEnd: MCPTool = {
  name: 'hooks_session-end',
  description: 'End current session and persist state',
  inputSchema: {
    type: 'object',
    properties: {
      saveState: { type: 'boolean', description: 'Save session state' },
      exportMetrics: { type: 'boolean', description: 'Export session metrics' },
    },
  },
  handler: async (params: Record<string, unknown>) => {
    const saveState = params.saveState !== false;
    // Use caller-supplied sessionId if provided, otherwise generate a current-time ID.
    // The -3600000 offset was incorrect — it prevented matching session-start IDs.
    const sessionId =
      typeof params.sessionId === 'string' && params.sessionId
        ? params.sessionId
        : `session-${Date.now()}`;

    // Read actual counts from stores
    const store = loadMemoryStore();
    const allEntries = Object.values(store.entries);
    const taskCount = allEntries.filter((e) => e.key.includes('task')).length;
    const agentCount = allEntries.filter((e) => e.key.includes('agent')).length;
    const patternCount = allEntries.filter((e) => e.key.includes('pattern')).length;
    const trajectoryCount = activeTrajectories.size;

    // Check for pending-insights.jsonl
    let insightCount = 0;
    try {
      const insightsPath = join(getProjectCwd(), '.monomind', 'data', 'pending-insights.jsonl');
      if (existsSync(insightsPath)) {
        const content = readFileSync(insightsPath, 'utf-8').trim();
        insightCount = content ? content.split('\n').length : 0;
      }
    } catch {
      // File not available
    }

    // Phase 5: Wire ReflexionMemory session end + NightlyLearner consolidation via bridge
    let sessionPersistence: { controller: string; persisted: boolean } | null = null;
    try {
      const bridge = await import('../memory/memory-bridge.js');
      const result = await bridge.bridgeSessionEnd({
        sessionId,
        summary: saveState ? 'Session ended with state saved' : 'Session ended',
        metrics: { tasksCompleted: taskCount, patternsLearned: patternCount },
      });
      if (result) {
        sessionPersistence = {
          controller: result.success ? 'sqlite' : 'none',
          persisted: result.success,
        };
      }
    } catch (e) {
      // Bridge not available
      if (process.env.DEBUG || process.env.MONOMIND_DEBUG)
        console.error('[hooks-session-end] memory bridge failed:', e);
    }

    // KG nudge: check if knowledge graph is empty and suggest distillation
    let kgNudge: { empty: boolean; prompt?: string } = { empty: false };
    if (process.env.MONOMIND_KG_NUDGE !== 'false') {
      try {
        const kg = await import('../memory/memory-kg.js');
        const stats = await kg.kgStats();
        const kgEmpty = stats.nodes === 0 && stats.edges === 0 && stats.rules === 0;
        if (kgEmpty && taskCount > 0) {
          kgNudge = {
            empty: true,
            prompt: [
              'The knowledge graph is empty (0 nodes, 0 edges, 0 rules). Before ending, distill 2-5 key insights:',
              '1. Identify important entities (functions, patterns, architectural decisions)',
              '2. Call memory_kg_ingest with nodes [{name, type, description}], edges [{source, target, relation}],',
              '   and any durable rules [{rule, context}] — use session ID as originRef',
              '3. Check existing entities first: memory_kg_stats with glossary:true',
              'Skip for trivial sessions. Disable with MONOMIND_KG_NUDGE=false',
            ].join('\n'),
          };
        }
      } catch {
        // non-fatal — skip nudge if KG module unavailable
      }
    }

    return {
      sessionId,
      sessionPersistence: sessionPersistence || { controller: 'none', persisted: false },
      summary: {
        tasksExecuted: taskCount,
        agentsSpawned: agentCount,
        pendingInsights: insightCount,
        memoryEntries: allEntries.length,
      },
      learningUpdates: {
        patternsLearned: patternCount,
        trajectoriesRecorded: trajectoryCount,
      },
      kgNudge,
    };
  },
};
