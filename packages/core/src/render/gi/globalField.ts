/** The world near the camera as one distance field, assembled from the objects standing in it. */

import { mat4 } from 'gl-matrix';

import type { ReadonlyMat4, ReadonlyVec3 } from 'gl-matrix';

import type { Vec3 } from '../../math/color.ts';

/**
 * A baked object field, as this package can describe one.
 *
 * **Structural rather than imported**, because `@driftengine/core` does not depend on
 * `@driftengine/assets` and must not start: the baker is a build step and this is a frame. What
 * `bakeObjectSdf` returns satisfies this shape, and so does what `readSdfv` hands back from a
 * container. That is the arrangement `Terrain` already has with `Heightfield` across the physics
 * boundary and `DTEX` has with `@driftengine/texture` across the container one.
 */
export interface FieldSource {
  /** Distance in metres, negative inside. `x` fastest, then `y`, then `z`. */
  readonly field: Float32Array;
  readonly dims: readonly [number, number, number];
  /** The field's own extent in **object** space, `[minX, minY, minZ, maxX, maxY, maxZ]`. */
  readonly bounds: Float32Array;
}

export interface GlobalFieldInstance {
  readonly source: FieldSource;
  /**
   * What colour this instance's surface is, or white where it did not say.
   *
   * On the instance rather than the source, because the same baked field is placed many times and
   * two pillars cut from one mould may be painted differently. Optional so that every caller
   * written before the trace needed a colour is unchanged.
   */
  readonly albedo?: Vec3;
  /**
   * World from object.
   *
   * **Uniform scale only, and `composeGlobalField` refuses the rest rather than approximating.**
   * A distance is not preserved by a non-uniform scale: the factor to correct by depends on the
   * direction to the nearest surface, which is exactly what a distance field does not record. An
   * instance squashed on one axis and sampled anyway produces something that is a distance in no
   * direction and looks like one in every slice.
   */
  readonly transform: ReadonlyMat4;
}

/** One level of the clipmap: a grid the composer fills and `sampleGlobalField` reads. */
export interface GlobalFieldCascade {
  readonly field: Float32Array;
  /**
   * The colour of whatever surface won the union at each sample, three floats a sample.
   *
   * **A union loses which instance won, and a ray that lands on a wall needs to know what colour
   * it is.** `demo/dev/bounce.html` is what made this necessary: a trace whose radiance came from
   * a rasterised capture could not follow a wall that changed colour, and one that read the probe
   * volume's irradiance returned the same answer for a red wall and a white one — irradiance is
   * light arriving, and what leaves a surface is that times its albedo.
   *
   * **White where no instance reached**, rather than black: the colour of a sample no ray can hit
   * is never read, and black would turn a read that did happen into light quietly vanishing
   * instead of a picture that is obviously wrong.
   */
  readonly albedo: Float32Array;
  readonly dims: readonly [number, number, number];
  /** Where this cascade stands, written by `composeGlobalField`. Six floats. */
  readonly bounds: Float32Array;
  /** Metres between samples, the same on all three axes. Written by `composeGlobalField`. */
  step: number;
}

/**
 * The composed world, as nested cascades centred on the camera.
 *
 * **A clipmap and not a sparse brick tree, which is a smaller claim than the plan made and is
 * what is here.** Fine near the viewer and coarse further out is the requirement, and nesting
 * grids of equal sample count at doubling extents meets it exactly: cascade 0 resolves a room and
 * cascade 3 resolves a district, at one allocation each and no indirection to traverse. What a
 * brick tree buys on top is *memory* — skipping the volume no surface is near — and nothing yet
 * measured says this needs it. `traceField.ts` will say, because it is the thing that pays.
 */
export interface GlobalField {
  /** Finest first. Each is twice the reach and twice the step of the one before it. */
  readonly cascades: readonly GlobalFieldCascade[];
}

/**
 * How much of a cascade's extent, at each face, fades into the cascade outside it.
 *
 * **A hard switch between cascades is worse than either cascade's own error.** An error that is
 * wrong everywhere reads as a coarse solution; one that changes abruptly along a surface reads as
 * a crack, and the crack moves with the camera because the boundary does. A tenth of the extent
 * is wide enough that the fade is below a voxel per step and narrow enough that the inner
 * cascade's resolution is what most of the inner cascade actually delivers.
 */
export const GLOBAL_FIELD_BLEND = 0.1;

