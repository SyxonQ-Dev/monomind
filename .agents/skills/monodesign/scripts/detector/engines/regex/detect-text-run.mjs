// Running the regex matcher/analyzer tables against source text: style-block
// and CSS-in-JS extraction, and the three run* entry points (regex matchers,
// text-content analyzers, stylesheet analyzers). Split out of detect-text.mjs
// (file-size sweep — pure move, no behaviour change).

import { isFullPage } from '../../shared/page.mjs';
import { finding } from '../../findings.mjs';
import { profileFindings } from '../../profile/profiler.mjs';
import {
  checkFocusVisible,
  checkHoverOnlyAffordance,
  checkDarkSchemeContrast,
} from '../../rules/checks.mjs';
import { REGEX_MATCHERS, REGEX_ANALYZERS, shouldRunPageAnalyzers, extFromFilePath } from './detect-text-matchers.mjs';

function extractStyleBlocks(content, ext) {
  ext = ext.toLowerCase();
  if (ext !== '.vue' && ext !== '.svelte') return [];
  const blocks = [];
  const re = /<style[^>]*>([\s\S]*?)<\/style>/gi;
  let m;
  while ((m = re.exec(content)) !== null) {
    const before = content.substring(0, m.index);
    const startLine = before.split('\n').length + 1;
    blocks.push({ content: m[1], startLine });
  }
  return blocks;
}

// ---------------------------------------------------------------------------
// CSS-in-JS extraction (styled-components, emotion)
// ---------------------------------------------------------------------------

const CSS_IN_JS_EXTENSIONS = new Set(['.js', '.ts', '.jsx', '.tsx']);

function extractCSSinJS(content, ext) {
  ext = ext.toLowerCase();
  if (!CSS_IN_JS_EXTENSIONS.has(ext)) return [];
  const blocks = [];
  const re = /(?:styled(?:\.\w+|\([^)]+\))|css)\s*`([\s\S]*?)`/g;
  let m;
  while ((m = re.exec(content)) !== null) {
    const before = content.substring(0, m.index);
    const startLine = before.split('\n').length;
    blocks.push({ content: m[1], startLine });
  }
  return blocks;
}

function runRegexMatchers(lines, filePath, lineOffset = 0, blockContext = null, options = {}) {
  const { profile, phase = 'regex-matchers' } = options || {};
  const findings = [];
  if (!profile) {
    for (const matcher of REGEX_MATCHERS) {
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        matcher.regex.lastIndex = 0;
        let m;
        while ((m = matcher.regex.exec(line)) !== null) {
          // For extracted blocks, use nearby lines as context for multi-line CSS patterns
          const context = blockContext
            ? lines.slice(Math.max(0, i - 3), Math.min(lines.length, i + 4)).join(' ')
            : line;
          if (matcher.test(m, context)) {
            findings.push(finding(matcher.id, filePath, matcher.fmt(m, context), i + 1 + lineOffset));
          }
        }
      }
    }
    return findings;
  }

  for (const matcher of REGEX_MATCHERS) {
    const matcherFindings = profileFindings(profile, {
      engine: 'regex',
      phase,
      ruleId: matcher.id,
      target: filePath,
    }, () => {
      const matches = [];
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        matcher.regex.lastIndex = 0;
        let m;
        while ((m = matcher.regex.exec(line)) !== null) {
          // For extracted blocks, use nearby lines as context for multi-line CSS patterns
          const context = blockContext
            ? lines.slice(Math.max(0, i - 3), Math.min(lines.length, i + 4)).join(' ')
            : line;
          if (matcher.test(m, context)) {
            matches.push(finding(matcher.id, filePath, matcher.fmt(m, context), i + 1 + lineOffset));
          }
        }
      }
      return matches;
    });
    findings.push(...matcherFindings);
  }
  return findings;
}

/** Page-level analyzers that scan rendered text content (em-dash use,
 *  buzzword phrases, numbered section markers, aphoristic cadence).
 *  These are detector-agnostic — they work on any HTML/text source
 *  and don't need a parsed DOM. Exported so detectHtml can call them
 *  for `.html` files (which otherwise skip the regex engine). */
const TEXT_CONTENT_ANALYZER_IDS = [
  'em-dash-overuse',
  'marketing-buzzword',
  'numbered-section-markers',
  'aphoristic-cadence',
];

function runTextContentAnalyzers(content, filePath, options = {}) {
  const profile = options?.profile;
  if (!shouldRunPageAnalyzers(content, filePath)) return [];
  // The 4 text-content analyzers are at indices 3-6 in REGEX_ANALYZERS.
  const findings = [];
  for (let i = 0; i < TEXT_CONTENT_ANALYZER_IDS.length; i++) {
    const analyzer = REGEX_ANALYZERS[3 + i];
    const ruleId = TEXT_CONTENT_ANALYZER_IDS[i];
    findings.push(...profileFindings(profile, {
      engine: 'regex',
      phase: 'text-content',
      ruleId,
      target: filePath,
    }, () => analyzer(content, filePath)));
  }
  return findings;
}

// Extract raw CSS text from a source file for the stylesheet-level analyzers
// (focus-visible, hover-only, dark-scheme). CSS-like files are CSS wholesale;
// everything else contributes only its <style> block contents so tag markup
// and inline styles don't confuse the flat CSS parser.
const CSS_LIKE_EXTS = new Set(['.css', '.scss', '.sass', '.less']);
function extractStylesheetText(content, ext) {
  if (CSS_LIKE_EXTS.has(ext)) return content;
  const blocks = [];
  const re = /<style[^>]*>([\s\S]*?)<\/style>/gi;
  let m;
  while ((m = re.exec(content)) !== null) blocks.push(m[1]);
  return blocks.join('\n');
}

const STYLESHEET_ANALYZERS = [
  { id: 'missing-focus-visible', run: checkFocusVisible },
  { id: 'hover-only-affordance', run: checkHoverOnlyAffordance },
  { id: 'dark-scheme-contrast-blindspot', run: checkDarkSchemeContrast },
];

// Run the stylesheet-level analyzers over a source file's CSS. Applies to
// CSS-like sources and to full HTML pages (which carry <style> blocks).
function runStylesheetAnalyzers(content, filePath, options = {}) {
  const profile = options?.profile;
  const ext = extFromFilePath(filePath);
  const isCssLike = CSS_LIKE_EXTS.has(ext);
  if (!isCssLike && !isFullPage(content)) return [];
  const cssText = extractStylesheetText(content, ext);
  if (!cssText.trim()) return [];
  const findings = [];
  for (const analyzer of STYLESHEET_ANALYZERS) {
    const hits = profileFindings(profile, {
      engine: 'regex',
      phase: 'stylesheet',
      ruleId: analyzer.id,
      target: filePath,
    }, () => analyzer.run(cssText));
    for (const h of hits) findings.push(finding(h.id, filePath, h.snippet));
  }
  return findings;
}


export {
  extractStyleBlocks,
  CSS_IN_JS_EXTENSIONS,
  extractCSSinJS,
  runRegexMatchers,
  TEXT_CONTENT_ANALYZER_IDS,
  runTextContentAnalyzers,
  CSS_LIKE_EXTS,
  extractStylesheetText,
  STYLESHEET_ANALYZERS,
  runStylesheetAnalyzers,
};
