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
  autoInstallDisabled,
  type EnsureOptions,
  ensureOptionalDependency,
  OPTIONAL_DEPENDENCIES,
  type OptionalDependencyName,
} from '../utils/optional-deps.js';

// Install failures this session, rethrown instead of installing again.
const failedInstalls = new Map<string, unknown>();

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
 * @returns The imported module, or null for a missing package that is not on
 *   the allow-list
 * @throws {OptionalDependencyError} when an allow-listed package cannot be
 *   loaded or installed; its message says how to install it by hand
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

  if (failedInstalls.has(packageName)) throw failedInstalls.get(packageName);

  try {
    return await ensureOptionalDependency<T>(packageName, {
      ...ensureOptions,
      log: silent ? () => {} : ensureOptions.log,
    });
  } catch (error) {
    // With auto-install off nothing was attempted; the next call re-checks.
    if (!autoInstallDisabled(ensureOptions.env)) failedInstalls.set(packageName, error);
    throw error;
  }
}

/**
 * Reset install attempts (useful for testing)
 */
export function resetInstallAttempts(): void {
  failedInstalls.clear();
}
