/** Where the camera is, and which way it faces, expressed in one capture's own space. */

/**
 * The camera as the sorter needs it: in the capture's coordinates rather than the world's.
 *
 * Mutable and filled in place, because this is resolved once a frame per batch and the engine's
 * rule about per-frame allocation binds a package exactly as it binds the renderer.
 */
export interface SplatViewLocal {
  /** The camera's forward in the capture's own space, unit length. */
  dirX: number;
  dirY: number;
  dirZ: number;
  /** The camera's position in the capture's own space. */
  originX: number;
  originY: number;
  originZ: number;
}

export function createSplatViewLocal(): SplatViewLocal {
  return { dirX: 0, dirY: 0, dirZ: -1, originX: 0, originY: 0, originZ: 0 };
}

/**
 * Fill `out` with the camera, in the space the capture's own positions are written in.
 *
 * **One sorter serves one batch, and this is what makes that affordable.** A batch has a model
 * matrix so that two captures can compose in one scene; its splat positions are in its own frame
 * and the sort reads them there, so asking the sort for a *world* direction would mean
 * transforming a million positions every time the view turned. Transforming the camera instead is
 * six numbers.
 *
 * **The direction is the model's transpose and not its inverse, and the two disagree exactly where
 * it matters.** What the sort needs is an ordering that matches the depth those splats really have
 * once the model has moved them, and the world depth of a capture-space point `p` is
 * `dot(M p + t - c, d)`, which rearranges to `dot(p, Mᵀd)` plus a constant. So `Mᵀd` is the
 * direction that orders correctly for *any* invertible model, including one with a non-uniform
 * scale; `M⁻¹d` is the direction that would be right if the transform were a rotation, and a
 * plausible-looking answer everywhere else. `splatView.test.ts` asserts the ordering rather than
 * the arithmetic, which is why the model it uses is stretched.
 *
 * The origin is the inverse, because that genuinely is a point: `M⁻¹(c − t)` is where the camera
 * sits in the capture's frame, and it is what the budget's distances are measured from. It also
 * happens to be exactly the point whose projection along `Mᵀd` cancels the constant above, so the
 * two halves agree by construction rather than by arrangement.
 *
 * **What this gives up**: the ordering is along the view *axis* rather than by distance to the
 * camera point, so two splats at equal depth and far apart across the frame are ordered by a plane
 * rather than by a sphere. That is the ordering every splat renderer uses and it costs nothing
 * until a capture wraps around the viewer. What would make it wrong is exactly that case —
 * standing inside a capture at a wide field of view, where the error shows at the frame's corners.
 *
 * **A singular model falls back to the world rather than to `NaN`.** This is reached from a frame
 * and the loop may not throw; a `NaN` direction is a sort in which every comparison is false,
 * which is silently input order rather than a visible fault.
 */
export function resolveSplatView(
  view: ArrayLike<number>,
  model: ArrayLike<number>,
  out: SplatViewLocal,
): void {
  /*
   * The camera's forward in the world is the third row of the view rotation, negated: the view
   * matrix takes world to camera and a camera looks down its own -z.
   */
  const forwardX = -(view[2] ?? 0);
  const forwardY = -(view[6] ?? 0);
  const forwardZ = -(view[10] ?? 0);

  /* The camera's position is -Rᵀt, which for a rigid view matrix is an exact inverse and costs
     nine multiplies rather than a general inversion. */
  const tx = view[12] ?? 0;
  const ty = view[13] ?? 0;
  const tz = view[14] ?? 0;
  const cameraX = -((view[0] ?? 0) * tx + (view[1] ?? 0) * ty + (view[2] ?? 0) * tz);
  const cameraY = -((view[4] ?? 0) * tx + (view[5] ?? 0) * ty + (view[6] ?? 0) * tz);
  const cameraZ = -((view[8] ?? 0) * tx + (view[9] ?? 0) * ty + (view[10] ?? 0) * tz);

  /*
   * **Named by row then column, because binding these the other way is a transposed inverse and a
   * plausible picture.** `model` is column-major, so the element at row `r` and column `c` is
   * `model[c * 4 + r]` — while the cofactor formulas below are written the way every reference
   * writes them, in rows. Reading three consecutive array entries as a row looks like a matching
   * pattern and quietly inverts the transpose; it did here, and the ordering test caught it by a
   * sign.
   */
  const a00 = model[0] ?? 0;
  const a10 = model[1] ?? 0;
  const a20 = model[2] ?? 0;
  const a01 = model[4] ?? 0;
  const a11 = model[5] ?? 0;
  const a21 = model[6] ?? 0;
  const a02 = model[8] ?? 0;
  const a12 = model[9] ?? 0;
  const a22 = model[10] ?? 0;

  /*
   * Mᵀd. Transposing turns the matrix's columns into rows, and a column of a column-major array is
   * three adjacent entries — so this reads as three plain dot products against the array as
   * stored, which is the one place the layout helps rather than hinders.
   */
  const rawX = a00 * forwardX + a10 * forwardY + a20 * forwardZ;
  const rawY = a01 * forwardX + a11 * forwardY + a21 * forwardZ;
  const rawZ = a02 * forwardX + a12 * forwardY + a22 * forwardZ;
  const length = Math.hypot(rawX, rawY, rawZ);

  /* Cofactors of the first row, which give the determinant and a third of the inverse at once. */
  const c00 = a11 * a22 - a12 * a21;
  const c01 = a12 * a20 - a10 * a22;
  const c02 = a10 * a21 - a11 * a20;
  const determinant = a00 * c00 + a01 * c01 + a02 * c02;

  if (
    length === 0 ||
    determinant === 0 ||
    !Number.isFinite(length) ||
    !Number.isFinite(determinant)
  ) {
    out.dirX = forwardX;
    out.dirY = forwardY;
    out.dirZ = forwardZ;
    out.originX = cameraX;
    out.originY = cameraY;
    out.originZ = cameraZ;
    return;
  }

  out.dirX = rawX / length;
  out.dirY = rawY / length;
  out.dirZ = rawZ / length;

  const relativeX = cameraX - (model[12] ?? 0);
  const relativeY = cameraY - (model[13] ?? 0);
  const relativeZ = cameraZ - (model[14] ?? 0);
  const inverse = 1 / determinant;
  /* M⁻¹ = adj(M)/det, and the adjugate is the *transpose* of the cofactor matrix — which is why
     c01 and c02 open the second and third rows here rather than the first. */
  out.originX =
    (c00 * relativeX + (a02 * a21 - a01 * a22) * relativeY + (a01 * a12 - a02 * a11) * relativeZ) *
    inverse;
  out.originY =
    (c01 * relativeX + (a00 * a22 - a02 * a20) * relativeY + (a02 * a10 - a00 * a12) * relativeZ) *
    inverse;
  out.originZ =
    (c02 * relativeX + (a01 * a20 - a00 * a21) * relativeY + (a00 * a11 - a01 * a10) * relativeZ) *
    inverse;
}
