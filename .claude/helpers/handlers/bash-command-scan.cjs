/**
 * Bash command text preparation for the destructive-ops gate (issue #427).
 *
 * The gate used to regex-match the RAW command string, so a command that only
 * MENTIONS a dangerous string was blocked: `grep -rn "rm -rf" src/`,
 * `git commit -m "document git push --force risks"`, `echo 'DROP TABLE' > f`,
 * or a heredoc whose body is documentation.
 *
 * `destructiveScanTargets(cmd)` returns the strings the gate should match:
 *
 *   - Normally: one string per command segment (split on && || ; | & and
 *     newlines outside quotes, mirroring splitCommandSegments in
 *     packages/@monomind/cli/src/mcp-tools/hooks-embedding-agents.ts), with
 *     quote characters removed and every quoted literal that contains
 *     whitespace replaced by a placeholder. A quoted literal WITHOUT
 *     whitespace is kept (dequoted), so `"rm" -rf ~`, `r"m" -rf ~` and
 *     `git push "--force"` still match. Quoted assignment values
 *     (`X="rm -rf ~"; $X`) and double-quoted text containing `$(`/backticks
 *     are kept too, because the shell can execute them. Heredoc bodies are
 *     dropped, except an unquoted-delimiter body that contains a command
 *     substitution.
 *
 *   - The whole RAW command (the previous behaviour) when any word in it
 *     names something that executes a string: a shell (`bash -c`, `sh -c`),
 *     `eval`, `xargs`, `ssh`, `su`, `watch`, `trap`, an interpreter
 *     (`python -c`, `node -e`, `awk`), a database client (`psql`, `mysql`,
 *     `sqlite3`), a git sub-command that runs commands, and so on. In that
 *     case a quoted payload may well be executed, so nothing is masked.
 *
 * Masking can only ever REMOVE a match that sat entirely inside a quoted
 * literal of a non-executing command; anything outside quotes, or anything
 * a listed executor could run, is still scanned. Dependency-free on purpose:
 * helpers run on every PreToolUse and must not import packages.
 */

'use strict';

var PLACEHOLDER = '_q_';

