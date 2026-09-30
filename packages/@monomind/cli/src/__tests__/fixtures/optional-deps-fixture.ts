/** Fakes for the first-use installer tests (optional-deps*.test.ts). */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { type NpmRunner, OPTIONAL_DEPENDENCIES } from '../../utils/optional-deps.js';

export const SDK = '@anthropic-ai/claude-agent-sdk';
export const VERSION = OPTIONAL_DEPENDENCIES[SDK].version;
export const HOST = { platform: 'linux' as const, arch: 'x64' };

export const notFound = (name: string): never => {
  throw Object.assign(new Error(`Cannot find package '${name}' imported from /x`), {
    code: 'MODULE_NOT_FOUND',
  });
};

/** Writes a minimal ESM SDK exporting `marker` under `prefix`, with the
 *  linux-x64 platform package unless `platform` is false. Returns the entry. */
export function writeFakeSdk(
  prefix: string,
  marker: string,
  { version = VERSION, platform = true }: { version?: string; platform?: boolean } = {},
): string {
  const dir = join(prefix, 'node_modules', SDK);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'package.json'),
    JSON.stringify({ name: SDK, version, type: 'module', exports: './index.js' }),
  );
  writeFileSync(join(dir, 'index.js'), `export const marker = ${JSON.stringify(marker)};\n`);
  if (platform) {
    const plat = join(prefix, 'node_modules', '@anthropic-ai', 'claude-agent-sdk-linux-x64');
    mkdirSync(plat, { recursive: true });
    writeFileSync(
      join(plat, 'package.json'),
      JSON.stringify({ name: `${SDK}-linux-x64`, version, os: ['linux'], cpu: ['x64'] }),
    );
    writeFileSync(join(plat, 'claude'), '#!/bin/sh\n', { mode: 0o755 });
  }
  return join(dir, 'index.js');
}

/** A stand-in for npm: records its calls and "installs" the fake SDK into
 *  the prefix it was given. */
export function fakeNpm(marker: string, delayMs = 0) {
  const calls: Array<{ args: string[]; cwd: string }> = [];
  const run: NpmRunner = async (args, cwd) => {
    calls.push({ args, cwd });
    if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
    const prefix = args.find((a) => a.startsWith('--prefix='))?.slice('--prefix='.length) as string;
    writeFakeSdk(prefix, marker);
  };
  return { run, calls };
}
