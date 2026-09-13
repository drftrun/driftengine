import { ColliderSet } from '../colliderSet.ts';
import type { ConvexShape } from '../shape.ts';
import type { Axis, Body, BodyFrame, BodyPart } from './body.ts';
import {
  AXIS_X,
  AXIS_Y,
  AXIS_Z,
  bodyBounds,
  bodyFrame,
  createBodyBounds,
  createBodyFrame,
} from './body.ts';
import { hits } from './scratch.ts';

/**
 * The sweep: movement resolved one axis at a time against static obstacles.
 *
 * Exact, branch-cheap, allocation-free and deterministic, which is what lets a stored replay
 * reproduce a run (AGENTS.md, "Determinism").
 */

/** Gap preserved between body and obstacle so faces never interpenetrate. */
const SKIN = 0.001;
/** Shrink applied to cross-axis overlap tests to avoid phantom edge catches. */
const SHRINK = 0.0005;

/*
 * The pair currently being swept, held at module scope so the per-axis work
 * carries no arguments and allocates nothing. `sweepShapePair` owns this state;
 * nothing else reads it.
 */
let swBodyShape: ConvexShape | undefined;
let swColShape: ConvexShape | undefined;
let swBody: Body;
let swFrame: BodyFrame;
let swPx = 0;
let swPy = 0;
let swPz = 0;
let swMinX = 0;
let swMinY = 0;
let swMinZ = 0;
let swMaxX = 0;
let swMaxY = 0;
let swMaxZ = 0;
let swTx = 0;
let swTy = 0;
let swTz = 0;
/** Travel window: the pair touches only while every axis window is open at once. */
let winEnter = 0;
let winExit = 0;
/**
 * Whether the axis that decided `winEnter` is a *support* contact: its plane
 * horizontal enough to stand on, with the body arriving from above. The bound
 * is deliberately below any floor/wall line a caller enforces (cos 70° = 0.34),
 * so the engine never claims support on a face the game would call a wall.
 */
let winSupport = true;
/**
 * The outward direction of the axis that decided `winEnter` — from the obstacle
 * toward the body. Companion to `winSupport`, which is a boolean about the same
 * contact; see `Body.contactNormalX`.
 */
let winNx = 0;
let winNy = 0;
let winNz = 0;
const SUPPORT_NY = 0.3;
/** Projection intervals written by the project helpers. */
let colLo = 0;
let colHi = 0;
let bodLo = 0;
let bodHi = 0;

/** Project the collider onto an axis: its shape's points, or its box analytically. */
function projectCollider(nx: number, ny: number, nz: number): void {
  const shape = swColShape;
  if (shape === undefined) {
    const centre =
      (swMinX + swMaxX) * 0.5 * nx + (swMinY + swMaxY) * 0.5 * ny + (swMinZ + swMaxZ) * 0.5 * nz;
    const reach =
      Math.abs(nx) * (swMaxX - swMinX) * 0.5 +
      Math.abs(ny) * (swMaxY - swMinY) * 0.5 +
      Math.abs(nz) * (swMaxZ - swMinZ) * 0.5;
    colLo = centre - reach;
    colHi = centre + reach;
    return;
  }
  const v = shape.vertices;
  let lo = Infinity;
  let hi = -Infinity;
  for (let i = 0; i < v.length; i += 3) {
    const d = (v[i] ?? 0) * nx + (v[i + 1] ?? 0) * ny + (v[i + 2] ?? 0) * nz;
    if (d < lo) lo = d;
    if (d > hi) hi = d;
  }
  const grow = shape.radius + discGrowth(shape, nx, ny, nz);
  colLo = lo - grow;
  colHi = hi + grow;
}

/**
 * How far a cylinder's disc rounding reaches along an axis, given in the shape's own coordinates.
 *
 * `sideRadius` grows a shape perpendicular to the segment through its first two points, so along a
 * direction `n` it reaches `sideRadius * sqrt(1 - (n · axis)^2)` — the full radius across the axis
 * and nothing along it. Zero for every shape that is not a cylinder, which is the common case and
 * costs one compare.
 *
 * **This is the exact half of the cylinder's support**, and the axis list this file folds is the
 * approximate half: the candidate axes come from the two shapes' enumerated features, and a curved
 * side has none. Each axis tested is answered exactly; the set of axes tested is a superset of a
 * box's and still not the whole family a cylinder's side spans. A sweep that tests more axes can
 * only stop a body earlier, so what that costs is a kinematic body stopping slightly short of a
 * cylinder at a glancing angle, never passing through one. `collideShapes` is the exact path and
 * is what the dynamics use.
 */
function discGrowth(
  shape: { readonly sideRadius: number; readonly vertices: Float32Array },
  nx: number,
  ny: number,
  nz: number,
): number {
  if (shape.sideRadius <= 0) return 0;
  const v = shape.vertices;
  const ax = (v[3] ?? 0) - (v[0] ?? 0);
  const ay = (v[4] ?? 0) - (v[1] ?? 0);
  const az = (v[5] ?? 0) - (v[2] ?? 0);
  const length = Math.sqrt(ax * ax + ay * ay + az * az);
  if (length < 1e-9) return shape.sideRadius;
  const along = (ax * nx + ay * ny + az * nz) / length;
  return shape.sideRadius * Math.sqrt(Math.max(0, 1 - along * along));
}

/** Project the body's shape (or its box) onto an axis, through its frame. */
function projectBody(nx: number, ny: number, nz: number): void {
  const f = swFrame;
  const centre = swPx * nx + swPy * ny + swPz * nz;
  const shape = swBodyShape;
  if (shape === undefined) {
    const reach =
      Math.abs(f.rx * nx + f.ry * ny + f.rz * nz) * swBody.hx +
      Math.abs(f.ux * nx + f.uy * ny + f.uz * nz) * swBody.hy +
      Math.abs(f.fx * nx + f.fy * ny + f.fz * nz) * swBody.hz;
    bodLo = centre - reach;
    bodHi = centre + reach;
    return;
  }
  // The axis in the body's own coordinates, so the points stay untransformed.
  const mx = f.rx * nx + f.ry * ny + f.rz * nz;
  const my = f.ux * nx + f.uy * ny + f.uz * nz;
  const mz = f.fx * nx + f.fy * ny + f.fz * nz;
  const v = shape.vertices;
  let lo = Infinity;
  let hi = -Infinity;
  for (let i = 0; i < v.length; i += 3) {
    const d = (v[i] ?? 0) * mx + (v[i + 1] ?? 0) * my + (v[i + 2] ?? 0) * mz;
    if (d < lo) lo = d;
    if (d > hi) hi = d;
  }
  const grow = shape.radius + discGrowth(shape, mx, my, mz);
  bodLo = centre + lo - grow;
  bodHi = centre + hi + grow;
}

