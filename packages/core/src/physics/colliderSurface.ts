import type { Collider, ColliderSet } from '@driftengine/physics';
import { ColliderSet as ColliderSetClass } from '@driftengine/physics';

import type { GroundSurface, SurfaceHit } from './ribbonSurface.ts';

/**
 * A `ColliderSet` answering "where is the ground here?", so a solid holds a body up.
 *
 * **Because a collider was solid to walk into and not to stand on.** The kinematic sweep resolves a
 * body against a collider set laterally, and `CharacterController` senses ground through
 * `PhysicsWorld` bodies and through a `GroundSurface` — a collider set is neither, so nothing ever
 * asked it what was under your feet. Measured before this existed: a character dropped over a
 * `ColliderSet` slab whose top face is at 5.5 m falls to −84 m in three seconds, which is exactly
 * what it does with no slab at all.
 *
 * Reported by a consumer building flyovers, who could express a sloped deck as a hull already and
 * found that standing on one did not hold them up. The alternative available to them was to add
 * every deck to a `PhysicsWorld` as a static body as well — the same geometry twice, in two
 * structures that can disagree.
 *
 * **It is a `GroundSurface` and not a new seam, which is what makes it worth having.** Everything
 * that stands on ground already takes one: the character controller, the raycast vehicle, the
 * third-person camera boom, the rain field. And because `heightSurface` takes a list of surfaces,
 * a world can be terrain *and* slabs without either knowing about the other:
 *
 * ```ts
 * const ground = new CompositeSurface([
 *   heightSurface((x, z) => terrainAt(x, z)),
 *   colliderSurface(decks, { minY: -10, maxY: 60 }),
 * ]);
 * ```
 *
 * **What it is not.** It is not a replacement for the sweep: the sweep is what stops a body walking
 * *into* a collider, and this is what stops it falling *through* one. A consumer wants both, and
 * they read the same set.
 */
export interface ColliderSurfaceOptions {
  /**
   * The vertical extent to look through, metres.
   *
   * **Required, and guessing would be worse than asking.** A ground query is a column, and the
   * spatial hash walks every cell in it — an unbounded column over a 4 m grid is half a million
   * cells and a frozen frame. A consumer knows how tall their world is; the engine does not, and a
   * default would be wrong quietly.
   */
  readonly minY: number;
  readonly maxY: number;
}

/** How much a face above the asker is penalised when two are equally near. */
const TIE_BREAK = 0.4;
/** Below this a face is treated as vertical: a wall, which is not something to stand on. */
const VERTICAL_EPSILON = 1e-6;
/** The column has a width, because a query with none falls between two cells of the hash. */
const COLUMN_EPSILON = 1e-4;

