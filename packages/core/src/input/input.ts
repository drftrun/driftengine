/**
 * Low-level, device-agnostic input capture: raw keys, relative mouse motion,
 * live touch points. Interpretation (bindings, gestures, virtual stick) is the
 * game's job — this module never decides what an input *means*.
 */

import { isTypingTarget } from './typingTarget.ts';
import { ActiveDevice, type InputDevice } from './activeDevice.ts';
import { glyphFor, identifyGamepad, labelFor, type GamepadFamily } from './gamepadIdentity.ts';
import {
  AXIS_INDEX,
  BUTTON_INDEX,
  DEFAULT_DEADZONE,
  applyDeadzone,
  type GamepadAxis,
  type GamepadButton,
} from './gamepadMapping.ts';
import { type RawHapticActuator, playRumble, stopRumble } from './rumble.ts';

/**
 * Ask for the pointer lock, and deal with being told no.
 *
 * Split out from the caller below so the rule can be tested without a DOM, the
 * same way `isTypingTarget` is.
 *
 * **The refusal is expected and it is not an error.** Chrome returns a promise here
 * (113 and up) and rejects it when it will not grant the lock — most often for the
 * second or so after the user has left one with Escape, which is precisely when the
 * next click arrives asking for it back. Dropping that promise makes an ordinary
 * refusal an `unhandledrejection`, and in a game that watches for those it becomes a
 * bug report about nothing: see report `G94666`, 2026-08-08.
 *
 * `requestFullscreen` next door has always caught its own for the same reason.
 */
export function askForPointerLock(
  request: (options?: { unadjustedMovement: boolean }) => Promise<void> | void,
): void {
  /*
   * **Asked for without the operating system's pointer acceleration on it.**
   *
   * `movementX` is a *display* delta by default, so the pointer curve the desktop applies to a
   * cursor is applied to the camera as well: a slow hand is scaled toward nothing and a fast one
   * is scaled up, which is a camera that ignores small movements and then jumps. Reported from
   * Firefox on Linux as "if I move slowly it does not move, and if I accelerate it moves steppy,
   * not because the frame rate is low" — which is the acceleration curve described exactly, by
   * somebody who could tell it was not the frame rate.
   *
   * A game wants the device's own counts. `unadjustedMovement` is how the specification says so,
   * and it is per request rather than a setting, so it belongs here rather than at a call site.
   *
   * **The fallback is the whole reason this is two calls.** A browser that does not implement the
   * option rejects with `NotSupportedError` and grants *nothing*, so asking once and giving up
   * would trade an accelerated camera for no camera at all on every engine that lacks it. Asked
   * again without the option, that browser behaves exactly as it did before this existed.
   *
   * **Firefox is that browser, measured on 2026-08-25, and the fallback is not a rescue there.**
   * Firefox 154 returns a promise and rejects the option with `NotSupportedError`; asked plainly it
   * accepts, and what it then delivers is the compositor's accelerated cursor travel in whole
   * screen pixels — 1,787 locked events, **not one of them fractional**, 27% of them exactly one
   * pixel, and a slow hand producing *no event at all* because the accelerated position never
   * crosses a pixel boundary. That is the report this rule was written for, arriving again from a
   * browser the rule cannot reach. Chromium honours the option and is unaffected.
   *
   * **So this function cannot fix Firefox and is not the place to try.** What it can do is what it
   * does: ask properly, and fall back rather than leaving a game with no camera. A game that wants
   * to respond — a warning, a different sensitivity — needs to be told, and nothing tells it yet.
   * `demo/dev/mouse.html` is the instrument that produced the figures above.
   */
  const pending = request({ unadjustedMovement: true });
  // Undefined on anything older than the promise, so this cannot reach for `.catch`
  // unconditionally: a browser that merely lacks the feature would throw in a click.
  if (pending === undefined) return;
  void pending.catch((error: unknown) => {
    /*
     * **Only the option's own refusal is retried**, and the test is the name the specification
     * gives it. Every other refusal is the ordinary one this function was written for — most
     * often the second after the user left the lock with Escape, which is precisely when the
     * next click arrives asking for it back — and asking again immediately would be a second
     * request for the same denial rather than a fallback.
     */
    const unsupported =
      typeof error === 'object' &&
      error !== null &&
      (error as { name?: string }).name === 'NotSupportedError';
    if (!unsupported) return;
    const plain = request();
    if (plain !== undefined) {
      void plain.catch(() => {
        /* Refused. The game carries on with the mouse unlocked. */
      });
    }
  });
}

