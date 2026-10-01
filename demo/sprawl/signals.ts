/**
 * The junctions' signals: two phases each, the streets running along z and then those along x,
 * each green for its class's time and then amber before the other axis goes.
 *
 * **One clock for every signal**, offset per junction by a hash of its index, so neighbouring
 * junctions do not all change together and the same junction changes at the same moment on every
 * run. What gives: no green wave down an avenue, which the reference's host may have had and its
 * scripts do not say.
 */

/** Seconds of amber and all-red before the other axis goes. Ours: the scripts give none. */
export const AMBER_SEC = 3;

export const GREEN = 0;
export const AMBER = 1;
export const RED = 2;

export interface Signals {
  readonly count: number;
  /** Two a signal: the green of the streets along z, then of those along x. */
  readonly green: Float32Array;
  /** Where in its cycle each signal starts, seconds. */
  readonly offset: Float32Array;
}

/** `count` signals with these greens, each offset into its cycle by its index's hash. */
export function createSignals(green: readonly number[]): Signals {
  const count = green.length / 2;
  const offset = new Float32Array(count);
  for (let s = 0; s < count; s++) {
    const cycle = (green[s * 2] as number) + (green[s * 2 + 1] as number) + 2 * AMBER_SEC;
    offset[s] = (hash(s) / 4294967296) * cycle;
  }
  return { count, green: Float32Array.from(green), offset };
}

/** What signal `s` shows the streets of `phase` at `t` seconds: `GREEN`, `AMBER` or `RED`. */
export function lightAt(signals: Signals, s: number, phase: number, t: number): number {
  const g0 = signals.green[s * 2] as number;
  const g1 = signals.green[s * 2 + 1] as number;
  const cycle = g0 + g1 + 2 * AMBER_SEC;
  let at = (t + (signals.offset[s] as number)) % cycle;
  if (phase === 1) at = (at - g0 - AMBER_SEC + cycle) % cycle;
  const green = phase === 0 ? g0 : g1;
  return at < green ? GREEN : at < green + AMBER_SEC ? AMBER : RED;
}

/** A 32-bit integer mix (lowbias32): an index to a well-spread unsigned value. */
function hash(i: number): number {
  let x = (i + 0x9e3779b9) >>> 0;
  x = Math.imul(x ^ (x >>> 16), 0x7feb352d) >>> 0;
  x = Math.imul(x ^ (x >>> 15), 0x846ca68b) >>> 0;
  return (x ^ (x >>> 16)) >>> 0;
}
