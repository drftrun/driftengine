/** Fixed point-light budget shared by CPU selection and the flat shader. */
import type { AreaLightBuffer } from './areaLights.ts';
import type { ResolvedAreaShadows } from './areaShadowSet.ts';
import { POINT_LIGHT_COS_INNER, POINT_LIGHT_COS_OUTER } from './clusteredLights.ts';

/**
 * How many point lights the shading pass shades against at once.
 *
 * It was eight, and eight is what an ordinary lamp-lit courtyard broke over: six lamps
 * and a brazier inside 8.7 m take seven of them, so a gate's two lights —
 * equidistant by construction, both 12.52 m out — contended for the one remaining
 * slot and only ever one of them was rendered. More slots do not make the budget
 * unbounded, and they are not what fixes contention; `CONTENTION_BAND_M` in
 * `pointLightSelection.ts` is, by making the trade continuous. They buy the room
 * that stops a scene this ordinary from having to make the trade at all.
 *
 * **It was ten, and ten was a texture-unit limit that no longer exists.** The comment
 * here used to say that raising it "costs a texture unit and a pool slot each" and that
 * eleven "would spend the last guaranteed unit, so this is the end of the road". That was
 * true while each light's shadow was its own `samplerCube`. Every point shadow is now one
 * layer of one `TEXTURE_2D_ARRAY` — see `pointShadowArray.ts` — so a light costs a layer
 * and a pool slot, and no bindings at all.
 *
 * **Sixteen because that is what costs nothing.** A cube at face 512 was 6.29 MB and the
 * pool plus the two live maps was sixteen of them, 100.7 MB. An octahedral layer at 1024 is
 * 4.19 MB, so sixteen lights is a pool of twenty plus two live, twenty-two layers, 92.3 MB —
 * less than the storage it replaces, with six more shadowed lights. **Eighteen is where the
 * memory exactly equals what the cubes cost**, which is the number to reach for if a scene
 * ever wants more, and the arithmetic is written down here so nobody has to re-derive it.
 *
 * What limits it now is the shader rather than the bindings: every one of these is a slot in
 * five uniform arrays and an iteration of the light loop in the widest permutation of the
 * largest shader in the engine.
 */
export const MAX_POINT_LIGHTS = 16;

/** Two live maps make changing the caster's owning light a crossfade, not a pop. */
export const LIVE_POINT_SHADOW_MAPS = 2;

/**
 * Texture units the directional cascade binds: static, its depth peel, and dynamic.
 *
 * Named because the shading pass's total unit count has to be compared against what a
 * device offers, and a budget assembled from three literals scattered across two files
 * is a budget nobody can check. See the guard in `Renderer`'s constructor.
 */
export const DIRECTIONAL_SHADOW_UNITS = 3;

/**
 * Texture units every point light's shadow binds: one, for all of them.
 *
 * **It was twelve** — ten pooled cubemaps and two live transition maps, each its own
 * `samplerCube`, because GLSL ES cannot index a sampler array with a non-constant expression.
 * One `TEXTURE_2D_ARRAY` of octahedral maps makes the choice a layer index instead, so the
 * count stops depending on `MAX_POINT_LIGHTS` at all.
 */
export const POINT_SHADOW_UNITS = 1;

/**
 * Where surface colour binds, directly above the shadow units.
 *
 * Units 0–2 are the sun's static, peeled and mover depth layers; unit 3 is the point-shadow
 * array, every light in one binding. This is the fifth, the normal map is the sixth, and **ten of
 * WebGL2's guaranteed sixteen are free** — where the lit pass used to fill all sixteen exactly.
 *
 * It lives here rather than in the renderer because this is where the unit accounting is
 * written down. Raising `MAX_POINT_LIGHTS` no longer moves it: lights cost layers now, not
 * units, which is the whole of what the octahedral change bought.
 */
export const SURFACE_TEXTURE_UNIT = DIRECTIONAL_SHADOW_UNITS + POINT_SHADOW_UNITS;

/**
 * Where a normal map binds, directly above surface colour.
 *
 * **The first of the eleven units Phase 1.4 freed to be spent**, and it is worth saying what it
 * cost to have one at all. `uTextureRelief`'s comment records the constraint in as many words: a
 * second image sampler "is not the free addition it would be in a smaller shader", because the
 * widest permutation already declared one more sampler than this project's adapter offered.
 * Twelve point-shadow cubemaps became one array binding, and this is what that was for.
 *
 * The ORM map is the next one, and takes the unit above this.
 */
