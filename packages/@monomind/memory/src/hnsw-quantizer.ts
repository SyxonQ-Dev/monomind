/**
 * V1 HNSW Vector Index — vector quantizer
 *
 * Split out of hnsw-index.ts (file-size sweep). Pure move: no behaviour change.
 *
 * @module v1/memory/hnsw-quantizer
 */

import type { QuantizationConfig } from './types.js';

/**
 * Quantizer for vector compression
 */
export class Quantizer {
  private config: QuantizationConfig;
  private dimensions: number;

  constructor(config: QuantizationConfig, dimensions: number) {
    this.config = config;
    this.dimensions = dimensions;
  }

  /**
   * Encode a vector using quantization
   */
  encode(vector: Float32Array): Float32Array {
    if (vector.length !== this.dimensions) {
      throw new Error(
        `Vector dimension mismatch: expected ${this.dimensions}, got ${vector.length}`,
      );
    }
    switch (this.config.type) {
      case 'binary':
        return this.binaryQuantize(vector);
      case 'scalar':
        return this.scalarQuantize(vector);
      case 'product':
        return this.productQuantize(vector);
      default:
        return vector;
    }
  }

  /**
   * Get compression ratio
   */
  getCompressionRatio(): number {
    switch (this.config.type) {
      case 'binary':
        return 1.0; // sign quantization: same dimension, no compression
      case 'scalar':
        return 32 / (this.config.bits || 8);
      case 'product':
        return this.config.subquantizers || 8;
      default:
        return 1;
    }
  }

  private binaryQuantize(vector: Float32Array): Float32Array {
    // Sign quantization: map each component to 0.0 (≤0) or 1.0 (>0).
    // Result is a valid float vector compatible with all distance metrics.
    const binary = new Float32Array(vector.length);
    for (let i = 0; i < vector.length; i++) {
      binary[i] = vector[i] > 0 ? 1.0 : 0.0;
    }
    return binary;
  }

  private scalarQuantize(vector: Float32Array): Float32Array {
    // Find min/max for normalization
    let min = Infinity;
    let max = -Infinity;
    for (let i = 0; i < vector.length; i++) {
      if (vector[i] < min) min = vector[i];
      if (vector[i] > max) max = vector[i];
    }

    const range = max - min || 1;
    const bits = this.config.bits || 8;
    const levels = 2 ** bits;

    // Quantize each value to [0, levels-1] and normalize back to [0, 1]
    // so the resulting vector is compatible with cosine/euclidean distance.
    const quantized = new Float32Array(vector.length);
    for (let i = 0; i < vector.length; i++) {
      const normalized = (vector[i] - min) / range;
      quantized[i] = Math.round(normalized * (levels - 1)) / (levels - 1);
    }

    return quantized;
  }

  private productQuantize(vector: Float32Array): Float32Array {
    // Simplified product quantization
    // In production, would use trained codebooks
    const subquantizers = this.config.subquantizers || 8;
    const subvectorSize = Math.ceil(vector.length / subquantizers);

    const quantized = new Float32Array(subquantizers);

    for (let i = 0; i < subquantizers; i++) {
      let sum = 0;
      const start = i * subvectorSize;
      const end = Math.min(start + subvectorSize, vector.length);

      for (let j = start; j < end; j++) {
        sum += vector[j];
      }

      quantized[i] = sum / (end - start);
    }

    return quantized;
  }
}
