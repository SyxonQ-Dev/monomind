// Line-level unified diff for `fix --dry-run`. The old single-hunk version
// spanned the first to the last changed line, so 30 one-line edits spread
// across a big file printed nearly the whole file (#424). This uses Myers'
// O((N+M)D) algorithm — D (edited lines) is small for codemods — and emits
// one hunk per cluster of changes with 3 lines of context.

const CONTEXT = 3;
// Beyond this many edited lines the trace gets large; fall back to replacing
// the changed middle wholesale (still trimmed of the shared prefix/suffix).
const MAX_EDITS = 2000;

// Returns an edit script: [{ op: ' ' | '-' | '+', a, b }] where a/b index the
// old/new line arrays; null when the diff exceeds MAX_EDITS.
function myersDiff(a, b) {
  const n = a.length;
  const m = b.length;
  const max = n + m;
  const offset = max;
  const v = new Array(2 * max + 2).fill(0);
  const trace = [];
  let found = false;
  for (let d = 0; d <= max && !found; d++) {
    if (d > MAX_EDITS) return null;
    // Only diagonals -d..d can be read back for this step: O(D^2) memory.
    trace.push(v.slice(offset - d, offset + d + 1));
    for (let k = -d; k <= d; k += 2) {
      let x = (k === -d || (k !== d && v[offset + k - 1] < v[offset + k + 1]))
        ? v[offset + k + 1]
        : v[offset + k - 1] + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) { x++; y++; }
      v[offset + k] = x;
      if (x >= n && y >= m) { found = true; break; }
    }
  }
  // Backtrack through the saved frontiers.
  const script = [];
  let x = n;
  let y = m;
  for (let d = trace.length - 1; d >= 0; d--) {
    const vd = trace[d];
    const at = (kk) => vd[kk + d];
    const k = x - y;
    const prevK = (k === -d || (k !== d && at(k - 1) < at(k + 1))) ? k + 1 : k - 1;
    const prevX = d === 0 ? 0 : at(prevK);
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) { script.push({ op: ' ', a: --x, b: --y }); }
    if (d > 0) {
      if (x === prevX) script.push({ op: '+', a: x, b: --y });
      else script.push({ op: '-', a: --x, b: y });
    }
  }
  return script.reverse();
}

function unifiedDiff(oldText, newText, label) {
  if (oldText === newText) return '';
  const a = oldText.split('\n');
  const b = newText.split('\n');
  // A trailing newline yields an empty last element, which is not a line.
  if (a.length > 1 && b.length > 1 && a[a.length - 1] === '' && b[b.length - 1] === '') { a.pop(); b.pop(); }
  // Trim the shared prefix/suffix first so Myers only sees the changed middle.
  let p = 0;
  while (p < a.length && p < b.length && a[p] === b[p]) p++;
  let s = 0;
  while (s < a.length - p && s < b.length - p && a[a.length - 1 - s] === b[b.length - 1 - s]) s++;
  const oldMid = a.slice(p, a.length - s);
  const newMid = b.slice(p, b.length - s);
  const middle = myersDiff(oldMid, newMid) ?? [
    ...oldMid.map((_, i) => ({ op: '-', a: i, b: 0 })),
    ...newMid.map((_, i) => ({ op: '+', a: oldMid.length, b: i })),
  ];
  const script = [];
  for (let i = 0; i < p; i++) script.push({ op: ' ', a: i, b: i });
  for (const e of middle) script.push({ op: e.op, a: e.a + p, b: e.b + p });
  for (let i = 0; i < s; i++) script.push({ op: ' ', a: a.length - s + i, b: b.length - s + i });

  const lines = [`--- a/${label}`, `+++ b/${label}`];
  let i = 0;
  while (i < script.length) {
    while (i < script.length && script[i].op === ' ') i++;
    if (i >= script.length) break;
    const start = Math.max(0, i - CONTEXT);
    // Extend the hunk until a run of more than 2*CONTEXT unchanged lines.
    let end = i;
    let j = i;
    while (j < script.length) {
      if (script[j].op !== ' ') { end = j; j++; continue; }
      let run = 0;
      while (j + run < script.length && script[j + run].op === ' ') run++;
      if (j + run >= script.length || run > 2 * CONTEXT) break;
      j += run;
    }
    const stop = Math.min(script.length, end + 1 + CONTEXT);
    const hunk = script.slice(start, stop);
    const oldStart = hunk.find(e => e.op !== '+')?.a ?? script[start].a;
    const newStart = hunk.find(e => e.op !== '-')?.b ?? script[start].b;
    const oldLen = hunk.filter(e => e.op !== '+').length;
    const newLen = hunk.filter(e => e.op !== '-').length;
    lines.push(`@@ -${oldStart + 1},${oldLen} +${newStart + 1},${newLen} @@`);
    for (const e of hunk) lines.push(`${e.op}${e.op === '+' ? b[e.b] : a[e.a]}`);
    i = stop;
  }
  return lines.join('\n');
}

export { unifiedDiff };