export interface TouchPoint {
  readonly id: number;
  x: number;
  y: number;
  readonly startX: number;
  readonly startY: number;
  readonly startTime: number;
}

/** The devices this source watches, and the granularity a consumer may switch off. */
export type InputSourceName = 'keyboard' | 'mouse' | 'touch' | 'gamepad';

export interface InputOptions {
  /**
   * Turn a device off. Absent means on.
   *
   * A disabled source is **inert, not absent**: its state stops updating, it never takes the
   * prompts, and — for the gamepad — the poll stops outright, so an application that does not want
   * controllers pays for no snapshot at all.
   */
  readonly sources?: Partial<Record<InputSourceName, boolean>>;
  /**
   * Whether to poll the gamepad on an animation frame of this source's own. Defaults to true.
   *
   * **True is what makes support seamless**: a consumer that wired nothing still gets a working
   * controller. Pass `false` and call `poll()` where you want the sample taken — which is what a
   * recorded replay needs, since a sample pinned to the fixed tick is reproducible and one taken
   * on a frame callback is not.
   */
  readonly autoPoll?: boolean;
  /** How far a stick travels before it is moving. See `DEFAULT_DEADZONE`. */
  readonly deadzone?: number;
}

/** What a pad is, as opposed to where its buttons are. See `gamepadIdentity.ts`. */
export interface GamepadIdentity {
  readonly family: GamepadFamily;
  /** What this pad calls that position: `faceDown` is `A`, `Cross` or `B`. */
  label(button: GamepadButton): string;
  /** A stable key for a consumer's own icon set, such as `xbox.a`. The engine ships no art. */
  glyph(button: GamepadButton): string;
}

/**
 * One connected pad, as a consumer holds it.
 *
 * A view per pad rather than flat accessors on the source, for two reasons: identity belongs to a
 * device and would otherwise be passed alongside every call, and local multiplayer falls out of it
 * instead of needing a second design later.
 */
export interface GamepadView {
  /** The browser's own slot, so a consumer can keep a player on the pad they picked up. */
  readonly index: number;
  readonly identity: GamepadIdentity;
  /**
   * `'standard'` when the browser vouches for the layout, `'unknown'` when it will not.
   *
   * The named accessors still answer on an unknown pad — they read the standard indices — but they
   * are reading a guess, and this is how a consumer can tell.
   */
  readonly mapping: 'standard' | 'unknown';
  /** Held right now. */
  down(button: GamepadButton): boolean;
  /**
   * Went down since the last poll, readable by anything.
   *
   * Clears at the next poll rather than at the read, so a menu and a heads-up display may both see
   * one press. Use `consumePress` where acting twice would be a bug.
   */
  pressed(button: GamepadButton): boolean;
  /**
   * The same edge, claimed — true for exactly one caller, then gone for everybody.
   *
   * **The hazard is a slow frame.** The fixed-step loop runs more than once, and a `pressed` that
   * stayed true across both ticks is a double jump from a single press. Anything acting inside
   * `simulate` claims; anything drawing reads `pressed`.
   */
  consumePress(button: GamepadButton): boolean;
  /** A stick axis with the deadzone applied, in [-1, 1]. Vertical points **up at −1**. */
  axis(axis: GamepadAxis): number;
  /** A lower shoulder's analog travel, in [0, 1]. It is a button and an axis, honestly both. */
  trigger(button: 'l2' | 'r2'): number;
  /** Any button by raw index, for a pad whose layout the browser will not vouch for. */
  button(index: number): boolean;
  /** Any axis by raw index, untouched by the deadzone. */
  rawAxis(index: number): number;
  /**
   * Whether this pad has motors this browser can drive.
   *
   * **Read it and grey the control out.** Most pads on most browsers cannot rumble, and a settings
   * screen offering a slider the player's hardware ignores is worse than one that says so. Re-read
   * it after a poll rather than caching: a pad unplugged and plugged back in is a different device
   * behind the same slot.
   */
  readonly canRumble: boolean;
  /**
   * Play a rumble for `durationMs`, at two magnitudes in [0, 1]. Answers whether it was taken.
   *
   * `strong` is the low-frequency motor and `weak` the high-frequency one, which is what a standard
   * pad has two of. Magnitudes are clamped into range and a duration past the platform's ceiling of
   * five seconds is clamped to it; a duration at or below zero is nothing to play and answers
   * `false`.
   *
   * **`false` is a real answer and not an error**: no actuator, a browser that cannot drive one, or
   * nothing to play. It never throws, and a failure after the fact — the pad unplugged mid-effect —
   * is reported once per pad on the console rather than as an unhandled rejection.
   */
  rumble(durationMs: number, strong: number, weak: number): boolean;
  /** Stop whatever is playing. Answers whether the platform took it. */
  stopRumble(): boolean;
}

