import { EventEmitter } from 'node:events';

import { afterEach, describe, expect, test } from 'vitest';

import { InputSource } from '@driftengine/core';
import { NativeCanvas } from './canvas.ts';
import { connectDomEvents, type EventWindow } from './domEvents.ts';
import { HostPage } from './page.ts';

/**
 * **What this file is for: a finger on a touch screen, heard as Chrome's page hears it.** SDL
 * reports fingers; a page reads pointer events of type `touch`, touch events, and — after a tap —
 * the mouse events and click Chrome makes of it. Every sequence and figure here is Chrome 151's,
 * measured 2026-09-19 by dispatching touches over the DevTools protocol to a page whose canvas
 * filled it.
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
  const window = Object.assign(new EventEmitter(), { x: 0, y: 0, width: 640, height: 480 });
  const mouse = {
    setPosition: () => {},
    showCursor: () => {},
    capture: () => {},
    uncapture: () => {},
  };
  undo.push(
    connectDomEvents(window as unknown as EventWindow, mouse, page, canvas, { now: () => clock }),
  );
  /* SDL's fingers are where they are across the window, from 0 to 1. */
  const finger = (type: string, fingerId: number, x: number, y: number) =>
    window.emit(type, { fingerId, x: x / 640, y: y / 480, pressure: 1, mouse: false });
  const tap = (x: number, y: number) => {
    finger('fingerDown', 7, x, y);
    finger('fingerUp', 7, x, y);
  };
  return { page, canvas, window, finger, tap };
}

const TOUCH = [
  ...['pointerover', 'pointerenter', 'pointerdown', 'pointermove', 'pointerup'],
  ...['pointerout', 'pointerleave', 'gotpointercapture', 'lostpointercapture'],
  ...['touchstart', 'touchmove', 'touchend'],
  ...['mouseover', 'mouseenter', 'mousemove', 'mousedown', 'mouseup', 'click', 'dblclick'],
];

function sequence(nodes: Record<string, EventTarget>, types: readonly string[]) {
  const heard: string[] = [];
  for (const [where, node] of Object.entries(nodes)) {
    for (const type of types) {
      node.addEventListener(type, (event) => {
        if (event.target !== node) return;
        const detail = /click|down|up$/.test(type) ? ` ${(event as UIEvent).detail}` : '';
        heard.push(`${type}@${where}${detail}`);
      });
    }
  }
  return heard;
}

