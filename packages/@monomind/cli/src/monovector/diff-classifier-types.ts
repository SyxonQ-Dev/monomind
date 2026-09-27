/**
 * Diff classifier and diff-analysis types.
 */

export interface DiffClassifierConfig {
  maxDiffSize: number;
  classifyByImpact: boolean;
  detectRefactoring: boolean;
  minConfidence: number;
}

export interface DiffHunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  content: string;
  changes: DiffChange[];
}

export interface DiffChange {
  type: 'add' | 'remove' | 'context';
  lineNumber: number;
  content: string;
}

export interface DiffClassification {
  primary: 'feature' | 'bugfix' | 'refactor' | 'docs' | 'test' | 'config' | 'style' | 'unknown';
  secondary: string[];
  confidence: number;
  impactLevel: 'low' | 'medium' | 'high' | 'critical';
  suggestedReviewers: string[];
  testingStrategy: string[];
  riskFactors: string[];
}

export interface FileDiff {
  path: string;
  hunks: DiffHunk[];
  additions: number;
  deletions: number;
  classification: DiffClassification;
}

export interface DiffAnalysis {
  files: FileDiff[];
  overall: DiffClassification;
  stats: {
    totalAdditions: number;
    totalDeletions: number;
    filesChanged: number;
    avgConfidence: number;
  };
  timestamp: number;
}

// ============================================================================
// Additional Exports for MCP Tools
// ============================================================================

/**
 * Risk level type for file risk assessment
 */
export type RiskLevel = 'low' | 'medium' | 'high' | 'critical';

/**
 * Diff file interface for analyze tools
 */
export interface DiffFile {
  path: string;
  status: 'added' | 'modified' | 'deleted' | 'renamed';
  additions: number;
  deletions: number;
  hunks: number;
  binary: boolean;
}

/**
 * File risk assessment result
 */
export interface FileRisk {
  file: string;
  risk: RiskLevel;
  score: number;
  reasons: string[];
}

/**
 * Overall risk assessment result
 */
export interface OverallRisk {
  overall: RiskLevel;
  score: number;
  breakdown: { low: number; medium: number; high: number; critical: number };
}

/**
 * Diff analysis result
 */
export interface DiffAnalysisResult {
  ref: string;
  timestamp: number;
  files: DiffFile[];
  risk: OverallRisk;
  classification: DiffClassification;
  summary: string;
  fileRisks?: FileRisk[];
  recommendedReviewers?: string[];
}
