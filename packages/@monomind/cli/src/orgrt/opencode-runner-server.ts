// packages/@monomind/cli/src/orgrt/opencode-runner-server.ts
/**
 * The ephemeral `opencode serve` process OpencodeAgentRunner drives, plus
 * the full-access pieces that talk to it (coder mode on every runtime,
 * plan MM3). Split out of opencode-runner.ts to keep that file under the
 * project's 500-line cap.
 *
 * Full access (`args.access === 'full'`), verified against opencode 1.18.32:
 *  - `OPENCODE_PERMISSION` (JSON) is deep-merged into the loaded config's
 *    `permission` AFTER every other source (global, project opencode.json,
 *    .opencode/, OPENCODE_CONFIG_CONTENT, managed) — so it overrides only
 *    the permission rules and leaves the user's providers, MCP servers,
 *    agents and AGENTS.md alone. A bare `"allow"` string is NOT accepted
 *    there (the served config comes back broken), so the override is an
 *    object: `"*"` plus every built-in permission key, each set to `allow`
 *    so a user's own per-key rule (e.g. `bash: {"rm *": "ask"}`) is
 *    replaced rather than left after the wildcard (rules are last-match-
 *    wins). `question` stays `deny`: a headless turn has nobody to answer
 *    the question tool, which would otherwise block the turn.
 *  - Anything that still asks (an agent's own `permission`, a custom key)
 *    arrives as a `permission.asked` event and is answered `always` by
 *    `replyPermission` below.
 *  - The server is spawned through process-group-spawn.ts: in full mode it
 *    leads its own process group under the turn's `MONOMIND_EXEC_TREE`
 *    marker, so cancel reaches every shell its bash tool started and
 *    agent-exec.ts can report background pids, same as the Claude runner.
 */

import type { AgentRunArgs } from './agent-runner.js';
import { maskedCommand } from './authority-mask.js';
import { spawnRunnerProcess } from './process-group-spawn.js';
import { omitAnthropicManagedKeys } from './provider.js';

/** Built-in opencode permission keys (PermissionConfig, @opencode-ai/sdk v2
 *  types) forced to `allow` in full mode — see the module doc. */
const PERMISSION_KEYS = [
  'read',
  'edit',
  'glob',
  'grep',
  'list',
  'bash',
  'task',
  'external_directory',
  'todowrite',
  'webfetch',
  'websearch',
  'codesearch',
  'lsp',
  'doom_loop',
  'skill',
] as const;

export const FULL_ACCESS_PERMISSION: Record<string, 'allow' | 'deny'> = {
  '*': 'allow',
  ...Object.fromEntries(PERMISSION_KEYS.map((k) => [k, 'allow' as const])),
  question: 'deny',
};

/** How long the ephemeral server may take to print its listening line. The
 *  SDK's own default of 5s is too tight for a cold machine, and a timeout
 *  there crashes the role session. */
const SERVER_START_TIMEOUT_MS = 30_000;

export interface OpencodeServer {
  url: string;
  /** SIGTERM the server process itself (not its group): a normal end
   *  leaves background jobs running, like the Claude runner. */
  close(): void;
  /** Cancel target: the whole tracked tree in full mode, else the server. */
  target: { kill(signal?: NodeJS.Signals): void };
  /** Stop the full-mode tree sampling; call once when the run ends. */
  stop(): void;
}

/**
 * Start the ephemeral opencode server WITH THE ROLE'S SESSION ENV (#262).
 *
 * The SDK's `createOpencode()`/`createOpencodeServer()` spawn `opencode serve`
 * with the daemon's `process.env` and take no env option (`ServerOptions` is
 * `{hostname, port, signal, timeout, config}` — @opencode-ai/sdk 1.18.15), so
 * `args.env` never reached the process that runs the role's shell: provider
 * credentials, the #249 MONOMIND_* scoping and the #258 git guard all silently
 * failed to apply, and that shell had the operator's full git/GitHub access.
 * Spawning it here is codex-runner.ts's own `{ ...process.env, ...args.env }`
 * shape. An ATTACHED server (`OPENCODE_URL`) can't get the env — it is the
 * operator's own process; role-sandbox.ts audits it with `git-guard-unapplied`.
 */
