import type { MonographEdge, MonographNode } from '../../types.js';
import { makeId, toNormLabel } from '../../types.js';
import type { EntityDef, FieldDef } from './orm.js';
import { addField } from './orm-helpers.js';

// Split out of orm.ts (file-size sweep). Pure move: no behaviour change.

/** SQLAlchemy: class Foo(Base) or class Foo(db.Model) etc. */
export const SQLALCHEMY_CLASS_RE = /class\s+(\w+)\s*\([^)]*Base[^)]*\)/g;

/** SQLAlchemy column: fieldName = Column( */
export const SQLALCHEMY_COLUMN_RE = /(\w+)\s*(?::\s*[\w[\]]+)?\s*=\s*Column\s*\(/g;

export function detectSQLAlchemyEntities(
  source: string,
  filePath: string,
  language: string,
  entities: EntityDef[],
  entityNodes: MonographNode[],
  fieldNodes: MonographNode[],
  edges: MonographEdge[],
): void {
  const classRe = new RegExp(SQLALCHEMY_CLASS_RE.source, 'g');
  let m: RegExpExecArray | null;

  while ((m = classRe.exec(source)) !== null) {
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
    // Scope column scan to this class's body — slice from the match end to the next
    // unindented `class ` keyword or end-of-string to avoid assigning columns from
    // other classes to this entity.
    const classBodyStart = m.index + m[0].length;
    const nextClassIdx = source.indexOf('\nclass ', classBodyStart);
    const classBody =
      nextClassIdx >= 0 ? source.slice(classBodyStart, nextClassIdx) : source.slice(classBodyStart);
    const columnRe = new RegExp(SQLALCHEMY_COLUMN_RE.source, 'g');
    let cm: RegExpExecArray | null;
    while ((cm = columnRe.exec(classBody)) !== null) {
      const fieldName = cm[1];
      addField(
        entityName,
        fieldName,
        'Column',
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
