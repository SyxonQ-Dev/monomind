// packages/@monomind/cli/src/commands/org-subcommands-hil.ts
//
// `monomind org` human-in-the-loop subcommands: inbound delivery (inbox),
// questions/answer, approvals/approve/deny, and decision gates.

import type { Command, CommandContext, CommandResult } from '../types.js';
import { validateOrgName } from './org-control.js';

export const inboxSubcommand: Command = {
  name: 'inbox',
  description:
    'Deliver an inbound cross-org message (live to a running org, queued to inbox.jsonl otherwise) — remote.ts shells out to this over SSH',
  options: [
    {
      name: 'json',
      description: 'JSON payload: {"from":"orgA:role","subject":"...","body":"..."}',
      type: 'string',
    },
    { name: 'to', description: "Target role (default: the org's coordinator)", type: 'string' },
    {
      name: 'from',
      description: 'Sender, qualified "org:role" (alternative to --json)',
      type: 'string',
    },
    { name: 'subject', description: 'Subject (alternative to --json)', type: 'string' },
    { name: 'body', description: 'Body (alternative to --json)', type: 'string' },
  ],
  examples: [
    {
      command:
        'monomind org inbox growth --json \'{"from":"sales:boss","subject":"leads","body":"..."}\'',
      description: 'Deliver a message to the growth org',
    },
    {
      command:
        'monomind org inbox growth --to lead --from growth:publisher-bot --subject "re: post" --body "done" --format json',
      description:
        'Reply as an automation role; prints {"v":1,"org","to","from","delivery","receipt","messageId"}',
    },
  ],
  action: async (ctx: CommandContext): Promise<CommandResult> => {
    const v = validateOrgName(ctx.args[0]);
    if (!v.ok) return v.result;
    const { inboxAction } = await import('./org-observe.js');
    return inboxAction(ctx, v.name);
  },
};

export const questionsSubcommand: Command = {
  name: 'questions',
  description: "List pending ask_human questions from an org's agents",
  options: [
    { name: 'all', description: 'Include answered and dismissed questions', type: 'boolean' },
  ],
  subcommands: [
    {
      name: 'dismiss',
      description:
        'Close a pending question without an answer (releases the org_complete gate; the asking role is told)',
      options: [
        { name: 'reason', description: 'Why it is dismissed (shown to the role)', type: 'string' },
        {
          name: 'by',
          description: 'Resolver recorded as resolvedBy (default: human)',
          type: 'string',
        },
      ],
      examples: [
        {
          command: 'monomind org questions dismiss growth q-123-ab --reason "no longer needed"',
          description: 'Dismiss question q-123-ab',
        },
      ],
      action: async (ctx: CommandContext): Promise<CommandResult> => {
        const v = validateOrgName(ctx.args[0]);
        if (!v.ok) return v.result;
        const { dismissAction } = await import('./org-observe.js');
        return dismissAction(ctx, v.name);
      },
    },
  ],
  examples: [
    { command: 'monomind org questions growth', description: 'Show unanswered questions' },
    {
      command: 'monomind org questions dismiss growth q-123-ab --reason "moot"',
      description: 'Dismiss a question nobody will answer',
    },
  ],
  action: async (ctx: CommandContext): Promise<CommandResult> => {
    const v = validateOrgName(ctx.args[0]);
    if (!v.ok) return v.result;
    const { questionsAction } = await import('./org-observe.js');
    return questionsAction(ctx, v.name);
  },
};

export const approvalsSubcommand: Command = {
  name: 'approvals',
  description: "List pending tool/action approval requests from an org's agents",
  options: [{ name: 'all', description: 'Include resolved approvals', type: 'boolean' }],
  examples: [{ command: 'monomind org approvals growth', description: 'Show pending approvals' }],
  action: async (ctx: CommandContext): Promise<CommandResult> => {
    const v = validateOrgName(ctx.args[0]);
    if (!v.ok) return v.result;
    const { approvalsAction } = await import('./org-observe.js');
    return approvalsAction(ctx, v.name);
  },
};

