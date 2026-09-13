import type { ReadonlyMat4 } from 'gl-matrix';

import type { Bounds } from '../math/bounds.ts';

/**
 * Occlusion culling: a small depth buffer of declared occluders, a max pyramid over it, and a
 * rectangle test per object.
 *
 * **On the CPU, and that is the decision the whole design turns on.** The two obvious answers are
 * hardware occlusion queries and a GPU depth pyramid, and each of them fails a rule this engine
 * already holds. A query answers a frame late and needs a bounding-box draw per candidate, so a
 * newly-visible object pops in — and the two backends spell it differently, which is the parity
 * risk `AGENTS.md` names. A GPU pyramid over the frame's own depth has to be *read back* to cull on
 * the CPU, which stalls, or tested in a compute shader, which WebGL2 does not have at all. Neither
 * of them can be tested without a GPU, and this repository's whole culling story — `sphereInFrustum`,
 * `boundsVisible`, `lodForBounds` — is assertions over arithmetic.
 *
 * So: **the consumer declares its occluders** — a wall, a building, a terrain slab, the few large
 * things a scene is actually hidden by — and this rasterises them into a buffer a few hundred
 * texels wide. *What that gives up* is that a small object never occludes anything: a crowd does
 * not hide the crowd behind it. *What would reverse it* is a scene whose occlusion is genuinely
 * made of small things, where the answer is a query-based scheme and its one-frame latency.
 *
 * **Everything here errs toward drawing.** A cull that is wrong in the other direction is a hole in
 * the world, and there is no threshold that makes it acceptable. Three constructions keep it that
 * way and each is worth naming:
 *
 * - **Back faces, not front.** A box hides whatever is behind its *far* surface, so the buffer
 *   holds the depth of the occluder's back and an object is culled only when it is deeper than
 *   that. Rasterising the near face would cull everything inside the box as well.
 * - **Eroded by one texel.** A triangle sampled at texel centres covers up to half a texel more
 *   than it should at every silhouette. One dilation of the *unwritten* texels takes that back, at
 *   the cost of a one-texel border of occluder nobody misses.
 * - **A max pyramid, tested against the object's nearest point.** The object is culled only if
 *   every texel its rectangle touches is already covered by something nearer, which is what taking
 *   the maximum bound over the rectangle and comparing the object's minimum depth says.
 */

/** What an unwritten texel holds: the far plane, which occludes nothing. */
const FAR = 1;

export interface OcclusionOptions {
  /** Texels across. The height follows the aspect. */
  readonly width: number;
  readonly height: number;
}

export class OcclusionBuffer {
  /**
   * The pyramid, level 0 first, each level a quarter of the one before.
   *
   * One allocation per level rather than one buffer with offsets, because the test indexes a level
   * by its own width and an offset table would be a second thing to keep in step.
   */
  private levels: Float32Array[] = [];
  private widths: number[] = [];
  private heights: number[] = [];
  private built = false;
  private occluders = 0;

  /** The view-projection this frame's occluders were rasterised through. */
  private readonly viewProj = new Float32Array(16);

  constructor(options: OcclusionOptions) {
    this.resize(options);
  }

  get width(): number {
    return this.widths[0] ?? 0;
  }

  get height(): number {
    return this.heights[0] ?? 0;
  }

  /** How many occluders were declared this frame. Zero means every test answers "draw it". */
  get declared(): number {
    return this.occluders;
  }

  /**
   * Rebuild the pyramid for a new size. Called when the drawing buffer's aspect changes.
   *
   * Levels stop at 1x1: the coarsest level is one texel covering the whole frame, which is what a
   * rectangle spanning the screen is tested against.
   */
  resize(options: OcclusionOptions): void {
    const width = Math.max(1, Math.round(options.width));
    const height = Math.max(1, Math.round(options.height));
    if (width === this.widths[0] && height === this.heights[0]) return;
    this.levels = [];
    this.widths = [];
    this.heights = [];
    let w = width;
    let h = height;
    for (;;) {
      this.levels.push(new Float32Array(w * h));
      this.widths.push(w);
      this.heights.push(h);
      if (w === 1 && h === 1) break;
      w = Math.max(1, w >> 1);
      h = Math.max(1, h >> 1);
    }
    this.built = false;
  }

  /** Start a frame: clear to the far plane and take the matrix everything will be projected by. */
  begin(viewProj: ReadonlyMat4): void {
    const base = this.levels[0];
    if (base !== undefined) base.fill(FAR);
    for (let i = 0; i < 16; i++) this.viewProj[i] = viewProj[i] ?? 0;
    this.built = false;
    this.occluders = 0;
  }

