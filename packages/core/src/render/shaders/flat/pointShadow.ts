/**
 * Filtering an omnidirectional shadow.
 *
 * **This file used to be mostly seam defences and is not any more.** A cube map stores six
 * images under six 90 degree projections, and a filter tap that crossed a shared edge read the
 * other projection's answer — drawn as straight lines radiating from beneath the light, in seven
 * separate reports. Four things existed to fight that: a direction clamp, a flat tolerance, a
 * bias that grew toward a boundary, and a filter that narrowed near one. All four are gone,
 * because an octahedral map is one projection over the whole sphere and there is no join to
 * cross. See `shaders/octahedral.ts`.
 *
 * `MAX_FILTER_RADIUS` is still at the floor those defences forced it to. Widening it changes the
 * picture and is its own change.
 */
import { MAX_SHADOW_FILTER_TAPS } from '../../renderQuality.ts';
import { OUTPUT_TRANSFORM_GLSL } from '../outputTransform.ts';

export const POINTSHADOW_GLSL = `/**
 * How much of one tap's occlusion survives its own penumbra.
 *
 * **How much of a shadow survives, as well as how soft it is.** A penumbra does not merely blur
 * with distance from its caster, it *takes over*: far enough from the occluder, relative to how
 * big the source is, every point on the receiver can see part of the flame and there is no umbra
 * left at all. The shadow is gone, not blurry. Without it, two columns lit by a brazier threw
 * full-strength edges fifteen metres across the terrace, and the gap between them read as a
 * spotlight cone with straight sides rather than as a fire.
 *
 * **Per tap, and it was once for the whole filter, taken from the centre tap alone.** That is a
 * blocker search of one sample standing in for twelve, and it is right wherever the taps agree —
 * inside an umbra they all find the same occluder, so this returns exactly what the shared value
 * did, and the umbra is unchanged to the bit. It is wrong exactly where they disagree, which is
 * the silhouette: there the centre ray *misses*, so the search reports no occluder, the spread is
 * zero and the fade is switched off — while the taps that do land on the caster then draw at full
 * strength. What that paints is a hard one-texel line around a shadow whose interior has
 * correctly faded to nothing.
 *
 * Reported as shadows "faded out but NOT shadow outlines, generating long lines around the
 * world", and on a brazier as a bare square outline lying on the ground with no shadow inside it.
 *
 * **What it costs** is two multiplies and a divide per occluded tap, against a tap that has
 * already paid for a texture fetch. **What would make it wrong** is a filter wide enough that one
 * tap's occluder is not the occluder a neighbouring tap is estimating for, which is the same
 * limit the shared value had and is what \`MAX_FILTER_RADIUS\` bounds.
 */
float tapStrength(float receiverDistance, float occluderDistance, float sourceRadius) {
  float spread = max(receiverDistance - occluderDistance, 0.0) / max(occluderDistance, 0.05);
  float penumbra = clamp(sourceRadius * spread * PENUMBRA_FADE, 0.0, 1.0);
  return 1.0 - penumbra * penumbra;
}

float pointShadow(
  highp sampler2DArray maps,
  float layer,
  vec3 toFrag,
  float far,
  float near,
  float sourceRadius
) {
  /*
   * The receiver's own distance, and it is the *radius* now rather than a cube face's local Z.
   *
   * That difference removes two things. Every tap of an angular disk shares this one number,
   * where a cube needed each tap's own face-local Z recomputed — offsets changed it, and
   * comparing them all against the centre ray drew repeated wedges on large receivers. And the
   * stored value converts with a multiply instead of the perspective divide, which used to
   * magnify whatever error the sample arrived with, worst near the far plane.
   */
  float dist = length(toFrag);

  /*
   * A receiver nearer than the near plane is not shadowed at all.
   *
   * The near plane already says "nothing this close to the source is rendered into the
   * map", and a caller raises it so a fixture does not shadow its own housing. That was
   * only ever applied to *casters*, so a surface inside the same distance still went
   * through the comparison — against a map that, by the caller's own instruction, holds
   * nothing about anything near it.
   *
   * Reported on a ceiling with recessed strip lights hung a hand's width below it: shadows
   * that "go on and off" as the camera moves. The seams that made it unmissable are gone;
   * the gate stays, because comparing against a map that holds nothing is still wrong.
   *
   * The gate is the caller's own number rather than a new constant. A consumer that wants
   * the surface right beside its lamp to take a shadow can lower it, which is the same
   * knob and the same meaning it has always had for the other side of the transaction.
   */
  if (dist <= near) return 1.0;

  // Modest depth bias only. The heavy lifting is done by offsetting the
  // sample position along the surface normal before this is called — see the
  // call site — which is the cure for grazing receivers that depth bias alone
  // cannot fix without peter-panning.
  float bias = 0.04 + dist * 0.015;

  /*
   * Penumbra from the emitter's actual size.
   *
   * A shadow's softness is not a constant: it is set by how large the source is
   * and how far the caster stands from the surface it falls on. Find the
   * occluder with a centre tap, then widen the filter by
   * sourceRadius * (receiver - occluder) / occluder — the real geometry of a
   * penumbra. A bulb stays crisp; a flame goes soft with distance, which is
   * what makes a fire read as a fire rather than a large lamp.
   *
   * textureLod(..., 0.0), not the implicit-derivative texture() call this replaced.
   * pointShadowArray.ts allocates the array with texStorage3D at one storage level,
   * NEAREST both filters — there is no mip to select, so the two calls fetch the
   * identical texel. Not a quality trade; the output is bit-for-bit the same.
   *
   * It matters because implicit derivatives are only well-defined under *uniform*
   * control flow, and this sits inside the light loop below. See AGENTS.md, 2026-08-07.
   */
  float centreStored = textureLod(maps, vec3(octEncode(toFrag), layer), 0.0).r;
  float occluderDistance = centreStored >= 0.9999 ? dist : centreStored * far;
  float spread = max(dist - occluderDistance, 0.0) / max(occluderDistance, 0.05);
  /*
   * Softness comes from *fading the shadow*, not from widening the filter.
   *
   * Four attempts went into widening it, and the fourth is what identified why
   * none of them worked. The decisive observation was that the light pool looked
   * right until a column entered it. With no occluder the penumbra estimate is zero,
   * the filter stays at its floor, and the light pool is clean. The instant a
   * column is found the filter widens — and a wide angular filter on a *cube*
   * map is what crossed face seams. The artefact was never the columns' shadows;
   * it was the search for their penumbra.
   *
   * The map has no seams now, so the cap could open. It has not, in this change:
   * the storage moved and nothing else did, and the widening is a picture decision
   * taken against a tree that already renders correctly.
   */
  float radius = clamp(sourceRadius * spread, 0.01, MAX_FILTER_RADIUS) + 0.012;

  /*
   * Taps are placed on a disk *perpendicular to the light ray*, turned by half a golden
   * angle on every other column of pixels.
   *
   * Offsetting the ray by fixed 3D vectors was the earlier approach and it has
   * two faults that only show on a wide filter. The offsets are not
   * perpendicular to the ray, so part of each one moves the sample along its own
   * depth instead of across the shadow; and twelve *fixed* taps at a large
   * radius align, so the penumbra breaks into hard straight bands following the
   * tap pattern — reported, on a brazier behind a rank of columns, as strange
   * straight lines across the light pool.
   *
   * **The cure for that was a per-fragment hash, and it is what made the penumbra
   * stipple.** Twelve taps are a coarse estimate of how much of the emitter this point can
   * see; turning them by an unrelated angle at every pixel makes each pixel's error
   * independent of its neighbour's, which is the definition of noise. Something has to
   * average that back out, and this engine's lit pass is the last thing to touch the frame —
   * there is no blur and no temporal resolve behind it, so the noise reached the screen. Two
   * games reported the same coarse cross-hatch across a light pool.
   *
   * **So the turn comes from a two-pixel tile instead, and the pair is averaged afterwards.**
   * A pixel's own x parity picks one of two tap sets half a golden angle apart, and
   * \`main\` folds the pair together once the light loop is over — see the resolve there. The
   * pair's twenty-four taps are the filter; each pixel pays for twelve of them.
   *
   * **A *column* pair rather than a 2x2 square, and that was measured rather than assumed.**
   * Four turns on a square tile, resolved with both derivatives, came back at 3.88 against this
   * pair's 2.46 on the same build — because the second derivative hands the lower row of a quad
   * the upper row's difference on hardware that answers a coarse derivative, and with four turns
   * that is the wrong difference. Two turns keyed on the column alone make it the right one,
   * which is why the tile's shape and the resolve are one decision rather than two.
   *
   * **Neither half works alone**, which is the same pairing \`ambientOcclusion.ts\` describes
   * between its rotation tile and its blur. Measured on \`demo/dev/pointshadow.html\` at
   * \`?exposure=6\`, as mean absolute luminance difference to the right and down neighbour over
   * the mover's penumbra, on WebGL2: **4.60** for the per-fragment hash this replaces, **2.88**
   * for this tile with no resolve — and a one-pixel vertical comb in the picture, which is the
   * tile itself on screen — against **2.37** for the pair resolved. A frame with the shadow
   * switched off measures 0.81, and WebGPU answers 4.56 and 2.33 for the same two builds.
   *
   * **Unchanged by the move to an octahedral map, and that is the point.** The offsets are
   * angular perturbations of a direction, so every tap is still a direction and octEncode is
   * defined on all of them. Nothing offsets in UV, so the map's border needs no wrap
   * arithmetic and a tap that would have crossed a cube join lands on the adjacent texel.
   */
  vec3 fwd = normalize(toFrag);
  vec3 up = abs(fwd.y) < 0.9 ? vec3(0.0, 1.0, 0.0) : vec3(1.0, 0.0, 0.0);
  vec3 tu = normalize(cross(up, fwd));
  vec3 tv = cross(fwd, tu);
  /*
   * Integer arithmetic, because this is a lattice: a shader compiler is free to implement
   * \`mod(x, 2.0)\` as a multiply by a reciprocal, and a GPU here answers 3 for \`3.0 % 3.0\`.
   * \`gl_FragCoord.x\` is the pixel's centre, so truncating it is the pixel's own column.
   */
  float angle = float(int(gl_FragCoord.x) & 1) * PCF_PAIR_TURN;
  float ca = cos(angle);
  float sa = sin(angle);

  float lit = 0.0;
  for (int i = 0; i < ${MAX_SHADOW_FILTER_TAPS}; i++) {
    if (i >= uShadowFilterTaps) break;
    vec2 disk = PCF_OFFSETS[i];
    vec2 turned = vec2(disk.x * ca - disk.y * sa, disk.x * sa + disk.y * ca);
    // Perpendicular to the ray, and *not* scaled by its length: the offsets are
    // an angular perturbation of a direction, which is what the encoding takes.
    vec3 sampleDir = toFrag + (tu * turned.x + tv * turned.y) * radius;
    float stored = textureLod(maps, vec3(octEncode(sampleDir), layer), 0.0).r;
    if (stored >= 0.9999) {
      // Beyond the far plane nothing was rendered: treat as lit.
      lit += 1.0;
      continue;
    }
    float storedDistance = stored * far;
    if (dist - bias > storedDistance) {
      // A point shadow cannot outlive the finite light that casts it, so its
      // occlusion fades smoothly before the light's far plane.
      float reach = shadowReach(max(dist - storedDistance, 0.0), far);
      lit += 1.0 - reach * tapStrength(dist, storedDistance, sourceRadius);
    } else {
      lit += 1.0;
    }
  }
  return lit / float(max(uShadowFilterTaps, 1));
}

/**
 * The same filter for a source that has a *shape* rather than a radius.
 *
 * **One map from the rectangle's centre, and the rectangle's own extent as the filter's shape.**
 * That is the whole difference from \`pointShadow\` above, and it is what makes the result read as
 * one wide emitter rather than as a lamp: a bulb's penumbra is round, so a row of nine of them
 * gives nine round shadows that pile up darker where they overlap, and a strip's penumbra is a
 * strip — soft along the cable, tight across it, one shadow with one soft edge.
 *
 * **The taps land on the emitter's silhouette as this fragment sees it**, which is the part a
 * scalar radius cannot express. The rectangle's two axes are projected onto the plane across the
 * light ray and each keeps its own width, so the sample pattern is an ellipse rather than a disk,
 * and a rectangle seen edge-on along one axis has no penumbra in that direction — which is correct
 * and is what a strip light actually does. Four dot products and two square roots more than the
 * round filter.
 *
 * **The fade is driven by the *narrower* projected half extent, and the reason is a strip.** A
 * penumbra does not only blur a shadow, it takes over: past the point where every part of the
 * receiver can see part of the emitter there is no umbra left. Driven by the wider extent, a
 * three-metre cable would delete its own shadow at a metre of caster clearance — but across the
 * cable the source is nearly a line, so an umbra band survives there and only the length is
 * smeared. \`min\` keeps that band; \`max\` would erase it.
 *
 * **What it costs** is a second copy of the tap loop, about 30 lines, compiled into the eight
 * permutations that carry point shadows. Folding the two into one loop was the alternative and was
 * not taken: the shared form has to multiply the disk offset by a width before scaling the axis
 * rather than after, which is a different rounding order on every tap of the *point* path — so the
 * saving is paid for by perturbing eight scenes that currently gate at zero pixels, in a change
 * about area lights. \`docs/IMPROVEMENTS.md\` carries the row.
 *
 * **What would make it wrong** is a rectangle much wider than its distance to the caster, where
 * different points on the emitter genuinely see different silhouettes and no single map from the
 * centre stands in for all of them — a ceiling-wide panel a hand's width above a table. The honest
 * answer there is several maps across the emitter, which is several bakes.
 */
float areaShadow(
  highp sampler2DArray maps,
  float layer,
  vec3 toFrag,
  float far,
  float near,
  vec3 right,
  vec3 up,
  vec2 halfSize
) {
  float dist = length(toFrag);
  /* The near plane says nothing this close to the emitter was rendered; see \`pointShadow\`. */
  if (dist <= near) return 1.0;

  float bias = 0.04 + dist * 0.015;

  /*
   * The blocker search, one tap along the centre ray, exactly as the round filter does it. Similar
   * triangles turn the two distances into how much wider than the emitter the penumbra is.
   *
   * \`textureLod(..., 0.0)\` rather than \`texture()\`: the array carries one storage level and
   * NEAREST both filters, so the two fetch the identical texel — and this sits inside the area
   * light loop, which is not provably uniform control flow. See AGENTS.md, 2026-08-07.
   */
  float centreStored = textureLod(maps, vec3(octEncode(toFrag), layer), 0.0).r;
  float occluderDistance = centreStored >= 0.9999 ? dist : centreStored * far;
  float spread = max(dist - occluderDistance, 0.0) / max(occluderDistance, 0.05);

  vec3 fwd = toFrag / dist;
  /*
   * Each axis with its along-the-ray component removed: the rectangle's outline flattened onto the
   * plane the taps move in. The lengths that come back are the foreshortening — 1 for a rectangle
   * seen face-on, 0 for one seen exactly edge-on along that axis — so the two widths below carry
   * both the emitter's size and how much of it this fragment can see.
   */
  vec3 acrossX = right - fwd * dot(right, fwd);
  vec3 acrossY = up - fwd * dot(up, fwd);
  float seenX = length(acrossX);
  float seenY = length(acrossY);
  /*
   * A collapsed axis offsets nothing rather than offsetting along an arbitrary direction. Both
   * cannot collapse at once: \`right\` and \`up\` are perpendicular, so a ray parallel to one of
   * them is perpendicular to the other.
   */
  vec3 alongX = seenX > 1e-5 ? acrossX / seenX : vec3(0.0);
  vec3 alongY = seenY > 1e-5 ? acrossY / seenY : vec3(0.0);

  float halfX = halfSize.x * seenX;
  float halfY = halfSize.y * seenY;
  /* The same ceiling and the same floor the round filter uses, per axis. See MAX_FILTER_RADIUS. */
  float widthX = min(halfX * spread, MAX_FILTER_RADIUS) + 0.012;
  float widthY = min(halfY * spread, MAX_FILTER_RADIUS) + 0.012;

  /*
   * Turned inside the unit disk *before* the ellipse maps it, so the half-turn that separates
   * the two halves of a pixel pair survives the anisotropy. The same two-pixel tile the round
   * filter uses and for the same reasons — see \`pointShadow\`, which carries the measurement;
   * a rectangle's shadow stippled exactly as a lamp's did, because it is the same twelve taps.
   */
  float angle = float(int(gl_FragCoord.x) & 1) * PCF_PAIR_TURN;
  float ca = cos(angle);
  float sa = sin(angle);

  float lit = 0.0;
  for (int i = 0; i < ${MAX_SHADOW_FILTER_TAPS}; i++) {
    if (i >= uShadowFilterTaps) break;
    vec2 disk = PCF_OFFSETS[i];
    vec2 turned = vec2(disk.x * ca - disk.y * sa, disk.x * sa + disk.y * ca);
    vec3 sampleDir = toFrag + alongX * (turned.x * widthX) + alongY * (turned.y * widthY);
    float stored = textureLod(maps, vec3(octEncode(sampleDir), layer), 0.0).r;
    if (stored >= 0.9999) {
      /* Beyond the far plane nothing was rendered: treat as lit. */
      lit += 1.0;
      continue;
    }
    float storedDistance = stored * far;
    if (dist - bias > storedDistance) {
      /* An area light's occlusion cannot outlive the map that carries it either. */
      float reach = shadowReach(max(dist - storedDistance, 0.0), far);
      /* The narrower half extent, for the reason in the header: it is what keeps a strip's
         umbra. Per tap, for the reason \`tapStrength\` gives. */
      lit += 1.0 - reach * tapStrength(dist, storedDistance, min(halfX, halfY));
    } else {
      lit += 1.0;
    }
  }
  return lit / float(max(uShadowFilterTaps, 1));
}
#endif

out vec4 outColor;

${OUTPUT_TRANSFORM_GLSL}

/**
 * A fixed Poisson disk avoids the grid-shaped edge left by square 3x3 PCF.
 * Directional and point shadows consume the same maximum filter-tap budget;
 * their texture sizes differ because one is a 2D projection of a frustum and one
 * is an octahedral projection of the whole sphere, not because one is a lower
 * quality tier.
 */
#if DIRECTIONAL_SHADOWS
const vec2 DIRECTIONAL_PCF_OFFSETS[${MAX_SHADOW_FILTER_TAPS}] = vec2[${MAX_SHADOW_FILTER_TAPS}](
  vec2(-0.326, -0.406), vec2( 0.519,  0.767), vec2( 0.962, -0.195), vec2(-0.696,  0.457),
  vec2(-0.840, -0.074), vec2( 0.185, -0.893), vec2( 0.896,  0.412), vec2(-0.203,  0.621),
  vec2( 0.473, -0.480), vec2( 0.507,  0.064), vec2(-0.322, -0.933), vec2(-0.792, -0.598)
);

/** Anything outside the light frustum or beyond its far plane counts as lit. */`;
