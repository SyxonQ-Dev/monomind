/**
 * Diff Classifier for Change Analysis
 */

import { createDiffClassifier, DiffClassifier } from './diff-classifier-core.js';
import type {
  DiffAnalysisResult,
  DiffClassification,
  DiffFile,
  FileDiff,
  FileRisk,
  OverallRisk,
  RiskLevel,
} from './diff-classifier-types.js';
import { diffCache, getGitDiffNumstat, getGitDiffNumstatAsync } from './diff-git.js';

export type * from './diff-classifier-types.js';
export { clearDiffCache, getGitDiffNumstat, getGitDiffNumstatAsync } from './diff-git.js';
export { createDiffClassifier, DiffClassifier };

/**
 * Assess risk for a single file
 */
export function assessFileRisk(file: DiffFile): FileRisk {
  const reasons: string[] = [];
  let score = 0;

  // Size-based risk
  const totalChanges = file.additions + file.deletions;
  if (totalChanges > 300) {
    score += 30;
    reasons.push('Large change size (>300 lines)');
  } else if (totalChanges > 100) {
    score += 15;
    reasons.push('Medium change size (>100 lines)');
  }

  // Path-based risk
  const lowerPath = file.path.toLowerCase();
  if (/security|auth|crypto|password/.test(lowerPath)) {
    score += 40;
    reasons.push('Security-sensitive file');
  }
  if (/payment|billing|transaction/.test(lowerPath)) {
    score += 35;
    reasons.push('Payment-related file');
  }
  if (/database|migration|schema/.test(lowerPath)) {
    score += 25;
    reasons.push('Database-related file');
  }
  if (/core|main|index/.test(lowerPath)) {
    score += 15;
    reasons.push('Core module');
  }
  if (/config|env|settings/.test(lowerPath)) {
    score += 20;
    reasons.push('Configuration file');
  }

  // Status-based risk
  if (file.status === 'deleted') {
    score += 10;
    reasons.push('File deleted');
  }

  // Binary file risk
  if (file.binary) {
    score += 5;
    reasons.push('Binary file');
  }

  let risk: RiskLevel = 'low';
  if (score >= 60) risk = 'critical';
  else if (score >= 40) risk = 'high';
  else if (score >= 20) risk = 'medium';

  return { file: file.path, risk, score: Math.min(100, score), reasons };
}

/**
 * Assess overall risk from files and file risks
 */
export function assessOverallRisk(_files: DiffFile[], fileRisks: FileRisk[]): OverallRisk {
  const breakdown = { low: 0, medium: 0, high: 0, critical: 0 };
  let totalScore = 0;

  for (const fr of fileRisks) {
    breakdown[fr.risk]++;
    totalScore += fr.score;
  }

  const avgScore = fileRisks.length > 0 ? totalScore / fileRisks.length : 0;

  // Weight more heavily towards high/critical files
  const weightedScore = avgScore + breakdown.critical * 15 + breakdown.high * 10;

  let overall: RiskLevel = 'low';
  if (weightedScore >= 60 || breakdown.critical > 0) overall = 'critical';
  else if (weightedScore >= 40 || breakdown.high > 1) overall = 'high';
  else if (weightedScore >= 20 || breakdown.medium > 2) overall = 'medium';

  return { overall, score: Math.min(100, Math.round(weightedScore)), breakdown };
}

// Singleton classifier instance for reuse
let classifierInstance: DiffClassifier | null = null;

function getClassifier(): DiffClassifier {
  if (!classifierInstance) {
    classifierInstance = new DiffClassifier();
  }
  return classifierInstance;
}

/**
 * Classify a diff based on files (uses singleton classifier)
 */
export function classifyDiff(files: DiffFile[]): DiffClassification {
  const classifier = getClassifier();
  const fileDiffs: FileDiff[] = files.map((f) => ({
    path: f.path,
    hunks: [],
    additions: f.additions,
    deletions: f.deletions,
    classification: classifier.classifyFile(f.path, []),
  }));

  return classifier.computeOverallClassification(fileDiffs);
}

/**
 * Suggest reviewers based on files and risks
 */
