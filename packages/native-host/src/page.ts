/**
 * The page a scene expects around its canvas, for a host that has none: `window`, `document`, and
 * the animation frames a browser schedules.
 *
 * **What is here is what gets read**, listed from every listener and property the engine's packages
 * and the published scenes reach: keys, pointers, the mouse, the wheel, focus, resizing and
 * unloading on `window`; visibility, focus and pointer lock on `document`; `requestAnimationFrame`,
 * which the engine's input polls from. The three are a tree (`domTree.ts`), so an event is
 * captured and bubbles as it does in a browser, and each answers the `on…` attributes. Anything
 * else a scene reaches for is a gap named when it is met — `createElement` refuses by name —
 * rather than a DOM this pretends to be.
 *
 * **Focus is a browser's.** The window has it or not, as SDL says; within it the canvas is focused
 * only once it is focusable, which a canvas is when it is given a `tabIndex`, and keys go to what
 * is focused, or to the document when nothing is.
 *
 * **A `document` is what the engine's splash looks for**, and it mounts one unless the scene says
 * `splash: false` or the page carries a shell's bridge (`__driftHost`). The published scenes all
 * say so; a packaged game is given the bridge.
 */

import { UserActivation } from './activation.ts';
import type { NativeCanvas } from './canvas.ts';
import { type Handlers, HostNode } from './domTree.ts';
import { installEventClasses } from './eventClasses.ts';
import { PageFullscreen } from './fullscreen.ts';
import { MediaQueries, type MediaQueryList } from './mediaQueries.ts';
import { PointerCapture } from './pointerCapture.ts';
import { FocusEvent } from './uiEvents.ts';

/** Every input event a page can be told of, which each of the three nodes answers `on…` for. */
export const INPUT_TYPES = [
  ...['keydown', 'keypress', 'keyup', 'focus', 'blur', 'wheel', 'contextmenu'],
  ...['click', 'dblclick', 'auxclick', 'mousedown', 'mouseup', 'mousemove'],
  ...['mouseover', 'mouseout', 'mouseenter', 'mouseleave'],
  ...['pointerdown', 'pointerup', 'pointermove', 'pointerover', 'pointerout'],
  ...['pointerenter', 'pointerleave', 'pointercancel', 'gotpointercapture', 'lostpointercapture'],
  ...['touchstart', 'touchmove', 'touchend', 'touchcancel', 'fullscreenchange', 'fullscreenerror'],
] as const;

type InputType = (typeof INPUT_TYPES)[number];
const WINDOW_TYPES = ['resize', 'beforeunload', 'gamepadconnected', 'gamepaddisconnected'] as const;
const DOCUMENT_TYPES = [
  'visibilitychange',
  'pointerlockchange',
  'pointerlockerror',
  'fullscreenchange',
  'fullscreenerror',
] as const;

/* The attributes `HostNode.handles` defines below, declared for the checker. */
export interface PageWindow extends Handlers<InputType | (typeof WINDOW_TYPES)[number]> {}
export interface PageDocument extends Handlers<InputType | (typeof DOCUMENT_TYPES)[number]> {}

export class PageWindow extends HostNode {
  canvas: NativeCanvas | null = null;
  /** Answered by the page, which knows what a query asks about (`mediaQueries.ts`). */
  matchMedia: (query: string) => MediaQueryList = () => {
    throw new Error('[driftengine] a window no page holds has no media to query');
  };
  get innerWidth(): number {
    return this.canvas?.clientWidth ?? 0;
  }
  get innerHeight(): number {
    return this.canvas?.clientHeight ?? 0;
  }
  get devicePixelRatio(): number {
    return this.canvas?.pixelRatio ?? 1;
  }
  static {
    HostNode.handles(PageWindow.prototype, [...INPUT_TYPES, ...WINDOW_TYPES]);
  }
}

export class PageDocument extends HostNode {
  visibilityState: DocumentVisibilityState = 'visible';
  pointerLockElement: Element | null = null;
  /** What is focused: the canvas, once it is focusable and asked, or nothing. */
  activeElement: NativeCanvas | null = null;
  /** Set by the page that owns this document, which is what holds the lock and the focus. */
  release: (() => void) | null = null;
  focused = true;
  /** The page's fullscreen, which this document reports. */
  fullscreenControl: PageFullscreen | null = null;
  readonly fullscreenEnabled = true;

  get fullscreenElement(): NativeCanvas | null {
    return this.fullscreenControl?.element ?? null;
  }

