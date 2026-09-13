/**
 * Secondary motion: hair, a coat, an antenna, a chain, reacting to what the subject is doing.
 *
 * **A pure function of the time it is asked about, which is the whole reason this is not a
 * ragdoll.** The consumer who asked for it refused ragdoll in writing and gave the reason: a
 * ragdoll integrates state, so it cannot answer *what is the pose at time t* for a `t` reached by
 * dragging a playhead backwards. Their preview reads one sampler against an audio clock and their
 * export reads the same one against a frame index; anything that accumulates makes those two
 * disagree, and makes two exports of one project differ.
 *
 * **What makes a pure version possible is that a damped spring forgets.** The influence of the
 * anchor at time τ on the mass at time t decays as `e^(-ζω(t-τ))`, so past some settle time it
 * is below any tolerance worth naming. Evaluating at `t` is therefore: start at rest a settle time
 * earlier, march forward, return. Bounded work, no history, and the same answer whichever way the
 * caller scrubs.
 *
 * **What that costs is arithmetic per sample rather than per frame**, and it is the trade the
 * request asks for. A spring at 2 Hz and 0.35 damping settles in about 1.7 s, which at this
 * module's substep is a few dozen steps of a 2x2 multiply — microseconds, paid whether the caller
 * is playing forward or dragging backwards, which is the point.
 *
 * **Nothing here reads a clock**, allocates after module load, or holds state between calls, which
 * is `clip.ts`'s contract and the reason this belongs beside it rather than in physics.
 */

/** Three floats, as everything in this package passes positions. */
type Vec3Out = Float32Array;

/** Where the mass is being pulled, as a pure function of time. Writes three floats into `out`. */
export type SpringAnchor = (timeSec: number, out: Vec3Out) => void;

export interface SpringSettings {
  /**
   * How fast the spring wants to oscillate, in hertz.
   *
   * This is the *undamped* natural frequency: the rate it would ring at with no damping at all.
   * Hair is a few hertz; a heavy coat is under one.
   */
  readonly frequencyHz: number;
  /**
   * The damping ratio. Below 1 overshoots and rings, 1 is critical and never overshoots, above 1
   * sags in without reaching. **Zero is refused** — see `springSettleSec`.
   */
  readonly damping: number;
  /**
   * How far the mass may fall behind its anchor, in metres. Absent means no limit.
   *
   * A limit rather than a stiffness change, because the two are different requests: stiffening
   * changes how the whole motion reads, and this is for the one frame in a plan where a whip pan
   * would otherwise leave a braid behind in the air.
   */
  readonly maxOffsetM?: number;
}

/**
 * One link of a chain: a spring, plus where it sits relative to the link above it at rest.
 *
 * **The offset is what makes a chain hang rather than collapse.** Without it every link would be
 * pulled to the same point and a braid would be a single mass with extra arithmetic.
 */
export interface SpringLink extends SpringSettings {
  /** Where this link rests relative to the one above it, in metres. */
  readonly restOffsetM: readonly [number, number, number];
}

/**
 * How long until the spring's memory of an input is negligible.
 *
 * **This is the lookback, and it is derived rather than dialled.** The envelope of a damped
 * oscillator decays as `e^(-ζωt)`, so reaching a factor `EPSILON` takes `-ln(EPSILON) / (ζω)`.
 * Everything older than that contributes less than a thousandth of the anchor's own motion, which
 * is well under a pixel on anything this drives.
 *
 * **Damping of zero has no answer here and is refused at the sampler.** An undamped spring rings
 * forever, so no lookback is long enough and there is no honest value to return — the whole
 * argument for sampling this purely is the decay, and at ζ = 0 there is none.
 */
export function springSettleSec(settings: SpringSettings): number {
  const omega = 2 * Math.PI * settings.frequencyHz;
  return -Math.log(EPSILON) / (settings.damping * omega);
}

/**
 * The same, for a chain, which remembers longer than any of its links.
 *
 * **A cascade does not forget at its slowest link's rate.** A disturbance entering the top has to
 * travel down before it can die out, so the composite response carries a polynomial in `t`
 * alongside the exponential and the settle time grows with depth. Taking one link's lookback for
 * four would leave the sampler carrying a start transient into its answer, which is exactly the
 * defect the purity test exists to catch.
 *
 * The bound is the survival function of the cascade — `e^(-x) Σ x^k/k!` for `k` under the link
 * count, with `x = σt` — solved for `EPSILON`. **`σ` is the slowest link and the depth is taken as
 * a full multiplicity**, which is the worst case: links that differ have distinct poles and settle
 * sooner than this says. Erring long costs substeps; erring short costs correctness.
 */
