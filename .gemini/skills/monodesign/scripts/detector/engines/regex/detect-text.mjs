import { checkSourceDesignSystem } from '../../design-system.mjs';
import { applyInlineIgnores } from '../../shared/inline-ignores.mjs';
import { filterByProviders } from '../../registry/antipatterns.mjs';
import { profileFindings, profileStep } from '../../profile/profiler.mjs';
import { REGEX_ANALYZERS, shouldRunPageAnalyzers, extFromFilePath } from './detect-text-matchers.mjs';
import {
  extractStyleBlocks,
  extractCSSinJS,
  runRegexMatchers,
  runStylesheetAnalyzers,
} from './detect-text-run.mjs';

function detectText(content, filePath, options = {}) {
  const profile = options?.profile;
  const findings = [];
  const lines = content.split('\n');
  const ext = extFromFilePath(filePath);

  // Run regex matchers on the full file content (catches Tailwind classes, inline styles)
  // Enable block context for CSS files where related properties span multiple lines
  const cssLike = new Set(['.css', '.scss', '.sass', '.less']);
  findings.push(...runRegexMatchers(lines, filePath, 0, cssLike.has(ext) || null, {
    profile,
    phase: 'source',
  }));

  // Extract and scan <style> blocks from Vue/Svelte SFCs
  const styleBlocks = profile
    ? profileStep(profile, {
      engine: 'regex',
      phase: 'extract',
      ruleId: 'style-blocks',
      target: filePath,
    }, () => extractStyleBlocks(content, ext))
    : extractStyleBlocks(content, ext);
  for (const block of styleBlocks) {
    const blockLines = block.content.split('\n');
    findings.push(...runRegexMatchers(blockLines, filePath, block.startLine - 1, true, {
      profile,
      phase: 'style-block',
    }));
  }

  // Extract and scan CSS-in-JS template literals
  const cssJsBlocks = profile
    ? profileStep(profile, {
      engine: 'regex',
      phase: 'extract',
      ruleId: 'css-in-js',
      target: filePath,
    }, () => extractCSSinJS(content, ext))
    : extractCSSinJS(content, ext);
  for (const block of cssJsBlocks) {
    const blockLines = block.content.split('\n');
    findings.push(...runRegexMatchers(blockLines, filePath, block.startLine - 1, true, {
      profile,
      phase: 'css-in-js',
    }));
  }

  if (options?.designSystem) {
    findings.push(...profileFindings(profile, {
      engine: 'regex',
      phase: 'source',
      ruleId: 'design-system',
      target: filePath,
    }, () => checkSourceDesignSystem(content, filePath, { designSystem: options.designSystem })));
  }

  // Deduplicate findings (same antipattern + similar snippet, within 2 lines)
  const deduped = [];
  for (const f of findings) {
    const isDupe = deduped.some(d =>
      d.antipattern === f.antipattern &&
      d.snippet === f.snippet &&
      Math.abs(d.line - f.line) <= 2
    );
    if (!isDupe) deduped.push(f);
  }

  // Page-level analyzers only run on full pages
  if (shouldRunPageAnalyzers(content, filePath)) {
    const analyzerIds = [
      'single-font',
      'flat-type-hierarchy',
      'monotonous-spacing',
      'em-dash-overuse',
      'marketing-buzzword',
      'numbered-section-markers',
      'aphoristic-cadence',
      'dark-glow',
    ];
    for (let i = 0; i < REGEX_ANALYZERS.length; i++) {
      const analyzer = REGEX_ANALYZERS[i];
      deduped.push(...profileFindings(profile, {
        engine: 'regex',
        phase: 'page-analyzer',
        ruleId: analyzerIds[i] || `analyzer-${i + 1}`,
        target: filePath,
      }, () => analyzer(content, filePath)));
    }
  }

  // Stylesheet-level accessibility analyzers (focus-visible, hover-only,
  // dark-scheme). Run on CSS-like sources and full HTML pages.
  deduped.push(...runStylesheetAnalyzers(content, filePath, options));

  const byProvider = filterByProviders(deduped, options?.providers);
  // Inline `monodesign-disable*` waivers travel with the file; honor them unless
  // explicitly bypassed (`--no-config` / `--no-inline-ignores`).
  return options?.inlineIgnores === false ? byProvider : applyInlineIgnores(byProvider, content);
}


export { REGEX_MATCHERS, REGEX_ANALYZERS } from './detect-text-matchers.mjs';
export {
  extractStyleBlocks,
  extractCSSinJS,
  runRegexMatchers,
  TEXT_CONTENT_ANALYZER_IDS,
  runTextContentAnalyzers,
  runStylesheetAnalyzers,
} from './detect-text-run.mjs';
export { detectText };
