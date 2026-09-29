// packages/@monomind/cli/src/orgrt/cline-runner-acp.ts
/**
 * A resumed cline turn over ACP (`cline --acp --auto-approve true`).
 *
 * Why ACP: `cline --id <session>` cannot be combined with `--json` (it forces
 * the interactive UI and drops the prompt), so the one headless way to add a
 * turn to an existing session is ACP `session/load` + `session/prompt`.
 * Verified live against cline 3.0.65 with an OpenRouter free model
 * (2026-09-29): the loaded session kept its earlier context.
 *
 * Wire (JSON-RPC 2.0, one object per line): initialize → session/load
 * {sessionId, cwd, mcpServers: []} → session/prompt. `session/load` REPLAYS
 * the stored conversation as `session/update` notifications before it
 * answers, so every update before the load response is ignored.
 *
 * Auth: ACP only restores stored credentials of cline's own sign-ins (cline,
 * cline-pass, openai-codex). Any other provider needs `CLINE_API_KEY` — which
 * ACP passes to the provider as its key — so the runner fills it from the
 * provider's own key variable (OPENROUTER_API_KEY, ...) when unset, and
 * names the fix when there is none. `CLINE_PROVIDER` / `CLINE_MODEL` pick the
 * provider and model (the session's own, from `cline history`, by default).
 *
 * Gaps ACP has (cline's acp/session-updates.ts drops them): no usage and no
 * iteration events, and `--thinking` does not exist there (ACP runs with
 * thinking off). Usage and cost come from the session's cumulative
 * `metadata.usage` in `cline history --json`, read before and after the turn.
 * Max turns is approximated: a model step starts at the first message,
 * thought or tool call after tool results; past the cap the runner sends
 * `session/cancel` (stopReason `cancelled`), and kills the process if the
 * prompt has not ended EXIT_GRACE_MS later.
 */

import type { AgentRunArgs } from './agent-runner.js';
import type { ClineSetup } from './cline-runner-host.js';
import { parseAcpUpdate, toUsage } from './cline-runner-parse.js';
import { launchCline } from './cline-runner-proc.js';
import { MAX_TURNS_KILL_GRACE_MS } from './cline-runner-stream.js';
import { acpToolName } from './cline-runner-tools.js';
import type {
  ClineEvent,
  ClineHistoryRow,
  ClineHost,
  ClineTurnOutcome,
  ClineUsage,
} from './cline-runner-types.js';

/** Providers ACP authenticates from cline's own stored sign-in. */
const ACP_STORED_AUTH = new Set(['cline', 'cline-pass', 'openai-codex']);
const HISTORY_LIMIT = 200;
const EXIT_GRACE_MS = 5000;

/** The key variable cline's provider catalog names for a provider
 *  (`apiKeyEnv`); the common ones, else `<PROVIDER>_API_KEY`. */
export function providerKeyEnv(provider: string): string[] {
  switch (provider) {
    case 'openai':
    case 'openai-native':
      return ['OPENAI_API_KEY'];
    case 'gemini':
    case 'google':
      return ['GEMINI_API_KEY', 'GOOGLE_API_KEY'];
    default:
      return [`${provider.toUpperCase().replace(/[^A-Z0-9]/g, '_')}_API_KEY`];
  }
}

/** The ACP env for one resumed turn, or the reason it cannot authenticate. */
export function acpEnv(
  base: Record<string, string>,
  provider: string | undefined,
  model: string | undefined,
): { env: Record<string, string> } | { error: string } {
  const env = { ...base };
  const p = provider || env.CLINE_PROVIDER;
  if (p) env.CLINE_PROVIDER = p;
  if (model) env.CLINE_MODEL = model;
  if (!env.CLINE_API_KEY && p && !ACP_STORED_AUTH.has(p)) {
    const vars = providerKeyEnv(p);
    const key = vars.map((v) => env[v]).find((v) => !!v);
    if (!key) {
      return {
        error:
          `resuming a cline session goes through ACP, which only reads a stored sign-in for ` +
          `cline / cline-pass / openai-codex; for provider "${p}" export ${vars.join(' or ')} ` +
          '(or CLINE_API_KEY) in the environment',
      };
    }
    env.CLINE_API_KEY = key;
  }
  return { env };
}

