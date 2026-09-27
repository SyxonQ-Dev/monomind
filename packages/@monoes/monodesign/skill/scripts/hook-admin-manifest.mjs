/**
 * Installing/repairing the design-hook manifest for each supported provider
 * (.claude, .agents/Codex, .cursor, .github) for hook-admin.mjs.
 *
 * Split out of hook-admin.mjs. See that file for context.
 */
import fs from 'node:fs';
import path from 'node:path';

const MONODESIGN_HOOK_COMMAND_MARKERS = [
  'skills/monodesign/scripts/hook-probe.mjs',
  'skills/monodesign/scripts/hook.mjs',
  'skills/monodesign/scripts/hook-before-edit.mjs',
  'skills/monodesign/scripts/hook-after-edit.mjs',
  'skills/monodesign/scripts/hook-stop.mjs',
];
const TIMEOUT_SECONDS = 5;
const STATUS_MESSAGE = 'Checking UI changes';

const HOOK_MANIFEST_TARGETS = [
  {
    provider: '.claude',
    skillRel: '.claude/skills/monodesign',
    destRel: '.claude/settings.local.json',
    sharedDestRel: '.claude/settings.json',
    manifest: () => ({
      description: 'Monodesign design detector: runs after Edit/Write/MultiEdit on UI files and surfaces findings as system reminders.',
      hooks: {
        PostToolUse: [
          {
            matcher: 'Edit|Write|MultiEdit',
            hooks: [
              {
                type: 'command',
                command: 'node "${CLAUDE_PROJECT_DIR}/.claude/skills/monodesign/scripts/hook.mjs"',
                timeout: TIMEOUT_SECONDS,
                statusMessage: STATUS_MESSAGE,
              },
            ],
          },
        ],
      },
    }),
  },
  {
    provider: '.agents',
    skillRel: '.agents/skills/monodesign',
    destRel: '.codex/config.toml',
    format: 'toml',
    manifest: () => [
      '# monodesign:start native-hook',
      '[[hooks.PostToolUse]]',
      'matcher = "Edit|Write|apply_patch"',
      '[[hooks.PostToolUse.hooks]]',
      'type = "command"',
      'command = "node .agents/skills/monodesign/scripts/hook.mjs"',
      `timeout = ${TIMEOUT_SECONDS}`,
      `statusMessage = "${STATUS_MESSAGE}"`,
      '# monodesign:end native-hook',
      '',
    ].join('\n'),
  },
  {
    provider: '.cursor',
    skillRel: '.cursor/skills/monodesign',
    destRel: '.cursor/hooks.json',
    manifest: () => ({
      version: 1,
      hooks: {
        preToolUse: [
          {
            command: 'node ".cursor/skills/monodesign/scripts/hook-before-edit.mjs"',
            timeout: TIMEOUT_SECONDS,
          },
        ],
      },
    }),
  },
  {
    // GitHub Copilot reads repo-level hooks from `.github/hooks/*.json`. The same
    // manifest is honored by the CLI (once committed to the default branch) and
    // the cloud/app agent. Schema differs: lowercase `postToolUse`, flat entries,
    // `bash`/`timeoutSec`, and a `matcher` regex against the `edit`/`create` tools.
    provider: '.github',
    skillRel: '.github/skills/monodesign',
    destRel: '.github/hooks/monodesign.json',
    manifest: () => ({
      version: 1,
      hooks: {
        postToolUse: [
          {
            type: 'command',
            matcher: 'edit|create|apply_patch',
            bash: 'node "$(git rev-parse --show-toplevel)/.github/skills/monodesign/scripts/hook.mjs"',
            timeoutSec: TIMEOUT_SECONDS,
          },
        ],
      },
    }),
  },
];

export function repairHookManifests(cwd) {
  const result = { written: [], already: [], backups: [] };
  for (const target of HOOK_MANIFEST_TARGETS) {
    if (!fs.existsSync(path.join(cwd, target.skillRel))) continue;
    const dest = path.join(cwd, target.destRel);
    const sharedDest = target.sharedDestRel ? path.join(cwd, target.sharedDestRel) : null;

    if (target.format === 'toml') {
      const current = fs.existsSync(dest) ? safeReadText(dest) : '';
      const next = mergeCodexHookConfig(current || '', target.manifest());
      if (current === next) {
        result.already.push(target.provider);
        continue;
      }
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, next);
      result.written.push(target.provider);
      continue;
    }

    if (sharedDest && fileHasMonodesignHookMarker(sharedDest)) {
      pruneMonodesignHookFromManifest(dest);
      result.already.push(target.provider);
      continue;
    }

    const fresh = target.manifest();
    let next = fresh;
    if (fs.existsSync(dest)) {
      try {
        next = mergeHookManifests(JSON.parse(fs.readFileSync(dest, 'utf-8')), fresh);
      } catch {
        const backup = `${dest}.bak`;
        fs.copyFileSync(dest, backup);
        result.backups.push(backup);
      }
    }

    const serialized = `${JSON.stringify(next, null, 2)}\n`;
    const current = fs.existsSync(dest) ? safeReadText(dest) : null;
    if (current === serialized) {
      result.already.push(target.provider);
      continue;
    }
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, serialized);
    result.written.push(target.provider);
  }
  return result;
}

