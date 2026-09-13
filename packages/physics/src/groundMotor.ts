/**
 * Accelerate along a wish direction, Quake's way.
 *
 * **Six lines, and the most reimplemented six lines in movement code.** Every kinematic character
 * needs them and the trap is specific: the amount added is clamped against *how much of the wish
 * speed the body does not already have along the wish direction*, not against the wish speed
 * itself. Get that wrong and a body accelerates to `wishSpeed` in every direction at once, which
 * is a body that cannot turn; leave the clamp out and it accelerates for ever.
 *
 * **What the projection buys is air-strafing.** `currentSpeed` is the *dot product*, so a body
 * moving fast in one direction still has room to add speed at right angles to it — which is why
 * turning while airborne gains speed in every game descended from Quake, and why it is a verb
 * players learn rather than a bug. A consumer that wants that behaviour gets it; one that does not
 * passes a small `accel` while airborne, which is what the parameter is for.
 *
 * **`accel` is what a consumer decides**, and it is where every game's own answer lives: a surface
 * that grips or slips, a motor that is winded, a slope that foreshortens the thrust. This takes
 * the number and applies it, which is the boundary this whole package draws.
 */

/** Anything with a planar velocity. Declared structurally so nothing is imported either way. */
export interface PlanarState {
  velX: number;
  velZ: number;
}

/**
 * @param wishX Unit direction the body is asking to travel in.
 * @param wishZ
 * @param wishSpeed How fast it is asking to go, in that direction.
 * @param accel Metres per second squared this tick may deliver.
 * @returns How much speed was actually added, so a consumer can tell a stalled motor from a
 *   satisfied one — a demand the ground refuses is exactly the interesting case for anything
 *   drawing wheelspin or smoke.
 */
export function accelerateAlong(
  state: PlanarState,
  wishX: number,
  wishZ: number,
  wishSpeed: number,
  accel: number,
  dt: number,
): number {
  if (wishSpeed < 1e-6) return 0;
  /* How much of the wish speed the body already has *along the wish direction*. */
  const currentSpeed = state.velX * wishX + state.velZ * wishZ;
  const addSpeed = wishSpeed - currentSpeed;
  if (addSpeed <= 0) return 0;
  const added = Math.min(accel * dt, addSpeed);
  state.velX += wishX * added;
  state.velZ += wishZ * added;
  return added;
}
