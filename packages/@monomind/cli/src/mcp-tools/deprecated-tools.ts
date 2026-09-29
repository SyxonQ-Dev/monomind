/**
 * Marks a family of MCP tools deprecated (#418): the description starts with
 * a `DEPRECATED:` note and every result carries a `deprecated` field. The
 * tools keep working until their removal release.
 */

import type { MCPTool, MCPToolResult } from './types.js';

function isContentResult(value: unknown): value is MCPToolResult {
  return (
    typeof value === 'object' &&
    value !== null &&
    Array.isArray((value as { content?: unknown }).content)
  );
}

/** Adds `deprecated: notice` to a tool result, whichever shape it has. */
export function withDeprecatedField(result: unknown, notice: string): unknown {
  if (isContentResult(result)) {
    const [first, ...rest] = result.content;
    if (first?.type === 'text' && typeof first.text === 'string') {
      try {
        const parsed: unknown = JSON.parse(first.text);
        if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
          const text = JSON.stringify({ ...parsed, deprecated: notice }, null, 2);
          return { ...result, content: [{ ...first, text }, ...rest] };
        }
      } catch {
        // Not JSON — fall through and append the note as its own text item.
      }
    }
    return { ...result, content: [...result.content, { type: 'text', text: notice }] };
  }
  if (typeof result === 'object' && result !== null && !Array.isArray(result)) {
    return { ...result, deprecated: notice };
  }
  return result;
}

export function deprecateTools(tools: MCPTool[], notice: string): MCPTool[] {
  return tools.map((tool) => ({
    ...tool,
    description: `DEPRECATED: ${tool.description} ${notice}`,
    handler: async (input, context) =>
      withDeprecatedField(await tool.handler(input, context), notice),
  }));
}
