/** The second level of the chain: march the world's own distance field, where the screen ran out. */

import { sampleGlobalField } from './globalField.ts';

import type { ReadonlyVec3 } from 'gl-matrix';
import type { GlobalField, GlobalFieldCascade } from './globalField.ts';

/**
 * **This is the level that makes the one above it legitimate.**
 *
 * `ROADMAP.md` refused screen-space global illumination because its error is unbounded: a ray that
 * leaves the frame has no answer at all, and every technique that ships one anyway invents it from
 * whatever happened to be on screen. Here the screen is an accelerator with something behind it,
 * and this is the something. Its error is bounded by the field's resolution — a number written
 * down, measurable, and the same in every direction — rather than by what the camera is pointing
 * at.
 *
 * **Sphere tracing, which is the only march a distance field admits.** Step by the field's own
 * value: it is a distance nothing can be nearer than, so the step is as long as it can safely be
 * and the march converges in a handful of steps rather than in a fixed grid walk. Every invariant
 * that makes that true is tested where it is produced — `sdf.ts` measures the gradient's length,
 * `globalField.ts` measures that the composed field never overestimates — because a march cannot
 * tell a field that is a distance from one that merely has the right sign.
 */

/** How the march is shaped. */
export interface FieldMarch {
  /** The most samples one ray may take. A converging march uses a fraction of this. */
  readonly steps: number;
  /** How far the ray travels in world metres before it gives up. */
  readonly reachM: number;
  /**
   * Half-angle of the cone, in radians. Zero is a pencil ray.
   *
   * **A rough surface reflects a lobe rather than a ray**, and a cone is how a distance field
   * traces one: the radius grows with the distance travelled and a hit is where the field falls
   * below *that* rather than below a constant. The blur is then correct by construction — a wide
   * cone stops further from a surface, so what it gathers is a broader patch of it — instead of
   * being a filter applied to a sharp answer afterwards.
   */
  readonly coneAngle: number;
  /** How close to a surface counts as arriving, in metres, before the cone's own radius. */
  readonly hitEpsilonM: number;
}

/**
 * How far along the ray a march starts, in voxels of the finest cascade.
 *
 * **Proportional to the field's resolution and not a constant, because what it is escaping is the
 * field's own error.** A trilinear read of a grid is wrong by something on the order of a voxel
 * near a surface, so a ray leaving a surface is inside that error until it has travelled about
 * that far — and a march that starts at zero reports a hit before it has moved, on every surface
 * at once. A voxel is a different number in each cascade and in each scene, which is exactly why
 * this is a count of them rather than a length.
 */
export const FIELD_START_VOXELS = 2;

/** The march an indirect ray takes through the world field. */
export const FIELD_MARCH: FieldMarch = {
  steps: 64,
  reachM: 20,
  coneAngle: 0,
  hitEpsilonM: 0.01,
};

/** Where a march ended. Reused rather than returned, because the chain runs this per ray. */
export interface FieldHit {
  hit: boolean;
  /** Where it arrived, in world metres. */
  x: number;
  y: number;
  z: number;
  /**
   * How far along the ray, world metres, from the **lifted** origin.
   *
   * The lift is `FIELD_START_VOXELS` voxels along the normal, so this differs from the distance to
   * the point a caller passed in by at most that — and by nothing at all where the caller passed
   * no normal, which is what a ray from open space does.
   */
  distanceM: number;
  /** The cone's radius there, which is how broad a patch of surface this hit stands for. */
  radiusM: number;
  /** How many samples it took. Diagnostic, and the thing a convergence test asserts on. */
  steps: number;
  /**
   * Whether it left the field rather than running out of reach.
   *
   * **The two misses are different and the chain acts on the difference.** A ray that escaped has
   * gone somewhere this level has no information about, and the probe volume behind it is what
   * answers. A ray that ran out of reach travelled its whole budget through open space, which is a
   * statement about the world rather than about the field.
   */
  escaped: boolean;
}

export function newFieldHit(): FieldHit {
  return { hit: false, x: 0, y: 0, z: 0, distanceM: 0, radiusM: 0, steps: 0, escaped: false };
}

/** The cone's radius after travelling `distance`, for a cone of this half-angle. */
export function coneRadiusAt(distanceM: number, coneAngle: number): number {
  return coneAngle <= 0 ? 0 : distanceM * Math.tan(coneAngle);
}