  /**
   * Declare one occluder: a box in local space, placed by a model matrix.
   *
   * **A box rather than the mesh**, which is the same bargain a bounding sphere makes for the
   * frustum: an occluder that is smaller than the thing it stands for is conservative, and a
   * consumer knows the box that fits inside its wall. *What would make it wrong* is a consumer
   * handing the mesh's own bounds for a shape with a hole in it, which would occlude through the
   * hole — so the parameter is the box you may safely be hidden by, not the box you occupy.
   */
  addOccluder(
    min: ReadonlyArray<number> | Float32Array,
    max: ReadonlyArray<number> | Float32Array,
    model: ReadonlyMat4,
  ): void {
    for (let corner = 0; corner < 8; corner++) {
      const x = corner & 1 ? (max[0] ?? 0) : (min[0] ?? 0);
      const y = corner & 2 ? (max[1] ?? 0) : (min[1] ?? 0);
      const z = corner & 4 ? (max[2] ?? 0) : (min[2] ?? 0);
      const wx = (model[0] ?? 0) * x + (model[4] ?? 0) * y + (model[8] ?? 0) * z + (model[12] ?? 0);
      const wy = (model[1] ?? 0) * x + (model[5] ?? 0) * y + (model[9] ?? 0) * z + (model[13] ?? 0);
      const wz =
        (model[2] ?? 0) * x + (model[6] ?? 0) * y + (model[10] ?? 0) * z + (model[14] ?? 0);
      if (!this.project(wx, wy, wz, corner)) return;
    }
    this.occluders++;
    /*
     * The six faces, wound so that each is counter-clockwise seen from outside. Only the ones
     * facing *away* from the camera are rasterised: a box hides what is behind its far surface,
     * and the near one would cull the box's own interior.
     */
    for (let face = 0; face < 6; face++) {
      const a = FACES[face * 4] ?? 0;
      const b = FACES[face * 4 + 1] ?? 0;
      const c = FACES[face * 4 + 2] ?? 0;
      const d = FACES[face * 4 + 3] ?? 0;
      /* Screen-space winding: a back face comes out clockwise once projected. */
      if (signedArea(CORNERS, a, b, c) >= 0) continue;
      this.triangle(a, b, c);
      this.triangle(a, c, d);
    }
    this.built = false;
  }

  /**
   * Whether a bounding sphere is entirely behind the declared occluders.
   *
   * **False whenever anything is uncertain**, which is every case the arithmetic cannot settle: no
   * occluders, a sphere crossing the near plane, a rectangle off the side of the frame. Drawing
   * something hidden costs a draw call; culling something visible is a hole.
   */
  occluded(bounds: Bounds, model: ReadonlyMat4): boolean {
    if (this.occluders === 0) return false;
    if (!this.built) this.buildPyramid();

    const cx = bounds.centre[0] ?? 0;
    const cy = bounds.centre[1] ?? 0;
    const cz = bounds.centre[2] ?? 0;
    const m0 = model[0] ?? 0;
    const m1 = model[1] ?? 0;
    const m2 = model[2] ?? 0;
    const m4 = model[4] ?? 0;
    const m5 = model[5] ?? 0;
    const m6 = model[6] ?? 0;
    const m8 = model[8] ?? 0;
    const m9 = model[9] ?? 0;
    const m10 = model[10] ?? 0;
    const x = m0 * cx + m4 * cy + m8 * cz + (model[12] ?? 0);
    const y = m1 * cx + m5 * cy + m9 * cz + (model[13] ?? 0);
    const z = m2 * cx + m6 * cy + m10 * cz + (model[14] ?? 0);
    /* The same largest-axis rule `boundsVisible` uses, and for the same reason. */
    const sx = Math.sqrt(m0 * m0 + m1 * m1 + m2 * m2);
    const sy = Math.sqrt(m4 * m4 + m5 * m5 + m6 * m6);
    const sz = Math.sqrt(m8 * m8 + m9 * m9 + m10 * m10);
    const radius = bounds.radius * Math.max(sx, sy, sz);

    /* The cube that contains the sphere, which contains the object. Conservative twice over. */
    let minX = Infinity;
    let minY = Infinity;
    let minZ = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (let corner = 0; corner < 8; corner++) {
      const px = corner & 1 ? x + radius : x - radius;
      const py = corner & 2 ? y + radius : y - radius;
      const pz = corner & 4 ? z + radius : z - radius;
      if (!this.project(px, py, pz, 0)) return false;
      minX = Math.min(minX, CORNERS[0] ?? 0);
      maxX = Math.max(maxX, CORNERS[0] ?? 0);
      minY = Math.min(minY, CORNERS[1] ?? 0);
      maxY = Math.max(maxY, CORNERS[1] ?? 0);
      minZ = Math.min(minZ, CORNERS[2] ?? 0);
    }

    const width = this.widths[0] ?? 1;
    const height = this.heights[0] ?? 1;
    /* Off the side of the frame: the frustum test owns that answer, and this one abstains. */
    if (minX < 0 || minY < 0 || maxX > width || maxY > height) return false;

    /*
     * The coarsest level whose texel is at least as wide as the rectangle, so the test reads at
     * most two texels each way. `Math.log2` would say the same thing and is one of the calls this
     * repository's determinism gate refuses elsewhere; a shift loop says it in integers.
     */
    let level = 0;
    let span = Math.max(maxX - minX, maxY - minY);
    while (span > 1 && level + 1 < this.levels.length) {
      span *= 0.5;
      level++;
    }
    const buffer = this.levels[level];
    const lw = this.widths[level] ?? 1;
    const lh = this.heights[level] ?? 1;
    if (buffer === undefined) return false;
    const scale = 1 / (1 << level);
    const x0 = Math.max(0, Math.floor(minX * scale));
    const y0 = Math.max(0, Math.floor(minY * scale));
    const x1 = Math.min(lw - 1, Math.floor(maxX * scale));
    const y1 = Math.min(lh - 1, Math.floor(maxY * scale));

    let bound = -Infinity;
    for (let ty = y0; ty <= y1; ty++) {
      for (let tx = x0; tx <= x1; tx++) {
        const value = buffer[ty * lw + tx] ?? FAR;
        if (value > bound) bound = value;
      }
    }
    /* Culled only when the object's nearest point is behind everything covering its rectangle. */
    return minZ > bound;
  }

