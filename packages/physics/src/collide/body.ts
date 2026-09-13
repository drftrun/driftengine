import type { ConvexShape } from '../shape.ts';

/**
 * A body: what it is shaped like, what bounds it presents, and the frame it stands in.
 *
 * Separate from the sweep because these describe a body at rest. `bodyFrame` is here rather
 * than with the sweep, despite being sweep machinery in spirit, because `bodyBounds` calls
 * it — putting it there would make the two files import each other.
 */

/** Moving body: center position + half extents. Mutated in place by moveAxis. */
export interface Body {
  x: number;
  y: number;
  z: number;
  hx: number;
  hy: number;
  hz: number;
  /**
   * Which way is *up* for this body, as a unit vector. Omitted means world up.
   *
   * A body is a box, and a box has an orientation whether or not anything models one.
   * Nothing here did: every volume in this module was world-axis, so a body tilted to
   * lie along a banked deck — which is how a route is drawn and how a character is drawn
   * standing on it — collided as though it were still standing bolt upright. The
   * drawn body then reaches outside its own collision volume by roughly
   * `hy * sin(tilt)`, which on the 41-degree deck where every measured failure sits is
   * about half a metre of body with nothing solid around it: it passes into geometry
   * that looks solid, and geometry that looks clear stops it.
   *
   * Only the up axis, deliberately. It is what a surface has to give (`SurfaceHit`
   * carries a normal, not a frame) and what a body resting on one needs; roll about
   * that axis cannot change a box's world-axis bounds by more than its own
   * cross-section, and inventing a full frame here would mean inventing a heading for
   * bodies that have none. `bodyBounds` treats the remaining freedom conservatively.
   *
   * Two invariants for anything that sets it: it must be **unit length**, because
   * `bodyBounds` trusts that rather than paying a square root per query in the tick;
   * and it must be *set*, not accumulated, so a fixed-timestep replay cannot drift.
   */
  upX?: number;
  upY?: number;
  upZ?: number;
  /**
   * Which way this body *faces*, as a hint. Omitted means +Z, and it is only a hint:
   * `bodyFrame` orthogonalises it against `up`, so a caller with a yaw and a surface
   * normal does not have to reconcile them itself.
   *
   * Matters only for a body whose cross-section is not square — a box that is wider than
   * it is deep collides differently depending on which way it is turned, and that is
   * exactly the "crossing objects with different orientation" case.
   */
  fwdX?: number;
  fwdY?: number;
  fwdZ?: number;
  /**
   * The volume this body really is, in its own frame. Unset means the
   * `hx/hy/hz` box, which is also what the shape's absence has always meant.
   */
  shape?: ConvexShape;
  /**
   * A body made of parts — a character is a torso, a head, limbs and skates, and
   * with parts set it collides as exactly those, wherever its frame tilts
   * them. Takes precedence over `shape`. Set, not accumulated, like `up`.
   */
  parts?: readonly BodyPart[];
  /**
   * Where the frame rotates, as an offset from the centre along local Y.
   * Unset means the centre; a standing character wants its *feet* (`-hy`),
   * because that is where the drawn body pivots when it leans onto a bank —
   * a centre-pivoted tilt swings the feet through the floor and buries a
   * ground-snapped body up to 0.4 m into the very deck it stands on, while a
   * feet-pivoted one keeps them planted and swings the head, exactly like the
   * avatar it collides for. Upright bodies are unaffected bit for bit.
   */
  pivotY?: number;
  /**
   * Whether the contact that stopped the last blocked *downward* `moveAxis`
   * was support — the body arriving on top of a face whose plane is
   * walkably horizontal — as opposed to a graze against a side, an edge or an
   * underside. Written by `moveAxis` on downward Y moves only; `true` when the
   * move was not blocked at all.
   *
   * Exists because "the fall was stopped" and "the body is standing on
   * something" are different facts, and every rest rule that conflated them
   * let a body hang in mid-air by a skate corner kissing a slab's flank —
   * measured live as a character standing over the void beside a drawn pad,
   * half a metre below its top. A caller that never reads it loses nothing:
   * the resolution itself is unchanged, bit for bit.
   */
  contactSupport?: boolean;
  /**
   * The way **off** a face this body is perched on the rim of, as a horizontal unit vector.
   * Zero when the last downward move was supported, was not blocked, or was refused for any
   * other reason.
   *
   * **A rim perch's contact normal points straight up and that is not a mistake** — up is
   * genuinely the way out of the clamp. It is also of no use to a caller trying to get a body
   * off something it has been told it is not standing on: the only direction that helps is
   * sideways, and which sideways is a fact about the obstacle's footprint that nothing outside
   * the sweep can see.
   *
   * Without it a body could be held in clear air indefinitely. `contactSupport` correctly
   * refuses a foot's corner on a nine-centimetre sliver of a slab, so nothing grounds; the
   * blocked fall re-clamps the vertical speed every tick, so gravity never accumulates; and a
   * consumer sliding along the contact normal finds no horizontal component to slide along.
   * Measured on a courtyard pillar: five seconds of held input, zero metres of descent, and the
   * body still exactly where it started.
   */
  contactRimX?: number;
  contactRimZ?: number;
  /**
   * Which way is *out* of whatever clamped the last blocked `moveAxis` — a unit
   * vector pointing from the obstacle toward the body.
   *
   * Only meaningful on a move that was actually blocked (compare the returned
   * distance with the requested one); left as it was otherwise, so a caller reading
   * it after an unobstructed move is reading history.
   *
   * The sweep has always known this and always discarded it. `foldAxis` picks the
   * separating axis that decides the contact and already judges *which side of it*
   * the body is on — that is exactly `contactSupport`, reduced to a boolean about
   * one special case. Keeping the direction instead of the boolean is what lets a
   * caller **slide along** a face rather than stop dead against it, and that
   * distinction turns out to be the difference between a wall and a trap: a body
   * whose every axis is refused has nowhere to go, and axis-separated movement
   * refuses both axes at any corner. Measured on two separate reports as a character
   * held motionless and unable to jump for as long as anyone waited.
   *
   * Written, not accumulated, exactly like `up` — a fixed-timestep replay cannot
   * afford a field that drifts.
   */
  contactNormalX?: number;
  contactNormalY?: number;
  contactNormalZ?: number;
}