/**
 * Fold one candidate separating axis into the travel window.
 *
 * Both shapes project to an interval, and travel slides the body's at a known
 * rate, so overlap on this axis is a window of travel. Returns false when the
 * axis proves the pair can never touch — separated and not closing, or the
 * combined window has emptied.
 */
function foldAxis(nx: number, ny: number, nz: number): boolean {
  const len = nx * nx + ny * ny + nz * nz;
  // Parallel cross products degenerate to nothing; the face axes cover them.
  if (len < 1e-12) return true;
  const inv = 1 / Math.sqrt(len);
  nx *= inv;
  ny *= inv;
  nz *= inv;

  projectCollider(nx, ny, nz);
  projectBody(nx, ny, nz);
  const rate = swTx * nx + swTy * ny + swTz * nz;

  if (rate > -1e-9 && rate < 1e-9) {
    /*
     * Travel does not change this projection: either it always overlaps, or
     * never. Shrunk by SKIN, so a body resting its SKIN gap away from a face —
     * which is exactly where contact leaves it — reads as clear and slides
     * along it instead of catching on every seam.
     */
    return bodHi > colLo + SKIN && bodLo < colHi - SKIN;
  }
  /*
   * Grown by SKIN: contact stops a skin's width short of the face, the same
   * gap the axis-aligned path has always kept. Stopping *at* the face left the
   * body touching it, and a touching body read as "already overlapping" on the
   * next tick — the walk-out rule then waved the same move through, and a
   * character standing on a floor fell through it one tick after landing.
   */
  let s1 = (colLo - SKIN - bodHi) / rate;
  let s2 = (colHi + SKIN - bodLo) / rate;
  if (s1 > s2) {
    const swap = s1;
    s1 = s2;
    s2 = swap;
  }
  if (s1 > winEnter) {
    winEnter = s1;
    /*
     * Which side of this axis the body is on, at the moment of touch. Both
     * projections slide by `rate · s1` on the body's side before comparing.
     *
     * This one test answers two questions. **Support** — the plane is walkably
     * horizontal and the body arrived on top of it, rather than kissing a side, an
     * edge or an underside. And **which way is out**, which is the same fact without
     * the horizontality requirement: a body above the obstacle's interval escapes
     * along `+n`, one below it along `−n`.
     */
    const above = bodLo + rate * s1 >= colHi - SKIN * 4;
    const below = bodHi + rate * s1 <= colLo + SKIN * 4;
    if (ny >= SUPPORT_NY) winSupport = above;
    else if (ny <= -SUPPORT_NY) winSupport = below;
    else winSupport = false;
    /*
     * Neither above nor below means the body straddles the obstacle's interval on
     * this axis, which is what "already interpenetrating" looks like from here. The
     * reverse of the travel direction is then the honest answer: it is the one escape
     * this sweep can actually vouch for.
     */
    if (above) {
      winNx = nx;
      winNy = ny;
      winNz = nz;
    } else if (below) {
      winNx = -nx;
      winNy = -ny;
      winNz = -nz;
    } else {
      winNx = -swTx;
      winNy = -swTy;
      winNz = -swTz;
    }
  }
  if (s2 < winExit) winExit = s2;
  // No travel satisfies every axis at once, so this obstacle is never touched.
  return winEnter <= winExit;
}

/**
 * How far a body — tilted, shaped, or both — may travel along one world axis
 * before it touches an obstacle that may itself be a shape.
 *
 * This replaces growing bounds into a bigger axis-aligned box: a bigger box is
 * solid where the real body is not, so it stops a character short of geometry
 * they can see clear air beside. The volume that collides is the volume that
 * is drawn, on both sides.
 *
 * Separating axes, generalised: each side contributes its face normals (world
 * axes for a plain box, frame axes for a boxy body), and their edge directions
 * cross-multiply for the edge-on-edge cases. A round side has no features and
 * contributes its sweep direction and point-to-corner axes instead. The axis
 * list is fixed per shape pair — enumerated from build-time data, never
 * iterated to a tolerance — so two machines replay the same run bit for bit.
 *
 * Returns the largest travel in `[0, |delta|]` that stays clear, as a
 * magnitude. A pair already overlapping when the move begins is let out rather
 * than trapped, the same rule the axis-aligned path uses — a body put inside
 * geometry by a spawn or a deck rising under it has to be able to walk out.
 */
