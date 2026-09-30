// packages/@monomind/cli/src/orgrt/antigravity-runner-stream.ts
// Split out of antigravity-runner.ts (file-size sweep) — the `agy` subprocess
// streaming cursor (computeSafeChunk), the per-turn stream reader
// (streamTurn), and the turn-failure error builder (turnError). streamTurn
// does not reference `this` — it was a private method purely for grouping,
// so moving it to a standalone function changes nothing observable; the
// class in antigravity-runner.ts now calls it as an imported function.
import { randomUUID } from 'node:crypto';
import type { AgentRunArgs } from './agent-runner.js';
import { killOnAbort } from './agent-runner.js';
import type { AgyEvent, AgyStreamEvent, TurnOutcome } from './antigravity-runner-types.js';
import { maskedCommand } from './authority-mask.js';
import type { OrgEffortLevel } from './cost-tier.js';
import { classifyStderr } from './kimicode-runner.js';
import { NativeToolCalls } from './kimicode-runner-tools.js';
import { spawnRunnerProcess } from './process-group-spawn.js';
import { omitAnthropicManagedKeys } from './provider.js';
import { stepMeter } from './runner-usage.js';
import { TOOL_CALL_RE } from './tool-fence.js';

const TURN_TIMEOUT_MS = 2 * 60 * 60 * 1000; // 2 hours, matching kimi/codex runners

/** `agy --effort` accepts low|medium|high|max (agy --help): 'off' has no
 *  agy equivalent below low, and 'xhigh' rounds down rather than jumping to
 *  the most expensive level. */
const AGY_EFFORT: Record<OrgEffortLevel, string> = {
  off: 'low',
  low: 'low',
  medium: 'medium',
  high: 'high',
  xhigh: 'high',
  max: 'max',
};

// The opening marker TOOL_CALL_RE looks for (see tool-fence.ts:
// /```tool_call\s*\n([\s\S]*?)```/g). computeSafeChunk matches on this
// literal substring rather than the full regex (including its \s*\n
// requirement) — a deliberate simplification: the only cost of being
// slightly less strict is that literal prose containing "```tool_call" not
// followed by a real fence body would be held back until the step ends,
// at which point it flushes as-is (matching TOOL_CALL_RE's own behavior
// for anything that never forms a complete, well-closed fence). That is
// an acceptable, self-correcting edge case for something the model is
// never instructed to write outside the real fence protocol.
const FENCE_OPEN = '```tool_call';

/**
 * Fence-boundary-aware incremental streaming cursor. Given the full text
 * accumulated so far for one in-progress agent_response step and how much
 * of it (from the start) has already been surfaced as visible text, returns
 * the additional prefix that is now also safe to surface, plus the new
 * high-water mark to pass back in on the next call.
 *
 * "Safe" means: never any part of an unclosed ```tool_call fence (its
 * content must never reach the user, complete or not — same as
 * TOOL_CALL_RE's own stripping), and never a trailing partial match of the
 * "```tool_call" opening marker itself, which could still complete into a
 * real fence as more text arrives on the next call. A complete fence found
 * along the way is skipped in its entirety — scanning resumes right after
 * its closing ``` — so the fence never appears in the returned chunk.
 *
 * Pure and only ever reads forward from flushedUpTo, so calling it once
 * per accumulated string or once per tiny incremental slice (as real
 * per-token deltas arrive) converges on the identical assembled output —
 * exercised directly in this file's own test suite.
 */
export function computeSafeChunk(
  text: string,
  flushedUpTo: number,
): { chunk: string; safeEnd: number } {
  let cursor = flushedUpTo;
  let visibleStart = flushedUpTo;
  let chunk = '';
  for (;;) {
    const openIdx = text.indexOf(FENCE_OPEN, cursor);
    if (openIdx === -1) {
      // No complete opening marker ahead. The tail might still be the
      // start of one forming — hold back the longest suffix of the
      // unscanned text that exactly matches a prefix of FENCE_OPEN.
      const tail = text.slice(cursor);
      let holdBack = 0;
      for (let n = Math.min(FENCE_OPEN.length - 1, tail.length); n > 0; n--) {
        if (FENCE_OPEN.startsWith(tail.slice(-n))) {
          holdBack = n;
          break;
        }
      }
      const safeEnd = text.length - holdBack;
      chunk += text.slice(visibleStart, safeEnd);
      return { chunk, safeEnd };
    }
    // Everything before the opening marker is safe.
    chunk += text.slice(visibleStart, openIdx);
    const closeIdx = text.indexOf('```', openIdx + FENCE_OPEN.length);
    if (closeIdx === -1) {
      // Opened but not yet closed — nothing from here on is safe yet.
      return { chunk, safeEnd: openIdx };
    }
    // Fully closed — skip the entire fence, keep scanning after it.
    cursor = closeIdx + 3;
    visibleStart = cursor;
  }
}

