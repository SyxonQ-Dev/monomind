/**
 * Guidance MCP Tools
 *
 * Helps the system navigate Monomind's capabilities by providing structured
 * discovery of tools, commands, agents, skills, and recommended workflows.
 *
 * The static capability catalog, task routes/workflow templates and the
 * guidance_quickref tool live in guidance-catalog.ts, guidance-routes.ts and
 * guidance-quickref-tool.ts.
 *
 * @module @monomind/cli/mcp-tools/guidance
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pickAgents } from '../routing/agent-pick.js';
import { CAPABILITY_CATALOG, type CapabilityArea } from './guidance-catalog.js';
import { guidanceQuickRef } from './guidance-quickref-tool.js';
import { TASK_ROUTES, WORKFLOW_TEMPLATES } from './guidance-routes.js';
import { getProjectCwd, type MCPTool } from './types.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const CLI_ROOT = join(__dirname, '../../..');

/**
 * Find the project root by looking for .claude/ directory.
 * Tries CWD first (most common), then walks up from the CLI package location.
 */
function findProjectRoot(): string {
  // Allow operator override; trusted when set.
  const envRoot = process.env.MONOMIND_PROJECT_ROOT;
  if (envRoot && existsSync(join(envRoot, '.claude'))) {
    return envRoot;
  }

  // Strategy 1: CWD (most reliable when invoked by user)
  if (existsSync(join(getProjectCwd(), '.claude'))) {
    return getProjectCwd();
  }

  // Strategy 2: Walk up from CLI package location.
  // CLI is at packages/@monomind/cli/ — project root is 4 levels up.
  const fromPackage = join(CLI_ROOT, '../../../..');
  if (existsSync(join(fromPackage, '.claude'))) {
    return fromPackage;
  }

  // Strategy 3: Walk up from CWD, but stop at the first ancestor that ALSO
  // contains a project-marker the user owns (`.git` or `package.json`). This
  // closes a confused-deputy: previously, dropping `.claude/agents/x.md` in
  // any of 10 ancestor directories (e.g., `/tmp`) would have been consumed
  // as authoritative agent data. Requiring a marker means an attacker also
  // needs control over a `.git` repo or `package.json` at the same level —
  // which means they already control the project.
  let dir = getProjectCwd();
  for (let i = 0; i < 10; i++) {
    if (
      existsSync(join(dir, '.claude')) &&
      (existsSync(join(dir, '.git')) || existsSync(join(dir, 'package.json')))
    ) {
      return dir;
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  // Fallback: CWD
  return getProjectCwd();
}

const PROJECT_ROOT = findProjectRoot();

// ── Dynamic Discovery ───────────────────────────────────────

function discoverAgents(): string[] {
  const agentsDir = join(PROJECT_ROOT, '.claude/agents');
  if (!existsSync(agentsDir)) return [];

  const agents: string[] = [];
  const visited = new Set<string>();
  // Symlink-aware walk with depth cap. `entry.isDirectory()` returns true for
  // symlinks pointing at directories, so a careless `agents/loop -> ..`
  // symlink would otherwise traverse outside the agents tree (or loop
  // forever). Using lstat + skipping symlinks closes both vectors.
  function walk(dir: string, depth: number): void {
    if (depth > 8) return;
    if (visited.has(dir)) return;
    visited.add(dir);
    try {
      const entries = readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isSymbolicLink()) continue;
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(full, depth + 1);
        } else if (
          entry.isFile() &&
          entry.name.endsWith('.md') &&
          entry.name !== 'MIGRATION_SUMMARY.md'
        ) {
          if (statSync(full).size > 512 * 1024) continue; // skip files > 512 KB
          const content = readFileSync(full, 'utf-8');
          const nameMatch = content.match(/^name:\s*(.+)$/m);
          if (nameMatch) agents.push(nameMatch[1].trim().replace(/^["']|["']$/g, ''));
        }
      }
    } catch {
      /* ignore */
    }
  }
  walk(agentsDir, 0);
  return [...new Set(agents)].sort();
}

function discoverSkills(): string[] {
  const skillsDir = join(PROJECT_ROOT, '.claude/skills');
  if (!existsSync(skillsDir)) return [];

  const skills: string[] = [];
  try {
    const entries = readdirSync(skillsDir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        const skillFile = join(skillsDir, entry.name, 'SKILL.md');
        if (existsSync(skillFile)) {
          skills.push(entry.name);
        }
      }
    }
  } catch {
    /* ignore */
  }
  return skills.sort();
}

// ── MCP Tool Definitions ────────────────────────────────────

const guidanceCapabilities: MCPTool = {
  name: 'guidance_capabilities',
  description:
    'List all capability areas with their tools, commands, agents, and skills. Use this to discover what Monomind can do.',
  inputSchema: {
    type: 'object',
    properties: {
      area: {
        type: 'string',
        description:
          'Filter to a specific area (e.g., "monoswarm", "memory-knowledge"). Omit to list all areas.',
      },
      format: {
        type: 'string',
        enum: ['summary', 'detailed'],
        description:
          'Output format. "summary" lists names and descriptions, "detailed" includes tools/agents/skills.',
      },
    },
  },
  handler: async (params: Record<string, unknown>) => {
    // Cap area before any use — reflected verbatim in the error JSON if the
    // key is unknown, which would allow a caller to embed an arbitrarily long
    // string in the MCP response body.
    const MAX_AREA_LEN = 128;
    const rawArea = params.area;
    const area =
      typeof rawArea === 'string' && rawArea.length <= MAX_AREA_LEN ? rawArea : undefined;
    const format = (params.format as string) || 'summary';

    if (area) {
      const cap = CAPABILITY_CATALOG[area];
      if (!cap) {
        const available = Object.keys(CAPABILITY_CATALOG).join(', ');
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({ error: 'Unknown capability area', available }, null, 2),
            },
          ],
          isError: true,
        };
      }
      return { content: [{ type: 'text', text: JSON.stringify(cap, null, 2) }] };
    }

    if (format === 'detailed') {
      return { content: [{ type: 'text', text: JSON.stringify(CAPABILITY_CATALOG, null, 2) }] };
    }

    const summary = Object.entries(CAPABILITY_CATALOG).map(([key, val]) => ({
      area: key,
      name: val.name,
      description: val.description,
      toolCount: val.tools.length,
      agentCount: val.agents.length,
      skillCount: val.skills.length,
      whenToUse: val.whenToUse,
    }));

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({ areas: summary, totalAreas: summary.length }, null, 2),
        },
      ],
    };
  },
};