export const NORMAL_TEXTURE_UNIT = SURFACE_TEXTURE_UNIT + 1;

/**
 * Occlusion, roughness and metallic in one image, on the unit above the normal map.
 *
 * Derived rather than written down, for the reason `SURFACE_TEXTURE_UNIT` is: a gap wastes a unit
 * on a device that has none to waste, and an overlap binds two textures to one unit, which is
 * undefined at best and reads as a surface losing one of its maps depending on the driver.
 *
 * **One unit for three channels rather than three units for three maps.** glTF packs them this way
 * and so does every authoring tool that emits them; a file that separates its occlusion into its
 * own image loses it, with the reason stated in the importer rather than a second sampler spent.
 *
 * The emissive map is the next one, and takes the unit above this.
 */
export const ORM_TEXTURE_UNIT = NORMAL_TEXTURE_UNIT + 1;

/**
 * Where a consumer's emissive map binds.
 *
 * **The unit `textureUnitBudget.test.ts` has named for it since the sampler unlock**, which is the
 * point of naming units rather than counting them: the change that spends one has to read what it
 * is spending, and this one was written down before it was taken.
 *
 * Directly above the ORM map so the four material maps are contiguous — surface, normal, ORM,
 * emissive. They are the set a device's guaranteed sixteen has to hold together, and anything else
 * sitting between two of them makes that budget harder to read than it is.
 */
export const EMISSIVE_TEXTURE_UNIT = ORM_TEXTURE_UNIT + 1;

/**
 * Where a baked reflection probe binds, when there is a unit spare for one.
 *
 * **It used to be one past the guarantee, and it is not any more.** WebGL2 promises sixteen
 * units; the lit pass used to fill 0 through 15, so the probe sat at the seventeenth and every
 * Apple GPU — all of which report exactly sixteen — had no unit for it and stood down. The
 * point-shadow cubes became one array binding, so this is the eighth of sixteen and the probe
 * fits everywhere.
 *
 * The rule it carried is kept anyway rather than deleted, because the reasoning is still the
 * right one if the budget ever fills again: the probe is the thing given up, not the shadows.
 * Dropping shadows to make room would trade a feature every scene uses for one a single
 * material asks for, and a surface that cannot mirror the room still reflects the
 * sky-and-ground approximation it always did.
 */
export const ENVIRONMENT_TEXTURE_UNIT = EMISSIVE_TEXTURE_UNIT + 1;

/**
 * Where the froxel table binds.
 *
 * **Spent unconditionally, and that is what a runtime branch costs.** The clustered arm is
 * compiled into every profile rather than permuted in, because a fifth permutation flag doubled
 * the generated WGSL and cost 49% of the bundle on every consumer — the measurement is at the
 * declaration in `shaders/flat/preamble.ts`. A declared sampler needs a valid texture bound to it
 * whether or not the branch reads it, so this unit is taken even with `clusteredLights` off, and a
 * one-texel placeholder stands in it.
 *
 * The eighth of sixteen. The sampler unlock left nine free and this is the first of them.
 */
export const CLUSTER_TABLE_TEXTURE_UNIT = ENVIRONMENT_TEXTURE_UNIT + 1;

/**
 * Where the photometric atlas binds: one row per IES profile, any number of them.
 *
 * **One unit for every profile a world holds, which is the whole reason it is an atlas.** A
 * fixture's distribution is a curve rather than an image, so a row of 128 floats holds one and a
 * texture holds as many as a consumer loads. Per-profile textures would have spent the remaining
 * units on the third fixture.
 *
 * **Spent unconditionally, for the same reason the froxel table is**, and the argument is at that
 * declaration: the lookup is a branch on a value rather than a permutation, so the sampler is
 * declared in every profile and a declared sampler needs a complete texture bound whether or not
 * the branch reads it. With no profile loaded that texture is a single row of ones, which is the
 * multiplicative identity — a row of zeros would switch off every light that reached it.
 *
 * The tenth of sixteen. `CAPABILITIES.md` §3 keeps the running count.
 */
export const IES_ATLAS_TEXTURE_UNIT = CLUSTER_TABLE_TEXTURE_UNIT + 1;

