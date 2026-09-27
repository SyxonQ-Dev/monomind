/**
 * SONA Optimizer — keyword categories, tunables, and stateless matching helpers
 * Split out of sona-optimizer.ts (file-size sweep). Pure move: these constants
 * and functions never touched `this` in the SONAOptimizer class, so they move
 * verbatim; call sites in the class now call them directly instead of via
 * `this.`.
 *
 * @module v1/cli/memory/sona-optimizer
 */

import type { LearnedPattern } from './sona-optimizer-types.js';

// ============================================================================
// Constants
// ============================================================================

export const DEFAULT_PERSISTENCE_PATH = '.swarm/sona-patterns.json';
export const PATTERN_VERSION = '1.0.0';
export const MIN_CONFIDENCE = 0.1;
export const MAX_CONFIDENCE = 0.99;
export const CONFIDENCE_INCREMENT = 0.1;
export const CONFIDENCE_DECREMENT = 0.15;
export const DECAY_RATE = 0.01; // Per day
export const MAX_PATTERNS = 1000;

/**
 * Common agent types for routing
 */
export const _AGENT_TYPES = [
  'coder',
  'tester',
  'reviewer',
  'architect',
  'researcher',
  'optimizer',
  'debugger',
  'documenter',
  'security-architect',
  'performance-engineer',
];

/**
 * Task keywords for pattern extraction
 */
export const KEYWORD_CATEGORIES: Record<string, string[]> = {
  coder: [
    'implement',
    'code',
    'write',
    'create',
    'build',
    'develop',
    'add',
    'feature',
    'function',
    'class',
    'module',
    'api',
    'endpoint',
  ],
  tester: [
    'test',
    'spec',
    'coverage',
    'unit',
    'integration',
    'e2e',
    'mock',
    'assert',
    'expect',
    'verify',
    'validate',
    'scenario',
  ],
  reviewer: [
    'review',
    'check',
    'audit',
    'analyze',
    'inspect',
    'evaluate',
    'quality',
    'standards',
    'best-practices',
    'lint',
  ],
  architect: [
    'architect',
    'design',
    'structure',
    'pattern',
    'system',
    'schema',
    'database',
    'infrastructure',
    'scalability',
    'architecture',
  ],
  researcher: [
    'research',
    'investigate',
    'explore',
    'find',
    'search',
    'discover',
    'analyze',
    'understand',
    'learn',
    'study',
  ],
  optimizer: [
    'optimize',
    'performance',
    'speed',
    'memory',
    'improve',
    'enhance',
    'faster',
    'efficient',
    'reduce',
    'benchmark',
  ],
  debugger: [
    'debug',
    'fix',
    'bug',
    'error',
    'issue',
    'problem',
    'crash',
    'exception',
    'trace',
    'diagnose',
    'resolve',
  ],
  documenter: [
    'document',
    'docs',
    'readme',
    'comment',
    'explain',
    'guide',
    'tutorial',
    'api-docs',
    'specification',
    'jsdoc',
  ],
  'security-architect': [
    'security',
    'auth',
    'authentication',
    'authorization',
    'encrypt',
    'vulnerability',
    'cve',
    'secure',
    'permission',
    'role',
  ],
  'performance-engineer': [
    'profiling',
    'bottleneck',
    'latency',
    'throughput',
    'cache',
    'scale',
    'load',
    'stress',
    'concurrent',
    'parallel',
  ],
};

// ============================================================================
// Stateless matching helpers
// ============================================================================

/**
 * Check if word is a stop word
 */
export function isStopWord(word: string): boolean {
  const stopWords = new Set([
    'the',
    'and',
    'for',
    'that',
    'this',
    'with',
    'from',
    'have',
    'been',
    'will',
    'would',
    'could',
    'should',
    'into',
    'then',
    'than',
    'when',
    'where',
    'which',
    'there',
    'their',
    'what',
    'about',
    'more',
    'some',
    'also',
    'just',
    'only',
    'other',
    'very',
    'after',
    'most',
    'such',
  ]);
  return stopWords.has(word);
}

/**
 * Extract meaningful keywords from task description
 */
