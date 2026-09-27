/**
 * kimi-code Tier 1 frontmatter converters (.claude/* → .kimi-code/*).
 * File-size sweep: split out of kimi-generator.ts.
 *
 * Same minimal-transform approach as opencode-generator.ts: only ensure the
 * keys kimi actually reads are present and correct; everything else passes
 * through (kimi ignores unknown frontmatter fields on agents).
 */

interface SplitMd {
  fm: string; // raw frontmatter body (between the --- fences), no fences
  body: string; // markdown body after the closing fence
  hasFm: boolean;
}

function splitFrontmatter(src: string): SplitMd {
  const m = src.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!m) return { fm: '', body: src, hasFm: false };
  return { fm: m[1], body: m[2], hasFm: true };
}

/** Insert a top-level scalar `key: value` into a frontmatter block if absent. */
function ensureFmKey(fm: string, key: string, value: string): string {
  const re = new RegExp(`^${key}\\s*:`, 'm');
  if (re.test(fm)) return fm;
  const line = `${key}: ${value}`;
  if (!fm.trim()) return line;
  // When description is a YAML block scalar (`description: |` / `>`), its
  // value continues on the following indented lines — skip past all of
  // them so the new key lands after the block instead of inside it
  // (inserting mid-block corrupts both the description and the new key's
  // parsed value).
  const descIdx = fm.search(/^description\s*:/m);
  if (descIdx >= 0) {
    const lines = fm.split('\n');
    const descLineIdx = fm.slice(0, descIdx).split('\n').length - 1;
    const descValue = lines[descLineIdx].slice(lines[descLineIdx].indexOf(':') + 1).trim();
    let insertAfter = descLineIdx;
    if (/^[|>][+-]?\d*$/.test(descValue)) {
      while (insertAfter + 1 < lines.length && /^(\s|$)/.test(lines[insertAfter + 1])) {
        insertAfter++;
      }
    }
    lines.splice(insertAfter + 1, 0, line);
    return lines.join('\n');
  }
  return `${line}\n${fm}`;
}

/** Set (replace-or-insert) a top-level scalar `key: value`. */
function setFmKey(fm: string, key: string, value: string): string {
  const re = new RegExp(`^${key}\\s*:.*$`, 'm');
  if (re.test(fm)) return fm.replace(re, `${key}: ${value}`);
  return ensureFmKey(fm, key, value);
}

/** Kebab-case slug — kimi REQUIRES agent names in kebab-case and skips the
 *  file with a warning otherwise. Also guarantees a filesystem-safe filename. */
function slugifyName(name: string): string {
  const s = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return s || 'agent';
}

/** Default category write-kimicode.ts assigns to any source command that
 *  sits directly in `.claude/commands/` with no subdirectory:
 *  `segs.length > 1 ? segs[0] : 'monomind'`. */
const DEFAULT_CATEGORY = 'monomind';

/**
 * Join a category and base name into a slug without re-stacking the default
 * 'monomind' prefix onto a name that already carries it.
 *
 * Only guards the DEFAULT_CATEGORY case. On a repeat `--force` init run
 * against a project whose `.claude/commands/` already contains a flat,
 * previously-namespaced file — e.g. from an older generator version, or
 * before this fix shipped — `base` IS that already-prefixed name, and
 * blindly re-joining stacked another "monomind-" on top every single run
 * (observed live: "monomind-truth-start" -> "monomind-monomind-truth-start"
 * -> "monomind-monomind-monomind-truth-start" ...). Used for both the
 * plugin command filename (kimiCommandFilename) and the flow-skill's own
 * `name:` field (convertKimiCommandToFlowSkill) — both must stay in sync
 * since a mismatch resurrects the "conflicts with a real skill" skip path.
 *
 * A real, non-default category (e.g. 'github') is deliberately left alone
 * even when `base` happens to start with that same word (e.g. 'github-modes'
 * under a `github/` subdirectory) — that's a legitimate nested-command name,
 * not an instance of the confirmed default-category compounding bug.
 */
function namespacedSlug(category: string, base: string): string {
  const slugCategory = slugifyName(category);
  const slugBase = slugifyName(base);
  if (
    slugCategory === DEFAULT_CATEGORY &&
    (slugBase === slugCategory || slugBase.startsWith(`${slugCategory}-`))
  ) {
    return slugBase;
  }
  return slugifyName(`${category}-${base}`);
}

