// packages/@monomind/cli/src/orgrt/pi-runner.ts
/**
 * PiAgentRunner — AgentRunner impl backed by the Pi coding agent CLI
 * (`pi`, https://github.com/badlogic/pi-mono, package @mariozechner/pi-coding-agent).
 *
 * Architectural pattern: SAME as the other subprocess runners — spawn the
 * CLI, parse its output, normalize to AgentMessage.
 *
 * Auth: pi's own provider login (per-provider API key or subscription,
 * configured via `pi` itself). No env vars set here.
 *
 * Streaming / liveness — WHY INCREMENTAL (#204):
 *   This runner originally buffered ALL of pi's stdout until the subprocess
 *   exited, then parsed the whole batch. session.ts races the FIRST pull
 *   from this runner against a 4-minute silent-stream watchdog
 *   (SILENT_SESSION_MS), so any turn longer than 4 minutes yielded zero
 *   messages in time — abort, retry, kill, circuit breaker, stalled org.
 *   Same bug class the kimi/antigravity/codex runners had (#204 audit,
 *   fixed for codex in the commit this one mirrors). This runner now parses
 *   stdout LINE BY LINE as data arrives: a liveness `tool_use` message is
 *   yielded the moment the subprocess spawns (deterministically winning the
 *   first-pull race regardless of model-thinking latency), assistant text is
 *   yielded as each `message_end` event lands (pi sends whole messages, not
 *   per-token deltas — no accumulation needed, unlike agy), and pi's own
 *   `tool_execution_start`/`tool_execution_end` events are forwarded as
 *   rich `tool_use`/`tool_result` pairs matched by toolCallId. Tool_call fences are still collected
 *   from the raw texts and parsed at end of turn (fence parsing needs the
 *   complete text). Fatal provider errors (auth/quota) are classified via
 *   the shared classifyStderr helper and tagged non-retryable, same as
 *   kimi/antigravity/codex.
 *
 * Subprocess protocol — byte-verified against a running `pi` 0.73.1 binary
 * (2026-08-25, see doc/agent-exec-protocol testing).
 *   - Invocation: `pi --mode json --session-dir <dir> "<prompt>"`. The
 *     prompt is POSITIONAL (matching pi's own interactive-mode CLI shape and
 *     the same convention codex uses) — an earlier revision of this runner
 *     passed it via a `-p` flag, which a second-source cross-check against
 *     another public agentic-CLI wrapper's tool table indicated was wrong;
 *     corrected here. An even earlier revision also passed `--approve`
 *     (meant to accept the cwd as trusted so pi doesn't stop to ask) — that
 *     flag does not exist in 0.73.1's `--help` output at all and made every
 *     turn fail immediately with "Unknown option: --approve"; removed.
 *     `--mode json` alone was confirmed NOT to block on an interactive
 *     trust prompt, so no replacement flag is needed (pi has no single
 *     "yolo" flag; tool auto-approval for individual actions is a separate,
 *     not-yet-wired concern for this runner — org tool calls go through
 *     canUseTool regardless, since they use the tool-fence protocol, not
 *     pi's native tool surface).
 *     (`--session-dir` also gives turn-to-turn continuity: pi persists
 *     sessions in that directory and resumes the latest one by default —
 *     there is no confirmed explicit `--resume <id>` flag for headless use,
 *     so this runner points every turn at the SAME per-run session dir
 *     rather than tracking a session id, and disclaims true cross-process
 *     resume as best-effort). SUPERSEDED for pi 0.87: the first --mode json
 *     record is a `session` header with the id, and `--session <id>` resumes
 *     it — the runner now passes it on every later invocation, and drops
 *     `--session-dir` in coder mode so sessions stay in pi's own store.
 *   - Event types seen: `agent_start` (ignored), `message_update` (partial;
 *     carries a cumulative `usage` object — kept as running totals but
 *     superseded by `message_end`), `message_end` (final `content` array
 *     with `{type:'text', text}` / `{type:'toolCall', ...}` items — only
 *     `text` items are surfaced to the bus), `tool_execution_start` /
 *     `tool_execution_end` (org tool calls use the shared tool-fence
 *     protocol, not pi's native tool-call surface; both tool_execution events
 *     become matched tool_use/tool_result pairs — see header note above).
 *   - Usage field names differ from the other CLIs: `usage.input` /
 *     `usage.output` (not `input_tokens`/`output_tokens`).
 *
 * Org tools — FENCE PROTOCOL: same approach as the other subprocess runners.
 */
import { join } from 'node:path';
import type { AgentMessage, AgentRunArgs, AgentRunner } from './agent-runner.js';
import { NativeToolCalls } from './kimicode-runner-tools.js';
import type { TurnOutcome } from './pi-runner-stream.js';
import { STARTUP_GRACE_MS, streamTurn, turnError } from './pi-runner-stream.js';
import {
  buildToolProtocol,
  formatToolResults,
  parseToolCalls,
  runToolRound,
} from './tool-fence.js';

export { parsePiEvents } from './pi-runner-parse.js';
export type { PiStreamEvent } from './pi-runner-stream.js';

export class PiAgentRunner implements AgentRunner {
  constructor(private piBin?: string) {}

