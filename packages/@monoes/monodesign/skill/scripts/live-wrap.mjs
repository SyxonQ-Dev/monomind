/**
 * CLI helper: find an element in source and wrap it in a variant container.
 *
 * Usage:
 *   node <scripts_path>/live-wrap.mjs --id SESSION_ID --count N --query "hero-combined-left" [--file path]
 *
 * Searches project files for the element matching the query (class name, ID, or
 * text snippet), wraps it with the variant scaffolding, and prints the file path
 * + line range where the agent should insert variant HTML.
 *
 * This replaces 3-4 agent tool calls (grep + read + edit) with a single CLI call.
 */

import fs from 'node:fs';
import path from 'node:path';
import { isGeneratedFile } from './lib/is-generated.mjs';
import { readBuffer as readManualEditsBuffer } from './live/manual-edits-buffer.mjs';
import {
  buildSvelteComponentCssAuthoring,
  scaffoldSvelteComponentSession,
  shouldUseSvelteComponentInjection,
} from './live/svelte-component.mjs';

import {
  argVal,
  pendingEntriesThatMayAffectWrap,
  manualEditMayAffectWrap,
  applyBufferedManualEditToLines,
} from './live-wrap-manual-edit.mjs';
import {
  buildSearchQueries,
  detectCommentSyntax,
  detectStyleMode,
  buildCssSelectorPrefixExamples,
  buildCssAuthoring,
} from './live-wrap-css.mjs';
import {
  findFileWithQuery,
  minLeadingSpaces,
  findElement,
  findAllElements,
  filterByText,
  findClosingLine,
} from './live-wrap-search.mjs';

