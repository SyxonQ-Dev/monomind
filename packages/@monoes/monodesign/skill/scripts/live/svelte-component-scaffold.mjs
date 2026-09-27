/**
 * Scaffolding a new Svelte component-injection session for
 * live/svelte-component.mjs: writing the manifest and initial variant stub
 * files under the session's component directory.
 *
 * Split out of live/svelte-component.mjs. See that file for context.
 */
import fs from 'node:fs';
import path from 'node:path';
import {
  componentSessionDir,
  ensureRuntimeHelper,
  SVELTE_RUNTIME_FILE,
} from './svelte-component-session.mjs';
import {
  buildInsertVariantStub,
  buildPropContract,
  buildVariantStub,
  extractMustacheExpressions,
  substituteExprsWithProps,
} from './svelte-component-markup.mjs';

export function scaffoldSvelteComponentSession({
  id,
  count,
  sourceFile,
  sourceStartLine,
  sourceEndLine,
  originalLines,
  cwd = process.cwd(),
}) {
  ensureRuntimeHelper(cwd);
  const dir = componentSessionDir(id, cwd);
  fs.mkdirSync(dir, { recursive: true });

  const originalMarkup = originalLines.join('\n');
  const contract = buildPropContract(extractMustacheExpressions(originalMarkup));
  const originalWithProps = substituteExprsWithProps(originalMarkup, contract);

  const manifest = {
    id,
    previewMode: 'svelte-component',
    sourceFile: sourceFile.split(path.sep).join('/'),
    sourceStartLine,
    sourceEndLine,
    count,
    propContract: contract,
    originalMarkup,
    componentDir: path.relative(cwd, dir).split(path.sep).join('/'),
    runtimeModule: `/${SVELTE_RUNTIME_FILE}`,
  };

  fs.writeFileSync(path.join(dir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf-8');

  for (let n = 1; n <= count; n++) {
    const variantFile = path.join(dir, `v${n}.svelte`);
    if (!fs.existsSync(variantFile)) {
      fs.writeFileSync(variantFile, buildVariantStub(n, originalWithProps, contract), 'utf-8');
    }
  }

  return {
    manifest,
    manifestFile: path.relative(cwd, path.join(dir, 'manifest.json')).split(path.sep).join('/'),
    componentDir: manifest.componentDir,
    propContract: contract,
  };
}

export function scaffoldSvelteComponentInsertSession({
  id,
  count,
  sourceFile,
  insertLine,
  position,
  anchorStartLine,
  anchorEndLine,
  anchorLines,
  cwd = process.cwd(),
}) {
  ensureRuntimeHelper(cwd);
  const dir = componentSessionDir(id, cwd);
  fs.mkdirSync(dir, { recursive: true });

  const anchorMarkup = (anchorLines || []).join('\n');
  const manifest = {
    id,
    mode: 'insert',
    previewMode: 'svelte-component',
    sourceFile: sourceFile.split(path.sep).join('/'),
    insertLine,
    position,
    anchorStartLine,
    anchorEndLine,
    originalMarkup: anchorMarkup,
    anchorMarkup,
    count,
    propContract: [],
    componentDir: path.relative(cwd, dir).split(path.sep).join('/'),
    runtimeModule: `/${SVELTE_RUNTIME_FILE}`,
  };

  fs.writeFileSync(path.join(dir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf-8');

  for (let n = 1; n <= count; n++) {
    const variantFile = path.join(dir, `v${n}.svelte`);
    if (!fs.existsSync(variantFile)) {
      fs.writeFileSync(variantFile, buildInsertVariantStub(n), 'utf-8');
    }
  }

  return {
    manifest,
    manifestFile: path.relative(cwd, path.join(dir, 'manifest.json')).split(path.sep).join('/'),
    componentDir: manifest.componentDir,
    propContract: [],
  };
}
