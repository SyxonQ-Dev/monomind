// packages/@monomind/cli/src/orgrt/dsh-runner-parse.ts
/**
 * Pure helpers for DshAgentRunner (dsh-runner.ts): the `--json` event
 * vocabulary, dsh's native tool names → contract kind/canonical input, the
 * `--patch` YAML that selects model + effort, the version gate, and the
 * errors a failed invocation maps to. No I/O here, so every piece is
 * fixture-testable.
 *
 * Sources (all from the installed @deepseek-ai/dsh 0.1.7-rc.2 package, then
 * checked by running it — see dsh-runner.ts's header):
 *   - events: dsh-headless/lib/json-stream-*.js (`projectJsonRun`)
 *   - tool names/params: dsh-tool-{bash,pwsh,fs,fs-search,web,todo,
 *     str-replace-editor,subagent}; MCP tools are `mcp__<server>__<tool>`
 *     (dsh-mcp-client)
 *   - patch rows: dsh-base/cordis.patch.yml (`agent-default-model`,
 *     `sandbox-policy`), dsh-agent-default-model's Config
 *     (provider, model, reasoningEffort)
 *   - resume refusals: dsh-headless/lib/index.js (`assertAdoptable`)
 */

import type { AgentMessage } from './agent-runner.js';
import type { OrgEffortLevel } from './cost-tier.js';
import { canonicalTool, type ToolKind } from './kimicode-runner-tools.js';

// ── events ───────────────────────────────────────────────────────────────

export interface DshUsage {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  reasoningTokens?: number;
}

/** One `dsh --profile headless --json` line. */
export interface DshEvent {
  type:
    | 'session'
    | 'status'
    | 'thinking'
    | 'text'
    | 'tool_call'
    | 'tool_result'
    | 'final'
    | 'error';
  sessionId?: string;
  cwd?: string;
  phase?: 'turn_start' | 'step_start' | 'step_end' | 'turn_end' | (string & {});
  turn?: number;
  step?: number;
  usage?: DshUsage;
  reason?: { kind?: string; error?: { message?: string; code?: string } };
  text?: string;
  callId?: string;
  tool?: string;
  input?: unknown;
  status?: 'completed' | 'error';
  result?: string;
  message?: string;
  truncated?: boolean;
}

/** Parse one stdout line; null for anything that is not a dsh event. */
export function parseDshLine(line: string): DshEvent | null {
  const t = line.trim();
  if (!t.startsWith('{')) return null;
  try {
    const ev = JSON.parse(t) as DshEvent;
    return ev && typeof ev.type === 'string' ? ev : null;
  } catch {
    return null;
  }
}

// ── tools ────────────────────────────────────────────────────────────────

type Raw = Record<string, unknown>;

function rec(v: unknown): Raw {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Raw) : {};
}

const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);

/**
 * Contract kind + canonical input for one dsh tool call. dsh-specific
 * shapes are translated here; names it shares with other CLIs (edit, write,
 * read, glob, grep, web_fetch, todo_write, mcp__*) go through the shared
 * canonicalTool.
 */
export function dshCanonicalTool(
  name: string,
  rawInput: unknown,
): { kind: ToolKind; input: Record<string, unknown> } {
  const raw = rec(rawInput);
  switch (name) {
    case 'bash':
    case 'pwsh': {
      const command = str(raw.command);
      if (command === undefined) return { kind: 'other', input: raw };
      const input: Raw = { command };
      if (str(raw.description) !== undefined) input.description = raw.description;
      if (str(raw.workdir) !== undefined) input.cwd = raw.workdir;
      return { kind: 'shell', input };
    }
    case 'str_replace_editor': {
      // One tool, four commands (view|create|str_replace|insert).
      const file_path = str(raw.path);
      if (file_path === undefined) return { kind: 'other', input: raw };
      if (raw.command === 'view') return { kind: 'read', input: { file_path } };
      if (raw.command === 'create') {
        const content = str(raw.file_text);
        return {
          kind: 'write',
          input: content === undefined ? { file_path } : { file_path, content },
        };
      }
      if (raw.command === 'str_replace' && str(raw.old_str) !== undefined) {
        return {
          kind: 'edit',
          input: { file_path, old_string: raw.old_str, new_string: str(raw.new_str) ?? '' },
        };
      }
      return { kind: 'patch', input: { files: [{ file_path, action: 'update' }] } };
    }
    case 'web_search': {
      const queries = Array.isArray(raw.queries)
        ? raw.queries.filter((q): q is string => typeof q === 'string')
        : [];
      return queries.length > 0
        ? { kind: 'web', input: { query: queries.join('\n') } }
        : { kind: 'other', input: raw };
    }
    case 'subagent':
    case 'subagent_fork':
      return { kind: 'task', input: raw };
    default:
      return canonicalTool(name, rawInput);
  }
}

