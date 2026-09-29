/**
 * Bash command text preparation for the destructive-ops gate (issue #427).
 *
 * The gate used to regex-match the RAW command string, so a command that only
 * MENTIONS a dangerous string was blocked: `grep -rn "rm -rf" src/`,
 * `git commit -m "document git push --force risks"`, `echo 'DROP TABLE' > f`,
 * or a heredoc whose body is documentation.
 *
 * `destructiveScanTargets(cmd)` returns the strings the gate should match.
 * The command is split into segments on && || ; | & and newlines outside
 * quotes (mirroring splitCommandSegments in
 * packages/@monomind/cli/src/mcp-tools/hooks-embedding-agents.ts).
 *
 *   - A segment is MASKED (quoted literals containing whitespace become a
 *     placeholder; quoted-delimiter heredoc bodies are dropped) only when its
 *     command word is on SAFE_COMMANDS, an allowlist of commands that do not
 *     execute their arguments, AND every other segment of its pipeline is too
 *     (so nothing unknown reads its output), AND — if any segment writes a
 *     file — every segment of the whole command is allowlisted (so
 *     `echo '…' > x.sh; ./x.sh` is not masked). Even in a masked segment,
 *     quoted words without whitespace (`"rm" -rf`) and assignment values
 *     (`X="rm -rf ~"`) stay visible.
 *   - Every other segment is scanned dequoted but unmasked: quote characters
 *     are removed, the literal text is kept.
 *   - The whole RAW command (the pre-#427 behaviour) is scanned when a quote
 *     is unterminated, when there is a command substitution (`$(…)`,
 *     backticks, `<(…)`) or a dynamic command word (`$X`), or when any word
 *     names a known string executor (EXECUTOR_WORD) — an extra safety layer
 *     on top of the allowlist.
 *
 * Masking therefore only ever hides text inside quotes given to a command
 * known not to run it. Dependency-free on purpose: helpers run on every
 * PreToolUse and must not import packages.
 */

'use strict';

var PLACEHOLDER = '_q_';

// Commands whose quoted arguments are data. Exact command word only (no
// paths: `./echo` could be anything). less (+ commands, LESSOPEN), sed (`e`),
// awk (system), find (-exec) and xargs are deliberately absent.
var SAFE_COMMANDS = /^(?:grep|egrep|fgrep|rg|ag|ack|echo|printf|cat|tee|head|tail|wc|jq|yq|touch|mkdir|ls|git|gh)$/;
var SAFE_GIT_SUBCOMMAND = /^(?:commit|tag|notes|log|show|grep|diff)$/;
var SAFE_GH_SUBCOMMAND = /^(?:issue|pr|api|release)$/;
// Options that make an otherwise-safe command run a program.
var UNSAFE_OPTION = {
  printf: /^-v/,                                   // assigns a variable
  rg: /^--pre/,                                    // runs a preprocessor
  ack: /^--pager/,                                 // runs a pager
  git: /^(?:-O|--open-files-in-pager|--ext-diff|--textconv)/,
};

// Words that make a quoted argument executable; any one of them anywhere in
// the command forces a raw scan. Matched against each word's basename.
var EXECUTOR_WORD = new RegExp('^(?:' + [
  // shells and string-executing builtins/wrappers
  'sh', 'bash', 'zsh', 'dash', 'ksh', 'mksh', 'fish', 'csh', 'tcsh', 'ash', 'busybox', 'nu',
  'eval', 'exec', 'source', '\\.', 'alias', 'trap', 'xargs', 'parallel', 'env', 'sudo', 'doas',
  'su', 'runuser', 'watch', 'script', 'flock', 'nsenter', 'chroot', 'setsid', 'unshare',
  'ssh', 'rsync', 'tmux', 'screen', 'expect', 'at', 'batch', 'crontab', 'find', 'fd',
  'make', 'just', 'npm', 'yarn', 'pnpm', 'concurrently', 'nodemon', 'entr', 'watchexec',
  'docker', 'podman', 'kubectl',
  // interpreters
  'python[0-9.]*', 'pypy[0-9.]*', 'node', 'nodejs', 'deno', 'bun', 'perl', 'ruby', 'php',
  'lua', 'luajit', 'tclsh', 'rscript', 'osascript', 'pwsh', 'powershell', 'cmd', 'cmd\\.exe',
  'awk', 'gawk', 'mawk', 'nawk', 'sed', 'gsed', 'vim?', 'nvim', 'emacs', 'npx', 'pnpx',
  // database clients (the SQL patterns exist for these)
  'psql', 'pgcli', 'mysql', 'mycli', 'mariadb', 'sqlite3?', 'litecli', 'sqlcmd', 'mongo',
  'mongosh', 'redis-cli', 'cqlsh', 'clickhouse(?:-client)?', 'duckdb', 'cockroach', 'usql',
  'bq', 'snowsql', 'trino', 'presto', 'beeline', 'hive', 'spark-sql', 'supabase', 'prisma',
  'wrangler', 'turso', 'dolt', 'sf', 'sfdx',
].join('|') + ')$', 'i');