/**
 * The joint palette, read by the **vertex** stage.
 *
 * **It comes out of the same sixteen as everything above it, and that is the correction.** The
 * palette was first given unit 0 on the reasoning that `MAX_VERTEX_TEXTURE_IMAGE_UNITS` is a
 * separate guarantee of sixteen from `MAX_TEXTURE_IMAGE_UNITS`. Those two do bound the stages
 * separately — but they bound how many units each stage may *reference*, not how the units are
 * numbered: `activeTexture` selects from one shared pool, so unit 0 is the directional shadow map
 * whoever binds it. The result is `GL_INVALID_OPERATION: two textures of different types use the
 * same sampler location`, on a frame that otherwise draws.
 *
 * Found on hardware rather than in review, which is the whole reason a capture is part of the
 * work. WebGPU never had it: its bindings are per bind group and carry no shared namespace.
 *
 * What it costs is one of the five units left after the IES atlas. What would make it wrong is
 * the lit pass growing past sixteen, which `textureUnitBudget.test.ts` asserts against.
 */
export const SKIN_PALETTE_TEXTURE_UNIT = IES_ATLAS_TEXTURE_UNIT + 1;

/**
 * A mesh's morph deltas, also read by the vertex stage, and also out of this same sixteen.
 *
 * The second vertex-stage sampler this engine has, and it takes a unit for the reason the palette
 * does: `activeTexture` selects from one pool whichever stage the sampler is declared in. Thirteen
 * of sixteen spoken for, three free.
 */
export const MORPH_DELTA_TEXTURE_UNIT = SKIN_PALETTE_TEXTURE_UNIT + 1;

/**
 * Where the spot-light cookie atlas binds: one row of square tiles, one tile a cookie.
 *
 * **The fourteenth of sixteen, and two are left.** `CAPABILITIES.md` §3 keeps the running count —
 * and had been three units stale for as long as the IES atlas, the skin palette and the morph
 * deltas have existed, which is why the number is derived in `textureUnitBudget.test.ts` and only
 * quoted in prose.
 *
 * **Spent unconditionally, for the reason the froxel table and the IES atlas are**: a declared
 * sampler needs a complete texture bound whether or not the branch reads it, so a one-texel white
 * placeholder stands in it when no consumer has loaded a cookie. White rather than black, because
 * it multiplies a light's colour and a black stand-in would switch off every light that reached
 * it — the identity `packIesAtlas` chooses for the same reason.
 */
export const COOKIE_ATLAS_TEXTURE_UNIT = MORPH_DELTA_TEXTURE_UNIT + 1;

/**
 * The colour the frame had already drawn, for a refracting surface to sample.
 *
 * **The second-to-last unit WebGL2 guarantees, and derived rather than a literal** for the reason
 * every unit above it is: a gap wastes a unit on a device that has none to waste, and an overlap
 * binds two textures of different types to one unit, which is undefined and reads as a scene
 * losing one of them depending on the driver.
 *
 * **One unit is left after this.** What that costs is that the next sampler added has to find room
 * rather than take it — by folding into an existing binding the way the twelve point-shadow
 * cubemaps became one array, which is what freed the units this one is spending.
 * `textureUnitBudget.test.ts` carries the phone that budget was written for.
 */
export const REFRACT_SCENE_TEXTURE_UNIT = COOKIE_ATLAS_TEXTURE_UNIT + 1;

/**
 * A cookie's tile, in texels a side.
 *
 * **128, which is what a gobo is.** A cookie is a soft mask — a window frame, a leaf canopy, a
 * grille — and its edges are blurred by the source's own size before anything sees them, so the
 * resolution that matters is the shape rather than the detail. Sixteen tiles at 128 is a
 * 2048x128 atlas at 1 MB, against 16 MB for the same count at 512.
 *
 * Interpolated into the shader rather than repeated there, so the half-texel inset that stops one
 * tile bleeding into the next is derived from one definition.
 */
export const COOKIE_TILE = 128;

