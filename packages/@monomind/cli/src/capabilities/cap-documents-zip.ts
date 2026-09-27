import fs from 'node:fs';
import { unzipSync } from 'fflate';

// Split out of cap-documents.ts (file-size sweep). Pure move: no behaviour change.

// ── ZIP-based XML text extraction (pptx, odt, odp, ods, epub) ──────
// These formats are all ZIP archives containing XML/HTML with text content.
// Read with fflate (pure JS, no native deps, no shell-out) so this works
// identically on macOS/Linux/Windows — a prior version shelled out to the
// `unzip` CLI, which isn't available on Windows by default.

export function readZipEntries(filePath: string): Record<string, Uint8Array> {
  const buffer = fs.readFileSync(filePath);
  return unzipSync(new Uint8Array(buffer));
}

export function textFromZipEntries(
  entries: Record<string, Uint8Array>,
  xmlPaths: string[],
  stripTags: boolean,
): string {
  const parts: string[] = [];

  for (const xmlPath of xmlPaths) {
    const bytes = entries[xmlPath];
    if (bytes) parts.push(Buffer.from(bytes).toString('utf-8'));
  }
  if (parts.length === 0) {
    // Fallback: any XML/HTML/XHTML entries (e.g. EPUB chapters, whose names
    // aren't known ahead of time)
    const candidates = Object.keys(entries)
      .filter((f) => /\.(xml|html|xhtml)$/i.test(f))
      .slice(0, 50);
    for (const c of candidates) parts.push(Buffer.from(entries[c]).toString('utf-8'));
  }

  const joined = parts.join('\n');
  if (!stripTags) return joined;
  return joined
    .replace(/<[^>]+>/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#\d+;/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export async function extractFromZip(
  filePath: string,
  xmlPaths: string[],
  stripTags: boolean,
): Promise<string> {
  return textFromZipEntries(readZipEntries(filePath), xmlPaths, stripTags);
}
