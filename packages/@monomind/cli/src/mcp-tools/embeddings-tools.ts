/**
 * Embeddings MCP Tools for CLI
 *
 * Tool definitions for ONNX embeddings with hyperbolic support and neural substrate.
 * Implements ADR-024: Embeddings MCP Tools
 */

import { embeddingsCoreTools } from './embeddings-tools-core.js';
import { embeddingsNeuralTools } from './embeddings-tools-neural.js';
import type { MCPTool } from './types.js';

/** Ungated — internal/test use only. MCP clients get `embeddingsTools` below. */
export const allEmbeddingsTools: MCPTool[] = [...embeddingsCoreTools, ...embeddingsNeuralTools];

// embeddings_neural's `init` action persists a config blob (sona/flashAttention/
// ewcPlusPlus/etc.) with no implementing code anywhere for those flags — gated
// behind MONOMIND_MCP_SPECULATIVE=1. The other 6 tools in this file
// (embeddings_init/generate/compare/search/hyperbolic/status) do real work
// and stay visible by default.
const SPECULATIVE = process.env.MONOMIND_MCP_SPECULATIVE === '1';

export const embeddingsTools: MCPTool[] = SPECULATIVE
  ? allEmbeddingsTools
  : allEmbeddingsTools.filter((t) => t.name !== 'embeddings_neural');
