// packages/@monomind/cli/src/commands/org-memory-command.ts
//
// `monomind org memory` — inspect an org's cross-run memory and knowledge graph.

import { existsSync, readFileSync } from 'node:fs';
import { ORG_DIR, OrgDefSchema } from '../orgrt/types.js';
import { output } from '../output.js';
import type { Command, CommandContext, CommandResult } from '../types.js';
import { validateOrgName } from './org-control.js';

const log = (text: string): void => {
  console.log(text);
};

export const memorySubcommand: Command = {
  name: 'memory',
  description:
    "Inspect an org's cross-run memory and knowledge graph (stats | search <query> | rules | rollback <run-ref> | promote <run-ref>)",
  examples: [
    { command: 'monomind org memory growth stats', description: 'KG size and namespaces' },
    {
      command: 'monomind org memory growth search "launch checklist"',
      description: 'Search org memory + KG',
    },
    {
      command: 'monomind org memory growth rollback run:m4x2',
      description: "Withdraw one run's support from this org's KG",
    },
    {
      command: 'monomind org memory growth promote run:m4x2',
      description: "Share one run's claims with project-wide knowledge",
    },
  ],
  action: async (ctx: CommandContext): Promise<CommandResult> => {
    const v = validateOrgName(ctx.args[0]);
    if (!v.ok) return v.result;
    const sub = String(ctx.args[1] ?? 'stats');
    const { join } = await import('node:path');
    const cwd = ctx.cwd || process.cwd();
    const dbPath = join(cwd, '.monomind', 'org-memory');
    const kg = await import('../memory/memory-kg.js');
    const bridge = await import('../memory/memory-bridge.js');
    const { orgKgScope, orgMemoryNamespace } = await import('../orgrt/org-memory.js');
    // Every KG operation below is scoped to the requested org, so the org
    // name in the output describes what was actually read, not just what
    // was asked for. Reads of the shared store are unchanged.
    const scope = orgKgScope(v.name);
    const kgNs = kg.kgNamespaces(scope);
    // Flat org memory is namespaced by the org DEFINITION, not by name —
    // resolve it the way the runtime writes it (B4), so a configured
    // `memory_namespace` is searched instead of a guessed `org:<name>`.
    const defPath = join(cwd, ORG_DIR, `${v.name}.json`);
    const flatNs = existsSync(defPath)
      ? orgMemoryNamespace(v.name, OrgDefSchema.parse(JSON.parse(readFileSync(defPath, 'utf8'))))
      : `org:${v.name}`;
    try {
      if (sub === 'stats') {
        const [stats, glossary, backend] = await Promise.all([
          kg.kgStats({ dbPath, scope }),
          kg.kgGlossary({ dbPath, limit: 15, scope }),
          bridge.bridgeGetBackendStats(dbPath),
        ]);
        // The backend reports every namespace in the SHARED store, so
        // listing it raw put other orgs' namespaces (and their counts)
        // under this org's name. Keep only what this org owns.
        // Spread kgNs rather than listing namespaces: the identity work
        // added `names` (the entity name index), and a hand-written list
        // silently omits any namespace added later, hiding rows this org
        // does own.
        const owned = new Set<string>([...Object.values(kgNs), flatNs]);
        const byNs = Object.fromEntries(
          Object.entries(backend?.entriesByNamespace ?? {}).filter(
            ([ns]) => owned.has(ns) || ns.startsWith(`agent:${flatNs}:`),
          ),
        );
        if (ctx.flags.format === 'json') {
          const payload = { v: 1, org: v.name, ...stats, glossary, namespaces: byNs };
          process.stdout.write(`${JSON.stringify(payload)}\n`);
          return { success: true, data: payload };
        }
        log(
          output.info(
            `Knowledge graph: ${stats.nodes} entities, ${stats.edges} relations, ${stats.rules} rules`,
          ),
        );
        if (glossary.length) log(output.info(`Top entities: ${glossary.join(', ')}`));
        for (const [ns, count] of Object.entries(byNs))
          log(output.info(`  ${ns}: ${count} entries`));
        return {
          success: true,
          message: 'org memory stats',
          data: { ...stats, namespaces: byNs },
        };
      }
      if (sub === 'search') {
        const q = ctx.args.slice(2).join(' ');
        if (!q) return { success: false, message: 'usage: org memory <org> search <query>' };
        const [mem, graph] = await Promise.all([
          bridge.bridgeSearchEntries({
            query: q,
            namespace: flatNs,
            limit: 5,
            dbPath,
          }),
          kg.kgSearch({ query: q, dbPath, limit: 8, scope }),
        ]);
        if (ctx.flags.format === 'json') {
          const payload = {
            v: 1,
            org: v.name,
            query: q,
            memories: mem?.results ?? [],
            triplets: graph.triplets,
            kg_context: graph.context ?? null,
          };
          process.stdout.write(`${JSON.stringify(payload)}\n`);
          return { success: true, data: payload };
        }
        for (const r of mem?.results ?? [])
          log(output.info(`[${r.score.toFixed(2)}] ${r.key}: ${r.content.slice(0, 160)}`));
        if (graph.context) log(output.info(`\nKnowledge graph:\n${graph.context}`));
        return {
          success: true,
          message: `${(mem?.results ?? []).length} memories, ${graph.triplets.length} triplets`,
        };
      }
      if (sub === 'rules') {
        const rules = await kg.kgListRules({ dbPath, limit: 50, scope });
        if (ctx.flags.format === 'json') {
          const payload = { v: 1, org: v.name, items: rules };
          process.stdout.write(`${JSON.stringify(payload)}\n`);
          return { success: true, data: payload };
        }
        for (const r of rules) log(output.info(`- ${r.rule.slice(0, 200)}`));
        return { success: true, message: `${rules.length} rules`, data: { rules } };
      }
      if (sub === 'rollback') {
        const ref = ctx.args[2];
        if (!ref)
          return {
            success: false,
            message: 'usage: org memory <org> rollback <origin-ref> (e.g. run:m4x2)',
          };
        // Scoped: the ref is resolved inside this org's namespaces and
        // origin space, so the org name in the command is an ownership
        // restriction rather than a label on an unfiltered rollback.
        const res = await kg.kgRollback({ originRef: ref, scope, dbPath });
        if (ctx.flags.format === 'json') {
          const payload = { v: 1, org: v.name, ref, ...res };
          process.stdout.write(`${JSON.stringify(payload)}\n`);
          return { success: res.success, data: payload };
        }
        log(
          output.info(
            `Rolled back ${ref} for org ${v.name}: ${res.deleted} deleted, ${res.retained} retained (shared with other origins)`,
          ),
        );
        return { success: res.success, message: `rollback ${ref}`, data: res };
      }
      if (sub === 'promote') {
        const ref = ctx.args[2];
        if (!ref)
          return {
            success: false,
            message: 'usage: org memory <org> promote <origin-ref> (e.g. run:m4x2)',
          };
        const res = await kg.kgPromote({ originRef: ref, from: scope, dbPath });
        if (ctx.flags.format === 'json') {
          const payload = { v: 1, org: v.name, ref, ...res };
          process.stdout.write(`${JSON.stringify(payload)}\n`);
          return { success: res.success, data: payload };
        }
        log(
          output.info(
            res.success
              ? `Promoted ${ref} from org ${v.name} to project-shared knowledge: ${res.nodes} entities, ${res.edges} relations, ${res.rules} rules. Withdraw with origin ref ${res.promotedAs}.`
              : `Promotion of ${ref} failed: ${res.error ?? 'unknown error'}`,
          ),
        );
        return { success: res.success, message: `promote ${ref}`, data: res };
      }
      return {
        success: false,
        message: `unknown subcommand "${sub}" — use stats | search | rules | rollback | promote`,
      };
    } finally {
      await bridge.shutdownBridge().catch(() => {
        /* best effort */
      });
    }
  },
};
