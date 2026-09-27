/**
 * Unit tests for orgrt/tool-activity.ts — the `tool_activity` event builder
 * (#357, doc/agent-exec-protocol.md §3.2). No SDK/CLI involved: exercises
 * ToolActivityTracker directly against AgentMessage-shaped objects, the same
 * shape ClaudeAgentRunner (and the vendor runners) yield.
 */

import { describe, expect, it } from 'vitest';
import type { AgentMessage } from '../orgrt/agent-runner.js';
import { isBridgedToolName, ToolActivityTracker } from '../orgrt/tool-activity.js';

function collector() {
  const events: Record<string, unknown>[] = [];
  return { events, emit: (ev: Record<string, unknown>) => events.push(ev) };
}

describe('isBridgedToolName', () => {
  it('recognizes the mcp__org__ prefix agent-exec.ts registers bridged tools under', () => {
    expect(isBridgedToolName('mcp__org__create_nodes')).toBe(true);
    expect(isBridgedToolName('Bash')).toBe(false);
    expect(isBridgedToolName(undefined)).toBe(false);
  });
});

describe('ToolActivityTracker: native start/end (fidelity "full")', () => {
  it('emits a matched start/end pair correlated by the tool_use id', () => {
    const { events, emit } = collector();
    const t = new ToolActivityTracker(emit, 'full');
    t.onMessage({
      type: 'tool_use',
      tool_use_id: 'toolu_1',
      tool: 'Bash',
      input: { command: 'go test ./...', description: 'Run tests' },
      parent_tool_use_id: null,
    } as AgentMessage);
    t.onMessage({
      type: 'tool_result',
      tool_use_id: 'toolu_1',
      tool: 'Bash',
      is_error: false,
      text: 'ok\n',
      duration_ms: 8123,
    } as AgentMessage);

    expect(events).toEqual([
      {
        v: 1,
        type: 'tool_activity',
        id: 'toolu_1',
        phase: 'start',
        name: 'Bash',
        input: { command: 'go test ./...', description: 'Run tests' },
        parent_tool_use_id: null,
      },
      {
        v: 1,
        type: 'tool_activity',
        id: 'toolu_1',
        phase: 'end',
        name: 'Bash',
        ok: true,
        output: 'ok\n',
        output_truncated: false,
        duration_ms: 8123,
      },
    ]);
  });

  it('Edit carries old_string/new_string on the start event', () => {
    const { events, emit } = collector();
    const t = new ToolActivityTracker(emit, 'full');
    t.onMessage({
      type: 'tool_use',
      tool_use_id: 'toolu_2',
      tool: 'Edit',
      input: { file_path: '/a.ts', old_string: 'foo', new_string: 'bar' },
      parent_tool_use_id: null,
    } as AgentMessage);
    expect(events[0]).toMatchObject({
      phase: 'start',
      name: 'Edit',
      input: { file_path: '/a.ts', old_string: 'foo', new_string: 'bar' },
    });
  });

  it('threads parent_tool_use_id through for subagent nesting', () => {
    const { events, emit } = collector();
    const t = new ToolActivityTracker(emit, 'full');
    t.onMessage({
      type: 'tool_use',
      tool_use_id: 'toolu_3',
      tool: 'Read',
      input: { file_path: '/x' },
      parent_tool_use_id: 'toolu_task_1',
    } as AgentMessage);
    expect(events[0]).toMatchObject({ parent_tool_use_id: 'toolu_task_1' });
  });

  it('skips bridged (mcp__org__*) tool calls entirely — tool_call/tool_result already cover them', () => {
    const { events, emit } = collector();
    const t = new ToolActivityTracker(emit, 'full');
    t.onMessage({
      type: 'tool_use',
      tool_use_id: 'toolu_4',
      tool: 'mcp__org__create_nodes',
      input: { count: 2 },
      parent_tool_use_id: null,
    } as AgentMessage);
    t.onMessage({
      type: 'tool_result',
      tool_use_id: 'toolu_4',
      tool: 'mcp__org__create_nodes',
      is_error: false,
      text: 'created 2 nodes',
    } as AgentMessage);
    expect(events).toHaveLength(0);
  });

  it('a tool_result with no matching open start is ignored', () => {
    const { events, emit } = collector();
    const t = new ToolActivityTracker(emit, 'full');
    t.onMessage({ type: 'tool_result', tool_use_id: 'unknown', text: 'x' } as AgentMessage);
    expect(events).toHaveLength(0);
  });
});