/**
 * Run one `agy` invocation and stream its stream-json output
 * INCREMENTALLY: each parsed event is yielded as soon as its line arrives
 * on stdout (see antigravity-runner.ts's header "Streaming / liveness" note
 * for why buffering until process exit was a bug). End-of-turn facts (exit
 * code, stderr tail, conversation id, usage, error, timeout flag) are
 * written into `outcome`, which the caller reads after this generator
 * completes.
 */
export async function* streamTurn(
  bin: string,
  prompt: string,
  conversationId: string | undefined,
  args: AgentRunArgs,
  outcome: TurnOutcome,
): AsyncGenerator<AgyStreamEvent> {
  // ARG ORDER (from agy headless docs):
  //   agy -p "<prompt>" --output-format stream-json
  //       [--model X] [--effort L] [--dangerously-skip-permissions]
  //       [--continue | --conversation <id>]
  // --dangerously-skip-permissions is passed at every access level: a
  // headless agy has no one to answer a permission prompt, so this is also
  // what full access (`--access full`) runs with. agy isolates none of the
  // user's own config, so `--settings` needs nothing extra here.
  const cliArgs: string[] = ['-p', prompt, '--output-format', 'stream-json'];
  if (args.model) cliArgs.push('--model', args.model);
  if (args.effort) cliArgs.push('--effort', AGY_EFFORT[args.effort]);
  // #482 `--sandbox restricted` (any access mode): no skip, so agy's own
  // rules auto-deny what they would ask about (shell, file writes outside
  // the temp dir — agy 1.2.13, checked live).
  if (args.sandbox !== 'restricted') cliArgs.push('--dangerously-skip-permissions');
  if (conversationId) {
    cliArgs.push('--conversation', conversationId);
  }

  // Process-group leader under --access full, so cancel reaches the whole
  // tree and agent exec can report background_pids (process-group-spawn.ts).
  const proc = spawnRunnerProcess(
    ...maskedCommand(args.authorityMask, bin, cliArgs),
    {
      cwd: args.cwd,
      // o-18: ambient ANTHROPIC_* creds never belong to a non-Anthropic
      // vendor CLI; an explicit value in args.env still wins below.
      env: { ...omitAnthropicManagedKeys(process.env), ...args.env },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
    args,
  );
  const child = proc.child;

  let stderrTail = '';
  child.stderr?.on('data', (c: Buffer) => {
    stderrTail = (stderrTail + c.toString()).slice(-4000);
  });

  // SIGTERM→SIGKILL escalation, shared by the turn timeout, the abort
  // signal, and the abandoned-stream path in `finally` — a CLI that
  // ignores SIGTERM must not leak a zombie per turn.
  const KILL_GRACE_MS = 5000;
  let killTimer: ReturnType<typeof setTimeout> | undefined;
  const killChild = (): void => {
    proc.target.kill('SIGTERM');
    killTimer = setTimeout(() => proc.target.kill('SIGKILL'), KILL_GRACE_MS);
    killTimer.unref?.();
  };

  // Arm the turn timeout BEFORE consuming stdout — a hung CLI must be
  // killed while we're still reading, not after it finishes.
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    killChild();
  }, TURN_TIMEOUT_MS);
  // Abort hook (see AgentRunArgs.signal): kill the child so the stdout
  // loop below unblocks instead of orphaning it on iterator.return().
  const unsubscribeAbort = killOnAbort(args.signal, proc.target, KILL_GRACE_MS);

  // Attach the exit promise BEFORE consuming stdout: on a spawn failure
  // (ENOENT, bad binary) the 'error' event fires almost immediately —
  // if no listener is attached yet it escapes as an unhandled 'error'
  // event and crashes the process instead of reaching our catch block.
  const exitPromise = new Promise<number>((res, rej) => {
    child.on('error', rej);
    child.on('close', (code) => res(code ?? 1));
  });
  // Prevent an unhandled-rejection crash if the stdout loop below throws
  // before we await exitPromise (the await still sees the rejection).
  exitPromise.catch(() => {});

  // Incremental text streaming is opt-in via extras, not unconditional:
  // this runner has two independent consumers, exactly like
  // ClaudeAgentRunner (agent-runner.ts) — see its own header comment for
  // the full reasoning, which applies here verbatim. agent-exec.ts (the
  // Agent Exec Protocol) wants incremental `assistant` messages — its
  // protocol doc documents the `assistant` frame as "Incremental
  // assistant text ... callers append" — and sets this unconditionally
  // for every runtime. session.ts (the org runtime) treats each
  // `assistant` AgentMessage as ONE COMPLETE STEP: it feeds the full text
  // into StateDetector's regex pattern-matching and emits ONE org
  // chat-bus event per step. session.ts never sets extras in production
  // (only its `_orgTest` test seam does, and only when no real runner is
  // configured), so leaving this opt-in keeps the org runtime unchanged
  // for antigravity-backed roles too — not just Claude's.
  const streamPartials = args.extras?.includePartialMessages === true;

  let lastConversationId: string | undefined = conversationId;
  // Per-token text_delta fragments are accumulated per agent_response step
  // (pendingText, raw, fences intact) so fence stripping at flush time
  // always sees the complete text — a per-token delta could split a
  // ```tool_call fence across events. rawText bookkeeping (what
  // parseToolCalls sees) is therefore still computed exactly once per
  // step, at the same DONE/step-change/end-of-stream boundaries as
  // before. visibleSoFar decouples FROM that: it is the fence-safe
  // prefix of pendingText already shown to the user (via computeSafeChunk
  // — see its header for the safety definition), and lets emitVisible()
  // stream new safe text live, mid-step, instead of waiting for the
  // step's rawText flush. When !streamPartials, emitVisible() is simply
  // never called (see its two call sites below) — visibleSoFar then stays
  // '' for the whole step, so flushText()'s own diff naturally degrades to
  // "reveal the whole finalStripped text", byte-for-byte the pre-streaming
  // behavior, with no separate code path needed for that case.
  // agy's tool steps: an ACTIVE step_update starts a call and the DONE one
  // for the same step_index ends it with the tool's output (verified live).
  // agy has no call id of its own, so the id is the step index under a
  // per-invocation prefix (step indexes are not unique across invocations).
  const tools = new NativeToolCalls();
  const callPrefix = `agy_${randomUUID().slice(0, 8)}_`;
  let pendingText = '';
  let pendingStepIndex: number | undefined;
  let visibleSoFar = '';
  let sawStreamedText = false;
  let resultResponse: string | undefined;

  // Stream any NEWLY safe text since the last call, as its own event
  // (rawText intentionally omitted — this must never feed rawTexts,
  // which needs one accumulated-per-step string, not fragments).
  // Recomputes computeSafeChunk(pendingText, 0) from scratch each call
  // rather than tracking a raw-text cursor: computeSafeChunk's chunk is
  // provably prefix-stable as pendingText grows (exercised directly by
  // this file's own "handles a fence delivered across many small
  // incremental calls" test), so diffing against visibleSoFar is both
  // correct and — for chat-sized text — cheap enough not to matter.
  const emitVisible = (): AgyStreamEvent | null => {
    const { chunk } = computeSafeChunk(pendingText, 0);
    // Trailing whitespace is held back rather than shown immediately:
    // it might be interior (more text follows, e.g. the blank line
    // before a fence) or truly trailing (nothing follows, and old
    // behavior's whole-text `.trim()` would have dropped it) — which
    // one it is isn't known until the step ends, so flushText's own
    // finalStripped diff (also `.trim()`-ed) is what ultimately
    // resolves it, one way or the other.
    const trimmed = chunk.replace(/\s+$/, '');
    if (trimmed.length <= visibleSoFar.length) return null;
    const increment = trimmed.slice(visibleSoFar.length);
    visibleSoFar = trimmed;
    return { kind: 'assistant', text: increment, conversationId: lastConversationId };
  };

  // Flush the accumulated agent_response text as one assistant event:
  // rawText is the full accumulated text (fence parsing's input, UNCHANGED
  // from before incremental streaming existed), text is whatever fence-safe
  // content hasn't already been streamed by emitVisible (undefined once
  // emitVisible has already shown everything there is to show). Using the
  // same TOOL_CALL_RE + trim as the old single-shot design — rather than
  // computeSafeChunk — for this final reveal is deliberate: an unclosed
  // fence must still leak through unchanged at true end-of-stream (matching
  // TOOL_CALL_RE leaving it untouched — computeSafeChunk withholds it
  // forever, since it can never be told a step is truly over), and
  // trailing whitespace must still be dropped exactly the way the old
  // whole-text `.trim()` dropped it.
  const flushText = (): AgyStreamEvent[] => {
    if (!pendingText) return [];
    const raw = pendingText;
    const finalStripped = raw.replace(TOOL_CALL_RE, '').trim();
    const remainder =
      finalStripped.length > visibleSoFar.length
        ? finalStripped.slice(visibleSoFar.length)
        : undefined;
    pendingText = '';
    pendingStepIndex = undefined;
    visibleSoFar = '';
    return [
      { kind: 'assistant', rawText: raw, text: remainder, conversationId: lastConversationId },
    ];
  };

  // #550: a step's usage (live: an agent_response DONE step carries
  // { input_tokens, output_tokens, cache_read_tokens, total_tokens }) is
  // that step's own model call, reported once per step_index, after the
  // step's own events.
  const stepGrowth = stepMeter();
  const withUsage = (ev: AgyEvent): AgyStreamEvent[] => {
    const events = handleEvent(ev);
    const u = ev.event === 'step_update' ? ev.step_update?.usage : undefined;
    const used =
      u &&
      stepGrowth(ev.step_update?.step_index ?? 'x', {
        input: u.input_tokens,
        output: u.output_tokens,
        cached: u.cache_read_tokens,
      });
    if (used) events.push({ kind: 'usage', usage: used, conversationId: lastConversationId });
    return events;
  };

  // Normalize one parsed wire event: capture the conversation id from ANY
  // event that carries it (resume needs it on the next turn), record result
  // envelope state, and return the AgyStreamEvents to yield (zero, one, or
  // — on a step-index change that both flushes the old step AND streams
  // the new step's first delta — two).
  // init and other event kinds matter only for the conversation id.
  const handleEvent = (ev: AgyEvent): AgyStreamEvent[] => {
    const cid = ev.conversation_id ?? ev.step_update?.conversation_id ?? ev.result?.conversation_id;
    if (cid) lastConversationId = cid;

    const events: AgyStreamEvent[] = [];

    if (ev.event === 'step_update' && ev.step_update) {
      const step = ev.step_update;
      if (step.step_type === 'agent_response') {
        if (
          pendingStepIndex !== undefined &&
          step.step_index !== undefined &&
          step.step_index !== pendingStepIndex
        ) {
          // A new response step started — flush the previous one. rawText
          // bookkeeping timing is UNCHANGED from before incremental
          // streaming: still exactly one flush for the OLD step here: the
          // new step's own delta (if any) just joins pendingText for a
          // LATER event to flush, same as before.
          events.push(...flushText());
          pendingStepIndex = step.step_index;
          if (typeof step.text_delta === 'string') {
            sawStreamedText = true;
            pendingText += step.text_delta;
            if (streamPartials) {
              const inc = emitVisible();
              if (inc) events.push(inc);
            }
          }
          return events;
        }
        if (step.step_index !== undefined) pendingStepIndex = step.step_index;
        if (typeof step.text_delta === 'string') {
          sawStreamedText = true;
          // A DONE step can carry the step's FULL text after ACTIVE
          // deltas streamed the same content per-token — replace
          // instead of double-appending when the accumulated text is
          // a prefix of the DONE payload.
          if (step.state === 'DONE' && pendingText && step.text_delta.startsWith(pendingText)) {
            pendingText = step.text_delta;
          } else {
            pendingText += step.text_delta;
          }
        }
        if (step.state === 'DONE') {
          events.push(...flushText());
        } else if (streamPartials) {
          const inc = emitVisible();
          if (inc) events.push(inc);
        }
        return events;
      } else if (step.step_type === 'tool' && step.tool_info?.name) {
        const name = step.tool_info.name.slice(0, 200);
        const rawInput = step.tool_info.parameters ?? step.tool_info.args ?? {};
        const id = `${callPrefix}${step.step_index ?? 'x'}`;
        const native =
          step.state === 'DONE'
            ? tools.end(id, step.tool_info.output ?? '', false, lastConversationId, {
                name,
                rawInput,
              })
            : [tools.start(id, name, rawInput, lastConversationId)].filter((m) => m !== null);
        if (native.length > 0) {
          events.push({ kind: 'native', native, conversationId: lastConversationId });
        }
        return events;
      }
    } else if (ev.event === 'result' && ev.result) {
      const result = ev.result;
      if (result.status && result.status !== 'SUCCESS') {
        outcome.error = result.error ?? `status: ${result.status}`;
      }
      if (result.usage) {
        outcome.inputTokens = result.usage.input_tokens ?? 0;
        outcome.outputTokens = result.usage.output_tokens ?? 0;
        outcome.cachedInputTokens = result.usage.cache_read_tokens ?? 0;
      }
      if (result.response) resultResponse = result.response;
    }
    return events;
  };

  try {
    // Immediate liveness yield: session.ts races the FIRST pull against a
    // 4-minute silent-stream watchdog, and the model's first event can
    // itself take minutes (long thinking chains, large file reads).
    // Yielding at spawn wins that race deterministically instead of
    // depending on agy's latency.
    yield { kind: 'tool', toolName: 'turn started', conversationId };

    let buf = '';
    for await (const chunk of child.stdout as AsyncIterable<Buffer>) {
      buf += chunk.toString();
      const parts = buf.split('\n');
      buf = parts.pop() ?? '';
      for (const line of parts) {
        const trimmed = line.trim();
        if (!trimmed?.startsWith('{')) continue;
        let ev: AgyEvent;
        try {
          ev = JSON.parse(trimmed) as AgyEvent;
        } catch {
          continue;
        }
        for (const out of withUsage(ev)) yield out;
      }
    }
    const tail = buf.trim();
    if (tail?.startsWith('{')) {
      try {
        for (const out of withUsage(JSON.parse(tail) as AgyEvent)) yield out;
      } catch {
        /* not JSON, skip */
      }
    }

    // Flush any trailing text whose DONE boundary never arrived.
    for (const flushed of flushText()) yield flushed;

    // Fallback for agy versions that only return result.response (no
    // streaming): surface it as the turn's assistant text.
    if (!sawStreamedText && resultResponse) {
      const stripped = resultResponse.replace(TOOL_CALL_RE, '').trim();
      yield {
        kind: 'assistant',
        rawText: resultResponse,
        text: stripped || undefined,
        conversationId: lastConversationId,
      };
    }
  } finally {
    clearTimeout(timer);
    unsubscribeAbort();
    proc.stop();
    if (child.exitCode === null && child.signalCode === null) {
      // NOT confirmed dead. Either the consumer abandoned this stream
      // mid-turn (session.ts's silent abort calls iterator.return(), the
      // mailbox closes, or an error is thrown downstream) — kill it, WITH
      // the SIGKILL escalation — or a SIGTERM from the timeout/abort is
      // still inside its grace period: leave that escalation armed, since
      // clearing it here would orphan a CLI that ignores SIGTERM and then
      // wait on `exitPromise` forever (same fix as codex/kimi/pi-rpc).
      if (!child.killed) killChild();
    } else if (killTimer) {
      clearTimeout(killTimer);
    }
  }

  const exitCode = await exitPromise;
  if (killTimer) clearTimeout(killTimer);
  outcome.conversationId = lastConversationId;
  outcome.exitCode = exitCode;
  outcome.stderrTail = stderrTail;
  outcome.timedOut = timedOut;
}

