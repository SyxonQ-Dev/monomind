/**
 * Browser MCP Tools — Info Retrieval, Wait, Eval & Session Management
 *
 * Split out of browser-tools.ts to keep files under 500 lines (pure move).
 */

import {
  browserSessions,
  fail,
  findElement,
  getConnection,
  ok,
  pruneExpiredSessions,
  rejectFlagLike,
  touchSession,
  validateSessionId,
  validateUrl,
} from './browser-session.js';
import type { MCPTool } from './types.js';

/** Cap on browser_eval scripts. */
const MAX_BROWSER_EVAL_BYTES = 16 * 1024;

export const browserInfoTools: MCPTool[] = [
  // ==========================================================================
  // Information Retrieval Tools
  // ==========================================================================
  {
    name: 'browser_get-text',
    description: 'Get inner text of an element',
    category: 'browser',
    tags: ['info'],
    inputSchema: {
      type: 'object',
      properties: {
        target: { type: 'string', description: 'CSS selector, role, text, label, or placeholder' },
        locator: {
          type: 'string',
          enum: ['selector', 'role', 'text', 'label', 'placeholder'],
          description: 'How to find the element (default: selector)',
        },
        session: { type: 'string', description: 'Session ID' },
      },
      required: ['target'],
    },
    handler: async (input) => {
      const raw = input as { target?: unknown; locator?: unknown; session?: unknown };
      let sessionId: string;
      let target: string;
      try {
        sessionId = validateSessionId(raw.session);
        target = rejectFlagLike(raw.target, 'target');
      } catch (e) {
        return fail((e as Error).message);
      }
      const locator = typeof raw.locator === 'string' ? raw.locator : 'selector';
      try {
        const conn = await getConnection(sessionId);
        const ref = await findElement(conn, target, locator);
        const res = await conn.client.send<{ result: { value: unknown } }>(
          'Runtime.callFunctionOn',
          {
            objectId: ref.objectId,
            functionDeclaration: 'function(){return this.innerText??this.textContent??""}',
            returnByValue: true,
          },
          conn.cdpSessionId,
        );
        touchSession(sessionId);
        return ok({ text: res.result.value });
      } catch (e) {
        return fail((e as Error).message);
      }
    },
  },

  {
    name: 'browser_get-value',
    description: 'Get value of an input element',
    category: 'browser',
    tags: ['info', 'form'],
    inputSchema: {
      type: 'object',
      properties: {
        target: { type: 'string', description: 'CSS selector, role, text, label, or placeholder' },
        locator: {
          type: 'string',
          enum: ['selector', 'role', 'text', 'label', 'placeholder'],
          description: 'How to find the element (default: selector)',
        },
        session: { type: 'string', description: 'Session ID' },
      },
      required: ['target'],
    },
    handler: async (input) => {
      const raw = input as { target?: unknown; locator?: unknown; session?: unknown };
      let sessionId: string;
      let target: string;
      try {
        sessionId = validateSessionId(raw.session);
        target = rejectFlagLike(raw.target, 'target');
      } catch (e) {
        return fail((e as Error).message);
      }
      const locator = typeof raw.locator === 'string' ? raw.locator : 'selector';
      try {
        const conn = await getConnection(sessionId);
        const ref = await findElement(conn, target, locator);
        const res = await conn.client.send<{ result: { value: unknown } }>(
          'Runtime.callFunctionOn',
          {
            objectId: ref.objectId,
            functionDeclaration: 'function(){return this.value??""}',
            returnByValue: true,
          },
          conn.cdpSessionId,
        );
        touchSession(sessionId);
        return ok({ value: res.result.value });
      } catch (e) {
        return fail((e as Error).message);
      }
    },
  },

  {
    name: 'browser_get-title',
    description: 'Get the current page title',
    category: 'browser',
    tags: ['info'],
    inputSchema: {
      type: 'object',
      properties: { session: { type: 'string', description: 'Session ID' } },
    },
    handler: async (input) => {
      const { session } = input as { session?: unknown };
      let sessionId: string;
      try {
        sessionId = validateSessionId(session);
      } catch (e) {
        return fail((e as Error).message);
      }
      try {
        const { getCurrentTitle } = await import('@monoes/monobrowse');
        const conn = await getConnection(sessionId);
        const title = await getCurrentTitle(conn.client, conn.cdpSessionId);
        touchSession(sessionId);
        return ok({ title });
      } catch (e) {
        return fail((e as Error).message);
      }
    },
  },

  {
    name: 'browser_get-url',
    description: 'Get the current page URL',
    category: 'browser',
    tags: ['info'],
    inputSchema: {
      type: 'object',
      properties: { session: { type: 'string', description: 'Session ID' } },
    },
    handler: async (input) => {
      const { session } = input as { session?: unknown };
      let sessionId: string;
      try {
        sessionId = validateSessionId(session);
      } catch (e) {
        return fail((e as Error).message);
      }
      try {
        const { getCurrentUrl } = await import('@monoes/monobrowse');
        const conn = await getConnection(sessionId);
        const url = await getCurrentUrl(conn.client, conn.cdpSessionId);
        touchSession(sessionId);
        return ok({ url });
      } catch (e) {
        return fail((e as Error).message);
      }
    },
  },

  // ==========================================================================
  // Wait Tools
  // ==========================================================================
  {
    name: 'browser_wait',
    description: 'Wait for a CSS selector to appear, a URL pattern, page load, or a fixed duration',
    category: 'browser',
    tags: ['wait'],
    inputSchema: {
      type: 'object',
      properties: {
        selector: { type: 'string', description: 'CSS selector to wait for' },
        url: { type: 'string', description: 'URL substring to wait for in current URL' },
        load: { type: 'boolean', description: 'Wait for page load event' },
        duration: {
          type: 'number',
          description: 'Wait a fixed number of milliseconds (max 60000)',
        },
        timeout: {
          type: 'number',
          description: 'Timeout in ms for selector/url/load conditions (default 30000)',
        },
        session: { type: 'string', description: 'Session ID' },
      },
    },
    handler: async (input) => {
      const raw = input as {
        selector?: unknown;
        url?: unknown;
        load?: boolean;
        duration?: unknown;
        timeout?: number;
        session?: unknown;
      };
      let sessionId: string;
      try {
        sessionId = validateSessionId(raw.session);
      } catch (e) {
        return fail((e as Error).message);
      }
      const timeout = Math.min(Math.max(Number(raw.timeout ?? 30000), 0), 60000);
      try {
        const { waitFor, waitForLoad } = await import('@monoes/monobrowse');
        const conn = await getConnection(sessionId);

        if (raw.duration !== undefined) {
          const ms = Math.min(Math.max(Number(raw.duration), 0), 60000);
          await new Promise((r) => setTimeout(r, ms));
        } else if (raw.selector !== undefined) {
          await waitFor(conn.client, conn.cdpSessionId, {
            selector: rejectFlagLike(raw.selector, 'selector'),
            timeout,
          });
        } else if (raw.url !== undefined) {
          await waitFor(conn.client, conn.cdpSessionId, { url: validateUrl(raw.url), timeout });
        } else if (raw.load) {
          await waitForLoad(conn.client, conn.cdpSessionId, 'load', timeout);
        } else {
          return fail('browser_wait: provide selector, url, load:true, or duration');
        }
        touchSession(sessionId);
        return ok();
      } catch (e) {
        return fail((e as Error).message);
      }
    },
  },

  // ==========================================================================
  // JavaScript Execution
  // ==========================================================================
  {
    name: 'browser_eval',
    description:
      'Execute JavaScript in page context. Requires MONOMIND_ALLOW_BROWSER_EVAL=1 env var.',
    category: 'browser',
    tags: ['eval', 'js'],
    inputSchema: {
      type: 'object',
      properties: {
        script: { type: 'string', description: 'JavaScript expression to evaluate' },
        session: { type: 'string', description: 'Session ID' },
      },
      required: ['script'],
    },
    handler: async (input) => {
      // SECURITY: browser_eval runs arbitrary JS with the browser's session cookies.
      // Require explicit operator opt-in via env var to prevent SSRF / credential theft.
      if (process.env.MONOMIND_ALLOW_BROWSER_EVAL !== '1') {
        return fail(
          'browser_eval is disabled by default. Set MONOMIND_ALLOW_BROWSER_EVAL=1 to enable.',
        );
      }
      const raw = input as { script?: unknown; session?: unknown };
      if (typeof raw.script !== 'string') return fail('script: must be a string');
      if (raw.script.length > MAX_BROWSER_EVAL_BYTES)
        return fail(`script: too long (max ${MAX_BROWSER_EVAL_BYTES})`);
      let sessionId: string;
      try {
        sessionId = validateSessionId(raw.session);
      } catch (e) {
        return fail((e as Error).message);
      }
      // Audit log every eval call
      try {
        const crypto = await import('node:crypto');
        const hash = crypto.createHash('sha256').update(raw.script).digest('hex').slice(0, 16);
        console.error(
          `[${new Date().toISOString()}] AUDIT browser_eval session=${sessionId} script_sha256_16=${hash}`,
        );
      } catch {
        /* best-effort */
      }
      try {
        const { evaluateJs } = await import('@monoes/monobrowse');
        const conn = await getConnection(sessionId);
        const result = await evaluateJs(conn.client, conn.cdpSessionId, raw.script);
        touchSession(sessionId);
        return ok({ result });
      } catch (e) {
        return fail((e as Error).message);
      }
    },
  },

  // ==========================================================================
  // Session Management
  // ==========================================================================
  {
    name: 'browser_session-list',
    description: 'List active browser sessions',
    category: 'browser',
    tags: ['session'],
    inputSchema: { type: 'object', properties: {} },
    handler: async () => {
      await pruneExpiredSessions();
      const sessions = Array.from(browserSessions.values());
      return ok({ sessions, count: sessions.length });
    },
  },
];

export default browserInfoTools;