/**
 * Where the SDF text atlas binds.
 *
 * **Not a new number past `SURFACE_TEXTURE_UNIT`.** The next untaken one by that reading is
 * `ENVIRONMENT_TEXTURE_UNIT`, the seventeenth unit — and on the Apple GPUs this file already
 * accounts for, which report exactly the guaranteed sixteen, a seventeenth unit does not
 * exist. The reflection probe can decline gracefully when that happens and still leave a
 * correct picture behind. SDF text has no such fallback: it is opt-in, but a consumer who
 * opts in wants their labels on every device that promises WebGL2, not on every device except
 * one vendor's phones.
 *
 * So the atlas reuses `SURFACE_TEXTURE_UNIT` itself, which needs no capability check because
 * it is already the last unit WebGL2 guarantees. That is safe rather than a compromise: text
 * draws through its own program, in its own pass, with exactly one sampler, so it never
 * needs to coexist with whatever the shading pass bound a moment earlier — the two are never
 * bound at once. Named separately anyway, so the SDF renderer's call site reads as "the
 * atlas's unit" rather than as a reference to a surface colour it has nothing to do with.
 */
export const SDF_TEXT_TEXTURE_UNIT = SURFACE_TEXTURE_UNIT;

/**
 * Cubemaps kept for world lights, independent of how many lights a world has.
 *
 * This used to be one map per light, forever, and it is the single most expensive
 * mistake the renderer has made. A `DEPTH_COMPONENT24` cube at face size 512 is
 * six faces at four bytes a texel, about 6.3 MB; a measured world carries 50
 * lights, so the renderer allocated roughly 327 MB of shadow storage — of which
 * `MAX_POINT_LIGHTS` worth, eight maps, could be sampled in any given frame.
 * Forty-two of them, some 265 MB, were unreadable by construction.
 *
 * Nothing about that is visible on a GPU with its own memory. On an integrated
 * part it is fatal: system RAM *is* the VRAM, over a bus shared with the CPU, so
 * past the budget the driver evicts and re-uploads every frame and the frame rate
 * falls off a cliff rather than degrading. It reproduced as a game that ran at
 * 3 fps maximised and *perfectly* in a small window, because shrinking the window
 * shrank the other targets back under the budget.
 *
 * So the pool is sized to what the shader can actually read, plus headroom. The
 * headroom is not optional: selection reorders as the camera moves, and a pool of
 * exactly eight would evict a map that is about to be wanted again and re-bake it
 * on the next frame, forever. Four spare slots absorb that churn.
 *
 * The maps are no longer permanent, which is the cost of this: a light entering
 * the sampled set for the first time in a while pays six face passes once. They
 * bake from static geometry, so the result is identical whenever it is taken.
 */
export const POINT_SHADOW_POOL = MAX_POINT_LIGHTS + 4;

/**
 * The active point lights a pass shades against.
 *
 * Named separately from `Environment` so a pass can ask for the lights without asking
 * for the sky, the fog, the shadow maps and the highlight box as well — and named with
 * `Environment`'s own field names so an environment satisfies it structurally, which
 * keeps the call free of a per-frame adapter object in a per-frame path.
 */
export interface PointLightSet {
  readonly lightCount: number;
  readonly lightPositions: Float32Array;
  readonly lightColors: Float32Array;
  readonly lightRadii: Float32Array;
  readonly lightWeights: Float32Array;
  /**
   * Each light's emitter radius in metres, optional per consumer.
   *
   * Absent means every source is a mathematical point, which is what this engine assumed until
   * a highlight smaller than a fragment turned out to be the cause of speckle on glossy paint.
   */
  readonly lightSourceRadii?: Float32Array;
  /**
   * Three per light: where a spot points, normalised. Absent means every light is a point.
   *
   * Optional so that a consumer which has never heard of spot lights passes exactly what it passed
   * before and gets exactly what it got before.
   */
  readonly lightDirections?: Float32Array;
  /** Two per light: the cosine of the inner cone angle, then of the outer. */
  readonly lightConeCos?: Float32Array;
  /** One per light: a row of the photometric atlas, or negative for none. */
  readonly lightIesProfiles?: Float32Array;
  /**
   * Three per light: where a photometric profile's azimuth zero points, in world space.
   *
   * **Only an asymmetric fixture reads it** — a street light, a wall washer — and every axially
   * symmetric profile ignores it entirely, which is nearly all of them. It need not be
   * perpendicular to the light's direction: the shader orthogonalises it against the aim, so a
   * caller can hand the fixture's own forward and let the aim decide the rest. A zero vector, or
   * one parallel to the aim, leaves the profile on its first plane.
   *
   * **It cannot be derived from the direction**, which is why it is here at all: there is no
   * continuous field of unit vectors tangent to a sphere, so any reference built from the aim
   * alone flips somewhere — and the obvious constructions put that flip exactly where these
   * fixtures point, `cross(worldUp, dir)` being singular for a light aimed straight down.
   */
  readonly lightIesAxes?: Float32Array;
  /**
   * One per light: a tile of the cookie atlas, or negative for none.
   *
   * A cookie is a mask the fixture projects — a window frame, a grille, foliage — and it is
   * oriented by the same `lightIesAxes` a photometric profile is, because both answer the same
   * question about a fixture: which way is up. It fills the light's **outer cone**, so a cookie
   * drawn for one spot works in another with a different angle.
   */
  readonly lightCookies?: Float32Array;
}

