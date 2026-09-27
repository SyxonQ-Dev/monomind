const _JSONL_SIZE_CAP = 10 * 1024 * 1024; // 10 MB — skip files larger than this in /api/graph
// Session id format for data/sessions/<id>.jsonl persistence — no path traversal (".."), starts
// with a word char, rest is word chars/dot/dash. Shared by every session-id-accepting endpoint.
const SESSION_ID_RE = /^(?!.*\.\.)[a-zA-Z0-9_][a-zA-Z0-9_.-]*$/;
const buildDocsState = new Map();

export { _JSONL_SIZE_CAP, buildDocsState, SESSION_ID_RE };