export function springChainSettleSec(links: readonly SpringLink[]): number {
  if (links.length === 0) return 0;

  let slowest = Infinity;
  for (const link of links) {
    validateSettings(link);
    slowest = Math.min(slowest, link.damping * 2 * Math.PI * link.frequencyHz);
  }

  /* Bracket by doubling rather than by a guessed constant: the root grows with depth, and a
     bracket that is too tight would silently return its own upper bound. */
  let high = -Math.log(EPSILON) + links.length;
  while (cascadeSurvival(high, links.length) > EPSILON) high *= 2;

  let low = 0;
  /* A fixed count rather than a tolerance, so the answer is the same on every machine. Sixty-four
     halvings take the bracket below what a double can represent. */
  for (let n = 0; n < 64; n += 1) {
    const middle = (low + high) / 2;
    if (cascadeSurvival(middle, links.length) > EPSILON) low = middle;
    else high = middle;
  }
  return high / slowest;
}

/**
 * `e^(-x) Σ x^k/k!` for `k` below `count`: how much of a disturbance a cascade still holds.
 *
 * Built up from `e^(-x)` and multiplied down rather than summing `x^k/k!` and scaling at the end,
 * because every term of this form is at most 1 while `x^k` alone overflows for a deep chain.
 */
function cascadeSurvival(x: number, count: number): number {
  let term = Math.exp(-x);
  let sum = term;
  for (let k = 1; k < count; k += 1) {
    term *= x / k;
    sum += term;
  }
  return sum;
}

/** A thousandth of the anchor's own motion: below a pixel on anything a spring drives. */
const EPSILON = 1e-3;

/**
 * Substeps per oscillation period.
 *
 * **Measured against the reference march in the tests, and the measurement is why the integrator
 * below is the one it is.** The first attempt stepped the equation with semi-implicit Euler, whose
 * error goes as the step: against a four-thousand-step march from the beginning of time it missed
 * by 0.058 at thirty-two steps a period, 0.029 at sixty-four and 0.0075 at two hundred and
 * fifty-six — a clean halving, which is first order, and which said the *integrator* carried the
 * error and not the lookback. Holding a hundredth needed about a thousand steps a period, three
 * thousand per joint per frame, which is not a number worth paying for hair.
 *
 * Solving each substep in closed form instead leaves only the anchor's own sampling, and that error
 * goes as the step squared: **1.7e-2, 4.1e-3, 1.2e-3 and 4.0e-4 at four, eight, sixteen and
 * thirty-two**, a quarter per doubling, flooring at 2.3e-4 — which is the reference's own error and
 * not this one's.
 *
 * **Thirty-two, for the anchor rather than for the spring.** Sixteen already holds the assertion.
 * What thirty-two buys is the rate the anchor is read at, which is this number times the spring's
 * frequency: 64 Hz for a 2 Hz spring, comfortably above what a plan at 24 or 30 fps carries, where
 * sixteen would sit right on it. Ninety-odd steps of a four-multiply 2x2.
 */
const STEPS_PER_PERIOD = 32;

/**
 * How close to `1` counts as critically damped.
 *
 * Below it the ringing and sagging forms both divide by a frequency that has gone to zero. The
 * band is far narrower than any setting a person types, and the closed form is continuous across
 * it, so which side a value lands on is not visible in the motion.
 */
const CRITICAL_BAND = 1e-12;

/**
 * Scratch, allocated once: this is called per joint per frame and may not allocate.
 *
 * The anchor pair is `Float32Array` because that is what a `SpringAnchor` writes, and the state is
 * double because it is carried across every substep while the anchor is only read.
 */
const ANCHOR = new Float32Array(3);
const PREVIOUS = new Float32Array(3);
const POSITION = new Float64Array(3);
const VELOCITY = new Float64Array(3);
/** Four transition coefficients, which for a single spring is one link's worth. */
const COEFFICIENTS = new Float64Array(4);

