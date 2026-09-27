import { capSecurityInput, getMonoFence, MAX_SECURITY_INPUT_LEN } from './security-tools-core.js';
import type { MCPTool, MCPToolResult } from './types.js';

/**
 * Check if input is safe (simple boolean check)
 */
export const monofenceIsSafeTool: MCPTool = {
  name: 'monofence_is_safe',
  description: 'Quick boolean check if input is safe. Fastest option for simple validation.',
  inputSchema: {
    type: 'object',
    properties: {
      input: {
        type: 'string',
        description: 'Text to check',
      },
    },
    required: ['input'],
  },
  handler: async (args: Record<string, unknown>): Promise<MCPToolResult> => {
    let input: string;
    try {
      input = capSecurityInput(args.input);
    } catch (e) {
      return {
        content: [{ type: 'text', text: JSON.stringify({ error: (e as Error).message }) }],
        isError: true,
      };
    }

    try {
      await getMonoFence(); // triggers auto-install if package is missing
      const { isSafe } = await import('monofence-ai');
      const safe = isSafe(input);

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({ safe }, null, 2),
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({ error: String(error) }),
          },
        ],
        isError: true,
      };
    }
  },
};

/**
 * Check for PII in input
 */
export const monofenceHasPIITool: MCPTool = {
  name: 'monofence_has_pii',
  description: 'Check if input contains PII (emails, SSNs, API keys, passwords, etc.).',
  inputSchema: {
    type: 'object',
    properties: {
      input: {
        type: 'string',
        description: 'Text to check for PII',
      },
    },
    required: ['input'],
  },
  handler: async (args: Record<string, unknown>): Promise<MCPToolResult> => {
    let input: string;
    try {
      input = capSecurityInput(args.input);
    } catch (e) {
      return {
        content: [{ type: 'text', text: JSON.stringify({ error: (e as Error).message }) }],
        isError: true,
      };
    }

    try {
      const defender = await getMonoFence();
      const hasPII = defender.hasPII(input);

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({ hasPII }, null, 2),
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({ error: String(error) }),
          },
        ],
        isError: true,
      };
    }
  },
};

/**
 * Scan LLM output for PII leakage, prompt echo, and policy violations
 */
export const monofenceScanOutputTool: MCPTool = {
  name: 'monofence_scan_output',
  description:
    'Scan LLM output for PII leakage, prompt echo (trigram Jaccard), and policy violations. Use after receiving a model response.',
  inputSchema: {
    type: 'object',
    properties: {
      output: {
        type: 'string',
        description: 'LLM output text to scan',
      },
      originalPrompt: {
        type: 'string',
        description: 'Original prompt sent to the LLM (enables echo detection)',
      },
    },
    required: ['output'],
  },
  handler: async (args: Record<string, unknown>): Promise<MCPToolResult> => {
    let output: string;
    try {
      output = capSecurityInput(args.output, 'output');
    } catch (e) {
      return {
        content: [{ type: 'text', text: JSON.stringify({ error: (e as Error).message }) }],
        isError: true,
      };
    }
    const rawPrompt = args.originalPrompt as string | undefined;
    const originalPrompt =
      typeof rawPrompt === 'string'
        ? rawPrompt.length > MAX_SECURITY_INPUT_LEN
          ? rawPrompt.slice(0, MAX_SECURITY_INPUT_LEN)
          : rawPrompt
        : undefined;

    try {
      const defender = await getMonoFence();
      const result = await defender.scanOutput(output, originalPrompt);

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({ error: String(error) }),
          },
        ],
        isError: true,
      };
    }
  },
};

/**
 * Get or reset multi-turn context escalation state
 */
export const monofenceContextTool: MCPTool = {
  name: 'monofence_context',
  description:
    'Get the multi-turn context escalation state (normal/suspicious/elevated/attack) and cumulative threat score. Pass reset=true to start a fresh session.',
  inputSchema: {
    type: 'object',
    properties: {
      reset: {
        type: 'boolean',
        description: 'Reset context to start a new session',
        default: false,
      },
    },
  },
  handler: async (args: Record<string, unknown>): Promise<MCPToolResult> => {
    const reset = args.reset as boolean;

    try {
      const defender = await getMonoFence();

      if (reset) {
        defender.resetContext();
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                {
                  message: 'Context reset — escalation state cleared',
                  state: defender.getContextState(),
                },
                null,
                2,
              ),
            },
          ],
        };
      }

      const state = defender.getContextState();
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(state, null, 2),
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({ error: String(error) }),
          },
        ],
        isError: true,
      };
    }
  },
};
