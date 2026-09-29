// packages/@monomind/cli/src/orgrt/pi-runner-state.ts
/**
 * Run-level bookkeeping shared by the pi `--mode json` and `--mode rpc`
 * runners (pi 0.87.1):
 *   - PiRunTracker: token usage summed over assistant messages, the run's
 *     final failure (pi exits 0 even when every auto-retry failed, so the
 *     error only shows in the stream), and completion on `agent_settled`
 *     (an `agent_end` with `willRetry:true` is followed by `auto_retry_*`
 *     and another agent run).
 *   - PiTurnBudget: `--max-turns` emulation. pi has no turn cap, so the
 *     runner counts `turn_start` events per mailbox message and aborts when
 *     the count passes the cap; a turn pi replays after `auto_retry_start`
 *     is not counted twice.
 *   - PiTextStream: `text_delta` streaming with the tool_call fences held
 *     back (computeSafeChunk), reconciled at each message_end.
 *   - piCliArgs: the flags both runners share.
 */
import type { AgentRunArgs } from './agent-runner.js';
import { computeSafeChunk } from './antigravity-runner.js';
import type { OrgEffortLevel } from './cost-tier.js';
import type { PiMessageUsage, PiParsedLine } from './pi-runner-parse.js';
import { TOOL_CALL_RE } from './tool-fence.js';

/** `pi --thinking` levels (off|minimal|low|medium|high|xhigh|max) cover
 *  every abstract effort level 1:1. */
export const PI_THINKING: Record<OrgEffortLevel, string> = {
  off: 'off',
  low: 'low',
  medium: 'medium',
  high: 'high',
  xhigh: 'xhigh',
  max: 'max',
};

/** Built-in pi tools a `--access read` turn keeps (#388). */
export const PI_READ_TOOLS = 'read,grep,find,ls';

/**
 * Flags shared by `--mode json` and `--mode rpc`:
 *   - `--session-id <id>` opens that exact project session or creates it
 *     (pi docs/cli.md), in pi's own session store — nothing is written into
 *     the user's project. The runner picks the id, so resume needs no
 *     output parsing and every tool round reopens the same session.
 *   - Project trust: coder mode with `--settings` sources passes
 *     `--approve` (load the project's `.pi/` settings, extensions, skills,
 *     prompts). Otherwise the run is isolated: `--no-approve` plus no
 *     extensions/skills/prompt templates/context files (`-ne -ns -np -nc`),
 *     matching the Claude runner's isolated default. pi has no tool
 *     approval to bypass, so full access needs no flag of its own.
 */
export function piCliArgs(mode: 'json' | 'rpc', sessionId: string, args: AgentRunArgs): string[] {
  const out = ['--mode', mode, '--session-id', sessionId];
  if (args.model) out.push('--model', args.model);
  if (args.effort) out.push('--thinking', PI_THINKING[args.effort]);
  if ((args.settingSources?.length ?? 0) > 0) out.push('--approve');
  else out.push('--no-approve', '-ne', '-ns', '-np', '-nc');
  // #388: pi's documented read-only mode (`pi --help`: "no file
  // modifications possible") — only the read-only built-in tools.
  if (args.access === 'read') out.push('--tools', PI_READ_TOOLS);
  return out;
}

/** Usage, completion and failure of one pi agent run (see header). */
export class PiRunTracker {
  inputTokens = 0;
  outputTokens = 0;
  cacheReadTokens = 0;
  cacheWriteTokens = 0;
  costUsd?: number;
  /** agent_settled seen (or a legacy agent_end without willRetry). */
  settled = false;
  /** The last assistant message ended with stopReason "aborted". */
  aborted = false;
  private lastError?: string;
  private retryError?: string;
  /** pi's auto-retries since its last success — tags a failure so agent
   *  exec does not retry a 429 pi already retried (provider-limit.ts). */
  retries = 0;

  addUsage(u: PiMessageUsage): void {
    this.inputTokens += u.input;
    this.outputTokens += u.output;
    this.cacheReadTokens += u.cacheRead;
    this.cacheWriteTokens += u.cacheWrite;
    if (u.cost !== undefined) this.costUsd = (this.costUsd ?? 0) + u.cost;
  }