const guidanceRecommend: MCPTool = {
  name: 'guidance_recommend',
  description:
    'Given a task description, recommend which capability areas, tools, and workflow to use, ' +
    'plus the agents the central picker ranks for it (`agents[].name` is a spawnable Task subagent_type).',
  inputSchema: {
    type: 'object',
    properties: {
      task: {
        type: 'string',
        description: 'Description of what you want to accomplish.',
      },
    },
    required: ['task'],
  },
  handler: async (params: Record<string, unknown>) => {
    // Cap task: iterated through 14 regex patterns via route.pattern.test(task).
    // Each .test() call is O(n) on the input string; without a cap an attacker
    // can make every routing call O(14n) on an arbitrary-length string.
    const MAX_GUIDANCE_TASK_LEN = 16 * 1024;
    const rawTask = params.task as string;
    const task =
      typeof rawTask === 'string' && rawTask.length > MAX_GUIDANCE_TASK_LEN
        ? rawTask.slice(0, MAX_GUIDANCE_TASK_LEN)
        : rawTask;
    const matches: Array<{
      area: string;
      capability: CapabilityArea;
      workflow: string;
      score: number;
    }> = [];

    for (const route of TASK_ROUTES) {
      if (route.pattern.test(task)) {
        for (const areaKey of route.areas) {
          const cap = CAPABILITY_CATALOG[areaKey];
          if (cap) {
            matches.push({ area: areaKey, capability: cap, workflow: route.workflow, score: 1 });
          }
        }
      }
    }

    // Deduplicate by area, keeping highest score
    const seen = new Map<string, (typeof matches)[0]>();
    for (const m of matches) {
      const existing = seen.get(m.area);
      if (!existing || m.score > existing.score) {
        seen.set(m.area, m);
      }
    }

    const recommendations = [...seen.values()];

    // Agents come from the central picker, the ranking `pick` and the routing
    // hooks use; capability areas keep only their tool/workflow guidance.
    const picked = await pickAgents(typeof task === 'string' ? task : '', 3);
    const agents = picked.agents.map((a) => ({
      name: a.type,
      confidence: a.confidence,
      reason: a.reason,
    }));

    if (recommendations.length === 0) {
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                task,
                message: 'No specific pattern matched. Here are general-purpose capabilities:',
                suggestions: [
                  { area: 'agent-management', reason: 'Spawn individual agents for targeted work' },
                  { area: 'monoswarm', reason: 'Use swarms for multi-file or complex tasks' },
                  { area: 'hooks-automation', reason: 'Use hooks for task routing and learning' },
                ],
                agents,
                tip: 'Use guidance_capabilities for a full list of all capability areas.',
              },
              null,
              2,
            ),
          },
        ],
      };
    }

    const primaryWorkflow = recommendations[0]?.workflow;
    const template = primaryWorkflow ? WORKFLOW_TEMPLATES[primaryWorkflow] : undefined;

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(
            {
              task,
              recommendations: recommendations.map((r) => ({
                area: r.area,
                name: r.capability.name,
                description: r.capability.description,
                tools: r.capability.tools,
                skills: r.capability.skills,
              })),
              agents,
              workflow: template
                ? {
                    name: primaryWorkflow,
                    steps: template.steps,
                    agents: template.agents,
                    topology: template.topology,
                  }
                : undefined,
            },
            null,
            2,
          ),
        },
      ],
    };
  },
};