/** Weights are optional per consumer; a short array means every light is fully present. */
const FULLY_PRESENT: Float32Array = new Float32Array(MAX_POINT_LIGHTS).fill(1);

/** No size at all, which is the behaviour every scene had before a light could have one. */
const POINT_SOURCES: Float32Array = new Float32Array(MAX_POINT_LIGHTS);
/**
 * Every light pointing nowhere, which is what a light with no cone needs.
 *
 * The direction is never read when the cone admits everything — `smoothstep` is already at its
 * upper bound — so zeroes are correct rather than merely harmless.
 */
const NO_DIRECTIONS: Float32Array = new Float32Array(MAX_POINT_LIGHTS * 3);
/**
 * Every light carrying no photometric profile.
 *
 * Filled with −1 rather than left at zero, because zero is a valid row index: a world with one
 * profile loaded and a light that never asked for it would otherwise take row 0 and be shaped by
 * a fixture it has nothing to do with.
 */
const NO_PROFILES: Float32Array = new Float32Array(MAX_POINT_LIGHTS).fill(-1);
/**
 * Every light carrying no azimuth reference.
 *
 * Zero rather than an axis, and the shader reads a zero-length reference as "no usable one" and
 * stays on the first plane — which is what every symmetric profile does anyway, so a scene that
 * never heard of this shades exactly as it did.
 */
const NO_IES_AXES: Float32Array = new Float32Array(MAX_POINT_LIGHTS * 3);
/** Every light carrying no cookie. −1 rather than 0, because tile 0 is a real cookie. */
const NO_COOKIES: Float32Array = new Float32Array(MAX_POINT_LIGHTS).fill(-1);
/**
 * A cone that admits every direction, for every light.
 *
 * Inner −1 and outer −2 in each pair, which is the collapse `POINT_LIGHT_COS_OUTER` describes: the
 * dot product never falls below −1, so the term is exactly 1 and a scene with no spot light shades
 * exactly as it did before spot lights existed.
 */
/**
 * A fresh cone array where every light admits every direction.
 *
 * Exported because `createEnvironment` needs one it owns: the module-scope `OPEN_CONES` is shared
 * by every fallback in this file, and handing it to an environment would let one scene's edit
 * reach another's — the aliasing `createEnvironment` already warns about for `lightPositions`.
 */
export function openCones(lights: number = MAX_POINT_LIGHTS): Float32Array {
  const cones = new Float32Array(lights * 2);
  for (let light = 0; light < lights; light++) {
    cones[light * 2] = POINT_LIGHT_COS_INNER;
    cones[light * 2 + 1] = POINT_LIGHT_COS_OUTER;
  }
  return cones;
}

const OPEN_CONES: Float32Array = (() => {
  const cones = new Float32Array(MAX_POINT_LIGHTS * 2);
  for (let light = 0; light < MAX_POINT_LIGHTS; light++) {
    cones[light * 2] = POINT_LIGHT_COS_INNER;
    cones[light * 2 + 1] = POINT_LIGHT_COS_OUTER;
  }
  return cones;
})();
/** A light nobody positioned, at the origin with no colour: shaded, and contributing nothing. */
const NO_POSITIONS: Float32Array = new Float32Array(MAX_POINT_LIGHTS * 3);
const NO_COLORS: Float32Array = new Float32Array(MAX_POINT_LIGHTS * 3);
/** Said once per process, not once per frame. See the guard that sets it. */
let warnedShortArrays = false;

