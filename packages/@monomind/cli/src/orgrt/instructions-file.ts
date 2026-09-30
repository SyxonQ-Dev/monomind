// packages/@monomind/cli/src/orgrt/instructions-file.ts
/**
 * #502 review: a role's (or loadout's) `instructions_file` is read by the
 * daemon — outside every role sandbox — and pasted into the role's prompt.
 * Pointed at the operator key, the dashboard secret or `~/.ssh`, it would
 * hand the role their contents.
 *
 * - The path is signed (org-signature.ts), and so is a digest of the file's
 *   content: the definition stops verifying when a role edits the file, and
 *   the daemon compares the content it reads for each session with the
 *   digest it verified at start (so an edit mid-run is not read either).
 * - The path must resolve, through every symlink, to a file inside the
 *   project and not to anything a role may not read.
 * - Reading closes the check-then-read race: the file is opened with
 *   O_NOFOLLOW, the opened descriptor must be the very inode that was
 *   checked (dev/ino), it may have no other hard link, on Linux its
 *   /proc/self/fd path is checked again, and the text comes from that fd.
 */

import { createHash } from 'node:crypto';
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  realpathSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { authorityDirs } from './authority-mask.js';
import { HOME_DENY_READ, isDashboardCredential } from './file-roots.js';
import { isWithin, realPath } from './policy-paths.js';

type Opts = { home?: string; env?: NodeJS.ProcessEnv };

function refusedAt(real: string, file: string, root: string, opts: Opts): string | undefined {
  const home = opts.home ?? homedir();
  const env = opts.env ?? process.env;
  const realRoot = realPath(root);
  if (!isWithin(realRoot, real))
    return `instructions_file ${file} resolves to ${real}, outside the project ${realRoot}`;
  const denied = [...authorityDirs(home, env), ...HOME_DENY_READ.map((p) => join(home, p))].find(
    (d) => isWithin(realPath(d), real),
  );
  if (denied) return `instructions_file ${file} resolves inside ${denied}`;
  if (isDashboardCredential(real)) return `instructions_file ${file} is a dashboard credential`;
  return undefined;
}

/** The real path to read, or `{ refused }` with why. `root` is the project
 *  (org root) a relative path resolves against. */
export function resolveInstructionsFile(
  file: string,
  root: string,
  opts: Opts = {},
): { path: string; refused?: undefined } | { path?: undefined; refused: string } {
  const lexical = isAbsolute(file) ? file : resolve(root, file);
  const real = realPath(lexical);
  const refused = refusedAt(real, file, root, opts);
  return refused ? { refused } : { path: real };
}

/** Read the file safely (see the module doc): its text, or why not. */
export function readInstructionsFile(
  file: string,
  root: string,
  opts: Opts = {},
): { text: string; refused?: undefined } | { text?: undefined; refused: string } {
  const resolved = resolveInstructionsFile(file, root, opts);
  if (resolved.path === undefined) return { refused: resolved.refused };
  let checked: ReturnType<typeof lstatSync>;
  try {
    checked = lstatSync(resolved.path);
  } catch (err) {
    return { refused: `instructions_file ${file} is unreadable (${(err as Error).message})` };
  }
  if (!checked.isFile()) return { refused: `instructions_file ${file} is not a regular file` };
  let fd: number;
  try {
    fd = openSync(resolved.path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  } catch (err) {
    return { refused: `instructions_file ${file} could not be opened (${(err as Error).message})` };
  }
  try {
    const st = fstatSync(fd);
    if (st.dev !== checked.dev || st.ino !== checked.ino)
      return { refused: `instructions_file ${file} was replaced while it was being opened` };
    if (!st.isFile()) return { refused: `instructions_file ${file} is not a regular file` };
    if (st.nlink > 1) return { refused: `instructions_file ${file} has other hard links` };
    if (process.platform === 'linux') {
      let viaFd: string;
      try {
        viaFd = realpathSync(`/proc/self/fd/${fd}`);
      } catch {
        viaFd = resolved.path;
      }
      const again = refusedAt(viaFd, file, root, opts);
      if (again) return { refused: again };
    }
    return { text: readFileSync(fd, 'utf-8') };
  } finally {
    closeSync(fd);
  }
}

/** What an instructions file contributes to the signature: the digest of
 *  its content, or why it can't be read (which is then signed as is). */
export function instructionsDigest(file: string, root: string, opts: Opts = {}): string {
  const read = readInstructionsFile(file, root, opts);
  return read.text === undefined
    ? `unreadable: ${read.refused}`
    : `sha256:${createHash('sha256').update(read.text).digest('hex')}`;
}

/** The text of an instructions file whose digest must still be `expected`
 *  (the one verified at org start), or why it can't be used. */
export function readVerifiedInstructions(
  file: string,
  root: string,
  expected: string | undefined,
  opts: Opts = {},
): { text: string; refused?: undefined } | { text?: undefined; refused: string } {
  const read = readInstructionsFile(file, root, opts);
  if (read.text === undefined || expected === undefined) return read;
  const digest = `sha256:${createHash('sha256').update(read.text).digest('hex')}`;
  if (digest !== expected)
    return { refused: `instructions_file ${file} changed since the org's signature was verified` };
  return read;
}
