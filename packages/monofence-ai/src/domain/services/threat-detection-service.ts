/**
 * Threat Detection Service
 *
 * Core detection logic for AI manipulation attempts.
 * Embedded implementation based on AIMDS patterns.
 *
 * Performance targets:
 * - Detection: <10ms
 * - Pattern matching: <5ms
 * - PII scan: <3ms
 */

import { createHash } from 'node:crypto';
import {
  createThreat,
  type Threat,
  type ThreatDetectionResult,
  type ThreatSeverity,
  type ThreatType,
} from '../entities/threat.js';
import { createEvasionDetector, type EvasionDetector } from './evasion-detector.js';
import { PII_PATTERNS, PROMPT_INJECTION_PATTERNS, type ThreatPattern } from './threat-patterns.js';

/**
 * Threat Detection Service
 */
export class ThreatDetectionService {
  private readonly patterns: ThreatPattern[];
  private readonly evasionDetector: EvasionDetector;
  private detectionCount = 0;
  private totalDetectionTimeMs = 0;

  constructor(customPatterns?: ThreatPattern[]) {
    this.patterns = customPatterns ?? PROMPT_INJECTION_PATTERNS;
    this.evasionDetector = createEvasionDetector();
    // Warm up JIT: run a no-op normalization so the first real detect() call
    // does not pay regex-compilation cost inside the measured window
    this.evasionDetector.normalize('warmup');
  }

  /**
   * Detect threats in input text
   * Target: <10ms latency
   */
  detect(input: string): ThreatDetectionResult {
    const startTime = performance.now();
    const threats: Threat[] = [];

    // Evasion pre-pass: normalize and detect obfuscation techniques
    const evasionResult = this.evasionDetector.normalize(input);
    const normalizedInput = evasionResult.normalizedInput;

    // Pattern matching against evasion-normalized input
    for (const pattern of this.patterns) {
      const match = pattern.pattern.exec(normalizedInput);
      if (match) {
        // Calculate confidence with context
        const confidence = this.calculateConfidence(pattern, match, normalizedInput);

        threats.push(
          createThreat({
            type: pattern.type,
            severity: this.adjustSeverity(pattern.severity, confidence),
            confidence,
            pattern: pattern.pattern.source,
            description: pattern.description,
            location: {
              start: match.index,
              end: match.index + match[0].length,
            },
          }),
        );
      }
    }

    // PII detection uses original input to avoid false negatives on real PII
    const piiFound = this.detectPII(input);

    // Calculate overallRisk from highest-confidence threat
    const deduped = this.deduplicateThreats(threats);
    const baseRisk = deduped.length > 0 ? Math.max(...deduped.map((t) => t.confidence)) : 0;
    const overallRisk = evasionResult.wasObfuscated ? Math.min(1.0, baseRisk + 0.1) : baseRisk;

    const detectionTimeMs = performance.now() - startTime;
    this.detectionCount++;
    this.totalDetectionTimeMs += detectionTimeMs;

    return {
      safe: deduped.length === 0,
      threats: deduped,
      detectionTimeMs,
      piiFound,
      inputHash: this.hashInput(input),
      wasObfuscated: evasionResult.wasObfuscated,
      overallRisk,
    };
  }

  /**
   * Quick scan - pattern matching only (with evasion normalization)
   * Target: <5ms latency
   */
  quickScan(input: string): { threat: boolean; confidence: number } {
    // Run through evasion detector so obfuscated inputs are also caught
    const evasionResult = this.evasionDetector.normalize(input);
    const normalizedInput = this.normalizeInput(evasionResult.normalizedInput);

    let maxConfidence = 0;
    let threatFound = false;

    for (const pattern of this.patterns) {
      if (pattern.pattern.test(normalizedInput)) {
        threatFound = true;
        maxConfidence = Math.max(maxConfidence, pattern.baseConfidence);

        // Early exit on critical threats
        if (pattern.severity === 'critical') {
          return { threat: true, confidence: maxConfidence };
        }
      }
    }

    return { threat: threatFound, confidence: maxConfidence };
  }

