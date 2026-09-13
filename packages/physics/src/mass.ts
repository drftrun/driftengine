import { faceCount, faceVertices } from './faces.ts';
import type { ConvexShape } from './shape.ts';

/**
 * A shape's volume, centre of mass and inertia tensor, at a given density.
 *
 * **Exact for a hull, by tetrahedral decomposition over its face loops** — which is why this sits
 * immediately beside the loops themselves: one build-time addition to `ConvexShape` pays for both
 * contact clipping and this, and neither is a separate piece of work.
 *
 * A rounded hull — `radius > 0` with faces — is the Minkowski sum of a hull and a ball, which has
 * no closed form. Sphere and capsule are handled by the ball case below; anything else with a
 * radius is approximated by the hull's tensor about the same centre. **What that gives up** is
 * accuracy for a heavily rounded hull, where the shell is a large fraction of the volume. **What
 * would make it wrong** is a consumer building such a shape and caring how it tumbles, at which
 * point the answer is a numerical integration over the support function rather than a fudge factor.
 *
 * Build-time only, like everything else in `shape.ts`: nothing here may be called per tick.
 */
export interface MassProperties {
  volume: number;
  comX: number;
  comY: number;
  comZ: number;
  /** The tensor about the centre of mass. Six independent terms, symmetric. */
  ixx: number;
  iyy: number;
  izz: number;
  ixy: number;
  ixz: number;
  iyz: number;
}

/** A target for `shapeMassProperties`, so nothing allocates per call. */
export function createMassProperties(): MassProperties {
  return { volume: 0, comX: 0, comY: 0, comZ: 0, ixx: 0, iyy: 0, izz: 0, ixy: 0, ixz: 0, iyz: 0 };
}

/** Scratch for one face's vertex loop. `MAX_POINTS` caps a hull at 64, so a face cannot exceed it. */
const FACE = new Uint16Array(64);