/** Allocate a field. Called once; `composeGlobalField` fills it and allocates nothing. */
export function createGlobalField(resolution: number, cascades: number): GlobalField {
  const samples = Math.trunc(resolution);
  if (!(samples >= 2)) {
    throw new Error(
      `createGlobalField: resolution is ${String(resolution)} and the minimum is 2. One sample on ` +
        'an axis has nothing to interpolate between.',
    );
  }
  const levels = Math.trunc(cascades);
  if (!(levels >= 1)) {
    throw new Error(
      `createGlobalField: cascade count is ${String(cascades)} and the minimum is 1.`,
    );
  }

  const out: GlobalFieldCascade[] = [];
  for (let level = 0; level < levels; level++) {
    out.push({
      field: new Float32Array(samples ** 3),
      albedo: new Float32Array(samples ** 3 * 3),
      dims: [samples, samples, samples],
      bounds: new Float32Array(6),
      step: 0,
    });
  }
  return { cascades: out };
}

/**
 * Put one cascade where the camera is, and answer its half-extent.
 *
 * **Exported because the compute path needs the same placement and two spellings drift.** A pass
 * filling these on a device has to agree with this about where every cascade stands, to the last
 * bit: disagree by a fraction of a step and the fade between cascades lands somewhere different on
 * each side, which is a seam that appears only when both paths are compared.
 *
 * The snapping is the decision. See `composeGlobalField` for why a grid centred on the exact camera
 * position makes the whole field shimmer.
 */
export function placeCascade(
  cascade: GlobalFieldCascade,
  level: number,
  radius: number,
  cameraPos: ReadonlyVec3,
): number {
  const half = radius * 2 ** level;
  const step = (2 * half) / ((cascade.dims[0] as number) - 1);
  cascade.step = step;
  for (let axis = 0; axis < 3; axis++) {
    const centre = Math.round((cameraPos[axis] as number) / step) * step;
    cascade.bounds[axis] = centre - half;
    cascade.bounds[axis + 3] = centre + half;
  }
  return half;
}

/** Scratch the composer reuses, because it runs once a frame and the rule about that is absolute. */
const INVERSE = new Float32Array(16);
const OBJECT = new Float32Array(3);
/** The nearest point of a source's box to the sample, for the bound outside it. */
const CLAMPED = new Float32Array(3);

/**
 * Fill every cascade from the instances standing near the camera.
 *
 * `radius` is the innermost cascade's half-extent in metres; each cascade outside it reaches twice
 * as far at the same sample count.
 *
 * **Every cascade's centre is snapped to a multiple of its own step, and that is the decision this
 * function exists to make.** A grid centred on the exact camera position resamples the entire
 * world at a new sub-pixel offset every frame, so every value changes slightly every frame and the
 * indirect light shimmers — worst on a slow camera, which is exactly when a viewer is looking at
 * it. Snapped, a camera move is either nothing at all or a whole voxel, and a whole voxel leaves
 * every sample the two grids share bit-identical.
 *
 * **A point no instance is near takes the cascade's own reach rather than infinity.** That is an
 * underestimate of the true distance, which is the safe direction: a march that steps by it takes
 * a shorter step than it could and converges anyway, where an overestimate steps through the wall
 * it was meant to stop at.
 *
 * **This is the reference, and it visits every sample of every cascade for every instance that is
 * not culled outright.** `scripts/gpu-parity.mjs` is the pattern the WGSL will be checked against,
 * and the WGSL is where the brick culling belongs — a CPU implementation that was already
 * accelerated would be a second thing to be wrong rather than the thing the first is checked by.
 */