export interface InputCallbacks {
  onKeyDown?: (code: string) => void;
  onTouchStart?: (touch: TouchPoint) => void;
  onTouchMove?: (touch: TouchPoint) => void;
  onTouchEnd?: (touch: TouchPoint, durationMs: number) => void;
}

/** Scratch for the deadzone, at module scope because `axis` is a per-frame read. */
const deadzoned = { x: 0, y: 0 };

/** Four is past generous for local play, and the array is preallocated to it. */
const MAX_PADS = 4;

/** The shape read off a `Gamepad`, named so this file does not depend on lib.dom's version. */
interface RawPad {
  readonly id: string;
  readonly index: number;
  readonly mapping: string;
  readonly buttons: ArrayLike<{ readonly pressed: boolean; readonly value: number }>;
  readonly axes: ArrayLike<number>;
  /** Absent on every pad without motors, and on every browser that does not implement them. */
  readonly vibrationActuator?: RawHapticActuator | null;
}

/**
 * One pad's state, reused across polls.
 *
 * **Bitmasks rather than arrays of booleans**, because the edge is the difference of two of them
 * and seventeen buttons fit in one integer. `pressed` is `downNow & ~downLast`, computed once at
 * the poll rather than derived at every read.
 */
class PadState implements GamepadView {
  index = -1;
  mapping: 'standard' | 'unknown' = 'unknown';
  live = false;
  id = '';
  private downNow = 0;
  private downLast = 0;
  private claimed = 0;
  /**
   * Presses waiting for somebody to act on them, one bit a button.
   *
   * The pad's half of the pair `keysUnclaimed` is for the keyboard, and it exists for the same
   * reason: a claimant does not run every display frame. See `sync`.
   */
  private unclaimed = 0;
  private readonly values = new Float32Array(17);
  private readonly axes = new Float32Array(8);
  private axisCount = 0;
  private buttonCount = 0;
  /**
   * The actuator from the most recent poll, and it is re-read every poll on purpose.
   *
   * A `Gamepad` is a fresh snapshot each `getGamepads` call and a pad unplugged and plugged back in
   * is a different device behind the same slot — holding the first actuator would drive hardware
   * that is no longer there, or fail against one that is.
   */
  private actuator: RawHapticActuator | null = null;
  /** So a failure is reported once per pad rather than once per effect. See `refuseIfUnvouched`. */
  private rumbleFailed = false;
  private readonly reportRumbleFailure = (): void => {
    if (this.rumbleFailed) return;
    this.rumbleFailed = true;
    console.warn(
      `[driftengine] this pad stopped taking haptic effects: ${JSON.stringify(this.id)}. ` +
        'It was most likely unplugged mid-effect; `canRumble` answers again after the next poll.',
    );
  };

  private readonly identityObject = {
    family: 'generic' as GamepadFamily,
    label: (button: GamepadButton): string => labelFor(this.identityObject.family, button),
    glyph: (button: GamepadButton): string => glyphFor(this.identityObject.family, button),
  };

  get identity(): GamepadIdentity {
    return this.identityObject;
  }

  /** Copy a snapshot into numbers, and latch this frame's edges. Allocates nothing. */
  sync(pad: RawPad): boolean {
    if (pad.id !== this.id) {
      this.id = pad.id;
      this.identityObject.family = identifyGamepad(pad.id);
      /* The browser's own word, normalised: it writes `''` where it will not vouch for a layout. */
      this.mapping = pad.mapping === 'standard' ? 'standard' : 'unknown';
    }
    this.index = pad.index;
    this.actuator = pad.vibrationActuator ?? null;
    this.downLast = this.downNow;
    let next = 0;
    const buttons = Math.min(pad.buttons.length, 17);
    this.buttonCount = buttons;
    for (let i = 0; i < buttons; i += 1) {
      const button = pad.buttons[i];
      if (button === undefined) continue;
      this.values[i] = button.value;
      if (button.pressed) next |= 1 << i;
    }
    /*
     * **A press waits to be claimed; only a release spends it.**
     *
     * This used to read *"an edge nobody claimed last frame is not carried into this one"*, which
     * makes a press live for exactly one poll — and `poll` is on an animation frame while a
     * fixed-step consumer is not. At 120 Hz against a 60 Hz simulation about half the display
     * frames run no tick at all, so a press landing in one of those was dropped before anything
     * could claim it, and a controller's jump went missing in proportion to the player's refresh
     * rate. The keyboard was given a claim-scoped edge for this exact reason; the pad kept the
     * frame-scoped one and had the same bug for longer.
     *
     * New presses accumulate, a claim spends one, and a button coming back up spends whatever is
     * left — a press nobody wanted, whose button is no longer down, describes nothing anybody can
     * still act on. Per button, so claiming one never spends another: two buttons in one frame are
     * two independent claims, which is what *"press B+A at the same identical time"* needs.
     */
    this.unclaimed |= next & ~this.downNow;
    this.unclaimed &= next;
    this.downNow = next;
    /* The *readable* edge stays frame-scoped: `pressed` is what a UI draws with, and a highlight
       that outlived its frame would be wrong. */
    this.claimed = 0;
    const axes = Math.min(pad.axes.length, 8);
    this.axisCount = axes;
    for (let i = 0; i < axes; i += 1) this.axes[i] = pad.axes[i] ?? 0;
    return next !== 0;
  }