describe('a finger, as Chrome sends it', () => {
  test('A TAP IS A POINTER, A TOUCH, A CAPTURE HELD AND LET GO, and then the mouse Chrome makes of it', () => {
    const { page, canvas, tap } = setUp();
    const heard = sequence({ canvas, document: page.document }, TOUCH);
    tap(100, 100);
    expect(heard).toEqual([
      'pointerover@canvas',
      'pointerenter@document',
      'pointerenter@canvas',
      'pointerdown@canvas 0',
      'touchstart@canvas',
      'gotpointercapture@canvas',
      'pointerup@canvas 0',
      'lostpointercapture@canvas',
      'pointerout@canvas',
      'pointerleave@canvas',
      'pointerleave@document',
      'touchend@canvas',
      'mouseover@canvas',
      'mouseenter@document',
      'mouseenter@canvas',
      'mousemove@canvas',
      'mousedown@canvas 1',
      'mouseup@canvas 1',
      'click@canvas 1',
    ]);
  });

  test('THE POINTER IS A TOUCH, NUMBERED FROM 2, AND THE CLICK IS ITS OWN', () => {
    const { canvas, tap } = setUp();
    const seen: string[] = [];
    for (const type of ['pointerdown', 'click']) {
      canvas.addEventListener(type, (event) => {
        const e = event as PointerEvent;
        seen.push(`${type} ${e.pointerId} ${e.pointerType} ${String(e.isPrimary)} ${e.clientX}`);
      });
    }
    tap(100, 120);
    tap(300, 120);
    expect(seen).toEqual([
      'pointerdown 2 touch true 100',
      'click 2 touch false 100',
      'pointerdown 3 touch true 300',
      'click 3 touch false 300',
    ]);
  });

  test('A SECOND TAP SOON AFTER AND CLOSE BY IS A DOUBLE TAP; LATER OR FURTHER IS NOT', () => {
    const { canvas, tap } = setUp();
    const heard = sequence({ canvas }, ['mouseover', 'click', 'dblclick']);
    tap(100, 100);
    clock += 300;
    tap(110, 100);
    clock += 450;
    tap(110, 100);
    clock += 100;
    tap(140, 100);
    /* The mouse Chrome makes of taps comes over the canvas once, and stays. */
    expect(heard).toEqual([
      'mouseover@canvas',
      'click@canvas 1',
      'click@canvas 2',
      'dblclick@canvas 2',
      'click@canvas 1',
      'click@canvas 1',
    ]);
  });

  test('A MOVE WITHIN FIFTEEN PIXELS SENDS NO TOUCHMOVE AND IS STILL A TAP; ONE PAST THEM IS NO TAP', () => {
    const { canvas, finger } = setUp();
    const heard = sequence({ canvas }, ['pointermove', 'touchmove', 'click']);
    finger('fingerDown', 1, 100, 100);
    finger('fingerMove', 1, 113, 100);
    finger('fingerUp', 1, 113, 100);
    finger('fingerDown', 1, 100, 200);
    finger('fingerMove', 1, 117, 200);
    finger('fingerUp', 1, 117, 200);
    expect(heard).toEqual([
      'pointermove@canvas',
      'click@canvas 1',
      'pointermove@canvas',
      'touchmove@canvas',
    ]);
  });

  test('A TOUCHSTART PREVENTED HEARS EVERY MOVE, AND NO MOUSE IS MADE OF THE TAP', () => {
    const { canvas, finger } = setUp();
    canvas.addEventListener('touchstart', (event) => event.preventDefault());
    const heard = sequence({ canvas }, ['touchmove', 'mousedown', 'click']);
    finger('fingerDown', 1, 100, 100);
    finger('fingerMove', 1, 105, 100);
    finger('fingerUp', 1, 105, 100);
    expect(heard).toEqual(['touchmove@canvas']);
  });

  test('TWO FINGERS ARE TWO POINTERS, THE FIRST PRIMARY, and each touch event lists them', () => {
    const { canvas, finger } = setUp();
    const seen: string[] = [];
    canvas.addEventListener('pointerdown', (event) => {
      const e = event as PointerEvent;
      seen.push(`down ${e.pointerId} ${String(e.isPrimary)}`);
    });
    /* Measured too: two fingers down and up, unmoved, made no mouse and no click in Chrome. */
    canvas.addEventListener('click', () => seen.push('click'));
    for (const type of ['touchstart', 'touchend']) {
      canvas.addEventListener(type, (event) => {
        const e = event as TouchEvent;
        const changed = [...e.changedTouches].map((t) => t.identifier).join();
        seen.push(`${type} ${e.touches.length} [${changed}]`);
      });
    }
    finger('fingerDown', 40, 100, 100);
    finger('fingerDown', 41, 200, 200);
    finger('fingerUp', 41, 200, 200);
    finger('fingerUp', 40, 100, 100);
    expect(seen).toEqual([
      'down 2 true',
      'touchstart 1 [0]',
      'down 3 false',
      'touchstart 2 [1]',
      'touchend 1 [1]',
      'touchend 0 [0]',
    ]);
  });

  test('SDL’S MOUSE MADE FROM A FINGER, AND ITS FINGER MADE FROM A MOUSE, ARE NOT SENT TWICE', () => {
    const { canvas, window } = setUp();
    const heard = sequence({ canvas }, ['pointerdown', 'mousedown', 'touchstart']);
    window.emit('mouseButtonDown', { x: 5, y: 5, button: 1, touch: true });
    window.emit('fingerDown', { fingerId: 1, x: 0.1, y: 0.1, pressure: 1, mouse: true });
    expect(heard).toEqual([]);
  });

  test('THE ENGINE’S OWN INPUT READS THE TOUCH, where it landed', () => {
    const { canvas, finger } = setUp();
    const input = new InputSource(canvas as unknown as HTMLElement, [], { autoPoll: false });
    undo.push(() => input.dispose());
    const touched: string[] = [];
    undo.push(
      input.subscribe({
        onTouchStart: (t) => touched.push(`start ${t.x} ${t.y}`),
        onTouchEnd: (t) => touched.push(`end ${t.x} ${t.y}`),
      }),
    );
    finger('fingerDown', 1, 320, 240);
    finger('fingerUp', 1, 320, 240);
    expect(touched).toEqual(['start 320 240', 'end 320 240']);
  });
});
