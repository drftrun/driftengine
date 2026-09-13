import type { ReadonlyVec3 } from 'gl-matrix';

/**
 * A heightfield, and the two questions everything else asks it.
 *
 * **The whole design of this file is one rule: the answer a query gives is the surface that is
 * drawn.** A heightfield is stored as a lattice of samples and drawn as triangles, and those are
 * not the same surface — a bilinear patch through four corners and the two triangles that span
 * them agree only along their shared diagonal and at the corners. Interpolating bilinearly because
 * it is the obvious thing gives a character that floats over half of every cell and sinks into the
 * other half, by up to a quarter of the cell's height range, everywhere, for ever. It is a defect
 * with no symptom a screenshot can show and no test that fails, which is exactly the kind this
 * repository writes down.
 *
 * So `heightAt` reads the *triangle*, and `heightfieldPatch` builds those same triangles, and a
 * test asserts each vertex against the query.
 *
 * **The normal is the other way round on purpose.** A face normal is constant over a triangle and
 * jumps at every edge, so a field built from them is faceted, and — worse — two patches meeting at
 * a boundary shade differently along it, which reads as a crack that is not there. `normalAt` is a
 * central difference over the samples, continuous by construction, and it is what the mesh carries
 * as its vertex normals. A caller who wants the plane a wheel actually rests on takes three
 * `heightAt` samples; a caller who wants to orient a character takes this.
 */

export interface HeightfieldOptions {
  /** Samples across x. At least two, since one sample is not a cell. */
  readonly width: number;
  /** Samples across z. */
  readonly depth: number;
  /** Metres between samples, the same both ways. */
  readonly spacingM: number;
  /** `width * depth` heights in metres, row-major with x running fastest. */
  readonly heights: ArrayLike<number>;
  /** World position of sample `(0, 0)`. The origin's own y is added to every height. */
  readonly origin?: ReadonlyVec3;
}

export class Terrain {
  readonly width: number;
  readonly depth: number;
  readonly spacingM: number;
  /** World position of sample `(0, 0)`, copied because a caller reuses its vectors. */
  readonly origin = new Float32Array(3);
  /** The samples, copied for the same reason and because this is read every frame. */
  readonly heights: Float32Array;

  constructor(options: HeightfieldOptions) {
    const { width, depth, spacingM } = options;
    if (!(width >= 2)) throw new Error(`Terrain: width must be at least 2, got ${width}`);
    if (!(depth >= 2)) throw new Error(`Terrain: depth must be at least 2, got ${depth}`);
    if (!(spacingM > 0)) throw new Error(`Terrain: spacing must be above zero, got ${spacingM}`);
    if (options.heights.length !== width * depth) {
      throw new Error(
        `Terrain: ${width} by ${depth} needs ${width * depth} heights, got ${options.heights.length}`,
      );
    }
    this.width = Math.round(width);
    this.depth = Math.round(depth);
    this.spacingM = spacingM;
    this.heights = Float32Array.from(options.heights);
    if (options.origin !== undefined) this.origin.set(options.origin as ArrayLike<number>);
  }

  /** How far the field reaches along x, metres. One less cell than it has samples. */
  get extentX(): number {
    return (this.width - 1) * this.spacingM;
  }

  get extentZ(): number {
    return (this.depth - 1) * this.spacingM;
  }

  /** One sample, by grid index, clamped to the field rather than wrapping or answering NaN. */
  sample(ix: number, iz: number): number {
    const x = Math.min(this.width - 1, Math.max(0, ix));
    const z = Math.min(this.depth - 1, Math.max(0, iz));
    return (this.origin[1] ?? 0) + (this.heights[z * this.width + x] ?? 0);
  }

  /**
   * The height of the drawn surface at a world position.
   *
   * **The triangle and not the bilinear patch**, for the reason at the top of this file. The cell
   * is split along its `a`-`c` diagonal — from the sample at `(ix, iz)` to the one at
   * `(ix + 1, iz + 1)` — and `heightfieldPatch` emits exactly that split, so the two cannot
   * disagree about where the ground is.
   *
   * Clamped outside the field. A world has an edge and a query past it should answer the edge
   * rather than extrapolate a slope into a place that has no samples.
   */
  heightAt(x: number, z: number): number {
    const u = (x - (this.origin[0] ?? 0)) / this.spacingM;
    const v = (z - (this.origin[2] ?? 0)) / this.spacingM;
    const clampedU = Math.min(this.width - 1, Math.max(0, u));
    const clampedV = Math.min(this.depth - 1, Math.max(0, v));
    /* One short of the last sample, so `ix + 1` is always a sample and the cell is always whole. */
    const ix = Math.min(this.width - 2, Math.floor(clampedU));
    const iz = Math.min(this.depth - 2, Math.floor(clampedV));
    const fu = clampedU - ix;
    const fv = clampedV - iz;

    const a = this.sample(ix, iz);
    const c = this.sample(ix + 1, iz + 1);
    if (fu >= fv) {
      /* Below the diagonal: the triangle a, b, c. */
      const b = this.sample(ix + 1, iz);
      return a + (b - a) * fu + (c - b) * fv;
    }
    /* Above it: the triangle a, c, d. */
    const d = this.sample(ix, iz + 1);
    return a + (d - a) * fv + (c - d) * fu;
  }

  /**
   * The surface normal at a world position, as a central difference over the samples.
   *
   * Continuous across every cell boundary, which is what stops two patches shading differently
   * along the edge they share — the failure that reads as a crack in geometry that has none.
   */
  normalAt(x: number, z: number, out: Float32Array): Float32Array {
    const step = this.spacingM;
    const dx = this.heightAt(x + step, z) - this.heightAt(x - step, z);
    const dz = this.heightAt(x, z + step) - this.heightAt(x, z - step);
    /* The gradient of a height field, normalised: (-dh/dx, 1, -dh/dz) over twice the step. */
    const nx = -dx / (2 * step);
    const nz = -dz / (2 * step);
    const length = Math.sqrt(nx * nx + 1 + nz * nz);
    out[0] = nx / length;
    out[1] = 1 / length;
    out[2] = nz / length;
    return out;
  }
}
