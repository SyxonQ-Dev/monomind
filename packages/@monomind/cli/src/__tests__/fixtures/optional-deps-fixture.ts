/** Fakes for the first-use installer tests (optional-deps*.test.ts). */
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { type NpmRunner, OPTIONAL_DEPENDENCIES } from '../../utils/optional-deps.js';
import type { CodePins } from '../../utils/optional-deps-locks.js';

export const SDK = '@anthropic-ai/claude-agent-sdk';
export const VERSION = OPTIONAL_DEPENDENCIES[SDK].version;
export const HOST = { platform: 'linux' as const, arch: 'x64', musl: false };

/** The fake's entry and binary never change (the marker lives beside the
 *  entry), so one set of pins fits every fake install. */
export const FAKE_ENTRY = "export { marker } from './marker.js';\n";
export const FAKE_BINARY = '#!/bin/sh\n';
const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
export const FAKE_PINS: Record<string, CodePins> = {
  [SDK]: {
    version: VERSION,
    entry: { file: 'sdk.mjs', sha256: sha256(FAKE_ENTRY) },
    binaries: { [`${SDK}-linux-x64`]: { file: 'claude', sha256: sha256(FAKE_BINARY) } },
  },
};

export const notFound = (name: string): never => {
  throw Object.assign(new Error(`Cannot find package '${name}' imported from /x`), {
    code: 'MODULE_NOT_FOUND',
  });
};

/** Writes a minimal ESM SDK exporting `marker` under `prefix`, with the
 *  linux-x64 platform package unless `platform` is false. Returns the entry,
 *  which (with the binary) matches FAKE_PINS. */
export function writeFakeSdk(
  prefix: string,
  marker: string,
  { version = VERSION, platform = true }: { version?: string; platform?: boolean } = {},
): string {
  const dir = join(prefix, 'node_modules', SDK);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'package.json'),
    JSON.stringify({ name: SDK, version, type: 'module', exports: './sdk.mjs' }),
  );
  writeFileSync(join(dir, 'sdk.mjs'), FAKE_ENTRY);
  writeFileSync(join(dir, 'marker.js'), `export const marker = ${JSON.stringify(marker)};\n`);
  if (platform) {
    const plat = join(prefix, 'node_modules', '@anthropic-ai', 'claude-agent-sdk-linux-x64');
    mkdirSync(plat, { recursive: true });
    writeFileSync(
      join(plat, 'package.json'),
      JSON.stringify({ name: `${SDK}-linux-x64`, version, os: ['linux'], cpu: ['x64'] }),
    );
    writeFileSync(join(plat, 'claude'), FAKE_BINARY, { mode: 0o755 });
  }
  return join(dir, 'sdk.mjs');
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
