import path from 'node:path';
import { MONODESIGN_COMMAND } from './lib/provider.mjs';
import { ENVELOPE_PREFIX, ACK_EXTS, DEFAULT_CONFIG, matchConfiguredExtension } from './hook-lib-config.mjs';
import { normalizeIgnoreRule } from './hook-lib-ignore.mjs';
import { extractFindingIgnoreValue, extractFindingIgnoreValueRaw } from './hook-lib-findings.mjs';

export function renderTemplate(findings, filePath, config, opts = {}) {
  if (!Array.isArray(findings) || findings.length === 0) return '';
  const limits = config?.limits || DEFAULT_CONFIG.limits;
  const cap = Math.max(1, limits.maxFindings || DEFAULT_CONFIG.limits.maxFindings);
  const maxChars = Math.max(500, limits.maxChars || DEFAULT_CONFIG.limits.maxChars);

  const cwd = opts.cwd || process.cwd();
  const display = relativize(filePath, cwd);
  const total = findings.length;
  const shown = findings.slice(0, cap);
  const remaining = total - shown.length;

  const header = `${ENVELOPE_PREFIX} Design hook findings requiring review in ${display} (${total} issue(s)):`;
  const lines = shown.map((f) => formatFindingLine(f));
  const more = remaining > 0
    ? `... and ${remaining} more (see ${MONODESIGN_COMMAND} audit).`
    : null;
  const footer = directiveFooter(display);

  const blocks = [header, ...lines];
  if (more) blocks.push(more);
  blocks.push('');
  blocks.push(footer);
  let text = blocks.join('\n');

  if (text.length > maxChars) {
    text = clampToBudget(header, lines, more, footer, maxChars);
  }
  return text;
}

export function renderGroupedTemplate(groups, config, opts = {}) {
  const realGroups = groups.filter((group) => Array.isArray(group.findings) && group.findings.length > 0);
  if (realGroups.length === 0) return '';
  if (realGroups.length === 1) {
    const [group] = realGroups;
    return renderTemplate(group.findings, group.filePath, config, opts);
  }

  const limits = config?.limits || DEFAULT_CONFIG.limits;
  const cap = Math.max(1, limits.maxFindings || DEFAULT_CONFIG.limits.maxFindings);
  const maxChars = Math.max(500, limits.maxChars || DEFAULT_CONFIG.limits.maxChars);
  const cwd = opts.cwd || process.cwd();
  const total = realGroups.reduce((sum, group) => sum + group.findings.length, 0);
  const header = `${ENVELOPE_PREFIX} Design hook findings requiring review across ${realGroups.length} files (${total} issue(s)):`;
  const lines = [];
  let shownCount = 0;

  for (const group of realGroups) {
    const display = relativize(group.filePath, cwd);
    lines.push(`${display} (${group.findings.length} issue(s)):`);
    const remainingCap = Math.max(0, cap - shownCount);
    const shown = group.findings.slice(0, remainingCap);
    for (const finding of shown) {
      lines.push(formatFindingLine(finding));
    }
    shownCount += shown.length;
    const hidden = group.findings.length - shown.length;
    if (hidden > 0) {
      lines.push(`- ... ${hidden} more in ${display} (see ${MONODESIGN_COMMAND} audit).`);
    }
  }

  const footer = directiveFooter('the affected files', { grouped: true });
  let text = [header, ...lines, '', footer].join('\n');
  if (text.length > maxChars) {
    text = clampGroupedToBudget(header, lines, footer, maxChars);
  }
  return text;
}

function clampGroupedToBudget(header, lines, footer, maxChars) {
  const assemble = (linesArr, omitted) => [
    header,
    ...linesArr,
    ...(omitted ? [`... and more (see ${MONODESIGN_COMMAND} audit).`] : []),
    '',
    footer,
  ].join('\n');

  const working = lines.slice();
  let omitted = false;
  let assembled = assemble(working, omitted);
  while (assembled.length > maxChars && working.length > 1) {
    working.pop();
    omitted = true;
    assembled = assemble(working, omitted);
  }
  if (assembled.length > maxChars) {
    assembled = `${assembled.slice(0, maxChars - 1)}…`;
  }
  return assembled;
}

