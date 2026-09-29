// packages/@monomind/cli/src/orgrt/dsh-runner-models.ts
/**
 * Model routing for DshAgentRunner (dsh-runner.ts): which dsh provider route a
 * model option names, the curated model list (dsh has no listing command —
 * its picker is the web Models page), and the `llm-pi-ai` row that turns a
 * pi-ai route on for one run. Pure; no I/O.
 *
 * Model option: a bare id (`deepseek-v4-pro`) keeps the profile's provider;
 * `<route>/<model>` picks a route first (`openrouter/z-ai/glm-5.2:free`), the
 * way opencode's option reads. Only a known route counts as a prefix, since
 * pi-ai model ids contain slashes themselves (`z-ai/glm-5.2:free`).
 *
 * Free models (live-checked 2026-09-29, dsh 0.1.7-rc.2, pi-ai catalog in the
 * package): dsh's own routes are paid, but its bundled pi-ai adapter reaches
 * zero-cost catalog models on two routes, each needing only a free account key:
 *   - openrouter (`:free` models, OPENROUTER_API_KEY)
 *   - nvidia (NVIDIA's API catalog, NVIDIA_API_KEY) — incl. DeepSeek V4
 *     Flash/Pro, so a free key runs dsh on DeepSeek models.
 * OpenCode Zen's free models are in the catalog too but are not listed: Zen
 * answers `FreeTierError: OpenCode's free tier can only be used from within
 * OpenCode` to any other client (checked live).
 *
 * The llm-pi-ai adapter mounts dormant (no routes) until its config names a
 * provider. A `--patch` REPLACES a row's whole config (checked with
 * `--dump-config`), so the row is built from the dumped config with the
 * route added — the user's other Models-page routes stay — and left out
 * entirely when the route is already configured. `apiKeyEnv` makes a missing
 * key a named MISSING_CREDENTIAL (resolved from the env or dsh's credential
 * store) instead of pi-ai's bare "Provider is not configured". Checked against
 * a local OpenAI-compatible mock: dsh sent `model: z-ai/glm-5.2:free` with
 * `Bearer $OPENROUTER_API_KEY` and `reasoning.effort`.
 */

import type { AgentModel } from './agent-models.js';
import type { OrgEffortLevel } from './cost-tier.js';

/** dsh's own DeepSeek routes (dsh-llm-deepseek, dsh-llm-deepseek-account). */
export const DSH_NATIVE_ROUTES = ['deepseek-official', 'deepseek-account'] as const;

/** pi-ai routes → the env var pi-ai reads the key from (pi-ai
 *  env-api-keys.js). `null`: the route authenticates another way (OAuth
 *  sign-in, cloud credentials), so no `apiKeyEnv` is written. */
const PI_AI_ROUTE_KEYS: Record<string, string | null> = {
  'amazon-bedrock': null,
  anthropic: null,
  'github-copilot': null,
  'openai-codex': null,
  'ant-ling': 'ANT_LING_API_KEY',
  'azure-openai-responses': 'AZURE_OPENAI_API_KEY',
  baseten: 'BASETEN_API_KEY',
  cerebras: 'CEREBRAS_API_KEY',
  'cloudflare-ai-gateway': 'CLOUDFLARE_API_KEY',
  'cloudflare-workers-ai': 'CLOUDFLARE_API_KEY',
  deepseek: 'DEEPSEEK_API_KEY',
  fireworks: 'FIREWORKS_API_KEY',
  google: 'GEMINI_API_KEY',
  'google-vertex': 'GOOGLE_CLOUD_API_KEY',
  groq: 'GROQ_API_KEY',
  huggingface: 'HF_TOKEN',
  'kimi-coding': 'KIMI_API_KEY',
  minimax: 'MINIMAX_API_KEY',
  'minimax-cn': 'MINIMAX_CN_API_KEY',
  mistral: 'MISTRAL_API_KEY',
  moonshotai: 'MOONSHOT_API_KEY',
  'moonshotai-cn': 'MOONSHOT_API_KEY',
  nvidia: 'NVIDIA_API_KEY',
  openai: 'OPENAI_API_KEY',
  opencode: 'OPENCODE_API_KEY',
  'opencode-go': 'OPENCODE_API_KEY',
  openrouter: 'OPENROUTER_API_KEY',
  together: 'TOGETHER_API_KEY',
  'vercel-ai-gateway': 'AI_GATEWAY_API_KEY',
  xai: 'XAI_API_KEY',
  xiaomi: 'XIAOMI_API_KEY',
  zai: 'ZAI_API_KEY',
  'zai-coding-cn': 'ZAI_CODING_CN_API_KEY',
};

