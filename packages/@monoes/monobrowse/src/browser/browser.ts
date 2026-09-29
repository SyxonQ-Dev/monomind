// File-size sweep: split into sibling modules (browser-state, browser-discovery,
// browser-launch, browser-lifecycle, browser-page). Pure move — this file now
// re-exports everything it used to define, so every existing import path
// keeps working.

export { isPortOpen } from './browser-discovery.js';
export { launchBrowser } from './browser-launch.js';
export { closeBrowser, reapIdleLaunchedBrowser } from './browser-lifecycle.js';
export {
  connectToTarget,
  enableSessionDomains,
  getCurrentTitle,
  getCurrentUrl,
  openUrl,
  waitForLoad,
} from './browser-page.js';
export {
  getLaunchedPid,
  getLaunchedUserDataDir,
  ownsLaunchedUserDataDir,
} from './browser-state.js';