export function composeGlobalField(
  instances: readonly GlobalFieldInstance[],
  cameraPos: ReadonlyVec3,
  radius: number,
  out: GlobalField,
): void {
  if (!(radius > 0)) {
    throw new Error(`composeGlobalField: radius is ${String(radius)} and must be positive.`);
  }

  for (const instance of instances) {
    assertUniformScale(instance.transform);
    assertCubicVoxels(instance.source);
  }

  for (let level = 0; level < out.cascades.length; level++) {
    const cascade = out.cascades[level] as GlobalFieldCascade;
    const half = placeCascade(cascade, level, radius, cameraPos);
    const [nx, ny, nz] = cascade.dims;
    const step = cascade.step;

    /* The reach, which is both the initial value and the distance past which an instance cannot
       change one — so it is also what culls an instance whose box is further away than that. */
    cascade.field.fill(half);
    /* White, so a sample no instance reached is neutral. See `GlobalFieldCascade.albedo`. */
    cascade.albedo.fill(1);

    const ox = cascade.bounds[0] as number;
    const oy = cascade.bounds[1] as number;
    const oz = cascade.bounds[2] as number;

    for (const instance of instances) {
      const albedo = instance.albedo;
      const ar = albedo === undefined ? 1 : (albedo[0] ?? 1);
      const ag = albedo === undefined ? 1 : (albedo[1] ?? 1);
      const ab = albedo === undefined ? 1 : (albedo[2] ?? 1);
      const scale = uniformScaleOf(instance.transform);
      if (mat4.invert(INVERSE, instance.transform) === null) continue;
      /*
       * **An instance further from this cascade than the cascade's own reach cannot change a
       * single sample in it**, because every sample already holds the reach and the minimum keeps
       * the smaller. So this is a pure speed decision and no test can see it: 64 instances over a
       * kilometre with four of them near the camera, four cascades of 33, compose in **19.4 ms
       * with this line and 150.2 ms without it**, to bit-identical output. Recorded as a
       * measurement for that reason — `sdf.ts`'s `NEIGHBOURS` is the same situation arriving from
       * the other direction, where the measurement said the extra work bought nothing.
       */
      if (
        boxDistance(
          instance,
          INVERSE,
          scale,
          ox,
          oy,
          oz,
          ox + 2 * half,
          oy + 2 * half,
          oz + 2 * half,
        ) > half
      ) {
        continue;
      }

      for (let iz = 0; iz < nz; iz++) {
        const wz = oz + iz * step;
        for (let iy = 0; iy < ny; iy++) {
          const wy = oy + iy * step;
          for (let ix = 0; ix < nx; ix++) {
            const index = ix + nx * (iy + ny * iz);
            const current = cascade.field[index] as number;
            const distance = sampleInstance(instance, INVERSE, scale, ox + ix * step, wy, wz);
            /* **The minimum, because the union of two solids is the nearer surface.** A maximum
               is the intersection and carves a groove along the seam of every wall that meets
               another wall, with the sign right on both sides of it. */
            /* **Written only where the instance won**, which is what makes the colour the
               nearest surface's rather than the last one's. A composer that wrote it beside the
               comparison would paint the whole field with whichever instance came last. */
            if (distance < current) {
              cascade.field[index] = distance;
              cascade.albedo[index * 3] = ar;
              cascade.albedo[index * 3 + 1] = ag;
              cascade.albedo[index * 3 + 2] = ab;
            }
          }
        }
      }
    }
  }
}

/**
 * The field at a world point, from the finest cascade that holds it.
 *
 * A point past every cascade reads the outermost one clamped to its edge, rather than a sentinel:
 * a caller marching outward wants a number it can step by, and the outermost cascade's own reach
 * is the honest one.
 */
export function sampleGlobalField(field: GlobalField, x: number, y: number, z: number): number {
  const last = field.cascades.length - 1;
  for (let level = 0; level <= last; level++) {
    const cascade = field.cascades[level] as GlobalFieldCascade;
    const inside = insideBy(cascade, x, y, z);
    if (inside <= 0) continue;
    const value = trilinear(cascade, x, y, z);
    if (level === last) return value;
    const band =
      GLOBAL_FIELD_BLEND * ((cascade.bounds[3] as number) - (cascade.bounds[0] as number));
    if (inside >= band) return value;
    const outer = trilinear(field.cascades[level + 1] as GlobalFieldCascade, x, y, z);
    const weight = inside / band;
    return outer + (value - outer) * weight;
  }
  return trilinear(field.cascades[last] as GlobalFieldCascade, x, y, z);
}

/** How far inside a cascade a point is, measured to the nearest face. Negative means outside. */
function insideBy(cascade: GlobalFieldCascade, x: number, y: number, z: number): number {
  const p = [x, y, z];
  let least = Infinity;
  for (let axis = 0; axis < 3; axis++) {
    const min = cascade.bounds[axis] as number;
    const max = cascade.bounds[axis + 3] as number;
    least = Math.min(least, (p[axis] as number) - min, max - (p[axis] as number));
  }
  return least;
}

/**
 * The distance one instance reports at a world point.
 *
 * **The world point is carried into object space through the inverse**, which is the transform
 * every implementation gets wrong first — and a sphere cannot see the mistake, because a sphere is
 * invariant under every rotation. Using the placement matrix itself puts the object at the mirror
 * of where it was asked to stand.
 *
 * **Outside the source's own box, the distance to the box is a bound and on its own it is a
 * useless one.** Every surface the field describes is inside the box, so nothing can be nearer
 * than the box is — true, and just outside the box it says *zero*, which is an underestimate of a
 * distance that is really most of a metre. Safe for a march in the sense that it never steps
 * through anything, and fatal in practice: a sphere trace stops where the field falls under its
 * epsilon, so a shell of near-zero around every instance's bounding box is a **phantom surface**.
 * It draws as dark fins radiating from every object, which is how it was found — by looking at
 * `demo/giFieldRig.ts`, after `globalField.test.ts`'s "never overestimates" passed it happily,
 * zero being an underestimate of everything.
 *
 * So the bound is taken against the field's own value at the nearest point of the box as well:
 * `d(q) >= d(c) - |q - c|` by the triangle inequality, and `d(q) >= |q - c|` because the surface
 * is inside. The larger of the two is still an underestimate and is the useful one — it reports
 * the real clearance just outside the box and falls back to the box distance far away.
 */
