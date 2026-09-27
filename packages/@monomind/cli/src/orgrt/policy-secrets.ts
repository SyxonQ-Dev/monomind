// packages/@monomind/cli/src/orgrt/policy-secrets.ts
// Split out of policy.ts (file-size sweep) — secret redaction and the
// bounded, redacted summaries put on the bus / into approval requests.
import { TOOL_RESULT_OUTPUT_MAX_CHARS } from './types.js';

/** SEC: secret shapes scrubbed from every bus payload — the argument summary on
 *  'tool' events and the content snapshot on 'asset' events. Prefix-keeping
 *  patterns ($1) leave the surrounding context readable; the rest are replaced
 *  whole. Deliberately loose: a false positive costs a readable value in an
 *  audit log, a false negative persists a live credential to disk. */
const SECRET_PATTERNS: Array<[RegExp, string]> = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, '[REDACTED]'],
  [/\b(bearer\s+)[A-Za-z0-9._~+/=-]{16,}/gi, '$1[REDACTED]'],
  [/\b(basic\s+)[A-Za-z0-9+/=]{16,}/gi, '$1[REDACTED]'],
  [/\b(sk|rk)-[A-Za-z0-9_-]{16,}/g, '[REDACTED]'],
  [/\bgh[pousr]_[A-Za-z0-9]{20,}/g, '[REDACTED]'],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}/g, '[REDACTED]'],
  [/\bAKIA[0-9A-Z]{16}\b/g, '[REDACTED]'],
  [/\bxox[abprs]-[A-Za-z0-9-]{10,}/g, '[REDACTED]'],
  [/\bAIza[0-9A-Za-z_-]{30,}/g, '[REDACTED]'],
  [/\bey[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, '[REDACTED]'],
  // .env / shell: SOME_API_KEY=value, DB_PASSWORD="value"
  [
    /(\b[A-Z][A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIALS?)[A-Z0-9_]*\s*=\s*)(["']?)[^\s"']+\2/g,
    '$1[REDACTED]',
  ],
  // json / yaml / cli: "apiKey": "value", password: value, api_key=value
  [
    /((?:api[_-]?key|access[_-]?token|auth[_-]?token|secret[_-]?key|client[_-]?secret|secret|password|passwd|token)["']?\s*[:=]\s*)(["']?)[^\s"',&]{6,}\2/gi,
    '$1[REDACTED]',
  ],
  // url credentials: scheme://user:password@host
  [/(\b[a-z][a-z0-9+.-]*:\/\/[^\s/:@]+:)[^\s/@]+@/gi, '$1[REDACTED]@'],
];

export function redactSecrets(text: string): string {
  let out = text;
  for (const [re, replacement] of SECRET_PATTERNS) out = out.replace(re, replacement);
  return out;
}

/** #289: the bounded, redacted slice of a tool's result body that goes on the
 *  bus. Redacts BEFORE truncating, so a cut-off credential can't leak the way
 *  a half-matched token would; keeps the head and states the truncation in
 *  structured fields rather than leaving a reader to infer it from an ellipsis. */
export function summarizeToolOutput(text: string): {
  output: string;
  truncated?: boolean;
  output_chars: number;
} {
  const clean = redactSecrets(text);
  if (clean.length <= TOOL_RESULT_OUTPUT_MAX_CHARS)
    return { output: clean, output_chars: text.length };
  return {
    output: `${clean.slice(0, TOOL_RESULT_OUTPUT_MAX_CHARS)}…[truncated]`,
    truncated: true,
    output_chars: text.length,
  };
}

/** Redacted, truncated argument summary — the form `tool` events log (and,
 *  since M5, approval requests carry). */
export function summarizeToolInput(input: Record<string, unknown>): Record<string, unknown> {
  return summarize(input);
}

export function summarize(input: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(input)) {
    if (typeof v !== 'string') {
      out[k] = v;
      continue;
    }
    const clean = redactSecrets(v); // redact BEFORE truncating so a cut-off token can't leak
    out[k] = clean.length > 200 ? `${clean.slice(0, 200)}…` : clean;
  }
  return out;
}
