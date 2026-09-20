import { expect, test } from 'vitest';

import { sdlWindowFlags } from './windowMode.ts';

/**
 * **What this file is for: a packaged game's window being the one its manifest asked for.** The
 * desktop shell hands `window.mode` and `window.resizable` to Electron; the native host opened
 * every window resizable and windowed whatever the manifest said, which nothing reported.
 */
test('A WINDOW IS WINDOWED AND RESIZABLE UNLESS ASKED OTHERWISE', () => {
  expect(sdlWindowFlags()).toEqual({ fullscreen: false, borderless: false, resizable: true });
});

test('FULLSCREEN KEEPS ITS FRAME FLAG, AND BORDERLESS IS A WINDOW WITHOUT ONE', () => {
  expect(sdlWindowFlags('fullscreen', true)).toEqual({
    fullscreen: true,
    borderless: false,
    resizable: true,
  });
  expect(sdlWindowFlags('borderless', false)).toEqual({
    fullscreen: false,
    borderless: true,
    resizable: false,
  });
});
