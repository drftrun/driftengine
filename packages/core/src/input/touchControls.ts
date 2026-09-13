/** Configurable two-zone mobile controls over raw touch input. */

import type { TouchPoint } from './input.ts';
import { InputSource } from './input.ts';

export interface TouchControlsOptions {
  /**
   * The two nodes the stick is *drawn* with, when a caller wants one drawn.
   *
   * **Optional, and that is a correction rather than a convenience.** These were positional
   * arguments and read as dependencies — a consumer who could not reach the page concluded the
   * class needed two elements to work, and constructed two `div`s it never appended anywhere so
   * the input maths would run. It does not need them: they are an *output channel*, written to and
   * never read. Every touch comes from `input.target`, and every number this class reports is
   * computed without either node.
   *
   * So absent means the stick has no visible representation and the controls work exactly as they
   * did, which is what a consumer drawing its own HUD, drawing none, or forbidden the page wants.
   * `stickBase` takes `hidden` and a position; `stickNub` takes a transform.
   */
  stickBase?: HTMLElement;
  stickNub?: HTMLElement;
  /** Fraction of the input surface assigned to the dynamic stick. */
  splitRatio?: number;
  stickRadiusPx?: number;
  stickDeadzone?: number;
  gestureMovePx?: number;
  holdResolveMs?: number;
  /**
   * How long a touch may last and still fire the primary on release.
   *
   * The press fires on release, so this duration *is* the action's input
   * latency, and a caller whose action has a grace window of its own — a
   * platformer's coyote time — wants the two sized against each other. Set it
   * past that window and a tap begun at the edge of a drop resolves after the
   * body is unjumpably in the air.
   */
  tapMaxMs?: number;
  /**
   * Whether holding the second zone still also *fires* the primary, or only holds it.
   *
   * The default is only-holds, and it is the fix for a real complaint from phone
   * testing: a still thumb kept firing the primary action, so there was no way to hold
   * position and look. A thumb placed down and held is what looking around
   * *starts* with, so resolving it into a press fires the action every time somebody
   * lines up a camera move. There is no threshold that separates "still thumb" from
   * "about to look", because they are the same input.
   *
   * A tap still fires on release, which is where the intent actually is; and the hold
   * still reports `primaryHeld`, so a caller whose action has a held form — a glide, a
   * charge — keeps it. Only the *edge* from a motionless press is gone.
   *
   * The promotion is not a verdict, and reading it as one is what later ate the tap:
   * a touch promoted to the hold and released quickly is still a tap, because the
   * player's thumb did the thing a tap is. See `isTapRelease`.
   */
  fireOnHold?: boolean;
  swipeMaxMs?: number;
  /** Vertical travel divided by horizontal travel required for a swipe. */
  swipeDominance?: number;
}

import { classifyRightGesture, isTapRelease } from './rightGesture.ts';

type RightMode = 'pending' | 'look' | 'secondary' | 'primary-hold';

/**
 * Second-zone touches beyond the first, and what they may do.
 *
 * The first thumb in the zone owns everything continuous: the look, and the
 * held form of the primary. Anything after it owns only *edges* — a tap, a
 * flick — because two fingers contributing look at once is one camera being
 * dragged in two directions, which is a worse control than the one this fixes.
 *
 * They exist at all because the zone used to drop every touch after the first
 * outright: a player steering through a corner could not jump out of it without
 * letting go of the corner.
 */
const EXTRA_SLOTS = 3;
const NO_TOUCH = -1;

/**
 * A reusable mobile scheme: dynamic stick on the first zone; look plus a
 * primary tap/hold and secondary downward swipe on the second. The class
 * reports generic control state. A game decides whether those signals mean
 * jump, fire, crouch, slide, or anything else.
 */
export class TouchControls {
  moveX = 0;
  moveY = 0;
  primaryHeld = false;
  secondaryHeld = false;
  onFirstTouch: (() => void) | null = null;

  private primaryQueued = false;
  private lookDx = 0;
  private lookDy = 0;
  private leftId: number | null = null;
  private rightId: number | null = null;
  private rightMode: RightMode = 'pending';
  private rightLastX = 0;
  private rightLastY = 0;
  /** Greatest distance the owning touch has reached from where it landed. */
  private rightTravel = 0;
  private rightStart: TouchPoint | null = null;
  private firstTouchSeen = false;