function sweepShapePair(
  bodyShape: ConvexShape | undefined,
  body: Body,
  f: BodyFrame,
  px: number,
  py: number,
  pz: number,
  colShape: ConvexShape | undefined,
  bMinX: number,
  bMinY: number,
  bMinZ: number,
  bMaxX: number,
  bMaxY: number,
  bMaxZ: number,
  axis: Axis,
  delta: number,
): number {
  const want = Math.abs(delta);
  const dir = delta < 0 ? -1 : 1;
  swBodyShape = bodyShape;
  swColShape = colShape;
  swBody = body;
  swFrame = f;
  swPx = px;
  swPy = py;
  swPz = pz;
  swMinX = bMinX;
  swMinY = bMinY;
  swMinZ = bMinZ;
  swMaxX = bMaxX;
  swMaxY = bMaxY;
  swMaxZ = bMaxZ;
  swTx = axis === AXIS_X ? dir : 0;
  swTy = axis === AXIS_Y ? dir : 0;
  swTz = axis === AXIS_Z ? dir : 0;
  // True entry time, allowed negative: the sign is what tells a body resting
  // against a face (entry ≈ 0, hold it there) from one genuinely inside it
  // (entry well past, let it out).
  winEnter = -Infinity;
  winExit = Infinity;
  winSupport = true;
  winNx = 0;
  winNy = 0;
  winNz = 0;

  // The collider's faces — world axes where it is only its box.
  if (colShape === undefined) {
    if (!foldAxis(1, 0, 0) || !foldAxis(0, 1, 0) || !foldAxis(0, 0, 1)) return want;
  } else {
    const fn = colShape.faceNormals;
    for (let i = 0; i < fn.length; i += 3) {
      if (!foldAxis(fn[i] ?? 0, fn[i + 1] ?? 0, fn[i + 2] ?? 0)) return want;
    }
  }

  // The body's faces, rotated into the world — frame axes where it is only its box.
  if (bodyShape === undefined) {
    if (!foldAxis(f.rx, f.ry, f.rz) || !foldAxis(f.ux, f.uy, f.uz) || !foldAxis(f.fx, f.fy, f.fz)) {
      return want;
    }
  } else {
    const fn = bodyShape.faceNormals;
    for (let i = 0; i < fn.length; i += 3) {
      const lx = fn[i] ?? 0;
      const ly = fn[i + 1] ?? 0;
      const lz = fn[i + 2] ?? 0;
      if (
        !foldAxis(
          f.rx * lx + f.ux * ly + f.fx * lz,
          f.ry * lx + f.uy * ly + f.fy * lz,
          f.rz * lx + f.uz * ly + f.fz * lz,
        )
      ) {
        return want;
      }
    }
  }

  // Edge crosses. A round side has no edges; its direction of travel stands in,
  // which is exactly the axis a rolling contact needs.
  const colEdges = colShape === undefined ? 3 : Math.max(1, colShape.edgeDirs.length / 3);
  const bodyEdges = bodyShape === undefined ? 3 : Math.max(1, bodyShape.edgeDirs.length / 3);
  for (let c = 0; c < colEdges; c++) {
    let cx: number;
    let cy: number;
    let cz: number;
    if (colShape === undefined) {
      cx = c === 0 ? 1 : 0;
      cy = c === 1 ? 1 : 0;
      cz = c === 2 ? 1 : 0;
    } else if (colShape.edgeDirs.length === 0) {
      cx = swTx;
      cy = swTy;
      cz = swTz;
    } else {
      cx = colShape.edgeDirs[c * 3] ?? 0;
      cy = colShape.edgeDirs[c * 3 + 1] ?? 0;
      cz = colShape.edgeDirs[c * 3 + 2] ?? 0;
    }
    for (let b = 0; b < bodyEdges; b++) {
      let ex: number;
      let ey: number;
      let ez: number;
      if (bodyShape === undefined) {
        ex = b === 0 ? f.rx : b === 1 ? f.ux : f.fx;
        ey = b === 0 ? f.ry : b === 1 ? f.uy : f.fy;
        ez = b === 0 ? f.rz : b === 1 ? f.uz : f.fz;
      } else if (bodyShape.edgeDirs.length === 0) {
        ex = swTx;
        ey = swTy;
        ez = swTz;
      } else {
        const lx = bodyShape.edgeDirs[b * 3] ?? 0;
        const ly = bodyShape.edgeDirs[b * 3 + 1] ?? 0;
        const lz = bodyShape.edgeDirs[b * 3 + 2] ?? 0;
        ex = f.rx * lx + f.ux * ly + f.fx * lz;
        ey = f.ry * lx + f.uy * ly + f.fy * lz;
        ez = f.rz * lx + f.uz * ly + f.fz * lz;
      }
      if (!foldAxis(cy * ez - cz * ey, cz * ex - cx * ez, cx * ey - cy * ex)) return want;
    }
  }

  // A round body meets corners the face axes cannot see: point-to-centre axes.
  // A cylinder counts as round here too: its side is curved, and the corner axes below are the
  // only ones that see a curved surface at all. More axes can only stop a body earlier.
  const bodyRound =
    bodyShape !== undefined && (bodyShape.faceNormals.length === 0 || bodyShape.sideRadius > 0);
  const colRound =
    colShape !== undefined && (colShape.faceNormals.length === 0 || colShape.sideRadius > 0);
  if (bodyRound) {
    if (colShape === undefined) {
      for (let i = 0; i < 8; i++) {
        const vx = i & 1 ? swMaxX : swMinX;
        const vy = i & 2 ? swMaxY : swMinY;
        const vz = i & 4 ? swMaxZ : swMinZ;
        if (!foldAxis(vx - px, vy - py, vz - pz)) return want;
      }
    } else {
      const v = colShape.vertices;
      for (let i = 0; i < v.length; i += 3) {
        if (!foldAxis((v[i] ?? 0) - px, (v[i + 1] ?? 0) - py, (v[i + 2] ?? 0) - pz)) return want;
      }
    }
    if (colRound && !foldAxis(swTx, swTy, swTz)) return want;
  }
  if (colRound && !bodyRound) {
    const cx = colShape.vertices[0] ?? 0;
    const cy = colShape.vertices[1] ?? 0;
    const cz = colShape.vertices[2] ?? 0;
    if (bodyShape === undefined) {
      for (let i = 0; i < 8; i++) {
        const sx = i & 1 ? body.hx : -body.hx;
        const sy = i & 2 ? body.hy : -body.hy;
        const sz = i & 4 ? body.hz : -body.hz;
        const wx = px + f.rx * sx + f.ux * sy + f.fx * sz;
        const wy = py + f.ry * sx + f.uy * sy + f.fy * sz;
        const wz = pz + f.rz * sx + f.uz * sy + f.fz * sz;
        if (!foldAxis(cx - wx, cy - wy, cz - wz)) return want;
      }
    } else {
      const v = bodyShape.vertices;
      for (let i = 0; i < v.length; i += 3) {
        const lx = v[i] ?? 0;
        const ly = v[i + 1] ?? 0;
        const lz = v[i + 2] ?? 0;
        const wx = px + f.rx * lx + f.ux * ly + f.fx * lz;
        const wy = py + f.ry * lx + f.uy * ly + f.fy * lz;
        const wz = pz + f.rz * lx + f.uz * ly + f.fz * lz;
        if (!foldAxis(cx - wx, cy - wy, cz - wz)) return want;
      }
    }
  }

  // Nothing constrained the travel at all.
  if (winEnter === -Infinity) return want;
  /*
   * Genuinely inside when the move begins — a spawn, a deck risen underneath —
   * is let out rather than trapped; that has always been the rule. The
   * threshold placement is load-bearing: a body at rest sits a skin short of
   * the face, so its next identical move computes an entry of exactly −SKIN.
   * A threshold at −SKIN put the resting state on the boundary and let
   * floating point decide, tick by tick, whether the floor existed — measured
   * as the character falling through the world one tick after landing. Two skins
   * puts rest a full skin inside the held band; only real interpenetration
   * beyond that opens the way out.
   */
  if (winEnter < -SKIN * 2) {
    /*
     * **Out is allowed. *Anywhere* is not, and that difference is the whole of this.**
     *
     * This returned the full travel, unconditionally, which reads as "a body that is already
     * inside something is not constrained by it" — and that is exactly what it did. A character
     * whose body had ended up inside a column could walk straight on through it and out the far
     * side, because every move it asked for was granted in full. Reported over and over as
     * *"the character sometimes pass though"*, and it is the same defect behind the rest of
     * that family: a move nothing clamps leaves `contactSupport` at the `true` it starts with,
     * so the body is told it is standing, and every backstop a consumer has is waiting for a
     * refusal that never comes.
     *
     * Measured on a capture between two courtyard pillars 0.41 m apart with a body 0.70 m wide
     * overlapping both: held forward carried it clean across their span and off the world.
     *
     * The overlap runs from `winEnter` to `winExit` along the direction of travel, so the body
     * leaves in `winExit` going forward and in `-winEnter` going back. Travelling toward the
     * nearer of the two is coming out; travelling toward the further one is going deeper. Only
     * the first is granted, and it is granted whole, so nothing is ever sealed in: whichever
     * way is shortest is always open.
     *
     * `winExit` is `Infinity` where nothing ahead bounds the overlap at all, which is not a way
     * out and compares as one that never arrives.
     *
     * **Held to a body whose middle is between this obstacle's floor and its lid**, which is the
     * same test `ejectFromSolid` is gated on and for the same reason: it separates being *in* a
     * solid from the shallow overlaps ordinary play is full of. A collider is sunk under the
     * surface it draws, so a character standing on one has its feet inside the box by design; a
     * skate corner clips the flank of a slab in passing. Neither is burial, both compute an
     * entry past the threshold above, and restricting either costs mobility where there was
     * never a wall — measured as a character perched on a rim taking 1.77 s to come off it instead
     * of 0.20 s, because a two-centimetre graze on a neighbouring box was being treated as a
     * solid to be respected.
     */
    /*
     * **Horizontal travel only, and gravity is why.**
     *
     * "The nearer exit is the way out" is a statement about *passing through* something, and
     * passing through is a horizontal idea here. Applied to a falling body it says the opposite
     * of what it means: a body overlapping the flank of a tall wall by a few centimetres has its
     * shortest exit *upward*, so descending reads as taking the long way and the fall is refused.
     * A body pinched between two walls then hangs in clear air for ever, which is the failure
     * this whole rule exists to end rather than one to introduce. Measured on the smallest case
     * that shows it — two walls closer together than the body is wide — as zero metres of descent
     * in five seconds.
     *
     * A body buried under something has `ejectFromSolid` for the vertical, which knows to prefer
     * up and knows how to clear every overlap at once. Nothing needs this axis, and everything
     * that falls needs it left alone.
     */
    /*
     * **And a ceiling counts as something you are inside, which the middle test alone cannot
     * see.**
     *
     * The test above asks whether the body's *centre* is between this obstacle's floor and its
     * lid, and for anything a body stands on or squeezes between that is exactly right. It is
     * blind to the one arrangement where the body is under the obstacle rather than in it: a
     * deck overhead, low enough that the character's *head* is inside it while the centre is still
     * below the deck's floor. The gate reads false, the rule declines, and the full travel is
     * granted — so the deck stops existing for the whole body, not merely for the head.
     *
     * Measured where a route crosses over itself with 1.75 m of clearance for a 1.70 m body:
     * standing normally on the lower deck, the head is already 0.148 m inside the upper one,
     * and from there `moveAxis` delivers a **full metre** of travel further in against **zero**
     * resistance. What that costs is not a clipped head. It is everything downstream — the
     * character walks on into a pocket, the rescues push them deeper because nothing pushes back,
     * and they come to rest sealed on all six axes with 0.3 mm of headroom. Reported as *"even
     * if the head cannot physically pass through, I'm able to go inside and get stuck"* and
     * *"I shouldn't be able to ENTER there"*.
     *
     * `swMinY >= swBody.y` is the whole of it: an obstacle whose floor is at or above the body's
     * middle is over the body, not under it. Nothing a body rests on can satisfy it, so every
     * surface in the world is untouched — and this is reached only when the travel direction
     * shows real interpenetration in the first place.
     *
     * What it grants is unchanged and is the point: the nearer exit is still open and still
     * whole, so a body under a deck can always back out the way it came. Only going further in
     * is refused.
     */
    if (axis !== AXIS_Y && ((swBody.y > swMinY && swBody.y < swMaxY) || swMinY >= swBody.y)) {
      return winExit <= -winEnter ? want : 0;
    }
    return want;
  }
  if (winEnter >= want) return want;
  return winEnter > 0 ? winEnter : 0;
}

