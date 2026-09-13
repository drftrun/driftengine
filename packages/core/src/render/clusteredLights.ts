/**
 * The froxel table: what it looks like in memory, and the CPU binner that fills it.
 *
 * **One table, two producers, one reader.** A compute shader writes this on WebGPU and this file
 * writes it on WebGL2, and the lit pass fetches it the same way on both. That is the 2026-08-13
 * rule applied literally — the decision is backend-neutral and only the binding is per-backend —
 * and it is why the table is a *texture* rather than a storage buffer, which only one backend has.
 *
 * **The layout is chosen so the two producers can be compared, not merely trusted.** The
 * 2026-08-17 rule says two implementations of one decision drift, and drift invisibly when the
 * constants are identical; a CPU binner and a GPU binner are exactly that. So every choice here
 * that could have gone either way went the way that makes a byte-for-byte comparison possible:
 * fixed slots rather than an appended list, an integer ordering rather than a distance sort, and
 * an overflow rule both can evaluate. `scripts/cluster-check.mjs` is the comparison.
 */

/** Tiles across the screen. */
export const CLUSTER_X = 16;
/** Tiles down the screen. */
export const CLUSTER_Y = 9;
/** Depth slices, partitioned exponentially. */
export const CLUSTER_Z = 24;

export const CLUSTER_COUNT = CLUSTER_X * CLUSTER_Y * CLUSTER_Z;

/**
 * Texels a cluster occupies: one for its count, seven holding four light indices each.
 *
 * **Fixed rather than packed, and that is what removes the atomics.** One invocation owns one
 * cluster and writes only its own run, so nothing is appended to a shared list, there is no
 * counter to increment atomically and no compaction pass. That is also what lets the GPU binner
 * write through a *write-only* storage texture, which is all core WGSL gives.
 */
export const CLUSTER_TEXELS = 5;

/**
 * How many lights one cluster can hold. Four index texels at four indices each.
 *
 * **Sixteen because that is `MAX_POINT_LIGHTS`, and the equality is the point.** The light loop's
 * bound has to be a constant and there is only one loop, so a larger cap here would raise it for
 * the fixed path too — a scene that never asks for froxels would carry a loop bound of 28 where it
 * carries 16 today, which on the driver that faulted under the full shader is precisely the sort
 * of change nobody would attribute to clustering. Equal bounds mean the fixed path is untouched.
 *
 * **It is not the old limit wearing a new hat.** Sixteen was a budget for the *whole scene*, chosen
 * by distance with a contention band because somebody always had to be last. Sixteen per froxel is
 * a different sixteen in every froxel, out of `MAX_CLUSTERED_LIGHTS` in the scene.
 */
export const MAX_LIGHTS_PER_CLUSTER = (CLUSTER_TEXELS - 1) * 4;

/**
 * How many lights the clustered path carries at once.
 *
 * **This is the number that replaces `MAX_POINT_LIGHTS`**, and it is not bounded by the same
 * thing: the sixteen is a uniform-array size and an iteration of the widest shader's light loop,
 * while this is a row count in a texture nobody iterates in full. 320 lights is three rows.
 *
 * 320 rather than 256 because the light region has to end on a row boundary — see `TABLE_WIDTH` —
 * and at three texels a light, 320 is the smallest count at or above 256 that does.
 */
export const MAX_CLUSTERED_LIGHTS = 320;

/**
 * Texels one light's record occupies: position and radius, colour and emitter size, then the
 * weight and the shadow slot.
 *
 * **The shadow slot is an index into the existing sixteen-wide shadow uniforms, not a layer.**
 * Clustering lifts how many lights *shade* a fragment; it does not lift how many shadow maps
 * exist, and it should not — the pool is twenty-two octahedral layers at 1024, 92.3 MB, and that
 * is a memory budget rather than a shader limit. So a clustered light either holds one of those
 * slots or casts no shadow, exactly as a light does today, and `-1` says which.
 *
 * GLSL ES can index a *uniform array* with a non-constant expression; it is only sampler arrays
 * it cannot. That is what lets a light index the shadow uniforms by a number read from a texture,
 * and it is the same fact the octahedral array texture was built on.
 */
export const LIGHT_TEXELS = 5;