export function shapeMassProperties(
  shape: ConvexShape,
  density: number,
  out: MassProperties,
): MassProperties {
  const faces = faceCount(shape);
  /*
   * **A triangle mesh has no mass properties and answers zero rather than guessing.** A surface
   * encloses no volume, and a soup of them may not even be closed; the bounding box's tensor would
   * be a plausible number for a body that `addBody` refuses to make dynamic anyway. Zero volume is
   * what a static body's own inverse mass already is.
   */
  if (shape.triangles !== undefined) {
    out.volume = 0;
    out.comX = 0;
    out.comY = 0;
    out.comZ = 0;
    out.ixx = 0;
    out.iyy = 0;
    out.izz = 0;
    out.ixy = 0;
    out.ixz = 0;
    out.iyz = 0;
    return out;
  }
  // A disc-rounded shape is a cylinder and has its own closed form, which is exact rather than a
  // decomposition — so it is tested before the faceless path, whose arithmetic assumes a ball.
  if (shape.sideRadius > 0) return cylinderProperties(shape, density, out);
  if (faces === 0) return ballProperties(shape, density, out);

  let volume = 0;
  let centroidX = 0;
  let centroidY = 0;
  let centroidZ = 0;
  // Second moments about the origin, accumulated per tetrahedron and shifted at the end.
  let xx = 0;
  let yy = 0;
  let zz = 0;
  let xy = 0;
  let xz = 0;
  let yz = 0;

  for (let face = 0; face < faces; face++) {
    const n = faceVertices(shape, face, FACE);
    const a = (FACE[0] ?? 0) * 3;
    const ax = shape.vertices[a] ?? 0;
    const ay = shape.vertices[a + 1] ?? 0;
    const az = shape.vertices[a + 2] ?? 0;

    // Fan the face into triangles, each closing a tetrahedron against the origin.
    for (let i = 1; i + 1 < n; i++) {
      const b = (FACE[i] ?? 0) * 3;
      const c = (FACE[i + 1] ?? 0) * 3;
      const bx = shape.vertices[b] ?? 0;
      const by = shape.vertices[b + 1] ?? 0;
      const bz = shape.vertices[b + 2] ?? 0;
      const cx = shape.vertices[c] ?? 0;
      const cy = shape.vertices[c + 1] ?? 0;
      const cz = shape.vertices[c + 2] ?? 0;

      // Six times the signed tetrahedron volume: the scalar triple product.
      const det = ax * (by * cz - bz * cy) - ay * (bx * cz - bz * cx) + az * (bx * cy - by * cx);
      const v = det / 6;
      volume += v;

      // Centroid of a tetrahedron with one vertex at the origin.
      centroidX += (v * (ax + bx + cx)) / 4;
      centroidY += (v * (ay + by + cy)) / 4;
      centroidZ += (v * (az + bz + cz)) / 4;

      /*
       * Second moments of a tetrahedron about the origin, in closed form. The diagonal integral
       * reduces to det/60 times the sum of squares and pairwise products of the three vertex
       * coordinates; the products use det/120 with the mixed terms. Both are exact rather than
       * quadrature, which is what makes the box test below a hand-derived literal rather than a
       * tolerance chosen to fit.
       */
      xx += (det / 60) * (ax * ax + bx * bx + cx * cx + ax * bx + ax * cx + bx * cx);
      yy += (det / 60) * (ay * ay + by * by + cy * cy + ay * by + ay * cy + by * cy);
      zz += (det / 60) * (az * az + bz * bz + cz * cz + az * bz + az * cz + bz * cz);
      xy +=
        (det / 120) *
        (2 * ax * ay +
          2 * bx * by +
          2 * cx * cy +
          ax * by +
          ay * bx +
          ax * cy +
          ay * cx +
          bx * cy +
          by * cx);
      xz +=
        (det / 120) *
        (2 * ax * az +
          2 * bx * bz +
          2 * cx * cz +
          ax * bz +
          az * bx +
          ax * cz +
          az * cx +
          bx * cz +
          bz * cx);
      yz +=
        (det / 120) *
        (2 * ay * az +
          2 * by * bz +
          2 * cy * cz +
          ay * bz +
          az * by +
          ay * cz +
          az * cy +
          by * cz +
          bz * cy);
    }
  }

  const mass = volume * density;
  const comX = volume === 0 ? 0 : centroidX / volume;
  const comY = volume === 0 ? 0 : centroidY / volume;
  const comZ = volume === 0 ? 0 : centroidZ / volume;

  out.volume = volume;
  out.comX = comX;
  out.comY = comY;
  out.comZ = comZ;
  // Parallel-axis shift from the origin to the centre of mass.
  out.ixx = density * (yy + zz) - mass * (comY * comY + comZ * comZ);
  out.iyy = density * (xx + zz) - mass * (comX * comX + comZ * comZ);
  out.izz = density * (xx + yy) - mass * (comX * comX + comY * comY);
  out.ixy = -(density * xy) + mass * comX * comY;
  out.ixz = -(density * xz) + mass * comX * comZ;
  out.iyz = -(density * yz) + mass * comY * comZ;
  return out;
}

/**
 * Several shapes as one body: volumes added, centre of mass weighted, tensors moved and summed.
 *
 * **What a compound body weighs, and it is the parallel axis theorem doing the work.** Each part's
 * tensor is about that part's own centre of mass; the body's is about the body's. Moving one costs
 * `m (|d|² δ - d ⊗ d)` where `d` is the offset between the two centres, and skipping that term is
 * not a small error — an L-beam released at rest would rotate, because its inertia would no longer
 * match its shape.
 *
 * **Overlap is counted twice, and that is the decision rather than an oversight.** A decomposition's
 * hulls bulge slightly into each other, so the volumes here sum to a little more than the solid they
 * stand for — measured at 27% against 16% occupied on a torus, and 5% against 2% on a cup. Removing
 * it exactly means a boolean intersection of convex solids, which is a large body of code whose
 * output corrects a number the caller invented when they chose a density.
 * `Decomposition.hullVolume` reports the sum, so a caller who cares can divide it out.
 *
 * The shapes are read twice: once for the centre and once for the tensor about it. That is a bake's
 * cost paid at `addBody`, not a tick's.
 */
