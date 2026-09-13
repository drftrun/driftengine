import { TRAMPLE_SLOTS } from './trample.ts';

/**
 * How wind and footfall deform a scatter batch, decided once for both backends.
 *
 * **Every number here is a conversion, and a copy of one would drift.** The vertex stage is
 * handed metres of bend rather than metres per second, a time already scaled, and a wind
 * direction already normalised — so the same gust has to arrive at both backends through the
 * same arithmetic or a field of grass leans differently depending on which one is drawing it.
 * That is the 2026-08-13 rule in `AGENTS.md`: the decision is neutral, the binding is not.
 */

/** How far a press reaches, and how far down it pushes. */
const TRAMPLE_RADIUS_M = 1.1;
const TRAMPLE_DEPTH = 0.8;

/**
 * Zeroed presses, for a batch nothing walks through.
 *
 * Bound rather than skipped: a uniform array still holding the last batch's presses would
 * flatten the *next* one, and the grit from a drift is drawn through this same path — which
 * would have made a slide comb grass it was nowhere near.
 */
const EMPTY_TRAMPLE = new Float32Array(TRAMPLE_SLOTS * 4);

/** What the scatter vertex stage reads, after every conversion has been applied. */
export interface ScatterDeform {
  /** Unit wind direction, or zero when there is no wind to have a direction. */
  readonly direction: Float32Array;
  /** **Metres of bend, not metres per second.** A blade at the wind's own speed lies flat. */
  bend: number;
  gust: number;
  time: number;
  readonly spatialPhase: Float32Array;
  trample: Float32Array;
  trampleRadius: number;
  trampleDepth: number;
}

/** Allocate one per binder, refilled per call: both callers are per-frame paths. */
export function createScatterDeform(): ScatterDeform {
  return {
    direction: new Float32Array(2),
    bend: 0,
    gust: 0,
    time: 0,
    spatialPhase: new Float32Array([0.18, 0.13]),
    trample: EMPTY_TRAMPLE,
    trampleRadius: TRAMPLE_RADIUS_M,
    trampleDepth: TRAMPLE_DEPTH,
  };
}

/** Convert a gust into what the shader wants, into a target the caller owns. */
export function resolveScatterDeform(
  windX: number,
  windZ: number,
  windGust: number,
  timeSeconds: number,
  trample: Float32Array | null,
  out: ScatterDeform,
): ScatterDeform {
  const speed = Math.hypot(windX, windZ);
  const invSpeed = speed > 1e-5 ? 1 / speed : 0;
  out.direction[0] = windX * invSpeed;
  out.direction[1] = windZ * invSpeed;
  out.bend = speed * 0.045;
  out.gust = windGust * 0.06;
  out.time = timeSeconds * 1.6;
  out.trample = trample ?? EMPTY_TRAMPLE;
  return out;
}