  /**
   * Detect PII in text
   */
  detectPII(input: string): boolean {
    for (const pii of PII_PATTERNS) {
      if (pii.pattern.test(input)) {
        return true;
      }
    }
    return false;
  }

  /**
   * Get detection statistics
   */
  getStats(): { detectionCount: number; avgDetectionTimeMs: number } {
    return {
      detectionCount: this.detectionCount,
      avgDetectionTimeMs:
        this.detectionCount > 0 ? this.totalDetectionTimeMs / this.detectionCount : 0,
    };
  }

  /**
   * Normalize input for consistent detection
   */
  private normalizeInput(input: string): string {
    return (
      input
        // Normalize unicode
        .normalize('NFKC')
        // Remove zero-width characters
        .replace(/[\u200B-\u200D\uFEFF]/g, '')
        // Normalize whitespace
        .replace(/\s+/g, ' ')
        .trim()
    );
  }

  /**
   * Calculate confidence with contextual factors
   */
  private calculateConfidence(
    pattern: ThreatPattern,
    match: RegExpExecArray,
    input: string,
  ): number {
    let confidence = pattern.baseConfidence;

    // Contextual boosts are capped in aggregate. Previously each additional
    // co-occurring pattern added an uncapped +0.05, so a long document that
    // incidentally tripped several weak patterns could promote a 0.55 "may be
    // legitimate" signal all the way to 0.99 "critical". A pattern's base
    // confidence is a statement about how diagnostic that pattern is; context
    // may sharpen it, but must not redefine it.
    const MAX_CONTEXT_BOOST = 0.1;
    let boost = 0;

    // Boost confidence if multiple threat indicators
    const threatIndicatorCount = this.patterns.filter((p) => p.pattern.test(input)).length;
    if (threatIndicatorCount > 1) {
      boost += 0.05 * (threatIndicatorCount - 1);
    }

    // Boost confidence if at start of input (more likely intentional)
    if (match.index < 20) {
      boost += 0.05;
    }

    confidence = Math.min(confidence + Math.min(boost, MAX_CONTEXT_BOOST), 0.99);

    // Reduce confidence for very short inputs (less context)
    if (input.length < 50) {
      confidence *= 0.9;
    }

    return Math.round(confidence * 100) / 100;
  }

  /**
   * Adjust severity based on confidence
   */
  private adjustSeverity(baseSeverity: ThreatSeverity, confidence: number): ThreatSeverity {
    if (confidence < 0.5 && baseSeverity === 'critical') {
      return 'high';
    }
    if (confidence < 0.4 && baseSeverity === 'high') {
      return 'medium';
    }
    return baseSeverity;
  }

  /**
   * Deduplicate threats by type
   */
  private deduplicateThreats(threats: Threat[]): Threat[] {
    const seen = new Map<ThreatType, Threat>();

    for (const threat of threats) {
      const existing = seen.get(threat.type);
      if (!existing || threat.confidence > existing.confidence) {
        seen.set(threat.type, threat);
      }
    }

    return Array.from(seen.values()).sort((a, b) => {
      // Sort by severity first, then confidence
      const severityOrder = { critical: 0, high: 1, medium: 2, low: 3 };
      const severityDiff = severityOrder[a.severity] - severityOrder[b.severity];
      return severityDiff !== 0 ? severityDiff : b.confidence - a.confidence;
    });
  }

  /**
   * Hash input for caching/deduplication
   */
  private hashInput(input: string): string {
    return createHash('sha256').update(input).digest('hex').slice(0, 16);
  }
}

/**
 * Create a new ThreatDetectionService instance
 */
export function createThreatDetectionService(
  customPatterns?: ThreatPattern[],
): ThreatDetectionService {
  return new ThreatDetectionService(customPatterns);
}
