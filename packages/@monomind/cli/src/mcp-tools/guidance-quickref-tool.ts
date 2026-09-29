/**
 * Guidance MCP tool: guidance_quickref.
 *
 * Split out of guidance-tools.ts, which registers the guidance tools in
 * `guidanceTools`.
 */

import type { MCPTool } from './types.js';

export const guidanceQuickRef: MCPTool = {
  name: 'guidance_quickref',
  description:
    'Quick reference card for common operations. Returns the most useful commands for a given domain.',
  inputSchema: {
    type: 'object',
    properties: {
      domain: {
        type: 'string',
        enum: [
          'getting-started',
          'daily-dev',
          'swarm-ops',
          'memory-ops',
          'github-ops',
          'diagnostics',
        ],
        description: 'Domain to get quick reference for.',
      },
    },
    required: ['domain'],
  },
  handler: async (params: Record<string, unknown>) => {
    // Cap domain before any use — reflected in the error JSON when the key is
    // unknown, allowing an attacker to embed an arbitrarily long string.
    const MAX_DOMAIN_LEN = 128;
    const rawDomain = params.domain;
    const domain =
      typeof rawDomain === 'string' && rawDomain.length <= MAX_DOMAIN_LEN ? rawDomain : '';

    const refs: Record<string, { title: string; commands: Array<{ cmd: string; desc: string }> }> =
      {
        'getting-started': {
          title: 'Getting Started',
          commands: [
            {
              cmd: 'npx monomind init wizard',
              desc: 'Initialize project with interactive setup',
            },
            {
              cmd: 'npx monomind@latest doctor --fix',
              desc: 'Run diagnostics and auto-fix issues',
            },
            { cmd: 'npx monomind@latest status', desc: 'Check system status' },
          ],
        },
        'daily-dev': {
          title: 'Daily Development',
          commands: [
            {
              cmd: 'npx monomind@latest hooks pre-task --description "..."',
              desc: 'Get routing recommendation before task',
            },
            {
              cmd: 'npx monomind@latest hooks post-task --task-id "..." --success true',
              desc: 'Record task outcome for learning',
            },
            {
              cmd: 'npx monomind@latest hooks post-edit --file "..." --success true',
              desc: 'Record an edit outcome in the local feedback log',
            },
            {
              cmd: 'npx monomind@latest memory search --query "..."',
              desc: 'Search memory for relevant patterns',
            },
            {
              cmd: 'npx monomind@latest hooks route --task "..."',
              desc: 'Route task to optimal agent',
            },
          ],
        },
        'swarm-ops': {
          title: 'Monoswarm Operations',
          commands: [
            {
              cmd: 'npx monomind@latest monoswarm init --topology hierarchical --max-agents 8',
              desc: 'Initialize anti-drift monoswarm',
            },
            { cmd: 'npx monomind@latest monoswarm status', desc: 'Check monoswarm status' },
            {
              cmd: 'npx monomind@latest agent spawn -t coder --name my-coder',
              desc: 'Spawn a specific agent',
            },
          ],
        },
        'memory-ops': {
          title: 'Memory Operations',
          commands: [
            { cmd: 'npx monomind@latest memory init --force', desc: 'Initialize memory database' },
            {
              cmd: 'npx monomind@latest memory store --key "k" --value "v" --namespace patterns',
              desc: 'Store a value',
            },
            {
              cmd: 'npx monomind@latest memory search --query "auth patterns"',
              desc: 'Semantic vector search',
            },
            {
              cmd: 'npx monomind@latest memory list --namespace patterns',
              desc: 'List entries in namespace',
            },
            {
              cmd: 'npx monomind@latest memory retrieve --key "k" --namespace patterns',
              desc: 'Get a specific entry',
            },
          ],
        },
        'github-ops': {
          title: 'GitHub Operations',
          commands: [
            {
              cmd: 'Use pr-manager agent for PR lifecycle',
              desc: 'Spawn pr-manager for automated PR management',
            },
            {
              cmd: 'Use monoswarm-code-review agent for reviews',
              desc: 'Deploy multi-agent code review',
            },
            {
              cmd: 'Use release-manager agent for releases',
              desc: 'Automated release with changelog',
            },
            { cmd: 'Use issue-tracker agent for triage', desc: 'Intelligent issue management' },
          ],
        },
        diagnostics: {
          title: 'Diagnostics & Troubleshooting',
          commands: [
            {
              cmd: 'npx monomind@latest doctor --fix',
              desc: 'Full system diagnostics with auto-fix',
            },
            { cmd: 'npx monomind@latest status --watch', desc: 'Live system monitoring' },
            { cmd: 'npx monomind@latest hooks worker status', desc: 'Background worker health' },
            {
              cmd: 'npx monomind@latest performance benchmark --suite all',
              desc: 'Run all benchmarks',
            },
            {
              cmd: 'npx monomind@latest hooks progress --detailed',
              desc: 'V1 implementation progress',
            },
          ],
        },
      };

    const ref = domain ? refs[domain] : undefined;
    if (!ref) {
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              { error: 'Unknown quick-ref domain', available: Object.keys(refs) },
              null,
              2,
            ),
          },
        ],
        isError: true,
      };
    }

    return { content: [{ type: 'text', text: JSON.stringify(ref, null, 2) }] };
  },
};
