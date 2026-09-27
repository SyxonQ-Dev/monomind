/**
 * The `ignore-rule` / `ignore-file` / `ignore-value` hook-admin.mjs commands:
 * parsing their CLI args and merging the result into detector config.
 *
 * Split out of hook-admin.mjs. See that file for context.
 */
import path from 'node:path';
import { MONODESIGN_COMMAND } from './lib/provider.mjs';
import { normalizeIgnoreValue } from './hook-lib.mjs';
import {
  mergeDetectorConfig,
  readRawDetectorConfig,
  writeDetectorConfig,
} from './hook-admin-config.mjs';

function normalizeRuleId(rule) {
  return String(rule || '').trim().toLowerCase();
}

function parseIgnoreRuleArgs(args) {
  const positionals = [];
  let allValues = false;

  for (let i = 0; i < args.length; i++) {
    const arg = String(args[i] || '');
    if (arg === '--all-values') {
      allValues = true;
    } else if (arg === '--reason') {
      while (i + 1 < args.length && !String(args[i + 1]).startsWith('--')) i++;
    } else if (arg.startsWith('--reason=')) {
      // Accepted for command symmetry; ignoreRules stores rule ids only.
    } else if (arg.startsWith('--')) {
      throw new Error(`Unknown ignore-rule flag: ${arg}`);
    } else {
      positionals.push(arg);
    }
  }

  return {
    rule: normalizeRuleId(positionals[0]),
    allValues,
  };
}

export function addIgnoreRule(cwd, args) {
  const parsed = parseIgnoreRuleArgs(args);
  const rule = parsed.rule;
  if (!rule) throw new Error(`Pass a rule id, e.g. ${MONODESIGN_COMMAND} hooks ignore-rule side-tab`);
  if (rule === 'overused-font' && !parsed.allValues) {
    throw new Error(`overused-font is value-specific by default. Use ${MONODESIGN_COMMAND} hooks ignore-value overused-font <font> for a confirmed font, or ${MONODESIGN_COMMAND} hooks ignore-rule overused-font --all-values only when the user asked to ignore overused fonts generally.`);
  }
  const config = mergeDetectorConfig(readRawDetectorConfig(cwd));
  if (!config.ignoreRules.includes(rule)) config.ignoreRules.push(rule);
  writeDetectorConfig(cwd, config);
  return `Added "${rule}" to detector.ignoreRules. Current: ${config.ignoreRules.join(', ')}`;
}

export function addIgnoreFile(cwd, glob) {
  if (!glob) throw new Error(`Pass a glob, e.g. ${MONODESIGN_COMMAND} hooks ignore-file "src/legacy/**"`);
  const config = mergeDetectorConfig(readRawDetectorConfig(cwd));
  if (!config.ignoreFiles.includes(glob)) config.ignoreFiles.push(glob);
  writeDetectorConfig(cwd, config);
  return `Added "${glob}" to detector.ignoreFiles. Current: ${config.ignoreFiles.join(', ')}`;
}

function parseIgnoreValueArgs(args) {
  const positionals = [];
  let shared = false;
  let local = false;
  let reason = '';

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--shared') {
      shared = true;
    } else if (arg === '--local') {
      local = true;
    } else if (arg === '--reason') {
      const chunks = [];
      while (i + 1 < args.length && !String(args[i + 1]).startsWith('--')) {
        chunks.push(args[++i]);
      }
      reason = chunks.join(' ').trim();
    } else if (String(arg).startsWith('--reason=')) {
      reason = String(arg).slice('--reason='.length).trim();
    } else {
      positionals.push(arg);
    }
  }

  const [rule, ...valueParts] = positionals;
  return {
    rule: String(rule || '').trim().toLowerCase(),
    value: normalizeIgnoreValue(valueParts.join(' ')),
    shared,
    local,
    reason,
  };
}

export function addIgnoreValue(cwd, args) {
  const parsed = parseIgnoreValueArgs(args);
  if (!parsed.rule || !parsed.value) {
    throw new Error(`Pass a rule id and value, e.g. ${MONODESIGN_COMMAND} hooks ignore-value overused-font Inter`);
  }

  if (parsed.shared && parsed.local) {
    throw new Error('Pass only one scope flag: --shared or --local');
  }

  const local = parsed.local;
  const config = mergeDetectorConfig(readRawDetectorConfig(cwd, { local }));
  const key = `${parsed.rule}\0${parsed.value}`;
  const existing = config.ignoreValues.find((entry) => `${entry.rule}\0${entry.value}` === key);

  if (existing) {
    if (parsed.reason) existing.reason = parsed.reason;
  } else {
    const entry = {
      rule: parsed.rule,
      value: parsed.value,
      createdAt: new Date().toISOString(),
    };
    if (parsed.reason) entry.reason = parsed.reason;
    config.ignoreValues.push(entry);
  }

  const target = writeDetectorConfig(cwd, config, { local });
  const scope = local ? 'local detector.ignoreValues' : 'shared detector.ignoreValues';
  return `Added ${parsed.rule}=${parsed.value} to ${scope} (${path.relative(cwd, target).split(path.sep).join('/') || target}).`;
}
