import { EventEmitter } from 'node:events';

import { afterEach, describe, expect, test, vi } from 'vitest';

import { NativeCanvas } from './canvas.ts';
import { connectDomEvents, type EventWindow } from './domEvents.ts';
import { HostPage } from './page.ts';

/**
 * **What this file is for: `matchMedia`, which the engine asks before it decides a device is a
 * phone.** The engine reads `(pointer: coarse)` to choose touch controls and to ask for fullscreen
 * on a first gesture; a consumer may ask anything. The answers are this host's, a desktop window's:
 * a mouse that hovers, the window's size, fullscreen as a display mode. Chrome in a desktop window
 * answers `(pointer: fine)` and `(hover: hover)` for a machine with a mouse; headless Chrome, which
 * has none, answered `(pointer: none)` and `(hover: none)` when measured, so no literal here is
 * headless Chrome's.
 */

let undo: (() => void)[] = [];
afterEach(() => {
  for (const step of undo.reverse()) step();
  undo = [];
});

function setUp() {
  const page = new HostPage({ now: () => 0 });
  undo.push(page.install());
  const canvas = new NativeCanvas(640, 480);
  page.attach(canvas);
  const window = Object.assign(new EventEmitter(), {
    x: 0,
    y: 0,
    width: 640,
    height: 480,
    fullscreen: false,
    setFullscreen(on: boolean) {
      window.fullscreen = on;
    },
  });
  const mouse = {
    setPosition: () => {},
    showCursor: () => {},
    capture: () => {},
    uncapture: () => {},
  };
  undo.push(connectDomEvents(window as unknown as EventWindow, mouse, page, canvas));
  const matches = (query: string) => page.window.matchMedia(query).matches;
  return { page, canvas, window, matches };
}

describe('matchMedia on a desktop window', () => {
  test('THE POINTER IS A MOUSE THAT HOVERS, and it is the global a page reads too', () => {
    const { matches } = setUp();
    expect(
      ['(pointer: coarse)', '(pointer: fine)', '(hover: hover)', '(hover: none)'].map(matches),
    ).toEqual([false, true, true, false]);
    expect(typeof (globalThis as { matchMedia?: unknown }).matchMedia).toBe('function');
  });

  test('A TOUCH SCREEN IS KNOWN ONCE A FINGER HAS LANDED, and a list watching it is told', () => {
    const { page, window } = setUp();
    const list = page.window.matchMedia('(any-pointer: coarse)');
    const told: boolean[] = [];
    list.addEventListener('change', (event) => told.push((event as MediaQueryListEvent).matches));
    expect(list.matches).toBe(false);
    window.emit('fingerDown', { fingerId: 1, x: 0.5, y: 0.5, pressure: 1, mouse: false });
    expect([list.matches, told]).toEqual([true, [true]]);
  });

  test('THE WINDOW’S SIZE AND SHAPE, which change as it is resized', () => {
    const { page, canvas, window, matches } = setUp();
    expect(
      [
        '(min-width: 600px)',
        '(max-width: 600px)',
        '(width >= 641px)',
        '(width > 640px)',
        '(orientation: landscape)',
        '(min-resolution: 1dppx)',
      ].map(matches),
    ).toEqual([true, false, false, false, true, true]);
    const list = page.window.matchMedia('(orientation: portrait)');
    const steady = page.window.matchMedia('(hover: hover)');
    let changes = 0;
    let steadyChanges = 0;
    list.onchange = () => (changes += 1);
    steady.onchange = () => (steadyChanges += 1);
    canvas.resizeTo(400, 800);
    window.emit('resize', { width: 400, height: 800, pixelWidth: 400, pixelHeight: 800 });
    /* Told when its answer flips, and a list whose answer did not is told nothing. */
    expect([list.matches, changes, steadyChanges]).toEqual([true, 1, 0]);
  });

  test('FULLSCREEN IS A DISPLAY MODE; a window is otherwise standalone', async () => {
    const { page, canvas, window, matches } = setUp();
    expect(matches('(display-mode: standalone)')).toBe(true);
    window.emit('mouseButtonDown', { x: 1, y: 1, button: 1, touch: false });
    await canvas.requestFullscreen();
    expect([matches('(display-mode: fullscreen)'), page.document.fullscreenElement]).toEqual([
      true,
      canvas,
    ]);
  });

  test('A LIST IS AN OR, NOT NEGATES A QUERY, AND PRINT IS NEVER THIS', () => {
    const { matches } = setUp();
    expect(
      [
        '(pointer: coarse), (hover: hover)',
        'not all and (pointer: coarse)',
        'screen and (pointer: fine)',
        'only screen and (hover: hover) and (pointer: coarse)',
        'print',
        '(prefers-reduced-motion: no-preference)',
      ].map(matches),
    ).toEqual([true, true, true, false, false, true]);
  });

  test('A FEATURE THIS HOST DOES NOT KNOW IS FALSE, and it says which, once', () => {
    const { matches } = setUp();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      expect([matches('(inverted-colors: inverted)'), matches('(inverted-colors: none)')]).toEqual([
        false,
        false,
      ]);
      const said = warn.mock.calls.filter((call) => String(call[0]).includes('inverted-colors'));
      expect(said.length).toBe(1);
    } finally {
      warn.mockRestore();
    }
  });
});