/**
 * Where each field of a light's record sits, as an offset in `uint`s from `lightBase`.
 *
 * **Written out rather than left to the two writers to agree on**, because there are two: this
 * file's CPU binner and `clusterBinner.ts`'s WGSL kernel, and the 2026-08-17 rule is that two
 * implementations of one decision drift invisibly when the constants are identical.
 * `scripts/cluster-check.mjs` compares the tables byte for byte and is the backstop; this table is
 * so that the two are written from one statement rather than compared after the fact.
 *
 * Slots 10 to 15 arrived with the fourth texel and the spot fields fill them exactly — direction,
 * two cone cosines, and a profile index — with nothing spare. Slots 10 and 11 were already free
 * inside the third texel and were being written as literal zeros.
 *
 * **A fifth texel arrived 2026-08-27 for the photometric azimuth**, and the reason it is affordable
 * is a measurement rather than a shrug: the light region is `MAX_CLUSTERED_LIGHTS * LIGHT_TEXELS`
 * texels — 20 KB at four — against a froxel region of 270 KB, so a fifth texel is **5 KB of 290,
 * 1.7% of the table**. The obvious reading is that a fifth of four is a quarter, and that is a
 * quarter of the *smaller* half. Slot 19 is spare.
 *
 * **Why the azimuth needs a vector at all**, rather than being derived from the direction: there is
 * no continuous field of unit vectors tangent to a sphere — the hairy ball theorem — so *any*
 * reference derived from the aim alone has a direction in which it flips, and an asymmetric fixture
 * rotating through that direction would snap its pattern round. The two obvious constructions put
 * that singularity where these fixtures actually point: `cross(worldUp, dir)` fails for a light
 * aimed straight down, which is a street light.
 */
export const LIGHT_RECORD = {
  positionX: 0,
  positionY: 1,
  positionZ: 2,
  radius: 3,
  colorR: 4,
  colorG: 5,
  colorB: 6,
  sourceRadius: 7,
  weight: 8,
  shadowSlot: 9,
  directionX: 10,
  directionY: 11,
  directionZ: 12,
  cosInner: 13,
  cosOuter: 14,
  iesProfile: 15,
  /** The fixture's azimuth zero, in world space. See the note above on why it cannot be derived. */
  iesAxisX: 16,
  iesAxisY: 17,
  iesAxisZ: 18,
  /** A tile of the cookie atlas, or negative for none. Slot 19, the one the fifth texel spared. */
  cookie: 19,
} as const;

/**
 * The cone a light with no cone has: one that admits every direction, exactly.
 *
 * **`smoothstep(cosOuter, cosInner, dot(-L, dir))` must return exactly 1 for a point light**, and
 * these two values are what make it. Every direction on the sphere has `dot >= -1`, so with the
 * outer edge at −2 and the inner at −1 the argument is always at or past the upper edge and
 * `smoothstep` is 1 — no branch, no special case, and the published scenes stay bit-identical by
 * construction rather than by measurement.
 *
 * **Not −1 and −1**, which is the spelling that suggests itself: `smoothstep(a, a, x)` is undefined
 * when the two edges are equal and a driver may answer either bound.
 */
export const POINT_LIGHT_COS_INNER = -1;
export const POINT_LIGHT_COS_OUTER = -2;

/** A light carrying no IES profile. Matches the shader's own test against a negative index. */
export const NO_IES_PROFILE = -1;

/** The record's `w` when a light holds no shadow slot. */
export const NO_SHADOW_SLOT = -1;

/** Texels the light records occupy, which is where the cluster runs begin. */
export const LIGHT_REGION_TEXELS = MAX_CLUSTERED_LIGHTS * LIGHT_TEXELS;

/**
 * Texels across the table.
 *
 * **320, so that neither region straddles a row.** 320 divides by `CLUSTER_TEXELS`, so a cluster's
 * run of five is 64 clusters to a row and never wraps — a cluster split across two rows would need
 * the shader to carry the wrap, and getting that wrong reads as lights belonging to the froxel
 * next door. It divides `LIGHT_REGION_TEXELS` exactly too, so the cluster region starts at the
 * beginning of a row.
 */
export const TABLE_WIDTH = 320;

/** Rows: three of light records and 54 of cluster runs. 292 KB of `RGBA32UI`, allocated once. */
export const TABLE_HEIGHT = (LIGHT_REGION_TEXELS + CLUSTER_COUNT * CLUSTER_TEXELS) / TABLE_WIDTH;

