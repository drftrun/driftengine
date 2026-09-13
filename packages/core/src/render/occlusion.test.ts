import { mat4 } from 'gl-matrix';
import { describe, expect, it } from 'vitest';

import { createBounds } from '../math/bounds.ts';
import type { Bounds } from '../math/bounds.ts';
import { OcclusionBuffer } from './occlusion.ts';

/**
 * Occlusion culling, asserted as arithmetic.
 *
 * **This is the whole reason it is on the CPU.** A hardware query or a GPU pyramid could only be
 * checked by photographing a scene and counting draws; a buffer built here is a function of a
 * matrix and some boxes, and a test can put an object behind a wall and ask.
 *
 * Every case that matters is a *conservative* one — the cull that must not happen — because a cull
 * that is wrong in that direction is a hole in the world and no tuning makes it acceptable.
 */

/** A camera at `(0, 0, z)` looking down −z, which is where every fixture below stands. */
function viewProj(eyeZ = 10): Float32Array {
  const projection = mat4.create();
  mat4.perspective(projection, (60 * Math.PI) / 180, 16 / 9, 0.1, 100);
  const view = mat4.create();
  mat4.lookAt(view, [0, 0, eyeZ], [0, 0, 0], [0, 1, 0]);
  const out = mat4.create();
  mat4.multiply(out, projection, view);
  return out as Float32Array;
}

const IDENTITY = mat4.create() as Float32Array;

/** A translation, so a fixture can place a box without building a matrix by hand each time. */
function at(x: number, y: number, z: number): Float32Array {
  const m = mat4.create();
  mat4.translate(m, m, [x, y, z]);
  return m as Float32Array;
}

/**
 * A bounding sphere, built by hand.
 *
 * `createBounds` takes no arguments — it makes an empty one for a caller to measure into — so a
 * fixture that passed a centre and a radius to it would silently test a zero-radius sphere at the
 * origin, which is inside every wall here. Written out so the fixture says what it is.
 */
function sphere(centre: readonly [number, number, number], radius: number): Bounds {
  const bounds = createBounds();
  bounds.centre.set(centre);
  bounds.min.set([centre[0] - radius, centre[1] - radius, centre[2] - radius]);
  bounds.max.set([centre[0] + radius, centre[1] + radius, centre[2] + radius]);
  bounds.radius = radius;
  return bounds;
}

function buffer(): OcclusionBuffer {
  return new OcclusionBuffer({ width: 256, height: 144 });
}

/** A wall four metres wide and four tall, one metre thick, standing at the origin. */
const WALL_MIN = [-4, -4, -0.5];
const WALL_MAX = [4, 4, 0.5];

