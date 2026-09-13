/**
 * Properties of the flat shader that a rewrite must not quietly drop.
 *
 * Crude on purpose. GLSL cannot be executed here, so these read the source — but the
 * failure mode they guard is not a wrong number, it is a *missing term*, and that has
 * now happened twice in this file's history. `a33fb75` rewrote `selectPointLights` and
 * silently removed the range fade `e8cd4ec` had added; the point-light shadow on
 * emissive surfaces was added once and then went unnoticed for months because nothing
 * named it. A term nobody asserts is a term the next rewrite loses.
 *
 * Each of these corresponds to a reported bug and can be traced to the commit
 * that fixed it. If one fails, the question is not "is the string still there" but
 * "did the rewrite keep the behaviour".
 */
import { expect, test } from 'vitest';
import { flatFrag, flatVert } from './flat/index.ts';
import { DEPTH_INSTANCED_VERT, DEPTH_SKINNED_VERT, DEPTH_VERT } from './depth.ts';

/** Everything switched on, which is the variant these behavioural terms belong to. */
const full = flatFrag({
  pointShadows: true,
  directionalShadows: true,
  environmentProbe: true,
  nightEmissive: false,
});

/** Source with runs of whitespace collapsed, so formatting is not the assertion. */
const source = full.replace(/\s+/g, ' ');

/** The vertex stage, collapsed the same way. */
const vertexSource = flatVert({ skinned: false, morphed: false, instanced: false }).replace(
  /\s+/g,
  ' ',
);

test('a light contributes only as much as it is present', () => {
  /*
   * *"these are like on/off"*. Selection fades a light in and out across the budget
   * cut and the edge of view range, and the shader has to honour it or membership is
   * still a switch. Both terms, because they are two different things.
   */
  /* **And a metal takes none of it.** A lamp's diffuse is the one term that was never multiplied
     by `(1 - metal)`, and it is added after the environment blend, so it could not even be dimmed
     by the reflection in front of it: a broad view-independent wash sat on top of every metal in
     every lamp-lit room, which is the definition of matte and is what one read as. */
  expect(source, 'the direct term is weighted, and a metal takes none of it').toContain(
    'lit += albedo * lightColor * ndl * shape * shaded * lightWeight * (1.0 - metal);',
  );
  // `shape` is the falloff curve the profile asked for; squaring belongs to one of them.
  expect(source, 'and the shaped falloff still squares').toContain(
    'uLightFalloff == 1 ? falloff : falloff * falloff',
  );
  expect(source, 'and so is the shading that reaches emissive geometry').toContain(
    'lightShade = min(lightShade, mix(1.0, shaded, lightWeight));',
  );
});

test('a surface texture reaches every lighting term, not just the ambient one', () => {
  /*
   * The failure this protects against is silent and looks like a lighting bug rather
   * than a texturing one: a term left on vColor shades a textured wall as if it were
   * untextured, so the tile pattern is present in ambient and absent in lamplight and
   * nobody suspects the material. Naming the local `albedo` is what makes the mistake
   * possible — vColor is still in scope and still compiles.
   *
   * Asserted as "no lighting term reads vColor" rather than by listing the terms, so a
   * term added later is caught by construction instead of by somebody remembering to
   * extend this list.
   */
  expect(source, 'the texture is sampled once into a single local').toContain(
    'vec4 texel = texture(uAlbedo, vUv);',
  );
  expect(source, 'and multiplied in, not substituted').toContain('albedo *= texel.rgb;');
  /*
   * The cutout has to be tested before the lighting, not after: a fragment that is going
   * to be thrown away should not pay for light it will never contribute. Since the cutout
   * moved ahead of the lighting branch this is a stronger claim than it used to be: it now
   * sits before the branch that decides whether lighting runs *at all*, not merely before
   * the ambient term.
   */
  expect(
    source.indexOf('if (texel.a < uAlbedoCutout) discard;'),
    'the cutout discards before lighting is even decided',
  ).toBeLessThan(source.indexOf('if (uLightingEnabled != 0) {'));
  expect(source.includes('lit += vColor'), 'no lighting term bypasses the texture').toBe(false);
  expect(source.includes('lit = vColor'), 'not even the first one').toBe(false);
});

test('roughness sets the width of a highlight and not its strength', () => {
  /*
   * The lobe is normalised to a peak of one. Trowbridge-Reitz's own normalisation puts its
   * peak at 1/(pi*a^2), which is right for a distribution that has to integrate to unity
   * and wrong for a look control: it ties how *bright* a highlight is to how *wide* it is,
   * so neither `vSpecular` nor `roughness` means what its name says.
   *
   * It shipped un-normalised once. At the default roughness the peak came out 52 times the
   * `pow(ndh, 96)` lobe it replaced, and every surface authored before the attribute
   * existed — every polished prop in the world — went from a soft highlight to a blown
   * white speck, with nothing in the API to say it would.
   */
  expect(source, 'divided by its own peak').toContain('return (a2 * a2) / max(d * d, 1e-8);');
  expect(
    source.includes('3.14159265 * d * d'),
    'and pi is gone, because a normalised lobe cancels it',
  ).toBe(false);
});

test('a translucent draw is covered by its texture, not by its quad', () => {
  /*
   * A decal — a stain, a poster, a sticker — is a texture that is transparent around the
   * mark and partly transparent within it. Both halves matter: the cutout throws away the
   * empty surround, and the alpha that survives it has to reach the output, or the mark
   * blends at a uniform opacity across the whole quad and reads as a rectangle of haze.
   *
   * Costs the opaque world nothing, which is why it can be unconditional: with blending
   * off the alpha channel is never read.
   */
  expect(source, 'the sampled alpha is kept, not only tested').toContain('coverage = texel.a;');
  expect(source, 'and it scales the draw opacity at the output').toContain('uOpacity * coverage');
  expect(source, 'untextured geometry is fully covered').toContain('float coverage = 1.0;');
});

test('an emissive colour replaces the albedo rather than tinting it', () => {
  /*
   * The fallback is the whole compatibility story: geometry that names no colour must
   * shade exactly as it did before the attribute existed, and a negative component is how
   * "none named" is spelled, because black is a colour a surface may legitimately want.
   */
  expect(source).toContain('vec3 emissiveTint = vEmissiveColor.r < 0.0 ? albedo : vEmissiveColor;');
});

test('a glowing surface is shadowed by lamps and by the sky', () => {
  /*
   * *"shadow goes UNDER the courtyard start race lines/bands"*, reported twice. The first
   * fix gave the emissive term `lightShade`, which covers lamps only; the second gave
   * it `sunShade`, because at dusk the bands are lit while the sun is at its longest
   * and at night the moon casts exactly the same way.
   *
   * Losing either half puts a shadow back under a glowing surface.
   */
  expect(source).toContain(
    'lit += emissiveTint * emissiveMapped * uEmissiveGain * vEmissive * uNightFactor * mix(1.0, min(lightShade, sunShade), EMISSIVE_SHADOW_SHARE);',
  );
});

test('the sky shadow reaching emissive geometry keeps every cap', () => {
  /*
   * The caps that stop a low sun throwing shadows the length of the world live inside
   * `shadowFactor`: the low-elevation fade, the per-caster length cap and the frustum
   * edge fades. `sunShade` has to *be* that function's result rather than anything
   * re-derived, or the emissive path grows its own uncapped copy of the shadow.
   */
  expect(source).toContain('float sunShade = shadowFactor(ndl);');
  expect(source, 'and the direct term still uses the same value').toContain(
    'float direct = ndl * sunShade;',
  );
});

