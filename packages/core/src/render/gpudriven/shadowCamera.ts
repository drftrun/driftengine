/** Where the second pipeline's light stands, and the two corrections its map needs. */

/**
 * **The light's projection, fitted to the scene's bounding sphere rather than the camera.**
 *
 * The forward path fits a cascade to the *view* frustum, which is what a large world wants: the map
 * follows the camera and spends its texels where the viewer is. It also costs that path a snapping
 * rule, because a box that moves continuously makes every shadow edge crawl as the camera turns.
 *
 * This one fitted the whole scene, and still does while the scene is no larger than the radius a
 * caller names: its rigs are a few metres across, so a sphere around the lot is a box that never
 * moves and therefore never shimmers. **What that gave up was stated rather than discovered** — a
 * world too big for one map gets a soft, coarse shadow everywhere — and a world arrived: the voxel
 * sandbox's port. So past that radius `fitShadow` follows the eye instead, snapped as the forward
 * path's cascade is. One sphere rather than a cascade of them: `docs/CAPABILITIES.md` records what
 * that costs at a distance.
 *
 * **A sphere rather than an eight-corner box**, because a box's extent in light space depends on
 * the sun's direction and a sphere's does not — so the fit is the same size at every hour, and a
 * shadow that grows softer as the sun moves is the sun moving rather than the fit breathing.
 */

import { SHADOW_DEPTH_FADE } from './shadow.ts';

/** Where the basis stops taking `y` as its reference. Any sun steeper than this is overhead. */
const OVERHEAD = 0.99;

/**
 * A bounding sphere over every cluster, from the world bounds the cull buffer already holds.
 *
 * **It reads the transformed bounds rather than transforming them itself**, which it did until
 * 2026-09-17 and which was one of two places in this pipeline that multiplied a cluster by its
 * mesh's matrix. `clusterWorld.ts` is the other and is now the only one: two copies of that
 * arithmetic can disagree about the scale a sphere takes, and a light's box that disagrees with the
 * cull's bounds clips casters out of a map that the cull believes are in it — which is a surface
 * lit with something standing in front of it.
 *
 * `stride` is how many floats a cluster occupies; `CLUSTER_CULL_FLOATS` for the cull buffer, where
 * the centre and radius are the first four of eight.
 *
 * `out` is the centre and the radius, four floats.
 */
export function sceneShadowBounds(
  /** Centre and radius, four floats at every `stride`, in world space. */
  bounds: Float32Array,
  stride: number,
  count: number,
  out: Float32Array,
): Float32Array {
  let lowX = Infinity;
  let lowY = Infinity;
  let lowZ = Infinity;
  let highX = -Infinity;
  let highY = -Infinity;
  let highZ = -Infinity;

  for (let c = 0; c < count; c += 1) {
    const at = c * stride;
    const cx = bounds[at] as number;
    const cy = bounds[at + 1] as number;
    const cz = bounds[at + 2] as number;
    const radius = bounds[at + 3] as number;
    /*
     * **A record of no radius is a slot nobody holds, not a cluster at the origin.** A streaming
     * scene's buffers are sized by capacity, so the records past what is live are zeros — and
     * counting them stretches this box all the way back to the origin over empty space, which puts
     * the light's whole depth range across a volume that is mostly nothing. A static scene has no
     * such records and is unaffected: a baked cluster always has a positive radius.
     */
    if (!(radius > 0)) continue;
    lowX = Math.min(lowX, cx - radius);
    lowY = Math.min(lowY, cy - radius);
    lowZ = Math.min(lowZ, cz - radius);
    highX = Math.max(highX, cx + radius);
    highY = Math.max(highY, cy + radius);
    highZ = Math.max(highZ, cz + radius);
  }

  if (!Number.isFinite(lowX)) {
    /*
     * **A scene with no clusters is a unit sphere, not a point.** A radius of zero divides by zero
     * in the fit below and every entry of the matrix comes back NaN — which reaches the device as
     * a draw that covers nothing and a lookup that is never inside the map, so the frame is simply
     * unshadowed and nothing says why.
     */
    out[0] = 0;
    out[1] = 0;
    out[2] = 0;
    out[3] = 1;
    return out;
  }

  out[0] = (lowX + highX) * 0.5;
  out[1] = (lowY + highY) * 0.5;
  out[2] = (lowZ + highZ) * 0.5;
  out[3] = Math.max(
    Math.hypot(highX - lowX, highY - lowY, highZ - lowZ) * 0.5,
    /* Never zero, for the reason above: one flat quad is a legal scene. */
    1e-3,
  );
  return out;
}