  /** The legacy flag, still read. */
  get fullscreen(): boolean {
    return this.fullscreenElement !== null;
  }

  exitFullscreen(): Promise<void> {
    return this.fullscreenControl?.exit() ?? Promise.resolve();
  }

  get hidden(): boolean {
    return this.visibilityState !== 'visible';
  }

  hasFocus(): boolean {
    return this.focused;
  }

  exitPointerLock(): void {
    this.release?.();
  }

  createElement(tag: string): never {
    throw new Error(`[driftengine] the native host has no DOM to make a <${tag}> in`);
  }

  static {
    HostNode.handles(PageDocument.prototype, [...INPUT_TYPES, ...DOCUMENT_TYPES]);
  }
}

export interface HostPageOptions {
  /** The clock a gesture's five seconds are measured on, in milliseconds. */
  readonly now?: () => number;
}

export class HostPage {
  readonly window = new PageWindow();
  readonly document = new PageDocument();
  /** Whether a person has just done something (`activation.ts`), as `navigator.userActivation`. */
  readonly userActivation: UserActivation;
  readonly fullscreen: PageFullscreen;
  /** Which pointers the page holds (`pointerCapture.ts`). */
  readonly capture = new PointerCapture();
  readonly media: MediaQueries;
  /** Whether a finger has landed: the one proof of a touch screen SDL gives. */
  private touched = false;
  /* Two queues swapped each frame, so a frame allocates nothing and asks made during it wait. */
  private asked = new Map<number, FrameRequestCallback>();
  private due = new Map<number, FrameRequestCallback>();
  private nextId = 1;
  private readonly lockListeners: ((locked: boolean) => void)[] = [];
  private locker: ((lock: boolean) => boolean) | null = null;

  constructor(options: HostPageOptions = {}) {
    this.userActivation = new UserActivation(options.now ?? (() => performance.now()));
    this.fullscreen = new PageFullscreen(this.userActivation);
    this.document.parentNode = this.window;
    this.document.release = () => this.unlock();
    this.document.fullscreenControl = this.fullscreen;
    this.fullscreen.changed = () => this.media.changed();
    this.media = new MediaQueries(() => ({
      width: this.window.innerWidth,
      height: this.window.innerHeight,
      pixelRatio: this.window.devicePixelRatio,
      fullscreen: this.document.fullscreenElement !== null,
      touched: this.touched,
    }));
    this.window.matchMedia = (query) => this.media.match(query);
  }

  /** A finger landed, so this is a touch screen, whatever SDL listed. */
  noteTouch(): void {
    if (this.touched) return;
    this.touched = true;
    this.media.changed();
  }

  readonly requestAnimationFrame = (callback: FrameRequestCallback): number => {
    const id = this.nextId;
    this.nextId += 1;
    this.asked.set(id, callback);
    return id;
  };

  readonly cancelAnimationFrame = (id: number): void => {
    this.asked.delete(id);
    this.due.delete(id);
  };

  /** One frame: the callbacks asked for before it began, in the order they were asked. */
  runFrame(now: number): void {
    const due = this.asked;
    this.asked = this.due;
    this.due = due;
    for (const [id, callback] of due) {
      /* Looked up again, so a callback cancelled by an earlier one this frame does not run. */
      if (!due.has(id)) continue;
      due.delete(id);
      callback(now);
    }
  }

  /** Whether the window can be seen, as `document.visibilityState` reports it. */
  setVisible(visible: boolean): void {
    const state: DocumentVisibilityState = visible ? 'visible' : 'hidden';
    if (this.document.visibilityState === state) return;
    this.document.visibilityState = state;
    this.document.dispatchEvent(new Event('visibilitychange'));
  }

  /**
   * The window gaining or losing the focus: the focused canvas is told first, as the element a
   * browser blurs, and then the window.
   */
  setFocused(focused: boolean): void {
    if (this.document.focused === focused) return;
    this.document.focused = focused;
    const canvas = this.document.activeElement;
    if (canvas !== null) focusEvents(canvas, focused);
    this.window.dispatchEvent(new FocusEvent(focused ? 'focus' : 'blur'));
  }

  /** Where a key goes: the focused element, or the document when nothing is focused. */
  keyTarget(): HostNode {
    return this.document.activeElement ?? this.document;
  }