function clampToBudget(header, lines, more, footer, maxChars) {
  const assemble = (linesArr, moreText) => {
    const blocks = [header, ...linesArr];
    if (moreText) blocks.push(moreText);
    blocks.push('');
    blocks.push(footer);
    return blocks.join('\n');
  };

  const working = lines.slice();
  let moreText = more;
  let assembled = assemble(working, moreText);
  while (assembled.length > maxChars && working.length > 1) {
    working.pop();
    moreText = `... and more (see ${MONODESIGN_COMMAND} audit).`;
    assembled = assemble(working, moreText);
  }
  if (assembled.length > maxChars) {
    assembled = `${assembled.slice(0, maxChars - 1)}…`;
  }
  return assembled;
}

function formatFindingLine(f) {
  const prefix = f.line && f.line > 0 ? `- L${f.line}` : '-';
  const desc = (f.description || '').trim();
  const name = (f.name || '').trim();
  // Description from the registry already ends in punctuation; join with a
  // single space. `name` may have a trailing period already, keep it clean.
  const nameSegment = name ? `${name.replace(/\.+\s*$/, '')}.` : '';
  const ignoreCommand = formatFindingIgnoreCommand(f);
  const ignoreSegment = ignoreCommand
    ? ` If the user explicitly confirms this value is intentional: \`${ignoreCommand}\`.`
    : '';
  return `${prefix} [${f.antipattern}] ${nameSegment} ${desc}${ignoreSegment}`.replace(/\s+/g, ' ').trim();
}

function formatFindingIgnoreCommand(finding) {
  if (!finding || typeof finding !== 'object') return '';
  const rule = normalizeIgnoreRule(finding.antipattern);
  if (!rule) return '';
  const normalizedValue = extractFindingIgnoreValue(finding);
  if (!normalizedValue) return '';
  const value = extractFindingIgnoreValueRaw(finding);
  const valueArg = quoteCommandArg(value);
  const reason = quoteCommandArg(`User confirmed ${value} is intentional`);
  return `${MONODESIGN_COMMAND} hooks ignore-value ${rule} ${valueArg} --shared --reason ${reason}`;
}

