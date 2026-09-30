// packages/@monomind/cli/src/orgrt/pi-rpc-runner-auth.ts
/**
 * Missing-API-key detection for PiRpcAgentRunner (pi-rpc-runner.ts).
 *
 * Without a key, pi 0.87.1 in `--mode rpc` answers the `prompt` command with
 * `{"type":"response","command":"prompt","success":false,"error":"No API key
 * found for openai. …"}` and then sends nothing else (live capture, empty
 * HOME). The runner used to ignore every `response`, so the turn sat on the
 * 10-minute silence watchdog instead of failing.
 *
 * Two checks, both ending in the same "missing API key: set X" error:
 *   - Up front, before spawning: the model names a built-in provider
 *     (`openai/gpt-5`), its key variable is not in the spawn env, and pi
 *     has no stored credential or custom provider of that name.
 *   - From pi itself: a rejected `prompt` response, or stderr, whose text
 *     is pi's own "No API key found" / "Use /login" wording.
 */
import * as fs from 'node:fs';
import { join } from 'node:path';

/** Built-in pi providers with one API-key variable (pi 0.87.1's own table,
 *  docs/providers.md). Cloud providers with ambient credentials are left
 *  out: an unset variable does not mean they have no credential. */
export const PI_PROVIDER_KEY_ENV: Readonly<Record<string, string>> = {
  anthropic: 'ANTHROPIC_API_KEY',
  'ant-ling': 'ANT_LING_API_KEY',
  openai: 'OPENAI_API_KEY',
  deepseek: 'DEEPSEEK_API_KEY',
  nvidia: 'NVIDIA_API_KEY',
  google: 'GEMINI_API_KEY',
  mistral: 'MISTRAL_API_KEY',
  groq: 'GROQ_API_KEY',
  cerebras: 'CEREBRAS_API_KEY',
  xai: 'XAI_API_KEY',
  openrouter: 'OPENROUTER_API_KEY',
  'vercel-ai-gateway': 'AI_GATEWAY_API_KEY',
  zai: 'ZAI_API_KEY',
  fireworks: 'FIREWORKS_API_KEY',
  together: 'TOGETHER_API_KEY',
  moonshotai: 'MOONSHOT_API_KEY',
  minimax: 'MINIMAX_API_KEY',
};

/** Other variables pi accepts in place of the primary one. */
const ALTERNATE_KEY_ENV: Readonly<Record<string, readonly string[]>> = {
  anthropic: ['ANTHROPIC_OAUTH_TOKEN', 'ANTHROPIC_AUTH_TOKEN'],
};

/** pi's wording for "no credential" (seen live, and in agent-error-classify.ts). */
const PI_NO_KEY_RE = /\bno api key (?:found|configured)\b|\buse \/login\b/i;

type Env = Record<string, string | undefined>;

/** True when `file` parses and `pick` finds the provider in it; a file that
 *  exists but does not parse counts as present — the check cannot tell. */
function mentionsProvider(file: string, pick: (json: Record<string, unknown>) => unknown): boolean {
  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return false;
  }
  try {
    return pick(JSON.parse(raw) as Record<string, unknown>) !== undefined;
  } catch {
    return true;
  }
}

/** A credential or custom provider pi would find without the variable. */
function hasStoredCredential(provider: string, env: Env, cwd: string): boolean {
  const agentDir =
    env.PI_CODING_AGENT_DIR || (env.HOME ? join(env.HOME, '.pi', 'agent') : undefined);
  const providers = (j: Record<string, unknown>) =>
    (j.providers as Record<string, unknown> | undefined)?.[provider];
  if (agentDir) {
    if (mentionsProvider(join(agentDir, 'auth.json'), (j) => j[provider])) return true;
    if (mentionsProvider(join(agentDir, 'models.json'), providers)) return true;
  }
  return mentionsProvider(join(cwd, '.pi', 'models.json'), providers);
}

/**
 * The key variable a run is missing, or undefined when it has one (or the
 * check cannot tell: no model, no provider prefix, a provider not in
 * PI_PROVIDER_KEY_ENV, or a stored credential).
 */
export function missingPiApiKey(
  model: string | undefined,
  env: Env,
  cwd: string,
): { provider: string; keyEnv: string } | undefined {
  const slash = model?.indexOf('/') ?? -1;
  if (!model || slash <= 0) return undefined;
  const provider = model.slice(0, slash);
  const keyEnv = PI_PROVIDER_KEY_ENV[provider];
  if (!keyEnv) return undefined;
  if ([keyEnv, ...(ALTERNATE_KEY_ENV[provider] ?? [])].some((k) => env[k])) return undefined;
  if (hasStoredCredential(provider, env, cwd)) return undefined;
  return { provider, keyEnv };
}

/** The fatal "missing API key: set X" error. `piText` is pi's own message. */
export function missingApiKeyError(
  key: { provider?: string; keyEnv?: string },
  piText?: string,
): Error {
  const what = key.keyEnv
    ? `set ${key.keyEnv}${key.provider ? ` for provider ${key.provider}` : ''}`
    : "set the provider's API key variable";
  const err = new Error(
    `PiRpcAgentRunner: missing API key: ${what}, or run \`pi\` then /login.` +
      (piText
        ? ` pi: ${piText.trim().split('\n')[0].slice(0, 300)}`
        : ' (no API key found in the environment or pi auth.json)'),
  );
  (err as Error & { fatal?: boolean }).fatal = true;
  return err;
}

/** The missing-key error for pi text (a rejected prompt, or stderr), or
 *  undefined when the text is not pi's no-credential wording. */
export function piAuthErrorFromText(text: string, model: string | undefined): Error | undefined {
  if (!PI_NO_KEY_RE.test(text)) return undefined;
  // "No API key found for openai." names the provider; otherwise the model's.
  const provider =
    /no api key found for (?!the selected model)([\w.-]+?)\.?(?:\s|$)/i.exec(text)?.[1] ??
    (model?.includes('/') ? model.slice(0, model.indexOf('/')) : undefined);
  const keyEnv = provider ? PI_PROVIDER_KEY_ENV[provider] : undefined;
  return missingApiKeyError({ provider: keyEnv ? provider : undefined, keyEnv }, text);
}