export function colliderSurface(set: ColliderSet, options: ColliderSurfaceOptions): GroundSurface {
  const { minY, maxY } = options;
  if (!(maxY > minY)) {
    throw new Error(
      `colliderSurface: maxY must be above minY, got minY=${minY} maxY=${maxY}. This is the ` +
        'vertical extent the column search walks, and an empty one finds no ground anywhere.',
    );
  }

  /* Allocation-free: a ground query runs every tick for everything that stands on something. */
  const found = new Int32Array(ColliderSetClass.MAX_HITS);
  const box: Collider = { minX: 0, minY: 0, minZ: 0, maxX: 0, maxY: 0, maxZ: 0 };
  const top = { y: 0, nx: 0, ny: 1, nz: 0 };

  /**
   * The highest surface of collider `index` in this column, or false where the column misses it.
   *
   * **A shaped collider is solved against its own face planes, not its box.** The box is the broad
   * phase; treating it as the answer is what would put a body standing on thin air over the corner
   * of every ramp, which is the same mistake the segment query documents having made. For a convex
   * solid the vertical line at `(x, z)` enters through the downward-facing planes and leaves
   * through the upward-facing ones, so the exit is the lowest of the upward ones and the entry is
   * the highest of the downward ones — and the column misses the solid entirely when the exit is
   * below the entry.
   */
  const columnTop = (index: number, x: number, z: number): boolean => {
    set.bounds(index, box);
    if (x < box.minX || x > box.maxX || z < box.minZ || z > box.maxZ) return false;

    const shape = set.shapeAt(index);
    const planes = shape?.facePlanes;
    if (shape === undefined || planes === undefined || planes.length < 16) {
      /* A collider that is its box: the lid is flat and its normal is up. */
      top.y = box.maxY;
      top.nx = 0;
      top.ny = 1;
      top.nz = 0;
      return true;
    }

    let exit = Infinity;
    let entry = -Infinity;
    let nx = 0;
    let ny = 1;
    let nz = 0;
    for (let p = 0; p < planes.length; p += 4) {
      const pnx = planes[p] as number;
      const pny = planes[p + 1] as number;
      const pnz = planes[p + 2] as number;
      const d = planes[p + 3] as number;
      const lateral = pnx * x + pnz * z;
      if (pny > -VERTICAL_EPSILON && pny < VERTICAL_EPSILON) {
        /* A vertical face bounds the column rather than the height: outside it, there is no solid
           over this point at any height. */
        if (lateral > d) return false;
        continue;
      }
      const y = (d - lateral) / pny;
      if (pny > 0) {
        if (y < exit) {
          exit = y;
          nx = pnx;
          ny = pny;
          nz = pnz;
        }
      } else if (y > entry) {
        entry = y;
      }
    }
    if (!Number.isFinite(exit) || exit < entry) return false;

    /* Rounding grows the solid outward along the face normal, so the lid rises by it. `sideRadius`
       grows a cylinder's side and not its caps, which is why only `radius` is here. */
    top.y = exit + shape.radius;
    top.nx = nx;
    top.ny = ny;
    top.nz = nz;
    return true;
  };

  const fill = (out: SurfaceHit): void => {
    out.y = top.y;
    out.normalX = top.nx;
    out.normalY = top.ny;
    out.normalZ = top.nz;
    /* A solid has no route, so the fields that describe one say nothing rather than something
       invented. `tilt` follows the face, for the reason `heightSurface` gives: the surface collides
       exactly as it looks. */
    out.tiltX = top.nx;
    out.tiltY = top.ny;
    out.tiltZ = top.nz;
    out.tangentX = 1;
    out.tangentY = 0;
    out.tangentZ = 0;
    out.distanceM = 0;
    out.lateralM = 0;
    out.bankRad = 0;
    out.halfWidthM = Infinity;
  };

  return {
    /**
     * The face nearest the asker's feet, ties broken toward the one below.
     *
     * The same rule `CompositeSurface` uses between its parts and `RibbonSurface` between its own
     * passes, and for the same reason: what you are standing on is the thing under your feet, and
     * "highest wins" teleports a body under a deck up onto it.
     */
    sample(x: number, z: number, out: SurfaceHit, atY = Infinity): boolean {
      const count = set.query(
        x - COLUMN_EPSILON,
        minY,
        z - COLUMN_EPSILON,
        x + COLUMN_EPSILON,
        maxY,
        z + COLUMN_EPSILON,
        found,
      );
      const located = Number.isFinite(atY);
      let best = Infinity;
      let hit = false;
      for (let i = 0; i < count; i++) {
        if (!columnTop(found[i] as number, x, z)) continue;
        const score = located ? Math.abs(top.y - atY) + (top.y > atY ? TIE_BREAK : 0) : -top.y;
        if (score >= best) continue;
        best = score;
        fill(out);
        hit = true;
      }
      return hit;
    },

    /** See `GroundSurface.sampleBand`: the highest face in the band, and nothing outside it. */
    sampleBand(x: number, z: number, out: SurfaceHit, loY: number, hiY: number): boolean {
      const count = set.query(
        x - COLUMN_EPSILON,
        Math.max(minY, loY),
        z - COLUMN_EPSILON,
        x + COLUMN_EPSILON,
        Math.min(maxY, hiY),
        z + COLUMN_EPSILON,
        found,
      );
      let bestY = -Infinity;
      let hit = false;
      for (let i = 0; i < count; i++) {
        if (!columnTop(found[i] as number, x, z)) continue;
        /* Half-open, as the interface says: a face at head height is one a body passes under. */
        if (top.y < loY || top.y >= hiY || top.y <= bestY) continue;
        bestY = top.y;
        fill(out);
        hit = true;
      }
      return hit;
    },
  };
}