function sampleInstance(
  instance: GlobalFieldInstance,
  inverse: Float32Array,
  scale: number,
  x: number,
  y: number,
  z: number,
): number {
  const source = instance.source;
  OBJECT[0] =
    (inverse[0] as number) * x +
    (inverse[4] as number) * y +
    (inverse[8] as number) * z +
    (inverse[12] as number);
  OBJECT[1] =
    (inverse[1] as number) * x +
    (inverse[5] as number) * y +
    (inverse[9] as number) * z +
    (inverse[13] as number);
  OBJECT[2] =
    (inverse[2] as number) * x +
    (inverse[6] as number) * y +
    (inverse[10] as number) * z +
    (inverse[14] as number);

  let outsideSq = 0;
  for (let axis = 0; axis < 3; axis++) {
    const min = source.bounds[axis] as number;
    const max = source.bounds[axis + 3] as number;
    const value = OBJECT[axis] as number;
    CLAMPED[axis] = value < min ? min : value > max ? max : value;
    const over = value - (CLAMPED[axis] as number);
    outsideSq += over * over;
  }
  if (outsideSq > 0) {
    const outside = Math.sqrt(outsideSq);
    const atBox = sourceAt(
      source,
      CLAMPED[0] as number,
      CLAMPED[1] as number,
      CLAMPED[2] as number,
    );
    return Math.max(outside, atBox - outside) * scale;
  }
  return sourceAt(source, OBJECT[0] as number, OBJECT[1] as number, OBJECT[2] as number) * scale;
}

/** How far an instance's box is from a cascade's, so an instance too far away is skipped whole. */
function boxDistance(
  instance: GlobalFieldInstance,
  inverse: Float32Array,
  scale: number,
  minX: number,
  minY: number,
  minZ: number,
  maxX: number,
  maxY: number,
  maxZ: number,
): number {
  /*
   * The nearest point of the cascade to the instance's own centre, then that point's distance to
   * the instance's box. Conservative in the right direction: it never reports further than the
   * true separation, so an instance that could contribute is never culled.
   */
  const centre = instance.source.bounds;
  const world = instance.transform;
  const cx = ((centre[0] as number) + (centre[3] as number)) / 2;
  const cy = ((centre[1] as number) + (centre[4] as number)) / 2;
  const cz = ((centre[2] as number) + (centre[5] as number)) / 2;
  const wx =
    (world[0] as number) * cx +
    (world[4] as number) * cy +
    (world[8] as number) * cz +
    (world[12] as number);
  const wy =
    (world[1] as number) * cx +
    (world[5] as number) * cy +
    (world[9] as number) * cz +
    (world[13] as number);
  const wz =
    (world[2] as number) * cx +
    (world[6] as number) * cy +
    (world[10] as number) * cz +
    (world[14] as number);

  const nearX = Math.min(Math.max(wx, minX), maxX);
  const nearY = Math.min(Math.max(wy, minY), maxY);
  const nearZ = Math.min(Math.max(wz, minZ), maxZ);
  return sampleInstance(instance, inverse, scale, nearX, nearY, nearZ);
}

/** Trilinear read of a cascade, clamped at its own edge. */
function trilinear(cascade: GlobalFieldCascade, x: number, y: number, z: number): number {
  return read(cascade.field, cascade.dims, cascade.bounds, cascade.step, x, y, z);
}

/** Trilinear read of a source field, whose step this has to derive from its own bounds. */
function sourceAt(source: FieldSource, x: number, y: number, z: number): number {
  const step =
    ((source.bounds[3] as number) - (source.bounds[0] as number)) /
    ((source.dims[0] as number) - 1);
  return read(source.field, source.dims, source.bounds, step, x, y, z);
}