export function startOpencodeServer(args: AgentRunArgs): Promise<OpencodeServer> {
  // Mirrors runner-registry.ts's OPENCODE_BIN override for this runtime.
  const bin = process.env.OPENCODE_BIN || 'opencode';
  const full = args.access === 'full';
  const proc = spawnRunnerProcess(
    ...maskedCommand(args.authorityMask, bin, ['serve', '--hostname=127.0.0.1', '--port=0']),
    {
      cwd: args.cwd,
      // o-18: ambient ANTHROPIC_* creds never belong to a non-Anthropic
      // vendor CLI; an explicit value in args.env still wins below (this is
      // the #262 path opencode-runner.test.ts's base-url provider test uses).
      env: {
        ...omitAnthropicManagedKeys(process.env),
        ...args.env,
        ...(full ? { OPENCODE_PERMISSION: JSON.stringify(FULL_ACCESS_PERMISSION) } : {}),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
    args,
  );
  const child = proc.child;
  // kill() on an exited child is a no-op (same as the SDK's own stop()).
  const close = () => void child.kill();
  return new Promise((resolve, reject) => {
    let out = '';
    let settled = false;
    const settle = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };
    const die = (what: string) =>
      settle(() => {
        close();
        proc.stop();
        reject(new Error(`OpencodeAgentRunner: opencode serve ${what}\n${out}`.trimEnd()));
      });
    const timer = setTimeout(() => die('did not start in time'), SERVER_START_TIMEOUT_MS);
    const onOutput = (c: Buffer) => {
      // The SDK reads the same line ("opencode server listening on <url>").
      out = (out + c.toString()).slice(-4000);
      const m = out.match(/opencode server listening on\s+(https?:\/\/\S+)/);
      if (m) settle(() => resolve({ url: m[1], close, target: proc.target, stop: proc.stop }));
    };
    child.stdout?.on('data', onOutput);
    child.stderr?.on('data', onOutput);
    child.on('error', (e: Error) => settle(() => reject(e)));
    child.on('exit', (code: number | null) => die(`exited with code ${code}`));
  });
}

/**
 * Full access: answer one permission request `always`. opencode 1.18 emits
 * `permission.asked` (`{id, sessionID, …}`) answered at
 * `POST /permission/{id}/reply`; older servers emitted `permission.updated`
 * answered at `POST /session/{sessionID}/permissions/{id}`. The v1 SDK
 * client this runner uses only knows the older route, so both go through
 * fetch. Best-effort: a failed reply leaves the request pending, which the
 * turn timeout still bounds.
 */
export async function replyPermission(
  baseUrl: string,
  directory: string,
  evType: string,
  props: { id?: string; sessionID?: string },
): Promise<void> {
  if (!props.id) return;
  const q = `?directory=${encodeURIComponent(directory)}`;
  const [path, body] =
    evType === 'permission.asked'
      ? [`/permission/${encodeURIComponent(props.id)}/reply`, { reply: 'always' }]
      : [
          `/session/${encodeURIComponent(props.sessionID ?? '')}/permissions/${encodeURIComponent(props.id)}`,
          { response: 'always' },
        ];
  try {
    await fetch(`${baseUrl.replace(/\/+$/, '')}${path}${q}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-opencode-directory': directory,
      },
      body: JSON.stringify(body),
    });
  } catch {
    /* best-effort — see above */
  }
}

/** `off` has no variant of that name; the closest opencode variants. */
const EFFORT_VARIANTS: Record<string, string[]> = { off: ['none', 'minimal'] };

/**
 * `AgentRunArgs.effort` → an opencode model variant (its per-model reasoning
 * presets — `opencode run --variant`, the prompt body's `variant`). Only a
 * variant the target model actually lists is returned: the model is
 * `args.model` or the served config's `model`, looked up in
 * `config.providers()` (each model's `variants` keys, e.g. low/medium/high/
 * xhigh/max). Undefined when the model or the variant can't be resolved —
 * the turn then runs at the model's default.
 */
export async function resolveEffortVariant(
  client: any,
  model: string | undefined,
  effort: string | undefined,
): Promise<string | undefined> {
  if (!effort) return undefined;
  try {
    let target = model;
    if (!target) {
      const cfg = await client.config.get();
      target = (cfg?.data ?? cfg)?.model;
    }
    const slash = target?.indexOf('/') ?? -1;
    if (!target || slash < 0) return undefined;
    const providerID = target.slice(0, slash);
    const modelID = target.slice(slash + 1);
    const res = await client.config.providers();
    const providers: any[] = (res?.data ?? res)?.providers ?? [];
    const variants = providers.find((p) => p?.id === providerID)?.models?.[modelID]?.variants;
    if (!variants || typeof variants !== 'object') return undefined;
    return (EFFORT_VARIANTS[effort] ?? [effort]).find((v) => v in variants);
  } catch {
    return undefined;
  }
}

/** Race a promise against a wall-clock timeout. */
export function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(
      () =>
        reject(
          new Error(
            `OpencodeAgentRunner: ${label} exceeded the ${Math.round(ms / 60000)}min turn timeout`,
          ),
        ),
      ms,
    );
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}
