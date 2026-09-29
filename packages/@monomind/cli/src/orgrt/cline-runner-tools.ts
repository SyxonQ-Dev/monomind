// packages/@monomind/cli/src/orgrt/cline-runner-tools.ts
/**
 * Cline's native tools → contract kind + canonical input (doc §3.2, rev 19).
 * Tool names and input shapes read from the cline 3.0.65 binary's own zod
 * schemas (2026-09-29):
 *   run_commands      {commands: [string | {command, args?}]} (also a bare
 *                     string / array / {command} / {cmd})
 *   editor            {path, old_text?, new_text, insert_line?} — replaces
 *                     old_text, creates the file when old_text is absent, or
 *                     inserts at insert_line
 *   apply_patch       {input: "*** Begin Patch ..."} or a bare string
 *   read_files        {files: [{path, start_line?, end_line?}]} (also
 *                     file_paths / paths / bare strings)
 *   search_codebase   {queries: string[] | string} (regex patterns)
 *   fetch_web_content {requests: [{url, prompt}]}
 *   spawn_agent {task}, team_* → task; skills, ask_question,
 *   submit_and_exit, switch_to_act_mode → other; MCP tools mcp__<srv>__<tool>.
 * tool-kind.ts's shared table does not list these names, so this module sets
 * `kind` itself (AgentMessage.kind wins over the name lookup).
 */

import type { AgentMessage } from './agent-runner.js';
import { isClineRefusal } from './cline-runner-scoped.js';
import { canonicalTool, type ToolKind } from './kimicode-runner-tools.js';

type Raw = Record<string, unknown>;

function asRecord(v: unknown): Raw {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Raw) : {};
}

function asList(v: unknown): unknown[] {
  if (v === undefined || v === null) return [];
  return Array.isArray(v) ? v : [v];
}

