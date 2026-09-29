// packages/@monomind/cli/src/orgrt/agent-exec-gate.ts
// Split out of agent-exec.ts (file-size rule): the canUseTool gate for
// `--access scoped` (the caller's tool list plus `--allow-bash-prefix`) and
// `--access read` (#388, agent-exec-read.ts). `--access full` uses
// agent-exec-access.ts's fullAccessCanUseTool and never reaches this.

import { readAccessCanUseTool } from './agent-exec-read.js';
import { hasUnsafeShellSyntax } from './agent-exec-shell-syntax.js';

type Decision =
  | { behavior: 'allow'; updatedInput: Record<string, unknown> }
  | { behavior: 'deny'; message: string };

export type ExecCanUseTool = (
  toolName: string,
  input: Record<string, unknown>,
) => Promise<Decision>;

/** Scoped access: only the caller's own tools, plus Bash commands that start
 *  with one of `bashPrefixes` and contain no shell metacharacters. */
export function scopedCanUseTool(
  allowedToolNames: ReadonlySet<string>,
  bashPrefixes: readonly string[],
): ExecCanUseTool {
  return async (toolName, input) => {
    if (allowedToolNames.has(toolName)) return { behavior: 'allow', updatedInput: input };
    if (toolName === 'Bash' && bashPrefixes.length > 0 && typeof input.command === 'string') {
      const cmd = input.command.trimStart();
      const matchesPrefix = bashPrefixes.some((p) => cmd === p || cmd.startsWith(`${p} `));
      if (matchesPrefix && !hasUnsafeShellSyntax(cmd))
        return { behavior: 'allow', updatedInput: input };
      if (matchesPrefix)
        return {
          behavior: 'deny',
          message:
            'Bash command contains shell metacharacters (;, &, |, `, $(, <() — only a single literal invocation is allowed, no chaining/substitution/redirection.',
        };
    }
    return {
      behavior: 'deny',
      message:
        toolName === 'Bash' && bashPrefixes.length > 0
          ? `Bash is only allowed for commands starting with: ${bashPrefixes.join(', ')}.`
          : `Tool "${toolName}" was not in the tool list this exec call was given.`,
    };
  };
}

/** The gate for a scoped or read turn. */
export function execCanUseTool(
  access: 'scoped' | 'read',
  allowedToolNames: ReadonlySet<string>,
  bashPrefixes: readonly string[],
): ExecCanUseTool {
  return access === 'read'
    ? readAccessCanUseTool(allowedToolNames, bashPrefixes)
    : scopedCanUseTool(allowedToolNames, bashPrefixes);
}
