import { framesHeld } from './bootGate.ts';

/**
 * Fixed-timestep game loop with render interpolation.
 *
 * Simulation always advances in `fixedDt` increments (determinism requirement,
 * see AGENTS.md); rendering runs once per animation frame and receives the
 * interpolation factor `alpha` in [0, 1) between the two most recent sim states.
 */
export interface LoopHooks {
  /**
   * Advance the simulation by exactly `dt` seconds.
   *
   * `tick` counts fixed steps from `LoopOptions.startTick`, and it is the identity every
   * networked and recorded thing indexes by: an input belongs to a tick, a snapshot is of a tick,
   * a desync begins at a tick. `AGENTS.md` already states the contract it makes concrete — "time
   * is a tick count the caller supplies" — and the loop was the one place that knew the count and
   * did not hand it over, so a caller wanting one kept a second counter beside this callback and
   * hoped the two agreed.
   *
   * A caller with no use for it takes one argument and is unaffected.
   */
  simulate(dt: number, tick: number): void;
  /**
   * Draw one frame. `alpha` interpolates prev→current sim state.
   *
   * `frameDt` is clamped by `maxFrameTime` and is the one to animate against:
   * a stall must not advance the wind by a minute when the page comes back.
   *
   * `wallDt` is the same gap with nothing done to it, and it exists for the
   * diagnostics. A clamped delta cannot tell a device that took a quarter second
   * from a browser that waited a second before asking — both arrive as 0.25 —
   * and three bug reports were filed on that ambiguity before anyone could see it.
   * Nothing that animates should read it.
   */
  /**
   * @param frame What the frame source delivered, when it delivers anything.
   *
   * `undefined` under the window, which is every frame outside a session. An immersive session
   * hands over the object every pose in that frame is read from, and it is valid only for the
   * duration of this call. Typed `unknown` because core does not name an `XRFrame`; the package
   * that does narrows it. An implementation written before this parameter existed still satisfies
   * the interface, which is why it was added at the end rather than anywhere more readable.
   */
  render(alpha: number, frameDt: number, wallDt: number, frame?: unknown): void;
  /**
   * Whether the simulation should advance this frame. Absent means always.
   *
   * Pause is expressed here rather than by stopping the loop, so a paused game
   * keeps rendering — the world stays on screen behind the menu instead of
   * freezing on whatever the last frame happened to be.
   */
  shouldSimulate?: () => boolean;
  /**
   * Whether this frame is worth drawing at all. Absent means always.
   *
   * For the clip export, and it is not an optimisation. A clip is a fixed 60
   * frames a second; a display running at 144 offers 2.4 animation frames per
   * clip frame, and the recorder can only take one of them — so the other 1.4
   * are a full render of a 1080x1920 frame that is thrown away, competing for the
   * GPU with the one that is kept. Worse, on a 100 Hz display no frame lands
   * near enough to every slot and the capture rate falls to 50: the file then
   * claims 60 fps while holding 50, which is precisely the stutter this exists to
   * remove.
   *
   * Skipped time is not lost — it is added to the `frameDt` the next drawn frame
   * receives, so anything smoothing against it sees real elapsed time.
   *
   * **The 60 above is the example and not a limit**, which is worth saying because every sentence
   * of it names one. This hook is a predicate the caller supplies, so the rate is whatever the
   * caller returns true at, and `FramePacer` takes the rate it paces to as a constructor argument:
   * `new FramePacer(30)` is a thirty-a-second export and needs nothing here. A consumer capturing
   * at 60 and dropping every other frame is paying a full render per discarded frame for a rate the
   * pacer would have given them.
   */
  shouldRender?: () => boolean;
}

export interface LoopOptions {
  fixedDt?: number;
  /** Clamp for pathological frames (tab switch, debugger) to avoid a sim spiral. */
  maxFrameTime?: number;
  /**
   * The tick number the first fixed step reports. Zero unless a caller says otherwise.
   *
   * A participant joining a session in progress is told the host's tick and has to agree with it,
   * because every input and every snapshot is addressed by that number. Starting at zero and
   * adding an offset at each use is the same arithmetic done in more places, and one of them
   * eventually forgets.
   */
  startTick?: number;
  /**
   * Who asks for the next frame, and what that frame carries.
   *
   * **The window, unless a session is driving.** An immersive session produces frames on the
   * headset's clock through `session.requestAnimationFrame`, at whatever rate its display runs, and
   * the callback carries the frame object every pose in that frame is read from. A loop calling the
   * window's `requestAnimationFrame` inside a session draws at the page's rate into a display that
   * wanted something else, which is the difference between presence and motion sickness.
   *
   * Optional and defaulting to the window, so no existing caller changes.
   *
   * `frame` is `unknown` deliberately. This file is `@driftengine/core`'s clock and has no business
   * naming an `XRFrame`, which lives in a package core does not depend on; `@driftengine/xr`
   * narrows it at the one place that reads it. What core owns is that *something* arrived with the
   * frame and is handed to `render` unread.
   */
  frameSource?: FrameSource;
}

