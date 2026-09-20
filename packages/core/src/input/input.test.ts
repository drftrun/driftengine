import { expect, test, vi } from 'vitest';
import { InputSource, askForPointerLock } from './input.ts';

/**
 * The test character's own report of an unhandled rejection, which is the thing the page
 * would have raised as `unhandledrejection`.
 *
 * Reached through `globalThis` rather than by naming `process`, because this repo has
 * no node types and one test is not a reason to take a dependency for them.
 */
interface RejectionWatcher {
  on(event: 'unhandledRejection', listener: (reason: unknown) => void): void;
  off(event: 'unhandledRejection', listener: (reason: unknown) => void): void;
}
const character = (globalThis as unknown as { process: RejectionWatcher }).process;

test('a refused pointer lock is swallowed rather than left to the page', async () => {
  /*
   * Chrome has returned a promise from `requestPointerLock` since 113, and it rejects
   * it whenever the request is refused — most often because the user has just left the
   * lock with Escape, which the browser follows with about a second of refusing to give
   * it back. The click that comes next asks anyway.
   *
   * Report `G94666`: an RTX 3060 holding a locked 16.667 ms filed `auto:unhandled_rejection`
   * 0.8 s after releasing a pointer lock. Nothing was wrong with that session. The
   * refusal was correct, ignoring it was correct, and dropping the promise on the floor
   * turned it into a fault report that cost the player one of the three a session gets.
   */
  const seen: unknown[] = [];
  const watch = (reason: unknown): void => {
    seen.push(reason);
  };
  character.on('unhandledRejection', watch);

  try {
    askForPointerLock(() => Promise.reject(new Error('the user exited the lock with Escape')));
    // An unhandled rejection is reported on the turn after the microtask queue drains,
    // so the check has to be made from a later task than the one that asked.
    await new Promise((resolve) => setTimeout(resolve, 0));
  } finally {
    character.off('unhandledRejection', watch);
  }

  expect(seen).toEqual([]);
});

test('a browser that returns nothing from the request is still fine', () => {
  // The promise is recent. Anything older hands back `undefined`, and reaching for
  // `.catch` on that would turn a browser that merely lacks a feature into a throw
  // inside a click handler.
  expect(() => {
    askForPointerLock(() => undefined);
  }).not.toThrow();
});

/*
 * **The camera takes the device's counts, not the desktop's cursor curve.**
 *
 * Without `unadjustedMovement` the pointer acceleration the operating system applies to a
 * cursor is applied to the look as well, so a slow hand is scaled toward nothing and a fast one
 * is scaled up. Reported from Firefox on Linux as a camera that ignores small movements and then
 * jumps, by somebody who had already ruled out the frame rate.
 */
test('the lock is asked for without the pointer acceleration on it', () => {
  const asked: (unknown | undefined)[] = [];
  askForPointerLock((options) => {
    asked.push(options);
    return undefined;
  });

  expect(asked).toEqual([{ unadjustedMovement: true }]);
});

/*
 * A browser that does not implement the option rejects and grants *nothing*, so asking once
 * would trade an accelerated camera for no camera at all. Asked again plainly, it behaves
 * exactly as it did before the option existed.
 */
test('a browser without the option is asked again without it', async () => {
  const asked: (unknown | undefined)[] = [];
  askForPointerLock((options) => {
    asked.push(options);
    if (options === undefined) return undefined;
    const refusal = new Error('unadjustedMovement is not supported');
    refusal.name = 'NotSupportedError';
    return Promise.reject(refusal);
  });
  await new Promise((resolve) => setTimeout(resolve, 0));

  expect(asked).toEqual([{ unadjustedMovement: true }, undefined]);
});

/*
 * And every other refusal is the ordinary one — the second after the user left the lock with
 * Escape, which is exactly when the next click arrives asking for it back. Asking again there
 * would be a second request for the same denial rather than a fallback.
 */
test('an ordinary refusal is not retried', async () => {
  const asked: (unknown | undefined)[] = [];
  askForPointerLock((options) => {
    asked.push(options);
    const refusal = new Error('the user exited the lock with Escape');
    refusal.name = 'SecurityError';
    return Promise.reject(refusal);
  });
  await new Promise((resolve) => setTimeout(resolve, 0));

  expect(asked).toEqual([{ unadjustedMovement: true }]);
});

/*
 * **And the call site has to hand them over, which is where this was lost.**
 *
 * The three tests above prove `askForPointerLock` *offers* the option. They cannot prove anybody
 * takes it, because each supplies its own callback — and the real one was
 * `() => this.target.requestPointerLock()`, a lambda with no parameters, so the options object was
 * built, passed, and dropped on the floor. Every browser was asked plainly, the fallback never had
 * anything to fall back from, and the camera kept the desktop's acceleration curve on it for as
 * long as the feature had shipped.
 *
 * It is the shape this repository keeps meeting: every layer carries the value and one layer does
 * not pass it on, with the test sitting on the layer above the drop. Reported twice from Firefox,
 * and from two separate consumers, which is what says it is not one application's wiring.
 */
test('the call site forwards the options rather than dropping them', () => {
  const asked: (unknown | undefined)[] = [];
  const target = {
    addEventListener: () => {},
    removeEventListener: () => {},
    requestPointerLock: (options?: unknown) => {
      asked.push(options);
      return undefined;
    },
  } as unknown as HTMLElement;

  /* The least window and document the constructor touches, on a character with no DOM. */
  const globals = globalThis as unknown as Record<string, unknown>;
  const hadWindow = 'window' in globals;
  const hadDocument = 'document' in globals;
  globals['window'] = {
    matchMedia: () => ({ matches: false }),
    addEventListener: () => {},
    removeEventListener: () => {},
  };
  globals['document'] = {
    addEventListener: () => {},
    removeEventListener: () => {},
    pointerLockElement: null,
  };

  try {
    new InputSource(target).requestPointerLock();
  } finally {
    if (!hadWindow) delete globals['window'];
    if (!hadDocument) delete globals['document'];
  }

  expect(asked, "the browser is asked for the device's own counts, not a plain lock").toEqual([
    { unadjustedMovement: true },
  ]);
});

/**
 * **A missing media query costs one hint, not the whole input system.**
 *
 * `isCoarse` decides whether a touch-shaped control scheme is offered, and it was read in the
 * constructor as `window.matchMedia('(pointer: coarse)').matches` with nothing in front of it. The
 * engine already knows better in two places: `ui/fullscreen.ts` tests `typeof window.matchMedia
 * !== 'function'` before the identical query, and this very file reads gamepads and animation
 * frames off `globalThis` defensively. The one unguarded line was the one in the constructor, so
 * the failure was not a degraded feature but a `new InputSource(...)` that threw — no input at all
 * in any embedder without the API, which is what the platform audit was looking for.
 */
test('input constructs where there is no pointer media query, and is not coarse', () => {
  const listeners = { addEventListener() {}, removeEventListener() {} };
  vi.stubGlobal('window', listeners);
  vi.stubGlobal('document', listeners);

  const target = {
    addEventListener() {},
    removeEventListener() {},
  } as unknown as HTMLElement;

  try {
    const input = new InputSource(target, [], { autoPoll: false });
    expect(input.isCoarse, 'no media query is not a coarse pointer').toBe(false);
    input.dispose();
  } finally {
    vi.unstubAllGlobals();
  }
});
