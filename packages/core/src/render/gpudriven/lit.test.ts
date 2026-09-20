import { expect, test } from 'vitest';

import { EMISSIVE_SHADOW_SHARE, LOBES_GLSL } from '../shaders/flat/lobes.ts';
import { HEMISPHERIC, litColour, newLitColour, specularLobe } from './lit.ts';

import type { LitEnvironment, LitSurface } from './lit.ts';

/**
 * **What this file is for: the second pipeline's lit expression had no reference at all.**
 *
 * `shadeBins.ts` is the reference for the *reconstruction* — the screen vertices, the
 * perspective-correct weights and their gradients — and `gpu-parity.mjs` runs it against
 * `SHADE_SURFACE_WGSL` over generated triangles. The shading pass's own header says why that is
 * the part worth checking: the interpolation is the only part that differs between the pipelines,
 * so it is the only part that can drift.
 *
 * That was true while the lit expression was four lines. It is not a reason for the expression to
 * have **no** reference, and it did not: nothing in the tree computed what the shader computes, so
 * nothing could disagree with it. The forward path's own lit expression is GLSL and cannot be
 * compared to WGSL by reading. This is the twin, and `gpu-parity.mjs` runs both.
 */

const ENVIRONMENT: LitEnvironment = {
  lightDir: [0, 1, 0],
  lightColour: [1, 0.9, 0.8],
  sky: [0.3, 0.4, 0.6],
  ground: [0.1, 0.09, 0.08],
};

function surface(overrides: Partial<LitSurface> = {}): LitSurface {
  return {
    albedo: [0.5, 0.5, 0.5],
    normal: [0, 1, 0],
    toEye: [0, 0, 1],
    roughness: 0.5,
    specular: 0,
    emissive: 0,
    ...overrides,
  };
}

test('THE HEMISPHERIC AMBIENT IS THE FORWARD PATH’S, term for term', () => {
  /*
   * `mix(ground, sky, n.y * 0.5 + 0.5)` — a normal straight up takes the sky, straight down takes
   * the ground, and level takes half of each. Two pipelines disagreeing about that is two
   * pipelines lighting the same scene differently with nothing on screen saying which is right.
   */
  expect(HEMISPHERIC(1)).toBe(1);
  expect(HEMISPHERIC(-1)).toBe(0);
  expect(HEMISPHERIC(0)).toBe(0.5);

  const out = newLitColour();
  /* Facing straight down, in the dark: the ground colour times the albedo and nothing else. */
  litColour(surface({ normal: [0, -1, 0] }), ENVIRONMENT, out);
  expect(out[0]).toBeCloseTo(0.5 * 0.1, 6);
  expect(out[2]).toBeCloseTo(0.5 * 0.08, 6);
});

test('the diffuse term is the cosine, clamped at the horizon', () => {
  const out = newLitColour();
  litColour(surface(), ENVIRONMENT, out);
  /* Straight at the light: albedo * (colour * 1 + sky). */
  expect(out[0]).toBeCloseTo(0.5 * (1 + 0.3), 6);

  /* Turned away from it: no negative light, which is the clamp rather than an accident. */
  litColour(surface({ normal: [0, -1, 0] }), ENVIRONMENT, out);
  expect(out[0]).toBeCloseTo(0.5 * 0.1, 6);
});

