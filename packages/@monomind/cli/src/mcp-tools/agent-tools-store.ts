/**
 * Agent MCP Tools — persistent store and model routing.
 * Extracted from agent-tools.ts.
 */

import { existsSync, mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { readJsonStoreOrNull } from '../utils/json-file.js';
import { getMonomindDataRoot, migrateLegacyStoreFile } from './types.js';

// Storage paths — relative to the git-safe data root (see getMonomindDataRoot()).
// Canonical location matches task-tools.ts/session-tools.ts
// so the agent store is a single physical file across all tools.
const AGENT_DIR = 'agents';
const AGENT_FILE = 'store.json';

// Model types matching Claude Agent SDK
export type ClaudeModel = 'haiku' | 'sonnet' | 'opus' | 'inherit';

export interface AgentRecord {
  agentId: string;
  agentType: string;
  status: 'idle' | 'busy' | 'terminated';
  health: number;
  taskCount: number;
  config: Record<string, unknown>;
  createdAt: string;
  domain?: string;
  model?: ClaudeModel; // Model assigned to this agent
  modelRoutedBy?: 'explicit' | 'router' | 'default'; // How model was determined (ADR-026)
  lastResult?: Record<string, unknown>; // Output from last completed task
}

export interface AgentStore {
  agents: Record<string, AgentRecord>;
  version: string;
}

function getAgentDir(): string {
  return join(getMonomindDataRoot(), AGENT_DIR);
}

function getAgentPath(): string {
  return join(getAgentDir(), AGENT_FILE);
}

function ensureAgentDir(): void {
  const dir = getAgentDir();
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

const EMPTY_AGENT_STORE: AgentStore = { agents: {}, version: '3.0.0' };

export function loadAgentStore(): AgentStore {
  return loadAgentStoreOrNull() ?? EMPTY_AGENT_STORE;
}

export function loadAgentStoreOrNull(): AgentStore | null {
  const path = getAgentPath();
  migrateLegacyStoreFile(path, join(AGENT_DIR, AGENT_FILE));
  return readJsonStoreOrNull<AgentStore>(path, { agents: {}, version: '3.0.0' }, 'loadAgentStore');
}

export function saveAgentStore(store: AgentStore): void {
  // Cap terminated agents to prevent unbounded growth
  const MAX_TERMINATED = 500;
  const terminated = Object.entries(store.agents)
    .filter(([, a]) => a.status === 'terminated')
    .sort(([, a], [, b]) => (a.createdAt ?? '').localeCompare(b.createdAt ?? ''));
  if (terminated.length > MAX_TERMINATED) {
    for (const [id] of terminated.slice(0, terminated.length - MAX_TERMINATED)) {
      delete store.agents[id];
    }
  }
  ensureAgentDir();
  const dest = getAgentPath();
  const tmp = `${dest}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, JSON.stringify(store, null, 2), 'utf-8');
  renameSync(tmp, dest);
}

// Default model mappings for agent types (can be overridden)
const AGENT_TYPE_MODEL_DEFAULTS: Record<string, ClaudeModel> = {
  // Complex agents → opus
  architect: 'opus',
  'security-architect': 'opus',
  'system-architect': 'opus',
  'core-architect': 'opus',
  // Registry agents the old architect/security types now resolve to.
  'Software Architect': 'opus',
  'Security Engineer': 'opus',
  // Medium complexity → sonnet
  coder: 'sonnet',
  reviewer: 'sonnet',
  researcher: 'sonnet',
  tester: 'sonnet',
  analyst: 'sonnet',
  // Simple/fast agents → haiku
  formatter: 'haiku',
  linter: 'haiku',
  documenter: 'haiku',
};

/**
 * Determine model for agent based on (ADR-026 3-tier routing):
 * 1. Explicit model in config
 * 2. Enhanced task-based routing with Agent Booster AST (if task provided)
 * 3. Agent type defaults
 * 4. Fallback to sonnet
 */
export async function determineAgentModel(
  agentType: string,
  config: Record<string, unknown>,
  _task?: string,
): Promise<{
  model: ClaudeModel;
  routedBy: 'explicit' | 'router' | 'default';
  canSkipLLM?: boolean;
  agentBoosterIntent?: string;
  tier?: 1 | 2 | 3;
}> {
  // 1. Explicit model in config
  if (config.model && ['haiku', 'sonnet', 'opus', 'inherit'].includes(config.model as string)) {
    return { model: config.model as ClaudeModel, routedBy: 'explicit' };
  }

  // 2. Task-based model router modules were never shipped — fall through to agent-type defaults.

  // 3. Agent type defaults
  const defaultModel = AGENT_TYPE_MODEL_DEFAULTS[agentType];
  if (defaultModel) {
    return { model: defaultModel, routedBy: 'default' };
  }

  // 4. Fallback to sonnet (balanced)
  return { model: 'sonnet', routedBy: 'default' };
}
