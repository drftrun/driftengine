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
 * Texels a cluster occupies: one for its count, nineteen holding four light indices each.
 *
 * **Fixed rather than packed, and that is what removes the atomics.** One invocation owns one
 * cluster and writes only its own run, so nothing is appended to a shared list, there is no
 * counter to increment atomically and no compaction pass. That is also what lets the GPU binner
 * write through a *write-only* storage texture, which is all core WGSL gives.
 */
export const CLUSTER_TEXELS = 20;

/**
 * How many lights one cluster can hold: nineteen index texels at four indices each, 76.
 *
 * **Sixteen until a candlelit interior drew its froxels as rectangles.** The cap was pinned to
 * `MAX_POINT_LIGHTS` so the one light loop kept one bound. Then a courtyard of candles, lanterns
 * and braziers asked 461 of its 3,456 froxels for more than sixteen, and up to fifty. A full froxel
 * keeps its nearest and drops the rest, and its neighbour keeps a different set, so the step
 * between them drew as hard-edged, screen-aligned rectangles on every vault, on both backends.
 *
 * Seventy-six because it is the next cap the table's shape allows above what was measured: a run
 * must divide the 320-texel row, and the two regions must end on one. What it costs is the table,
 * 292 KB to 1.1 MB, and the loop's bound. The bound is the clustered arm's alone in effect: the
 * fixed arm still leaves at its own count and never passes `MAX_LIGHTS`, so a consumer that does
 * not cluster iterates what it did. What would make 76 wrong is content that asks more of one
 * froxel, and the answer then is the next cap rather than a softer overflow: any overflow rule
 * draws the cluster's edge.
 *
 * **It is not the old limit wearing a new hat.** Sixteen was a budget for the *whole scene*, chosen
 * by distance with a contention band because somebody always had to be last. This is a different
 * set in every froxel, out of `MAX_CLUSTERED_LIGHTS` in the scene.
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
 * Texels one light's record occupies: position and radius, then colour with the emitter size and
 * the weight, then the shadow slot and the fixture: direction, cone, profile, cookie and azimuth.
 *
 * **A plain point light is read in two of the five.** The lit pass fetches this record once per
 * light per fragment, and at eight megapixels with lights crowded together that fetch is the
 * frame: 320 lamps of radius 12 cost 26.2 ms of a 4K main pass when all five texels were read for
 * every light, and 12.7 ms read in two, on the RX 9070 XT `demo/dev/clusterStress.html` was
 * measured on. So the second texel carries a flag, `LIGHT_FIXTURE_FLAG`, and the last three are
 * fetched only for a light that has a shadow slot, a cone, a profile or a cookie. What a plain light
 * would have read there is what the shader assumes in their place, so the picture is the same.
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
 *
 * **Reordered 2026-10-02 so a plain light's fields are the first eight**, which is what lets the
 * shader stop after two texels. Nine values are needed by every light and eight fit in two
 * texels, so the emitter size and the weight share slot 7 as two halves; see `packSizeAndWeight`.
 * Slot 19 is spare.
 */
export const LIGHT_RECORD = {
  positionX: 0,
  positionY: 1,
  positionZ: 2,
  radius: 3,
  colorR: 4,
  colorG: 5,
  colorB: 6,
  /** The emitter size and the weight, two halves in one word, and the fixture flag. */
  sizeAndWeight: 7,
  shadowSlot: 8,
  directionX: 9,
  directionY: 10,
  directionZ: 11,
  cosInner: 12,
  cosOuter: 13,
  iesProfile: 14,
  /** A tile of the cookie atlas, or negative for none. */
  cookie: 15,
  /** The fixture's azimuth zero, in world space. See the note above on why it cannot be derived. */
  iesAxisX: 16,
  iesAxisY: 17,
  iesAxisZ: 18,
} as const;

/** Texels the lit pass reads for a light whose record carries no fixture. */
export const PLAIN_LIGHT_TEXELS = 2;

/**
 * The bit of `sizeAndWeight` that says the record's last three texels hold something: the sign of
 * the emitter size's half, which a size never needs.
 */
export const LIGHT_FIXTURE_FLAG = 0x8000;

const halfScratch = new Float32Array(1);
const halfScratchBits = new Uint32Array(halfScratch.buffer);

