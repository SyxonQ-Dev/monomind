import type { MonographEdge, MonographNode } from '../../types.js';
import { makeId, toNormLabel } from '../../types.js';
import type { EntityDef, FieldDef } from './orm.js';
import { addField } from './orm-helpers.js';

// Split out of orm.ts (file-size sweep). Pure move: no behaviour change.

/** Prisma model block: model Name { ... } */
export const PRISMA_MODEL_RE = /^model\s+(\w+)\s*\{([^}]+)\}/gm;

/** Prisma field line inside a model block */
export const PRISMA_FIELD_RE = /^\s+(\w+)\s+(\w+)/gm;

export function detectPrismaEntities(
  source: string,
  filePath: string,
  language: string,
  entities: EntityDef[],
  entityNodes: MonographNode[],
  fieldNodes: MonographNode[],
  edges: MonographEdge[],
): void {
  const modelRe = new RegExp(PRISMA_MODEL_RE.source, 'gm');
  let m: RegExpExecArray | null;

  while ((m = modelRe.exec(source)) !== null) {
    const entityName = m[1];
    const body = m[2];
    const entityNodeId = makeId('entity', entityName + filePath);

    const entityNode: MonographNode = {
      id: entityNodeId,
      label: 'Entity',
      name: entityName,
      normLabel: toNormLabel(entityName),
      filePath,
      startLine: 0,
      endLine: 0,
      isExported: true,
      language,
    };
    entityNodes.push(entityNode);

    const fields: FieldDef[] = [];
    const fieldRe = new RegExp(PRISMA_FIELD_RE.source, 'gm');
    let fm: RegExpExecArray | null;

    while ((fm = fieldRe.exec(body)) !== null) {
      const fieldName = fm[1];
      const fieldType = fm[2];
      // Skip Prisma keywords
      if (['model', 'enum', 'type', 'datasource', 'generator'].includes(fieldName)) continue;
      addField(
        entityName,
        fieldName,
        fieldType,
        filePath,
        language,
        entityNodeId,
        fields,
        fieldNodes,
        edges,
      );
    }

    entities.push({ name: entityName, filePath, fields, entityNodeId });
  }
}
