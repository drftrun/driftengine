/**
 * Ray against shapes, for picking. Pure arithmetic, no allocation, no renderer.
 *
 * Separate from `src/render/` because none of it touches a context and all of it is
 * testable without one — the same split `textLayout.ts` makes for the same reason.
 */

/**
 * The slab method: clip the ray against three pairs of parallel planes and keep the
 * overlap.
 *
 * **The divide by a zero direction component is deliberate.** A ray parallel to an axis
 * gives ±Infinity for that slab, and the min/max below then either keep the interval
 * whole (the origin is between the planes) or collapse it (it is not), which is the right
 * answer both times. Special-casing zero to avoid the divide is how this gets broken.
 *
 * Returns the near distance, `0` when the origin is inside, `-1` on a miss. Distance
 * rather than a boolean because a pick has to choose the nearest of several hits.
 */
export function rayAabb(
  origin: ArrayLike<number>,
  direction: ArrayLike<number>,
  min: ArrayLike<number>,
  max: ArrayLike<number>,
): number {
  let near = -Infinity;
  let far = Infinity;

  for (let axis = 0; axis < 3; axis++) {
    const inverse = 1 / (direction[axis] as number);
    let t0 = ((min[axis] as number) - (origin[axis] as number)) * inverse;
    let t1 = ((max[axis] as number) - (origin[axis] as number)) * inverse;
    if (t0 > t1) {
      const swap = t0;
      t0 = t1;
      t1 = swap;
    }
    if (t0 > near) near = t0;
    if (t1 < far) far = t1;
    if (near > far) return -1;
  }

  if (far < 0) return -1;
  return near < 0 ? 0 : near;
}

/**
 * Möller–Trumbore, indexed and two-sided.
 *
 * Takes vertex *indices* into a flat position array rather than three points, so a caller
 * walking an index buffer allocates nothing per triangle — which is the whole reason
 * picking can afford a narrow phase at pointer-move rates.
 *
 * **Two-sided deliberately.** Culling back faces would make a pick miss a surface the
 * camera has got behind, and what that looks like to somebody using it is a click passing
 * through the object to whatever is beyond it.
 */
export function rayTriangle(
  origin: ArrayLike<number>,
  direction: ArrayLike<number>,
  positions: ArrayLike<number>,
  a: number,
  b: number,
  c: number,
): number {
  const ax = positions[a * 3] as number;
  const ay = positions[a * 3 + 1] as number;
  const az = positions[a * 3 + 2] as number;
  const e1x = (positions[b * 3] as number) - ax;
  const e1y = (positions[b * 3 + 1] as number) - ay;
  const e1z = (positions[b * 3 + 2] as number) - az;
  const e2x = (positions[c * 3] as number) - ax;
  const e2y = (positions[c * 3 + 1] as number) - ay;
  const e2z = (positions[c * 3 + 2] as number) - az;

  const px = (direction[1] as number) * e2z - (direction[2] as number) * e2y;
  const py = (direction[2] as number) * e2x - (direction[0] as number) * e2z;
  const pz = (direction[0] as number) * e2y - (direction[1] as number) * e2x;

  const determinant = e1x * px + e1y * py + e1z * pz;
  /* Near zero is a ray in the triangle's own plane: no single crossing to report. */
  if (determinant > -1e-9 && determinant < 1e-9) return -1;
  const inverse = 1 / determinant;

  const tx = (origin[0] as number) - ax;
  const ty = (origin[1] as number) - ay;
  const tz = (origin[2] as number) - az;

  const u = (tx * px + ty * py + tz * pz) * inverse;
  if (u < 0 || u > 1) return -1;

  const qx = ty * e1z - tz * e1y;
  const qy = tz * e1x - tx * e1z;
  const qz = tx * e1y - ty * e1x;

  const v =
    ((direction[0] as number) * qx +
      (direction[1] as number) * qy +
      (direction[2] as number) * qz) *
    inverse;
  if (v < 0 || u + v > 1) return -1;

  const distance = (e2x * qx + e2y * qy + e2z * qz) * inverse;
  return distance > 1e-6 ? distance : -1;
}

/**
 * Where a ray meets an infinite plane, or `-1`.
 *
 * The plane is a point and a normal rather than four coefficients, because every caller
 * here has a point — a gizmo's origin, a target's position — and would otherwise compute
 * `d` to have it undone one line later.
 *
 * **A ray within `1e-6` of parallel is a miss and not a hit at infinity.** The alternative
 * returns a number that is finite, enormous and wrong, and what a caller does with it is
 * teleport whatever it was dragging. Callers that grab against a plane depend on this
 * refusal; see `gizmo.ts`.
 *
 * The normal does not have to be unit length, but `direction` and `normal` must be in the
 * same space, and a plane behind the ray reports `-1` the way every other miss does.
 */
