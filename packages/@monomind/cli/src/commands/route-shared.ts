/**
 * Shared helpers for the route command: registry agent lookup and the router singleton.
 * Split from route.ts.
 *
 * @module @monomind/cli/commands/route-shared
 */

import { agentCatalog } from '../decision/catalogs.js';
import type { CatalogItem } from '../decision/jev.js';
import { createKeywordRouter, type KeywordRouter } from '../monovector/index.js';

// ============================================================================
// Registry Agents
// ============================================================================

/** Registry agents (.monomind/registry.json) — the agents `route` can pick. */
export function registryAgents(): CatalogItem[] {
  return agentCatalog(process.cwd());
}

/** Spawnable name (Task subagent_type) of a registry agent. */
export function agentName(agent: CatalogItem): string {
  return agent.name || agent.id;
}

/** A registry agent by spawnable name or slug, case-insensitive. */
export function findAgent(query: string): CatalogItem | undefined {
  const q = query.toLowerCase();
  return registryAgents().find((a) => agentName(a).toLowerCase() === q || a.id.toLowerCase() === q);
}

// ============================================================================
// Router Singleton
// ============================================================================

let routerInstance: KeywordRouter | null = null;

let routerInitialized = false;

/**
 * Get or create the router instance
 */
export async function getRouter(): Promise<KeywordRouter> {
  if (!routerInstance) {
    routerInstance = createKeywordRouter();
  }
  if (!routerInitialized) {
    await routerInstance.initialize();
    routerInitialized = true;
  }
  return routerInstance;
}
