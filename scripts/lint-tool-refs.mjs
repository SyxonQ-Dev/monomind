#!/usr/bin/env node

/**
 * MCP tool / CLI command reference lint (GH #421).
 *
 * Shipped agent, skill and command markdown told models to call MCP tools that
 * the server never registered (`mcp__monomind__swarm_init`,
 * `mcp__monomind__memory_usage`, ...) and to run CLI commands that do not exist
 * (`npx monomind github pr-init`), and the guidance catalog that
 * guidance_capabilities / guidance_recommend return listed tool names nobody
 * registered. Every such reference costs the model a failed call.
 *
 * WHAT IT CHECKS
 * --------------
 *   1. Every `mcp__monomind__<name>` in the markdown of the `.claude` trees
 *      (root, the npm-shipped package tree, and the .agents / .gemini /
 *      .kimi-code platform trees) names a tool in the FULL MCP registry — every
 *      category the server can load, as advertised with MONOMIND_MCP_FULL=1.
 *      `mcp__monomind__<prefix>_*` passes when some tool starts with <prefix>_.
 *   2. Every tool and command in the guidance catalog (CAPABILITY_CATALOG)
 *      resolves: tools against the same registry, commands against the built
 *      CLI's command registry.
 *   3. Every `monomind <cmd> [<sub>]` in the code of agent definitions
 *      (`.claude/agents`, `packages/@monomind/cli/.claude/agents`) resolves to a
 *      real CLI command — the check lint-skills.mjs runs on skills and
 *      commands, extended to agents.
 *
 * Tools and commands come from the BUILT CLI (packages/@monomind/cli/dist), so
 * build first: `pnpm -r run build`.
 *
 * KNOWN_BAD_CLI_REFS is an explicit, shrinking allowlist of agent CLI
 * references not yet fixed (GH #421). An entry that no longer occurs fails the
 * lint, so fixing a reference forces removing its entry.
 *
 * Run:   node scripts/lint-tool-refs.mjs
 * Exit:  0 when everything resolves, 1 otherwise.
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { pathToFileURL } from 'node:url';
import { extractCommandRefs, loadCliCommands, unresolvedReason } from './lint-skills.mjs';

const ROOT = process.cwd();
const CLI_DIST = 'packages/@monomind/cli/dist/src';

const MARKDOWN_TREES = [
  '.claude',
  'packages/@monomind/cli/.claude',
  '.agents',
  '.gemini',
  '.kimi-code',
];
const AGENT_TREES = ['.claude/agents', 'packages/@monomind/cli/.claude/agents'];

/**
 * GH #421: agent CLI references that name commands the CLI does not have and
 * are not fixed yet — file → the unresolved `monomind <cmd>` keys it still
 * holds. Shrink only: fix the reference, then delete its entry.
 */
export const KNOWN_BAD_CLI_REFS = new Map(
  [
    ['github/monoswarm-code-review.md', ['monomind github']],
    ['github/monoswarm-issue.md', ['monomind github']],
    ['github/monoswarm-multi-repo.md', ['monomind github']],
    ['github/monoswarm-pr.md', ['monomind github', 'monomind swarm']],
    ['github/project-board-sync.md', ['monomind github']],
    ['github/workflow-automation.md', ['monomind actions']],
  ].flatMap(([file, keys]) => AGENT_TREES.map((tree) => [`${tree}/${file}`, new Set(keys)])),
);

/** Every tool name the MCP server can register (all categories loaded). */
export async function loadMcpToolNames(root = ROOT) {
  const modPath = join(root, CLI_DIST, 'mcp-client-registry.js');
  if (!existsSync(modPath)) {
    throw new Error(`${CLI_DIST}/mcp-client-registry.js is missing — build the CLI first`);
  }
  const registry = await import(pathToFileURL(modPath).href);
  await registry.ensureAllLoaded();
  return new Set(registry.TOOL_REGISTRY.keys());
}

/** Does `name` (possibly a `prefix_*` wildcard) resolve in `tools`? */
export function toolResolves(name, tools) {
  if (name.endsWith('_*')) {
    const prefix = name.slice(0, -1);
    return [...tools].some((t) => t.startsWith(prefix));
  }
  return tools.has(name);
}

