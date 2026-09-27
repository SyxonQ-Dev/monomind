/**
 * V1 Intelligence Module — SONA routing pattern bridge
 * Split out of intelligence.ts (file-size sweep). Pure move.
 *
 * @module v1/cli/intelligence
 */

import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { Pattern } from './intelligence-types.js';

/**
 * Read routing patterns from the SONA optimizer's .swarm/sona-patterns.json
 * and convert them to the standard Pattern shape used by intelligence.ts.
 * Returns an empty array when the file is absent or unreadable.
 */
export function loadSonaRoutingPatterns(): Pattern[] {
  try {
    const sonaPath = join(process.cwd(), '.swarm', 'sona-patterns.json');
    if (!existsSync(sonaPath)) return [];
    if (statSync(sonaPath).size > 10 * 1024 * 1024) return [];

    const raw = JSON.parse(readFileSync(sonaPath, 'utf-8'));
    const persisted = raw as {
      patterns?: Record<
        string,
        {
          keywords?: string[];
          agent?: string;
          confidence?: number;
          successCount?: number;
          failureCount?: number;
          createdAt?: number;
        }
      >;
    };
    if (
      !persisted.patterns ||
      typeof persisted.patterns !== 'object' ||
      Array.isArray(persisted.patterns)
    )
      return [];

    const now = Date.now();
    const results: Pattern[] = [];

    // Cap total entries to prevent DoS via an unbounded patterns map.
    // sona-patterns.json is written by the SONA optimizer but could be
    // replaced or hand-edited outside the process — validate every field before use.
    const MAX_SONA_ENTRIES = 500;
    let entryCount = 0;

    for (const [key, p] of Object.entries(persisted.patterns)) {
      // Prototype pollution guard — skip __proto__ / constructor / prototype keys.
      if (key === '__proto__' || key === 'constructor' || key === 'prototype') continue;
      if (typeof key !== 'string' || key.length === 0 || key.length > 256) continue;
      if (entryCount++ >= MAX_SONA_ENTRIES) break;

      if (!p || typeof p !== 'object') continue;

      // Validate keywords: must be a bounded array of short strings.
      const rawKw = p.keywords;
      let keywords: string[];
      if (rawKw === undefined) {
        keywords = [key];
      } else if (
        Array.isArray(rawKw) &&
        rawKw.length <= 64 &&
        rawKw.every((k) => typeof k === 'string' && k.length > 0 && k.length <= 128)
      ) {
        keywords = rawKw as string[];
      } else {
        continue; // malformed keywords — skip entry
      }

      // Validate agent string.
      const agent = p.agent;
      if (
        agent !== undefined &&
        (typeof agent !== 'string' || agent.length === 0 || agent.length > 128)
      )
        continue;

      // Validate confidence is a finite number in [0, 1].
      const rawConf = p.confidence;
      const confidence = rawConf !== undefined ? rawConf : 0.5;
      if (
        typeof confidence !== 'number' ||
        !Number.isFinite(confidence) ||
        confidence < 0 ||
        confidence > 1
      )
        continue;

      // Validate usage counts are safe integers.
      const sc = p.successCount ?? 0;
      const fc = p.failureCount ?? 0;
      if (typeof sc !== 'number' || !Number.isFinite(sc) || sc < 0 || sc > 1e9) continue;
      if (typeof fc !== 'number' || !Number.isFinite(fc) || fc < 0 || fc > 1e9) continue;

      // Validate createdAt is a reasonable epoch ms value.
      const rawTs = p.createdAt;
      const createdAt =
        rawTs !== undefined &&
        typeof rawTs === 'number' &&
        Number.isFinite(rawTs) &&
        rawTs >= 0 &&
        rawTs <= 9.9e12
          ? rawTs
          : now;

      results.push({
        id: `sona:${key}`,
        type: agent ?? 'routing',
        content: keywords.join(' '),
        confidence,
        usageCount: sc + fc,
        embedding: [] as number[],
        createdAt,
        lastUsedAt: now,
      });
    }

    return results;
  } catch (e) {
    if (process.env.DEBUG || process.env.MONOMIND_DEBUG)
      console.error('[intelligence] failed to load .swarm/sona-patterns.json:', e);
    return [];
  }
}
