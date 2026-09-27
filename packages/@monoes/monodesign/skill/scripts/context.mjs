/**
 * Context loader: prints PRODUCT.md (and DESIGN.md if present) as one
 * markdown block on stdout, or prints a `NO_PRODUCT_MD:` message when no
 * PRODUCT.md is found anywhere. The skill keys off that message to branch:
 * from-scratch build commands (init / teach / craft / shape) and clear
 * build/shape intent divert into the init flow, while scoped commands proceed
 * using the existing code as context.
 *
 * Path resolution (first match wins):
 *   1. Active project root, if PRODUCT.md or DESIGN.md is there. An explicit
 *      --target selects the active project: the workspace child in a
 *      monorepo, or the nearest directory around the target carrying
 *      canonical context files in an ordinary repo (issue #376).
 *   2. Active project .agents/context/ then docs/
 *   3. Repo root context, using the same order, as a per-file fallback
 *      whenever the active project is nested below it
 *   4. $MONODESIGN_CONTEXT_DIR (absolute or cwd-relative) — power-user
 *      escape hatch, only consulted when defaults are empty
 *   5. Active project root as a "nothing found" default
 *
 * `resolveContextDir()` and `loadContext()` are also exported for the
 * server-side scripts (live.mjs, live-server.mjs) that need the structured
 * shape rather than the markdown block.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseTargetOptions } from './lib/target-args.mjs';
import { MONODESIGN_COMMAND } from './lib/provider.mjs';
import { hasTargetOption } from './context-utils.mjs';
import {
  loadContext,
  resolveContextDir,
  resolveProjectRoot,
  resolveTargetSelection,
} from './context-resolve.mjs';
import {
  extractPlatform,
  extractRegister,
  extractSectionValue,
} from './context-fields.mjs';
import { computeUpdateDirective } from './context-update.mjs';

export { loadContext, resolveContextDir, resolveProjectRoot, resolveTargetSelection };
export { extractPlatform, extractRegister, extractSectionValue };

async function cli() {
  let cliOptions;
  try {
    cliOptions = parseCliOptions(process.argv.slice(2));
  } catch (err) {
    if (err?.name === 'TargetArgError') {
      process.stderr.write(`${err.message}\n`);
      process.exit(1);
    }
    throw err;
  }
  const targetProvided = hasTargetOption(cliOptions);
  const targetExists = targetProvided ? pathExistsForTarget(process.cwd(), cliOptions.targetPath) : null;
  const selection = resolveTargetSelection(process.cwd(), cliOptions);
  if (selection) {
    process.stdout.write(`${buildTargetSelectionDirective(selection)}\n`);
    process.exit(0);
  }
  const ctx = loadContext(process.cwd(), cliOptions);
  const updateDirective = await computeUpdateDirective();

  if (!ctx.hasProduct) {
    // Direct stdout message instead of relying on empty output as a signal
    // — cheap models miss the empty case more often than the explicit one.
    const parts = [
      'NO_PRODUCT_MD: This project has no PRODUCT.md yet. ' +
      'Follow SKILL.md Setup step 1: for `init`, `teach`, `craft`, `shape`, ' +
      'or wording that clearly maps to a from-scratch build/shape flow, load ' +
      'reference/init.md and write PRODUCT.md first; for any other (scoped) ' +
      'command against existing code, proceed using the code as context and ' +
      `offer \`${MONODESIGN_COMMAND} init\` as a suggestion (do not block).`,
    ];
    parts.push(buildResolvedContextDirective(ctx, cliOptions, { targetExists }));
    if (shouldWarnMissingTarget(ctx, targetProvided, targetExists)) {
      parts.push(buildMissingTargetDirective());
    }
    if (updateDirective) parts.push(updateDirective);
    process.stdout.write(`${parts.join('\n\n---\n\n')}\n`);
    process.exit(0);
  }
  const parts = [`# PRODUCT.md\n\n${ctx.product.trim()}`];
  if (ctx.hasDesign) {
    parts.push(`# DESIGN.md\n\n${ctx.design.trim()}`);
  }
  parts.push(buildResolvedContextDirective(ctx, cliOptions, { targetExists }));
  if (shouldWarnMissingTarget(ctx, targetProvided, targetExists)) {
    parts.push(buildMissingTargetDirective());
  }
  const register = extractRegister(ctx.product);
  const next = register
    ? `NEXT STEP: This project's register is \`${register}\`. You MUST now read \`reference/${register}.md\` before producing any design output.`
    : `NEXT STEP: You MUST now read the matching register reference (\`reference/brand.md\` or \`reference/product.md\`) before producing any design output. Pick based on PRODUCT.md above.`;
  parts.push(next);
  const platform = extractPlatform(ctx.product);
  const nativeRefs =
    platform === 'adaptive' ? ['ios', 'android'] : platform === 'ios' || platform === 'android' ? [platform] : [];
  if (nativeRefs.length) {
    const refList = nativeRefs.map(p => `\`reference/${p}.md\``).join(' and ');
    const label = platform === 'adaptive' ? '`adaptive` (both iOS and Android)' : `\`${platform}\``;
    parts.push(
      `NEXT STEP: This project targets ${label}. Also read ${refList} for native conventions, in addition to the register reference.`,
    );
  } else if (!platform) {
    // A `## Platform` section that names something we don't recognize (a
    // toolchain like `flutter`, a typo) would otherwise silently fall back to
    // web — the wrong default exactly when the user tried to say "native".
    const rawPlatform = extractSectionValue(ctx.product, 'Platform');
    if (rawPlatform) {
      parts.push(
        `WARNING: PRODUCT.md's \`## Platform\` value \`${rawPlatform}\` is not recognized; treating the project as \`web\`. Valid values are \`web\`, \`ios\`, \`android\`, or \`adaptive\` (cross-platform, ships both). If this project is native, fix the field (name the design language the app renders, not the toolchain) and surface it to the user.`,
      );
    }
  }
  if (updateDirective) parts.push(updateDirective);
  process.stdout.write(`${parts.join('\n\n---\n\n')}\n`);
}

function parseCliOptions(args) {
  return parseTargetOptions(args, { strict: true });
}

function pathExistsForTarget(cwd, targetPath) {
  const abs = path.isAbsolute(targetPath) ? targetPath : path.resolve(cwd, targetPath);
  return fs.existsSync(abs);
}

function buildResolvedContextDirective(ctx, options, { targetExists = null } = {}) {
  const targetPath = hasTargetOption(options) ? options.targetPath : null;
  return `RESOLVED_CONTEXT:\n${JSON.stringify({
    targetPath,
    ...(targetPath ? { targetExists } : {}),
    projectRoot: ctx.projectRoot,
    repoRoot: ctx.repoRoot,
    productPath: ctx.productPath,
    designPath: ctx.designPath,
  }, null, 2)}`;
}

function shouldWarnMissingTarget(ctx, targetProvided, targetExists = null) {
  if (ctx.isMonorepo && targetProvided && targetExists === false) return true;
  return !!(
    ctx.isMonorepo
    && (!targetProvided || targetExists === false)
    && ctx.projectRoot
    && ctx.repoRoot
    && path.resolve(ctx.projectRoot) === path.resolve(ctx.repoRoot)
  );
}

function buildMissingTargetDirective() {
  const script = process.argv[1] || 'context.mjs';
  return (
    'MONOREPO_TARGET_REQUIRED: This is a monorepo and context.mjs ran without --target. ' +
    'If the user named a file, route, or child app, do not answer from this output. ' +
    `Rerun \`node ${script} --target <path>\` and answer from that run's RESOLVED_CONTEXT fields.`
  );
}

function buildTargetSelectionDirective(selection) {
  return (
    `TARGET_SELECTION_REQUIRED:\n${JSON.stringify(selection, null, 2)}\n\n` +
    'Show each app with its productStatus/productPath and designStatus/designPath so the user can see child overrides, inherited root files, fallback files, or missing files before choosing. ' +
    'Ask the user which app Monodesign should use, then rerun Monodesign helper commands from that child app cwd using this same scripts directory. ' +
    'Use `--target <path>` only as a fallback when changing cwd is not possible, or when the user explicitly named a file/path.'
  );
}

// Run cli() only when this module is the entry point. Compare realpaths
// rather than endsWith(): a loose suffix match also fires for unrelated
// scripts like `load-context.mjs`, and realpath tolerates symlinked
// invocation (the test harness symlinks the skill dir).
function invokedAsScript() {
  const arg = process.argv[1];
  if (!arg) return false;
  try {
    return fs.realpathSync(arg) === fs.realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (invokedAsScript()) {
  cli();
}
