/** The shape every splat reader produces, and the packing that turns it into two GPU texels. */

import { packHalf2x16 } from './half.ts';

/** How many `uint32`s a splat occupies with no view-dependent colour: two `RGBA32UI` texels. */
export const SPLAT_WORDS = 8;

/**
 * The same with degree-1 view-dependent colour: **one more texel**, and no more than one.
 *
 * The costing in `sphericalHarmonics` below is what picked degree 1 and it is worth reading before
 * anybody raises this. Nine coefficients fit a texel as bytes with a per-splat scale beside them,
 * which is +50% on the record and on the read; degree 2 is three more texels and degree 3 is six,
 * and degree 3 alone would put 307 MB a frame through a device already carrying 389.
 */
export const SPLAT_WORDS_SH1 = 12;

/** Three basis functions at l=1, three channels each. */
export const SPLAT_SH1_COEFFICIENTS = 9;

/**
 * A capture as a reader hands it over: linear values, one array per attribute.
 *
 * **Linear, and that boundary is load-bearing.** A `.ply` from a training run stores scale as its
 * logarithm and opacity as its logit, and undoing both is the *reader's* job rather than this
 * one's. Getting the boundary wrong produces a capture that is either invisible or a solid block,
 * and both have been reported against other viewers — because both look like a rendering fault.
 */
export interface SplatSource {
  readonly count: number;
  /** Three per splat, in the capture's own space. */
  readonly positions: Float32Array;
  /** Three per splat: the Gaussian's standard deviation along each of its own axes, in metres. */
  readonly scales: Float32Array;
  /**
   * Four per splat, **xyzw**, normalised here rather than trusted.
   *
   * **Both file formats store wxyz and this does not**, which is a deliberate seam: `xyzw` is what
   * `gl-matrix` uses and what every other quaternion in this engine is, so a consumer building a
   * source by hand is not asked to learn a second convention for one type. Each reader reorders on
   * the way in, in one line, at the point where the file's order is already on screen.
   */
  readonly rotations: Float32Array;
  /**
   * Three per splat, 0 to 1, **linear**.
   *
   * Not sRGB-decoded, which is what every reference viewer does and is also what is correct here:
   * a capture's colour comes from a spherical-harmonic DC term, which is linear radiance, and this
   * engine shades and composites in linear and grades once at the end. What would make it wrong is
   * a capture authored by a tool that baked a display transform into the DC term — which produces
   * a washed-out cloud, not a subtly wrong one.
   */
  readonly colors: Float32Array;
  /** One per splat, 0 to 1, already through the logistic if the format stored a logit. */
  readonly opacities: Float32Array;
  /**
   * The l=1 spherical-harmonic band, nine per splat, or absent for a capture that has none.
   *
   * **Interleaved by basis function and then by channel** — `Y(1,−1).rgb`, `Y(1,0).rgb`,
   * `Y(1,1).rgb` — which is *not* how a `.ply` stores them. That file is channel-major, all
   * fifteen of red before all fifteen of green, and the reader transposes on the way in for the
   * reason every other reordering in this package happens there: the file's own order is on
   * screen at exactly one place, and a shader that had to know it would be a second copy of a
   * convention nothing checks.
   *
   * Raw coefficients, signed, in the same units the training run wrote — the band constant is the
   * shader's to apply, like `SH_C0` is the reader's for the DC term.
   */
  readonly sh1?: Float32Array;
}

/**
 * A capture packed for the GPU, plus the two things the CPU still needs.
 *
 * **`positions` survives packing because the sorter reads it every time the view turns**, and it is
 * the only per-splat attribute that does. Everything else is in `packed` and is never looked at
 * again by JavaScript.
 *
 * **This takes ownership of the arrays handed to `packSplats`.** They are twelve and four bytes a
 * splat, so copying a million-splat capture would be sixteen megabytes of duplicate to no purpose;
 * the cost is that a caller must not go on mutating a source after packing it, which is stated
 * here because nothing enforces it.
 */
