import type { MCPTool } from '../types.js';
import { getProjectCwd } from '../types.js';
import { getDbPath, text } from './shared.js';

// ── monograph_route_map ───────────────────────────────────────────────────────

// ── monograph_route_map ───────────────────────────────────────────────────────

export const monographRouteMapTool: MCPTool = {
  name: 'monograph_route_map',
  description:
    'List all HTTP routes in the codebase with their handler info. Supports filtering by URL prefix or HTTP method.',
  inputSchema: {
    type: 'object',
    properties: {
      prefix: {
        type: 'string',
        description: 'Filter routes whose path contains this prefix (e.g. /api)',
      },
      method: {
        type: 'string',
        description: 'Filter by HTTP method: GET, POST, PUT, DELETE, PATCH, ANY',
      },
      includeMiddleware: {
        type: 'boolean',
        description: 'Include middleware/use routes (default: false)',
      },
    },
  },
  handler: async (input) => {
    const { openDb, closeDb } = await import('@monoes/monograph');
    const { getMonographRouteMap } = await import('@monoes/monograph');
    const db = openDb(getDbPath());
    try {
      const result = getMonographRouteMap(db, {
        prefix: input.prefix as string | undefined,
        method: input.method as string | undefined,
        includeMiddleware: input.includeMiddleware as boolean | undefined,
      });
      if (result.routes.length === 0)
        return text('No routes found. Run monograph_build first or adjust your filters.');
      const lines = [`Routes (${result.total} total):`];
      for (const r of result.routes) {
        const loc = r.handlerFile
          ? r.handlerLine != null
            ? `${r.handlerFile}:${r.handlerLine}`
            : r.handlerFile
          : '';
        const mw =
          r.middlewareChain.length > 0 ? `  middleware: ${r.middlewareChain.join(' → ')}` : '';
        lines.push(
          `  ${r.method} ${r.path}${r.handlerName ? ` → ${r.handlerName}` : ''}${loc ? `  (${loc})` : ''}${mw}`,
        );
      }
      return text(lines.join('\n'));
    } finally {
      closeDb(db);
    }
  },
};

// ── monograph_shape_check ─────────────────────────────────────────────────────

// ── monograph_shape_check ─────────────────────────────────────────────────────

export const monographShapeCheckTool: MCPTool = {
  name: 'monograph_shape_check',
  description:
    'Validate API route response shapes: checks that handler return keys match consumer property accesses. Detects shape mismatches between producer and consumer.',
  inputSchema: {
    type: 'object',
    properties: {
      route: { type: 'string', description: 'Filter by route path substring (e.g. /api/users)' },
      file: { type: 'string', description: 'Filter by source file path substring' },
    },
  },
  handler: async (input) => {
    const { openDb, closeDb } = await import('@monoes/monograph');
    const { getShapeCheck } = await import('@monoes/monograph');
    const db = openDb(getDbPath());
    const repoPath = getProjectCwd();
    try {
      const result = getShapeCheck(db, repoPath, {
        route: input.route as string | undefined,
        file: input.file as string | undefined,
      });
      // Render as structured text so LLMs can act on it directly without parsing JSON.
      const lines: string[] = [];
      lines.push(`Shape check: ${result.message}`);
      if (result.route) {
        const handlerLoc = result.route.handlerFile
          ? `  Handler: ${result.route.handlerName}  [${result.route.handlerFile}]`
          : `  Handler: ${result.route.handlerName}`;
        lines.push(`Route: ${result.route.method} ${result.route.path}`);
        lines.push(handlerLoc);
      }
      if (result.shape.returnedKeys.length > 0) {
        lines.push(`  Returned keys: ${result.shape.returnedKeys.join(', ')}`);
      }
      if (result.shape.accessedKeys.length > 0) {
        lines.push(`  Accessed keys: ${result.shape.accessedKeys.join(', ')}`);
      }
      if (result.shape.mismatches.length > 0) {
        lines.push(
          `  Mismatches (accessed but not returned): ${result.shape.mismatches.join(', ')}`,
        );
      }
      if (result.shape.extra.length > 0) {
        lines.push(`  Unused returned keys: ${result.shape.extra.join(', ')}`);
      }
      if (result.consumers.length > 0) {
        lines.push(`  Consumers (${result.consumers.length}):`);
        for (const c of result.consumers.slice(0, 10)) {
          lines.push(`    - ${c.name}  [${c.filePath}]`);
        }
        if (result.consumers.length > 10) {
          lines.push(`    … ${result.consumers.length - 10} more`);
        }
      }
      return text(lines.join('\n'));
    } finally {
      closeDb(db);
    }
  },
};
