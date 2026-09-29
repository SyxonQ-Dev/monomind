// packages/@monomind/cli/src/orgrt/tool-kind.ts
/**
 * Normalized tool kind for `tool_activity` start events (rev 19, doc §3.2):
 * one vocabulary a caller can render by, whatever the runtime calls its
 * tools. A runner that knows the kind sets `AgentMessage.kind`; otherwise
 * the tool name is looked up in NAME_KINDS below.
 *
 * Names are matched case- and separator-insensitively (`read_file`,
 * `ReadFile` and `readFile` are one key), so the table lists each tool once.
 */

export const TOOL_KINDS = [
  'shell',
  'edit',
  'write',
  'read',
  'search',
  'web',
  'mcp',
  'task',
  'todo',
  'patch',
  'other',
] as const;
export type ToolKind = (typeof TOOL_KINDS)[number];

const KIND_SET: ReadonlySet<string> = new Set(TOOL_KINDS);

/** Normalized name → kind. Claude Code's names first, then vendor CLIs'. */
const NAME_KINDS: Record<string, ToolKind> = {
  // Claude Code
  bash: 'shell',
  edit: 'edit',
  multiedit: 'edit',
  notebookedit: 'edit',
  write: 'write',
  read: 'read',
  glob: 'search',
  grep: 'search',
  webfetch: 'web',
  websearch: 'web',
  task: 'task',
  agent: 'task',
  todowrite: 'todo',
  // codex / opencode / kimi / gemini-family / pi / crush / copilot
  shell: 'shell',
  execcommand: 'shell',
  commandexecution: 'shell',
  runshellcommand: 'shell',
  applypatch: 'patch',
  filechange: 'patch',
  patch: 'patch',
  patchapply: 'patch',
  readfile: 'read',
  readmanyfiles: 'read',
  view: 'read',
  writefile: 'write',
  strreplacefile: 'edit',
  replace: 'edit',
  list: 'search',
  ls: 'search',
  listdirectory: 'search',
  searchfilecontent: 'search',
  find: 'search',
  fetch: 'web',
  fetchurl: 'web',
  searchweb: 'web',
  googlewebsearch: 'web',
  mcptoolcall: 'mcp',
  todoread: 'todo',
  settodolist: 'todo',
  updateplan: 'todo',
  todolist: 'todo',
  // antigravity (agy) / grok / copilot / qwen / kimi native names
  powershell: 'shell',
  exec: 'shell',
  runcommand: 'shell',
  runterminalcommand: 'shell',
  editfile: 'edit',
  searchreplace: 'edit',
  strreplace: 'edit',
  strreplaceeditor: 'edit',
  replacefilecontent: 'edit',
  multireplacefilecontent: 'edit',
  create: 'write',
  createfile: 'write',
  writetofile: 'write',
  viewfile: 'read',
  grepsearch: 'search',
  findbyname: 'search',
  rg: 'search',
  listdir: 'search',
  readurlcontent: 'web',
  callmcptool: 'mcp',
  spawnsubagent: 'task',
  invokesubagent: 'task',
  browsersubagent: 'task',
  updatetodo: 'todo',
  // cline (the runner already sets kind; names for name-only lookup)
  runcommands: 'shell',
  editor: 'edit',
  readfiles: 'read',
  searchcodebase: 'search',
  fetchwebcontent: 'web',
  spawnagent: 'task',
  // aider shim / dsh (web_search, bash already above)
  lint: 'shell',
  gitcommit: 'other',
  pwsh: 'shell',
  subagent: 'task',
  subagentfork: 'task',
};

function normalize(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/** The kind for one tool call: `provided` when it is a known kind, else the
 *  name table, else `other`. `mcp__server__tool` names are always `mcp`. */
export function toolKind(name: string | undefined, provided?: string): ToolKind {
  if (provided && KIND_SET.has(provided)) return provided as ToolKind;
  if (!name) return 'other';
  if (name.startsWith('mcp__')) return 'mcp';
  return NAME_KINDS[normalize(name)] ?? 'other';
}