export interface SplatData {
  readonly count: number;
  /** Three per splat. See above: the sorter's input, and the reason this is not packed away. */
  readonly positions: Float32Array;
  /**
   * `wordsPerSplat` per splat — texel 0 is position and colour, texel 1 is the covariance, and
   * texel 2 is the l=1 band where the capture carries one.
   */
  readonly packed: Uint32Array;
  /**
   * `SPLAT_WORDS` or `SPLAT_WORDS_SH1`. Everything that indexes `packed` reads this rather than a
   * constant, and `FORMAT.md` §4.7 anticipated exactly this: a `SPLT` block already carries its
   * own `wordsPerSplat` and says "a capture that carries spherical-harmonic coefficients later
   * fits by raising it and nothing else".
   */
  readonly wordsPerSplat: number;
  /** The capture's axis-aligned extent, for the frustum test that precedes a sort. */
  readonly boundsMin: Float32Array;
  readonly boundsMax: Float32Array;
  /**
   * One per splat: the largest of its three standard deviations, in the capture's own units.
   *
   * **What the budget ranks by, and the second attribute that survives packing.** A splat's
   * contribution to the picture is roughly how many pixels it covers, which is its world extent
   * over its distance to the camera; the distance is per-frame and this is the half that is not.
   * The largest sigma bounds the projected radius from above for every orientation, so it ranks
   * correctly without a per-splat projection.
   *
   * What it costs is **four bytes a splat** — four megabytes at a million, on top of the twelve
   * `positions` already keeps — and it is paid whether or not a capture is ever budgeted, because
   * packing cannot know. What would make it wrong is a capture of extremely flat splats seen
   * edge-on, where the largest sigma is a poor estimate of the pixels covered and this
   * over-ranks them; the honest fix there is the projected radius, which is per-frame work this
   * deliberately avoids.
   */
  readonly extents: Float32Array;
  /**
   * How many `f_rest_*` coefficients the source carried, of which this kept the first band.
   *
   * Zero for a format that has none. **Nine are read as of 2026-08-27 and the rest are not**, and
   * the costing that decided which is below, kept because it is the argument against raising it.
   *
   * ## What view-dependent colour costs, costed 2026-08-27 and built the same day
   *
   * A splat with no harmonics is `SPLAT_WORDS` uint32s — two `RGBA32UI` texels, **32 bytes** — and
   * the vertex stage runs **six times a splat**, because the quad is two unindexed triangles and
   * `SPLAT_VERT` says why. Every invocation fetches every texel, so the data texture is read at
   * **192 bytes a splat a frame** before any texture cache.
   *
   * A degree-`n` expansion carries `((n+1)^2 − 1) * 3` coefficients:
   *
   * | Degree | Coefficients | Extra texels | Bytes a splat | Read a splat a frame |
   * |---|---|---|---|---|
   * | 0 | 0 | 0 | 32 | 192 |
   * | 1 **(built)** | 9 | 1 | 48 | 288 |
   * | 2 | 24 | 3 | 80 | 480 |
   * | 3 | 45 | 6 | 128 | 768 |
   *
   * **Against the mobile budget of `SPLAT_BUDGET_DEFAULT`, 400,000 splats**: 76.8 MB a frame at
   * degree 0, 115.2 at degree 1, 192 at degree 2 and **307.2 at degree 3**. `docs/CAPABILITIES.md`
   * records a mid-range phone already moving **388.7 MB a frame of attachment traffic**, so degree 3
   * would very nearly double the memory traffic of a frame on the device that is already the
   * constraint — and the texture itself would grow from 12.8 MB to 51 MB, which is the mistake
   * `lightBudget.ts`'s shadow pool records making once already.
   *
   * **Degree 1 is the band that earns its texel.** The l=1 lobe is broad and directional — it is
   * what makes glass, a wet surface and a polished floor read as themselves — where degrees 2 and 3
   * are the sharp specular detail that costs four and six times as much. Nine coefficients fit one
   * texel as **bytes with a per-splat scale beside them**, rather than halves: nine halves is 18
   * bytes and would not fit, and a per-splat scale spends the sixteenth byte on the accuracy that
   * quantising to a capture-wide range would have thrown away.
   *
   * **What is still unmeasured**, and it is the number that would refine this: how much of the 6x
   * amplification a real texture cache absorbs, since six consecutive invocations read the same
   * texels. Answering it needs a GPU timing of the splat pass against a capture, and this checkout
   * has none — `demo/dev/public/` being uncommitted.
   */
  readonly sphericalHarmonics: number;
  /**
   * How many bands of that expansion this capture actually carries: 0 or 1.
   *
   * Separate from `sphericalHarmonics`, which counts what the *source* had — a `.ply` written at
   * degree 3 reports 45 there and 1 here, because forty-five coefficients arrived and nine were
   * kept. The two disagreeing is the honest state rather than a discrepancy.
   */
  readonly shDegree: 0 | 1;
}