/** Every `mcp__monomind__<name>` in `text`, with its line number. */
export function extractToolRefs(text) {
  const refs = [];
  for (const m of text.matchAll(/mcp__monomind__([A-Za-z0-9_-]*[A-Za-z0-9](?:_\*)?)/g)) {
    refs.push({ name: m[1], line: text.slice(0, m.index).split('\n').length });
  }
  return refs;
}

/** The unresolved `monomind <cmd>` key of a CLI reference, as the allowlist spells it. */
function cliKey(ref, cli) {
  return cli.has(ref.command) ? `monomind ${ref.command} ${ref.sub}` : `monomind ${ref.command}`;
}

function walkMarkdown(dir, out = []) {
  const abs = join(ROOT, dir);
  if (!existsSync(abs)) return out;
  for (const entry of readdirSync(abs)) {
    if (entry === 'node_modules' || entry === 'worktrees') continue;
    const rel = `${dir}/${entry}`;
    if (statSync(join(ROOT, rel)).isDirectory()) walkMarkdown(rel, out);
    else if (entry.endsWith('.md')) out.push(rel);
  }
  return out;
}

async function main() {
  let tools;
  let cli;
  let catalog;
  try {
    tools = await loadMcpToolNames();
    cli = await loadCliCommands();
    catalog = (
      await import(pathToFileURL(join(ROOT, CLI_DIST, 'mcp-tools/guidance-catalog.js')).href)
    ).CAPABILITY_CATALOG;
  } catch (err) {
    console.error(`❌ ${err.message}`);
    return 1;
  }
  const errors = [];

  // 1. MCP tool references in markdown.
  const files = [...new Set(MARKDOWN_TREES.flatMap((t) => walkMarkdown(t)))];
  let toolRefs = 0;
  for (const file of files) {
    for (const ref of extractToolRefs(readFileSync(join(ROOT, file), 'utf8'))) {
      toolRefs++;
      if (!toolResolves(ref.name, tools))
        errors.push(`${file}:${ref.line}: unknown MCP tool mcp__monomind__${ref.name}`);
    }
  }

  // 2. Guidance catalog.
  for (const [area, cap] of Object.entries(catalog)) {
    for (const tool of cap.tools)
      if (!toolResolves(tool, tools))
        errors.push(`guidance-catalog.ts [${area}]: unknown MCP tool ${tool}`);
    for (const command of cap.commands) {
      const [ref] = extractCommandRefs(`\`monomind ${command}\``);
      const reason = unresolvedReason(ref, cli);
      if (reason) errors.push(`guidance-catalog.ts [${area}]: command '${command}' — ${reason}`);
    }
  }

  // 3. CLI references in agent definitions.
  const allowedSeen = new Set();
  let cliRefs = 0;
  for (const file of AGENT_TREES.flatMap((t) => walkMarkdown(t))) {
    for (const ref of extractCommandRefs(readFileSync(join(ROOT, file), 'utf8'))) {
      cliRefs++;
      const reason = unresolvedReason(ref, cli);
      if (!reason) continue;
      const key = cliKey(ref, cli);
      const allowed = KNOWN_BAD_CLI_REFS.get(file);
      if (allowed?.has(key)) allowedSeen.add(`${file}|${key}`);
      else errors.push(`${file}: '${ref.text}' — ${reason}`);
    }
  }
  for (const [file, keys] of KNOWN_BAD_CLI_REFS) {
    if (!existsSync(join(ROOT, file))) continue;
    for (const key of keys)
      if (!allowedSeen.has(`${file}|${key}`))
        errors.push(
          `${file}: allowlisted '${key}' no longer occurs — remove it from KNOWN_BAD_CLI_REFS`,
        );
  }

  if (errors.length) {
    console.error(`❌ Tool/command reference lint: ${errors.length} error(s)`);
    for (const e of errors) console.error(`  ${e}`);
    console.error(
      `  MCP tools must be registered by the server (${relative(ROOT, join(ROOT, CLI_DIST))}/mcp-client-registry.js); commands must exist in the built CLI.`,
    );
    return 1;
  }
  console.log(
    `✓ Tool/command reference lint passed — ${toolRefs} MCP tool reference(s) in ${files.length} file(s), ${cliRefs} agent CLI reference(s), guidance catalog clean`,
  );
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(await main());
}
