import {
  AXIS_INDEX,
  BUTTON_INDEX,
  type GamepadAxis,
  type GamepadButton,
} from './gamepadMapping.ts';

/**
 * A browser with a controller in it, for tests that need `InputSource` and not a machine.
 *
 * **Not a `.test.ts` file, and that is the point.** Vitest registers a test when the file
 * declaring it is imported, so a second test file importing this from beside its own tests would
 * re-run every test in that file as well. Split out for the same reason `rendererHarness.ts` is.
 *
 * **This character has no DOM at all** — the vitest environment is `node`, because what this
 * repository tests is simulation rather than pages. `input.test.ts` already stubbed `window` and
 * `document` on `globalThis` by hand; this generalises that and adds a `navigator` with a pad
 * behind it.
 *
 * **`requestAnimationFrame` is a queue this drives rather than a clock.** The poll runs on a frame
 * callback, and a test that waited for a real one would be slow and would sometimes fail. `frame()`
 * runs exactly one, so a test states how many frames happened instead of hoping.
 *
 * `restore()` puts back whatever was there, and a test must call it in a `finally`: leaking a fake
 * `window` into the next file is a failure that reads as the next file's bug.
 */

interface FakeButton {
  pressed: boolean;
  value: number;
}

export function fakeBrowser(id = 'Xbox 360 Controller (XInput STANDARD GAMEPAD)') {
  const buttons: FakeButton[] = Array.from({ length: 17 }, () => ({ pressed: false, value: 0 }));
  const axes: number[] = [0, 0, 0, 0];
  let connected = false;
  let mapping = 'standard';
  let padId = id;

  /**
   * A fresh array every call, and fresh button objects behind it — **because the real one does
   * that too**, and the poll's whole design rests on it. A harness that handed back the same array
   * would let a renderer read it many times a frame and never show the cost.
   */
  const calls = { getGamepads: 0 };

  /**
   * The rumble half, recorded rather than felt.
   *
   * **A haptic effect has no observable result in a test**, which is exactly why the surface answers
   * a boolean rather than nothing: what can be asserted is whether the platform took the call and
   * what it was handed. So the effects are recorded here and the tests read them.
   *
   * `hasActuator` is a switch rather than a fixture, because the capability under test is largely
   * the *refusal*: most pads on most browsers cannot rumble, and a settings screen has to know.
   */
  const effects: { type: string; params: Record<string, number> }[] = [];
  let resets = 0;
  let hasActuator = true;
  let hasReset = true;
  let failEffect = false;

  const actuator = {
    playEffect: (type: string, params: Record<string, number>): Promise<string> => {
      effects.push({ type, params: { ...params } });
      return failEffect
        ? Promise.reject(new Error('the pad went away'))
        : Promise.resolve('complete');
    },
    reset: (): Promise<string> => {
      resets += 1;
      return Promise.resolve('complete');
    },
  };

  const getGamepads = (): (object | null)[] => {
    calls.getGamepads += 1;
    if (!connected) return [null];
    return [
      {
        id: padId,
        index: 0,
        mapping,
        connected: true,
        buttons: buttons.map((b) => ({ pressed: b.pressed, value: b.value })),
        axes: axes.slice(),
        vibrationActuator: hasActuator
          ? hasReset
            ? actuator
            : { playEffect: actuator.playEffect }
          : null,
      },
    ];
  };

  const frameCallbacks: ((time: number) => void)[] = [];
  let nextFrameHandle = 1;

  const target = {
    addEventListener: () => {},
    removeEventListener: () => {},
    requestPointerLock: () => undefined,
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 640, height: 480 }),
  } as unknown as HTMLElement;

  const globals = globalThis as unknown as Record<string, unknown>;
  const had: Record<string, { present: boolean; value: unknown }> = {};
  const install = (name: string, value: unknown): void => {
    had[name] = { present: name in globals, value: globals[name] };
    /* `defineProperty` rather than assignment: `navigator` is a getter on the Node global and
       assigning to it is silently ignored, which would leave the poll reading the real one. */
    Object.defineProperty(globals, name, { value, configurable: true, writable: true });
  };

  /** Window listeners this harness can fire, so a key is a statement rather than a real event. */
  const windowListeners = new Map<string, ((event: unknown) => void)[]>();
  install('window', {
    matchMedia: () => ({ matches: false }),
    addEventListener: (type: string, fn: (event: unknown) => void) => {
      const existing = windowListeners.get(type);
      if (existing === undefined) windowListeners.set(type, [fn]);
      else existing.push(fn);
    },
    removeEventListener: (type: string, fn: (event: unknown) => void) => {
      const existing = windowListeners.get(type);
      if (existing === undefined) return;
      const at = existing.indexOf(fn);
      if (at >= 0) existing.splice(at, 1);
    },
  });
  install('document', {
    addEventListener: () => {},
    removeEventListener: () => {},
    pointerLockElement: null,
    visibilityState: 'visible',
  });
  install('navigator', { getGamepads });
  install('requestAnimationFrame', (fn: (time: number) => void) => {
    frameCallbacks.push(fn);
    return nextFrameHandle++;
  });
  install('cancelAnimationFrame', () => {});

  const indexOfButton = (button: GamepadButton): number => BUTTON_INDEX[button];

  return {
    target,
    /**
     * How many times the poll asked the browser for pads.
     *
     * The number the once-a-frame rule is asserted on: `getGamepads` allocates an array and the
     * objects behind it, so a read that called it again would multiply that by however many
     * buttons a frame looks at.
     */
    calls,
    /** Every effect the poll's pad was asked to play, in order, with the parameters it was given. */
    effects,
    /** How many times the actuator was reset, which is what stopping a rumble does. */
    get resets(): number {
      return resets;
    },
    /**
     * Whether this pad carries an actuator, and whether that actuator carries `reset`.
     *
     * Both are real states a browser produces: a keyboard-shaped pad has no actuator at all, and an
     * older Chromium's actuator has `playEffect` without `reset`.
     */
    rumbleSupport(present: boolean, options: { reset?: boolean; fail?: boolean } = {}): void {
      hasActuator = present;
      hasReset = options.reset ?? true;
      failEffect = options.fail ?? false;
    },
    connect(nextId = padId, nextMapping = 'standard'): void {
      padId = nextId;
      mapping = nextMapping;
      connected = true;
    },
    disconnect(): void {
      connected = false;
    },
    press(button: GamepadButton): void {
      const at = buttons[indexOfButton(button)];
      if (at !== undefined) {
        at.pressed = true;
        at.value = 1;
      }
    },
    release(button: GamepadButton): void {
      const at = buttons[indexOfButton(button)];
      if (at !== undefined) {
        at.pressed = false;
        at.value = 0;
      }
    },
    axis(axis: GamepadAxis, value: number): void {
      axes[AXIS_INDEX[axis]] = value;
    },
    /** Press a key, as the window would deliver it. `target` is nothing a game is typing into. */
    keyDown(code: string): void {
      for (const fn of windowListeners.get('keydown') ?? []) {
        fn({ code, repeat: false, target: null, preventDefault: () => {} });
      }
    },
    keyUp(code: string): void {
      for (const fn of windowListeners.get('keyup') ?? []) fn({ code });
    },
    /** Run exactly one animation frame, which is what a poll rides on. */
    frame(): void {
      const pending = frameCallbacks.splice(0, frameCallbacks.length);
      for (const fn of pending) fn(0);
    },
    restore(): void {
      for (const [name, before] of Object.entries(had)) {
        if (before.present) {
          Object.defineProperty(globals, name, {
            value: before.value,
            configurable: true,
            writable: true,
          });
        } else {
          delete globals[name];
        }
      }
    },
  };
}