/* Scratch for one splat's rotation matrix, so the packing loop allocates nothing. */
const rotation = new Float32Array(9);

/**
 * Turn a source into two texels per splat, and compute the capture's bounds while the loop is open.
 *
 * Texel 0 is the three position floats reinterpreted as `uint32` plus the colour as `RGBA8`.
 * Texel 1 is the six unique terms of the 3x3 covariance as three half pairs, with the fourth
 * component reserved and written zero.
 *
 * **The covariance is computed here and never again.** It is fixed for the lifetime of a capture,
 * so evaluating it per splat per frame would cost a quaternion-to-matrix and two 3x3 multiplies
 * for a value that cannot change. What that gives up is six halves of precision against the
 * source's floats; what would make it wrong is a capture whose splats are animated, which is not a
 * thing this format can express.
 */
export function packSplats(source: SplatSource): SplatData {
  const { count, positions, scales, rotations, colors, opacities, sh1 } = source;
  expectLength('positions', positions, count * 3);
  expectLength('scales', scales, count * 3);
  expectLength('rotations', rotations, count * 4);
  expectLength('colors', colors, count * 3);
  expectLength('opacities', opacities, count);
  if (sh1 !== undefined) expectLength('sh1', sh1, count * SPLAT_SH1_COEFFICIENTS);

  const wordsPerSplat = sh1 === undefined ? SPLAT_WORDS : SPLAT_WORDS_SH1;
  const packed = new Uint32Array(count * wordsPerSplat);
  /* Reinterpreting rather than converting: the shader reads these back with the inverse. */
  const asFloat = new Float32Array(packed.buffer);

  const boundsMin = new Float32Array([Infinity, Infinity, Infinity]);
  const boundsMax = new Float32Array([-Infinity, -Infinity, -Infinity]);
  const extents = new Float32Array(count);

  for (let index = 0; index < count; index++) {
    const at = index * wordsPerSplat;
    const p = index * 3;
    const x = positions[p] ?? 0;
    const y = positions[p + 1] ?? 0;
    const z = positions[p + 2] ?? 0;
    asFloat[at] = x;
    asFloat[at + 1] = y;
    asFloat[at + 2] = z;
    if (x < (boundsMin[0] ?? 0)) boundsMin[0] = x;
    if (y < (boundsMin[1] ?? 0)) boundsMin[1] = y;
    if (z < (boundsMin[2] ?? 0)) boundsMin[2] = z;
    if (x > (boundsMax[0] ?? 0)) boundsMax[0] = x;
    if (y > (boundsMax[1] ?? 0)) boundsMax[1] = y;
    if (z > (boundsMax[2] ?? 0)) boundsMax[2] = z;

    /* `unpackUnorm4x8` reads the lowest byte as x, so red goes in the lowest byte. */
    packed[at + 3] =
      (byte(colors[p]) |
        (byte(colors[p + 1]) << 8) |
        (byte(colors[p + 2]) << 16) |
        (byte(opacities[index]) << 24)) >>>
      0;

    quaternionToMatrix(rotations, index * 4, index);

    /*
     * Sigma = R diag(s^2) R^T, six unique terms. Written as a sum over the three columns rather
     * than as two matrix products, which is the same arithmetic with nothing to allocate: column
     * j of R scaled by s_j is column j of R*S, and Sigma[i][k] is the dot of rows i and k of that.
     */
    const sx = scales[p] ?? 0;
    const sy = scales[p + 1] ?? 0;
    const sz = scales[p + 2] ?? 0;
    extents[index] = Math.max(sx, sy, sz);
    const w0 = sx * sx;
    const w1 = sy * sy;
    const w2 = sz * sz;
    const r00 = rotation[0] ?? 0;
    const r01 = rotation[1] ?? 0;
    const r02 = rotation[2] ?? 0;
    const r10 = rotation[3] ?? 0;
    const r11 = rotation[4] ?? 0;
    const r12 = rotation[5] ?? 0;
    const r20 = rotation[6] ?? 0;
    const r21 = rotation[7] ?? 0;
    const r22 = rotation[8] ?? 0;

    const xx = r00 * r00 * w0 + r01 * r01 * w1 + r02 * r02 * w2;
    const xy = r00 * r10 * w0 + r01 * r11 * w1 + r02 * r12 * w2;
    const xz = r00 * r20 * w0 + r01 * r21 * w1 + r02 * r22 * w2;
    const yy = r10 * r10 * w0 + r11 * r11 * w1 + r12 * r12 * w2;
    const yz = r10 * r20 * w0 + r11 * r21 * w1 + r12 * r22 * w2;
    const zz = r20 * r20 * w0 + r21 * r21 * w1 + r22 * r22 * w2;

    packed[at + 4] = packHalf2x16(xx, xy);
    packed[at + 5] = packHalf2x16(xz, yy);
    packed[at + 6] = packHalf2x16(yz, zz);
    /*
     * The extent, as float bits, in what texel one's fourth component would otherwise waste.
     *
     * **The GPU never reads it** — the vertex stage takes three of that texel's four components
     * for the covariance — so this costs the draw nothing and it means a `.drft` splat block can
     * be exactly the packed record. Carrying a parallel four bytes a splat instead would be
     * twelve percent on the one payload this engine most wants small. `extents` still exists
     * beside it because the sort reads it in a tight loop, where reinterpreting bits per access
     * would not be free. What would make this wrong is a later shader wanting that component for
     * something else, at which point the block grows a ninth word and says so in its header.
     */
    asFloat[at + 7] = extents[index] ?? 0;

    if (sh1 !== undefined) packSh1(sh1, index, packed, asFloat, at + 8);
  }

  /* A capture of nothing has no extent, and Infinity in a bound is a frustum test that never
     answers. Collapse to the origin, which a zero-count batch never reaches anyway. */
  if (count === 0) {
    boundsMin.fill(0);
    boundsMax.fill(0);
  }

  return {
    count,
    positions,
    packed,
    wordsPerSplat,
    boundsMin,
    boundsMax,
    extents,
    sphericalHarmonics: 0,
    shDegree: sh1 === undefined ? 0 : 1,
  };
}

