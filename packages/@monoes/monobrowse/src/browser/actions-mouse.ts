import type { CdpClient } from './cdp.js';
import { getElementBox } from './snapshot.js';
import type { ClickOptions, ElementRef } from './types.js';

export async function clickPoint(
  client: CdpClient,
  sessionId: string,
  x: number,
  y: number,
  options: ClickOptions = {},
): Promise<void> {
  const button = options.button ?? 'left';
  // Cap clickCount to prevent unbounded loop DoS
  const clickCount = Math.min(Math.max(1, Math.floor(options.clickCount ?? 1)), 100);
  const modifiers = options.modifiers ?? 0;

  const shared = { x, y, button, modifiers };
  const buttonsMask = button === 'right' ? 2 : button === 'middle' ? 4 : 1;

  for (let i = 0; i < clickCount; i++) {
    const count = i + 1;
    await client.send(
      'Input.dispatchMouseEvent',
      { ...shared, type: 'mousePressed', buttons: buttonsMask, clickCount: count },
      sessionId,
    );
    await client.send(
      'Input.dispatchMouseEvent',
      {
        ...shared,
        type: 'mouseReleased',
        buttons: i < clickCount - 1 ? buttonsMask : 0,
        clickCount: count,
      },
      sessionId,
    );
  }
}

export async function scrollElement(
  client: CdpClient,
  sessionId: string,
  direction: 'up' | 'down' | 'left' | 'right',
  amount = 300,
  ref?: ElementRef,
): Promise<void> {
  // Cap scroll amount to prevent extreme delta values
  amount = Math.min(Math.max(1, Math.floor(amount)), 100_000);
  let x = 0;
  let y = 0;
  let deltaX = 0;
  let deltaY = 0;

  if (ref) {
    const box = await getElementBox(client, sessionId, ref);
    if (!box) throw new Error(`Cannot scroll: ref @${ref.ref} not found in DOM`);
    x = box.x;
    y = box.y;
  } else {
    // Center of viewport
    const vp = await client.send<{ result: { value: string } }>(
      'Runtime.evaluate',
      {
        expression: 'JSON.stringify({w: window.innerWidth, h: window.innerHeight})',
        returnByValue: true,
      },
      sessionId,
    );
    const dims = JSON.parse(vp.result?.value ?? '{"w":1280,"h":720}');
    x = dims.w / 2;
    y = dims.h / 2;
  }

  switch (direction) {
    case 'down':
      deltaY = amount;
      break;
    case 'up':
      deltaY = -amount;
      break;
    case 'right':
      deltaX = amount;
      break;
    case 'left':
      deltaX = -amount;
      break;
  }

  await client.send(
    'Input.dispatchMouseEvent',
    {
      type: 'mouseWheel',
      x,
      y,
      deltaX,
      deltaY,
    },
    sessionId,
  );
}

export async function hoverElement(
  client: CdpClient,
  sessionId: string,
  ref: ElementRef,
): Promise<void> {
  const box = await getElementBox(client, sessionId, ref);
  if (!box) throw new Error(`Cannot hover ref @${ref.ref}: element not found in DOM`);

  await client.send(
    'Input.dispatchMouseEvent',
    {
      type: 'mouseMoved',
      x: box.x,
      y: box.y,
    },
    sessionId,
  );
}

export async function mouseMove(
  client: CdpClient,
  sessionId: string,
  x: number,
  y: number,
): Promise<void> {
  await client.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y }, sessionId);
}

export async function mouseDown(
  client: CdpClient,
  sessionId: string,
  x: number,
  y: number,
  button: 'left' | 'right' | 'middle' = 'left',
): Promise<void> {
  const buttonsMask = button === 'right' ? 2 : button === 'middle' ? 4 : 1;
  await client.send(
    'Input.dispatchMouseEvent',
    { type: 'mousePressed', x, y, button, buttons: buttonsMask, clickCount: 1 },
    sessionId,
  );
}

export async function mouseUp(
  client: CdpClient,
  sessionId: string,
  x: number,
  y: number,
  button: 'left' | 'right' | 'middle' = 'left',
): Promise<void> {
  await client.send(
    'Input.dispatchMouseEvent',
    { type: 'mouseReleased', x, y, button, buttons: 0, clickCount: 1 },
    sessionId,
  );
}

export async function mouseWheel(
  client: CdpClient,
  sessionId: string,
  x: number,
  y: number,
  deltaY: number,
  deltaX = 0,
): Promise<void> {
  await client.send(
    'Input.dispatchMouseEvent',
    { type: 'mouseWheel', x, y, deltaX, deltaY },
    sessionId,
  );
}

export async function dragAndDrop(
  client: CdpClient,
  sessionId: string,
  src: ElementRef,
  tgt: ElementRef,
): Promise<void> {
  const srcBox = await getElementBox(client, sessionId, src);
  const tgtBox = await getElementBox(client, sessionId, tgt);
  if (!srcBox || !tgtBox) throw new Error('Cannot drag: one or both elements not found in DOM');

  await client.send(
    'Input.dispatchMouseEvent',
    { type: 'mousePressed', x: srcBox.x, y: srcBox.y, button: 'left', buttons: 1, clickCount: 1 },
    sessionId,
  );
  await client.send(
    'Input.dispatchMouseEvent',
    { type: 'mouseMoved', x: srcBox.x, y: srcBox.y, button: 'left', buttons: 1 },
    sessionId,
  );

  // Move in steps for smooth drag
  const steps = 10;
  for (let i = 1; i <= steps; i++) {
    const x = srcBox.x + (tgtBox.x - srcBox.x) * (i / steps);
    const y = srcBox.y + (tgtBox.y - srcBox.y) * (i / steps);
    await client.send(
      'Input.dispatchMouseEvent',
      { type: 'mouseMoved', x, y, button: 'left', buttons: 1 },
      sessionId,
    );
  }

  await client.send(
    'Input.dispatchMouseEvent',
    { type: 'mouseReleased', x: tgtBox.x, y: tgtBox.y, button: 'left', buttons: 0, clickCount: 1 },
    sessionId,
  );
}