export const isDshNativeRoute = (route: string): boolean =>
  (DSH_NATIVE_ROUTES as readonly string[]).includes(route);

/** Split a model option into route + model id; `provider` is undefined for
 *  a bare id (the profile's current route applies). */
export function dshSplitModel(option: string): { provider?: string; model: string } {
  const slash = option.indexOf('/');
  if (slash > 0) {
    const route = option.slice(0, slash);
    const model = option.slice(slash + 1);
    if (model && (isDshNativeRoute(route) || route in PI_AI_ROUTE_KEYS)) {
      return { provider: route, model };
    }
  }
  return { model: option };
}

// ── curated list ─────────────────────────────────────────────────────────

/** pi-ai's level order (models.js EXTENDED_THINKING_LEVELS). */
const LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const;

export interface DshModel extends AgentModel {
  /** Zero-cost in the catalog: needs only a free account key (`key_env`). */
  free?: boolean;
  /** The env var (or dsh credential-store entry) the route's key comes from. */
  key_env: string;
}

const deepseek = (id: string, label: string, def = false): DshModel => ({
  id,
  label,
  ...(def ? { default: true } : {}),
  effort_levels: ['off', 'low', 'high', 'max'],
  key_env: 'DEEPSEEK_API_KEY',
});

const free = (route: string, model: string, label: string, levels: string[]): DshModel => ({
  id: `${route}/${model}`,
  label: `${label} (free)`,
  free: true,
  effort_levels: levels,
  key_env: PI_AI_ROUTE_KEYS[route] as string,
});

/** Levels are pi-ai's getSupportedThinkingLevels over each catalog entry. */
export const DSH_MODELS: DshModel[] = [
  deepseek('deepseek-flash', 'DeepSeek V4.1 Flash', true),
  deepseek('deepseek-v4-pro', 'DeepSeek V4 Pro'),
  free('nvidia', 'deepseek-ai/deepseek-v4-flash-0731', 'DeepSeek V4 Flash via NVIDIA', [
    'off',
    'high',
    'max',
  ]),
  free('nvidia', 'deepseek-ai/deepseek-v4-pro-0813', 'DeepSeek V4 Pro via NVIDIA', [
    'off',
    'high',
    'max',
  ]),
  free('nvidia', 'moonshotai/kimi-k3', 'Kimi K3 via NVIDIA', [
    'off',
    'minimal',
    'low',
    'medium',
    'high',
  ]),
  free('openrouter', 'z-ai/glm-5.2:free', 'GLM 5.2 via OpenRouter', ['off', 'high', 'xhigh']),
  free('openrouter', 'minimax/minimax-m3:free', 'MiniMax M3 via OpenRouter', [
    'off',
    'minimal',
    'low',
    'medium',
    'high',
  ]),
  free('openrouter', 'nvidia/nemotron-3-ultra-550b-a55b:free', 'Nemotron 3 Ultra via OpenRouter', [
    'off',
    'medium',
    'high',
  ]),
  free('openrouter', 'poolside/laguna-s-2.1:free', 'Laguna S 2.1 via OpenRouter', [
    'off',
    'minimal',
    'low',
    'medium',
    'high',
  ]),
  free('openrouter', 'openrouter/free', 'OpenRouter free-models router', [
    'off',
    'minimal',
    'low',
    'medium',
    'high',
  ]),
];

/** The curated entry for a route + model, if any. */
export function dshCuratedModel(provider: string, model: string): DshModel | undefined {
  const id = isDshNativeRoute(provider) ? model : `${provider}/${model}`;
  return DSH_MODELS.find((m) => m.id === id);
}