export async function wrapCli() {
  const args = process.argv.slice(2);

  if (args.includes('--help') || args.includes('-h')) {
    console.log(`Usage: monodesign wrap [options]

Find an element in source and wrap it in a variant container.

Required:
  --id ID            Session ID for the variant wrapper
  --count N          Number of expected variants (1-8)

Element identification (at least one required):
  --element-id ID    HTML id attribute of the element
  --classes A,B,C    Comma- or space-separated CSS class names
  --tag TAG          Tag name (div, section, etc.)
  --query TEXT       Fallback: raw text to search for

Optional:
  --file PATH        Source file to search in (skips auto-detection)
  --text TEXT        Picked element's textContent. Used to disambiguate when
                     classes/tag match multiple sibling elements (e.g. a list
                     of <Card>s with the same className). Pass the first ~80
                     chars of event.element.textContent.
  --page-url URL     Current page URL. Required when pending manual edits may
                     affect the picked source block. Pending edits are filtered
                     to this page so an edit on /a doesn't bleed into /b.
  --help             Show this help message

Output (JSON):
  { file, startLine, endLine, insertLine, commentSyntax }

The agent should insert variant HTML at insertLine.`);
    process.exit(0);
  }

  const id = argVal(args, '--id');
  // biome-ignore lint/correctness/useParseIntRadix: --count is caller-supplied CLI input; radix 10 would change how a 0x value parses
  const count = parseInt(argVal(args, '--count') || '3');
  const elementId = argVal(args, '--element-id');
  const classes = argVal(args, '--classes');
  const tag = argVal(args, '--tag');
  const query = argVal(args, '--query');
  const filePath = argVal(args, '--file');
  const text = argVal(args, '--text');
  const pageUrl = argVal(args, '--page-url');

  if (!id) { console.error('Missing --id'); process.exit(1); }
  if (!elementId && !classes && !query) {
    console.error('Need at least one of: --element-id, --classes, --query');
    process.exit(1);
  }

  // Build search queries in priority order (most specific first)
  const queries = buildSearchQueries(elementId, classes, tag, query);

  const genOpts = { cwd: process.cwd() };

  // Find the source file. Generated files are excluded from auto-search so we
  // don't silently write variants into a file the next build will wipe.
  let targetFile = filePath;
  if (!targetFile) {
    for (const q of queries) {
      targetFile = findFileWithQuery(q, process.cwd(), genOpts);
      if (targetFile) break;
    }
    if (!targetFile) {
      // Nothing in source. Did the element show up in a generated file? That
      // tells the agent "fall back to the agent-driven flow" vs "element just
      // doesn't exist in this project."
      let generatedHit = null;
      for (const q of queries) {
        generatedHit = findFileWithQuery(q, process.cwd(), { ...genOpts, includeGenerated: true });
        if (generatedHit) break;
      }
      if (generatedHit) {
        console.error(JSON.stringify({
          error: 'element_not_in_source',
          fallback: 'agent-driven',
          generatedMatch: path.relative(process.cwd(), generatedHit).split(path.sep).join('/'),
          hint: 'Element found only in a generated file. See "Handle fallback" in live.md.',
        }));
      } else {
        console.error(JSON.stringify({
          error: 'element_not_found',
          fallback: 'agent-driven',
          hint: 'Element not found in any project file. It may be runtime-injected (JS component, etc.). See "Handle fallback" in live.md.',
        }));
      }
      process.exit(1);
    }
  } else {
    if (isGeneratedFile(targetFile, genOpts)) {
      console.error(JSON.stringify({
        error: 'file_is_generated',
        fallback: 'agent-driven',
        file: path.relative(process.cwd(), path.resolve(process.cwd(), targetFile)).split(path.sep).join('/'),
        hint: 'Explicit --file points at a generated file. Writing here gets wiped by the next build. See "Handle fallback" in live.md.',
      }));
      process.exit(1);
    }
  }

  const content = fs.readFileSync(targetFile, 'utf-8');
  const lines = content.split('\n');

  // Find the element, trying each query in priority order. When `--text` is
  // supplied, collect every candidate the queries surface and disambiguate
  // by the picked element's textContent. Without `--text`, fall back to the
  // legacy first-match behavior so unmodified callers keep working.
  let match = null;
  if (text) {
    const candidates = [];
    for (const q of queries) {
      const all = findAllElements(lines, q, tag);
      for (const c of all) {
        if (!candidates.some((x) => x.startLine === c.startLine)) {
          candidates.push(c);
        }
      }
      // Once a more-specific query (ID, full className combo) yielded a unique
      // result, stop — falling through to the loose tag+single-class query
      // would readmit the siblings we just disambiguated past.
      if (candidates.length === 1) break;
    }
    if (candidates.length === 0) {
      console.error(JSON.stringify({ error: `Found file but could not locate element in ${targetFile}. Searched for: ${queries.join(', ')}` }));
      process.exit(1);
    }
    if (candidates.length === 1) {
      match = candidates[0];
    } else {
      const filtered = filterByText(candidates, lines, text);
      if (filtered.length === 1) {
        match = filtered[0];
      } else if (filtered.length === 0) {
        // Source uses dynamic content (`<h1>{title}</h1>` etc.) so the
        // browser-side textContent doesn't appear literally in source. Fall
        // back to first-match rather than refusing — this is the same
        // behavior unmodified callers see, just preserved.
        match = candidates[0];
      } else {
        // Multiple candidates ALSO match the text. Truly ambiguous — refuse
        // rather than pick wrong, and hand the agent the candidate locations
        // so it can disambiguate by reading the file.
        console.error(JSON.stringify({
          error: 'element_ambiguous',
          fallback: 'agent-driven',
          file: path.relative(process.cwd(), targetFile).split(path.sep).join('/'),
          candidates: filtered.map((c) => ({
            startLine: c.startLine + 1,
            endLine: c.endLine + 1,
          })),
          hint: 'Multiple source elements match both classes/tag and textContent. Pass --element-id, a more specific --text, or write the wrapper manually. See "Handle fallback" in live.md.',
        }));
        process.exit(1);
      }
    }
  } else {
    for (const q of queries) {
      match = findElement(lines, q, tag);
      if (match) break;
    }
    if (!match) {
      console.error(JSON.stringify({ error: `Found file but could not locate element in ${targetFile}. Searched for: ${queries.join(', ')}` }));
      process.exit(1);
    }
  }

  const { startLine, endLine } = match;
  const commentSyntax = detectCommentSyntax(targetFile);
  const styleMode = detectStyleMode(targetFile);
  const isJsx = commentSyntax.open === '{/*';
  const indent = lines[startLine].match(/^(\s*)/)[1];

  // Extract the original element. Reindent under the wrapper while preserving
  // the relative depth between lines — `l.trimStart()` would strip ALL leading
  // whitespace and collapse e.g. `<aside>`/`  <h1>`/`</aside>` (6/8/6 spaces)
  // to a single uniform indent, so on accept/discard the round-trip restores
  // the inner element at its parent's depth instead of nested inside it.
  // Strip only the COMMON minimum leading whitespace across the picked lines;
  // `deindentContent` on the accept side already mirrors this convention.
  let originalLines = lines.slice(startLine, endLine + 1);

  // Buffer-aware "original" content: if the user has pending manual edits for
  // this page whose originalText appears in the picked source range, apply
  // them so the wrap block's "original" variant reflects what the user was
  // looking at (their edited DOM), not the raw source. Source itself stays
  // untouched here — only the wrap block's embedded "original" copy is
  // adjusted. The pending edits remain in the buffer until committed.
  //
  // Apply buffered edits only when the browser provided the current page URL.
  // Without it, fail if pending edits plausibly touch this exact source range;
  // otherwise skip buffer awareness so unrelated staged edits on another page
  // do not block normal wrap work.
  let pendingBuffer = { entries: [] };
  try { pendingBuffer = readManualEditsBuffer(process.cwd()); } catch {}
  const pendingEntriesForTarget = pageUrl
    ? []
    : pendingEntriesThatMayAffectWrap(pendingBuffer.entries, targetFile, originalLines, startLine, process.cwd());
  if (pendingEntriesForTarget.length > 0) {
    console.error(JSON.stringify({
      error: 'missing_page_url_with_pending_edits',
      pendingEntries: pendingEntriesForTarget.length,
      hint: 'Pending manual edits may affect the selected source block. Pass --page-url=$event.pageUrl so the wrap block reflects the user\'s staged DOM.',
    }));
    process.exit(1);
  }
  if (pageUrl) {
    const failedBufferedOps = [];
    for (const entry of pendingBuffer.entries || []) {
      if (entry.pageUrl !== pageUrl) continue;
      for (const op of entry.ops || []) {
        const mayAffectWrap = manualEditMayAffectWrap(op, targetFile, originalLines, startLine, process.cwd());
        const result = applyBufferedManualEditToLines(originalLines, startLine, op);
        if (result.changed) {
          originalLines = result.lines;
          continue;
        }
        if (!mayAffectWrap) continue;
        failedBufferedOps.push({
          entryId: entry.id,
          ref: op?.ref || null,
          originalText: op?.originalText || null,
          reason: 'ambiguous_or_unmatched_pending_edit',
        });
      }
    }
    if (failedBufferedOps.length > 0) {
      console.error(JSON.stringify({
        error: 'manual_edit_buffer_apply_failed',
        pendingOps: failedBufferedOps,
        hint: 'A staged copy edit appears to affect the selected source block, but could not be applied unambiguously to the wrap original. Apply or discard copy edits first, or write the wrapper manually.',
      }));
      process.exit(1);
    }
  }

  const originalBaseIndent = minLeadingSpaces(originalLines);
  const reindentOriginal = (extra) => originalLines
    .map((l) => (l.trim() === '' ? '' : indent + extra + l.slice(originalBaseIndent)))
    .join('\n');
  const originalIndented = reindentOriginal('    ');
  const relTargetFile = path.relative(process.cwd(), targetFile).split(path.sep).join('/');
  const useSvelteComponent = shouldUseSvelteComponentInjection(targetFile);

  // Wrapper attributes differ by syntax. HTML allows plain string attrs;
  // JSX requires object-literal style and parses string attrs as HTML (which
  // either type-errors or renders a literal CSS string).
  const styleContents = isJsx ? 'style={{ display: "contents" }}' : 'style="display: contents"';

  // JSX/TSX guard: the picked element occupies a single JSX child slot
  // (inside `return (...)`, an array `.map(...)`, an `asChild` branch, or
  // any other expression position). Replacing it with `comment + <div> +
  // comment` yields three adjacent siblings — invalid JSX. We can't use a
  // Fragment `<></>` either: parents that clone children (Radix `asChild`,
  // Headless UI, etc.) hit "Invalid prop supplied to React.Fragment" when
  // they try to pass an `id` through.
  //
  // Solution: keep the wrapper `<div>` as the single JSX-slot child and
  // tuck both marker comments INSIDE it. accept/discard then expands its
  // replacement range to include the wrapper's `<div>` open / close lines
  // so the entire scaffold gets removed cleanly.
  const wrapperLines = isJsx ? [
    `${indent}<div data-monodesign-variants="${id}" data-monodesign-variant-count="${count}" ${styleContents}>`,
    `${indent}  ${commentSyntax.open} monodesign-variants-start ${id} ${commentSyntax.close}`,
    `${indent}  ${commentSyntax.open} Original ${commentSyntax.close}`,
    `${indent}  <div data-monodesign-variant="original">`,
    reindentOriginal('    '),
    `${indent}  </div>`,
    `${indent}  ${commentSyntax.open} Variants: insert below this line ${commentSyntax.close}`,
    `${indent}  ${commentSyntax.open} monodesign-variants-end ${id} ${commentSyntax.close}`,
    `${indent}</div>`,
  ] : [
    `${indent + commentSyntax.open} monodesign-variants-start ${id} ${commentSyntax.close}`,
    `${indent}<div data-monodesign-variants="${id}" data-monodesign-variant-count="${count}" ${styleContents}>`,
    `${indent}  ${commentSyntax.open} Original ${commentSyntax.close}`,
    `${indent}  <div data-monodesign-variant="original">`,
    originalIndented,
    `${indent}  </div>`,
    `${indent}  ${commentSyntax.open} Variants: insert below this line ${commentSyntax.close}`,
    `${indent}</div>`,
    `${indent + commentSyntax.open} monodesign-variants-end ${id} ${commentSyntax.close}`,
  ];

  let outputFile = targetFile;
  let outputStartLine = startLine + 1;
  let outputEndLine = startLine + wrapperLines.length + (originalLines.length - 1);
  let insertLine;
  let svelteSession = null;

  if (useSvelteComponent) {
    // Svelte/SvelteKit resets component-local state on markup HMR updates.
    // Keep generation source-neutral: agents write real variant components
    // under the generated componentDir, the browser mounts them into the live
    // DOM, and live-accept.mjs inlines the accepted variant back into the route.
    svelteSession = scaffoldSvelteComponentSession({
      id,
      count,
      sourceFile: relTargetFile,
      sourceStartLine: startLine + 1,
      sourceEndLine: endLine + 1,
      originalLines,
      cwd: process.cwd(),
    });
    outputFile = path.resolve(process.cwd(), svelteSession.manifestFile);
    outputStartLine = 1;
    outputEndLine = 1;
    insertLine = 1;
  } else {
    // Replace the original element with the wrapper
    const newLines = [
      ...lines.slice(0, startLine),
      ...wrapperLines,
      ...lines.slice(endLine + 1),
    ];
    fs.writeFileSync(targetFile, newLines.join('\n'), 'utf-8');

    // Calculate insert line (the "insert below this line" comment).
    // 0-indexed file position. Both HTML and JSX wrappers have 6 lines above
    // the insert marker (HTML: start-comment + outer-div + Original-comment +
    // original-div + content + close-original-div; JSX: outer-div +
    // start-comment + Original-comment + original-div + content +
    // close-original-div). Multi-line originals push the marker by their
    // extra line count.
    insertLine = startLine + 6 + (originalLines.length - 1) + 1;
  }

  const outputRelFile = path.relative(process.cwd(), outputFile).split(path.sep).join('/');

  const svelteComponentAuthoring = useSvelteComponent ? buildSvelteComponentCssAuthoring(count) : null;

  console.log(JSON.stringify({
    file: outputRelFile,
    sourceFile: useSvelteComponent ? relTargetFile : undefined,
    previewMode: useSvelteComponent ? 'svelte-component' : undefined,
    componentDir: svelteSession?.componentDir,
    propContract: svelteSession?.propContract,
    sourceStartLine: useSvelteComponent ? startLine + 1 : undefined,
    sourceEndLine: useSvelteComponent ? endLine + 1 : undefined,
    startLine: outputStartLine,       // 1-indexed for the agent
    // wrapperLines is an array but one element (the original-content slot)
    // is a `\n`-joined multi-line string, so the actual file-row count is
    // wrapperLines.length + (originalLines.length - 1). Without the offset,
    // endLine pointed inside the wrapper for any picked element that
    // spanned more than one source line.
    endLine: outputEndLine, // 1-indexed
    insertLine,            // 1-indexed: where variants go
    commentSyntax: commentSyntax,
    styleMode: useSvelteComponent ? 'svelte-component' : styleMode.mode,
    styleTag: useSvelteComponent ? null : styleMode.styleTag,
    cssSelectorPrefixExamples: useSvelteComponent ? [] : buildCssSelectorPrefixExamples(styleMode.mode, count),
    cssAuthoring: useSvelteComponent ? svelteComponentAuthoring : buildCssAuthoring(styleMode, count),
    originalLineCount: originalLines.length,
  }));
}

// Auto-execute when run directly (node live-wrap.mjs ...)
const _running = process.argv[1];
if (_running?.endsWith('live-wrap.mjs') || _running?.endsWith('live-wrap.mjs/')) {
  wrapCli();
}

// Test exports (used by tests/live-wrap.test.mjs)
export {
  buildSearchQueries,
  findElement,
  findClosingLine,
  detectCommentSyntax,
  findAllElements,
  filterByText,
  findFileWithQuery,
  detectStyleMode,
  buildCssAuthoring,
  buildCssSelectorPrefixExamples,
};