/** Scratch for `moveAxis` and `bodyBounds`; the tick may not allocate. */
const sweepBounds = createBodyBounds();
const sweepFrame = createBodyFrame();

/**
 * Move `body` along one axis by up to `delta`, clamped by the first obstacle.
 * Returns the distance actually moved (compare with `delta` to detect a hit).
 */

/**
 * How far past one span's edge a coordinate sits, as a sign: -1 below, +1 above, 0 inside.
 *
 * The direction that takes a body **further off** the face it is perched on the rim of, which
 * is the one thing a caller cannot work out from a contact normal: a rim perch's normal points
 * straight up, because up really is the way out of the clamp. Off is sideways, and only the
 * sweep knows which sideways, because only the sweep saw the obstacle's footprint.
 */

/**
 * Is this column standing over the obstacle itself, rather than merely over its bounding box?
 *
 * **The box is the answer only for a box, and this used to give it for everything.** Support asks
 * whether the body's own column is over the thing holding it up, and a bounding box stands in for
 * the footprint — which is exact for an axis-aligned collider and enormously wrong for a diagonal
 * one. A ribbon's deck is tiled with wedges whose top face is the drawn triangle; a wedge lying
 * across the world axes has a box several times its own area, and every column inside that box was
 * being called standing.
 *
 * What that produced is a walkable ledge in every cut in a deck. A body landing at the mouth of a
 * gap catches the deck's last wedge with the edge of its shoulder, its centre a quarter of a metre
 * out over the hole — and was told it was standing, so nothing slid it off and nothing let it
 * fall. Measured on one route's day 23: a band about a metre wide over an authored gap where a
 * body lands, reports grounded, and stays for ever, resting one collider give below a deck the
 * surface correctly says is not there.
 *
 * For a convex volume the column hits it exactly when the point is inside the shape's shadow on
 * the ground plane, and the faces with a horizontal normal are what bound that shadow — a wedge's
 * sides, a slab's flanks. Faces looking up or down bound nothing there and are skipped, which is
 * also what keeps this from rejecting the middle of a perfectly ordinary lid.
 *
 * Once per move rather than once per candidate: only the obstacle that actually clamped the move
 * has any say in whether the body is standing on something.
 */
