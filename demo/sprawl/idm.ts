/**
 * How a car accelerates: the intelligent driver model at the reference's numbers — a 2 m minimum
 * gap and a 1.2 s headway (`trafficMinGap`, `trafficHeadway`) — and how it brakes for a slower edge
 * ahead, a turn.
 *
 * **The model is the reference's reading, not its code**: its scripts name a gap and a headway and
 * say the following is IDM-like. The exponent of 4 and the comfortable deceleration of half a
 * kind's brake are the model's customary values, and ours.
 */

export const MIN_GAP = 2;
export const HEADWAY = 1.2;
/** A gap past which nothing ahead matters. */
export const FAR = 1e9;
/** The hardest a car brakes: twice the comfortable figure, which is its kind's own brake. */
const EMERGENCY = 2;

/**
 * Acceleration for a car at `v` wanting `v0`, a bumper gap `gap` behind something moving at `lead`,
 * accelerating at up to `accel` and braking comfortably at `brake`.
 */
export function idm(
  v: number,
  v0: number,
  gap: number,
  lead: number,
  accel: number,
  brake: number,
): number {
  const r = v0 > 0 ? v / v0 : 1;
  const r2 = r * r;
  const free = 1 - r2 * r2;
  if (gap >= FAR) return accel * free;
  const wanted =
    MIN_GAP + Math.max(0, v * HEADWAY + (v * (v - lead)) / (2 * Math.sqrt(accel * brake)));
  const q = wanted / Math.max(gap, 0.1);
  return Math.max(-EMERGENCY * brake, accel * (free - q * q));
}

/**
 * The braking that brings `v` down to `after` exactly `left` metres on, once that takes at least
 * `onset`; 0 before then, so a car holds its speed until the turn is near and then brakes steadily
 * along one curve. A lower desired speed does not do this: the model's free-road term sheds speed
 * too gently near its target, and a car arrived at a turn half again too fast.
 */
export function turnBraking(v: number, after: number, left: number, onset: number): number {
  if (v <= after) return 0;
  const need = (v * v - after * after) / (2 * Math.max(left, 0.5));
  return need >= onset ? -need : 0;
}
