/**
 * Browser action helpers (click, type, scroll, drag, JS evaluation, ...).
 *
 * File-size sweep: split into sibling modules (actions-keyboard.ts,
 * actions-mouse.ts, actions-form.ts, actions-eval.ts). This file remains the
 * entry point and re-exports everything that used to live here so every
 * existing import keeps working.
 */

export {
  addInitScript,
  evaluateJs,
  pushState,
  readClipboard,
  removeInitScript,
  writeClipboard,
} from './actions-eval.js';
export {
  checkElement,
  clickElement,
  fillElement,
  focusElement,
  selectOption,
  typeIntoElement,
  uploadFile,
} from './actions-form.js';
export { keyDown, keyUp, pressKey, pressKeyCombo, typeText } from './actions-keyboard.js';
export {
  clickPoint,
  dragAndDrop,
  hoverElement,
  mouseDown,
  mouseMove,
  mouseUp,
  mouseWheel,
  scrollElement,
} from './actions-mouse.js';
