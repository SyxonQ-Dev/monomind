// packages/@monomind/cli/src/commands/org.ts

import { output } from '../output.js';
import type { Command, CommandContext, CommandResult } from '../types.js';
import { validateOrgName } from './org-control.js';
import {
  pauseAction,
  reloadAction,
  resumeAction,
  statusAction,
  stopAction,
} from './org-lifecycle.js';
import {
  deleteAction,
  listAction,
  markCompleteAction,
  migrateAction,
  testLoopAction,
} from './org-manage.js';
import { memorySubcommand } from './org-memory-command.js';
import { runAction } from './org-run.js';
import { serveAction, supervisorAction } from './org-serve.js';

export {
  checkServeLock,
  classifyRun,
  clearReloadfile,
  clearStaleControlFiles,
  clearStopfile,
  isOrgPaused,
  listOrgConfigFiles,
  type RunLiveEvidence,
  type RunState,
  type ServeLockCheck,
  validateOrgName,
} from './org-control.js';
export {
  pollReloadfiles,
  pollRunfiles,
  pollStopfiles,
  runOutcomeResult,
  waitForRunEnd,
} from './org-poll.js';

const log = (text: string): void => {
  console.log(text);
};

export const orgCommand: Command = {
  name: 'org',
  description: 'SDK-based org runtime — run agent organizations as a controlled daemon',
  subcommands: [
    {
      name: 'skills',
      description:
        'Browse the org skill library and import skills (MIT/Apache-2.0) from other repos',
      options: [
        { name: 'tag', description: 'Filter by tag (list, search)', type: 'string' },
        { name: 'limit', description: 'Max search results (default 10)', type: 'number' },
        {
          name: 'global',
          description: 'import: into ~/.monomind/org-skills instead of this project',
          type: 'boolean',
        },
        { name: 'into', description: 'import: into this library directory', type: 'string' },
        { name: 'only', description: 'import: comma-separated skill names', type: 'string' },
        {
          name: 'tags',
          description: 'import: comma-separated tags to give imported skills',
          type: 'string',
        },
        {
          name: 'overwrite',
          description: 'import: replace skills already in the library',
          type: 'boolean',
        },
      ],
      examples: [
        {
          command: 'monomind org skills search "backend api reviewer"',
          description: 'Find skills for a role',
        },
        { command: 'monomind org skills show systematic-debugging', description: 'Read one skill' },
        {
          command: 'monomind org skills import obra/superpowers --global',
          description: "Import a repo's skills",
        },
      ],
      action: async (ctx: CommandContext): Promise<CommandResult> => {
        const { orgSkillsAction } = await import('./org-skills.js');
        return orgSkillsAction(ctx);
      },
    },
    {
      name: 'run',
      description: 'Start an org (foreground daemon)',
      options: [
        { name: 'task', description: 'Override the org goal for this run', type: 'string' },
        {
          name: 'resume',
          description: 'Resume an org run from its persisted checkpoint instead of starting fresh',
          type: 'boolean',
        },
        {
          name: 'cross-process',
          description:
            'Discover and message orgs hosted by other monomind processes on this machine (default true)',
          type: 'boolean',
          default: true,
        },
        {
          name: 'dry-run',
          description:
            "Validate and print each role's briefing without starting any agent sessions",
          type: 'boolean',
        },
        {
          name: 'budget-usd',
          description:
            'Hard-stop the run if the upfront cost estimate exceeds this USD value (e.g. --budget-usd 5)',
          type: 'number',
        },
        {
          name: 'yes',
          short: 'y',
          description: 'Skip the interactive cost-estimate confirmation prompt',
          type: 'boolean',
        },
        {
          name: 'auto-approve',
          description:
            'Comma-separated gated tools every role may call without human approval for this run (e.g. org_complete). -y alone approves nothing',
          type: 'string',
        },
      ],
      examples: [
        {
          command: 'monomind org run growth --task "weekly report"',
          description: 'Run the growth org once with a task',
        },
        {
          command: 'monomind org run growth --task "weekly report" -y --auto-approve org_complete',
          description:
            'Unattended one-shot run that may end itself without a human approving org_complete',
        },
      ],
      action: runAction,
    },
    { name: 'stop', description: 'Request a running org daemon to stop', action: stopAction },
    {
      name: 'pause',
      description: 'Pause an org — current turns finish, no new cycles start',
      action: pauseAction,
    },
    { name: 'resume', description: 'Resume a paused org', action: resumeAction },
    {
      name: 'reload',
      description: 'Hot-reload an org definition without stopping sessions',
      action: reloadAction,
    },
    { name: 'status', description: 'Show runtime state of orgs', action: statusAction },
    {
      name: 'serve',
      description: 'Start the daemon server only (hosts scheduled orgs)',
      options: [
        {
          name: 'cross-process',
          description:
            'Discover and message orgs hosted by other monomind processes on this machine (default true)',
          type: 'boolean',
          default: true,
        },
      ],
      action: serveAction,
    },
    {
      name: 'supervisor',
      description: 'Print (or --install) a launchd/systemd unit that keeps `org serve` running',
      options: [
        { name: 'format', description: 'launchd or systemd (default: platform)', type: 'string' },
        {
          name: 'install',
          description: 'Write the unit into the per-user location',
          type: 'boolean',
        },
      ],
      action: supervisorAction,
    },
    {
      name: 'test-loop',
      description: 'Run the org e2e verification loop N times',
      options: [
        { name: 'times', short: 'n', description: 'Iterations', type: 'number', default: 5 },
        {
          name: 'scenario',
          description:
            'Run a declarative scenario file (.monomind/scenarios/<file>) instead of the built-in fixture — structural dry-run only',
          type: 'string',
        },
      ],
      action: testLoopAction,
    },
    {
      name: 'logs',
      description: 'Show (or follow) the formatted event log of an org run',
      options: [
        { name: 'run', description: 'Run id (default: latest)', type: 'string' },
        { name: 'role', description: 'Only events from/to this role', type: 'string' },
        {
          name: 'filter-tool',
          description: 'Filter events by tool name (e.g., Write, Edit)',
          type: 'string',
        },
        { name: 'filter-role', description: 'Filter events by role ID', type: 'string' },
        {
          name: 'tools-only',
          description: 'Show only tool events (exclude messages/status/audit)',
          type: 'boolean',
        },
        {
          name: 'audit-filter',
          description: 'Filter audit events by decision (allow|deny)',
          type: 'string',
        },
        { name: 'follow', short: 'f', description: 'Keep tailing until Ctrl-C', type: 'boolean' },
      ],
      examples: [
        { command: 'monomind org logs growth --follow', description: 'Live-tail the latest run' },
        {
          command: 'monomind org logs growth --tools-only',
          description: 'Show only tool call events',
        },
      ],
      action: async (ctx: CommandContext): Promise<CommandResult> => {
        const v = validateOrgName(ctx.args[0]);
        if (!v.ok) return v.result;
        const { logsAction } = await import('./org-observe.js');
        return logsAction(ctx, v.name);
      },
    },
    {
      name: 'events',
      description:
        "Tail a run's bus events as NDJSON — the machine streaming surface (agent-exec-protocol.md §7.3)",
      options: [
        { name: 'run', description: 'Run id (default: latest)', type: 'string' },
        { name: 'follow', short: 'f', description: 'Keep tailing until Ctrl-C', type: 'boolean' },
        {
          name: 'since',
          description: 'Replay cursor: an event id or ISO-8601 timestamp',
          type: 'string',
        },
        {
          name: 'ndjson',
          description: 'Accepted for spec symmetry — NDJSON is the only output mode',
          type: 'boolean',
        },
      ],
      examples: [
        {
          command: 'monomind org events growth --follow',
          description: 'Live NDJSON tail of the latest run',
        },
      ],
      action: async (ctx: CommandContext): Promise<CommandResult> => {
        const v = validateOrgName(ctx.args[0]);
        if (!v.ok) return v.result;
        const { eventsAction } = await import('./org-observe.js');
        return eventsAction(ctx, v.name);
      },
    },
    {
      name: 'watch',
      description:
        "Live-tail one role's assistant chat text (any runtime) — a filtered, friendlier `logs --follow`",
      options: [
        { name: 'run', description: 'Run id (default: latest)', type: 'string' },
        {
          name: 'follow',
          description:
            'Set --follow=false to print current output once and exit instead of live-tailing',
          type: 'boolean',
          default: true,
        },
        {
          name: 'verbose',
          description:
            'Also interleave status events (restart/crash/state-change) into the transcript',
          type: 'boolean',
        },
        {
          name: 'stats',
          description: 'Print a running token/cost line as usage events arrive',
          type: 'boolean',
        },
      ],
      examples: [
        {
          command: 'monomind org watch growth researcher',
          description: "Watch the researcher role's live output",
        },
        {
          command: 'monomind org watch growth researcher --verbose --stats',
          description: 'Also show restarts/crashes and a running token/cost total',
        },
      ],
      action: async (ctx: CommandContext): Promise<CommandResult> => {
        const v = validateOrgName(ctx.args[0]);
        if (!v.ok) return v.result;
        const { watchAction } = await import('./org-observe.js');
        return watchAction(ctx, v.name);
      },
    },
    {
      name: 'report',
      description: 'Summarize an org run: outcome, per-role activity, tokens, assets, crashes',
      options: [
        { name: 'run', description: 'Run id (default: latest)', type: 'string' },
        { name: 'all', description: 'List all recorded runs from history', type: 'boolean' },
        { name: 'by-role', description: 'Show per-role cost breakdown', type: 'boolean' },
        { name: 'audit', description: 'Show tool audit trail', type: 'boolean' },
        {
          name: 'tool',
          description: 'Filter tool audit by tool name (with --audit)',
          type: 'string',
        },
        { name: 'format', description: 'Output format (mermaid for flowchart)', type: 'string' },
      ],
      examples: [
        { command: 'monomind org report growth', description: 'Report on the latest run' },
      ],
      action: async (ctx: CommandContext): Promise<CommandResult> => {
        const v = validateOrgName(ctx.args[0]);
        if (!v.ok) return v.result;
        const { reportAction } = await import('./org-observe.js');
        return reportAction(ctx, v.name);
      },
    },
    memorySubcommand,
    {
      name: 'costs',
      description: 'Show per-role cost tracking from runtime.json',
      options: [{ name: 'run', description: 'Run ID (defaults to latest)', type: 'string' }],
      examples: [
        { command: 'monomind org costs growth', description: 'Show cost breakdown for latest run' },
        {
          command: 'monomind org costs growth --run run-20240130-123456',
          description: 'Show cost breakdown for specific run',
        },
      ],
      action: async (ctx: CommandContext): Promise<CommandResult> => {
        const v = validateOrgName(ctx.args[0]);
        if (!v.ok) return v.result;
        const { costsAction } = await import('./org-observe.js');
        return costsAction(ctx, v.name);
      },
    },
    {
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
    },
    {
      name: 'flow',
      description: 'Export org flow as Mermaid diagram',
      options: [{ name: 'run', description: 'Run ID (defaults to latest)', type: 'string' }],
      examples: [
        {
          command: 'monomind org flow growth --run run-20250130120000',
          description: 'Export Mermaid flowchart',
        },
      ],
      action: async (ctx: CommandContext): Promise<CommandResult> => {
        const v = validateOrgName(ctx.args[0]);
        if (!v.ok) return v.result;
        const { flowAction } = await import('./org-observe.js');
        return flowAction(ctx, v.name);
      },
    },
    {
      name: 'questions',
      description: "List pending ask_human questions from an org's agents",
      options: [{ name: 'all', description: 'Include answered questions', type: 'boolean' }],
      examples: [
        { command: 'monomind org questions growth', description: 'Show unanswered questions' },
      ],
      action: async (ctx: CommandContext): Promise<CommandResult> => {
        const v = validateOrgName(ctx.args[0]);
        if (!v.ok) return v.result;
        const { questionsAction } = await import('./org-observe.js');
        return questionsAction(ctx, v.name);
      },
    },
    {
      name: 'approvals',
      description: "List pending tool/action approval requests from an org's agents",
      options: [{ name: 'all', description: 'Include resolved approvals', type: 'boolean' }],
      examples: [
        { command: 'monomind org approvals growth', description: 'Show pending approvals' },
      ],
      action: async (ctx: CommandContext): Promise<CommandResult> => {
        const v = validateOrgName(ctx.args[0]);
        if (!v.ok) return v.result;
        const { approvalsAction } = await import('./org-observe.js');
        return approvalsAction(ctx, v.name);
      },
    },
    {
      name: 'answer',
      description:
        'Answer a pending ask_human question (live if the org is running, queued otherwise)',
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
    },
    {
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
    },
    {
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
    },
    {
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
    },
    {
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
    },
    {
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
    },
    {
      name: 'replay',
      description:
        'Time-travel debugging: replay a run\'s bus events (does not resume live execution — use "org run --resume" for that)',
      examples: [
        {
          command: 'monomind org replay growth run-20250130120000-abc',
          description: "Replay a checkpoint's events for inspection",
        },
      ],
      action: async (ctx: CommandContext): Promise<CommandResult> => {
        const v = validateOrgName(ctx.args[0]);
        if (!v.ok) return v.result;
        const { replayAction } = await import('./org-observe.js');
        return replayAction(ctx, v.name);
      },
    },
    {
      name: 'resume-from',
      description:
        "Resume live execution from the org's persisted checkpoint (restores mailbox/policy/session state; subject to TTL and checksum validation)",
      examples: [
        {
          command: 'monomind org resume-from growth',
          description: 'Resume growth from its last checkpoint',
        },
      ],
      action: async (ctx: CommandContext): Promise<CommandResult> => {
        const v = validateOrgName(ctx.args[0]);
        if (!v.ok) return v.result;
        const { resumeFromAction } = await import('./org-observe.js');
        return resumeFromAction(ctx, v.name);
      },
    },
    {
      name: 'branch',
      description:
        "Snapshot a run's event log into a new run for replay — usage: org branch <org> <run-id> <label>. The new run's id is generated; <label> is only a note recorded in its .branch-source",
      examples: [
        {
          command: 'monomind org branch growth run-20250130 "before the outage"',
          description:
            'Snapshot run-20250130 into a new generated run id, noting why in .branch-source (the label does not name the run)',
        },
        {
          command: 'monomind org branch growth run-20250130 pre-outage --format json',
          description:
            'Same, printing {"run": "<generated id>", ...} so a script can replay it without parsing prose',
        },
      ],
      action: async (ctx: CommandContext): Promise<CommandResult> => {
        const v = validateOrgName(ctx.args[0]);
        if (!v.ok) return v.result;
        const { branchAction } = await import('./org-observe.js');
        return branchAction(ctx, v.name);
      },
    },
    {
      name: 'decisions',
      description: 'Show Rifft-style decision traces',
      examples: [
        {
          command: 'monomind org decisions growth --run run-20250130',
          description: 'Show decision traces',
        },
      ],
      action: async (ctx: CommandContext): Promise<CommandResult> => {
        const v = validateOrgName(ctx.args[0]);
        if (!v.ok) return v.result;
        const { decisionsAction } = await import('./org-observe.js');
        return decisionsAction(ctx, v.name);
      },
    },
    {
      name: 'create',
      description: 'Scaffold an org config from a starter template',
      options: [
        {
          name: 'template',
          description:
            'content-team | dev-team | research-pod | kg-extraction | advisor-orchestrator',
          type: 'string',
        },
        {
          name: 'goal',
          description: "Org goal (defaults to the template's placeholder)",
          type: 'string',
        },
        { name: 'schedule', description: 'Daemon schedule, e.g. 30m or 2h', type: 'string' },
        { name: 'force', description: 'Overwrite an existing org config', type: 'boolean' },
        {
          name: 'yes',
          short: 'y',
          description: 'Skip the per-role model confirmation prompt (TTY only)',
          type: 'boolean',
        },
      ],
      examples: [
        {
          command: 'monomind org create blog --template content-team --goal "3 posts/week"',
          description: 'Create a content org',
        },
      ],
      action: async (ctx: CommandContext): Promise<CommandResult> => {
        const v = validateOrgName(ctx.args[0]);
        if (!v.ok) return v.result;
        const { createAction } = await import('./org-observe.js');
        return createAction(ctx, v.name);
      },
    },
    {
      name: 'validate',
      description: 'Validate org config(s) against the runtime schema and structural invariants',
      examples: [
        { command: 'monomind org validate growth', description: 'Validate one org config' },
        {
          command: 'monomind org validate',
          description: 'Validate every org config in the project',
        },
      ],
      action: async (ctx: CommandContext): Promise<CommandResult> => {
        const { validateAction } = await import('./org-observe.js');
        return validateAction(ctx);
      },
    },
    {
      name: 'migrate',
      description: 'Convert a legacy-format org config (topology/board/loop) to the current format',
      examples: [
        {
          command: 'monomind org migrate growth',
          description: 'Migrate one org; original saved as growth.v1.json',
        },
      ],
      action: migrateAction,
    },
    { name: 'list', description: 'List all orgs in the current project', action: listAction },
    {
      name: 'delete',
      description: 'Delete an org and all its data',
      options: [
        { name: 'yes', short: 'y', description: 'Skip confirmation', type: 'boolean' },
        {
          name: 'force',
          description: 'Delete even if the org appears to be running',
          type: 'boolean',
        },
      ],
      action: deleteAction,
    },
    {
      name: 'mark-complete',
      description: 'Manually close a stale/crashed run',
      action: markCompleteAction,
    },
  ],
  examples: [
    { command: 'monomind org run my-org', description: 'Run an org under full daemon control' },
  ],
  action: async (): Promise<CommandResult> => {
    // index.ts's dispatcher never prints result.message on a failed action —
    // it only exits with result.exitCode — so this must log itself or bare
    // `monomind org` exits silently with code 1 and zero output.
    const message =
      'usage: monomind org <run|stop|status|serve|test-loop|logs|report|costs|inbox|questions|answer|approve|deny|replay|resume-from|branch|decisions|create|validate|migrate|list|delete|mark-complete>';
    log(output.error(message));
    return { success: false, message };
  },
};

export default orgCommand;