/**
 * March a ray through the composed world field.
 *
 * Returns whether it arrived at a surface. A false is the chain's cue to go one level further
 * down; `FieldHit.escaped` says which of the two misses it was.
 */
export function traceField(
  field: GlobalField,
  point: ReadonlyVec3,
  normal: ReadonlyVec3,
  direction: ReadonlyVec3,
  march: FieldMarch,
  out: FieldHit,
): boolean {
  out.hit = false;
  out.x = 0;
  out.y = 0;
  out.z = 0;
  out.distanceM = 0;
  out.radiusM = 0;
  out.steps = 0;
  out.escaped = false;

  const dx = direction[0] ?? 0;
  const dy = direction[1] ?? 0;
  const dz = direction[2] ?? 0;
  const length = Math.hypot(dx, dy, dz);
  if (!(length > 0)) {
    throw new Error(
      'traceField: the direction has no length, so every step would be the same point and the ' +
        'march would spend its whole budget standing still.',
    );
  }
  const ux = dx / length;
  const uy = dy / length;
  const uz = dz / length;

  const finest = field.cascades[0] as GlobalFieldCascade;
  const start = FIELD_START_VOXELS * finest.step;

  /*
   * **Lifted along the normal, and only along the normal.** Pushing the start along the *ray* as
   * well double-counts — a ray leaving along its own normal would then begin two offsets out, and
   * every distance it reported would carry the second one — and it does not help the case that
   * needs help: a tangent ray pushed along itself is still on the surface, because a surface is
   * what tangent means. The normal is the one direction that always leaves.
   *
   * A point with no normal, which is what a ray from open space has, is not lifted at all, so
   * `distanceM` is measured from exactly where the caller asked.
   */
  const nx = normal[0] ?? 0;
  const ny = normal[1] ?? 0;
  const nz = normal[2] ?? 0;
  const normalLength = Math.hypot(nx, ny, nz);
  const lift = normalLength > 0 ? start / normalLength : 0;
  const ox = (point[0] ?? 0) + nx * lift;
  const oy = (point[1] ?? 0) + ny * lift;
  const oz = (point[2] ?? 0) + nz * lift;

  const steps = Math.max(1, Math.round(march.steps));
  let travelled = 0;

  for (let step = 0; step < steps; step++) {
    const x = ox + ux * travelled;
    const y = oy + uy * travelled;
    const z = oz + uz * travelled;
    out.steps = step + 1;

    /*
     * **Outside the outermost cascade the march stops rather than sampling.** There is no
     * information out there at all: `sampleGlobalField` clamps to the edge, which is the right
     * answer for a sample and the wrong one for a march — stepping on clamped values converges on
     * the boundary of the cascade and reports a surface made of nothing.
     */
    if (!withinField(field, x, y, z)) {
      out.escaped = true;
      out.distanceM = travelled;
      return false;
    }

    const distance = sampleGlobalField(field, x, y, z);
    const radius = coneRadiusAt(travelled, march.coneAngle);
    if (distance <= radius + march.hitEpsilonM) {
      out.hit = true;
      out.x = x;
      out.y = y;
      out.z = z;
      out.distanceM = travelled;
      out.radiusM = radius;
      return true;
    }

    /*
     * **Step by the distance, and by at least a fraction of a voxel.** A field whose value is
     * genuinely tiny beside a surface the cone is not wide enough to accept would otherwise take
     * ever-smaller steps and spend the whole budget arriving nowhere, which reads as a miss and
     * costs a fallback. The floor makes that case terminate as a miss quickly instead.
     */
    travelled += Math.max(distance, finest.step * 0.25);
    if (travelled > march.reachM) {
      out.distanceM = march.reachM;
      return false;
    }
  }

  out.distanceM = travelled;
  return false;
}

/** Whether a point is inside the outermost cascade, which is the whole of what the field knows. */
function withinField(field: GlobalField, x: number, y: number, z: number): boolean {
  const outer = field.cascades[field.cascades.length - 1] as GlobalFieldCascade;
  const p = [x, y, z];
  for (let axis = 0; axis < 3; axis++) {
    if ((p[axis] as number) < (outer.bounds[axis] as number)) return false;
    if ((p[axis] as number) > (outer.bounds[axis + 3] as number)) return false;
  }
  return true;
}
