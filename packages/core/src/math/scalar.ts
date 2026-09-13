export const TAU = Math.PI * 2;
export const DEG_TO_RAD = Math.PI / 180;

export function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value;
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/** Hermite interpolation between two edges: 0 below `a`, 1 above `b`. */
export function smoothstep(a: number, b: number, x: number): number {
  const t = clamp((x - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
}

/**
 * Framerate-independent exponential approach of `a` toward `b`.
 * `lambda` is the convergence rate in 1/seconds (higher = snappier).
 */
export function damp(a: number, b: number, lambda: number, dt: number): number {
  /*
   * **Presentation smoothing, which is why the marker is here and not a rewrite.** `damp`,
   * `dampAngle` and `dampTracking` converge a *drawn* value toward a target over wall-clock
   * seconds: a camera following a car, a dial settling. `scripts/determinism.mjs` refuses `Math.exp`
   * inside the simulation set because ECMAScript does not specify it, and that refusal is right for
   * anything a tick's state depends on — but none of these three is that.
   *
   * **What a simulation wants instead**, if it ever wants exponential approach inside the fixed
   * step, is a per-tick factor computed once from `lambda` and the fixed `dt` and passed in as a
   * number: at a constant step the factor is a constant, so nothing has to call `exp` on a tick at
   * all. `exactExp` in `math/exact.ts` is the other answer, and is the one to reach for when the
   * rate itself varies.
   */
  // determinism: build-time — presentation smoothing; see the note above for a simulation
  return lerp(a, b, 1 - Math.exp(-lambda * dt));
}

/**
 * Exponential approach of `a` toward a target that is itself **moving**, at `velocity`.
 *
 * `damp` above is `lerp(a, b, 1 - exp(-lambda dt))`, which is the exact solution of
 * `a' = lambda (b - a)` for a `b` that holds still across the interval — a zero-order hold. For a
 * target that is moving it is wrong in two ways that both show up as the frame rate changes,
 * because the error is a function of `dt`:
 *
 * - the settled gap becomes `v dt (1-k)/k` for `k = 1 - exp(-lambda dt)`, which *shrinks as the
 *   frame time grows*, so a machine that drops rate quietly re-frames the shot;
 * - and under uneven frames the gap oscillates rather than settling at all.
 *
 * This solves the same equation for `b(t) = b - v (dt - t)`, a target arriving at `b` having
 * travelled at `v`. Substituting `e = a - b` gives `e' = -lambda e - v`, whose solution is
 * `e(t) = (e0 + v/lambda) exp(-lambda t) - v/lambda` — so the settled gap is `v/lambda` at every
 * rate and there is nothing left for jitter to move. `b` is the target **now**, at the end of the
 * interval, which is what a caller has.
 *
 * **What it costs is a velocity the caller has to supply**, and a caller that passes zero gets
 * `damp` back exactly. A finite difference of the target over the frame is the usual source and is
 * exact for a target that is moving smoothly; what it is not good for is a target that *steps*,
 * where one frame of `delta/dt` is a spike and this will aim `v/lambda` ahead of it.
 *
 * Zero or negative `lambda` returns `a` rather than dividing by it. The limit as `lambda` goes to
 * zero is `a` — no pull, no movement — so the guard agrees with the arithmetic rather than merely
 * avoiding an infinity.
 */
export function dampTracking(
  a: number,
  b: number,
  velocity: number,
  lambda: number,
  dt: number,
): number {
  if (lambda <= 0) return a;
  const lag = velocity / lambda;
  // determinism: build-time — presentation smoothing, like `damp`; see the note there
  return b - lag + (a - b + lag + velocity * dt) * Math.exp(-lambda * dt);
}

/** Signed shortest angular distance from `a` to `b`, in (-π, π]. */
export function angleDelta(a: number, b: number): number {
  let d = (b - a) % TAU;
  if (d > Math.PI) d -= TAU;
  if (d < -Math.PI) d += TAU;
  return d;
}

/**
 * Fold an angle into (-π, π]. Simulation state uses this so a long session
 * cannot accumulate an unbounded angle and lose float precision. Anything
 * replaying a recorded session depends on staying bit-stable over its length.
 */
export function wrapAngle(a: number): number {
  let w = a % TAU;
  if (w > Math.PI) w -= TAU;
  if (w <= -Math.PI) w += TAU;
  return w;
}

/** `lerp` along the shortest arc — the angular counterpart for render interpolation. */
export function lerpAngle(a: number, b: number, t: number): number {
  return a + angleDelta(a, b) * t;
}

/** `damp` along the shortest arc between two angles. */
export function dampAngle(a: number, b: number, lambda: number, dt: number): number {
  // determinism: build-time — presentation smoothing; see `damp`
  return a + angleDelta(a, b) * (1 - Math.exp(-lambda * dt));
}