describe('ToolActivityTracker: size caps (§3.2)', () => {
  it('caps a single oversized string field at 16 KiB and flags it', () => {
    const { events, emit } = collector();
    const t = new ToolActivityTracker(emit, 'full');
    const huge = 'x'.repeat(20 * 1024);
    t.onMessage({
      type: 'tool_use',
      tool_use_id: 'toolu_5',
      tool: 'Edit',
      input: { file_path: '/a.ts', old_string: huge, new_string: 'y' },
      parent_tool_use_id: null,
    } as AgentMessage);
    const ev = events[0] as any;
    expect(Buffer.byteLength(ev.input.old_string, 'utf8')).toBe(16 * 1024);
    expect(ev.input.old_string_truncated).toBe(true);
    expect(ev.input.new_string).toBe('y');
    expect(ev.input.new_string_truncated).toBeUndefined();
  });

  it('caps nested MultiEdit-style edits arrays recursively', () => {
    const { events, emit } = collector();
    const t = new ToolActivityTracker(emit, 'full');
    const huge = 'x'.repeat(20 * 1024);
    t.onMessage({
      type: 'tool_use',
      tool_use_id: 'toolu_6',
      tool: 'MultiEdit',
      input: {
        file_path: '/a.ts',
        edits: [
          { old_string: huge, new_string: 'short' },
          { old_string: 'short', new_string: 'short' },
        ],
      },
      parent_tool_use_id: null,
    } as AgentMessage);
    const ev = events[0] as any;
    expect(ev.input.edits[0].old_string_truncated).toBe(true);
    expect(Buffer.byteLength(ev.input.edits[0].old_string, 'utf8')).toBe(16 * 1024);
    expect(ev.input.edits[1].old_string_truncated).toBeUndefined();
  });

  it('caps output at 16 KiB and flags output_truncated', () => {
    const { events, emit } = collector();
    const t = new ToolActivityTracker(emit, 'full');
    t.onMessage({
      type: 'tool_use',
      tool_use_id: 'toolu_7',
      tool: 'Bash',
      input: { command: 'yes' },
      parent_tool_use_id: null,
    } as AgentMessage);
    const huge = 'y'.repeat(20 * 1024);
    t.onMessage({
      type: 'tool_result',
      tool_use_id: 'toolu_7',
      tool: 'Bash',
      is_error: false,
      text: huge,
    } as AgentMessage);
    const end = events[1] as any;
    expect(Buffer.byteLength(end.output, 'utf8')).toBe(16 * 1024);
    expect(end.output_truncated).toBe(true);
  });

  it('keeps the whole event well under 64 KiB even for a pathologically large MultiEdit', () => {
    const { events, emit } = collector();
    const t = new ToolActivityTracker(emit, 'full');
    const field = 'x'.repeat(16 * 1024); // each field individually at the per-field cap
    const edits = Array.from({ length: 20 }, () => ({ old_string: field, new_string: field }));
    t.onMessage({
      type: 'tool_use',
      tool_use_id: 'toolu_8',
      tool: 'MultiEdit',
      input: { file_path: '/a.ts', edits },
      parent_tool_use_id: null,
    } as AgentMessage);
    const size = Buffer.byteLength(JSON.stringify(events[0]), 'utf8');
    expect(size).toBeLessThan(64 * 1024);
    expect((events[0] as any).input).toEqual({ truncated: true });
  });
});

