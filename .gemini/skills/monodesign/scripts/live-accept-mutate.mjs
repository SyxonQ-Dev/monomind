/**
 * Discard/accept source rewrites for live-accept.mjs: restoring the original
 * element (discard) or splicing in the chosen variant with a carbonize
 * wrapper for any colocated CSS (accept).
 *
 * Split out of live-accept.mjs. See that file for context.
 */
import fs from 'node:fs';
import {
  deindentContent,
  detectCommentSyntax,
  expandReplaceRange,
  extractCss,
  extractOriginal,
  extractVariant,
  findMarkerBlock,
} from './live-accept-parse.mjs';

export function handleDiscard(id, lines, targetFile) {
  const block = findMarkerBlock(id, lines);
  if (!block) return { handled: false, error: 'Markers not found' };

  const original = extractOriginal(lines, block);
  const isJsx = detectCommentSyntax(targetFile).open === '{/*';
  const replaceRange = expandReplaceRange(block, lines, isJsx);

  // Restore at the line we're actually replacing FROM, not the marker line.
  // For JSX wrappers the marker comments live INSIDE the outer `<div>`, so
  // `block.start` sits 2 spaces deeper than the original element. Using that
  // as the deindent base would push the restored content 2 spaces too far
  // right on every JSX/TSX session. `replaceRange.start` is the outer wrapper
  // line, which is at the original element's indent for both HTML and JSX.
  const indent = lines[replaceRange.start].match(/^(\s*)/)[1];
  const restored = deindentContent(original, indent);

  const newLines = [
    ...lines.slice(0, replaceRange.start),
    ...restored,
    ...lines.slice(replaceRange.end + 1),
  ];
  fs.writeFileSync(targetFile, newLines.join('\n'), 'utf-8');
  return {};
}

function buildCarbonizeReplacement({
  indent,
  commentSyntax,
  isJsx,
  id,
  variantNum,
  cssContent,
  paramValues,
  restored,
}) {
  const lines = [];
  if (!cssContent) {
    lines.push(...restored);
    return lines;
  }

  const variantStyleAttr = isJsx
    ? "style={{ display: 'contents' }}"
    : 'style="display: contents"';

  const pushCarbonizeBody = (bodyIndent) => {
    const bodyRestored = reindentContent(restored, indent, `${bodyIndent}  `);
    lines.push(`${bodyIndent + commentSyntax.open} monodesign-carbonize-start ${id} ${commentSyntax.close}`);
    lines.push(`${bodyIndent}<style data-monodesign-css="${id}">${isJsx ? '{`' : ''}`);
    for (const cssLine of cssContent) {
      lines.push(bodyIndent + cssLine.trimStart());
    }
    lines.push(bodyIndent + (isJsx ? '`}</style>' : '</style>'));
    if (paramValues && Object.keys(paramValues).length > 0) {
      lines.push(
        `${bodyIndent + commentSyntax.open} monodesign-param-values ${id}: ${JSON.stringify(paramValues)} ${commentSyntax.close}`,
      );
    }
    lines.push(`${bodyIndent + commentSyntax.open} monodesign-carbonize-end ${id} ${commentSyntax.close}`);
    lines.push(`${bodyIndent}<div data-monodesign-variant="${variantNum}" ${variantStyleAttr}>`);
    lines.push(...bodyRestored);
    lines.push(`${bodyIndent}</div>`);
  };

  if (isJsx) {
    const wrapperStyle = 'style={{ display: "contents" }}';
    lines.push(`${indent}<div data-monodesign-carbonize="${id}" ${wrapperStyle}>`);
    pushCarbonizeBody(`${indent}  `);
    lines.push(`${indent}</div>`);
  } else {
    pushCarbonizeBody(indent);
  }

  return lines;
}

function reindentContent(contentLines, fromIndent, toIndent) {
  return contentLines.map((line) => {
    if (line.trim() === '') return '';
    if (line.startsWith(fromIndent)) return toIndent + line.slice(fromIndent.length);
    return toIndent + line.trimStart();
  });
}

export function handleAccept(id, variantNum, lines, targetFile, paramValues) {
  const block = findMarkerBlock(id, lines);
  if (!block) return { handled: false, error: 'Markers not found' };

  const commentSyntax = detectCommentSyntax(targetFile);
  const isJsx = commentSyntax.open === '{/*';
  // Anchor indent on the line we're replacing FROM (the outer wrapper),
  // not on `block.start` — for JSX that's the marker comment 2 spaces
  // deeper than the original element. See handleDiscard for the full
  // rationale.
  const replaceRange = expandReplaceRange(block, lines, isJsx);
  const indent = lines[replaceRange.start].match(/^(\s*)/)[1];

  // Extract the chosen variant's inner content
  const variantContent = extractVariant(lines, block, variantNum);
  if (!variantContent) return { handled: false, error: `Variant ${variantNum} not found` };
  const originalContent = extractOriginal(lines, block);

  // Extract CSS block if present
  const cssContent = extractCss(lines, block, id);

  // Check if carbonizing is needed:
  // - CSS block exists, OR
  // - variant HTML contains helper classes/attributes that need cleanup
  const variantText = variantContent.join('\n');
  const hasHelperAttrs = variantText.includes('data-monodesign-variant');
  const needsCarbonize = !!(cssContent || hasHelperAttrs);

  const restored = deindentContent(variantContent, indent);
  const replacement = buildCarbonizeReplacement({
    indent,
    commentSyntax,
    isJsx,
    id,
    variantNum,
    cssContent,
    paramValues,
    restored,
  });

  const newLines = [
    ...lines.slice(0, replaceRange.start),
    ...replacement,
    ...lines.slice(replaceRange.end + 1),
  ];
  fs.writeFileSync(targetFile, newLines.join('\n'), 'utf-8');

  return { carbonize: needsCarbonize, acceptedOriginalText: originalContent.join('\n') };
}
