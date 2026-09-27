/**
 * PRODUCT.md field extraction for context.mjs: pulling the `## Register` and
 * `## Platform` section values out of the loaded PRODUCT.md body.
 *
 * Split out of context.mjs. See that file for context.
 */
import { escapeRegExp } from './context-utils.mjs';

/**
 * Read the first non-empty line under a bare `## <heading>` section of
 * PRODUCT.md (e.g. `## Register`, `## Platform`). Returns null when the
 * section is absent. The heading match is exact (`\s*$`) so near-miss
 * headings like `## Register guidelines` don't shadow the real field.
 */
export function extractSectionValue(product, heading) {
  if (!product) return null;
  const headingRe = new RegExp(`^##\\s+${escapeRegExp(heading)}\\s*$`, 'i');
  const lines = product.split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (headingRe.test(lines[i].trim())) {
      for (let j = i + 1; j < lines.length; j++) {
        const next = lines[j].trim();
        // A new heading before any value means the section is empty.
        if (/^#{1,6}\s/.test(next)) return null;
        if (next) return next;
      }
    }
  }
  return null;
}

/**
 * Pull the register (`brand` or `product`) out of PRODUCT.md by looking
 * for a `## Register` section and reading the first non-empty line that
 * follows it. Returns null when the file is legacy / register-less.
 */
export function extractRegister(product) {
  const word = (extractSectionValue(product, 'Register') || '').toLowerCase();
  return word === 'brand' || word === 'product' ? word : null;
}

/**
 * Pull the platform (`web`, `ios`, `android`, or `adaptive`) out of PRODUCT.md
 * by looking for a `## Platform` section and reading the first non-empty line
 * that follows it. `adaptive` is for cross-platform apps (Flutter, React
 * Native) that ship both iOS and Android from one codebase; a line that names
 * both targets (e.g. `ios, android`) is also read as `adaptive`. Returns null
 * when the file is legacy / platform-less, which the skill treats as `web`
 * (the default the general rules already assume).
 */
export function extractPlatform(product) {
  const value = (extractSectionValue(product, 'Platform') || '').toLowerCase();
  if (!value) return null;
  if (value === 'web' || value === 'ios' || value === 'android' || value === 'adaptive') return value;
  // A short list naming both native targets (`ios, android`, `ios and
  // android`) = adaptive. Only list separators and the two platform words may
  // appear; anything else (prose, negations) is unrecognized and falls
  // through to the CLI's WARNING path.
  const tokens = value.split(/[\s,+&/]+/).filter(t => t && t !== 'and');
  if (tokens.length >= 2 && tokens.every(t => t === 'ios' || t === 'android')
    && tokens.includes('ios') && tokens.includes('android')) {
    return 'adaptive';
  }
  return null;
}
