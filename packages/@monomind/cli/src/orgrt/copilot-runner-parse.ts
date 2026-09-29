// packages/@monomind/cli/src/orgrt/copilot-runner-parse.ts
import type { CopilotEvent, CopilotStreamEvent, CopilotUsage } from './copilot-runner-types.js';
import { TOOL_CALL_RE } from './tool-fence.js';

/**
 * Sum the per-model token counts out of a `--usage-output-file` payload.
 * Returns undefined — never a zeroed object — when the file has no model
 * metrics to read, so a caller can tell "copilot made no model call" (the
 * file is still written, with `modelMetrics: {}`) apart from a number it
 * actually measured. Summing across models covers a session that switched
 * model mid-run. Exported for unit testing against the captured fixture in
 * copilot-runner.test.ts.
 */
export function parseCopilotUsage(raw: string): CopilotUsage | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  const metrics = (parsed as { modelMetrics?: unknown } | null)?.modelMetrics;
  if (!metrics || typeof metrics !== 'object' || Array.isArray(metrics)) return undefined;
  let inputTokens = 0;
  let outputTokens = 0;
  let sawAny = false;
  for (const entry of Object.values(metrics as Record<string, unknown>)) {
    const usage = (entry as { usage?: Record<string, unknown> } | null)?.usage;
    if (!usage || typeof usage !== 'object') continue;
    const i = Number(usage.inputTokens);
    const o = Number(usage.outputTokens);
    if (!Number.isFinite(i) || !Number.isFinite(o)) continue;
    inputTokens += i;
    outputTokens += o;
    sawAny = true;
  }
  return sawAny ? { inputTokens, outputTokens } : undefined;
}

function coerceText(v: unknown): string | undefined {
  if (typeof v === 'string') return v;
  if (Array.isArray(v)) {
    return v
      .filter(
        (b): b is { type: string; text: string } =>
          !!b && typeof b === 'object' && (b as Record<string, unknown>).type === 'text',
      )
      .map((b) => b.text)
      .join('\n');
  }
  return undefined;
}

/** Parse ONE NDJSON line into a normalized stream event (or null if it
 *  carries nothing to yield). Shared by the incremental streaming path and
 *  the batch parseCopilotEvents helper below (kept for unit testing against
 *  fixture lines — copilot-runner.test.ts). */
export function handleLine(line: string): CopilotStreamEvent | null {
  const trimmed = line.trim();
  if (!trimmed?.startsWith('{')) return null;
  let ev: CopilotEvent;
  try {
    ev = JSON.parse(trimmed);
  } catch {
    return null;
  }

  const kind = ev.type ?? ev.kind;
  if (kind === 'assistant.message' || kind === 'assistant') {
    // `data.content` first — that is the real 1.0.83 shape (#181); the rest
    // are the previously-guessed shapes, kept as fallbacks.
    const text =
      coerceText(ev.data?.content) ??
      ev.data?.text ??
      coerceText(ev.content) ??
      ev.text ??
      coerceText(ev.message?.content) ??
      ev.message?.text;
    if (!text) return null;
    return {
      kind: 'assistant',
      rawText: text,
      text: text.replace(TOOL_CALL_RE, '').trim() || undefined,
    };
  }
  if (ev.role === 'assistant') {
    const text = coerceText(ev.content) ?? ev.text;
    if (!text) return null;
    return {
      kind: 'assistant',
      rawText: text,
      text: text.replace(TOOL_CALL_RE, '').trim() || undefined,
    };
  }
  const data = ev.data;
  if (kind === 'tool.execution_start' && typeof data?.toolCallId === 'string') {
    return {
      kind: 'native',
      toolStart: { id: data.toolCallId, name: String(data.toolName ?? 'tool'), input: data.arguments },
    };
  }
  if (kind === 'tool.execution_complete' && typeof data?.toolCallId === 'string') {
    return {
      kind: 'native',
      toolEnd: {
        id: data.toolCallId,
        output: data.result?.content ?? '',
        isError: data.success === false,
      },
    };
  }
  if (kind === 'result' && typeof ev.sessionId === 'string' && ev.sessionId) {
    return { kind: 'session', sessionId: ev.sessionId };
  }
  if (typeof kind === 'string' && kind.startsWith('tool')) {
    const label = coerceText(ev.content) ?? ev.text ?? kind;
    return { kind: 'tool', toolName: label.slice(0, 200) };
  }
  return null;
}

/** Pure NDJSON parser — exported for unit testing against fixture lines
 *  (copilot-runner.test.ts). */
export function parseCopilotEvents(lines: string[]): { texts: string[]; rawTexts: string[] } {
  const rawTexts: string[] = [];
  for (const line of lines) {
    const out = handleLine(line);
    if (out?.kind === 'assistant' && out.rawText !== undefined) rawTexts.push(out.rawText);
  }
  const texts = rawTexts.map((t) => t.replace(TOOL_CALL_RE, '').trim());
  return { texts, rawTexts };
}
