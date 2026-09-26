#!/usr/bin/env node
/**
 * Git merge driver for CHANGELOG.md: resolves the conflict a release causes
 * when another session added entries under `## [Unreleased]` meanwhile.
 *
 * A release turns `## [Unreleased]` into `## [X.Y.Z] — <date>` on one side
 * (theirs, e.g. origin/main) while the other side (ours, local main) added new
 * entries under `## [Unreleased]` at the same place, so a plain text merge
 * conflicts every time. The result here is:
 *
 *   - theirs' version sections, verbatim;
 *   - one `## [Unreleased]` above them holding theirs' own Unreleased entries
 *     plus every entry our side added (not in base, not anywhere in theirs),
 *     deduped, in their `### Added` / `### Fixed` / … subsections.
 *
 * It only does that when the merge has exactly this shape: our side changed
 * no version section and only added Unreleased entries (every base Unreleased
 * entry is still there, unchanged), and the preamble merges trivially.
 * Anything else is left to git as an ordinary conflict: the file named by %A
 * gets `git merge-file`'s conflict markers and the driver exits 1.
 *
 * Register it (pnpm run setup:merge-drivers does this):
 *   .gitattributes:  CHANGELOG.md merge=monomind-changelog
 *   git config merge.monomind-changelog.driver "node scripts/merge-changelog.mjs %O %A %B"
 * or for one command only:
 *   git -c merge.monomind-changelog.driver="node scripts/merge-changelog.mjs %O %A %B" merge origin/main
 *
 * Usage: node scripts/merge-changelog.mjs <base %O> <ours %A> <theirs %B>
 * Exit: 0 merged (result written to <ours>), 1 conflict left in <ours>, 2 usage error.
 */

import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';

const SECTION = /^## \[/;
const UNRELEASED = /^## \[Unreleased\]/i;
const SUBSECTION = /^### /;
const BULLET = /^\s{0,3}[-*+] /;
/** Keep a Changelog order; unknown headings follow in order of appearance. */
const ORDER = ['breaking', 'added', 'changed', 'deprecated', 'removed', 'fixed', 'security'];

/** Splits a changelog into its preamble and `## [` sections (header + body lines). */
function parse(text) {
  const lines = text.split('\n');
  const first = lines.findIndex((l) => SECTION.test(l));
  const end = first === -1 ? lines.length : first;
  const sections = [];
  for (let i = end; i < lines.length; i++) {
    if (SECTION.test(lines[i])) sections.push({ header: lines[i], body: [] });
    else sections[sections.length - 1].body.push(lines[i]);
  }
  return { preamble: lines.slice(0, end), sections };
}

const sectionText = (s) => [s.header, ...s.body].join('\n');
const released = (doc) => doc.sections.filter((s) => !UNRELEASED.test(s.header));
const unreleased = (doc) => doc.sections.filter((s) => UNRELEASED.test(s.header));

/**
 * Entries of a section body, each tagged with its `###` subsection ('' before
 * the first). A bullet starts an entry and its non-blank, non-bullet lines
 * continue it; any other paragraph is an entry of its own. `gap` marks an
 * entry separated from the previous one of its subsection by a blank line.
 */
function entries(body) {
  const out = [];
  let sub = '';
  let cur = null;
  let blank = false;
  for (const line of body) {
    if (SUBSECTION.test(line)) {
      sub = line.trim();
      cur = null;
      blank = false;
    } else if (line.trim() === '') {
      cur = null;
      blank = true;
    } else if (BULLET.test(line) || !cur) {
      const gap = blank && out.length > 0 && out[out.length - 1].sub === sub;
      cur = { sub, gap, lines: [line.trimEnd()] };
      out.push(cur);
      blank = false;
    } else {
      cur.lines.push(line.trimEnd());
    }
  }
  return out.map((e) => ({ sub: e.sub, gap: e.gap, text: e.lines.join('\n') }));
}

