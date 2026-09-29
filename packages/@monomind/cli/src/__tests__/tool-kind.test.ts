/**
 * orgrt/tool-kind.ts: the normalized `kind` on tool_activity start events
 * (rev 19) — Claude Code's tool names and common vendor CLI names.
 */

import { describe, expect, it } from 'vitest';
import { TOOL_KINDS, toolKind } from '../orgrt/tool-kind.js';

describe('toolKind', () => {
  it('maps every Claude Code native tool', () => {
    const cases: Record<string, string> = {
      Bash: 'shell',
      Edit: 'edit',
      MultiEdit: 'edit',
      NotebookEdit: 'edit',
      Write: 'write',
      Read: 'read',
      Glob: 'search',
      Grep: 'search',
      WebFetch: 'web',
      WebSearch: 'web',
      mcp__github__create_issue: 'mcp',
      Task: 'task',
      Agent: 'task',
      TodoWrite: 'todo',
    };
    for (const [name, kind] of Object.entries(cases)) expect(toolKind(name), name).toBe(kind);
  });

  it('maps common vendor names, case- and separator-insensitively', () => {
    const cases: Record<string, string> = {
      shell: 'shell',
      exec_command: 'shell',
      command_execution: 'shell',
      apply_patch: 'patch',
      file_change: 'patch',
      patch: 'patch',
      read_file: 'read',
      ReadFile: 'read',
      write_file: 'write',
      edit: 'edit',
      grep: 'search',
      glob: 'search',
      list: 'search',
      web_search: 'web',
      mcp_tool_call: 'mcp',
      todo_list: 'todo',
    };
    for (const [name, kind] of Object.entries(cases)) expect(toolKind(name), name).toBe(kind);
  });

  it('maps the agy, grok and copilot native names', () => {
    const cases: Record<string, string> = {
      run_command: 'shell',
      view_file: 'read',
      write_to_file: 'write',
      replace_file_content: 'edit',
      grep_search: 'search',
      find_by_name: 'search',
      search_replace: 'edit',
      list_dir: 'search',
      create: 'write',
    };
    for (const [name, kind] of Object.entries(cases)) expect(toolKind(name), name).toBe(kind);
  });

  it('prefers a valid provided kind, ignores an invalid one', () => {
    expect(toolKind('whatever', 'patch')).toBe('patch');
    expect(toolKind('Bash', 'nonsense')).toBe('shell');
  });

  it('falls back to other', () => {
    expect(toolKind('frobnicate')).toBe('other');
    expect(toolKind(undefined)).toBe('other');
    expect(TOOL_KINDS).toContain('other');
  });
});