function overFootprint(
  x: number,
  z: number,
  shape: ConvexShape | undefined,
  minX: number,
  maxX: number,
  minZ: number,
  maxZ: number,
): boolean {
  if (shape === undefined) {
    footprintOutX = rimOut(x, minX, maxX);
    footprintOutZ = rimOut(z, minZ, maxZ);
    return footprintOutX === 0 && footprintOutZ === 0;
  }
  const normals = shape.faceNormals;
  const vertices = shape.vertices;
  /* A shape's own rounding widens its shadow, and a sphere has no faces at all to bound one. */
  const grow = shape.radius;
  let worstPast = -Infinity;
  footprintOutX = 0;
  footprintOutZ = 0;
  for (let i = 0; i < normals.length; i += 3) {
    const nx = normals[i] ?? 0;
    const nz = normals[i + 2] ?? 0;
    const length = Math.sqrt(nx * nx + nz * nz);
    /* Looking up or down: it bounds the volume, not its shadow. */
    if (length < FOOTPRINT_MIN_HORIZONTAL) continue;
    const ux = nx / length;
    const uz = nz / length;
    /*
     * **Both ends of the line, because that is how the list is stored.**
     *
     * `faceNormals` holds one entry per *direction* — a normal and its opposite appear once
     * between them — so a slab has three entries and not six. Testing only `dot <= max` bounds
     * one side of each and leaves the other open, which is not a small error: it left the far
     * end and one flank of every deck unbounded, so a column past them was still called standing
     * and the ledge this exists to remove survived the fix meant to remove it.
     */
    let high = -Infinity;
    let low = Infinity;
    for (let v = 0; v < vertices.length; v += 3) {
      const reach = ux * (vertices[v] ?? 0) + uz * (vertices[v + 2] ?? 0);
      if (reach > high) high = reach;
      if (reach < low) low = reach;
    }
    const here = ux * x + uz * z;
    const pastHigh = here - high - grow;
    if (pastHigh > worstPast) {
      /* The face the column is furthest outside is the one it fell off, so its outward normal
         is the way further off — which is what a caller with nothing to stand on needs. */
      worstPast = pastHigh;
      footprintOutX = ux;
      footprintOutZ = uz;
    }
    const pastLow = low - grow - here;
    if (pastLow > worstPast) {
      worstPast = pastLow;
      footprintOutX = -ux;
      footprintOutZ = -uz;
    }
  }
  return worstPast <= 0;
}

/**
 * Is anything at all under this column at the height the body came to rest?
 *
 * **`overFootprint` answers about one collider; this answers about the floor.** Support is asked
 * of the obstacle that won the clamp, which is exact for a floor made of a single thing and wrong
 * everywhere two colliders abut to make one. A body straddling the join is inside both, and the
 * one that wins is not always the one its centre is over: the box *behind* it wins as readily as
 * the box in front, and then the column is outside the winner's footprint by construction, with a
 * rim that points back the way the body came.
 *
 * What that costs is not a stumble. `contactSupport` is a body's grounding, so a false refusal
 * takes the jump, keeps re-clamping the fall, and hands the consumer a direction to push the body
 * in — and pushing it *back over the join* re-arms the refusal on the next tick. Captured on the
 * back edge of a terrace, where one collider ends at z = 9.4046 and the strip behind it begins:
 * the body accelerates across the join for five ticks, is shoved back 0.06 m with its velocity
 * replaced, and does it again for as long as the key is held. Net progress zero, on flat ground,
 * with nothing drawn there. A jump clears it because a body in the air has no downward clamp to
 * be refused.
 *
 * The height test is what keeps this from becoming "always say yes". A candidate counts as the
 * floor the body is on only if its lid is at the height the body actually came to rest, so a
 * lower deck below a ledge is still a drop and the rim perch this whole test exists to refuse is
 * refused exactly as before: over a hole there is nothing to find. There is deliberately no upper
 * bound — a lid *above* the resting height belongs to something the body is inside rather than on,
 * which is `ejectFromSolid`'s question, and shoving such a body sideways off a rim it is not on is
 * the wrong answer to it.
 *
 * Runs only where the winner already said no, so the common path pays nothing for it, and it
 * reads the same query the sweep already made rather than making another.
 */
