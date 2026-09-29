// packages/@monomind/cli/src/orgrt/opencode-runner-tools.ts
/**
 * opencode native tool calls → matched `tool_use`/`tool_result`
 * AgentMessages (coder mode on every runtime, plan MM3; contract §4).
 *
 * opencode reports every native tool call as a `type:"tool"` message part
 * on the SSE stream (`message.part.updated`), re-sent as its `state`
 * advances `pending → running → completed | error` (ToolPart/ToolState in
 * @opencode-ai/sdk's types.gen.d.ts). `callID` is stable across those
 * updates, so it is the id both halves carry — ToolActivityTracker
 * (tool-activity.ts) pairs start and end by it, which is what makes this
 * runtime's fidelity "full".
 *
 *  - `pending` is skipped: its `input` is still being streamed (`raw`).
 *  - `running` yields the start, with the input translated to the
 *    contract's canonical keys and a `kind`.
 *  - `completed`/`error` yields the end (plus the start first, when the
 *    call finished before a `running` update was ever seen).
 *
 * The original tool name stays in `tool`; `kind` and the canonical `input`
 * are what a caller renders from.
 */

import type { AgentMessage } from './agent-runner.js';
import type { ToolKind } from './tool-kind.js';

type Input = Record<string, unknown>;

const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);

/** Drop undefined values so optional canonical keys are absent, not null. */
function compact(o: Input): Input {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));
}

/** opencode's MCP tool id: `sanitize(server) + "_" + sanitize(tool)`
 *  (the same replace opencode applies, verified in the 1.18 binary). */
const sanitize = (s: string) => s.replace(/[^a-zA-Z0-9_-]/g, '_');

/**
 * `apply_patch`'s `patchText` (`*** Begin Patch` … `*** End Patch`) →
 * contract `patch` files. Each `*** Add/Update/Delete File: <path>` header
 * starts a file; the lines up to the next header are its diff.
 */
export function parsePatchText(text: string): Array<{
  file_path: string;
  action: 'add' | 'update' | 'delete';
  diff?: string;
}> {
  const files: Array<{
    file_path: string;
    action: 'add' | 'update' | 'delete';
    lines: string[];
  }> = [];
  for (const line of text.split('\n')) {
    const m = line.match(/^\*\*\* (Add|Update|Delete) File: (.+)$/);
    if (m) {
      const action = m[1].toLowerCase() as 'add' | 'update' | 'delete';
      files.push({ file_path: m[2].trim(), action, lines: [] });
      continue;
    }
    if (/^\*\*\* (Begin|End) Patch/.test(line)) continue;
    files[files.length - 1]?.lines.push(line);
  }
  return files.map(({ file_path, action, lines }) => {
    const diff = lines.join('\n').trim();
    return diff ? { file_path, action, diff } : { file_path, action };
  });
}

/**
 * One opencode tool call → contract kind + canonical input. `mcpServers`
 * are the served instance's MCP server names (`client.mcp.status()`); an
 * unknown tool whose id starts with one of them (sanitized, then `_`) is
 * that server's tool. Anything else keeps its raw input as `other`.
 */
export function canonicalOpencodeTool(
  tool: string,
  input: Input,
  mcpServers: readonly string[] = [],
): { kind: ToolKind; input: Input } {
  const filePath = str(input.filePath) ?? str(input.file_path) ?? str(input.path);
  switch (tool) {
    case 'bash':
      return {
        kind: 'shell',
        input: compact({
          command: str(input.command) ?? '',
          description: str(input.description),
          cwd: str(input.workdir),
        }),
      };
    case 'edit':
      return {
        kind: 'edit',
        input: {
          file_path: filePath ?? '',
          old_string: str(input.oldString) ?? '',
          new_string: str(input.newString) ?? '',
        },
      };
    case 'write':
      return {
        kind: 'write',
        input: { file_path: filePath ?? '', content: str(input.content) ?? '' },
      };
    case 'read':
      return { kind: 'read', input: { file_path: filePath ?? '' } };
    case 'grep':
    case 'glob':
      return {
        kind: 'search',
        input: compact({
          pattern: str(input.pattern) ?? '',
          path: str(input.path),
        }),
      };
    case 'list':
      return {
        kind: 'search',
        input: compact({ pattern: '*', path: str(input.path) }),
      };
    case 'webfetch':
      return { kind: 'web', input: compact({ url: str(input.url) }) };
    case 'websearch':
    case 'codesearch':
      return { kind: 'web', input: compact({ query: str(input.query) }) };
    case 'apply_patch':
    case 'patch':
      return {
        kind: 'patch',
        input: { files: parsePatchText(str(input.patchText) ?? '') },
      };
    case 'task':
      return { kind: 'task', input };
    case 'todowrite':
    case 'todoread':
      return { kind: 'todo', input };
  }
  // Longest server name first so `a_b` wins over `a` for tool `a_b_x`.
  for (const server of [...mcpServers].sort((a, b) => b.length - a.length)) {
    const prefix = `${sanitize(server)}_`;
    if (tool.startsWith(prefix) && tool.length > prefix.length) {
      return {
        kind: 'mcp',
        input: { server, tool: tool.slice(prefix.length), arguments: input },
      };
    }
  }
  return { kind: 'other', input };
}

/**
 * Turns the stream of `type:"tool"` part updates into at most one start and
 * one end per call. Stateful per runner run (a call's updates may span
 * rounds only in theory; ids are unique per session either way).
 */
export class OpencodeToolParts {
  private started = new Set<string>();
  private ended = new Set<string>();
  mcpServers: string[] = [];

  constructor(private sessionId: string) {}

  /** `part` is a `message.part.updated` part with `type === "tool"`. */
  onPart(part: any): AgentMessage[] {
    const id = str(part?.callID) ?? str(part?.id);
    const tool = str(part?.tool);
    const state = part?.state;
    if (!id || !tool || !state || this.ended.has(id)) return [];
    const status = state.status;
    if (status !== 'running' && status !== 'completed' && status !== 'error') return [];

    const out: AgentMessage[] = [];
    if (!this.started.has(id)) {
      this.started.add(id);
      const { kind, input } = canonicalOpencodeTool(tool, state.input ?? {}, this.mcpServers);
      out.push({
        type: 'tool_use',
        session_id: this.sessionId,
        tool_use_id: id,
        tool,
        kind,
        input,
        parent_tool_use_id: null,
      });
    }
    if (status === 'running') return out;

    this.ended.add(id);
    const start = state.time?.start;
    const end = state.time?.end;
    const exit = state.metadata?.exit;
    out.push({
      type: 'tool_result',
      session_id: this.sessionId,
      tool_use_id: id,
      tool,
      is_error: status === 'error',
      text: status === 'error' ? String(state.error ?? '') : String(state.output ?? ''),
      ...(typeof start === 'number' && typeof end === 'number' ? { duration_ms: end - start } : {}),
      ...(tool === 'bash' && typeof exit === 'number' ? { exit_code: exit } : {}),
    });
    return out;
  }
}
