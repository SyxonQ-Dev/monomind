/**
 * Cross-platform npm invocation.
 *
 * On Windows, `npm` is a `.cmd` shim, and Node refuses to spawn a `.cmd` or
 * `.bat` file without `shell: true` (EINVAL since 18.20.2 / 20.12.2,
 * CVE-2024-27980). We avoid `shell: true` everywhere (injection risk), so on
 * win32 npm's JavaScript entry point is run with this Node instead
 * (GitHub issues #84, #521). Elsewhere `npm` itself is spawned.
 */
import { existsSync } from 'node:fs';
import { win32 } from 'node:path';

interface NpmHost {
  platform: NodeJS.Platform;
  execPath: string;
  env: NodeJS.ProcessEnv;
  exists: (p: string) => boolean;
}

const currentHost = (): NpmHost => ({
  platform: process.platform,
  execPath: process.execPath,
  env: process.env,
  exists: existsSync,
});

/** npm's `bin/npm-cli.js` on Windows: the one npm itself reports when this
 *  process runs under npm (`npm_execpath`), else the copy installed next to
 *  node.exe, which is where the Windows Node installer puts it. */
export function windowsNpmCli(host: NpmHost = currentHost()): string | undefined {
  const fromEnv = host.env.npm_execpath;
  if (fromEnv && /npm-cli\.js$/i.test(fromEnv) && host.exists(fromEnv)) return fromEnv;
  const besideNode = win32.join(
    win32.dirname(host.execPath),
    'node_modules',
    'npm',
    'bin',
    'npm-cli.js',
  );
  return host.exists(besideNode) ? besideNode : undefined;
}

/** `[command, args]` that runs `npm <args>` without a shell. */
export function npmInvocation(args: string[], host: NpmHost = currentHost()): [string, string[]] {
  if (host.platform !== 'win32') return ['npm', args];
  const cli = windowsNpmCli(host);
  if (!cli) {
    throw new Error(
      `npm's npm-cli.js was not found next to ${host.execPath}; ` +
        'run this from an npm script or install npm alongside Node.',
    );
  }
  return [host.execPath, [cli, ...args]];
}