/** The table, as the `Uint32Array` both a texture upload and a readback comparison want. */
export function createClusterTable(): Uint32Array {
  return new Uint32Array(TABLE_WIDTH * TABLE_HEIGHT * 4);
}

/** The first `uint` of a cluster's run: its count. Its indices follow four to a texel. */
export function clusterBase(cluster: number): number {
  return (LIGHT_REGION_TEXELS + cluster * CLUSTER_TEXELS) * 4;
}

/** The first `uint` of a light's record. */
export function lightBase(light: number): number {
  return light * LIGHT_TEXELS * 4;
}

/**
 * Which depth slice a view-space depth falls in.
 *
 * Exponential rather than linear, which is what every published clustered renderer settled on: a
 * linear partition spends most of its slices where the eye has no depth discrimination left, and
 * puts almost every light in a scene into the first one.
 *
 * Clamped at both ends rather than allowed to run off. A fragment exactly on the far plane is a
 * real fragment and must land in the last slice, not one past it.
 */
export function sliceOfViewDepth(z: number, near: number, far: number): number {
  if (!(z > near)) return 0;
  const slice = Math.floor((Math.log(z / near) / Math.log(far / near)) * CLUSTER_Z);
  return slice < 0 ? 0 : slice > CLUSTER_Z - 1 ? CLUSTER_Z - 1 : slice;
}

/** The view-space depth a slice begins at. */
export function sliceNearDepth(slice: number, near: number, far: number): number {
  return near * (far / near) ** (slice / CLUSTER_Z);
}

/**
 * The axis-aligned bounds of one cluster, in view space, as `[minX, minY, minZ, maxX, maxY, maxZ]`
 * with z a positive depth.
 *
 * **The AABB of the cluster's eight corners, which is larger than the cluster.** A froxel is a
 * truncated pyramid and its bounding box is not tight at the near end; the cost of that is a light
 * occasionally binned into a cluster it only *nearly* touches, which shades a few fragments
 * against a light contributing almost nothing. The alternative — testing the sphere against six
 * planes — is exact, costs four more dot products per light per cluster, and is what to reach for
 * if a profile ever indicts this. It is stated rather than hidden because the looseness is
 * visible in the conformance script's borderline count and would otherwise read as a bug.
 */
export function clusterViewBounds(
  i: number,
  j: number,
  k: number,
  near: number,
  far: number,
  tanHalfFovY: number,
  aspect: number,
  out: Float32Array,
): void {
  const zNear = sliceNearDepth(k, near, far);
  const zFar = sliceNearDepth(k + 1, near, far);

  /* NDC edges of the tile. The y axis runs the same way as the view's, so no flip lives here. */
  const xLo = -1 + (2 * i) / CLUSTER_X;
  const xHi = -1 + (2 * (i + 1)) / CLUSTER_X;
  const yLo = -1 + (2 * j) / CLUSTER_Y;
  const yHi = -1 + (2 * (j + 1)) / CLUSTER_Y;

  const halfHNear = zNear * tanHalfFovY;
  const halfHFar = zFar * tanHalfFovY;
  const halfWNear = halfHNear * aspect;
  const halfWFar = halfHFar * aspect;

  /* Four products a side, because a tile straddling zero has its extreme at the far plane on
     both sides while one entirely to one side has its minimum at the near plane. */
  out[0] = Math.min(xLo * halfWNear, xLo * halfWFar, xHi * halfWNear, xHi * halfWFar);
  out[3] = Math.max(xLo * halfWNear, xLo * halfWFar, xHi * halfWNear, xHi * halfWFar);
  out[1] = Math.min(yLo * halfHNear, yLo * halfHFar, yHi * halfHNear, yHi * halfHFar);
  out[4] = Math.max(yLo * halfHNear, yLo * halfHFar, yHi * halfHNear, yHi * halfHFar);
  out[2] = zNear;
  out[5] = zFar;
}

