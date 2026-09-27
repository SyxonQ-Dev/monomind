import { basename, extname } from 'node:path';
import { insertEdges } from '../../storage/edge-store.js';
import { insertNodes } from '../../storage/node-store.js';
import type { MonographEdge, MonographNode } from '../../types.js';
import type { PipelinePhase } from '../types.js';
import { langFromExt, safeReadSource } from './orm-helpers.js';
import { detectMongooseEntities } from './orm-mongoose.js';
import { detectPrismaEntities } from './orm-prisma.js';
import { detectSequelizeEntities } from './orm-sequelize.js';
import { detectSQLAlchemyEntities } from './orm-sqlalchemy.js';
import { detectTypeOrmEntities } from './orm-typeorm.js';
import type { StructureOutput } from './structure.js';

// ── Output types ──────────────────────────────────────────────────────────────

export interface FieldDef {
  name: string;
  type: string;
  fieldNodeId: string;
}

export interface EntityDef {
  name: string;
  filePath: string;
  fields: FieldDef[];
  entityNodeId: string;
}

export interface OrmOutput {
  entities: EntityDef[];
}

// ── Supported code extensions ─────────────────────────────────────────────────

const TS_JS_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs']);

// ── Phase ─────────────────────────────────────────────────────────────────────

export const ormPhase: PipelinePhase<OrmOutput> = {
  name: 'orm',
  deps: ['parse', 'structure'],
  async execute(ctx, deps) {
    if (ctx.allFilesCached)
      return { entities: [], entityNodes: [], fieldNodes: [], hasFieldEdges: [] };
    const { fileNodes } = deps.get('structure') as StructureOutput;
    const entities: EntityDef[] = [];
    const entityNodes: MonographNode[] = [];
    const fieldNodes: MonographNode[] = [];
    const hasFieldEdges: MonographEdge[] = [];

    for (const fileNode of fileNodes) {
      const relPath = fileNode.filePath ?? '';
      const ext = extname(relPath).toLowerCase();
      const fileName = basename(relPath);

      const isPrisma = fileName.endsWith('.prisma');
      const isPython = ext === '.py';
      const isTsJs = TS_JS_EXTENSIONS.has(ext);

      if (!isPrisma && !isPython && !isTsJs) continue;

      const source = safeReadSource(`${ctx.repoPath}/${relPath}`, ctx.options.maxFileSizeBytes);
      if (!source) continue;

      const language = isPrisma ? 'prisma' : isPython ? 'python' : langFromExt(ext);

      if (isPrisma) {
        detectPrismaEntities(
          source,
          relPath,
          language,
          entities,
          entityNodes,
          fieldNodes,
          hasFieldEdges,
        );
      } else if (isPython) {
        detectSQLAlchemyEntities(
          source,
          relPath,
          language,
          entities,
          entityNodes,
          fieldNodes,
          hasFieldEdges,
        );
      } else {
        // TypeORM/MikroORM and Mongoose and Sequelize for TS/JS files
        detectTypeOrmEntities(
          source,
          relPath,
          language,
          entities,
          entityNodes,
          fieldNodes,
          hasFieldEdges,
        );
        detectMongooseEntities(
          source,
          relPath,
          language,
          entities,
          entityNodes,
          fieldNodes,
          hasFieldEdges,
        );
        detectSequelizeEntities(
          source,
          relPath,
          language,
          entities,
          entityNodes,
          fieldNodes,
          hasFieldEdges,
        );
      }
    }

    if (ctx.db) {
      insertNodes(ctx.db, entityNodes);
      insertNodes(ctx.db, fieldNodes);
      insertEdges(ctx.db, hasFieldEdges);
    }

    return { entities };
  },
};
