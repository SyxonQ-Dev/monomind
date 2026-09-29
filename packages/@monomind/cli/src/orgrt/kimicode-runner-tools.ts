// packages/@monomind/cli/src/orgrt/kimicode-runner-tools.ts
/**
 * Native tool events for the vendor CLI runners (coder mode on every
 * runtime, doc/agent-exec-protocol.md §3.2 + plan Contract §4).
 *
 * Shared by the subprocess runners the same way kimicode-runner.ts's
 * classifyStderr already is: each runner parses its own CLI's wire format and
 * hands the native tool name, id and raw arguments here. This module
 *   - maps the native name to the contract `kind`
 *     (shell|edit|write|read|search|web|mcp|task|todo|patch|other),
 *   - translates the native argument shape to that kind's canonical `input`
 *     keys (a shell call → {command}, an edit → {file_path, old_string,
 *     new_string}, ...), falling back to kind "other" with the raw input when
 *     a required key is missing rather than emitting a half-filled shape,
 *   - builds the rich 'tool_use'/'tool_result' AgentMessages
 *     ToolActivityTracker (tool-activity.ts) turns into matched
 *     tool_activity start/end events: `tool_use_id` + `tool` + `input` is the
 *     same shape ClaudeAgentRunner yields, so the tracker needs no per-runtime
 *     code. `text` stays the tool name, so the org runtime's StateDetector
 *     liveness is unchanged.
 *
 * The start message sets `AgentMessage.kind`, which tool-activity.ts prefers
 * over its own name table (tool-kind.ts) — this table knows the CLIs' own
 * names (agy's run_command, grok's search_replace, ...).
 */

import type { AgentMessage } from './agent-runner.js';
import type { ToolKind } from './tool-kind.js';

export type { ToolKind };

/** Native tool names of the CLIs this module serves (agy, kimi, grok, qwen,
 *  copilot, pi), lowercased. The names do not collide in meaning across
 *  CLIs, so one table serves all of them. */
const NAME_KIND: Record<string, ToolKind> = {
  // shell
  bash: 'shell',
  shell: 'shell',
  powershell: 'shell',
  run_command: 'shell',
  run_shell_command: 'shell',
  run_terminal_command: 'shell',
  exec: 'shell',
  // edit
  edit: 'edit',
  edit_file: 'edit',
  replace: 'edit',
  search_replace: 'edit',
  str_replace: 'edit',
  str_replace_editor: 'edit',
  replace_file_content: 'edit',
  multi_replace_file_content: 'edit',
  multiedit: 'edit',
  // write
  write: 'write',
  write_file: 'write',
  write_to_file: 'write',
  create: 'write',
  create_file: 'write',
  // read
  read: 'read',
  read_file: 'read',
  view: 'read',
  view_file: 'read',
  // search
  grep: 'search',
  grep_search: 'search',
  search_file_content: 'search',
  glob: 'search',
  find: 'search',
  find_by_name: 'search',
  rg: 'search',
  // web
  web_search: 'web',
  websearch: 'web',
  search_web: 'web',
  web_fetch: 'web',
  webfetch: 'web',
  fetch: 'web',
  fetchurl: 'web',
  read_url_content: 'web',
  // mcp
  call_mcp_tool: 'mcp',
  // task (subagents)
  task: 'task',
  agent: 'task',
  spawn_subagent: 'task',
  invoke_subagent: 'task',
  browser_subagent: 'task',
  // todo
  todo_write: 'todo',
  todowrite: 'todo',
  update_todo: 'todo',
  set_todo_list: 'todo',
  settodolist: 'todo',
  // patch
  apply_patch: 'patch',
};

const MCP_NAME_RE = /^mcp__(.+?)__(.+)$/;

/** Contract kind for a native tool name. */
export function toolKind(name: string): ToolKind {
  if (MCP_NAME_RE.test(name)) return 'mcp';
  return NAME_KIND[name.toLowerCase()] ?? 'other';
}

type Raw = Record<string, unknown>;

function asRecord(v: unknown): Raw {
  if (v && typeof v === 'object' && !Array.isArray(v)) return v as Raw;
  if (typeof v === 'string') {
    try {
      const parsed = JSON.parse(v);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Raw;
    } catch {
      /* not JSON — keep it as-is below */
    }
    return v ? { value: v } : {};
  }
  return {};
}

/** First string value among `keys` (native CLIs spell the same argument
 *  differently: file_path / path / TargetFile / AbsolutePath, ...). */
function pick(raw: Raw, keys: string[]): string | undefined {
  for (const k of keys) {
    const v = raw[k];
    if (typeof v === 'string') return v;
  }
  return undefined;
}