/** One piece of a compound body, offset from the body's centre in its own frame. */
export interface BodyPart {
  shape: ConvexShape;
  ox: number;
  oy: number;
  oz: number;
}

/**
 * World-axis half-extents of a body, accounting for the tilt of its own up axis.
 *
 * The whole point of the exercise: a tilted box needs a bigger axis-aligned box to hold
 * it, and every query in this module is axis-aligned. For an upright body this returns
 * exactly `hx, hy, hz`, so nothing that has not asked for an orientation changes by a
 * floating-point bit.
 *
 * Conservative about the one freedom `Body` does not model. With only an up axis given,
 * the body may be rolled arbitrarily about it, so the two cross-axes are bounded by the
 * larger of the two half-widths — a box is at worst its own diagonal wide, and being
 * generous here costs a little forgiveness at a corner while being mean would cost the
 * penetration this exists to stop.
 *
 * Allocation-free by contract: writes into `out` and returns it (the tick calls this and
 * the tick may not allocate).
 */
export interface BodyBounds {
  hx: number;
  hy: number;
  hz: number;
}

export function createBodyBounds(): BodyBounds {
  return { hx: 0, hy: 0, hz: 0 };
}

export function bodyBounds(body: Body, out: BodyBounds): BodyBounds {
  /*
   * A shaped body is bounded by its enclosing radius, whichever way it turns.
   * Broad phase only — over-asking costs a candidate test, under-asking costs
   * a body through a wall — and it saves re-deriving oriented extents for a
   * volume the narrow phase is about to resolve exactly anyway.
   */
  if (body.parts !== undefined) {
    /*
     * The union of each part's ball, placed where the frame and pivot really
     * put it. A single enclosing sphere was measured 2.5 m across for a
     * feet-pivoted character — every query dragged in half the junction — while
     * this stays within centimetres of the true extents.
     */
    const f = bodyFrame(body, boundsFrame);
    const pivotY = body.pivotY ?? 0;
    out.hx = 0;
    out.hy = 0;
    out.hz = 0;
    for (let i = 0; i < body.parts.length; i++) {
      const part = body.parts[i];
      if (part === undefined) continue;
      const oy = part.oy - pivotY;
      const cx = f.rx * part.ox + f.ux * oy + f.fx * part.oz;
      const cy = pivotY + f.ry * part.ox + f.uy * oy + f.fy * part.oz;
      const cz = f.rz * part.ox + f.uz * oy + f.fz * part.oz;
      const r = part.shape.boundRadius;
      if (Math.abs(cx) + r > out.hx) out.hx = Math.abs(cx) + r;
      if (Math.abs(cy) + r > out.hy) out.hy = Math.abs(cy) + r;
      if (Math.abs(cz) + r > out.hz) out.hz = Math.abs(cz) + r;
    }
    return out;
  }
  if (body.shape !== undefined) {
    const radius = body.shape.boundRadius + Math.abs(body.pivotY ?? 0) * 2;
    out.hx = radius;
    out.hy = radius;
    out.hz = radius;
    return out;
  }
  const ux = body.upX ?? 0;
  const uy = body.upY ?? 1;
  const uz = body.upZ ?? 0;
  // Upright, which is almost every body almost always: the exact old numbers, no work.
  if (ux === 0 && uz === 0 && uy > 0) {
    out.hx = body.hx;
    out.hy = body.hy;
    out.hz = body.hz;
    return out;
  }
  /*
   * The up axis contributes `hy * |component|` to each world axis. The two cross-axes
   * span the plane perpendicular to it, and their contribution to a world axis is the
   * length of that axis's projection onto that plane — `sqrt(1 - component^2)` — times
   * the wider of the two half-widths, since roll about `up` is unmodelled and may point
   * either of them anywhere in the plane.
   */
  const across = Math.max(body.hx, body.hz);
  out.hx = Math.abs(ux) * body.hy + Math.sqrt(Math.max(0, 1 - ux * ux)) * across;
  out.hy = Math.abs(uy) * body.hy + Math.sqrt(Math.max(0, 1 - uy * uy)) * across;
  out.hz = Math.abs(uz) * body.hy + Math.sqrt(Math.max(0, 1 - uz * uz)) * across;
  return out;
}