function columnOverFloor(body: Body, boxes: ColliderSet, count: number, restY: number): boolean {
  const data = boxes.data;
  for (let h = 0; h < count; h++) {
    const index = hits[h] ?? 0;
    const o = index * 6;
    /* Below the feet by more than a join's worth: a floor, but not this one. */
    if ((data[o + 4] ?? 0) < restY - FLOOR_JOIN) continue;
    if (
      overFootprint(
        body.x,
        body.z,
        boxes.shapeAt(index),
        data[o] ?? 0,
        data[o + 3] ?? 0,
        data[o + 2] ?? 0,
        data[o + 5] ?? 0,
      )
    ) {
      return true;
    }
  }
  return false;
}

/**
 * How far below the body's feet a lid may be and still be the same floor.
 *
 * Two colliders authored to meet share a lid height exactly, and a body clamped by one rests a
 * `SKIN` above it, so the whole question is decided inside a few thousandths of a metre. Four
 * skins is room for that and for the float noise of a world built hundreds of metres from the
 * origin, and it is far under any step a character would have to fall to.
 */
const FLOOR_JOIN = SKIN * 4;

/**
 * How far above the sole a contact may be and still count as underfoot, as a fraction of the
 * body's half-height.
 *
 * Roughly ankle height on a standing character — 0.26 m on a 1.70 m body — and expressed
 * against the body rather than in metres, because what counts as *underfoot* is a fact about
 * the body and not about the world. A compound character's feet and the legs immediately above
 * them fall inside it; its chest and its head do not, and those are the ones this exists to
 * refuse.
 */
const UNDERFOOT_BAND = 0.3;

/**
 * The lowest point of one part, along the body's own up, in body space.
 *
 * A shape's `vertices` are its local hull and its `radius` is rounding grown around them, so the
 * sole of a rounded skate sits a radius below its lowest vertex. Called only on a downward move
 * by a body made of parts: four parts of eight points on the character this was measured for.
 */
function partFloor(part: BodyPart): number {
  const v = part.shape.vertices;
  let lowest = Infinity;
  for (let i = 1; i < v.length; i += 3) {
    const y = v[i] ?? 0;
    if (y < lowest) lowest = y;
  }
  return (lowest === Infinity ? 0 : lowest) + part.oy - part.shape.radius;
}

/**
 * Which way is *off* the shape whose shadow `overFootprint` last found a column outside.
 *
 * Written by that call and read straight after it, in the one place both run. A pair of module
 * scratch values rather than an out parameter, because this sits in the tick and the house rules
 * allow no allocation there.
 */
let footprintOutX = 0;
let footprintOutZ = 0;

/**
 * How much horizontal a face normal needs before it says anything about the shadow.
 *
 * A deck's lid is not exactly level — it banks and it climbs — so a threshold of zero would let
 * the lid's own slight lean bound the footprint and cut a walkable surface down to a sliver of
 * itself. A fifth is well past any lid a character can stand on (`MIN_GROUND_NORMAL_Y` is cos 70°,
 * whose horizontal part is 0.94) and well under any side face worth bounding with.
 */
const FOOTPRINT_MIN_HORIZONTAL = 0.2;

function rimOut(centre: number, min: number, max: number): number {
  if (centre < min) return -1;
  if (centre > max) return 1;
  return 0;
}