test('THE SPECULAR LOBE IS THE FORWARD PATH’S, and peaks at one however wide it is', () => {
  /*
   * **A distribution that peaks at one is what makes a widened lobe broader rather than brighter**,
   * and `lobes.ts` records paying for the version that did not. Roughness changes the *width*, so
   * the value at the peak has to be the same at every roughness or a rough surface is dimmer for
   * being rough.
   */
  for (const roughness of [0.1, 0.3, 0.7, 1]) {
    expect(specularLobe(1, roughness), `at roughness ${roughness}`).toBeCloseTo(1, 6);
  }

  /*
   * **Below roughness 0.1 as well, which it did not do until 2026-09-20.** `max(d * d, 1e-8)` is
   * there so a mirror does not divide by nothing, and at the peak `d` *is* `a * a` — so once
   * `a * a` fell under 1e-4 the floor took over and the peak fell with it: **0.0039 at roughness
   * 0.05, 256 times dimmer than at 0.1**. A smoother surface got a fainter highlight, which is the
   * opposite of what smoother means. The floor is on `a` now, at `MIN_LOBE_ALPHA`, so the guard
   * protects the division instead of scaling the answer.
   */
  for (const roughness of [0, 0.01, 0.05, 0.09]) {
    expect(specularLobe(1, roughness), `polished, at roughness ${roughness}`).toBeCloseTo(1, 6);
  }

  /*
   * **And it is narrower rather than dimmer**, which is what the floor buys: a fragment away from
   * the peak, a polished surface has fallen off and a satin one has not.
   */
  expect(specularLobe(0.999, 0.05)).toBeLessThan(specularLobe(0.999, 0.3));
  expect(specularLobe(1, 0.1)).toBeCloseTo(1, 6);

  /* And it is narrower when the surface is smoother, which is the whole of what roughness does. */
  const halfAngle = Math.cos(0.15);
  expect(specularLobe(halfAngle, 0.1)).toBeLessThan(specularLobe(halfAngle, 0.6));

  /* The guard on a mirror, so `a` never reaches zero and the quotient never divides by nothing. */
  expect(Number.isFinite(specularLobe(0.2, 0))).toBe(true);
  expect(specularLobe(0.2, 0)).toBeGreaterThanOrEqual(0);
});

test('A HIGHLIGHT APPEARS WHERE THE HALF VECTOR LINES UP, and is the light’s own colour', () => {
  /*
   * The half vector between the light and the eye. A surface whose normal is that half vector is at
   * the peak of the lobe, and what it adds is the light's colour times the surface's specular —
   * **not** times the albedo, because a dielectric's highlight is the colour of the source.
   */
  const light: readonly [number, number, number] = [0, 1, 0];
  const eye: readonly [number, number, number] = [0, 0, 1];
  const halfway = [light[0] + eye[0], light[1] + eye[1], light[2] + eye[2]];
  const length = Math.hypot(halfway[0] as number, halfway[1] as number, halfway[2] as number);
  const aligned: readonly [number, number, number] = [
    (halfway[0] as number) / length,
    (halfway[1] as number) / length,
    (halfway[2] as number) / length,
  ];

  const plain = newLitColour();
  const shiny = newLitColour();
  litColour(surface({ normal: aligned, specular: 0 }), ENVIRONMENT, plain);
  litColour(surface({ normal: aligned, specular: 0.4 }), ENVIRONMENT, shiny);

  const added = [0, 1, 2].map((c) => (shiny[c] as number) - (plain[c] as number));
  /* At the peak the lobe is one, so what was added is exactly `lightColour * specular`. */
  expect(added[0]).toBeCloseTo(1 * 0.4, 5);
  expect(added[1]).toBeCloseTo(0.9 * 0.4, 5);
  expect(added[2]).toBeCloseTo(0.8 * 0.4, 5);
});

test('a surface with no specular has no highlight anywhere', () => {
  /*
   * **The whole term is zero for a world that declares no specular**, which is what keeps this
   * change from moving anything that was drawn before it. A scene whose materials say nothing
   * about shininess renders exactly the frame it rendered when the expression was four lines.
   */
  const out = newLitColour();
  const before = newLitColour();
  for (const normal of [
    [0, 1, 0],
    [0.6, 0.8, 0],
    [0, 0.707, 0.707],
  ] as const) {
    litColour(surface({ normal, specular: 0 }), ENVIRONMENT, out);
    litColour(surface({ normal, specular: 0, roughness: 0.05 }), ENVIRONMENT, before);
    expect(Array.from(out)).toEqual(Array.from(before));
  }
});

test('emissive adds the albedo scaled, which is what the second pipeline already did', () => {
  const out = newLitColour();
  const dark: LitEnvironment = {
    lightDir: [0, 1, 0],
    lightColour: [0, 0, 0],
    sky: [0, 0, 0],
    ground: [0, 0, 0],
  };
  litColour(surface({ albedo: [0.2, 0.4, 0.6], emissive: 2 }), dark, out);
  expect(out[0]).toBeCloseTo(0.4, 6);
  expect(out[1]).toBeCloseTo(0.8, 6);
  expect(out[2]).toBeCloseTo(1.2, 6);
});

