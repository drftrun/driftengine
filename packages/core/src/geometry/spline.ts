/**
 * An arc-length parameterised curve with a rotation-minimising frame — the
 * spine every banked surface in the engine is built on.
 *
 * Two properties do all the work, and both are the difference between a track
 * and a mess:
 *
 * **Sampled by distance, not by parameter.** A Catmull-Rom curve evaluated at
 * evenly spaced `t` bunches its samples where the curve is tight and stretches
 * them on the straights. A surface built that way has triangles the size of a
 * room on the fast sections and a width that pulses through every bend.
 *
 * **The frame is transported, not recomputed.** Deriving an up-vector from
 * world up at each sample flips it the moment the tangent passes vertical, and
 * the surface turns inside out for one segment — a hole that appears on exactly
 * one shape and is invisible everywhere else. Carrying the frame forward from
 * the previous sample cannot flip, because there is nothing to flip relative to.
 *
 * The engine never learns what this curve is *for*. It takes numbers.
 */
import type { Vec3 } from '../math/color.ts';

export interface SplinePoint {
  x: number;
  y: number;
  z: number;
  /**
   * Roll about the direction of travel, radians. Positive lifts the right-hand
   * edge — the bank of a left-hand corner.
   */
  bankRad: number;
  /** Full width of the surface here, metres. */
  widthM: number;
}

/**
 * One evaluated point. Written into by `sampleAt`, never returned, because this
 * runs inside the fixed tick.
 */
export interface SplineSample {
  x: number;
  y: number;
  z: number;
  /** Unit direction of travel. */
  tangentX: number;
  tangentY: number;
  tangentZ: number;
  /** Unit surface up, after banking. */
  normalX: number;
  normalY: number;
  normalZ: number;
  /** Unit across-surface, after banking. Points to the character's right. */
  rightX: number;
  rightY: number;
  rightZ: number;
  bankRad: number;
  widthM: number;
}

export function createSplineSample(): SplineSample {
  return {
    x: 0,
    y: 0,
    z: 0,
    tangentX: 1,
    tangentY: 0,
    tangentZ: 0,
    normalX: 0,
    normalY: 1,
    normalZ: 0,
    rightX: 0,
    rightY: 0,
    rightZ: 1,
    bankRad: 0,
    widthM: 0,
  };
}

/**
 * Target spacing of the internal arc-length table.
 *
 * Fine enough that interpolating the curve parameter within one cell is
 * indistinguishable from solving for it, and coarse enough that a 400 m track
 * costs a few thousand entries.
 */
const TABLE_STEP_M = 0.25;
const MIN_STEPS_PER_SEGMENT = 4;
/** Centripetal parameterisation: the exponent that avoids cusps and loops. */
const KNOT_ALPHA = 0.5;
/** Chord length below which two control points count as the same place. */
const DEGENERATE_CHORD = 1e-6;
/** Parameter offset used for the finite-difference tangent. */
const TANGENT_DU = 1e-3;

/** One component of a centripetal Catmull-Rom, via Barry–Goldman. */
function barryGoldman(
  p0: number,
  p1: number,
  p2: number,
  p3: number,
  t0: number,
  t1: number,
  t2: number,
  t3: number,
  t: number,
): number {
  const a1 = ((t1 - t) * p0 + (t - t0) * p1) / (t1 - t0);
  const a2 = ((t2 - t) * p1 + (t - t1) * p2) / (t2 - t1);
  const a3 = ((t3 - t) * p2 + (t - t2) * p3) / (t3 - t2);
  const b1 = ((t2 - t) * a1 + (t - t0) * a2) / (t2 - t0);
  const b2 = ((t3 - t) * a2 + (t - t1) * a3) / (t3 - t1);
  return ((t2 - t) * b1 + (t - t1) * b2) / (t2 - t1);
}

function smoothstep01(u: number): number {
  return u * u * (3 - 2 * u);
}

export class Spline {
  private readonly px: Float64Array;
  private readonly py: Float64Array;
  private readonly pz: Float64Array;
  private readonly bank: Float64Array;
  private readonly width: Float64Array;
  /** Number of curve segments: one fewer than the control points. */
  private readonly segments: number;

