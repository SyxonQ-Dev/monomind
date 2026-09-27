/** Ownership check and legacy SessionStart hook removal for cursor/claude settings.json.
 * File-size sweep: split out of migration.ts.
 */

import { readFileSync } from 'node:fs';

export function isOwnedScript(path: string): boolean {
  try {
    return /monomind|mastermind/i.test(readFileSync(path, 'utf8'));
  } catch {
    return false;
  }
}

export function removeLegacyCursorHook(content: string): {
  content: string;
  changed: boolean;
  diagnostic?: string;
} {
  try {
    const parsed = JSON.parse(content) as Record<string, unknown>;
    const hooks = parsed.hooks;
    if (!hooks || typeof hooks !== 'object' || Array.isArray(hooks))
      return { content, changed: false };
    const entries = (hooks as Record<string, unknown>).SessionStart;
    if (!Array.isArray(entries)) return { content, changed: false };
    const retained = entries.filter(
      (entry) => !JSON.stringify(entry).includes('monomind-activate'),
    );
    if (retained.length === entries.length) return { content, changed: false };
    (hooks as Record<string, unknown>).SessionStart = retained;
    return { content: `${JSON.stringify(parsed, null, 2)}\n`, changed: true };
  } catch {
    return {
      content,
      changed: false,
      diagnostic: 'ERROR: cursor legacy settings are malformed; left unchanged',
    };
  }
}
