/**
 * What a GGX prefilter has to decide before any device is involved: which roughness a mip level
 * stands for, and which source level one importance sample is allowed to read.
 *
 * **Backend-neutral, and that is the 2026-08-13 rule rather than tidiness.** A helper taking a
 * `WebGL2RenderingContext` is a decision the other backend cannot reach, so it gets reimplemented
 * there and the two drift. Both backends convolve the same cube by the same lobe; only the binding
 * differs. It is also what makes the arithmetic testable without a GPU, which is where the
 * hand-derived numbers in the test beside this file come from.
 *
 * **What a prefilter is, against what shipped before it.** A box filter averages a square of
 * texels. A GGX lobe is not square, is not symmetric about the reflection direction at grazing
 * angles, and widens with roughness in a way that has an analytic form. Sampling a box-filtered
 * chain by roughness is an approximation whose error is largest exactly where a surface looks most
 * interesting, and `uEnvironmentGain` is the control that has been correcting it by brute force.
 *
 * **What it costs:** a bake goes from six passes plus a mip chain to six passes plus a convolution
 * per level. That is affordable only because a bake is once per scene rather than once per frame,
 * and the sample count is a quality option for the same reason a phone and a workstation should
 * not agree on it. **What would make it wrong** is a caller baking per frame; at that point the
 * convolution is the frame's cost and the box chain it replaced was the right trade.
 */

/**
 * Samples per texel, per quality tier.
 *
 * **Powers of two, because the Hammersley sequence's radical inverse is a bit reversal.** A count
 * that is not a power of two leaves the sequence unevenly stratified, which does not error — it
 * shows as a faint directional bias in the rough levels that reads as the environment being
 * slightly wrong rather than as a sampling fault.
 *
 * 32 is where a rough level stops showing individual bright sources as separate blobs on the
 * scenes in this repository; 128 is where doubling it again stopped being visible. **What would
 * make these wrong** is a much brighter environment than any tested here — a small sun in an
 * otherwise dark sky is the worst case for variance, and it wants the high tier or a source level
 * chosen more conservatively than `sourceLevelForSample` does.
 */
export const PREFILTER_SAMPLE_COUNTS = {
  low: 16,
  medium: 32,
  high: 128,
} as const satisfies Readonly<Record<string, number>>;

/** The tier names, so a quality option can take one without restating them. */
export type PrefilterQuality = keyof typeof PREFILTER_SAMPLE_COUNTS;

/**
 * The octahedral edge a probe of a given cube face size gets.
 *
 * **Twice the face, which is the ratio `OCTAHEDRAL_EDGE` already chose** for the point-shadow
 * array and for the reason written down there: matching a cube face's angular density needs
 * `face * sqrt(6)`, so twice the face is about **1.22x coarser in the worst direction**, taken
 * because the filtering this unlocks is blurring the result anyway. 1024 for a 512 face there,
 * 256 for the default 128 face here — one rule, so the two octahedral resources in this engine
 * are calibrated against each other rather than each to taste.
 */
export function octahedralEdgeFor(faceSize: number): number {
  return Math.max(32, Math.trunc(faceSize) * 2);
}

/**
 * The irradiance image's edge, and why the diffuse term is a level of the same chain.
 *
 * **Eight, which is what a probe's diffuse light actually needs.** A cosine convolution removes
 * everything above the second band, so the image it produces has no detail an eighth of a sphere
 * across to lose — the size irradiance probes are conventionally stored at, arrived at from the
 * same place. It replaces nine spherical-harmonic coefficients, and 64 octahedral texels carry at
 * least what nine coefficients did.
 *
 * **What this buys is the last texture unit.** A second array would be a second sampler, and
 * WebGL2 guarantees sixteen units of which fifteen are spent. Folding the diffuse term into a
 * level of the radiance chain is what `REFRACT_SCENE_TEXTURE_UNIT`'s comment asks the next
 * sampler to do, and it leaves unit 15 free.
 */
export const IRRADIANCE_EDGE = 8;

/**
 * Which level of a chain holds the cosine convolution.
 *
 * The level whose image is `IRRADIANCE_EDGE` across. For the default 256 edge that is level 5, and
 * **the chain stops there rather than carrying unread levels above it** — `texStorage3D` takes a
 * level count, so the three that would hold sixteen, four and one texel are never created. Six
 * levels, 87,360 texels, 683 KB a layer at half float.
 */
export function irradianceLevelFor(edge: number): number {
  return Math.max(1, Math.round(Math.log2(Math.max(IRRADIANCE_EDGE * 2, edge) / IRRADIANCE_EDGE)));
}

