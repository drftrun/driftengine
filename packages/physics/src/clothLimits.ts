/**
 * Where a skinned cloth's particles may not go: the limits measured from each particle's skinned
 * position, and the colliders its skeleton carries.
 *
 * **Projections, not constraints with compliance.** A limit is a statement about the body — a
 * garment does not pass through the hip it is cut for — so a particle past one is put back on its
 * surface, at once and wholly. Applied after the constraint iterations of every substep, so a stiff
 * garment pulling a particle into the body loses.
 *
 * Allocation-free, and each function a kernel the GPU solver mirrors.
 */

/** A particle further than `maxDistance[i] · scale` from its skinned position is put back on that sphere. */
export function applyMaxDistance(
  position: Float32Array,
  inverseMass: Float32Array,
  target: Float32Array,
  maxDistance: Float32Array,
  scale: number,
): void {
  for (let i = 0; i < inverseMass.length; i++) {
    if ((inverseMass[i] as number) === 0) continue;
    const limit = (maxDistance[i] as number) * scale;
    if (!(limit < Infinity)) continue;
    const at = i * 3;
    const dx = (position[at] as number) - (target[at] as number);
    const dy = (position[at + 1] as number) - (target[at + 1] as number);
    const dz = (position[at + 2] as number) - (target[at + 2] as number);
    const d2 = dx * dx + dy * dy + dz * dz;
    if (d2 <= limit * limit) continue;
    const s = limit / Math.sqrt(d2);
    position[at] = (target[at] as number) + dx * s;
    position[at + 1] = (target[at + 1] as number) + dy * s;
    position[at + 2] = (target[at + 2] as number) + dz * s;
  }
}

/**
 * A sphere the particle may not enter, on one side of its skinned position: behind it along the
 * skinned normal for a backstop (`side` −1), in front for a frontstop (`side` +1). `stops` holds a
 * distance and a radius a particle; the centre is `distance + radius` from the skinned position,
 * so the sphere's near surface is `distance` from it. An infinite distance is no stop.
 */
export function applyStops(
  position: Float32Array,
  inverseMass: Float32Array,
  target: Float32Array,
  normal: Float32Array,
  stops: Float32Array,
  side: number,
): void {
  for (let i = 0; i < inverseMass.length; i++) {
    if ((inverseMass[i] as number) === 0) continue;
    const distance = stops[i * 2] as number;
    const radius = stops[i * 2 + 1] as number;
    if (!(distance < Infinity) || !(radius > 0)) continue;
    const at = i * 3;
    const reach = (distance + radius) * side;
    const cx = (target[at] as number) + (normal[at] as number) * reach;
    const cy = (target[at + 1] as number) + (normal[at + 1] as number) * reach;
    const cz = (target[at + 2] as number) + (normal[at + 2] as number) * reach;
    pushOut(position, at, cx, cy, cz, radius);
  }
}

/** Put the point at `at` on the sphere's surface if it is inside. A point at the centre stays. */
function pushOut(
  position: Float32Array,
  at: number,
  cx: number,
  cy: number,
  cz: number,
  radius: number,
): void {
  const dx = (position[at] as number) - cx;
  const dy = (position[at + 1] as number) - cy;
  const dz = (position[at + 2] as number) - cz;
  const d2 = dx * dx + dy * dy + dz * dz;
  if (d2 >= radius * radius || d2 < 1e-18) return;
  const s = radius / Math.sqrt(d2);
  position[at] = cx + dx * s;
  position[at + 1] = cy + dy * s;
  position[at + 2] = cz + dz * s;
}

/**
 * Every particle out of every collider: a sphere, or a tapered capsule from `ends[k·6]` to
 * `ends[k·6+3]` whose radius runs from `radii[k·2]` to `radii[k·2+1]` — plus the particle's
 * thickness and the cloth's margin.
 *
 * **A tapered capsule is pushed out from the nearest point on its axis**, at the radius interpolated
 * there. That is the usual approximation of a cone-swept sphere and what character cloth solvers
 * ship: exact where the two radii are equal, and where they differ it puts a particle a little off
 * the true surface on the narrowing side — by a fraction of the taper over the capsule's length,
 * which for a limb is millimetres. What would make it wrong is a collider tapering steeply over a
 * short length, a cone more than a limb; the exact distance to a swept sphere is the fix then.
 */
export function applyColliders(
  position: Float32Array,
  inverseMass: Float32Array,
  thickness: Float32Array | null,
  margin: number,
  ends: Float32Array,
  radii: Float32Array,
  colliders: number,
): void {
  for (let i = 0; i < inverseMass.length; i++) {
    if ((inverseMass[i] as number) === 0) continue;
    const at = i * 3;
    const pad = (thickness === null ? 0 : (thickness[i] as number)) + margin;
    for (let k = 0; k < colliders; k++) {
      const ax = ends[k * 6] as number;
      const ay = ends[k * 6 + 1] as number;
      const az = ends[k * 6 + 2] as number;
      const ex = (ends[k * 6 + 3] as number) - ax;
      const ey = (ends[k * 6 + 4] as number) - ay;
      const ez = (ends[k * 6 + 5] as number) - az;
      const e2 = ex * ex + ey * ey + ez * ez;
      let t = 0;
      if (e2 > 1e-18) {
        t =
          (((position[at] as number) - ax) * ex +
            ((position[at + 1] as number) - ay) * ey +
            ((position[at + 2] as number) - az) * ez) /
          e2;
        t = Math.min(1, Math.max(0, t));
      }
      const r0 = radii[k * 2] as number;
      const r1 = radii[k * 2 + 1] as number;
      pushOut(position, at, ax + ex * t, ay + ey * t, az + ez * t, r0 + (r1 - r0) * t + pad);
    }
  }
}
