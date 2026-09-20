/**
 * A key, named as a browser names it, from the scancode SDL reports.
 *
 * **`code` is the name that matters**: the engine binds by it and so does every game on it, because
 * it names a key's position rather than what the layout prints on it. SDL's scancode is the USB
 * keyboard usage for that position, and the W3C table of codes is written against the same usages,
 * so the two meet by number. `key` is what the key types, which a text field wants and a game
 * mostly does not.
 *
 * What it gives up: keys a game does not bind — media keys, the international keys beyond the ISO
 * backslash, a keypad's rarer members — have no `code` here and arrive as `Unidentified` rather
 * than as a guess. Usage 0x32, the ISO hash key most boards report as 0x31 anyway, is one of them.
 */

const CODES = new Map<number, string>();
for (let at = 0; at < 26; at += 1) CODES.set(4 + at, `Key${String.fromCharCode(65 + at)}`);
for (let at = 0; at < 9; at += 1) CODES.set(30 + at, `Digit${at + 1}`);
CODES.set(39, 'Digit0');
for (let at = 0; at < 12; at += 1) CODES.set(58 + at, `F${at + 1}`);
for (let at = 0; at < 9; at += 1) CODES.set(89 + at, `Numpad${at + 1}`);
for (const [usage, code] of [
  [40, 'Enter'],
  [41, 'Escape'],
  [42, 'Backspace'],
  [43, 'Tab'],
  [44, 'Space'],
  [45, 'Minus'],
  [46, 'Equal'],
  [47, 'BracketLeft'],
  [48, 'BracketRight'],
  [49, 'Backslash'],
  [51, 'Semicolon'],
  [52, 'Quote'],
  [53, 'Backquote'],
  [54, 'Comma'],
  [55, 'Period'],
  [56, 'Slash'],
  [57, 'CapsLock'],
  [70, 'PrintScreen'],
  [71, 'ScrollLock'],
  [72, 'Pause'],
  [73, 'Insert'],
  [74, 'Home'],
  [75, 'PageUp'],
  [76, 'Delete'],
  [77, 'End'],
  [78, 'PageDown'],
  [79, 'ArrowRight'],
  [80, 'ArrowLeft'],
  [81, 'ArrowDown'],
  [82, 'ArrowUp'],
  [83, 'NumLock'],
  [84, 'NumpadDivide'],
  [85, 'NumpadMultiply'],
  [86, 'NumpadSubtract'],
  [87, 'NumpadAdd'],
  [88, 'NumpadEnter'],
  [98, 'Numpad0'],
  [99, 'NumpadDecimal'],
  [100, 'IntlBackslash'],
  [101, 'ContextMenu'],
  [103, 'NumpadEqual'],
  [224, 'ControlLeft'],
  [225, 'ShiftLeft'],
  [226, 'AltLeft'],
  [227, 'MetaLeft'],
  [228, 'ControlRight'],
  [229, 'ShiftRight'],
  [230, 'AltRight'],
  [231, 'MetaRight'],
] as const) {
  CODES.set(usage, code);
}

/** `KeyboardEvent.key` for the keys that type nothing, by position. */
const NAMED = new Map<number, string>([
  [40, 'Enter'],
  [88, 'Enter'],
  [41, 'Escape'],
  [42, 'Backspace'],
  [43, 'Tab'],
  [44, ' '],
  [57, 'CapsLock'],
  [70, 'PrintScreen'],
  [71, 'ScrollLock'],
  [72, 'Pause'],
  [73, 'Insert'],
  [74, 'Home'],
  [75, 'PageUp'],
  [76, 'Delete'],
  [77, 'End'],
  [78, 'PageDown'],
  [79, 'ArrowRight'],
  [80, 'ArrowLeft'],
  [81, 'ArrowDown'],
  [82, 'ArrowUp'],
  [83, 'NumLock'],
  [101, 'ContextMenu'],
  [224, 'Control'],
  [228, 'Control'],
  [225, 'Shift'],
  [229, 'Shift'],
  [226, 'Alt'],
  [230, 'Alt'],
  [227, 'Meta'],
  [231, 'Meta'],
]);
for (let at = 0; at < 12; at += 1) NAMED.set(58 + at, `F${at + 1}`);

