// packages/@monomind/cli/src/orgrt/agent-exec-bridge.ts
import type { Readable } from 'node:stream';
import type { AgentMessage } from './agent-runner.js';

// ─── stdio frame bridge (§4.3) ──────────────────────────────────────────────

interface PendingCall {
  settle: (text: string) => void;
  timer: NodeJS.Timeout;
}

export class StdioToolBridge {
  private pending = new Map<string, PendingCall>();
  private counter = 0;
  private closed = false;
  private buffer = '';
  private stopped = false;

  constructor(
    private stdin: Readable,
    private toolTimeoutMs: number,
    private emit: (ev: Record<string, unknown>) => void,
    /** Invoked synchronously on a cancel frame — wired to terminate(). */
    private onCancel?: () => void,
  ) {}

  start(): void {
    this.stdin.setEncoding('utf8');
    this.stdin.on('data', (chunk: string) => {
      if (this.stopped) return;
      this.buffer += chunk;
      let nl: number;
      while ((nl = this.buffer.indexOf('\n')) !== -1) {
        const line = this.buffer.slice(0, nl).trim();
        this.buffer = this.buffer.slice(nl + 1);
        if (line) this.handleLine(line);
      }
    });
    this.stdin.on('end', () => {
      // §4.3: EOF fails every pending call and disables further bridging.
      this.closed = true;
      for (const [id, p] of this.pending) {
        clearTimeout(p.timer);
        p.settle('ERROR: caller closed stdin');
        this.pending.delete(id);
      }
    });
    this.stdin.on('error', () => {
      this.closed = true;
    });
  }

  private handleLine(line: string): void {
    let frame: any;
    try {
      frame = JSON.parse(line);
    } catch {
      this.emit({
        v: 1,
        type: 'error',
        code: 'bad-frame',
        fatal: false,
        message: `unparseable stdin frame: ${line.slice(0, 120)}`,
      });
      return;
    }
    if (frame?.type === 'cancel') {
      this.cancelRequested = true;
      this.onCancel?.();
      return;
    }
    if (frame?.type === 'tool_result' && typeof frame.id === 'string') {
      const p = this.pending.get(frame.id);
      if (!p) {
        this.emit({
          v: 1,
          type: 'error',
          code: 'bad-frame',
          fatal: false,
          message: `tool_result for unknown or expired id "${frame.id}"`,
        });
        return;
      }
      clearTimeout(p.timer);
      this.pending.delete(frame.id);
      const text =
        frame.result && typeof frame.result === 'object' && typeof frame.result.text === 'string'
          ? frame.result.text
          : typeof frame.result === 'string'
            ? frame.result
            : JSON.stringify(frame.result ?? '');
      p.settle(frame.ok === false ? `ERROR: ${text}` : text);
      return;
    }
    this.emit({
      v: 1,
      type: 'error',
      code: 'bad-frame',
      fatal: false,
      message: `unrecognized stdin frame type: ${String(frame?.type ?? '(none)')}`,
    });
  }

  /** Set when the caller sends a cancel frame; polled by the engine loop. */
  cancelRequested = false;

  /** Invoke a tool on the caller: emit tool_call, await tool_result, echo it. */
  call(name: string, args: Record<string, unknown>): Promise<{ text: string }> {
    if (this.closed) return Promise.resolve({ text: 'ERROR: caller closed stdin' });
    const id = `tc_${++this.counter}`;
    return new Promise((resolve) => {
      const settle = (text: string) => {
        this.pending.delete(id);
        this.emit({
          v: 1,
          type: 'tool_result',
          id,
          ok: !text.startsWith('ERROR:'),
          result: { text },
        });
        resolve({ text });
      };
      const timer = setTimeout(() => settle('ERROR: tool timeout'), this.toolTimeoutMs);
      this.pending.set(id, { timer, settle });
      this.emit({ v: 1, type: 'tool_call', id, name, args });
    });
  }

  /** Stop reading; fail anything still pending. */
  stop(): void {
    this.stopped = true;
    this.closed = true;
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.settle('ERROR: exec terminated');
    }
    this.pending.clear();
  }
}

// ─── usage accounting (cumulative→delta, session.ts parity) ────────────────

export class UsageTracker {
  private cumulative = new Map<string, { in: number; out: number; usd: number | null }>();
  /** Running sum of every delta; `usd` stays null until a cost is reported. */
  readonly total: { in: number; out: number; usd: number | null } = { in: 0, out: 0, usd: null };
  /** `usd` is null when the runner reported no cost (unknown, never $0):
   *  a missing or non-finite `cost_usd` stays null instead of becoming 0. */
  delta(m: AgentMessage): { in: number; out: number; usd: number | null } {
    const key = m.session_id ?? '';
    const prev = this.cumulative.get(key) ?? { in: 0, out: 0, usd: null };
    const usd = typeof m.cost_usd === 'number' && Number.isFinite(m.cost_usd) ? m.cost_usd : null;
    const cur = { in: m.input_tokens ?? 0, out: m.output_tokens ?? 0, usd };
    // Runners that report per-turn (not cumulative) usage would produce
    // negatives under naive differencing; treat decreasing totals as fresh.
    const d = {
      in: Math.max(0, cur.in - prev.in),
      out: Math.max(0, cur.out - prev.out),
      usd: usd === null ? null : Math.max(0, usd - (prev.usd ?? 0)),
    };
    // An unknown cost keeps the last known cumulative figure as the base.
    this.cumulative.set(key, { ...cur, usd: usd ?? prev.usd });
    this.total.in += d.in;
    this.total.out += d.out;
    if (d.usd !== null) this.total.usd = (this.total.usd ?? 0) + d.usd;
    return d;
  }
}
