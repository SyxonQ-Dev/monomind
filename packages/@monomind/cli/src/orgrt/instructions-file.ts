// packages/@monomind/cli/src/orgrt/instructions-file.ts
/**
 * #502 review: a role's (or loadout's) `instructions_file` is read by the
 * daemon — outside every role sandbox — and pasted into the role's prompt.
 * Pointed at the operator key, the dashboard secret or `~/.ssh`, it would
 * hand the role their contents. The path is signed now (org-signature.ts),
 * and independently it must resolve, through every symlink, to a file
 * inside the project, and not to anything a role may not read.
 */

import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { authorityDirs } from './authority-mask.js';
import { HOME_DENY_READ, isDashboardCredential } from './file-roots.js';
import { isWithin, realPath } from './policy-paths.js';

/** The real path to read, or `{ refused }` with why. `root` is the project
 *  (org root) a relative path resolves against. */
export function resolveInstructionsFile(
  file: string,
  root: string,
  opts: { home?: string; env?: NodeJS.ProcessEnv } = {},
): { path: string; refused?: undefined } | { path?: undefined; refused: string } {
  const home = opts.home ?? homedir();
  const env = opts.env ?? process.env;
  const lexical = isAbsolute(file) ? file : resolve(root, file);
  const real = realPath(lexical);
  const realRoot = realPath(root);
  if (!isWithin(realRoot, real))
    return {
      refused: `instructions_file ${file} resolves to ${real}, outside the project ${realRoot}`,
    };
  const denied = [...authorityDirs(home, env), ...HOME_DENY_READ.map((p) => join(home, p))].find(
    (d) => isWithin(realPath(d), real),
  );
  if (denied) return { refused: `instructions_file ${file} resolves inside ${denied}` };
  if (isDashboardCredential(real))
    return { refused: `instructions_file ${file} is a dashboard credential` };
  return { path: real };
}
