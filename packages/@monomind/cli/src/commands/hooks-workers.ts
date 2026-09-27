/**
 * Hooks Worker Commands
 * Background worker management (@monoes/hooks workers) + Intelligence command
 * Extracted from hooks.ts to reduce file size.
 *
 * Split into sibling modules (file-size sweep, pure move); this file
 * re-exports everything so existing import paths keep working.
 */

export { intelligenceCommand } from './hooks-intelligence-command.js';
export { workerCommand } from './hooks-worker-command.js';