const rank = (sub) => {
  const i = ORDER.indexOf(
    sub
      .replace(/^###\s*/, '')
      .trim()
      .toLowerCase(),
  );
  return sub === '' ? -1 : i === -1 ? ORDER.length : i;
};

function renderUnreleased(header, list, looseList) {
  const subs = [];
  for (const e of list) if (!subs.includes(e.sub)) subs.push(e.sub);
  subs.sort((a, b) => rank(a) - rank(b));
  const out = [header, ''];
  for (const sub of subs) {
    if (sub) out.push(sub, '');
    const texts = list.filter((e) => e.sub === sub).map((e) => e.text);
    out.push(...(looseList ? texts.flatMap((t, i) => (i ? ['', t] : [t])) : texts), '');
  }
  return out;
}

/** 3-way merge of a value that only one side may change; undefined = conflict. */
function pick(base, ours, theirs) {
  if (ours === base || ours === theirs) return theirs;
  if (theirs === base) return ours;
  return undefined;
}

/** The merged text, or null when the merge is not the release/Unreleased shape. */
function mergeChangelog(baseText, oursText, theirsText) {
  const [base, ours, theirs] = [baseText, oursText, theirsText].map(parse);
  const preamble = pick(
    base.preamble.join('\n'),
    ours.preamble.join('\n'),
    theirs.preamble.join('\n'),
  );
  if (preamble === undefined) return null;

  // Our side must not have touched any released section (added, removed or edited).
  const releasedText = (doc) => released(doc).map(sectionText).join('\n');
  if (releasedText(ours) !== releasedText(base)) return null;
  if (unreleased(ours).length > 1 || unreleased(base).length > 1 || unreleased(theirs).length > 1)
    return null;

  const baseEntries = unreleased(base).flatMap((s) => entries(s.body));
  const oursBody = unreleased(ours)[0]?.body ?? [];
  const oursEntries = entries(oursBody);
  const key = (e) => `${e.sub}\n${e.text}`;
  const oursKeys = new Set(oursEntries.map(key));
  // Every base Unreleased entry must still be on our side, unchanged.
  if (!baseEntries.every((e) => oursKeys.has(key(e)))) return null;

  const baseTexts = new Set(baseEntries.map((e) => e.text));
  const theirsTexts = new Set(theirs.sections.flatMap((s) => entries(s.body)).map((e) => e.text));
  const added = [];
  const seen = new Set();
  for (const e of oursEntries) {
    if (baseTexts.has(e.text) || theirsTexts.has(e.text) || seen.has(e.text)) continue;
    seen.add(e.text);
    added.push(e);
  }

  if (!added.length) return theirsText;
  const theirsUnreleased = unreleased(theirs)[0];
  const list = [...(theirsUnreleased ? entries(theirsUnreleased.body) : []), ...added];
  const header = theirsUnreleased?.header ?? unreleased(ours)[0]?.header ?? '## [Unreleased]';
  const rendered = renderUnreleased(
    header,
    list,
    oursEntries.some((e) => e.gap),
  ).join('\n');

  // In place of theirs' Unreleased, else above theirs' first version section.
  const sections = theirs.sections.map(sectionText);
  const at = theirs.sections.findIndex((x) => UNRELEASED.test(x.header));
  if (at === -1) sections.unshift(rendered);
  else sections[at] = rendered;
  const out = preamble === '' ? sections : [preamble, ...sections];
  return out.join('\n');
}

function main(argv) {
  if (argv.length !== 3) {
    process.stderr.write('usage: merge-changelog.mjs <base %O> <ours %A> <theirs %B>\n');
    return 2;
  }
  const [o, a, b] = argv;
  const merged = mergeChangelog(...[o, a, b].map((p) => readFileSync(p, 'utf8')));
  if (merged !== null) {
    writeFileSync(a, merged);
    return 0;
  }
  // Not our shape: leave git's ordinary conflict (markers) in %A.
  const r = spawnSync('git', ['merge-file', '-L', 'ours', '-L', 'base', '-L', 'theirs', a, o, b], {
    stdio: ['ignore', 'ignore', 'inherit'],
  });
  return r.status === 0 ? 0 : 1;
}

process.exit(main(process.argv.slice(2)));
