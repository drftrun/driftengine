import type { GroundSurface, SurfaceHit } from './ribbonSurface.ts';

/**
 * The tops of a set of flat, axis-aligned pads, answering as a ground surface.
 *
 * For the parts of a route that are *platforms* rather than ribbon — a flight of
 * steps, a run of pads with gaps between them. Those are still the route, and
 * that is the whole reason this exists rather than letting the collision boxes
 * carry them: a character on ordinary geometry is off the route as far as anything
 * asking the surface is concerned, and the route is what decides top speed, what
 * the camera leans on, and how far along the run somebody is.
 *
 * Deliberately flat. A pad is an AABB, its top is level, and pretending
 * otherwise would mean inventing a normal that the collider it shares a shape
 * with does not have.
 */
export interface SurfaceBox {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
  /** Height of the walkable face. */
  topY: number;
  /** How far along the route this pad sits, metres. */
  distanceM: number;
  /** Direction of travel across it, for the camera and the pose. */
  tangentX: number;
  tangentZ: number;
}

export class BoxSurface implements GroundSurface {
  constructor(private readonly boxes: readonly SurfaceBox[]) {}

  get count(): number {
    return this.boxes.length;
  }

  /**
   * The highest pad whose footprint contains the column.
   *
   * Highest rather than nearest, because pads never overlap in a way where the
   * lower one is the answer — a flight of steps is monotone — and "highest"
   * needs no reference height, which keeps this usable from a plain
   * `GroundSurface` call.
   *
   * A linear scan: a day's route carries a few dozen pads, and a scan over
   * thirty boxes inside a fixed tick costs less than the branch needed to skip
   * it. Allocation-free either way.
   */
  sample(x: number, z: number, out: SurfaceHit, atY = Infinity): boolean {
    let best: SurfaceBox | null = null;
    for (const box of this.boxes) {
      if (x < box.minX || x > box.maxX || z < box.minZ || z > box.maxZ) continue;
      // Highest pad at or below the asker, so a run of pads under a flyover
      // does not hand a character the deck above them.
      if (box.topY > atY + 1.2) continue;
      if (best === null || box.topY > best.topY) best = box;
    }
    if (best === null) return false;
    describe(best, out);
    return true;
  }

  /** See `GroundSurface.sampleBand`: the highest pad whose top is in the band. */
  sampleBand(x: number, z: number, out: SurfaceHit, loY: number, hiY: number): boolean {
    let best: SurfaceBox | null = null;
    for (const box of this.boxes) {
      if (x < box.minX || x > box.maxX || z < box.minZ || z > box.maxZ) continue;
      if (box.topY < loY || box.topY >= hiY) continue;
      if (best === null || box.topY > best.topY) best = box;
    }
    if (best === null) return false;
    describe(best, out);
    return true;
  }
}

function describe(box: SurfaceBox, out: SurfaceHit): void {
  out.y = box.topY;
  out.normalX = 0;
  out.normalY = 1;
  // A lid is flat, so it looks exactly as it collides. See `SurfaceHit.tilt`.
  out.tiltX = 0;
  out.tiltY = 1;
  out.tiltZ = 0;
  out.normalZ = 0;
  out.tangentX = box.tangentX;
  out.tangentY = 0;
  out.tangentZ = box.tangentZ;
  out.distanceM = box.distanceM;
  out.lateralM = 0;
  // Half the smaller footprint axis: the honest answer to "how much room is
  // left", which is what a caller uses it for.
  out.halfWidthM = Math.min(box.maxX - box.minX, box.maxZ - box.minZ) * 0.5;
  out.bankRad = 0;
}