export const answerSubcommand: Command = {
  name: 'answer',
  description: 'Answer a pending ask_human question (live if the org is running, queued otherwise)',
  options: [
    {
      name: 'by',
      description: 'Resolver recorded as resolvedBy (default: human)',
      type: 'string',
    },
  ],
  examples: [
    {
      command: 'monomind org answer growth q-123-ab "yes, ship it"',
      description: 'Answer question q-123-ab',
    },
  ],
  action: async (ctx: CommandContext): Promise<CommandResult> => {
    const v = validateOrgName(ctx.args[0]);
    if (!v.ok) return v.result;
    const { answerAction } = await import('./org-observe.js');
    return answerAction(ctx, v.name);
  },
};

export const approveSubcommand: Command = {
  name: 'approve',
  description: 'Approve a pending tool/action approval',
  options: [
    {
      name: 'request',
      description: 'Resolve only this approval request id (apr-…)',
      type: 'string',
    },
    {
      name: 'by',
      description: 'Resolver recorded as resolvedBy (default: human)',
      type: 'string',
    },
  ],
  examples: [
    {
      command: 'monomind org approve growth coder "Bash"',
      description: 'Approve Bash tool for coder role',
    },
  ],
  action: async (ctx: CommandContext): Promise<CommandResult> => {
    const v = validateOrgName(ctx.args[0]);
    if (!v.ok) return v.result;
    const { approveAction } = await import('./org-observe.js');
    return approveAction(ctx, v.name);
  },
};

export const denySubcommand: Command = {
  name: 'deny',
  description: 'Deny a pending tool/action approval',
  options: [
    {
      name: 'request',
      description: 'Resolve only this approval request id (apr-…)',
      type: 'string',
    },
    {
      name: 'by',
      description: 'Resolver recorded as resolvedBy (default: human)',
      type: 'string',
    },
  ],
  examples: [
    {
      command: 'monomind org deny growth coder "Bash"',
      description: 'Deny Bash tool for coder role',
    },
  ],
  action: async (ctx: CommandContext): Promise<CommandResult> => {
    const v = validateOrgName(ctx.args[0]);
    if (!v.ok) return v.result;
    const { denyAction } = await import('./org-observe.js');
    return denyAction(ctx, v.name);
  },
};

export const gatesSubcommand: Command = {
  name: 'gates',
  description: "List decision gates from an org's agents",
  options: [{ name: 'all', description: 'Include resolved gates', type: 'boolean' }],
  examples: [
    { command: 'monomind org gates growth', description: 'Show pending gates' },
    { command: 'monomind org gates growth --all', description: 'Show all gates' },
  ],
  action: async (ctx: CommandContext): Promise<CommandResult> => {
    const v = validateOrgName(ctx.args[0]);
    if (!v.ok) return v.result;
    const { gatesAction } = await import('./org-observe.js');
    return gatesAction(ctx, v.name);
  },
};

export const gateApproveSubcommand: Command = {
  name: 'gate-approve',
  description: 'Approve a pending decision gate',
  options: [
    {
      name: 'by',
      description: 'Resolver recorded as resolvedBy (default: human)',
      type: 'string',
    },
  ],
  examples: [
    {
      command: 'monomind org gate-approve growth gate-123-ab "ship it"',
      description: 'Approve gate with resolution',
    },
  ],
  action: async (ctx: CommandContext): Promise<CommandResult> => {
    const v = validateOrgName(ctx.args[0]);
    if (!v.ok) return v.result;
    const { gateResolveAction } = await import('./org-observe.js');
    return gateResolveAction(ctx, v.name, true);
  },
};

export const gateRejectSubcommand: Command = {
  name: 'gate-reject',
  description: 'Reject a pending decision gate',
  options: [
    {
      name: 'by',
      description: 'Resolver recorded as resolvedBy (default: human)',
      type: 'string',
    },
  ],
  examples: [
    {
      command: 'monomind org gate-reject growth gate-123-ab "not ready"',
      description: 'Reject gate with reason',
    },
  ],
  action: async (ctx: CommandContext): Promise<CommandResult> => {
    const v = validateOrgName(ctx.args[0]);
    if (!v.ok) return v.result;
    const { gateResolveAction } = await import('./org-observe.js');
    return gateResolveAction(ctx, v.name, false);
  },
};