// Markers dsh-tool-bash's renderResult/renderPromoted append to a result.
const EXIT_MARKER_RE = /\[exit code: (-?\d+)\]\s*$/;
const NOT_EXITED_RE =
  /\[(killed by signal|timed out after|stopped:|still running after)|^started background job /m;

/** A shell call's exit code, read off dsh's result text: `[exit code: N]`
 *  when non-zero, no marker at all when 0. Undefined when the command did not
 *  exit on its own (signal, timeout, moved to a background job), the call
 *  errored, or the result was truncated (the marker sits at the end). */
export function dshShellExitCode(ev: DshEvent): number | undefined {
  if (ev.status !== 'completed' || ev.truncated || typeof ev.result !== 'string') return undefined;
  const m = EXIT_MARKER_RE.exec(ev.result);
  if (m) return Number(m[1]);
  return NOT_EXITED_RE.test(ev.result) ? undefined : 0;
}

/** Pairs dsh's `tool_call`/`tool_result` by callId into the rich
 *  tool_use/tool_result AgentMessages ToolActivityTracker matches. */
export class DshToolCalls {
  private open = new Map<string, { name: string; kind: ToolKind; startedAt: number }>();

  start(ev: DshEvent, sessionId?: string): AgentMessage | null {
    const id = ev.callId;
    const name = ev.tool ?? '';
    if (!id || this.open.has(id)) return null;
    const { kind, input } = dshCanonicalTool(name, ev.input);
    this.open.set(id, { name, kind, startedAt: Date.now() });
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

  end(ev: DshEvent, sessionId?: string): AgentMessage | null {
    const id = ev.callId;
    const call = id ? this.open.get(id) : undefined;
    if (!id || !call) return null;
    this.open.delete(id);
    const exitCode = call.kind === 'shell' ? dshShellExitCode(ev) : undefined;
    return {
      type: 'tool_result',
      session_id: sessionId,
      tool_use_id: id,
      tool: call.name,
      is_error: ev.status === 'error',
      text: ev.result ?? '',
      duration_ms: Date.now() - call.startedAt,
      ...(exitCode !== undefined ? { exit_code: exitCode } : {}),
    };
  }

  /** Calls still open when the process ended: a failed end each, so every
   *  start has an end (an aborted turn is closed by the caller instead). */
  flush(sessionId?: string): AgentMessage[] {
    const out: AgentMessage[] = [];
    for (const id of [...this.open.keys()]) {
      const m = this.end(
        {
          type: 'tool_result',
          callId: id,
          status: 'error',
          result: 'dsh exited before the call finished',
        },
        sessionId,
      );
      if (m) out.push(m);
    }
    return out;
  }
}

// ── model + effort patch ─────────────────────────────────────────────────

/** dsh's shipped default route (dsh-base `agent-default-model`). */
export const DSH_DEFAULT_SELECTION = { provider: 'deepseek-official', model: 'deepseek-flash' };

/** DeepSeek's own efforts are off|low|high|max (dsh-llm-deepseek); `medium`
 *  maps to dsh's default `high`, `xhigh` to `max`. Other providers (the
 *  llm-pi-ai section) take every monomind level verbatim. */
const DEEPSEEK_EFFORT: Record<OrgEffortLevel, string> = {
  off: 'off',
  low: 'low',
  medium: 'high',
  high: 'high',
  xhigh: 'max',
  max: 'max',
};

export function dshEffort(provider: string, effort: OrgEffortLevel): string {
  return provider.startsWith('deepseek-') ? DEEPSEEK_EFFORT[effort] : effort;
}

export interface DshSelection {
  provider: string;
  model: string;
  reasoningEffort?: string;
}

/**
 * The `agent-default-model` row as a `--patch` overlay. A patch REPLACES a
 * row's whole `config` (checked with `--dump-config`), so provider and model
 * are always written. Values are JSON-quoted, which YAML reads as plain
 * double-quoted scalars.
 */
export function dshModelPatchYaml(sel: DshSelection): string {
  const q = (s: string) => JSON.stringify(s);
  return [
    '# generated by monomind agent exec (dsh runner): model + effort for this run',
    '- id: agent-default-model',
    '  config:',
    `    provider: ${q(sel.provider)}`,
    `    model: ${q(sel.model)}`,
    ...(sel.reasoningEffort ? [`    reasoningEffort: ${q(sel.reasoningEffort)}`] : []),
    '',
  ].join('\n');
}

/** The `agent-default-model` row out of `dsh --dump-config` output. Only
 *  plain or quoted scalars count; a `!!js` expression is not a value. */
export function parseDumpedSelection(dump: string): Partial<DshSelection> {
  const lines = dump.split('\n');
  const start = lines.findIndex((l) => /^- id: ['"]?agent-default-model['"]?\s*$/.test(l));
  if (start < 0) return {};
  const out: Partial<DshSelection> = {};
  for (let i = start + 1; i < lines.length && !lines[i].startsWith('- '); i++) {
    const m = /^\s{4}(provider|model|reasoningEffort):\s*(.+?)\s*$/.exec(lines[i]);
    if (!m || m[2].startsWith('!!')) continue;
    out[m[1] as keyof DshSelection] = m[2].replace(/^(['"])(.*)\1$/, '$2');
  }
  return out;
}

// ── version gate ─────────────────────────────────────────────────────────

/** dsh is a developer preview with announced breaking changes: this runner
 *  was built against 0.1.7-rc.2 (and `next` 0.2.0-rc.1 keeps the headless
 *  contract), so it accepts 0.1.7 up to, not including, 0.3.0. */
export const DSH_SUPPORTED_RANGE = '>=0.1.7-0 <0.3.0';
export const DSH_INSTALL_HINT = 'npm i -g @deepseek-ai/dsh';

export function dshVersionSupported(output: string): { ok: boolean; version?: string } {
  const m = /(\d+)\.(\d+)\.(\d+)(-[0-9A-Za-z.-]+)?/.exec(output);
  if (!m) return { ok: false };
  const [maj, min, pat] = [Number(m[1]), Number(m[2]), Number(m[3])];
  // Base triple only: 0.1.7-rc.2 counts as 0.1.7 (what the preview ships).
  const ok = maj === 0 && ((min === 1 && pat >= 7) || min === 2);
  return { ok, version: m[0] };
}

// ── errors ───────────────────────────────────────────────────────────────

/**
 * The actionable message for a failed invocation, from the `error` event
 * (failures outside a turn — usage errors, `--session-id` refusals) or the
 * final `turn_end` reason. `fatal` marks errors a retry cannot fix.
 */
export function dshFailure(
  errorEvent: string | undefined,
  turnEnd: DshEvent['reason'] | undefined,
  resume: string | undefined,
): { message: string; fatal: boolean } | null {
  if (errorEvent) {
    const cwd = /was recorded in "(.*)", not "(.*)"$/.exec(errorEvent);
    if (cwd) {
      return {
        fatal: true,
        message:
          `dsh refuses to resume session ${resume ?? ''}: it was recorded in ${cwd[1]}, ` +
          `not ${cwd[2]}. Run it from ${cwd[1]}, or start a new session (no --resume).`,
      };
    }
    if (/is a subagent or forked session/.test(errorEvent)) {
      return {
        fatal: true,
        message: `dsh refuses to resume session ${resume ?? ''}: it is a subagent or forked session, which only its parent can drive. Resume the parent session instead.`,
      };
    }
    if (/does not exist; omit --session-id/.test(errorEvent)) {
      return {
        fatal: true,
        message: `dsh has no session ${resume ?? ''} under this DSH_HOME; start a new session (no --resume).`,
      };
    }
    if (/cannot be adopted|does not compose|is live in this process/.test(errorEvent)) {
      return { fatal: true, message: `dsh refuses to resume: ${errorEvent}` };
    }
    return { fatal: false, message: `dsh: ${errorEvent}` };
  }
  if (turnEnd && turnEnd.kind !== 'completed') {
    const code = turnEnd.error?.code;
    const msg = turnEnd.error?.message ?? turnEnd.kind ?? 'turn did not complete';
    if (code === 'MISSING_CREDENTIAL' || /api key/i.test(msg)) {
      return {
        fatal: true,
        message: `dsh: ${code ?? 'auth'}: ${msg} — export DEEPSEEK_API_KEY, or save a key on the Models page of \`dsh web\`.`,
      };
    }
    return {
      fatal: false,
      message: `dsh: turn ${turnEnd.kind ?? 'ended'}${code ? ` (${code})` : ''}: ${msg}`,
    };
  }
  return null;
}
