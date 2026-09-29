// packages/@monomind/cli/src/orgrt/codex-runner-tools.ts
/**
 * Coder mode on every runtime (rev 19, contract §4): codex's own tool items
 * → matched `tool_use`/`tool_result` start/end pairs with canonical inputs,
 * so ToolActivityTracker (tool-activity.ts) emits `full`-fidelity
 * `tool_activity` for codex the same way it does for claude.
 *
 * Wire shapes — live-captured 2026-09-29 from codex-cli 0.156.1
 * (`codex exec --json`, a shell command plus two apply_patch edits):
 *
 *   {"type":"item.started","item":{"id":"item_1","type":"command_execution",
 *    "command":"/usr/bin/bash -lc 'echo probe'","aggregated_output":"",
 *    "exit_code":null,"status":"in_progress"}}
 *   {"type":"item.completed","item":{... same id ...,"aggregated_output":"probe\n",
 *    "exit_code":0,"status":"completed"}}
 *   {"type":"item.started","item":{"id":"item_2","type":"file_change",
 *    "changes":[{"path":"/abs/note.txt","kind":"add"}],"status":"in_progress"}}
 *   {"type":"item.completed","item":{... same id ...,"status":"completed"}}
 *
 * `mcp_tool_call` ({server, tool, arguments, result?, error?, status}),
 * `web_search` ({query}) and `todo_list` ({items:[{text, completed}]}) follow
 * codex's documented `codex exec --json` item schema (docs/exec.md,
 * exec/src/exec_events.rs) — not observed live here. `reasoning`,
 * `agent_message` and `error` items are not tool calls and are skipped; any
 * other item type is passed through as kind `other` with its raw fields.
 *
 * codex numbers items per `exec` process (`item_0`, `item_1`, … restart on
 * every spawn, resumed turns included), so ids are prefixed per spawn to
 * stay unique across tool rounds and mailbox prompts.
 */

import type { CodexItem, CodexStreamEvent } from './codex-runner-types.js';

type ToolKind = NonNullable<CodexStreamEvent['toolKind']>;

/** Item types that are not tool calls. */
const NON_TOOL_ITEMS = new Set(['agent_message', 'reasoning', 'error', 'user_message']);

const FIELD_KEYS_SKIPPED = new Set(['id', 'type', 'status']);

function patchAction(kind: unknown): 'add' | 'update' | 'delete' {
  return kind === 'add' || kind === 'delete' ? kind : 'update';
}

/** Canonical kind + input for one tool item (contract §4). */
function describe(item: CodexItem): {
  kind: ToolKind;
  input: Record<string, unknown>;
  label: string;
} {
  switch (item.type) {
    case 'command_execution': {
      const command = item.command ?? '';
      return { kind: 'shell', input: { command }, label: command || 'shell' };
    }
    case 'file_change': {
      const files = (item.changes ?? []).map((c) => ({
        file_path: c.path,
        action: patchAction(c.kind),
        ...(typeof c.diff === 'string' ? { diff: c.diff } : {}),
      }));
      const label = files.map((f) => `${f.action} ${f.file_path}`).join(', ');
      return { kind: 'patch', input: { files }, label: label || 'apply_patch' };
    }
    case 'mcp_tool_call': {
      const server = item.server ?? '';
      const tool = item.tool ?? '';
      return {
        kind: 'mcp',
        input: { server, tool, arguments: item.arguments ?? {} },
        label: `${server}.${tool}`,
      };
    }
    case 'web_search':
      return {
        kind: 'web',
        input: { query: item.query ?? '' },
        label: `web search: ${item.query ?? ''}`,
      };
    case 'todo_list':
      return { kind: 'todo', input: { items: item.items ?? [] }, label: 'todo list' };
    default: {
      const input: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(item)) if (!FIELD_KEYS_SKIPPED.has(k)) input[k] = v;
      return { kind: 'other', input, label: item.type };
    }
  }
}

