import { expect, test } from 'vitest';

import { glyphFor, identifyGamepad, labelFor } from './gamepadIdentity.ts';

/**
 * Both `id` shapes browsers actually produce, which are not the same shape.
 *
 * Chromium puts the vendor pair in parentheses; Firefox prefixes it. A parser that knew only one
 * would report `generic` for every pad in the other browser — a wrong glyph on screen, with
 * nothing anywhere reporting it.
 */
test('a vendor is read from either shape of id string', () => {
  expect(identifyGamepad('Wireless Controller (STANDARD GAMEPAD Vendor: 054c Product: 09cc)')).toBe(
    'playstation',
  );
  expect(identifyGamepad('054c-09cc-Wireless Controller')).toBe('playstation');
  expect(identifyGamepad('Xbox 360 Controller (XInput STANDARD GAMEPAD)')).toBe('xbox');
  expect(identifyGamepad('045e-028e-Microsoft X-Box 360 pad')).toBe('xbox');
  expect(identifyGamepad('057e-2009-Nintendo Switch Pro Controller')).toBe('nintendo');
});

test('anything unrecognised is generic rather than guessed', () => {
  expect(identifyGamepad('Some Arcade Stick')).toBe('generic');
  expect(identifyGamepad('')).toBe('generic');
});

/**
 * The swap this whole design exists for.
 *
 * `faceDown` is one position. Three vendors give it three different names, and two of those are
 * each other's — an Xbox pad's A is where a Nintendo pad's B is.
 */
test('one position, three names, and two of them are swapped', () => {
  expect(labelFor('xbox', 'faceDown')).toBe('A');
  expect(labelFor('nintendo', 'faceDown')).toBe('B');
  expect(labelFor('playstation', 'faceDown')).toBe('Cross');

  expect(labelFor('xbox', 'faceRight')).toBe('B');
  expect(labelFor('nintendo', 'faceRight')).toBe('A');
  expect(labelFor('playstation', 'faceRight')).toBe('Circle');
});

test('a generic pad is labelled by its position, which is not wrong', () => {
  expect(labelFor('generic', 'faceDown')).toBe('Face Down');
  expect(labelFor('generic', 'l1')).toBe('L1');
});

test('a glyph key names the family and the position, so a consumer can map it', () => {
  expect(glyphFor('xbox', 'faceDown')).toBe('xbox.a');
  expect(glyphFor('playstation', 'faceDown')).toBe('playstation.cross');
  expect(glyphFor('nintendo', 'faceDown')).toBe('nintendo.b');
  expect(glyphFor('generic', 'faceDown')).toBe('generic.faceDown');
});
