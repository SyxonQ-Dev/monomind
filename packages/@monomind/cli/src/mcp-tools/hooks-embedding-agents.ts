/**
 * Hooks embedding — file-to-agent suggestions and command risk assessment.
 * Extracted from hooks-embedding.ts.
 */

import { getProjectCwd } from './types.js';

// File type → recommended agents for hooks_pre-edit. Every value is a spawnable
// agent name (a bundled agent's frontmatter `name`, the Task subagent_type).
export const AGENT_PATTERNS: Record<string, string[]> = {
  '.ts': ['coder', 'Software Architect', 'tester'],
  '.tsx': ['Frontend Developer', 'coder', 'reviewer'],
  '.test.ts': ['tester', 'reviewer'],
  '.spec.ts': ['tester', 'reviewer'],
  '.md': ['Technical Writer', 'researcher'],
  '.json': ['coder', 'Software Architect'],
  '.yaml': ['DevOps Automator', 'coder'],
  '.yml': ['DevOps Automator', 'coder'],
  '.sh': ['DevOps Automator', 'coder'],
  '.py': ['coder', 'AI Engineer', 'researcher'],
  '.sql': ['Database Optimizer', 'coder'],
  '.css': ['Frontend Developer', 'Monodesign'],
  '.scss': ['Frontend Developer', 'Monodesign'],
};

export function getFileExtension(filePath: string): string {
  const match = filePath.match(/\.[a-zA-Z0-9]+$/);
  return match ? match[0] : '';
}

export function suggestAgentsForFile(filePath: string): string[] {
  const ext = getFileExtension(filePath);

  // Check for test files first
  if (filePath.includes('.test.') || filePath.includes('.spec.')) {
    return AGENT_PATTERNS['.test.ts'] || ['tester', 'reviewer'];
  }

  return AGENT_PATTERNS[ext] || ['coder', 'Software Architect'];
}

/**
 * V3: Augment agent suggestions with semantic matches from intelligence.ts ReasoningBank.
 * Returns null when the intelligence system is unavailable or has no relevant patterns.
 * Used by the prompt hook (.claude/helpers/handlers/route-handler.cjs).
 */
// Only pattern types that are registry agent names (the spawnable Task
// subagent_type) count; structural labels ('action', 'observation',
// 'routing') and names no agent carries any more are skipped.
//
// Lean teardown: the SONA neural LoRA routing adaptation (applyNeuralAdaptation +
// the @monomind/neural NeuralLearningSystem singleton) has been removed. Routing now
// uses the pure keyword path plus the deterministic generateSimpleEmbedding query
// against the pattern index, with outcomes recorded via route-outcomes. No ONNX /
// LoRA inference happens on the routing hot path anymore.

export async function suggestAgentsFromIntelligence(
  task: string,
): Promise<{ agents: string[]; confidence: number } | null> {
  try {
    const intel = await import('../memory/intelligence.js');
    await intel.initializeIntelligence();
    const matches = await intel.findSimilarPatterns(task, { k: 5 });
    if (!matches || matches.length === 0) return null;

    // Only count patterns whose type is a registry agent name.
    // Trajectory-derived patterns use type='action'|'observation' etc. — skip those.
    const { agentNames } = await import('../decision/catalogs.js');
    const names = agentNames(getProjectCwd());
    const agentCounts: Record<string, number> = {};
    for (const m of matches) {
      const agent = m.type ?? '';
      if (!names.has(agent)) continue;
      agentCounts[agent] = (agentCounts[agent] ?? 0) + (m.similarity ?? m.confidence ?? 0.5);
    }

    const sorted = Object.entries(agentCounts).sort((a, b) => b[1] - a[1]);
    if (sorted.length === 0) return null;

    // Return top-3 ranked agents so callers can build multi-agent task assignments
    const topAgents = sorted.slice(0, 3).map(([agent]) => agent);
    const confidence = Math.min(0.9, sorted[0][1] / matches.length);
    return { agents: topAgents, confidence };
  } catch {
    return null;
  }
}

/**
 * Mirror of FALLBACK_DESTRUCTIVE_PATTERNS in .claude/helpers/handlers/gates-handler.cjs
 * (the PreToolUse Bash gate). That file is a dependency-free CJS hook helper,
 * so the table cannot be imported here; keep the two in sync. Parity is pinned
 * by __tests__/mcp-tools-hooks-pre-command-risk.test.ts.
 */
