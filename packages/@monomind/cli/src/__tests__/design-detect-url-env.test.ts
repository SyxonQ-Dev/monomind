/**
 * #518 review: when no browser is installed and Chrome cannot be fetched,
 * `design detect <url> --json` warns on stderr, so stdout stays the JSON
 * document.
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('@monoes/monobrowse', () => ({
  findChrome: () => {
    throw new Error('No supported browser found.');
  },
}));
vi.mock('../browser/managed-chrome.js', () => ({
  ensureManagedChrome: async () => {
    throw new Error('MONOMIND_NO_AUTO_INSTALL is set');
  },
}));

const { output } = await import('../output.js');
const { urlScanEnv } = await import('../commands/design-detect.js');

describe('design detect URL scan without a browser', () => {
  it('writes the fallback warning to stderr, not stdout', async () => {
    const out = vi.spyOn(output, 'writeln').mockImplementation(() => {});
    const err = vi.spyOn(output, 'writeErrorln').mockImplementation(() => {});
    await expect(urlScanEnv()).resolves.toBeUndefined();
    expect(out).not.toHaveBeenCalled();
    expect(err.mock.calls.join('\n')).toMatch(/MONOMIND_NO_AUTO_INSTALL is set/);
  });
});