function getFmScalar(fm: string, key: string): string | null {
  const m = fm.match(new RegExp(`^${key}\\s*:\\s*(.+?)\\s*$`, 'm'));
  return m ? m[1].replace(/^["']|["']$/g, '') : null;
}

/**
 * Convert a Claude agent definition to kimi agent format.
 * - name is slugified to kebab-case (hard requirement — kimi skips the file otherwise).
 * - description is ensured (kimi shows it to the main agent for delegation).
 * - Everything else passes through: kimi ignores Claude-only keys (model, etc.)
 *   and accepts comma-separated tools: strings.
 */
export function convertKimiAgentMd(src: string, fallbackName: string): string {
  const { fm, body, hasFm } = splitFrontmatter(src);
  const rawName = (getFmScalar(fm, 'name') || fallbackName).trim();
  const name = slugifyName(rawName);
  let out = fm;
  out = setFmKey(out, 'name', name);
  if (!getFmScalar(out, 'description')) {
    out = ensureFmKey(out, 'description', `${name} agent (monomind)`);
  }
  if (hasFm || fm) {
    return `---\n${out}\n---\n${body}`;
  }
  return `---\nname: ${name}\ndescription: ${name} agent (monomind)\n---\n${body}`;
}

/**
 * Convert a SKILL.md. Both Claude and kimi use directory-form SKILL.md with
 * required name + description — this only guarantees those two keys.
 */
export function convertKimiSkillMd(src: string, fallbackName: string): string {
  const { fm, body, hasFm } = splitFrontmatter(src);
  const name = slugifyName((getFmScalar(fm, 'name') || fallbackName).trim());
  let out = fm;
  out = setFmKey(out, 'name', name);
  if (!getFmScalar(out, 'description')) {
    out = ensureFmKey(out, 'description', `${name} skill (monomind)`);
  }
  if (hasFm || fm) {
    return `---\n${out}\n---\n${body}`;
  }
  return `---\nname: ${name}\ndescription: ${name} skill (monomind)\n---\n${body}`;
}

/**
 * True when a Claude command's body carries the catalog-style router shape
 * tests/repo/mastermind-router-consistency.test.ts forbids under any
 * `skills/` tree: a markdown table whose header row has both an "Intent"
 * cell and a "primary route" cell (same detection that test's
 * `hasCatalogRouterTable` uses). `.claude/commands/mastermind.md` — the
 * universal intent router — is written in exactly this shape and is shipped
 * ONLY as a plugin command (`.kimi-code/plugin/commands/monomind-mastermind.md`),
 * never as a skill; the canonical skill-tool router lives at
 * `.claude/skills/mastermind/SKILL.md` and is mirrored separately. kimi is
 * the only target that converts commands into skills at all (no other
 * platform mirrors `.claude/commands/` into a `skills/` tree), so it's the
 * only place a command with this shape can leak a second, contradicting
 * router into `skills/` — see write-kimicode.ts's flow-skill branch, which
 * checks this before ever writing to `.kimi-code/skills/`.
 */
export function isCatalogStyleRouterCommand(src: string): boolean {
  const { body } = splitFrontmatter(src);
  const stripped = body.replace(/```[\s\S]*?```/g, '');
  for (const line of stripped.split('\n')) {
    if (!line.trim().startsWith('|')) continue;
    const cells = line.split('|').map((c) => c.trim().toLowerCase());
    if (cells.some((c) => c === 'intent') && cells.some((c) => /^primary\s+route$/.test(c))) {
      return true;
    }
  }
  return false;
}

/**
 * Convert a Claude slash-command into a kimi flow skill — the only way to get
 * an invocable command at PROJECT level (kimi has no project-level command
 * directory; real slash commands require the plugin, see Tier 3).
 * - type: flow  → manual invocation only (/skill:<name>), never auto-invoked.
 * - Strips Claude-only frontmatter keys (allowed-tools, argument-hint, bare
 *   claude model names) whose semantics kimi doesn't share.
 */
export function convertKimiCommandToFlowSkill(
  src: string,
  category: string,
  fallbackName: string,
): string {
  const { fm, body } = splitFrontmatter(src);
  let out = fm
    .replace(/^allowed-tools\s*:.*(\r?\n|$)/im, '')
    .replace(/^argument-hint\s*:.*(\r?\n|$)/im, '')
    .replace(/^model\s*:\s*(?!.*\/).*/im, '') // drop bare claude model names
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  const name = namespacedSlug(category, fallbackName);
  out = setFmKey(out, 'name', name);
  if (!getFmScalar(out, 'description')) {
    out = ensureFmKey(out, 'description', `${category} ${fallbackName} command (monomind)`);
  }
  out = setFmKey(out, 'type', 'flow');
  return `---\n${out}\n---\n\n${body.trimStart()}`;
}

/**
 * Convert a Claude slash-command into a kimi PLUGIN command file.
 * Plugin commands only read `name`/`description` frontmatter; the body is the
 * prompt and $ARGUMENTS is the placeholder — the same convention Claude
 * commands already use, so bodies pass through unchanged.
 */
export function convertKimiPluginCommandMd(
  src: string,
  category: string,
  fallbackName: string,
): string {
  const { fm, body } = splitFrontmatter(src);
  let out = fm
    .replace(/^allowed-tools\s*:.*(\r?\n|$)/im, '')
    .replace(/^argument-hint\s*:.*(\r?\n|$)/im, '')
    .replace(/^model\s*:\s*(?!.*\/).*/im, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  if (!getFmScalar(out, 'description')) {
    out = ensureFmKey(out, 'description', `${category} ${fallbackName} command (monomind)`);
  }
  return `---\n${out}\n---\n\n${body.trimStart()}`;
}

/** Namespace-prefixed command filename: "mastermind-build.md". */
export function kimiCommandFilename(category: string, file: string): string {
  const base = file.replace(/\.md$/i, '');
  return `${namespacedSlug(category, base)}.md`;
}