const FILE_KEYS = ['file_path', 'path', 'filePath', 'absolute_path', 'AbsolutePath', 'TargetFile'];
const OLD_KEYS = ['old_string', 'oldText', 'old_str', 'TargetContent'];
const NEW_KEYS = ['new_string', 'newText', 'new_str', 'ReplacementContent'];

function compact(o: Raw): Raw {
  const out: Raw = {};
  for (const [k, v] of Object.entries(o)) if (v !== undefined) out[k] = v;
  return out;
}

/** A list of {old,new} edits under whichever key the CLI uses (pi `edits`,
 *  agy `ReplacementChunks`), or undefined when the call is a single edit. */
function editList(raw: Raw): Raw[] | undefined {
  const list = raw.edits ?? raw.ReplacementChunks;
  return Array.isArray(list) ? list.map(asRecord) : undefined;
}

/**
 * Canonical kind + input for one native tool call (plan Contract §4). The
 * native name always stays on the message as `tool`; only `input` changes.
 */
export function canonicalTool(
  name: string,
  rawInput: unknown,
): { kind: ToolKind; input: Record<string, unknown> } {
  const raw = asRecord(rawInput);
  const kind = toolKind(name);
  const other = { kind: 'other' as const, input: raw };
  switch (kind) {
    case 'shell': {
      const command = pick(raw, ['command', 'CommandLine', 'cmd']);
      if (command === undefined) return other;
      return {
        kind,
        input: compact({
          command,
          description: pick(raw, ['description']),
          cwd: pick(raw, ['cwd', 'Cwd', 'directory', 'workdir']),
        }),
      };
    }
    case 'edit': {
      const file_path = pick(raw, FILE_KEYS);
      if (file_path === undefined) return other;
      const edits = editList(raw);
      if (edits && edits.length !== 1) {
        return { kind: 'patch', input: { files: [{ file_path, action: 'update' }] } };
      }
      const src = edits ? edits[0] : raw;
      const old_string = pick(src, OLD_KEYS);
      const new_string = pick(src, NEW_KEYS);
      if (old_string === undefined || new_string === undefined) {
        return { kind: 'patch', input: { files: [{ file_path, action: 'update' }] } };
      }
      return { kind, input: { file_path, old_string, new_string } };
    }
    case 'write': {
      const file_path = pick(raw, FILE_KEYS);
      if (file_path === undefined) return other;
      return {
        kind,
        input: compact({ file_path, content: pick(raw, ['content', 'CodeContent', 'file_text']) }),
      };
    }
    case 'read': {
      const file_path = pick(raw, FILE_KEYS);
      return file_path === undefined ? other : { kind, input: { file_path } };
    }
    case 'search': {
      const pattern = pick(raw, ['pattern', 'Pattern', 'query', 'Query', 'regex', 'glob']);
      if (pattern === undefined) return other;
      return {
        kind,
        input: compact({
          pattern,
          path: pick(raw, ['path', 'SearchPath', 'SearchDirectory', 'dir_path', 'directory']),
        }),
      };
    }
    case 'web': {
      const url = pick(raw, ['url', 'Url', 'URL']);
      const query = pick(raw, ['query', 'Query', 'q']);
      return url === undefined && query === undefined
        ? other
        : { kind, input: compact({ url, query }) };
    }
    case 'mcp': {
      const m = MCP_NAME_RE.exec(name);
      if (m) return { kind, input: { server: m[1], tool: m[2], arguments: raw } };
      const server = pick(raw, ['ServerName', 'server', 'server_name']);
      const tool = pick(raw, ['ToolName', 'tool', 'tool_name']);
      if (server === undefined || tool === undefined) return other;
      return {
        kind,
        input: { server, tool, arguments: asRecord(raw.Arguments ?? raw.arguments ?? {}) },
      };
    }
    case 'patch': {
      const text = pick(raw, ['value', 'input', 'patch']);
      const files = text === undefined ? [] : patchFiles(text);
      return files.length > 0 ? { kind, input: { files } } : other;
    }
    default:
      return { kind, input: raw };
  }
}

const PATCH_HEADER_RE = /^\*\*\* (Add|Update|Delete) File: (.+)$/;
const PATCH_ACTION = { Add: 'add', Update: 'update', Delete: 'delete' } as const;

/** Files of an `apply_patch` envelope (`*** Begin Patch` / `*** Add|Update|
 *  Delete File: <path>` sections — the format copilot's apply_patch takes,
 *  verified live), each with its own section as the diff. */
