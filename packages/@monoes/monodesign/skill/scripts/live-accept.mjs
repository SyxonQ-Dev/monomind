/**
 * CLI helper: deterministic accept/discard of variant sessions.
 *
 * Usage:
 *   node live-accept.mjs --id SESSION_ID --discard
 *   node live-accept.mjs --id SESSION_ID --variant N
 *
 * For discard: removes the entire variant wrapper and restores the original.
 * For accept: replaces the wrapper with the chosen variant's content. If the
 * session had a colocated <style> block, it's preserved with carbonize markers
 * for a background agent to integrate into the project's CSS.
 *
 * Output: JSON to stdout.
 */

import path from 'node:path';
import { isGeneratedFile } from './lib/is-generated.mjs';
import {
  applyDeferredSvelteComponentAccepts,
  findSvelteComponentManifest,
  inlineSvelteComponentAccept,
  removeSvelteComponentSession,
} from './live/svelte-component.mjs';
import { findSessionFile } from './live-accept-search.mjs';
import {
  detectCommentSyntax,
  deindentContent,
  extractCss,
  extractOriginal,
  extractVariant,
  findMarkerBlock,
  readSourceShadowPreviewMeta,
} from './live-accept-parse.mjs';
import { handleAccept, handleDiscard } from './live-accept-mutate.mjs';
import {
  scrubManualEditsAgainstFile,
  scrubManualEditsAgainstOriginalBlock,
} from './live-accept-scrub.mjs';

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

export async function acceptCli() {
  const args = process.argv.slice(2);

  if (args.includes('--help') || args.includes('-h')) {
    console.log(`Usage: node live-accept.mjs [options]

Deterministic accept/discard for live variant sessions.

Modes:
  --discard          Remove variants, restore original
  --variant N        Accept variant N, discard the rest

Required:
  --id SESSION_ID    Session ID of the variant wrapper

Options:
  --page-url URL     Current browser page URL; scopes staged copy-edit cleanup
  --defer-source-write
                     Deprecated compatibility flag. Svelte component accepts
                     now write the real source immediately.

Output (JSON):
  { handled, file, carbonize }`);
    process.exit(0);
  }

  const id = argVal(args, '--id');
  const variantNum = argVal(args, '--variant');
  const paramValuesRaw = argVal(args, '--param-values');
  const pageUrl = argVal(args, '--page-url');
  const isDiscard = args.includes('--discard');

  if (!id) { console.error('Missing --id'); process.exit(1); }
  if (!isDiscard && !variantNum) { console.error('Need --discard or --variant N'); process.exit(1); }

  let paramValues = null;
  if (paramValuesRaw) {
    try { paramValues = JSON.parse(paramValuesRaw); }
    catch { paramValues = null; } // malformed blob: skip the comment rather than failing the accept
  }

  // Find the file containing this session's markers
  const found = findSessionFile(id, process.cwd());
  const svelteComponentManifest = found ? null : findSvelteComponentManifest(id, process.cwd());

  if (!found && !svelteComponentManifest) {
    console.log(JSON.stringify({ handled: false, error: `Session markers not found for id: ${id}` }));
    process.exit(0);
  }

  if (svelteComponentManifest) {
    if (isDiscard) {
      removeSvelteComponentSession(id, process.cwd());
      console.log(JSON.stringify({
        handled: true,
        file: svelteComponentManifest.sourceFile,
        carbonize: false,
        previewMode: 'svelte-component',
        componentDir: svelteComponentManifest.componentDir,
      }));
      return;
    }

    let result;
    try {
      result = inlineSvelteComponentAccept(
        svelteComponentManifest,
        variantNum,
        paramValues,
        process.cwd(),
      );
    } catch (err) {
      result = {
        handled: false,
        error: err.message,
        file: svelteComponentManifest.sourceFile,
        sourceFile: svelteComponentManifest.sourceFile,
        previewMode: 'svelte-component',
        componentDir: svelteComponentManifest.componentDir,
      };
    }
    if (result.carbonize) {
      result.todo = `REQUIRED before next poll: carbonize cleanup in ${result.file}. See reference/live.md "Required after accept".`;
    }
    console.log(JSON.stringify({ handled: result.handled !== false, ...result }));
    return;
  }

  const { file: targetFile, content, lines } = found;
  const relFile = path.relative(process.cwd(), targetFile).split(path.sep).join('/');
  const previewBlock = findMarkerBlock(id, lines);
  const sourceShadowPreview = previewBlock
    ? readSourceShadowPreviewMeta(content, id)
    : null;

  if (sourceShadowPreview) {
    console.log(JSON.stringify({
      handled: false,
      error: 'source_shadow_preview_deprecated',
      hint: 'Svelte live mode now uses svelte-component injection. Re-wrap the element and regenerate variants.',
    }));
    process.exit(0);
  }

  if (isGeneratedFile(targetFile, { cwd: process.cwd() })) {
    console.log(JSON.stringify({
      handled: false,
      mode: 'fallback',
      file: relFile,
      hint: 'Session is in a generated file. Persist the accepted variant in source; do not rely on this script.',
    }));
    process.exit(0);
  }

  if (isDiscard) {
    const result = handleDiscard(id, lines, targetFile);
    console.log(JSON.stringify({ handled: true, file: relFile, carbonize: false, ...result }));
  } else {
    const result = handleAccept(id, variantNum, lines, targetFile, paramValues);
    const acceptedOriginalText = result.acceptedOriginalText || '';
    delete result.acceptedOriginalText;
    // Single-line attention-grabber when cleanup is required. The full
    // five-step checklist lives in reference/live.md (loaded once per
    // session); repeating it per-event would waste tokens.
    if (result.carbonize) {
      result.todo = `REQUIRED before next poll: carbonize cleanup in ${relFile}. See reference/live.md "Required after accept".`;
    }
    // Scrub stash entries whose text appeared inside the just-replaced
    // original wrap block. The accept embodies those manual edits (wrap was
    // buffer-aware), so only those scoped ops are redundant.
    if (result.handled !== false) {
      try {
        scrubManualEditsAgainstOriginalBlock(acceptedOriginalText, process.cwd(), pageUrl);
      } catch {
        // Non-fatal; the buffer stays as-is and the user can discard later.
      }
    }
    console.log(JSON.stringify({ handled: true, file: relFile, ...result }));
  }
}

function argVal(args, flag) {
  const idx = args.indexOf(flag);
  return idx !== -1 && idx + 1 < args.length ? args[idx + 1] : null;
}

// Auto-execute when run directly
const _running = process.argv[1];
if (_running?.endsWith('live-accept.mjs') || _running?.endsWith('live-accept.mjs/')) {
  acceptCli();
}

export { findMarkerBlock, extractOriginal, extractVariant, extractCss, deindentContent, detectCommentSyntax, scrubManualEditsAgainstFile, scrubManualEditsAgainstOriginalBlock, applyDeferredSvelteComponentAccepts };
