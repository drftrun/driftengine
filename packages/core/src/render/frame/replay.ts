import type { ScheduledPass } from './schedule.ts';

/**
 * The nodes a schedule kept, in the order they are to be replayed.
 *
 * **Separate from the executor because it is the part with an answer to check.** A pass the
 * scheduler dropped writes something nothing reads, and replaying its nodes anyway is what made
 * every capture in the verb migration unable to fail — but no real frame drops a pass today, so
 * the behaviour has nowhere to be observed from inside a renderer test. Here it has.
 *
 * Order inside a pass is the caller's order and is never changed, for the reason `schedule`
 * gives: blending and depth make *after* different from *before*.
 *
 * Allocates nothing. `out` is the caller's, sized with the arena, and the return value says how
 * many of its entries were filled.
 */
export function keptNodes(passes: ScheduledPass[], count: number, out: Int32Array): number {
  let at = 0;
  for (let i = 0; i < count; i += 1) {
    const pass = passes[i];
    if (pass === undefined) break;
    const end = pass.first + pass.count;
    for (let node = pass.first; node < end && at < out.length; node += 1) {
      out[at] = node;
      at += 1;
    }
  }
  return at;
}

/**
 * A scratch array big enough for `needed` nodes, reusing the one given where it already fits.
 *
 * **`keptNodes` says the caller's array is "sized with the arena", and this is what makes that
 * true.** It was not: the renderer sized its scratch with `MAX_DRAWS_PER_FRAME` while the arena
 * it reads reallocates at twice its capacity whenever a frame outgrows it. `keptNodes` then
 * stopped at `out.length` and the tail of the frame's passes was never replayed — no warning, no
 * error, and a plausible picture missing whatever those passes drew.
 *
 * It was reachable with the draw ring nowhere near full, because a node is recorded per **verb**
 * rather than per draw: overlays, scatter, plumes and text each record one.
 *
 * **What it costs** is a single allocation on the frame that first outgrows the scratch and none
 * afterwards, because the caller keeps what comes back. **What would make it wrong** is a caller
 * that discards the result and calls this again per frame, which is an allocation in a hot path;
 * the arena's own doubling is what keeps the growth finite rather than per-frame.
 */
export function scratchFor(scratch: Int32Array, needed: number): Int32Array {
  return scratch.length >= needed ? scratch : new Int32Array(needed);
}
