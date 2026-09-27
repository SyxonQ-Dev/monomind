import { readFileSync } from 'node:fs';
import { extname, join } from 'node:path';
import type { MonographNode } from '../../types.js';
import { makeId } from '../../types.js';
import type { PipelinePhase } from '../types.js';
import {
  CJS_MJS_EXTS,
  extractCallSites,
  extractConstructorAssignments,
  isSupportedExt,
  TS_JS_EXTS,
} from './call-site-extractors.js';
import {
  buildAllImportMapsFromSource,
  buildWorkspacePackageMap,
  extractImportNames,
  REEXPORT_RE,
  resolveModuleSpecifier,
} from './module-resolution.js';
import type { ParseOutput } from './parse.js';
import { emitEdge, prepareEdgeStmts } from './scope-resolution-edges.js';
import {
  buildEnclosingIndex,
  buildFunctionIndex,
  buildLineOffsets,
  findEnclosingSymbolId,
} from './scope-resolution-function-index.js';
import { resolveTarget } from './scope-resolution-target.js';

export {
  extractGoCallSites,
  extractJavaCallSites,
  extractRustCallSites,
} from './call-site-extractors.js';
// Re-export for external consumers
export {
  buildWorkspacePackageMap,
  clearWorkspacePackageMapCache,
  resolveModuleSpecifier,
} from './module-resolution.js';

// ── Output ────────────────────────────────────────────────────────────────────

export interface ScopeResolutionOutput {
  resolvedEdges: number;
  skippedDynamic: number;
  ambiguous: number;
  reexportEdges: number;
  orphanImportsRemoved: number;
  importsReconstructed: number;
}

// ── Phase definition ──────────────────────────────────────────────────────────

function getImportMap(
  allImportMaps: Map<string, Map<string, string>>,
  fileNodeId: string,
): Map<string, string> {
  return allImportMaps.get(fileNodeId) ?? new Map();
}

