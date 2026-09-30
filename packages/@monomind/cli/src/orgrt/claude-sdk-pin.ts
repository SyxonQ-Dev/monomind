// packages/@monomind/cli/src/orgrt/claude-sdk-pin.ts
/**
 * #526 review: the SDK's own Claude binary, held to its pin at every spawn.
 *
 * ensureOptionalDependency() hashes the bundled binary once per process
 * (utils/optional-deps-verify.ts), but sdk.mjs resolves the binary again
 * on every query(). So the SDK's query is wrapped: it always passes the
 * verified path as `pathToClaudeCodeExecutable`, so the SDK never picks
 * another file, and checks with one stat that the file is still the one
 * that was hashed (same inode, size, mtime and ctime) before the query
 * starts and again right before a spawnClaudeCodeProcess hook runs.
 *
 * Not a copy: a verified copy in the operator dir would be invisible to
 * masked roles (the mask hides that dir), and anywhere else a role could
 * write it. The deps dir is read-only to roles in both sandboxes; the stat
 * check catches what an unsandboxed process changes there.
 *
 * An installed Claude Code (#522) is not this binary: a query that already
 * names another `pathToClaudeCodeExecutable` is passed through unchanged,
 * with no pin check, and #522's own code checks that binary.
 */
import type { Options, query as sdkQuery } from '@anthropic-ai/claude-agent-sdk';
import { assertStillVerified, verifiedBinary } from '../utils/optional-deps-verify.js';

const SDK = '@anthropic-ai/claude-agent-sdk';
type Query = typeof sdkQuery;

/** `query` pinned to the verified binary `bin` (see the module doc). */
export function pinnedQuery(query: Query, bin: { path: string; sha256: string }): Query {
  return ((params: Parameters<Query>[0]) => {
    // A binary the caller chose (#522's installed Claude Code) is not this
    // one: it is passed through untouched and has its own checks.
    const chosen = params.options?.pathToClaudeCodeExecutable;
    if (chosen && chosen !== bin.path) return query(params);
    assertStillVerified(bin.path, bin.sha256);
    const spawn = params.options?.spawnClaudeCodeProcess;
    const options: Options = {
      ...params.options,
      pathToClaudeCodeExecutable: bin.path,
      ...(spawn
        ? {
            spawnClaudeCodeProcess: (o: Parameters<typeof spawn>[0]) => {
              assertStillVerified(bin.path, bin.sha256);
              return spawn(o);
            },
          }
        : {}),
    };
    return query({ ...params, options });
  }) as Query;
}

/** The loaded SDK with its query pinned to the bundled binary it verified,
 *  when it verified one (not in tests that load a fake without pins). */
export function withPinnedExecutable<T extends { query: Query }>(
  sdk: T,
): T & { executable?: string } {
  const bin = verifiedBinary(SDK);
  if (!bin) return sdk;
  return { ...sdk, query: pinnedQuery(sdk.query, bin), executable: bin.path };
}
