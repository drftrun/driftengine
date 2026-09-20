import { EventEmitter } from 'node:events';

import { afterEach, describe, expect, test } from 'vitest';

import { InputSource } from '@driftengine/core';
import { NativeCanvas } from './canvas.ts';
import { connectDomEvents } from './domEvents.ts';
import type { EventMouse, EventWindow } from './domEvents.ts';
import { HostPage } from './page.ts';

/**
 * **What this file is for: a key or a mouse reaching the engine's own input, unchanged.** The
 * engine's `InputSource` listens on `window`, `document` and its canvas for the events a browser
 * sends, and the plan for this host is that it hears exactly those, in the same shape, from SDL. So
 * these tests drive a stand-in SDL window and read the answer off a real `InputSource`, not off the
 * events.
 */

/** An SDL window as `domEvents.ts` reads one: its events, its place on the screen, its size. */
function sdlWindow() {
  const window = Object.assign(new EventEmitter(), { x: 100, y: 50, width: 640, height: 480 });
  return window as unknown as EventWindow & EventEmitter;
}

function sdlMouse() {
  const warps: [number, number][] = [];
  const shown: boolean[] = [];
  const mouse: EventMouse = {
    setPosition: (x, y) => warps.push([x, y]),
    showCursor: (show = true) => shown.push(show),
    capture: () => undefined,
    uncapture: () => undefined,
  };
  return { mouse, warps, shown };
}

let undo: (() => void)[] = [];
afterEach(() => {
  for (const step of undo.reverse()) step();
  undo = [];
});

/** The host's clock, which a test moves by hand. */
let clock = 0;

function setUp() {
  const page = new HostPage();
  undo.push(page.install());
  const canvas = new NativeCanvas(640, 480);
  page.attach(canvas);
  const window = sdlWindow();
  const { mouse, warps, shown } = sdlMouse();
  clock = 0;
  undo.push(connectDomEvents(window, mouse, page, canvas, { now: () => clock }));
  const input = new InputSource(canvas as unknown as HTMLElement, ['Space'], { autoPoll: false });
  undo.push(() => input.dispose());
  return { page, canvas, window, input, warps, shown };
}

/** The end of an SDL drain, where a key down still waiting for its text is sent. */
const drained = () => Promise.resolve();

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

