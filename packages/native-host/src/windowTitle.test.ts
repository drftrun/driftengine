import { expect, test } from 'vitest';

import { windowTitle } from './windowTitle.ts';

/**
 * **What this file is for: a title a window manager shows as it was written.** Under X11 this SDL
 * writes the title in the process's C locale and adds no UTF-8 one, so an em dash came out of the
 * native window as `â€”` — reported by the maintainer on 2026-09-19, and read back with `xprop`.
 */
test('UNDER X11 A TITLE IS ASCII: accents dropped, dashes and quotes plain, the rest a question mark', () => {
  expect(windowTitle('Showroom — DriftEngine', 'x11')).toBe('Showroom - DriftEngine');
  expect(windowTitle('Café “Noir” – ‘1’', 'x11')).toBe('Cafe "Noir" - \'1\'');
  expect(windowTitle('日本', 'x11')).toBe('??');
});

test('UNDER WAYLAND, WHOSE TITLE IS UTF-8, IT IS LEFT AS IT IS', () => {
  expect(windowTitle('Showroom — DriftEngine', 'wayland')).toBe('Showroom — DriftEngine');
});