/** A level the model supports: the requested one, else the nearest above,
 *  else the nearest below (pi-ai's clampThinkingLevel). */
export function clampEffort(levels: readonly string[], effort: string): string {
  if (levels.includes(effort)) return effort;
  const at = (LEVELS as readonly string[]).indexOf(effort);
  if (at >= 0) {
    for (let i = at + 1; i < LEVELS.length; i++) if (levels.includes(LEVELS[i])) return LEVELS[i];
    for (let i = at - 1; i >= 0; i--) if (levels.includes(LEVELS[i])) return LEVELS[i];
  }
  return levels[0] ?? effort;
}

/** DeepSeek's own efforts are off|low|high|max (dsh-llm-deepseek): `medium`
 *  maps to dsh's default `high`, `xhigh` to `max`. A curated pi-ai model
 *  clamps to its own levels; any other pi-ai model takes the level verbatim
 *  (pi-ai shares monomind's names; dsh names an unsupported one). */
const DEEPSEEK_EFFORT: Record<OrgEffortLevel, string> = {
  off: 'off',
  low: 'low',
  medium: 'high',
  high: 'high',
  xhigh: 'max',
  max: 'max',
};

export function dshEffortFor(provider: string, model: string, effort: OrgEffortLevel): string {
  if (provider.startsWith('deepseek-')) return DEEPSEEK_EFFORT[effort];
  const curated = dshCuratedModel(provider, model);
  return curated?.effort_levels ? clampEffort(curated.effort_levels, effort) : effort;
}

// ── llm-pi-ai row ────────────────────────────────────────────────────────

/** The config lines (4+ spaces) of one row in `--dump-config` output;
 *  undefined when the row is missing or has no config. */
function dumpedConfigLines(dump: string, id: string): string[] | undefined {
  const lines = dump.split('\n');
  const start = lines.findIndex((l) => new RegExp(`^- id: ['"]?${id}['"]?\\s*$`).test(l));
  if (start < 0) return undefined;
  let i = start + 1;
  while (i < lines.length && /^\s{2}\S/.test(lines[i]) && !/^\s{2}config:\s*$/.test(lines[i])) i++;
  if (i >= lines.length || !/^\s{2}config:\s*$/.test(lines[i])) return undefined;
  const out: string[] = [];
  for (i++; i < lines.length && /^\s{4}/.test(lines[i]); i++) out.push(lines[i]);
  return out;
}

const routeLine = (route: string) => new RegExp(`^\\s{6}['"]?${route}['"]?:`);

/**
 * The `llm-pi-ai` patch row that serves `route` for this run, or null when
 * none is needed (a native DeepSeek route, or a route the profile already
 * configures). Any other routes and fields in the dumped config are kept.
 */
export function dshPiAiRow(route: string, dump: string): string | null {
  if (isDshNativeRoute(route)) return null;
  const keyEnv = PI_AI_ROUTE_KEYS[route];
  const entry = [
    `      ${JSON.stringify(route)}:${keyEnv ? '' : ' {}'}`,
    ...(keyEnv ? [`        apiKeyEnv: ${JSON.stringify(keyEnv)}`] : []),
  ];
  let config = dumpedConfigLines(dump, 'llm-pi-ai') ?? [];
  let at = config.findIndex((l) => /^\s{4}providers:\s*(\{\})?\s*$/.test(l));
  if (at >= 0) {
    let end = at + 1;
    while (end < config.length && /^\s{6}/.test(config[end])) end++;
    if (config.slice(at + 1, end).some((l) => routeLine(route).test(l))) return null;
    config[at] = '    providers:';
  } else {
    // No providers, or a flow-style one this splice cannot extend: ours only.
    config = config.filter((l) => !/^\s{4}providers:/.test(l));
    config.push('    providers:');
    at = config.length - 1;
  }
  config.splice(at + 1, 0, ...entry);
  return ['- id: llm-pi-ai', '  config:', ...config].join('\n');
}