/**
 * The coarsest level the GGX chain reaches, which is one below the irradiance level.
 *
 * This is `uEnvironmentMaxLod`, and it is what `roughnessForLevel` maps roughness 1 onto. For the
 * default edge it is 4, so the roughest level is 16 texels across.
 *
 * **That is better at high roughness than the cube it replaces, not worse.** A 128 cube's chain
 * ends at one texel a face, which the lit pass's own comment complains about — "one texel a face
 * and therefore one colour for every direction". What is given up is roughness granularity, five
 * stops against eight, and the level blend interpolates between them exactly as the cube's mip
 * filter did.
 */
export function ggxMaxLevelFor(edge: number): number {
  return Math.max(1, irradianceLevelFor(edge) - 1);
}

/**
 * The roughness mip level `level` is convolved for.
 *
 * **Linear in the level index, and it has to be**, because the lit pass already picks its level
 * with `surfaceRoughness * uEnvironmentMaxLod`. This is that relation read backwards. A different
 * curve here would not be an improvement in isolation — it would be the two halves disagreeing
 * about what level three means, which reads as roughness being subtly miscalibrated everywhere and
 * points at nothing.
 *
 * **What would make it wrong** is the lit pass changing how it selects a level; the two move
 * together or neither moves.
 */
export function roughnessForLevel(level: number, maxLevel: number): number {
  /*
   * A single-level chain has nowhere to go, and dividing by its zero top level is NaN — a
   * roughness the convolution would carry into every sample, producing a picture nobody could
   * attribute to a divide. A mirror is what one level honestly is.
   */
  if (maxLevel <= 0) return 0;
  return Math.min(1, Math.max(0, level / maxLevel));
}

/**
 * Which level of the source cube one importance sample may read.
 *
 * **Filtered importance sampling, and the whole point of it is variance rather than speed.** A
 * sample drawn from the GGX distribution covers a solid angle of `1 / (count * pdf)`; one texel of
 * a cube with `faceTexels`-wide faces covers `4*pi / (6 * faceTexels^2)`. When a sample is much
 * wider than a texel, reading the base level lets a few very bright texels land in some samples and
 * not others, and that variance survives the average as fireflies. Reading a level where the sample
 * covers roughly one texel is what removes them without raising the count.
 *
 * The half in front of the logarithm is not a fudge: a level step doubles a texel's width and so
 * quadruples its solid angle, and the level is a length ratio rather than an area one.
 *
 * **What it costs** is that the source has to be a box-filtered chain, which is why the capture
 * keeps its `generateMipmap` and the convolution writes a second cube. **What would make it wrong**
 * is convolving from a source that is itself already convolved: the lobe would be applied twice and
 * the error compounds up the chain, which is precisely the reason the two cubes are separate
 * objects rather than one written in place.
 */
export function sourceLevelForSample(
  pdf: number,
  faceTexels: number,
  count: number,
  maxLevel: number,
): number {
  /* Guard the logarithm's arguments rather than its result; a zero here is a caller's bug. */
  const texels = Math.max(1, faceTexels);
  const samples = Math.max(1, count);
  const density = Math.max(1e-12, pdf);

  const texelSolidAngle = (4 * Math.PI) / (6 * texels * texels);
  const sampleSolidAngle = 1 / (samples * density);
  const level = 0.5 * Math.log2(sampleSolidAngle / texelSolidAngle);

  return Math.min(maxLevel, Math.max(0, level));
}

/**
 * A level's own edge in texels, which is not the map's.
 *
 * **The gutter is one texel at every level**, so its share of the map doubles as the chain
 * coarsens and an inset computed once from the map's own size is wrong everywhere but level zero.
 * `flat/probeGrid.ts` carries the same expression for the forward path and records the slide it
 * prevents: a thirty-second of the map at the top of the chain, visible as a reflection sliding as
 * roughness rises.
 *
 * Floored at four, which is where the chain stops — a level two texels across is all gutter.
 */
export function probeLevelEdge(edge: number, level: number): number {
  return Math.max(edge / 2 ** level, 4);
}

/**
 * The two levels a roughness reads and how far between them it sits, as `lo`, `hi`, `t`.
 *
 * **Mixed by hand rather than by hardware trilinear**, for the reason above: the two levels have
 * different insets and hardware applies one coordinate to both. So the two fetches are issued at
 * their own insets and blended here, and this is the arithmetic that says which two and by how
 * much. Clamped at both ends, so a lod past the chain reads the coarsest level twice rather than
 * sampling a level that does not exist.
 */
export function probeLevelMix(lod: number, maxLevel: number, out: Float32Array): Float32Array {
  const lo = Math.min(Math.max(Math.floor(lod), 0), maxLevel);
  const hi = Math.min(lo + 1, maxLevel);
  out[0] = lo;
  out[1] = hi;
  out[2] = Math.min(Math.max(lod - lo, 0), 1);
  return out;
}
