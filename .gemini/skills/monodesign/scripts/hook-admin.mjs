#!/usr/bin/env node
/**
 * The Monodesign hooks command manages the design hook runtime
 * via the `hook` key and shared detector ignores via the `detector` key in
 * .monodesign/config.json / .monodesign/config.local.json.
 *
 * Usage:
 *   node hook-admin.mjs status                         # print current state
 *   node hook-admin.mjs on                             # set enabled: true
 *   node hook-admin.mjs off                            # set enabled: false
 *   node hook-admin.mjs ignore-rule <rule-id>          # append to ignoreRules
 *   node hook-admin.mjs ignore-rule overused-font --all-values
 *   node hook-admin.mjs ignore-file <glob>             # append to ignoreFiles
 *   node hook-admin.mjs ignore-value <rule> <value>    # append to shared ignoreValues
 *   node hook-admin.mjs ignore-value <rule> <value> --local
 *   node hook-admin.mjs reset                          # remove all config + cache
 *
 * Designed to be invoked by the LLM from the reference/hooks.md flow.
 * Output is human-readable; the harness will pass it back to the user.
 */

import fs from 'node:fs';
import path from 'node:path';

import {
  getConfigPath,
  getLocalConfigPath,
  getCachePath,
  getPendingPath,
  readConfig,
} from './hook-lib.mjs';
import {
  readRawConfigFile,
  readRawHookConfig,
  mergeHookConfig,
  writeHookConfig,
} from './hook-admin-config.mjs';
import { repairHookManifests } from './hook-admin-manifest.mjs';
import { addIgnoreRule, addIgnoreFile, addIgnoreValue } from './hook-admin-ignore.mjs';

const ACTIONS = new Set(['status', 'on', 'off', 'ignore-rule', 'ignore-file', 'ignore-value', 'reset']);

function statusReport(cwd) {
  const shared = readRawConfigFile(getConfigPath(cwd));
  const local = readRawConfigFile(getLocalConfigPath(cwd));
  const cfg = readConfig(cwd);
  const envKill = process.env.MONODESIGN_HOOK_DISABLED;
  const envState = envKill ? `MONODESIGN_HOOK_DISABLED=${envKill}` : 'unset';
  const cfgPath = path.relative(cwd, getConfigPath(cwd)).split(path.sep).join('/') || '.monodesign/config.json';
  const localPath = path.relative(cwd, getLocalConfigPath(cwd)).split(path.sep).join('/') || '.monodesign/config.local.json';
  const cachePath = path.relative(cwd, getCachePath(cwd)).split(path.sep).join('/') || '.monodesign/hook.cache.json';
  const fileState = (info, relPath, absent) => {
    if (info.malformed) return `${relPath} (malformed; ignored)`;
    if (info.exists) return relPath;
    return `${relPath} (${absent})`;
  };
  const ignoreValues = cfg.ignoreValues.map((entry) => `${entry.rule}=${entry.value}`);

  const lines = [
    `Monodesign design hook`,
    `  state:        ${cfg.enabled ? 'enabled' : 'disabled'}`,
    `  shared file:  ${fileState(shared, cfgPath, 'using defaults; file not present')}`,
    `  local file:   ${fileState(local, localPath, 'not present')}`,
    `  ignoreRules:  ${cfg.ignoreRules.length ? cfg.ignoreRules.join(', ') : '(none)'}`,
    `  ignoreFiles:  ${cfg.ignoreFiles.length ? cfg.ignoreFiles.join(', ') : '(none)'}`,
    `  ignoreValues: ${ignoreValues.length ? ignoreValues.join(', ') : '(none)'}`,
    `  maxFindings:  ${cfg.limits.maxFindings}`,
    `  maxChars:     ${cfg.limits.maxChars}`,
    `  env override: ${envState}`,
    `  cache file:   ${fs.existsSync(getCachePath(cwd)) ? cachePath : `${cachePath} (not present)`}`,
  ];
  return lines.join('\n');
}

function setEnabled(cwd, value) {
  const config = mergeHookConfig(readRawHookConfig(cwd));
  config.enabled = value;
  const target = writeHookConfig(cwd, config);
  if (!value) {
    return `Design hook disabled for this project (wrote ${path.relative(cwd, target).split(path.sep).join('/') || target}).`;
  }

  const localTarget = writeHookConfig(cwd, { consent: 'accepted' }, { local: true });
  const repaired = repairHookManifests(cwd);
  const parts = [
    `Design hook enabled for this project (wrote ${path.relative(cwd, target).split(path.sep).join('/') || target}).`,
    `Recorded local hook consent in ${path.relative(cwd, localTarget).split(path.sep).join('/') || localTarget}.`,
  ];
  if (repaired.written.length > 0) {
    parts.push(`Installed or repaired hook manifests for: ${repaired.written.join(', ')}.`);
  } else if (repaired.already.length > 0) {
    parts.push(`Hook manifests already installed for: ${repaired.already.join(', ')}.`);
  } else {
    parts.push('No installed provider skill folders found to repair.');
  }
  if (repaired.backups.length > 0) {
    parts.push(`Backed up malformed manifest(s): ${repaired.backups.map((filePath) => path.relative(cwd, filePath).split(path.sep).join('/') || filePath).join(', ')}.`);
  }
  return parts.join(' ');
}

function reset(cwd) {
  const removed = [];
  // Unified files may hold non-hook keys (e.g. updateCheck); strip only the
  // hook/detector subtrees and keep the rest, deleting the file only if nothing remains.
  for (const filePath of [getConfigPath(cwd), getLocalConfigPath(cwd)]) {
    try {
      const raw = readRawConfigFile(filePath).raw;
      if (!raw || typeof raw !== 'object' || Array.isArray(raw) || (!('hook' in raw) && !('detector' in raw))) continue;
      const { hook, detector, ...rest } = raw;
      if (Object.keys(rest).length === 0) {
        fs.unlinkSync(filePath);
      } else {
        fs.writeFileSync(filePath, `${JSON.stringify(rest, null, 2)}\n`);
      }
      removed.push(path.relative(cwd, filePath).split(path.sep).join('/') || filePath);
    } catch { /* ignore */ }
  }
  // State files are wholly ours; delete outright.
  for (const filePath of [getCachePath(cwd), getPendingPath(cwd)]) {
    try {
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
        removed.push(path.relative(cwd, filePath).split(path.sep).join('/') || filePath);
      }
    } catch { /* ignore */ }
  }
  return removed.length
    ? `Reset design hook config and cache (removed: ${removed.join(', ')}).`
    : 'No hook config or cache to remove. Already at defaults.';
}

function main() {
  const [, , actionArg, ...rest] = process.argv;
  const action = (actionArg || 'status').toLowerCase();
  const cwd = process.cwd();

  if (!ACTIONS.has(action)) {
    process.stderr.write(`Unknown action: ${action}\nValid: ${Array.from(ACTIONS).join(', ')}\n`);
    process.exit(1);
  }

  try {
    let out = '';
    switch (action) {
      case 'status': out = statusReport(cwd); break;
      case 'on':     out = setEnabled(cwd, true); break;
      case 'off':    out = setEnabled(cwd, false); break;
      case 'ignore-rule': out = addIgnoreRule(cwd, rest); break;
      case 'ignore-file': out = addIgnoreFile(cwd, rest[0]); break;
      case 'ignore-value': out = addIgnoreValue(cwd, rest); break;
      case 'reset':  out = reset(cwd); break;
    }
    process.stdout.write(`${out}\n`);
  } catch (err) {
    process.stderr.write(`Error: ${err.message || err}\n`);
    process.exit(1);
  }
}

main();
