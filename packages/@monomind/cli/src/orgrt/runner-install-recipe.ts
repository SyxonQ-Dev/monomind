// packages/@monomind/cli/src/orgrt/runner-install-recipe.ts
// Split out of runner-registry.ts (file-size rule); re-exported from there.

/**
 * An install hint a caller can run without a shell: global npm packages, or
 * a vendor's https install script piped to bash/sh. Anything else — prose,
 * extra shell syntax, a plain `npm install` — is `manual`.
 */
export type InstallRecipe =
  | { kind: 'npm'; packages: string[] }
  | { kind: 'script'; url: string; shell: 'bash' | 'sh' }
  | { kind: 'manual' };

// A version part is a tag or an exact/caret/tilde version — never a range
// operator, wildcard or anything starting with `-`.
const NPM_PACKAGE = /^(@[a-z0-9][\w.-]*\/)?[a-z0-9][\w.-]*(@[0-9A-Za-z.^~][0-9A-Za-z.^~-]*)?$/;
const CURL_INSTALL = /^curl[ \t]+-fsSL[ \t]+(\S+)[ \t]*\|[ \t]*(bash|sh)$/;
// A conservative URL charset: no quoting, substitution, separators or credentials.
const SCRIPT_URL = /^https:\/\/[a-z0-9.-]+(\/[A-Za-z0-9._~/-]*)?$/;

function isScriptUrl(url: string): boolean {
  if (!SCRIPT_URL.test(url)) return false;
  try {
    const u = new URL(url);
    return u.protocol === 'https:' && !u.username && !u.password;
  } catch {
    return false;
  }
}

export function installRecipe(hint: string): InstallRecipe {
  const text = hint.trim();
  // A hint is one line of space-separated words.
  if (/[^\S \t]/.test(text)) return { kind: 'manual' };
  const words = text.split(/[ \t]+/);
  if (
    words.length >= 4 &&
    words[0] === 'npm' &&
    words[1] === 'install' &&
    (words[2] === '-g' || words[2] === '--global')
  ) {
    const packages = words.slice(3);
    return packages.every((p) => NPM_PACKAGE.test(p))
      ? { kind: 'npm', packages }
      : { kind: 'manual' };
  }
  const m = CURL_INSTALL.exec(text);
  if (m && isScriptUrl(m[1])) return { kind: 'script', url: m[1], shell: m[2] as 'bash' | 'sh' };
  return { kind: 'manual' };
}
