// packages/@monomind/cli/src/orgrt/codex-runner-tools.ts

/** ADR-O001 D8 level → codex's `model_reasoning_effort`. codex accepts
 *  none|minimal|low|medium|high|xhigh|max (the API's own 400 lists them,
 *  verified with codex-cli 0.156.1); monomind's `off` is codex's `none`. */
export function codexEffortArgs(effort: string | undefined): string[] {
  if (!effort) return [];
  const level = effort === 'off' ? 'none' : effort;
  return ['-c', `model_reasoning_effort=${level}`];
}