test('a cubemap that has just landed is mixed in rather than switched on', () => {
  /*
   * *"also fade in-out in the drastic case, not on/off."* A pool slot changing hands
   * throws its image away, so a re-bake lands whole between two frames under a lamp
   * that has not moved. Every branch of the sampling chain has to take the weight.
   */
  expect(source, 'the static lookup takes the weight').toMatch(
    /occl = mix\(\s*1\.0,\s*pointShadow\(/,
  );
  expect(
    source.match(/occl = pointShadow\(/g),
    'and nothing samples a map at full strength regardless of how present it is',
  ).toBeNull();
  /*
   * **It used to count ten branches and now there is one**, which is the point rather than a
   * loosening. Twelve cubemaps meant twelve declared samplers and a ten-arm chain, because GLSL
   * ES cannot index a sampler array; every arm had to remember the weight and one that forgot
   * would have been a single light popping. One array texture makes the map a layer, so there is
   * one call and nothing left to keep in step.
   */
  expect(
    source.match(/pointShadow\(\s*uPointShadows,/g)?.length,
    'one call for the static map and one for the live one, and no chain',
  ).toBe(2);
});

test('a shining surface takes a highlight from the sun, and only where it is asked for', () => {
  /*
   * The ask behind this: cut-stone props should shine like diamonds. A
   * diamond is specular — the highlight moves as you move, which is the whole reason
   * it reads as a cut stone rather than a lamp. Emissive cannot do it: emissive is
   * flat, viewer-independent, and gated on the night factor.
   *
   * Gated on `vSpecular` rather than applied everywhere, because a world where every
   * box is glossy is a world made of plastic. The attribute defaults to zero, so this
   * term costs the rest of the world one multiply.
   */
  expect(source, 'the highlight is built against the view').toContain(
    'vec3 halfway = normalize(uDirectionalDir + normalize(uCameraPos - vWorldPos));',
  );
  /* `surfaceRoughness` rather than `vRoughness`: a surface's relief widens its own highlight,
     because a normal that wanders cannot hold one narrower than the wander. The parts this
     assertion is actually about are `* specColor` and `* sunShade`.

     `specColor` was `vSpecular` until the ORM map landed. It is `mix(vec3(vSpecular), albedo,
     metal)`, so it is still exactly the attribute wherever no map is bound, and the property this
     test is about — that the highlight takes the sun's own shadow — never moved.

     **It is computed here and added further down**, which is the only part that has changed: the
     environment blend below is a `mix`, so a highlight added before it is scaled by one minus the
     reflection's weight, and on a metal that weight reaches 1 and erased it entirely. The two
     assertions are split to match — that it is built with the sun's shadow, and that it reaches
     `lit` — because the property under test is the shadow, not the line number. */
  expect(source, 'and it is shadowed like any other sunlight').toContain(
    'uDirectionalColor * specularLobe(max(dot(n, halfway), 0.0), surfaceRoughness) * sunSpec * sunShade;',
  );
  /*
   * **Both halves, because the split is the whole point.** A dielectric's share goes in before the
   * environment blend, where that blend dims it by the surface's own reflectance exactly as it
   * always has; a metal's goes in after, because there the blend reaches 1 and would erase it.
   * Adding the whole term after the blend was tried and is what put a white blob on a black glass
   * lens carrying `specular` 1.
   */
  expect(source, 'a dielectric keeps its highlight under the reflection').toContain(
    'lit += sunHighlight * (1.0 - metal);',
  );
  expect(source, 'and a metal keeps its highlight on top of one').toContain(
    'lit += sunHighlight * metal;',
  );
});

test('a polished surface reflects the lamps, not only the sun', () => {
  /*
   * An interior has no dominant directional source, so a specular term that answers only
   * to the sun leaves a waxed floor under a strip light with no highlight at all — and the
   * highlight is most of what says "polished" rather than "pale". Same exponent and the
   * same weight and shadow terms as the sun's, so it cannot outlive the light casting it.
   */
  /* The view direction is hoisted into `toEyeLamp` now, because the Fresnel that whitens a
     metal's highlight at grazing needs it too. Same vector, named once. */
  expect(source, 'the lamp highlight is built against the view').toContain(
    'vec3 toEyeLamp = normalize(uCameraPos - vWorldPos); vec3 lampHalfway = normalize(toLight / max(dist, 1e-4) + toEyeLamp);',
  );
  /* `lampSpec` rather than `vSpecular` since the ORM map: it is that attribute exactly wherever
     no map is bound. What this line asserts is the three terms after it. */
  expect(source, 'and it fades with the light, not independently of it').toContain(
    '* lampSpec * shape * shaded * lightWeight;',
  );
  /*
   * The lobe is GGX rather than a pow(): its long tail is what smears a lamp into a streak
   * on a floor seen at a grazing angle, and a short-tailed lobe makes a round dot however
   * hard it is driven. Width is the effect; brightness is not a substitute for it.
   */
  expect(source, 'the highlight width answers to roughness').toContain(
    'float specularLobe(float ndh, float roughness) {',
  );
  expect(source, 'and no fixed exponent survives').not.toContain('SPECULAR_POWER');
});

test('mineral surfaces get procedural grain, and nothing else pays for it', () => {
  /*
   * What a realistic material needs and flat colour cannot give. There are no
   * textures in this engine and there will not be, so the grain is computed from
   * world position — no upload, no sampler, and it cannot be seen to tile.
   *
   * Two properties matter and neither is obvious from reading the term:
   *
   * *World space, not object space.* A pattern in object space rotates with the mesh,
   * which is exactly how "painted on" looks. In world space the grain stands still and
   * a turning prop moves through it, the way a solid does.
   *
   * *Behind the vGrain branch.* Almost nothing in the world carries the attribute,
   * so the cost is a compare for every other surface. Safe as a non-uniform branch
   * because it contains no texture fetch — see AGENTS.md, 2026-08-07, which is about
   * implicit derivatives rather than branching as such.
   *
   * *The amount is the surface's own, and this is the load-bearing assertion.* It was
   * inferred twice and wrongly twice. Gating on `vSpecular` meant "this is stone" only
   * while stone was the only shiny thing in the world, so an imported car came out sanded.
   * Weighting by `vRoughness` was closer and still a proxy: painted plaster is rough with
   * no grain and polished granite is smooth with plenty, so a painted masonry tower at
   * roughness 0.55 took 55% grain and read as marble. The properties are independent, so
   * no weighting between them can be right, and a regression here would arrive as a
   * plausible-looking re-weighting rather than as an obvious break.
   *
   * *And behind uGrain, which a caller sets.* That survives as the pass-level scale over
   * whatever the geometry stated, for an imported model that states nothing.
   */
  expect(source, 'the grain is gated on the attribute and on the pass').toContain(
    'if (vGrain > 0.0 && uGrain > 0.0) {',
  );
  expect(source, 'and sampled in world space').toContain('grain(vWorldPos * GRAIN_SCALE)');
  expect(source, 'at two scales, so one frequency is not one material').toContain(
    'grain(vWorldPos * GRAIN_COARSE_SCALE)',
  );
  expect(source, 'scaled by the caller and by what the surface declared').toContain(
    'uGrain * vGrain);',
  );
  expect(source, 'and never again derived from roughness').not.toContain('uGrain * vRoughness');
  expect(source, 'with no texture fetch inside the branch').not.toMatch(
    /if \(vGrain > 0\.0 && uGrain > 0\.0\) \{[^}]*texture/,
  );
});

/*
 * The permutation, which is a cost claim rather than a look claim.
 *
 * A profile with shadows off used to compile the whole shadow path anyway — GLSL cannot
 * prove `uPointShadowIndex[k]` is always -1, so nothing was eliminated and every fragment
 * paid for a feature that was switched off. On one RDNA4 part that was enough to fault the
 * GPU outright. What matters is *absence*, and absence is exactly what a rewrite loses
 * quietly, so it is asserted here rather than trusted.
 */
test('a profile with shadows off compiles none of the shadow path', () => {
  const bare = flatFrag({
    pointShadows: false,
    directionalShadows: false,
    environmentProbe: false,
    nightEmissive: false,
  });

  for (const absent of [
    'samplerCube',
    'uPointShadow0',
    'uPointShadow9',
    'uLivePointShadow0',
    'float pointShadow(',
    'uStaticShadowMap',
    'uDynamicShadowMap',
    'float shadowFactor(',
    'DIRECTIONAL_PCF_OFFSETS',
  ]) {
    expect(bare, `${absent} must not survive into a shadowless profile`).not.toContain(absent);
  }

  // And the shading it feeds is still there, unshadowed rather than unlit.
  expect(bare).toContain('lit += albedo * lightColor');
  expect(bare).toContain('float sunShade = 1.0;');
});

test('each half of the shadow path is dropped on its own', () => {
  const pointOnly = flatFrag({
    pointShadows: true,
    directionalShadows: false,
    environmentProbe: false,
    nightEmissive: false,
  });
  expect(pointOnly, 'point shadows kept').toContain('float pointShadow(');
  expect(pointOnly, 'directional dropped').not.toContain('float shadowFactor(');

  const directionalOnly = flatFrag({
    pointShadows: false,
    directionalShadows: true,
    environmentProbe: false,
    nightEmissive: false,
  });
  expect(directionalOnly, 'directional kept').toContain('float shadowFactor(');
  expect(directionalOnly, 'point dropped').not.toContain('float pointShadow(');
});

/*
 * Every uniform this shader declares is written by somebody.
 *
 * The bug this exists for has now happened twice, identically, and cost a day the second
 * time. `uTint` was never written and rendered a whole world black; `uAmbientGround` was
 * never written by the mesh pass and made the ground half of the hemisphere pure black, so
 * every downward-facing surface in every world took an ambient of nothing. Neither is a
 * wrong number — a GL uniform nobody writes is **zero**, silently, with no error and no
 * warning, and the result looks like a lighting decision rather than a missing line.
 *
 * Reading the renderer's source is crude, and it is the only check available: driving
 * `bindMeshPass` needs a real WebGL2 context, and by the time one exists the failure is a
 * dark screenshot nobody can attribute. The allowlist below is uniforms written on paths
 * other than the pass bind — per-draw state and material state — and adding to it should
 * feel like a decision rather than a formality.
 */
test('every uniform the flat shader declares is uploaded somewhere', async () => {
  /* Every module that writes a uniform of this pass. Atmosphere and the shadow sets own
   * their own blocks, so checking the renderer alone would report their uniforms missing. */
  const [rendererSource, ...delegates]: string[] = await Promise.all(
    [
      '../backend/webgl2/renderer.ts?raw',
      '../atmosphere.ts?raw',
      '../pointShadowSystem.ts?raw',
      '../livePointShadowSet.ts?raw',
      '../lightBudget.ts?raw',
    ].map(
      // Vite's `?raw` suffix carries no type declaration; the variable path keeps TS quiet
      // and vitest resolves it at run time.
      async (path) => (await import(/* @vite-ignore */ path)).default as string,
    ),
  );

  /*
   * Scoped to the mesh pass, not to the file. Searching the whole renderer is what let the
   * original bug through: `uAmbientGround` *was* written — by the plume pass, whose shader
   * does not declare it — so a file-wide search reported it covered while the mesh pass
   * shipped a zero. A uniform has to be written by the pass that reads it.
   *
   * **`writeMeshPassState` rather than `bindMeshPass` since 2026-08-25.** The writes moved out of
   * `bindMeshPass` when skinning made a second flat program, because a uniform location belongs to
   * a program and both have to be fed. The scoping argument is unchanged and the method it names
   * is; anchoring on the old name would have found a body with no uniform writes in it and passed
   * every assertion vacuously, which is why the anchor is asserted to exist rather than defaulted.
   */
  const start = (rendererSource ?? '').indexOf('private writeMeshPassState(');
  expect(start, 'writeMeshPassState must be findable').toBeGreaterThan(-1);
  const end = (rendererSource ?? '').indexOf('\n  }\n', start);
  const meshPass = (rendererSource ?? '').slice(start, end);
  /*
   * The light slots are bound by a shared helper now, so their names live in
   * `lightBudget.ts` and the delegate list above would report them covered whether or not
   * this pass ever asks for them. Assert the call itself, or the scoping this whole test
   * exists for is worth nothing for exactly the uniforms it was written after.
   */
  expect(meshPass, 'the mesh pass binds the point lights itself').toContain('bindPointLights(');
  /*
   * The cubemaps are the same story one step later. The pool chooses which light samples which
   * slot — that half is `pointShadowSystem.ts`'s and is shared with the other backend — and the
   * renderer's own `bindPointShadows` turns the answer into texture units and `uniform*v`. So
   * assert the call, and read the binder as part of this pass rather than as a delegate: it is
   * the mesh pass's, it just does not fit inside one method.
   */
  expect(meshPass, 'the mesh pass binds the cubemaps itself').toContain('bindPointShadows(');
  const binderStart = (rendererSource ?? '').indexOf('private bindPointShadows(');
  expect(binderStart, 'bindPointShadows must be findable').toBeGreaterThan(-1);
  const binder = (rendererSource ?? '').slice(
    binderStart,
    (rendererSource ?? '').indexOf('\n  }\n', binderStart),
  );
  /*
   * And the froxel table, on the same reading as the cubemaps: the pass binds it itself, through a
   * method that exists because it does not fit inline rather than because it is somebody else's
   * job. Sliced in rather than exempted, so the four uniforms it writes stay covered by this guard
   * instead of being listed as somebody else's problem.
   */
  expect(meshPass, 'the mesh pass binds the froxel table itself').toContain('this.bindClusters(');
  const clusterStart = (rendererSource ?? '').indexOf('private bindClusters(');
  expect(clusterStart, 'bindClusters must be findable').toBeGreaterThan(-1);
  const clusterBinder = (rendererSource ?? '').slice(
    clusterStart,
    (rendererSource ?? '').indexOf('\n  }\n', clusterStart),
  );
  /*
   * And the photometric atlas, on exactly the same reading as the froxel table: the pass binds it
   * itself through a method that exists because it does not fit inline. Sliced in rather than
   * exempted, so its two uniforms stay covered by this guard instead of becoming somebody else's
   * problem — which is the shape of exemption this test was written after.
   */
  expect(meshPass, 'the mesh pass binds the photometric atlas itself').toContain(
    'this.bindIesAtlas(',
  );
  const iesStart = (rendererSource ?? '').indexOf('private bindIesAtlas(');
  expect(iesStart, 'bindIesAtlas must be findable').toBeGreaterThan(-1);
  const iesBinder = (rendererSource ?? '').slice(
    iesStart,
    (rendererSource ?? '').indexOf('\n  }\n', iesStart),
  );

  const renderer = [meshPass, binder, clusterBinder, iesBinder, ...delegates].join('\n');

  /** Written per draw or per material rather than when the pass is bound. */
  const writtenElsewhere = new Set([
    'uModel', // drawMesh
    'uTint', // drawMesh
    'uOpacity', // drawMesh / bindMeshPass reset
    'uAlbedo', // setSurfaceTexture + bindMeshPass
    'uAlbedoEnabled',
    'uAlbedoCutout',
    'uUvScale',
    /*
     * The material's, written by `setMaterial` rather than by the mesh pass — the same category
     * the albedo entries above are in, and listed for the same reason: this test is scoped to
     * `bindMeshPass` on purpose, because a file-wide search once reported `uAmbientGround`
     * covered by the plume pass while the mesh pass shipped a zero.
     */
    'uNormalMap',
    'uNormalStrength',
    'uOrmMap',
    'uOrmEnabled',
    'uOrmScale',
    /*
     * Written per *pass* rather than per draw or at bind: the order-independent accumulation sets
     * it to one for the whole replay and back to zero after, in `endFrame`. It is in this list for
     * the same reason the material entries above are — the mesh pass is not where it belongs, and
     * a uniform nothing writes is a zero, which for this one is the correct default anyway.
     */
    'uOitWeighted',
  ]);

  const declared = [...full.matchAll(/^uniform\s+(?:highp\s+|lowp\s+|mediump\s+)?\w+\s+(\w+)/gm)]
    .map((m) => m[1])
    .filter((name) => name !== undefined && !writtenElsewhere.has(name));

  const missing = declared.filter(
    (name) => !renderer.includes(`'${name}'`) && !renderer.includes(`'${name}[0]'`),
  );

  expect(missing, `uniforms declared by flat.ts that nothing in renderer.ts writes`).toEqual([]);
});

test('a surface closer to a lamp than its near plane is not shadow-tested', () => {
  /*
   * The near plane says "nothing this close to the source is in the map", and a caller
   * raises it so a fixture does not shadow its own housing. It was applied to casters
   * only, so a receiver inside the same distance was still compared — against a map that,
   * by the caller's own instruction, holds nothing about anything near it.
   *
   * And the comparison was not harmless there: bias scales with distance, so at fifteen
   * centimetres there was almost none, while the disagreement between two cube faces along
   * their shared edge did not shrink at all. The seams won and were drawn as thin lines
   * radiating from under the light — reported on a ceiling with strip lights hung a hand's
   * width below it, as shadows that come and go as the camera moves.
   *
   * The seams are gone with the cubes, and the gate is not: comparing a receiver against a map
   * that holds nothing about anything near it is still wrong, it just fails less loudly now.
   */
  expect(source, 'the receiver distance is gated on the same near plane').toContain(
    'if (dist <= near) return 1.0;',
  );
  /*
   * Before any sampling. A gate after the first fetch would still pay for the lookup it
   * exists to avoid, and the whole point is that there is nothing there to read.
   */
  expect(
    source.indexOf('if (dist <= near) return 1.0;'),
    'and it gates before the map is touched',
  ).toBeLessThan(source.indexOf('textureLod(maps'));
});

test('a perfect reflector is not asked to absorb', () => {
  /*
   * **The split sum's second half integrates one scattering event and drops the rest.** A ray that
   * strikes a microfacet, bounces off a second and leaves is energy the surface returned and
   * `envBrdfApprox` never counted, so `dfg.x + dfg.y` comes to `1 - 0.55 * roughness` — which says
   * that a surface at `f0` 1, a perfect reflector, absorbs 55% of the light once it is roughened.
   * Roughness scatters light. It does not absorb it.
   *
   * Reported from a consumer whose subject is forced fully metallic, as metals reading opaque and
   * flat where they had been reflective. Measured against the term this replaced: 22% of the
   * reflection gone at roughness 0.4, 33% at 0.6, 44% at 0.8.
   *
   * **The acceptance measurement could not have caught it.** `metal` reaches this shader only
   * through an ORM map and `demo/dev/ibl.html` binds none, so every rung of the roughness ladder
   * that signed the term off is a dielectric at `f0` 0.04 — the one material where the defect is
   * worth a thousandth of what it is worth on a metal.
   *
   * Asserted at the call rather than inside `envSpecularEnergy`, because the defect was never in
   * the fit: it was one expression choosing the un-compensated half of it.
   */
  const source = flatFrag({
    pointShadows: false,
    directionalShadows: false,
    environmentProbe: true,
    nightEmissive: false,
  });

  expect(source, 'the weight is the compensated energy').toContain(
    'float integrated = clamp(envSpecularEnergy(f0, dfg) * max(uReflectivity, metal), 0.0, 1.0);',
  );
  /* The exact expression it replaced. Named so that reintroducing it fails here rather than in a
     consumer's picture six weeks later, which is how it was found the first time. */
  expect(source, 'and never the bare single-scatter one').not.toContain(
    'f0 * dfg.x + dfg.y) * max(uReflectivity',
  );
  expect(source, 'the compensation is compiled in beside the fit').toContain(
    'float envSpecularEnergy(',
  );
});

test('the environment sampler exists only when a probe was asked for', () => {
  /*
   * **This is a texture-unit assertion wearing a string assertion's clothes.** The lit pass
   * binds units 0 to 15 and WebGL2 guarantees sixteen, so the probe's `samplerCube` is the
   * seventeenth. A declaration that survived into a profile with no probe would default to unit
   * 0 and share it with a `sampler2D` shadow map, which is two sampler types on one unit: not a
   * wasted fetch but undefined behaviour, for a value the shader was going to discard.
   *
   * The shadowless test above already refuses every `samplerCube`, which covers one corner of
   * this. What it cannot cover is the profile that keeps its shadows and declines a probe, which
   * is every scene that has ever run on this engine.
   */
  const withProbe = flatFrag({
    pointShadows: true,
    directionalShadows: true,
    environmentProbe: true,
    nightEmissive: false,
  });
  expect(withProbe).toContain('uniform highp sampler2DArray uEnvironment');
  expect(withProbe, 'the roughness picks the level').toContain('textureLod(uEnvironment');

  const without = flatFrag({
    pointShadows: true,
    directionalShadows: true,
    environmentProbe: false,
    nightEmissive: false,
  });
  /* Seventeenth *texture* still, though no longer the seventeenth sampler: the fifteen shadow
     bindings share one declaration now. The assertion is unchanged and so is its reason.

     **The sampler, not the prefix.** This read `not.toContain('uEnvironment')`, which is a
     substring of every uniform whose name begins that way — `uEnvironmentGain` is a plain float
     that every variant declares, and it tripped a guard that is about a texture binding. Naming
     the declaration says what the test has always meant and cannot be fooled by a neighbour. */
  expect(without, 'no probe binding where nothing will fill one').not.toContain(
    'sampler2DArray uEnvironment',
  );
  expect(without, 'and nothing samples one').not.toContain('textureLod(uEnvironment');
  /* And the approximation it falls back to is still there, unconditionally. */
  expect(without).toContain('mix(uAmbientGround, uAmbient, mirrored.y * 0.5 + 0.5)');
});

test('the night-side term is cut out of the source unless a consumer asks for it', () => {
  /*
   * The reason this is a compile-time option rather than a uniform left at zero, and the reason
   * it is worth a test rather than a comment: the term names `emissiveTint` and `vEmissive`,
   * which the ordinary emissive line also names, so its presence lets the compiler re-plan the
   * arithmetic they share. Measured on the gilded chamber at a held frame, with the amount at 0
   * and the term compiled in, **109 pixels of 750,080 moved** against the build before it
   * existed, where a shadow tap sat exactly on its boundary and flipped sides.
   *
   * A string is what can be asserted here; the pixels were established by capture. Together they
   * are the whole claim: a consumer that does not want this is charged nothing and sees nothing.
   */
  const off = flatFrag({
    pointShadows: true,
    directionalShadows: true,
    environmentProbe: false,
    nightEmissive: false,
  });
  expect(off, 'no uniform nobody will upload').not.toContain('uNightEmissive');

  const on = flatFrag({
    pointShadows: true,
    directionalShadows: true,
    environmentProbe: false,
    nightEmissive: true,
  });
  expect(on).toContain('uniform float uNightEmissive');
  expect(on, 'and the term reads the night side of the same dot product').toContain(
    'max(-sunDot, 0.0)',
  );
  /* The ordinary emissive line is untouched either way, which is what "added" means here. */
  for (const source of [off, on]) {
    expect(source).toContain(
      'lit += emissiveTint * emissiveMapped * uEmissiveGain * vEmissive * uNightFactor',
    );
  }
});

/*
 * Relief read off the surface texture, and the three properties of it that are not visible from
 * the arithmetic.
 *
 * Every one of these was found by capturing the proof page (`demo/dev/relief.ts`) on both
 * backends rather than by reading the term, and every one is the kind a rewrite drops silently:
 * the picture still has bumps in it and only a two-backend diff says which ones are right.
 */
test('texture relief is centred, gated on the texture, and cannot turn a face inside out', () => {
  /*
   * **Centred, not three.js's forward difference, and this is the load-bearing one.**
   * WebGL2's framebuffer counts y upward and WebGPU's counts it downward, so `dFdy` points the
   * opposite way on the two backends. The construction survives that because `sign(det)` flips
   * with it and cancels — but only if the height difference is exactly antisymmetric in the
   * step, which a forward difference is not wherever the picture curves. Measured before the
   * fix: the y component of the perturbed normal disagreed between backends by a mean of 18 of
   * 255 against 4 for the two components `dFdx` drives. After it, every panel of the proof page
   * is bit-identical across backends. A rewrite back to `h(uv + d) - h(uv)` would look tidier,
   * compile, draw plausible bumps, and quietly break one backend.
   */
  expect(source, 'the x slope is sampled either side of the pen').toContain(
    'surfaceHeight(texture(uAlbedo, vUv + duvdx).rgb) - surfaceHeight(texture(uAlbedo, vUv - duvdx).rgb)',
  );
  expect(source, 'and so is the y slope').toContain(
    'surfaceHeight(texture(uAlbedo, vUv + duvdy).rgb) - surfaceHeight(texture(uAlbedo, vUv - duvdy).rgb)',
  );

  /*
   * **Gated on two uniforms and nothing else.** Both halves matter. The texture flag is what
   * makes geometry with no image pay nothing, and it is also what makes `setSurfaceTexture(null)`
   * clear the relief without a second call. The scale is what keeps every consumer that never
   * asks for this drawing exactly what it drew before. And *uniform* is what makes the
   * derivatives inside legal at all: a varying-dependent branch around `dFdx` is undefined in
   * GLSL and refused outright by WGSL. See `shadowFactor` for the shader that could not be
   * translated until that was obeyed.
   */
  expect(source, 'both conditions are uniforms').toContain(
    'if (uAlbedoEnabled != 0 && uTextureRelief != 0.0) {',
  );

  /*
   * **Bounded.** Past 45° the perturbation is the size of the surface it perturbs: the result
   * swings a long way for a small change in either, which is the fast-varying normal this engine
   * spent a release removing the sparkle from, and it lights a face from behind its own geometry
   * besides. Microscopic relief standing on real geometry is the whole claim of the term.
   */
  expect(source, 'the tilt is capped').toContain('float limit = abs(det) * RELIEF_MAX_TILT;');
  expect(
    source,
    'and the roughness grows with it, as the procedural relief already does',
  ).toContain('abs(uTextureRelief) * RELIEF_ROUGHNESS');
});

/*
 * The frame crosses the stage boundary, and its validity crosses with it.
 *
 * `vertexDefaults.ts` gives a mesh without tangents `[1, 0, 0, 1]` — a *usable* frame rather than a
 * sentinel, because "a zero tangent normalises to a NaN in any shader that eventually reads one,
 * and a NaN in a fragment takes the pixel with it". So the attribute cannot report its own absence
 * and something else has to. That is `uHasTangents`, a per-draw uniform, carried across as a flat
 * varying because a value that is one thing for the whole draw has nothing to interpolate.
 */
test('the tangent frame and its validity both reach the fragment stage', () => {
  expect(vertexSource, 'declared at the location both backends already upload to').toContain(
    'layout(location = 10) in vec4 aTangent;',
  );
  expect(vertexSource, 'passed through rather than consumed in the vertex stage').toContain(
    'out vec4 vTangent;',
  );
  expect(vertexSource, 'flat, because a per-draw flag has nothing to interpolate').toContain(
    'flat out int vHasTangents;',
  );
  expect(vertexSource).toContain('uniform int uHasTangents;');
  expect(source, 'and the fragment stage receives both').toContain('in vec4 vTangent;');
  expect(source).toContain('flat in int vHasTangents;');
});

/*
 * The map is applied before the reliefs, not instead of them.
 *
 * `uRelief` invents structure from noise and `uTextureRelief` reads a height off the albedo's own
 * luminance; both exist because there was no way to author normals. A map is the authored truth
 * about which way the surface faces, and relief is fine structure laid over whatever that is — so
 * the order is fixed, and a map arriving after relief would overwrite the caller's grain rather
 * than carrying it.
 *
 * **Compared on the application sites, not on the names.** `uNormalStrength` is declared in the
 * preamble, which is concatenated first, so an index of the name alone is earlier than everything
 * and the assertion would hold however wrong the order became.
 */
test('a normal map perturbs the shading normal before either relief does', () => {
  const applied = source.indexOf('mix(n, normalize(tbn * mapped)');
  const relief = source.indexOf('float reliefAmount = uRelief * vRelief;');
  expect(applied, 'the map is applied to the shading normal').toBeGreaterThan(-1);
  expect(relief, 'and the procedural relief is still there').toBeGreaterThan(-1);
  expect(applied, 'the map comes first').toBeLessThan(relief);
});

/*
 * The derivative rule, stated mechanically. `AGENTS.md` 2026-08-07: a derivative may only be taken
 * under uniform control flow, and WGSL refuses the module outright rather than leaving it
 * undefined. `uNormalStrength` is a uniform and `vHasTangents` is a varying — flat, but a compiler
 * cannot prove a varying uniform.
 *
 * **The two halves are asserted separately, because the chunk order makes a positional test a
 * lie.** `tangentFrame` is concatenated *before* `main`, so its `dFdx` is earlier in the source
 * than the gate whatever the code does. What is true and worth pinning is that the function is
 * only *called* under the uniform gate, and that inside it the varying selects rather than
 * branches.
 */
test('the frame is only built under a uniform gate', () => {
  const gate = source.indexOf('if (uNormalStrength > 0.0)');
  expect(gate, 'the block is gated on the uniform').toBeGreaterThan(-1);
  expect(
    source.indexOf('tangentFrame(n,', gate),
    'and the frame is built inside it',
  ).toBeGreaterThan(gate);
});

test('the varying selects between two frames rather than branching on one', () => {
  expect(source, 'a ternary, so no derivative sits under a varying').toContain(
    'hasTangents != 0 ? attrT : derivedT',
  );
  expect(source, 'and nothing branches on it').not.toContain('if (hasTangents');
});

/*
 * The UVs are scaled once. `FLAT_VERT` already does `vUv = aUv * uUvScale`, so a fragment that
 * multiplied again would tile the normal map at the square of the material's density — visible
 * only on a material whose scale is not 1, which is most of them and none of the defaults.
 */
test('the normal map reads the UVs the vertex stage already scaled', () => {
  expect(source).toContain('texture(uNormalMap, vUv)');
  expect(source, 'not scaled twice').not.toContain('texture(uNormalMap, vUv * uUvScale)');
});

/*
 * The sample sits outside the lighting branch, beside albedo's, because occlusion applies to an
 * unlit draw too — `uLightingEnabled` at 0 is `meshBasicMaterial` and a baked crevice is still a
 * crevice. Its own branch is on a uniform, which is what makes the implicit derivative in
 * `texture()` legal here exactly as it is legal for `uAlbedo`.
 */
test('the ORM map is sampled under a uniform branch, before lighting is decided', () => {
  expect(source).toContain('if (uOrmEnabled != 0) {');
  expect(source).toContain('texture(uOrmMap, vUv)');
  expect(source, 'not scaled twice — FLAT_VERT already does vUv = aUv * uUvScale').not.toContain(
    'texture(uOrmMap, vUv * uUvScale)',
  );
  const sampledAt = source.indexOf('texture(uOrmMap, vUv)');
  const lightingAt = source.indexOf('if (uLightingEnabled != 0) {');
  expect(sampledAt).toBeGreaterThan(0);
  expect(sampledAt, 'sampled before the lighting branch opens').toBeLessThan(lightingAt);
});

/*
 * glTF defines occlusion strength as `1 + strength * (texel - 1)`, which is a mix from 1 and not a
 * multiply. A multiply at strength 0 means fully occluded, which is the opposite of what the
 * parameter says, and the sort of inversion that reads as a lighting bug for a week.
 */
test('occlusion mixes from one where roughness and metallic scale', () => {
  expect(source).toContain('mix(1.0, t.r, uOrmScale.r)');
  expect(source).toContain('clamp(t.g * uOrmScale.g, 0.0, 1.0)');
  expect(source).toContain('clamp(t.b * uOrmScale.b, 0.0, 1.0)');
});

/*
 * The identity the zero-pixel gate rests on: with no map bound, `ormRoughness` is initialised from
 * the attribute and the branch that would overwrite it is not taken, so the roughness expression is
 * the one it replaces with no ternary and nothing to get backwards.
 */
test('roughness falls back to the vertex attribute with no map bound', () => {
  expect(source).toContain('float ormRoughness = vRoughness;');
  expect(source).toContain('ormRoughness + reliefAmount * RELIEF_ROUGHNESS');
  expect(source, 'the attribute is read once, by the fallback').not.toContain(
    'vRoughness + reliefAmount',
  );
});

/*
 * **The identity the whole gate rests on.** Every metal term has to reduce to the term it replaced
 * when `metal` is 0, because that is where every published scene sits. Asserted at source level
 * rather than by capture, so a future edit that swaps a `mix`'s arguments is caught in a second
 * rather than in a frame nobody thought to re-shoot.
 */
test('every metal term collapses to its dielectric form at metal 0', () => {
  /* mix(x, y, 0) is exactly x, so the dielectric value must be the FIRST argument in each. */
  expect(source).toContain('mix(vec3(vSpecular), albedo, metal)');
  expect(source).toContain('mix(0.04, 1.0, metal)');
  expect(source).toContain('mix(vec3(1.0), albedo, metal)');
  /* max(uReflectivity, 0.0) is uReflectivity, because both renderers clamp it non-negative. */
  expect(source).toContain('max(uReflectivity, metal)');
  /* And the diffuse, whose ambient half cancels — see the spec's 3.1. */
  expect(source).toContain('albedo * (ambient + uDirectionalColor * direct * (1.0 - metal))');
});

/*
 * A metal's Fresnel base is close to its albedo, not a dielectric's four percent. Left at 0.04 a
 * smooth metal seen head-on takes a four percent reflection and reads as dark paint, which is the
 * single most common way a metal workflow looks broken.
 */
test('the Fresnel base rises with metal', () => {
  expect(source).toContain('float f0 = mix(0.04, 1.0, metal);');
  expect(source).toContain('mix(f0, 1.0, facing');
  expect(source, 'the old constant base is gone').not.toContain('mix(0.04, 1.0, facing');
});

/*
 * vSpecular defaults to 0, so a lamp highlight gated on it alone would never light a metal — and
 * every mesh meshBuilder builds has that default. The gate is `vSpecular > 0.0` exactly when metal
 * is 0, so nothing that does not bind a map takes a different branch than it did.
 */
test('a metal takes a lamp highlight even with no specular attribute', () => {
  expect(source).toContain('if (vSpecular > 0.0 || metal > 0.0) {');
  expect(source, 'the old gate is gone').not.toContain('if (vSpecular > 0.0) {');
});

/*
 * Placed where the lighting branch closes and **before the fog block**, which is the one
 * constraint on it. Fog sits between the eye and the surface rather than on it, so multiplying it
 * would darken the air in front of a crevice. Everything the *surface* contributes is fair game —
 * sun, ambient, lamps, emissive, the arrival glow, and the unlit path too.
 */
test('occlusion multiplies the surface and not the medium', () => {
  expect(source).toContain('lit *= ormOcclusion;');
  const occlusionAt = source.indexOf('lit *= ormOcclusion;');
  const fogAt = source.indexOf('if (uFogEnabled != 0) {');
  const lightingAt = source.indexOf('if (uLightingEnabled != 0) {');
  expect(occlusionAt).toBeGreaterThan(lightingAt);
  expect(occlusionAt, 'before the fog block, or it darkens the air').toBeLessThan(fogAt);
});

/*
 * **A metal has no diffuse, so the ambient term is the whole of what it shows apart from its
 * reflection** — and that term knew nothing about the room the metal was standing in. A chromed
 * subject in a white atrium came out near black, because a hemispheric sky-and-ground constant is
 * wrong in both directions at once when the environment is neither.
 *
 * Guarded by two factors, and both are load-bearing: the caller's amount, which is 0 unless asked
 * so every existing scene is unchanged, and `uEnvironmentEnabled`, which is 0 until a bake lands
 * and while one is running — sampling a cube the pass is writing is a feedback loop.
 */
/*
 * **The diffuse term is inert unless a caller asked for it, and that is asserted rather than
 * assumed.** It used to be nine coefficients from a readback that landed a frame or two after the
 * bake on one backend, with a gate of its own to cover the gap; it is a level of the probe array
 * now, so it exists exactly when the reflection does and the only remaining question is whether a
 * caller wants their ambient substituted at all.
 *
 * `uProbeGridAmbient` is that question. `mix(x, y, 0)` is exactly `x`, so at zero the hemispheric
 * gradient survives untouched — which is the guarantee `ProbeBakeOptions.irradiance` was added to
 * give, after one consumer filed its absence four times over two days as four different bugs.
 */
test('the diffuse term reads the array, and a gate of its own makes it inert', () => {
  expect(source, 'the level holding the cosine convolution').toContain(
    'uniform float uEnvironmentIrradianceLevel',
  );
  expect(source, 'a gate of its own rather than the probe flag').toContain(
    'uniform float uProbeGridAmbient',
  );
  const declaredAt = source.indexOf('uniform float uProbeGridAmbient');
  const usedAt = source.indexOf('uProbeGridAmbient * uEnvironmentEnabled');
  expect(declaredAt).toBeGreaterThan(-1);
  expect(usedAt).toBeGreaterThan(declaredAt);
  /* The hemispheric term is the FIRST argument, so a gate of zero leaves it exactly as it was. */
  expect(source).toContain(
    'ambient = mix(ambient, irradiance, uProbeGridAmbient * uEnvironmentEnabled)',
  );
  /* And the clamp went with the second-order fit that needed it: a cosine convolution of a
     non-negative environment cannot come back negative. */
  expect(source, 'no clamp left over from the projection').not.toContain(
    'max(irradiance, vec3(0.0))',
  );
});

/*
 * The lattice, which is four uniforms whatever the probe count. This shader already declares 385
 * uniform vectors against WebGL2's guaranteed 224, so a per-probe array is not available and a
 * commit that reached for one would fail here rather than on a device.
 */
test('the grid is four uniforms, not an array that grows with the probe count', () => {
  expect(source).toContain('uniform vec3 uProbeGridOrigin');
  expect(source).toContain('uniform vec3 uProbeGridInvSpacing');
  expect(source).toContain('uniform vec3 uProbeGridCounts');
  expect(source, 'nothing per probe').not.toMatch(/uniform\s+\w+\s+uProbe\w*\[/);
});

/* Without the probe there is no grid to describe, and an unused uniform is a binding a backend has
   to answer for nothing. */
test('there is no irradiance where there is no probe', () => {
  const bare = flatFrag({
    pointShadows: false,
    directionalShadows: false,
    environmentProbe: false,
    nightEmissive: false,
  });
  expect(bare).not.toContain('uProbeGrid');
  expect(bare).not.toContain('uEnvironmentIrradianceLevel');
});

/*
 * **A metal's highlight goes white at a grazing angle**, which is most of what reads as polished.
 * Schlick says reflectance climbs to 1 at the edge whatever the material is, so a red metal shows a
 * red highlight face-on and a white one along every panel edge. Without it the highlight is
 * albedo-tinted at every angle and a dark suit reads as matte paint however smooth its map says it
 * is. The environment term has carried its own Fresnel since it was written; the direct one had
 * none.
 */
test('the direct highlight takes a Fresnel that whitens it at grazing, and only for metal', () => {
  expect(source).toContain('mix(specColor, vec3(1.0), pow(1.0 - sunVoH, 5.0) * metal)');
  expect(source).toContain(
    'vec3 lampSpec = mix( specColor, vec3(1.0), pow(1.0 - max(dot(toEyeLamp, lampHalfway), 0.0), 5.0) * metal );',
  );
  /* Scaled by metal, so mix(specColor, white, 0) is specColor and the dielectric case is
     the expression it replaces — which is what keeps the published scenes bit-identical. */
});

/**
 * The vertex stage's one permutation.
 *
 * Absent rather than gated, and the choice is a measurement rather than a preference: the vertex
 * shader had no permutation axis until skinning, so a second variant costs 1,118 bytes gzipped
 * where one more *fragment* flag costs 246,925. These assertions are what stop somebody "simplifying" it
 * back into a uniform branch that every static mesh in the engine would pay for.
 */
test('the unskinned vertex variant carries no skinning at all', () => {
  const plain = flatVert({ skinned: false, morphed: false, instanced: false });
  expect(plain).not.toContain('uJointPalette');
  expect(plain).not.toContain('aJoints');
  expect(plain).not.toContain('skinMatrix');
  expect(plain).not.toContain('location = 11');
});

test('the skinned variant declares the two attributes at 11 and 12', () => {
  const skinned = flatVert({ skinned: true, morphed: false, instanced: false });
  expect(skinned).toContain('layout(location = 11) in vec4 aJoints;');
  expect(skinned).toContain('layout(location = 12) in vec4 aWeights;');
});

test('neither variant has a runtime gate, because the variant is the gate', () => {
  expect(flatVert({ skinned: true, morphed: false, instanced: false })).not.toContain('uSkinned');
  expect(flatVert({ skinned: false, morphed: false, instanced: false })).not.toContain('uSkinned');
});

/*
 * The 2026-08-07 rule is about implicit derivatives in a fragment stage and a vertex stage has
 * none, which is what lets the palette be a texture at all. `texelFetch` takes an integer
 * coordinate and infers no level, so this asserts nobody later reaches for a filtered sample and
 * reintroduces a question this stage does not have.
 */
test('the palette is read with an integer fetch and no implicit level', () => {
  const skinned = flatVert({ skinned: true, morphed: false, instanced: false });
  expect(skinned).toContain('texelFetch(uJointPalette');
  expect(skinned).not.toMatch(/\btexture\s*\(\s*uJointPalette/);
});

/*
 * A palette entry already carries the joint's inverse bind, so it maps the model's bind pose to
 * where the joint has moved it — which is model space, before the placement. Placing first would
 * apply the character's world transform twice and throw the rig across the scene.
 *
 * `model` rather than `uModel` since the instanced variant landed: it is the local both arms of
 * the branch fill, from the uniform or from the instance attributes, so the body below reads the
 * same either way and this contract holds for both.
 */
test('the skin matrix is applied in model space, before the placement', () => {
  const skinned = flatVert({ skinned: true, morphed: false, instanced: false }).replace(
    /\s+/g,
    ' ',
  );
  expect(skinned).toContain('vec4 local = skin * vec4(basePosition, 1.0);');
  expect(skinned).toContain('vec4 world = model * local;');
  expect(skinned).toContain('mat4 model = uModel;');
});

/*
 * **Morph before skin, and the order is the definition.** A morph target deforms the bind pose —
 * an expression on a face the skeleton has not moved yet — and the skeleton then carries that
 * shape wherever the joint goes. Skinning first would deform the posed vertex, so an expression
 * would drift as a limb moved.
 */
test('a morph offset is added to the bind pose, before skinning', () => {
  const both = flatVert({ skinned: true, morphed: true, instanced: false }).replace(/\s+/g, ' ');
  const morphAt = both.indexOf('basePosition = aPosition + morphOffset()');
  const skinAt = both.indexOf('vec4 local = skin * vec4(basePosition, 1.0);');
  expect(morphAt).toBeGreaterThan(-1);
  expect(skinAt).toBeGreaterThan(morphAt);
});

test('the unmorphed variants carry no morph code at all', () => {
  for (const skinned of [false, true]) {
    const source = flatVert({ skinned, morphed: false, instanced: false });
    expect(source).not.toContain('uMorphDeltas');
    expect(source).not.toContain('morphOffset');
    expect(source).not.toContain('uMorphWeights');
  }
});

/*
 * A uniform block is packed in declaration order, so morph's uniforms have to come after every
 * other one or the offsets the renderer writes by all move — which does not fail, it draws a
 * scrambled frame. `flatPass.ts` asserts the generated offsets; this asserts the *source* property
 * that produces them, which is the thing a person editing this file could break.
 */
test('morph declares its uniforms after the ones every variant shares', () => {
  const morphed = flatVert({ skinned: false, morphed: true, instanced: false });
  expect(morphed.indexOf('uniform vec2 uUvScale;')).toBeLessThan(
    morphed.indexOf('uniform float uMorphWeights'),
  );
});

test('the instanced variant takes its placement and tint from attributes', () => {
  const source = flatVert({ skinned: false, morphed: false, instanced: true });
  expect(source).toContain('layout(location = 11) in vec4 aInstanceModel0;');
  expect(source).toContain('layout(location = 14) in vec4 aInstanceModel3;');
  expect(source).toContain('layout(location = 15) in vec3 aInstanceTint;');
  /* Cut out rather than left declared: an unwritten uniform is zero, and a zero model matrix
     collapses every instance of the batch onto the origin. */
  expect(source).not.toContain('uniform mat4 uModel;');
  expect(source).not.toContain('uniform vec3 uTint;');
});

test('the uninstanced variant declares no instance attribute', () => {
  const source = flatVert({ skinned: false, morphed: false, instanced: false });
  expect(source).toContain('uniform mat4 uModel;');
  expect(source).toContain('uniform vec3 uTint;');
  expect(source).not.toContain('aInstanceModel0');
  expect(source).not.toContain('aInstanceTint');
});

test('both variants place and tint through the same two names', () => {
  /* The body below the branch is shared, so a rename in one arm and not the other would be a
     compile error in exactly one variant — which is the kind that ships. */
  for (const instanced of [false, true]) {
    const source = flatVert({ skinned: false, morphed: false, instanced }).replace(/\s+/g, ' ');
    expect(source).toContain('vec4 world = model * local;');
    expect(source).toContain('vec3 worldNormal = mat3(model) * localNormal;');
    expect(source).toContain('vColor = aColor * tint;');
  }
});

/*
 * Locations 11 and 12 are the joint indices and weights, and the base mesh has already spent
 * eleven of WebGL2's guaranteed sixteen. So a draw is skinned or instanced and never both, and
 * saying so out loud is cheaper than a variant that silently drops one of them.
 */
test('skinned and instanced together are refused', () => {
  expect(() => flatVert({ skinned: true, morphed: false, instanced: true })).toThrow(
    /skinned and instanced/i,
  );
});

test('the instanced depth variant takes its placement from attributes', () => {
  expect(DEPTH_INSTANCED_VERT).toContain('layout(location = 11) in vec4 aInstanceModel0;');
  expect(DEPTH_INSTANCED_VERT).toContain('layout(location = 14) in vec4 aInstanceModel3;');
  expect(DEPTH_INSTANCED_VERT).not.toContain('uniform mat4 uModel;');
  /* No tint at 15: this stage writes depth and nothing samples its colour. */
  expect(DEPTH_INSTANCED_VERT).not.toContain('aInstanceTint');
});

test('the plain depth variant is untouched by the instanced one', () => {
  expect(DEPTH_VERT).toContain('uniform mat4 uModel;');
  expect(DEPTH_VERT).not.toContain('aInstanceModel0');
});

/*
 * The colour and depth stages must place a vertex identically, or a shadow parts from the body
 * casting it — the same claim the skinned pair already makes, now for the instanced pair.
 */
test('colour and depth build the instance matrix from the same four columns', () => {
  const flat = flatVert({ skinned: false, morphed: false, instanced: true }).replace(/\s+/g, ' ');
  const depth = DEPTH_INSTANCED_VERT.replace(/\s+/g, ' ');
  const build =
    'mat4 model = mat4(aInstanceModel0, aInstanceModel1, aInstanceModel2, aInstanceModel3);';
  expect(flat).toContain(build);
  expect(depth).toContain(build);
});

/*
 * The per-vertex channel.
 *
 * Location 13 is the instanced variant's aInstanceModel2, so the attribute is compiled into the
 * other four variants and out of that one. What makes the arrangement safe is that both varyings
 * are declared everywhere and the instanced path writes the neutral values, so the fragment stage
 * sees one shape whatever drew it and gains no permutation.
 */
test('declares the attribute and the wind in the variants that can hold them', () => {
  for (const variant of [
    { skinned: false, morphed: false, instanced: false },
    { skinned: true, morphed: false, instanced: false },
    { skinned: false, morphed: true, instanced: false },
  ]) {
    const source = flatVert(variant);
    expect(source).toContain('layout(location = 13) in vec4 aChannel;');
    expect(source).toContain('uniform vec2 uWindDirection;');
    expect(source).toContain('channelBend(world.xyz, aChannel.x)');
  }
});

test('compiles neither into the instanced variant, which spends 13 on its transform', () => {
  const source = flatVert({ skinned: false, morphed: false, instanced: true });
  expect(source).not.toContain('aChannel');
  expect(source).not.toContain('uWindDirection');
  expect(source).toContain('layout(location = 13) in vec4 aInstanceModel2;');
});

/*
 * The fragment stage must not be able to tell which vertex variant ran. If the instanced path
 * left these unwritten they would read as zero, and zero on either lane is catastrophic rather
 * than subtle: no sun at all, or nothing drawn.
 */
test('writes neutral lanes on the instanced path so the fragment stage reads one shape', () => {
  const source = flatVert({ skinned: false, morphed: false, instanced: true });
  expect(source).toContain('out float vSkyDirect;');
  expect(source).toContain('out float vAlpha;');
  expect(source).toContain('vSkyDirect = 1.0;');
  expect(source).toContain('vAlpha = 1.0;');
});

/*
 * The bend has to reach the shadow lookup and the clip position, not just the varying a
 * fragment shades from. A vertex shaded where it moved and shadow-tested where it did not
 * self-shadows as the gust changes, which only shows up in motion.
 */
test('bends before the world position reaches the light matrix and the clip position', () => {
  const source = flatVert({ skinned: false, morphed: false, instanced: false });
  const bend = source.indexOf('channelBend(world.xyz');
  expect(bend).toBeGreaterThan(0);
  expect(bend).toBeLessThan(source.indexOf('vLightPos = uLightViewProj'));
  expect(bend).toBeLessThan(source.indexOf('gl_Position = uViewProj'));
});

/*
 * The depth pass bends with the colour pass, which is the defect scatter.ts records having fixed:
 * a canopy that bends in the picture and stands still in the shadow map slides its whole shade
 * off the ground, and the offset follows the gust rather than sitting still to be found.
 */
test('the depth pass bends on the same channel as the colour pass', () => {
  expect(DEPTH_VERT).toContain('layout(location = 13) in vec4 aChannel;');
  expect(DEPTH_VERT).toContain('channelBend(world.xyz, aChannel.x)');
});

test('the skinned depth variant bends too, so a rigged canopy keeps its shadow', () => {
  expect(DEPTH_SKINNED_VERT).toContain('channelBend(world.xyz, aChannel.x)');
});

/* The instanced depth variant spends 13 on aInstanceModel2, exactly as the colour pass does. */
test('the instanced depth variant carries no channel', () => {
  expect(DEPTH_INSTANCED_VERT).not.toContain('aChannel');
  expect(DEPTH_INSTANCED_VERT).toContain('layout(location = 13) in vec4 aInstanceModel2;');
});

/*
 * **The whole of the sky lane's defect, in two assertions.** A sky factor carried in the vertex
 * colour scales ambient and sun together, so an enclosed face is darkened twice. This lane must
 * reach the directional source and must not reach the ambient term, and the second half is the
 * one a careless edit would break while still looking plausible.
 */
test('the sky lane attenuates the sun and never the ambient', () => {
  const source = flatFrag({
    pointShadows: false,
    directionalShadows: false,
    environmentProbe: false,
    nightEmissive: false,
  });
  expect(source).toContain('sunShade *= vSkyDirect;');
  expect(source).not.toMatch(/ambient\s*[*]?=\s*[^;]*vSkyDirect/);
});

/*
 * It scales sunShade rather than direct because the sun's specular lobe reads sunShade on its own:
 * scaling direct alone leaves an enclosed face with no sunlight and a sun highlight anyway.
 */
test('the sky lane is applied where the specular lobe also reads it', () => {
  const source = flatFrag({
    pointShadows: false,
    directionalShadows: false,
    environmentProbe: false,
    nightEmissive: false,
  });
  expect(source.indexOf('sunShade *= vSkyDirect;')).toBeLessThan(
    source.indexOf('float direct = ndl * sunShade;'),
  );
});

/* One local, so the order-independent branch inherits the lane rather than repeating it. */
test('the alpha lane folds into the draw opacity once', () => {
  const source = flatFrag({
    pointShadows: false,
    directionalShadows: false,
    environmentProbe: false,
    nightEmissive: false,
  });
  expect(source).toContain('float alpha = uOpacity * coverage * vAlpha;');
});

const REFRACT_BASE = {
  pointShadows: false,
  directionalShadows: false,
  environmentProbe: false,
  nightEmissive: false,
};

/*
 * The lane 3.42.0 declared reserved and unread. It costs a varying and no attribute, where a
 * fifteenth attribute would have spent one of the two vertex locations left.
 */
test('the vertex stage passes the channel thickness lane through', () => {
  const source = flatVert({ skinned: false, morphed: false, instanced: false });
  expect(source).toContain('out float vThickness;');
  expect(source).toContain('vThickness = aChannel.w;');
});

/*
 * The instanced variant carries no channel, so it writes the neutral 1.0 rather than leaving the
 * varying unwritten. A defined state: the draw still refracts, at the thickness it stated.
 */
test('the instanced variant writes a neutral thickness', () => {
  const source = flatVert({ skinned: false, morphed: false, instanced: true });
  expect(source).toContain('out float vThickness;');
  expect(source).toContain('vThickness = 1.0;');
});

/*
 * A uniform and a branch, never a permutation: one more flatFrag axis is about 247 KB gzipped paid
 * by every consumer, against 19.8 KB for a branch.
 */
test('refraction is a uniform and a branch rather than a permutation', () => {
  const source = flatFrag(REFRACT_BASE);
  expect(source).toContain('uniform sampler2D uRefractScene;');
  expect(source).toContain('uniform float uRefractStrength;');
  expect(source).toContain('uniform vec3 uRefractTint;');
  expect(source).toContain('uniform float uRefractThickness;');
  expect(source).not.toContain('#if REFRACTION');
});

/*
 * **The assertion Beer-Lambert exists for.** A tint multiplied straight in gives the same colour at
 * every angle; dividing by the view angle is what makes a glass edge go green while its middle
 * stays clear. An implementation without it passes every other assertion in this file.
 */
test('the path length divides by the view angle and is clamped off the silhouette', () => {
  const source = flatFrag(REFRACT_BASE);
  expect(source).toContain('max(dot(refractN, refractV), 0.05)');
  expect(source).toContain('pow(uRefractTint, vec3(pathLength))');
});

/*
 * A sample that walked off the frame and wrapped would pull the opposite edge of the screen into a
 * pane at the border, which reads as a tear rather than as an approximation running out.
 */
test('the refracted sample is clamped inside the frame', () => {
  expect(flatFrag(REFRACT_BASE)).toContain('clamp(screenUv + refractN.xy * uRefractStrength');
});

/*
 * Off is the default and off is what every call that predates this means, so a scene that never
 * refracts reads the sampler nowhere.
 */
test('the refraction branch is entered only when a draw asks for it', () => {
  expect(flatFrag(REFRACT_BASE)).toContain('if (uRefractStrength > 0.0) {');
});

/**
 * **No point-shadow array is read at an index that could be past its end.**
 *
 * The light budget is a build-time size now, and a clustered light carries its shadow slot in the
 * froxel record rather than in the loop counter — so a build with fewer slots than
 * `MAX_LIGHTS_PER_CLUSTER` can be handed a number past the end of these arrays. Indexing a uniform
 * array out of range is undefined in GLSL ES and arrives as a picture rather than as an error,
 * which is the failure mode nothing downstream can see.
 *
 * Written as "every read goes through the clamped name" rather than as "the clamp is present", so
 * it catches the case that actually reintroduces the bug: somebody adding a *new* shadow array
 * beside these and indexing it with the raw slot.
 */
test('reads every point-shadow array through the clamped slot', () => {
  const source = flatFrag({
    pointShadows: true,
    directionalShadows: true,
    environmentProbe: false,
    nightEmissive: false,
  });
  expect(source).toContain('int shadowRead = clamp(shadowSlot, 0, MAX_LIGHTS - 1);');

  const reads = [...source.matchAll(/u(?:Live)?PointShadow[A-Za-z]*\[([^\]]+)\]/g)]
    .map((match) => match[1].trim())
    /* The declarations themselves, which are sized by the budget rather than indexed by it. */
    .filter((index) => index !== 'MAX_LIGHTS');
  expect(reads.length, 'the arrays are read at all').toBeGreaterThan(4);
  expect([...new Set(reads)], 'and only ever at the clamped index').toEqual(['shadowRead']);
});

/** A slot past the end is treated as no shadow rather than clamped onto another light's. */
test('gives a light past the shadow arrays no shadow rather than a neighbour’s', () => {
  const source = flatFrag({
    pointShadows: true,
    directionalShadows: true,
    environmentProbe: false,
    nightEmissive: false,
  });
  expect(source).toContain('shadowSlot >= 0 && shadowSlot < MAX_LIGHTS ? uPointShadowLayer');
});

/**
 * The budget reaches the source, which is the whole mechanism the fit rests on.
 *
 * Both numbers, because they size different families: twenty arrays hang off `MAX_LIGHTS` with
 * point shadows on and fourteen off `MAX_AREA_LIGHTS`.
 */
test('builds the light arrays at the budget it was given', () => {
  const small = flatFrag({
    pointShadows: true,
    directionalShadows: true,
    environmentProbe: false,
    nightEmissive: false,
    maxLights: 8,
    maxAreaLights: 2,
  });
  expect(small).toContain('#define MAX_LIGHTS 8');
  expect(small).toContain('#define MAX_AREA_LIGHTS 2');
  expect(small).not.toContain('#define MAX_LIGHTS 16');
});

/** Absent means the engine's own budget, so nothing that never heard of this moves a byte. */
test('leaves the source byte-identical when no budget is named', () => {
  const variant = {
    pointShadows: true,
    directionalShadows: true,
    environmentProbe: false,
    nightEmissive: false,
  } as const;
  expect(flatFrag({ ...variant, maxLights: 16, maxAreaLights: 4 })).toBe(flatFrag(variant));
});

/**
 * A budget that is not a whole number of slots is refused where somebody can act on it.
 *
 * It is interpolated straight into the source as an array size, so zero declares
 * `uniform vec3 uLightPos[0]` and 7.5 declares `[7.5]` — both arrive as a shader compile error
 * naming a line nobody wrote, one layer below anybody who could fix it.
 */
test('refuses a light budget that is not a whole number of slots', () => {
  const variant = {
    pointShadows: true,
    directionalShadows: true,
    environmentProbe: false,
    nightEmissive: false,
  } as const;
  expect(() => flatFrag({ ...variant, maxLights: 0 })).toThrow(/at least 1/);
  expect(() => flatFrag({ ...variant, maxLights: 7.5 })).toThrow(/whole number/);
  expect(() => flatFrag({ ...variant, maxAreaLights: -1 })).toThrow(/maxAreaLights/);
});