  /** Fold one parsed event in. `countUsage` false leaves usage to the
   *  caller (the rpc runner sums agent_end.messages instead). */
  observe(p: PiParsedLine, countUsage = true): void {
    const end = p.assistantEnd;
    if (end) {
      if (countUsage) this.addUsage(end.usage);
      this.aborted = end.stopReason === 'aborted';
      this.lastError =
        end.stopReason === 'error' ? end.errorMessage || 'pi reported an error' : undefined;
    }
    if (p.retryStart) this.retries += 1;
    if (p.retryEnd) this.retryError = p.retryEnd.success ? undefined : p.retryEnd.finalError;
    if (p.retryEnd?.success) this.retries = 0;
    if (p.settled || (p.agentEnd && p.agentEnd.willRetry === undefined)) this.settled = true;
  }

  /** The run's final failure, if it ended in one. */
  failure(): string | undefined {
    return this.retryError ?? this.lastError;
  }
}

/** Emulated max turns for one mailbox message (see header). */
export class PiTurnBudget {
  used = 0;
  hit = false;
  constructor(readonly max: number) {}

  /** Count a turn_start / auto_retry_start; true exactly once, when the
   *  turn that just started is past the cap and must be aborted. */
  observe(p: PiParsedLine): boolean {
    if (p.retryStart && this.used > 0) this.used -= 1;
    if (!p.turnStart) return false;
    this.used += 1;
    if (this.hit || !(this.max > 0) || this.used <= this.max) return false;
    this.hit = true;
    return true;
  }
}

/** computeSafeChunk's fence safety plus a trailing-whitespace holdback,
 *  diffed against what is already visible: the new increment (if any) and
 *  the new high-water mark. */
export function nextIncrement(
  totalRaw: string,
  visibleSoFar: string,
): { increment?: string; visibleSoFar: string } {
  const { chunk } = computeSafeChunk(totalRaw, 0);
  const trimmed = chunk.replace(/\s+$/, '');
  if (trimmed.length <= visibleSoFar.length) return { visibleSoFar };
  return { increment: trimmed.slice(visibleSoFar.length), visibleSoFar: trimmed };
}

/**
 * Visible assistant text of one pi invocation / rpc prompt round.
 * `partials` false (the org runtime): nothing streams; each message_end
 * yields that message's fence-stripped text. `partials` true (agent exec):
 * text_delta increments stream as they arrive, per contentIndex, reset on
 * each assistant message_start; messages join with '\n'.
 */
export class PiTextStream {
  private completed: string[] = [];
  private current = new Map<number, string>();
  private visible = '';
  constructor(private readonly partials: boolean) {}

  messageStart(): void {
    this.current = new Map();
  }

  delta(index: number, delta: string): string | undefined {
    this.current.set(index, (this.current.get(index) ?? '') + delta);
    if (!this.partials) return undefined;
    const cur = [...this.current.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([, t]) => t)
      .join('\n');
    return this.advance([...this.completed, cur]);
  }

  /** A completed assistant message's raw text (may be empty). */
  messageEnd(rawText: string): string | undefined {
    if (rawText) this.completed.push(rawText);
    this.current = new Map();
    if (!this.partials) return rawText.replace(TOOL_CALL_RE, '').trim() || undefined;
    return this.advance(this.completed);
  }

  /** Whatever of `rawText` (default: every completed message) has not been
   *  shown yet — the end-of-round reconciliation. */
  remainder(rawText = this.completed.join('\n')): string | undefined {
    const final = rawText.replace(TOOL_CALL_RE, '').trim();
    if (final.length <= this.visible.length) return undefined;
    const rest = final.slice(this.visible.length);
    this.visible = final;
    return rest;
  }

  /** Streaming only: the end-of-invocation remainder(). */
  flush(): string | undefined {
    return this.partials ? this.remainder() : undefined;
  }

  private advance(parts: string[]): string | undefined {
    const { increment, visibleSoFar } = nextIncrement(
      parts.filter(Boolean).join('\n'),
      this.visible,
    );
    this.visible = visibleSoFar;
    return increment;
  }
}
