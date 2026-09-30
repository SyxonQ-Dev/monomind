/**
 * CLI MCP tool subcommands: tools, toggle, exec.
 * Split from mcp.ts.
 *
 * @module @monomind/cli/commands/mcp-tool-commands
 */

import { callMCPTool, hasTool, listMCPTools } from '../mcp-client.js';
import { output } from '../output.js';
import type { Command, CommandContext, CommandResult } from '../types.js';

// MCP tools categories — `value` must match the literal `category` field set
// on registered MCPTool entries (see mcp-tools/*.ts), not the lazy-load
// category key in mcp-client.ts's CATEGORY_LOADERS. Values that don't match
// any tool's `category` field always return zero results from the real
// registry (previously masked by a fabricated static fallback list).
const TOOL_CATEGORIES = [
  { value: 'agent', label: 'Agents', hint: 'Agent store tools' },
  { value: 'performance', label: 'Monitoring', hint: 'Status and metrics monitoring' },
  { value: 'knowledge', label: 'Memory', hint: 'Memory and neural features' },
  { value: 'github', label: 'GitHub', hint: 'GitHub integration tools' },
  { value: 'system', label: 'System', hint: 'System and benchmark tools' },
];

// List tools
export const toolsCommand: Command = {
  name: 'tools',
  description: 'List available MCP tools',
  options: [
    {
      name: 'category',
      short: 'c',
      description: 'Filter by category',
      type: 'string',
      choices: TOOL_CATEGORIES.map((c) => c.value),
    },
    {
      name: 'enabled',
      description: 'Show only enabled tools',
      type: 'boolean',
      default: false,
    },
  ],
  action: async (ctx: CommandContext): Promise<CommandResult> => {
    const category = ctx.flags.category as string;

    // Use local tool registry — no static fallback. If the registry can't be
    // loaded, let the error propagate rather than showing a fabricated list.
    const registeredTools = await listMCPTools(category);

    const tools: Array<{ name: string; category: string; description: string; enabled: boolean }> =
      registeredTools.map((tool) => ({
        name: tool.name,
        category: tool.category || 'uncategorized',
        description: tool.description,
        enabled: tool.enabled,
      }));

    if (ctx.flags.format === 'json') {
      output.printJson(tools);
      return { success: true, data: tools };
    }

    output.writeln();
    output.writeln(output.bold('Available MCP Tools'));
    output.writeln();

    if (tools.length === 0) {
      output.printInfo(category ? `0 tools matched category "${category}"` : '0 tools matched');
      return { success: true, data: tools };
    }

    // Group by category
    const grouped = tools.reduce(
      (acc, tool) => {
        if (!acc[tool.category]) acc[tool.category] = [];
        acc[tool.category].push(tool);
        return acc;
      },
      {} as Record<string, typeof tools>,
    );

    for (const [cat, catTools] of Object.entries(grouped)) {
      output.writeln(output.highlight(cat.charAt(0).toUpperCase() + cat.slice(1)));

      output.printTable({
        columns: [
          { key: 'name', header: 'Tool', width: 25 },
          { key: 'description', header: 'Description', width: 35 },
          {
            key: 'enabled',
            header: 'Status',
            width: 10,
            format: (v: unknown) =>
              (v as boolean) ? output.success('Enabled') : output.dim('Disabled'),
          },
        ],
        data: catTools,
        border: false,
      });

      output.writeln();
    }

    output.printInfo(`Total: ${tools.length} tools`);

    return { success: true, data: tools };
  },
};

