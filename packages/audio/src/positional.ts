/**
 * Placing a sound in the world: how loud a source is from here, and which side
 * of the head it is on.
 *
 * Two small functions rather than a panner graph per emitter. A full HRTF node
 * is the general answer and the right one for a game where a footstep behind
 * you is information; for environmental sources — a fire, a waterfall, a storm
 * column — what a player actually reads is "how close" and "which way", and
 * these produce exactly those two numbers at no per-frame node cost.
 *
 * Both are pure, so a game can compute a whole scene's mix inside its render
 * pass without touching the audio thread until the values have settled.
 */

/**
 * Level for a source `distance` away, reaching exactly zero at `radius`.
 *
 * Zero at the edge is the part that matters. Physical falloff is `1/d²`, which
 * never quite arrives — and a route carrying a dozen braziers then sums into a
 * permanent hiss the player can neither identify nor walk away from. A curve
 * that ends is worth more here than one that is correct.
 *
 * `curve` shapes the approach: 1 is linear, 2 concentrates the change near the
 * source, which is where a player's own movement makes it legible.
 */
export function distanceGain(distance: number, radius: number, curve = 2): number {
  if (!(radius > 0) || !Number.isFinite(distance)) return 0;
  const t = 1 - Math.min(Math.max(distance / radius, 0), 1);
  return curve === 1 ? t : t ** curve;
}

/**
 * Where a source sits across the stereo field, from a listener facing `yaw`.
 *
 * -1 hard left, 0 centre or directly ahead/behind, 1 hard right. Yaw 0 faces
 * −Z, matching the convention the rest of the engine's cameras and controls
 * use, so the listener's right is `(cos yaw, 0, sin yaw)`.
 *
 * Horizontal only. Height is deliberately ignored: stereo cannot express it,
 * and folding it in would quietly pull a source overhead toward the centre for
 * no reason a listener could interpret.
 */
export function stereoPan(dx: number, dz: number, yaw: number): number {
  const horizontal = Math.hypot(dx, dz);
  if (horizontal < 1e-4) return 0;
  return (dx * Math.cos(yaw) + dz * Math.sin(yaw)) / horizontal;
}