  /** Whether any stick has left the dead region, which counts as the player using this pad. */
  moved(deadzone: number): boolean {
    for (let i = 0; i + 1 < this.axisCount; i += 2) {
      applyDeadzone(this.axes[i] ?? 0, this.axes[i + 1] ?? 0, deadzone, deadzoned);
      if (deadzoned.x !== 0 || deadzoned.y !== 0) return true;
    }
    return false;
  }

  deadzone = DEFAULT_DEADZONE;

  down(button: GamepadButton): boolean {
    return (this.downNow & (1 << BUTTON_INDEX[button])) !== 0;
  }

  pressed(button: GamepadButton): boolean {
    const bit = 1 << BUTTON_INDEX[button];
    return (this.downNow & ~this.downLast & ~this.claimed & bit) !== 0;
  }

  consumePress(button: GamepadButton): boolean {
    const bit = 1 << BUTTON_INDEX[button];
    if ((this.unclaimed & bit) === 0) return false;
    this.unclaimed &= ~bit;
    /* So the readable edge agrees within the frame that produced it: something drawing this button
       as freshly pressed must stop the moment somebody acts on it. */
    this.claimed |= bit;
    return true;
  }

  axis(axis: GamepadAxis): number {
    const index = AXIS_INDEX[axis];
    /* Deadzoned against its partner, because the dead region is a circle over the pair rather
       than a window on each — see `applyDeadzone`. */
    const pairFirst = index - (index % 2);
    applyDeadzone(
      this.axes[pairFirst] ?? 0,
      this.axes[pairFirst + 1] ?? 0,
      this.deadzone,
      deadzoned,
    );
    return index === pairFirst ? deadzoned.x : deadzoned.y;
  }

  /**
   * A trigger's travel, and it is deliberately not `axis`.
   *
   * A stick's deadzone is a circle over a *pair*, and a trigger has no partner to pair with — so
   * asking for one through `axis` would either invent a partner or mean something different from
   * every other member of that method. It rests at 0 and needs no dead region of its own.
   */
  trigger(button: 'l2' | 'r2'): number {
    return this.values[BUTTON_INDEX[button]] ?? 0;
  }

  button(index: number): boolean {
    if (index < 0 || index >= this.buttonCount) return false;
    return (this.downNow & (1 << index)) !== 0;
  }

  rawAxis(index: number): number {
    if (index < 0 || index >= this.axisCount) return 0;
    return this.axes[index] ?? 0;
  }

  get canRumble(): boolean {
    return this.actuator !== null && typeof this.actuator.playEffect === 'function';
  }

  rumble(durationMs: number, strong: number, weak: number): boolean {
    return playRumble(this.actuator, durationMs, strong, weak, this.reportRumbleFailure);
  }

  stopRumble(): boolean {
    return stopRumble(this.actuator, this.reportRumbleFailure);
  }
}

export class InputSource {
  readonly isCoarse: boolean;
  readonly touches = new Map<number, TouchPoint>();
  readonly target: HTMLElement;

  private readonly keys = new Set<string>();
  private readonly preventDefaultCodes: ReadonlySet<string>;
  private readonly subscribers: InputCallbacks[] = [];
  private mouseDx = 0;
  private mouseDy = 0;
  private mouseButtonDown = false;
  private readonly disposers: Array<() => void> = [];