export function extractKeywords(task: string): string[] {
  if (!task || typeof task !== 'string') {
    return [];
  }

  const lower = task.toLowerCase();
  const words = lower.split(/[\s\-_.,;:!?'"()[\]{}]+/).filter((w) => w.length > 2);

  // Extract keywords that match our categories
  const keywords = new Set<string>();

  for (const categoryKeywords of Object.values(KEYWORD_CATEGORIES)) {
    for (const keyword of categoryKeywords) {
      if (lower.includes(keyword)) {
        keywords.add(keyword);
      }
    }
  }

  // Add any significant words not in categories
  for (const word of words) {
    if (word.length >= 4 && !isStopWord(word)) {
      keywords.add(word);
    }
  }

  return Array.from(keywords).slice(0, 10); // Limit to 10 keywords
}

/**
 * Create a unique pattern key from keywords and agent
 */
export function createPatternKey(keywords: string[], agent: string): string {
  const sortedKeywords = [...keywords].sort();
  return `${agent}:${sortedKeywords.join('+')}`;
}

/**
 * Match keywords to agent using category heuristics
 */
export function matchKeywordsToAgent(keywords: string[]): {
  agent: string;
  confidence: number;
  matchedKeywords: string[];
} | null {
  const scores: Record<string, { score: number; matched: string[] }> = {};

  for (const [agent, categoryKeywords] of Object.entries(KEYWORD_CATEGORIES)) {
    const matched = keywords.filter((k) => categoryKeywords.includes(k));
    if (matched.length > 0) {
      scores[agent] = {
        score: matched.length / categoryKeywords.length,
        matched,
      };
    }
  }

  // Find best scoring agent
  let bestAgent = '';
  let bestScore = 0;
  let bestMatched: string[] = [];

  for (const [agent, data] of Object.entries(scores)) {
    if (data.score > bestScore) {
      bestScore = data.score;
      bestAgent = agent;
      bestMatched = data.matched;
    }
  }

  if (bestAgent && bestScore > 0) {
    return {
      agent: bestAgent,
      confidence: Math.min(0.7, 0.3 + bestScore),
      matchedKeywords: bestMatched,
    };
  }

  return null;
}

/**
 * Get alternative agent suggestions
 */
export function getAlternatives(
  keywords: string[],
  excludeAgent: string,
): Array<{ agent: string; score: number }> {
  const alternatives: Array<{ agent: string; score: number }> = [];

  for (const [agent, categoryKeywords] of Object.entries(KEYWORD_CATEGORIES)) {
    if (agent === excludeAgent) continue;

    const matched = keywords.filter((k) => categoryKeywords.includes(k));
    if (matched.length > 0) {
      alternatives.push({
        agent,
        score: (matched.length / Math.max(keywords.length, 1)) * 0.5,
      });
    }
  }

  return alternatives.sort((a, b) => b.score - a.score).slice(0, 3);
}

/**
 * Validate pattern structure with strict bounds.
 * SECURITY: confidence/keywords/agent fields must be bounds-checked to
 * defeat poisoning. typeof NaN === 'number' and typeof Infinity === 'number'
 * pass the loose typeof check; without bounds, an attacker who writes
 * sona-patterns.json (poisoned bundle, malicious test fixture, co-located
 * compromise) can inject `confidence: 1e308` to deterministically win
 * every routing decision via findBestPatternMatch's `score = matchRatio *
 * confidence`. Mirrors the pattern in intelligence.ts:loadFromDisk.
 */
export function validatePattern(pattern: unknown): pattern is LearnedPattern {
  if (!pattern || typeof pattern !== 'object') return false;
  const p = pattern as Record<string, unknown>;
  if (!Array.isArray(p.keywords) || p.keywords.length > 64) return false;
  if (!p.keywords.every((k) => typeof k === 'string' && k.length > 0 && k.length <= 128))
    return false;
  if (typeof p.agent !== 'string' || p.agent.length === 0 || p.agent.length > 128) return false;
  if (
    typeof p.confidence !== 'number' ||
    !Number.isFinite(p.confidence) ||
    p.confidence < 0 ||
    p.confidence > 1
  )
    return false;
  if (
    typeof p.successCount !== 'number' ||
    !Number.isFinite(p.successCount) ||
    p.successCount < 0 ||
    p.successCount > 1e9
  )
    return false;
  if (
    typeof p.failureCount !== 'number' ||
    !Number.isFinite(p.failureCount) ||
    p.failureCount < 0 ||
    p.failureCount > 1e9
  )
    return false;
  return true;
}
