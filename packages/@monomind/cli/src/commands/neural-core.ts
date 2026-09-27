/**
 * Neural core commands — train, status, patterns, predict
 * Pattern storage and similarity search (no ML/neural-network training)
 *
 * Split into sibling modules (file-size sweep, pure move); this file
 * re-exports everything so existing import paths keep working.
 */

export { patternsCommand } from './neural-core-patterns.js';
export { predictCommand } from './neural-core-predict.js';
export { statusCommand } from './neural-core-status.js';
export { trainCommand } from './neural-core-train.js';