  /**
   * A world point into buffer coordinates and depth, written into `CORNERS` at `slot`.
   *
   * Returns false for a point at or behind the eye, where the perspective divide has no meaning —
   * and a false anywhere abandons the whole shape, occluder or occludee, because a partial
   * projection is exactly the kind of half-answer that produces a hole.
   */
  private project(x: number, y: number, z: number, slot: number): boolean {
    const m = this.viewProj;
    const cx = (m[0] ?? 0) * x + (m[4] ?? 0) * y + (m[8] ?? 0) * z + (m[12] ?? 0);
    const cy = (m[1] ?? 0) * x + (m[5] ?? 0) * y + (m[9] ?? 0) * z + (m[13] ?? 0);
    const cz = (m[2] ?? 0) * x + (m[6] ?? 0) * y + (m[10] ?? 0) * z + (m[14] ?? 0);
    const cw = (m[3] ?? 0) * x + (m[7] ?? 0) * y + (m[11] ?? 0) * z + (m[15] ?? 0);
    if (cw <= 1e-6) return false;
    const inverse = 1 / cw;
    CORNERS[slot * 3] = (cx * inverse * 0.5 + 0.5) * (this.widths[0] ?? 1);
    CORNERS[slot * 3 + 1] = (cy * inverse * 0.5 + 0.5) * (this.heights[0] ?? 1);
    CORNERS[slot * 3 + 2] = cz * inverse;
    return true;
  }

  /**
   * One triangle of an occluder's back face into level 0, keeping the nearest depth per texel.
   *
   * A half-space rasteriser over the triangle's own bounding box, sampling at texel centres. Depth
   * is interpolated in screen space rather than perspective-correct — which for a *bound* is the
   * safe direction only if it never under-estimates, so the depth written is the plane's value at
   * the texel centre plus half a texel of gradient each way. A bound that is too far occludes less.
   */
  private triangle(a: number, b: number, c: number): void {
    const buffer = this.levels[0];
    if (buffer === undefined) return;
    const width = this.widths[0] ?? 1;
    const height = this.heights[0] ?? 1;
    const ax = CORNERS[a * 3] ?? 0;
    const ay = CORNERS[a * 3 + 1] ?? 0;
    const az = CORNERS[a * 3 + 2] ?? 0;
    const bx = CORNERS[b * 3] ?? 0;
    const by = CORNERS[b * 3 + 1] ?? 0;
    const bz = CORNERS[b * 3 + 2] ?? 0;
    const cx = CORNERS[c * 3] ?? 0;
    const cy = CORNERS[c * 3 + 1] ?? 0;
    const cz = CORNERS[c * 3 + 2] ?? 0;

    const area = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
    if (area === 0) return;
    const inverseArea = 1 / area;

    const x0 = Math.max(0, Math.floor(Math.min(ax, bx, cx)));
    const x1 = Math.min(width - 1, Math.ceil(Math.max(ax, bx, cx)));
    const y0 = Math.max(0, Math.floor(Math.min(ay, by, cy)));
    const y1 = Math.min(height - 1, Math.ceil(Math.max(ay, by, cy)));

    for (let ty = y0; ty <= y1; ty++) {
      const py = ty + 0.5;
      for (let tx = x0; tx <= x1; tx++) {
        const px = tx + 0.5;
        const w0 = ((bx - ax) * (py - ay) - (by - ay) * (px - ax)) * inverseArea;
        const w1 = ((cx - bx) * (py - by) - (cy - by) * (px - bx)) * inverseArea;
        const w2 = ((ax - cx) * (py - cy) - (ay - cy) * (px - cx)) * inverseArea;
        if (w0 < 0 || w1 < 0 || w2 < 0) continue;
        /* Barycentrics: w1 belongs to a, w2 to b, w0 to c. */
        const depth = w1 * az + w2 * bz + w0 * cz;
        const at = ty * width + tx;
        if (depth < (buffer[at] ?? FAR)) buffer[at] = depth;
      }
    }
  }