/** The position's name, or null for one this table does not name. */
export function codeOf(scancode: number): string | null {
  return CODES.get(scancode) ?? null;
}

/**
 * What the key types, from SDL's name for it: the character, shifted where it is a letter and
 * shift is held, or the browser's name for a key that types nothing.
 */
export function keyOf(key: string | null, scancode: number, shifted: boolean): string {
  if (key !== null && key.length === 1) {
    return shifted && key >= 'a' && key <= 'z' ? key.toUpperCase() : key;
  }
  return NAMED.get(scancode) ?? 'Unidentified';
}

/**
 * The legacy `keyCode` a browser still sends on `keydown` and `keyup`: the Windows virtual-key code
 * for the position, which Chrome sends on every platform.
 */
const LEGACY = new Map<string, number>([
  ['Backspace', 8],
  ['Tab', 9],
  ['Enter', 13],
  ['NumpadEnter', 13],
  ['ShiftLeft', 16],
  ['ShiftRight', 16],
  ['ControlLeft', 17],
  ['ControlRight', 17],
  ['AltLeft', 18],
  ['AltRight', 18],
  ['Pause', 19],
  ['CapsLock', 20],
  ['Escape', 27],
  ['Space', 32],
  ['PageUp', 33],
  ['PageDown', 34],
  ['End', 35],
  ['Home', 36],
  ['ArrowLeft', 37],
  ['ArrowUp', 38],
  ['ArrowRight', 39],
  ['ArrowDown', 40],
  ['PrintScreen', 44],
  ['Insert', 45],
  ['Delete', 46],
  ['MetaLeft', 91],
  ['MetaRight', 92],
  ['ContextMenu', 93],
  ['NumpadMultiply', 106],
  ['NumpadAdd', 107],
  ['NumpadSubtract', 109],
  ['NumpadDecimal', 110],
  ['NumpadDivide', 111],
  ['NumLock', 144],
  ['ScrollLock', 145],
  ['Semicolon', 186],
  ['Equal', 187],
  ['Comma', 188],
  ['Minus', 189],
  ['Period', 190],
  ['Slash', 191],
  ['Backquote', 192],
  ['BracketLeft', 219],
  ['Backslash', 220],
  ['BracketRight', 221],
  ['Quote', 222],
  ['IntlBackslash', 226],
]);
for (let at = 0; at < 10; at += 1) {
  LEGACY.set(`Digit${at}`, 48 + at);
  LEGACY.set(`Numpad${at}`, 96 + at);
}
for (let at = 0; at < 24; at += 1) LEGACY.set(`F${at + 1}`, 112 + at);

/**
 * `keyCode` for a key down or up. A letter key's is the letter the layout puts there, as Chrome's
 * is — `KeyQ` on an AZERTY board types `a` and reports 65 — and every other key's is its position's.
 */
export function legacyKeyCode(code: string, key: string): number {
  if (/^[a-z]$/i.test(key)) return key.toUpperCase().charCodeAt(0);
  if (/^Key[A-Z]$/.test(code)) return code.charCodeAt(3);
  return LEGACY.get(code) ?? 0;
}

/**
 * Which of the four locations a key is in: 1 and 2 for a modifier's two sides, 3 for the keypad.
 * Only the modifiers have sides — `BracketLeft` and `ArrowLeft` are standard keys.
 */
export function keyLocation(code: string): number {
  const side = /^(?:Shift|Control|Alt|Meta)(Left|Right)$/.exec(code)?.[1];
  if (side !== undefined) return side === 'Left' ? 1 : 2;
  return code.startsWith('Numpad') ? 3 : 0;
}
