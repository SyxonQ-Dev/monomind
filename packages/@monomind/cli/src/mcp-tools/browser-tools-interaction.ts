/**
 * Browser MCP Tools — Interaction
 *
 * Split out of browser-tools.ts to keep files under 500 lines (pure move).
 */

import {
  fail,
  findElement,
  getConnection,
  ok,
  rejectFlagLike,
  touchSession,
  validateSessionId,
} from './browser-session.js';
import type { MCPTool } from './types.js';

export const browserInteractionTools: MCPTool[] = [
  // ==========================================================================
  // Interaction Tools
  // ==========================================================================
  {
    name: 'browser_click',
    description:
      'Click an element. Use locator="selector" (CSS selector), "role", "text", "label", or "placeholder".',
    category: 'browser',
    tags: ['interaction'],
    inputSchema: {
      type: 'object',
      properties: {
        target: {
          type: 'string',
          description: 'CSS selector, role name, visible text, label text, or placeholder text',
        },
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
        const { clickElement } = await import('@monoes/monobrowse');
        const conn = await getConnection(sessionId);
        const ref = await findElement(conn, target, locator);
        await clickElement(conn.client, conn.cdpSessionId, ref);
        touchSession(sessionId);
        return ok();
      } catch (e) {
        return fail((e as Error).message);
      }
    },
  },

  {
    name: 'browser_fill',
    description: 'Clear and fill an input element with a value',
    category: 'browser',
    tags: ['interaction', 'form'],
    inputSchema: {
      type: 'object',
      properties: {
        target: { type: 'string', description: 'CSS selector, role, text, label, or placeholder' },
        value: { type: 'string', description: 'Value to fill' },
        locator: {
          type: 'string',
          enum: ['selector', 'role', 'text', 'label', 'placeholder'],
          description: 'How to find the element (default: selector)',
        },
        session: { type: 'string', description: 'Session ID' },
      },
      required: ['target', 'value'],
    },
    handler: async (input) => {
      const raw = input as {
        target?: unknown;
        value?: unknown;
        locator?: unknown;
        session?: unknown;
      };
      let sessionId: string;
      let target: string;
      try {
        sessionId = validateSessionId(raw.session);
        target = rejectFlagLike(raw.target, 'target');
      } catch (e) {
        return fail((e as Error).message);
      }
      if (typeof raw.value !== 'string') return fail('value: must be a string');
      const locator = typeof raw.locator === 'string' ? raw.locator : 'selector';
      try {
        const { fillElement } = await import('@monoes/monobrowse');
        const conn = await getConnection(sessionId);
        const ref = await findElement(conn, target, locator);
        await fillElement(conn.client, conn.cdpSessionId, ref, raw.value);
        touchSession(sessionId);
        return ok();
      } catch (e) {
        return fail((e as Error).message);
      }
    },
  },

  {
    name: 'browser_type',
    description: 'Type text character-by-character (useful for autocomplete, live-search, etc.)',
    category: 'browser',
    tags: ['interaction', 'form'],
    inputSchema: {
      type: 'object',
      properties: {
        target: { type: 'string', description: 'CSS selector, role, text, label, or placeholder' },
        text: { type: 'string', description: 'Text to type' },
        locator: {
          type: 'string',
          enum: ['selector', 'role', 'text', 'label', 'placeholder'],
          description: 'How to find the element (default: selector)',
        },
        session: { type: 'string', description: 'Session ID' },
      },
      required: ['target', 'text'],
    },
    handler: async (input) => {
      const raw = input as {
        target?: unknown;
        text?: unknown;
        locator?: unknown;
        session?: unknown;
      };
      let sessionId: string;
      let target: string;
      try {
        sessionId = validateSessionId(raw.session);
        target = rejectFlagLike(raw.target, 'target');
      } catch (e) {
        return fail((e as Error).message);
      }
      if (typeof raw.text !== 'string') return fail('text: must be a string');
      const locator = typeof raw.locator === 'string' ? raw.locator : 'selector';
      try {
        const { typeText, fillElement } = await import('@monoes/monobrowse');
        const conn = await getConnection(sessionId);
        const ref = await findElement(conn, target, locator);
        // Focus by clicking (filling with empty string focuses without clearing for type)
        await fillElement(conn.client, conn.cdpSessionId, ref, '');
        await typeText(conn.client, conn.cdpSessionId, raw.text);
        touchSession(sessionId);
        return ok();
      } catch (e) {
        return fail((e as Error).message);
      }
    },
  },

  {
    name: 'browser_press',
    description:
      'Press a keyboard key or combo (e.g. "Enter", "Tab", "Escape", "Ctrl+A", "Shift+Tab")',
    category: 'browser',
    tags: ['interaction'],
    inputSchema: {
      type: 'object',
      properties: {
        key: {
          type: 'string',
          description: 'Key name or combo (Enter, Tab, Escape, Ctrl+A, Shift+Tab, etc.)',
        },
        session: { type: 'string', description: 'Session ID' },
      },
      required: ['key'],
    },
    handler: async (input) => {
      const raw = input as { key?: unknown; session?: unknown };
      let sessionId: string;
      let key: string;
      try {
        sessionId = validateSessionId(raw.session);
        key = rejectFlagLike(raw.key, 'key');
      } catch (e) {
        return fail((e as Error).message);
      }
      try {
        const { pressKey, pressKeyCombo } = await import('@monoes/monobrowse');
        const conn = await getConnection(sessionId);
        if (key.includes('+')) {
          const parts = key.split('+').map((k) => k.trim());
          const mainKey = parts[parts.length - 1];
          let bits = 0;
          for (const m of parts.slice(0, -1)) {
            switch (m.toLowerCase()) {
              case 'alt':
                bits |= 1;
                break;
              case 'ctrl':
              case 'control':
                bits |= 2;
                break;
              case 'meta':
              case 'cmd':
                bits |= 4;
                break;
              case 'shift':
                bits |= 8;
                break;
            }
          }
          await pressKeyCombo(conn.client, conn.cdpSessionId, mainKey, bits);
        } else {
          await pressKey(conn.client, conn.cdpSessionId, key);
        }
        touchSession(sessionId);
        return ok();
      } catch (e) {
        return fail((e as Error).message);
      }
    },
  },

  {
    name: 'browser_hover',
    description: 'Hover the mouse over an element',
    category: 'browser',
    tags: ['interaction'],
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
        const { hoverElement } = await import('@monoes/monobrowse');
        const conn = await getConnection(sessionId);
        const ref = await findElement(conn, target, locator);
        await hoverElement(conn.client, conn.cdpSessionId, ref);
        touchSession(sessionId);
        return ok();
      } catch (e) {
        return fail((e as Error).message);
      }
    },
  },

  {
    name: 'browser_select',
    description: 'Select an option from a <select> dropdown by value or label',
    category: 'browser',
    tags: ['interaction', 'form'],
    inputSchema: {
      type: 'object',
      properties: {
        target: {
          type: 'string',
          description: 'CSS selector, role, text, label, or placeholder for the <select>',
        },
        value: { type: 'string', description: 'Option value or visible text to select' },
        locator: {
          type: 'string',
          enum: ['selector', 'role', 'text', 'label', 'placeholder'],
          description: 'How to find the element (default: selector)',
        },
        session: { type: 'string', description: 'Session ID' },
      },
      required: ['target', 'value'],
    },
    handler: async (input) => {
      const raw = input as {
        target?: unknown;
        value?: unknown;
        locator?: unknown;
        session?: unknown;
      };
      let sessionId: string;
      let target: string;
      try {
        sessionId = validateSessionId(raw.session);
        target = rejectFlagLike(raw.target, 'target');
      } catch (e) {
        return fail((e as Error).message);
      }
      if (typeof raw.value !== 'string') return fail('value: must be a string');
      const locator = typeof raw.locator === 'string' ? raw.locator : 'selector';
      try {
        const { selectOption } = await import('@monoes/monobrowse');
        const conn = await getConnection(sessionId);
        const ref = await findElement(conn, target, locator);
        await selectOption(conn.client, conn.cdpSessionId, ref, raw.value);
        touchSession(sessionId);
        return ok();
      } catch (e) {
        return fail((e as Error).message);
      }
    },
  },

  {
    name: 'browser_check',
    description: 'Check a checkbox or radio button',
    category: 'browser',
    tags: ['interaction', 'form'],
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
        const { checkElement } = await import('@monoes/monobrowse');
        const conn = await getConnection(sessionId);
        const ref = await findElement(conn, target, locator);
        await checkElement(conn.client, conn.cdpSessionId, ref, true);
        touchSession(sessionId);
        return ok();
      } catch (e) {
        return fail((e as Error).message);
      }
    },
  },

  {
    name: 'browser_uncheck',
    description: 'Uncheck a checkbox',
    category: 'browser',
    tags: ['interaction', 'form'],
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
        const { checkElement } = await import('@monoes/monobrowse');
        const conn = await getConnection(sessionId);
        const ref = await findElement(conn, target, locator);
        await checkElement(conn.client, conn.cdpSessionId, ref, false);
        touchSession(sessionId);
        return ok();
      } catch (e) {
        return fail((e as Error).message);
      }
    },
  },

  {
    name: 'browser_scroll',
    description: 'Scroll the page or a specific element',
    category: 'browser',
    tags: ['interaction'],
    inputSchema: {
      type: 'object',
      properties: {
        direction: {
          type: 'string',
          enum: ['up', 'down', 'left', 'right'],
          description: 'Scroll direction',
        },
        amount: { type: 'number', description: 'Scroll amount in pixels (default 300)' },
        target: {
          type: 'string',
          description: 'Optional CSS selector to scroll a specific element',
        },
        session: { type: 'string', description: 'Session ID' },
      },
      required: ['direction'],
    },
    handler: async (input) => {
      const raw = input as {
        direction?: string;
        amount?: number;
        target?: unknown;
        session?: unknown;
      };
      let sessionId: string;
      try {
        sessionId = validateSessionId(raw.session);
      } catch (e) {
        return fail((e as Error).message);
      }
      const direction = (raw.direction as 'up' | 'down' | 'left' | 'right') ?? 'down';
      const amount = raw.amount ?? 300;
      try {
        const { scrollElement } = await import('@monoes/monobrowse');
        const conn = await getConnection(sessionId);
        if (raw.target !== undefined) {
          const ref = await findElement(conn, rejectFlagLike(raw.target, 'target'), 'selector');
          await scrollElement(conn.client, conn.cdpSessionId, direction, amount, ref);
        } else {
          await scrollElement(conn.client, conn.cdpSessionId, direction, amount);
        }
        touchSession(sessionId);
        return ok();
      } catch (e) {
        return fail((e as Error).message);
      }
    },
  },
];

export default browserInteractionTools;
