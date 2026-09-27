// packages/@monomind/cli/src/orgrt/tool-providers-client.ts
import { type ChildProcess, spawn } from 'node:child_process';

export const MCP_PROTOCOL_VERSION = '2025-06-18';
const LIST_TIMEOUT_MS = 30_000;
const STDERR_TAIL = 2_000;

// ── Stdio JSON-RPC client ────────────────────────────────────────────────

export class McpRpcError extends Error {
  constructor(
    message: string,
    readonly code?: number,
  ) {
    super(message);
  }
}
export class McpTimeoutError extends Error {}

export interface McpToolInfo {
  name: string;
  description?: string;
  inputSchema?: unknown;
}

export interface McpSpawnSpec {
  command: string;
  args: string[];
  env: Record<string, string>;
  cwd?: string;
}

type Pending = {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  timer?: ReturnType<typeof setTimeout>;
};

/** Minimal MCP client over a child process's stdio (newline-delimited JSON). */
export class McpStdioClient {
  private child?: ChildProcess;
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private buf = '';
  private stderrTail = '';
  private closing = false;
  exited = false;
  exitReason?: string;
  /** Called once when the process goes away; `deliberate` = close() was called. */
  onExit?: (reason: string, deliberate: boolean) => void;

  constructor(private spec: McpSpawnSpec) {}

  get pid(): number | undefined {
    return this.child?.pid;
  }

  async start(timeoutMs = LIST_TIMEOUT_MS): Promise<void> {
    let child: ChildProcess;
    try {
      child = spawn(this.spec.command, this.spec.args, {
        env: this.spec.env,
        cwd: this.spec.cwd,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (err) {
      this.fail(`spawn failed: ${err instanceof Error ? err.message : String(err)}`);
      throw new Error(this.exitReason);
    }
    this.child = child;
    child.on('error', (err) => this.fail(`spawn failed: ${err.message}`));
    child.on('exit', (code, signal) => {
      const tail = this.stderrTail.trim().split('\n').slice(-3).join(' | ');
      this.fail(
        `process exited (${signal ? `signal ${signal}` : `code ${code}`})${tail ? `: ${tail}` : ''}`,
      );
    });
    child.stdin?.on('error', () => {
      /* EPIPE after exit — surfaced through the exit handler */
    });
    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => this.onData(chunk));
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk: string) => {
      this.stderrTail = (this.stderrTail + chunk).slice(-STDERR_TAIL);
    });
    await this.request(
      'initialize',
      {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: 'monomind-org', version: '1.0.0' },
      },
      timeoutMs,
    );
    this.notify('notifications/initialized');
  }

  request(method: string, params: unknown, timeoutMs: number): Promise<unknown> {
    if (this.exited) return Promise.reject(new Error(this.exitReason ?? 'process not running'));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const entry: Pending = { resolve, reject };
      entry.timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new McpTimeoutError(`${method} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      (entry.timer as { unref?: () => void }).unref?.();
      this.pending.set(id, entry);
      this.write({ jsonrpc: '2.0', id, method, params });
    });
  }

  notify(method: string, params?: unknown): void {
    this.write({ jsonrpc: '2.0', method, ...(params !== undefined ? { params } : {}) });
  }

  async listTools(timeoutMs = LIST_TIMEOUT_MS): Promise<McpToolInfo[]> {
    const tools: McpToolInfo[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 100; page++) {
      const res = (await this.request('tools/list', cursor ? { cursor } : {}, timeoutMs)) as {
        tools?: McpToolInfo[];
        nextCursor?: string;
      };
      for (const t of res?.tools ?? []) if (t && typeof t.name === 'string') tools.push(t);
      cursor = typeof res?.nextCursor === 'string' && res.nextCursor ? res.nextCursor : undefined;
      if (!cursor) break;
    }
    return tools;
  }

  /** Deliberate shutdown: SIGTERM, SIGKILL after 2 s. */
  close(): void {
    if (this.exited) return;
    this.closing = true;
    const child = this.child;
    try {
      child?.stdin?.end();
    } catch {
      /* already closed */
    }
    try {
      child?.kill('SIGTERM');
    } catch {
      /* already gone */
    }
    const t = setTimeout(() => {
      try {
        if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      } catch {
        /* already gone */
      }
    }, 2_000);
    t.unref?.();
    this.fail('closed');
  }

  private write(msg: unknown): void {
    try {
      this.child?.stdin?.write(`${JSON.stringify(msg)}\n`);
    } catch {
      /* surfaced through exit */
    }
  }

  private onData(chunk: string): void {
    this.buf += chunk;
    let nl = this.buf.indexOf('\n');
    while (nl !== -1) {
      const line = this.buf.slice(0, nl).trim();
      this.buf = this.buf.slice(nl + 1);
      if (line) this.onLine(line);
      nl = this.buf.indexOf('\n');
    }
  }

  private onLine(line: string): void {
    let msg: {
      id?: number | string;
      method?: string;
      result?: unknown;
      error?: { code?: number; message?: string };
    };
    try {
      msg = JSON.parse(line);
    } catch {
      return; // not JSON-RPC (stray log line) — ignore
    }
    if (msg.method !== undefined) {
      // Server → client request: answer ping, refuse the rest. Notifications ignored.
      if (msg.id !== undefined) {
        if (msg.method === 'ping') this.write({ jsonrpc: '2.0', id: msg.id, result: {} });
        else
          this.write({
            jsonrpc: '2.0',
            id: msg.id,
            error: { code: -32601, message: `method not supported: ${msg.method}` },
          });
      }
      return;
    }
    if (typeof msg.id !== 'number') return;
    const p = this.pending.get(msg.id);
    if (!p) return;
    this.pending.delete(msg.id);
    if (p.timer) clearTimeout(p.timer);
    if (msg.error) p.reject(new McpRpcError(msg.error.message ?? 'MCP error', msg.error.code));
    else p.resolve(msg.result);
  }

  private fail(reason: string): void {
    if (this.exited) return;
    this.exited = true;
    this.exitReason = reason;
    for (const p of this.pending.values()) {
      if (p.timer) clearTimeout(p.timer);
      p.reject(new Error(reason));
    }
    this.pending.clear();
    this.onExit?.(reason, this.closing);
  }
}