/**
 * Bind a light set to whichever program declares the shared slot names.
 *
 * Three passes now shade against these — surfaces, smoke and water — and each had its
 * own copy of the same four uploads. A fourth would have made it four, and one of the
 * four would eventually have been the one to forget `uLightWeight` and have lights pop
 * in and out instead of fading.
 *
 * `falloff` travels with them because the shape a lamp fades with is a property of the
 * *world*, not of the material it lands on: a lamp that behaves one way on stone and
 * another on the water beside it is the same light in two places.
 */
export function bindPointLights(
  gl: WebGL2RenderingContext,
  uniforms: Record<string, WebGLUniformLocation>,
  lights: PointLightSet | null,
  falloff: 'smooth' | 'inverseSquare',
): void {
  const r = resolvePointLights(lights, falloff, glLights);
  gl.uniform1i(uniforms['uLightCount'] ?? null, r.count);
  gl.uniform1i(uniforms['uLightFalloff'] ?? null, r.falloff);
  if (r.count === 0) return;
  gl.uniform3fv(uniforms['uLightPos[0]'] ?? null, r.positions);
  gl.uniform3fv(uniforms['uLightColor[0]'] ?? null, r.colors);
  gl.uniform1fv(uniforms['uLightRadius[0]'] ?? null, r.radii);
  gl.uniform1fv(uniforms['uLightSourceRadius[0]'] ?? null, r.sourceRadii);
  gl.uniform1fv(uniforms['uLightWeight[0]'] ?? null, r.weights);
  /*
   * The cone, uploaded for every light rather than only for spots. The shader reads these slots
   * unconditionally — a point light's pair is what makes its term collapse to 1 — so leaving them
   * unwritten is a uniform holding zeros, which is a cone that admits nothing and a world with
   * every lamp switched off.
   */
  gl.uniform3fv(uniforms['uLightDir[0]'] ?? null, r.directions);
  gl.uniform2fv(uniforms['uLightCone[0]'] ?? null, r.coneCos);
  gl.uniform1fv(uniforms['uLightIesProfile[0]'] ?? null, r.iesProfiles);
  gl.uniform3fv(uniforms['uLightIesAxis[0]'] ?? null, r.iesAxes);
  gl.uniform1fv(uniforms['uLightCookie[0]'] ?? null, r.cookies);
}

/**
 * Bind the rectangular emitters, on the same reasoning `bindPointLights` gives.
 *
 * Separate from the point lights because they are a separate loop with separate arrays, and in the
 * same file because a fourth pass forgetting one of these is the failure that helper exists to
 * prevent — and there is no reason a second one would be immune to it.
 */
export function bindAreaLights(
  gl: WebGL2RenderingContext,
  uniforms: Record<string, WebGLUniformLocation>,
  lights: AreaLightBuffer | null,
): void {
  const count = lights?.count ?? 0;
  gl.uniform1i(uniforms['uAreaLightCount'] ?? null, count);
  /*
   * Nothing else uploaded at zero, which is what makes an area light free to a scene that has
   * none: the shader's loop breaks on the count before it reads an array, so the arrays may hold
   * whatever they held.
   */
  if (count === 0 || lights === null) return;
  gl.uniform3fv(uniforms['uAreaLightPos[0]'] ?? null, lights.positions);
  gl.uniform3fv(uniforms['uAreaLightColor[0]'] ?? null, lights.colors);
  gl.uniform3fv(uniforms['uAreaLightRight[0]'] ?? null, lights.right);
  gl.uniform3fv(uniforms['uAreaLightUp[0]'] ?? null, lights.up);
  gl.uniform2fv(uniforms['uAreaLightSize[0]'] ?? null, lights.sizes);
  gl.uniform1fv(uniforms['uAreaLightTwoSided[0]'] ?? null, lights.twoSided);
}

/**
 * Put a rectangle's occlusion on the program: eight arrays, no texture of its own.
 *
 * **No sampler here, and that is the whole reason this is a separate function rather than part of
 * `bindPointShadows`.** An area light's layers live in the array that call already bound, so the
 * unit and the sampler name are its business and these are only indices into it — which is also
 * what makes an area shadow ride `RenderQuality.pointShadows`: with the flag off the program
 * declares no array at all, none of these eight names exists, and every lookup below answers
 * `null`.
 *
 * Addressed as `name[0]`, because GLSL ES exposes an array uniform under the name of its first
 * element and `name[1]` returns nothing from the cached table — the mistake that left point-light
 * slots 1 to 7 at zero and made their shadows vanish.
 */
