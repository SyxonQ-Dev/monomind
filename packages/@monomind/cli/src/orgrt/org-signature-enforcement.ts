// packages/@monomind/cli/src/orgrt/org-signature-enforcement.ts
/**
 * #502: whether org definitions must carry a valid operator signature
 * (org-signature.ts). A module of its own, with no imports, so the vitest
 * setup file can turn it off without loading the org runtime — a setup file
 * that imported org-signature.ts would load fs-case.ts and friends before a
 * test file's `vi.mock` of them could take effect.
 */

let enforced = true;

/** Test-only switch: the org runtime's own suites start hundreds of fixture
 *  orgs that have nothing to do with signing, so their vitest setup file
 *  turns enforcement off; the signature tests turn it back on. Nothing in
 *  production calls this — there is deliberately no env var or flag. */
export function setOrgSignatureEnforcement(on: boolean): void {
  enforced = on;
}

export function orgSignatureEnforced(): boolean {
  return enforced;
}
