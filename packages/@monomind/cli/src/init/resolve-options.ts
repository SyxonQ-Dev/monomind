/**
 * Pure `InitOptions` construction from `monomind init` flags. Split out of
 * init-action.ts so both the interactive action and the machine-readable
 * `--json` workspace-init path (commands/init-workspace.ts) compute options
 * from the same flags — a caller must not see `--minimal`/`--target`/etc.
 * behave differently just because it also passed `--json`.
 *
 * @module @monomind/cli/init/resolve-options
 */

import { VERSION } from '../index.js';
import { resolvePlatformId } from '../platform-adapters/registry.js';
import { MCP_FLOATING_PIN } from '../platform-adapters/renderers/mcp.js';
import type { PlatformId } from '../platform-adapters/types.js';
import type { CommandContext } from '../types.js';
import {
  DEFAULT_INIT_OPTIONS,
  FULL_INIT_OPTIONS,
  type InitOptions,
  MINIMAL_INIT_OPTIONS,
} from './index.js';
import { PACK_NAMES, parsePackList } from './packs.js';

export type ResolveInitOptionsResult =
  | { ok: true; options: InitOptions }
  | { ok: false; message: string };

/** Builds `InitOptions` for `targetDir` from `ctx.flags`. No I/O. */
export function resolveInitOptions(
  ctx: CommandContext,
  targetDir: string,
): ResolveInitOptionsResult {
  const force = ctx.flags.force as boolean;
  const minimal = ctx.flags.minimal as boolean;
  const full = ctx.flags.full as boolean;
  const skipClaude = ctx.flags['skip-claude'] as boolean;
  const onlyClaude = ctx.flags['only-claude'] as boolean;
  const requestedTarget = ctx.flags.target as string | undefined;
  const requestedPlatforms = ctx.flags.platform as string | undefined;
  const enablePlatformHooks = ctx.flags['enable-hooks'] === true;
  const noInstall = (ctx.flags['no-install'] || ctx.flags.noInstall) as boolean;
  // Absent (the default) pins to the running CLI (#419); bare `--pin` does the
  // same explicitly, `--pin <version>` pins to that version, and `--pin latest`
  // or `--no-pin` keep the floating `monomind@latest` command.
  const pinFlag = ctx.flags.pin;
  const pin =
    ctx.flags['no-pin'] === true
      ? MCP_FLOATING_PIN
      : pinFlag === true
        ? VERSION
        : typeof pinFlag === 'string'
          ? pinFlag
          : undefined;

  let options: InitOptions;

  if (minimal) {
    options = {
      ...MINIMAL_INIT_OPTIONS,
      targetDir,
      force,
      components: { ...MINIMAL_INIT_OPTIONS.components },
    };
  } else if (full) {
    options = {
      ...FULL_INIT_OPTIONS,
      targetDir,
      force,
      components: { ...FULL_INIT_OPTIONS.components },
    };
  } else {
    options = {
      ...DEFAULT_INIT_OPTIONS,
      targetDir,
      force,
      components: { ...DEFAULT_INIT_OPTIONS.components },
    };
  }

  // Opt-in packs on top of core (GH #411): `--packs a,b` or `--all-packs`.
  const packFlag = ctx.flags.packs;
  if (ctx.flags['all-packs'] === true || ctx.flags.allPacks === true) {
    options.packs = [...PACK_NAMES];
  } else if (typeof packFlag === 'string') {
    const parsed = parsePackList(packFlag);
    if (!parsed.ok) return { ok: false, message: parsed.message };
    options.packs = parsed.packs;
  }

  const legacyTargets = ['opencode', 'kimicode', 'codex'].filter(
    (name) => ctx.flags[name] === true,
  );
  const target =
    requestedTarget ||
    (onlyClaude ? 'claude' : legacyTargets.length === 1 ? legacyTargets[0] : 'all');
  const validTargets = new Set([
    'all',
    'claude',
    'antigravity',
    'opencode',
    'kimicode',
    'codex',
    'cline',
    'aider',
    'agents',
  ]);
  // Coder-mode runtimes (rev 20): only on request, so `--target all` (the
  // default) writes no .clinerules/ or .aider.conf.yml into every project.
  // `agents` (AGENTS.md only) is the opposite of all, never part of it.
  const optInTargets = new Set(['cline', 'aider', 'agents']);
  if (!validTargets.has(target)) {
    return { ok: false, message: `Unknown init target: ${target}` };
  }

  const selectedTargets = new Set(
    target === 'all'
      ? [...validTargets].filter((name) => name !== 'all' && !optInTargets.has(name))
      : [target],
  );
  let selectedPlatforms: PlatformId[];
  if (requestedPlatforms) {
    const requested = requestedPlatforms.split(',');
    const parsed = requested
      .map((value) => resolvePlatformId(value))
      .filter((value): value is PlatformId => value !== undefined);
    if (parsed.length === 0 || parsed.length !== requested.length) {
      return { ok: false, message: `Unknown init platform: ${requestedPlatforms}` };
    }
    selectedPlatforms = [...new Set(parsed)];
    selectedTargets.clear();
    if (selectedPlatforms.includes('claude')) selectedTargets.add('claude');
    if (selectedPlatforms.includes('antigravity')) selectedTargets.add('antigravity');
    if (selectedPlatforms.includes('opencode')) selectedTargets.add('opencode');
    if (selectedPlatforms.includes('kimi')) selectedTargets.add('kimicode');
    if (selectedPlatforms.includes('codex')) selectedTargets.add('codex');
  } else {
    const legacyToPlatform: Record<string, PlatformId> = {
      claude: 'claude',
      antigravity: 'antigravity',
      opencode: 'opencode',
      kimicode: 'kimi',
      codex: 'codex',
      aider: 'aider',
    };
    selectedPlatforms = [...selectedTargets]
      .map((legacy) => legacyToPlatform[legacy])
      .filter((value): value is PlatformId => value !== undefined);
  }

  // `--skip-claude` has always meant "leave Claude project artifacts out".
  // It must not erase an explicitly selected non-Claude adapter (the previous
  // component-only implementation silently did exactly that). Keep the
  // legacy target set and adapter selection in lockstep.
  if (skipClaude) {
    selectedTargets.delete('claude');
    selectedPlatforms = selectedPlatforms.filter((platform) => platform !== 'claude');
  }
  if (pin) options.mcp = { ...options.mcp, pin };
  options.selectedPlatforms = selectedPlatforms;
  options.enablePlatformHooks = enablePlatformHooks;
  options.components.antigravity = selectedTargets.has('antigravity');
  options.components.opencode = selectedTargets.has('opencode');
  options.components.kimicode = selectedTargets.has('kimicode');
  options.components.codex = selectedTargets.has('codex');
  options.components.cline = selectedTargets.has('cline');
  options.components.agentsOnly = selectedTargets.has('agents');
  options.components.mcp = selectedTargets.has('claude') || selectedTargets.has('antigravity');
  if (!selectedTargets.has('claude')) {
    options.components.settings = false;
    options.components.commands = false;
    options.components.agents = false;
    options.components.helpers = false;
    options.components.statusline = false;
    options.components.claudeMd = false;
  }

  if (skipClaude) {
    options.components.settings = false;
    options.components.skills = false;
    options.components.commands = false;
    options.components.agents = false;
    options.components.helpers = false;
    options.components.statusline = false;
    options.components.mcp = false;
    options.components.claudeMd = false;
  }

  if (onlyClaude) {
    options.components.runtime = false;
  }

  if (noInstall) {
    options.installClaudeCode = false;
  }

  // Memory is on by default and not tied to --start-all: every init except
  // --only-claude (runtime is off) and --no-memory creates the database.
  if (
    ctx.flags.memory === false ||
    ctx.flags['no-memory'] === true ||
    ctx.flags.noMemory === true
  ) {
    options.initMemory = false;
  }

  // `--if-missing` (#358): create only files that don't exist yet; never
  // touch an existing CLAUDE.md/AGENTS.md/settings.json/etc.
  if (ctx.flags['if-missing'] === true || ctx.flags.ifMissing === true) {
    options.ifMissing = true;
  }

  // `--no-graph` (#358): skip the Monograph code-graph build, the slowest
  // step of init — a coder workspace wants to be ready in a few seconds.
  if (ctx.flags['no-graph'] === true || ctx.flags.noGraph === true) {
    options.components.monograph = false;
  }

  return { ok: true, options };
}