/**
 * A source of animation frames. `window` satisfies it, and so does an `XRSession`.
 *
 * Structural rather than a class, because both of the things that satisfy it are somebody else's:
 * one is the browser's and one is a runtime's.
 */
export interface FrameSource {
  requestAnimationFrame(callback: (timeMs: number, frame?: unknown) => void): number;
  cancelAnimationFrame(handle: number): void;
}

/** Starts the loop immediately. Returns a stop function. */
export function startLoop(hooks: LoopHooks, options: LoopOptions = {}): () => void {
  const fixedDt = options.fixedDt ?? 1 / 60;
  const maxFrameTime = options.maxFrameTime ?? 0.25;

  let last = performance.now();
  let accumulator = 0;
  /**
   * Fixed steps taken, offset by `startTick`.
   *
   * **It counts steps and not frames, and it never moves while paused.** A tick is a unit of
   * simulation, so a paused game that keeps rendering is at the same tick for as long as the menu
   * is open — which is what makes the number usable as an index into a recording.
   */
  let tick = Math.trunc(options.startTick ?? 0);
  let rafId = 0;
  /** Frame time banked by animation frames that were not drawn. */
  let undrawnDt = 0;
  /** The same bank, unclamped. See `LoopHooks.render`. */
  let undrawnWallDt = 0;

  /*
   * Read once and held. A session that ends mid-loop is a consumer stopping this loop and starting
   * another, because the two run at different rates and share no accumulator worth carrying across.
   */
  const source: FrameSource = options.frameSource ?? {
    requestAnimationFrame: (callback) => requestAnimationFrame(callback),
    cancelAnimationFrame: (handle) => {
      cancelAnimationFrame(handle);
    },
  };

  const frame = (now: number, xrFrame?: unknown): void => {
    rafId = source.requestAnimationFrame(frame);

    /*
     * **Held: draw nothing, advance nothing, and bank nothing.**
     *
     * The engine badge holds the screen for a few seconds after the first frame reaches it, and
     * a game left running behind an opaque plate is a game whose opening seconds nobody sees —
     * an intro that plays to a black rectangle, a cue that is already three seconds in when the
     * plate lifts. Freezing on the drawn frame is what makes the badge a hold rather than a
     * theft.
     *
     * `last` moves with the clock so the wait is not banked. Without that line every held frame
     * accumulates, and the resume replays the whole hold in one step: the same failure the pause
     * above drops its accumulator for, arrived at from a different direction.
     */
    if (framesHeld()) {
      last = now;
      accumulator = 0;
      return;
    }

    let frameDt = (now - last) / 1000;
    last = now;
    const wallDt = frameDt;
    if (frameDt > maxFrameTime) frameDt = maxFrameTime;

    accumulator += frameDt;

    // Paused: drop the banked time rather than keeping it. Holding it would
    // replay the whole pause in one resume frame, and every one of those ticks
    // would land in a run timer that M4 turns into a leaderboard entry.
    if (hooks.shouldSimulate !== undefined && !hooks.shouldSimulate()) {
      accumulator = 0;
    } else {
      while (accumulator >= fixedDt) {
        hooks.simulate(fixedDt, tick);
        tick += 1;
        accumulator -= fixedDt;
      }
    }

    if (hooks.shouldRender !== undefined && !hooks.shouldRender()) {
      undrawnDt += frameDt;
      undrawnWallDt += wallDt;
      return;
    }
    /* Handed on unread. See `LoopOptions.frameSource` for why core does not look inside it. */
    hooks.render(accumulator / fixedDt, frameDt + undrawnDt, wallDt + undrawnWallDt, xrFrame);
    undrawnDt = 0;
    undrawnWallDt = 0;
  };

  rafId = source.requestAnimationFrame(frame);
  return () => {
    source.cancelAnimationFrame(rafId);
  };
}
