// packages/@monomind/cli/src/orgrt/agent-error-classify.ts
/**
 * Pure classification of an agent turn's failure into a caller-facing status
 * (issue #390). Input is what the runner/exec engine produced — the §3.4
 * `error.code` (auth, quota, missing-binary, runner-error, …) and its
 * message, plus any assistant text the turn printed — so `agent test` and,
 * later, `agent exec` error events can share one mapping.
 *
 * The main addition over §3.4 is `model_unavailable`: every runtime reports
 * "unknown model / not on your plan" differently, and they all land in
 * `runner-error` (or `auth`, when the provider answers 403) today.
 */

import { classifyStderr } from './kimicode-runner-parse.js';

export type AgentFailureStatus =
  | 'auth'
  | 'quota'
  | 'rate_limited'
  | 'model_unavailable'
  | 'timeout'
  | 'missing_binary'
  | 'error';

export interface AgentErrorInput {
  /** The §3.4 code the engine emitted (`runner-error`, `auth`, …), if any. */
  code?: string;
  /** Error message plus any assistant text from the failed turn. */
  message?: string;
}

export interface ClassifiedAgentError {
  status: AgentFailureStatus;
  /** Error code for the caller: the §3.4 code, or `model-unavailable`. */
  code: string;
}

/**
 * Model-not-available messages, one per runtime wording. Strings marked
 * "seen" were captured from the installed CLI with a bogus `--model`
 * (2026-09-29); the rest are the providers' documented API errors.
 */
const MODEL_UNAVAILABLE_PATTERNS: RegExp[] = [
  // claude (seen): "There's an issue with the selected model (x). It may not
  // exist or you may not have access to it." + stderr "[claude-code:unrecognized_model]"
  /issue with the selected model/i,
  /unrecognized_model/i,
  // Anthropic API: {"type":"not_found_error","message":"model: x"}
  /not_found_error[\s\S]{0,200}\bmodel\b/i,
  // copilot (seen): 'Model "x" from --model flag is not available.'
  // codex (seen): "The 'x' model is not supported when using Codex with a ChatGPT account."
  /\bmodel\b[^\n]{0,160}\bis not (?:available|supported)\b/i,
  // pi (seen): 'Model "x" not found.'  crush (seen): 'large model "x" not found.'
  // antigravity runner fixture: "model not found"; opencode: ProviderModelNotFoundError
  /\bmodel\b[^\n]{0,160}\bnot found\b/i,
  /model[_ ]?not[_ ]?found/i,
  // agy (seen): "model x is not recognized as a known model"; "invalid model selection"
  /\bnot recognized as a known model\b/i,
  /\b(?:unknown|unsupported|invalid|unrecognized) model\b/i,
  // OpenAI/xAI: "The model `x` does not exist or you do not have access to it."
  // DashScope (qwen): "Model not exist."
  /\bmodel\b[^\n]{0,160}\b(?:does not|doesn't|not) exist\b/i,
  // Gemini API: "models/x is not found for API version v1beta"
  /\bmodels\/[\w.-]+ is not found\b/i,
  // Moonshot (kimi): "Not found the model x or Permission denied"
  /not found the model/i,
  // Plan/tier gates: "not available on your plan", "requires a paid plan"
  /not available (?:on|for|in|with) your (?:plan|subscription|tier|account)/i,
];

/** Wording that means the credentials are missing or rejected. */
const AUTH_PATTERNS: RegExp[] = [
  /invalid api key/i,
  /please run \/login|not logged in|not signed in|log ?in required/i,
  /\bunauthori[sz]ed\b|authentication (?:failed|error|required)/i,
  // hermes (seen): "No inference provider configured. … set an API key"
  /no inference provider configured/i,
];

/** Runners re-throw ENOENT as prose ("requires the Codex CLI (codex) on PATH"). */
const MISSING_BINARY_PATTERNS: RegExp[] = [
  /requires the [^\n]{1,80} on PATH/i,
  /\bENOENT\b/,
  /command not found/i,
  /\bCLI not found\b/i,
];

const matchesAny = (patterns: RegExp[], text: string): boolean =>
  patterns.some((re) => re.test(text));

/** True when `message` is one of the runtimes' "model not available" errors. */
export function isModelUnavailable(message: string): boolean {
  return matchesAny(MODEL_UNAVAILABLE_PATTERNS, message);
}

/** Map an engine error (code + message) to a caller-facing status. */
export function classifyAgentError(input: AgentErrorInput): ClassifiedAgentError {
  const code = input.code ?? 'runner-error';
  const message = input.message ?? '';

  // Codes the engine decided without looking at provider text.
  if (code === 'missing-binary') return { status: 'missing_binary', code };
  if (code === 'timeout') return { status: 'timeout', code };
  // rev 20: a 429 agent exec retried until it gave up (agent-exec-retry.ts).
  if (code === 'rate-limited') return { status: 'rate_limited', code };
  if (code !== 'auth' && code !== 'quota' && code !== 'runner-error') {
    return { status: 'error', code };
  }

  // A model error can arrive as a 403 (classified auth) or a 404 runner-error.
  if (isModelUnavailable(message))
    return { status: 'model_unavailable', code: 'model-unavailable' };
  if (code === 'auth') return { status: 'auth', code };
  if (code === 'quota') return { status: 'quota', code };

  if (matchesAny(MISSING_BINARY_PATTERNS, message)) {
    return { status: 'missing_binary', code: 'missing-binary' };
  }
  if (matchesAny(AUTH_PATTERNS, message)) return { status: 'auth', code: 'auth' };
  const cls = classifyStderr(message);
  if (cls.fatal) {
    if (/auth/i.test(cls.label ?? '')) return { status: 'auth', code: 'auth' };
    return cls.rateLimited
      ? { status: 'rate_limited', code: 'rate-limited' }
      : { status: 'quota', code: 'quota' };
  }
  return { status: 'error', code };
}
