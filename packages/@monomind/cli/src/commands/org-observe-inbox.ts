// packages/@monomind/cli/src/commands/org-observe-inbox.ts
//
// `monomind org inbox` — inbound cross-org message delivery (live to a
// running org, queued to inbox.jsonl otherwise).

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ORG_DIR } from '../orgrt/types.js';
import { output } from '../output.js';
import type { CommandContext, CommandResult } from '../types.js';
import { orgJson, printOrgJson } from './org-observe-shared.js';

const log = (text: string): void => {
  console.log(text);
};

/** `org inbox <name> --json '{"from":"orgA:role","subject":"...","body":"..."}' [--to role]`
 *  (or `--from/--subject/--body`) `[--format json]`.
 *  Inbound entrypoint for cross-org/remote delivery — orgrt/remote.ts's deliverRemote()
 *  shells out to exactly this command over SSH, and mono-agent replies through it.
 *
 *  Live path (M3): POST to the hosting daemon's /api/xdeliver with the OPERATOR
 *  credential (readOperatorCredential), which lets the daemon trust `from` as
 *  given — the sender org need not be registered (`workflow`, an automation
 *  role). Without an operator credential it presents the sender org's own
 *  broker credential, if that org is registered. Offline path: spool into
 *  inbox.jsonl, drained into the role's mailbox on the org's next start.
 *
 *  `--format json` prints `{"v":1,"org","to","from","delivery":"live"|"queued",
 *  "receipt","messageId"}`. Exit 0 for live and queued; non-zero only for
 *  invalid input or an unknown org. */
export const inboxAction = async (ctx: CommandContext, name: string): Promise<CommandResult> => {
  const json = orgJson(ctx);
  // JSON mode keeps stdout to the single payload — diagnostics go to stderr.
  const note = (text: string): void => {
    if (json) process.stderr.write(`${text}\n`);
    else log(text);
  };
  const fail = (message: string): CommandResult => {
    if (json) process.stdout.write(`${JSON.stringify({ v: 1, org: name, error: message })}\n`);
    else log(output.error(message));
    return { success: false, message };
  };

  let payload: { from?: unknown; subject?: unknown; body?: unknown } = {};
  const rawJson = ctx.flags.json;
  if (typeof rawJson === 'string') {
    try {
      payload = JSON.parse(rawJson) as typeof payload;
    } catch {
      return fail('org inbox: --json is not valid JSON');
    }
  } else {
    payload = { from: ctx.flags.from, subject: ctx.flags.subject, body: ctx.flags.body };
  }
  const from = typeof payload.from === 'string' ? payload.from.trim() : '';
  const subject = typeof payload.subject === 'string' ? payload.subject : '';
  const body = typeof payload.body === 'string' ? payload.body : '';
  if (!from || !body)
    return fail('org inbox: payload requires "from" and "body" (via --json or --from/--body)');
  if (!/^[^\s:]{1,128}(:[^\s:]{1,128})?$/.test(from))
    return fail(`org inbox: invalid sender "${from}" — use "<org>:<role>" or "<role>"`);

  const { lookupOrg, normalizeCredential, readOperatorCredential } = await import(
    '../orgrt/broker.js'
  );
  const remote = lookupOrg(name);
  const defPath = join(ctx.cwd, ORG_DIR, `${name}.json`);
  if (!remote && !existsSync(defPath)) return fail(`Org not found: ${name}`);

  // Target role: explicit --to, else the org's coordinator (reports_to == null),
  // else the first role — matching where a role-less cross-org message should land.
  let toRole = typeof ctx.flags.to === 'string' ? ctx.flags.to : '';
  if (toRole && !/^[a-z0-9][a-z0-9_-]*$/i.test(toRole)) return fail(`Invalid role id: ${toRole}`);
  if (!toRole) {
    if (!existsSync(defPath))
      return fail(`Org "${name}" config is not in this project — pass --to <role>.`);
    try {
      const def = JSON.parse(readFileSync(defPath, 'utf8')) as {
        roles?: { id?: string; reports_to?: string | null }[];
      };
      const roles = Array.isArray(def.roles) ? def.roles : [];
      toRole = roles.find((r) => r.reports_to == null)?.id ?? roles[0]?.id ?? '';
    } catch (err) {
      return fail(
        `Could not read org config for ${name}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    if (!toRole) return fail(`Org "${name}" has no roles to deliver to — pass --to <role>.`);
  }

  const { newMessageId, queueMessage } = await import('../orgrt/inbox.js');
  const messageId = newMessageId();
  const to = `${name}:${toRole}`;
  const done = (delivery: 'live' | 'queued', receipt: string): CommandResult => {
    if (json) return printOrgJson({ v: 1, org: name, to, from, delivery, receipt, messageId });
    log(output.success(receipt));
    return { success: true, message: receipt };
  };

  // Live path: a hosting daemon registered this org with the broker.
  if (remote) {
    const [fromOrg, fromRole] = from.includes(':') ? from.split(':', 2) : ['external', from];
    const operatorCred = readOperatorCredential(name);
    const agentCred = normalizeCredential(remote.credential);
    const cred = operatorCred ?? agentCred;
    const fromCredential = operatorCred ? undefined : lookupOrg(fromOrg)?.credential;
    try {
      const res = await fetch(`${remote.url}/api/xdeliver`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(cred ? { 'x-monomind-cred': cred } : {}),
        },
        body: JSON.stringify({
          fromOrg,
          fromRole,
          ...(fromCredential ? { fromCredential } : {}),
          toOrg: name,
          toRole,
          subject,
          body,
          messageId,
        }),
        signal: AbortSignal.timeout(10_000),
      });
      const data = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        receipt?: string;
        error?: string;
      };
      if (res.ok && data.ok) {
        const receipt = data.receipt ?? `delivered to ${to}`;
        // The daemon itself may have queued it (role starting, org waking).
        return done(/^queued/.test(receipt) ? 'queued' : 'live', receipt);
      }
      note(
        output.warning(
          `Live delivery rejected (${data.error ?? res.status}) — falling back to offline queue.`,
        ),
      );
    } catch (err) {
      note(
        output.warning(
          `Hosting daemon unreachable (${err instanceof Error ? err.message : 'error'}) — falling back to offline queue.`,
        ),
      );
    }
  }

  // Offline path: spool; drained into the role's mailbox when the org next starts.
  const queued = queueMessage(ctx.cwd, name, {
    fromQualified: from,
    toRole,
    subject,
    body,
    ts: Date.now(),
    messageId,
  });
  if (!queued) {
    const message = `Could not queue the message for ${to} (disk full or permissions).`;
    if (json) process.stdout.write(`${JSON.stringify({ v: 1, org: name, error: message })}\n`);
    else log(output.error(message));
    return { success: false, message: 'queueing failed' };
  }
  return done('queued', `queued for ${to} (delivered when the org next runs)`);
};