// Enable/disable tools
export const toggleCommand: Command = {
  name: 'toggle',
  description: 'Enable or disable MCP tools',
  options: [
    {
      name: 'enable',
      short: 'e',
      description: 'Enable tools',
      type: 'string',
    },
    {
      name: 'disable',
      short: 'd',
      description: 'Disable tools',
      type: 'string',
    },
  ],
  action: async (ctx: CommandContext): Promise<CommandResult> => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const stateFile = path.join(ctx.cwd, '.monomind', 'mcp-disabled-tools.json');

    let disabled: string[] = [];
    try {
      disabled = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    } catch (e) {
      if (process.env.DEBUG || process.env.MONOMIND_DEBUG)
        console.error('[mcp] failed to load mcp-disabled-tools.json, treating as fresh:', e);
    }

    const enableArg = ctx.flags.enable as string | undefined;
    const disableArg = ctx.flags.disable as string | undefined;

    if (!enableArg && !disableArg) {
      output.writeln(output.warning('Provide --enable <tool> or --disable <tool>'));
      return { success: false, exitCode: 1 };
    }

    if (disableArg) {
      const tools = disableArg.split(',').map((t) => t.trim());
      for (const t of tools) {
        if (!disabled.includes(t)) disabled.push(t);
      }
      output.printSuccess(`Disabled: ${tools.join(', ')}`);
    }

    if (enableArg) {
      const tools = enableArg.split(',').map((t) => t.trim());
      disabled = disabled.filter((t) => !tools.includes(t));
      output.printSuccess(`Enabled: ${tools.join(', ')}`);
    }

    fs.mkdirSync(path.dirname(stateFile), { recursive: true });
    fs.writeFileSync(stateFile, `${JSON.stringify(disabled, null, 2)}\n`);
    output.writeln(output.dim(`State saved to ${stateFile}. ${disabled.length} tool(s) disabled.`));
    output.writeln(output.dim('Disabled tools are rejected immediately by direct CLI invocation.'));
    output.writeln(
      output.dim(
        'An external MCP server (mcp start) must be restarted to stop exposing disabled tools to MCP clients.',
      ),
    );

    return { success: true };
  },
};

// Execute tool
export const execCommand: Command = {
  name: 'exec',
  description: 'Execute an MCP tool',
  options: [
    {
      name: 'tool',
      short: 't',
      description: 'Tool name',
      type: 'string',
      required: true,
    },
    {
      name: 'params',
      short: 'p',
      description: 'Tool parameters (JSON)',
      type: 'string',
    },
  ],
  examples: [
    {
      command: 'monomind mcp exec -t agent_list -p \'{"includeTerminated":true}\'',
      description: 'Execute tool',
    },
  ],
  action: async (ctx: CommandContext): Promise<CommandResult> => {
    const tool = (ctx.flags.tool as string) || ctx.args[0];
    const paramsStr = ctx.flags.params as string;

    if (!tool) {
      output.printError('Tool name is required. Use --tool or -t');
      return { success: false, exitCode: 1 };
    }

    let params = {};
    if (paramsStr) {
      try {
        params = JSON.parse(paramsStr);
      } catch (_e) {
        output.printError('Invalid JSON parameters');
        return { success: false, exitCode: 1 };
      }
    }

    output.printInfo(`Executing tool: ${tool}`);

    if (Object.keys(params).length > 0) {
      output.writeln(output.dim(`  Parameters: ${JSON.stringify(params)}`));
    }

    try {
      // Execute through local MCP tool registry
      if (!(await hasTool(tool))) {
        output.printError(`Tool not found: ${tool}`);
        return { success: false, exitCode: 1 };
      }

      const startTime = performance.now();
      const result = await callMCPTool(tool, params, {
        sessionId: `cli-${Date.now().toString(36)}`,
        requestId: `exec-${Date.now()}`,
      });
      const duration = performance.now() - startTime;

      output.writeln();
      output.printSuccess(`Tool executed in ${duration.toFixed(2)}ms`);

      if (ctx.flags.format === 'json') {
        output.printJson({ tool, params, result, duration });
      } else {
        output.writeln();
        output.writeln(output.bold('Result:'));
        output.printJson(result);
      }

      return { success: true, data: { tool, params, result, duration } };
    } catch (error) {
      output.printError(`Tool execution failed: ${(error as Error).message}`);
      return { success: false, exitCode: 1 };
    }
  },
};
