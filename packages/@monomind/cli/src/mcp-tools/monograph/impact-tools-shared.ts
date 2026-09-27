import type { MonographNode } from '@monoes/monograph';
import type { MCPToolResult } from '../types.js';

/**
 * Human-readable text plus the machine-readable result it was rendered from.
 *
 * The adapters below used to `as any`-cast library results and read fields
 * that did not exist on them (`rn.occurrences`, `rn.references`), so a valid
 * result rendered as "Occurrences: 0". Typing the boundary against the real
 * library types turns that class of drift into a compile error; emitting the
 * structured payload alongside the prose means callers never have to re-parse
 * the prose to recover counts, locations, risk level, or error state.
 */
export function textWithData(readable: string, data: unknown, isError = false): MCPToolResult {
  return {
    content: [
      { type: 'text', text: readable },
      { type: 'text', text: JSON.stringify(data, null, 2) },
    ],
    ...(isError ? { isError: true } : {}),
  };
}

/** Location suffix for a graph node: `file:line`, `file`, or empty. */
export function nodeLocation(node: Pick<MonographNode, 'filePath' | 'startLine'>): string {
  if (!node.filePath) return '';
  return node.startLine != null ? `${node.filePath}:${node.startLine}` : node.filePath;
}