/** The light arrays the binner reads, in the shape `Environment` already carries them. */
export interface ClusterLightSet {
  readonly count: number;
  /** Three per light, world space. */
  readonly positions: Float32Array;
  /** Three per light. */
  readonly colors: Float32Array;
  /** One per light: the distance at which illumination falls to zero. */
  readonly radii: Float32Array;
  /** One per light: emitter size in metres. See `sphereLobe`. */
  readonly sourceRadii: Float32Array;
  /** One per light: how present it is, which is what makes a light arrive rather than appear. */
  readonly weights: Float32Array;
  /**
   * Three per light: the direction a spot points, normalised. Absent means every light is a point.
   *
   * Optional, so a consumer that has never heard of spot lights passes exactly what it passed
   * before and gets exactly what it got before — the collapse `POINT_LIGHT_COS_OUTER` describes.
   */
  readonly directions?: Float32Array;
  /** Two per light: the cosine of the inner cone angle, then of the outer. See the constants. */
  readonly coneCos?: Float32Array;
  /** Three per light: a photometric profile's azimuth zero. See `PointLightSet.lightIesAxes`. */
  readonly iesAxes?: Float32Array;
  /** One per light: a tile of the cookie atlas, or negative. See `PointLightSet.lightCookies`. */
  readonly cookies?: Float32Array;
  /** One per light: an index into the IES atlas, or −1. */
  readonly iesProfiles?: Float32Array;
}

/*
 * Scratch, at module scope, because `buildLightClusters` runs per frame on WebGL2 and the house
 * rule forbids allocating there.
 */
const bounds = new Float32Array(6);
/** View-space light centres, kept for the overflow rule, which needs them after the fact. */
const viewX = new Float32Array(MAX_CLUSTERED_LIGHTS);
const viewY = new Float32Array(MAX_CLUSTERED_LIGHTS);
const viewZ = new Float32Array(MAX_CLUSTERED_LIGHTS);

/**
 * A float reinterpreted as the `uint` that carries its bits, and back.
 *
 * The table is `RGBA32UI` because the *indices* are integers and an integer is what a texture can
 * carry exactly. The light records in the same texture are floats, so they travel as their own bit
 * pattern and the shader reads them with `uintBitsToFloat`. One texture, one texture unit, two
 * kinds of payload — rather than a second unit for three rows of numbers.
 */
const bits = new ArrayBuffer(4);
const bitsFloat = new Float32Array(bits);
const bitsUint = new Uint32Array(bits);

function floatBits(value: number): number {
  bitsFloat[0] = value;
  return bitsUint[0] ?? 0;
}

/** The squared distance from a point to an axis-aligned box, zero inside it. */
function distanceSqToBounds(x: number, y: number, z: number, b: Float32Array): number {
  const dx = x < (b[0] ?? 0) ? (b[0] ?? 0) - x : x > (b[3] ?? 0) ? x - (b[3] ?? 0) : 0;
  const dy = y < (b[1] ?? 0) ? (b[1] ?? 0) - y : y > (b[4] ?? 0) ? y - (b[4] ?? 0) : 0;
  const dz = z < (b[2] ?? 0) ? (b[2] ?? 0) - z : z > (b[5] ?? 0) ? z - (b[5] ?? 0) : 0;
  return dx * dx + dy * dy + dz * dz;
}

/** Insertion sort over a cluster's index slots. At most 28 integers, so this is not a hot loop. */
function sortIndices(table: Uint32Array, base: number, count: number): void {
  for (let n = 1; n < count; n++) {
    const value = table[base + 4 + n] ?? 0;
    let m = n - 1;
    while (m >= 0 && (table[base + 4 + m] ?? 0) > value) {
      table[base + 4 + m + 1] = table[base + 4 + m] ?? 0;
      m--;
    }
    table[base + 4 + m + 1] = value;
  }
}

