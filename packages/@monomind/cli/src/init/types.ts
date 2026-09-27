/**
 * V1 Init System Types
 * Configuration options for initializing Claude Code integration
 *
 * File-size sweep: split into sibling modules by theme — component/feature
 * config interfaces in types-components.ts, platform detection in
 * types-platform.ts, embeddings config in types-embeddings.ts, the full
 * InitOptions shape + presets in types-options.ts, and init result shapes in
 * types-result.ts. Re-exported here so every existing import path
 * (`./types.js` / `../init/types.js`) keeps working unchanged.
 */

export type {
  AgentsConfig,
  ClaudeMdTemplate,
  CommandsConfig,
  HooksConfig,
  InitComponents,
  MCPConfig,
  RuntimeConfig,
  SkillsConfig,
  StatuslineConfig,
} from './types-components.js';
export type { EmbeddingsConfig } from './types-embeddings.js';
export { DEFAULT_EMBEDDING_DIMS, DEFAULT_EMBEDDING_MODEL } from './types-embeddings.js';
export type { InitOptions } from './types-options.js';
export { DEFAULT_INIT_OPTIONS, FULL_INIT_OPTIONS, MINIMAL_INIT_OPTIONS } from './types-options.js';
export type { PlatformInfo } from './types-platform.js';
export { detectPlatform } from './types-platform.js';
export type { InitMemoryResult, InitResult } from './types-result.js';