function sub(a: ClineUsage, b: ClineUsage | undefined): ClineUsage {
  const d = (x: number, y = 0) => Math.max(0, x - y);
  return {
    inputTokens: d(a.inputTokens, b?.inputTokens),
    outputTokens: d(a.outputTokens, b?.outputTokens),
    cacheReadTokens: d(a.cacheReadTokens, b?.cacheReadTokens),
    cacheWriteTokens: d(a.cacheWriteTokens, b?.cacheWriteTokens),
    ...(a.totalCost !== undefined
      ? { totalCost: Math.max(0, a.totalCost - (b?.totalCost ?? 0)) }
      : {}),
  };
}

/** Session-cumulative usage of a history row. */
export function rowUsage(row: ClineHistoryRow | undefined): ClineUsage | undefined {
  const m = row?.metadata;
  const u = toUsage(m?.aggregateUsage) ?? toUsage(m?.usage);
  if (u && u.totalCost === undefined && typeof m?.totalCost === 'number') u.totalCost = m.totalCost;
  return u;
}

async function findRow(
  host: ClineHost,
  setup: ClineSetup,
  id: string,
): Promise<ClineHistoryRow | undefined> {
  const rows = await host.history(setup.bin, setup.env, HISTORY_LIMIT);
  return rows.find((r) => r.sessionId === id);
}

type Rpc = {
  id?: number | string;
  method?: string;
  params?: Record<string, unknown>;
  result?: Record<string, unknown>;
  error?: { message?: string };
};

