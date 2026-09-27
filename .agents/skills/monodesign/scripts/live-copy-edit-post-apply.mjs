// Post-apply verification: JSON/JS syntax checks, JSX/TSX parse checks,
// leftover monodesign marker detection, and the project's own
// manual-edit-validate script. Split out of live-copy-edit-agent.mjs
// (file-size sweep — pure move, no behaviour change).

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { isPathInsideOrEqual } from './live-copy-edit-runners.mjs';

const require = createRequire(import.meta.url);

export function runCopyEditPostApplyChecks({ cwd = process.cwd(), files = [] } = {}) {
  const failures = [];
  const warnings = [];
  const uniqueFiles = [...new Set((files || []).filter((file) => typeof file === 'string' && file.trim()))];
  for (const relativeFile of uniqueFiles) {
    const file = path.resolve(cwd, relativeFile);
    if (!isPathInsideOrEqual(cwd, file) || !fs.existsSync(file)) {
      warnings.push({ file: relativeFile, reason: 'file_missing_or_outside_cwd' });
      continue;
    }
    let content = '';
    try { content = fs.readFileSync(file, 'utf-8'); } catch (err) {
      failures.push({ file: relativeFile, reason: 'read_failed', message: err.message });
      continue;
    }
    const markerMatch = findLeftoverMonodesignMarker(content);
    if (markerMatch) failures.push({ file: relativeFile, reason: 'leftover_monodesign_marker', marker: markerMatch });
    if (/\.json$/.test(relativeFile)) {
      try {
        JSON.parse(content);
      } catch (err) {
        failures.push({
          file: relativeFile,
          reason: 'invalid_json',
          message: err.message || String(err),
        });
      }
    }
    const syntaxCheck = checkFrameworkSourceSyntax(relativeFile, content);
    if (syntaxCheck?.failure) failures.push(syntaxCheck.failure);
    if (syntaxCheck?.warning) warnings.push(syntaxCheck.warning);
    if (/\.(mjs|cjs|js)$/.test(relativeFile)) {
      const check = spawnSync(process.execPath, ['--check', file], { cwd, encoding: 'utf-8' });
      if (check.status !== 0) {
        failures.push({
          file: relativeFile,
          reason: 'invalid_js',
          message: (check.stderr || check.stdout || '').trim(),
        });
      }
    }
  }
  const validation = runManualEditValidationScript(cwd);
  if (validation?.failure) failures.push(validation.failure);
  if (validation?.warning) warnings.push(validation.warning);
  return { ok: failures.length === 0, failures, warnings };
}

function checkFrameworkSourceSyntax(relativeFile, content) {
  if (!/\.(jsx|tsx|ts)$/.test(relativeFile)) return null;
  let parser;
  try {
    parser = require('@babel/parser');
  } catch {
    return { warning: { file: relativeFile, reason: 'syntax_parser_unavailable' } };
  }
  const plugins = ['jsx'];
  if (/\.(ts|tsx)$/.test(relativeFile)) plugins.push('typescript');
  try {
    parser.parse(content, {
      sourceType: 'module',
      plugins,
      errorRecovery: false,
    });
    return null;
  } catch (err) {
    return {
      failure: {
        file: relativeFile,
        reason: 'invalid_source_syntax',
        message: err.message || String(err),
      },
    };
  }
}

function findLeftoverMonodesignMarker(content) {
  const commentMarker = content.match(/^\s*(?:<!--|\{\/\*)\s*monodesign-carbonize-(?:start|end)\b|^\s*(?:<!--|\{\/\*)\s*monodesign-variants-(?:start|end)\b/m);
  if (commentMarker) return commentMarker[0];

  const attrPattern = /\bdata-monodesign-(?:variants?|original-text|editable|text-wrap)\s*=/g;
  for (const line of content.split(/\r?\n/)) {
    attrPattern.lastIndex = 0;
    let match;
    while ((match = attrPattern.exec(line))) {
      if (!isInsideQuotedLiteral(line, match.index)) return match[0];
    }
  }
  return null;
}

function isInsideQuotedLiteral(line, index) {
  let quote = null;
  let escaped = false;
  for (let i = 0; i < index; i++) {
    const ch = line[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === '\\') {
      escaped = true;
      continue;
    }
    if (quote) {
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') quote = ch;
  }
  return quote !== null;
}

function runManualEditValidationScript(cwd) {
  const script = readManualEditValidationScript(cwd);
  if (!script) return null;
  const validation = spawnSync(script, {
    cwd,
    encoding: 'utf-8',
    shell: true,
    timeout: 30_000,
  });
  if (validation.error) {
    return {
      failure: {
        file: 'package.json',
        reason: 'manual_edit_validation_failed',
        message: validation.error.message || String(validation.error),
      },
    };
  }
  if (validation.status !== 0) {
    return {
      failure: {
        file: 'package.json',
        reason: 'manual_edit_validation_failed',
        message: [validation.stderr, validation.stdout].filter(Boolean).join('\n').trim(),
      },
    };
  }
  return null;
}

function readManualEditValidationScript(cwd) {
  const pkgPath = path.join(cwd, 'package.json');
  if (!fs.existsSync(pkgPath)) return null;
  try {
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
    const script = pkg?.scripts?.['monodesign:manual-edit-validate'];
    return typeof script === 'string' && script.trim() ? script : null;
  } catch {
    return null;
  }
}

export {
  checkFrameworkSourceSyntax,
  findLeftoverMonodesignMarker,
  isInsideQuotedLiteral,
  runManualEditValidationScript,
  readManualEditValidationScript,
};
