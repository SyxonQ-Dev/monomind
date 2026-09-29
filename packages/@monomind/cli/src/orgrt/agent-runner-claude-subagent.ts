// packages/@monomind/cli/src/orgrt/agent-runner-claude-subagent.ts

/**
 * #387: one lifecycle step of a native Claude subagent (a `Task`/`Agent` tool
 * call), carried on an `AgentMessage` of type `'subagent'` and forwarded by
 * agent-exec.ts as the protocol's `subagent` event (doc/agent-exec-protocol.md
 * §3.2.1). `id` is the SDK's task_id; `tool_use_id` is the id of the `Task`/
 * `Agent` tool call that started it, i.e. the matching `tool_activity` id.
 */
export interface SubagentEvent {
  phase: 'started' | 'progress' | 'finished';
  id: string;
  tool_use_id: string;
  subagent_type?: string;
  description?: string;
  prompt?: string;
  summary?: string;
  last_tool?: string;
  status?: string;
  /** The SDK's own task usage, passed through as-is — it reports a token
   *  total, not an input/output split, and no cost. */
  usage?: { total_tokens: number; tool_uses: number; duration_ms: number };
}

/**
 * Map the Agent SDK's `system` task messages (`task_started`,
 * `task_progress`, `task_notification`; sdk.d.ts SDKTask*Message) to
 * SubagentEvents. Stateful per turn: a later message may omit `tool_use_id`,
 * so it is remembered from `task_started`; a task that was never started here
 * — no tool call to join to, or an ambient `skip_transcript` housekeeping
 * task — is dropped at every phase. Returns undefined for anything else.
 */
export function createSubagentTracker(): (m: any) => SubagentEvent | undefined {
  const toolUseIds = new Map<string, string>();
  return (m) => {
    if (m?.type !== 'system' || typeof m.task_id !== 'string') return undefined;
    const id: string = m.task_id;
    if (m.subtype === 'task_started') {
      if (typeof m.tool_use_id !== 'string' || m.skip_transcript === true) return undefined;
      toolUseIds.set(id, m.tool_use_id);
      return {
        phase: 'started',
        id,
        tool_use_id: m.tool_use_id,
        ...opt('subagent_type', m.subagent_type),
        ...opt('description', m.description),
        ...opt('prompt', m.prompt),
      };
    }
    const tool_use_id = toolUseIds.get(id);
    if (!tool_use_id) return undefined;
    if (m.subtype === 'task_progress') {
      return {
        phase: 'progress',
        id,
        tool_use_id,
        ...opt('summary', m.summary),
        ...opt('last_tool', m.last_tool_name),
        ...(m.usage ? { usage: m.usage } : {}),
      };
    }
    if (m.subtype === 'task_notification') {
      toolUseIds.delete(id);
      return {
        phase: 'finished',
        id,
        tool_use_id,
        ...opt('status', m.status),
        ...opt('summary', m.summary),
        ...(m.usage ? { usage: m.usage } : {}),
      };
    }
    return undefined;
  };
}

/** `{ [key]: value }` for a non-empty string value, `{}` otherwise. */
function opt(key: string, value: unknown): Record<string, string> {
  return typeof value === 'string' && value ? { [key]: value } : {};
}
