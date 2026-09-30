// packages/@monomind/cli/src/mcp-pid-owner.ts
/**
 * #502 review: `~/.monomind/mcp.pid` names the process `mcp stop` (and a
 * forced `mcp start`) kills. Before killing it, check that the pid really is
 * a monomind MCP server — its argv holds `mcp start` and a monomind entry
 * point — so a planted or stale pid file cannot turn `mcp stop` into a kill
 * of an arbitrary process of the operator's.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

/** The process's argv, or undefined when it can't be read. */
export function processArgv(pid: number): string[] | undefined {
  if (!Number.isInteger(pid) || pid <= 0) return undefined;
  try {
    const raw = readFileSync(`/proc/${pid}/cmdline`, 'utf8');
    if (raw) return raw.split('\0').filter(Boolean);
  } catch {
    /* no procfs (macOS) or gone */
  }
  try {
    const out = execFileSync('ps', ['-p', String(pid), '-o', 'args='], {
      encoding: 'utf8',
      timeout: 1000,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return out ? out.split(/\s+/) : undefined;
  } catch {
    return undefined;
  }
}

export function isMonomindMcpServerArgv(argv: string[]): boolean {
  const i = argv.indexOf('mcp');
  return i >= 0 && argv[i + 1] === 'start' && argv.some((a) => /monomind/i.test(a));
}

/** True only when `pid`'s command line is a monomind MCP server's. */
export function isMonomindMcpServer(pid: number): boolean {
  const argv = processArgv(pid);
  return !!argv && isMonomindMcpServerArgv(argv);
}
