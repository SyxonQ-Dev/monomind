// packages/@monomind/cli/src/orgrt/cross-org.ts
// Extracted from daemon.ts — message delivery, cross-org routing, remote delivery.
// File-size sweep: split into sibling modules, re-exported here so every
// existing import path keeps working.
//   cross-org-federation.ts — M4 federation checks
//   cross-org-deferred.ts   — in-flight lazy-spawn tracking
//   cross-org-mail.ts       — addressing, mailbox bodies, pushMessage
//   cross-org-deliver.ts    — deliver()
//   cross-org-remote.ts     — deliverRemote()/receiveRemote()

export { deliver } from './cross-org-deliver.js';
export { federationAllows } from './cross-org-federation.js';
export { mailBody, pushMessage, resolveAddress } from './cross-org-mail.js';
export { type ReceiveRemoteOpts, receiveRemote } from './cross-org-remote.js';
