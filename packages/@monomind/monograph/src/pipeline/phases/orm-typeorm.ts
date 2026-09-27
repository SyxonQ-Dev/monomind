import type { MonographEdge, MonographNode } from '../../types.js';
import { makeId, toNormLabel } from '../../types.js';
import type { EntityDef, FieldDef } from './orm.js';
import { addField } from './orm-helpers.js';

// Split out of orm.ts (file-size sweep). Pure move: no behaviour change.

/** TypeORM: @Entity() decorator before a class */
export const TYPEORM_ENTITY_RE =
  /@Entity\s*\([^)]*\)\s*(?:export\s+)?(?:abstract\s+)?class\s+(\w+)/g;

/** TypeORM/MikroORM column decorator (matches the decorator line only) */
export const TYPEORM_COLUMN_DECORATOR_RE =
  /@(?:Primary(?:Generated)?Column|Column|CreateDateColumn|UpdateDateColumn|DeleteDateColumn|Property|PrimaryKey|ManyToOne|OneToMany|ManyToMany|OneToOne)\s*\([^)]*\)/g;

/** Property declaration after a TypeORM column decorator */
export const TYPEORM_PROP_RE = /(\w+)\s*[!?]?\s*:\s*(\w+)/;

export function detectTypeOrmEntities(
  source: string,
  filePath: string,
  language: string,
  entities: EntityDef[],
  entityNodes: MonographNode[],
  fieldNodes: MonographNode[],
  edges: MonographEdge[],
): void {
  const entityRe = new RegExp(TYPEORM_ENTITY_RE.source, 'g');
  const lines = source.split('\n');
  let m: RegExpExecArray | null;

  while ((m = entityRe.exec(source)) !== null) {
    const entityName = m[1];
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
    const colDecRe = new RegExp(TYPEORM_COLUMN_DECORATOR_RE.source, 'g');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (colDecRe.test(line)) {
        colDecRe.lastIndex = 0; // reset after test
        // Look at the next non-empty line for the property declaration
        for (let j = i + 1; j < Math.min(i + 4, lines.length); j++) {
          const propLine = lines[j].trim();
          if (!propLine || propLine.startsWith('@') || propLine.startsWith('//')) continue;
          const pm = TYPEORM_PROP_RE.exec(propLine);
          if (pm) {
            addField(
              entityName,
              pm[1],
              pm[2],
              filePath,
              language,
              entityNodeId,
              fields,
              fieldNodes,
              edges,
            );
          }
          break;
        }
      }
      colDecRe.lastIndex = 0; // always reset
    }

    entities.push({ name: entityName, filePath, fields, entityNodeId });
  }
}