export const DESTRUCTIVE_COMMAND_PATTERNS: RegExp[] = [
  /\brm\s+(?:-[a-z]*f[a-z]*r|-[a-z]*r[a-z]*f|--recursive.*--force|--force.*--recursive|-rf?)\b/i,
  /\bdrop\s+(database|table|schema|index)\b/i,
  /\btruncate\s+table\b/i,
  /\bgit\s+push\s+.*--force\b/i,
  /\bgit\s+reset\s+--hard\b/i,
  /\bgit\s+clean\s+.*-f/i,
  /\bformat\s+[a-z]:/i,
  /\bdel\s+\/[sf]\b/i,
  /\b(?:kubectl|helm)\s+delete\s+(?:--all|namespace)\b/i,
  /\bDROP\s+(?:DATABASE|TABLE|SCHEMA)\b/i,
  /\bDELETE\s+FROM\s+\w+/i,
  /\bALTER\s+TABLE\s+\w+\s+DROP\b/i,
];

/** Catastrophic, usually irreversible operations checked per segment. */
const CRITICAL_SEGMENT_PATTERNS: Array<{ pattern: RegExp; warning: string }> = [
  {
    pattern:
      /\brm\s+(?=(?:\S+\s+)*-(?:[a-zA-Z]*[rR]|-recursive))(?:\S+\s+)*["']?(?:\/|~|\$HOME|\$\{HOME\})["']?\/?\*?["']?(?:\s|$)|--no-preserve-root/,
    warning: 'Deletion of home or root directory',
  },
  {
    pattern: /\bgit\s+push\b(?=.*(?:--force\b|\s-f\b|\s\+))(?=.*\b(?:main|master)\b)/,
    warning: 'Force-push to main/master',
  },
  { pattern: /\bgit\s+push\b.*\s-f\b/, warning: 'Force-push detected' },
  { pattern: /\bdd\b.*\bof=\/dev\/(?!null\b)/, warning: 'Raw write to a block device' },
  { pattern: /\bmkfs(?:\.\w+)?\b/, warning: 'Filesystem format' },
];

/** `:(){ :|:& };:` and named variants; checked on the whole command. */
const FORK_BOMB = /([\w:]+)\s*\(\s*\)\s*\{\s*\1\s*\|\s*\1\s*&/;
const SHELL_INTERPRETER = /^(?:sudo\s+)?(?:\S*\/)?(?:sh|bash|zsh|dash|ksh)\b/;

/**
 * Split a shell command into segments on `&&`, `||`, `;`, `|`, `&` and
 * newlines, ignoring separators inside quotes. `piped` marks a segment that
 * reads the previous segment's output.
 */
export function splitCommandSegments(command: string): Array<{ text: string; piped: boolean }> {
  const segments: Array<{ text: string; piped: boolean }> = [];
  let current = '';
  let quote: string | null = null;
  let piped = false;
  const push = (nextPiped: boolean) => {
    const text = current.trim();
    if (text) segments.push({ text, piped });
    current = '';
    piped = nextPiped;
  };
  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    if (ch === '\\' && quote !== "'") {
      current += ch + (command[i + 1] ?? '');
      i++;
    } else if (quote) {
      if (ch === quote) quote = null;
      current += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      current += ch;
    } else if ((ch === '&' || ch === '|') && command[i + 1] === ch) {
      push(false);
      i++;
    } else if (ch === '|') {
      push(true);
      if (command[i + 1] === '&') i++;
    } else if (ch === ';' || ch === '&' || ch === '\n') {
      push(false);
    } else {
      current += ch;
    }
  }
  push(false);
  return segments;
}

export function assessCommandRisk(command: string): {
  risk: string;
  level: number;
  warnings: string[];
} {
  const warnings: string[] = [];
  let level = 0;
  const flag = (value: number, warning: string) => {
    level = Math.max(level, value);
    if (!warnings.includes(warning)) warnings.push(warning);
  };

  if (FORK_BOMB.test(command)) flag(0.95, 'Fork bomb detected');

  // Every segment is evaluated on its own; a harmless first command
  // (`echo hi && …`) no longer caps the risk of what follows.
  for (const { text, piped } of splitCommandSegments(command)) {
    for (const { pattern, warning } of CRITICAL_SEGMENT_PATTERNS) {
      if (pattern.test(text)) flag(0.95, warning);
    }
    const destructive = DESTRUCTIVE_COMMAND_PATTERNS.find((p) => p.test(text));
    if (destructive === DESTRUCTIVE_COMMAND_PATTERNS[0]) {
      flag(0.9, 'Recursive deletion detected - verify target path');
    } else if (destructive) {
      flag(
        0.9,
        `Destructive operation (blocked by the Bash gate): ${text.match(destructive)?.[0]}`,
      );
    }
    if (piped && SHELL_INTERPRETER.test(text)) flag(0.9, 'Piping content into a shell');
    if (/\bsudo\b/.test(text)) flag(0.7, 'Elevated privileges requested');
    if (/>>? \/(?!dev\/null\b)/.test(text)) flag(0.6, 'Writing to system path');
    if (/\bch(?:mod|own)\b/.test(text)) flag(0.5, 'Permission modification');
  }

  const risk = level >= 0.7 ? 'high' : level >= 0.4 ? 'medium' : 'low';

  return { risk, level, warnings };
}
