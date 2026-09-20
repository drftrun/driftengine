/**
 * Running the world forward to see what it will need, then putting it back.
 *
 * **This is the part no competitor can copy, and the reason is not the code.** The state of the art
 * in texture streaming is reactive: the documentation for the most widely deployed implementation
 * says so in as many words — streaming is *reactive by nature*, because the processor cannot know a
 * tile is needed until after a frame has already needed it. Hence pop-in, and hence the further
 * limitation that passes which write no feedback can sample tiles they are unable to request.
 *
 * That is true only of an engine that cannot run its simulation forward and put it back. This one
 * can, and already does every frame for the netcode. So residency is decided by looking at where
 * the camera *will* be:
 *
 * ```text
 * every engine                    DriftEngine
 * ────────────                    ───────────
 * render frame N                  save the simulation
 * read the feedback buffer        advance it N frames, deterministic, no rendering
 *   ↓ two to three frames late    sample which tiles those views want
 * request the tiles               restore
 * pop-in                          prefetch → resident before it is ever visible
 * ```
 *
 * **The simulation is taken as a handle the caller supplies**, in the save/restore shape
 * `@driftengine/network`'s `Snapshotter` already uses, for two reasons: this package must not
 * import a simulation, and a consumer with their own loop has to be able to supply their own.
 *
 * **A misprediction costs a wasted fetch and nothing else.** The tile arrives late, exactly as it
 * would in a reactive engine — so the floor of this mechanism is everyone else's ceiling.
 */

/**
 * What prediction needs from a simulation.
 *
 * Save and restore rather than a snapshot value, matching `Snapshotter` in the network package:
 * the buffer is the handle's own and is reused, so predicting allocates nothing.
 */
export interface SimulationHandle {
  /** Capture the current state into the handle's own storage. */
  save(): void;
  /** Put back what `save` captured. */
  restore(): void;
  /** Advance one fixed step. Deterministic, and the same step the simulation really runs. */
  advance(dt: number): void;
  /** Write the current view matrix into `out`, sixteen floats. */
  viewAt(out: Float32Array): void;
}

/**
 * Fill `out` with one view matrix per predicted frame, and leave the simulation exactly as found.
 *
 * Returns how many views were written — fewer than `frames` when `out` cannot hold them all.
 *
 * **Saved once and restored once**, however many frames are predicted: the intermediate states are
 * not wanted, only the views they imply.
 */
export function predictViews(
  sim: SimulationHandle,
  frames: number,
  dt: number,
  out: Float32Array,
): number {
  const capacity = Math.floor(out.length / 16);
  const wanted = Math.min(frames, capacity);
  if (wanted <= 0) return 0;

  sim.save();
  for (let i = 0; i < wanted; i += 1) {
    sim.advance(dt);
    sim.viewAt(out.subarray(i * 16, i * 16 + 16));
  }
  sim.restore();
  return wanted;
}
