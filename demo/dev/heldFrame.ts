/**
 * One virtual clock over `requestAnimationFrame` and `performance.now`, so two runs of one
 * build produce the same pixels.
 *
 * **Without this, nothing visual can be compared.** A scene's state is a function of elapsed
 * time, and elapsed time is a function of how the machine felt: a load that stalls a few frames
 * puts the camera somewhere else, and the two screenshots differ everywhere. That is not a
 * subtle problem. Measured while chasing a shading artefact, two captures taken at the same
 * wall-clock offset from the same page differed in **736,190 pixels of 921,600** — the whole
 * frame — because the automatic camera had advanced a different number of steps. A before and
 * after taken like that says nothing at all, and reads exactly like evidence.
 *
 * So: every frame advances the clock by exactly 1/60, whatever it cost in real time, for a
 * stated number of frames. After that the clock stops and the scene redraws the same state for
 * ever, which is what makes a screenshot repeatable and a difference meaningful.
 *
 * **It yields to the event loop between frames rather than spinning**, which is the part that
 * makes it usable on a scene that fetches. A model arrives over the network through callbacks
 * that only run when the task queue does, so a loop that drove frames synchronously would hold
 * a scene at zero parts for ever. The cost is that the hold takes real seconds to reach; the
 * benefit is that it works on the one scene that most needs looking at.
 *
 * Nothing here is engine API and nothing under `src/` may import it. It is a harness
 * instrument, in the harness, reached with `?hold=N`.
 */

/** What a frame is worth, matching the engine's own fixed step. */
const STEP_MS = 1000 / 60;

/**
 * Take over the clock and drive exactly `frames` steps, then freeze.
 *
 * Call before a scene mounts. Returns nothing to undo it: a page that has held its clock is a
 * page in a measuring state, and handing back a way to resume halfway would make the state it
 * is in depend on who called what.
 */
/**
 * Whether the clock has been let go. See `releaseHeldClock`.
 *
 * Module state rather than a returned handle, because the caller that patches the clock and
 * the caller that finishes mounting are the same file and threading a token between them
 * would only make the ordering easier to get wrong.
 */
let released = false;

/**
 * Start advancing the held clock, once the scene that will be measured exists.
 *
 * **Mounting became asynchronous and the clock did not notice.** The pump used to begin the
 * moment the page loaded, so a scene that awaited an adapter before it could draw simply
 * missed the frames that elapsed while it waited — and `dayClock` runs a ninety-second day,
 * so a handful of missed frames is minutes of sky. The two backends were then photographed
 * at different times and diffed against each other: WebGPU came out anywhere between 10:10
 * and 10:17 while WebGL2 sat at 10:21, and the difference read as a rendering fault.
 *
 * Safe to call when nothing is held: it does nothing, which is the normal case.
 */
export function releaseHeldClock(): void {
  released = true;
}

export function holdFrames(frames: number): void {
  const wanted = Math.max(1, Math.floor(frames));
  let virtualMs = 0;
  let advanced = 0;
  released = false;
  /*
   * Queued rather than called: `requestAnimationFrame` promises the callback runs later, and a
   * scene that re-requests inside its own callback would recurse to the stack limit if this
   * called straight through.
   */
  let pending: FrameRequestCallback[] = [];

  performance.now = (): number => virtualMs;
  window.requestAnimationFrame = (callback: FrameRequestCallback): number => {
    pending.push(callback);
    return pending.length;
  };
  /* Nothing to cancel: a queued callback is drained on the next pump either way, and a scene
     that cancels and re-requests in one frame would otherwise lose the frame entirely. */
  window.cancelAnimationFrame = (): void => {};

  const pump = (): void => {
    /*
     * Nothing moves until the scene is mounted. Draining callbacks here would be harmless;
     * advancing the clock would not, because the frames would be spent on a page with
     * nothing in it and the scene would reach the hold having simulated fewer of them.
     */
    if (!released) {
      setTimeout(pump, 0);
      return;
    }
    const due = pending;
    pending = [];
    if (advanced < wanted) {
      virtualMs += STEP_MS;
      advanced++;
      /*
       * Announced only once the count is *reached*, and that is a bug fix rather than a
       * refinement. The badge below is added the moment the hold is asked for, and the capture
       * harness read it as "the hold is done" — so a screenshot was taken 2.5 seconds later at
       * whatever frame the pump had got to. The pump yields to the task queue between frames,
       * around 250 a second, so anything under roughly six hundred frames finished inside that
       * window and everything above it did not. Measured: at `hold=2250` the two backends
       * photographed 11:20 and 11:23 of `dayClock`'s day and the diff was read as a rendering
       * difference. `heldClock.mjs` already signalled this way; now both do.
       */
      if (advanced === wanted) {
        (window as unknown as { __heldFrame?: number }).__heldFrame = wanted;
        badge.textContent = `held at frame ${wanted}`;
      }
    }
    for (const callback of due) callback(virtualMs);
    /* A task rather than a microtask, so fetch, worker and decode callbacks get their turn. */
    setTimeout(pump, 0);
  };
  /*
   * Say so, and keep saying so. A held page looks like a running one, and somebody reading a
   * frame rate off a scene whose clock has stopped would be reading the number of steps this
   * chose rather than anything the machine did.
   */
  const badge = document.createElement('div');
  /* Until the count is reached this says what is happening, not what has happened. */
  badge.textContent = `holding for ${wanted} frames`;
  badge.style.cssText =
    'position:fixed;top:8px;right:8px;z-index:99;padding:4px 8px;border:1px solid #0f0;' +
    'color:#0f0;background:#000;font:12px monospace';
  document.body.append(badge);
  setTimeout(pump, 0);
}

/** `?hold=N`, or nothing at all. Absent is the normal case and costs nothing. */
export function askedHeldFrames(): number | undefined {
  const asked = new URLSearchParams(location.search).get('hold');
  if (asked === null || asked === '') return undefined;
  const frames = Number(asked);
  if (Number.isFinite(frames) && frames >= 1) return frames;
  console.warn(`hold=${asked} is not a number of frames. Try hold=600.`);
  return undefined;
}
