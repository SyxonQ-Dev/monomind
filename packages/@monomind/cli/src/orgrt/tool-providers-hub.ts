// packages/@monomind/cli/src/orgrt/tool-providers-hub.ts
import type { OrgToolDef } from './agent-runner.js';
import type { OrgBus } from './bus.js';
import type { ChainTrace } from './tool-providers.js';
import { McpStdioClient, type McpToolInfo } from './tool-providers-client.js';
import {
  configHash,
  normalizeProvider,
  type ProviderContext,
  ProviderProcess,
  providerEnv,
  providerPrefix,
} from './tool-providers-process.js';
import { jsonSchemaCatchall, jsonSchemaToZodShape } from './tool-providers-schema.js';
import type { ToolProviderConfig } from './types.js';

export interface RoleProviderToolSet {
  tools: OrgToolDef[];
  /** Kill every provider process this session started. Idempotent. */
  close(): void;
  /** Live provider pids by provider name (tests / diagnostics). */
  pids(): Record<string, number | undefined>;
}

/** Daemon-lifetime owner of provider tool-list caches and live processes. */
export class ToolProviderHub {
  private listCache = new Map<string, Promise<McpToolInfo[]>>();
  private sessions = new Map<string, Set<RoleProviderToolSet>>();

  /** tools/list for one provider config — cached per config hash. A failed
   *  listing is evicted so the next session start retries it. */
  listTools(p: ToolProviderConfig, ctx: ProviderContext, cwd?: string): Promise<McpToolInfo[]> {
    const cfg = normalizeProvider(p);
    const key = configHash(cfg);
    const cached = this.listCache.get(key);
    if (cached) return cached;
    const promise = (async () => {
      const client = new McpStdioClient({
        command: cfg.command,
        args: cfg.args,
        env: providerEnv(cfg, ctx),
        cwd,
      });
      try {
        await client.start();
        const tools = await client.listTools();
        return cfg.allow ? tools.filter((t) => cfg.allow?.includes(t.name)) : tools;
      } finally {
        client.close();
      }
    })();
    this.listCache.set(key, promise);
    promise.catch(() => {
      if (this.listCache.get(key) === promise) this.listCache.delete(key);
    });
    return promise;
  }

  /** Build the provider tools for one role session. Providers whose tool list
   *  cannot be fetched are skipped with an `audit` event — a broken provider
   *  must not take the whole role down. */
  async buildRoleTools(opts: {
    ctx: ProviderContext;
    providers: ToolProviderConfig[];
    trace: () => ChainTrace;
    bus?: OrgBus;
    cwd?: string;
    reservedNames?: Set<string>;
  }): Promise<RoleProviderToolSet> {
    const { ctx, bus } = opts;
    const procs: ProviderProcess[] = [];
    const tools: OrgToolDef[] = [];
    const seen = new Set(opts.reservedNames ?? []);
    for (const raw of opts.providers) {
      const cfg = normalizeProvider(raw);
      let listed: McpToolInfo[];
      try {
        listed = await this.listTools(cfg, ctx, opts.cwd);
      } catch (err) {
        bus?.emit({
          type: 'audit',
          from: ctx.role,
          reason: 'tool-provider-list-failed',
          msg: `tool provider ${cfg.name}: could not list tools — ${err instanceof Error ? err.message : String(err)}`,
          data: { provider: cfg.name },
        });
        continue;
      }
      const proc = new ProviderProcess(cfg, ctx, opts.cwd, bus);
      procs.push(proc);
      const prefix = providerPrefix(cfg);
      for (const t of listed) {
        const exposed = `${prefix}__${t.name}`;
        if (seen.has(exposed)) continue;
        seen.add(exposed);
        tools.push({
          name: exposed,
          description: t.description || `Tool "${t.name}" from tool provider ${cfg.name}.`,
          schema: jsonSchemaToZodShape(t.inputSchema),
          catchall: jsonSchemaCatchall(t.inputSchema),
          handler: async (args) => ({
            text: await proc.call(t.name, args, {
              org: ctx.org,
              run: ctx.run,
              role: ctx.role,
              ...opts.trace(),
            }),
          }),
        });
      }
    }
    let closed = false;
    const set: RoleProviderToolSet = {
      tools,
      close: () => {
        if (closed) return;
        closed = true;
        for (const p of procs) p.close();
        this.sessions.get(ctx.org)?.delete(set);
      },
      pids: () => Object.fromEntries(procs.map((p) => [p.cfg.name, p.pid])),
    };
    if (procs.length > 0) {
      const forOrg = this.sessions.get(ctx.org) ?? new Set();
      forOrg.add(set);
      this.sessions.set(ctx.org, forOrg);
    }
    return set;
  }

  /** Kill every provider process of every live session of `org`. */
  closeOrg(org: string): void {
    const forOrg = this.sessions.get(org);
    if (!forOrg) return;
    for (const s of [...forOrg]) s.close();
    this.sessions.delete(org);
  }

  closeAll(): void {
    for (const org of [...this.sessions.keys()]) this.closeOrg(org);
  }
}