  /** Which device the player last actually used, and who wants telling when that changes. */
  private readonly active = new ActiveDevice();
  private readonly enabled: Record<InputSourceName, boolean> = {
    keyboard: true,
    mouse: true,
    touch: true,
    gamepad: true,
  };
  /** Preallocated: a poll must not build a pad per frame. */
  private readonly padStates: PadState[] = Array.from({ length: MAX_PADS }, () => new PadState());
  /** The live subset, as a stable array whose length is set rather than rebuilt. */
  private readonly padViews: GamepadView[] = [];
  private deadzone = DEFAULT_DEADZONE;
  private autoPoll = true;
  private frameHandle = 0;
  /** Devices already refused in words, so a refusal is once a pad rather than once a frame. */
  private readonly refusedPads = new Set<string>();
  /**
   * Keys that went down since the last poll, and the ones a caller has claimed.
   *
   * `isDown` is a level and `onKeyDown` is a callback; neither is an edge a simulation tick can
   * take. These give the keyboard the two verbs a pad already had, latched at the same moment and
   * cleared at the same one, which is what lets one action answer for both devices without either
   * being a special case.
   */
  private keysPressed = new Set<string>();
  private keysPressedNext = new Set<string>();
  private readonly keysClaimed = new Set<string>();
  /**
   * Presses waiting for somebody to act on them.
   *
   * **Separate from `keysPressed`, because the two edges have different lifetimes and conflating
   * them lost inputs.** `keysPressed` is for *drawing* — a highlight that outlived its frame would
   * be wrong — so it rotates every poll. This one is for *acting*, and a claimant does not run
   * every frame: `poll` is on an animation frame and a fixed-step simulation is not, so at 120 Hz
   * against a 60 Hz tick about half the display frames run no tick at all. A press that landed in
   * one of those was rotated away before anything could claim it, and the player's jump did not
   * happen — intermittently, in proportion to their refresh rate. A consumer found it by replacing
   * a hand-rolled `onKeyDown` latch, which cleared only when the simulation ran, with
   * `ActionMap.consumePress`.
   *
   * So a claim lives until it is claimed or until the key comes back up. **Releasing is what makes
   * it stale**: a press nobody wanted, whose key is no longer down, describes nothing anybody can
   * still act on. What this costs is a press held across a screen that does not read it, which
   * then lands on the screen that does — which is the same thing the hand-rolled latch did.
   */
  private readonly keysUnclaimed = new Set<string>();