  /**
   * The control points with a reflected phantom at each end, so a segment reads its
   * four points as `ex[s] … ex[s + 3]` with no bounds test and no end case.
   *
   * The reflection is what makes the curve reach its own endpoints rather than
   * stopping one control point short, and it used to be recomputed — with its two
   * branches — inside every evaluation. It is a property of the point list, so it is
   * computed once with the point list.
   */
  private readonly ex: Float64Array;
  private readonly ey: Float64Array;
  private readonly ez: Float64Array;

  /**
   * Centripetal knots per segment, as the three non-zero values: `t0` is always 0.
   *
   * These cost three `hypot`s and three square roots, and they depend only on which
   * segment you are in — never on where you are inside it. Evaluating the curve
   * recomputed them every time regardless, which was the single most expensive thing
   * the engine did: **`sampleAt` alone evaluates three times** (the point, and one
   * either side for the central-difference tangent), so one sample paid for nine of
   * each. The arc-length table is thousands of evaluations per curve, `buildRibbon`
   * is thousands more, and the simulation samples the route every tick.
   *
   * Hoisting them changes no arithmetic: the same expression on the same inputs, run
   * once per segment instead of once per ask.
   */
  private readonly knot1: Float64Array;
  private readonly knot2: Float64Array;
  private readonly knot3: Float64Array;

  /** Arc-length table, in parallel columns. */
  private readonly tableParam: Float64Array;
  private readonly tableDist: Float64Array;
  private readonly tableX: Float64Array;
  private readonly tableY: Float64Array;
  private readonly tableZ: Float64Array;
  private readonly tableUpX: Float64Array;
  private readonly tableUpY: Float64Array;
  private readonly tableUpZ: Float64Array;
  private readonly length: number;

