import { EventEmitter } from 'node:events';

import { afterEach, expect, test } from 'vitest';

import type { OrbitView } from '../orbit.ts';
import { NativeCanvas } from '../../packages/native-host/src/canvas.ts';
import { connectDomEvents, type EventWindow } from '../../packages/native-host/src/domEvents.ts';
import { HostPage } from '../../packages/native-host/src/page.ts';
import { bindSceneControls } from './sceneControls.ts';

/**
 * **What this file is for: a scene's camera taken by the mouse on the native window.** The dev
 * harness binds a mounted scene's `view` to the canvas; this host mounted scenes the same way and
 * bound nothing, so a drag moved no camera — reported by the maintainer on 2026-09-19. Driven here
 * from SDL's events, through the page, to the binder the harness and the website share.
 */

let undo: (() => void)[] = [];
afterEach(() => {
  for (const step of undo.reverse()) step();
  undo = [];
});

test('A DRAG TURNS THE CAMERA, THE WHEEL ZOOMS IT, AND A DOUBLE CLICK LETS IT GO', () => {
  const page = new HostPage();
  undo.push(page.install());
  const canvas = new NativeCanvas(640, 480);
  page.attach(canvas);
  const window = Object.assign(new EventEmitter(), { x: 0, y: 0, width: 640, height: 480 });
  const mouse = {
    setPosition: () => {},
    showCursor: () => {},
    capture: () => {},
    uncapture: () => {},
  };
  let clock = 0;
  undo.push(
    connectDomEvents(window as unknown as EventWindow, mouse, page, canvas, { now: () => clock }),
  );
  const moves: string[] = [];
  const view = {
    taken: false,
    drag: (dx: number, dy: number) => moves.push(`drag ${dx} ${dy}`),
    zoom: (steps: number) => moves.push(`zoom ${steps}`),
    scale: () => undefined,
    release: () => moves.push('release'),
  };
  undo.push(bindSceneControls(canvas, view as unknown as OrbitView));

  const at = (x: number, y: number, button?: number) => ({ x, y, button, touch: false });
  window.emit('mouseMove', at(100, 100));
  window.emit('mouseButtonDown', at(100, 100, 1));
  /* Past the binder's ten pixels of travel before a drag takes the camera. */
  for (const x of [106, 112, 118]) window.emit('mouseMove', at(x, 100));
  window.emit('mouseButtonUp', at(118, 100, 1));
  window.emit('mouseWheel', { ...at(118, 100), dx: 0, dy: 1, flipped: false });
  clock += 1000;
  for (let press = 0; press < 2; press += 1) {
    window.emit('mouseButtonDown', at(118, 100, 1));
    window.emit('mouseButtonUp', at(118, 100, 1));
  }
  expect(moves).toEqual(['drag 6 0', 'drag 6 0', 'zoom 1', 'release']);
});