test('A GLOW TAKES THE COLOUR ITS MAP GIVES IT, and the albedo where there is none', () => {
  /*
   * **flat/main.ts's `emissiveTint * emissiveMapped`**: what a surface emits is its albedo times an
   * emissive map, and the albedo alone where it binds none. A facade of lit windows is that — a wall
   * whose map is black, glowing nowhere, and a window whose map is white, glowing its own colour.
   */
  const dark: LitEnvironment = {
    lightDir: [0, 1, 0],
    lightColour: [0, 0, 0],
    sky: [0, 0, 0],
    ground: [0, 0, 0],
  };
  const out = newLitColour();
  litColour(
    surface({ albedo: [0.2, 0.4, 0.6], emissive: 2, emissiveColour: [0.2, 0, 0.3] }),
    dark,
    out,
  );
  expect(out[0]).toBeCloseTo(0.4, 6);
  expect(out[1]).toBeCloseTo(0, 6);
  expect(out[2]).toBeCloseTo(0.6, 6);
});

test('AND IT TOUCHES NOTHING BUT THE GLOW', () => {
  /* The sun, the room and the highlight all still read the albedo: a map says where light is
     emitted, not what the surface is made of. */
  const lit = { ...ENVIRONMENT, lightColour: [1, 0.9, 0.8] as [number, number, number] };
  const plain = newLitColour();
  const mapped = newLitColour();
  litColour(surface({ specular: 0.5, emissive: 0 }), lit, plain);
  litColour(surface({ specular: 0.5, emissive: 0, emissiveColour: [1, 0, 0] }), lit, mapped);
  expect(Array.from(mapped)).toEqual(Array.from(plain));
});

test('SHADE TAKES THE SUN AND LEAVES THE ROOM, which is where the forward path puts it', () => {
  /*
   * **`flat/main.ts` multiplies `direct` and the lobe by `sunShade` and the ambient by nothing**,
   * and its comment records what happens when a sky term reaches the ambient as well: an enclosed
   * face is darkened once for having no sun and again for the light it should still have received,
   * and a consumer raised a floor constant to get the contrast back. The second pipeline applies it
   * in the same two places.
   */
  const shiny = surface({ specular: 0.6, roughness: 0.3, emissive: 0.4 });
  const lit = newLitColour();
  const dark = newLitColour();
  litColour(shiny, ENVIRONMENT, lit);
  litColour({ ...shiny, shade: 0 }, ENVIRONMENT, dark);

  /*
   * Fully shadowed keeps the hemispheric fill, loses both direct terms, and keeps the part of the
   * glow a shadow may not take — all of it, until 2026-09-17, which was not the forward path's.
   */
  const albedo = 0.5;
  const ambient = 0.3; /* the sky, for a normal straight up */
  expect(dark[0]).toBeCloseTo(albedo * ambient + albedo * 0.4 * (1 - EMISSIVE_SHADOW_SHARE), 6);
  expect(dark[0]).toBeLessThan(lit[0] as number);
});

test('a surface that says nothing about shade is the frame that already shipped', () => {
  const out = newLitColour();
  const explicit = newLitColour();
  litColour(surface({ specular: 0.4 }), ENVIRONMENT, out);
  litColour(surface({ specular: 0.4, shade: 1 }), ENVIRONMENT, explicit);
  expect(Array.from(out)).toEqual(Array.from(explicit));
});

test('half shade is half of the direct light rather than half of the pixel', () => {
  const shiny = surface({ specular: 0.6, roughness: 0.3 });
  const lit = newLitColour();
  const half = newLitColour();
  const dark = newLitColour();
  litColour(shiny, ENVIRONMENT, lit);
  litColour({ ...shiny, shade: 0.5 }, ENVIRONMENT, half);
  litColour({ ...shiny, shade: 0 }, ENVIRONMENT, dark);
  expect(half[0]).toBeCloseTo(((lit[0] as number) + (dark[0] as number)) * 0.5, 6);
});

