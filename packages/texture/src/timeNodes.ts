/**
 * Time as a sampling argument, which is what makes an animated texture replay-exact.
 *
 * **`t` is the caller's, from the simulation's clock, and is never read from a platform.** Every
 * other engine's animated texture reads a wall clock, so replaying the same simulation shows
 * different texels — which matters for a rollback session, for a deterministic capture, and for
 * every automated visual comparison this repository runs.
 *
 * **Latent interpolation is why a long animation is nearly free.** A sixty-frame animation shares
 * one latent and moves only the time slice, so it costs a little more than one frame rather than
 * sixty times one.
 */

/** Which frame of a flipbook this time lands on. Never negative, never past the end. */
export function flipbookFrame(t: number, frames: number, fps: number, loop: boolean): number {
  if (frames <= 0) return 0;
  const raw = Math.floor(t * fps);
  if (loop) {
    /* Modulo that stays non-negative for negative time, which `%` alone does not. */
    return ((raw % frames) + frames) % frames;
  }
  return Math.min(frames - 1, Math.max(0, raw));
}

export interface LerpWeights {
  a: number;
  b: number;
  mix: number;
}

/**
 * The two keys surrounding this time, and how far between them it sits.
 *
 * At or past the end it lands on the last key with no mix, rather than wrapping — a caller that
 * wants looping says so by wrapping `t` before calling.
 */
export function latentLerpWeights(
  t: number,
  keyCount: number,
  duration: number,
  out: LerpWeights,
): void {
  if (keyCount <= 1 || duration <= 0) {
    out.a = 0;
    out.b = 0;
    out.mix = 0;
    return;
  }
  const spans = keyCount - 1;
  const position = Math.min(spans, Math.max(0, (t / duration) * spans));
  const index = Math.min(spans - 1, Math.floor(position));
  out.a = index;
  out.b = index + 1;
  out.mix = position - index;
  if (position >= spans) {
    out.a = spans - 1;
    out.b = spans;
    out.mix = 1;
  }
}
