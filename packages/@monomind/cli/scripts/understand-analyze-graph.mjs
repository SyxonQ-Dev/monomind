// understand-analyze-graph.mjs — Builds a KnowledgeGraph-compatible
// graph.json for ua-import compatibility.
// File-size sweep: split out of understand-analyze.mjs.

import { readFileSync, existsSync } from 'node:fs';
import { join, basename } from 'node:path';
import { detectLanguages, detectFrameworks } from './understand-analyze-detect.mjs';
import { getCurrentCommitHash } from './understand-analyze-git.mjs';

// Build a KnowledgeGraph-compatible graph.json for ua-import compatibility
export function buildGraphJson(dir, fileNodes, analysisMap, layers) {
  const projectName = basename(dir);
  const nodes = fileNodes.map(n => {
    const a = analysisMap[n.file_path] || {};
    return {
      id: 'file:' + (n.file_path || n.name),
      dbId: n.id,          // integer PK — use this in --import-analyses-stdin payloads
      type: 'file',
      name: n.name,
      filePath: n.file_path,
      summary: a.fileSummary || '',
      tags: a.tags || [],
      complexity: a.complexity || 'moderate',
    };
  });

  // Project metadata
  let description = '';
  try {
    const pkgPath = join(dir, 'package.json');
    if (existsSync(pkgPath)) {
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
      description = pkg.description || '';
    }
  } catch {}

  return {
    version: '2.7.0',
    kind: 'codebase',
    project: {
      name: projectName,
      languages: detectLanguages(fileNodes),
      frameworks: detectFrameworks(dir),
      description,
      analyzedAt: new Date().toISOString(),
      gitCommitHash: getCurrentCommitHash(dir),
    },
    nodes,
    edges: [],
    layers: layers.map(l => ({ id: l.id, name: l.name, description: l.description, nodeIds: l.nodeIds })),
    tour: [],
  };
}
