import type { CdpClient } from './cdp.js';

export async function typeText(client: CdpClient, sessionId: string, text: string): Promise<void> {
  // Cap to 100 KB to prevent OOM in CDP message serializer
  const safeText = text.length > 102_400 ? text.slice(0, 102_400) : text;
  await client.send('Input.insertText', { text: safeText }, sessionId);
}

export async function pressKeyCombo(
  client: CdpClient,
  sessionId: string,
  key: string,
  modifiers: number,
): Promise<void> {
  const { text: _text, ...keyInfo } = resolveKey(key);
  // rawKeyDown prevents Chrome from inserting the character text; only the shortcut fires
  await client.send(
    'Input.dispatchKeyEvent',
    { type: 'rawKeyDown', ...keyInfo, modifiers },
    sessionId,
  );
  await client.send('Input.dispatchKeyEvent', { type: 'keyUp', ...keyInfo, modifiers }, sessionId);
}

export async function pressKey(client: CdpClient, sessionId: string, key: string): Promise<void> {
  const { text, ...keyInfo } = resolveKey(key);

  // rawKeyDown does not insert text; the explicit char event handles insertion
  await client.send(
    'Input.dispatchKeyEvent',
    {
      type: 'rawKeyDown',
      ...keyInfo,
    },
    sessionId,
  );

  if (text) {
    await client.send(
      'Input.dispatchKeyEvent',
      {
        type: 'char',
        text,
      },
      sessionId,
    );
  }

  await client.send(
    'Input.dispatchKeyEvent',
    {
      type: 'keyUp',
      ...keyInfo,
    },
    sessionId,
  );
}