test('THE IRRADIANCE REPLACES THE HEMISPHERIC AMBIENT rather than lifting it', () => {
  /*
   * `flat/main.ts` records the version that mixed *toward* a coarse level and what it cost — a
   * night courtyard rendered black, because a box-filtered level three below the coarsest is a
   * sample of the room rather than an integral over it. This is the integral, and it replaces the
   * gradient where a caller supplies one: `mix(ambient, irradiance, amount)`.
   */
  const out = newLitColour();
  const room: LitEnvironment = { ...ENVIRONMENT, irradiance: [0.8, 0.1, 0.1] };
  litColour(surface({ normal: [0, 1, 0] }), { ...room, irradianceAmount: 1 }, out);
  /* Facing up, in a room that is red: albedo times the irradiance, plus the sun. */
  const albedo = 0.5;
  expect(out[0]).toBeCloseTo(albedo * (1 * 1 + 0.8), 6);

  const half = newLitColour();
  litColour(surface({ normal: [0, 1, 0] }), { ...room, irradianceAmount: 0.5 }, half);
  const none = newLitColour();
  litColour(surface({ normal: [0, 1, 0] }), room, none);
  expect(half[0]).toBeCloseTo(((out[0] as number) + (none[0] as number)) / 2, 6);
});

test('a scene that supplies no room keeps the gradient it set', () => {
  const out = newLitColour();
  const explicit = newLitColour();
  litColour(surface(), ENVIRONMENT, out);
  litColour(
    surface(),
    { ...ENVIRONMENT, irradiance: [9, 9, 9], radianceAmount: 1, irradianceAmount: 0 },
    explicit,
  );
  expect(Array.from(out)).toEqual(Array.from(explicit));
});

test('what a surface reflects is mixed over what it is lit by, by the weight', () => {
  const room: LitEnvironment = {
    ...ENVIRONMENT,
    radiance: [1, 0, 0],
    radianceAmount: 1,
    prefiltered: 1,
  };
  const matte = newLitColour();
  const shiny = newLitColour();
  litColour(surface({ roughness: 0.2 }), room, matte);
  litColour(surface({ roughness: 0.2, reflectivity: 1 }), room, shiny);
  /* The red room reaches a surface that reflects and does not reach one that does not. */
  expect(shiny[0]).toBeGreaterThan(matte[0] as number);
  expect(shiny[1]).toBeLessThan(matte[1] as number);
});

test('a material that asks for no reflection is the frame that already shipped', () => {
  const out = newLitColour();
  const loud = newLitColour();
  litColour(surface({ specular: 0.4 }), ENVIRONMENT, out);
  litColour(
    surface({ specular: 0.4 }),
    { ...ENVIRONMENT, radiance: [12, 12, 12], radianceAmount: 1, prefiltered: 1 },
    loud,
  );
  expect(Array.from(out)).toEqual(Array.from(loud));
});

test('A DIELECTRIC’S HIGHLIGHT IS DIMMED BY WHAT IT REFLECTS, and a metal’s is not', () => {
  /*
   * **This test asserted the opposite until 2026-09-17, and the reason it gave was the forward
   * path's reason for the other half of the same line.**
   *
   * `flat/main.ts` adds the sun's highlight twice: `lit += sunHighlight * (1 - metal)` *before* the
   * environment blend and `lit += sunHighlight * metal` *after* it. Its comment on the second is
   * explicit about why the first must not move — a dielectric's blend weight reaches most of the
   * way to 1 at a grazing angle, and taking a lobe that was correctly dimmed by the surface's own
   * reflectance and putting it back at full strength is "a white blob where there was none" on a
   * near-black glass lens carrying `specular` 1. The metal half is the repair: on a metal the blend
   * reaches 1, so a highlight left underneath is multiplied by exactly zero and the surface with
   * the most reason to show a specular streak is the one guaranteed not to.
   *
   * This file had both halves on the outside and cited the metal argument for it. Nothing caught
   * it, because no material in any rig carries a `specular` **and** a `reflectivity` — §3 row 85.
   *
   * **At a weight of one, which is what makes this able to fail.** Below it the two orders differ
   * by `1 - weight`, a few per cent either way. A reflectivity of 30 is what drives the clamped
   * weight to one; no material would ask for that and the point is the arithmetic.
   */
  const room: LitEnvironment = {
    ...ENVIRONMENT,
    radiance: [0.2, 0.2, 0.2],
    radianceAmount: 1,
    prefiltered: 1,
  };
  /* The eye on the light's own axis, so the lobe is at its peak and a highlight is worth seeing. */
  const aimed = { roughness: 0.3, reflectivity: 30, toEye: [0, 1, 0] as [number, number, number] };
  const plain = newLitColour();
  const dielectric = newLitColour();
  const metal = newLitColour();
  const metalPlain = newLitColour();
  litColour(surface(aimed), room, plain);
  litColour(surface({ ...aimed, specular: 0.8 }), room, dielectric);
  litColour(surface({ ...aimed, specular: 0.8, metalness: 1 }), room, metal);
  litColour(surface({ ...aimed, metalness: 1 }), room, metalPlain);

  expect(plain[0]).toBeCloseTo(0.2, 6);
  /* Multiplied away entirely, which is what a weight of one does to everything under it. */
  expect(Array.from(dielectric)).toEqual(Array.from(plain));
  /*
   * The metal's is added over the top of its own reflection, so it survives — and **`specular` is
   * not what makes it**, because `mix(specular, albedo, 1)` is the albedo: a metal's highlight
   * colour is its own whatever the material's dielectric reflectance says. Both metals carry one,
   * and what these two lines assert is that it sits on the outside of the blend, where a weight of
   * one cannot reach it. The reflection alone would be `0.2 * albedo`.
   */
  expect(metal[0]).toBeGreaterThan(0.2 * 0.5);
  expect(metalPlain[0]).toBeGreaterThan(0.2 * 0.5);
});