describe('ToolActivityTracker: message-stream-driven, not canUseTool-driven', () => {
  // #355's --access full runs the SDK with permissionMode:'bypassPermissions',
  // under which canUseTool is shadowed and never invoked at all. Start/end
  // pairing must still work from the message stream alone, with ok derived
  // from the real tool_result — no denied field, since wrapCanUseTool was
  // never called to record one.
  it('pairs start/end correctly even when wrapCanUseTool is never invoked', () => {
    const { events, emit } = collector();
    const t = new ToolActivityTracker(emit, 'full');
    // No call to t.wrapCanUseTool(...) anywhere in this test.
    t.onMessage({
      type: 'tool_use',
      tool_use_id: 'toolu_full',
      tool: 'Bash',
      input: { command: 'rm -rf /tmp/scratch' },
      parent_tool_use_id: null,
    } as AgentMessage);
    t.onMessage({
      type: 'tool_result',
      tool_use_id: 'toolu_full',
      tool: 'Bash',
      is_error: false,
      text: 'removed\n',
    } as AgentMessage);
    expect(events[1]).toMatchObject({ phase: 'end', ok: true });
    expect(events[1]).not.toHaveProperty('denied');
  });
});

describe('ToolActivityTracker: denial (scoped mode)', () => {
  it('wrapCanUseTool records a deny by id and onToolResult reports denied:true, ok:false', async () => {
    const { events, emit } = collector();
    const t = new ToolActivityTracker(emit, 'full');
    const rawCanUseTool = async (_toolName: string, _input: Record<string, unknown>) => ({
      behavior: 'deny' as const,
      message: 'not allowed',
    });
    const wrapped = t.wrapCanUseTool(rawCanUseTool);
    await wrapped('Bash', { command: 'rm -rf /' }, { toolUseId: 'toolu_9' });

    t.onMessage({
      type: 'tool_use',
      tool_use_id: 'toolu_9',
      tool: 'Bash',
      input: { command: 'rm -rf /' },
      parent_tool_use_id: null,
    } as AgentMessage);
    t.onMessage({
      type: 'tool_result',
      tool_use_id: 'toolu_9',
      tool: 'Bash',
      is_error: true,
      text: 'not allowed',
    } as AgentMessage);

    expect(events[1]).toMatchObject({ phase: 'end', ok: false, denied: true });
  });

  it('does not mark denied when the decision allows', async () => {
    const { events, emit } = collector();
    const t = new ToolActivityTracker(emit, 'full');
    const rawCanUseTool = async () => ({ behavior: 'allow' as const, updatedInput: {} });
    const wrapped = t.wrapCanUseTool(rawCanUseTool);
    await wrapped('Bash', { command: 'ls' }, { toolUseId: 'toolu_10' });

    t.onMessage({
      type: 'tool_use',
      tool_use_id: 'toolu_10',
      tool: 'Bash',
      input: { command: 'ls' },
      parent_tool_use_id: null,
    } as AgentMessage);
    t.onMessage({
      type: 'tool_result',
      tool_use_id: 'toolu_10',
      tool: 'Bash',
      is_error: false,
      text: 'a.ts\n',
    } as AgentMessage);

    expect(events[1]).toMatchObject({ phase: 'end', ok: true });
    expect(events[1]).not.toHaveProperty('denied');
  });
});

