/**
 * Monoswarm coordination tools: monoswarm_notice, monoswarm_memory,
 * monoswarm_audit_list, monoswarm_audit_verify.
 *
 * Registered through `monoswarmTools` in monoswarm-tools.ts, which keeps the
 * registration order; see that module for what these tools do and do not do.
 */

import { join } from 'node:path';
import {
  getOrCreateAuditKey,
  loadMonoswarmState,
  RESERVED_KEYS,
  saveMonoswarmState,
} from './monoswarm-state.js';
import { getProjectCwd, type MCPTool } from './types.js';

export const monoswarmCoordinationTools: MCPTool[] = [
  {
    name: 'monoswarm_notice',
    description:
      'Append a message to a shared array in the state file — a noticeboard, not message delivery; nothing subscribes to it.',
    category: 'monoswarm',
    inputSchema: {
      type: 'object',
      properties: {
        message: { type: 'string', description: 'Notice text' },
        priority: {
          type: 'string',
          enum: ['low', 'normal', 'high', 'critical'],
          description: 'Notice priority',
        },
        fromId: { type: 'string', description: 'Sender agent ID' },
      },
      required: ['message'],
    },
    handler: async (input) => {
      const state = loadMonoswarmState();

      if (!state.initialized) {
        return { success: false, error: 'Monoswarm not initialized' };
      }

      const MAX_MSG_LEN = 1024 * 1024; // 1 MB
      const MAX_FROM_ID_LEN = 256;
      const MAX_PRIORITY_LEN = 16;
      const rawMessage = input.message as string;
      const message =
        typeof rawMessage === 'string' && rawMessage.length > MAX_MSG_LEN
          ? rawMessage.slice(0, MAX_MSG_LEN)
          : rawMessage;
      const rawFromId = (input.fromId as string) || 'system';
      const fromId =
        typeof rawFromId === 'string' && rawFromId.length > MAX_FROM_ID_LEN
          ? rawFromId.slice(0, MAX_FROM_ID_LEN)
          : rawFromId;
      const rawPriority = (input.priority as string) || 'normal';
      const priority =
        typeof rawPriority === 'string' && rawPriority.length > MAX_PRIORITY_LEN
          ? rawPriority.slice(0, MAX_PRIORITY_LEN)
          : rawPriority;

      const noticeId = `notice-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

      state.notices.push({
        noticeId,
        message,
        priority,
        fromId,
        timestamp: new Date().toISOString(),
      });
      state.notices = state.notices.slice(-100); // Keep only the last 100 notices

      saveMonoswarmState(state);

      return {
        success: true,
        noticeId,
        recipients: state.agents.length,
        priority,
        postedAt: new Date().toISOString(),
      };
    },
  },
  {
    name: 'monoswarm_memory',
    description:
      'Plain key/value bookkeeping in the state file — not a distributed or replicated store.',
    category: 'monoswarm',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['get', 'set', 'delete', 'list'],
          description: 'Memory action',
        },
        key: { type: 'string', description: 'Memory key' },
        value: { description: 'Value to store (for set)' },
      },
      required: ['action'],
    },
    handler: async (input) => {
      const state = loadMonoswarmState();
      const action = input.action as string;
      const key = input.key as string;

      const MAX_KEY_LEN = 256;
      const MAX_VALUE_BYTES = 1024 * 1024; // 1 MB
      const MAX_KEYS = 1000;

      if (action === 'get') {
        if (!key) return { action, error: 'Key required' };
        if (typeof key !== 'string' || key.length > MAX_KEY_LEN || RESERVED_KEYS.has(key)) {
          return { action, error: 'Invalid key' };
        }
        return {
          action,
          key,
          value: Object.hasOwn(state.sharedMemory, key) ? state.sharedMemory[key] : undefined,
          exists: Object.hasOwn(state.sharedMemory, key),
        };
      }

      if (action === 'set') {
        if (!key) return { action, error: 'Key required' };
        if (typeof key !== 'string' || key.length > MAX_KEY_LEN || RESERVED_KEYS.has(key)) {
          return { action, error: 'Invalid key' };
        }
        const rawValue = input.value;
        const cappedValue =
          typeof rawValue === 'string' && rawValue.length > MAX_VALUE_BYTES
            ? rawValue.slice(0, MAX_VALUE_BYTES)
            : rawValue;
        const keyCount = Object.keys(state.sharedMemory).length;
        if (!Object.hasOwn(state.sharedMemory, key) && keyCount >= MAX_KEYS) {
          return { action, error: `Shared memory full (max ${MAX_KEYS} keys)` };
        }
        state.sharedMemory[key] = cappedValue;
        saveMonoswarmState(state);

        try {
          const bridge = await import('../memory/memory-bridge.js');
          await bridge.bridgeStoreEntry({
            key: `monoswarm-memory-${key}`,
            value: JSON.stringify(input.value),
            namespace: 'monoswarm-memory',
          });
        } catch {
          /* SQLite memory backend not available */
        }

        return { action, key, success: true, updatedAt: new Date().toISOString() };
      }

      if (action === 'delete') {
        if (!key) return { action, error: 'Key required' };
        if (typeof key !== 'string' || key.length > MAX_KEY_LEN || RESERVED_KEYS.has(key)) {
          return { action, error: 'Invalid key' };
        }
        const existed = Object.hasOwn(state.sharedMemory, key);
        delete state.sharedMemory[key];
        saveMonoswarmState(state);
        return { action, key, deleted: existed };
      }

      if (action === 'list') {
        return {
          action,
          keys: Object.keys(state.sharedMemory),
          count: Object.keys(state.sharedMemory).length,
        };
      }

      return { action, error: 'Unknown action' };
    },
  },
  {
    name: 'monoswarm_audit_list',
    description:
      'List tamper-evident vote audit records (HMAC-signed JSONL trail) — local file, not a distributed ledger.',
    category: 'monoswarm',
    inputSchema: {
      type: 'object',
      properties: {
        swarmId: { type: 'string', description: 'Filter by monoswarm ID (optional)' },
        limit: { type: 'number', description: 'Max records to return (default: 50, max: 500)' },
      },
    },
    handler: async (input) => {
      try {
        const { AuditWriter } = await import('../consensus/audit-writer.js');
        const auditDir = join(getProjectCwd(), '.monomind', 'consensus');
        const writer = new AuditWriter(auditDir);
        const limit = Math.min(Math.max(1, (input.limit as number) || 50), 500);
        const swarmId = input.swarmId as string | undefined;
        const records = writer.listDecisions(swarmId, limit);
        return {
          success: true,
          count: records.length,
          records: records.map((r) => ({
            decisionId: r.decisionId,
            swarmId: r.swarmId,
            protocol: r.protocol,
            topic: r.topic,
            decision: r.decision,
            voteCount: r.votes.length,
            quorumAchieved: r.quorumAchieved,
            round: r.round,
            durationMs: r.durationMs,
            completedAt: r.completedAt,
            signed: !!r.recordSignature,
          })),
        };
      } catch (e) {
        return { success: false, error: `Audit trail unavailable: ${(e as Error).message}` };
      }
    },
  },
  {
    name: 'monoswarm_audit_verify',
    description:
      'Verify tamper-evidence of a vote decision (checks HMAC signatures on all votes and the record itself) — a local file check, not a distributed ledger.',
    category: 'monoswarm',
    inputSchema: {
      type: 'object',
      properties: {
        decisionId: { type: 'string', description: 'Decision/proposal ID to verify' },
      },
      required: ['decisionId'],
    },
    handler: async (input) => {
      const hk = getOrCreateAuditKey();
      const decisionId = input.decisionId as string;
      if (typeof decisionId !== 'string' || decisionId.length === 0 || decisionId.length > 256) {
        return { success: false, error: 'Invalid decisionId' };
      }
      try {
        const { AuditWriter } = await import('../consensus/audit-writer.js');
        const auditDir = join(getProjectCwd(), '.monomind', 'consensus');
        const writer = new AuditWriter(auditDir);
        const result = writer.verifyDecision(decisionId, hk);
        return {
          success: true,
          decisionId,
          valid: result.valid,
          invalidVotes: result.invalidVotes,
          message: result.valid
            ? 'All vote signatures and record signature verified — no tampering detected.'
            : `Verification failed: ${result.invalidVotes.length} invalid vote(s) or record signature mismatch.`,
        };
      } catch (e) {
        return { success: false, error: `Audit verification failed: ${(e as Error).message}` };
      }
    },
  },
];