export function moveAxis(body: Body, boxes: ColliderSet, axis: Axis, delta: number): number {
  if (delta === 0) return 0;

  /*
   * The body's *oriented* bounds, not its nominal half-extents. A body lying along a
   * banked deck occupies a taller, wider column than an upright one, and resolving it
   * against the smaller box is what let a drawn body reach into solid geometry.
   */
  const bounds = bodyBounds(body, sweepBounds);
  const frame = bodyFrame(body, sweepFrame);
  const minX = body.x - bounds.hx;
  const maxX = body.x + bounds.hx;
  const minY = body.y - bounds.hy;
  const maxY = body.y + bounds.hy;
  const minZ = body.z - bounds.hz;
  const maxZ = body.z + bounds.hz;

  // Sweep region: the body's box grown along the axis of travel, so nothing
  // the move could reach is ever missed.
  const count = boxes.query(
    axis === AXIS_X && delta < 0 ? minX + delta : minX,
    axis === AXIS_Y && delta < 0 ? minY + delta : minY,
    axis === AXIS_Z && delta < 0 ? minZ + delta : minZ,
    axis === AXIS_X && delta > 0 ? maxX + delta : maxX,
    axis === AXIS_Y && delta > 0 ? maxY + delta : maxY,
    axis === AXIS_Z && delta > 0 ? maxZ + delta : maxZ,
    hits,
  );
  const data = boxes.data;
  /*
   * Where this body's soles are, in its own space: the floor of its lowest part, so a contact
   * can be asked whether the body met it with something it stands on. Computed once here rather
   * than per candidate, and only where the question is asked at all — a downward move by a body
   * made of parts.
   */
  const soleParts = axis === AXIS_Y && delta <= 0 ? body.parts : undefined;
  let soleFloor = Infinity;
  if (soleParts !== undefined) {
    for (let p = 0; p < soleParts.length; p++) {
      const part = soleParts[p];
      if (part === undefined) continue;
      const floor = partFloor(part);
      if (floor < soleFloor) soleFloor = floor;
    }
  }
  // Support of the contact that finally clamps the move; true when unblocked.
  let clampSupport = true;
  /*
   * The obstacle that won the clamp, kept rather than judged on the spot.
   *
   * Whether a contact is *support* is a question about the winner alone, and asking it at every
   * candidate meant asking it several times a move and throwing all but one answer away — which
   * mattered less than the fact that it could only be asked of a box. Kept here, it can be asked
   * of the real volume once. See `overFootprint`.
   */
  let clampWalkable = true;
  let clampShape: ConvexShape | undefined;
  let clampMinX = 0;
  let clampMaxX = 0;
  let clampMinZ = 0;
  let clampMaxZ = 0;
  /*
   * And which way is *off* it, when a downward contact is a walkable plane the body's own
   * column is not over — the rim perch `clampSupport` exists to refuse. Zero when the refusal
   * had another reason, or when there was no refusal. See `Body.contactRimX`.
   */
  let clampRimX = 0;
  let clampRimZ = 0;
  // And which way is out of it. Zero until something actually clamps the move.
  let clampNx = 0;
  let clampNy = 0;
  let clampNz = 0;

  for (let h = 0; h < count; h++) {
    const index = hits[h] ?? 0;
    const o = index * 6;
    const bMinX = data[o] ?? 0;
    const bMinY = data[o + 1] ?? 0;
    const bMinZ = data[o + 2] ?? 0;
    const bMaxX = data[o + 3] ?? 0;
    const bMaxY = data[o + 4] ?? 0;
    const bMaxZ = data[o + 5] ?? 0;
    const colShape = boxes.shapeAt(index);

    /*
     * Anything with a real volume on either side — a tilted body, a shaped
     * body, a shaped obstacle — is resolved by sweeping the volumes, not by
     * growing axis-aligned boxes around them. The bounds above are the broad
     * phase; `sweepShapePair` is the answer, so a body is stopped by exactly
     * the geometry it would really touch and by nothing else.
     */
    if (
      frame.tilted ||
      colShape !== undefined ||
      body.shape !== undefined ||
      body.parts !== undefined
    ) {
      let room = Math.abs(delta);
      /*
       * The frame rotates about the body's pivot (its feet, for a standing
       * character), so the world position of anything local is
       * `pos + pivot + R·(local − pivot)` — for the upright frame that is
       * exactly `pos + local`, unchanged.
       */
      const pivotY = body.pivotY ?? 0;
      const baseX = body.x - frame.rx * 0 - frame.ux * pivotY;
      const baseY = body.y + pivotY - frame.uy * pivotY;
      const baseZ = body.z - frame.uz * pivotY;
      const parts = body.parts;
      if (parts !== undefined && parts.length > 0) {
        // A compound body is the nearest contact any of its parts makes.
        for (let p = 0; p < parts.length; p++) {
          const part = parts[p];
          if (part === undefined) continue;
          /*
           * **A part that is not a foot may collide, but it may not hold the body up.**
           *
           * Nothing here stands on its chest. A compound character caught on a deck's edge by
           * the torso — whose box carries the arms — hangs there with its skates a full metre
           * clear of anything, and every rule downstream believes it: the contact plane is
           * walkable, the column is over solid ground, so the body is *standing*, and it stays
           * standing for as long as the player leaves it. Measured at the reporter's own
           * capture as the whole body's fall clamping at **0.0000 m** while the skates alone
           * fall **1.1106 m**, and reported as being *"magnetized in the mid part of the
           * body"* — with a screenshot of an arm resting on the rim, and the reading that
           * settles it: *"it may collide but they should just slip, we don't have any hand
           * holding feature."*
           *
           * So on the way *down* only the feet answer. Sideways every part still collides
           * exactly as before — an arm cannot pass through a deck — and a fall simply carries
           * on past whatever the upper body brushes until something is under the soles. The
           * band is `UNDERFOOT_BAND`, which admits the legs immediately above the skates and
           * nothing higher.
           *
           * Plain and single-shape bodies never reach this: `soleParts` is set only for a
           * downward move by a body made of parts.
           */
          if (soleParts !== undefined && partFloor(part) - soleFloor > body.hy * UNDERFOOT_BAND) {
            continue;
          }
          const px = baseX + frame.rx * part.ox + frame.ux * part.oy + frame.fx * part.oz;
          const py = baseY + frame.ry * part.ox + frame.uy * part.oy + frame.fy * part.oz;
          const pz = baseZ + frame.rz * part.ox + frame.uz * part.oy + frame.fz * part.oz;
          // A part nowhere near this obstacle, even after the whole move,
          // costs six compares instead of an axis sweep.
          const pr = part.shape.boundRadius + Math.abs(delta);
          if (
            px + pr < bMinX ||
            px - pr > bMaxX ||
            py + pr < bMinY ||
            py - pr > bMaxY ||
            pz + pr < bMinZ ||
            pz - pr > bMaxZ
          ) {
            continue;
          }
          const r = sweepShapePair(
            part.shape,
            body,
            frame,
            px,
            py,
            pz,
            colShape,
            bMinX,
            bMinY,
            bMinZ,
            bMaxX,
            bMaxY,
            bMaxZ,
            axis,
            delta,
          );
          if (r < room) {
            room = r;
            /*
             * Support needs the body's own column over the thing holding it,
             * not only a walkable contact plane: a foot's corner catching the
             * rim of a slab with the body's centre already past the edge is a
             * tip-over, and calling it standing left characters planted in the
             * air a stride past every pad and deck end. The obstacle's bounds
             * stand in for its footprint — conservative for a diagonal slab,
             * exact for the boxes this failure was measured on.
             */
            clampWalkable = winSupport;
            clampShape = colShape;
            clampMinX = bMinX;
            clampMaxX = bMaxX;
            clampMinZ = bMinZ;
            clampMaxZ = bMaxZ;
            clampNx = winNx;
            clampNy = winNy;
            clampNz = winNz;
          }
        }
      } else {
        const r = sweepShapePair(
          body.shape,
          body,
          frame,
          baseX,
          baseY,
          baseZ,
          colShape,
          bMinX,
          bMinY,
          bMinZ,
          bMaxX,
          bMaxY,
          bMaxZ,
          axis,
          delta,
        );
        if (r < room) {
          room = r;
          clampWalkable = winSupport;
          clampShape = colShape;
          clampMinX = bMinX;
          clampMaxX = bMaxX;
          clampMinZ = bMinZ;
          clampMaxZ = bMaxZ;
          clampNx = winNx;
          clampNy = winNy;
          clampNz = winNz;
        }
      }
      if (room < Math.abs(delta)) delta = delta < 0 ? -room : room;
      continue;
    }

    if (axis !== AXIS_X && (maxX - SHRINK <= bMinX || minX + SHRINK >= bMaxX)) continue;
    if (axis !== AXIS_Y && (maxY - SHRINK <= bMinY || minY + SHRINK >= bMaxY)) continue;
    if (axis !== AXIS_Z && (maxZ - SHRINK <= bMinZ || minZ + SHRINK >= bMaxZ)) continue;

    const bodyMin = axis === AXIS_X ? minX : axis === AXIS_Y ? minY : minZ;
    const bodyMax = axis === AXIS_X ? maxX : axis === AXIS_Y ? maxY : maxZ;
    const boxMin = axis === AXIS_X ? bMinX : axis === AXIS_Y ? bMinY : bMinZ;
    const boxMax = axis === AXIS_X ? bMaxX : axis === AXIS_Y ? bMaxY : bMaxZ;

    if (delta > 0 && bodyMax <= boxMin + SKIN) {
      const room = boxMin - bodyMax - SKIN;
      if (room < delta) {
        delta = room > 0 ? room : 0;
        /*
         * On this path the clamp is always against the move axis's own face, so out
         * is simply back the way the body came. No separating-axis search is
         * involved and none is needed.
         */
        clampNx = axis === AXIS_X ? -1 : 0;
        clampNy = axis === AXIS_Y ? -1 : 0;
        clampNz = axis === AXIS_Z ? -1 : 0;
      }
    } else if (delta < 0 && bodyMin >= boxMax - SKIN) {
      const room = boxMax - bodyMin + SKIN;
      if (room > delta) {
        delta = room < 0 ? room : 0;
        clampNx = axis === AXIS_X ? 1 : 0;
        clampNy = axis === AXIS_Y ? 1 : 0;
        clampNz = axis === AXIS_Z ? 1 : 0;
        /*
         * **The footprint this clamp will be judged against, which this path never
         * filled in.**
         *
         * The downward report asks `overFootprint` whether the body's column is over
         * whatever stopped it, and it reads these four regardless of which path won the
         * clamp — but only the shape sweep above ever wrote them. A body with no volume
         * of its own therefore had its column tested against a zero-area footprint at
         * the world origin: supported at exactly (0, 0) and refused everywhere else, on
         * a floor with nothing wrong with it, with a rim that was a compass bearing away
         * from the origin rather than a way off anything. Measured on a single flat
         * slab, 400 of 401 columns across a four-metre line.
         *
         * A plain collider's box *is* its footprint, so the four bounds are simply the
         * box, and `clampShape` is cleared because this winner has no shape — a set that
         * holds both hulls and boxes runs both paths in one move, and the shape left
         * behind by a candidate that lost would otherwise be used to judge this one.
         */
        clampWalkable = true;
        clampShape = undefined;
        clampMinX = bMinX;
        clampMaxX = bMaxX;
        clampMinZ = bMinZ;
        clampMaxZ = bMaxZ;
      }
    }
  }

  if (axis === AXIS_X) body.x += delta;
  else if (axis === AXIS_Y) body.y += delta;
  else body.z += delta;
  // Only downward moves get the report: it is the question "am I standing on
  // this", and nothing else asks it. The plain-AABB path clamps against the
  // move axis's own faces, so a block there is support by construction.
  if (axis === AXIS_Y && delta <= 0) {
    if (clampNx !== 0 || clampNy !== 0 || clampNz !== 0) {
      const over = overFootprint(
        body.x,
        body.z,
        clampShape,
        clampMinX,
        clampMaxX,
        clampMinZ,
        clampMaxZ,
      );
      /*
       * The way off, from the same call that decided the body is not on it — read out
       * now, because the floor test below asks the same question of other colliders and
       * each answer overwrites the last.
       */
      const rimX = footprintOutX;
      const rimZ = footprintOutZ;
      /*
       * **The winner is one collider and support is a question about the floor.**
       *
       * Asking only the obstacle that clamped is exact for a floor made of one thing and
       * wrong wherever two colliders abut to make one: the box *behind* the body can win
       * the clamp while the body's centre is already over the box in front, and then the
       * column is outside the winner's footprint by construction, with a rim pointing
       * back the way the body came. Measured on two slabs meeting at a line, 34 of 401
       * columns across the join refused support, in one band as wide as the body and all
       * on the same side of the line — which is what a player feels as a wall they can
       * cross one way and not the other, and can jump over, since a body in the air has
       * no downward clamp to be refused.
       *
       * That is most of the floor in a real world rather than an edge case: a terrace
       * against its verge, a verge's strips against each other, every deck wedge against
       * the next.
       *
       * So the column is held if *anything* the move could have landed on is under it at
       * the height the body came to rest. The rim perch this test exists to refuse is
       * refused exactly as before, because over a hole there is nothing to find.
       */
      const held = over || columnOverFloor(body, boxes, count, body.y - bounds.hy);
      clampSupport = clampWalkable && held;
      clampRimX = clampWalkable && !held ? rimX : 0;
      clampRimZ = clampWalkable && !held ? rimZ : 0;
    }
    body.contactSupport = clampSupport;
    /*
     * Written on the same move that decides support, and cleared when support was granted, so
     * a caller cannot act on a rim it left three ticks ago. See `Body.contactRimX`.
     */
    const rimLength = Math.sqrt(clampRimX * clampRimX + clampRimZ * clampRimZ);
    body.contactRimX = rimLength > 0 ? clampRimX / rimLength : 0;
    body.contactRimZ = rimLength > 0 ? clampRimZ / rimLength : 0;
  }
  /*
   * The way out of whatever clamped this move, for every axis and both directions —
   * unlike `contactSupport`, which is a question only a downward move asks. Written
   * only when something actually clamped, so a caller that checks "was I blocked"
   * first is never handed a stale direction as though it were fresh.
   */
  if (clampNx !== 0 || clampNy !== 0 || clampNz !== 0) {
    const len = Math.sqrt(clampNx * clampNx + clampNy * clampNy + clampNz * clampNz) || 1;
    body.contactNormalX = clampNx / len;
    body.contactNormalY = clampNy / len;
    body.contactNormalZ = clampNz / len;
  }
  return delta;
}
