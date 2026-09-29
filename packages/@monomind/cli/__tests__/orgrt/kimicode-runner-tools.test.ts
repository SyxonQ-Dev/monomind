/**
 * The vendor runners' native-tool helper (kimicode-runner-tools.ts): native
 * name → contract kind, native argument shapes → canonical inputs, and the
 * start/end pairing ToolActivityTracker turns into tool_activity events.
 */
import { describe, expect, it } from 'vitest';
import type { AgentMessage } from '../../src/orgrt/agent-runner.js';
import {
  canonicalTool,
  messageBlocks,
  NativeToolCalls,
  toolKind,
  toolOutputText,
} from '../../src/orgrt/kimicode-runner-tools.js';
import { ToolActivityTracker } from '../../src/orgrt/tool-activity.js';

describe('toolKind', () => {
  it('maps each CLI’s native names to the contract kinds', () => {
    expect(toolKind('run_command')).toBe('shell'); // agy
    expect(toolKind('Bash')).toBe('shell'); // kimi
    expect(toolKind('run_shell_command')).toBe('shell'); // qwen
    expect(toolKind('bash')).toBe('shell'); // grok, copilot, pi
    expect(toolKind('replace_file_content')).toBe('edit');
    expect(toolKind('search_replace')).toBe('edit');
    expect(toolKind('write_to_file')).toBe('write');
    expect(toolKind('create')).toBe('write');
    expect(toolKind('view_file')).toBe('read');
    expect(toolKind('grep_search')).toBe('search');
    expect(toolKind('search_web')).toBe('web');
    expect(toolKind('mcp__github__list_issues')).toBe('mcp');
    expect(toolKind('todo_write')).toBe('todo');
    expect(toolKind('Agent')).toBe('task');
    expect(toolKind('apply_patch')).toBe('patch');
    expect(toolKind('list_dir')).toBe('other');
  });
});

describe('canonicalTool', () => {
  it('shell: {command, description?, cwd?} from each native spelling', () => {
    expect(canonicalTool('run_command', { CommandLine: 'ls', Cwd: '/w' })).toEqual({
      kind: 'shell',
      input: { command: 'ls', cwd: '/w' },
    });
    expect(
      canonicalTool('run_shell_command', { command: 'ls', description: 'list', directory: '/d' }),
    ).toEqual({ kind: 'shell', input: { command: 'ls', description: 'list', cwd: '/d' } });
  });

  it('edit: {file_path, old_string, new_string} from agy, kimi and pi shapes', () => {
    expect(
      canonicalTool('replace_file_content', {
        TargetFile: '/a.ts',
        TargetContent: 'x',
        ReplacementContent: 'y',
      }),
    ).toEqual({ kind: 'edit', input: { file_path: '/a.ts', old_string: 'x', new_string: 'y' } });
    expect(canonicalTool('Edit', { path: 'a.ts', old_string: 'x', new_string: 'y' }).input).toEqual({
      file_path: 'a.ts',
      old_string: 'x',
      new_string: 'y',
    });
    expect(canonicalTool('edit', { path: 'a.ts', edits: [{ oldText: 'x', newText: 'y' }] })).toEqual({
      kind: 'edit',
      input: { file_path: 'a.ts', old_string: 'x', new_string: 'y' },
    });
  });

  it('a multi-edit becomes a patch on that file rather than a partial edit', () => {
    expect(
      canonicalTool('multi_replace_file_content', {
        TargetFile: '/a.ts',
        ReplacementChunks: [{ TargetContent: 'a' }, { TargetContent: 'b' }],
      }),
    ).toEqual({ kind: 'patch', input: { files: [{ file_path: '/a.ts', action: 'update' }] } });
  });

  it('write/read/search/web/mcp canonical keys', () => {
    expect(canonicalTool('write_to_file', { TargetFile: '/b', CodeContent: 'hi' })).toEqual({
      kind: 'write',
      input: { file_path: '/b', content: 'hi' },
    });
    expect(canonicalTool('view_file', { AbsolutePath: '/a' })).toEqual({
      kind: 'read',
      input: { file_path: '/a' },
    });
    expect(canonicalTool('grep_search', { Query: 'foo', SearchPath: '/src' })).toEqual({
      kind: 'search',
      input: { pattern: 'foo', path: '/src' },
    });
    expect(canonicalTool('read_url_content', { Url: 'https://x' })).toEqual({
      kind: 'web',
      input: { url: 'https://x' },
    });
    expect(
      canonicalTool('call_mcp_tool', { ServerName: 'gh', ToolName: 'get', Arguments: { n: 1 } }),
    ).toEqual({ kind: 'mcp', input: { server: 'gh', tool: 'get', arguments: { n: 1 } } });
    expect(canonicalTool('mcp__gh__get', { n: 1 })).toEqual({
      kind: 'mcp',
      input: { server: 'gh', tool: 'get', arguments: { n: 1 } },
    });
  });

  it('patch: the files of an apply_patch envelope (copilot, live shape)', () => {
    const value =
      '*** Begin Patch\n*** Add File: b.txt\n+hi\n*** Update File: a.txt\n@@\n-x\n+y\n*** Delete File: c.txt\n*** End Patch\n';
    expect(canonicalTool('apply_patch', { value })).toEqual({
      kind: 'patch',
      input: {
        files: [
          { file_path: 'b.txt', action: 'add', diff: '+hi' },
          { file_path: 'a.txt', action: 'update', diff: '@@\n-x\n+y' },
          { file_path: 'c.txt', action: 'delete' },
        ],
      },
    });
  });

  it('parses a JSON-string argument payload (OpenAI-style function.arguments)', () => {
    expect(canonicalTool('Bash', '{"command":"pwd"}')).toEqual({
      kind: 'shell',
      input: { command: 'pwd' },
    });
  });

  it('falls back to kind "other" with the raw input when a required key is missing', () => {
    expect(canonicalTool('bash', { script: 'ls' })).toEqual({
      kind: 'other',
      input: { script: 'ls' },
    });
  });
});