/**
 * One splat's l=1 band into one `RGBA32UI` texel: nine bytes and a scale.
 *
 * **Bytes with a per-splat scale, and both halves of that are the decision.** Nine halves would be
 * eighteen bytes and would not fit a texel at all; nine bytes against a *capture-wide* range would
 * fit and would spend most of the range on the few splats with the largest coefficients, leaving
 * the ordinary ones quantised to a handful of levels. A per-splat scale costs the sixteenth byte —
 * which is four bytes as a float, filling the texel exactly — and gives every splat the whole
 * 8-bit range for its own coefficients.
 *
 * A splat whose band is all zero gets a scale of zero and nine mid-range bytes, which the shader
 * multiplies back to exactly zero. That is the common case in a capture's flat regions and it
 * costs nothing to say so.
 *
 * The three spare bytes of the third word are written zero rather than left as whatever the
 * allocation held: a `.drft` block is compared byte for byte by `drft-diff`, and a record with
 * uninitialised padding is a file that differs from itself.
 */
function packSh1(
  sh1: Float32Array,
  index: number,
  packed: Uint32Array,
  asFloat: Float32Array,
  at: number,
): void {
  const from = index * SPLAT_SH1_COEFFICIENTS;
  let scale = 0;
  for (let k = 0; k < SPLAT_SH1_COEFFICIENTS; k++) {
    const magnitude = Math.abs(sh1[from + k] ?? 0);
    if (magnitude > scale) scale = magnitude;
  }
  const inverse = scale > 0 ? 1 / scale : 0;
  /* Centre of the range, which is exactly zero once the scale multiplies it back. */
  const quantise = (value: number): number =>
    Math.max(0, Math.min(255, Math.round((value ?? 0) * inverse * 127 + 128)));

  packed[at] =
    (quantise(sh1[from] ?? 0) |
      (quantise(sh1[from + 1] ?? 0) << 8) |
      (quantise(sh1[from + 2] ?? 0) << 16) |
      (quantise(sh1[from + 3] ?? 0) << 24)) >>>
    0;
  packed[at + 1] =
    (quantise(sh1[from + 4] ?? 0) |
      (quantise(sh1[from + 5] ?? 0) << 8) |
      (quantise(sh1[from + 6] ?? 0) << 16) |
      (quantise(sh1[from + 7] ?? 0) << 24)) >>>
    0;
  packed[at + 2] = quantise(sh1[from + 8] ?? 0) >>> 0;
  asFloat[at + 3] = scale;
}