/**
 * Where the mass sits at `timeSec`, given where its anchor has been.
 *
 * `anchorAt` is called many times per sample, at times before `timeSec`, and must be a pure
 * function of the time it is handed — the same contract `sampleClip` holds. An anchor that reads a
 * clock, or that answers differently on a second call for one time, breaks the property this
 * module exists to provide and does so silently.
 */
export function sampleSpring(
  settings: SpringSettings,
  anchorAt: SpringAnchor,
  timeSec: number,
  out: Vec3Out,
): void {
  validateSettings(settings);

  const lookback = springSettleSec(settings);
  const start = timeSec - lookback;

  /*
   * **At rest on the anchor rather than at the origin.** A spring started at zero would spend its
   * first settle time flying in from wherever the scene's origin happens to be, and since the
   * lookback ends exactly where the caller asked, that transient would arrive in the answer. The
   * anchor's own position is the only rest state that is right for every scene.
   */
  anchorAt(start, PREVIOUS);
  POSITION[0] = PREVIOUS[0]!;
  POSITION[1] = PREVIOUS[1]!;
  POSITION[2] = PREVIOUS[2]!;
  VELOCITY[0] = 0;
  VELOCITY[1] = 0;
  VELOCITY[2] = 0;

  const steps = Math.max(1, Math.ceil(lookback * settings.frequencyHz * STEPS_PER_PERIOD));
  const step = lookback / steps;
  const trail = trailPerUnitSpeed(settings);
  transitionOver(settings, step, COEFFICIENTS, 0);

  for (let n = 1; n <= steps; n += 1) {
    anchorAt(start + n * step, ANCHOR);
    for (let axis = 0; axis < 3; axis += 1) {
      advance(
        COEFFICIENTS,
        0,
        trail,
        step,
        POSITION,
        VELOCITY,
        axis,
        PREVIOUS[axis]!,
        ANCHOR[axis]!,
      );
      PREVIOUS[axis] = ANCHOR[axis]!;
    }
  }

  anchorAt(timeSec, ANCHOR);
  writeClamped(settings.maxOffsetM, POSITION, 0, ANCHOR[0]!, ANCHOR[1]!, ANCHOR[2]!, out, 0);
}

/**
 * Where every link of a chain sits at `timeSec`. Writes three floats per link into `out`.
 *
 * **The whole chain is marched on one grid rather than each link on its own**, and that is not an
 * optimisation. Link `n`'s anchor is link `n-1`'s *sprung* position, so sampling a link
 * independently would need its parent at every substep, which would need the grandparent at every
 * substep of every one of those: a depth-`d` chain would cost `steps^d` anchor calls. Marched
 * together it is `steps × d`, and it is the same answer.
 */