export const scopeResolutionPhase: PipelinePhase<ScopeResolutionOutput> = {
  name: 'scope-resolution',
  deps: ['parse', 'cross-file'],
  async execute(ctx, deps) {
    if (ctx.allFilesCached) {
      return {
        resolvedEdges: 0,
        skippedDynamic: 0,
        ambiguous: 0,
        reexportEdges: 0,
        orphanImportsRemoved: 0,
        importsReconstructed: 0,
      };
    }
    const { symbolNodes, fileContents } = deps.get('parse') as ParseOutput;

    let resolvedEdges = 0;
    let skippedDynamic = 0;
    let ambiguous = 0;

    const fileNodesByPath = new Map<string, MonographNode>();
    for (const node of symbolNodes) {
      if (node.label === 'File' && node.filePath) {
        fileNodesByPath.set(node.filePath, node);
      }
    }

    if (ctx.db) {
      const dbFileNodes = ctx.db
        .prepare(`SELECT id, file_path FROM nodes WHERE label = 'File'`)
        .all() as { id: string; file_path: string }[];
      for (const row of dbFileNodes) {
        if (row.file_path && !fileNodesByPath.has(row.file_path)) {
          fileNodesByPath.set(row.file_path, {
            id: row.id,
            label: 'File',
            name: row.file_path.split('/').pop() ?? row.file_path,
            normLabel: '',
            filePath: row.file_path,
            isExported: false,
          });
        }
      }
    }

    const allImportMaps = buildAllImportMapsFromSource(ctx.repoPath, fileNodesByPath, fileContents);
    const { byFilePath: fnIndex, nameCounts } = buildFunctionIndex(ctx);
    const enclosingIndex = buildEnclosingIndex(ctx);

    const edgeStmts = ctx.db ? prepareEdgeStmts(ctx.db) : null;
    const resolveAllCalls = ctx.db?.transaction(() => {
      for (const [filePath, fileNode] of fileNodesByPath) {
        const ext = extname(filePath).toLowerCase();
        if (!isSupportedExt(ext)) continue;

        let source: string | undefined = fileContents.get(filePath);
        if (!source) {
          try {
            source = readFileSync(join(ctx.repoPath, filePath), 'utf-8');
          } catch {
            continue;
          }
        }

        const callSites = extractCallSites(source, filePath, fileNode.id, ext);
        const lineOffsets = buildLineOffsets(source);
        const enclosing = enclosingIndex.get(filePath);
        const importMap = getImportMap(allImportMaps, fileNode.id);
        const ctorMap =
          TS_JS_EXTS.has(ext) || CJS_MJS_EXTS.has(ext)
            ? extractConstructorAssignments(source)
            : undefined;
        const importedFiles = [...new Set(importMap.values())];

        for (const site of callSites) {
          if (site.form === 'dynamic') {
            skippedDynamic++;
            continue;
          }

          const resolved = resolveTarget(
            site,
            filePath,
            importMap,
            fnIndex,
            ctorMap,
            importedFiles,
          );
          if (!resolved) continue;

          if (site.methodName && (nameCounts.get(site.methodName) ?? 0) > 1) {
            ambiguous++;
          }

          // Attribute the call to the function it sits in; fall back to the
          // file node for genuine module-top-level calls.
          const sourceId =
            findEnclosingSymbolId(enclosing, lineOffsets, site.offset) ?? site.callerFileNodeId;

          const result = edgeStmts ? emitEdge(edgeStmts, sourceId, resolved.targetId) : 'skipped';
          if (result === 'inserted' || result === 'upgraded') {
            resolvedEdges++;
          }
        }
      }
    });
    resolveAllCalls?.();

    let reexportEdges = 0;
    if (ctx.db) {
      const insertRef = ctx.db.prepare(`
        INSERT OR IGNORE INTO edges (id, source_id, target_id, relation, confidence, confidence_score)
        VALUES (?, ?, ?, 'REFERENCES', 'EXTRACTED', 0.85)
      `);
      const reexportKnownFiles = new Set(fileNodesByPath.keys());
      const reexportWorkspaceMap = buildWorkspacePackageMap(ctx.repoPath);
      const insertReexports = ctx.db.transaction(() => {
        for (const [filePath, fileNode] of fileNodesByPath) {
          const ext = extname(filePath).toLowerCase();
          if (!TS_JS_EXTS.has(ext) && !CJS_MJS_EXTS.has(ext)) continue;

          let source: string | undefined = fileContents.get(filePath);
          if (!source) {
            try {
              source = readFileSync(join(ctx.repoPath, filePath), 'utf-8');
            } catch {
              continue;
            }
          }

          REEXPORT_RE.lastIndex = 0;
          let m: RegExpExecArray | null;
          while ((m = REEXPORT_RE.exec(source)) !== null) {
            const specifier = m[2];
            const names = extractImportNames(m[1]);
            const resolvedFile = resolveModuleSpecifier(
              filePath,
              specifier,
              ctx.repoPath,
              reexportKnownFiles,
              reexportWorkspaceMap,
            );
            if (!resolvedFile) continue;

            for (const name of names) {
              const ids = fnIndex.get(resolvedFile)?.get(name);
              if (!ids || ids.length === 0) continue;
              const targetId =
                ids.length === 1 ? ids[0] : (ids.find((id) => id.endsWith('_function')) ?? ids[0]);
              const edgeId = makeId(fileNode.id, targetId, 'reexport_ref');
              try {
                insertRef.run(edgeId, fileNode.id, targetId);
                reexportEdges++;
              } catch {
                /* duplicate */
              }
            }
          }
        }
      });
      insertReexports();
    }

    let orphanImportsRemoved = 0;
    if (ctx.db) {
      const result = ctx.db
        .prepare(`
          DELETE FROM edges WHERE id IN (
            SELECT e.id FROM edges e
            JOIN nodes t ON e.target_id = t.id
            WHERE e.relation = 'IMPORTS' AND t.label = 'Variable'
          )
        `)
        .run();
      orphanImportsRemoved = result.changes;
    }

    let importsReconstructed = 0;
    if (ctx.db) {
      const insertImport = ctx.db.prepare(`
        INSERT OR IGNORE INTO edges (id, source_id, target_id, relation, confidence, confidence_score)
        VALUES (?, ?, ?, 'IMPORTS', 'EXTRACTED', 0.9)
      `);
      const fileIdByPath = new Map<string, string>();
      for (const [fp, node] of fileNodesByPath) fileIdByPath.set(fp, node.id);

      const insertAll = ctx.db.transaction(() => {
        for (const [fileNodeId, importMap] of allImportMaps) {
          const targetPaths = new Set(importMap.values());
          for (const targetPath of targetPaths) {
            const targetFileId = fileIdByPath.get(targetPath);
            if (!targetFileId || targetFileId === fileNodeId) continue;
            const edgeId = makeId(fileNodeId, targetFileId, 'imports_file');
            try {
              insertImport.run(edgeId, fileNodeId, targetFileId);
              importsReconstructed++;
            } catch {
              /* duplicate */
            }
          }
        }
      });
      insertAll();
    }

    return {
      resolvedEdges,
      skippedDynamic,
      ambiguous,
      reexportEdges,
      orphanImportsRemoved,
      importsReconstructed,
    };
  },
};
