// #502: the org runtime refuses definitions the operator has not signed.
// Many suites here start fixture orgs that have nothing to do with signing,
// so enforcement is off by default under test; the signature tests
// (org-signature*.test.ts) turn it back on with setOrgSignatureEnforcement.
// The import-free module: importing org-signature.ts here would load the org
// runtime before a test file's vi.mock of one of its modules takes effect.
import { setOrgSignatureEnforcement } from '../../src/orgrt/org-signature-enforcement.js';

setOrgSignatureEnforcement(false);