export function bindAreaShadows(
  gl: WebGL2RenderingContext,
  uniforms: Record<string, WebGLUniformLocation>,
  shadows: ResolvedAreaShadows,
): void {
  gl.uniform1iv(uniforms['uAreaShadowLayer[0]'] ?? null, shadows.layer);
  gl.uniform1fv(uniforms['uAreaShadowFar[0]'] ?? null, shadows.far);
  gl.uniform1fv(uniforms['uAreaShadowNear[0]'] ?? null, shadows.near);
  gl.uniform1fv(uniforms['uAreaShadowWeight[0]'] ?? null, shadows.weight);
  gl.uniform1iv(uniforms['uLiveAreaShadowLayer[0]'] ?? null, shadows.liveLayer);
  gl.uniform1fv(uniforms['uLiveAreaShadowFar[0]'] ?? null, shadows.liveFar);
  gl.uniform1fv(uniforms['uLiveAreaShadowNear[0]'] ?? null, shadows.liveNear);
  gl.uniform1fv(uniforms['uLiveAreaShadowWeight[0]'] ?? null, shadows.liveWeight);
}

/** The five arrays and two scalars a shader needs, after every fallback has been applied. */
export interface ResolvedPointLights {
  count: number;
  /** 1 for `inverseSquare`, 0 for `smooth`. An `int` uniform on both backends. */
  falloff: number;
  positions: Float32Array;
  colors: Float32Array;
  radii: Float32Array;
  sourceRadii: Float32Array;
  weights: Float32Array;
  directions: Float32Array;
  coneCos: Float32Array;
  iesProfiles: Float32Array;
  iesAxes: Float32Array;
  cookies: Float32Array;
}

/** One per GL binder, refilled per call: holds references, allocates nothing. */
const glLights: ResolvedPointLights = {
  count: 0,
  falloff: 0,
  positions: NO_POSITIONS,
  colors: NO_COLORS,
  radii: POINT_SOURCES,
  sourceRadii: POINT_SOURCES,
  weights: FULLY_PRESENT,
  directions: NO_DIRECTIONS,
  coneCos: OPEN_CONES,
  iesProfiles: NO_PROFILES,
  iesAxes: NO_IES_AXES,
  cookies: NO_COOKIES,
};

/**
 * Choose which array each slot actually gets, with every fallback applied.
 *
 * **Separated from the upload so a second backend reaches the same five arrays.** The whole
 * argument for `bindPointLights` is that a fourth pass would eventually be the one to forget
 * `uLightWeight`; a second *backend* that cannot call it, having no `WebGL2RenderingContext`,
 * is that same fourth pass wearing a different hat. WebGPU scatters these into a uniform block
 * at the generated stride, WebGL2 hands them to `uniform3fv`.
 *
 * Fills a target the caller owns, because both callers are per-frame paths.
 */
