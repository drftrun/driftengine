/**
 * The host's frames, in the order a browser runs one: the page's animation frames, the frame
 * itself, the task's microtask checkpoint, then the present.
 *
 * **The checkpoint before the present is the part that is easy to lose.** A browser puts the canvas
 * on the screen when the task ends, after every microtask queued in it has run, and the WebGPU
 * renderer relies on that: whatever is drawn after `endFrame` is submitted on a microtask, since
 * there is no second `endFrame` to hang it on. A host that presents as soon as the frame returns
 * blits the canvas before that submission, so the window never shows an overlay while the canvas
 * texture, which a capture reads back, holds it — a loading screen seen by every capture and by
 * nobody at the machine.
 *
 * Taken as steps rather than as a window, so the order can be held by a test without a display.
 */

/** One frame's call: the page's clock in milliseconds, and how many frames were drawn before it. */
export interface FrameCall {
  readonly now: number;
  readonly drawn: number;
}

/** The device's error scope around a frame, where there is a device to scope. */
export interface FrameErrors {
  open(): void;
  close(): void;
}

export interface FrameSteps {
  /** Stop after this many; unbounded when absent. */
  readonly frames?: number;
  /** Whether to draw another: false once the window has closed or the game has asked to quit. */
  readonly open: () => boolean;
  /** The page's clock, read once a frame. */
  readonly clock: () => number;
  /** Where a held clock moves, before anything reads it. */
  readonly before?: (drawn: number) => void;
  /** The page's animation-frame callbacks, which a browser runs before it paints. */
  readonly animationFrames: (now: number) => void;
  /** The device's error scope for this frame, or null before the canvas has a device. */
  readonly errors: () => FrameErrors | null;
  /**
   * Draw the frame, or answer with a promise when there is nothing to draw until it settles — a
   * scene still mounting. The loop waits for it, presents nothing for that frame and does not count
   * it, rather than spinning through empty frames: that burned a core between two scenes, and spent
   * a run's frame budget before the next scene had drawn once.
   */
  readonly frame?: (call: FrameCall) => void | Promise<void>;
  /** Put the canvas on the screen. */
  readonly present: () => void;
  readonly after?: (call: FrameCall) => void;
}

/** Draw until `open` says stop or `frames` are drawn, and answer how many were. */
export async function runFrames(steps: FrameSteps): Promise<number> {
  const frames = steps.frames ?? Number.POSITIVE_INFINITY;
  let drawn = 0;
  while (steps.open() && drawn < frames) {
    steps.before?.(drawn);
    const now = steps.clock();
    steps.animationFrames(now);
    const errors = steps.errors();
    errors?.open();
    const waiting = steps.frame?.({ now, drawn });
    if (waiting !== undefined) {
      errors?.close();
      await waiting;
      continue;
    }
    /*
     * The microtask checkpoint, then the present. A macrotask is the one boundary Node guarantees
     * every microtask has run by, chained ones included. What it gives up: the device's and SDL's
     * callbacks may take a turn between the frame and the present, where a browser runs nothing
     * else. Both only queue work; neither draws.
     */
    await new Promise((resolve) => setImmediate(resolve));
    steps.present();
    errors?.close();
    steps.after?.({ now, drawn });
    drawn += 1;
    /* A task between frames, so SDL's events and the device's callbacks get their turn. */
    await new Promise((resolve) => setImmediate(resolve));
  }
  return drawn;
}
