import { describe, expect, test } from 'vitest';

import { codeOf, keyOf } from './keyCodes.ts';

/**
 * **What this file is for: a key reaching the engine by the name a browser gives it.** The engine,
 * and every game on it, binds keys by `KeyboardEvent.code` — `KeyW`, `Space`, `ShiftLeft` — which
 * names a key's position. SDL reports a scancode, which is the USB keyboard usage for that position
 * (measured from the binding: `A` is 4, `1` is 30, `LSHIFT` 225), and the W3C table of codes is
 * keyed on the same usages. So a position crosses by number, whatever the layout prints on it.
 */
describe('a scancode, as a browser names the key', () => {
  test('LETTERS, DIGITS AND THE KEYS A GAME BINDS', () => {
    expect(codeOf(4)).toBe('KeyA');
    expect(codeOf(26)).toBe('KeyW');
    expect(codeOf(29)).toBe('KeyZ');
    /* The digit row runs 1 to 9 and then 0, as the usage table does. */
    expect(codeOf(30)).toBe('Digit1');
    expect(codeOf(38)).toBe('Digit9');
    expect(codeOf(39)).toBe('Digit0');
    expect(codeOf(44)).toBe('Space');
    expect(codeOf(43)).toBe('Tab');
    expect(codeOf(41)).toBe('Escape');
    expect(codeOf(40)).toBe('Enter');
  });

  test('THE TWO SIDES OF A MODIFIER ARE TWO KEYS', () => {
    expect(codeOf(225)).toBe('ShiftLeft');
    expect(codeOf(229)).toBe('ShiftRight');
    expect(codeOf(224)).toBe('ControlLeft');
    expect(codeOf(230)).toBe('AltRight');
    expect(codeOf(227)).toBe('MetaLeft');
  });

  test('ARROWS, FUNCTION KEYS AND THE KEYPAD', () => {
    expect(codeOf(79)).toBe('ArrowRight');
    expect(codeOf(82)).toBe('ArrowUp');
    expect(codeOf(58)).toBe('F1');
    expect(codeOf(69)).toBe('F12');
    expect(codeOf(89)).toBe('Numpad1');
    expect(codeOf(98)).toBe('Numpad0');
    expect(codeOf(88)).toBe('NumpadEnter');
    expect(codeOf(100)).toBe('IntlBackslash');
  });

  test('A POSITION WITH NO NAME IS NULL, not a guess', () => {
    expect(codeOf(0)).toBeNull();
    expect(codeOf(500)).toBeNull();
  });

  test('THE CHARACTER, where there is one, and a named key otherwise', () => {
    /* SDL names a key unshifted and in lower case; a browser's `key` is what the key types. */
    expect(keyOf('w', 26, false)).toBe('w');
    expect(keyOf('w', 26, true)).toBe('W');
    expect(keyOf('space', 44, false)).toBe(' ');
    expect(keyOf('return', 40, false)).toBe('Enter');
    expect(keyOf('shift', 225, true)).toBe('Shift');
    expect(keyOf('down', 81, false)).toBe('ArrowDown');
    expect(keyOf(null, 0, false)).toBe('Unidentified');
  });
});
