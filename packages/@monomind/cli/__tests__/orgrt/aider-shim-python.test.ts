/**
 * Runs the aider shim's own Python tests (aider/test_monomind_aider_shim.py)
 * with aider's interpreter — found the way the runner finds it
 * (MONOMIND_AIDER_PYTHON, else the `aider` entry point's shebang, else uv's
 * tool dir). Skipped when aider is not installed. Among them: a
 * model-suggested shell command runs under full access and not under
 * scoped access (monoes/monomind#383 acceptance).
 */
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { resolveAiderPython } from '../../src/orgrt/aider-runner-resolve.js';

const python = resolveAiderPython(process.env.AIDER_CLI_BIN || 'aider', process.env);
const testsDir = join(dirname(fileURLToPath(import.meta.url)), 'aider');

describe.skipIf(!python)('aider shim (Python, aider’s own interpreter)', () => {
  it('passes its unittest suite', () => {
    const p = spawnSync(
      python as string,
      ['-m', 'unittest', 'discover', '-s', testsDir, '-p', 'test_*.py'],
      { encoding: 'utf8', timeout: 300_000, env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' } },
    );
    expect(p.status, p.stderr.slice(-3000)).toBe(0);
    expect(p.stderr).toMatch(/\nOK/);
  }, 320_000);
});