  /**
   * `options` is a **third** parameter rather than a widened second, so every existing call site
   * keeps compiling. A consumer that passes only a target and its prevent-default codes gets the
   * behaviour it always had, plus a working controller it did not ask for.
   */
  constructor(
    target: HTMLElement,
    preventDefaultCodes: Iterable<string> = [],
    options: InputOptions = {},
  ) {
    this.target = target;
    this.preventDefaultCodes = new Set(preventDefaultCodes);
    this.isCoarse = window.matchMedia('(pointer: coarse)').matches;
    this.deadzone = options.deadzone ?? DEFAULT_DEADZONE;
    this.autoPoll = options.autoPoll ?? true;
    for (const name of ['keyboard', 'mouse', 'touch', 'gamepad'] as const) {
      this.enabled[name] = options.sources?.[name] ?? true;
    }
    for (const pad of this.padStates) pad.deadzone = this.deadzone;

    this.listen(window, 'keydown', (e: KeyboardEvent) => {
      /*
       * A keystroke aimed at a text field is not the game's.
       *
       * Before this, `preventDefaultCodes` applied everywhere, so a consumer that
       * asked for `Space` and `KeyE` — reasonably, since Space scrolls the page —
       * silently made those characters untypeable in its own forms. A consumer
       * hit exactly that: a player could not put a space or an `e` into a bug report.
       *
       * The key is not registered either, not merely un-prevented: holding `W` to
       * write a word must not walk the character into the sea behind the dialog.
       */
      if (isTypingTarget(e.target)) return;
      if (!this.enabled.keyboard) return;
      if (this.preventDefaultCodes.has(e.code)) e.preventDefault();
      if (e.repeat) return;
      this.keys.add(e.code);
      this.keysPressedNext.add(e.code);
      this.keysUnclaimed.add(e.code);
      this.active.use('keyboard');
      for (let i = 0; i < this.subscribers.length; i++) {
        this.subscribers[i]?.onKeyDown?.(e.code);
      }
    });
    // Always released, even from a field: a key held *before* focus moved into one
    // is in `keys`, and skipping its keyup would leave the character walking forever.
    this.listen(window, 'keyup', (e: KeyboardEvent) => {
      this.keys.delete(e.code);
      /* And the unclaimed press goes with it — see `keysUnclaimed`. */
      this.keysUnclaimed.delete(e.code);
    });
    this.listen(window, 'blur', () => {
      this.keys.clear();
      this.keysUnclaimed.clear();
    });

    this.listen(target, 'mousedown', () => {
      if (!this.enabled.mouse) return;
      this.mouseButtonDown = true;
      this.active.use('mouse');
    });
    this.listen(window, 'mouseup', () => {
      this.mouseButtonDown = false;
    });
    /*
     * **Released by anything that can eat the mouseup, exactly as the keys are.**
     *
     * A held key survives a lost focus and leaves the character walking forever, which is why
     * `blur` clears `keys` above. This flag had no such release and is worse when it sticks,
     * because it does not merely hold an input on — it silently moves the look onto a **cursor
     * that is not locked**, and an unlocked cursor is a different device: its `movementX` is the
     * travel of an arrow across the desktop, so it stops dead at the edge of the display and it
     * arrives in whole screen pixels with the operating system's acceleration curve on it.
     *
     * That is two bug reports in one. The camera turns until it will not turn any further and
     * only frees up when the mouse is moved back, which is the arrow sitting against the edge;
     * and a slow hand moves the camera not at all while a fast one moves it in steps, which is
     * sub-pixel travel rounding to zero and then to several at once. Both were reported on
     * browser fullscreen, where the transition blurs the window — eating the mouseup — and the
     * frame is the whole screen, so there is no desktop left to travel across before the edge.
     *
     * `visibilitychange` as well as `blur`, because a tab switched away with a button held
     * comes back to a document that never saw the release either.
     */
    this.listen(window, 'blur', () => {
      this.mouseButtonDown = false;
    });
    this.listen(window, 'pointercancel', () => {
      this.mouseButtonDown = false;
    });
    /* Not in `GlobalEventHandlersEventMap`, so it is bound directly and disposed by hand. */
    const onHidden = (): void => {
      if (document.visibilityState !== 'visible') this.mouseButtonDown = false;
    };
    document.addEventListener('visibilitychange', onHidden);
    this.disposers.push(() => document.removeEventListener('visibilitychange', onHidden));
    this.listen(window, 'mousemove', (e: MouseEvent) => {
      if (!this.enabled.mouse) return;
      /* Offered rather than asserted: a mousemove is not necessarily a decision, so
         `ActiveDevice` accumulates it against a threshold. See its own comment. */
      this.active.moved(e.movementX, e.movementY);
      if (this.hasPointerLock || this.mouseButtonDown) {
        this.mouseDx += e.movementX;
        this.mouseDy += e.movementY;
      }
    });

    this.listen(target, 'touchstart', (e: TouchEvent) => this.onTouches(e, 'start'), false);
    this.listen(target, 'touchmove', (e: TouchEvent) => this.onTouches(e, 'move'), false);
    this.listen(target, 'touchend', (e: TouchEvent) => this.onTouches(e, 'end'), false);
    this.listen(target, 'touchcancel', (e: TouchEvent) => this.onTouches(e, 'end'), false);

    /* **This is what makes a controller work with no wiring at all**, which is the requirement.
       It never starts when the source is off, so an application that declines controllers pays
       nothing rather than paying for a loop that returns immediately. */
    this.startPolling();
  }

  isDown(code: string): boolean {
    return this.keys.has(code);
  }

  /* -- Gamepads, hints and policy -------------------------------------------------------- */

  /**
   * The pads currently connected and seen, most recently sampled.
   *
   * **A pad is invisible until the player uses it**, and that is the browser's rule rather than
   * this engine's: reporting a connected gamepad before a button has been pressed is a
   * fingerprinting surface, so none does. It happens to be the rule this design wanted anyway.
   *
   * The array is stable and its length is set rather than rebuilt, so reading it allocates
   * nothing.
   */
  get pads(): readonly GamepadView[] {
    return this.padViews;
  }

  /**
   * One pad by position in `pads`, or null.
   *
   * **Position in the list, not the browser's slot** — `GamepadView.index` answers that, and is
   * what a consumer pins a player to. The distinction shows itself when a pad is unplugged: the
   * list closes up, and a caller holding a slot wants `index`.
   */
  pad(at: number): GamepadView | null {
    return this.padViews[at] ?? null;
  }

  /** Which device the player last actually used. See `activeDevice.ts` for what counts as use. */
  get lastDevice(): InputDevice {
    return this.active.last;
  }

  /** Told when that changes, and only when it changes. Returns the unsubscribe. */
  onDeviceChange(listener: (device: InputDevice) => void): () => void {
    return this.active.subscribe(listener);
  }