/**
 * Fill the table with this frame's light assignment, and answer how many lights it carried.
 *
 * **A cluster's list is written in increasing light index, and that is a decision about the gate
 * rather than about the picture.** Sorting by distance was the first design and it is wrong for
 * one reason that only appears at the conformance check: a float comparison cannot be relied on to
 * rank two nearly equidistant lights the same way in JavaScript and in WGSL. Contraction,
 * evaluation order, and a JS number that is a double until something rounds it are each enough to
 * swap them, and the byte comparison would then fail on a scene where both binners were correct.
 * An integer key has no such freedom.
 *
 * **A float decides one thing only: which lights survive an overflow.** A full cluster meeting a
 * nearer light drops its farthest, and the survivors are re-sorted ascending before the next one
 * arrives, so the bytes stay deterministic even though the membership was chosen by a comparison
 * allowed to differ in its last bit. Keeping the first N encountered was the alternative and it
 * can drop the lamp a viewer is standing under in favour of 28 distant ones, which the fidelity
 * bar does not allow.
 *
 * **Positions are stored in world space and binned in view space.** The lit pass computes
 * `uLightPos[i] - vWorldPos` and the clustered arm must reach the same arithmetic from a different
 * place — storing view-space positions would make the two arms differ by a transform, and the
 * zero-pixel gate between them would stop meaning anything.
 *
 * **Measured, because this runs on the main thread on WebGL2 and a cost nobody measured is a cost
 * nobody can defend.** On this machine, lights of radius 8 in a 0.1 to 500 frustum:
 *
 *     16 lights   0.411 ms a frame
 *     64 lights   1.037 ms a frame
 *    256 lights   2.589 ms a frame
 *
 * Sixteen is today's budget and is nearly free. **256 is 16% of a 60 fps frame**, which is
 * affordable and is not nothing — and it is the honest argument for the GPU binner rather than a
 * stopwatch on a shader. The floor is the per-frame clear of the cluster region; the slope is the
 * tile box, which grows with a light's screen area rather than with the light count, so a scene of
 * small lamps costs far less than this and one of vast overlapping radii costs more.
 *
 * **Re-measured after the tile box moved inside the slice loop**, which is what made the two
 * binners agree: 0.386, 0.895 and 2.001 ms before, so correctness cost between 6% and 29%. Worth
 * recording, because the earlier numbers were for a binner that dropped lights.
 *
 * `shadowSlots` is how many of the shadow uniform slots are live this frame, which is what
 * decides whether a light's record names one. See `LIGHT_TEXELS`.
 *
 * Fills a caller-owned table and allocates nothing.
 */