export function suggestReviewers(files: DiffFile[], fileRisks: FileRisk[]): string[] {
  const reviewers = new Set<string>();

  for (const file of files) {
    const lowerPath = file.path.toLowerCase();

    if (/security|auth|crypto/.test(lowerPath)) reviewers.add('security-team');
    if (/database|migration/.test(lowerPath)) reviewers.add('dba');
    if (/api|endpoint|route/.test(lowerPath)) reviewers.add('api-owner');
    if (/test|spec/.test(lowerPath)) reviewers.add('qa-engineer');
    if (/config|deploy|ci/.test(lowerPath)) reviewers.add('devops');
    if (/ui|component|style/.test(lowerPath)) reviewers.add('frontend-lead');
    if (/model|service|repository/.test(lowerPath)) reviewers.add('backend-lead');
  }

  // Add based on risk
  const hasHighRisk = fileRisks.some((fr) => fr.risk === 'high' || fr.risk === 'critical');
  if (hasHighRisk) {
    reviewers.add('tech-lead');
    reviewers.add('senior-developer');
  }

  // Default reviewer
  if (reviewers.size === 0) {
    reviewers.add('developer');
  }

  return Array.from(reviewers).slice(0, 5);
}

// Analysis result cache
// FIFO eviction cap matches diffCache. Without a cap, repeated calls to analyzeDiff
// with unique refs (e.g. HEAD~0...HEAD~N) would grow this Map to GBs.
const analysisCache = new Map<string, { result: DiffAnalysisResult; timestamp: number }>();
const ANALYSIS_CACHE_TTL_MS = 3000; // 3 seconds
const ANALYSIS_CACHE_MAX_ENTRIES = 50;

/**
 * Analyze a diff with full analysis (optimized with caching)
 */
export async function analyzeDiff(options: {
  ref?: string;
  useMonoVector?: boolean;
  skipCache?: boolean;
}): Promise<DiffAnalysisResult> {
  const ref = options.ref || 'HEAD';

  // Check analysis cache (unless skipCache is true)
  if (!options.skipCache) {
    const cached = analysisCache.get(ref);
    if (cached && Date.now() - cached.timestamp < ANALYSIS_CACHE_TTL_MS) {
      return cached.result;
    }
  }

  // Use async git diff for non-blocking operation
  const files = await getGitDiffNumstatAsync(ref);

  // Parallel file risk assessment for large diffs
  const fileRisks =
    files.length > 20
      ? await Promise.all(files.map((f) => Promise.resolve(assessFileRisk(f))))
      : files.map(assessFileRisk);

  const risk = assessOverallRisk(files, fileRisks);
  const classification = classifyDiff(files);
  const recommendedReviewers = suggestReviewers(files, fileRisks);

  const totalAdditions = files.reduce((sum, f) => sum + f.additions, 0);
  const totalDeletions = files.reduce((sum, f) => sum + f.deletions, 0);

  const result: DiffAnalysisResult = {
    ref,
    timestamp: Date.now(),
    files,
    risk,
    classification,
    summary: `${files.length} files changed (+${totalAdditions}/-${totalDeletions}), ${risk.overall} risk`,
    fileRisks,
    recommendedReviewers,
  };

  // Cache the result
  if (analysisCache.size >= ANALYSIS_CACHE_MAX_ENTRIES) {
    const oldestKey = analysisCache.keys().next().value;
    if (oldestKey !== undefined) analysisCache.delete(oldestKey);
  }
  analysisCache.set(ref, { result, timestamp: Date.now() });

  return result;
}

/**
 * Synchronous version of analyzeDiff for backward compatibility
 */
export function analyzeDiffSync(options: {
  ref?: string;
  useMonoVector?: boolean;
}): DiffAnalysisResult {
  const ref = options.ref || 'HEAD';

  // Check analysis cache
  const cached = analysisCache.get(ref);
  if (cached && Date.now() - cached.timestamp < ANALYSIS_CACHE_TTL_MS) {
    return cached.result;
  }

  const files = getGitDiffNumstat(ref);
  const fileRisks = files.map(assessFileRisk);
  const risk = assessOverallRisk(files, fileRisks);
  const classification = classifyDiff(files);
  const recommendedReviewers = suggestReviewers(files, fileRisks);

  const totalAdditions = files.reduce((sum, f) => sum + f.additions, 0);
  const totalDeletions = files.reduce((sum, f) => sum + f.deletions, 0);

  const result: DiffAnalysisResult = {
    ref,
    timestamp: Date.now(),
    files,
    risk,
    classification,
    summary: `${files.length} files changed (+${totalAdditions}/-${totalDeletions}), ${risk.overall} risk`,
    fileRisks,
    recommendedReviewers,
  };

  if (analysisCache.size >= ANALYSIS_CACHE_MAX_ENTRIES) {
    const oldestKey = analysisCache.keys().next().value;
    if (oldestKey !== undefined) analysisCache.delete(oldestKey);
  }
  analysisCache.set(ref, { result, timestamp: Date.now() });
  return result;
}

/**
 * Clear all diff-related caches
 */
export function clearAllDiffCaches(): void {
  diffCache.clear();
  analysisCache.clear();
  classifierInstance?.clearCache();
}
