// live-wrap search-query construction + per-file CSS/comment authoring
// helpers. Split out of live-wrap.mjs (file-size sweep — pure move, no
// behaviour change).

import path from 'node:path';

/**
 * Build search query strings in priority order (most specific first).
 * ID is most reliable, then specific class combos, then single classes, then raw query.
 */
function buildSearchQueries(elementId, classes, tag, query) {
  const queries = [];

  // 1. ID is the most specific
  if (elementId) {
    queries.push(`id="${elementId}"`);
  }

  // 2. Full class attribute match (for elements with distinctive multi-class combos).
  // Emit both class="..." (HTML) and className="..." (React/JSX) so whichever
  // convention the file uses will match.
  if (classes) {
    const classList = splitClassList(classes);
    if (classList.length > 1) {
      const joined = classList.join(' ');
      const sorted = [...classList].sort((a, b) => b.length - a.length);
      queries.push(`class="${joined}"`);
      queries.push(`className="${joined}"`);
      for (const className of sorted) {
        queries.push(className);
      }
    } else if (classList.length === 1) {
      queries.push(classList[0]);
    }
  }

  // 3. Tag + class combo (e.g., <section class="hero">).
  // Same dual-emit for JSX compatibility.
  if (tag && classes) {
    const firstClass = splitClassList(classes)[0];
    queries.push(`<${tag} class="${firstClass}`);
    queries.push(`<${tag} className="${firstClass}`);
  }

  // 4. Raw fallback query
  if (query) {
    queries.push(query);
  }

  return queries;
}

function splitClassList(classes) {
  return String(classes).split(/[,\s]+/).map(c => c.trim()).filter(Boolean);
}

function detectCommentSyntax(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.jsx' || ext === '.tsx') {
    return { open: '{/*', close: '*/}' };
  }
  // HTML, Vue, Svelte, Astro all use HTML comments
  return { open: '<!--', close: '-->' };
}

function detectStyleMode(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.astro') {
    return {
      mode: 'astro-global-prefixed',
      styleTag: '<style is:inline data-monodesign-css="SESSION_ID">',
    };
  }
  return {
    mode: 'scoped',
    styleTag: '<style data-monodesign-css="SESSION_ID">',
  };
}

function buildCssSelectorPrefixExamples(styleMode, count) {
  if (styleMode !== 'astro-global-prefixed') return [];
  return Array.from({ length: count }, (_, i) => `[data-monodesign-variant="${i + 1}"]`);
}

function buildCssAuthoring(styleMode, count) {
  const variantNumbers = Array.from({ length: count }, (_, i) => i + 1);
  if (styleMode.mode === 'astro-global-prefixed') {
    return {
      mode: styleMode.mode,
      styleTag: styleMode.styleTag,
      strategy: 'global-prefixed',
      rulePattern: '[data-monodesign-variant="N"] > .variant-class { ... }',
      selectorExamples: variantNumbers.map((n) => `[data-monodesign-variant="${n}"] > .variant-class`),
      requirements: [
        'Use the styleTag exactly; the is:inline attribute is required for this file.',
        'Put raw CSS directly between the styleTag opening and a plain </style> close.',
        'Prefix every preview selector with the matching [data-monodesign-variant="N"] selector.',
        'Keep selectors anchored to the generated variant wrapper; do not rely on component CSS scoping for preview rules.',
      ],
      forbidden: [
        'Do not use @scope for this styleMode.',
        'Do not wrap style content in a JSX/TSX template literal ({` ... `}); that syntax is for .tsx/.jsx only.',
        'Do not put { immediately after the style opening tag; Astro parses { as expression syntax.',
      ],
    };
  }
  return {
    mode: styleMode.mode,
    styleTag: styleMode.styleTag,
    strategy: 'scope-rule',
    rulePattern: '@scope ([data-monodesign-variant="N"]) { :scope > .variant-class { ... } }',
    selectorExamples: variantNumbers.map((n) => `@scope ([data-monodesign-variant="${n}"]) { :scope > .variant-class { ... } }`),
    requirements: [
      'Use @scope blocks keyed to each [data-monodesign-variant="N"] wrapper.',
      'Inside each @scope block, make :scope rules step into the replacement element with a descendant combinator.',
      'Use the styleTag exactly; do not add framework-specific style attributes unless this object says to.',
    ],
    forbidden: [
      'Do not use global [data-monodesign-variant="N"] selector prefixes for this styleMode.',
      'Do not add is:inline to the style tag for this styleMode.',
    ],
  };
}

export {
  buildSearchQueries,
  splitClassList,
  detectCommentSyntax,
  detectStyleMode,
  buildCssSelectorPrefixExamples,
  buildCssAuthoring,
};
