/**
 * What a lamp's light keeps through glass at this receiver: `glassShadow.ts`'s rules over the point
 * filter's own taps, for a round lamp and for a rectangle.
 *
 * **The sun's lookup, in the lamp's geometry** (`directionalShadow.ts`'s `sunGlassLookup`). The
 * outline comes from depth-tested taps on the opaque filter's own disk — a tap counts a pane only
 * where the receiver is farther from the lamp than that pane, by the opaque bias, and fades with
 * the opaque shadow's own reach and penumbra — and the colour from spread taps, read coarse,
 * unmixed from what lies around the pane and weighed by its share, so a frosted patch mixes its
 * panes and keeps the light a clear one passes.
 *
 * **Where a lamp differs is the frost.** Light scattered at a pane spreads in a cone behind it, so
 * at a receiver `behind` metres past the pane the colour comes from pane points within
 * `(1 − clarity) × tan 30° × behind` of the ray. Seen from the lamp that is an angle over the pane's
 * distance, and in the filter's units — offsets added to the ray at the receiver's distance — it is
 * that spread times `dist / pane`. Capped at `FROST_RADIUS_CAP` base radii, the tap count unchanged.
 *
 * **What it costs** is one coarse tint fetch per shadowed lamp on a receiver with no glass near its
 * filter — the tint is white there, and the lookup stops — and two tap loops where there is. **What
 * it gives up** is what the sun's gives up, plus the octahedral map's fold: a coarse level averages
 * across the map's outer edges, so a wide frost spread lying across one borrows a little colour from
 * the other side of the sphere.
 */
import { FROST_RADIUS_CAP, FROST_SPREAD } from '../../glassShadow.ts';
import { MAX_SHADOW_FILTER_TAPS } from '../../renderQuality.ts';

/** Octahedral texels per radian at edge 1: the sphere's 4π over `edge²` texels, as a side. */
const TEXELS_PER_RADIAN = 1 / Math.sqrt(4 * Math.PI);

