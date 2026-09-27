/**
 * Markup <-> prop-contract translation for live/svelte-component.mjs: mapping
 * mustache expressions in wrapped markup to named Svelte props (and back),
 * and parsing a variant .svelte file into its markup/CSS parts.
 *
 * Split out of live/svelte-component.mjs. See that file for context.
 */

const MUSTACHE_RE = /\{([^{}]+)\}/g;

export function extractMustacheExpressions(text) {
  const expressions = [];
  const seen = new Set();
  const lines = String(text || '').split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith('<!--')) continue;
    let match;
    MUSTACHE_RE.lastIndex = 0;
    while ((match = MUSTACHE_RE.exec(line)) !== null) {
      const expr = match[1].trim();
      if (!expr || seen.has(expr)) continue;
      seen.add(expr);
      expressions.push(expr);
    }
  }
  return expressions;
}

export function buildPropContract(expressions) {
  return expressions.map((expr, index) => {
    const derived = derivePropName(expr, index);
    return {
      prop: derived,
      expr,
      placeholder: `{${expr}}`,
    };
  });
}

function derivePropName(expr, index) {
  const tail = expr.match(/(?:\.|\[)(\w+)\s*\]?$/);
  if (tail?.[1] && /^[A-Za-z_$][\w$]*$/.test(tail[1])) {
    return tail[1];
  }
  return `prop${index}`;
}

export function substituteExprsWithProps(markup, contract) {
  let out = String(markup || '');
  for (const entry of contract) {
    out = out.split(entry.placeholder).join(`{${entry.prop}}`);
  }
  return out;
}

export function substitutePropsWithExprs(markup, contract) {
  let out = String(markup || '');
  for (const entry of contract) {
    out = out.split(`{${entry.prop}}`).join(`{${entry.expr}}`);
  }
  return out;
}

export function parseSvelteComponentFile(content) {
  const text = String(content || '');
  const scriptMatch = text.match(/^([\s\S]*?)<script\b[^>]*>[\s\S]*?<\/script>/i);
  const withoutScript = scriptMatch ? text.slice(scriptMatch[0].length) : text;
  const styleMatch = withoutScript.match(/<style\b[^>]*>[\s\S]*?<\/style\s*>/i);
  const styleBlock = styleMatch ? styleMatch[0] : '';
  const markup = styleMatch
    ? withoutScript.slice(0, styleMatch.index).trim()
    : withoutScript.trim();
  const cssLines = styleBlock
    ? styleBlock
      .replace(/^<style\b[^>]*>/i, '')
      .replace(/<\/style\s*>$/i, '')
      .split('\n')
      .map((line) => line.trimEnd())
    : [];
  while (cssLines.length > 0 && cssLines[0].trim() === '') cssLines.shift();
  while (cssLines.length > 0 && cssLines[cssLines.length - 1].trim() === '') cssLines.pop();
  return { markup, cssLines, styleBlock };
}

function buildPropsScript(contract) {
  if (contract.length === 0) {
    return '<script>\n  /** @type {Record<string, never>} */\n  let {} = $props();\n</script>\n';
  }
  const names = contract.map((c) => c.prop).join(', ');
  const typeFields = contract.map((c) => `    ${c.prop}: string;`).join('\n');
  return `<script>\n  /** @type {{\n${typeFields}\n  }} */\n  let { ${names} } = $props();\n</script>\n`;
}

export function buildVariantStub(variantNum, originalWithProps, contract) {
  const propsComment = contract.length > 0
    ? `\n<!-- Props: ${contract.map((c) => `${c.prop} <- {${c.expr}}`).join(', ')} -->\n`
    : '';
  return `${buildPropsScript(contract)}${propsComment}${originalWithProps.trim()}\n\n<style>\n  /* Variant ${variantNum}: add scoped CSS here */\n</style>\n`;
}

export function buildInsertVariantStub(variantNum) {
  return `${buildPropsScript([])}<div class="monodesign-insert-preview">Insert variant ${variantNum}</div>\n\n<style>\n  .monodesign-insert-preview { display: block; }\n</style>\n`;
}
