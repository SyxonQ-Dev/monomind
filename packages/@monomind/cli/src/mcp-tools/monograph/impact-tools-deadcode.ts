import { existsSync, readdirSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import type { MCPTool } from '../types.js';
import { getProjectCwd } from '../types.js';
import { _isValidDb, getDbPath, text } from './shared.js';

// ── monograph_dead_code ──────────────────────────────────────────────────────

// ── monograph_dead_code ──────────────────────────────────────────────────────

export const monographDeadCodeTool: MCPTool = {
  name: 'monograph_dead_code',
  description:
    'Detect dead code: exported functions with zero inbound references, files with no importers, and stale dist build artifacts. Returns structured JSON with candidates grouped by category. Always verify candidates with grep before deleting.',
  inputSchema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Absolute path to the repo (defaults to project cwd)' },
      categories: {
        type: 'array',
        items: { type: 'string', enum: ['dead-functions', 'orphan-files', 'stale-dist'] },
        description: 'Which categories to check (default: all three)',
      },
    },
  },
  handler: async (input) => {
    const { openDb } = await import('@monoes/monograph');
    const repoPath = (input.path as string | undefined) ?? getProjectCwd();
    const cats = (input.categories as string[] | undefined) ?? [
      'dead-functions',
      'orphan-files',
      'stale-dist',
    ];
    const result: Record<string, unknown> = {};

    const dbPath = getDbPath(repoPath);
    // openDb's fileMustExist option isn't in the currently-published
    // @monoes/monograph release this CLI depends on — check validity
    // ourselves so a missing DB doesn't get silently auto-created empty.
    if (!_isValidDb(dbPath)) {
      return text(
        JSON.stringify({ error: 'No monograph index found. Run monograph_build first.' }),
      );
    }
    let db: ReturnType<typeof openDb> | null = null;
    try {
      db = openDb(dbPath);
      // _isValidDb's size check can't distinguish a real index from an
      // empty-but-schema-migrated DB (better-sqlite3 auto-creates + migrates
      // on open, and other unguarded openDb() call sites in this file can
      // create exactly that as a side effect of an unrelated tool call before
      // monograph_build ever runs). Verify actual content post-open so this
      // reports "never built" instead of a misleading "0 dead functions found".
      const { count } = db.prepare('SELECT COUNT(*) as count FROM nodes').get() as {
        count: number;
      };
      if (count === 0) {
        return text(
          JSON.stringify({ error: 'No monograph index found. Run monograph_build first.' }),
        );
      }
    } catch {
      return text(
        JSON.stringify({ error: 'No monograph index found. Run monograph_build first.' }),
      );
    }

    try {
      if (cats.includes('dead-functions')) {
        const { detectDeadCodeNodes } = await import('@monoes/monograph');
        const { readFileSync } = await import('node:fs');
        const nodes = detectDeadCodeNodes(db);
        // Filter out stale graph nodes: verify the function name actually appears in the source file
        // SEC-6: n.filePath is DB-sourced. A poisoned monograph.db could
        // ship `../../etc/passwd` and exfiltrate (or, with a malicious
        // `name`, probe for known strings). Resolve against repoPath and
        // refuse anything that escapes it.
        const repoRoot = resolve(repoPath);
        const verified = nodes.filter((n) => {
          if (!n.filePath) return false;
          const resolved = resolve(repoPath, n.filePath);
          if (!resolved.startsWith(repoRoot + sep) && resolved !== repoRoot) return false;
          try {
            const content = readFileSync(resolved, 'utf-8');
            return content.includes(n.name);
          } catch {
            return false;
          }
        });
        const staleCount = nodes.length - verified.length;
        result['dead-functions'] = {
          count: verified.length,
          candidates: verified.map((n) => ({
            name: n.name,
            location: n.filePath
              ? n.startLine
                ? `${n.filePath}:${n.startLine}`
                : n.filePath
              : null,
          })),
          ...(staleCount > 0
            ? {
                staleIndexEntries: staleCount,
                note: 'Some graph entries reference deleted functions. Rebuild the index with monograph_build to clean up.',
              }
            : {}),
        };
      }

      if (cats.includes('orphan-files')) {
        const rows = db
          .prepare(`
          SELECT n.name, n.file_path,
            (SELECT COUNT(*) FROM edges e WHERE e.source_id = n.id AND e.relation = 'IMPORTS') as imports_out,
            (SELECT COUNT(*) FROM edges e WHERE e.target_id = n.id AND e.relation = 'IMPORTS') as imported_by
          FROM nodes n
          WHERE n.label = 'File'
            AND (SELECT COUNT(*) FROM edges e WHERE e.target_id = n.id AND e.relation = 'IMPORTS') = 0
            AND n.file_path NOT LIKE '%/test/%'
            AND n.file_path NOT LIKE '%/tests/%'
            AND n.file_path NOT LIKE '%.test.%'
            AND n.file_path NOT LIKE '%__tests__%'
            AND n.file_path NOT LIKE '%/spec/%'
            AND n.file_path NOT LIKE '%.spec.%'
            AND n.file_path NOT LIKE '%/index.%'
            AND n.file_path NOT LIKE 'bin/%'
            AND n.file_path NOT LIKE 'scripts/%'
            AND n.file_path NOT LIKE '%/cli.ts'
            AND n.file_path NOT LIKE '%/cli.js'
            AND n.file_path NOT LIKE '%/main.ts'
            AND n.file_path NOT LIKE '%/main.js'
            AND n.file_path NOT LIKE '%/dist/%'
            AND n.file_path NOT LIKE '%node_modules%'
          ORDER BY n.file_path
        `)
          .all() as Array<{
          name: string;
          file_path: string;
          imports_out: number;
          imported_by: number;
        }>;

        const withOutbound = rows.filter((r: any) => r.imports_out > 0);
        const isolated = rows.filter((r: any) => r.imports_out === 0);

        result['orphan-files'] = {
          count: withOutbound.length,
          note: 'Files that import other modules but nothing imports them. May be lazy-loaded or dynamically imported — verify with grep.',
          candidates: withOutbound.map((r: any) => ({
            file: r.file_path,
            outboundImports: r.imports_out,
          })),
          ...(isolated.length > 0
            ? {
                isolated: {
                  count: isolated.length,
                  note: 'Files with zero edges in either direction — likely standalone scripts or entry points.',
                  files: isolated.map((r: any) => r.file_path),
                },
              }
            : {}),
        };
      }

      if (cats.includes('stale-dist')) {
        result['stale-dist'] = findStaleDist(repoPath);
      }

      return text(JSON.stringify(result, null, 2));
    } finally {
      db?.close();
    }
  },
};

