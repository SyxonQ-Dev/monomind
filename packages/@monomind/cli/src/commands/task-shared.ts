import { output } from '../output.js';

// Input length caps
export const MAX_TASK_ID_LEN = 128;
export const MAX_DESCRIPTION_LEN = 4_000;
export const MAX_REASON_LEN = 512;
export const MAX_TAGS = 20;
export const MAX_TAG_LEN = 64;
export const MAX_DEPS = 50;
export const MAX_DEP_LEN = 128;
export const MAX_ASSIGN_LEN = 128;
export const MAX_LIMIT = 1_000;

// Task types
export const TASK_TYPES = [
  { value: 'implementation', label: 'Implementation', hint: 'Feature implementation' },
  { value: 'bug-fix', label: 'Bug Fix', hint: 'Fix a bug or issue' },
  { value: 'refactoring', label: 'Refactoring', hint: 'Code refactoring' },
  { value: 'testing', label: 'Testing', hint: 'Write or update tests' },
  { value: 'documentation', label: 'Documentation', hint: 'Documentation updates' },
  { value: 'research', label: 'Research', hint: 'Research and analysis' },
  { value: 'review', label: 'Review', hint: 'Code review' },
  { value: 'optimization', label: 'Optimization', hint: 'Performance optimization' },
  { value: 'security', label: 'Security', hint: 'Security audit or fix' },
  { value: 'custom', label: 'Custom', hint: 'Custom task type' },
];

// Task priorities
export const TASK_PRIORITIES = [
  { value: 'critical', label: 'Critical', hint: 'Highest priority' },
  { value: 'high', label: 'High', hint: 'Important task' },
  { value: 'normal', label: 'Normal', hint: 'Standard priority' },
  { value: 'low', label: 'Low', hint: 'Lower priority' },
];

// Format task status with color
export function formatStatus(status: string): string {
  switch (status) {
    case 'completed':
      return output.success(status);
    case 'running':
    case 'in_progress':
      return output.info(status);
    case 'pending':
    case 'queued':
      return output.warning(status);
    case 'failed':
    case 'cancelled':
      return output.error(status);
    default:
      return status;
  }
}

// Format priority with color
export function formatPriority(priority: string): string {
  switch (priority) {
    case 'critical':
      return output.error(priority);
    case 'high':
      return output.warning(priority);
    case 'normal':
      return priority;
    case 'low':
      return output.dim(priority);
    default:
      return priority;
  }
}
