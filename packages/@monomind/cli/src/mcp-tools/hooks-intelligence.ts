// Trajectory tools, pattern/stats tools, and model-routing tools live in
// sibling modules to keep each file readable; they are part of the same
// `hooks_intelligence_*` / `hooks_model-*` surface.

export {
  hooksModelOutcome,
  hooksModelRoute,
  hooksModelStats,
} from './hooks-intelligence-model.js';
export {
  hooksIntelligenceLearn,
  hooksIntelligenceStats,
  hooksPatternSearch,
  hooksPatternStore,
} from './hooks-intelligence-patterns.js';
export {
  hooksIntelligenceReset,
  hooksTrajectoryEnd,
  hooksTrajectoryStart,
  hooksTrajectoryStep,
} from './hooks-intelligence-trajectory.js';