describe('SDL’s events, as a page hears them', () => {
  test('A KEY HELD IS DOWN AND A KEY RELEASED IS NOT, by its code', async () => {
    const { window, input } = setUp();
    window.emit('keyDown', key(26, { key: 'w' }));
    /* A key down waits for the end of SDL's drain, for the text that may follow it. */
    await drained();
    expect(input.isDown('KeyW')).toBe(true);
    window.emit('keyUp', key(26, { key: 'w' }));
    expect(input.isDown('KeyW')).toBe(false);
  });

  /**
   * **A first press must never be mistaken for a repeat, whatever shape the platform states it in.**
   *
   * `InputSource` discards a repeat outright — a held key must not re-fire a press — so a host that
   * marks every press a repeat makes the engine deaf to *held* keys while taps that are handled on
   * the edge, like a hotbar digit, keep working. That is a maddening shape to report and it was
   * reported on 2026-09-20: keys reached the page and `isDown` was false for all 48 of them.
   *
   * The coercion was `(event.repeat ?? 0) !== 0`, which is correct for the number SDL's types
   * promise and **inverted for a boolean**: `false !== 0` is `true`, so a platform answering
   * `repeat: false` marks every key a repeat. Asserted here for both shapes rather than trusting a
   * declaration, because the declaration is the thing that turned out not to be load-bearing.
   */
  test('A FIRST PRESS IS NOT A REPEAT, WHETHER THE PLATFORM SAYS 0 OR false', async () => {
    for (const said of [0, false, undefined] as const) {
      const { window, page } = setUp();
      const seen: boolean[] = [];
      page.window.addEventListener('keydown', (event) => {
        seen.push((event as KeyboardEvent).repeat);
      });
      window.emit('keyDown', key(26, { repeat: said }));
      await drained();
      expect(seen, `repeat: ${String(said)}`).toEqual([false]);
      for (const step of undo.reverse()) step();
      undo = [];
    }
  });

  test('and a platform that does say a repeat is believed', async () => {
    for (const said of [1, true] as const) {
      const { window, page } = setUp();
      const seen: boolean[] = [];
      page.window.addEventListener('keydown', (event) => {
        seen.push((event as KeyboardEvent).repeat);
      });
      window.emit('keyDown', key(26, { repeat: said }));
      await drained();
      expect(seen, `repeat: ${String(said)}`).toEqual([true]);
      for (const step of undo.reverse()) step();
      undo = [];
    }
  });

  test('A PRESS IS AN EDGE FOR ONE POLL, and a repeat is not a second press', async () => {
    const { window, input } = setUp();
    window.emit('keyDown', key(44));
    await drained();
    input.poll();
    expect(input.keyPressed('Space')).toBe(true);
    window.emit('keyDown', key(44, { repeat: 1 }));
    await drained();
    input.poll();
    expect(input.keyPressed('Space')).toBe(false);
  });

  test('A KEY THE ENGINE ASKED TO KEEP IS KEPT FROM THE PAGE: preventDefault reaches the event', async () => {
    const { page, window } = setUp();
    let prevented: boolean | null = null;
    /* After the engine's listener, as a page's own would be. */
    page.window.addEventListener('keydown', (event) => {
      prevented = event.defaultPrevented;
    });
    window.emit('keyDown', key(44));
    await drained();
    expect(prevented).toBe(true);
  });

  test('LOSING FOCUS LETS GO OF EVERY KEY, as a browser’s blur does', () => {
    const { window, input } = setUp();
    window.emit('keyDown', key(4));
    window.emit('blur', {});
    expect(input.isDown('KeyA')).toBe(false);
  });

  test('THE POLL RUNS ON THE PAGE’S FRAMES, as it does on a browser’s', async () => {
    const { page, canvas, window } = setUp();
    const polled = new InputSource(canvas as unknown as HTMLElement);
    undo.push(() => polled.dispose());
    window.emit('keyDown', key(4));
    await drained();
    page.runFrame(16);
    expect(polled.keyPressed('KeyA')).toBe(true);
    page.runFrame(32);
    expect(polled.keyPressed('KeyA')).toBe(false);
  });

  test('UNDER POINTER LOCK THE MOUSE MOVES THE CAMERA BY HOW FAR IT WENT, and goes back to the middle', async () => {
    const { canvas, window, input, warps, shown } = setUp();
    /* The click a lock is asked for in, which is the gesture it needs. */
    window.emit('mouseButtonDown', { button: 1, x: 5, y: 5, touch: false });
    window.emit('mouseButtonUp', { button: 1, x: 5, y: 5, touch: false });
    await canvas.requestPointerLock();
    expect(input.hasPointerLock).toBe(true);
    let moves = 0;
    canvas.addEventListener('mousemove', () => {
      moves += 1;
    });
    /* Hidden, and put in the middle of the window: 100 + 320, 50 + 240 on the screen. */
    expect(shown).toEqual([false]);
    expect(warps.at(-1)).toEqual([420, 290]);
    window.emit('mouseMove', { x: 330, y: 236, touch: false });
    /* The warp back arrives as a move of its own, to where the pointer already is. */
    window.emit('mouseMove', { x: 320, y: 240, touch: false });
    const delta = { dx: 0, dy: 0 };
    input.consumeMouseDelta(delta);
    expect(delta).toEqual({ dx: 10, dy: -4 });
    expect(moves, 'the warp is not a move of the mouse').toBe(1);
  });

  test('A WINDOW THAT CANNOT HOLD THE CURSOR REFUSES THE LOCK, and leaves the cursor as it was', async () => {
    const page = new HostPage();
    undo.push(page.install());
    const canvas = new NativeCanvas(640, 480);
    page.attach(canvas);
    const shown: boolean[] = [];
    /* What SDL says with no window focused: a hidden one, a desktop that took the focus away. */
    const mouse: EventMouse = {
      setPosition: () => undefined,
      showCursor: (show = true) => shown.push(show),
      capture: () => {
        throw new Error('SDL_CaptureMouse(1) error: No window has focus');
      },
      uncapture: () => undefined,
    };
    const window = sdlWindow();
    undo.push(connectDomEvents(window, mouse, page, canvas));
    window.emit('mouseButtonDown', { button: 1, x: 5, y: 5, touch: false });
    await expect(canvas.requestPointerLock()).rejects.toThrow(/could not hold/);
    expect(page.document.pointerLockElement).toBeNull();
    expect(shown.at(-1), 'the cursor is not left hidden').toBe(true);
  });

  test('ESCAPE RELEASES THE LOCK, and the cursor comes back', async () => {
    const { page, canvas, window, shown } = setUp();
    window.emit('mouseButtonDown', { button: 1, x: 5, y: 5, touch: false });
    await canvas.requestPointerLock();
    window.emit('keyDown', key(41));
    expect(page.document.pointerLockElement).toBeNull();
    expect(shown).toEqual([false, true]);
  });

  test('A BUTTON AND THE WHEEL REACH THE CANVAS in the browser’s numbering and direction', () => {
    const { page, canvas, window } = setUp();
    const heard: string[] = [];
    for (const type of ['pointerdown', 'mousedown', 'mouseup', 'click', 'contextmenu', 'wheel']) {
      canvas.addEventListener(type, (event) => {
        const e = event as MouseEvent & WheelEvent;
        heard.push(type === 'wheel' ? `wheel ${e.deltaY}` : `${type} ${e.button}`);
      });
    }
    /* SDL counts buttons from 1, left first; a browser from 0, with the middle before the right. */
    window.emit('mouseButtonDown', { button: 1, x: 5, y: 5, touch: false });
    window.emit('mouseButtonUp', { button: 1, x: 5, y: 5, touch: false });
    window.emit('mouseButtonDown', { button: 3, x: 5, y: 5, touch: false });
    let wheeled = 0;
    page.window.addEventListener('wheel', (event) => {
      if (event.cancelable) wheeled += 1;
    });
    /* SDL's wheel is positive away from the person; a browser's `deltaY` is positive toward them. */
    window.emit('mouseWheel', { dx: 0, dy: 1, flipped: false, x: 5, y: 5, touch: false });
    expect(wheeled, 'the wheel bubbles to the window, and can be cancelled').toBe(1);
    expect(heard).toEqual([
      'pointerdown 0',
      'mousedown 0',
      'mouseup 0',
      'click 0',
      'pointerdown 2',
      'mousedown 2',
      'contextmenu 2',
      'wheel -100',
    ]);
  });

  test('A CLICK SAYS WHICH MODIFIERS ARE HELD, as a browser’s pointer events do', () => {
    const { canvas, window } = setUp();
    const held: string[] = [];
    canvas.addEventListener('pointerdown', (event) => {
      const e = event as PointerEvent;
      held.push(`${String(e.shiftKey)} ${String(e.ctrlKey)}`);
    });
    window.emit('keyDown', key(225));
    window.emit('mouseButtonDown', { button: 1, x: 5, y: 5, touch: false });
    window.emit('mouseButtonUp', { button: 1, x: 5, y: 5, touch: false });
    window.emit('keyUp', key(225));
    window.emit('keyDown', key(224));
    window.emit('mouseButtonDown', { button: 1, x: 5, y: 5, touch: false });
    expect(held).toEqual(['true false', 'false true']);
  });

  test('A MINIMISED WINDOW IS A HIDDEN PAGE, and a resized one tells the page', () => {
    const { page, window } = setUp();
    let resized = 0;
    page.window.addEventListener('resize', () => {
      resized += 1;
    });
    window.emit('minimize', {});
    expect(page.document.visibilityState).toBe('hidden');
    window.emit('restore', {});
    expect(page.document.visibilityState).toBe('visible');
    window.emit('resize', { width: 800, height: 600, pixelWidth: 800, pixelHeight: 600 });
    expect(resized).toBe(1);
  });
});

