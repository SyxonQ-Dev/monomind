/**
 * CLAUDE.md generator support: stack-convention detection and optional
 * package availability used by the section generators.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { WORKER_COUNT } from './generated-counts.js';
import { _isOptionalPackageResolvable } from './shared.js';
import { detectProjectProfile } from './shared-instructions-generator.js';

/** Build/test/lint commands and layout for the stack actually in the repo. */
export interface StackConventions {
  build: string;
  test: string;
  lint: string;
  srcDir: string;
  testDir: string;
}

/** The placeholder `npm init` writes for `scripts.test` — always fails. */
const NPM_INIT_TEST_STUB = /no test specified/;

function readPackageScripts(targetDir: string): Record<string, string> {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(targetDir, 'package.json'), 'utf-8'));
    const scripts = pkg?.scripts;
    return scripts && typeof scripts === 'object' ? scripts : {};
  } catch {
    return {};
  }
}

/** True when `.monomind/capabilities.json` lists `name` as active. */
export function isCapabilityActive(targetDir: string, name: string): boolean {
  try {
    const caps = JSON.parse(
      fs.readFileSync(path.join(targetDir, '.monomind', 'capabilities.json'), 'utf-8'),
    );
    return Array.isArray(caps?.active) && caps.active.includes(name);
  } catch {
    return false;
  }
}

/**
 * The File Organization and Build & Test sections used to prescribe `/src`
 * and npm unconditionally, which is wrong in every non-Node repo — GH #278
 * hit a Go project that got told to run `npm run build`. Reuse init's own
 * project detection, the same one that already labels
 * `.agents/shared_instructions.md` with "Stack: Go", instead of guessing.
 * A directory that isn't there is dropped rather than invented.
 */
export function detectStackConventions(targetDir: string): StackConventions {
  const profile = detectProjectProfile(targetDir);
  const layout = { srcDir: profile.srcDir, testDir: profile.testDir };
  switch (profile.language) {
    case 'go':
      return { build: 'go build ./...', test: 'go test ./...', lint: 'go vet ./...', ...layout };
    case 'rust':
      return { build: 'cargo build', test: 'cargo test', lint: 'cargo clippy', ...layout };
    case 'python':
      return { build: '', test: 'pytest', lint: 'ruff check .', ...layout };
    default: {
      const run =
        profile.packageManager === 'pnpm'
          ? 'pnpm'
          : profile.packageManager === 'yarn'
            ? 'yarn'
            : profile.packageManager === 'bun'
              ? 'bun'
              : 'npm';
      // GH #412: only name scripts package.json actually defines — `npm run
      // lint` in a project without a lint script is a command that fails.
      const scripts = readPackageScripts(targetDir);
      return {
        build: scripts.build ? `${run} run build` : '',
        test: scripts.test && !NPM_INIT_TEST_STUB.test(scripts.test) ? `${run} test` : '',
        lint: scripts.lint ? `${run} run lint` : '',
        ...layout,
      };
    }
  }
}

// --- Optional package availability (P1-23) ---
// The docs below advertise features backed by optionalDependencies (npm may
// silently skip installing these), so the generated CLAUDE.md can say
// "(unavailable in this install)" instead of presenting an unresolvable
// package's features as unconditionally working. Resolution goes through
// _isOptionalPackageResolvable (shared.ts) — the one resolver for this
// question; write-capabilities.ts uses the same helper directly.
export interface OptionalPackageAvailability {
  hooks: boolean;
  mcp: boolean;
  routing: boolean;
  monofence: boolean;
}
let _availabilityCache: OptionalPackageAvailability | null = null;
/** Test-only: `_availabilityCache` is module-level, so tests asserting both
 * the resolvable and unresolvable branches must clear it between cases. */
export function _resetOptionalPackageCache(): void {
  _availabilityCache = null;
}
export function detectOptionalPackages(): OptionalPackageAvailability {
  if (_availabilityCache) return _availabilityCache;
  _availabilityCache = {
    hooks: _isOptionalPackageResolvable('@monoes/hooks'),
    mcp: _isOptionalPackageResolvable('@monoes/mcp'),
    routing: _isOptionalPackageResolvable('@monoes/routing'),
    monofence: _isOptionalPackageResolvable('monofence-ai'),
  };
  return _availabilityCache;
}
export function unavailNote(available: boolean): string {
  return available ? '' : ' _(unavailable in this install)_';
}

// WORKER_COUNT (generated-counts.ts) is a build-time constant, computed
// from source regardless of whether @monoes/hooks resolves at `init` time —
// but printing it when the package is NOT resolvable would claim a count of
// workers that cannot actually run in this install, the same class of lie
// as a wrong number. Shown only when the package is genuinely available.
export function workerCountLabel(hooksAvailable: boolean): string {
  return hooksAvailable ? `${WORKER_COUNT} ` : '';
}
