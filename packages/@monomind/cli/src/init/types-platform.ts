/**
 * V1 Init System Types — platform detection.
 * File-size sweep: split out of types.ts.
 */

import os from 'node:os';
import path from 'node:path';

/**
 * Detected platform information
 */
export interface PlatformInfo {
  /** Operating system */
  os: 'windows' | 'darwin' | 'linux';
  /** Architecture */
  arch: 'x64' | 'arm64' | 'arm' | 'ia32';
  /** Node.js version */
  nodeVersion: string;
  /** Shell type */
  shell: 'powershell' | 'cmd' | 'bash' | 'zsh' | 'sh';
  /** Home directory */
  homeDir: string;
  /** Config directory (platform-specific) */
  configDir: string;
}

/**
 * Detect current platform
 */
export function detectPlatform(): PlatformInfo {
  const platform = os.platform();
  const arch = os.arch();
  const homeDir = os.homedir();

  let osType: 'windows' | 'darwin' | 'linux';
  let shell: 'powershell' | 'cmd' | 'bash' | 'zsh' | 'sh';
  let configDir: string;

  switch (platform) {
    case 'win32':
      osType = 'windows';
      shell = process.env.PSModulePath ? 'powershell' : 'cmd';
      configDir = process.env.APPDATA || path.join(homeDir, 'AppData', 'Roaming');
      break;
    case 'darwin':
      osType = 'darwin';
      shell = process.env.SHELL?.includes('zsh') ? 'zsh' : 'bash';
      configDir = path.join(homeDir, 'Library', 'Application Support');
      break;
    default:
      osType = 'linux';
      shell = process.env.SHELL?.includes('zsh')
        ? 'zsh'
        : process.env.SHELL?.includes('bash')
          ? 'bash'
          : 'sh';
      configDir = process.env.XDG_CONFIG_HOME || path.join(homeDir, '.config');
  }

  return {
    os: osType,
    arch: arch as PlatformInfo['arch'],
    nodeVersion: process.version,
    shell,
    homeDir,
    configDir,
  };
}