/**
 * The light's view-projection, in the OpenGL convention the rest of this engine builds matrices in:
 * `x` and `y` in -1..1 and `z` in -1..1 as well. Returns the metres its depth range spans.
 *
 * **Written out rather than composed from a look-at and an orthographic**, because the product is
 * four lines and the two halves are not independently useful. The whole of it is: project onto the
 * light's basis, divide by the radius, and negate the depth axis so that *nearer the light* is
 * smaller — which is the direction a depth test with `less` wants and is the opposite of the
 * frame's reversed depth. `depthConvention.ts` carries why shadows are not reversed.
 *
 * `lightDir` points **toward** the light, as `Environment.directionalDir` does.
 */
/** The light's right, up and toward-the-light axes, nine numbers. See `lightBasis`. */
const BASIS = new Float64Array(9);

/**
 * The light's three axes, which depend on its direction and on nothing else.
 *
 * **One basis for both fits, and the following fit needs it to be exactly this.** Snapping a map
 * to whole texels only holds its edges still if the texel grid it snaps to is fixed, and the grid
 * is this basis: `lightMatrix.ts` says the same about the forward path's, where anchoring the light
 * at the focus instead would move light space under the snap and cancel it.
 */
function lightBasis(lightDir: readonly [number, number, number], out: Float64Array): void {
  const length = Math.hypot(lightDir[0], lightDir[1], lightDir[2]) || 1;
  const ax = lightDir[0] / length;
  const ay = lightDir[1] / length;
  const az = lightDir[2] / length;

  /*
   * **The reference direction moves when the sun is overhead, and a sun overhead is the common
   * case.** `cross(up, axis)` collapses as the two line up, so a light within a degree of straight
   * down produces a basis of denormals and a map that is mostly one texel. Noon is not an edge
   * case in a day cycle.
   */
  const upX = Math.abs(ay) > OVERHEAD ? 0 : 0;
  const upY = Math.abs(ay) > OVERHEAD ? 0 : 1;
  const upZ = Math.abs(ay) > OVERHEAD ? 1 : 0;

  let rx = upY * az - upZ * ay;
  let ry = upZ * ax - upX * az;
  let rz = upX * ay - upY * ax;
  const rLength = Math.hypot(rx, ry, rz) || 1;
  rx /= rLength;
  ry /= rLength;
  rz /= rLength;

  /* The third axis is the cross of the other two, so the basis is orthonormal by construction. */
  out[0] = rx;
  out[1] = ry;
  out[2] = rz;
  out[3] = ay * rz - az * ry;
  out[4] = az * rx - ax * rz;
  out[5] = ax * ry - ay * rx;
  out[6] = ax;
  out[7] = ay;
  out[8] = az;
}

export function fitDirectionalShadow(
  centre: ArrayLike<number>,
  radius: number,
  lightDir: readonly [number, number, number],
  out: Float32Array,
): number {
  lightBasis(lightDir, BASIS);
  const rx = BASIS[0] as number;
  const ry = BASIS[1] as number;
  const rz = BASIS[2] as number;
  const ux = BASIS[3] as number;
  const uy = BASIS[4] as number;
  const uz = BASIS[5] as number;
  const ax = BASIS[6] as number;
  const ay = BASIS[7] as number;
  const az = BASIS[8] as number;

  const scale = 1 / Math.max(radius, 1e-6);
  const put = (column: number, x: number, y: number, z: number): void => {
    out[column * 4] = x;
    out[column * 4 + 1] = y;
    out[column * 4 + 2] = z;
    out[column * 4 + 3] = 0;
  };
  /* Rows are the basis and columns are the axes: row 0 is the light's right, row 2 its depth. */
  put(0, rx * scale, ux * scale, -ax * scale);
  put(1, ry * scale, uy * scale, -ay * scale);
  put(2, rz * scale, uz * scale, -az * scale);

  const dot = (x: number, y: number, z: number): number =>
    x * (centre[0] as number) + y * (centre[1] as number) + z * (centre[2] as number);
  out[12] = -dot(rx, ry, rz) * scale;
  out[13] = -dot(ux, uy, uz) * scale;
  /* Positive, because the depth row is already negated: the centre of the scene lands at zero. */
  out[14] = dot(ax, ay, az) * scale;
  out[15] = 1;

  /* The box is a diameter deep, which is what turns a stored depth difference into metres. */
  return 2 * Math.max(radius, 1e-6);
}

