import { readFileSync, statSync } from 'node:fs';
import type { MonographEdge, MonographNode } from '../../types.js';
import { makeId, toNormLabel } from '../../types.js';
import type { FieldDef } from './orm.js';

// Split out of orm.ts (file-size sweep). Pure move: no behaviour change.

export function addField(
  entityName: string,
  fieldName: string,
  fieldType: string,
  filePath: string,
  language: string,
  entityNodeId: string,
  fields: FieldDef[],
  fieldNodes: MonographNode[],
  edges: MonographEdge[],
): void {
  const fieldNodeId = makeId('field', entityName + fieldName + filePath);

  const fieldNode: MonographNode = {
    id: fieldNodeId,
    label: 'Field',
    name: fieldName,
    normLabel: toNormLabel(fieldName),
    filePath,
    startLine: 0,
    endLine: 0,
    isExported: false,
    language,
    properties: { declaredType: fieldType },
  };
  fieldNodes.push(fieldNode);

  const edgeId = makeId(entityNodeId, fieldNodeId, 'has_field');
  edges.push({
    id: edgeId,
    sourceId: entityNodeId,
    targetId: fieldNodeId,
    relation: 'HAS_FIELD',
    confidence: 'EXTRACTED',
    confidenceScore: 0.9,
  });

  fields.push({ name: fieldName, type: fieldType, fieldNodeId });
}

/**
 * Extracts a balanced brace block from source starting at the position of the
 * opening `{`. Returns the content between the braces (not including the braces).
 */
export function extractBraceBlock(
  source: string,
  openPos: number,
  maxLen: number,
): string | undefined {
  // Find the opening brace at or after openPos
  const start = source.indexOf('{', openPos);
  if (start === -1) return undefined;

  let depth = 0;
  let i = start;
  const end = Math.min(start + maxLen, source.length);

  for (; i < end; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}') {
      depth--;
      if (depth === 0) return source.slice(start + 1, i);
    }
  }
  // Return partial block if not closed within maxLen
  return source.slice(start + 1, i);
}

export function safeReadSource(absPath: string, maxBytes: number): string | undefined {
  try {
    const stat = statSync(absPath);
    if (stat.size > maxBytes) return undefined;
    return readFileSync(absPath, 'utf-8');
  } catch {
    return undefined;
  }
}

export function langFromExt(ext: string): string {
  if (ext === '.ts' || ext === '.tsx') return 'typescript';
  if (ext === '.js' || ext === '.jsx' || ext === '.mjs' || ext === '.cjs') return 'javascript';
  return 'unknown';
}
