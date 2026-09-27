import type { PlatformAdapter, PlatformId } from './types.js';

/**
 * Declared locations are data, not proof that a capability is currently
 * verified. Rendering remains gated by the adapter's capability evidence.
 * User paths are relative to the selected home directory.
 */
export const PLATFORM_PATHS: Record<PlatformId, PlatformAdapter['paths']> = {
  claude: {
    locations: {
      instruction: { project: { path: 'CLAUDE.md', format: 'md' }, user: 'cli_fallback' },
      skill: { project: { path: '.claude/skills' }, user: { path: '.claude/skills' } },
      command: {
        project: { path: '.claude/commands/monomind.md', format: 'md' },
        user: 'cli_fallback',
      },
      agent: {
        project: { path: '.claude/agents/mastermind-coordinator.md', format: 'md' },
        user: 'cli_fallback',
      },
      mcp: {
        project: { path: '.mcp.json', format: 'json', entryPath: ['mcpServers', 'monomind'] },
        user: 'cli_fallback',
      },
    },
  },
  gemini: {
    locations: {
      instruction: { project: { path: 'GEMINI.md', format: 'md' }, user: 'cli_fallback' },
      skill: { project: { path: '.agents/skills' }, user: { path: '.agents/skills' } },
      mcp: {
        project: {
          path: '.gemini/settings.json',
          format: 'json',
          entryPath: ['mcpServers', 'monomind'],
        },
        user: 'cli_fallback',
      },
    },
  },
  cursor: {
    locations: {
      instruction: {
        project: { path: '.cursor/rules/monomind.mdc', format: 'md' },
        user: 'cli_fallback',
      },
      skill: { project: { path: '.agents/skills' }, user: { path: '.agents/skills' } },
      mcp: {
        project: {
          path: '.cursor/mcp.json',
          format: 'json',
          entryPath: ['mcpServers', 'monomind'],
        },
        user: 'cli_fallback',
      },
    },
  },
  vscode: {
    locations: {
      instruction: {
        project: { path: '.github/copilot-instructions.md', format: 'md' },
        user: 'cli_fallback',
      },
      skill: { project: { path: '.agents/skills' }, user: { path: '.agents/skills' } },
      mcp: {
        project: { path: '.vscode/mcp.json', format: 'json', entryPath: ['servers', 'monomind'] },
        user: 'cli_fallback',
      },
    },
  },
  copilot: {
    locations: {
      instruction: {
        project: { path: '.github/copilot-instructions.md', format: 'md' },
        user: 'cli_fallback',
      },
      skill: { project: { path: '.agents/skills' }, user: { path: '.agents/skills' } },
      mcp: { project: 'cli_fallback', user: 'cli_fallback' },
    },
  },
  opencode: {
    locations: {
      instruction: { project: { path: 'AGENTS.md', format: 'md' }, user: 'cli_fallback' },
      skill: { project: { path: '.agents/skills' }, user: { path: '.agents/skills' } },
      command: {
        project: { path: '.opencode/commands/monomind.md', format: 'md' },
        user: 'cli_fallback',
      },
      agent: {
        project: { path: '.opencode/agents/mastermind-coordinator.md', format: 'md' },
        user: 'cli_fallback',
      },
      mcp: {
        project: { path: 'opencode.json', format: 'jsonc', entryPath: ['mcp', 'monomind'] },
        user: 'cli_fallback',
      },
    },
  },
  aider: {
    locations: {
      instruction: { project: { path: 'CONVENTIONS.md', format: 'md' }, user: 'cli_fallback' },
      skill: { project: 'cli_fallback', user: 'cli_fallback' },
      mcp: { project: 'cli_fallback', user: 'cli_fallback' },
    },
  },
  kiro: {
    locations: {
      instruction: {
        project: { path: '.kiro/steering/monomind.md', format: 'md' },
        user: 'cli_fallback',
      },
      skill: { project: { path: '.kiro/skills' }, user: 'cli_fallback' },
      mcp: {
        project: { path: '.kiro/mcp.json', format: 'json', entryPath: ['mcpServers', 'monomind'] },
        user: 'cli_fallback',
      },
    },
  },
  trae: {
    locations: {
      instruction: {
        project: { path: '.trae/rules/monomind.md', format: 'md' },
        user: 'cli_fallback',
      },
      skill: { project: 'discovery', user: 'discovery' },
      mcp: { project: 'cli_fallback', user: 'cli_fallback' },
    },
  },
  openclaw: {
    locations: {
      instruction: { project: { path: 'AGENTS.md', format: 'md' }, user: 'cli_fallback' },
      skill: { project: { path: '.agents/skills' }, user: { path: '.agents/skills' } },
      mcp: {
        project: 'cli_fallback',
        user: {
          path: '.openclaw/openclaw.json',
          format: 'json',
          entryPath: ['mcpServers', 'monomind'],
        },
      },
    },
  },
  droid: {
    locations: {
      instruction: { project: { path: 'AGENTS.md', format: 'md' }, user: 'cli_fallback' },
      skill: { project: { path: '.agents/skills' }, user: { path: '.agents/skills' } },
      mcp: {
        project: {
          path: '.factory/mcp.json',
          format: 'json',
          entryPath: ['mcpServers', 'monomind'],
        },
        user: { path: '.factory/mcp.json', format: 'json', entryPath: ['mcpServers', 'monomind'] },
      },
    },
  },
  antigravity: {
    locations: {
      instruction: { project: 'discovery', user: 'discovery' },
      skill: { project: { path: '.agents/skills' }, user: 'discovery' },
      mcp: { project: 'discovery', user: 'discovery' },
    },
  },
  hermes: {
    locations: {
      instruction: { project: 'cli_fallback', user: 'cli_fallback' },
      skill: { project: { path: '.agents/skills' }, user: { path: '.agents/skills' } },
      mcp: { project: 'cli_fallback', user: 'discovery' },
    },
  },
  codex: {
    locations: {
      instruction: { project: { path: 'AGENTS.md', format: 'md' }, user: 'cli_fallback' },
      skill: { project: { path: '.agents/skills' }, user: { path: '.agents/skills' } },
      mcp: {
        project: {
          path: '.codex/config.toml',
          format: 'toml',
          entryPath: ['mcp_servers', 'monomind'],
        },
        user: 'cli_fallback',
      },
      // Hooks remain evidence-gated. These paths are intentionally just
      // locations, not a claim that the current registry may render a hook.
      hook: { project: { path: '.codex/config.toml', format: 'toml' }, user: 'cli_fallback' },
      hook_bridge: {
        project: { path: '.agents/monomind/hook-bridge.mjs', format: 'js' },
        user: 'cli_fallback',
      },
    },
  },
  kimi: {
    locations: {
      instruction: { project: { path: 'AGENTS.md', format: 'md' }, user: 'cli_fallback' },
      skill: { project: { path: '.agents/skills' }, user: { path: '.agents/skills' } },
      mcp: {
        project: {
          path: '.kimi-code/mcp.json',
          format: 'json',
          entryPath: ['mcpServers', 'monomind'],
        },
        user: 'cli_fallback',
      },
    },
  },
  zed: {
    locations: {
      instruction: { project: { path: 'AGENTS.md', format: 'md' }, user: 'cli_fallback' },
      skill: { project: { path: '.agents/skills' }, user: { path: '.agents/skills' } },
      mcp: {
        project: {
          path: '.zed/settings.json',
          format: 'jsonc',
          entryPath: ['context_servers', 'monomind'],
        },
        user: 'cli_fallback',
      },
    },
  },
};
