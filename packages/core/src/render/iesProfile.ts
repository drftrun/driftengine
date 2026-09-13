/** Photometric profiles packed into one texture a light can index into. */

/** What a reader produces, restated structurally so core imports no package. See `readIesProfile`. */
export interface PhotometricProfile {
  readonly verticalAngles: Float32Array;
  readonly horizontalAngles: Float32Array;
  readonly candela: Float32Array;
  readonly maxCandela: number;
}

/**
 * Columns across the atlas: one row per profile, sampled by vertical angle.
 *
 * **A power of two, and 128 rather than 64 because the interesting part of a real distribution is
 * narrow.** A spot fixture puts its whole falloff inside a few degrees of the beam edge, and at 64
 * columns that edge is two texels wide and reads as a step. What a larger number costs is four
 * kilobytes a profile, which is nothing against the image it replaces.
 */
export const IES_ATLAS_WIDTH = 128;

/**
 * `planes` rows of intensity per profile, normalised to the profile's peak, indexed by angle.
 *
 * **Resampled to a regular grid here rather than in the reader**, because that is a decision about
 * a texture and not about a file: LM-63 is dense where a distribution changes and sparse where it
 * does not, and a shader cannot sample an irregular table without carrying it.
 *
 * **Asymmetric fixtures keep their horizontal planes as of 2026-08-27.** This function flattened
 * to the first plane and said in its own comment what to reach for instead — "a row per horizontal
 * plane with the light carrying a plane count" — and that is what this is. A street light and a
 * wall washer are the fixtures that are not axially symmetric, and they are exactly the fixtures
 * whose whole point is that they throw more one way than another.
 *
 * **One plane count for the atlas rather than one per profile**, and every profile is padded to
 * it. The shader's row is `profile * planes + plane`; a per-profile count would need a second
 * number in a light's record to divide by, and a light's record is where space is expensive.
 * Padding a symmetric profile repeats its single row, which costs `width` floats a plane — half a
 * kilobyte — against the image an IES profile replaces. **A set with nothing asymmetric in it
 * comes out at one plane and is bit-identical to what this produced before planes existed**, which
 * is what keeps the common case free.
 *
 * **The planes are resampled onto a regular 0-to-360 arc**, for the reason the vertical angles are
 * resampled onto a fixed one: the shader maps an azimuth to a plane by arithmetic and carries no
 * per-profile angle list to search. A file measuring 0 and 180 packed into four planes has its
 * measured values at planes 0 and 2 and the interpolation between them at 1 and 3, which is what a
 * fixture symmetric about its own axis actually throws.
 *
 * **A profile occupies `planes + 1` rows, and the extra one repeats the first.** That is what lets
 * the shader do the whole azimuth blend in **one** fetch, with the texture's own linear filter
 * between adjacent rows: without the wrap row the plane after the last would have to blend back to
 * the first, which a fractional row cannot express — it would reach into the *next profile's*
 * first plane instead. The alternative was two explicit fetches and a `mix`, which was written,
 * measured at **+18,315 gzipped bytes on `core-only`** across the sixteen fragment permutations,
 * and replaced by this. One row a profile is 512 bytes.
 *
 * **Normalised to each profile's own peak** because the shader multiplies it into a light's
 * colour, which already carries the intensity a consumer chose. A profile that also carried
 * absolute candela would multiply the two and make every IES light either black or blinding. The
 * peak is the *profile's*, not the plane's: normalising each plane to itself would make every
 * plane reach 1 and throw away the asymmetry this exists to carry.
 */
export function packIesAtlas(
  profiles: readonly PhotometricProfile[],
  width: number = IES_ATLAS_WIDTH,
): { data: Float32Array; width: number; height: number; planes: number } {
  /*
   * **One row of ones when there is nothing to pack, rather than a zero-height texture.**
   *
   * A sampler declared in the shader must have a complete texture bound whether or not any branch
   * reads it — the argument `emptyTexture.ts` makes — and a zero-height allocation is an
   * `INVALID_VALUE` rather than an empty one. Ones rather than zeros because this value multiplies
   * a light's colour: an all-zero fallback would switch off every light that reached it.
   */
  if (profiles.length === 0) {
    return { data: new Float32Array(width).fill(1), width, height: 1, planes: 1 };
  }

  /* The widest fixture decides the grid, so no profile is resampled *down* and loses a lobe. */
  let planes = 1;
  for (const profile of profiles) {
    planes = Math.max(planes, profile?.horizontalAngles.length ?? 1);
  }

  /* The wrap row: `planes + 1` per profile, the last repeating the first. See the note above. */
  const rows = planes + 1;
  const height = profiles.length * rows;
  const data = new Float32Array(width * height);
  for (let index = 0; index < profiles.length; index++) {
    const profile = profiles[index];
    for (let row = 0; row < rows; row++) {
      const at = (index * rows + row) * width;
      if (profile === undefined) {
        data.fill(1, at, at + width);
        continue;
      }
      /* Row `planes` is plane 0 again, which is what makes the blend wrap rather than bleed. */
      packRow(profile, row % planes, planes, data, at, width);
    }
  }
  return { data, width, height, planes };
}