function mergeCodexHookConfig(existing, hookBlock) {
  const completeBlock = /# monodesign:start native-hook[\s\S]*?# monodesign:end native-hook\n?/m;
  const incompleteBlock = /# monodesign:start native-hook[\s\S]*$/m;
  let merged = existing;
  if (completeBlock.test(merged)) merged = merged.replace(completeBlock, hookBlock);
  else if (incompleteBlock.test(merged)) merged = merged.replace(incompleteBlock, hookBlock);
  else merged = `${merged.trimEnd()}${merged.trim() ? '\n\n' : ''}${hookBlock}`;
  return enableCodexHooks(merged);
}

function enableCodexHooks(config) {
  if (!/^\[features\]\s*$/m.test(config)) {
    return `[features]\nhooks = true\n\n${config}`;
  }
  const lines = config.split(/\r?\n/);
  const start = lines.findIndex((line) => /^\[features\]\s*$/.test(line));
  let end = start + 1;
  while (end < lines.length && !/^\[\[?[^\]]+\]\]?\s*$/.test(lines[end])) end++;
  const hookIndex = lines.slice(start + 1, end).findIndex((line) => /^hooks\s*=/.test(line));
  if (hookIndex === -1) lines.splice(end, 0, 'hooks = true');
  else lines[start + 1 + hookIndex] = 'hooks = true';
  return lines.join('\n');
}

function safeReadText(filePath) {
  try {
    return fs.readFileSync(filePath, 'utf-8');
  } catch {
    return null;
  }
}

function mergeHookManifests(existing, fresh) {
  const existingObject = existing && typeof existing === 'object' && !Array.isArray(existing) ? existing : {};
  const freshObject = fresh && typeof fresh === 'object' && !Array.isArray(fresh) ? fresh : {};
  const existingHooks = existingObject.hooks && typeof existingObject.hooks === 'object' && !Array.isArray(existingObject.hooks)
    ? existingObject.hooks
    : {};
  const freshHooks = freshObject.hooks && typeof freshObject.hooks === 'object' && !Array.isArray(freshObject.hooks)
    ? freshObject.hooks
    : {};

  const merged = { ...existingObject, hooks: {} };
  if (freshObject.version !== undefined) merged.version = freshObject.version;
  if (freshObject.description !== undefined) merged.description = freshObject.description;

  const hookEvents = new Set([...Object.keys(existingHooks), ...Object.keys(freshHooks)]);
  for (const event of hookEvents) {
    const preserved = stripMonodesignHookEntries(existingHooks[event]);
    const added = Array.isArray(freshHooks[event]) ? freshHooks[event] : [];
    const mergedEntries = [...preserved, ...added];
    if (mergedEntries.length > 0) merged.hooks[event] = mergedEntries;
  }
  return merged;
}

function fileHasMonodesignHookMarker(filePath) {
  if (!fs.existsSync(filePath)) return false;
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  } catch {
    return false;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return false;
  if (!parsed.hooks || typeof parsed.hooks !== 'object') return false;
  return valueHasMonodesignHookMarker(parsed.hooks);
}

function valueHasMonodesignHookMarker(value) {
  if (typeof value === 'string') {
    return MONODESIGN_HOOK_COMMAND_MARKERS.some((marker) => value.includes(marker));
  }
  if (Array.isArray(value)) return value.some(valueHasMonodesignHookMarker);
  if (value && typeof value === 'object') return Object.values(value).some(valueHasMonodesignHookMarker);
  return false;
}

function stripMonodesignHookEntry(entry) {
  if (!entry || typeof entry !== 'object') return entry;
  // `command`/`args`: Claude/Codex/Cursor. `bash`/`powershell`: GitHub Copilot's
  // flat entry shape, where the marker lives under the shell-command keys.
  if (valueHasMonodesignHookMarker(entry.command) || valueHasMonodesignHookMarker(entry.args)
    || valueHasMonodesignHookMarker(entry.bash) || valueHasMonodesignHookMarker(entry.powershell)) {
    return null;
  }
  if (!Array.isArray(entry.hooks)) return entry;

  const strippedHooks = entry.hooks
    .map(stripMonodesignHookEntry)
    .filter(Boolean);

  if (strippedHooks.length === 0 && entry.hooks.some(valueHasMonodesignHookMarker)) {
    return null;
  }
  return { ...entry, hooks: strippedHooks };
}

function stripMonodesignHookEntries(entries) {
  if (!Array.isArray(entries)) return [];
  return entries
    .map(stripMonodesignHookEntry)
    .filter(Boolean);
}

function pruneMonodesignHookFromManifest(manifestPath) {
  if (!fileHasMonodesignHookMarker(manifestPath)) return false;
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
  } catch {
    return false;
  }

  const existingHooks = parsed.hooks && typeof parsed.hooks === 'object' && !Array.isArray(parsed.hooks)
    ? parsed.hooks
    : {};
  const cleanedHooks = {};
  for (const [event, entries] of Object.entries(existingHooks)) {
    const kept = stripMonodesignHookEntries(entries);
    if (kept.length > 0) cleanedHooks[event] = kept;
  }

  const next = { ...parsed };
  if (Object.keys(cleanedHooks).length > 0) {
    next.hooks = cleanedHooks;
  } else {
    delete next.hooks;
    delete next.description;
    delete next.version;
  }

  if (Object.keys(next).length === 0) {
    fs.rmSync(manifestPath, { force: true });
  } else {
    fs.writeFileSync(manifestPath, `${JSON.stringify(next, null, 2)}\n`);
  }
  return true;
}
