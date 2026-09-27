import type { MonographEdge, MonographNode } from '../../types.js';
import { makeId, toNormLabel } from '../../types.js';
import type { EntityDef, FieldDef } from './orm.js';
import { addField, extractBraceBlock } from './orm-helpers.js';

// Split out of orm.ts (file-size sweep). Pure move: no behaviour change.

/** Sequelize: class Foo extends Model (or extends Model.Model) */
export const SEQUELIZE_CLASS_RE = /class\s+(\w+)\s+extends\s+(?:\w+\.)?Model\b/g;

/** Sequelize Model.init({ field: ... }, { sequelize }) — capture the first arg block */
export const SEQUELIZE_INIT_RE = /(\w+)\.init\s*\(\s*\{/g;

/** Sequelize sequelize.define('ModelName', { ... }) */
export const SEQUELIZE_DEFINE_RE = /\.define\s*\(\s*['"](\w+)['"]\s*,\s*\{/g;

/** Sequelize field inside init/define block: fieldName: DataTypes.X or fieldName: { type: DataTypes.X } */
export const SEQUELIZE_FIELD_RE =
  /(\w+)\s*:\s*(?:\{[^}]*type\s*:\s*(?:DataTypes\.)?(\w+)|(?:DataTypes\.)?(\w+))/g;

export function detectSequelizeEntities(
  source: string,
  filePath: string,
  language: string,
  entities: EntityDef[],
  entityNodes: MonographNode[],
  fieldNodes: MonographNode[],
  edges: MonographEdge[],
): void {
  // Track entity names we've already registered to avoid duplicates.
  const registeredNames = new Set<string>();

  function registerEntity(entityName: string): string {
    const entityNodeId = makeId('entity', entityName + filePath);
    if (registeredNames.has(entityName)) return entityNodeId;
    registeredNames.add(entityName);

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
    return entityNodeId;
  }

  // Collect class names that extend Model so we can match them in .init() calls.
  const modelClasses = new Set<string>();
  const classRe = new RegExp(SEQUELIZE_CLASS_RE.source, 'g');
  let cm: RegExpExecArray | null;
  while ((cm = classRe.exec(source)) !== null) {
    modelClasses.add(cm[1]);
  }

  // Handle: ClassName.init({ ... }, { sequelize })
  const initRe = new RegExp(SEQUELIZE_INIT_RE.source, 'g');
  let im: RegExpExecArray | null;
  while ((im = initRe.exec(source)) !== null) {
    const candidateName = im[1];
    // Only treat as Sequelize if it's a known Model subclass OR if DataTypes appears in the block.
    const blockStart = im.index + im[0].length - 1; // position of the opening '{'
    const block = extractBraceBlock(source, blockStart, 4000);
    if (!block) continue;
    if (!modelClasses.has(candidateName) && !block.includes('DataTypes')) continue;

    const entityNodeId = registerEntity(candidateName);
    const fields: FieldDef[] = [];
    const fieldRe = new RegExp(SEQUELIZE_FIELD_RE.source, 'g');
    let fm: RegExpExecArray | null;
    const seen = new Set<string>();
    while ((fm = fieldRe.exec(block)) !== null) {
      const fieldName = fm[1];
      const fieldType = fm[2] ?? fm[3] ?? 'DataType';
      if (seen.has(fieldName)) continue;
      if (
        ['type', 'allowNull', 'defaultValue', 'primaryKey', 'unique', 'references'].includes(
          fieldName,
        )
      )
        continue;
      seen.add(fieldName);
      addField(
        candidateName,
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
    entities.push({ name: candidateName, filePath, fields, entityNodeId });
  }

  // Handle: sequelize.define('ModelName', { ... })
  const defineRe = new RegExp(SEQUELIZE_DEFINE_RE.source, 'g');
  let dm: RegExpExecArray | null;
  while ((dm = defineRe.exec(source)) !== null) {
    const entityName = dm[1];
    const blockStart = dm.index + dm[0].length - 1;
    const block = extractBraceBlock(source, blockStart, 4000);

    const entityNodeId = registerEntity(entityName);
    const fields: FieldDef[] = [];
    if (block) {
      const fieldRe = new RegExp(SEQUELIZE_FIELD_RE.source, 'g');
      let fm: RegExpExecArray | null;
      const seen = new Set<string>();
      while ((fm = fieldRe.exec(block)) !== null) {
        const fieldName = fm[1];
        const fieldType = fm[2] ?? fm[3] ?? 'DataType';
        if (seen.has(fieldName)) continue;
        if (
          ['type', 'allowNull', 'defaultValue', 'primaryKey', 'unique', 'references'].includes(
            fieldName,
          )
        )
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