test('A METAL IS NOTHING BUT ITS REFLECTION, and the sun does not reach it at all', () => {
  /*
   * **A metal's environment weight is exactly 1 at every angle and every roughness**, which follows
   * from the two lines `ibl.ts` carries rather than from a choice made here: its `f0` is 1, so
   * Schlick's `mix(f0, 1, ...)` is 1 wherever you stand, and the amount is `max(reflectivity,
   * metal)`. So the blend replaces everything underneath and a fully metallic surface is its
   * reflection through its own albedo — the diffuse, the ambient and the direct term are all gone.
   *
   * `flat/main.ts` keeps an ambient floor in the same expression and that floor is what stops an
   * *intermediate* metalness going dark; at 1 it is multiplied away there too. The test below this
   * one is the one that sees it.
   *
   * The second assertion is the sharper half: turn the sun off entirely and nothing moves.
   */
  const room: LitEnvironment = {
    ...ENVIRONMENT,
    radiance: [0.8, 0.5, 0.2],
    radianceAmount: 1,
    prefiltered: 1,
  };
  const metal = newLitColour();
  const unlit = newLitColour();
  litColour(surface({ metalness: 1, albedo: [1, 0.5, 0.25] }), room, metal);
  litColour(
    surface({ metalness: 1, albedo: [1, 0.5, 0.25] }),
    { ...room, lightColour: [0, 0, 0] },
    unlit,
  );

  /* With the sun off there is nothing left but the reflection, through the albedo. */
  expect(unlit[0]).toBeCloseTo(0.8, 5);
  expect(unlit[1]).toBeCloseTo(0.25, 5);
  expect(unlit[2]).toBeCloseTo(0.05, 5);
  /*
   * And with the sun on, the only thing it adds is the highlight. Its *diffuse* never arrives: the
   * direct term is multiplied by `1 - metal` and whatever is left of it is replaced by a blend at
   * weight 1. What survives is the lobe, on the outside.
   */
  for (let channel = 0; channel < 3; channel += 1) {
    expect(metal[channel], `channel ${channel}`).toBeGreaterThan(unlit[channel] as number);
  }
});

