import type { MonographEdge, MonographNode } from '../../types.js';
import { makeId, toNormLabel } from '../../types.js';
import type { EntityDef, FieldDef } from './orm.js';
import { addField, extractBraceBlock } from './orm-helpers.js';

// Split out of orm.ts (file-size sweep). Pure move: no behaviour change.

/** Mongoose: const XxxSchema = new Schema({ */
export const MONGOOSE_SCHEMA_RE =
  /(?:const|let|var)\s+(\w*[Ss]chema)\s*=\s*new\s+(?:\w+\.)?Schema\s*\(\s*\{/g;

/** Mongoose field inside a Schema object: fieldName: { type: SomeType } or fieldName: SomeType */
export const MONGOOSE_FIELD_RE = /(\w+)\s*:\s*(?:\{[^}]*type\s*:\s*(\w+)|(\w+))/g;

export function detectMongooseEntities(
  source: string,
  filePath: string,
  language: string,
  entities: EntityDef[],
  entityNodes: MonographNode[],
  fieldNodes: MonographNode[],
  edges: MonographEdge[],
): void {
  const schemaRe = new RegExp(MONGOOSE_SCHEMA_RE.source, 'g');
  let m: RegExpExecArray | null;

  while ((m = schemaRe.exec(source)) !== null) {
    const schemaVarName = m[1];
    // Remove 'Schema' suffix to get entity name
    const entityName = schemaVarName.replace(/[Ss]chema$/, '') || schemaVarName;
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

    // Extract a block after the Schema({ starting point
    const blockStart = m.index + m[0].length;
    const block = extractBraceBlock(source, blockStart - 1, 4000);

    const fields: FieldDef[] = [];
    if (block) {
      const fieldRe = new RegExp(MONGOOSE_FIELD_RE.source, 'g');
      let fm: RegExpExecArray | null;
      const seen = new Set<string>();
      while ((fm = fieldRe.exec(block)) !== null) {
        const fieldName = fm[1];
        const fieldType = fm[2] ?? fm[3] ?? 'Mixed';
        if (seen.has(fieldName)) continue;
        // Skip obvious non-field keys
        if (['type', 'required', 'default', 'ref', 'index', 'unique', 'enum'].includes(fieldName))
          continue;
        seen.add(fieldName);
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
    }

    entities.push({ name: entityName, filePath, fields, entityNodeId });
  }
}
