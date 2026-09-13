/** Where environment probes stand, and which of them light a point. */

import type { Vec3 } from '../math/color.ts';

/**
 * A lattice, and the reason it is one.
 *
 * **A list of probes is what the shader cannot afford.** Free placement wants a position and an
 * extent per probe, and `flatFrag` already declares 35 array uniforms totalling 385 uniform
 * vectors against WebGL2's guaranteed `MAX_FRAGMENT_UNIFORM_VECTORS` of 224 — the widest
 * permutation is 1.7x over the guarantee already and runs because real parts offer more. Sixteen
 * probes of position and extent would add about 48 vectors to that, on a budget nobody can raise.
 *
 * A lattice needs four uniforms whatever the probe count: an origin, the reciprocal of the
 * spacing, the counts, and whether the grid supplies ambient. The layer index is arithmetic and
 * the blend is three lerps, so nothing here scales with how many probes a world has.
 *
 * **What it costs** is that probes cannot be placed where a room is. A world whose interesting
 * volume is not a box spends layers on probes standing in walls, and the answer to that is a
 * coarser grid rather than a list. **What would make it wrong** is the flat shader's uniform
 * pressure falling far enough for per-probe data to fit, or probe data moving into a texture —
 * which needs the last texture unit, and `lightBudget.ts` records why that one is being kept.
 */
export interface ProbeGridOptions {
  /** Where probe (0, 0, 0) stands. Every other probe is offset from it by whole steps. */
  readonly origin: Vec3;
  /** Metres between neighbouring probes on each axis. Every component must be positive. */
  readonly spacing: Vec3;
  /**
   * How many probes on each axis.
   *
   * **`[1, 1, 1]` is a single probe, and that is not a special case anywhere below.** A world that
   * bakes one environment is a grid of one, so there is one code path through the array, the
   * convolution and the shader instead of a grid path and a legacy path that drift.
   */
  readonly counts: Vec3;
}

/**
 * The eight probes surrounding a point, and how much of each it takes.
 *
 * Filled rather than returned, because the renderer asks this per draw when it decides what to
 * bake next, and the rule against allocating in a per-frame path is cheaper to keep than to
 * reason about. Eight always, duplicates included: a point at the edge of the grid, or in a grid
 * one probe wide, resolves several corners to the same layer and their weights add. That keeps
 * the sum exactly one with no branch, which is what the shader wants too.
 */
export interface ProbeBlend {
  readonly layers: Int32Array;
  readonly weights: Float32Array;
}

/** A blend a caller owns and reuses. */
export function createProbeBlend(): ProbeBlend {
  return { layers: new Int32Array(8), weights: new Float32Array(8) };
}

/**
 * How many layers a grid may hold, and it is a memory limit rather than a binding one.
 *
 * Every probe is one layer of one array, so probes cost no texture units at all — the same thing
 * the octahedral change bought the point lights, arrived at the same way. What they do cost is
 * storage: a layer at the default size is 683 KB with its chain, so 64 layers is **43.7 MB**,
 * comfortably under the 92.3 MB `pointShadowArray.ts` already spends.
 *
 * WebGL2 guarantees `MAX_ARRAY_TEXTURE_LAYERS` of 256, which would be 175 MB and is the number
 * this is *not* set to. Raising it is an arithmetic decision about memory and the arithmetic is
 * written here so nobody has to re-derive it.
 */
export const MAX_ENV_PROBES = 64;

/**
 * The lattice a single baked probe is, and the origin a loaded environment sits at.
 *
 * **Here rather than in either backend**, per the rule `prefilterEnvMap.ts` states at length: a
 * value one backend defines is a decision the other cannot reach, so it gets restated there and the
 * two drift. Both renderers turn `bakeReflectionProbe` into a grid of one, and they have to turn it
 * into the *same* grid or a scene renders differently on each.
 *
 * A step is required even here, because `ProbeGrid` refuses a zero one — the blend divides by it —
 * and one metre is the honest arbitrary choice for a grid with no extent.
 */
export const SINGLE_PROBE: Vec3 = [1, 1, 1];
export const UNIT_STEP: Vec3 = [1, 1, 1];
export const WORLD_ORIGIN: Vec3 = [0, 0, 0];

/**
 * Whether a declared grid is the one already allocated.
 *
 * `texStorage3D` and `createTexture` are both immutable in the size they take, so a grid that has
 * not changed must not reallocate: `bakeReflectionProbe` declares its grid of one on every call,
 * and a scene rebaking each frame would otherwise throw away its layers every frame.
 */
export function sameGrid(a: ProbeGrid, b: ProbeGrid): boolean {
  for (let axis = 0; axis < 3; axis++) {
    if (a.counts[axis] !== b.counts[axis]) return false;
    if (a.origin[axis] !== b.origin[axis]) return false;
    if (a.spacing[axis] !== b.spacing[axis]) return false;
  }
  return true;
}

export class ProbeGrid {
  readonly origin: Vec3;
  readonly spacing: Vec3;
  readonly counts: Vec3;
  /** Probes in total, which is also the array's layer count. */
  readonly layers: number;
  /** The reciprocal of the spacing, because the shader multiplies and so does everything here. */
  readonly invSpacing: Vec3;