function findStaleDist(repoPath: string): Record<string, unknown> {
  const distSrc = join(repoPath, 'dist', 'src');
  const src = join(repoPath, 'src');

  // Scan a single package for stale dist artifacts
  const scanPkg = (pkgPath: string, pkgName: string) => {
    const pkgDistSrc = join(pkgPath, 'dist', 'src');
    const pkgSrc = join(pkgPath, 'src');
    if (!existsSync(pkgDistSrc) || !existsSync(pkgSrc)) return null;

    const staleDirs: string[] = [];
    const staleFiles: string[] = [];
    let resourceForks = 0;

    try {
      const distDirs = readdirSync(pkgDistSrc, { withFileTypes: true }).filter(
        (d) => d.isDirectory() && !d.name.startsWith('.') && !d.name.startsWith('._'),
      );
      const srcDirs = new Set(
        readdirSync(pkgSrc, { withFileTypes: true })
          .filter((d) => d.isDirectory() && !d.name.startsWith('.'))
          .map((d) => d.name),
      );
      for (const d of distDirs) {
        if (!srcDirs.has(d.name)) staleDirs.push(d.name);
      }
    } catch {
      /* skip */
    }

    try {
      const distFiles = readdirSync(pkgDistSrc).filter(
        (f) => f.endsWith('.js') && !f.startsWith('.') && !f.startsWith('._'),
      );
      for (const f of distFiles) {
        const tsName = f.replace(/\.js$/, '.ts');
        if (!existsSync(join(pkgSrc, tsName))) staleFiles.push(f);
      }
    } catch {
      /* skip */
    }

    // Count macOS resource fork files
    const countRF = (dir: string) => {
      try {
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
          if (entry.name.startsWith('._')) resourceForks++;
          else if (entry.isDirectory()) countRF(join(dir, entry.name));
        }
      } catch {
        /* skip */
      }
    };
    countRF(pkgDistSrc);

    if (staleDirs.length === 0 && staleFiles.length === 0 && resourceForks === 0) return null;
    return {
      package: pkgName,
      staleDirs,
      staleFiles,
      ...(resourceForks > 0 ? { macosResourceForks: resourceForks } : {}),
    };
  };

  // Single-package repo
  if (existsSync(distSrc) && existsSync(src)) {
    const finding = scanPkg(repoPath, '.');
    return {
      count: finding ? finding.staleDirs.length + finding.staleFiles.length : 0,
      note: 'Directories/files in dist/src/ with no corresponding source. Fix: rm -rf dist && npm run build.',
      ...(finding ? { findings: [finding] } : {}),
    };
  }

  // Monorepo: scan all packages
  const packagesDir = join(repoPath, 'packages');
  if (!existsSync(packagesDir)) return { count: 0, note: 'No dist/src or packages/ found' };

  const findings: Array<Record<string, unknown>> = [];
  try {
    for (const scope of readdirSync(packagesDir, { withFileTypes: true })) {
      if (!scope.isDirectory()) continue;
      const scopeDir = join(packagesDir, scope.name);
      if (scope.name.startsWith('@')) {
        for (const pkg of readdirSync(scopeDir, { withFileTypes: true })) {
          if (!pkg.isDirectory()) continue;
          const f = scanPkg(join(scopeDir, pkg.name), `${scope.name}/${pkg.name}`);
          if (f) findings.push(f);
        }
      } else {
        const f = scanPkg(scopeDir, scope.name);
        if (f) findings.push(f);
      }
    }
  } catch {
    /* skip */
  }

  return {
    count: findings.reduce(
      (s, f) =>
        s + ((f.staleDirs as string[])?.length ?? 0) + ((f.staleFiles as string[])?.length ?? 0),
      0,
    ),
    note: 'Directories/files in dist/src/ with no corresponding source. Fix: rm -rf dist && npm run build.',
    findings,
  };
}
