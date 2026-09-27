/**
 * Svelte live-mode component injection helpers.
 *
 * Variants are real .svelte components under node_modules/.monodesign-live/<session-id>/.
 * The browser mounts them via Svelte 5 mount(); accept inlines the chosen
 * variant back into the route source with props mapped to original bindings.
 */

export {
  SVELTE_COMPONENT_ROOT,
  SVELTE_RUNTIME_FILE,
  DEFERRED_ACCEPTS_FILE,
  shouldUseSvelteComponentInjection,
  componentSessionDir,
  manifestPathForSession,
  ensureRuntimeHelper,
  findSvelteComponentManifest,
  readManifest,
  resolveSourceFile,
  removeSvelteComponentSession,
  removeAllSvelteComponentSessions,
  deferredAcceptsPath,
  readDeferredAccepts,
  writeDeferredAccept,
  applyDeferredSvelteComponentAccepts,
} from './svelte-component-session.mjs';
export {
  extractMustacheExpressions,
  buildPropContract,
  substituteExprsWithProps,
  substitutePropsWithExprs,
  parseSvelteComponentFile,
} from './svelte-component-markup.mjs';
export {
  scaffoldSvelteComponentSession,
  scaffoldSvelteComponentInsertSession,
} from './svelte-component-scaffold.mjs';
export {
  inlineSvelteComponentAccept,
} from './svelte-component-accept.mjs';

export function buildSvelteComponentCssAuthoring(count) {
  const variantNumbers = Array.from({ length: count }, (_, i) => i + 1);
  return {
    mode: 'svelte-component',
    styleTag: null,
    strategy: 'component-style-block',
    rulePattern: '.semantic-class { ... }',
    selectorExamples: variantNumbers.map(() => '.expense-row { padding: 22px; }'),
    requirements: [
      'Write each variant as a real Svelte component file (v1.svelte, v2.svelte, ...).',
      'Keep the prop names from propContract; bind dynamic text with {propName}, not literal snapshot text.',
      'Put variant CSS in the component <style> block using semantic class selectors.',
      'Author param-driven CSS against var(--p-<id>, default) and [data-p-<id>] using :global(...) so the runtime knob values reach the mounted root.',
      'Declare params in componentDir/params.json keyed by variant number (e.g. {"1": [...], "2": [...]}), NOT as a data-monodesign-params attribute.',
      'Do not use @scope or data-monodesign-variant selectors in component files.',
      'Do not edit the route source file during generation; only edit files under componentDir.',
    ],
    forbidden: [
      'Do not use @scope blocks in Svelte component variants.',
      'Do not copy live DOM snapshot text into markup when propContract provides bindings.',
      'Do not add data-monodesign-* attributes inside component files. Svelte parses { in attribute values as an expression, so data-monodesign-params with JSON breaks the build; use componentDir/params.json instead.',
    ],
    paramsFile: 'params.json',
  };
}