export function combineMassProperties(
  parts: readonly ConvexShape[],
  density: number,
  out: MassProperties,
): MassProperties {
  let volume = 0;
  let comX = 0;
  let comY = 0;
  let comZ = 0;
  for (const part of parts) {
    const m = shapeMassProperties(part, density, COMBINE_SCRATCH);
    volume += m.volume;
    comX += m.volume * m.comX;
    comY += m.volume * m.comY;
    comZ += m.volume * m.comZ;
  }
  if (volume > 0) {
    comX /= volume;
    comY /= volume;
    comZ /= volume;
  } else {
    comX = 0;
    comY = 0;
    comZ = 0;
  }

  let ixx = 0;
  let iyy = 0;
  let izz = 0;
  let ixy = 0;
  let ixz = 0;
  let iyz = 0;
  for (const part of parts) {
    const m = shapeMassProperties(part, density, COMBINE_SCRATCH);
    const mass = m.volume * density;
    const dx = m.comX - comX;
    const dy = m.comY - comY;
    const dz = m.comZ - comZ;
    ixx += m.ixx + mass * (dy * dy + dz * dz);
    iyy += m.iyy + mass * (dx * dx + dz * dz);
    izz += m.izz + mass * (dx * dx + dy * dy);
    ixy += m.ixy - mass * dx * dy;
    ixz += m.ixz - mass * dx * dz;
    iyz += m.iyz - mass * dy * dz;
  }

  out.volume = volume;
  out.comX = comX;
  out.comY = comY;
  out.comZ = comZ;
  out.ixx = ixx;
  out.iyy = iyy;
  out.izz = izz;
  out.ixy = ixy;
  out.ixz = ixz;
  out.iyz = iyz;
  return out;
}

/** Reused by `combineMassProperties`, which is called once per body rather than once per tick. */
const COMBINE_SCRATCH = createMassProperties();

/**
 * A cylinder: `sideRadius` about the segment between the shape's two points.
 *
 * Exact and in closed form, like the hull path and unlike the capsule's, which has to sum a
 * cylinder and two hemispheres. `m r² / 2` down the axis and `m (3r² + L²) / 12` across it, where
 * `L` is the full length — the two textbook results, hand-derived in the test rather than checked
 * against this code.
 *
 * **The tensor is built about the axis and then rotated into place**, the same last step
 * `capsuleProperties` takes and for the same reason: a cylinder baked into world space by a
 * collider has an arbitrary axis, and a tensor written in the shape's own frame would be wrong
 * for it in a way nothing throws about.
 *
 * A shape carrying both roundings — a cylinder with a filleted rim — is treated as the plain
 * cylinder its two radii describe at the fillet's outer extent. **What that gives up** is the
 * fillet's own volume, a few per cent at a small radius; **what would make it wrong** is a
 * consumer filleting a rim by a large fraction of the shape, where the answer is the numerical
 * integration §4a already names.
 */
function cylinderProperties(
  shape: ConvexShape,
  density: number,
  out: MassProperties,
): MassProperties {
  const r = shape.sideRadius + shape.radius;
  const ax = (shape.vertices[3] ?? 0) - (shape.vertices[0] ?? 0);
  const ay = (shape.vertices[4] ?? 0) - (shape.vertices[1] ?? 0);
  const az = (shape.vertices[5] ?? 0) - (shape.vertices[2] ?? 0);
  const length = Math.sqrt(ax * ax + ay * ay + az * az) + 2 * shape.radius;

  out.comX = ((shape.vertices[0] ?? 0) + (shape.vertices[3] ?? 0)) / 2;
  out.comY = ((shape.vertices[1] ?? 0) + (shape.vertices[4] ?? 0)) / 2;
  out.comZ = ((shape.vertices[2] ?? 0) + (shape.vertices[5] ?? 0)) / 2;
  out.ixy = 0;
  out.ixz = 0;
  out.iyz = 0;

  const volume = Math.PI * r * r * length;
  const mass = volume * density;
  out.volume = volume;

  const along = (mass * r * r) / 2;
  const across = (mass * (3 * r * r + length * length)) / 12;
  if (length === 0) {
    out.ixx = along;
    out.iyy = along;
    out.izz = along;
    return out;
  }
  const segment = Math.sqrt(ax * ax + ay * ay + az * az) || 1;
  const ux = ax / segment;
  const uy = ay / segment;
  const uz = az / segment;
  const d = along - across;
  out.ixx = across + d * ux * ux;
  out.iyy = across + d * uy * uy;
  out.izz = across + d * uz * uz;
  out.ixy = d * ux * uy;
  out.ixz = d * ux * uz;
  out.iyz = d * uy * uz;
  return out;
}