// Words that make a quoted argument executable. Matched against each
// unquoted word's basename (so /usr/bin/bash counts).
var EXECUTOR_WORD = new RegExp('^(?:' + [
  // shells and string-executing builtins/wrappers
  'sh', 'bash', 'zsh', 'dash', 'ksh', 'mksh', 'fish', 'csh', 'tcsh', 'ash', 'busybox',
  'eval', 'exec', 'source', 'alias', 'trap', 'xargs', 'parallel', 'env', 'sudo', 'doas',
  'su', 'runuser', 'watch', 'script', 'flock', 'nsenter', 'chroot', 'setsid', 'unshare',
  'ssh', 'rsync', 'tmux', 'screen', 'expect', 'at', 'batch', 'crontab', 'find', 'fd',
  'make', 'just',
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

// git runs strings through these sub-commands/options; a plain
// `git commit -m "…"` is still masked.
var GIT_EXECUTING_WORD = /^(?:-c|--exec(?:=.*)?|-x|--config-env(?:=.*)?|config|alias\..*|rebase|bisect|submodule|filter-branch|filter-repo|difftool|mergetool|daemon|-C)$/;

var ASSIGNMENT_WORD = /^[A-Za-z_][A-Za-z0-9_]*(?:\[[^\]]*\])?\+?=/;
var SUBSTITUTION = /\$\(|`/;

/**
 * Walk the command once, producing masked segments and the list of words
 * (dequoted, as the shell would see them) used for executor detection.
 */
function parse(cmd) {
  var segments = [];
  var words = [];
  var seg = '';      // masked text of the current segment
  var word = '';     // dequoted current word (for executor detection)
  var wordMasked = '';
  var inWord = false;
  var pendingHeredocs = [];
  var unterminated = false;
  // `$(( 1 << 2 ))` is a shift, not a heredoc: never mask bodies there.
  var arithmetic = cmd.indexOf('((') !== -1;
  var i = 0;
  var n = cmd.length;

  function endWord() {
    if (inWord) {
      words.push(word);
      seg += wordMasked;
    }
    word = '';
    wordMasked = '';
    inWord = false;
  }
  function endSegment() {
    endWord();
    var t = seg.trim();
    if (t) segments.push(t);
    seg = '';
  }
  function addQuoted(content, executable) {
    // Assignment values and literals without whitespace stay visible.
    var keep = executable || !/\s/.test(content) || ASSIGNMENT_WORD.test(word);
    word += content;
    wordMasked += keep ? content : PLACEHOLDER;
    inWord = true;
  }
  function readHeredocBodies() {
    // Called just after an unquoted newline: consume each pending body.
    while (pendingHeredocs.length) {
      var h = pendingHeredocs.shift();
      var body = '';
      var closed = false;
      while (i < n) {
        var eol = cmd.indexOf('\n', i);
        if (eol === -1) eol = n;
        var line = cmd.slice(i, eol);
        i = eol + 1;
        var cmp = h.stripTabs ? line.replace(/^\t+/, '') : line;
        if (cmp === h.delim) { closed = true; break; }
        body += line + '\n';
      }
      // Keep the body when it never closed (not really a heredoc) or when an
      // unquoted delimiter expands $(…) / backticks inside it.
      if (!closed || (!h.quoted && SUBSTITUTION.test(body))) {
        segments.push(body.replace(/\n/g, ' '));
      }
    }
  }

  while (i < n) {
    var ch = cmd[i];
    if (ch === '\\') {
      var next = cmd[i + 1];
      if (next === '\n') { endWord(); seg += ' '; i += 2; continue; }
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
      addQuoted(cmd.slice(start, end), false);
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
      addQuoted(content, SUBSTITUTION.test(content));
      i = j + 1;
    } else if (ch === '<' && cmd.slice(i, i + 3) === '<<<') {
      endWord();
      seg += '<<<';
      i += 3;
    } else if (ch === '<' && cmd[i + 1] === '<' && !arithmetic) {
      endWord();
      var m = /^<<(-?)[ \t]*(?:'([^']*)'|"([^"]*)"|\\?([^\s;&|<>()]+))/.exec(cmd.slice(i));
      if (m) {
        var quoted = m[2] !== undefined || m[3] !== undefined || /^<<-?[ \t]*\\/.test(m[0]);
        var delim = m[2] !== undefined ? m[2] : m[3] !== undefined ? m[3] : m[4].replace(/['"\\]/g, '');
        pendingHeredocs.push({ delim: delim, quoted: quoted, stripTabs: m[1] === '-' });
        seg += m[0].replace(/['"]/g, '') + ' ';
        i += m[0].length;
      } else {
        seg += '<<';
        i += 2;
      }
    } else if ((ch === '&' || ch === '|') && cmd[i + 1] === ch) {
      endSegment();
      i += 2;
    } else if (ch === ';' || ch === '&' || ch === '|' || ch === '\n') {
      endSegment();
      i += (ch === '|' && cmd[i + 1] === '&') ? 2 : 1;
      if (ch === '\n') readHeredocBodies();
    } else if (/\s/.test(ch) || ch === '(' || ch === ')' || ch === '`' || ch === '{' || ch === '}') {
      endWord();
      seg += ch;
      i++;
    } else {
      word += ch;
      wordMasked += ch;
      inWord = true;
      i++;
    }
  }
  endSegment();
  return { segments: segments, words: words, unterminated: unterminated };
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

/**
 * Return the strings the destructive-ops patterns should be matched against.
 * See the file header for the rules.
 */
function destructiveScanTargets(cmd) {
  if (typeof cmd !== 'string' || !cmd) return [];
  var parsed = parse(cmd);
  if (parsed.unterminated || hasExecutor(parsed.words)) return [cmd];
  return parsed.segments;
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
  _parse: parse,
  _hasExecutor: hasExecutor,
};
