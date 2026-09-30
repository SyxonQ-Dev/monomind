/**
 * Auto-install utility for optional MCP tool dependencies
 *
 * When an MCP tool requires an optional package that isn't installed, this
 * loads it through ensureOptionalDependency (utils/optional-deps.ts), which
 * installs it once into ~/.monomind/deps at the version pinned there and
 * never touches the user's project (#519). Only packages on that allow-list
 * are installed; anything else is imported if present and otherwise skipped.
 */

import {
  type EnsureOptions,
  ensureOptionalDependency,
  OPTIONAL_DEPENDENCIES,
  type OptionalDependencyName,
} from '../utils/optional-deps.js';

// Packages whose install failed this session; they are not retried.
const failedInstalls = new Set<string>();

export interface AutoInstallOptions extends EnsureOptions {
  /**
   * Silent install (no console output)
   */
  silent?: boolean;
}

function isInstallable(name: string): name is OptionalDependencyName {
  return Object.hasOwn(OPTIONAL_DEPENDENCIES, name);
}

/**
 * Import a package, installing it into monomind's deps directory first if it
 * is an allow-listed optional dependency that is missing. The module comes
 * from wherever it was resolved, so callers must use the returned module
 * rather than importing the package by name.
 *
 * @param packageName - npm package name
 * @param options - Installation options
 * @returns The imported module or null if unavailable
 */
export async function tryImportOrInstall<T = unknown>(
  packageName: string,
  options: AutoInstallOptions = {},
): Promise<T | null> {
  const { silent = false, ...ensureOptions } = options;

  if (!isInstallable(packageName)) {
    try {
      return (await import(packageName)) as T;
    } catch {
      return null;
    }
  }

  if (failedInstalls.has(packageName)) return null;

  try {
    return await ensureOptionalDependency<T>(packageName, {
      ...ensureOptions,
      log: silent ? () => {} : ensureOptions.log,
    });
  } catch (error) {
    failedInstalls.add(packageName);
    if (!silent) {
      console.error(`[monomind] ${packageName} is not available: ${(error as Error).message}`);
    }
    return null;
  }
}

/**
 * Check if a package is available without installing
 */
export async function isPackageAvailable(packageName: string): Promise<boolean> {
  try {
    await import(packageName);
    return true;
  } catch {
    return false;
  }
}

/**
 * Reset install attempts (useful for testing)
 */
export function resetInstallAttempts(): void {
  failedInstalls.clear();
}

/**
 * Optional package dependencies and their purposes
 */
export const OPTIONAL_PACKAGES = {
  'monofence-ai': {
    description: 'AI manipulation defense (prompt injection, PII detection)',
    tools: ['aidefence_scan', 'aidefence_analyze', 'aidefence_stats', 'aidefence_learn'],
  },
  'onnxruntime-node': {
    description: 'ONNX runtime for neural network inference',
    tools: ['neural_*'],
  },
} as const;

export default {
  tryImportOrInstall,
  isPackageAvailable,
  resetInstallAttempts,
  OPTIONAL_PACKAGES,
};