  /*
   * The extra second-zone touches, as parallel fixed arrays: a touch event
   * arrives as often as a frame does while a thumb is down, so nothing on this
   * path may allocate.
   */
  private readonly extraIds = new Int32Array(EXTRA_SLOTS).fill(NO_TOUCH);
  private readonly extraTravel = new Float32Array(EXTRA_SLOTS);
  private readonly extraSliding = new Uint8Array(EXTRA_SLOTS);
  /** Whether the owning touch is the one holding the secondary. */
  private ownerSliding = false;

  private readonly stickBase: HTMLElement | null;
  private readonly stickNub: HTMLElement | null;
  private readonly surface: HTMLElement;
  private readonly splitRatio: number;
  private readonly stickRadiusPx: number;
  private readonly stickDeadzone: number;
  private readonly gestureMovePx: number;
  private readonly holdResolveMs: number;
  private readonly tapMaxMs: number;
  private readonly fireOnHold: boolean;
  private readonly swipeMaxMs: number;
  private readonly swipeDominance: number;
  private readonly unsubscribe: () => void;

  /**
   * Take the input surface, and optionally the two nodes the stick is drawn with.
   *
   * **Two forms, and the older one is kept working rather than deprecated.** It was
   * `(input, stickBase, stickNub, options)`, which put an output channel where a reader expects a
   * dependency — a consumer forbidden the page read the signature, concluded the class could not be
   * used without two `HTMLElement`s, and built two it threw away. The options form says what is
   * true: the elements are how the stick is *drawn*, and drawing it is optional.
   *
   * `new TouchControls(input)` is a working control scheme with no visible stick.
   */
  constructor(input: InputSource, options?: TouchControlsOptions);
  constructor(
    input: InputSource,
    stickBase: HTMLElement,
    stickNub: HTMLElement,
    options?: TouchControlsOptions,
  );
  constructor(
    input: InputSource,
    second: HTMLElement | TouchControlsOptions = {},
    third?: HTMLElement,
    fourth: TouchControlsOptions = {},
  ) {
    /*
     * **A third argument means the positional form, and nothing about the second is inspected.**
     *
     * Sniffing the second argument was tried first and is wrong: `instanceof HTMLElement` needs a
     * DOM constructor this package is checked without, and duck-typing on `nodeType` reads a
     * stand-in element as an options object — which this file's own harness supplies, so the first
     * version silently dropped every option a positional caller passed. The arity carries the
     * answer without asking what anything is.
     */
    const positional = third !== undefined;
    const options: TouchControlsOptions = positional ? fourth : (second as TouchControlsOptions);
    this.stickBase = positional ? (second as HTMLElement) : (options.stickBase ?? null);
    this.stickNub = positional ? (third ?? null) : (options.stickNub ?? null);
    this.surface = input.target;
    this.splitRatio = options.splitRatio ?? 0.5;
    this.stickRadiusPx = options.stickRadiusPx ?? 40;
    this.stickDeadzone = options.stickDeadzone ?? 0.12;
    /*
     * Twenty rather than fourteen: a thumb rolls a little as it lands, and at
     * fourteen that roll turned a tap into a two-degree camera nudge. Nothing
     * is lost at the start of a look, because the travel that resolves one is
     * credited to it (see `onMove`).
     */
    this.gestureMovePx = options.gestureMovePx ?? 20;
    this.holdResolveMs = options.holdResolveMs ?? 90;
    this.tapMaxMs = options.tapMaxMs ?? 180;
    this.fireOnHold = options.fireOnHold ?? false;
    this.swipeMaxMs = options.swipeMaxMs ?? 160;
    this.swipeDominance = options.swipeDominance ?? 2.4;
    this.validateOptions();
    this.unsubscribe = input.subscribe({
      onTouchStart: (touch) => this.onStart(touch),
      onTouchMove: (touch) => this.onMove(touch),
      onTouchEnd: (touch, durationMs) => this.onEnd(touch, durationMs),
    });
  }

  /** Resolve a still second-zone touch into the generic primary hold. */
  tick(nowMs: number): void {
    const start = this.rightStart;
    if (this.rightMode !== 'pending' || start === null) return;
    if (nowMs - start.startTime >= this.holdResolveMs) {
      // Held, not fired: see `fireOnHold`. A motionless thumb is somebody deciding
      // where to look, and firing under it is the bug this exists to prevent.
      if (this.fireOnHold) this.primaryQueued = true;
      this.primaryHeld = true;
      this.rightMode = 'primary-hold';
    }
  }