// git runs strings through these sub-commands/options.
var GIT_EXECUTING_WORD = /^(?:-c|--exec(?:=.*)?|-x|--config-env(?:=.*)?|config|alias\..*|rebase|bisect|submodule|filter-branch|filter-repo|difftool|mergetool|daemon|-C)$/;

var ASSIGNMENT_WORD = /^[A-Za-z_][A-Za-z0-9_]*(?:\[[^\]]*\])?\+?=/;
var SUBSTITUTION = /\$\(|`/;
// An output redirect to anything but /dev/null or another fd.
var WRITE_REDIRECT = /(?:^|[^>&])>>?\s*(?![&\s]|\/dev\/null(?![^\s;&|]))/;

/**
 * Walk the command once. Each segment keeps a masked and a plain (dequoted,
 * unmasked) rendering plus its words; heredoc bodies are collected with the
 * index of the segment that owns them.
 */
function parse(cmd) {
  var segs = [];
  var heredocs = [];
  var pending = [];
  var words = [];
  var pipeline = 0;
  var cur = { masked: '', plain: '', words: [], pipeline: 0 };
  var word = '';
  var wordMasked = '';
  var wordExtra = ''; // spaced quoted pieces, re-emitted standalone in the plain text
  var inWord = false;
  var unterminated = false;
  var dynamic = false;
  // `$(( 1 << 2 ))` is a shift, not a heredoc: never treat `<<` as one there.
  var arithmetic = cmd.indexOf('((') !== -1;
  var i = 0;
  var n = cmd.length;

  function emit(s) { cur.masked += s; cur.plain += s; }
  function endWord() {
    if (inWord) {
      words.push(word);
      cur.words.push(word);
      cur.masked += wordMasked;
      cur.plain += word + wordExtra;
    }
    word = '';
    wordMasked = '';
    wordExtra = '';
    inWord = false;
  }
  function endSegment(piped) {
    endWord();
    if (cur.plain.trim()) segs.push(cur);
    if (!piped) pipeline++;
    cur = { masked: '', plain: '', words: [], pipeline: pipeline };
  }
  function addQuoted(content) {
    // Assignment values and literals without whitespace stay visible.
    var keep = !/\s/.test(content) || ASSIGNMENT_WORD.test(word);
    word += content;
    if (/\s/.test(content)) wordExtra += ' ' + content; // so -O"rm …" still reads as rm …
    wordMasked += keep ? content : PLACEHOLDER;
    inWord = true;
  }
  function readHeredocBodies() {
    // Called just after an unquoted newline: consume each pending body.
    while (pending.length) {
      var h = pending.shift();
      h.body = '';
      while (i < n) {
        var eol = cmd.indexOf('\n', i);
        if (eol === -1) eol = n;
        var line = cmd.slice(i, eol);
        i = eol + 1;
        if ((h.stripTabs ? line.replace(/^\t+/, '') : line) === h.delim) { h.closed = true; break; }
        h.body += line + ' ';
      }
      heredocs.push(h);
    }
  }

  while (i < n) {
    var ch = cmd[i];
    if (ch === '\\') {
      var next = cmd[i + 1];
      if (next === '\n') { endWord(); emit(' '); i += 2; continue; }
      word += next || '';
      wordMasked += next || '';
      inWord = true;
      i += 2;
    } else if (ch === "'" || (ch === '$' && cmd[i + 1] === "'")) {
      var start = ch === '$' ? i + 2 : i + 1;
      var end = cmd.indexOf("'", start);
      if (ch === '$') {
        while (end !== -1 && cmd[end - 1] === '\\') end = cmd.indexOf("'", end + 1);
      }
      if (end === -1) { unterminated = true; end = n; }
      addQuoted(cmd.slice(start, end));
      i = end + 1;
    } else if (ch === '"') {
      var j = i + 1;
      var content = '';
      while (j < n && cmd[j] !== '"') {
        if (cmd[j] === '\\' && j + 1 < n) { content += cmd[j + 1]; j += 2; continue; }
        content += cmd[j];
        j++;
      }
      if (j >= n) unterminated = true;
      if (SUBSTITUTION.test(content)) dynamic = true;
      addQuoted(content);
      i = j + 1;
    } else if (ch === '<' && cmd.slice(i, i + 3) === '<<<') {
      endWord();
      emit('<<<');
      i += 3;
    } else if (ch === '<' && cmd[i + 1] === '<' && !arithmetic) {
      endWord();
      var m = /^<<(-?)[ \t]*(?:'([^']*)'|"([^"]*)"|\\?([^\s;&|<>()]+))/.exec(cmd.slice(i));
      if (m) {
        pending.push({
          delim: m[2] !== undefined ? m[2] : m[3] !== undefined ? m[3] : m[4].replace(/['"\\]/g, ''),
          quoted: m[2] !== undefined || m[3] !== undefined || /^<<-?[ \t]*\\/.test(m[0]),
          stripTabs: m[1] === '-',
          owner: segs.length,
          closed: false,
        });
        emit(m[0].replace(/['"]/g, '') + ' ');
        i += m[0].length;
      } else {
        emit('<<');
        i += 2;
      }
    } else if (ch === '&' && (cmd[i - 1] === '>' || cmd[i - 1] === '<' || cmd[i + 1] === '>')) {
      word += ch; // part of a redirect: 2>&1, &>file
      wordMasked += ch;
      inWord = true;
      i++;
    } else if ((ch === '&' || ch === '|') && cmd[i + 1] === ch) {
      endSegment(false);
      i += 2;
    } else if (ch === ';' || ch === '&' || ch === '|' || ch === '\n') {
      endSegment(ch === '|');
      i += (ch === '|' && cmd[i + 1] === '&') ? 2 : 1;
      if (ch === '\n') readHeredocBodies();
    } else if (/\s/.test(ch) || ch === '(' || ch === ')' || ch === '`' || ch === '{' || ch === '}') {
      if (ch === '`' || (ch === '(' && /[$<>]/.test(cmd[i - 1] || ''))) dynamic = true;
      endWord();
      emit(ch);
      i++;
    } else {
      word += ch;
      wordMasked += ch;
      inWord = true;
      i++;
    }
  }
  endSegment(false);
  pending.forEach(function (h) { h.body = ''; heredocs.push(h); });
  return { segs: segs, heredocs: heredocs, words: words, unterminated: unterminated, dynamic: dynamic };
}