/**
 * Fill `rotation` from a quaternion at `offset`, normalising on the way.
 *
 * **A zero quaternion is a refusal naming the splat**, not a silent identity and not a `NaN` that
 * reaches the GPU. A NaN covariance produces a splat whose ellipse fails every comparison, which
 * on most drivers is an invisible splat and on some is one that covers the screen — and neither
 * points at the file that caused it.
 */
function quaternionToMatrix(source: Float32Array, offset: number, index: number): void {
  const qx = source[offset] ?? 0;
  const qy = source[offset + 1] ?? 0;
  const qz = source[offset + 2] ?? 0;
  const qw = source[offset + 3] ?? 0;
  const length = Math.hypot(qx, qy, qz, qw);
  if (length === 0 || !Number.isFinite(length)) {
    throw new Error(
      `splat ${index} carries a rotation of length ${length}, which names no orientation. ` +
        'A capture with a zero or non-finite quaternion is malformed at the source.',
    );
  }
  const x = qx / length;
  const y = qy / length;
  const z = qz / length;
  const w = qw / length;

  rotation[0] = 1 - 2 * (y * y + z * z);
  rotation[1] = 2 * (x * y - w * z);
  rotation[2] = 2 * (x * z + w * y);
  rotation[3] = 2 * (x * y + w * z);
  rotation[4] = 1 - 2 * (x * x + z * z);
  rotation[5] = 2 * (y * z - w * x);
  rotation[6] = 2 * (x * z - w * y);
  rotation[7] = 2 * (y * z + w * x);
  rotation[8] = 1 - 2 * (x * x + y * y);
}

function byte(value: number | undefined): number {
  const clamped = Math.max(0, Math.min(1, value ?? 0));
  return Math.round(clamped * 255);
}

function expectLength(name: string, array: Float32Array, expected: number): void {
  if (array.length === expected) return;
  throw new Error(
    `${name} has ${array.length} entries where a capture of this count needs ${expected}.`,
  );
}