export function buildLightClusters(
  lights: ClusterLightSet,
  view: Float32Array,
  near: number,
  far: number,
  tanHalfFovY: number,
  aspect: number,
  table: Uint32Array,
  shadowSlots: number,
): number {
  const count = Math.min(lights.count, MAX_CLUSTERED_LIGHTS);

  /*
   * The whole cluster region, not just the counts.
   *
   * **An index past the count is never read, so this looks like waste and is not.** The GPU binner
   * writes a cluster's eight texels in one go — a write-only storage texture has no read-modify-
   * write — so its unused slots are zero. If this left last frame's indices sitting there, the two
   * tables would differ in bytes neither shader can see, and the conformance script would have to
   * learn which differences to forgive. A `fill` is a memset and costs less than the loop it
   * replaces; agreeing about the invisible bytes is what keeps the comparison exact.
   */
  table.fill(0, LIGHT_REGION_TEXELS * 4);

  for (let light = 0; light < count; light++) {
    const x = lights.positions[light * 3] ?? 0;
    const y = lights.positions[light * 3 + 1] ?? 0;
    const z = lights.positions[light * 3 + 2] ?? 0;
    const radius = lights.radii[light] ?? 0;

    /* The record, as the shader reads it. World space; see the note above. */
    const record = lightBase(light);
    table[record] = floatBits(x);
    table[record + 1] = floatBits(y);
    table[record + 2] = floatBits(z);
    table[record + 3] = floatBits(radius);
    table[record + 4] = floatBits(lights.colors[light * 3] ?? 0);
    table[record + 5] = floatBits(lights.colors[light * 3 + 1] ?? 0);
    table[record + 6] = floatBits(lights.colors[light * 3 + 2] ?? 0);
    table[record + 7] = floatBits(lights.sourceRadii[light] ?? 0);
    table[record + 8] = floatBits(lights.weights[light] ?? 1);
    /*
     * Signed, and carried as a float's bits like everything else in the record so the shader
     * reads the whole texel one way. The first `MAX_POINT_LIGHTS` lights keep the shadow slots
     * they already have — `resolvePointLights` orders them so the ones worth shadowing come
     * first — and everything past that is a light without a map, which is what a scene with two
     * hundred lamps has anyway.
     */
    table[record + LIGHT_RECORD.shadowSlot] = floatBits(
      light < shadowSlots ? light : NO_SHADOW_SLOT,
    );

    /*
     * The cone, and a light that declared none gets the one that admits everything. Written for
     * every light rather than only for spots, because the shader reads the same six slots either
     * way and a record left at whatever the last frame put there is a cone nobody asked for.
     */
    const cone = lights.coneCos;
    const directions = lights.directions;
    const iesAxes = lights.iesAxes;
    table[record + LIGHT_RECORD.directionX] = floatBits(directions?.[light * 3] ?? 0);
    table[record + LIGHT_RECORD.directionY] = floatBits(directions?.[light * 3 + 1] ?? 0);
    table[record + LIGHT_RECORD.directionZ] = floatBits(directions?.[light * 3 + 2] ?? 0);
    table[record + LIGHT_RECORD.cosInner] = floatBits(cone?.[light * 2] ?? POINT_LIGHT_COS_INNER);
    table[record + LIGHT_RECORD.cosOuter] = floatBits(
      cone?.[light * 2 + 1] ?? POINT_LIGHT_COS_OUTER,
    );
    table[record + LIGHT_RECORD.iesProfile] = floatBits(
      lights.iesProfiles?.[light] ?? NO_IES_PROFILE,
    );
    /* Zero where a consumer gave none, which the shader reads as "no usable reference" and falls
       back to the first plane — the behaviour every symmetric profile has anyway. */
    table[record + LIGHT_RECORD.iesAxisX] = floatBits(iesAxes?.[light * 3] ?? 0);
    table[record + LIGHT_RECORD.iesAxisY] = floatBits(iesAxes?.[light * 3 + 1] ?? 0);
    table[record + LIGHT_RECORD.iesAxisZ] = floatBits(iesAxes?.[light * 3 + 2] ?? 0);
    table[record + LIGHT_RECORD.cookie] = floatBits(lights.cookies?.[light] ?? NO_IES_PROFILE);

    /* Column-major, as gl-matrix builds it. The view looks down -z, so depth is -vz. */
    const vx = (view[0] ?? 0) * x + (view[4] ?? 0) * y + (view[8] ?? 0) * z + (view[12] ?? 0);
    const vy = (view[1] ?? 0) * x + (view[5] ?? 0) * y + (view[9] ?? 0) * z + (view[13] ?? 0);
    const vz = (view[2] ?? 0) * x + (view[6] ?? 0) * y + (view[10] ?? 0) * z + (view[14] ?? 0);
    const depth = -vz;
    viewX[light] = vx;
    viewY[light] = vy;
    viewZ[light] = depth;

    /* Entirely behind the camera, so no cluster can reach it. */
    if (depth + radius <= 0) continue;

    /*
     * The slices the sphere could possibly touch. The tiles are derived per slice, below.
     *
     * **Two versions of this were wrong before the conformance script settled it**, and both were
     * wrong in the same direction: they skipped clusters the exact test would have accepted, so
     * WebGL2 simply lacked lights that WebGPU had. Recorded because the reasoning is seductive.
     *
     * The first projected the sphere at its *nearest* depth, on the argument that a light subtends
     * its largest angle there. That holds for a light straddling the view axis and fails beside
     * it: dividing by the smallest half-height magnifies both endpoints *away* from the centre, so
     * an off-axis interval slides off screen and clamps to one edge tile. A light 8.9 m below the
     * axis at 8.2 m depth with an 8 m radius spanned NDC -58 to -3 there, against -1.8 to -0.09 at
     * the far end of its own extent.
     *
     * The second took the extremes across the sphere's own depth range, which fixed that case and
     * not the next one: **a froxel's box spans its slice's depth range, not the sphere's**, and a
     * slice reaching past the sphere is wider in world x than anything the sphere's extent
     * describes.
     *
     * So the tile box is derived from the slice, inside the loop, by inverting exactly the bounds
     * `clusterViewBounds` builds. It is tight and it is conservative by construction rather than
     * by an argument, which is what the two attempts above were.
     */
    const kLo = sliceOfViewDepth(depth - radius, near, far);
    const kHi = sliceOfViewDepth(depth + radius, near, far);
    const xLo = vx - radius;
    const xHi = vx + radius;
    const yLo = vy - radius;
    const yHi = vy + radius;

    const radiusSq = radius * radius;
    for (let k = kLo; k <= kHi; k++) {
      /* The same two depths `clusterViewBounds` builds this slice's box from. */
      const halfHNear = sliceNearDepth(k, near, far) * tanHalfFovY;
      const halfHFar = sliceNearDepth(k + 1, near, far) * tanHalfFovY;
      const halfWNear = halfHNear * aspect;
      const halfWFar = halfHFar * aspect;
      const iLo = tileOf(
        Math.min(xLo / halfWNear, xLo / halfWFar, xHi / halfWNear, xHi / halfWFar),
        CLUSTER_X,
      );
      const iHi = tileOf(
        Math.max(xLo / halfWNear, xLo / halfWFar, xHi / halfWNear, xHi / halfWFar),
        CLUSTER_X,
      );
      const jLo = tileOf(
        Math.min(yLo / halfHNear, yLo / halfHFar, yHi / halfHNear, yHi / halfHFar),
        CLUSTER_Y,
      );
      const jHi = tileOf(
        Math.max(yLo / halfHNear, yLo / halfHFar, yHi / halfHNear, yHi / halfHFar),
        CLUSTER_Y,
      );
      for (let j = jLo; j <= jHi; j++) {
        for (let i = iLo; i <= iHi; i++) {
          clusterViewBounds(i, j, k, near, far, tanHalfFovY, aspect, bounds);
          if (distanceSqToBounds(vx, vy, depth, bounds) > radiusSq) continue;
          insert(
            table,
            i + j * CLUSTER_X + k * CLUSTER_X * CLUSTER_Y,
            light,
            near,
            far,
            tanHalfFovY,
            aspect,
          );
        }
      }
    }
  }
  return count;
}