  /** Consume the primary edge exactly once. */
  consumePrimaryPress(): boolean {
    const queued = this.primaryQueued;
    this.primaryQueued = false;
    return queued;
  }

  /** Drain accumulated second-zone look motion into a caller-owned object. */
  consumeLook(out: { dx: number; dy: number }): void {
    out.dx = this.lookDx;
    out.dy = this.lookDy;
    this.lookDx = 0;
    this.lookDy = 0;
  }

  dispose(): void {
    this.unsubscribe();
    if (this.stickBase !== null) this.stickBase.hidden = true;
    this.moveX = 0;
    this.moveY = 0;
    this.primaryHeld = false;
    this.secondaryHeld = false;
    this.ownerSliding = false;
    this.extraIds.fill(NO_TOUCH);
    this.extraSliding.fill(0);
  }

  private onStart(touch: TouchPoint): void {
    if (!this.firstTouchSeen) {
      this.firstTouchSeen = true;
      this.onFirstTouch?.();
    }
    const bounds = this.surface.getBoundingClientRect();
    const splitX = bounds.left + bounds.width * this.splitRatio;
    if (touch.startX < splitX) {
      if (this.leftId !== null) return;
      this.leftId = touch.id;
      this.showStick(touch.startX, touch.startY);
      return;
    }
    if (this.rightId !== null) {
      this.claimExtra(touch.id);
      return;
    }
    this.rightId = touch.id;
    this.rightMode = 'pending';
    this.rightStart = touch;
    this.rightTravel = 0;
    this.rightLastX = touch.x;
    this.rightLastY = touch.y;
  }

  private onMove(touch: TouchPoint): void {
    if (touch.id === this.leftId) {
      this.updateStick(touch);
      return;
    }
    if (touch.id !== this.rightId) {
      this.moveExtra(touch);
      return;
    }

    const dx = touch.x - touch.startX;
    const dy = touch.y - touch.startY;
    this.rightTravel = Math.max(this.rightTravel, Math.hypot(dx, dy));

    if (this.rightMode === 'pending') {
      const gesture = this.classify(touch, dx, dy);
      if (gesture === 'secondary') {
        this.rightMode = 'secondary';
        this.ownerSliding = true;
        this.secondaryHeld = true;
      } else if (gesture === 'look') {
        this.rightMode = 'look';
        /*
         * Credit the travel that resolved the gesture. Starting the count from
         * here instead threw away the first dozen pixels of every drag, which
         * is a dead zone at the start of each look and reads as the camera
         * being slow to respond rather than as an input being dropped.
         */
        this.lookDx += dx;
        this.lookDy += dy;
        this.rightLastX = touch.x;
        this.rightLastY = touch.y;
      }
    } else if (this.rightMode === 'look' || this.rightMode === 'primary-hold') {
      /*
       * A held thumb still looks, and keeps holding while it does.
       *
       * The hold used to be a terminal state: once a motionless touch resolved
       * into it, the same thumb could no longer move the camera for the rest of
       * its life. That is the wrong half of the input to freeze — the held form
       * is for verbs that last (a glide), and a verb that lasts is exactly the
       * one you need to steer through.
       */
      this.lookDx += touch.x - this.rightLastX;
      this.lookDy += touch.y - this.rightLastY;
    }
    this.rightLastX = touch.x;
    this.rightLastY = touch.y;
  }

  private onEnd(touch: TouchPoint, durationMs: number): void {
    if (touch.id === this.leftId) {
      this.leftId = null;
      this.moveX = 0;
      this.moveY = 0;
      if (this.stickBase !== null) this.stickBase.hidden = true;
      return;
    }
    if (touch.id !== this.rightId) {
      this.endExtra(touch, durationMs);
      return;
    }

    /*
     * `primary-hold` counts as a tap here, and that is the fix. It is the state
     * a still thumb is promoted into after `holdResolveMs`, so the old test —
     * fire only from `pending` — threw away every tap slower than 90 ms, which
     * on a phone is most of them. `isTapRelease` decides on travel and duration
     * instead, which is what a tap actually is.
     */
    if (
      (this.rightMode === 'pending' || this.rightMode === 'primary-hold') &&
      this.isTap(this.rightTravel, durationMs)
    ) {
      this.primaryQueued = true;
    }
    if (this.rightMode === 'secondary') {
      this.ownerSliding = false;
      this.refreshSecondary();
    }
    if (this.rightMode === 'primary-hold') this.primaryHeld = false;
    this.rightId = null;
    this.rightStart = null;
    this.rightMode = 'pending';
    this.rightTravel = 0;
  }