function patchFiles(
  text: string,
): Array<{ file_path: string; action: 'add' | 'update' | 'delete'; diff?: string }> {
  const files: Array<{ file_path: string; action: 'add' | 'update' | 'delete'; diff?: string }> =
    [];
  let body: string[] = [];
  const flush = () => {
    const last = files.at(-1);
    if (last && body.length > 0) last.diff = body.join('\n');
    body = [];
  };
  for (const line of text.split('\n')) {
    const m = PATCH_HEADER_RE.exec(line);
    if (m) {
      flush();
      files.push({
        file_path: m[2].trim(),
        action: PATCH_ACTION[m[1] as keyof typeof PATCH_ACTION],
      });
    } else if (line.startsWith('*** End Patch')) {
      break;
    } else if (files.length > 0) {
      body.push(line);
    }
  }
  flush();
  return files;
}

/** Text of a tool result in whatever shape the CLI reports it: a string, a
 *  content-block array ({type:'text', text}), or {content: ...}. */
export function toolOutputText(out: unknown): string {
  if (typeof out === 'string') return out;
  if (Array.isArray(out)) {
    return out
      .map((b) =>
        typeof b === 'string'
          ? b
          : b && typeof b === 'object' && typeof (b as Raw).text === 'string'
            ? ((b as Raw).text as string)
            : '',
      )
      .filter(Boolean)
      .join('\n');
  }
  if (out && typeof out === 'object') {
    const o = out as Raw;
    if ('content' in o) return toolOutputText(o.content);
    return JSON.stringify(out);
  }
  return out === undefined || out === null ? '' : String(out);
}

/**
 * Per-turn bookkeeping for one runner's native tool calls: builds the rich
 * start/end messages and pairs them by the CLI's own call id. An end whose
 * start was never seen (a CLI that reports a finished call in one event) gets
 * its start synthesized first, so the tracker never sees an orphan end.
 */
export class NativeToolCalls {
  private open = new Map<string, { name: string; startedAt: number }>();

  /** Start message for a newly seen call, or null for a repeated start. */
  start(id: string, name: string, rawInput: unknown, sessionId?: string): AgentMessage | null {
    if (this.open.has(id)) return null;
    this.open.set(id, { name, startedAt: Date.now() });
    const { kind, input } = canonicalTool(name, rawInput);
    return {
      type: 'tool_use',
      session_id: sessionId,
      text: name,
      tool_use_id: id,
      tool: name,
      input,
      parent_tool_use_id: null,
      kind,
    };
  }

  /** End message(s) for a call; `fallback` names a call whose start never
   *  arrived. Empty when the id is unknown and there is no fallback. */
  end(
    id: string,
    output: unknown,
    isError: boolean,
    sessionId?: string,
    fallback?: { name: string; rawInput: unknown },
  ): AgentMessage[] {
    const out: AgentMessage[] = [];
    if (!this.open.has(id)) {
      if (!fallback) return out;
      const s = this.start(id, fallback.name, fallback.rawInput, sessionId);
      if (s) out.push(s);
    }
    const call = this.open.get(id);
    if (!call) return out;
    this.open.delete(id);
    out.push({
      type: 'tool_result',
      session_id: sessionId,
      tool_use_id: id,
      tool: call.name,
      is_error: isError,
      text: toolOutputText(output),
      duration_ms: Date.now() - call.startedAt,
    });
    return out;
  }
}

/** Blocks of one Anthropic-Messages-shaped message (grok
 *  `streaming-messages-json`, qwen `stream-json`): the text, tool_use and
 *  tool_result blocks, each in the shape the runners need. */
export function messageBlocks(content: unknown): {
  text: string;
  toolUses: Array<{ id: string; name: string; input: unknown }>;
  toolResults: Array<{ id: string; output: unknown; isError: boolean }>;
} {
  const texts: string[] = [];
  const toolUses: Array<{ id: string; name: string; input: unknown }> = [];
  const toolResults: Array<{ id: string; output: unknown; isError: boolean }> = [];
  if (typeof content === 'string') texts.push(content);
  for (const b of Array.isArray(content) ? content : []) {
    if (!b || typeof b !== 'object') continue;
    const block = b as Raw;
    if (block.type === 'text' && typeof block.text === 'string') texts.push(block.text);
    else if (block.type === 'tool_use' && typeof block.id === 'string') {
      toolUses.push({ id: block.id, name: String(block.name ?? ''), input: block.input });
    } else if (block.type === 'tool_result' && typeof block.tool_use_id === 'string') {
      toolResults.push({
        id: block.tool_use_id,
        output: block.content,
        isError: block.is_error === true,
      });
    }
  }
  return { text: texts.join('\n'), toolUses, toolResults };
}