  constructor(points: readonly SplinePoint[]) {
    const count = points.length;
    this.px = new Float64Array(Math.max(count, 1));
    this.py = new Float64Array(Math.max(count, 1));
    this.pz = new Float64Array(Math.max(count, 1));
    this.bank = new Float64Array(Math.max(count, 1));
    this.width = new Float64Array(Math.max(count, 1));
    for (let i = 0; i < count; i++) {
      const p = points[i] as SplinePoint;
      this.px[i] = p.x;
      this.py[i] = p.y;
      this.pz[i] = p.z;
      this.bank[i] = p.bankRad;
      this.width[i] = p.widthM;
    }
    this.segments = Math.max(count - 1, 0);

    // --- Phantom ends and knots -------------------------------------------
    // Four entries even for a curve with no segments, so nothing here can read past
    // its own array. A single point reflects onto itself, which is the same
    // degenerate answer the branched form gave.
    const extended = Math.max(count + 2, 4);
    this.ex = new Float64Array(extended);
    this.ey = new Float64Array(extended);
    this.ez = new Float64Array(extended);
    for (let i = 0; i < count; i++) {
      this.ex[i + 1] = this.px[i] as number;
      this.ey[i + 1] = this.py[i] as number;
      this.ez[i + 1] = this.pz[i] as number;
    }
    if (count < 2) {
      const x = this.px[0] ?? 0;
      const y = this.py[0] ?? 0;
      const z = this.pz[0] ?? 0;
      this.ex.fill(x);
      this.ey.fill(y);
      this.ez.fill(z);
    } else {
      this.ex[0] = 2 * (this.px[0] as number) - (this.px[1] as number);
      this.ey[0] = 2 * (this.py[0] as number) - (this.py[1] as number);
      this.ez[0] = 2 * (this.pz[0] as number) - (this.pz[1] as number);
      const last = count - 1;
      this.ex[count + 1] = 2 * (this.px[last] as number) - (this.px[last - 1] as number);
      this.ey[count + 1] = 2 * (this.py[last] as number) - (this.py[last - 1] as number);
      this.ez[count + 1] = 2 * (this.pz[last] as number) - (this.pz[last - 1] as number);
    }

    this.knot1 = new Float64Array(Math.max(this.segments, 1));
    this.knot2 = new Float64Array(Math.max(this.segments, 1));
    this.knot3 = new Float64Array(Math.max(this.segments, 1));
    for (let s = 0; s < this.segments; s++) {
      // Every gap is floored: a repeated control point would otherwise divide by
      // zero and take the whole track with it.
      const k1 = Math.max(
        Math.hypot(
          (this.ex[s + 1] as number) - (this.ex[s] as number),
          (this.ey[s + 1] as number) - (this.ey[s] as number),
          (this.ez[s + 1] as number) - (this.ez[s] as number),
        ) ** KNOT_ALPHA,
        DEGENERATE_CHORD,
      );
      const k2 =
        k1 +
        Math.max(
          Math.hypot(
            (this.ex[s + 2] as number) - (this.ex[s + 1] as number),
            (this.ey[s + 2] as number) - (this.ey[s + 1] as number),
            (this.ez[s + 2] as number) - (this.ez[s + 1] as number),
          ) ** KNOT_ALPHA,
          DEGENERATE_CHORD,
        );
      this.knot1[s] = k1;
      this.knot2[s] = k2;
      this.knot3[s] =
        k2 +
        Math.max(
          Math.hypot(
            (this.ex[s + 3] as number) - (this.ex[s + 2] as number),
            (this.ey[s + 3] as number) - (this.ey[s + 2] as number),
            (this.ez[s + 3] as number) - (this.ez[s + 2] as number),
          ) ** KNOT_ALPHA,
          DEGENERATE_CHORD,
        );
    }

    // --- Arc-length table -------------------------------------------------
    // Step counts first, so the columns can be sized exactly rather than grown.
    let total = 1;
    const stepsPerSegment = new Int32Array(Math.max(this.segments, 1));
    for (let s = 0; s < this.segments; s++) {
      const chord = Math.hypot(
        (this.px[s + 1] ?? 0) - (this.px[s] ?? 0),
        (this.py[s + 1] ?? 0) - (this.py[s] ?? 0),
        (this.pz[s + 1] ?? 0) - (this.pz[s] ?? 0),
      );
      const steps = Math.max(MIN_STEPS_PER_SEGMENT, Math.ceil(chord / TABLE_STEP_M));
      stepsPerSegment[s] = steps;
      total += steps;
    }

    this.tableParam = new Float64Array(total);
    this.tableDist = new Float64Array(total);
    this.tableX = new Float64Array(total);
    this.tableY = new Float64Array(total);
    this.tableZ = new Float64Array(total);
    this.tableUpX = new Float64Array(total);
    this.tableUpY = new Float64Array(total);
    this.tableUpZ = new Float64Array(total);

    let n = 0;
    let dist = 0;
    let lastX = 0;
    let lastY = 0;
    let lastZ = 0;
    for (let s = 0; s < this.segments; s++) {
      const steps = stepsPerSegment[s] ?? MIN_STEPS_PER_SEGMENT;
      for (let k = s === 0 ? 0 : 1; k <= steps; k++) {
        const u = k / steps;
        this.evaluate(s, u, TEMP);
        if (n > 0) dist += Math.hypot(TEMP[0] - lastX, TEMP[1] - lastY, TEMP[2] - lastZ);
        this.tableParam[n] = s + u;
        this.tableDist[n] = dist;
        this.tableX[n] = TEMP[0] as number;
        this.tableY[n] = TEMP[1] as number;
        this.tableZ[n] = TEMP[2] as number;
        lastX = TEMP[0] as number;
        lastY = TEMP[1] as number;
        lastZ = TEMP[2] as number;
        n++;
      }
    }
    if (this.segments === 0) {
      this.tableParam[0] = 0;
      this.tableDist[0] = 0;
      this.tableX[0] = this.px[0] ?? 0;
      this.tableY[0] = this.py[0] ?? 0;
      this.tableZ[0] = this.pz[0] ?? 0;
      n = 1;
    }
    /*
     * A curve through coincident control points has a length of a few floating
     * point crumbs rather than exactly zero, and every consumer that loops
     * `for (d = 0; d < length; d += step)` would build one degenerate
     * cross-section from it. Floor it: below a micrometre this is a point.
     */
    const measured = this.tableDist[n - 1] ?? 0;
    this.length = measured < DEGENERATE_CHORD ? 0 : measured;

    this.transportFrames(n);
  }

  get lengthM(): number {
    return this.length;
  }

  /** Control points, for callers that need the authored shape back. */
  get pointCount(): number {
    return this.segments + 1;
  }

