/** How light falls off with distance, and the specular lobes a highlight is made of. */
import { POINT_SHADOW_FADE_START } from '../../renderQuality.ts';

export const LOBES_GLSL = `float shadowReach(float distance, float maxDistance) {
  return 1.0 - smoothstep(
    maxDistance * ${POINT_SHADOW_FADE_START.toFixed(2)},
    maxDistance,
    distance
  );
}

/**
 * How quickly a point shadow gives way to its own penumbra.
 *
 * Tuned by eye against a brazier: at 1.6 a column's shadow is crisp for about
 * two metres, readable for four, and gone by eight — which is what a metre-wide
 * flame actually does, and what stops a long throw reading as a hard-edged cone.
 */
const float PENUMBRA_FADE = 1.6;
/**
 * Widest the filter may open, in radians of direction.
 *
 * **Was 0.07, and that floor was a cube map's fault.** Anything wide enough to soften a long
 * shadow was wide enough to straddle a face boundary, and a tap across a seam read a face
 * rendered under a different projection — a straight line running outward from beneath the
 * light, in seven separate reports and four failed attempts at widening. There are no faces
 * now: an octahedral map is one projection over the whole sphere, so a tap that would have
 * crossed a join lands on the adjacent texel.
 *
 * **0.25 rather than further, and the ceiling is arithmetic rather than taste.** Both this and
 * the fade below are driven by the same quantity, sourceRadius * spread:
 *
 *     0.07  penumbra 0.11, strength 0.99   the shadow is essentially whole
 *     0.25  penumbra 0.40, strength 0.84   soft, and still plainly a shadow
 *     0.40  penumbra 0.64, strength 0.59   more than half faded out
 *     0.625 penumbra 1.00, strength 0.00   gone: nothing left to blur
 *
 * So the cap can never matter to a shadow at more than 0.625, and past about 0.25 it is
 * widening the filter on something already fading away — paying scattered taps for softness
 * nobody can see. A sweep at 0.07, 0.15, 0.25, 0.40 and 0.625 was captured on both point-lit
 * scenes: no value drew a straight line, a band or a speckle, the visible difference was
 * concentrated in gilded-chamber and was slight in night-court, and **the GPU timings were too
 * noisy to choose on** — two runs of one build differed by more than two runs of two builds, so
 * the number comes from the arithmetic above rather than from a stopwatch.
 */
const float MAX_FILTER_RADIUS = 0.25;

/**
 * How much of a self-lit surface's glow a lamp's shadow may take.
 *
 * Zero is the old behaviour — emission entirely unshadowed, and bands that float free of
 * the floor when a character's shadow crosses them. One would darken a lamp head because
 * something passed in front of it, which is worse. Just over half reads as an inlay lit
 * from within a deck that is itself in shade.
 */
const float EMISSIVE_SHADOW_SHARE = 0.55;

/*
 * Trowbridge-Reitz, because the width of a highlight is the whole effect.
 *
 * The pow() lobe this replaces is tight and short-tailed: it makes a small round dot and
 * nothing else, however hard it is driven. A real rough surface seen at a grazing angle
 * smears a light along the view direction, and that smear is the long tail GGX has and
 * Blinn-Phong does not. It is the difference between a floor that looks pale and a floor
 * that looks polished, and no amount of intensity crosses it.
 *
 * Normalised to a peak of one, which is the part that took a regression to get right.
 * The distribution's own normalisation puts its peak at 1/(pi*a^2) so that it integrates
 * to unity over the hemisphere, which is what a BRDF wants and not what this term is.
 * This is a look control: the specular attribute says how strong a highlight is and
 * roughness says how wide, and the two must not be entangled. Un-normalised they were —
 * at the default roughness the peak came out 52 times the pow() lobe it replaced, so
 * every surface authored before roughness existed went from a soft highlight to a blown
 * white speck, with nothing in the API to say it would.
 *
 * So divide by the peak: a2*a2/(d*d) is D(ndh)/D(1) with the constants cancelled, which
 * is a multiply cheaper than the honest spelling as well.
 */
float specularLobe(float ndh, float roughness) {
  float a = max(roughness * roughness, 1e-3);
  float a2 = a * a;
  float d = ndh * ndh * (a2 - 1.0) + 1.0;
  return (a2 * a2) / max(d * d, 1e-8);
}

/**
 * The same lobe from a source that has a size, rather than from a point.
 *
 * **A light with no size has a reflection with no size**, and a reflection smaller than a
 * fragment cannot be sampled: it lands in some pixels and not the ones beside them. That is the
 * bright speckle a dark glossy surface shows under a close lamp, and no amount of multisampling
 * touches it, because multisampling resolves coverage and this is a value varying inside one
 * triangle. The information to fix it was already in the scene and only the shadow pass was
 * reading it: sourceRadius gave the penumbra its width while the highlight stayed a point.
 *
 * A sphere of radius r at distance d subtends r/d, so that is added to the lobe's own width.
 * The standard representative-point approximation, and the important half is the **energy
 * term**: widening a lobe without it makes the highlight brighter rather than broader, because
 * this distribution peaks at 1 whatever its width. Measured, that mistake took speckle from 893
 * to 3313 on the reproduction. Scaling by (a / a')^2 puts the same energy under the wider curve.
 *
 * A headlight is the case this exists for. It sits closer to a wing than anything else in a
 * scene ever does, so r/d is large and its highlight is genuinely broad.
 */
float sphereLobe(float ndh, float roughness, float sourceRadius, float dist) {
  float a = max(roughness * roughness, 1e-3);
  float widened = clamp(a + sourceRadius / max(2.0 * dist, 1e-3), a, 1.0);
  float energy = (a / widened) * (a / widened);
  float w2 = widened * widened;
  float d = ndh * ndh * (w2 - 1.0) + 1.0;
  return energy * (w2 * w2) / max(d * d, 1e-8);
}

/**
 * The other half of the split-sum approximation: what fraction of an environment a surface returns.
 *
 * The convolution decides *what* a surface reflects at a given roughness; this decides *how much*.
 * Before it the amount was fresnel times one-minus-roughness, which is a curve somebody chose
 * standing in for an integral.
 *
 * Karis's analytic fit to the environment BRDF, so there is **no lookup texture and no texture
 * unit**: a few multiply-adds against roughness and the view angle. x scales the surface's own
 * reflectance at normal incidence and y is the additive grazing term, so a smooth dielectric at
 * f0 0.04 returns about 0.046 head-on and approaches 1 at the edge, which is what a dielectric
 * does. At roughness 1 it returns about 0.016 rather than the zero one-minus-roughness gave, which
 * is the substantive difference: a fully rough dielectric does reflect its surroundings.
 *
 * **It replaces the Fresnel factor as well as the thinning**, because the fit already contains the
 * angular dependence; multiplying by a separate Fresnel term would apply it twice.
 *
 * **How much this is worth was measured, and it is worth less than it looks on a dark room.**
 * On demo/dev/ibl.html?ladder=1 the whole ladder moved by at most 0.2 of 255 when the old term was
 * replaced. That is not the term failing: at high roughness the surface reads the coarsest levels
 * of the chain, and in a room of five dark walls and one bright one those levels are dark, so a
 * weight three times larger against a near-zero radiance is still near zero. It is worth much more
 * against a bright environment, which is what a loaded sky is and what no captured room here is.
 *
 * **A warning about reading that page, paid for once.** The ladder falls about five-fold from
 * mirror to rough, and that reads as energy being lost. It is not: a mirror concentrates the one
 * bright wall into a sharp image and a rough surface averages it against five dark ones, so the
 * falloff is the room's own content. The normalised falloff also happens to track one-minus-
 * roughness closely, which made the old term look like the cause — and removing that term entirely
 * changed nothing, which is what settled it. Perturb before believing a match.
 *
 * **What it costs** is a fit rather than the integral: the published error is around one per cent
 * of the tabulated term, far below what an eight-bit frame can show. **What would make it wrong**
 * is a material model this shader does not have — a clearcoat or a sheen lobe carries its own BRDF
 * and its own integral, and this fit is Trowbridge-Reitz with Smith masking and nothing else.
 */
vec2 envBrdfApprox(float ndv, float roughness) {
  const vec4 c0 = vec4(-1.0, -0.0275, -0.572, 0.022);
  const vec4 c1 = vec4(1.0, 0.0425, 1.04, -0.04);
  vec4 r = roughness * c0 + c1;
  float a004 = min(r.x * r.x, exp2(-9.28 * ndv)) * r.x + r.y;
  return vec2(-1.04, 1.04) * a004 + r.zw;
}

/**
 * How much of a prefiltered environment a surface returns, with the light that bounces more than
 * once inside the microsurface put back.
 *
 * **\`envBrdfApprox\` alone is not energy conserving, and on a metal that is not a subtlety.** The
 * split sum's second half integrates a *single* scattering event, so it silently discards every ray
 * that strikes one microfacet, bounces, and leaves. Roughness scatters light; it does not absorb
 * it — so a surface with \`f0\` 1, a perfect reflector, has to return **everything** at every
 * roughness. \`dfg.x + dfg.y\` returns \`1 - 0.55 * roughness\`: measured 1.000 at roughness 0,
 * 0.725 at 0.5 and 0.450 at 1.0, which asserts that a perfect mirror absorbs 55% of the light if
 * you roughen it.
 *
 * **That shipped, and it was reported from a consumer as metals reading opaque and flat.** Its
 * acceptance measurement — the roughness ladder on \`demo/dev/ibl.html\` — could not have caught
 * it: \`metal\` reaches the shader only through an ORM map, that page binds none, so every rung on
 * it is a dielectric at \`f0\` 0.04 where the same defect is worth about a thousandth of what it is
 * worth on a metal. The instrument measured the one material the term is nearly right for.
 *
 * The compensation is Fdez-Agüera's: the energy the single-scatter integral is missing, returned at
 * the surface's average Fresnel over the hemisphere, summed as a geometric series over repeated
 * bounces. **At \`f0\` 1 it comes back to exactly 1.0 at every roughness** — \`average\` is 1,
 * \`multi\` is \`energy / energy\`, and \`single + missing\` telescopes — so a fully metallic surface
 * returns precisely what it did before the split sum was introduced, and a dielectric gains the
 * small amount it was always owed.
 *
 * **No divide guard, because the denominator cannot reach zero here.** \`missing\` is at most 0.55
 * and \`average\` at most 1, so \`1 - missing * average\` bottoms out at 0.45 — at \`f0\` 1 and
 * roughness 1, the worst case in both variables at once.
 *
 * **What it gives up:** the multiply-scattered share is returned against the *prefiltered radiance*
 * rather than against the irradiance the paper uses, because this expression has one environment
 * value and not two. The two converge exactly where the term is large — the coarsest level of a
 * prefiltered chain is nearly the average of the environment — and where they differ, at low
 * roughness, \`missing\` is near zero and the choice cannot show. **What would make it wrong** is a
 * surface model with a second lobe: a clearcoat or a sheen carries its own integral and its own
 * missing energy, and neither is this.
 */
float envSpecularEnergy(float f0, vec2 dfg) {
  float single = f0 * dfg.x + dfg.y;
  float energy = dfg.x + dfg.y;
  float missing = 1.0 - energy;
  float average = f0 + (1.0 - f0) / 21.0;
  float multi = single * average / (1.0 - missing * average);
  return single + multi * missing;
}

/**
 * The irradiance a Lambertian surface receives from a quadrilateral emitter, exactly, **signed**.
 *
 * **This is not an approximation of the diffuse term, it is the diffuse term.** The cosine-weighted
 * integral over a polygon has a closed form — the sum over edges of the angle each subtends times
 * how much the plane it spans faces the surface — and it is the same expression a linearly
 * transformed cosine reduces to when its matrix is the identity, which is exactly what a Lambertian
 * lobe is. An implementation that fits an LTC matrix computes the same number for this half; the
 * fit is only doing work for the specular half.
 *
 * **The sign is which side of the emitter the surface is on, and that is the whole of one-sidedness.**
 * With the corners wound so a surface on the emitting side sees them counter-clockwise, this comes
 * back positive there and negative behind — measured: +0.09443 under a 3.2 by 1.0 panel three
 * metres up, and −0.09443 the same distance above it. So a one-sided light is \`max(0, form)\` and a
 * two-sided one is \`abs(form)\`, and neither needs a separate facing test.
 *
 * **That is better than the test it replaces**, which compared the emitter's normal against the
 * direction to the shaded point — a decision about the rectangle's *centre* applied to a whole
 * fragment. The sign is exact per fragment, so a surface level with the emitter's plane fades
 * through zero rather than switching.
 *
 * **The winding is the thing to get wrong**, and it was wrong first: corners in the natural order
 * \`-r-u, +r-u, +r+u, -r+u\` wind the other way seen from the emitting side, so every surface got a
 * negative form factor, every one-sided light clamped it to zero, and the frame was black with
 * nothing to point at.
 *
 * **Clipped to the horizon.** A polygon partly below the surface must contribute only the part
 * above it, and corners below the tangent plane are projected onto it rather than dropped —
 * dropping one leaves the polygon open and the sum meaningless.
 *
 * **What it costs** is four normalisations, four cross products and four inverse cosines, about the
 * same as one shadow tap. **What would make it wrong** is a non-planar quadrilateral: the form
 * factor is defined for a planar polygon, and four corners off-plane describe no surface at all.
 * Nothing checks that, because the check costs as much as the term — \`selectAreaLights\`
 * orthogonalises the axes on the way in so a caller cannot easily produce one.
 */
float quadFormFactor(vec3 n, vec3 p, vec3 c0, vec3 c1, vec3 c2, vec3 c3) {
  vec3 v0 = c0 - p;
  vec3 v1 = c1 - p;
  vec3 v2 = c2 - p;
  vec3 v3 = c3 - p;

  float d0 = dot(v0, n);
  float d1 = dot(v1, n);
  float d2 = dot(v2, n);
  float d3 = dot(v3, n);
  if (d0 < 0.0 && d1 < 0.0 && d2 < 0.0 && d3 < 0.0) return 0.0;
  v0 -= n * min(d0, 0.0);
  v1 -= n * min(d1, 0.0);
  v2 -= n * min(d2, 0.0);
  v3 -= n * min(d3, 0.0);

  vec3 u0 = normalize(v0);
  vec3 u1 = normalize(v1);
  vec3 u2 = normalize(v2);
  vec3 u3 = normalize(v3);

  float sum = 0.0;
  sum += acos(clamp(dot(u0, u1), -1.0, 1.0)) * dot(normalize(cross(u0, u1)), n);
  sum += acos(clamp(dot(u1, u2), -1.0, 1.0)) * dot(normalize(cross(u1, u2)), n);
  sum += acos(clamp(dot(u2, u3), -1.0, 1.0)) * dot(normalize(cross(u2, u3)), n);
  sum += acos(clamp(dot(u3, u0), -1.0, 1.0)) * dot(normalize(cross(u3, u0)), n);

  /* Two pi rather than pi: the sum is twice the projected solid angle. Signed; see above. */
  return sum / (2.0 * 3.14159265359);
}

/**
 * The fraction of a surface's specular lobe that a rectangle covers.
 *
 * **This is the specular half of an area light, and it replaces a representative point that was
 * measured wrong by 90% to 100% on a smooth surface.** The old term handed the closest point on the
 * rectangle to \`sphereLobe\` and multiplied by the rectangle's *diffuse* form factor: on polished
 * metal facing a softbox it returned 0.000233 where the integral is 0.9207, and head-on on a rough
 * surface it was 3.7 times too bright. \`scripts/areaSpecular.mjs\` is that measurement and the one
 * below.
 *
 * **A linearly transformed cosine with an analytic matrix rather than a fitted one.** The idea an
 * LTC rests on is that the clamped-cosine integral over a polygon has a closed form, so if you can
 * map the specular lobe onto a clamped cosine you can integrate the lobe over the polygon by
 * transforming the polygon instead. A fitted LTC stores that map in tables; this builds it: an
 * orthonormal frame on the lobe's direction, scaled across it by the lobe's width. **So there is no
 * table, no polynomial and no texture unit** — \`quadFormFactor\` above does the integral, and it
 * already clips to the horizon, which in this space is the transformed cosine's own horizon.
 *
 * **Both numbers in it were measured rather than chosen**, in \`areaSpecular.mjs\`:
 *
 * - **Where the lobe points.** The mirror ray only while the surface is smooth; at roughness 1 the
 *   lobe is broad and leans back toward the normal. Framing on the mirror ray instead is worth 213%
 *   against 42% on a rectangle the surface is reflecting. The interpolation below agrees with the
 *   lobe's sampled direction to within a per cent.
 * - **How wide it is.** Fitting one isotropic scale per grid entry against the lobe lands at
 *   \`2 * alpha\` for alpha up to about a quarter and \`1.15 * alpha\` at alpha 1.
 *
 * **What it costs**: one \`quadFormFactor\`, a normalise and a cross product for the frame, and four
 * transformed corners. The old term cost a ray-plane intersection, a \`sphereLobe\` and its own
 * \`quadFormFactor\` call, so this is close to a wash and is not why it changed.
 *
 * **What is left in it** is the anisotropy an isotropic scale cannot carry: a real lobe stretches
 * along the view at grazing angles and this one stays round, which is what a fitted matrix's shear
 * terms are for. Worst 40.1% against the integral where the light is what the surface reflects, and
 * 79.0% for a rectangle overhead, against 287% for the term it replaces.
 */
float quadCoverage(
  vec3 n,
  vec3 p,
  vec3 toEye,
  float roughness,
  vec3 c0,
  vec3 c1,
  vec3 c2,
  vec3 c3
) {
  float alpha = clamp(roughness * roughness, 1e-3, 1.0);

  float lean = (1.0 - alpha) * (sqrt(1.0 - alpha) + alpha);
  vec3 axis = normalize(mix(n, reflect(-toEye, n), lean));

  /*
   * Any orthonormal pair across the axis will do, because the scaling is isotropic in both — so
   * this picks a helper that cannot be parallel to the axis rather than branching on which one is.
   *
   * **The first axis is across the view plane, and that costs nothing today and is load-bearing
   * later.** With an isotropic scale the two tangents are interchangeable — the transformed corners
   * differ by a rotation about \`axis\`, and the form factor about that axis is rotation-invariant,
   * so any pair draws the same picture. A *fitted* matrix has shear terms coupling the first axis
   * to the third, and those are only meaningful in the frame they were fitted in:
   * \`scripts/ltcFit.mjs\` builds \`normalize(n x d)\`, so this does too, and a table dropped in later
   * lands in the frame it was measured in rather than in an arbitrary one.
   *
   * \`cross(n, axis)\` degenerates exactly where the lobe points along the normal, which is normal
   * incidence — and there the lobe is rotationally symmetric, so the frame genuinely is arbitrary
   * and the helper below is the right answer rather than a fallback. Chosen branchlessly, because
   * this sits in the largest shader in the engine and a branch here is a branch per rectangle.
   */
  vec3 across = cross(n, axis);
  vec3 helper = mix(vec3(1.0, 0.0, 0.0), vec3(0.0, 1.0, 0.0), step(0.9, abs(axis.x)));
  vec3 tangent = normalize(mix(cross(helper, axis), across, step(1e-4, length(across))));
  vec3 bitangent = cross(axis, tangent);

  float inverseScale = 1.0 / max(alpha * (1.15 + 0.85 * (1.0 - alpha)), 1e-4);

  vec3 d0 = c0 - p;
  vec3 d1 = c1 - p;
  vec3 d2 = c2 - p;
  vec3 d3 = c3 - p;
  vec3 l0 = vec3(dot(d0, tangent) * inverseScale, dot(d0, bitangent) * inverseScale, dot(d0, axis));
  vec3 l1 = vec3(dot(d1, tangent) * inverseScale, dot(d1, bitangent) * inverseScale, dot(d1, axis));
  vec3 l2 = vec3(dot(d2, tangent) * inverseScale, dot(d2, bitangent) * inverseScale, dot(d2, axis));
  vec3 l3 = vec3(dot(d3, tangent) * inverseScale, dot(d3, bitangent) * inverseScale, dot(d3, axis));

  /*
   * The magnitude, not the signed value: the frame above is built from a helper vector, so whether
   * the transformed corners wind one way or the other about the axis depends on which helper the
   * step chose. Sidedness is already settled before this is called — \`main.ts\` skips a rectangle
   * whose signed diffuse form factor is not positive.
   */
  return abs(quadFormFactor(vec3(0.0, 0.0, 1.0), vec3(0.0), l0, l1, l2, l3));
}


/**
 * Procedural grain: how fine it is, and how far it swings the surface either way.
 *
 * 26 cycles per metre puts several across a hand-sized facet, which is the scale mineral
 * grain actually reads at.
 *
 * **The swing was 0.8 to 1.16 and that is 18% either side, which is far too much.** It was
 * documented as a surface being slightly uneven and it read as *veining*: a pattern with
 * structure, which is what marble has and sandstone does not. Reported as the papyrus
 * columns looking like marble even once grain became a property they legitimately declare.
 * 6% is unevenness. Past about 10% the eye starts reading figure rather than surface.
 *
 * **And one frequency is one material.** A single scale across a column, a floor tile and a
 * cliff makes them all the same stone seen at three sizes, because a repeated frequency is
 * exactly what the eye uses to judge what something is made of. A second, much coarser
 * octave mixed in gives the pattern structure at two sizes at once, which is what real
 * stone has: fine crystal grain inside broader mottling. It costs one more noise evaluation
 * inside a branch almost nothing takes.
 */
const float GRAIN_SCALE = 26.0;
const float GRAIN_COARSE_SCALE = 4.5;
const float GRAIN_COARSE_MIX = 0.45;
const float GRAIN_FLOOR = 0.94;
const float GRAIN_CEIL = 1.06;


/**
 * Nudge a cube direction to stay inside the face it already belongs to.
 *
 * Every component except the dominant one is clamped to a fraction of the
 * dominant magnitude, which is exactly the condition for "this direction is
 * inside that face". The dominant component is restored untouched, so the face
 * choice itself never changes.
 */
#if POINT_SHADOWS`;