  async *run(args: AgentRunArgs): AsyncIterable<AgentMessage> {
    const bin = this.piBin || process.env.PI_CLI_BIN || 'pi';
    // Stable per-run session directory for org roles. Coder mode (--access
    // full / --settings) keeps the user's own pi setup instead: sessions in
    // pi's own store, not a directory in the user's project.
    const userSetup = args.access === 'full' || (args.settingSources?.length ?? 0) > 0;
    const sessionDir = userSetup ? undefined : join(args.cwd, '.monomind-pi-session');
    // The `session` header's id (pi docs/json.md); every later invocation
    // passes `--session <id>`, so a tool round or the next prompt continues
    // the same conversation. AgentRunArgs.resume seeds it.
    let sessionId: string | undefined = args.resume;
    const tools = new NativeToolCalls();
    // pi prices each assistant message; the result carries this run's
    // running sum (cumulative, like every runner's cost_usd).
    let runCostUsd: number | undefined;

    try {
      let first = !sessionId;
      for await (const p of args.prompt) {
        const text = typeof p === 'string' ? p : (p?.message?.content ?? String(p ?? ''));
        let nextPrompt = first
          ? `${args.systemPrompt}${buildToolProtocol(args.tools)}\n\n---\n\n${text}`
          : text;
        first = false;
        let turnInputTokens = 0;
        let turnOutputTokens = 0;

        // runToolRound ends this loop past the round cap (#326).
        for (let round = 0; ; round++) {
          // Filled in by streamTurn as the subprocess runs and when it exits.
          const outcome: TurnOutcome = {
            exitCode: 1,
            stderrTail: '',
            timedOut: false,
            hangSuspected: false,
            inputTokens: 0,
            outputTokens: 0,
          };
          // Raw assistant texts (fences intact) for end-of-turn tool-call
          // parsing — fence parsing needs the complete text, so fences are
          // collected here while the stripped prose streams out live below.
          const rawTexts: string[] = [];

          for await (const ev of streamTurn(
            bin,
            nextPrompt,
            sessionDir,
            sessionId,
            args,
            outcome,
          )) {
            if (outcome.sessionId) sessionId = outcome.sessionId;
            if (ev.kind === 'assistant' && ev.rawText !== undefined) {
              rawTexts.push(ev.rawText);
              // Yield assistant prose AS IT ARRIVES (per message_end event,
              // not after process exit): a pi turn can run many minutes, and
              // session.ts's watchdog must see messages DURING the turn.
              // Note this means partial output may already be yielded when a
              // turn later exits non-zero — preferable to losing it entirely.
              if (ev.text) yield { type: 'assistant', session_id: sessionId, text: ev.text };
            } else if (ev.kind === 'native') {
              // pi's own tool calls, paired by toolCallId.
              if (ev.toolStart) {
                const t = ev.toolStart;
                const m = tools.start(t.id, t.name, t.input, sessionId);
                if (m) yield m;
              }
              if (ev.toolEnd) {
                yield* tools.end(ev.toolEnd.id, ev.toolEnd.output, ev.toolEnd.isError, sessionId);
              }
            } else if (ev.kind === 'tool') {
              // Liveness for the spawn-time yield: session.ts never renders tool_use as chat — it only
              // feeds the StateDetector ('tool-call' state) and refreshes
              // last-activity.
              yield { type: 'tool_use', text: ev.toolName };
            }
          }

          if (outcome.hangSuspected) {
            throw new Error(
              `PiAgentRunner: pi produced no output within ${STARTUP_GRACE_MS / 1000}s and was killed. ` +
                "This usually means it is stuck on a prompt headless mode has no way to answer — pi's own " +
                'docs say --mode json should not show a trust prompt, so this is unexpected. Run `pi` once ' +
                `manually in a real terminal in this project to check, then retry.${outcome.stderrTail ? `\nstderr: ${outcome.stderrTail.slice(-500)}` : ''}`,
            );
          }
          if (outcome.exitCode !== 0) {
            throw turnError(outcome, round);
          }

          turnInputTokens += outcome.inputTokens;
          turnOutputTokens += outcome.outputTokens;
          if (outcome.sessionId) sessionId = outcome.sessionId;
          if (outcome.costUsd !== undefined) runCostUsd = (runCostUsd ?? 0) + outcome.costUsd;

          const malformed: string[] = [];
          const calls = parseToolCalls(rawTexts, (raw, err) =>
            malformed.push(
              `[monomind] ignored malformed tool_call fence (${err}): ${raw.slice(0, 200)}`,
            ),
          );
          for (const note of malformed) yield { type: 'assistant', text: note };
          if (calls.length === 0) break;

          const { results, note } = await runToolRound(args, calls, round);
          if (note) yield { type: 'assistant', text: note };
          if (!results) break;
          nextPrompt = formatToolResults(calls, results);
        }

        yield {
          type: 'result',
          session_id: sessionId,
          subtype: 'success',
          input_tokens: turnInputTokens,
          output_tokens: turnOutputTokens,
          ...(runCostUsd !== undefined ? { cost_usd: runCostUsd } : {}),
        };
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new Error(
          'PiAgentRunner requires the Pi coding agent CLI (pi) on PATH. ' +
            'Install it: npm install -g @mariozechner/pi-coding-agent, then configure a ' +
            'provider. Or unset the runtime to use Claude.',
        );
      }
      throw err;
    }
  }
}
