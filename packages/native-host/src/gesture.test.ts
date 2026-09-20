import { EventEmitter } from 'node:events';

import { afterEach, describe, expect, test } from 'vitest';

import { NativeCanvas } from './canvas.ts';
import { connectDomEvents, type EventWindow } from './domEvents.ts';
import { HostPage } from './page.ts';

/**
 * **What this file is for: what a page may do only when a person has just done something.** Chrome
 * gates pointer lock and fullscreen on a gesture — a key down, a mouse press, a lift of a finger —
 * that lasts five seconds, and a page on this host that works only because nothing gated it would
 * fail the moment it ran in a browser. Every refusal and every figure below is Chrome 151's,
 * measured 2026-09-19 over the DevTools protocol.
 */

let undo: (() => void)[] = [];
afterEach(() => {
  for (const step of undo.reverse()) step();
  undo = [];
});

let clock = 0;

function setUp() {
  clock = 0;
  const page = new HostPage({ now: () => clock });
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
  undo.push(
    connectDomEvents(window as unknown as EventWindow, mouse, page, canvas, { now: () => clock }),
  );
  const press = () => {
    window.emit('mouseButtonDown', { x: 10, y: 10, button: 1, touch: false });
    window.emit('mouseButtonUp', { x: 10, y: 10, button: 1, touch: false });
  };
  return { page, canvas, window, press };
}

const outcome = (promise: Promise<unknown>) =>
  promise.then(
    () => 'granted',
    (error: Error) => `${error.name}: ${error.message}`,
  );

describe('pointer lock', () => {
  test('ASKED WITH NO GESTURE, IT IS REFUSED as Chrome refuses it', async () => {
    const { page, canvas } = setUp();
    let errors = 0;
    page.document.addEventListener('pointerlockerror', () => (errors += 1));
    expect(await outcome(canvas.requestPointerLock())).toBe(
      'NotAllowedError: A user gesture is required to request Pointer Lock.',
    );
    expect([page.document.pointerLockElement, errors]).toEqual([null, 1]);
  });

  test('ASKED IN A PRESS, IT IS GRANTED, and leaves the gesture for fullscreen after it', async () => {
    const { page, canvas, press } = setUp();
    let asked: Promise<string>[] = [];
    canvas.addEventListener('mousedown', () => {
      asked = [outcome(canvas.requestPointerLock())];
    });
    press();
    clock += 100;
    asked.push(outcome(canvas.requestFullscreen()));
    expect(await Promise.all(asked)).toEqual(['granted', 'granted']);
    expect(page.document.pointerLockElement).toBe(canvas);
  });
});