/** An NDC coordinate to a tile index, clamped. */
function tileOf(ndc: number, tiles: number): number {
  const tile = Math.floor((ndc + 1) * 0.5 * tiles);
  return tile < 0 ? 0 : tile > tiles - 1 ? tiles - 1 : tile;
}

/**
 * Put a light into a cluster, applying the overflow rule.
 *
 * Lights arrive in increasing index, so the common path appends and the list is already sorted.
 * The sort only runs on the rare path where a replacement broke that order.
 */
function insert(
  table: Uint32Array,
  cluster: number,
  light: number,
  near: number,
  far: number,
  tanHalfFovY: number,
  aspect: number,
): void {
  const base = clusterBase(cluster);
  const count = table[base] ?? 0;
  if (count < MAX_LIGHTS_PER_CLUSTER) {
    table[base + 4 + count] = light;
    table[base] = count + 1;
    return;
  }

  /*
   * Full. Drop the farthest member if this one is nearer, measured from the cluster's own centre.
   * Rare enough that recomputing the members' distances beats carrying 96,768 floats of scratch
   * for a case most frames never reach.
   */
  const k = Math.floor(cluster / (CLUSTER_X * CLUSTER_Y));
  const j = Math.floor((cluster - k * CLUSTER_X * CLUSTER_Y) / CLUSTER_X);
  const i = cluster - k * CLUSTER_X * CLUSTER_Y - j * CLUSTER_X;
  clusterViewBounds(i, j, k, near, far, tanHalfFovY, aspect, bounds);
  const cx = ((bounds[0] ?? 0) + (bounds[3] ?? 0)) * 0.5;
  const cy = ((bounds[1] ?? 0) + (bounds[4] ?? 0)) * 0.5;
  const cz = ((bounds[2] ?? 0) + (bounds[5] ?? 0)) * 0.5;

  const mine = centreDistanceSq(light, cx, cy, cz);
  let worstSlot = -1;
  let worst = mine;
  for (let n = 0; n < MAX_LIGHTS_PER_CLUSTER; n++) {
    const held = table[base + 4 + n] ?? 0;
    const d = centreDistanceSq(held, cx, cy, cz);
    if (d > worst) {
      worst = d;
      worstSlot = n;
    }
  }
  if (worstSlot < 0) return;
  table[base + 4 + worstSlot] = light;
  sortIndices(table, base, MAX_LIGHTS_PER_CLUSTER);
}

function centreDistanceSq(light: number, cx: number, cy: number, cz: number): number {
  const dx = (viewX[light] ?? 0) - cx;
  const dy = (viewY[light] ?? 0) - cy;
  const dz = (viewZ[light] ?? 0) - cz;
  return dx * dx + dy * dy + dz * dz;
}