  constructor(options: ProbeGridOptions) {
    const counts: Vec3 = [
      Math.max(1, Math.trunc(options.counts[0])),
      Math.max(1, Math.trunc(options.counts[1])),
      Math.max(1, Math.trunc(options.counts[2])),
    ];
    const layers = counts[0] * counts[1] * counts[2];
    /*
     * **Fail fast at init**, per `AGENTS.md`, and say the arithmetic rather than the rule. A grid
     * too large to allocate is a consumer's typo far more often than an intention, and the cost of
     * finding out at `texStorage3D` is a device-lost message with nothing in it about probes.
     */
    if (layers > MAX_ENV_PROBES) {
      throw new Error(
        `ProbeGrid: ${counts[0]}x${counts[1]}x${counts[2]} is ${layers} probes and the limit is ` +
          `${MAX_ENV_PROBES}. Each is one layer of one array texture; see MAX_ENV_PROBES for what ` +
          `raising it costs in memory.`,
      );
    }
    for (let axis = 0; axis < 3; axis++) {
      const step = options.spacing[axis] ?? 0;
      /*
       * A zero step is a division by zero one line into `nearestProbes`, and the NaN it produces
       * reaches the shader as a probe weight — which reads as the environment being wrong
       * everywhere rather than as a grid being declared wrong once.
       */
      if (!(step > 0)) {
        throw new Error(
          `ProbeGrid: spacing on axis ${axis} is ${String(step)}; every component must be ` +
            `positive. A grid one probe wide on an axis still needs a step, since the step is ` +
            `what the blend divides by.`,
        );
      }
    }

    this.origin = [options.origin[0], options.origin[1], options.origin[2]];
    this.spacing = [options.spacing[0], options.spacing[1], options.spacing[2]];
    this.invSpacing = [1 / this.spacing[0], 1 / this.spacing[1], 1 / this.spacing[2]];
    this.counts = counts;
    this.layers = layers;
  }

  /**
   * The layer a probe at whole lattice coordinates occupies.
   *
   * **x fastest, then y, then z**, and the order is written down because the shader computes the
   * same expression and the two disagreeing would put every fragment's reflection in a different
   * room. Out-of-range coordinates clamp; see `nearestProbes` for why clamping rather than
   * wrapping is the behaviour at a grid's edge.
   */
  layerAt(ix: number, iy: number, iz: number): number {
    const x = clampIndex(ix, this.counts[0]);
    const y = clampIndex(iy, this.counts[1]);
    const z = clampIndex(iz, this.counts[2]);
    return x + this.counts[0] * (y + this.counts[1] * z);
  }

  /** Where a layer's probe stands, filling a vector the caller owns. */
  positionOf(layer: number, out: Vec3): Vec3 {
    const index = clampIndex(layer, this.layers);
    const x = index % this.counts[0];
    const y = Math.floor(index / this.counts[0]) % this.counts[1];
    const z = Math.floor(index / (this.counts[0] * this.counts[1]));
    out[0] = this.origin[0] + x * this.spacing[0];
    out[1] = this.origin[1] + y * this.spacing[1];
    out[2] = this.origin[2] + z * this.spacing[2];
    return out;
  }
}

/**
 * The eight probes around a world position, with trilinear weights that sum to one.
 *
 * **Clamped at the grid's edge rather than wrapped or faded.** A point outside the grid takes the
 * nearest probes at full weight, which is the same environment it would have had one step inside —
 * the honest degradation, and the one a consumer can see coming. Fading to the hemispheric
 * gradient at the boundary was the alternative and it reads worse: an object walking out of a
 * grid would change what lights it while nothing about it changed.
 *
 * **Weights sum to one everywhere, including outside**, which is what lets the shader multiply
 * rather than normalise. In a grid one probe wide on an axis, that axis contributes a factor of
 * one and the eight corners collapse onto fewer layers whose weights add — no branch, and a
 * `[1, 1, 1]` grid returns the single probe at weight one with the other seven entries pointing
 * at it too.
 */
export function nearestProbes(
  grid: ProbeGrid,
  x: number,
  y: number,
  z: number,
  out: ProbeBlend,
): ProbeBlend {
  const lx = cellCoordinate(x, grid.origin[0], grid.invSpacing[0], grid.counts[0]);
  const ly = cellCoordinate(y, grid.origin[1], grid.invSpacing[1], grid.counts[1]);
  const lz = cellCoordinate(z, grid.origin[2], grid.invSpacing[2], grid.counts[2]);

  let slot = 0;
  for (let cz = 0; cz < 2; cz++) {
    const wz = cz === 0 ? 1 - lz.fraction : lz.fraction;
    for (let cy = 0; cy < 2; cy++) {
      const wy = cy === 0 ? 1 - ly.fraction : ly.fraction;
      for (let cx = 0; cx < 2; cx++) {
        const wx = cx === 0 ? 1 - lx.fraction : lx.fraction;
        out.layers[slot] = grid.layerAt(lx.index + cx, ly.index + cy, lz.index + cz);
        out.weights[slot] = wx * wy * wz;
        slot++;
      }
    }
  }
  return out;
}

/**
 * One axis of the lookup: which probe is below the point, and how far past it the point is.
 *
 * The lower index stops one short of the last probe so the pair `index` and `index + 1` is always
 * inside the grid, and a single-probe axis has no pair at all — both corners are probe zero and
 * the fraction is zero, so that axis multiplies every weight by one.
 */
function cellCoordinate(
  value: number,
  origin: number,
  invSpacing: number,
  count: number,
): { index: number; fraction: number } {
  if (count <= 1) return { index: 0, fraction: 0 };
  const local = (value - origin) * invSpacing;
  const clamped = local <= 0 ? 0 : local >= count - 1 ? count - 1 : local;
  const index = Math.min(Math.floor(clamped), count - 2);
  return { index, fraction: clamped - index };
}

/** A whole index forced into a range, for the two lookups that accept anything. */
function clampIndex(value: number, count: number): number {
  const index = Math.trunc(value);
  return index <= 0 ? 0 : index >= count - 1 ? count - 1 : index;
}