export function rayPlane(
  origin: ArrayLike<number>,
  direction: ArrayLike<number>,
  point: ArrayLike<number>,
  normal: ArrayLike<number>,
): number {
  const denominator =
    (direction[0] as number) * (normal[0] as number) +
    (direction[1] as number) * (normal[1] as number) +
    (direction[2] as number) * (normal[2] as number);
  if (denominator > -1e-6 && denominator < 1e-6) return -1;

  const numerator =
    ((point[0] as number) - (origin[0] as number)) * (normal[0] as number) +
    ((point[1] as number) - (origin[1] as number)) * (normal[1] as number) +
    ((point[2] as number) - (origin[2] as number)) * (normal[2] as number);
  const distance = numerator / denominator;
  return distance >= 0 ? distance : -1;
}

/**
 * The closest approach between a ray and an infinite line, written into `out`.
 *
 * `out` receives three numbers: the ray's parameter, the line's parameter, and the
 * distance between the two closest points. Three outputs is why this takes a buffer where
 * everything else in this file returns a number — a caller picking a gizmo handle needs
 * all three at once, and needs them without allocating on every pointer move.
 *
 * Returns `false` for two lines within `1e-6` of parallel, and **writes nothing in that
 * case**. There is no closest pair to report: every point on one line is equidistant from
 * the other, so any answer would be arbitrary, and a caller dragging along the line has to
 * keep what it had rather than jump to whichever point the arithmetic happened to land on.
 *
 * `direction` and `axis` must both be unit length. That is what makes the returned
 * parameters distances rather than multiples of two different vectors' lengths.
 */
export function rayClosestOnLine(
  origin: ArrayLike<number>,
  direction: ArrayLike<number>,
  point: ArrayLike<number>,
  axis: ArrayLike<number>,
  out: Float32Array,
): boolean {
  const dx = direction[0] as number;
  const dy = direction[1] as number;
  const dz = direction[2] as number;
  const ax = axis[0] as number;
  const ay = axis[1] as number;
  const az = axis[2] as number;

  const dotDA = dx * ax + dy * ay + dz * az;
  /* Both are unit, so this is 1 - cos²: the squared sine of the angle between them. */
  const denominator = 1 - dotDA * dotDA;
  if (denominator < 1e-6) return false;

  const wx = (origin[0] as number) - (point[0] as number);
  const wy = (origin[1] as number) - (point[1] as number);
  const wz = (origin[2] as number) - (point[2] as number);
  const dotDW = dx * wx + dy * wy + dz * wz;
  const dotAW = ax * wx + ay * wy + az * wz;

  const rayT = (dotDA * dotAW - dotDW) / denominator;
  const lineS = (dotAW - dotDA * dotDW) / denominator;

  const px = wx + dx * rayT - ax * lineS;
  const py = wy + dy * rayT - ay * lineS;
  const pz = wz + dz * rayT - az * lineS;

  out[0] = rayT;
  out[1] = lineS;
  out[2] = Math.sqrt(px * px + py * py + pz * pz);
  return true;
}

/**
 * The nearest positive distance along a ray to a sphere's surface, or `-1`.
 *
 * **An origin inside the sphere reports the far root rather than a miss**, which is the
 * same choice `rayAabb` makes for the same reason: a camera that has got inside something
 * pickable is still looking at it, and reporting a miss makes the object impossible to
 * click from close up.
 *
 * `direction` must be unit length, which is what lets the quadratic drop its leading
 * coefficient.
 */
export function raySphere(
  origin: ArrayLike<number>,
  direction: ArrayLike<number>,
  centre: ArrayLike<number>,
  radius: number,
): number {
  const ox = (origin[0] as number) - (centre[0] as number);
  const oy = (origin[1] as number) - (centre[1] as number);
  const oz = (origin[2] as number) - (centre[2] as number);

  const b =
    ox * (direction[0] as number) + oy * (direction[1] as number) + oz * (direction[2] as number);
  const c = ox * ox + oy * oy + oz * oz - radius * radius;
  const discriminant = b * b - c;
  if (discriminant < 0) return -1;

  const root = Math.sqrt(discriminant);
  const near = -b - root;
  if (near >= 0) return near;
  const far = -b + root;
  return far >= 0 ? far : -1;
}