/** The one trilinear read both grids use, so the two cannot disagree about the layout. */
function read(
  field: Float32Array,
  dims: readonly [number, number, number],
  bounds: Float32Array,
  step: number,
  x: number,
  y: number,
  z: number,
): number {
  const [nx, ny, nz] = dims;
  const counts = [nx, ny, nz];
  const p = [x, y, z];
  const low = [0, 0, 0];
  const fraction = [0, 0, 0];
  for (let axis = 0; axis < 3; axis++) {
    const count = counts[axis] as number;
    const local = ((p[axis] as number) - (bounds[axis] as number)) / step;
    const clamped = local <= 0 ? 0 : local >= count - 1 ? count - 1 : local;
    const index = Math.min(Math.floor(clamped), count - 2);
    low[axis] = index;
    fraction[axis] = clamped - index;
  }

  const [lx, ly, lz] = low as [number, number, number];
  const [fx, fy, fz] = fraction as [number, number, number];
  let total = 0;
  for (let cz = 0; cz < 2; cz++) {
    const wz = cz === 0 ? 1 - fz : fz;
    for (let cy = 0; cy < 2; cy++) {
      const wy = cy === 0 ? 1 - fy : fy;
      for (let cx = 0; cx < 2; cx++) {
        const wx = cx === 0 ? 1 - fx : fx;
        const index = lx + cx + nx * (ly + cy + ny * (lz + cz));
        total += (field[index] as number) * wx * wy * wz;
      }
    }
  }
  return total;
}

/** The scale a transform applies, refusing one that differs between axes. See `transform`. */
function uniformScaleOf(transform: ReadonlyMat4): number {
  return Math.hypot(transform[0] as number, transform[1] as number, transform[2] as number);
}

/**
 * Refuse a source whose voxels are not cubic, which `sourceAt` and the shader both assume.
 *
 * **One step for all three axes is the contract, and it was unwritten until it cost a feature.**
 * `bakeObjectSdf` picks its step from the object's longest axis and gives each axis whatever count
 * it needs at that step, so `dims` differ per axis and the spacing does not. Both readers rely on
 * that: `sourceAt` here derives the step from x alone, and `composeField.wgsl.ts` says so in a
 * comment. A source sampled with the same count on every axis of a box that is not a cube has
 * oblong voxels, and every sample of it is taken at the wrong place along y and z — far enough
 * wrong that a point at the centre of a slab reads the slab's corner.
 *
 * **Measured on `demo/dev/bounce.html`**, whose room is five such slabs: the composed field held
 * almost no room, 98.9% of every probe's rays left a closed room, and the traced bounce delivered a
 * thirty-fifth of the light. Nothing failed; the field was simply empty. Refusing is the only
 * honest answer, because a distance field carries no record of the axis it was sampled along and
 * there is nothing here to correct it with — the same reason a non-uniform scale is refused above.
 *
 * **An axis of one sample is refused here too, and by its own sentence**, because `read` addresses
 * `index` and `index + 1` on every axis and cannot be given an axis with no pair. `bakeObjectSdf`
 * never produces one — its counts are a ceiling plus one over a span that includes two voxels of
 * padding — but `FieldSource` is a shape a consumer may build by hand, which is the whole reason
 * this function exists.
 */
export function assertCubicVoxels(source: FieldSource): void {
  const steps = [0, 1, 2].map((axis) => {
    const count = source.dims[axis] as number;
    if (count < 2) {
      throw new Error(
        `driftengine: a distance field source is ${source.dims.join('x')} samples and every axis ` +
          'needs at least two. One sample on an axis has no neighbour to interpolate towards.',
      );
    }
    return ((source.bounds[axis + 3] as number) - (source.bounds[axis] as number)) / (count - 1);
  });
  const low = Math.min(...steps);
  const high = Math.max(...steps);
  if (high - low <= 1e-3 * high) return;
  throw new Error(
    `driftengine: a distance field source's voxels are ${steps
      .map((step) => step.toFixed(4))
      .join(' by ')} metres and have to be cubic. Its dims are ${source.dims.join('x')} over a ` +
      'box that is not that shape; give each axis the count it needs at one step, as ' +
      'bakeObjectSdf does.',
  );
}

function assertUniformScale(transform: ReadonlyMat4): void {
  const x = Math.hypot(transform[0] as number, transform[1] as number, transform[2] as number);
  const y = Math.hypot(transform[4] as number, transform[5] as number, transform[6] as number);
  const z = Math.hypot(transform[8] as number, transform[9] as number, transform[10] as number);
  const spread = Math.max(x, y, z) - Math.min(x, y, z);
  if (spread > 1e-4 * Math.max(x, y, z)) {
    throw new Error(
      `composeGlobalField: an instance is scaled ${x.toFixed(3)}, ${y.toFixed(3)}, ` +
        `${z.toFixed(3)}, and a distance field takes a uniform scale only. There is no factor to ` +
        'correct a non-uniform one by: it depends on the direction to the nearest surface, which ' +
        'is what the field does not record.',
    );
  }
}