/**
 * **The map for a frame: the whole scene while it fits inside `follow` metres, and a sphere of that
 * radius around the eye once it does not.**
 *
 * The scene fit is right for what this pipeline was first given — rigs a few metres across, a box
 * that never moves and so never shimmers — and wrong for a world, which is what the voxel
 * sandbox's port made this pipeline draw: at radius 14 its sphere is hundreds of metres across and
 * a 2048 map over it has texels a quarter of a metre wide. So past a radius the caller names, the
 * map follows the eye, as the forward path's does in `lightMatrix.ts`. **At or under it nothing
 * changes, to the bit**, and with no radius at all nothing ever does — which is what keeps the three
 * rigs the control rather than a second fit's first customer.
 *
 * **Why the scene's size rather than whether the eye is inside it**: a fit that switched as the eye
 * crossed a boundary would jump the whole map between two scales mid-walk, where a scene grows past
 * the radius once and stays there.
 *
 * `sphere` is the scene's centre and radius, four floats, as `sceneShadowBounds` writes them.
 * Returns the metres the depth range spans, which the lookup multiplies a stored difference by.
 */
export function fitShadow(
  sphere: ArrayLike<number>,
  eye: ArrayLike<number>,
  follow: number | undefined,
  lightDir: readonly [number, number, number],
  mapSize: number,
  out: Float32Array,
): number {
  const radius = sphere[3] as number;
  /* No radius is an infinite one: a scene is never larger, so the fit never follows. */
  if (!(radius > (follow ?? Infinity))) {
    return fitDirectionalShadow(sphere, radius, lightDir, out);
  }
  return fitFollowingShadow(eye, follow as number, sphere, lightDir, mapSize, out);
}

/**
 * A sphere of `radius` around `focus`, **snapped to whole texels of a fixed light space**, and deep
 * enough toward the light to hold every caster the scene has there.
 *
 * **Snapped, or every edge crawls.** The basis is the light's alone, so the grid is fixed; the
 * focus's three light-space coordinates are rounded to it, and the map moves in whole texels or not
 * at all. A world point then falls in the same texel until the map steps, rather than at a new
 * sub-texel offset every frame.
 *
 * **Deep enough toward the sun for every caster.** A receiver is inside the sphere, and anything
 * that shadows one lies between it and the light — so the range reaches toward the light as far as
 * the scene's own far side, which is where the last possible caster is. `lightMatrix.ts` reaches
 * three radii; a dusk sun over a city casts a tower's shadow further than that, and the scene's
 * sphere is known exactly here. **The reach is rounded up to whole radii**, so it changes only when
 * the eye has walked a radius along the light rather than rescaling every stored depth each frame.
 *
 * **And symmetric about the eye, which is not for casters but for the lookup.** The lookup gives
 * up on the last stretch of stored depth, `SHADOW_DEPTH_FADE`, because in the scene fit that is the
 * scene's far rim. The first version of this reached only a radius away from the sun, which put
 * every receiver in that stretch — the ground below the eye came out less shadowed the further
 * below it was, and the sphere's far side not at all. Symmetric, a receiver at most a radius from
 * the eye is stored within `radius / reach` of the middle, and the least reach is the whole number
 * of radii that keeps that short of the fade.
 */
function fitFollowingShadow(
  focus: ArrayLike<number>,
  radius: number,
  sphere: ArrayLike<number>,
  lightDir: readonly [number, number, number],
  mapSize: number,
  out: Float32Array,
): number {
  lightBasis(lightDir, BASIS);
  const rx = BASIS[0] as number;
  const ry = BASIS[1] as number;
  const rz = BASIS[2] as number;
  const ux = BASIS[3] as number;
  const uy = BASIS[4] as number;
  const uz = BASIS[5] as number;
  const ax = BASIS[6] as number;
  const ay = BASIS[7] as number;
  const az = BASIS[8] as number;
  const fx = focus[0] as number;
  const fy = focus[1] as number;
  const fz = focus[2] as number;

  const texel = (2 * radius) / Math.max(1, mapSize);
  const across = Math.round((rx * fx + ry * fy + rz * fz) / texel) * texel;
  const up = Math.round((ux * fx + uy * fy + uz * fz) / texel) * texel;
  const along = Math.round((ax * fx + ay * fy + az * fz) / texel) * texel;

  const farSide =
    ax * (sphere[0] as number) +
    ay * (sphere[1] as number) +
    az * (sphere[2] as number) +
    (sphere[3] as number);
  /*
   * A receiver a radius from the eye is stored at 0.5 + radius / (2 reach); keeping that below the
   * fade's start needs reach >= radius / (2 (start - 0.5)), which is 1.25 radii and so two.
   */
  const least = Math.ceil(1 / (2 * ((SHADOW_DEPTH_FADE[0] as number) - 0.5)));
  const reach = radius * Math.max(least, Math.ceil((farSide - along) / radius));

  const scale = 1 / radius;
  const depth = 1 / reach;
  const put = (column: number, x: number, y: number, z: number): void => {
    out[column * 4] = x;
    out[column * 4 + 1] = y;
    out[column * 4 + 2] = z;
    out[column * 4 + 3] = 0;
  };
  put(0, rx * scale, ux * scale, -ax * depth);
  put(1, ry * scale, uy * scale, -ay * depth);
  put(2, rz * scale, uz * scale, -az * depth);
  out[12] = -across * scale;
  out[13] = -up * scale;
  /* Nearer the light is smaller, as in the scene fit: the sunward end lands at -1. */
  out[14] = along * depth;
  out[15] = 1;
  return 2 * reach;
}

