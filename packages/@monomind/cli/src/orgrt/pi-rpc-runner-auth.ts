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
 * Two checks:
 *   - Up front, before spawning, when a model is set: `pi auth check --model
 *     <m> --json` (pi 0.87.1, ~0.3s). pi resolves the provider itself
 *     (`deepseek/deepseek-chat-v3.1` routes to openrouter), so extensions,
 *     auth.json and gateways all count. Only `status:"not_ready"` fails the
 *     run; any other answer, an error, a timeout or a pi without the
 *     command skips the check — the rejected-prompt path below still fails
 *     in about a second.
 *   - From pi itself: a rejected `prompt` response, or stderr, whose text
 *     is pi's own "No API key found" wording.
 */
import { execFile } from 'node:child_process';

/** Built-in pi providers with one API-key variable (pi 0.87.1's own table,
 *  docs/providers.md) — used only to name the variable in the error. */
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

/** pi's wording for a credential that was never set (seen live). A bare
 *  "Use /login" is not enough: pi also says it for an expired login. */
const PI_NO_KEY_RE = /\bno api key (?:found|configured)\b/i;

const AUTH_CHECK_TIMEOUT_MS = 10_000;

/** pi's `auth check --json` answer (only the fields the runner reads). */
interface PiAuthCheck {
  status?: string;
  provider?: string;
  reason?: string;
}

/** Run `pi auth check --model <m> --json`; undefined when it cannot tell. */
function runAuthCheck(
  bin: string,
  model: string,
  opts: { env: Record<string, string>; cwd: string; signal?: AbortSignal },
): Promise<PiAuthCheck | undefined> {
  return new Promise((resolve) => {
    try {
      execFile(
        bin,
        ['auth', 'check', '--model', model, '--json'],
        { env: opts.env, cwd: opts.cwd, timeout: AUTH_CHECK_TIMEOUT_MS, signal: opts.signal },
        // not_ready exits 1, so read stdout whatever the exit code.
        (_err, stdout) => {
          const line =
            String(stdout ?? '')
              .trim()
              .split('\n')
              .pop() ?? '';
          try {
            const json = JSON.parse(line) as PiAuthCheck;
            resolve(json && typeof json === 'object' ? json : undefined);
          } catch {
            resolve(undefined);
          }
        },
      );
    } catch {
      resolve(undefined);
    }
  });
}

/**
 * The fatal error for a model pi says it has no usable credential for, or
 * undefined when pi is ready or the check could not tell (see header).
 */
export async function piAuthPrecheck(
  bin: string,
  model: string | undefined,
  opts: { env: Record<string, string>; cwd: string; signal?: AbortSignal },
): Promise<Error | undefined> {
  if (!model) return undefined;
  const check = await runAuthCheck(bin, model, opts);
  if (check?.status !== 'not_ready') return undefined;
  const provider = check.provider;
  const keyEnv = provider ? PI_PROVIDER_KEY_ENV[provider] : undefined;
  if (check.reason === 'credentials_not_configured') {
    return missingApiKeyError(
      { provider, keyEnv },
      `pi auth check: ${provider ?? model} not_ready (credentials_not_configured)`,
    );
  }
  const err = new Error(
    `PiRpcAgentRunner: pi is not ready for provider ${provider ?? model} (${check.reason ?? 'not_ready'}): ` +
      `not logged in or the login expired. Run \`pi\` then /login${keyEnv ? `, or set ${keyEnv}` : ''}.`,
  );
  (err as Error & { fatal?: boolean }).fatal = true;
  return err;
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
      (piText ? ` pi: ${piText.trim().split('\n')[0].slice(0, 300)}` : ''),
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
