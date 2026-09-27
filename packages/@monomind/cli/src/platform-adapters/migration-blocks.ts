/** Managed-block extraction and migration into the current marker format.
 * File-size sweep: split out of migration.ts.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { mergeManagedBlock, removeManagedMarker } from './merge.js';
import type { LegacySurface } from './migration-inventory.js';

/** Remove only old marker blocks; callers retain unrelated content and keys. */
export function removeLegacyManagedBlocks(content: string): string {
  return removeManagedMarker(
    removeManagedMarker(content, 'instructions:codex'),
    'instructions:opencode',
  )
    .replace(/\n?<!--\s*monomind:start\s*-->[\s\S]*?<!--\s*monomind:end\s*-->\n?/g, '\n')
    .replace(/\n?#\s*monomind:start\s*[\s\S]*?#\s*monomind:end\s*\n?/g, '\n');
}

/** Recover a YAML file corrupted by the historical HTML comment installer. */
export function deCorruptAiderYaml(content: string): string {
  const cleaned = content
    .replace(/\n?<!--\s*monomind:start\s*-->[\s\S]*?<!--\s*monomind:end\s*-->\n?/g, '\n')
    .trimEnd();
  if (/^read:\s*/m.test(cleaned)) return `${cleaned}\n`;
  return `${cleaned ? `${cleaned}\n` : ''}read: CONVENTIONS.md\n`;
}

const BARE_BLOCK =
  /(?:<!--\s*)?monomind:start\s*-->(?:\r?\n)?([\s\S]*?)(?:<!--\s*)?monomind:end\s*-->(?:\r?\n)?/i;
const HASH_BARE_BLOCK = /#\s*monomind:start\s*(?:\r?\n)?([\s\S]*?)#\s*monomind:end\s*(?:\r?\n)?/i;

export function takeLegacyBlock(content: string): { body: string; remainder: string } | undefined {
  const match = BARE_BLOCK.exec(content) ?? HASH_BARE_BLOCK.exec(content);
  if (!match) return undefined;
  return {
    body: match[1]!.trim(),
    remainder: `${content.slice(0, match.index)}${content.slice(match.index + match[0].length)}`,
  };
}

function instructionMarker(surface: LegacySurface, body: string): string | undefined {
  switch (surface.id) {
    case 'trae-rules':
      return 'instructions:trae';
    case 'kiro-steering':
      return 'instructions:kiro';
    case 'claude-bare-instruction-markers':
      return 'instructions:claude';
    case 'gemini-bare-instruction-markers':
      return 'instructions:gemini';
    case 'copilot-bare-instruction-markers':
      return 'instructions:copilot';
    case 'cursor-bare-instruction-markers':
      return 'instructions:cursor';
    case 'bare-instruction-markers':
      // AGENTS.md is shared by several runtimes. Old installs did not retain
      // their writer id, so use only an explicit self-identification; the
      // conservative Codex fallback matches the legacy Codex writer.
      if (/\bopencode\b/i.test(body)) return 'instructions:opencode';
      if (/\bdroid\b/i.test(body)) return 'instructions:droid';
      if (/\bopenclaw\b/i.test(body)) return 'instructions:openclaw';
      if (/\bkimi\b/i.test(body)) return 'instructions:kimi';
      return 'instructions:codex';
    default:
      return undefined;
  }
}

export function writeMigratedInstructions(
  root: string,
  surface: LegacySurface,
  original: string,
  beforeWrite: ((path: string) => void) | undefined,
): { changed: boolean; paths: string[] } {
  const extracted = takeLegacyBlock(original);
  if (!extracted) return { changed: false, paths: [] };

  if (surface.id === 'openclaw-config') {
    const target = join(root, 'AGENTS.md');
    const targetContent = existsSync(target) ? readFileSync(target, 'utf8') : '';
    const migrated = mergeManagedBlock(targetContent, 'instructions:openclaw', extracted.body);
    beforeWrite?.(target);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, migrated, 'utf8');
    beforeWrite?.(join(root, surface.path));
    writeFileSync(join(root, surface.path), extracted.remainder, 'utf8');
    return { changed: true, paths: ['AGENTS.md', surface.path] };
  }

  const marker = instructionMarker(surface, extracted.body);
  if (!marker) return { changed: false, paths: [] };

  const migrated = mergeManagedBlock(extracted.remainder, marker, extracted.body);
  beforeWrite?.(join(root, surface.path));
  writeFileSync(join(root, surface.path), migrated, 'utf8');
  return { changed: true, paths: [surface.path] };
}
