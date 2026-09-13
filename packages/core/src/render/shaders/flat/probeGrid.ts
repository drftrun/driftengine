/** Reading the probe array: which layers a point sits between, and what each of them holds. */

/**
 * The lit pass's half of the grid, and the two things it has to get right.
 *
 * **A layer index is arithmetic rather than a lookup.** Probes stand on a lattice, so the cell a
 * point is in comes out of one multiply and a floor, and the eight corner weights are three lerps.
 * `probeGrid.ts` computes the same thing in TypeScript for a caller pacing its bakes, and the two
 * expressions have to agree or every fragment reads a probe that was baked somewhere else.
 *
 * **Levels are mixed by hand, and the gutter is why.** A level's gutter is one texel, so its inset
 * in normalised coordinates is `1 / edge` and differs between levels. Hardware trilinear applies
 * one coordinate to both levels it blends, so one of the two would be read at the wrong inset — by
 * a thirty-second of the map at the top of the chain, which is a visible slide in a reflection as
 * roughness rises. Two fetches at their own insets, mixed, is the price of the fold.
 *
 * **What it costs**, at the counts below: eight fetches for the diffuse term and four for the
 * reflection. The diffuse eight are of an eight-texel image and land in the same cache line; the
 * reflection's four are two probes at two levels. A grid of one collapses to one and two, because
 * every corner resolves to the same layer and the zero-weight ones are skipped.
 */
export const PROBEGRID_GLSL = `#if ENVIRONMENT_PROBE
/**
 * Where a direction lands in one layer at one level, inset past that level's gutter.
 *
 * The level's own edge rather than the map's, since a gutter is one texel at every level and its
 * share of the map doubles as the chain coarsens.
 */
vec3 probeCoord(vec3 dir, float level, float layer) {
  float levelEdge = max(uEnvironmentEdge / exp2(level), 4.0);
  return vec3(octInsetUv(dir, levelEdge), layer);
}

/**
 * A layer index from whole lattice coordinates: x fastest, then y, then z.
 *
 * Clamped, which is what makes an axis one probe wide safe: the second corner of a pair that does
 * not exist resolves to the first, at a weight the caller has already set to zero.
 */
float probeLayer(vec3 index) {
  vec3 top = max(uProbeGridCounts - 1.0, vec3(0.0));
  vec3 held = clamp(index, vec3(0.0), top);
  return held.x + uProbeGridCounts.x * (held.y + uProbeGridCounts.y * held.z);
}

/**
 * The cell a world position is in, as a base corner and the fraction past it.
 *
 * **Clamped rather than wrapped**, so a point outside the grid takes the nearest probes at full
 * weight — the environment it would have had one step inside. Wrapping would light one end of a
 * world with the probe from the other end, which is invisible in any test that stays indoors.
 *
 * An axis one probe wide has its fraction forced to zero, so that axis contributes a factor of one
 * to every corner weight and the eight corners collapse onto fewer layers whose weights still sum
 * to one.
 */
void probeCell(vec3 worldPos, out vec3 base, out vec3 frac) {
  vec3 top = max(uProbeGridCounts - 1.0, vec3(0.0));
  vec3 local = clamp((worldPos - uProbeGridOrigin) * uProbeGridInvSpacing, vec3(0.0), top);
  base = min(floor(local), max(top - 1.0, vec3(0.0)));
  frac = local - base;
  frac *= step(vec3(1.5), uProbeGridCounts);
}

/** One probe's diffuse light: the cosine convolution, at its own level, in one fetch. */
vec3 probeIrradiance(vec3 dir, float layer) {
  float level = uEnvironmentIrradianceLevel;
  return textureLod(uEnvironment, probeCoord(dir, level, layer), level).rgb;
}

/**
 * One probe's reflection at a roughness, as two levels mixed by hand.
 *
 * textureLod rather than texture throughout, per the 2026-08-07 rule and for a second reason on
 * top of it: the level is wanted here, and the fetches sit inside a loop that no compiler can
 * prove uniform.
 */
vec3 probeRadiance(vec3 dir, float lod, float layer) {
  float lo = clamp(floor(lod), 0.0, uEnvironmentMaxLod);
  float hi = min(lo + 1.0, uEnvironmentMaxLod);
  vec3 coarse = textureLod(uEnvironment, probeCoord(dir, hi, layer), hi).rgb;
  vec3 fine = textureLod(uEnvironment, probeCoord(dir, lo, layer), lo).rgb;
  return mix(fine, coarse, clamp(lod - lo, 0.0, 1.0));
}

/**
 * The grid's diffuse light at a point, trilinear over the eight probes around it.
 *
 * **Eight, because diffuse is the term a grid exists for.** A floor spanning four probes is the
 * case the whole row was costed against, and a hard selection steps visibly across it — which is
 * exactly where a lit surface has nothing else going on to hide the seam.
 *
 * Zero-weight corners are skipped, so a grid of one does one fetch rather than eight.
 *
 * The cell is recomputed here rather than passed in, because the two terms sit in separate
 * conditional blocks of the lit pass and threading a pair of vectors between them would mean a
 * third. Six arithmetic operations against that.
 */
vec3 gridIrradiance(vec3 dir, vec3 worldPos) {
  vec3 base;
  vec3 frac;
  probeCell(worldPos, base, frac);
  vec3 sum = vec3(0.0);
  for (int c = 0; c < 8; c++) {
    vec3 corner = vec3(float(c & 1), float((c >> 1) & 1), float((c >> 2) & 1));
    vec3 axisWeight = mix(1.0 - frac, frac, corner);
    float weight = axisWeight.x * axisWeight.y * axisWeight.z;
    if (weight <= 0.0) continue;
    sum += probeIrradiance(dir, probeLayer(base + corner)) * weight;
  }
  return sum;
}

/**
 * The grid's reflection at a point: two probes along the axis the point is most between.
 *
 * **Two rather than eight, and the axis is chosen rather than fixed.** Sixteen fetches for a
 * reflection is not affordable on the parts this engine targets, and a single probe pops as a
 * smooth surface crosses a cell boundary. Blending along the axis with the largest betweenness
 * removes the pop where it is largest for one extra pair of fetches; the other two axes take their
 * nearest probe, where the switch happens at the point the blend would have been half and half.
 *
 * Full trilinear here is recorded as deferred rather than refused, with its reversal condition: a
 * consumer measuring the remaining seam as their constraint.
 */
vec3 gridRadiance(vec3 dir, float lod, vec3 worldPos) {
  vec3 base;
  vec3 frac;
  probeCell(worldPos, base, frac);
  vec3 between = min(frac, 1.0 - frac);
  vec3 nearest = base + step(vec3(0.5), frac);
  vec3 low = nearest;
  vec3 high = nearest;
  float t = 0.0;
  if (between.x >= between.y && between.x >= between.z) {
    low.x = base.x;
    high.x = base.x + 1.0;
    t = frac.x;
  } else if (between.y >= between.z) {
    low.y = base.y;
    high.y = base.y + 1.0;
    t = frac.y;
  } else {
    low.z = base.z;
    high.z = base.z + 1.0;
    t = frac.z;
  }
  vec3 near = probeRadiance(dir, lod, probeLayer(low));
  if (t <= 0.0) return near;
  return mix(near, probeRadiance(dir, lod, probeLayer(high)), t);
}
#endif`;