/** Every event `types` heard at the window, as the fields a test asks about. */
function heardAt(target: EventTarget, types: readonly string[]) {
  const heard: Record<string, unknown>[] = [];
  for (const type of types) {
    target.addEventListener(type, (event) => {
      const e = event as unknown as Record<string, unknown>;
      heard.push({
        type,
        class: event.constructor.name,
        key: e['key'],
        code: e['code'],
        keyCode: e['keyCode'],
        charCode: e['charCode'],
        which: e['which'],
        location: e['location'],
      });
    });
  }
  return heard;
}

describe('the events are the browser’s own classes, as Chrome fills them', () => {
  /*
   * Every literal below is what Chrome 151 handed a page for the same key, measured 2026-09-19 by
   * dispatching it over the DevTools protocol and recording the event a listener received.
   */
  const KEYS = ['keydown', 'keypress', 'keyup'] as const;

  test('A KEY THAT TYPES IS A KEYDOWN, A KEYPRESS AND A KEYUP, with the legacy codes Chrome gives', () => {
    const { page, window } = setUp();
    const heard = heardAt(page.window, KEYS);
    window.emit('keyDown', key(4, { key: 'a' }));
    window.emit('textInput', { text: 'a' });
    window.emit('keyUp', key(4, { key: 'a' }));
    expect(heard).toEqual([
      {
        type: 'keydown',
        class: 'KeyboardEvent',
        key: 'a',
        code: 'KeyA',
        keyCode: 65,
        charCode: 0,
        which: 65,
        location: 0,
      },
      {
        type: 'keypress',
        class: 'KeyboardEvent',
        key: 'a',
        code: 'KeyA',
        keyCode: 97,
        charCode: 97,
        which: 97,
        location: 0,
      },
      {
        type: 'keyup',
        class: 'KeyboardEvent',
        key: 'a',
        code: 'KeyA',
        keyCode: 65,
        charCode: 0,
        which: 65,
        location: 0,
      },
    ]);
  });

  test('THE KEY IS WHAT THE LAYOUT TYPED, which SDL says in the text that follows the key', async () => {
    const { page, window } = setUp();
    const heard = heardAt(page.window, KEYS);
    window.emit('keyDown', key(30, { key: '1', shift: 1 }));
    window.emit('textInput', { text: '!' });
    await drained();
    expect(heard.map((e) => [e['type'], e['key'], e['keyCode'], e['charCode']])).toEqual([
      ['keydown', '!', 49, 0],
      ['keypress', '!', 33, 33],
    ]);
  });

  test('A KEY THAT TYPES NOTHING SENDS NO KEYPRESS, and a shift says which side it is on', async () => {
    const { page, window } = setUp();
    const heard = heardAt(page.window, KEYS);
    const shifted: boolean[] = [];
    page.window.addEventListener('keydown', (event) => {
      shifted.push((event as KeyboardEvent).getModifierState('Shift'));
    });
    window.emit('keyDown', key(225, { shift: 1 }));
    await drained();
    window.emit('keyDown', key(41));
    await drained();
    expect(heard).toEqual([
      {
        type: 'keydown',
        class: 'KeyboardEvent',
        key: 'Shift',
        code: 'ShiftLeft',
        keyCode: 16,
        charCode: 0,
        which: 16,
        location: 1,
      },
      {
        type: 'keydown',
        class: 'KeyboardEvent',
        key: 'Escape',
        code: 'Escape',
        keyCode: 27,
        charCode: 0,
        which: 27,
        location: 0,
      },
    ]);
    expect(shifted).toEqual([true, false]);
  });

  test('ENTER TYPES A CARRIAGE RETURN, though SDL sends no text for it', async () => {
    const { page, window } = setUp();
    const heard = heardAt(page.window, ['keypress']);
    window.emit('keyDown', key(40));
    await drained();
    expect(heard.map((e) => [e['key'], e['keyCode'], e['charCode']])).toEqual([['Enter', 13, 13]]);
  });

  test('A KEYDOWN PREVENTED TYPES NOTHING, and a keypad key is on the keypad', () => {
    const { page, window } = setUp();
    const heard = heardAt(page.window, KEYS);
    page.window.addEventListener('keydown', (event) => event.preventDefault());
    window.emit('keyDown', key(89, { key: '1' }));
    window.emit('textInput', { text: '1' });
    /* VK_NUMPAD1 is 0x61, and the keypad is the fourth location. */
    expect(heard.map((e) => [e['type'], e['code'], e['keyCode'], e['location']])).toEqual([
      ['keydown', 'Numpad1', 97, 3],
    ]);
  });

  test('A LETTER’S LEGACY CODE IS THE LETTER THE LAYOUT PUTS THERE, not the position’s', async () => {
    /*
     * Chromium derives a letter key's `keyCode` from the character the layout gives it, so KeyQ on
     * an AZERTY board, which types `a`, reports 65 — the position would say 81.
     */
    const { page, window } = setUp();
    const heard = heardAt(page.window, ['keydown']);
    window.emit('keyDown', key(20, { key: 'a' }));
    window.emit('textInput', { text: 'a' });
    await drained();
    expect(heard.map((e) => [e['code'], e['key'], e['keyCode']])).toEqual([['KeyQ', 'a', 65]]);
  });

  test('KEYS GO TO THE FOCUSED CANVAS, and a canvas is focusable only once it has a tabIndex', async () => {
    const { page, canvas, window } = setUp();
    const heard: string[] = [];
    canvas.addEventListener('keydown', () => heard.push('canvas'));
    page.document.addEventListener('keydown', (event) =>
      heard.push(event.target === canvas ? 'document, from the canvas' : 'document'),
    );
    for (const type of ['focus', 'focusin']) canvas.addEventListener(type, () => heard.push(type));
    canvas.focus();
    window.emit('keyDown', key(4, { key: 'a' }));
    await drained();
    canvas.tabIndex = 0;
    canvas.focus();
    expect(page.document.activeElement).toBe(canvas);
    window.emit('keyDown', key(4, { key: 'a' }));
    await drained();
    expect(heard).toEqual(['document', 'focus', 'focusin', 'canvas', 'document, from the canvas']);
  });

  test('CAPS LOCK AND NUM LOCK ARE STATES A KEY CAN BE ASKED ABOUT', async () => {
    const { page, window } = setUp();
    const states: boolean[] = [];
    page.window.addEventListener('keydown', (event) => {
      const e = event as KeyboardEvent;
      states.push(e.getModifierState('CapsLock'), e.getModifierState('NumLock'));
    });
    window.emit('keyDown', key(4, { key: 'a', capslock: 1, numlock: 0 }));
    await drained();
    expect(states).toEqual([true, false]);
  });

  test('A POINTER IS A PointerEvent AND A MOUSE A MouseEvent, each reporting its button as Chrome does', () => {
    const { canvas, window } = setUp();
    const heard: string[] = [];
    for (const type of ['pointermove', 'mousemove', 'pointerdown', 'mousedown']) {
      canvas.addEventListener(type, (event) => {
        const e = event as PointerEvent;
        heard.push(
          `${type} ${event.constructor.name} button=${e.button} which=${(e as unknown as { which: number }).which} screenX=${e.screenX} offsetX=${e.offsetX}`,
        );
      });
    }
    window.emit('mouseMove', { x: 30, y: 20, touch: false });
    window.emit('mouseButtonDown', { button: 1, x: 30, y: 20, touch: false });
    /* On the screen, the window is at 100, 50. */
    expect(heard).toEqual([
      'pointermove PointerEvent button=-1 which=0 screenX=130 offsetX=30',
      'mousemove MouseEvent button=0 which=0 screenX=130 offsetX=30',
      'pointerdown PointerEvent button=0 which=1 screenX=130 offsetX=30',
      'mousedown MouseEvent button=0 which=1 screenX=130 offsetX=30',
    ]);
  });

  test('THE CLASSES ARE THE PAGE’S GLOBALS, so a page may make one or ask instanceof', () => {
    setUp();
    const scope = globalThis as unknown as Record<
      string,
      new (type: string, init?: object) => Event
    >;
    const made = new (scope['KeyboardEvent'] as new (t: string, i: object) => KeyboardEvent)(
      'keydown',
      { key: 'q', code: 'KeyQ', ctrlKey: true },
    );
    expect(made.getModifierState('Control')).toBe(true);
    expect(made instanceof (scope['UIEvent'] as unknown as typeof Event)).toBe(true);
    expect(typeof scope['TouchEvent']).toBe('function');
  });
});