export const AXIS_X = 0;
export const AXIS_Y = 1;
export const AXIS_Z = 2;
export type Axis = typeof AXIS_X | typeof AXIS_Y | typeof AXIS_Z;

/**
 * A body's orientation as three orthonormal axes, written out so the tick allocates nothing.
 *
 * Built from the body's `up` and, where it has one, its `forward`. Roll about `up` is what
 * `forward` supplies; without it any perpendicular will do, because a box whose cross-section
 * is square (`hx === hz`) is unchanged by roll and one that is not has no heading to honour.
 */
export interface BodyFrame {
  /** Across the body, to its right. */
  rx: number;
  ry: number;
  rz: number;
  /** The body's own up. */
  ux: number;
  uy: number;
  uz: number;
  /** The body's own forward. */
  fx: number;
  fy: number;
  fz: number;
  /** False where the frame is the world's, so callers can take the cheap path. */
  tilted: boolean;
}

export function createBodyFrame(): BodyFrame {
  return { rx: 1, ry: 0, rz: 0, ux: 0, uy: 1, uz: 0, fx: 0, fy: 0, fz: 1, tilted: false };
}

/**
 * Resolve a body's orientation into an orthonormal frame.
 *
 * Gram-Schmidt against `up`, so `forward` is a *hint* about heading rather than a constraint
 * that has to arrive already perpendicular — a caller with a yaw and a surface normal has no
 * cheap way to make those two agree, and demanding it would push the arithmetic into every
 * call site.
 */
export function bodyFrame(body: Body, out: BodyFrame): BodyFrame {
  const ux = body.upX ?? 0;
  const uy = body.upY ?? 1;
  const uz = body.upZ ?? 0;
  if (ux === 0 && uz === 0 && uy > 0 && body.fwdX === undefined) {
    out.rx = 1;
    out.ry = 0;
    out.rz = 0;
    out.ux = 0;
    out.uy = 1;
    out.uz = 0;
    out.fx = 0;
    out.fy = 0;
    out.fz = 1;
    out.tilted = false;
    return out;
  }
  const ulen = Math.sqrt(ux * ux + uy * uy + uz * uz) || 1;
  out.ux = ux / ulen;
  out.uy = uy / ulen;
  out.uz = uz / ulen;

  // A heading hint, or any direction not parallel to up.
  let fx = body.fwdX ?? 0;
  let fy = body.fwdY ?? 0;
  let fz = body.fwdZ ?? 1;
  // Remove the part along up, which is what makes the result orthonormal.
  const along = fx * out.ux + fy * out.uy + fz * out.uz;
  fx -= out.ux * along;
  fy -= out.uy * along;
  fz -= out.uz * along;
  let flen = Math.sqrt(fx * fx + fy * fy + fz * fz);
  if (flen < 1e-6) {
    // The hint was parallel to up: any perpendicular will do, so take the world axis
    // that up leans on least.
    if (Math.abs(out.ux) < 0.9) {
      fx = 1 - out.ux * out.ux;
      fy = -out.uy * out.ux;
      fz = -out.uz * out.ux;
    } else {
      fx = -out.ux * out.uz;
      fy = -out.uy * out.uz;
      fz = 1 - out.uz * out.uz;
    }
    flen = Math.sqrt(fx * fx + fy * fy + fz * fz) || 1;
  }
  out.fx = fx / flen;
  out.fy = fy / flen;
  out.fz = fz / flen;
  // right = forward x up, so the three form a consistent hand.
  out.rx = out.fy * out.uz - out.fz * out.uy;
  out.ry = out.fz * out.ux - out.fx * out.uz;
  out.rz = out.fx * out.uy - out.fy * out.ux;
  out.tilted = true;
  return out;
}

/** Scratch for `bodyBounds`; the tick may not allocate. */
const boundsFrame = createBodyFrame();