/** Build the actionable error for a failed agy turn. */
export function turnError(outcome: TurnOutcome, round: number, _bin: string): Error {
  if (outcome.timedOut) {
    return new Error(
      `AntigravityAgentRunner: agy turn (tool round ${round}) exceeded the ${Math.round(TURN_TIMEOUT_MS / 60000)}min ` +
        `turn timeout and was killed.${outcome.stderrTail ? ` stderr: ${outcome.stderrTail.slice(-500)}` : ''}`,
    );
  }
  // Fatal provider errors (auth/permission/quota — classified from the result
  // envelope's error string AND stderr): report what actually happened, and
  // tag the error so the daemon does NOT restart into the same guaranteed
  // failure (a restart on quota exhaustion can only hang or fail again).
  const cls = classifyStderr(`${outcome.error ?? ''}\n${outcome.stderrTail}`);
  if (cls.fatal) {
    const err = new Error(
      `AntigravityAgentRunner: FATAL provider error (${cls.label}) on turn ${round} — not retrying.` +
        (outcome.error ? ` error: ${outcome.error}` : '') +
        (outcome.stderrTail ? ` stderr: ${outcome.stderrTail.slice(-500)}` : ''),
    );
    (err as Error & { fatal?: boolean }).fatal = true;
    return err;
  }
  return new Error(
    `AntigravityAgentRunner: agy failed (exit ${outcome.exitCode})` +
      (outcome.error ? `: ${outcome.error}` : '') +
      (outcome.stderrTail ? `\nstderr: ${outcome.stderrTail.slice(-500)}` : ''),
  );
}