/** Each event of `types` heard on any node, once, named `type@where`, with `detail` for clicks. */
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

const BOUNDARY = ['pointerover', 'pointerenter', 'pointerout', 'pointerleave'] as const;
const MOUSE = [
  ...BOUNDARY,
  ...['mouseover', 'mouseenter', 'mouseout', 'mouseleave', 'pointermove', 'mousemove'],
  ...['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click', 'dblclick', 'auxclick'],
  'contextmenu',
];
const at = (x: number, y: number, extra: Record<string, unknown> = {}) => ({
  x,
  y,
  touch: false,
  ...extra,
});

describe('the mouse, as Chrome sends it', () => {
  /*
   * The sequences are Chrome 151's, measured 2026-09-19 over the DevTools protocol on a page whose
   * canvas filled it: a pointer coming in, a click, a second click, a right and a middle button, and
   * the pointer going out.
   */
  test('COMING IN IS OVER AND ENTER, the document before the canvas, and then the move', () => {
    const { page, canvas, window } = setUp();
    const heard = sequence({ canvas, document: page.document }, MOUSE);
    window.emit('hover', {});
    window.emit('mouseMove', at(100, 100));
    expect(heard).toEqual([
      'pointerover@canvas',
      'pointerenter@document',
      'pointerenter@canvas',
      'mouseover@canvas',
      'mouseenter@document',
      'mouseenter@canvas',
      'pointermove@canvas',
      'mousemove@canvas',
    ]);
  });

  test('A CLICK AND A SECOND ONE SOON AFTER COUNT ONE AND TWO, and the second is a double click', () => {
    const { page, canvas, window } = setUp();
    window.emit('mouseMove', at(100, 100));
    const heard = sequence({ canvas, document: page.document }, MOUSE);
    window.emit('mouseButtonDown', at(100, 100, { button: 1 }));
    window.emit('mouseButtonUp', at(100, 100, { button: 1 }));
    clock += 200;
    window.emit('mouseButtonDown', at(101, 100, { button: 1 }));
    window.emit('mouseButtonUp', at(101, 100, { button: 1 }));
    expect(heard).toEqual([
      'pointerdown@canvas 0',
      'mousedown@canvas 1',
      'pointerup@canvas 0',
      'mouseup@canvas 1',
      'click@canvas 1',
      'pointerdown@canvas 0',
      'mousedown@canvas 2',
      'pointerup@canvas 0',
      'mouseup@canvas 2',
      'click@canvas 2',
      'dblclick@canvas 2',
    ]);
  });

  test('A CLICK TOO LATE OR TOO FAR COUNTS FROM ONE AGAIN', () => {
    const { canvas, window } = setUp();
    const heard = sequence({ canvas }, ['click']);
    window.emit('mouseButtonDown', at(100, 100, { button: 1 }));
    window.emit('mouseButtonUp', at(100, 100, { button: 1 }));
    clock += 600;
    window.emit('mouseButtonDown', at(100, 100, { button: 1 }));
    window.emit('mouseButtonUp', at(100, 100, { button: 1 }));
    clock += 100;
    window.emit('mouseButtonDown', at(110, 100, { button: 1 }));
    window.emit('mouseButtonUp', at(110, 100, { button: 1 }));
    expect(heard).toEqual(['click@canvas 1', 'click@canvas 1', 'click@canvas 1']);
  });

  test('THE RIGHT BUTTON OPENS A CONTEXT MENU ON THE PRESS, and it and the middle one are aux clicks', () => {
    const { canvas, window } = setUp();
    window.emit('mouseMove', at(120, 100));
    const heard = sequence({ canvas }, MOUSE);
    const kinds: string[] = [];
    for (const type of ['contextmenu', 'auxclick']) {
      canvas.addEventListener(type, (event) => {
        const e = event as PointerEvent;
        kinds.push(`${type} ${event.constructor.name} ${e.button} ${String(e.isPrimary)}`);
      });
    }
    window.emit('mouseButtonDown', at(120, 100, { button: 3 }));
    window.emit('mouseButtonUp', at(120, 100, { button: 3 }));
    window.emit('mouseButtonDown', at(130, 100, { button: 2 }));
    window.emit('mouseButtonUp', at(130, 100, { button: 2 }));
    expect(heard).toEqual([
      'pointerdown@canvas 0',
      'mousedown@canvas 1',
      'contextmenu@canvas',
      'pointerup@canvas 0',
      'mouseup@canvas 1',
      'auxclick@canvas 1',
      'pointerdown@canvas 0',
      'mousedown@canvas 1',
      'pointerup@canvas 0',
      'mouseup@canvas 1',
      'auxclick@canvas 1',
    ]);
    expect(kinds).toEqual([
      'contextmenu PointerEvent 2 false',
      'auxclick PointerEvent 2 false',
      'auxclick PointerEvent 1 false',
    ]);
  });

  test('A SECOND BUTTON WHILE ONE IS HELD IS A POINTER MOVE, and the first then clicks nothing', () => {
    const { canvas, window } = setUp();
    window.emit('mouseMove', at(100, 100));
    const heard = sequence({ canvas }, MOUSE);
    window.emit('mouseButtonDown', at(100, 100, { button: 1 }));
    window.emit('mouseButtonDown', at(100, 100, { button: 3 }));
    window.emit('mouseButtonUp', at(100, 100, { button: 3 }));
    window.emit('mouseButtonUp', at(100, 100, { button: 1 }));
    expect(heard).toEqual([
      'pointerdown@canvas 0',
      'mousedown@canvas 1',
      'pointermove@canvas',
      'mousedown@canvas 1',
      'contextmenu@canvas',
      'pointermove@canvas',
      'mouseup@canvas 1',
      'auxclick@canvas 1',
      'pointerup@canvas 0',
      'mouseup@canvas 0',
    ]);
  });

  test('GOING OUT IS OUT AND LEAVE, the canvas before the document', () => {
    const { page, canvas, window } = setUp();
    window.emit('mouseMove', at(100, 100));
    const heard = sequence({ canvas, document: page.document }, MOUSE);
    window.emit('leave', {});
    expect(heard).toEqual([
      'pointerout@canvas',
      'pointerleave@canvas',
      'pointerleave@document',
      'mouseout@canvas',
      'mouseleave@canvas',
      'mouseleave@document',
    ]);
  });

  test('A DRAG OUT OF THE WINDOW STAYS OVER THE CANVAS UNTIL ITS RELEASE, and leaves after its click', () => {
    const { page, canvas, window } = setUp();
    window.emit('mouseMove', at(600, 100));
    const heard = sequence({ canvas, document: page.document }, MOUSE);
    window.emit('mouseButtonDown', at(600, 100, { button: 1 }));
    /* SDL holds a pressed button's pointer to the window, and reports it past the edge. */
    window.emit('leave', {});
    window.emit('mouseMove', at(700, 100));
    window.emit('mouseButtonUp', at(700, 100, { button: 1 }));
    expect(heard).toEqual([
      'pointerdown@canvas 0',
      'mousedown@canvas 1',
      'pointermove@canvas',
      'mousemove@canvas',
      'pointerup@canvas 0',
      'mouseup@canvas 1',
      'click@canvas 1',
      'pointerout@canvas',
      'pointerleave@canvas',
      'pointerleave@document',
      'mouseout@canvas',
      'mouseleave@canvas',
      'mouseleave@document',
    ]);
  });

  test('A DRAG THAT COMES BACK BEFORE ITS RELEASE NEVER LEFT', () => {
    const { page, canvas, window } = setUp();
    window.emit('mouseMove', at(600, 100));
    const heard = sequence({ canvas, document: page.document }, BOUNDARY);
    window.emit('mouseButtonDown', at(600, 100, { button: 1 }));
    window.emit('leave', {});
    window.emit('hover', {});
    window.emit('mouseButtonUp', at(600, 100, { button: 1 }));
    expect(heard).toEqual([]);
  });

  test('A PRESS FOCUSES A FOCUSABLE CANVAS, at half pressure while a button is down', () => {
    const { page, canvas, window } = setUp();
    canvas.tabIndex = 0;
    const pressures: number[] = [];
    for (const type of ['pointerdown', 'pointerup']) {
      canvas.addEventListener(type, (event) => pressures.push((event as PointerEvent).pressure));
    }
    window.emit('mouseButtonDown', at(10, 10, { button: 1 }));
    window.emit('mouseButtonUp', at(10, 10, { button: 1 }));
    expect(page.document.activeElement).toBe(canvas);
    expect(pressures).toEqual([0.5, 0]);
  });
});