export function resolvePointLights(
  lights: PointLightSet | null,
  falloff: 'smooth' | 'inverseSquare',
  out: ResolvedPointLights,
): ResolvedPointLights {
  const count = lights?.lightCount ?? 0;
  out.count = count;
  out.falloff = falloff === 'inverseSquare' ? 1 : 0;
  if (count === 0 || lights === null) {
    out.positions = NO_POSITIONS;
    out.colors = NO_COLORS;
    out.radii = POINT_SOURCES;
    out.sourceRadii = POINT_SOURCES;
    out.weights = FULLY_PRESENT;
    out.directions = NO_DIRECTIONS;
    out.coneCos = OPEN_CONES;
    out.iesProfiles = NO_PROFILES;
    out.iesAxes = NO_IES_AXES;
    out.cookies = NO_COOKIES;
    return out;
  }
  /*
   * **Every array is guarded on its length, and they used to disagree about what absent means.**
   *
   * `uLightWeight` checked a length and `uLightSourceRadius` checked for `undefined`, and
   * `createEnvironment` initialises the whole family to `new Float32Array(0)`, which is not
   * undefined. So the emitter-size fallback never fired: a zero-length array reached a uniform
   * declared as `MAX_POINT_LIGHTS` floats, `uniform1fv` refused it with `INVALID_VALUE` on every
   * frame that had a light in it, and the uniform kept the zeros it started with. Every light in
   * the scene was then shaded as a mathematical point, which is a highlight narrower than a
   * fragment: exactly the speckle on dark glossy paint that `sourceRadius` was added to remove.
   * **The feature was silently off in the app that asked for it.** Reported from outside; the
   * comment here previously claimed the fallback covered "an environment built before this
   * existed", which is true of a hand-written literal and false of anything the factory made.
   *
   * The other three had no guard at all, so the same mistake on them was the same error with a
   * different name. A short array now means a light that is unlit rather than a frame that is
   * invalid, which is the difference between a picture somebody can debug and a console flood.
   */
  const positions =
    lights.lightPositions.length >= MAX_POINT_LIGHTS * 3 ? lights.lightPositions : NO_POSITIONS;
  const colors = lights.lightColors.length >= MAX_POINT_LIGHTS * 3 ? lights.lightColors : NO_COLORS;
  const radii = lights.lightRadii.length >= MAX_POINT_LIGHTS ? lights.lightRadii : POINT_SOURCES;
  const sourceRadii =
    (lights.lightSourceRadii?.length ?? 0) >= MAX_POINT_LIGHTS
      ? (lights.lightSourceRadii as Float32Array)
      : POINT_SOURCES;
  const weights =
    lights.lightWeights.length >= MAX_POINT_LIGHTS ? lights.lightWeights : FULLY_PRESENT;
  /*
   * Guarded on length exactly as the five above are, and for the reason that comment gives: a short
   * array reaching a uniform declared `MAX_POINT_LIGHTS` wide is an `INVALID_VALUE` every frame and
   * a uniform that keeps whatever it started with. For the cone that would be zeros, which is a
   * cone admitting nothing — every light in the scene switched off, silently.
   */
  const directions =
    (lights.lightDirections?.length ?? 0) >= MAX_POINT_LIGHTS * 3
      ? (lights.lightDirections as Float32Array)
      : NO_DIRECTIONS;
  const coneCos =
    (lights.lightConeCos?.length ?? 0) >= MAX_POINT_LIGHTS * 2
      ? (lights.lightConeCos as Float32Array)
      : OPEN_CONES;
  const iesProfiles =
    (lights.lightIesProfiles?.length ?? 0) >= MAX_POINT_LIGHTS
      ? (lights.lightIesProfiles as Float32Array)
      : NO_PROFILES;
  /* Guarded on length like the five above, and for that comment's reason: a short array reaching a
     uniform declared `MAX_POINT_LIGHTS` wide is an `INVALID_VALUE` every frame and a uniform that
     keeps whatever it started with — which here would be a stale reference axis, and a fixture
     whose pattern points somewhere nobody asked for. */
  const iesAxes =
    (lights.lightIesAxes?.length ?? 0) >= MAX_POINT_LIGHTS * 3
      ? (lights.lightIesAxes as Float32Array)
      : NO_IES_AXES;
  const cookies =
    (lights.lightCookies?.length ?? 0) >= MAX_POINT_LIGHTS
      ? (lights.lightCookies as Float32Array)
      : NO_COOKIES;
  /*
   * Said once, because a consumer who has done this wants to know and does not want it every
   * frame. It is the diagnostic that was missing: the symptom is "the highlights look wrong",
   * which leads nowhere, and the cause is one array the caller forgot to bind.
   */
  if (
    !warnedShortArrays &&
    (positions === NO_POSITIONS || radii === POINT_SOURCES || sourceRadii === POINT_SOURCES)
  ) {
    warnedShortArrays = true;
    console.warn(
      `bindPointLights: lightCount is ${count} but at least one light array is shorter than ` +
        `MAX_POINT_LIGHTS (${MAX_POINT_LIGHTS}). Those lights are being drawn unlit or as ` +
        'points. Bind every array from the same PointLightBuffer: positions, colors, radii, ' +
        'sourceRadii and weights.',
    );
  }
  out.positions = positions;
  out.colors = colors;
  out.radii = radii;
  out.sourceRadii = sourceRadii;
  out.weights = weights;
  out.directions = directions;
  out.coneCos = coneCos;
  out.iesProfiles = iesProfiles;
  out.iesAxes = iesAxes;
  out.cookies = cookies;
  return out;
}