test('A PART-WAY METAL TAKES LESS DIRECT LIGHT THAN EITHER END OF THE RANGE', () => {
  /*
   * **The only assertion that sees `1 - metal` on the direct diffuse**, and finding it took a
   * perturbation: a monotonic version of this test passed with the factor deleted, because the
   * environment weight rises with metalness and drags the total down on its own.
   *
   * The configuration is chosen so the two ends agree. At roughness 1 the lobe is exactly 1, and
   * with the eye on the light's own axis the Schlick edge term is zero — so a metal's highlight is
   * `albedo` and a dielectric's diffuse is `albedo`, and both ends receive the same direct light.
   * In between, the diffuse is leaving at `1 - metal` while the blend that replaces it is only part
   * way up, and the surface is **darker than either end**. Remove the factor and the middle comes
   * out *brighter* than both instead, which is the shape of the failure rather than its size.
   *
   * `flat/main.ts` writes the same term as one line and describes the two it stands for: a metal's
   * reduced diffuse, plus the ambient floor that stops a rough one going black. Their two ambient
   * shares sum to the ambient exactly, which is why only one line is needed.
   */
  const dark: LitEnvironment = {
    ...ENVIRONMENT,
    lightColour: [1, 1, 1],
    radiance: [0, 0, 0],
    radianceAmount: 1,
  };
  const out = newLitColour();
  const sun = (metalness: number): number => {
    const lit = surface({ metalness, roughness: 1, specular: 0, toEye: [0, 1, 0] });
    litColour(lit, dark, out);
    const on = out[0] as number;
    litColour(lit, { ...dark, lightColour: [0, 0, 0] }, out);
    return on - (out[0] as number);
  };

  /* Both ends: the dielectric's whole diffuse, and the metal's whole highlight. */
  expect(sun(0)).toBeCloseTo(0.5, 5);
  expect(sun(1)).toBeCloseTo(0.5, 5);
  /* And the middle is below them, rather than above. */
  expect(sun(0.5)).toBeLessThan(0.45);
  expect(sun(0.25)).toBeLessThan(sun(0));
  expect(sun(0.75)).toBeLessThan(sun(1));
});

test('A METAL’S HIGHLIGHT TAKES ITS OWN COLOUR, which is why gold is not beige plastic', () => {
  /*
   * The single most visible thing metalness does. `specColor` runs from the surface's own
   * dielectric reflectance to its albedo, so a white lamp on gold leaves a gold highlight — and on
   * a dielectric it leaves a white one, which is the case this pipeline already had.
   */
  const gold: Partial<LitSurface> = {
    albedo: [1, 0.76, 0.33],
    roughness: 0.2,
    specular: 0.5,
    normal: [0, 1, 0],
    toEye: [0, 1, 0],
  };
  const white = newLitColour();
  const metal = newLitColour();
  litColour(surface({ ...gold, metalness: 0 }), ENVIRONMENT, white);
  litColour(surface({ ...gold, metalness: 1 }), ENVIRONMENT, metal);

  /* The dielectric's highlight is the light's colour, so its blue share is the light's. */
  const dielectricTint = (white[2] as number) / (white[0] as number);
  const metalTint = (metal[2] as number) / (metal[0] as number);
  expect(metalTint).toBeLessThan(dielectricTint);
});

test('AND IT GOES WHITE AT A GRAZING ANGLE, which is most of what reads as polished', () => {
  /*
   * Schlick says reflectance climbs to 1 at the edge whatever the material is, so a red metal shows
   * a red highlight face-on and a **white** one along every panel edge. Without it the highlight is
   * albedo-tinted at every angle and a dark red suit gets a dark red highlight that reads as matte
   * paint however smooth the map says it is. Scaled by metalness, so a dielectric is untouched.
   *
   * **The geometry is the whole difficulty in testing it.** The angle Schlick is taken against here
   * is between the eye and the *half vector*, which bisects the eye and the light — so it is half
   * the angle between them, and `(1 - VoH)^5` is under a four-hundredth for any pair less than
   * ninety degrees apart. A first attempt put the eye near the horizon with the light overhead,
   * measured a whitening of 0.0016, and passed with the term deleted. The light and the eye have to
   * be on **opposite** sides of the surface, near the horizon, which is exactly the geometry a rim
   * highlight is.
   */
  const red: Partial<LitSurface> = {
    albedo: [1, 0.1, 0.1],
    roughness: 0.25,
    specular: 0.5,
    metalness: 1,
    normal: [0, 1, 0],
  };
  const low: LitEnvironment = { ...ENVIRONMENT, lightDir: [0.99, 0.141, 0] };
  const headOn = newLitColour();
  const grazing = newLitColour();
  litColour(surface({ ...red, toEye: [0, 1, 0] }), ENVIRONMENT, headOn);
  litColour(surface({ ...red, toEye: [-0.99, 0.141, 0] }), low, grazing);

  const headOnTint = (headOn[1] as number) / (headOn[0] as number);
  const grazingTint = (grazing[1] as number) / (grazing[0] as number);
  expect(grazingTint).toBeGreaterThan(headOnTint * 1.5);
});

