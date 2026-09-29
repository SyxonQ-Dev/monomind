// #502: the org runtime refuses definitions the operator has not signed.
// Many suites here start fixture orgs that have nothing to do with signing,
// so enforcement is off by default under test; the signature tests
// (org-signature*.test.ts) turn it back on with setOrgSignatureEnforcement.
import { setOrgSignatureEnforcement } from '../../src/orgrt/org-signature.js';

setOrgSignatureEnforcement(false);