describe('occlusion culling', () => {
  it('culls nothing at all when no occluder was declared', () => {
    const occlusion = buffer();
    occlusion.begin(viewProj());
    expect(occlusion.declared).toBe(0);
    expect(occlusion.occluded(sphere([0, 0, -5], 1), IDENTITY)).toBe(false);
  });

  /** The case the feature exists for: a small thing directly behind a large one. */
  it('culls a sphere squarely behind a wall', () => {
    const occlusion = buffer();
    occlusion.begin(viewProj());
    occlusion.addOccluder(WALL_MIN, WALL_MAX, IDENTITY);
    expect(occlusion.declared).toBe(1);
    expect(occlusion.occluded(sphere([0, 0, -5], 0.5), IDENTITY)).toBe(true);
  });

  /**
   * **The cull that must never happen**, and the three shapes it takes.
   *
   * In front of the wall, beside it, and larger than it — each of which a buffer that had lost its
   * conservatism would cull, and each of which would be a hole in the world.
   */
  it('draws anything the wall does not actually hide', () => {
    const occlusion = buffer();
    occlusion.begin(viewProj());
    occlusion.addOccluder(WALL_MIN, WALL_MAX, IDENTITY);

    expect(occlusion.occluded(sphere([0, 0, 5], 0.5), IDENTITY), 'in front').toBe(false);
    /* Past the box's near-edge silhouette, which reaches x = 6.32 at this depth. */
    expect(occlusion.occluded(sphere([9, 0, -5], 0.5), IDENTITY), 'beside it').toBe(false);
    /* Wider than the wall, so its rectangle reaches past the occluded region on both sides. */
    expect(occlusion.occluded(sphere([0, 0, -5], 6), IDENTITY), 'larger than it').toBe(false);
  });

  /**
   * A sphere touching the wall's own plane is not behind it.
   *
   * The test compares the object's **nearest** point, so anything straddling the occluder has to
   * survive — this is the boundary where an off-by-one in the depth comparison shows.
   */
  it("compares the object's nearest point, not its centre and not its far side", () => {
    const occlusion = buffer();
    occlusion.begin(viewProj());
    occlusion.addOccluder(WALL_MIN, WALL_MAX, IDENTITY);
    /*
     * **Three spheres on one line, and each fails a different mistake.**
     *
     * The first is centred *in front* of the wall and reaches behind it: comparing the far side
     * would cull it, and it is plainly on screen. The second is centred *behind* and reaches in
     * front: comparing the centre would cull it. The third is wholly behind and is the control that
     * says the other two are not passing because the wall stopped occluding.
     */
    expect(occlusion.occluded(sphere([0, 0, 1.4], 1.2), IDENTITY), 'reaching back').toBe(false);
    expect(occlusion.occluded(sphere([0, 0, -1.4], 1.2), IDENTITY), 'reaching forward').toBe(false);
    expect(occlusion.occluded(sphere([0, 0, -4], 1.2), IDENTITY), 'wholly behind').toBe(true);
  });

  /**
   * **The one-texel erosion, which is what makes a silhouette safe** — and the arithmetic that says
   * where the silhouette actually is, because it is not where it first looks.
   *
   * The wall is a *box*, half a metre thick, and what casts the shadow is its **near** edge rather
   * than its far one: the ray from the eye at `(0, 0, 10)` through the corner `(4, ·, 0.5)` reaches
   * `x = 6.32` at the depth `z = −5`, where the ray through `(4, ·, −0.5)` reaches only 5.71. So
   * everything inside 6.32 at that depth is genuinely hidden and culling it is correct.
   *
   * What the erosion buys is the **last texel before that line**. An object at 6.25 is still inside
   * the true silhouette and is drawn anyway, because the border texel gave its bound back — one
   * texel at that depth being about twelve centimetres. That is the margin, measured, and it is the
   * only direction this may be wrong in.
   */
  it('stops culling a texel short of the silhouette, which is what the erosion buys', () => {
    const occlusion = buffer();
    occlusion.begin(viewProj());
    occlusion.addOccluder(WALL_MIN, WALL_MAX, IDENTITY);
    /* Well inside the shadow: culled, and the reason the case below is not vacuous. */
    expect(occlusion.occluded(sphere([5.5, 0, -5], 0.02), IDENTITY), 'inside').toBe(true);
    /*
     * Seven centimetres inside the true silhouette, and drawn anyway. **A sphere this small is what
     * makes the assertion discriminating**: its rectangle is about one texel, so the test reads
     * level 0 where the erosion actually happened — a larger object reads a coarser level, where a
     * border texel with one far child was already far and the erosion changes nothing. Measured
     * with the erosion removed: the cull then runs to 6.30, two centimetres from the silhouette,
     * with nothing between it and a hole but the rasteriser's coverage being exact at a boundary
     * where it is not.
     */
    expect(occlusion.occluded(sphere([6.25, 0, -5], 0.02), IDENTITY), 'at the edge').toBe(false);
  });

  /** A shape crossing the near plane has no projection, and abstaining is the only safe answer. */
  it('abstains for anything crossing the eye', () => {
    const occlusion = buffer();
    occlusion.begin(viewProj());
    occlusion.addOccluder(WALL_MIN, WALL_MAX, IDENTITY);
    expect(occlusion.occluded(sphere([0, 0, 10], 1), IDENTITY)).toBe(false);
  });

  /** An occluder crossing the eye is dropped whole rather than half-rasterised. */
  it('drops an occluder that crosses the eye rather than rasterising part of it', () => {
    const occlusion = buffer();
    occlusion.begin(viewProj());
    occlusion.addOccluder(WALL_MIN, WALL_MAX, at(0, 0, 10));
    expect(occlusion.declared, 'not counted').toBe(0);
    expect(occlusion.occluded(sphere([0, 0, -5], 0.5), IDENTITY)).toBe(false);
  });

  /** Two occluders side by side hide what neither hides alone, which is what the min-depth does. */
  it('lets two occluders hide between them what neither hides alone', () => {
    const occlusion = buffer();
    occlusion.begin(viewProj());
    /* Two narrow walls meeting at the origin, so a wide object behind them is fully covered. */
    occlusion.addOccluder([-4, -4, -0.5], [0.1, 4, 0.5], IDENTITY);
    occlusion.addOccluder([-0.1, -4, -0.5], [4, 4, 0.5], IDENTITY);
    expect(occlusion.occluded(sphere([0, 0, -6], 1.5), IDENTITY)).toBe(true);
  });

  /** The frame starts empty: last frame's occluders are last frame's. */
  it('forgets its occluders when a frame begins', () => {
    const occlusion = buffer();
    occlusion.begin(viewProj());
    occlusion.addOccluder(WALL_MIN, WALL_MAX, IDENTITY);
    expect(occlusion.occluded(sphere([0, 0, -5], 0.5), IDENTITY)).toBe(true);
    occlusion.begin(viewProj());
    expect(occlusion.occluded(sphere([0, 0, -5], 0.5), IDENTITY)).toBe(false);
  });

  it('resizes to a new aspect and keeps its pyramid whole', () => {
    const occlusion = buffer();
    occlusion.resize({ width: 128, height: 128 });
    expect(occlusion.width).toBe(128);
    expect(occlusion.height).toBe(128);
    occlusion.begin(viewProj());
    occlusion.addOccluder(WALL_MIN, WALL_MAX, IDENTITY);
    expect(occlusion.occluded(sphere([0, 0, -5], 0.5), IDENTITY)).toBe(true);
  });
});