export function sampleSpringChain(
  links: readonly SpringLink[],
  rootAt: SpringAnchor,
  timeSec: number,
  out: Float32Array,
): void {
  const count = links.length;
  if (count === 0) return;
  if (out.length < 3 * count) {
    throw new Error(
      `spring chain: out holds ${out.length} floats and this chain needs ${3 * count}, ` +
        `three per link for ${count} links.`,
    );
  }

  /* Validates every link on the way, so a bad setting is refused before any marching. */
  const lookback = springChainSettleSec(links);
  const start = timeSec - lookback;
  reserve(count);

  /*
   * **The substep resolves the fastest link, and the lookback the slowest.** A chain mixing the
   * two is expensive by exactly as much as it is asking for: a 9 Hz link needs a fine step, a 1 Hz
   * link at a tenth damping needs a long memory, and a chain with both needs both.
   */
  let fastest = 0;
  for (const link of links) fastest = Math.max(fastest, link.frequencyHz);
  const steps = Math.max(1, Math.ceil(lookback * fastest * STEPS_PER_PERIOD));
  const step = lookback / steps;

  for (let i = 0; i < count; i += 1) {
    transitionOver(links[i]!, step, chainCoefficients, 4 * i);
    chainTrail[i] = trailPerUnitSpeed(links[i]!);
  }

  /* At rest, hanging: each link starts on its own rest offset below the one above it. */
  rootAt(start, PREVIOUS);
  for (let i = 0; i < count; i += 1) {
    const rest = links[i]!.restOffsetM;
    for (let axis = 0; axis < 3; axis += 1) {
      const above = i === 0 ? PREVIOUS[axis]! : chainPosition[3 * (i - 1) + axis]!;
      chainPosition[3 * i + axis] = above + rest[axis]!;
      chainVelocity[3 * i + axis] = 0;
    }
  }

  for (let n = 1; n <= steps; n += 1) {
    rootAt(start + n * step, ANCHOR);
    for (let axis = 0; axis < 3; axis += 1) {
      /*
       * Swept from the root down, carrying the link above's two positions — where it was when the
       * substep began and where it ended up. Both are needed because the closed form below solves
       * a step of an anchor that is *moving*, and the link above is the anchor.
       */
      let abovePrevious = PREVIOUS[axis]!;
      let aboveNow = ANCHOR[axis]!;
      for (let i = 0; i < count; i += 1) {
        const at = 3 * i + axis;
        const rest = links[i]!.restOffsetM[axis]!;
        const mine = chainPosition[at]!;
        advance(
          chainCoefficients,
          4 * i,
          chainTrail[i]!,
          step,
          chainPosition,
          chainVelocity,
          at,
          abovePrevious + rest,
          aboveNow + rest,
        );
        abovePrevious = mine;
        aboveNow = chainPosition[at]!;
      }
      PREVIOUS[axis] = ANCHOR[axis]!;
    }
  }

  /*
   * The clamp walks the finished chain rather than riding along inside it, for the reason
   * `writeClamped` gives — and down the *clamped* positions, so a link held back brings the ones
   * below it along instead of leaving them stretched away from a parent that moved.
   */
  rootAt(timeSec, ANCHOR);
  let aboveX = ANCHOR[0]!;
  let aboveY = ANCHOR[1]!;
  let aboveZ = ANCHOR[2]!;
  for (let i = 0; i < count; i += 1) {
    const rest = links[i]!.restOffsetM;
    writeClamped(
      links[i]!.maxOffsetM,
      chainPosition,
      3 * i,
      aboveX + rest[0]!,
      aboveY + rest[1]!,
      aboveZ + rest[2]!,
      out,
      3 * i,
    );
    aboveX = out[3 * i]!;
    aboveY = out[3 * i + 1]!;
    aboveZ = out[3 * i + 2]!;
  }
}

/** Chain scratch, grown when a longer chain than any seen before arrives and never shrunk. */
let chainPosition = new Float64Array(0);
let chainVelocity = new Float64Array(0);
let chainCoefficients = new Float64Array(0);
let chainTrail = new Float64Array(0);

/**
 * Make room for `count` links.
 *
 * **Grown on demand rather than capped**, because a cap is a number this module cannot know: a
 * braid is four links and a chain-mail skirt is a hundred. After the first frame of the longest
 * chain a scene holds this allocates nothing, which is what `clip.ts` asks for — the rule is no
 * allocation *per frame*, not none ever.
 */
function reserve(count: number): void {
  if (chainTrail.length >= count) return;
  chainPosition = new Float64Array(3 * count);
  chainVelocity = new Float64Array(3 * count);
  chainCoefficients = new Float64Array(4 * count);
  chainTrail = new Float64Array(count);
}

function validateSettings(settings: SpringSettings): void {
  if (!(settings.frequencyHz > 0)) {
    throw new Error(
      `spring: frequencyHz is ${settings.frequencyHz}, and a spring needs a frequency above zero. ` +
        'It is the rate the spring would ring at undamped, in hertz.',
    );
  }
  if (!(settings.damping >= 0)) {
    throw new Error(`spring: damping is ${settings.damping}, and a damping ratio is not negative.`);
  }
  if (settings.damping === 0) {
    throw new Error(
      'spring: damping is 0, which never settles — an undamped spring rings forever, so no ' +
        'lookback is long enough to sample it purely and there is no honest answer to give. ' +
        'Anything above zero forgets; 1 is critical damping, which never overshoots.',
    );
  }
}

/**
 * How far a mass trails an anchor moving at unit speed.
 *
 * Write the offset from the anchor as `r = x - a`. With the anchor moving at a constant `va`,
 * `r'' + 2ζω r' + ω²r = -2ζω va`, whose particular solution is the constant `-2ζ va / ω`. What is
 * left after subtracting it is the *unforced* damped oscillator, which is the thing that has the
 * closed form this module's whole argument is built on.
 */
