/**
 * V1 Init System Types — init result shapes.
 * File-size sweep: split out of types.ts.
 */

import type { ProjectIndexCounts } from './project-indexes.js';
import type { PlatformInfo } from './types-platform.js';

/**
 * Init result
 */
export interface InitMemoryResult {
  status: 'created' | 'existing' | 'failed';
  dbPath: string;
  error?: string;
}

export interface InitResult {
  success: boolean;
  platform: PlatformInfo;
  created: {
    directories: string[];
    files: string[];
  };
  updated: string[];
  skipped: string[];
  /** Entries retired (moved to `.monomind/backups/…`) because this version
   *  no longer ships them — o-38. Never `created.files`: a destructive
   *  action reported inside a "created" total is how the original bug went
   *  unnoticed. */
  removed: string[];
  errors: string[];
  /** Shipped files kept because the user edited them; the new version was
   *  written beside each as `<file>.monomind-new` (see file-guard.ts). */
  kept?: string[];
  /** Things the user must be told even though the run succeeded. */
  warnings?: string[];
  /** Memory database setup outcome; absent when it was not attempted. */
  memory?: InitMemoryResult;
  /** Agent registry and skill index counts (see init/project-indexes.ts). */
  indexes?: ProjectIndexCounts;
  summary: {
    skillsCount: number;
    commandsCount: number;
    agentsCount: number;
    hooksEnabled: number;
  };
}