function basename(w) {
  var slash = w.lastIndexOf('/');
  return slash === -1 ? w : w.slice(slash + 1);
}

/** True when some word in the command can execute a quoted string. */
function hasExecutor(words) {
  var sawGit = false;
  for (var k = 0; k < words.length; k++) {
    var w = basename(words[k].replace(/^[$(`{]+/, ''));
    if (EXECUTOR_WORD.test(w)) return true;
    if (w === 'git') sawGit = true;
    else if (sawGit && GIT_EXECUTING_WORD.test(words[k])) return true;
  }
  return false;
}

/** The command word of a segment (after leading VAR=val), or ''. */
function commandWord(seg) {
  for (var k = 0; k < seg.words.length; k++) {
    if (!ASSIGNMENT_WORD.test(seg.words[k])) return { name: seg.words[k], rest: seg.words.slice(k + 1) };
  }
  return { name: '', rest: [] };
}

/** True when the segment's command is known not to execute its arguments. */
function isSafeSegment(seg) {
  var c = commandWord(seg);
  if (!SAFE_COMMANDS.test(c.name)) return false;
  if (c.name === 'git' && !SAFE_GIT_SUBCOMMAND.test(c.rest[0] || '')) return false;
  if (c.name === 'gh' && !SAFE_GH_SUBCOMMAND.test(c.rest[0] || '')) return false;
  var unsafe = UNSAFE_OPTION[c.name];
  return !unsafe || !c.rest.some(function (w) { return unsafe.test(w); });
}

/**
 * Return the strings the destructive-ops patterns should be matched against.
 * See the file header for the rules.
 */
function destructiveScanTargets(cmd) {
  if (typeof cmd !== 'string' || !cmd) return [];
  var parsed = parse(cmd);
  if (hasExecutor(parsed.words)) return [cmd];
  return segmentTargets(cmd, parsed);
}

/** The allowlist-based targets alone, without the executor safety layer. */
function segmentTargets(cmd, parsed) {
  if (parsed.unterminated || parsed.dynamic) return [cmd];
  var segs = parsed.segs;
  for (var k = 0; k < segs.length; k++) {
    if (commandWord(segs[k]).name.indexOf('$') !== -1) return [cmd]; // `$X args`
    segs[k].safe = isSafeSegment(segs[k]);
  }
  var allSafe = segs.every(function (s) { return s.safe; });
  var writes = segs.some(function (s) { return commandWord(s).name === 'tee' || WRITE_REDIRECT.test(s.plain); });
  function maskable(s) {
    if (!s || !s.safe || (writes && !allSafe)) return false;
    return segs.every(function (o) { return o.pipeline !== s.pipeline || o.safe; });
  }
  var targets = segs.map(function (s) { return maskable(s) ? s.masked : s.plain; });
  parsed.heredocs.forEach(function (h) {
    // An unquoted delimiter expands $(…) and backticks in the body.
    var inert = h.quoted || !SUBSTITUTION.test(h.body);
    if (!(h.closed && inert && maskable(segs[h.owner])) && h.body) targets.push(h.body);
  });
  return targets;
}

// ─── Network content piped into a shell ──────────────────────────────────────

var NETWORK_FETCH = /(?:^|[\s/(`])(?:curl|wget|fetch|aria2c|https?|httpie|xh|nc|ncat|iwr|irm|invoke-webrequest|invoke-restmethod)(?=\s|$)/i;
var SHELL_SINK_START = /^(?:sudo\s+(?:-\S+\s+)*)?(?:\S*\/)?(?:sh|bash|zsh|dash|ksh|fish|source|eval|iex|invoke-expression|python[0-9.]*|node|perl|ruby|php|pwsh|powershell)(?=\s|$)/i;
var SUBSTITUTED_FETCH = /(?:<\(|\$\(|`)\s*(?:curl|wget|fetch|https?|xh|nc|ncat|iwr|irm)\b/i;

/**
 * True when the command feeds downloaded content to an interpreter:
 * `curl … | sh`, `bash <(curl …)`, `sh -c "$(wget -O- …)"`, `eval "$(curl …)"`.
 */
function pipesNetworkIntoShell(cmd) {
  if (typeof cmd !== 'string' || !cmd) return false;
  if (SUBSTITUTED_FETCH.test(cmd)) return true;
  var chains = cmd.replace(/\|\||&&/g, ';').split(/[;&\n]/);
  for (var c = 0; c < chains.length; c++) {
    var stages = chains[c].split('|');
    for (var k = 1; k < stages.length; k++) {
      if (!SHELL_SINK_START.test(stages[k].trim())) continue;
      for (var p = 0; p < k; p++) if (NETWORK_FETCH.test(stages[p])) return true;
    }
  }
  return false;
}

module.exports = {
  destructiveScanTargets,
  pipesNetworkIntoShell,
  _hasExecutor: hasExecutor,
  _segmentTargets: function (cmd) { return segmentTargets(cmd, parse(cmd)); },
};
