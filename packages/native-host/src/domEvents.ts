/**
 * What SDL tells a window, as the events a page hears: keys, the mouse, the wheel, focus,
 * visibility, resizing and closing.
 *
 * **The engine's input is not changed for this host.** `InputSource` listens on `window`,
 * `document` and its canvas for the events a browser sends, and so do the scenes, so they are sent
 * here in that shape: each the browser's class (`uiEvents.ts`), a key by its `code` and with the
 * character the layout typed (`keyEvents.ts`), a button in the browser's numbering, the wheel in
 * the browser's direction. Each is dispatched at the canvas, or at what has the focus, and the tree
 * (`domTree.ts`) captures and bubbles it as a browser's does.
 *
 * The mouse is `mouseEvents.ts`, which says what Chrome sends for it; keys are `keyEvents.ts`.
 *
 * Fingers are `touchEvents.ts`.
 */

import type { NativeCanvas } from './canvas.ts';
import { KeyEvents, type SdlKey } from './keyEvents.ts';
import { type EventMouse, MouseModel, type SdlPointer } from './mouseEvents.ts';
import { type SdlFinger, TouchModel } from './touchEvents.ts';
import type { HostPage } from './page.ts';

export type { EventMouse } from './mouseEvents.ts';

/** What this reads of an SDL window: its events, where it is on the screen, and its size. */
export interface EventWindow {
  on(type: string, listener: (event: never) => void): unknown;
  off(type: string, listener: (event: never) => void): unknown;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  /** Whether SDL has the window fullscreen, and the way to ask; a window without them has none. */
  readonly fullscreen?: boolean;
  setFullscreen?(on: boolean): void;
}

export interface EventOptions {
  /** The clock clicks are counted against, in milliseconds. */
  readonly now?: () => number;
}

const ESCAPE = 41;
/** The modifier keys by scancode, both sides of each, as the bits `modifiers` keeps. */
const MODIFIER = new Map([
  [224, 1],
  [228, 1],
  [225, 2],
  [229, 2],
  [226, 4],
  [230, 4],
  [227, 8],
  [231, 8],
]);

/** Connect `window`'s events to `page` and `canvas`, and hand back what disconnects them. */
export function connectDomEvents(
  window: EventWindow,
  mouse: EventMouse,
  page: HostPage,
  canvas: NativeCanvas,
  options: EventOptions = {},
): () => void {
  const keys = new KeyEvents(
    () => page.keyTarget(),
    () => page.userActivation.notify(),
  );
  /*
   * **Leaving puts the window back as it was**, not into a window: one already fullscreen before the
   * page asked — a game packaged fullscreen, or put there by the shell's bridge — stays so, as a
   * browser under F11 stays fullscreen when a page's element leaves.
   */
  let before = false;
  page.setFullscreener((on) => {
    if (window.setFullscreen === undefined) return false;
    try {
      if (on) before = window.fullscreen === true;
      window.setFullscreen(on || before);
      return true;
    } catch {
      return false;
    }
  });
  /* Which modifiers are down, so a pointer event can say, as a browser's does. */
  let modifiers = 0;
  const held = () => ({
    ctrlKey: (modifiers & 1) !== 0,
    shiftKey: (modifiers & 2) !== 0,
    altKey: (modifiers & 4) !== 0,
    metaKey: (modifiers & 8) !== 0,
  });
  const now = options.now ?? (() => performance.now());
  const pointer = new MouseModel(window, mouse, page, canvas, held, now);
  const fingers = new TouchModel(window, page, canvas, held, now);
  canvas.cursorer = (css) => pointer.cursor(css);
  /* SDL makes a mouse of every finger, which the finger's own events have already said. */
  const mouseOnly = (handle: (event: SdlPointer) => void) => (event: SdlPointer) => {
    if (event.touch !== true) handle(event);
  };

  const listeners: [string, (event: never) => void][] = [
    [
      'keyDown',
      (event: SdlKey) => {
        /* Escape is the browser's before it is the page's: it lets go of the lock and fullscreen. */
        if (event.scancode === ESCAPE && pointer.isLocked) page.unlock();
        if (event.scancode === ESCAPE) void page.document.exitFullscreen().catch(() => undefined);
        modifiers |= MODIFIER.get(event.scancode) ?? 0;
        keys.down(event);
      },
    ],
    ['textInput', ({ text }: { text: string }) => keys.text(text)],
    [
      'keyUp',
      (event: SdlKey) => {
        modifiers &= ~(MODIFIER.get(event.scancode) ?? 0);
        keys.up(event);
      },
    ],
    ['mouseMove', mouseOnly((event) => pointer.move(event))],
    ['mouseButtonDown', mouseOnly((event) => pointer.down(event))],
    ['mouseButtonUp', mouseOnly((event) => pointer.up(event))],
    ['mouseWheel', mouseOnly((event) => pointer.wheel(event))],
    ['fingerDown', (event: SdlFinger) => fingers.down(event)],
    ['fingerMove', (event: SdlFinger) => fingers.move(event)],
    ['fingerUp', (event: SdlFinger) => fingers.up(event)],
    ['hover', () => pointer.hover()],
    ['leave', () => pointer.leave()],
    ['focus', () => page.setFocused(true)],
    [
      'blur',
      () => {
        page.unlock();
        /* A key released in another window is never heard here. */
        modifiers = 0;
        page.setFocused(false);
      },
    ],
    ['minimize', () => page.setVisible(false)],
    ['hide', () => page.setVisible(false)],
    ['restore', () => page.setVisible(true)],
    ['show', () => page.setVisible(true)],
    ['maximize', () => page.setVisible(true)],
    /* After the host's own listener has resized the canvas, which it registered first. */
    [
      'resize',
      () => {
        /* Taken out of fullscreen by something other than the page: the element leaves with it. */
        if (window.fullscreen === false) page.fullscreen.lost();
        page.window.dispatchEvent(new Event('resize'));
        /* A query about the window's size or shape may now answer otherwise. */
        page.media.changed();
      },
    ],
    ['beforeClose', () => page.window.dispatchEvent(new Event('beforeunload'))],
  ];
  /* A key held for its text is sent before anything that happened after it. */
  for (const entry of listeners) {
    const [type, listener] = entry;
    if (type === 'keyDown' || type === 'textInput') continue;
    entry[1] = (event: never) => {
      keys.flush();
      listener(event);
    };
  }
  for (const [type, listener] of listeners) window.on(type, listener);
  return () => {
    for (const [type, listener] of listeners) window.off(type, listener);
  };
}
