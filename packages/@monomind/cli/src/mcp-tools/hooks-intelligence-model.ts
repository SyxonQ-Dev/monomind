import { join } from 'node:path';
import { computeModelStats, recordModelOutcome } from '../monovector/model-outcomes.js';
import { getProjectCwd, type MCPTool } from './types.js';

/** Ledger dir for model-outcome/model-stats — `.monomind/neural/model-outcomes.jsonl`. */
function getModelOutcomesBaseDir(): string {
  return join(getProjectCwd(), '.monomind', 'neural');
}

// Model route tool - intelligent model selection
export const hooksModelRoute: MCPTool = {
  name: 'hooks_model-route',
  description: 'Route task to optimal Claude model (haiku/sonnet/opus) based on complexity',
  inputSchema: {
    type: 'object',
    properties: {
      task: { type: 'string', description: 'Task description to analyze' },
      preferSpeed: { type: 'boolean', description: 'Prefer faster models when possible' },
      preferCost: { type: 'boolean', description: 'Prefer cheaper models when possible' },
    },
    required: ['task'],
  },
  handler: async (params: Record<string, unknown>) => {
    // Cap task: analyzeComplexityFallback calls .toLowerCase() and O(n) .includes()
    // for each keyword; an unbounded task string causes event-loop DoS.
    const MAX_MODEL_ROUTE_TASK_LEN = 16 * 1024;
    const rawTask = params.task as string;
    const task =
      typeof rawTask === 'string' && rawTask.length > MAX_MODEL_ROUTE_TASK_LEN
        ? rawTask.slice(0, MAX_MODEL_ROUTE_TASK_LEN)
        : rawTask;
    // Native neural model-router removed in the lean build — keyword complexity heuristic.
    const complexity = analyzeComplexityFallback(task);
    // No confidence: the heuristic produces a complexity score, not a
    // probability that the chosen model is right.
    return {
      model: complexity > 0.7 ? 'opus' : complexity > 0.4 ? 'sonnet' : 'haiku',
      complexity,
      reasoning: 'Keyword complexity heuristic',
      implementation: 'heuristic',
    };
  },
};

// Model route outcome - record outcome for learning
export const hooksModelOutcome: MCPTool = {
  name: 'hooks_model-outcome',
  description: 'Record model routing outcome',
  inputSchema: {
    type: 'object',
    properties: {
      task: { type: 'string', description: 'Original task' },
      model: { type: 'string', enum: ['haiku', 'sonnet', 'opus'], description: 'Model used' },
      outcome: {
        type: 'string',
        enum: ['success', 'failure', 'escalated'],
        description: 'Task outcome',
      },
      verifier_type: {
        type: 'string',
        enum: ['tsc', 'vitest', 'eslint', 'llm_judge'],
        description: 'RLVR verifier type for grounded reward signal',
      },
      exit_code: {
        type: 'number',
        description: 'Verifier exit code (0 = pass); overrides outcome when verifier_type is set',
      },
    },
    required: ['task', 'model', 'outcome'],
  },
  handler: async (params: Record<string, unknown>) => {
    // Cap task: even though the response only reflects task.slice(0, 50), an
    // unbounded task string causes unnecessary memory allocation before the slice.
    const MAX_MODEL_OUTCOME_TASK_LEN = 16 * 1024;
    const rawOutcomeTask = params.task as string;
    const task =
      typeof rawOutcomeTask === 'string' && rawOutcomeTask.length > MAX_MODEL_OUTCOME_TASK_LEN
        ? rawOutcomeTask.slice(0, MAX_MODEL_OUTCOME_TASK_LEN)
        : rawOutcomeTask;
    const model = params.model as 'haiku' | 'sonnet' | 'opus';
    // RLVR: derive effective outcome from verifier exit_code when provided
    // Source: https://github.com/opendilab/awesome-RLVR
    const verifierType = params.verifier_type as string | undefined;
    const exitCode = params.exit_code as number | undefined;
    const effectiveOutcome =
      verifierType !== undefined && exitCode !== undefined
        ? exitCode === 0
          ? 'success'
          : 'failure'
        : (params.outcome as 'success' | 'failure' | 'escalated');
    const outcome = effectiveOutcome;
    const quality =
      typeof params.quality === 'number' && Number.isFinite(params.quality)
        ? Math.max(0, Math.min(1, params.quality as number))
        : undefined;

    // Native model-router removed in the lean build — there is no neural learner to
    // feed. What we do have: an append-only ledger of routing decisions and their
    // measured outcomes, mirroring route-outcomes.ts. hooks_model-stats reads this
    // back to compute real aggregate statistics.
    const recorded = await recordModelOutcome(getModelOutcomesBaseDir(), {
      ts: Date.now(),
      task: task || '',
      model,
      outcome,
      ...(quality !== undefined ? { quality } : {}),
    });

    return {
      recorded,
      task: (task || '').slice(0, 50),
      model,
      outcome,
      timestamp: new Date().toISOString(),
    };
  },
};

// Model router stats
export const hooksModelStats: MCPTool = {
  name: 'hooks_model-stats',
  description: 'Get model routing statistics',
  inputSchema: {
    type: 'object',
    properties: {},
  },
  handler: async () => {
    // Native model-router removed in the lean build — but hooks_model-outcome
    // appends real records to model-outcomes.jsonl, so real aggregate stats can
    // be computed from that ledger.
    const stats = await computeModelStats(getModelOutcomesBaseDir());
    if (stats.totalDecisions === 0) {
      return {
        available: false,
        message: 'No model-outcome records yet — run "hooks model-outcome" to start recording.',
      };
    }
    return {
      available: true,
      totalDecisions: stats.totalDecisions,
      modelDistribution: stats.modelDistribution,
      successRate: stats.successRate,
      byModel: stats.byModel,
      avgQuality: stats.avgQuality,
    };
  },
};

// Simple fallback complexity analyzer
function analyzeComplexityFallback(task: string): number {
  const taskLower = task.toLowerCase();

  // High complexity indicators
  const highIndicators = [
    'architect',
    'design',
    'refactor',
    'security',
    'audit',
    'complex',
    'analyze',
  ];
  const highCount = highIndicators.filter((ind) => taskLower.includes(ind)).length;

  // Low complexity indicators
  const lowIndicators = ['simple', 'typo', 'format', 'rename', 'comment'];
  const lowCount = lowIndicators.filter((ind) => taskLower.includes(ind)).length;

  // Base on length
  const lengthScore = Math.min(1, task.length / 200);

  return Math.min(1, Math.max(0, 0.3 + highCount * 0.2 - lowCount * 0.15 + lengthScore * 0.2));
}
