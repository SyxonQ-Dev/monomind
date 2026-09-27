/**
 * Embeddings MCP Tools — ONNX generation and hyperbolic (Poincaré ball) math.
 * Extracted from embeddings-tools.ts.
 */

// Real ONNX embedding generation via memory-initializer
let realEmbeddingFn:
  | ((text: string) => Promise<{ embedding: number[]; dimensions: number; model: string }>)
  | null = null;

async function getRealEmbeddingFunction() {
  if (!realEmbeddingFn) {
    try {
      const { generateEmbedding } = await import('../memory/memory-initializer.js');
      realEmbeddingFn = generateEmbedding;
    } catch {
      realEmbeddingFn = null;
    }
  }
  return realEmbeddingFn;
}

// Generate real ONNX embedding (falls back to deterministic hash if ONNX unavailable)
export async function generateRealEmbedding(text: string, dimension: number): Promise<number[]> {
  const realFn = await getRealEmbeddingFunction();

  if (realFn) {
    try {
      const result = await realFn(text);
      return result.embedding;
    } catch {
      // Fall through to fallback
    }
  }

  // Fallback: deterministic hash-based (only if ONNX truly unavailable)
  console.warn('[MCP] ONNX unavailable, using fallback embedding');
  const embedding: number[] = [];
  let hash = 0;
  for (let i = 0; i < text.length; i++) {
    hash = ((hash << 5) - hash + text.charCodeAt(i)) | 0;
  }

  for (let i = 0; i < dimension; i++) {
    const seed = hash + i * 1337;
    embedding.push(Math.sin(seed) * Math.cos(seed * 0.5));
  }

  // L2 normalize
  const norm = Math.sqrt(embedding.reduce((sum, x) => sum + x * x, 0));
  return embedding.map((x) => x / norm);
}

// Convert Euclidean embedding to Poincaré ball
export function toPoincare(euclidean: number[], curvature: number): number[] {
  const c = Math.abs(curvature);
  const sqrtC = Math.sqrt(c);
  const norm = Math.sqrt(euclidean.reduce((sum, x) => sum + x * x, 0));

  // Exponential map at origin
  const factor = Math.tanh((sqrtC * norm) / 2) / (sqrtC * norm + 1e-15);
  return euclidean.map((x) => x * factor);
}

// Poincaré distance
export function poincareDistance(a: number[], b: number[], curvature: number): number {
  const c = Math.abs(curvature);

  const diffSq = a.reduce((sum, _, i) => sum + (a[i] - b[i]) ** 2, 0);
  const normASq = a.reduce((sum, x) => sum + x * x, 0);
  const normBSq = b.reduce((sum, x) => sum + x * x, 0);

  const denom = (1 - normASq) * (1 - normBSq);
  const delta = (2 * diffSq) / (denom + 1e-15);

  return (1 / Math.sqrt(c)) * Math.acosh(1 + delta);
}
