import path from 'node:path';

// Codex `apply_patch` exposes the raw patch in `tool_input.command`, not
// `tool_input.file_path`. Claude Code may send both; parse the patch body
// so we can scan the file(s) the tool actually touched.
// https://developers.openai.com/codex/hooks#posttooluse
const APPLY_PATCH_FILE_RE = /^\*\*\* (?:Update|Add) File: (.+)$/gm;

export function parseApplyPatchPaths(command, projectCwd) {
  if (!command || typeof command !== 'string') return [];
  const out = [];
  for (const m of command.matchAll(APPLY_PATCH_FILE_RE)) {
    let p = (m[1] || '').trim();
    if (!p) continue;
    if (!path.isAbsolute(p)) p = path.resolve(projectCwd, p);
    out.push(p);
  }
  return out;
}

export function resolveTargetFiles(event, projectCwd) {
  const ti = event?.tool_input;
  const out = [];
  const add = (filePath) => {
    if (typeof filePath !== 'string' || !filePath) return;
    if (!out.includes(filePath)) out.push(filePath);
  };

  if (event?.tool_name === 'apply_patch' && ti && typeof ti.command === 'string') {
    for (const filePath of parseApplyPatchPaths(ti.command, projectCwd)) add(filePath);
  }
  if (ti && typeof ti.file_path === 'string' && ti.file_path) {
    add(ti.file_path);
  }
  // Cursor Write / StrReplace use `path`, not `file_path`.
  if (ti && typeof ti.path === 'string' && ti.path) {
    add(ti.path);
  }
  if (typeof event?.file_path === 'string' && event.file_path) {
    add(event.file_path);
  }
  return out;
}

export function resolveHarness(env = {}, event = null) {
  const explicit = env?.MONODESIGN_HOOK_HARNESS;
  if (explicit === 'cursor') return 'cursor';
  if (explicit === 'github') return 'github';
  if (explicit === 'claude' || explicit === 'codex') return 'claude';
  // GitHub Copilot's postToolUse event uses camelCase `toolName`/`toolArgs` and
  // has no `tool_name`/`tool_input`. That shape is the discriminator.
  if (event && typeof event === 'object'
    && (typeof event.toolName === 'string' || event.toolArgs !== undefined)
    && event.tool_name === undefined && event.tool_input === undefined) {
    return 'github';
  }
  if (typeof event?.conversation_id === 'string' && event.conversation_id) return 'cursor';
  return 'claude';
}

// GitHub Copilot's postToolUse payload is
//   { sessionId, timestamp, cwd, toolName, toolArgs, toolResult }
// mapped onto the internal `{ tool_name, tool_input, cwd, session_id }` shape.
// `toolArgs` shape depends on the tool: the `edit`/`create`/`view` tools send a
// JSON *string* (double-encoded) carrying the file under `path`, e.g.
//   "{\"path\":\"/abs/app.tsx\",\"old_str\":\"...\",\"new_str\":\"...\"}",
// while `apply_patch` sends a raw OpenAI-format patch string (handled below in
// normalizeGitHubEvent). The detector reads the file from disk after the tool
// ran, so only the path (not the proposed content) is needed here.
export function parseGitHubToolArgs(toolArgs) {
  if (toolArgs && typeof toolArgs === 'object' && !Array.isArray(toolArgs)) return toolArgs;
  if (typeof toolArgs === 'string' && toolArgs.trim()) {
    try {
      const parsed = JSON.parse(toolArgs);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch {
      return {};
    }
  }
  return {};
}

// Copilot's `apply_patch` tool (used by interactive sessions and the cloud
// agent) sends a raw OpenAI-format patch string in toolArgs, not JSON:
//   *** Begin Patch
//   *** Add File: /abs/app.css
//   +body { ... }
//   *** End Patch
// The `view`/`edit`/`create` tools (seen in `copilot -p` runs) instead send a
// JSON string with the path under `path`. Both must map onto the internal shape.
const APPLY_PATCH_MARKER = /\*\*\* (?:Begin Patch|Add File:|Update File:|Delete File:)/;

function looksLikeApplyPatch(rawArgs) {
  if (typeof rawArgs !== 'string' || !APPLY_PATCH_MARKER.test(rawArgs)) return false;
  // Guard against an edit/create payload whose edited *content* happens to
  // contain patch markers: that payload is a JSON object string, whereas a real
  // apply_patch payload is a raw patch string that does not parse as JSON. Only
  // treat non-JSON-object strings as apply_patch so edit events still get their
  // `path` extracted.
  try {
    const parsed = JSON.parse(rawArgs);
    if (parsed && typeof parsed === 'object') return false;
  } catch { /* not JSON → genuine raw patch */ }
  return true;
}

function applyPatchText(rawArgs) {
  if (typeof rawArgs === 'string') {
    if (APPLY_PATCH_MARKER.test(rawArgs)) return rawArgs;
    // Defensive: a future Copilot build might JSON-wrap the patch.
    const parsed = parseGitHubToolArgs(rawArgs);
    return parsed.patch || parsed.input || parsed.command || '';
  }
  if (rawArgs && typeof rawArgs === 'object' && !Array.isArray(rawArgs)) {
    return rawArgs.patch || rawArgs.input || rawArgs.command || '';
  }
  return '';
}

function normalizeGitHubEvent(event, projectCwd) {
  const cwd = event.cwd || envProjectDir(projectCwd) || projectCwd;
  const sessionId = event.sessionId || event.session_id || 'unknown';
  const toolName = event.toolName || event.tool_name || null;
  const toolInput = event.tool_input && typeof event.tool_input === 'object' ? { ...event.tool_input } : {};
  const rawArgs = event.toolArgs;

  let normalizedToolName = toolName;
  if (toolName === 'apply_patch' || looksLikeApplyPatch(rawArgs)) {
    // resolveTargetFiles() reads the touched paths from tool_input.command when
    // tool_name is 'apply_patch', so normalize the name even if a future build
    // sends the patch under a different tool label.
    const patch = applyPatchText(rawArgs);
    if (patch) {
      toolInput.command = patch;
      normalizedToolName = 'apply_patch';
    }
  } else {
    const args = parseGitHubToolArgs(rawArgs);
    const filePath = args.path || args.file_path || args.filePath || args.target_file;
    if (typeof filePath === 'string' && filePath) toolInput.file_path = filePath;
  }

  return {
    ...event,
    cwd,
    session_id: sessionId,
    tool_name: normalizedToolName,
    tool_input: toolInput,
  };
}

export function normalizeHookEvent(event, projectCwd, harness = 'claude') {
  if (!event || typeof event !== 'object') return event;
  if (harness === 'github') return normalizeGitHubEvent(event, projectCwd);
  if (harness !== 'cursor') return event;

  const cwd = event.cwd
    || (Array.isArray(event.workspace_roots) && event.workspace_roots[0])
    || envProjectDir(projectCwd)
    || projectCwd;
  const sessionId = event.session_id || event.conversation_id || 'unknown';

  const ti = event.tool_input && typeof event.tool_input === 'object' ? event.tool_input : {};
  const filePath = ti.file_path || ti.path || event.file_path;
  if (filePath) {
    return {
      ...event,
      cwd,
      session_id: sessionId,
      tool_input: { ...ti, file_path: filePath },
    };
  }

  return { ...event, cwd, session_id: sessionId };
}

export function envProjectDir(fallback) {
  if (typeof process.env.CURSOR_PROJECT_DIR === 'string' && process.env.CURSOR_PROJECT_DIR) {
    return process.env.CURSOR_PROJECT_DIR;
  }
  return fallback;
}