/**
 * Where a plane of the regular grid falls among the angles a file measured, as a pair and a mix.
 *
 * **Wrapped rather than clamped at the top**, which is the difference between an azimuth and a
 * vertical angle: a fixture measured at 0 and 180 is symmetric about its own axis and 270 degrees
 * is the same as 90, so the plane past the last measurement interpolates back toward the first.
 * Clamping instead would flatten one whole side of every two-plane fixture.
 *
 * A file that measures a full 360 — the last angle equal to the first — is handled by the same
 * arithmetic, because the wrap lands on that duplicate.
 */
function planeSpan(
  horizontal: Float32Array,
  plane: number,
  planes: number,
): { lower: number; upper: number; mix: number } {
  const count = horizontal.length;
  if (count <= 1) return { lower: 0, upper: 0, mix: 0 };
  const azimuth = (plane / planes) * 360;

  let upper = 0;
  while (upper < count && (horizontal[upper] ?? 0) <= azimuth) upper += 1;
  if (upper === 0) return { lower: 0, upper: 0, mix: 0 };
  if (upper >= count) {
    /* Past the last measured plane: back toward the first, across whatever arc is left. */
    const last = horizontal[count - 1] ?? 0;
    const span = 360 - last + (horizontal[0] ?? 0);
    return {
      lower: count - 1,
      upper: 0,
      mix: span > 0 ? Math.min(1, Math.max(0, (azimuth - last) / span)) : 0,
    };
  }
  const a = horizontal[upper - 1] ?? 0;
  const b = horizontal[upper] ?? a;
  return { lower: upper - 1, upper, mix: b > a ? (azimuth - a) / (b - a) : 0 };
}

/**
 * One profile into one row, sampled at `width` even steps across a **fixed 0 to 180 degree arc**.
 *
 * **Fixed rather than the profile's own range, and that is what keeps a light's record to one
 * slot.** A row spanning whatever a file happened to measure would need the light to carry the
 * first angle and the span as well, so the shader could map an angle back into the row — three
 * values where the froxel record has exactly one free. Pinning every row to the same arc makes the
 * lookup `angle / 180`, and the row index is then all a light needs.
 *
 * **Outside the measured range a row holds the nearest measured value**, which is correct rather
 * than merely safe: a downlight measured 0 to 90 emits nothing above the horizontal, and its last
 * sample is already the near-zero that says so. **What would make it wrong** is a file measured
 * over a partial arc that does *not* fall to zero at its end — a fixture with a documented cutoff
 * — where clamping extends its last value across everything beyond. That is a real shape and it is
 * rare, and the tell is a profile whose final candela is a large fraction of its peak.
 */
function packRow(
  profile: PhotometricProfile,
  plane: number,
  planes: number,
  out: Float32Array,
  offset: number,
  width: number,
): void {
  const angles = profile.verticalAngles;
  const count = angles.length;
  const peak = profile.maxCandela > 0 ? profile.maxCandela : 1;
  /* The candela grid is horizontal-major: all vertical angles of the first plane, then the next.
     So a plane is a run of `count` values, and blending two planes is a blend of two runs. */
  const span = planeSpan(profile.horizontalAngles, plane, planes);
  const lowerAt = span.lower * count;
  const upperAt = span.upper * count;

  for (let column = 0; column < width; column++) {
    /* Texel centres over the whole arc, so column 0 is 0 degrees and the last is 180. */
    const angle = width === 1 ? 0 : (column / (width - 1)) * 180;

    /*
     * Linear between the two measured angles either side. A nearest-neighbour lookup on a table
     * that is sparse in the flat regions produces visible steps exactly where the distribution is
     * smooth, which reads as banding in the light rather than as a sampling choice.
     */
    let upper = 1;
    while (upper < count && (angles[upper] ?? 0) < angle) upper += 1;
    const lower = Math.max(0, Math.min(upper - 1, count - 1));
    const top = Math.min(upper, count - 1);
    const a = angles[lower] ?? 0;
    const b = angles[top] ?? a;
    const mix = b > a ? Math.min(1, Math.max(0, (angle - a) / (b - a))) : 0;

    /*
     * Two interpolations, and the order is not arbitrary: vertical within each of the two planes
     * either side, then horizontal between the two results. Blending the planes first and then
     * sampling would be the same number for a linear grid and is not one for a real fixture,
     * whose vertical lists are the same but whose lobes are not.
     */
    const lowPlane = interpolate(profile.candela, lowerAt, lower, top, mix);
    const highPlane =
      span.lower === span.upper ? lowPlane : interpolate(profile.candela, upperAt, lower, top, mix);
    out[offset + column] = (lowPlane + (highPlane - lowPlane) * span.mix) / peak;
  }
}

/** One plane's value between two vertical samples, at `at` in the horizontal-major grid. */
function interpolate(
  candela: Float32Array,
  at: number,
  lower: number,
  upper: number,
  mix: number,
): number {
  const low = candela[at + lower] ?? 0;
  const high = candela[at + upper] ?? low;
  return low + (high - low) * mix;
}