/**
 * **Two corrections, and the difference is one negated row.**
 *
 * The lookup wants the light-space position with `x` and `y` still in -1..1 — it remaps those
 * itself — and `z` already in the 0..1 WebGPU clips to. That is `SHADOW_LOOKUP_CORRECTION`, and it
 * is `SHADOW_CLIP_CORRECTION` in `webgpu/renderer.ts` under another name, for the same reason: a
 * map is sampled rather than presented.
 *
 * The raster wants the same depth and the **opposite rows**, and this is the part that is easy to
 * get backwards. A generated vertex stage ends with `gl_Position.y = -gl_Position.y`, which naga
 * writes and nothing here does — so the forward path's shadow pass is handed the unflipped matrix
 * and emits a flipped picture, while a hand-written stage handed the same matrix emits an unflipped
 * one and stores every row at the mirror of where the lookup goes looking. Flipping it here is what
 * puts the two pipelines' maps in the same orientation, so one lookup can read either.
 *
 * **And the flip reverses the winding with it**, which is why the pipeline that uses this declares
 * `frontFace: 'cw'` — the same pair `depthPass.ts` carries, arrived at from the other side.
 *
 * Neither reverses depth. `depthConvention.ts` leaves shadow maps conventional, so the row is
 * `0.5z + 0.5` where the frame's is `0.5 - 0.5z`, and the pass that renders one clears to
 * `SHADOW_DEPTH_CLEAR` and compares with `less`.
 */
export const SHADOW_LOOKUP_CORRECTION = new Float32Array([
  1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0.5, 0, 0, 0, 0.5, 1,
]);

export const SHADOW_RASTER_CORRECTION = new Float32Array([
  1, 0, 0, 0, 0, -1, 0, 0, 0, 0, 0.5, 0, 0, 0, 0.5, 1,
]);

/**
 * How far toward the light the light's cone test stands its eye, in metres.
 *
 * **A directional light has no eye, and the cone test wants one.** Stood this far toward the sun,
 * every direction from the eye to a cluster in the map is the sun's own to within the cluster's
 * distance from the camera over this — three hundred-thousandths of a radian across a city three
 * kilometres wide — so the perspective test answers the directional one the map's raster applies
 * when it culls the faces turned from the light. A triangle it could cull wrongly is that close to
 * edge-on to the sun, and covers a thousandth of a texel of any map. In `float32` the eye is good
 * to eight metres of the hundred million, which moves the direction by less again.
 */
export const LIGHT_CONE_DISTANCE = 1e8;

/** The eye the light's cone test reads: `eye` moved `LIGHT_CONE_DISTANCE` toward the light. */
export function lightConeEye(
  eye: ArrayLike<number>,
  lightDir: ArrayLike<number>,
  out: [number, number, number],
): [number, number, number] {
  const x = lightDir[0] as number;
  const y = lightDir[1] as number;
  const z = lightDir[2] as number;
  const scale = LIGHT_CONE_DISTANCE / (Math.hypot(x, y, z) || 1);
  out[0] = (eye[0] as number) + x * scale;
  out[1] = (eye[1] as number) + y * scale;
  out[2] = (eye[2] as number) + z * scale;
  return out;
}

/**
 * The raster's matrix with its depth turned over, `1 - z`, and nothing else moved: what the light's
 * cull projects a cluster through, because the light's pyramid is stored turned over
 * (`shadowPyramidBase`) so the camera's cull and reduction can read it. Applied after
 * `SHADOW_RASTER_CORRECTION`, so the rows are the raster's, which are the map's and the pyramid's.
 */
export const SHADOW_CULL_CORRECTION = new Float32Array([
  1, 0, 0, 0, 0, 1, 0, 0, 0, 0, -1, 0, 0, 0, 1, 1,
]);

/** `out = correction · light`, column-major. */
export function correctShadowMatrix(
  correction: Float32Array,
  light: Float32Array,
  out: Float32Array,
): Float32Array {
  for (let column = 0; column < 4; column += 1) {
    for (let row = 0; row < 4; row += 1) {
      let sum = 0;
      for (let k = 0; k < 4; k += 1) {
        sum += (correction[k * 4 + row] as number) * (light[column * 4 + k] as number);
      }
      out[column * 4 + row] = sum;
    }
  }
  return out;
}