/**
 * A shape with no faces is a ball or a capsule: all of its volume is the rounding radius.
 *
 * Which one is decided by how many points survived `hullShape`'s dedupe, and that is the whole
 * distinction: one point is a sphere, two are a capsule along the segment between them.
 *
 * `Math.PI` is a constant rather than a call, so the determinism gate has nothing to say about it.
 */
function ballProperties(shape: ConvexShape, density: number, out: MassProperties): MassProperties {
  const count = shape.vertices.length / 3;
  let cx = 0;
  let cy = 0;
  let cz = 0;
  for (let i = 0; i < count; i++) {
    cx += shape.vertices[i * 3] ?? 0;
    cy += shape.vertices[i * 3 + 1] ?? 0;
    cz += shape.vertices[i * 3 + 2] ?? 0;
  }
  const n = count === 0 ? 1 : count;
  out.comX = cx / n;
  out.comY = cy / n;
  out.comZ = cz / n;
  out.ixy = 0;
  out.ixz = 0;
  out.iyz = 0;

  const r = shape.radius;
  if (count !== 2) {
    const volume = (4 / 3) * Math.PI * r * r * r;
    const inertia = 0.4 * volume * density * r * r;
    out.volume = volume;
    out.ixx = inertia;
    out.iyy = inertia;
    out.izz = inertia;
    return out;
  }
  return capsuleProperties(shape, density, out);
}

/**
 * A capsule: a cylinder of length 2h capped by two hemispheres of radius r.
 *
 * **This replaces the sphere tensor the previous version returned for any faceless shape**, which
 * was recorded as wrong where it stood: a wrong inertia does not throw, it produces a body that
 * tumbles unconvincingly, and that reads as a solver bug and gets diagnosed as one.
 *
 * The axis is the segment between the two points, and the tensor is built about it and then
 * rotated into place. **What this gives up:** the arithmetic below assumes a capsule, so a
 * two-point cloud with a radius small enough that the points are effectively a line segment is
 * still treated as a capsule, which it is. **What would make it wrong** is a three-point flat
 * cloud with a radius, which has no closed form and falls to the hull path above instead, where
 * §4a's Minkowski caveat applies.
 */
function capsuleProperties(
  shape: ConvexShape,
  density: number,
  out: MassProperties,
): MassProperties {
  const r = shape.radius;
  const ax = (shape.vertices[3] ?? 0) - (shape.vertices[0] ?? 0);
  const ay = (shape.vertices[4] ?? 0) - (shape.vertices[1] ?? 0);
  const az = (shape.vertices[5] ?? 0) - (shape.vertices[2] ?? 0);
  const length = Math.sqrt(ax * ax + ay * ay + az * az);
  const h = length / 2;

  const cylinder = 2 * Math.PI * r * r * h * density;
  const cap = ((2 * Math.PI * r * r * r) / 3) * density;
  out.volume = (cylinder + 2 * cap) / density;

  // About the capsule's own long axis.
  const along = (cylinder * r * r) / 2 + 2 * cap * ((2 * r * r) / 5);
  /*
   * Perpendicular to it. The cylinder term is standard; each hemisphere contributes its own
   * 2mr²/5 about its centre plus the parallel-axis shift to the capsule's centre, whose distance
   * terms reduce to h² + 3hr/4 because a hemisphere's centre of mass sits 3r/8 from its flat face.
   */
  const across =
    (cylinder * (3 * r * r + 4 * h * h)) / 12 +
    2 * cap * ((2 * r * r) / 5 + h * h + (3 * h * r) / 4);

  if (length === 0) {
    out.ixx = along;
    out.iyy = along;
    out.izz = along;
    return out;
  }

  /*
   * The tensor is `across` in every direction perpendicular to the axis and `along` down it, which
   * is `across·I + (along − across)·(a ⊗ a)` for the unit axis `a`. Written out rather than looped
   * because six terms unrolled read better than a 3×3 with two of nine entries unused.
   */
  const ux = ax / length;
  const uy = ay / length;
  const uz = az / length;
  const d = along - across;
  out.ixx = across + d * ux * ux;
  out.iyy = across + d * uy * uy;
  out.izz = across + d * uz * uz;
  out.ixy = d * ux * uy;
  out.ixz = d * ux * uz;
  out.iyz = d * uy * uz;
  return out;
}
