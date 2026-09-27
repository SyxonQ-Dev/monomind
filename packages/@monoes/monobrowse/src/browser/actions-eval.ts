import type { CdpClient } from './cdp.js';

export async function pushState(client: CdpClient, sessionId: string, url: string): Promise<void> {
  // Try Next.js router first, then fallback to history.pushState
  await evaluateJs(
    client,
    sessionId,
    `
    (function() {
      const url = ${JSON.stringify(url)};
      if (window.next && window.next.router) {
        window.next.router.push(url).catch(function() {});
        return;
      } else {
        history.pushState({}, '', url);
        window.dispatchEvent(new PopStateEvent('popstate'));
      }
    })()
  `,
  );
}

export async function addInitScript(
  client: CdpClient,
  sessionId: string,
  script: string,
): Promise<string> {
  const result = await client.send<{ identifier: string }>(
    'Page.addScriptToEvaluateOnNewDocument',
    {
      source: script,
    },
    sessionId,
  );
  return result.identifier;
}

export async function removeInitScript(
  client: CdpClient,
  sessionId: string,
  identifier: string,
): Promise<void> {
  await client.send('Page.removeScriptToEvaluateOnNewDocument', { identifier }, sessionId);
}

// Default cap on how long an evaluateJs() call waits for Runtime.evaluate to
// resolve. Because this always passes `awaitPromise: true`, an expression
// like `new Promise(() => {})` never settles — the underlying CdpClient.send()
// has no timeout of its own (the CDP_RESPONSE_SIZE_LIMIT in cdp.ts only guards
// the HTTP /json/* endpoints, not WebSocket command responses), so without
// this the caller (e.g. the `eval` CLI command) would hang forever with
// nothing to kill it.
const DEFAULT_EVAL_TIMEOUT_MS = 30_000;

export async function evaluateJs(
  client: CdpClient,
  sessionId: string,
  expression: string,
  timeoutMs: number = DEFAULT_EVAL_TIMEOUT_MS,
): Promise<unknown> {
  const evalPromise = client.send<{
    result: { value?: unknown; type: string; description?: string };
    exceptionDetails?: { text: string; exception?: { description?: string } };
  }>(
    'Runtime.evaluate',
    {
      expression,
      returnByValue: true,
      awaitPromise: true,
    },
    sessionId,
  );

  // Not unref'd (same rule as CdpClient.send): this timer settles the awaited
  // race, so it has to hold the event loop open while the evaluation is in
  // flight. Cleared in the finally so a fast evaluation does not keep the
  // process alive for the rest of timeoutMs.
  let evalTimer: ReturnType<typeof setTimeout> | undefined;
  let result: Awaited<typeof evalPromise>;
  try {
    result = await (timeoutMs > 0
      ? Promise.race([
          evalPromise,
          new Promise<never>((_, reject) => {
            evalTimer = setTimeout(
              () => reject(new Error(`JS evaluation timed out after ${timeoutMs}ms`)),
              timeoutMs,
            );
          }),
        ])
      : evalPromise);
  } finally {
    clearTimeout(evalTimer);
  }

  if (result.exceptionDetails) {
    throw new Error(
      `JS evaluation error: ${result.exceptionDetails.exception?.description ?? result.exceptionDetails.text}`,
    );
  }

  return result.result?.value;
}

export async function readClipboard(client: CdpClient, sessionId: string): Promise<string> {
  const result = await evaluateJs(client, sessionId, 'navigator.clipboard.readText()');
  return result as string;
}

export async function writeClipboard(
  client: CdpClient,
  sessionId: string,
  text: string,
): Promise<void> {
  // Cap to 100 KB to prevent OOM when serializing the CDP expression
  const safeText = text.length > 102_400 ? text.slice(0, 102_400) : text;
  await evaluateJs(client, sessionId, `navigator.clipboard.writeText(${JSON.stringify(safeText)})`);
}
