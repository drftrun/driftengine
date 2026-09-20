/**
 * The browser's input events, for a runtime that has only `Event`: keys, the mouse, pointers, the
 * wheel, touches, focus and pads, as classes with the members a browser's carry.
 *
 * **A page reads more of an event than the engine does.** The engine's input reads a key's `code`
 * and a pointer's movement; a consumer's own code reads `getModifierState`, `detail` for a double
 * click, the legacy `keyCode`, `pressure`, `offsetX`, or asks `instanceof PointerEvent`. An event
 * assembled from a bare `Event` answers none of those, and the failure is a `TypeError` inside the
 * consumer's handler or an `undefined` in its arithmetic. So each is its class, installed as the
 * global a browser has, defaulting every member as the UI Events and Pointer Events specifications
 * do.
 *
 * **Two of Chrome's own answers are kept where they differ from a first reading of those
 * specifications**, both measured in Chrome 151 on 2026-09-19: a `MouseEvent` whose button did not
 * change reports `button` 0 where a `PointerEvent` reports −1, and `which` is that raw button plus
 * one, so 0 for a move either way.
 *
 * What it gives up: coordinates are the window's, which is the canvas's here, so `pageX` is
 * `clientX` (nothing scrolls) and `offsetX` is measured from the target's box when it has one.
 */

type Modifier = 'AltGraph' | 'CapsLock' | 'NumLock';

export interface ModifierInit {
  readonly ctrlKey?: boolean;
  readonly shiftKey?: boolean;
  readonly altKey?: boolean;
  readonly metaKey?: boolean;
  readonly modifierAltGraph?: boolean;
  readonly modifierCapsLock?: boolean;
  readonly modifierNumLock?: boolean;
}

interface UiInit extends EventInit {
  readonly detail?: number;
  readonly view?: unknown;
}

export class UIEvent extends Event {
  readonly detail: number;
  readonly view: unknown;
  constructor(type: string, init: UiInit = {}) {
    super(type, init);
    this.detail = init.detail ?? 0;
    this.view = init.view ?? null;
  }
}

/** `getModifierState`, which every event carrying modifiers answers the same way. */
function modifierState(init: ModifierInit, key: string): boolean {
  if (key === 'Shift') return init.shiftKey === true;
  if (key === 'Control') return init.ctrlKey === true;
  if (key === 'Alt') return init.altKey === true;
  if (key === 'Meta') return init.metaKey === true;
  const locked: Record<Modifier, boolean | undefined> = {
    AltGraph: init.modifierAltGraph,
    CapsLock: init.modifierCapsLock,
    NumLock: init.modifierNumLock,
  };
  return locked[key as Modifier] === true;
}

export interface MouseInit extends UiInit, ModifierInit {
  readonly screenX?: number;
  readonly screenY?: number;
  readonly clientX?: number;
  readonly clientY?: number;
  readonly movementX?: number;
  readonly movementY?: number;
  /** −1 where no button changed: a move, an enter, a leave. */
  readonly button?: number;
  readonly buttons?: number;
  readonly relatedTarget?: EventTarget | null;
}

export class MouseEvent extends UIEvent {
  readonly screenX: number;
  readonly screenY: number;
  readonly clientX: number;
  readonly clientY: number;
  readonly movementX: number;
  readonly movementY: number;
  readonly ctrlKey: boolean;
  readonly shiftKey: boolean;
  readonly altKey: boolean;
  readonly metaKey: boolean;
  readonly buttons: number;
  readonly relatedTarget: EventTarget | null;
  protected readonly rawButton: number;
  private readonly modifiers: ModifierInit;

  constructor(type: string, init: MouseInit = {}) {
    super(type, init);
    this.screenX = init.screenX ?? 0;
    this.screenY = init.screenY ?? 0;
    this.clientX = init.clientX ?? 0;
    this.clientY = init.clientY ?? 0;
    this.movementX = init.movementX ?? 0;
    this.movementY = init.movementY ?? 0;
    this.ctrlKey = init.ctrlKey === true;
    this.shiftKey = init.shiftKey === true;
    this.altKey = init.altKey === true;
    this.metaKey = init.metaKey === true;
    this.rawButton = init.button ?? 0;
    this.buttons = init.buttons ?? 0;
    this.relatedTarget = init.relatedTarget ?? null;
    this.modifiers = init;
  }

  get button(): number {
    return Math.max(this.rawButton, 0);
  }
  get which(): number {
    return this.rawButton + 1;
  }
  get x(): number {
    return this.clientX;
  }
  get y(): number {
    return this.clientY;
  }
  get pageX(): number {
    return this.clientX;
  }
  get pageY(): number {
    return this.clientY;
  }
  get offsetX(): number {
    return this.clientX - boxOf(this.target).left;
  }
  get offsetY(): number {
    return this.clientY - boxOf(this.target).top;
  }
  getModifierState(key: string): boolean {
    return modifierState(this.modifiers, key);
  }
}