describe('ToolActivityTracker: cancel/timeout closes in-flight ids', () => {
  it('closeInFlight emits ok:false, cancelled:true for a start with no end yet', () => {
    const { events, emit } = collector();
    const t = new ToolActivityTracker(emit, 'full');
    t.onMessage({
      type: 'tool_use',
      tool_use_id: 'toolu_11',
      tool: 'Bash',
      input: { command: 'sleep 100' },
      parent_tool_use_id: null,
    } as AgentMessage);
    t.closeInFlight();
    expect(events[1]).toEqual({
      v: 1,
      type: 'tool_activity',
      id: 'toolu_11',
      phase: 'end',
      name: 'Bash',
      ok: false,
      cancelled: true,
    });
  });

  it('does not re-close an id that already got a real end', () => {
    const { events, emit } = collector();
    const t = new ToolActivityTracker(emit, 'full');
    t.onMessage({
      type: 'tool_use',
      tool_use_id: 'toolu_12',
      tool: 'Bash',
      input: {},
      parent_tool_use_id: null,
    } as AgentMessage);
    t.onMessage({
      type: 'tool_result',
      tool_use_id: 'toolu_12',
      tool: 'Bash',
      is_error: false,
      text: 'done',
    } as AgentMessage);
    t.closeInFlight();
    expect(events).toHaveLength(2); // start + real end, no synthetic cancel
  });
});

describe('ToolActivityTracker: vendor lightweight mapping (fidelity "start-only"/"none")', () => {
  it('maps a lightweight {type:"tool_use", text} signal to a start-only event with a synthetic id', () => {
    const { events, emit } = collector();
    const t = new ToolActivityTracker(emit, 'start-only');
    t.onMessage({ type: 'tool_use', text: 'shell' } as AgentMessage);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: 'tool_activity',
      phase: 'start',
      name: 'shell',
      input: null,
      parent_tool_use_id: null,
    });
    expect(typeof (events[0] as any).id).toBe('string');
  });

  it('never emits for a runtime with no real per-tool signal (fidelity "none")', () => {
    const { events, emit } = collector();
    const t = new ToolActivityTracker(emit, 'none');
    t.onMessage({ type: 'tool_use', text: 'turn started' } as AgentMessage);
    expect(events).toHaveLength(0);
  });
});

describe('ToolActivityTracker.toolCallCount (#360 full-access audit)', () => {
  it('counts one native "start" per tool_use, unaffected by its matching tool_result', () => {
    const { emit } = collector();
    const t = new ToolActivityTracker(emit, 'full');
    expect(t.toolCallCount).toBe(0);
    t.onMessage({
      type: 'tool_use',
      tool_use_id: 'toolu_1',
      tool: 'Bash',
      input: {},
      parent_tool_use_id: null,
    } as AgentMessage);
    expect(t.toolCallCount).toBe(1);
    t.onMessage({
      type: 'tool_result',
      tool_use_id: 'toolu_1',
      tool: 'Bash',
      is_error: false,
      text: '',
    } as AgentMessage);
    expect(t.toolCallCount).toBe(1);
    t.onMessage({
      type: 'tool_use',
      tool_use_id: 'toolu_2',
      tool: 'Write',
      input: {},
      parent_tool_use_id: null,
    } as AgentMessage);
    expect(t.toolCallCount).toBe(2);
  });

  it('does not count a bridged (mcp__org__*) tool_use — those are §4 tool_call/tool_result, not native activity', () => {
    const { emit } = collector();
    const t = new ToolActivityTracker(emit, 'full');
    t.onMessage({
      type: 'tool_use',
      tool_use_id: 'toolu_1',
      tool: 'mcp__org__create_nodes',
      input: {},
      parent_tool_use_id: null,
    } as AgentMessage);
    expect(t.toolCallCount).toBe(0);
  });

  it('counts a vendor lightweight start-only signal', () => {
    const { emit } = collector();
    const t = new ToolActivityTracker(emit, 'start-only');
    t.onMessage({ type: 'tool_use', text: 'shell' } as AgentMessage);
    t.onMessage({ type: 'tool_use', text: 'edit' } as AgentMessage);
    expect(t.toolCallCount).toBe(2);
  });

  it('never counts anything for fidelity "none"', () => {
    const { emit } = collector();
    const t = new ToolActivityTracker(emit, 'none');
    t.onMessage({ type: 'tool_use', text: 'turn started' } as AgentMessage);
    expect(t.toolCallCount).toBe(0);
  });
});
