/**
 * Anonymous closures (`() => {`, `async (req) => {`, `function () {`) become
 * Function/Method nodes named after their first source line, since they have
 * no name field. They stay in the graph — CALLS edges are attributed to the
 * innermost enclosing callable, closures included — but they are noise on
 * name-based surfaces: search results and god-node rankings (#404).
 */

/** Labels an anonymous closure (or the Process node derived from one) can carry. */
const CLOSURE_LABELS = ['Function', 'Method', 'Process'];

const ANONYMOUS_NAME_RE = /=>|^\s*(async\s*)?(function\s*\*?\s*)?\(/;

export function isAnonymousClosure(node: { label: string; name: string }): boolean {
  return CLOSURE_LABELS.includes(node.label) && ANONYMOUS_NAME_RE.test(node.name);
}

/** SQL twin of {@link isAnonymousClosure} for a `nodes` table aliased `n`. */
export const NOT_ANONYMOUS_CLOSURE_SQL = `NOT (n.label IN (${CLOSURE_LABELS.map((l) => `'${l}'`).join(', ')}) AND (
  n.name LIKE '%=>%' OR ltrim(n.name) LIKE '(%'
  OR ltrim(n.name) LIKE 'async(%' OR ltrim(n.name) LIKE 'async (%'
  OR ltrim(n.name) LIKE 'function(%' OR ltrim(n.name) LIKE 'function (%'
  OR ltrim(n.name) LIKE 'function*%(%' OR ltrim(n.name) LIKE 'async function%(%'))`;