export async function* streamAcpTurn(
  setup: ClineSetup,
  sessionId: string,
  prompt: string,
  args: AgentRunArgs,
  host: ClineHost,
  outcome: ClineTurnOutcome,
  known: { provider?: string; model?: string },
): AsyncGenerator<ClineEvent> {
  const before = await findRow(host, setup, sessionId);
  const auth = acpEnv(
    setup.env,
    known.provider ?? before?.provider,
    args.model || known.model || before?.model,
  );
  if ('error' in auth) {
    outcome.errorMessage = auth.error;
    outcome.fatal = true;
    return;
  }
  const acpSetup: ClineSetup = { ...setup, env: auth.env };
  const cli = ['--acp', '--auto-approve', 'true', ...setup.configArgs, ...setup.dataDirArgs];
  const launch = launchCline(acpSetup, cli, args, host, { interactive: true });
  const stdin = launch.child.stdin;
  const send = (o: Record<string, unknown>) => {
    if (stdin && !stdin.destroyed && stdin.writable)
      stdin.write(`${JSON.stringify({ jsonrpc: '2.0', ...o })}\n`);
  };
  const finish = () => {
    if (stdin && !stdin.destroyed) stdin.end();
    const t = setTimeout(() => launch.interrupt(), EXIT_GRACE_MS);
    t.unref?.();
  };

  let loaded = false;
  let text = '';
  let phase: 'idle' | 'model' | 'tools' = 'idle';
  let steps = 0;
  const flush = (into: ClineEvent[]) => {
    if (text.trim()) into.push({ kind: 'text', text });
    text = '';
  };
  const step = () => {
    if (phase === 'model') return;
    phase = 'model';
    steps++;
    if (args.maxTurns > 0 && steps > args.maxTurns && !outcome.maxTurnsHit) {
      outcome.maxTurnsHit = true;
      send({ method: 'session/cancel', params: { sessionId } });
      // Signals do not stop a cline run (see cline-runner-stream.ts); if the
      // cancel does not end the prompt either, the process goes.
      const t = setTimeout(() => {
        if (launch.child.exitCode === null && launch.child.signalCode === null) {
          launch.killChild(MAX_TURNS_KILL_GRACE_MS);
        }
      }, EXIT_GRACE_MS);
      t.unref?.();
    }
  };

  const handle = (line: string): ClineEvent[] => {
    const t = line.trim();
    if (!t.startsWith('{')) return [];
    let m: Rpc;
    try {
      m = JSON.parse(t) as Rpc;
    } catch {
      return [];
    }
    const out: ClineEvent[] = [];
    if (m.method !== undefined && m.id !== undefined) {
      // A request from cline (auto-approve makes permission requests rare):
      // allow a permission request, refuse anything else.
      if (m.method === 'session/request_permission') {
        const opts = Array.isArray(m.params?.options)
          ? (m.params.options as Array<Record<string, unknown>>)
          : [];
        const allow =
          opts.find((o) => o.kind === 'allow_always') ?? opts.find((o) => o.kind === 'allow_once');
        send({
          id: m.id,
          result: {
            outcome: allow
              ? { outcome: 'selected', optionId: allow.optionId }
              : { outcome: 'cancelled' },
          },
        });
      } else {
        send({ id: m.id, error: { code: -32601, message: `unsupported: ${m.method}` } });
      }
      return out;
    }
    if (m.method === 'session/update') {
      if (!loaded) return out; // session/load's replay of the old conversation
      const u = parseAcpUpdate(m.params?.update);
      if (u.textChunk !== undefined) {
        step();
        text += u.textChunk;
      } else if (u.thought) {
        step();
        out.push({ kind: 'ping' });
      } else if (u.toolStart) {
        step();
        flush(out);
        const { id, acpKind, rawInput, title } = u.toolStart;
        out.push({
          kind: 'tool_start',
          id,
          name: acpToolName(acpKind, rawInput, title),
          input: rawInput,
        });
      } else if (u.toolEnd) {
        phase = 'tools';
        const output =
          typeof u.toolEnd.output === 'string'
            ? parseMaybeJson(u.toolEnd.output)
            : u.toolEnd.output;
        out.push({
          kind: 'tool_end',
          id: u.toolEnd.id,
          output,
          ...(u.toolEnd.failed ? { error: stringOutput(output) || 'tool failed' } : {}),
        });
      }
      return out;
    }
    if (m.id === 1) {
      if (m.error) {
        outcome.errorMessage = `cline ACP initialize failed: ${m.error.message ?? 'unknown error'}`;
        finish();
      } else {
        send({
          id: 2,
          method: 'session/load',
          params: { sessionId, cwd: args.cwd, mcpServers: [] },
        });
      }
    } else if (m.id === 2) {
      if (m.error) {
        outcome.errorMessage = `cline could not load session ${sessionId}: ${m.error.message ?? 'unknown error'}`;
        finish();
      } else {
        loaded = true;
        send({
          id: 3,
          method: 'session/prompt',
          params: { sessionId, prompt: [{ type: 'text', text: prompt }] },
        });
      }
    } else if (m.id === 3) {
      flush(out);
      if (m.error) outcome.errorMessage = m.error.message ?? 'cline ACP prompt failed';
      else
        outcome.finishReason =
          typeof m.result?.stopReason === 'string' ? m.result.stopReason : 'unknown';
      finish();
    }
    return out;
  };

  let drained = false;
  try {
    yield { kind: 'ping' };
    send({ id: 1, method: 'initialize', params: { protocolVersion: 1, clientCapabilities: {} } });
    let buf = '';
    for await (const chunk of launch.child.stdout as AsyncIterable<Buffer>) {
      buf += chunk.toString();
      const parts = buf.split('\n');
      buf = parts.pop() ?? '';
      for (const line of parts) yield* handle(line);
    }
    if (buf.trim()) yield* handle(buf);
    const tail: ClineEvent[] = [];
    flush(tail);
    yield* tail;
    drained = true;
  } finally {
    launch.dispose();
  }

  outcome.exitCode = await launch.exit;
  outcome.stderrTail = launch.stderr();
  outcome.timedOut = launch.timedOut();
  outcome.sessionId = sessionId;
  outcome.provider = auth.env.CLINE_PROVIDER ?? before?.provider;
  outcome.model = auth.env.CLINE_MODEL ?? before?.model;
  if (outcome.finishReason === undefined && !outcome.errorMessage) {
    outcome.errorMessage = 'cline ACP ended before the prompt finished';
  }
  if (!drained) return;
  const after = rowUsage(await findRow(host, setup, sessionId));
  if (after) outcome.usage = sub(after, rowUsage(before));
}

function parseMaybeJson(s: string): unknown {
  const t = s.trim();
  if (!t.startsWith('{') && !t.startsWith('[')) return s;
  try {
    return JSON.parse(t);
  } catch {
    return s;
  }
}

function stringOutput(v: unknown): string {
  return typeof v === 'string' ? v : v === undefined ? '' : JSON.stringify(v);
}
