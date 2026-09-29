// packages/@monomind/cli/src/orgrt/provider-limit.ts
/**
 * Provider limit classification shared by every runner and `agent exec`
 * (doc/agent-exec-protocol.md §3.4, rev 20): a transient rate limit (HTTP
 * 429, "too many requests", a per-minute cap) is worth a retry after a short
 * backoff; exhausted quota, credits, billing or a daily allowance is not.
 *
 * Wordings seen in this repo's fixtures and runners:
 *   - OpenRouter through pi (fixture json-openrouter-429-retries.jsonl):
 *     `429: {"message":"Provider returned error","code":429,…"… is
 *     temporarily rate-limited upstream. Please retry shortly…"}`
 *   - OpenRouter's own caps: "Rate limit exceeded: free-models-per-min."
 *     (transient) vs "…: free-models-per-day. Add 10 credits…" (daily cap)
 *   - litellm (aider, dsh's pi-ai adapter): "litellm.RateLimitError: …"
 *   - Anthropic: `rate_limit_error`; OpenAI: "Rate limit reached for … Please
 *     try again in 1.5s" vs `insufficient_quota` / "exceeded your current
 *     quota"; Gemini: `RESOURCE_EXHAUSTED` with a `…PerMinute…` quota id and
 *     `"retryDelay": "17s"`; codex: "exceeded retry limit, last status: 429
 *     Too Many Requests" vs "You've hit your usage limit".
 */

/** A 429 by status, name or wording. A bare "429" is not enough — token
 *  counts and timestamps contain it — so it must look like a status. */
const RATE_LIMIT_RE =
  /rate[-_ ]?limit|too many requests|RateLimitError|resource[_ ]exhausted|\b(?:status|code|HTTP|error)\W{0,3}429\b|\b429\s*(?::|Too Many)|\(429\)|"code"\s*:\s*429/i;

/** The account's quota, credits or daily allowance is used up. */
const QUOTA_RE =
  /usage limit|quota|billing|insufficient.*(?:balance|credit|funds)|payment required|out of credits|credits? (?:exhausted|depleted)|per[-_ ]day\b|daily (?:limit|quota|cap)/i;

/** …except a per-minute quota, which is a rate limit (Gemini free tier). */
const PER_MINUTE_RE = /per[-_ ]?min(?:ute)?\b|PerMinute|\b[RT]PM\b/i;

export type ProviderLimit = 'rate-limited' | 'quota';

/** `rate-limited` for a transient limit, `quota` for exhausted quota or
 *  billing, undefined when the text is neither. */
export function classifyProviderLimit(text: string): ProviderLimit | undefined {
  const rate = RATE_LIMIT_RE.test(text);
  const quota = QUOTA_RE.test(text);
  if (rate && (!quota || PER_MINUTE_RE.test(text))) return 'rate-limited';
  return quota ? 'quota' : undefined;
}

/** Longest wait a provider's Retry-After hint may impose on one retry. */
export const MAX_RETRY_AFTER_MS = 30_000;

/**
 * The wait a provider asked for ("Retry-After: 20", "retry after 20
 * seconds", "Please try again in 1.5s", "retryDelay":"17s", "retry in
 * 500ms"), capped at MAX_RETRY_AFTER_MS; undefined when the text has none.
 */
export function parseRetryAfterMs(text: string): number | undefined {
  const m =
    /(?:retry[-_ ]?after|retry[-_ ]?delay|(?:try again|retry) in)["':=\s]*(\d+(?:\.\d+)?)\s*(ms|milliseconds?|s\b|sec(?:ond)?s?|m\b|min(?:ute)?s?)?/i.exec(
      text,
    );
  if (!m) return undefined;
  const n = Number(m[1]);
  if (!Number.isFinite(n) || n < 0) return undefined;
  const unit = (m[2] ?? 's').toLowerCase();
  const ms =
    unit.startsWith('ms') || unit.startsWith('milli')
      ? n
      : unit.startsWith('m')
        ? n * 60_000
        : n * 1000;
  return Math.min(Math.round(ms), MAX_RETRY_AFTER_MS);
}

/** Error property a runner sets when its CLI already retried the failure
 *  itself (pi's auto_retry, aider's litellm backoff): the number of retries,
 *  or 0 when the CLI retried an unknown number of times. */
export interface VendorRetried {
  vendorRetries?: number;
}

/** Tag `err` with the retries the runtime's CLI already made (a count, or
 *  'unknown'); a count of 0 leaves it untagged. */
export function withVendorRetries<E extends Error>(err: E, retries: number | 'unknown'): E {
  if (retries === 'unknown') (err as E & VendorRetried).vendorRetries = 0;
  else if (retries > 0) (err as E & VendorRetried).vendorRetries = retries;
  return err;
}

/**
 * The retries a runtime's CLI already made on this failure: the error's
 * `vendorRetries` tag, else wording such as codex's "exceeded retry limit"
 * (0 = count unknown). undefined when nothing says the CLI retried.
 */
export function vendorRetriesOf(err: unknown, text: string): number | undefined {
  const tagged = (err as VendorRetried | undefined)?.vendorRetries;
  if (typeof tagged === 'number' && tagged >= 0) return tagged;
  if (/exceeded retry limit|retries exhausted|max(?:imum)? retries/i.test(text)) return 0;
  return undefined;
}
