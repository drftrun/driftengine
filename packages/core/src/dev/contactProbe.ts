import type { Aabb } from '@driftengine/physics';
import type { ColliderSet } from '@driftengine/physics';

/**
 * What is around a box, in numbers a person can check.
 *
 * A development tool, not a physics path: `collide.ts` already resolves contacts and
 * is tuned to do it without allocating. This answers a different question — *which
 * colliders are here, and by how much* — for a diagnostic that runs when somebody
 * presses a key, so it favours being readable over being fast.
 *
 * Signed depth per axis rather than a single distance, because the two failures worth
 * telling apart look identical otherwise: a body 5 cm inside a deck and a body 5 cm
 * above one are both "5 cm from a collider".
 */
export interface ContactReport {
  index: number;
  /** True where the collider is a hull; its box is then the broad phase only. */
  hull: boolean;
  minX: number;
  minY: number;
  minZ: number;
  maxX: number;
  maxY: number;
  maxZ: number;
  /** Overlap along the axis. Positive is penetration, negative is the gap. */
  depthX: number;
  depthY: number;
  depthZ: number;
  /** Straight line between the boxes. Zero exactly when all three axes overlap. */
  distanceM: number;
}

export const CONTACT_LIMIT = 32;

export function createContactReports(count = CONTACT_LIMIT): ContactReport[] {
  const out: ContactReport[] = [];
  for (let i = 0; i < count; i++) {
    out.push({
      index: -1,
      hull: false,
      minX: 0,
      minY: 0,
      minZ: 0,
      maxX: 0,
      maxY: 0,
      maxZ: 0,
      depthX: 0,
      depthY: 0,
      depthZ: 0,
      distanceM: 0,
    });
  }
  return out;
}

const SCRATCH_BOUNDS: Aabb = { minX: 0, minY: 0, minZ: 0, maxX: 0, maxY: 0, maxZ: 0 };

/**
 * Describe every collider overlapping `box` or within `radius` of it.
 *
 * Returns how many entries of `out` were written. Reports are in query order, which is
 * spatial-hash order and therefore arbitrary: sort by `distanceM` at the point of
 * display if order matters, rather than paying for it here.
 */
export function describeContacts(
  colliders: ColliderSet,
  box: Aabb,
  radius: number,
  scratch: Int32Array,
  out: ContactReport[],
): number {
  const found = colliders.query(
    box.minX - radius,
    box.minY - radius,
    box.minZ - radius,
    box.maxX + radius,
    box.maxY + radius,
    box.maxZ + radius,
    scratch,
  );

  let written = 0;
  for (let k = 0; k < found && written < out.length; k++) {
    const index = scratch[k] as number;
    colliders.bounds(index, SCRATCH_BOUNDS);

    const depthX =
      Math.min(box.maxX, SCRATCH_BOUNDS.maxX) - Math.max(box.minX, SCRATCH_BOUNDS.minX);
    const depthY =
      Math.min(box.maxY, SCRATCH_BOUNDS.maxY) - Math.max(box.minY, SCRATCH_BOUNDS.minY);
    const depthZ =
      Math.min(box.maxZ, SCRATCH_BOUNDS.maxZ) - Math.max(box.minZ, SCRATCH_BOUNDS.minZ);

    const gapX = Math.max(0, -depthX);
    const gapY = Math.max(0, -depthY);
    const gapZ = Math.max(0, -depthZ);

    const report = out[written] as ContactReport;
    report.index = index;
    report.hull = colliders.shapeAt(index) !== undefined;
    report.minX = SCRATCH_BOUNDS.minX;
    report.minY = SCRATCH_BOUNDS.minY;
    report.minZ = SCRATCH_BOUNDS.minZ;
    report.maxX = SCRATCH_BOUNDS.maxX;
    report.maxY = SCRATCH_BOUNDS.maxY;
    report.maxZ = SCRATCH_BOUNDS.maxZ;
    report.depthX = depthX;
    report.depthY = depthY;
    report.depthZ = depthZ;
    report.distanceM = Math.hypot(gapX, gapY, gapZ);
    written++;
  }
  return written;
}
