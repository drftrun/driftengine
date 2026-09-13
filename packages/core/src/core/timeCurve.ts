import { TAU, clamp } from '../math/scalar.ts';

/**
 * Re-timing a stretch of playback: how much *source* time one second of clip
 * time is worth.
 *
 * A curve is a reparameterisation, not an animation. It answers exactly one
 * question — "given `localSec` into this segment, how far has the source
 * advanced?" — which is what lets a caller drive a fixed-timestep simulation, a
 * recorded stream or a video from the same maths.
 *
 * **Every curve is speed-neutral over its own segment**: whatever it steals it
 * pays back, so `curveSpanSec` equals `durationSec` for every kind. That is the
 * property that keeps a re-timed clip the length it was asked for. A curve that
 * slowed time without catching up would quietly shorten the footage a fixed
 * clip length can cover, and the clip would stop before the thing it was cut
 * for.
 *
 * Pure, closed-form and allocation-free: evaluated once per rendered frame.
 */
export type TimeCurveKind = 'linear' | 'hold' | 'ramp' | 'stutter' | 'reverse';

export interface TimeCurve {
  readonly kind: TimeCurveKind;
  /** Length of the segment on the clip's own clock, seconds. */
  readonly durationSec: number;
  /**
   * How much of the segment the effect claims, 0–1.
   *
   * `hold`: the fraction frozen. `ramp`: the depth of the rate swing.
   * `stutter`: the frozen fraction of each step. `reverse`: the fraction run
   * backwards. Zero makes every kind behave as `linear`, which is the honest
   * neutral rather than a special case to branch on.
   */
  readonly amount: number;
  /** `stutter` only: one freeze-and-catch-up cycle, seconds. */
  readonly stepSec: number;
  /**
   * `reverse` only: how far back the *caller* can actually go, in source
   * seconds.
   *
   * Running a re-simulated stream backwards is impossible without keeping the
   * states to go back to, so the reversible window is a property of the
   * consumer's buffer and has to be supplied rather than assumed. A curve never
   * returns an offset below `-reversibleSec`; a consumer with no buffer passes
   * zero and gets no reversal at all.
   */
  readonly reversibleSec: number;
}

export interface TimeCurveOptions {
  readonly amount?: number;
  readonly stepSec?: number;
  readonly reversibleSec?: number;
}

/**
 * Ceiling on `amount`.
 *
 * Every kind pays its debt back by running the rest of the segment at
 * `1 / (1 - amount)`, so an amount at 1 asks for infinite speed in zero time.
 * Capped rather than merely documented: this is the kind of value a tuning pass
 * pushes to its limit.
 */
export const MAX_TIME_CURVE_AMOUNT = 0.9;

const LINEAR_STEP_SEC = 1;

/**
 * Build a curve, validating at construction.
 *
 * Fail-fast here rather than per-frame in `curveOffsetSec`: a curve is built
 * once when a clip is planned, and a plan is a fine place to throw.
 */
export function timeCurve(
  kind: TimeCurveKind,
  durationSec: number,
  options: TimeCurveOptions = {},
): TimeCurve {
  if (!Number.isFinite(durationSec) || durationSec <= 0) {
    throw new Error(`A time curve needs a positive duration, got ${durationSec}`);
  }
  const amount = clamp(options.amount ?? 0, 0, MAX_TIME_CURVE_AMOUNT);
  const requested = options.stepSec ?? LINEAR_STEP_SEC;
  if (!Number.isFinite(requested) || requested <= 0) {
    throw new Error(`A stutter step must be positive, got ${requested}`);
  }

  /*
   * Snap the stutter step so a whole number of cycles fits the segment. A
   * trailing part-cycle would leave the curve mid-freeze at its own end, which
   * breaks neutrality by exactly the frozen remainder — small, and therefore
   * the sort of drift that accumulates over a dozen shots without ever looking
   * like a bug.
   */
  const cycles = Math.max(1, Math.round(durationSec / requested));

  return {
    kind,
    durationSec,
    amount,
    stepSec: kind === 'stutter' ? durationSec / cycles : requested,
    reversibleSec: Math.max(0, options.reversibleSec ?? 0),
  };
}

/** A curve that does nothing, for a segment that is played straight. */
export function linearCurve(durationSec: number): TimeCurve {
  return timeCurve('linear', durationSec);
}

/**
 * Source seconds elapsed by `localSec` into the curve.
 *
 * Monotonically non-decreasing for every kind except `reverse`, continuous
 * everywhere, and clamped to the segment — outside it, the neighbouring
 * segments own the clock.
 */
export function curveOffsetSec(curve: TimeCurve, localSec: number): number {
  const duration = curve.durationSec;
  const local = clamp(localSec, 0, duration);
  const amount = curve.amount;
  if (amount === 0) return local;

  switch (curve.kind) {
    case 'linear':
      return local;

    case 'hold': {
      // Freeze on the cut, then run fast enough to arrive on time.
      const frozen = amount * duration;
      return local <= frozen ? 0 : (local - frozen) / (1 - amount);
    }

    case 'ramp': {
      /*
       * Slow, fast, slow — an "ease-in-out-in". The rate is
       * `1 - amount * cos(TAU * t / duration)`, whose integral closes the loop
       * exactly at the segment's end because a whole cosine period integrates
       * to zero. Chosen over a hand-tuned easing precisely for that: neutrality
       * is a consequence of the shape rather than something to correct for.
       */
      // determinism: build-time — presentation: remaps a cinematic's playback time, not a tick
      return local - ((amount * duration) / TAU) * Math.sin((TAU * local) / duration);
    }

    case 'stutter': {
      const step = curve.stepSec;
      const cycles = Math.floor(local / step);
      const into = local - cycles * step;
      const frozen = amount * step;
      const moving = into <= frozen ? 0 : (into - frozen) / (1 - amount);
      return cycles * step + moving;
    }

    case 'reverse': {
      // Only as far back as the caller kept states for. With no buffer this is
      // zero and the segment plays straight.
      const back = Math.min(amount * duration, curve.reversibleSec);
      if (back <= 0) return local;
      if (local <= back) return -local;
      // Then recover the ground given up *and* the segment itself.
      return -back + ((local - back) * (duration + back)) / (duration - back);
    }
  }
}

/**
 * Source seconds a whole segment consumes — `durationSec` for every kind, and
 * worth asking for rather than assuming: a caller composing segments needs the
 * answer the curve actually gives, not the one it promises.
 */
export function curveSpanSec(curve: TimeCurve): number {
  return curveOffsetSec(curve, curve.durationSec);
}
