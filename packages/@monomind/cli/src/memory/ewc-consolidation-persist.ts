/**
 * Persistence methods for EWCConsolidator (save/load/clear).
 * File-size sweep: split out of ewc-consolidation.ts. Mixed into
 * EWCConsolidator.prototype at the bottom of ewc-consolidation.ts.
 *
 * @module v1/cli/memory/ewc-consolidation-persist
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { EWCConsolidator } from './ewc-consolidation.js';

export const ewcPersistMethods = {
  /**
   * Clear all patterns and history (full reset)
   */
  clear(this: EWCConsolidator): void {
    // Cancel any pending debounced write before clearing
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    this.dirty = false;
    this.patterns.clear();
    this.gradientHistory = [];
    this.globalFisher = new Array(this.config.dimensions).fill(0);
    this.consolidationHistory = [];

    // Remove persisted file
    try {
      if (fs.existsSync(this.config.storagePath)) {
        fs.unlinkSync(this.config.storagePath);
      }
    } catch {
      // Ignore deletion errors
    }
  },

  /**
   * Save state to disk
   */
  saveToDisk(this: EWCConsolidator): void {
    try {
      const dir = path.dirname(this.config.storagePath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }

      const state = {
        version: '1.0.0',
        config: {
          lambda: this.config.lambda,
          dimensions: this.config.dimensions,
          fisherDecayRate: this.config.fisherDecayRate,
        },
        globalFisher: this.globalFisher,
        patterns: Array.from(this.patterns.entries()),
        consolidationHistory: this.consolidationHistory.slice(-100),
        savedAt: Date.now(),
      };

      const tmp = `${this.config.storagePath}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
      fs.renameSync(tmp, this.config.storagePath);
    } catch (e) {
      // Silently fail - persistence is best-effort
      if (process.env.DEBUG || process.env.MONOMIND_DEBUG)
        console.error('[ewc-consolidation] failed to persist state:', e);
    }
  },

  /**
   * Load state from disk
   */
  async loadFromDisk(this: EWCConsolidator): Promise<void> {
    if (!fs.existsSync(this.config.storagePath)) {
      throw new Error('No persisted state found');
    }
    const fileSize = fs.statSync(this.config.storagePath).size;
    if (fileSize > 50 * 1024 * 1024) {
      throw new Error(`EWC state file too large (${fileSize} bytes); refusing to load`);
    }

    const content = fs.readFileSync(this.config.storagePath, 'utf-8');
    const state = JSON.parse(content);

    // Validate version
    if (state.version !== '1.0.0') {
      throw new Error(`Unsupported state version: ${state.version}`);
    }

    // Validate globalFisher — must be a finite-numeric vector matching dim.
    // An attacker who can write the persisted file could otherwise inject
    // [Infinity, ...] (freezes learning via the penalty>lambda damping branch)
    // or NaN values that poison ranking unpredictably.
    if (
      Array.isArray(state.globalFisher) &&
      state.globalFisher.length === this.config.dimensions &&
      state.globalFisher.every((v: unknown) => typeof v === 'number' && Number.isFinite(v))
    ) {
      this.globalFisher = state.globalFisher;
    } else {
      this.globalFisher = new Array(this.config.dimensions).fill(0);
    }

    // Restore patterns — drop any whose weights/fisherDiagonal are invalid.
    this.patterns.clear();
    if (Array.isArray(state.patterns)) {
      const isFiniteNumberArray = (a: unknown, dim: number): boolean =>
        Array.isArray(a) &&
        a.length === dim &&
        a.every((v) => typeof v === 'number' && Number.isFinite(v));
      for (const entry of state.patterns) {
        if (!Array.isArray(entry) || entry.length !== 2) continue;
        const [id, pattern] = entry;
        if (typeof id !== 'string' || id.length > 256) continue;
        const p = pattern as Record<string, unknown> | undefined;
        if (!p || typeof p !== 'object') continue;
        if (p.weights !== undefined && !isFiniteNumberArray(p.weights, this.config.dimensions))
          continue;
        if (
          p.fisherDiagonal !== undefined &&
          !isFiniteNumberArray(p.fisherDiagonal, this.config.dimensions)
        )
          continue;
        this.patterns.set(id, pattern);
      }
    }

    // Restore history — cap to last 100 entries so a crafted state file cannot
    // bloat the in-memory array (each entry is a small object, but the array is
    // summed on every getConsolidationStats() call which is O(n)).
    this.consolidationHistory = Array.isArray(state.consolidationHistory)
      ? state.consolidationHistory.slice(-100)
      : [];

    // Update config from persisted values, clamped to a sensible range to
    // prevent negative/NaN lambda from inverting the regularization sign.
    if (
      state.config &&
      typeof state.config.lambda === 'number' &&
      Number.isFinite(state.config.lambda) &&
      state.config.lambda >= 0 &&
      state.config.lambda <= 1000
    ) {
      this.config.lambda = state.config.lambda;
    }
  },
};