describe('pointer capture, as Chrome holds it', () => {
  /* Chrome 151's order and refusals, measured 2026-09-19 over the DevTools protocol. */
  const CAPTURE = ['gotpointercapture', 'lostpointercapture', ...MOUSE];

  test('HELD FROM A PRESS: told before the pointer’s next event, let go between the mouseup and the click', () => {
    const { page, canvas, window } = setUp();
    window.emit('mouseMove', at(100, 100));
    let held: boolean | null = null;
    canvas.addEventListener('pointerdown', (event) => {
      canvas.setPointerCapture((event as PointerEvent).pointerId);
      held = canvas.hasPointerCapture(1);
    });
    const heard = sequence({ canvas, document: page.document }, CAPTURE);
    window.emit('mouseButtonDown', at(100, 100, { button: 1 }));
    window.emit('mouseMove', at(700, 100));
    window.emit('mouseButtonUp', at(700, 100, { button: 1 }));
    expect(held).toBe(true);
    expect(heard).toEqual([
      'pointerdown@canvas 0',
      'mousedown@canvas 1',
      'gotpointercapture@canvas',
      'pointermove@canvas',
      'mousemove@canvas',
      'pointerup@canvas 0',
      'mouseup@canvas 1',
      'lostpointercapture@canvas',
      'click@canvas 1',
      'pointerout@canvas',
      'pointerleave@canvas',
      'pointerleave@document',
      'mouseout@canvas',
      'mouseleave@canvas',
      'mouseleave@document',
    ]);
    expect(canvas.hasPointerCapture(1)).toBe(false);
  });

  test('LET GO BY THE PAGE, IT IS TOLD before the pointer’s next event', () => {
    const { canvas, window } = setUp();
    window.emit('mouseMove', at(100, 100));
    window.emit('mouseButtonDown', at(100, 100, { button: 1 }));
    canvas.setPointerCapture(1);
    window.emit('mouseMove', at(110, 100));
    const heard = sequence({ canvas }, CAPTURE);
    canvas.releasePointerCapture(1);
    window.emit('mouseMove', at(120, 100));
    expect(heard).toEqual(['lostpointercapture@canvas', 'pointermove@canvas', 'mousemove@canvas']);
  });

  test('AN UNKNOWN POINTER IS REFUSED AS CHROME REFUSES IT, and a mouse with no button is not held', () => {
    const { canvas, window } = setUp();
    window.emit('mouseMove', at(100, 100));
    const refusal = (act: () => void) => {
      try {
        act();
        return 'ok';
      } catch (error) {
        return `${(error as Error).name}: ${(error as Error).message}`;
      }
    };
    expect(refusal(() => canvas.setPointerCapture(99))).toBe(
      "NotFoundError: Failed to execute 'setPointerCapture' on 'Element': No active pointer with the given id is found.",
    );
    expect(refusal(() => canvas.releasePointerCapture(99))).toBe(
      "NotFoundError: Failed to execute 'releasePointerCapture' on 'Element': No active pointer with the given id is found.",
    );
    expect(refusal(() => canvas.releasePointerCapture(1))).toBe('ok');
    const heard = sequence({ canvas }, CAPTURE);
    canvas.setPointerCapture(1);
    window.emit('mouseMove', at(110, 100));
    expect([canvas.hasPointerCapture(1), heard]).toEqual([
      false,
      ['pointermove@canvas', 'mousemove@canvas'],
    ]);
  });
});