describe('fullscreen', () => {
  test('ASKED WITH NO GESTURE, IT IS REFUSED, and says so at the canvas', async () => {
    const { page, canvas } = setUp();
    let errors = 0;
    page.document.addEventListener('fullscreenerror', () => (errors += 1));
    expect(await outcome(canvas.requestFullscreen())).toBe('TypeError: Permissions check failed');
    expect([page.document.fullscreenElement, errors]).toEqual([null, 1]);
  });

  test('IT SPENDS ITS GESTURE: a second request after the first is refused', async () => {
    const { canvas, press } = setUp();
    press();
    const first = await outcome(canvas.requestFullscreen());
    await outcome(canvas.ownerDocument.exitFullscreen());
    clock += 100;
    expect([first, await outcome(canvas.requestFullscreen())]).toEqual([
      'granted',
      'TypeError: Permissions check failed',
    ]);
  });

  test('A GESTURE LASTS FIVE SECONDS', async () => {
    const { canvas, press } = setUp();
    press();
    clock += 4500;
    const inTime = await outcome(canvas.requestFullscreen());
    await outcome(canvas.ownerDocument.exitFullscreen());
    press();
    clock += 5500;
    expect([inTime, await outcome(canvas.requestFullscreen())]).toEqual([
      'granted',
      'TypeError: Permissions check failed',
    ]);
  });

  test('A KEY IS A GESTURE, AND ESCAPE IS NOT ONE', async () => {
    const { canvas, window } = setUp();
    const key = (scancode: number) => ({
      scancode,
      key: null,
      shift: 0,
      ctrl: 0,
      alt: 0,
      super: 0,
    });
    window.emit('keyDown', key(41));
    await Promise.resolve();
    const afterEscape = await outcome(canvas.requestFullscreen());
    window.emit('keyDown', key(4));
    await Promise.resolve();
    expect([afterEscape, await outcome(canvas.requestFullscreen())]).toEqual([
      'TypeError: Permissions check failed',
      'granted',
    ]);
  });

  test('THE WINDOW GOES FULLSCREEN, the document says which element, and each change is heard', async () => {
    const { page, canvas, window, press } = setUp();
    const heard: string[] = [];
    page.document.addEventListener('fullscreenchange', (event) =>
      heard.push(`${event.target === canvas ? 'canvas' : 'other'} ${String(window.fullscreen)}`),
    );
    press();
    await canvas.requestFullscreen();
    expect([page.document.fullscreenElement, page.document.fullscreenEnabled]).toEqual([
      canvas,
      true,
    ]);
    await page.document.exitFullscreen();
    expect(page.document.fullscreenElement).toBeNull();
    expect(heard).toEqual(['canvas true', 'canvas false']);
  });

  test('LEAVING WHEN NOT FULLSCREEN IS REFUSED as Chrome refuses it', async () => {
    const { page } = setUp();
    expect(await outcome(page.document.exitFullscreen())).toBe(
      "TypeError: Failed to execute 'exitFullscreen' on 'Document': Document not active",
    );
  });

  test('ESCAPE LEAVES IT, AND SO DOES A WINDOW TAKEN OUT OF FULLSCREEN BY ANYTHING ELSE', async () => {
    const { page, canvas, window, press } = setUp();
    press();
    await canvas.requestFullscreen();
    window.emit('keyDown', { scancode: 41, key: null, shift: 0, ctrl: 0, alt: 0, super: 0 });
    expect([page.document.fullscreenElement, window.fullscreen]).toEqual([null, false]);

    press();
    await canvas.requestFullscreen();
    /* The shell's bridge, or the window manager, takes the window out; SDL then says it resized. */
    window.fullscreen = false;
    window.emit('resize', { width: 640, height: 480, pixelWidth: 640, pixelHeight: 480 });
    expect(page.document.fullscreenElement).toBeNull();
  });

  /*
   * **A window that was fullscreen before the page asked stays fullscreen after it leaves**, as a
   * browser already fullscreen with F11 stays so when a page's element leaves: a game packaged with
   * `window.mode: "fullscreen"` would otherwise drop to a window the first time its page left, or a
   * person pressed Escape.
   */
  test('LEAVING PUTS THE WINDOW BACK AS IT WAS, fullscreen if it was fullscreen before', async () => {
    const { page, canvas, window, press } = setUp();
    window.fullscreen = true;
    press();
    await canvas.requestFullscreen();
    await page.document.exitFullscreen();
    expect([page.document.fullscreenElement, window.fullscreen]).toEqual([null, true]);

    press();
    await canvas.requestFullscreen();
    window.emit('keyDown', { scancode: 41, key: null, shift: 0, ctrl: 0, alt: 0, super: 0 });
    expect([page.document.fullscreenElement, window.fullscreen]).toEqual([null, true]);
  });

  test('THE PAGE CAN ASK WHETHER A PERSON IS HERE, as navigator.userActivation answers', () => {
    const { page, press } = setUp();
    expect([page.userActivation.isActive, page.userActivation.hasBeenActive]).toEqual([
      false,
      false,
    ]);
    press();
    clock += 6000;
    expect([page.userActivation.isActive, page.userActivation.hasBeenActive]).toEqual([
      false,
      true,
    ]);
  });
});