function commandText(c: unknown): string | undefined {
  if (typeof c === 'string') return c;
  const r = asRecord(c);
  if (typeof r.command !== 'string') return undefined;
  const argv = Array.isArray(r.args) ? r.args.map(String) : [];
  return [r.command, ...argv.map((a) => (/[\s"]/u.test(a) ? JSON.stringify(a) : a))].join(' ');
}

function shellCommands(raw: unknown): string[] {
  const r = asRecord(raw);
  const list =
    typeof raw === 'string' || Array.isArray(raw)
      ? asList(raw)
      : 'commands' in r
        ? asList(r.commands)
        : 'command' in r && !('args' in r)
          ? [r.command]
          : 'cmd' in r
            ? [r.cmd]
            : [raw];
  return list.map(commandText).filter((c): c is string => typeof c === 'string');
}

function readPaths(raw: unknown): string[] {
  const r = asRecord(raw);
  const list =
    typeof raw === 'string' || Array.isArray(raw)
      ? asList(raw)
      : asList(
          r.files ?? r.file_paths ?? r.paths ?? (typeof r.path === 'string' ? raw : undefined),
        );
  return list
    .map((f) => (typeof f === 'string' ? f : (asRecord(f).path ?? asRecord(f).filePath)))
    .filter((p): p is string => typeof p === 'string');
}

function queries(raw: unknown): string[] {
  const r = asRecord(raw);
  const list = typeof raw === 'string' || Array.isArray(raw) ? asList(raw) : asList(r.queries);
  return list.filter((q): q is string => typeof q === 'string');
}

/** Contract kind + canonical input for one cline tool call. */
export function clineCanonicalTool(
  name: string,
  rawInput: unknown,
): { kind: ToolKind; input: Record<string, unknown> } {
  const raw = asRecord(rawInput);
  const other = { kind: 'other' as const, input: raw };
  switch (name) {
    case 'run_commands': {
      const cmds = shellCommands(rawInput);
      return cmds.length > 0 ? { kind: 'shell', input: { command: cmds.join('\n') } } : other;
    }
    case 'editor': {
      const file_path = typeof raw.path === 'string' ? raw.path : undefined;
      if (file_path === undefined || typeof raw.new_text !== 'string') return other;
      if (raw.insert_line !== undefined && raw.insert_line !== null) {
        return { kind: 'patch', input: { files: [{ file_path, action: 'update' }] } };
      }
      if (typeof raw.old_text === 'string' && raw.old_text !== '') {
        return {
          kind: 'edit',
          input: { file_path, old_string: raw.old_text, new_string: raw.new_text },
        };
      }
      return { kind: 'write', input: { file_path, content: raw.new_text } };
    }
    case 'apply_patch': {
      const text = typeof rawInput === 'string' ? rawInput : raw.input;
      const c = canonicalTool('apply_patch', { input: text });
      return c.kind === 'patch' ? c : other;
    }
    case 'read_files': {
      const paths = readPaths(rawInput);
      if (paths.length === 0) return other;
      return {
        kind: 'read',
        input:
          paths.length === 1 ? { file_path: paths[0] } : { file_path: paths[0], file_paths: paths },
      };
    }
    case 'search_codebase': {
      const qs = queries(rawInput);
      if (qs.length === 0) return other;
      return {
        kind: 'search',
        input: { pattern: qs.length === 1 ? qs[0] : qs.map((q) => `(?:${q})`).join('|') },
      };
    }
    case 'fetch_web_content': {
      const urls = asList(raw.requests)
        .map((q) => asRecord(q).url)
        .filter((u): u is string => typeof u === 'string');
      if (urls.length === 0) return other;
      return { kind: 'web', input: urls.length === 1 ? { url: urls[0] } : { url: urls[0], urls } };
    }
    case 'spawn_agent':
      return { kind: 'task', input: raw };
    case 'skills':
    case 'ask_question':
    case 'submit_and_exit':
    case 'switch_to_act_mode':
      return other;
    default:
      if (name.startsWith('team_')) return { kind: 'task', input: raw };
      return canonicalTool(name, rawInput);
  }
}

/** ACP `tool_call` has no tool name — only ACP's own kind and rawInput. The
 *  cline name it came from, so both protocols share one mapping. */
export function acpToolName(acpKind: unknown, rawInput: unknown, title: unknown): string {
  const raw = asRecord(rawInput);
  switch (acpKind) {
    case 'execute':
      return 'run_commands';
    case 'edit':
      return typeof raw.input === 'string' || typeof rawInput === 'string'
        ? 'apply_patch'
        : 'editor';
    case 'read':
      return 'read_files';
    case 'search':
      return 'search_codebase';
    case 'fetch':
      return 'fetch_web_content';
    default:
      return typeof title === 'string' && title ? title : 'unknown_tool';
  }
}

/** Text of a cline tool output: a string, a ToolOperationResult or an array
 *  of them ({query, result, success, error}), or any other JSON value. */
export function clineOutputText(out: unknown): string {
  if (typeof out === 'string') return out;
  if (Array.isArray(out)) {
    return out
      .map((o) => {
        if (typeof o === 'string') return o;
        const r = asRecord(o);
        const body = r.error ?? r.result ?? r.text;
        return typeof body === 'string' ? body : JSON.stringify(body ?? o);
      })
      .join('\n');
  }
  if (out === undefined || out === null) return '';
  const r = asRecord(out);
  const body = r.error ?? r.result;
  return typeof body === 'string' ? body : JSON.stringify(out);
}

function outputFailed(out: unknown): boolean {
  if (Array.isArray(out)) return out.some((o) => asRecord(o).success === false);
  return asRecord(out).success === false;
}

/** Pairs cline's tool starts and ends (by toolCallId) into the rich
 *  tool_use/tool_result AgentMessages ToolActivityTracker turns into
 *  matched tool_activity events. */
export class ClineToolCalls {
  private open = new Map<string, { name: string; startedAt: number }>();
  /** Ended ids: a second end (ACP reports a refused call failed twice) or a
   *  late start for one is dropped, not turned into a phantom call. */
  private closed = new Set<string>();
  /** Whether the latest ended call was refused (never run). */
  lastDenied = false;

  start(id: string, name: string, rawInput: unknown, sessionId?: string): AgentMessage | null {
    if (this.open.has(id) || this.closed.has(id)) return null;
    this.open.set(id, { name, startedAt: Date.now() });
    const { kind, input } = clineCanonicalTool(name, rawInput);
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

  /** End message(s); an end whose start never arrived gets one synthesized.
   *  A refused call (`denied`, or a refusal error — cline-runner-scoped.ts)
   *  ends with `denied: true`. */
  end(
    id: string,
    name: string | undefined,
    output: unknown,
    error: string | undefined,
    sessionId?: string,
    denied?: boolean,
  ): AgentMessage[] {
    const out: AgentMessage[] = [];
    if (this.closed.has(id)) return out;
    if (!this.open.has(id)) {
      const s = this.start(id, name ?? 'unknown_tool', {}, sessionId);
      if (s) out.push(s);
    }
    const call = this.open.get(id);
    if (!call) return out;
    this.open.delete(id);
    this.closed.add(id);
    const text = error ?? clineOutputText(output);
    const refused = denied === true || isClineRefusal(text);
    this.lastDenied = refused;
    out.push({
      type: 'tool_result',
      session_id: sessionId,
      tool_use_id: id,
      tool: call.name,
      is_error: refused || !!error || outputFailed(output),
      text,
      duration_ms: Date.now() - call.startedAt,
      ...(refused ? { denied: true } : {}),
    });
    return out;
  }
}