test('WHAT A METAL REFLECTS IS TINTED BY ITS ALBEDO, and a dielectric’s is not', () => {
  /*
   * `mix(vec3(1), albedo, metal)` on the environment: a dielectric reflects the room's own colour
   * and a metal reflects the room through itself, which is the other half of "a metal is nothing
   * but its reflection".
   */
  const room: LitEnvironment = {
    ...ENVIRONMENT,
    radiance: [1, 1, 1],
    radianceAmount: 1,
    prefiltered: 1,
  };
  const dielectric = newLitColour();
  const metal = newLitColour();
  const mirror: Partial<LitSurface> = { albedo: [1, 0.2, 0.2], roughness: 0.05, reflectivity: 30 };
  litColour(surface(mirror), room, dielectric);
  litColour(surface({ ...mirror, metalness: 1 }), room, metal);

  expect(dielectric[0]).toBeCloseTo(dielectric[1] as number, 6);
  expect(metal[0]).toBeCloseTo(1, 4);
  expect(metal[1]).toBeCloseTo(0.2, 4);
});

test('METALNESS ZERO IS WHAT A MATERIAL THAT SAYS NOTHING GETS', () => {
  const said = newLitColour();
  const unsaid = newLitColour();
  const room: LitEnvironment = {
    ...ENVIRONMENT,
    radiance: [0.7, 0.3, 0.9],
    radianceAmount: 1,
    prefiltered: 1,
  };
  for (const overrides of [
    { specular: 0.6, reflectivity: 0.4, roughness: 0.3 },
    { specular: 0, reflectivity: 0, roughness: 1 },
    { specular: 1, reflectivity: 0, roughness: 0.1, shade: 0.5 },
  ]) {
    litColour(surface({ ...overrides, metalness: 0 }), room, said);
    litColour(surface(overrides), room, unsaid);
    expect(Array.from(said), JSON.stringify(overrides)).toEqual(Array.from(unsaid));
  }
});

test('A METAL WITH NO PROBE REFLECTS THE SKY, and a metal is black without that', () => {
  /*
   * **The default that stops a silent disaster.** A metal's environment weight is exactly 1, so a
   * metal reflecting nothing is a metal that renders **black** — and `radiance` is an optional
   * field. `flat/main.ts` reflects the same two-colour gradient the ambient comes from where a
   * scene has no probe, so that is the default here rather than zero, and it is computed inside the
   * expression rather than by the caller because a caller can forget.
   *
   * The second half is the sharper claim: it is the **mirror** direction and not the normal. A
   * surface facing up seen from above reflects straight up and reads the sky; the same surface seen
   * from the side reflects along the horizon and reads the midpoint. Using the normal gives the sky
   * both times, which is a flat wash where a curve should be.
   */
  const unlit: LitEnvironment = { ...ENVIRONMENT, lightColour: [0, 0, 0] };
  const above = newLitColour();
  const side = newLitColour();
  litColour(surface({ metalness: 1, albedo: [1, 1, 1], toEye: [0, 1, 0] }), unlit, above);
  litColour(surface({ metalness: 1, albedo: [1, 1, 1], toEye: [0, 0, 1] }), unlit, side);

  /* Straight up: the mirror direction is the normal, so this is the sky exactly. */
  expect(above[0]).toBeCloseTo(0.3, 5);
  expect(above[2]).toBeCloseTo(0.6, 5);
  /* Along the horizon: halfway between the ground and the sky. */
  expect(side[0]).toBeCloseTo((0.1 + 0.3) / 2, 5);
  expect(side[2]).toBeCloseTo((0.08 + 0.6) / 2, 5);

  /*
   * **And the facing term the mirror direction uses is unclamped**, which is the case a silhouette
   * makes every frame: an interpolated normal turns past the eye, `dot(n, v)` goes negative, and
   * `reflect` follows it. Clamping at zero — the value the Fresnel weight wants, one line below —
   * folds the mirror direction back and reflects the sky where the ground belongs. Here the eye is
   * half a radian behind the surface, so the two spellings answer −0.5 and +0.5.
   */
  const behind = newLitColour();
  litColour(surface({ metalness: 1, albedo: [1, 1, 1], toEye: [0, -0.5, 0.866] }), unlit, behind);
  expect(behind[0]).toBeCloseTo(0.1 + (0.3 - 0.1) * 0.25, 5);
});

