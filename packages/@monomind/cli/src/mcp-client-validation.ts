/**
 * CLI MCP Client — error type and input-schema validation helpers
 * Split out of mcp-client.ts (file-size sweep). Pure move.
 */

import type { MCPTool } from './mcp-tools/types.js';

/**
 * MCP Client Error
 */
export class MCPClientError extends Error {
  constructor(
    message: string,
    public toolName: string,
    public cause?: Error,
  ) {
    super(message);
    this.name = 'MCPClientError';
  }
}

/**
 * Runtime JSON-Schema type name for a JS value, or undefined for values we do
 * not model (functions, symbols, bigint). `null` is reported as 'null' so a
 * declared `type: 'object'` does not silently accept it.
 *
 * Note the two JS/JSON mismatches this has to paper over: arrays are objects
 * in JS but a distinct type in JSON Schema, and JSON has no integer type —
 * `integer` is a *number* with a constraint, so `3` satisfies both `number`
 * and `integer` while `3.5` satisfies only `number`.
 */
function jsonTypeOf(value: unknown): string | undefined {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  switch (typeof value) {
    case 'string':
      return 'string';
    case 'boolean':
      return 'boolean';
    case 'number':
      return Number.isInteger(value) ? 'integer' : 'number';
    case 'object':
      return 'object';
    default:
      return undefined;
  }
}

function matchesDeclaredType(declared: string, actual: string): boolean {
  if (declared === actual) return true;
  // Every integer is a valid number; the reverse is not true.
  if (declared === 'number' && actual === 'integer') return true;
  return false;
}

/**
 * Check present arguments against the `type` each property declares in the
 * tool's inputSchema and WARN on a mismatch — deliberately non-fatal for now.
 *
 * `required` is already hard-enforced above; `type` is not, because nothing
 * ever checked it, so a tool declaring `{type: 'string'}` has always been free
 * to receive a number and reach its handler. Turning that into a throw without
 * knowing how many real callers violate their own schemas would break working
 * code, so this logs first: run the suite, count the warnings, then decide.
 *
 * Absent properties are ignored — that is `required`'s job, not this one's.
 * Explicit null is also ignored here for the same reason (the required check
 * already rejects it for required params, and an optional param set to null is
 * an "unset" idiom, not a type error).
 */
export function warnOnTypeMismatch(
  toolName: string,
  schema: MCPTool['inputSchema'] | undefined,
  input: Record<string, unknown>,
): void {
  const properties = schema?.properties;
  if (!properties || typeof properties !== 'object') return;

  for (const [key, value] of Object.entries(input)) {
    if (value === undefined || value === null) continue;

    const prop = (properties as Record<string, unknown>)[key];
    if (!prop || typeof prop !== 'object') continue;

    const declared = (prop as { type?: unknown }).type;
    // Union types (`type: ['string','number']`) pass if any branch matches.
    const declaredList =
      typeof declared === 'string'
        ? [declared]
        : Array.isArray(declared) && declared.every((t) => typeof t === 'string')
          ? (declared as string[])
          : undefined;
    if (!declaredList || declaredList.length === 0) continue;

    const actual = jsonTypeOf(value);
    if (!actual) continue;
    if (declaredList.some((d) => matchesDeclaredType(d, actual))) continue;

    // Report `integer` as `number` — the distinction is an artefact of how we
    // classify JS numbers, not something the caller passed.
    const reported = actual === 'integer' ? 'number' : actual;
    console.error(
      `[mcp] tool '${toolName}' param '${key}': schema declares ` +
        `${declaredList.join('|')}, got ${reported}`,
    );
  }
}