  /**
   * Turn a device on or off at runtime, for a settings screen.
   *
   * A disabled source is inert rather than absent, and disabling the gamepad stops the poll
   * outright — so an application that does not want controllers pays for no snapshot a frame.
   */
  setSourceEnabled(source: InputSourceName, enabled: boolean): void {
    this.enabled[source] = enabled;
    if (source !== 'gamepad') return;
    if (enabled) {
      this.startPolling();
      return;
    }
    this.padViews.length = 0;
  }

  /**
   * Sample the pads now.
   *
   * **Called once an animation frame by this source's own loop unless `autoPoll` is false**, and
   * public so a consumer can pin the sample to its own fixed tick instead — which is what a
   * recorded replay needs, since a sample taken on a frame callback is not reproducible.
   *
   * **`getGamepads()` allocates**, an array and the objects behind it, and that cost is the
   * browser's rather than something this engine can pool. So it is called exactly once here and
   * never from a read: every accessor on a view is a lookup on numbers already copied out. A frame
   * that runs three simulation ticks polls once, which is also the correct semantics — the
   * hardware cannot have changed between two ticks of one frame.
   */
  poll(): void {
    /*
     * The keyboard's frame boundary, and it happens whether or not there are pads.
     *
     * Rotated rather than cleared: a key pressed *during* the frame that is about to end belongs
     * to the next one, and clearing here would drop it on any consumer that presses and polls in
     * the same task. The two sets are swapped so neither is allocated per frame.
     */
    const spent = this.keysPressed;
    this.keysPressed = this.keysPressedNext;
    spent.clear();
    this.keysPressedNext = spent;
    this.keysClaimed.clear();

    if (!this.enabled.gamepad) return;
    const source = (globalThis as { navigator?: { getGamepads?: () => (RawPad | null)[] } })
      .navigator;
    if (source === undefined || typeof source.getGamepads !== 'function') return;

    const raw = source.getGamepads();
    let live = 0;
    let used = false;
    for (let i = 0; i < raw.length && live < MAX_PADS; i += 1) {
      const pad = raw[i];
      if (pad === null || pad === undefined) continue;
      const state = this.padStates[live];
      if (state === undefined) continue;

      const anyDown = state.sync(pad);
      this.refuseIfUnvouched(state);
      if (anyDown || state.moved(this.deadzone)) used = true;
      this.padViews[live] = state;
      live += 1;
    }
    this.padViews.length = live;
    if (used) this.active.use('gamepad');
  }

  /**
   * Say once, per device, that a pad's layout is not one the browser will vouch for.
   *
   * **Served rather than refused**, so a consumer that knows the device can still reach it by
   * index — but said out loud, because silence would leave a player whose arcade stick does
   * nothing with no way to discover why, which is the silent no-op the house rules forbid. Once
   * per device rather than once per frame, exactly as `registerCompute` refuses: a line every
   * frame floods a console somebody needs to read.
   */
  private refuseIfUnvouched(state: PadState): void {
    if (state.mapping !== 'unknown' || this.refusedPads.has(state.id)) return;
    this.refusedPads.add(state.id);
    console.warn(
      `[driftengine] the browser will not vouch for this pad's layout: ${JSON.stringify(state.id)}. ` +
        'Its named buttons read the standard positions and may be wrong; read `mapping` and reach ' +
        'it with `button(index)` and `rawAxis(index)`.',
    );
  }

  private startPolling(): void {
    /*
     * Not gated on the gamepad source, and that changed in 2.13.0. The poll advances the *input*
     * frame — it rotates the keyboard's edges as well as sampling pads — so a consumer that
     * switched controllers off would otherwise find `keyPressed` never clearing. What the gamepad
     * switch still turns off is the expensive half: `getGamepads`, which allocates, is not called
     * at all.
     */
    if (this.frameHandle !== 0 || !this.autoPoll) return;
    const frames = (globalThis as { requestAnimationFrame?: (fn: () => void) => number })
      .requestAnimationFrame;
    if (typeof frames !== 'function') return;
    /* Built once rather than per frame: a closure created every frame is the allocation the house
       rule about hot paths is about. */
    const tick = (): void => {
      this.frameHandle = frames(tick);
      this.poll();
    };
    this.frameHandle = frames(tick);
  }

  private stopPolling(): void {
    if (this.frameHandle === 0) return;
    const cancel = (globalThis as { cancelAnimationFrame?: (handle: number) => void })
      .cancelAnimationFrame;
    if (typeof cancel === 'function') cancel(this.frameHandle);
    this.frameHandle = 0;
  }

