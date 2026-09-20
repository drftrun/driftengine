import { EventEmitter } from 'node:events';

import { afterEach, expect, test } from 'vitest';

import { NativeCanvas } from './canvas.ts';
import { connectDomEvents, type EventWindow } from './domEvents.ts';
import { HostPage } from './page.ts';

/**
 * **What this file is for: `canvas.style`, which a page writes a cursor to.** A draggable view sets
 * `grab`, a button `pointer`, a first-person game `none`; on a canvas with no `style` each of those
 * is a `TypeError` inside the page's handler. The cursor is the window's, from SDL's own; any other
 * property is kept and read back, and means nothing without a layout.
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
  const window = Object.assign(new EventEmitter(), { x: 0, y: 0, width: 640, height: 480 });
  const told: string[] = [];
  const mouse = {
    setPosition: () => undefined,
    showCursor: (show = true) => told.push(show ? 'shown' : 'hidden'),
    capture: () => undefined,
    uncapture: () => undefined,
    setCursor: (cursor: string) => told.push(cursor),
  };
  undo.push(connectDomEvents(window as unknown as EventWindow, mouse, page, canvas));
  return { page, canvas, window, told };
}

test('A CURSOR WRITTEN TO THE CANVAS IS THE WINDOW’S, the nearest of SDL’s to what CSS names', () => {
  const { canvas, told } = setUp();
  for (const cursor of ['pointer', 'grab', 'text', 'ew-resize', 'url(hand.png) 4 4, crosshair']) {
    canvas.style.cursor = cursor;
  }
  canvas.style.cursor = 'none';
  canvas.style.cursor = 'default';
  expect(told).toEqual([
    'hand',
    'hand',
    'ibeam',
    'sizewe',
    'crosshair',
    'hidden',
    'shown',
    'arrow',
  ]);
  expect(canvas.style.cursor).toBe('default');
});

test('A CURSOR THE PAGE HID STAYS HIDDEN WHEN POINTER LOCK LETS GO', async () => {
  const { page, canvas, window, told } = setUp();
  canvas.style.cursor = 'none';
  window.emit('mouseButtonDown', { x: 5, y: 5, button: 1, touch: false });
  await canvas.requestPointerLock();
  page.unlock();
  expect(told.at(-1)).toBe('hidden');
});

test('ANY OTHER STYLE IS KEPT AND READ BACK, in either spelling', () => {
  const { canvas } = setUp();
  canvas.style.width = '100%';
  canvas.style.setProperty('touch-action', 'none');
  expect([
    canvas.style.width,
    canvas.style.getPropertyValue('touch-action'),
    canvas.style.touchAction,
  ]).toEqual(['100%', 'none', 'none']);
});
