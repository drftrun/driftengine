/**
 * Touches, as a browser's page reads them: `Touch`, the `TouchList` three of which a `TouchEvent`
 * carries, and the event. The sibling of `uiEvents.ts`, split out only so each stays one screenful.
 *
 * A `TouchList` indexes, iterates and answers `item`, the three ways a page reads one; the engine's
 * input reads `changedTouches[i]`.
 */

import { type ModifierInit, UIEvent } from './uiEvents.ts';

export interface TouchInit {
  readonly identifier: number;
  readonly target: EventTarget;
  readonly clientX?: number;
  readonly clientY?: number;
  readonly screenX?: number;
  readonly screenY?: number;
  readonly radiusX?: number;
  readonly radiusY?: number;
  readonly force?: number;
}

export class Touch {
  readonly identifier: number;
  readonly target: EventTarget;
  readonly clientX: number;
  readonly clientY: number;
  readonly screenX: number;
  readonly screenY: number;
  readonly radiusX: number;
  readonly radiusY: number;
  readonly rotationAngle = 0;
  readonly force: number;
  readonly altitudeAngle = Math.PI / 2;
  readonly azimuthAngle = 0;
  readonly touchType = 'direct';
  constructor(init: TouchInit) {
    this.identifier = init.identifier;
    this.target = init.target;
    this.clientX = init.clientX ?? 0;
    this.clientY = init.clientY ?? 0;
    this.screenX = init.screenX ?? 0;
    this.screenY = init.screenY ?? 0;
    this.radiusX = init.radiusX ?? 0;
    this.radiusY = init.radiusY ?? 0;
    this.force = init.force ?? 0;
  }
  get pageX(): number {
    return this.clientX;
  }
  get pageY(): number {
    return this.clientY;
  }
}

export class TouchList {
  readonly length: number;
  [index: number]: Touch;
  constructor(touches: readonly Touch[] = []) {
    this.length = touches.length;
    touches.forEach((touch, at) => {
      this[at] = touch;
    });
  }
  item(index: number): Touch | null {
    return this[index] ?? null;
  }
  *[Symbol.iterator](): IterableIterator<Touch> {
    for (let at = 0; at < this.length; at += 1) yield this[at] as Touch;
  }
}

export interface TouchEventInit extends EventInit, ModifierInit {
  readonly touches?: readonly Touch[];
  readonly targetTouches?: readonly Touch[];
  readonly changedTouches?: readonly Touch[];
}

export class TouchEvent extends UIEvent {
  readonly touches: TouchList;
  readonly targetTouches: TouchList;
  readonly changedTouches: TouchList;
  readonly ctrlKey: boolean;
  readonly shiftKey: boolean;
  readonly altKey: boolean;
  readonly metaKey: boolean;
  constructor(type: string, init: TouchEventInit = {}) {
    super(type, init);
    this.touches = new TouchList(init.touches);
    this.targetTouches = new TouchList(init.targetTouches);
    this.changedTouches = new TouchList(init.changedTouches);
    this.ctrlKey = init.ctrlKey === true;
    this.shiftKey = init.shiftKey === true;
    this.altKey = init.altKey === true;
    this.metaKey = init.metaKey === true;
  }
}