function resolveKey(key: string): {
  key: string;
  code: string;
  text?: string;
  windowsVirtualKeyCode?: number;
} {
  const keyMap: Record<
    string,
    { key: string; code: string; text?: string; windowsVirtualKeyCode?: number }
  > = {
    Enter: { key: 'Enter', code: 'Enter', text: '\r', windowsVirtualKeyCode: 13 },
    Tab: { key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 },
    Escape: { key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 },
    Backspace: { key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 },
    Delete: { key: 'Delete', code: 'Delete', windowsVirtualKeyCode: 46 },
    ArrowUp: { key: 'ArrowUp', code: 'ArrowUp', windowsVirtualKeyCode: 38 },
    ArrowDown: { key: 'ArrowDown', code: 'ArrowDown', windowsVirtualKeyCode: 40 },
    ArrowLeft: { key: 'ArrowLeft', code: 'ArrowLeft', windowsVirtualKeyCode: 37 },
    ArrowRight: { key: 'ArrowRight', code: 'ArrowRight', windowsVirtualKeyCode: 39 },
    Home: { key: 'Home', code: 'Home', windowsVirtualKeyCode: 36 },
    End: { key: 'End', code: 'End', windowsVirtualKeyCode: 35 },
    PageUp: { key: 'PageUp', code: 'PageUp', windowsVirtualKeyCode: 33 },
    PageDown: { key: 'PageDown', code: 'PageDown', windowsVirtualKeyCode: 34 },
    Space: { key: ' ', code: 'Space', text: ' ', windowsVirtualKeyCode: 32 },
    ' ': { key: ' ', code: 'Space', text: ' ', windowsVirtualKeyCode: 32 },
    Shift: { key: 'Shift', code: 'ShiftLeft', windowsVirtualKeyCode: 16 },
    Control: { key: 'Control', code: 'ControlLeft', windowsVirtualKeyCode: 17 },
    Alt: { key: 'Alt', code: 'AltLeft', windowsVirtualKeyCode: 18 },
    Meta: { key: 'Meta', code: 'MetaLeft', windowsVirtualKeyCode: 91 },
    F1: { key: 'F1', code: 'F1', windowsVirtualKeyCode: 112 },
    F2: { key: 'F2', code: 'F2', windowsVirtualKeyCode: 113 },
    F3: { key: 'F3', code: 'F3', windowsVirtualKeyCode: 114 },
    F4: { key: 'F4', code: 'F4', windowsVirtualKeyCode: 115 },
    F5: { key: 'F5', code: 'F5', windowsVirtualKeyCode: 116 },
    F6: { key: 'F6', code: 'F6', windowsVirtualKeyCode: 117 },
    F7: { key: 'F7', code: 'F7', windowsVirtualKeyCode: 118 },
    F8: { key: 'F8', code: 'F8', windowsVirtualKeyCode: 119 },
    F9: { key: 'F9', code: 'F9', windowsVirtualKeyCode: 120 },
    F10: { key: 'F10', code: 'F10', windowsVirtualKeyCode: 121 },
    F11: { key: 'F11', code: 'F11', windowsVirtualKeyCode: 122 },
    F12: { key: 'F12', code: 'F12', windowsVirtualKeyCode: 123 },
  };

  if (keyMap[key]) return keyMap[key];

  // Single printable character — windowsVirtualKeyCode required for rawKeyDown shortcut dispatch
  if (key.length === 1) {
    const charCode = key.charCodeAt(0);
    if (charCode >= 48 && charCode <= 57) {
      return { key, code: `Digit${key}`, text: key, windowsVirtualKeyCode: charCode };
    }
    if ((charCode >= 65 && charCode <= 90) || (charCode >= 97 && charCode <= 122)) {
      return {
        key,
        code: `Key${key.toUpperCase()}`,
        text: key,
        windowsVirtualKeyCode: key.toUpperCase().charCodeAt(0),
      };
    }
    // Symbol keys: map to the physical key's code and Windows virtual key code
    const symbolMap: Record<string, { code: string; windowsVirtualKeyCode: number }> = {
      '!': { code: 'Digit1', windowsVirtualKeyCode: 49 },
      '@': { code: 'Digit2', windowsVirtualKeyCode: 50 },
      '#': { code: 'Digit3', windowsVirtualKeyCode: 51 },
      $: { code: 'Digit4', windowsVirtualKeyCode: 52 },
      '%': { code: 'Digit5', windowsVirtualKeyCode: 53 },
      '^': { code: 'Digit6', windowsVirtualKeyCode: 54 },
      '&': { code: 'Digit7', windowsVirtualKeyCode: 55 },
      '*': { code: 'Digit8', windowsVirtualKeyCode: 56 },
      '(': { code: 'Digit9', windowsVirtualKeyCode: 57 },
      ')': { code: 'Digit0', windowsVirtualKeyCode: 48 },
      '-': { code: 'Minus', windowsVirtualKeyCode: 189 },
      _: { code: 'Minus', windowsVirtualKeyCode: 189 },
      '=': { code: 'Equal', windowsVirtualKeyCode: 187 },
      '+': { code: 'Equal', windowsVirtualKeyCode: 187 },
      '[': { code: 'BracketLeft', windowsVirtualKeyCode: 219 },
      '{': { code: 'BracketLeft', windowsVirtualKeyCode: 219 },
      ']': { code: 'BracketRight', windowsVirtualKeyCode: 221 },
      '}': { code: 'BracketRight', windowsVirtualKeyCode: 221 },
      '\\': { code: 'Backslash', windowsVirtualKeyCode: 220 },
      '|': { code: 'Backslash', windowsVirtualKeyCode: 220 },
      ';': { code: 'Semicolon', windowsVirtualKeyCode: 186 },
      ':': { code: 'Semicolon', windowsVirtualKeyCode: 186 },
      "'": { code: 'Quote', windowsVirtualKeyCode: 222 },
      '"': { code: 'Quote', windowsVirtualKeyCode: 222 },
      '`': { code: 'Backquote', windowsVirtualKeyCode: 192 },
      '~': { code: 'Backquote', windowsVirtualKeyCode: 192 },
      ',': { code: 'Comma', windowsVirtualKeyCode: 188 },
      '<': { code: 'Comma', windowsVirtualKeyCode: 188 },
      '.': { code: 'Period', windowsVirtualKeyCode: 190 },
      '>': { code: 'Period', windowsVirtualKeyCode: 190 },
      '/': { code: 'Slash', windowsVirtualKeyCode: 191 },
      '?': { code: 'Slash', windowsVirtualKeyCode: 191 },
    };
    const sym = symbolMap[key];
    if (sym)
      return { key, code: sym.code, text: key, windowsVirtualKeyCode: sym.windowsVirtualKeyCode };
    // Unknown/non-ASCII character — omit code since no valid DOM KeyboardEvent.code exists
    return { key, code: '', text: key };
  }

  return { key, code: key };
}

export async function keyDown(client: CdpClient, sessionId: string, key: string): Promise<void> {
  const { text: _text, ...keyInfo } = resolveKey(key);
  await client.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...keyInfo }, sessionId);
}

export async function keyUp(client: CdpClient, sessionId: string, key: string): Promise<void> {
  const { text: _text, ...keyInfo } = resolveKey(key);
  await client.send('Input.dispatchKeyEvent', { type: 'keyUp', ...keyInfo }, sessionId);
}