/**
 * A number as the sixteen bits of an IEEE half: rounded to the nearest, ties to even.
 *
 * **Computed here, once, and copied by both binners rather than converted on the GPU.** WGSL and
 * GLSL both leave the rounding of `pack2x16float` to the implementation, and two producers of one
 * table that round differently would make `scripts/cluster-check.mjs` compare noise.
 *
 * **A value only a subnormal half could hold is flushed to a signed zero.** A GPU may flush a
 * subnormal it unpacks, and the fixed arm reads the same value from a uniform where nothing would;
 * flushing it here means both arms read zero. Nothing is lost that a pixel could show: the largest
 * value flushed is 6.1e-5, a weight no lamp is visible at.
 */
export function halfBits(value: number): number {
  halfScratch[0] = value;
  const x = halfScratchBits[0] ?? 0;
  const sign = (x >>> 16) & 0x8000;
  const exponent = (x >>> 23) & 0xff;
  const mantissa = x & 0x7fffff;
  if (exponent === 0xff) return sign | 0x7c00 | (mantissa === 0 ? 0 : 0x200);
  const e = exponent - 127 + 15;
  if (e >= 0x1f) return sign | 0x7c00;
  if (e <= 0) return sign;
  const truncated = (e << 10) | (mantissa >>> 13);
  const rest = mantissa & 0x1fff;
  /* A carry out of the mantissa lands in the exponent, which is the correct rounding up. */
  const rounded =
    rest > 0x1000 || (rest === 0x1000 && (truncated & 1) === 1) ? truncated + 1 : truncated;
  return sign | rounded;
}

/** The number a half's bits hold. Exact: every half is also a float. */
export function halfValue(half: number): number {
  const sign = (half & 0x8000) === 0 ? 1 : -1;
  const exponent = (half >>> 10) & 0x1f;
  const mantissa = half & 0x3ff;
  if (exponent === 0) return sign * mantissa * 2 ** -24;
  if (exponent === 0x1f) return mantissa === 0 ? sign * Infinity : Number.NaN;
  return sign * (1 + mantissa / 1024) * 2 ** (exponent - 15);
}

/**
 * A lamp's emitter size as both arms read it: its magnitude, at half precision.
 *
 * **The fixed arm is rounded too, and that is what keeps the two arms one picture.**
 * `resolvePointLights` passes the sixteen uniform lights through this and `lampWeight`, so a light
 * moved from the uniform path to the froxel table shades with the same numbers. A negative size was
 * never meaningful and now reads as its magnitude on both.
 */
export function lampSourceRadius(value: number): number {
  return halfValue(halfBits(Math.abs(value)));
}

/** A lamp's weight as both arms read it: at half precision, sign kept. See `lampSourceRadius`. */
export function lampWeight(value: number): number {
  return halfValue(halfBits(value));
}

/**
 * Slot 7 of a record: the emitter size's half in the low bits, the weight's in the high, and the
 * fixture flag in the size's sign. The shader unpacks it with `unpackHalf2x16`, which is exact.
 */
export function packSizeAndWeight(sourceRadius: number, weight: number, fixture: boolean): number {
  const size = halfBits(Math.abs(sourceRadius)) & 0x7fff;
  return ((halfBits(weight) << 16) | size | (fixture ? LIGHT_FIXTURE_FLAG : 0)) >>> 0;
}

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

/** Rows: five of light records and 216 of cluster runs. 1.1 MB of `RGBA32UI`, allocated once. */
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

/**
 * `clusterViewBounds` for a slice whose depths and half extents the caller already has. The same
 * arithmetic in the same order, so the same box to the bit; the binner's inner loop uses this.
 */