describe('toolOutputText', () => {
  it('reads strings, content-block arrays and {content} wrappers', () => {
    expect(toolOutputText('ok')).toBe('ok');
    expect(toolOutputText([{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }])).toBe('a\nb');
    expect(toolOutputText({ content: [{ type: 'text', text: 'c' }] })).toBe('c');
    expect(toolOutputText(undefined)).toBe('');
  });
});

describe('messageBlocks', () => {
  it('splits an Anthropic-Messages content array into text, tool_use and tool_result', () => {
    const r = messageBlocks([
      { type: 'text', text: 'Reading.' },
      { type: 'tool_use', id: 'call_1', name: 'read_file', input: { path: 'a' } },
      { type: 'tool_result', tool_use_id: 'call_0', content: 'x', is_error: true },
    ]);
    expect(r.text).toBe('Reading.');
    expect(r.toolUses).toEqual([{ id: 'call_1', name: 'read_file', input: { path: 'a' } }]);
    expect(r.toolResults).toEqual([{ id: 'call_0', output: 'x', isError: true }]);
  });
});

describe('NativeToolCalls → ToolActivityTracker', () => {
  function track(msgs: AgentMessage[]) {
    const events: Record<string, unknown>[] = [];
    const t = new ToolActivityTracker((ev) => events.push(ev), 'full');
    for (const m of msgs) t.onMessage(m);
    return events;
  }

  it('produces a matched start/end pair with the canonical input and the native name', () => {
    const calls = new NativeToolCalls();
    const start = calls.start('c1', 'run_command', { CommandLine: 'ls' }, 's1');
    expect(start).toMatchObject({ type: 'tool_use', tool_use_id: 'c1', tool: 'run_command', kind: 'shell' });
    const end = calls.end('c1', 'a.txt\n', false, 's1');
    const events = track([start as AgentMessage, ...end]);
    expect(events).toEqual([
      expect.objectContaining({
        phase: 'start',
        id: 'c1',
        name: 'run_command',
        input: { command: 'ls' },
      }),
      expect.objectContaining({ phase: 'end', id: 'c1', ok: true, output: 'a.txt\n' }),
    ]);
  });

  it('ignores a repeated start and an end for an unknown id without a fallback', () => {
    const calls = new NativeToolCalls();
    expect(calls.start('c1', 'bash', { command: 'ls' })).not.toBeNull();
    expect(calls.start('c1', 'bash', { command: 'ls' })).toBeNull();
    expect(calls.end('nope', '', false)).toEqual([]);
  });

  it('synthesizes the start for an end whose start never arrived', () => {
    const calls = new NativeToolCalls();
    const msgs = calls.end('c9', 'done', true, undefined, { name: 'Write', rawInput: { path: 'x', content: 'y' } });
    expect(msgs.map((m) => m.type)).toEqual(['tool_use', 'tool_result']);
    const events = track(msgs);
    expect(events[0]).toMatchObject({ phase: 'start', input: { file_path: 'x', content: 'y' } });
    expect(events[1]).toMatchObject({ phase: 'end', ok: false, output: 'done' });
  });
});