  private claimExtra(id: number): void {
    for (let i = 0; i < EXTRA_SLOTS; i++) {
      if (this.extraIds[i] !== NO_TOUCH) continue;
      this.extraIds[i] = id;
      this.extraTravel[i] = 0;
      this.extraSliding[i] = 0;
      return;
    }
  }

  private extraSlot(id: number): number {
    for (let i = 0; i < EXTRA_SLOTS; i++) {
      if (this.extraIds[i] === id) return i;
    }
    return -1;
  }

  private moveExtra(touch: TouchPoint): void {
    const slot = this.extraSlot(touch.id);
    if (slot < 0) return;
    const dx = touch.x - touch.startX;
    const dy = touch.y - touch.startY;
    this.extraTravel[slot] = Math.max(this.extraTravel[slot] ?? 0, Math.hypot(dx, dy));
    // A flick still reads as one from any finger. A drag does not become a
    // look: the owning thumb has the camera, and a second one joining it would
    // make every two-thumb frame a fight over the same axis.
    if (this.extraSliding[slot] === 0 && this.classify(touch, dx, dy) === 'secondary') {
      this.extraSliding[slot] = 1;
      this.secondaryHeld = true;
    }
  }

  private endExtra(touch: TouchPoint, durationMs: number): void {
    const slot = this.extraSlot(touch.id);
    if (slot < 0) return;
    if (this.isTap(this.extraTravel[slot] ?? 0, durationMs)) this.primaryQueued = true;
    this.extraIds[slot] = NO_TOUCH;
    this.extraSliding[slot] = 0;
    this.refreshSecondary();
  }

  /** The secondary is held while *any* touch in the zone is holding it. */
  private refreshSecondary(): void {
    let held = this.ownerSliding;
    for (let i = 0; i < EXTRA_SLOTS && !held; i++) held = this.extraSliding[i] === 1;
    this.secondaryHeld = held;
  }

  private classify(touch: TouchPoint, dx: number, dy: number) {
    return classifyRightGesture(dx, dy, performance.now() - touch.startTime, {
      gestureMovePx: this.gestureMovePx,
      swipeMaxMs: this.swipeMaxMs,
      swipeDominance: this.swipeDominance,
    });
  }

  private isTap(travelPx: number, durationMs: number): boolean {
    return isTapRelease(travelPx, durationMs, {
      gestureMovePx: this.gestureMovePx,
      tapMaxMs: this.tapMaxMs,
    });
  }

  private showStick(x: number, y: number): void {
    if (this.stickBase !== null) {
      this.stickBase.style.left = `${x}px`;
      this.stickBase.style.top = `${y}px`;
      this.stickBase.hidden = false;
    }
    if (this.stickNub !== null) this.stickNub.style.transform = 'translate3d(0, 0, 0)';
  }

  private updateStick(touch: TouchPoint): void {
    const dx = touch.x - touch.startX;
    const dy = touch.y - touch.startY;
    const length = Math.hypot(dx, dy);
    const strength = Math.min(length / this.stickRadiusPx, 1);

    if (strength < this.stickDeadzone || length < 1e-6) {
      this.moveX = 0;
      this.moveY = 0;
    } else {
      this.moveX = (dx / length) * strength;
      this.moveY = (-dy / length) * strength;
    }

    const clampedLength = Math.min(length, this.stickRadiusPx);
    const nx = length > 1e-6 ? (dx / length) * clampedLength : 0;
    const ny = length > 1e-6 ? (dy / length) * clampedLength : 0;
    if (this.stickNub !== null) {
      this.stickNub.style.transform = `translate3d(${nx}px, ${ny}px, 0)`;
    }
  }

  private validateOptions(): void {
    if (this.splitRatio <= 0 || this.splitRatio >= 1) {
      throw new Error(`TouchControls.splitRatio must be between 0 and 1, got ${this.splitRatio}`);
    }
    if (this.stickRadiusPx <= 0) {
      throw new Error(`TouchControls.stickRadiusPx must be positive, got ${this.stickRadiusPx}`);
    }
    if (this.stickDeadzone < 0 || this.stickDeadzone >= 1) {
      throw new Error(`TouchControls.stickDeadzone must be in [0, 1), got ${this.stickDeadzone}`);
    }
  }
}
