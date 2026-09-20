import { EventEmitter } from 'node:events';
import { InputSource } from '@driftengine/core';
import { afterEach, expect, test } from 'vitest';

import { NativeCanvas } from './canvas.ts';
import { connectDomEvents, type EventWindow } from './domEvents.ts';
import { HostPage } from './page.ts';

/**
 * **A key pressed on the host reaches the engine's input, the way one does in a browser.**
 *
 * Every piece of this chain was tested and the chain was not: `domEvents.test.ts` checks that an
 * SDL `keyDown` becomes a `keydown` on the page's window, and core's own tests check that an
 * `InputSource` registers one — with nothing in between asserting that a scene on the native host
 * can be driven from its keyboard. That is the shape of gap this repository keeps finding: two
 * halves, each green, and no test of the seam.
 *
 * Reported from a maintainer's machine on 2026-09-20 as *the keyboard does not work in
 * `npm run native:scene`*.
 */

let undo: (() => void)[] = [];
afterEach(() => {
  for (const step of undo.reverse()) step();
  undo = [];
});

const key = (scancode: number, extra: Record<string, unknown> = {}) => ({
  scancode,
  key: null,
  repeat: 0,
  shift: 0,
  ctrl: 0,
  alt: 0,
  super: 0,
  ...extra,
});

function hosted() {
  const page = new HostPage();
  undo.push(page.install());
  const canvas = new NativeCanvas(640, 480);
  page.attach(canvas);
  const window = Object.assign(new EventEmitter(), {
    x: 0,
    y: 0,
    width: 640,
    height: 480,
    fullscreen: false,
    setFullscreen() {},
  });
  const mouse = {
    setPosition: () => {},
    showCursor: () => {},
    capture: () => {},
    uncapture: () => {},
  };
  undo.push(connectDomEvents(window as unknown as EventWindow, mouse, page, canvas));
  const input = new InputSource(canvas as unknown as HTMLElement, [], { autoPoll: false });
  undo.push(() => input.dispose());
  return { page, canvas, window, input };
}

/**
 * The end of an SDL drain, where a key down still waiting for its text is sent.
 *
 * **A `keyDown` is held for a microtask** so that a `textInput` arriving behind it can fill in the
 * character — which is why a test that emits a key and reads the input in the same turn sees
 * nothing, and why this one awaits. That cost an hour on 2026-09-20: the deferral looked exactly
 * like keys not reaching the engine at all.
 */
const drained = () => Promise.resolve();

test('A KEY PRESSED ON THE HOST IS A KEY THE ENGINE IS HOLDING', async () => {
  const { window, input } = hosted();
  /* 26 is `W`, the key every one of these scenes walks forward with. */
  window.emit('keyDown', key(26));
  await drained();
  input.poll();
  expect(input.isDown('KeyW')).toBe(true);

  window.emit('keyUp', key(26));
  await drained();
  input.poll();
  expect(input.isDown('KeyW')).toBe(false);
});

test('a key arriving while nothing is focused still reaches the engine', async () => {
  /*
   * **The host sends a key to `document.activeElement ?? document`**, and a native window has
   * nothing focused until something takes focus. If that path did not bubble to the page's window,
   * a scene would be deaf until the person clicked — which is not a thing a browser does either.
   */
  const { page, window, input } = hosted();
  expect(page.document.activeElement).toBe(null);
  window.emit('keyDown', key(4));
  await drained();
  input.poll();
  expect(input.isDown('KeyA')).toBe(true);
});