function trailPerUnitSpeed(settings: SpringSettings): number {
  return (-2 * settings.damping) / (2 * Math.PI * settings.frequencyHz);
}

/**
 * The 2x2 that carries `(offset, velocity)` across one substep exactly, written at `at`.
 *
 * It depends only on ω, ζ and the step — none of which change across a march or between axes — so
 * it is built once per link and each substep is four multiplies.
 */
function transitionOver(
  settings: SpringSettings,
  step: number,
  out: Float64Array,
  at: number,
): void {
  const zeta = settings.damping;
  const omega = 2 * Math.PI * settings.frequencyHz;
  const decay = Math.exp(-zeta * omega * step);
  const discriminant = zeta * zeta - 1;

  let cosine: number;
  let sine: number;
  if (discriminant < -CRITICAL_BAND) {
    /* Underdamped: it rings at a frequency below its own, and `sin(x)/x` carries the velocity. */
    const ringing = omega * Math.sqrt(-discriminant);
    cosine = Math.cos(ringing * step);
    sine = Math.sin(ringing * step) / ringing;
  } else if (discriminant > CRITICAL_BAND) {
    /*
     * Overdamped: the same expressions with the frequency gone imaginary, which is the hyperbolic
     * pair. **Nothing here can overflow, for a reason worth writing down**: the step is the
     * lookback over the step count and the lookback is `-ln(EPSILON)/(ζω)`, so both `ζω·step` and
     * `ω√(ζ²-1)·step` stay under `-ln(EPSILON)` for any settings at all — a stiffer spring shortens
     * its own memory in exact proportion to how fast it moves.
     */
    const sagging = omega * Math.sqrt(discriminant);
    cosine = Math.cosh(sagging * step);
    sine = Math.sinh(sagging * step) / sagging;
  } else {
    /* Critical: the limit of both, taken rather than approached. */
    cosine = 1;
    sine = step;
  }

  out[at] = decay * (cosine + zeta * omega * sine);
  out[at + 1] = decay * sine;
  out[at + 2] = -decay * omega * omega * sine;
  out[at + 3] = decay * (cosine - zeta * omega * sine);
}

/** One substep of one axis of one link, solved rather than stepped. */
function advance(
  coefficients: Float64Array,
  from: number,
  trail: number,
  step: number,
  position: Float64Array,
  velocity: Float64Array,
  at: number,
  anchorStart: number,
  anchorEnd: number,
): void {
  /*
   * **The anchor is read as moving straight between its two samples**, which is the only
   * approximation left in here and the reason the step still matters. It resolves the *spring's*
   * period, because that is the one thing this function knows; an anchor moving far faster than
   * the spring it drives is read on that grid, and the spring's own response to it is small for
   * exactly the reason it is being undersampled.
   */
  const speed = (anchorEnd - anchorStart) / step;
  const rest = trail * speed;
  const offset = position[at]! - anchorStart - rest;
  const relative = velocity[at]! - speed;

  position[at] =
    coefficients[from]! * offset + coefficients[from + 1]! * relative + rest + anchorEnd;
  velocity[at] = coefficients[from + 2]! * offset + coefficients[from + 3]! * relative + speed;
}

/**
 * Write a finished position out, held within `limit` metres of its anchor if there is one.
 *
 * **Applied at the end rather than per step, and that is deliberate**: clamping inside the march
 * feeds a position the spring never reached back into its own velocity, which turns a limit into a
 * different spring. This holds the drawn result within reach of the anchor and leaves the motion
 * the settings describe intact.
 */
function writeClamped(
  limit: number | undefined,
  position: Float64Array,
  from: number,
  anchorX: number,
  anchorY: number,
  anchorZ: number,
  out: Float32Array,
  at: number,
): void {
  const dx = position[from]! - anchorX;
  const dy = position[from + 1]! - anchorY;
  const dz = position[from + 2]! - anchorZ;

  let scale = 1;
  if (limit !== undefined && limit >= 0) {
    const lag = Math.hypot(dx, dy, dz);
    if (lag > limit) scale = limit / lag;
  }

  out[at] = anchorX + dx * scale;
  out[at + 1] = anchorY + dy * scale;
  out[at + 2] = anchorZ + dz * scale;
}
