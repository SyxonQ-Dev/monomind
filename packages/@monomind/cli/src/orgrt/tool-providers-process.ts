// packages/@monomind/cli/src/orgrt/tool-providers-process.ts
import { createHash } from 'node:crypto';
import type { OrgBus } from './bus.js';
import { omitAnthropicManagedKeys } from './provider.js';
import { mapToolResult, type ToolCallTrace } from './tool-providers.js';
import { McpRpcError, McpStdioClient, McpTimeoutError } from './tool-providers-client.js';
import type { OrgRole, ToolProviderConfig } from './types.js';

// ── Provider config helpers ──────────────────────────────────────────────

export interface ProviderContext {
  org: string;
  run: string;
  role: string;
  /** Daemon project root. */
  root: string;
}

export function providerPrefix(p: Pick<ToolProviderConfig, 'name' | 'prefix'>): string {
  return p.prefix ?? p.name.replace(/-/g, '_');
}

/** Tool-name prefixes (`<prefix>__`) a role's providers contribute. */
export function roleProviderPrefixes(role: Pick<OrgRole, 'tool_providers'>): string[] {
  return (role.tool_providers ?? []).map((p) => `${providerPrefix(p)}__`);
}

export function providerEnv(p: ToolProviderConfig, ctx: ProviderContext): Record<string, string> {
  // o-20 (folded into o-18): `p.command` is an arbitrary user-configured
  // tool-provider binary — an unbounded target set, unlike the 13 known
  // vendor CLIs o-18 fixed at their own spawn boundaries. No such binary has
  // a legitimate use for an AMBIENT/inherited Anthropic credential; an
  // explicit value in the provider's OWN `env` config still wins below
  // (Object.assign runs after), the same ambient-vs-explicit split o-18
  // applies at every runner's spawn boundary.
  const env: Record<string, string> = omitAnthropicManagedKeys(process.env);
  Object.assign(env, p.env ?? {});
  env.MONOMIND_ORG_NAME = ctx.org;
  env.MONOMIND_ORG_RUN = ctx.run;
  env.MONOMIND_ORG_ROLE = ctx.role;
  env.MONOMIND_ORG_ROOT = ctx.root;
  return env;
}

export function configHash(p: ToolProviderConfig): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        command: p.command,
        args: p.args ?? [],
        env: p.env ?? {},
        allow: p.allow ?? null,
      }),
    )
    .digest('hex');
}

/** Fill schema defaults for a provider entry that did not come through
 *  RoleSchema.parse (e.g. a hot-reloaded or hand-built role). */
export function normalizeProvider(
  p: ToolProviderConfig,
): Required<Pick<ToolProviderConfig, 'args' | 'env' | 'timeout_ms' | 'idle_ms'>> &
  ToolProviderConfig {
  return {
    ...p,
    args: p.args ?? [],
    env: p.env ?? {},
    timeout_ms: p.timeout_ms ?? 660_000,
    idle_ms: p.idle_ms ?? 300_000,
  };
}

// ── Per-session provider process ─────────────────────────────────────────

/** One provider's call-side process for one role session. */
export class ProviderProcess {
  private client?: McpStdioClient;
  private starting?: Promise<McpStdioClient>;
  private idleTimer?: ReturnType<typeof setTimeout>;
  private inflight = 0;
  private crashes = 0;
  private lastCrash = '';
  private closed = false;

  constructor(
    readonly cfg: ReturnType<typeof normalizeProvider>,
    private ctx: ProviderContext,
    private cwd: string | undefined,
    private bus?: OrgBus,
  ) {}

  get pid(): number | undefined {
    return this.client && !this.client.exited ? this.client.pid : undefined;
  }

  private unavailable(reason: string): string {
    return `ERROR: tool provider ${this.cfg.name} unavailable: ${reason}`;
  }

  private ensure(): Promise<McpStdioClient> {
    if (this.client && !this.client.exited) return Promise.resolve(this.client);
    if (this.starting) return this.starting;
    // Restart once per session after a crash; a second crash is final.
    if (this.crashes >= 2) return Promise.reject(new Error(this.lastCrash));
    const client = new McpStdioClient({
      command: this.cfg.command,
      args: this.cfg.args,
      env: providerEnv(this.cfg, this.ctx),
      cwd: this.cwd,
    });
    let counted = false;
    client.onExit = (reason, deliberate) => {
      if (this.client === client) this.client = undefined;
      if (deliberate) return;
      counted = true;
      this.crashes++;
      this.lastCrash = reason;
      this.bus?.emit({
        type: 'audit',
        from: this.ctx.role,
        reason: 'tool-provider-crashed',
        msg: `tool provider ${this.cfg.name} ${reason}${this.crashes >= 2 ? ' — not restarting again this session' : ' — restarting on next call'}`,
        data: { provider: this.cfg.name, crashes: this.crashes },
      });
    };
    this.starting = client
      .start()
      .then(() => {
        this.client = client;
        return client;
      })
      .catch((err: Error) => {
        client.close();
        // A start failure that did not surface as a process exit (e.g. an
        // initialize timeout) still counts against the restart budget.
        if (!counted) {
          this.crashes++;
          this.lastCrash = err.message;
        }
        throw err;
      })
      .finally(() => {
        this.starting = undefined;
      });
    return this.starting;
  }

  async call(tool: string, args: Record<string, unknown>, trace: ToolCallTrace): Promise<string> {
    if (this.closed) return this.unavailable('session ended');
    let client: McpStdioClient;
    try {
      client = await this.ensure();
    } catch (err) {
      return this.unavailable(err instanceof Error ? err.message : String(err));
    }
    this.inflight++;
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = undefined;
    try {
      const res = await client.request(
        'tools/call',
        { name: tool, arguments: args ?? {}, _meta: { trace } },
        this.cfg.timeout_ms,
      );
      return mapToolResult(res);
    } catch (err) {
      if (err instanceof McpRpcError) return `ERROR: ${err.message}`;
      if (err instanceof McpTimeoutError)
        return `ERROR: tool provider ${this.cfg.name}: ${tool} ${err.message}`;
      return this.unavailable(err instanceof Error ? err.message : String(err));
    } finally {
      this.inflight--;
      this.armIdle();
    }
  }

  private armIdle(): void {
    if (this.closed || this.inflight > 0) return;
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      this.idleTimer = undefined;
      if (this.inflight === 0) this.client?.close();
    }, this.cfg.idle_ms);
    this.idleTimer.unref?.();
  }

  close(): void {
    this.closed = true;
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = undefined;
    this.client?.close();
    this.client = undefined;
  }
}