test('OCCLUSION SCALES EVERYTHING THE SURFACE RETURNS, which is where flat/main.ts applies it', () => {
  /*
   * `lit *= ormOcclusion`, after the highlight, the reflection and the emissive. Its comment says
   * the ambient-only reading was considered and not taken. A lit, shiny, reflecting, glowing,
   * part-metal surface, so every term is in the product.
   */
  const room: LitEnvironment = {
    ...ENVIRONMENT,
    radiance: [0.6, 0.3, 0.9],
    radianceAmount: 1,
    prefiltered: 1,
  };
  const busy: Partial<LitSurface> = {
    specular: 0.7,
    roughness: 0.3,
    reflectivity: 0.5,
    emissive: 0.4,
    metalness: 0.3,
    toEye: [0, 0.8, 0.6],
  };
  const whole = newLitColour();
  const occluded = newLitColour();
  litColour(surface(busy), room, whole);
  litColour(surface({ ...busy, occlusion: 0.35 }), room, occluded);
  for (let c = 0; c < 3; c += 1) {
    expect(occluded[c]).toBeCloseTo((whole[c] as number) * 0.35, 6);
  }
});

test('a surface that says nothing about occlusion is the frame that already shipped', () => {
  const said = newLitColour();
  const unsaid = newLitColour();
  litColour(surface({ specular: 0.5, occlusion: 1 }), ENVIRONMENT, said);
  litColour(surface({ specular: 0.5 }), ENVIRONMENT, unsaid);
  expect(Array.from(said)).toEqual(Array.from(unsaid));
});

/** What a glowing surface adds over the same surface dark, lane by lane. */
function glow(surfaceOverrides: Partial<LitSurface>, environment: LitEnvironment): number[] {
  const lit = newLitColour();
  const dark = newLitColour();
  litColour(surface({ ...surfaceOverrides, emissive: 0.6 }), environment, lit);
  litColour(surface({ ...surfaceOverrides, emissive: 0 }), environment, dark);
  return [0, 1, 2].map((c) => (lit[c] as number) - (dark[c] as number));
}

test('EMISSION IS THE FRAME’S GAIN TIMES ITS CLOCK, as flat/main.ts scales every glow', () => {
  /*
   * `emissiveTint * uEmissiveGain * vEmissive * uNightFactor * mix(1, shade, share)`. The second
   * pipeline added `albedo * emissive` and nothing else, so a rig lit at noon glowed on it and not
   * on the forward path — which nothing compared until the textured rig's forward reference did.
   */
  const albedo: [number, number, number] = [0.5, 0.25, 0.8];
  const lit = { albedo, occlusion: 0.8 };
  for (const emission of [0, 0.3, 1, 1.7]) {
    const added = glow(lit, { ...ENVIRONMENT, emission });
    for (let c = 0; c < 3; c += 1) {
      expect(added[c]).toBeCloseTo((albedo[c] as number) * 0.6 * emission * 0.8, 6);
    }
  }
  /* At night factor zero nothing glows, which is every rig whose environment says it is day. */
  expect(glow(lit, { ...ENVIRONMENT, emission: 0 })).toEqual([0, 0, 0]);
});

test('A SHADOW TAKES A SHARE OF A GLOW, not all of it, and the share is the forward path’s', () => {
  expect(LOBES_GLSL).toContain(`const float EMISSIVE_SHADOW_SHARE = ${EMISSIVE_SHADOW_SHARE};`);
  const albedo: [number, number, number] = [0.5, 0.25, 0.8];
  for (const shade of [0, 0.4, 1]) {
    const added = glow({ albedo, shade }, ENVIRONMENT);
    const share = 1 + (shade - 1) * EMISSIVE_SHADOW_SHARE;
    for (let c = 0; c < 3; c += 1) {
      expect(added[c]).toBeCloseTo((albedo[c] as number) * 0.6 * share, 6);
    }
  }
  /* Full shade keeps 45% of the glow: a lit inlay in a deck that is itself in shadow. */
  expect(glow({ albedo, shade: 0 }, ENVIRONMENT)[0]).toBeCloseTo(0.5 * 0.6 * 0.45, 6);
});
