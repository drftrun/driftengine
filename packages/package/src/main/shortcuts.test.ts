import { describe, expect, it } from 'vitest';

import { isBlockedShortcut } from './shortcuts.ts';

const press = (
  key: string,
  modifiers: Partial<Record<'control' | 'meta' | 'shift' | 'alt', boolean>> = {},
) => ({
  type: 'keyDown',
  key,
  control: modifiers.control ?? false,
  meta: modifiers.meta ?? false,
  shift: modifiers.shift ?? false,
  alt: modifiers.alt ?? false,
});

describe('isBlockedShortcut', () => {
  /*
   * **A shipped game is not a browser and must not behave like one.** Chromium answers Ctrl+R,
   * F5, Ctrl+P and the inspector combinations itself, with no menu item to remove — so a player
   * leaning on Ctrl+R mid-run reloads the game and loses the run, and Ctrl+P offers to print it.
   * None of those are things a game does.
   */
  it('kills reload in a shipped build', () => {
    expect(isBlockedShortcut(press('r', { control: true }), 'linux', false)).toBe(true);
    expect(isBlockedShortcut(press('R', { control: true, shift: true }), 'linux', false)).toBe(
      true,
    );
    expect(isBlockedShortcut(press('F5'), 'win32', false)).toBe(true);
    expect(isBlockedShortcut(press('r', { meta: true }), 'darwin', false)).toBe(true);
  });

  it('kills the inspector, print, view source and find', () => {
    expect(isBlockedShortcut(press('F12'), 'win32', false)).toBe(true);
    expect(isBlockedShortcut(press('i', { control: true, shift: true }), 'linux', false)).toBe(
      true,
    );
    expect(isBlockedShortcut(press('i', { meta: true, alt: true }), 'darwin', false)).toBe(true);
    expect(isBlockedShortcut(press('p', { control: true }), 'linux', false)).toBe(true);
    expect(isBlockedShortcut(press('u', { control: true }), 'linux', false)).toBe(true);
    expect(isBlockedShortcut(press('f', { control: true }), 'linux', false)).toBe(true);
  });

  /* A game draws its own interface at its own scale. Browser zoom leaves it half off the screen. */
  it('kills browser zoom', () => {
    for (const key of ['+', '-', '=', '0']) {
      expect(isBlockedShortcut(press(key, { control: true }), 'linux', false)).toBe(true);
    }
  });

  /*
   * Quit stays. Cmd+Q on macOS is the shortcut every application on the machine answers to, and
   * Cmd+W closes a window there — a game that swallowed either would be the one application a
   * person cannot get out of.
   */
  it('leaves quitting alone', () => {
    expect(isBlockedShortcut(press('q', { meta: true }), 'darwin', false)).toBe(false);
    expect(isBlockedShortcut(press('w', { meta: true }), 'darwin', false)).toBe(false);
  });

  /* Ctrl+W is not a quit shortcut on Windows or Linux; it is a browser closing a tab. */
  it('kills Ctrl+W where it is a browser habit rather than a platform one', () => {
    expect(isBlockedShortcut(press('w', { control: true }), 'win32', false)).toBe(true);
  });

  /* Anything a game binds itself is untouched, including the keys it will actually use. */
  it('leaves the game its own keys', () => {
    expect(isBlockedShortcut(press('w'), 'linux', false)).toBe(false);
    expect(isBlockedShortcut(press('r'), 'linux', false)).toBe(false);
    expect(isBlockedShortcut(press('Escape'), 'linux', false)).toBe(false);
    expect(isBlockedShortcut(press('F11'), 'linux', false)).toBe(false);
  });

  /* A key going up is not a shortcut, and blocking it would break a game's own key handling. */
  it('only considers a key going down', () => {
    expect(
      isBlockedShortcut({ ...press('r', { control: true }), type: 'keyUp' }, 'linux', false),
    ).toBe(false);
  });

  /* In development every one of them is available, which is the point of a development run. */
  it('blocks nothing in a development run', () => {
    expect(isBlockedShortcut(press('r', { control: true }), 'linux', true)).toBe(false);
    expect(isBlockedShortcut(press('F12'), 'linux', true)).toBe(false);
  });
});
