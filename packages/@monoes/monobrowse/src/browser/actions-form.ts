import { resolve } from 'node:path';
import { pressKeyCombo, typeText } from './actions-keyboard.js';
import { clickPoint } from './actions-mouse.js';
import type { CdpClient } from './cdp.js';
import { getElementBox, getObjectIdForRef } from './snapshot.js';
import type { ClickOptions, ElementRef } from './types.js';

export async function clickElement(
  client: CdpClient,
  sessionId: string,
  ref: ElementRef,
  options: ClickOptions = {},
): Promise<void> {
  const box = await getElementBox(client, sessionId, ref);

  if (box) {
    await clickPoint(client, sessionId, box.x, box.y, options);
    return;
  }

  // Fallback: use JS click via objectId
  const objectId = await getObjectIdForRef(client, sessionId, ref);
  if (objectId) {
    await client.send(
      'Runtime.callFunctionOn',
      {
        functionDeclaration: 'function() { this.click(); }',
        objectId,
        returnByValue: true,
      },
      sessionId,
    );
    return;
  }

  throw new Error(`Cannot click ref @${ref.ref}: element not found in DOM`);
}

export async function fillElement(
  client: CdpClient,
  sessionId: string,
  ref: ElementRef,
  value: string,
): Promise<void> {
  const box = await getElementBox(client, sessionId, ref);

  if (box) {
    // Click to focus
    await clickPoint(client, sessionId, box.x, box.y);
  }

  // Select all and replace
  const objectId = await getObjectIdForRef(client, sessionId, ref);
  if (objectId) {
    const fillSelectResult = await client.send<{
      result: unknown;
      exceptionDetails?: { text: string; exception?: { description?: string } };
    }>(
      'Runtime.callFunctionOn',
      {
        functionDeclaration: `function() {
        this.focus();
        if (this.tagName === 'INPUT' || this.tagName === 'TEXTAREA') {
          this.select();
        } else if (this.isContentEditable) {
          const range = document.createRange();
          range.selectNodeContents(this);
          const sel = window.getSelection();
          if (sel) { sel.removeAllRanges(); sel.addRange(range); }
        }
      }`,
        objectId,
        returnByValue: true,
      },
      sessionId,
    );
    if (fillSelectResult.exceptionDetails) {
      throw new Error(
        `fillElement select-all failed: ${fillSelectResult.exceptionDetails.exception?.description ?? fillSelectResult.exceptionDetails.text}`,
      );
    }
  } else if (box) {
    // Fallback for elements without a resolvable objectId: keyboard select-all clears existing content
    const mod = process.platform === 'darwin' ? 4 : 2;
    await pressKeyCombo(client, sessionId, 'a', mod);
  }

  if (!objectId && !box) throw new Error(`Cannot fill ref @${ref.ref}: element not found in DOM`);

  // Type the value character by character for natural input
  await typeText(client, sessionId, value);
}

export async function selectOption(
  client: CdpClient,
  sessionId: string,
  ref: ElementRef,
  value: string,
): Promise<void> {
  const objectId = await getObjectIdForRef(client, sessionId, ref);
  if (!objectId) throw new Error(`Cannot select: ref @${ref.ref} not found in DOM`);

  const selectResult = await client.send<{
    result: unknown;
    exceptionDetails?: { text: string; exception?: { description?: string } };
  }>(
    'Runtime.callFunctionOn',
    {
      functionDeclaration: `function(value) {
      if (this.tagName !== 'SELECT') throw new Error('Not a select element');
      for (const opt of this.options) {
        if (opt.value === value || opt.textContent.trim() === value) {
          this.value = opt.value;
          this.dispatchEvent(new Event('change', { bubbles: true }));
          return;
        }
      }
      throw new Error('Option not found: ' + value);
    }`,
      objectId,
      arguments: [{ value }],
      returnByValue: true,
    },
    sessionId,
  );
  if (selectResult.exceptionDetails) {
    throw new Error(
      `selectOption failed: ${selectResult.exceptionDetails.exception?.description ?? selectResult.exceptionDetails.text}`,
    );
  }
}

export async function checkElement(
  client: CdpClient,
  sessionId: string,
  ref: ElementRef,
  checked = true,
): Promise<void> {
  const objectId = await getObjectIdForRef(client, sessionId, ref);
  if (!objectId) throw new Error(`Cannot check: ref @${ref.ref} not found in DOM`);

  const checkResult = await client.send<{
    result: unknown;
    exceptionDetails?: { text: string; exception?: { description?: string } };
  }>(
    'Runtime.callFunctionOn',
    {
      functionDeclaration: `function(checked) {
      if (this.checked !== checked) {
        this.click();
      }
    }`,
      objectId,
      arguments: [{ value: checked }],
      returnByValue: true,
    },
    sessionId,
  );
  if (checkResult.exceptionDetails) {
    throw new Error(
      `checkElement failed: ${checkResult.exceptionDetails.exception?.description ?? checkResult.exceptionDetails.text}`,
    );
  }
}

export async function focusElement(
  client: CdpClient,
  sessionId: string,
  ref: ElementRef,
): Promise<void> {
  const objectId = await getObjectIdForRef(client, sessionId, ref);
  if (objectId) {
    await client.send(
      'Runtime.callFunctionOn',
      {
        functionDeclaration: 'function() { this.focus(); }',
        objectId,
        returnByValue: true,
      },
      sessionId,
    );
    return;
  }
  const box = await getElementBox(client, sessionId, ref);
  if (box) {
    await clickPoint(client, sessionId, box.x, box.y);
  } else {
    throw new Error(`Cannot focus ref @${ref.ref}: element not found in DOM`);
  }
}

export async function typeIntoElement(
  client: CdpClient,
  sessionId: string,
  ref: ElementRef,
  text: string,
): Promise<void> {
  await focusElement(client, sessionId, ref);
  await typeText(client, sessionId, text);
}

export async function uploadFile(
  client: CdpClient,
  sessionId: string,
  ref: ElementRef,
  filePaths: string[],
): Promise<void> {
  if (!ref.backendDOMNodeId) throw new Error(`Cannot upload: ref @${ref.ref} has no DOM node`);

  await client.send(
    'DOM.setFileInputFiles',
    {
      files: filePaths.map((f) => resolve(f)),
      backendNodeId: ref.backendDOMNodeId,
    },
    sessionId,
  );
}