/** The end-of-call body the tracker reports as `output`. */
function outputOf(item: CodexItem): string {
  switch (item.type) {
    case 'command_execution':
      return item.aggregated_output ?? '';
    case 'file_change':
      return (item.changes ?? []).map((c) => `${patchAction(c.kind)} ${c.path}`).join('\n');
    case 'mcp_tool_call': {
      if (item.error?.message) return item.error.message;
      const content = item.result?.content;
      if (Array.isArray(content)) {
        return content
          .map((b) => (typeof b?.text === 'string' ? b.text : JSON.stringify(b)))
          .join('\n');
      }
      return item.result === undefined ? '' : JSON.stringify(item.result);
    }
    case 'todo_list':
      return (item.items ?? []).map((t) => `[${t.completed ? 'x' : ' '}] ${t.text}`).join('\n');
    default:
      return '';
  }
}

function failed(item: CodexItem): boolean {
  if (item.status === 'failed' || item.status === 'declined') return true;
  if (item.type === 'command_execution') {
    return typeof item.exit_code === 'number' && item.exit_code !== 0;
  }
  return item.type === 'mcp_tool_call' && !!item.error;
}

/**
 * Per-spawn tracker: turns `item.started`/`item.completed` tool items into
 * `tool_start`/`tool_end` stream events. A completed item that never
 * started (codex reports some items only on completion) gets its start
 * synthesized first, so every end has a start. `flush()` closes whatever is
 * still open when the process exits.
 */
export class CodexToolItems {
  private open = new Map<string, { tool: string; startedAt: number }>();

  constructor(private idPrefix: string) {}

  private start(item: CodexItem, threadId: string | undefined): CodexStreamEvent {
    const id = `${this.idPrefix}${item.id}`;
    const { kind, input, label } = describe(item);
    this.open.set(id, { tool: item.type, startedAt: Date.now() });
    return {
      kind: 'tool_start',
      toolUseId: id,
      tool: item.type,
      toolKind: kind,
      input,
      toolName: label.slice(0, 200),
      threadId,
    };
  }

  onItem(
    phase: 'started' | 'completed',
    item: CodexItem | undefined,
    threadId: string | undefined,
  ): CodexStreamEvent[] {
    if (!item?.id || !item.type || NON_TOOL_ITEMS.has(item.type)) return [];
    const id = `${this.idPrefix}${item.id}`;
    if (phase === 'started') return this.open.has(id) ? [] : [this.start(item, threadId)];
    const out: CodexStreamEvent[] = this.open.has(id) ? [] : [this.start(item, threadId)];
    const started = this.open.get(id);
    this.open.delete(id);
    out.push({
      kind: 'tool_end',
      toolUseId: id,
      tool: item.type,
      output: outputOf(item),
      isError: failed(item),
      ...(item.type === 'command_execution' && typeof item.exit_code === 'number'
        ? { exitCode: item.exit_code }
        : {}),
      ...(started ? { durationMs: Date.now() - started.startedAt } : {}),
      threadId,
    });
    return out;
  }

  /** Ends for every call still open when the codex process exited. */
  flush(threadId: string | undefined): CodexStreamEvent[] {
    const out: CodexStreamEvent[] = [];
    for (const [id, { tool, startedAt }] of this.open) {
      out.push({
        kind: 'tool_end',
        toolUseId: id,
        tool,
        output: 'codex exited before this tool call completed',
        isError: true,
        durationMs: Date.now() - startedAt,
        threadId,
      });
    }
    this.open.clear();
    return out;
  }
}

/** ADR-O001 D8 level → codex's `model_reasoning_effort`. codex accepts
 *  none|minimal|low|medium|high|xhigh|max (the API's own 400 lists them,
 *  verified with codex-cli 0.156.1); monomind's `off` is codex's `none`. */
export function codexEffortArgs(effort: string | undefined): string[] {
  if (!effort) return [];
  const level = effort === 'off' ? 'none' : effort;
  return ['-c', `model_reasoning_effort=${level}`];
}