export const LAMP_GLASS_GLSL = `
/*
 * Whether any glass lies within \`radius\` of this ray: the tint is exactly white wherever no pane
 * was drawn, and any pane passes at most 0.96 of itself, so one coarse fetch answers for the disk.
 */
bool lampGlassNear(float tintLayer, vec3 toFrag, float dist, float radius) {
  float texels = radius / dist * float(textureSize(uPointGlassTints, 0).x) * ${TEXELS_PER_RADIAN.toFixed(6)};
  vec4 around = textureLod(uPointGlassTints, vec3(octEncode(toFrag), tintLayer), log2(max(texels, 1.0)) + 1.0);
  return min(min(around.r, around.g), min(around.b, around.a)) < 0.998;
}

/*
 * The spread half: the colour of the glass the frost disk finds, read at \`lod\`, unmixed from what
 * lies around it and weighed by its share (glassShadow.ts's spreadTint). Clear when it finds none.
 */
vec3 lampGlassColour(
  float tintLayer,
  vec3 toFrag,
  vec3 tu,
  vec3 tv,
  float offset,
  float lod,
  float clarity,
  float ca,
  float sa
) {
  vec3 colour = vec3(0.0);
  float found = 0.0;
  for (int i = 0; i < ${MAX_SHADOW_FILTER_TAPS}; i++) {
    if (i >= uShadowFilterTaps) break;
    vec2 disk = PCF_OFFSETS[i];
    vec2 turned = vec2(disk.x * ca - disk.y * sa, disk.x * sa + disk.y * ca);
    vec3 spreadDir = toFrag + (tu * turned.x + tv * turned.y) * offset;
    vec4 pane = glassUnmix(textureLod(uPointGlassTints, vec3(octEncode(spreadDir), tintLayer), lod), clarity);
    colour += pane.rgb * pane.a;
    found += pane.a;
  }
  return found > 0.0 ? colour / found : vec3(1.0);
}

/* One outline tap: how much of the pane on this ray lies between the lamp and the receiver. */
float lampGlassTap(vec3 sampleDir, float glassLayer, float dist, float bias, float far, float size) {
  float stored = textureLod(uPointShadows, vec3(octEncode(sampleDir), glassLayer), 0.0).r;
  if (stored >= 0.9999) return 0.0;
  float storedDistance = stored * far;
  if (dist - bias <= storedDistance) return 0.0;
  return shadowReach(max(dist - storedDistance, 0.0), far) * tapStrength(dist, storedDistance, size);
}

/*
 * The frost's offset in the filter's units, the tint level that reads it as an average, and the
 * pane's clarity: the cone behind the nearest pane on the ray, as the lamp sees it, capped at
 * \`base\` radii.
 */
vec3 lampGlassFrost(float tintLayer, vec2 centreUv, float dist, float paneDistance, float base) {
  float clarity = textureLod(uPointGlassTints, vec3(centreUv, tintLayer), 0.0).a;
  float behind = max(dist - paneDistance, 0.0);
  float frost = (1.0 - clarity) * ${FROST_SPREAD.toFixed(6)} * behind * dist / max(paneDistance, 0.05);
  float offset = clamp(frost, base, base * ${FROST_RADIUS_CAP.toFixed(1)});
  float texels = offset / dist * float(textureSize(uPointGlassTints, 0).x) * ${TEXELS_PER_RADIAN.toFixed(6)};
  return vec3(offset, log2(max(texels, 1.0)), clarity);
}

/*
 * **One lookup for both kinds of lamp**, a rectangle's being the round one with its outline taps on
 * areaShadow's ellipse: a zero \`halfSize\` is a round lamp of \`sourceRadius\`. One function rather
 * than two because every lit permutation carries it, and two copies of the same eighty lines were
 * thirty-five kilobytes of the generated shaders.
 */
vec3 lampGlassTint(
  float layer,
  vec3 toFrag,
  float far,
  float near,
  vec3 right,
  vec3 up,
  vec2 halfSize,
  float sourceRadius
) {
  if (textureSize(uPointGlassTints, 0).x <= 1) return vec3(1.0);
  float dist = length(toFrag);
  if (dist <= near) return vec3(1.0);
  float glassLayer = layer + 1.0;
  float tintLayer = layer * 0.5;
  /* The opaque filter's own widest disk, so the check covers every tap it could take. */
  if (!lampGlassNear(tintLayer, toFrag, dist, MAX_FILTER_RADIUS + 0.012)) return vec3(1.0);

  float bias = 0.04 + dist * 0.015;
  vec2 centreUv = octEncode(toFrag);
  float paneStored = textureLod(uPointShadows, vec3(centreUv, glassLayer), 0.0).r;
  float paneDistance = paneStored >= 0.9999 ? dist : paneStored * far;
  float spread = max(dist - paneDistance, 0.0) / max(paneDistance, 0.05);

  vec3 fwd = toFrag / dist;
  vec3 lift = abs(fwd.y) < 0.9 ? vec3(0.0, 1.0, 0.0) : vec3(1.0, 0.0, 0.0);
  vec3 tu = normalize(cross(lift, fwd));
  vec3 tv = cross(fwd, tu);
  /* A round lamp: the opaque filter's radius, from the pane as its occluder, so a large lamp's
     tint is soft too. A rectangle: its two axes across the ray, each with its own width. */
  vec3 alongX = tu;
  vec3 alongY = tv;
  float radius = clamp(sourceRadius * spread, 0.01, MAX_FILTER_RADIUS) + 0.012;
  float widthX = radius;
  float widthY = radius;
  float penumbra = sourceRadius;
  if (halfSize.x > 0.0) {
    vec3 acrossX = right - fwd * dot(right, fwd);
    vec3 acrossY = up - fwd * dot(up, fwd);
    float seenX = length(acrossX);
    float seenY = length(acrossY);
    alongX = seenX > 1e-5 ? acrossX / seenX : vec3(0.0);
    alongY = seenY > 1e-5 ? acrossY / seenY : vec3(0.0);
    float halfX = halfSize.x * seenX;
    float halfY = halfSize.y * seenY;
    widthX = min(halfX * spread, MAX_FILTER_RADIUS) + 0.012;
    widthY = min(halfY * spread, MAX_FILTER_RADIUS) + 0.012;
    penumbra = min(halfX, halfY);
  }
  /* pointShadow's column-pair turn, so main's pair resolve averages these taps as it does those. */
  float angle = float(int(gl_FragCoord.x) & 1) * PCF_PAIR_TURN;
  float ca = cos(angle);
  float sa = sin(angle);

  float cover = 0.0;
  for (int i = 0; i < ${MAX_SHADOW_FILTER_TAPS}; i++) {
    if (i >= uShadowFilterTaps) break;
    vec2 disk = PCF_OFFSETS[i];
    vec2 turned = vec2(disk.x * ca - disk.y * sa, disk.x * sa + disk.y * ca);
    vec3 sampleDir = toFrag + alongX * (turned.x * widthX) + alongY * (turned.y * widthY);
    cover += lampGlassTap(sampleDir, glassLayer, dist, bias, far, penumbra);
  }
  if (cover <= 0.0) return vec3(1.0);
  vec3 frost = lampGlassFrost(tintLayer, centreUv, dist, paneDistance, max(widthX, widthY));
  vec3 colour = lampGlassColour(tintLayer, toFrag, tu, tv, frost.x, frost.y, frost.z, ca, sa);
  return mix(vec3(1.0), colour, cover / float(max(uShadowFilterTaps, 1)));
}

/* The two ways in, each asking first whether this build reads glass at all (GLASS_SHADOWS). */
vec3 pointGlassTint(float layer, vec3 toFrag, float far, float near, float sourceRadius) {
  if (GLASS_SHADOWS) return lampGlassTint(layer, toFrag, far, near, vec3(0.0), vec3(0.0), vec2(0.0), sourceRadius);
  return vec3(1.0);
}

vec3 areaGlassTint(
  float layer,
  vec3 toFrag,
  float far,
  float near,
  vec3 right,
  vec3 up,
  vec2 halfSize
) {
  if (GLASS_SHADOWS) return lampGlassTint(layer, toFrag, far, near, right, up, halfSize, 0.0);
  return vec3(1.0);
}
`;