  /**
   * Where an arc length falls in control-point terms: `index + fraction`.
   *
   * The inverse of `distanceAtPoint`, for a caller that measured something along
   * the curve and needs to write the answer back onto the points that produced it.
   * The fraction matters as much as the index — bank and width are blended between
   * two control points, so attributing a measurement to one of them without
   * knowing which one dominates there gets the wrong point by half the time.
   */
  pointParamAt(distanceM: number): number {
    if (this.segments === 0) return 0;
    const d = Math.min(Math.max(distanceM, 0), this.length);
    const i = Math.min(this.findCell(d), this.tableParam.length - 1);
    return Math.min(this.tableParam[i] ?? 0, this.segments);
  }

  /**
   * Arc length at control point `index`.
   *
   * A generator authors in control points — "the gap runs from the sixth point
   * to the eighth" — but everything downstream is in metres, and the conversion
   * is only knowable once the curve exists. Without this the caller has to
   * guess, and a guessed hole is a hole in the wrong place.
   */
  distanceAtPoint(index: number): number {
    if (this.segments === 0) return 0;
    const target = Math.min(Math.max(index, 0), this.segments);
    // The table always contains an entry at each integer parameter, because
    // every segment is walked from its own u = 0.
    let lo = 0;
    let hi = this.tableParam.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if ((this.tableParam[mid] ?? 0) < target - 1e-9) lo = mid + 1;
      else hi = mid;
    }
    return this.tableDist[lo] ?? 0;
  }

  /**
   * Carry an up-vector along the curve rather than deriving one at each sample.
   *
   * Each step rotates the previous up by the rotation that takes the previous
   * tangent onto this one — the discrete rotation-minimising frame. On a planar
   * curve it holds up exactly constant; through a climb past vertical it simply
   * follows, because it never consults world up again after the first sample.
   */
  private transportFrames(count: number): void {
    if (count === 0) return;

    this.tangentAt(0, count, TEMP);
    let tx = TEMP[0] as number;
    let ty = TEMP[1] as number;
    let tz = TEMP[2] as number;

    // Seed from world up, or from world forward where the curve starts
    // vertical and world up would give nothing to cross with.
    let ux = 0;
    let uy = 1;
    let uz = 0;
    if (Math.abs(ty) > 0.999) {
      ux = 0;
      uy = 0;
      uz = 1;
    }
    let dot = ux * tx + uy * ty + uz * tz;
    ux -= tx * dot;
    uy -= ty * dot;
    uz -= tz * dot;
    let inv = 1 / (Math.hypot(ux, uy, uz) || 1);
    ux *= inv;
    uy *= inv;
    uz *= inv;
    this.tableUpX[0] = ux;
    this.tableUpY[0] = uy;
    this.tableUpZ[0] = uz;

    for (let i = 1; i < count; i++) {
      this.tangentAt(i, count, TEMP);
      const nx = TEMP[0] as number;
      const ny = TEMP[1] as number;
      const nz = TEMP[2] as number;

      // Rodrigues about (previous tangent × this tangent), by the angle
      // between them. Degenerate when they are parallel, which is the common
      // case on a straight — hence the guard rather than a branchless form.
      const ax = ty * nz - tz * ny;
      const ay = tz * nx - tx * nz;
      const az = tx * ny - ty * nx;
      const sin = Math.hypot(ax, ay, az);
      if (sin > 1e-9) {
        const cos = tx * nx + ty * ny + tz * nz;
        const kx = ax / sin;
        const ky = ay / sin;
        const kz = az / sin;
        const kDotU = kx * ux + ky * uy + kz * uz;
        const cx = ky * uz - kz * uy;
        const cy = kz * ux - kx * uz;
        const cz = kx * uy - ky * ux;
        const rx = ux * cos + cx * sin + kx * kDotU * (1 - cos);
        const ry = uy * cos + cy * sin + ky * kDotU * (1 - cos);
        const rz = uz * cos + cz * sin + kz * kDotU * (1 - cos);
        ux = rx;
        uy = ry;
        uz = rz;
      }

      // Re-orthogonalise every step. Without it the transported frame drifts
      // off the plane over a few thousand samples and the surface shears.
      dot = ux * nx + uy * ny + uz * nz;
      ux -= nx * dot;
      uy -= ny * dot;
      uz -= nz * dot;
      inv = 1 / (Math.hypot(ux, uy, uz) || 1);
      ux *= inv;
      uy *= inv;
      uz *= inv;

      this.tableUpX[i] = ux;
      this.tableUpY[i] = uy;
      this.tableUpZ[i] = uz;
      tx = nx;
      ty = ny;
      tz = nz;
    }
  }

  /** Unit tangent at table entry `i`, from its neighbours' positions. */
  private tangentAt(i: number, count: number, out: Float64Array): void {
    const a = Math.max(i - 1, 0);
    const b = Math.min(i + 1, count - 1);
    let dx = (this.tableX[b] ?? 0) - (this.tableX[a] ?? 0);
    let dy = (this.tableY[b] ?? 0) - (this.tableY[a] ?? 0);
    let dz = (this.tableZ[b] ?? 0) - (this.tableZ[a] ?? 0);
    const len = Math.hypot(dx, dy, dz);
    if (len < 1e-12) {
      dx = 1;
      dy = 0;
      dz = 0;
    } else {
      dx /= len;
      dy /= len;
      dz /= len;
    }
    out[0] = dx;
    out[1] = dy;
    out[2] = dz;
  }

  /**
   * Curve position at segment `s`, local parameter `u`, into `out[0..2]`.
   *
   * Nothing here depends on anything but `u`: the four points are read straight out
   * of the phantom-extended arrays and the knots were measured when the curve was
   * built. What is left is the interpolation itself, which is the only part that
   * could not have been done in advance.
   */
  private evaluate(s: number, u: number, out: Float64Array): void {
    const x0 = this.ex[s] as number;
    const y0 = this.ey[s] as number;
    const z0 = this.ez[s] as number;
    const x1 = this.ex[s + 1] as number;
    const y1 = this.ey[s + 1] as number;
    const z1 = this.ez[s + 1] as number;
    const x2 = this.ex[s + 2] as number;
    const y2 = this.ey[s + 2] as number;
    const z2 = this.ez[s + 2] as number;
    const x3 = this.ex[s + 3] as number;
    const y3 = this.ey[s + 3] as number;
    const z3 = this.ez[s + 3] as number;

    const t0 = 0;
    const t1 = this.knot1[s] as number;
    const t2 = this.knot2[s] as number;
    const t3 = this.knot3[s] as number;
    const t = t1 + (t2 - t1) * u;

    out[0] = barryGoldman(x0, x1, x2, x3, t0, t1, t2, t3, t);
    out[1] = barryGoldman(y0, y1, y2, y3, t0, t1, t2, t3, t);
    out[2] = barryGoldman(z0, z1, z2, z3, t0, t1, t2, t3, t);
  }

  /** Curve position at a global parameter (segment index plus local u). */
  private evaluateParam(param: number, out: Float64Array): void {
    const clamped = Math.min(Math.max(param, 0), this.segments);
    let s = Math.floor(clamped);
    let u = clamped - s;
    if (s >= this.segments) {
      s = Math.max(this.segments - 1, 0);
      u = 1;
    }
    this.evaluate(s, u, out);
  }

  /** Largest table index whose distance is at most `d`. */
  private findCell(d: number): number {
    let lo = 0;
    let hi = this.tableDist.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if ((this.tableDist[mid] ?? 0) <= d) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  }

  /**
   * Evaluate the curve at an arc length, clamped to its ends.
   *
   * Allocation-free by contract: it is called from the simulation, from the
   * generator and from the mesh builder, and the first of those makes it a hot
   * path rule rather than a preference.
   */
  sampleAt(distanceM: number, out: SplineSample): void {
    if (this.segments === 0 || this.length <= 0) {
      out.x = this.px[0] ?? 0;
      out.y = this.py[0] ?? 0;
      out.z = this.pz[0] ?? 0;
      out.tangentX = 1;
      out.tangentY = 0;
      out.tangentZ = 0;
      out.normalX = 0;
      out.normalY = 1;
      out.normalZ = 0;
      out.rightX = 0;
      out.rightY = 0;
      out.rightZ = 1;
      out.bankRad = this.bank[0] ?? 0;
      out.widthM = this.width[0] ?? 0;
      return;
    }

    const d = Math.min(Math.max(distanceM, 0), this.length);
    const i = Math.min(this.findCell(d), this.tableDist.length - 2);
    const d0 = this.tableDist[i] ?? 0;
    const d1 = this.tableDist[i + 1] ?? d0;
    const span = d1 - d0;
    const alpha = span > 1e-12 ? (d - d0) / span : 0;

    const param =
      (this.tableParam[i] ?? 0) +
      ((this.tableParam[i + 1] ?? 0) - (this.tableParam[i] ?? 0)) * alpha;

    this.evaluateParam(param, TEMP);
    out.x = TEMP[0] as number;
    out.y = TEMP[1] as number;
    out.z = TEMP[2] as number;

    // Tangent from a central difference on the curve itself rather than from
    // the table, so it stays exact where the table is coarse.
    this.evaluateParam(param - TANGENT_DU, TEMP);
    const ax = TEMP[0] as number;
    const ay = TEMP[1] as number;
    const az = TEMP[2] as number;
    this.evaluateParam(param + TANGENT_DU, TEMP);
    let tx = (TEMP[0] as number) - ax;
    let ty = (TEMP[1] as number) - ay;
    let tz = (TEMP[2] as number) - az;
    const tLen = Math.hypot(tx, ty, tz);
    if (tLen < 1e-12) {
      tx = 1;
      ty = 0;
      tz = 0;
    } else {
      tx /= tLen;
      ty /= tLen;
      tz /= tLen;
    }
    out.tangentX = tx;
    out.tangentY = ty;
    out.tangentZ = tz;

    let ux =
      (this.tableUpX[i] ?? 0) + ((this.tableUpX[i + 1] ?? 0) - (this.tableUpX[i] ?? 0)) * alpha;
    let uy =
      (this.tableUpY[i] ?? 1) + ((this.tableUpY[i + 1] ?? 1) - (this.tableUpY[i] ?? 1)) * alpha;
    let uz =
      (this.tableUpZ[i] ?? 0) + ((this.tableUpZ[i + 1] ?? 0) - (this.tableUpZ[i] ?? 0)) * alpha;
    const uDot = ux * tx + uy * ty + uz * tz;
    ux -= tx * uDot;
    uy -= ty * uDot;
    uz -= tz * uDot;
    const uLen = Math.hypot(ux, uy, uz) || 1;
    ux /= uLen;
    uy /= uLen;
    uz /= uLen;

    // right = tangent × up, normal = right × tangent. Both unit, both exactly
    // perpendicular to the tangent, which is what the surface frame promises.
    let rx = ty * uz - tz * uy;
    let ry = tz * ux - tx * uz;
    let rz = tx * uy - ty * ux;
    const rLen = Math.hypot(rx, ry, rz) || 1;
    rx /= rLen;
    ry /= rLen;
    rz /= rLen;
    const nx = ry * tz - rz * ty;
    const ny = rz * tx - rx * tz;
    const nz = rx * ty - ry * tx;

    // Bank and width follow the control points through a smoothstep. Linear
    // would put a crease across the surface at every control point, and the
    // character would hit it as a bump nobody authored.
    const clamped = Math.min(Math.max(param, 0), this.segments);
    const seg = Math.min(Math.floor(clamped), Math.max(this.segments - 1, 0));
    const blend = smoothstep01(Math.min(Math.max(clamped - seg, 0), 1));
    const bank0 = this.bank[seg] ?? 0;
    const bank1 = this.bank[seg + 1] ?? bank0;
    const width0 = this.width[seg] ?? 0;
    const width1 = this.width[seg + 1] ?? width0;
    const bank = bank0 + (bank1 - bank0) * blend;
    out.bankRad = bank;
    out.widthM = width0 + (width1 - width0) * blend;

    const cos = Math.cos(bank);
    const sin = Math.sin(bank);
    out.rightX = rx * cos + nx * sin;
    out.rightY = ry * cos + ny * sin;
    out.rightZ = rz * cos + nz * sin;
    out.normalX = nx * cos - rx * sin;
    out.normalY = ny * cos - ry * sin;
    out.normalZ = nz * cos - rz * sin;
  }
}

/** Module-level scratch. One curve is evaluated at a time, on one thread. */
const TEMP = new Float64Array(3);

/** Convenience for callers building control points from a colour-carrying path. */
export type SplineColor = Vec3;
