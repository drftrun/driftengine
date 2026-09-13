/**
 * A held clock, as a script to inject into a page the harness does not own.
 *
 * **Why this exists next to `demo/dev/heldFrame.ts` rather than instead of it.** Two runs of one
 * build differ in zero pixels only if the frame being photographed is the same frame, and a
 * scene's state is a function of elapsed time: a load that stalls a few frames puts the camera
 * somewhere else. Measured while chasing a shading artefact, two captures taken at the same
 * wall-clock offset from one page differed in **736,190 pixels of 921,600**.
 *
 * The engine's own harness takes `?hold=N` and freezes itself, which is right for a person typing
 * a URL: they get a badge saying the clock has stopped, and a frame rate read off a held page is
 * otherwise a lie. **A consumer has no such hook and should not have to grow one.** Adding
 * a dev-only clock patch to a game's entry point puts harness code on the path to production and
 * makes the gate something each consumer implements. Injected before the page's own scripts run,
 * it needs no cooperation at all and works against a deployed build as readily as a dev server.
 *
 * So the two exist for different callers and the duplication is the price: this one is injected
 * from outside and stays silent, that one is asked for from inside and announces itself. If the
 * stepping ever changes, change both, and the fixed 1/60 below is the engine's own step rather
 * than a number chosen here.
 */

/** What a frame is worth, matching the engine's fixed simulation step. */
const STEP_MS = 1000 / 60;

/**
 * Source for `beforeLoad`, freezing the page after exactly `frames` steps.
 *
 * The shape is the same as the in-page version and each part of it is load-bearing. Callbacks are
 * queued rather than called through, because a scene that re-requests inside its own callback
 * would recurse to the stack limit. The pump is a task rather than a microtask, so fetch, worker
 * and decode callbacks get their turn: without that, a page that streams a model holds at zero
 * parts for ever and photographs an empty stage.
 */
export function heldClockScript(frames, { startWhen = 'true' } = {}) {
  const wanted = Math.max(1, Math.floor(frames));
  return `(() => {
  const realRaf = window.requestAnimationFrame.bind(window);
  const realNow = performance.now.bind(performance);
  let virtualMs = 0;
  let advanced = 0;
  let taken = false;
  let pending = [];

  /*
   * Nothing is taken over until the page says it is ready, and that is the part that makes this
   * work on a game rather than only on a scene that mounts synchronously.
   *
   * Measured on one: holding from page load left two runs of one build differing in 12,023 pixels
   * of 921,600, because the clock advances a frame per turn of the task queue whether or not the
   * load has finished, so the number of frames the game had actually drawn by frame N depended on
   * when a worker and an audio decode happened to resolve. Counting from a stated state instead
   * makes the frame that gets photographed the same frame.
   */
  const ready = () => { try { return Boolean(${startWhen}); } catch (error) { return false; } };

  const take = () => {
    taken = true;
    /* Continue from the real clock rather than from zero: a page that has already read the time
       and stored an origin would otherwise see it run backwards. */
    virtualMs = realNow();
    performance.now = () => virtualMs;
    window.requestAnimationFrame = (callback) => { pending.push(callback); return pending.length; };
    window.cancelAnimationFrame = () => {};
    const pump = () => {
      const due = pending;
      pending = [];
      /*
       * The clock moves for a frame that is actually drawn, and not for a turn of the task queue
       * that happens to find nothing waiting.
       *
       * Measured on a game whose load is asynchronous: advancing per turn left two runs of one
       * build differing in 895 pixels, because the turns that elapse while a worker and an audio
       * decode resolve are real turns and there are a different number of them each time. Tying
       * the step to a callback makes the page see exactly N frames of 1/60 however long its load
       * took. The cost is that a page which stops asking for frames stops the clock, which is
       * correct here and is why a caller states what to wait for.
       */
      if (due.length > 0 && advanced < ${wanted}) { virtualMs += ${STEP_MS}; advanced++; }
      for (const callback of due) callback(virtualMs);
      /* A task rather than a microtask, so fetch, worker and decode callbacks get their turn. */
      setTimeout(pump, 0);
    };
    setTimeout(pump, 0);
  };

  const watch = () => {
    if (ready()) take();
    else realRaf(watch);
  };
  realRaf(watch);

  /* What a caller waits on, since there is no badge to look for when nobody is looking. */
  Object.defineProperty(window, '__heldFrame', {
    get: () => (taken && advanced >= ${wanted} ? advanced : 0),
  });
})();`;
}
