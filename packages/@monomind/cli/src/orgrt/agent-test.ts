// packages/@monomind/cli/src/orgrt/agent-test.ts
/**
 * `monomind agent test <runtime> --json` engine (issue #390, protocol rev 18).
 *
 * Sends one "Reply with the single word: ok" turn through the same
 * in-process engine `agent exec` uses (runAgentExec) — max turns 1, no
 * caller tools, scoped access, a fresh temporary cwd — and folds the NDJSON
 * events into one result object with a status a caller can store:
 * ok | ok_unexpected | auth | quota | model_unavailable | timeout |
 * missing_binary | error.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getModelPrice } from '../pricing/model-pricing.js';
import { type AgentFailureStatus, classifyAgentError } from './agent-error-classify.js';
import { runAgentExec } from './agent-exec.js';
import type { AgentRunner } from './agent-runner.js';
import { locateBinary, resolveBinary, runnerSpec } from './runner-registry.js';
import { detectVersion } from './version-probe.js';

export const AGENT_TEST_PROMPT = 'Reply with the single word: ok';

export type AgentTestStatus = 'ok' | 'ok_unexpected' | AgentFailureStatus;

export interface AgentTestError {
  code: string;
  message: string;
  login_hint?: string;
}

export interface AgentTestResult {
  v: 1;
  runtime: string;
  model: string | null;
  status: AgentTestStatus;
  reply: string | null;
  latency_first_ms: number | null;
  latency_ms: number;
  input_tokens: number;
  output_tokens: number;
  /** null when the runtime reported no cost and the model has no price entry. */
  cost_usd: number | null;
  cost_estimated: boolean;
  runtime_version: string | null;
  error: AgentTestError | null;
}

/** Binary lookup: path = found, null = required but absent, undefined = none needed. */
export type BinaryFinder = (runtime: string) => string | null | undefined;

export interface AgentTestOptions {
  runtime: string;
  model?: string;
  timeoutMs: number;
  /** Test seams; production uses the registry, PATH, and the real runner. */
  runnerOverride?: AgentRunner;
  findBinary?: BinaryFinder;
  versionOf?: (runtime: string, binPath: string) => Promise<string | null>;
  now?: () => number;
}

/** The runtime's binary as `agent scan` would find it. */
export function findRuntimeBinary(runtime: string): string | null | undefined {
  const spec = runnerSpec(runtime);
  if (!spec) return undefined;
  const bin = resolveBinary(spec, process.env);
  return bin ? locateBinary(bin, process.env) : undefined;
}

async function installedVersion(runtime: string, binPath: string): Promise<string | null> {
  return (await detectVersion(runtime, binPath, {})).version;
}

/** "ok", case-insensitive, trimmed, with optional trailing punctuation. */
export function isOkReply(reply: string | null | undefined): boolean {
  return /^ok\p{P}*$/iu.test((reply ?? '').trim());
}

/** Runtime-reported cost, else a pricing-table estimate from the token counts. */
export function resolveCost(
  model: string | undefined,
  reportedUsd: number,
  inputTokens: number,
  outputTokens: number,
): { cost_usd: number | null; cost_estimated: boolean } {
  if (reportedUsd > 0 || inputTokens + outputTokens === 0) {
    return { cost_usd: reportedUsd, cost_estimated: false };
  }
  const price = model ? getModelPrice(model) : null;
  if (!price) return { cost_usd: null, cost_estimated: false };
  return { cost_usd: inputTokens * price.in + outputTokens * price.out, cost_estimated: true };
}

interface Collected {
  firstAt: number | null;
  texts: string[];
  inTokens: number;
  outTokens: number;
  usd: number;
  result: { text?: string; is_error?: boolean } | null;
  error: { code: string; message: string } | null;
}

function collector(now: () => number): {
  state: Collected;
  emit: (ev: Record<string, unknown>) => void;
} {
  const state: Collected = {
    firstAt: null,
    texts: [],
    inTokens: 0,
    outTokens: 0,
    usd: 0,
    result: null,
    error: null,
  };
  const emit = (ev: Record<string, unknown>): void => {
    if (ev.type === 'assistant' && typeof ev.text === 'string') {
      state.firstAt ??= now();
      state.texts.push(ev.text);
    } else if (ev.type === 'usage') {
      state.inTokens += Number(ev.input_tokens ?? 0);
      state.outTokens += Number(ev.output_tokens ?? 0);
      state.usd += Number(ev.cost_usd ?? 0);
    } else if (ev.type === 'result') {
      state.result = ev as Collected['result'];
    } else if (ev.type === 'error' && !state.error) {
      state.error = { code: String(ev.code ?? 'runner-error'), message: String(ev.message ?? '') };
    }
  };
  return { state, emit };
}

/** Run one test turn and fold its events into an AgentTestResult. */
export async function runAgentTest(opts: AgentTestOptions): Promise<AgentTestResult> {
  const now = opts.now ?? Date.now;
  const spec = runnerSpec(opts.runtime);
  const binPath = (opts.findBinary ?? findRuntimeBinary)(opts.runtime);
  const base = {
    v: 1 as const,
    runtime: opts.runtime,
    model: opts.model ?? null,
  };

  if (binPath === null) {
    return {
      ...base,
      status: 'missing_binary',
      reply: null,
      latency_first_ms: null,
      latency_ms: 0,
      input_tokens: 0,
      output_tokens: 0,
      cost_usd: 0,
      cost_estimated: false,
      runtime_version: null,
      error: {
        code: 'missing-binary',
        message: `${opts.runtime} CLI not found${spec ? ` — ${spec.installHint}` : ''}`,
      },
    };
  }

  const versionPromise = binPath
    ? (opts.versionOf ?? installedVersion)(opts.runtime, binPath).catch(() => null)
    : Promise.resolve(null);

  const cwd = mkdtempSync(join(tmpdir(), 'monomind-agent-test-'));
  const { state, emit } = collector(now);
  const started = now();
  try {
    await runAgentExec({
      runtime: opts.runtime,
      prompt: AGENT_TEST_PROMPT,
      model: opts.model,
      cwd,
      access: 'scoped',
      maxTurns: 1,
      timeoutMs: opts.timeoutMs,
      toolTimeoutMs: opts.timeoutMs,
      toolSpecs: null,
      stdioFrames: false,
      runnerOverride: opts.runnerOverride,
      emit,
    });
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
  const latency_ms = now() - started;

  const assistantText = state.texts.join('');
  const reply = state.result?.text ?? (assistantText || null);
  let status: AgentTestStatus;
  let error: AgentTestError | null = null;
  if (state.error) {
    const cls = classifyAgentError({
      code: state.error.code,
      message: `${state.error.message}\n${assistantText}`,
    });
    status = cls.status;
    error = {
      code: cls.code,
      message: state.error.message,
      ...(status === 'auth' && spec?.loginHint ? { login_hint: spec.loginHint } : {}),
    };
  } else {
    status = isOkReply(reply) ? 'ok' : 'ok_unexpected';
  }

  return {
    ...base,
    status,
    reply,
    latency_first_ms: state.firstAt === null ? null : state.firstAt - started,
    latency_ms,
    input_tokens: state.inTokens,
    output_tokens: state.outTokens,
    ...resolveCost(opts.model, state.usd, state.inTokens, state.outTokens),
    runtime_version: await versionPromise,
    error,
  };
}

/** Process exit code for a result: 0 when the turn succeeded, 124 on timeout. */
export function agentTestExitCode(status: AgentTestStatus): number {
  if (status === 'ok' || status === 'ok_unexpected') return 0;
  return status === 'timeout' ? 124 : 1;
}