function quoteCommandArg(value) {
  const text = String(value || '').trim();
  if (/^[A-Za-z0-9._:-]+$/.test(text)) return text;
  return `"${text.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

export function relativize(filePath, cwd) {
  try {
    const rel = path.relative(cwd, filePath).split(path.sep).join('/');
    if (!rel || rel.startsWith('..')) return filePath;
    return rel.split(path.sep).join('/');
  } catch {
    return filePath;
  }
}

// ────────────────────────────────────────────────────────────────────────
// Nudge/steer messages for the no-silent-fires policy.
//
// The hook is designed to be a conversational presence: every fire that
// actually scans a file emits a developer-role message into the model's
// next turn. Three states map to three templates:
//
//   1. **Fresh findings**  → `renderTemplate` (existing, imperative).
//   2. **Pending findings** → `renderPendingAck` (re-nudge for issues the
//                              model was already told about in this
//                              session but hasn't fixed yet).
//   3. **Truly clean**      → `renderCleanAck` (short positive nudge that
//                              keeps the design discipline in context).
//
// All three are short (≤ ~40 tokens each) so the cumulative cost stays
// bounded across a long active editing session. Users who explicitly want
// silence-on-clean can set `MONODESIGN_HOOK_QUIET=1` — runHook checks that
// env before emitting #2 or #3.
//
// Why not stay silent on dedup-clean? Earlier versions did. The model
// quickly forgets the prior reminder once tool output scrolls past it, so
// re-nudging on the same file with a short "still pending" line keeps the
// pressure on. The wording deliberately points back to "earlier this
// session" so the model knows it's a re-mind, not a new finding.
// ────────────────────────────────────────────────────────────────────────

const STEER_LINE = 'That does not mean the design is good: keep following the project design system and the monodesign skill guidance.';

export function renderCleanAck(filePath, opts = {}) {
  const cwd = opts.cwd || process.cwd();
  const display = relativize(filePath, cwd);
  return `${ENVELOPE_PREFIX} Design hook scanned ${display}. No deterministic design-quality issues found. ${STEER_LINE}`;
}

export function renderPendingAck(filePath, knownFindings, opts = {}) {
  const cwd = opts.cwd || process.cwd();
  const display = relativize(filePath, cwd);
  const count = knownFindings.length;
  // `knownFindings` here are the cache strings like "side-tab:3".
  const sample = knownFindings.slice(0, 3).join(', ');
  const more = count > 3 ? `, +${count - 3} more` : '';
  return `${ENVELOPE_PREFIX} Design hook scanned ${display}. Still has ${count} finding(s) flagged earlier this session (${sample}${more}). Handle them before finalizing — the previous reminder still applies.`;
}

export function shouldEmitAckForFile(filePath, config = null) {
  if (ACK_EXTS.has(path.extname(String(filePath || '')).toLowerCase())) return true;
  // Configured html-engine extensions are declared UI markup, so they get the
  // clean/pending acks; text-engine ones stay quiet like plain .ts/.js.
  const configured = matchConfiguredExtension(filePath, config?.extensions);
  return Boolean(configured && configured.engine === 'html');
}

export function designSystemOptions(config, detector, projectCwd) {
  if (config?.designSystem?.enabled === false) return {};
  if (!detector || typeof detector.loadDesignSystemForCwd !== 'function') return {};
  try {
    const designSystem = detector.loadDesignSystemForCwd(projectCwd);
    return designSystem ? { designSystem } : {};
  } catch {
    return {};
  }
}

export function appendDesignSystemNote(text, scanOptions) {
  if (!text || !scanOptions?.designSystem?.mdNewerThanJson) return text;
  return `${text}\n\n${ENVELOPE_PREFIX} DESIGN.md is newer than .monodesign/design.json. Run ${MONODESIGN_COMMAND} document to refresh the design-system sidecar.`;
}

// The directive footer is the part of the hook output that steers model
// behavior. Three intentional moves:
//   1. **Imperative, not advisory.** "Handle these..." beats "Consider
//      revising..." which the model treats as a soft suggestion it can
//      override when the user asked for any kind of throwaway / demo UI.
//   2. **Explicit judgment clause.** Without it, the model will try to
//      "fix" intentional motion, bad fixtures, anti-pattern examples in
//      docs, or test cases. Naming the judgment inline beats hoping the
//      model infers it from context.
//   3. **Acknowledgement instruction.** Hook output is injected as
//      developer-role context, not a chat turn, so the user never sees the
//      raw envelope. Asking the model to surface the resolution in its
//      reply is the cheapest way to make the feedback loop visible.
function directiveFooter(display, opts = {}) {
  const ignoreFileCommand = `${MONODESIGN_COMMAND} hooks ignore-file ${quoteCommandArg(display)}`;
  const fileIgnoreGuidance = opts.grouped
    ? `run \`${MONODESIGN_COMMAND} hooks ignore-file <path>\` for the specific file`
    : `run \`${ignoreFileCommand}\``;
  return [
    'Handle these before finalizing: fix findings that are real design problems, or explicitly classify contextually intentional findings as false positives. Acknowledge what you changed or why you are leaving a finding unchanged.',
    '',
    'Use context judgment before editing. A finding is not automatically a defect; literal or domain-appropriate motion, intentional demos or fixtures, documentation of bad design, and user-confirmed choices can be valid as-is.',
    '',
    `Do not change intentional design just to satisfy the hook, and do not silence a real finding with an inline ignore comment to skip fixing it. Suppress a finding only after the user explicitly confirms it is intentional. Prefer a config ignore (one reviewable place, the commands below); reach for an inline \`monodesign-disable <rule>\` comment only when the waiver must travel with a file that leaves the repo, such as an exported or standalone document. Prefer the narrowest persisted exception: run the exact \`${MONODESIGN_COMMAND} hooks ignore-value ... --shared\` command shown next to a value-specific finding. For \`overused-font\`, use \`ignore-value\` for a specific font and use \`${MONODESIGN_COMMAND} hooks ignore-rule overused-font --all-values\` only when the user asks to ignore overused fonts generally. For file-specific findings without an ignore-value command, ${fileIgnoreGuidance}; use \`${MONODESIGN_COMMAND} hooks ignore-rule <id>\` only when the user asks to suppress the whole non-value-specific rule. Run ${MONODESIGN_COMMAND} audit for the full pass.`,
  ].join('\n');
}

export function payload(text, eventName = 'PostToolUse', harness = 'claude') {
  if (harness === 'cursor') {
    return JSON.stringify({ additional_context: text });
  }
  // GitHub Copilot's postToolUse hook injects context via a top-level
  // `additionalContext` string (alongside an optional `modifiedResult`).
  if (harness === 'github') {
    return JSON.stringify({ additionalContext: text });
  }
  return JSON.stringify({
    hookSpecificOutput: { hookEventName: eventName, additionalContext: text },
  });
}