const guidanceDiscover: MCPTool = {
  name: 'guidance_discover',
  description:
    'Discover all available agents and skills from the .claude/ directory. Returns live filesystem data.',
  inputSchema: {
    type: 'object',
    properties: {
      type: {
        type: 'string',
        enum: ['agents', 'skills', 'all'],
        description: 'What to discover. Default: all.',
      },
    },
  },
  handler: async (params: Record<string, unknown>) => {
    const type = (params.type as string) || 'all';

    const result: Record<string, unknown> = {};

    if (type === 'agents' || type === 'all') {
      const agents = discoverAgents();
      result.agents = { count: agents.length, names: agents };
    }

    if (type === 'skills' || type === 'all') {
      const skills = discoverSkills();
      result.skills = { count: skills.length, names: skills };
    }

    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
  },
};

const guidanceWorkflow: MCPTool = {
  name: 'guidance_workflow',
  description:
    'Get a recommended workflow template for a task type. Includes steps, agents, and topology.',
  inputSchema: {
    type: 'object',
    properties: {
      type: {
        type: 'string',
        enum: Object.keys(WORKFLOW_TEMPLATES),
        description: `Workflow type. Options: ${Object.keys(WORKFLOW_TEMPLATES).join(', ')}`,
      },
    },
    required: ['type'],
  },
  handler: async (params: Record<string, unknown>) => {
    // Cap type before any use — reflected in the error JSON when the key is
    // unknown, allowing an attacker to embed an arbitrarily long string.
    const MAX_TYPE_LEN = 128;
    const rawType = params.type;
    const type = typeof rawType === 'string' && rawType.length <= MAX_TYPE_LEN ? rawType : '';
    const template = type ? WORKFLOW_TEMPLATES[type] : undefined;

    if (!template) {
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                error: 'Unknown workflow type',
                available: Object.keys(WORKFLOW_TEMPLATES),
              },
              null,
              2,
            ),
          },
        ],
        isError: true,
      };
    }

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(
            {
              workflow: type,
              ...template,
              swarmConfig: {
                topology: template.topology,
                maxAgents: Math.max(template.agents.length + 1, 4),
                strategy: 'specialized',
                consensus: 'majority',
              },
            },
            null,
            2,
          ),
        },
      ],
    };
  },
};

/**
 * All guidance tools
 */
export const guidanceTools: MCPTool[] = [
  guidanceCapabilities,
  guidanceRecommend,
  guidanceDiscover,
  guidanceWorkflow,
  guidanceQuickRef,
];

export default guidanceTools;