function sliceBounds(
  i: number,
  j: number,
  zNear: number,
  zFar: number,
  halfWNear: number,
  halfWFar: number,
  halfHNear: number,
  halfHFar: number,
  out: Float32Array,
): void {
  const xLo = -1 + (2 * i) / CLUSTER_X;
  const xHi = -1 + (2 * (i + 1)) / CLUSTER_X;
  const yLo = -1 + (2 * j) / CLUSTER_Y;
  const yHi = -1 + (2 * (j + 1)) / CLUSTER_Y;
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

/** Where `fillClusterLightSet` reads a frame's lights from: the arrays `Environment` carries. */
export interface ClusterLightArrays {
  readonly lightCount?: number;
  readonly lightPositions: Float32Array;
  readonly lightColors: Float32Array;
  readonly lightRadii: Float32Array;
  readonly lightWeights: Float32Array;
  readonly lightSourceRadii?: Float32Array;
  readonly lightDirections?: Float32Array;
  readonly lightConeCos?: Float32Array;
  readonly lightIesProfiles?: Float32Array;
  readonly lightIesAxes?: Float32Array;
  readonly lightCookies?: Float32Array;
}

/** A `ClusterLightSet` a renderer refills every frame. */
export type ClusterLightScratch = { -readonly [K in keyof ClusterLightSet]: ClusterLightSet[K] };

/** No emitter size at all, which is what the fixed arm reads for a light that was given none. */
const NO_SOURCE_SIZES = new Float32Array(0);

export function createClusterLightSet(): ClusterLightScratch {
  return {
    count: 0,
    positions: NO_SOURCE_SIZES,
    colors: NO_SOURCE_SIZES,
    radii: NO_SOURCE_SIZES,
    sourceRadii: NO_SOURCE_SIZES,
    weights: NO_SOURCE_SIZES,
  };
}

/**
 * A frame's lights as the binner reads them, in place, holding references and allocating nothing.
 *
 * **One assembly for both renderers, and it used to be two that had each dropped the same five
 * fields.** Each backend copied the position, colour, radius, size and weight arrays and nothing
 * else, so a spot's direction and cone, a profile, its axis and a cookie never reached the record:
 * with clustering on, every fixture shaded as a bare point light. On a probe page holding one
 * spot with a profile and a cookie the two arms differed by 357,706 pixels, the clustered one
 * flooding the scene the cone was meant to cut. The record and both shaders were right throughout;
 * the light never arrived.
 *
 * **And a light given no emitter size has none**, as the fixed arm reads it. This read the light's
 * radius in its place, an emitter as wide as the light reaches, which widened every lamp's
 * highlight on a specular surface on the clustered arm alone.
 */
export function fillClusterLightSet(
  env: ClusterLightArrays,
  out: ClusterLightScratch,
): ClusterLightSet {
  out.count = Math.min(env.lightCount ?? 0, MAX_CLUSTERED_LIGHTS);
  out.positions = env.lightPositions;
  out.colors = env.lightColors;
  out.radii = env.lightRadii;
  out.sourceRadii = env.lightSourceRadii ?? NO_SOURCE_SIZES;
  out.weights = env.lightWeights;
  out.directions = env.lightDirections;
  out.coneCos = env.lightConeCos;
  out.iesProfiles = env.lightIesProfiles;
  out.iesAxes = env.lightIesAxes;
  out.cookies = env.lightCookies;
  return out;
}

/*
 * Scratch, at module scope, because `buildLightClusters` runs per frame on WebGL2 and the house
 * rule forbids allocating there.
 */
const bounds = new Float32Array(6);
/**
 * Where each slice begins, for the frame being binned: `sliceNearDepth` for every slice and the
 * far plane, computed once. The same expression as a call per cluster, so the same numbers.
 *
 * **Once a binning rather than once a cluster**, which was two `pow` for every light and every
 * cluster it might touch. A courtyard of candles within a few metres of the camera is 640,000 of
 * those pairs, and the binning took 47 ms of a frame. On WebGL2 it runs every `bindMeshPass`, so a
 * probe grid baked at night binned for a minute.
 */
const sliceDepths = new Float64Array(CLUSTER_Z + 1);
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

/**
 * Whether a light's record needs its last three texels: it holds a shadow slot, a cone, a profile
 * or a cookie. Everything else is a plain light, read in `PLAIN_LIGHT_TEXELS`.
 *
 * **`shadowSlots` is zero where the lit shader has no point shadows**, and both binners are handed
 * it that way: a slot is only read under `POINT_SHADOWS`, so a light holding one in a build without
 * them was paying for three texels the shader then ignored.
 */
export function lightHasFixture(
  lights: ClusterLightSet,
  light: number,
  shadowSlots: number,
): boolean {
  const cone = lights.coneCos;
  return (
    light < shadowSlots ||
    (cone?.[light * 2] ?? POINT_LIGHT_COS_INNER) !== POINT_LIGHT_COS_INNER ||
    (cone?.[light * 2 + 1] ?? POINT_LIGHT_COS_OUTER) !== POINT_LIGHT_COS_OUTER ||
    (lights.iesProfiles?.[light] ?? NO_IES_PROFILE) >= 0 ||
    (lights.cookies?.[light] ?? NO_IES_PROFILE) >= 0
  );
}

/**
 * The value of `uClustered` for a frame: 0 with clustering off, 1 when every light is plain, 2 when
 * any carries a fixture.
 *
 * **The third state is a uniform the shader can branch on for free.** The flag test on each light is
 * a branch on a value read from a texture, and a compiler may run both sides of one; 1.3 ms of a 4K
 * main pass of 320 plain lamps was that test. Asked once a frame here, a scene whose lights are all
 * plain never reaches it.
 */
export function clusteredMode(lights: ClusterLightSet, count: number, shadowSlots: number): 1 | 2 {
  for (let light = 0; light < count; light++) {
    if (lightHasFixture(lights, light, shadowSlots)) return 2;
  }
  return 1;
}

/**
 * One light's record, at `at` in `out`, as the lit pass reads it.
 *
 * **The one writer.** The CPU binner calls this into the table and the GPU binner's staging calls
 * it into the buffer its kernel copies verbatim, so a field can only move in both at once; the
 * 2026-08-17 rule is that two implementations of one decision drift invisibly when the constants
 * are identical, and these were two.
 *
 * **A light is plain unless it has a shadow slot, a cone, a profile or a cookie**, and then the
 * flag is clear and the shader reads two texels. Every slot is still written, so a record holds no
 * bytes from a light that was there last frame and the two binners' tables stay comparable.
 *
 * The shadow slot is signed and carried as a float's bits like everything else in the record. The
 * first `MAX_POINT_LIGHTS` lights keep the shadow slots they already have, because
 * `resolvePointLights` orders them so the ones worth shadowing come first, and everything past that
 * is a light without a map, which is what a scene with two hundred lamps has anyway.
 */
export function writeLightRecord(
  lights: ClusterLightSet,
  light: number,
  shadowSlots: number,
  out: Uint32Array,
  at: number,
): void {
  const directions = lights.directions;
  const cone = lights.coneCos;
  const axes = lights.iesAxes;
  const shadowSlot = light < shadowSlots ? light : NO_SHADOW_SLOT;
  const cosInner = cone?.[light * 2] ?? POINT_LIGHT_COS_INNER;
  const cosOuter = cone?.[light * 2 + 1] ?? POINT_LIGHT_COS_OUTER;
  const profile = lights.iesProfiles?.[light] ?? NO_IES_PROFILE;
  const cookie = lights.cookies?.[light] ?? NO_IES_PROFILE;
  const fixture = lightHasFixture(lights, light, shadowSlots);

  out[at + LIGHT_RECORD.positionX] = floatBits(lights.positions[light * 3] ?? 0);
  out[at + LIGHT_RECORD.positionY] = floatBits(lights.positions[light * 3 + 1] ?? 0);
  out[at + LIGHT_RECORD.positionZ] = floatBits(lights.positions[light * 3 + 2] ?? 0);
  out[at + LIGHT_RECORD.radius] = floatBits(lights.radii[light] ?? 0);
  out[at + LIGHT_RECORD.colorR] = floatBits(lights.colors[light * 3] ?? 0);
  out[at + LIGHT_RECORD.colorG] = floatBits(lights.colors[light * 3 + 1] ?? 0);
  out[at + LIGHT_RECORD.colorB] = floatBits(lights.colors[light * 3 + 2] ?? 0);
  out[at + LIGHT_RECORD.sizeAndWeight] = packSizeAndWeight(
    lights.sourceRadii[light] ?? 0,
    lights.weights[light] ?? 1,
    fixture,
  );
  out[at + LIGHT_RECORD.shadowSlot] = floatBits(shadowSlot);
  /* A light that declared no cone gets the one that admits everything; see the constants. */
  out[at + LIGHT_RECORD.directionX] = floatBits(directions?.[light * 3] ?? 0);
  out[at + LIGHT_RECORD.directionY] = floatBits(directions?.[light * 3 + 1] ?? 0);
  out[at + LIGHT_RECORD.directionZ] = floatBits(directions?.[light * 3 + 2] ?? 0);
  out[at + LIGHT_RECORD.cosInner] = floatBits(cosInner);
  out[at + LIGHT_RECORD.cosOuter] = floatBits(cosOuter);
  out[at + LIGHT_RECORD.iesProfile] = floatBits(profile);
  out[at + LIGHT_RECORD.cookie] = floatBits(cookie);
  /* Zero where a consumer gave none, which the shader reads as "no usable reference" and falls
     back to the first plane, the behaviour every symmetric profile has anyway. */
  out[at + LIGHT_RECORD.iesAxisX] = floatBits(axes?.[light * 3] ?? 0);
  out[at + LIGHT_RECORD.iesAxisY] = floatBits(axes?.[light * 3 + 1] ?? 0);
  out[at + LIGHT_RECORD.iesAxisZ] = floatBits(axes?.[light * 3 + 2] ?? 0);
  out[at + 19] = 0;
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
  for (let k = 0; k <= CLUSTER_Z; k++) sliceDepths[k] = sliceNearDepth(k, near, far);

  for (let light = 0; light < count; light++) {
    const x = lights.positions[light * 3] ?? 0;
    const y = lights.positions[light * 3 + 1] ?? 0;
    const z = lights.positions[light * 3 + 2] ?? 0;
    const radius = lights.radii[light] ?? 0;

    /* The record, as the shader reads it. World space; see the note above. */
    writeLightRecord(lights, light, shadowSlots, table, lightBase(light));

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
      const zNear = sliceDepths[k] ?? 0;
      const zFar = sliceDepths[k + 1] ?? 0;
      const halfHNear = zNear * tanHalfFovY;
      const halfHFar = zFar * tanHalfFovY;
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
          sliceBounds(i, j, zNear, zFar, halfWNear, halfWFar, halfHNear, halfHFar, bounds);
          if (distanceSqToBounds(vx, vy, depth, bounds) > radiusSq) continue;
          insert(table, i + j * CLUSTER_X + k * CLUSTER_X * CLUSTER_Y, light, bounds);
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
 * Each member's squared distance from its cluster's centre, slot for slot with the table, for the
 * frame being binned. Allocated on the first binning, so a consumer that never clusters pays nothing.
 *
 * **Measured rather than assumed rare.** The overflow rule used to recompute the cluster's box and
 * all sixteen members' distances on every insert into a full cluster, on the argument that full
 * clusters are rare. Three hundred candles within a few metres of the camera fill 2,152 of the
 * 3,456, and the binning spent 47 ms a frame there. Each distance is the same number whenever it is
 * computed, so it is computed once, at the insert that placed the member.
 */
let memberDistance: Float64Array | null = null;

/**
 * Put a light into a cluster, applying the overflow rule. `box` is the cluster's bounds, which the
 * caller has just tested the light against.
 *
 * Lights arrive in increasing index, so the common path appends and the list is already sorted.
 * The sort only runs on the rare path where a replacement broke that order.
 */
function insert(table: Uint32Array, cluster: number, light: number, box: Float32Array): void {
  const base = clusterBase(cluster);
  const count = table[base] ?? 0;
  const distances = (memberDistance ??= new Float64Array(CLUSTER_COUNT * MAX_LIGHTS_PER_CLUSTER));
  const at = cluster * MAX_LIGHTS_PER_CLUSTER;
  const cx = ((box[0] ?? 0) + (box[3] ?? 0)) * 0.5;
  const cy = ((box[1] ?? 0) + (box[4] ?? 0)) * 0.5;
  const cz = ((box[2] ?? 0) + (box[5] ?? 0)) * 0.5;
  const mine = centreDistanceSq(light, cx, cy, cz);
  if (count < MAX_LIGHTS_PER_CLUSTER) {
    table[base + 4 + count] = light;
    distances[at + count] = mine;
    table[base] = count + 1;
    return;
  }

  /* Full. Drop the farthest member if this one is nearer, measured from the cluster's own centre. */
  let worstSlot = -1;
  let worst = mine;
  for (let n = 0; n < MAX_LIGHTS_PER_CLUSTER; n++) {
    const d = distances[at + n] ?? 0;
    if (d > worst) {
      worst = d;
      worstSlot = n;
    }
  }
  if (worstSlot < 0) return;
  table[base + 4 + worstSlot] = light;
  distances[at + worstSlot] = mine;
  sortMembers(table, base, distances, at);
}

/**
 * Sort a full cluster's index slots ascending, carrying each member's distance with it. An insertion
 * sort: sixteen integers, so this is not a hot loop.
 */
function sortMembers(table: Uint32Array, base: number, distances: Float64Array, at: number): void {
  for (let n = 1; n < MAX_LIGHTS_PER_CLUSTER; n++) {
    const value = table[base + 4 + n] ?? 0;
    const distance = distances[at + n] ?? 0;
    let m = n - 1;
    while (m >= 0 && (table[base + 4 + m] ?? 0) > value) {
      table[base + 4 + m + 1] = table[base + 4 + m] ?? 0;
      distances[at + m + 1] = distances[at + m] ?? 0;
      m--;
    }
    table[base + 4 + m + 1] = value;
    distances[at + m + 1] = distance;
  }
}

function centreDistanceSq(light: number, cx: number, cy: number, cz: number): number {
  const dx = (viewX[light] ?? 0) - cx;
  const dy = (viewY[light] ?? 0) - cy;
  const dz = (viewZ[light] ?? 0) - cz;
  return dx * dx + dy * dy + dz * dz;
}