function boxOf(target: EventTarget | null): { left: number; top: number } {
  const box = (target as { getBoundingClientRect?: () => DOMRect } | null)?.getBoundingClientRect;
  return typeof box === 'function' ? box.call(target) : { left: 0, top: 0 };
}

export interface WheelInit extends MouseInit {
  readonly deltaX?: number;
  readonly deltaY?: number;
  readonly deltaZ?: number;
  readonly deltaMode?: number;
}

export class WheelEvent extends MouseEvent {
  static readonly DOM_DELTA_PIXEL = 0;
  static readonly DOM_DELTA_LINE = 1;
  static readonly DOM_DELTA_PAGE = 2;
  readonly deltaX: number;
  readonly deltaY: number;
  readonly deltaZ: number;
  readonly deltaMode: number;
  constructor(type: string, init: WheelInit = {}) {
    super(type, init);
    this.deltaX = init.deltaX ?? 0;
    this.deltaY = init.deltaY ?? 0;
    this.deltaZ = init.deltaZ ?? 0;
    this.deltaMode = init.deltaMode ?? 0;
  }
}

export interface PointerInit extends MouseInit {
  readonly pointerId?: number;
  readonly width?: number;
  readonly height?: number;
  readonly pressure?: number;
  readonly pointerType?: string;
  readonly isPrimary?: boolean;
}

export class PointerEvent extends MouseEvent {
  readonly pointerId: number;
  readonly width: number;
  readonly height: number;
  readonly pressure: number;
  readonly tangentialPressure = 0;
  readonly tiltX = 0;
  readonly tiltY = 0;
  readonly twist = 0;
  readonly altitudeAngle = Math.PI / 2;
  readonly azimuthAngle = 0;
  readonly pointerType: string;
  readonly isPrimary: boolean;
  constructor(type: string, init: PointerInit = {}) {
    super(type, init);
    this.pointerId = init.pointerId ?? 0;
    this.width = init.width ?? 1;
    this.height = init.height ?? 1;
    this.pressure = init.pressure ?? 0;
    this.pointerType = init.pointerType ?? '';
    this.isPrimary = init.isPrimary === true;
  }
  override get button(): number {
    return this.rawButton;
  }
  /** A move stands for itself: this host coalesces nothing, so there is one event in it. */
  getCoalescedEvents(): PointerEvent[] {
    return this.type === 'pointermove' ? [this] : [];
  }
  getPredictedEvents(): PointerEvent[] {
    return [];
  }
}

export interface KeyInit extends UiInit, ModifierInit {
  readonly key?: string;
  readonly code?: string;
  readonly location?: number;
  readonly repeat?: boolean;
  readonly isComposing?: boolean;
  readonly keyCode?: number;
  readonly charCode?: number;
}

export class KeyboardEvent extends UIEvent {
  static readonly DOM_KEY_LOCATION_STANDARD = 0;
  static readonly DOM_KEY_LOCATION_LEFT = 1;
  static readonly DOM_KEY_LOCATION_RIGHT = 2;
  static readonly DOM_KEY_LOCATION_NUMPAD = 3;
  readonly key: string;
  readonly code: string;
  readonly location: number;
  readonly repeat: boolean;
  readonly isComposing: boolean;
  readonly ctrlKey: boolean;
  readonly shiftKey: boolean;
  readonly altKey: boolean;
  readonly metaKey: boolean;
  /** The legacy pair: a key's code on `keydown` and `keyup`, a character's on `keypress`. */
  readonly keyCode: number;
  readonly charCode: number;
  private readonly modifiers: ModifierInit;
  constructor(type: string, init: KeyInit = {}) {
    super(type, init);
    this.key = init.key ?? '';
    this.code = init.code ?? '';
    this.location = init.location ?? 0;
    this.repeat = init.repeat === true;
    this.isComposing = init.isComposing === true;
    this.ctrlKey = init.ctrlKey === true;
    this.shiftKey = init.shiftKey === true;
    this.altKey = init.altKey === true;
    this.metaKey = init.metaKey === true;
    this.keyCode = init.keyCode ?? 0;
    this.charCode = init.charCode ?? 0;
    this.modifiers = init;
  }
  get which(): number {
    return this.keyCode;
  }
  getModifierState(key: string): boolean {
    return modifierState(this.modifiers, key);
  }
}

export class FocusEvent extends UIEvent {
  readonly relatedTarget: EventTarget | null;
  constructor(type: string, init: UiInit & { relatedTarget?: EventTarget | null } = {}) {
    super(type, init);
    this.relatedTarget = init.relatedTarget ?? null;
  }
}