  /** Hold `canvas` in this page: its parent, its pointer lock and its focus are the page's. */
  attach(canvas: NativeCanvas): void {
    canvas.parentNode = this.document;
    this.window.canvas = canvas;
    canvas.lockPointer = () => {
      if (!this.userActivation.isActive) {
        this.document.dispatchEvent(new Event('pointerlockerror', { bubbles: true }));
        return Promise.reject(
          refusal('NotAllowedError', 'A user gesture is required to request Pointer Lock.'),
        );
      }
      return this.lock(canvas as unknown as Element)
        ? Promise.resolve()
        : Promise.reject(
            refusal('NotAllowedError', '[driftengine] the window could not hold the pointer'),
          );
    };
    canvas.fullscreener = () => this.fullscreen.request(canvas);
    canvas.capture = this.capture;
    canvas.focuser = (focus) => {
      const now = this.document.activeElement;
      if (focus === (now === canvas)) return;
      this.document.activeElement = focus ? canvas : null;
      if (this.document.focused) focusEvents(canvas, focus);
    };
  }

  /**
   * The platform's half of the lock: hide the cursor and hold it, or let it go. Answers false when it
   * cannot — a window without focus, as a hidden one is — and the lock is then refused, the way a
   * browser refuses one: the promise rejects and `pointerlockerror` fires, and nothing is locked.
   */
  setPointerLocker(locker: (lock: boolean) => boolean): void {
    this.locker = locker;
  }

  /** The platform's half of fullscreen: put the window in it or take it out, false when it cannot. */
  setFullscreener(setter: (on: boolean) => boolean): void {
    this.fullscreen.setter = setter;
  }

  /** Told when the lock is taken or released. */
  onPointerLock(listener: (locked: boolean) => void): void {
    this.lockListeners.push(listener);
  }

  unlock(): void {
    if (this.document.pointerLockElement === null) return;
    this.locker?.(false);
    this.document.pointerLockElement = null;
    this.changedLock(false);
  }

  /** Put the globals a page has on `scope`, and hand back what takes them off again. */
  install(scope: Record<string, unknown> = globalThis as Record<string, unknown>): () => void {
    const names = [
      'window',
      'document',
      'requestAnimationFrame',
      'cancelAnimationFrame',
      'devicePixelRatio',
      'matchMedia',
    ] as const;
    const held = names.map((name) => [name, Object.getOwnPropertyDescriptor(scope, name)] as const);
    scope['window'] = this.window;
    scope['document'] = this.document;
    scope['requestAnimationFrame'] = this.requestAnimationFrame;
    scope['cancelAnimationFrame'] = this.cancelAnimationFrame;
    scope['matchMedia'] = this.window.matchMedia;
    Object.defineProperty(scope, 'devicePixelRatio', {
      get: () => this.window.devicePixelRatio,
      configurable: true,
    });
    const classes = installEventClasses(scope);
    /* Node has a `navigator` of its own, behind a getter, so it is added to rather than replaced. */
    const navigator = scope['navigator'] as object | undefined;
    if (navigator !== undefined) {
      Object.defineProperty(navigator, 'userActivation', {
        value: this.userActivation,
        configurable: true,
      });
    }
    return () => {
      classes();
      if (navigator !== undefined)
        delete (navigator as { userActivation?: unknown }).userActivation;
      for (const [name, descriptor] of held) {
        if (descriptor === undefined) delete scope[name];
        else Object.defineProperty(scope, name, descriptor);
      }
    };
  }

  private lock(element: Element): boolean {
    if (this.document.pointerLockElement === element) return true;
    if (this.locker !== null && !this.locker(true)) {
      this.document.dispatchEvent(new Event('pointerlockerror', { bubbles: true }));
      return false;
    }
    this.document.pointerLockElement = element;
    this.changedLock(true);
    return true;
  }

  private changedLock(locked: boolean): void {
    this.document.dispatchEvent(new Event('pointerlockchange', { bubbles: true }));
    for (const listener of this.lockListeners) listener(locked);
  }
}

/** `focus` and `focusin`, or `blur` and `focusout`: the first stays on the element, the second bubbles. */
function focusEvents(canvas: NativeCanvas, focused: boolean): void {
  canvas.dispatchEvent(new FocusEvent(focused ? 'focus' : 'blur'));
  canvas.dispatchEvent(new FocusEvent(focused ? 'focusin' : 'focusout', { bubbles: true }));
}

/** A `DOMException`-shaped refusal: a browser's error name, with its message. */
function refusal(name: string, message: string): Error {
  return Object.assign(new Error(message), { name });
}