  /**
   * Whether a key went down since the last poll. Readable by anything, cleared at the next poll.
   *
   * The keyboard's half of the pair `GamepadView.pressed` documents: use this to draw, and
   * `consumeKeyPress` to act, so a slow frame running the fixed-step loop twice cannot act twice.
   */
  keyPressed(code: string): boolean {
    return this.keysPressed.has(code) && !this.keysClaimed.has(code);
  }

  /** The same edge, claimed: true for exactly one caller, then gone for everybody. */
  consumeKeyPress(code: string): boolean {
    if (!this.keysUnclaimed.delete(code)) return false;
    /* So the readable edge agrees within the frame that produced it: something drawing this key as
       freshly pressed must stop the moment somebody acts on it. */
    this.keysClaimed.add(code);
    return true;
  }

  /**
   * Add a device-event subscriber. Multiple reusable control layers may listen
   * without overwriting one another; interpretation still happens outside the
   * raw source. Subscription and removal are initialization-time operations.
   */
  subscribe(callbacks: InputCallbacks): () => void {
    this.subscribers.push(callbacks);
    let subscribed = true;
    return () => {
      if (!subscribed) return;
      subscribed = false;
      const index = this.subscribers.indexOf(callbacks);
      if (index >= 0) this.subscribers.splice(index, 1);
    };
  }

  /** Drain accumulated relative mouse motion into `out` (allocation-free). */
  consumeMouseDelta(out: { dx: number; dy: number }): void {
    out.dx = this.mouseDx;
    out.dy = this.mouseDy;
    this.mouseDx = 0;
    this.mouseDy = 0;
  }

  get hasPointerLock(): boolean {
    return document.pointerLockElement === this.target;
  }

  requestPointerLock(): void {
    if (!this.isCoarse && !this.hasPointerLock) {
      /*
       * **The options are forwarded, and this line is where they were lost.**
       *
       * It was `() => this.target.requestPointerLock()`, a lambda taking no parameters, so the
       * `{ unadjustedMovement: true }` that `askForPointerLock` builds was passed to it and
       * dropped. Every browser was asked plainly, the fallback had nothing to fall back from, and
       * the camera kept the desktop's acceleration curve for as long as the feature had shipped —
       * reported twice from Firefox and from two separate consumers, which is what said it was the
       * engine rather than one application's wiring. `input.test.ts` covered the helper and not
       * this call, which is why three green tests sat on top of it.
       */
      askForPointerLock((options) => this.target.requestPointerLock(options));
    }
  }

  dispose(): void {
    this.stopPolling();
    this.padViews.length = 0;
    for (const dispose of this.disposers) dispose();
    this.disposers.length = 0;
    this.subscribers.length = 0;
    this.keys.clear();
    this.touches.clear();
  }

  private onTouches(e: TouchEvent, phase: 'start' | 'move' | 'end'): void {
    if (!this.enabled.touch) return;
    e.preventDefault();
    if (phase === 'start') this.active.use('touch');
    const now = performance.now();
    for (let i = 0; i < e.changedTouches.length; i++) {
      const t = e.changedTouches[i];
      if (t === undefined) continue;
      if (phase === 'start') {
        const point: TouchPoint = {
          id: t.identifier,
          x: t.clientX,
          y: t.clientY,
          startX: t.clientX,
          startY: t.clientY,
          startTime: now,
        };
        this.touches.set(t.identifier, point);
        for (let subscriber = 0; subscriber < this.subscribers.length; subscriber++) {
          this.subscribers[subscriber]?.onTouchStart?.(point);
        }
      } else {
        const point = this.touches.get(t.identifier);
        if (point === undefined) continue;
        point.x = t.clientX;
        point.y = t.clientY;
        if (phase === 'move') {
          for (let subscriber = 0; subscriber < this.subscribers.length; subscriber++) {
            this.subscribers[subscriber]?.onTouchMove?.(point);
          }
        } else {
          this.touches.delete(t.identifier);
          const durationMs = now - point.startTime;
          for (let subscriber = 0; subscriber < this.subscribers.length; subscriber++) {
            this.subscribers[subscriber]?.onTouchEnd?.(point, durationMs);
          }
        }
      }
    }
  }

  private listen<K extends keyof GlobalEventHandlersEventMap>(
    target: EventTarget,
    type: K,
    handler: (event: GlobalEventHandlersEventMap[K]) => void,
    passive?: boolean,
  ): void {
    const options = passive === undefined ? undefined : { passive };
    target.addEventListener(type, handler as EventListener, options);
    this.disposers.push(() => target.removeEventListener(type, handler as EventListener));
  }
}