  /**
   * Erode by one texel, then reduce by maximum into every coarser level.
   *
   * **The erosion is what makes the whole thing conservative** and it costs one pass: a triangle
   * sampled at texel centres covers up to half a texel too much at every silhouette, so any texel
   * next to an unwritten one gives its bound back. The reduction is a maximum because the test asks
   * "is every texel under this rectangle already covered by something nearer", and a maximum over
   * children answers that for the parent.
   */
  private buildPyramid(): void {
    const base = this.levels[0];
    const width = this.widths[0] ?? 1;
    const height = this.heights[0] ?? 1;
    if (base !== undefined) {
      if (ERODED.length < base.length) ERODED = new Float32Array(base.length);
      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
          let value = base[y * width + x] ?? FAR;
          for (let dy = -1; dy <= 1 && value < FAR; dy++) {
            const ny = y + dy;
            if (ny < 0 || ny >= height) {
              value = FAR;
              break;
            }
            for (let dx = -1; dx <= 1; dx++) {
              const nx = x + dx;
              if (nx < 0 || nx >= width) {
                value = FAR;
                break;
              }
              const neighbour = base[ny * width + nx] ?? FAR;
              if (neighbour > value) value = neighbour;
            }
          }
          ERODED[y * width + x] = value;
        }
      }
      base.set(ERODED.subarray(0, base.length));
    }

    for (let level = 1; level < this.levels.length; level++) {
      const source = this.levels[level - 1];
      const target = this.levels[level];
      const sw = this.widths[level - 1] ?? 1;
      const sh = this.heights[level - 1] ?? 1;
      const tw = this.widths[level] ?? 1;
      const th = this.heights[level] ?? 1;
      if (source === undefined || target === undefined) continue;
      for (let y = 0; y < th; y++) {
        for (let x = 0; x < tw; x++) {
          const sx = Math.min(x * 2, sw - 1);
          const sy = Math.min(y * 2, sh - 1);
          const sx1 = Math.min(sx + 1, sw - 1);
          const sy1 = Math.min(sy + 1, sh - 1);
          target[y * tw + x] = Math.max(
            source[sy * sw + sx] ?? FAR,
            source[sy * sw + sx1] ?? FAR,
            source[sy1 * sw + sx] ?? FAR,
            source[sy1 * sw + sx1] ?? FAR,
          );
        }
      }
    }
    this.built = true;
  }
}

/** Eight projected corners, xy in buffer texels and z in normalised device coordinates. */
const CORNERS = new Float64Array(24);
/** Scratch for the erosion, grown to whatever the largest buffer has needed. */
let ERODED = new Float32Array(0);

/**
 * The six faces of a corner-indexed box, each wound counter-clockwise seen from outside.
 *
 * Corner `i` takes `max` on axis `k` where bit `k` of `i` is set, which is the same numbering
 * `boxShape` uses in the physics package — written out rather than derived, because the loop that
 * derives it is longer than the table.
 */
const FACES = new Uint8Array([
  1, 3, 7, 5, 4, 6, 2, 0, 2, 6, 7, 3, 0, 1, 5, 4, 4, 5, 7, 6, 0, 2, 3, 1,
]);

/** Twice the signed area of a projected triangle: positive is counter-clockwise on screen. */
function signedArea(corners: Float64Array, a: number, b: number, c: number): number {
  const ax = corners[a * 3] ?? 0;
  const ay = corners[a * 3 + 1] ?? 0;
  return (
    ((corners[b * 3] ?? 0) - ax) * ((corners[c * 3 + 1] ?? 0) - ay) -
    ((corners[b * 3 + 1] ?? 0) - ay) * ((corners[c * 3] ?? 0) - ax)
  );
}
