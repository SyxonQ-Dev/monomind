/**
 * @monoes/mcp - MCP Server (built-ins)
 *
 * Built-in system tools, resources and prompts registered on start().
 */

import { arch, platform } from 'node:os';
import { MCPServerCore } from './server-core.js';

export abstract class MCPServerBuiltins extends MCPServerCore {
  protected async registerBuiltInTools(): Promise<void> {
    this.registerTool({
      name: 'system/info',
      description: 'Get system information',
      inputSchema: { type: 'object', properties: {} },
      handler: async () => ({
        name: this.serverInfo.name,
        version: this.serverInfo.version,
        platform: platform(),
        arch: arch(),
        runtime: 'Node.js',
        uptime: this.startTime ? Date.now() - this.startTime.getTime() : 0,
      }),
      category: 'system',
    });

    this.registerTool({
      name: 'system/health',
      description: 'Get system health status',
      inputSchema: { type: 'object', properties: {} },
      handler: async () => await this.getHealthStatus(),
      category: 'system',
      cacheable: true,
      cacheTTL: 2000,
    });

    this.registerTool({
      name: 'system/metrics',
      description: 'Get server metrics',
      inputSchema: { type: 'object', properties: {} },
      handler: async () => this.getMetrics(),
      category: 'system',
      cacheable: true,
      cacheTTL: 1000,
    });

    this.registerTool({
      name: 'tools/list-detailed',
      description: 'List all registered tools with details',
      inputSchema: {
        type: 'object',
        properties: {
          category: { type: 'string', description: 'Filter by category' },
        },
      },
      handler: async (input: unknown) => {
        const params = input as { category?: string };
        if (params.category) {
          return this.toolRegistry.getByCategory(params.category);
        }
        return this.toolRegistry.listTools();
      },
      category: 'system',
    });

    this.logger.info('Built-in tools registered', {
      count: 4,
    });
  }

  // P2-1: Populate the Resources registry with system-level resources.
  // The registry scaffolding always shipped empty — these adapter registrations
  // surface monomind's state to MCP clients as app-driven context.
  protected registerBuiltInResources(): void {
    this.resourceRegistry.registerResource(
      {
        uri: 'monomind://system/status',
        name: 'System Status',
        description: 'Current monomind MCP server health, uptime, and tool count',
        mimeType: 'application/json',
      },
      async (uri: string) => [
        {
          uri,
          mimeType: 'application/json',
          text: JSON.stringify(
            {
              status: 'running',
              uptime: this.startTime ? Date.now() - this.startTime.getTime() : 0,
              tools: this.toolRegistry.listTools().length,
              version: this.serverInfo.version,
            },
            null,
            2,
          ),
        },
      ],
    );

    this.resourceRegistry.registerResource(
      {
        uri: 'monomind://system/metrics',
        name: 'Server Metrics',
        description: 'Request count, cache hit rate, error rate',
        mimeType: 'application/json',
      },
      async (uri: string) => [
        {
          uri,
          mimeType: 'application/json',
          text: JSON.stringify(this.getMetrics(), null, 2),
        },
      ],
    );

    this.resourceRegistry.registerResource(
      {
        uri: 'monomind://system/tools',
        name: 'Tool Inventory',
        description: 'Complete list of registered MCP tools with categories',
        mimeType: 'application/json',
      },
      async (uri: string) => [
        {
          uri,
          mimeType: 'application/json',
          text: JSON.stringify(this.toolRegistry.listTools(), null, 2),
        },
      ],
    );

    this.logger.info('Built-in resources registered', { count: 3 });
  }

  // P2-2: Populate the Prompts registry with curated workflow templates.
  // These give MCP clients pre-built prompt structures for common dev tasks.
  protected registerBuiltInPrompts(): void {
    this.promptRegistry.register({
      name: 'monomind:research-plan',
      description: 'Generate a structured research plan for a topic',
      arguments: [{ name: 'topic', description: 'The research topic', required: true }],
      handler: async (args: Record<string, string>) => [
        {
          role: 'user' as const,
          content: {
            type: 'text' as const,
            text: `Research plan for: ${args.topic ?? '(unspecified)'}\n\n1. Define scope and key questions\n2. Identify sources and prior work\n3. Outline methodology\n4. Execute research (parallel agents if appropriate)\n5. Synthesize findings\n6. Review and refine`,
          },
        },
      ],
    });

    this.promptRegistry.register({
      name: 'monomind:pr-review',
      description: 'Structured pull-request review checklist',
      arguments: [{ name: 'changes', description: 'Description of the changes', required: true }],
      handler: async (args: Record<string, string>) => [
        {
          role: 'user' as const,
          content: {
            type: 'text' as const,
            text: `PR Review checklist for: ${args.changes ?? '(unspecified)'}\n\n- [ ] Correctness: does the code do what it claims?\n- [ ] Tests: are there tests covering the changes?\n- [ ] Security: any input validation gaps?\n- [ ] Performance: any O(n²) or unnecessary allocations?\n- [ ] Docs: are relevant docs updated?\n- [ ] Breaking changes: any removed APIs or changed behavior?\n- [ ] Honesty: any fabricated metrics or misleading output?`,
          },
        },
      ],
    });

    this.promptRegistry.register({
      name: 'monomind:debug-protocol',
      description: 'Systematic root-cause debugging protocol (4-phase)',
      arguments: [
        {
          name: 'symptom',
          description: 'Description of the bug or unexpected behavior',
          required: true,
        },
      ],
      handler: async (args: Record<string, string>) => [
        {
          role: 'user' as const,
          content: {
            type: 'text' as const,
            text: `Debug protocol for: ${args.symptom ?? '(unspecified)'}\n\nPhase 1 — REPRODUCE: Write a test that triggers the bug. Verify it fails.\nPhase 2 — ISOLATE: Binary-search the cause. What's the smallest change that triggers it?\nPhase 3 — FIX: Make the test pass with the minimal code change.\nPhase 4 — VERIFY: Run the full test suite. Confirm no regressions.`,
          },
        },
      ],
    });

    this.logger.info('Built-in prompts registered', { count: 3 });
  }
}
