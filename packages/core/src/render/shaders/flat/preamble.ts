/** Version, inputs, uniforms and the defines the rest of the fragment shader is written against. */
import { COOKIE_TILE } from '../../lightBudget.ts';
import {
  CLUSTER_TEXELS,
  CLUSTER_X,
  CLUSTER_Y,
  CLUSTER_Z,
  LIGHT_REGION_TEXELS,
  LIGHT_TEXELS,
  MAX_LIGHTS_PER_CLUSTER,
  TABLE_WIDTH,
} from '../../clusteredLights.ts';

/**
 * How much roughness a relieved or normal-mapped surface gains per unit of relief.
 *
 * Exported because the GPU-driven pipeline widens its roughness by a normal map's strength the way
 * this shader does, and one number read by two shaders is a number that cannot drift between them.
 */
export const RELIEF_ROUGHNESS = 0.35;
import { MAX_SHADOW_FILTER_TAPS } from '../../renderQuality.ts';
import type { LightBudget } from '../../uniformVectorBudget.ts';
import { FOG_GLSL } from '../fog.ts';

/**
 * The preamble, built for one light budget.
 *
 * **A function rather than the constant it was, and the budget is why.** `MAX_LIGHTS` and
 * `MAX_AREA_LIGHTS` size twenty and fourteen uniform arrays between them, and an array costs a
 * whole row of the uniform grid per element whatever its base type — so these two numbers are
 * most of what the lit shader spends against `MAX_FRAGMENT_UNIFORM_VECTORS`, and on a part that
 * offers 256 of them they are the difference between a program that links and a black page. See
 * `uniformVectorBudget.ts` for the counting and for the ladder the renderer walks.
 *
 * Rebuilt per call rather than memoised: it is 0.84 ms for the whole fragment source, measured,
 * and a renderer builds it once at construction.
 */
export function preambleGlsl({ maxLights, maxAreaLights }: LightBudget): string {
  return `#version 300 es
precision highp float;

in vec3 vNormal;
in vec3 vColor;
in vec3 vWorldPos;
in float vEmissive;
in float vSpecular;
in vec4 vLightPos;
in vec2 vUv;
in vec3 vEmissiveColor;
in float vRoughness;
/*
 * How far a bump may tilt the shading normal, and how much roughness that tilt is worth.
 *
 * A surface whose normal wanders cannot hold a highlight narrower than the wander, so the
 * roughness has to grow with the relief or the picture is sparkle. Stated as a constant pair
 * because the amplitude is known here rather than measured off the screen.
 */
#define RELIEF_TILT 1.6
#define RELIEF_ROUGHNESS ${RELIEF_ROUGHNESS}
/**
 * The furthest a texture-derived bump may turn the shading normal, as a tangent.
 *
 * 1.0 is 45°. See the cap's own comment at the sampling site for why a limit has to exist at
 * all: past this the perturbation is the same size as the surface it perturbs, and what comes
 * out is decided by the last bits of a screen-space derivative rather than by the picture.
 */
#define RELIEF_MAX_TILT 1.0
in float vGrain;
in float vRelief;
in vec4 vTangent;
/*
 * **Declared after vTangent because the vertex stage declares them there.**
 *
 * GLSL ES links varyings by *name*, so on WebGL2 the order is free and this pair sat above
 * vTangent for a whole build without anything going wrong. The generated path does not: GLSL to
 * SPIR-V assigns varying locations by *declaration order*, so a stage that lists them in a
 * different order hands WebGPU a vec4 where it expects a float.
 *
 * The failure is total and silent in the picture -- "The component count (4) of the vertex output
 * at location 11 is different from the component count (1) of the fragment input at location 11",
 * on a pipeline that is then never created, so the backend draws nothing at all while WebGL2 is
 * pixel-perfect. Found by this row's own check on its first WebGPU run.
 *
 * **The rule this is an instance of: the two stages' varying blocks are one list in two places.**
 * Adding a varying to one and not the other in the same position is a WebGPU-only defect that no
 * WebGL2 capture can show.
 */
in float vSkyDirect;
in float vAlpha;
/*
 * The refraction thickness lane. **Declared here in the position the vertex stage declares it**,
 * which is the rule 3.42.0 paid for: GLSL links varyings by name so WebGL2 does not care, and the
 * generated path assigns locations by declaration order, so a stage that lists them differently
 * hands WebGPU a mismatched component count and no pipeline is created at all.
 */
in float vThickness;

/*
 * Refraction: the colour the frame had already drawn when the first refracting draw arrived.
 *
 * **A uniform and a branch, never a permutation.** One more flatFrag axis is about 247 KB gzipped
 * paid by every consumer whether or not they refract, against 19.8 KB for a branch -- which is the
 * price table Track D's three shipped rows measured.
 *
 * uRefractStrength at 0 is every draw that shipped before this existed, and it is the default, so
 * the sampler is bound to an empty texture and read nowhere on a frame that refracts nothing.
 */
uniform sampler2D uRefractScene;
uniform float uRefractStrength;
uniform vec3 uRefractTint;
uniform float uRefractThickness;
flat in int vHasTangents;

/**
 * Surface colour from an image the consumer supplied, multiplied into the vertex colour.
 *
 * The engine still ships and fetches no image assets — see surfaceTexture.ts. What this
 * samples is whatever the caller handed over, which for a procedurally generated canvas
 * is zero payload and no pipeline, exactly as vertex colour is.
 *
 * Multiplied rather than replacing, so vertex colour keeps working as the per-surface
 * tint it already is: one greyscale tile image lit by different vertex colours is how a
 * biome recolours a whole world without a second texture, and a mesh whose texture is
 * white shades identically to one with no texture at all.
 */
uniform sampler2D uAlbedo;
/** 0 leaves every textured path unevaluated, for the majority of geometry with no image. */
uniform int uAlbedoEnabled;
/**
 * Alpha below which a textured fragment is thrown away entirely, 0 to disable.
 *
 * The billboard case: a face, a leaf, a sign is an image with a *shape*, and drawing its
 * transparent corners as opaque black is the difference between a creature floating in
 * the dark and a rectangle with a creature on it. A cutout rather than blending because
 * these are depth-writing world geometry — blending them would need sorting, and a hard
 * edge is what a cutout is for.
 *
 * Zero by default, so a texture with no alpha to speak of costs one compare and nothing
 * else changes.
 */
uniform float uAlbedoCutout;

/**
 * A normal map, in the surface's own space.
 *
 * highp for the reason the depth samplers give: a lowp sampler may hand back eight bits, and eight
 * bits of a direction is a surface quantised into visible facets.
 *
 * Sampled linear and never sRGB. These bytes are a direction, not a colour; decoding them as
 * display values bends every normal toward the surface and reads as a green tint over everything.
 * SurfaceTextureOptions.colorSpace already defaults to linear and says why.
 */
uniform highp sampler2D uNormalMap;
/**
 * How hard the map turns the shading normal. 0 is no map at all, and gates the whole block.
 *
 * A uniform rather than a permutation flag, following uAlbedoEnabled: a fifth boolean would take
 * the exhaustive permutation sweep from sixteen shaders to thirty-two, and the generated WGSL that
 * consumers bundle as source from 766 KB to about 1.5 MB. A permutation is the right tool for the
 * shadow samplers, where a profile with shadows off should declare none of them; it is the wrong
 * tool for one image on a shader that already declares one.
 */
uniform float uNormalStrength;

/**
 * Occlusion, roughness and metallic in one image. glTF's packing, because that is what an import
 * carries: R is occlusion, G roughness, B metallic.
 *
 * highp for the reason the normal map gives: a lowp sampler may hand back eight bits, and eight
 * bits of roughness is a highlight that steps between widths as a surface curves.
 *
 * Sampled linear and never sRGB. These three numbers *are* the data, not a picture of it, and
 * decoding them as display values would bend every one of them toward its floor.
 */
uniform highp sampler2D uOrmMap;
/**
 * 1 when a map is bound. Gates the whole block, following uAlbedoEnabled.
 *
 * A uniform rather than a fifth permutation flag: FlatShaderOptions has four booleans and
 * flatSource.test.ts sweeps all sixteen exhaustively, so a fifth takes that to thirty-two and
 * roughly doubles the generated WGSL that consumers bundle as source, this engine having no build
 * step. A permutation is the right tool for the shadow samplers, where a profile with shadows off
 * should declare none of them. It is the wrong tool for one more image.
 */
uniform int uOrmEnabled;
/**
 * What each channel is scaled by, component-aligned with the map: r occlusion, g roughness,
 * b metallic. The alignment is the documentation.
 *
 * **r is applied as a mix from 1 and not as a multiply**, because that is what glTF's
 * occlusionTexture.strength is: 1 + strength * (texel - 1). A multiply at 0 means fully occluded,
 * which is the opposite of what a caller asking for no occlusion means.
 */
uniform vec3 uOrmScale;
/**
 * 1 when \`uEnvironment\` holds the GGX-prefiltered cube, 0 when it holds the capture's box chain.
 *
 * **Two chains whose levels mean different things, so two pieces of arithmetic downstream.** A box
 * level is a smaller picture and wants the texel-footprint floor; a prefiltered level is a lobe and
 * wants a roughness combined in quadrature. Likewise the weight: the split sum is the correct share
 * of a *prefiltered* environment and asserts an integral that was never performed over a box chain.
 *
 * A uniform rather than a permutation flag, following \`uOrmEnabled\`: a fifth boolean doubles the
 * generated WGSL every consumer bundles as source, and this is a few multiply-adds.
 */
uniform float uEnvironmentPrefiltered;

/**
 * Where a surface glows, and in what colour.
 *
 * **sRGB, unlike the two maps above it.** A normal map is a direction and an ORM map is three
 * numbers; this one is a colour somebody chose, so it is decoded the way the albedo is. Getting
 * that backwards is not subtle — an emissive map read as linear comes out visibly dark and muddy
 * where it should be saturated — but it is silent, because a glow that is too dim reads as a
 * material choice rather than as a decode.
 *
 * A uniform gate rather than a permutation flag, for exactly the reasons \`uOrmEnabled\` gives
 * above, and now with a number behind them: a fifth flag was built and measured at 49% of the
 * bundle. See \`ARCHITECTURE.md\` §1.
 */
uniform highp sampler2D uEmissiveMap;
/** 1 when a map is bound. Gates the sample, following uOrmEnabled. */
uniform int uEmissiveMapEnabled;
/**
 * What the map is scaled by, per channel. 1 is the identity and the default.
 *
 * The counterpart of \`uOrmScale\`: a factor that multiplies a texture is not a value, and this is
 * where the multiplier lives once an image supplies the shape.
 */
uniform vec3 uEmissiveScale;

#if DIRECTIONAL_SHADOWS
/*
 * The share marker below is what lets the environment probe exist, and it costs nothing.
 *
 * A device's sampler ceiling is per shader stage. This project's adapter offers exactly
 * sixteen and the widest permutation of this shader declared seventeen — one albedo, these
 * three maps, twelve point-shadow cubes and the probe's cube — so the probe was the one that
 * gave way, and reflective surfaces kept a sky-and-ground gradient on hardware that could
 * have mirrored the room.
 *
 * Every one of the fifteen shadow bindings was already one object: the WebGPU renderer hands
 * them all the same shadow sampler, and flatPass declares them all non-filtering. So
 * declaring one instead of fifteen changes nothing about how any of them is read, and takes
 * the count to three. WebGL2 has no such limit and ignores the marker, which is a line
 * comment to it.
 *
 * Marked on each declaration rather than matched on a name in the generator, deliberately.
 * flatPass records what a name rule cost: a point-shadow cube's name does not end the way the
 * three directional maps' names do, and a pattern wide enough to catch it also caught the
 * probe's colour cube — whose mip chain is its roughness, so it needs a filtering sampler and
 * cannot share a non-filtering one.
 *
 * Two things this comment may not contain, both learned here. No backticks: this is inside a
 * template literal and one of them ends the shader. And no uniform names from the probe's
 * half of the file, because a test asserts that a profile without a probe mentions them
 * nowhere — a comment is source too, and it failed that test first.
 */
uniform highp sampler2D uStaticShadowMap;  // wgsl:share shadow
uniform highp sampler2D uPeeledShadowMap;  // wgsl:share shadow
uniform highp sampler2D uDynamicShadowMap;  // wgsl:share shadow
/** 0 disables directional shadows when their source is not emitting. */
uniform float uShadowStrength;
uniform float uShadowMapSize;
/** Orthographic depth span, used to keep the residual bias in world metres. */
uniform float uShadowDepthSpan;
/** Horizontal world-space reach over which directional occlusion dissolves. */
uniform float uShadowMaxDistance;
/** 0 for a cheaper single-static-depth quality profile. */
uniform int uPeeledShadowEnabled;
/** Maximum horizontal projection per vertical metre for directional shadows. */
uniform float uShadowMaxSlope;
#endif
/** One sampling budget drives both directional and point-light filtering. */
uniform int uShadowFilterTaps;
uniform vec3 uDirectionalDir;      // surface → dominant source, normalized
uniform vec3 uDirectionalColor;
uniform vec3 uAmbient;
/**
 * Ambient arriving from below, for a hemispheric fill.
 *
 * Ambient from a single colour lights a floor and a ceiling identically, which is the
 * one thing real ambient never does: skylight comes from above and bounce comes off
 * whatever you are standing on. A room whose floor is carpet and whose ceiling is white
 * tile reads as neither if both get the same fill — the whole scene takes one flat tint.
 *
 * Defaults to uAmbient, so a consumer that sets only the one colour gets exactly the
 * uniform fill it always did.
 */
uniform vec3 uAmbientGround;
${FOG_GLSL}
uniform vec3 uCameraPos;
/** Optional world plane; reflection passes retain only the viewer's side. */
uniform vec4 uClipPlane;
uniform int uClipEnabled;
uniform float uEmissiveGain;
uniform float uNightFactor;
#if NIGHT_EMISSIVE
/**
 * Emission that only shows where the dominant light does not reach. 0 is off and is the default.
 *
 * The case it exists for is a lamp field on something that turns. Where the lights are is a
 * property of the surface, so it is authored per vertex; whether they are visible is a property
 * of where the sun is, and until this term nothing multiplied the two. Measured on the rotating
 * planet it was reported from, a patch bright enough to read on the night side was sixteen times
 * too bright on the day side, and the ratio is fixed by the lighting rather than by the value.
 *
 * The cut at the terminator is hard on purpose. Softening it is what puts the lights back on the
 * day side, which is the whole of the defect being fixed.
 */
uniform float uNightEmissive;
#endif
/**
 * How solid this draw is, 0 to 1.
 *
 * One uniform rather than a second material, for the same reason uTint is one:
 * everything else about a translucent piece of the world — its lighting, its fog,
 * its emissive — is what the flat shader already does, and duplicating the whole
 * of that to change one channel is how a renderer ends up with two shaders that
 * disagree about the sun. The caller owns the blend state; this owns the number.
 */
uniform float uOpacity;

/**
 * Whether this draw is accumulating into the order-independent transparency buffers, and
 * therefore weights its own output. 0 is every draw that is not, which is every draw on every
 * published scene.
 *
 * **A uniform rather than a permutation, and the cost is why.** Writing the accumulation and the
 * revealage from one pass needs a second fragment output, which is another \`flatFrag\` axis —
 * measured in \`scripts/wgsl.ts\` at about 247 KB gzipped, doubling the sixteen fragment variants,
 * and paid by every consumer whether or not they ever switch this on. A branch on a uniform costs
 * a compare, and the geometry is submitted twice instead. See \`orderIndependent.ts\`.
 *
 * **The revealage pass does not read this.** It draws with this at 0 and a blend of
 * \`(ZERO, ONE_MINUS_SRC_ALPHA)\`, so the colour it computes is multiplied away and only its alpha
 * reaches the target — which is exactly the point: both passes run the same code to decide what
 * alpha this fragment has, so they cannot disagree about it.
 */
uniform float uOitWeighted;

/**
 * Whether the fragment stage runs any lighting: ambient, the sun, point lights, specular,
 * reflectivity, procedural grain, emissive and the arrival highlight. 1 keeps every one of
 * them, which is what every draw did before this existed and what an opaque draw always
 * does. 0 leaves the surface exactly its own vertex colour times its own texture — three.js
 * calls that \`meshBasicMaterial\`, and it is what a flat glow shell or a flat backdrop plate
 * needs: colour and opacity, and nothing else touching it.
 *
 * **A uniform branch rather than a fifth permutation, and that is a cost decision, not a
 * style one.** \`POINT_SHADOWS\`, \`ENVIRONMENT_PROBE\` and the like are \`#if\`'d out because
 * leaving them in adds a sampler or a uniform-block member a profile without the feature
 * would still declare and still pay a bind group layout for — sixteen shader permutations
 * already, doubled again by the translucent pipeline on WebGPU. This adds no binding and no
 * block member the shader does not already carry the size of; it is one \`int\` beside
 * \`uOpacity\`, read once. And the branch it drives is on a value that is the same for every
 * fragment in one draw call, which is exactly the guarantee \`uReflectivity\` and
 * \`uAlbedoEnabled\` already lean on above: a compiler asked to predicate a whole wavefront on
 * one uniform skips the untaken side rather than computing both and discarding one, which is
 * only true because nothing here reads it through a *varying*-dependent branch.
 */
uniform int uLightingEnabled;
/**
 * Whether this draw recedes into the medium: the atmospheric haze and the underwater tint
 * both, folded together because both are the *camera's* medium rather than a property of the
 * surface — see \`mediumFog\`/\`mediumColor\` in \`fog.ts\`. 1 keeps both, matching every draw
 * before this existed.
 *
 * **Independent of \`uLightingEnabled\`, and that is the point of it being a second uniform
 * rather than the same one.** "Unlit but still fading into the haze" is a real thing to
 * want — a marker at the edge of view distance should still say it is far away even if
 * nothing about it is shaded — so coupling the two would take away a look this shader can
 * otherwise express for free. The caller chooses the combination; this only offers both.
 *
 * **The trade-off worth stating: with this at 0, the underwater tint is skipped too, which
 * is the one place this draw can now disagree with the rest of a submerged world.** Every
 * other pass applies \`uUnderwaterFactor\` unconditionally so that crossing the surface changes
 * the whole scene together — see the comment on \`waterTransmission\` below. A translucent draw
 * that asked to be unfogged is asking for its colour untouched by the medium full stop, which
 * is what "exactly as its colour says" has to mean for it; the cost is that such a draw will
 * not tint if the camera goes under water, unlike everything else in the frame.
 */
uniform int uFogEnabled;

/**
 * A pass-level scale over the grain the geometry declared, 0 to 1.
 *
 * Which surfaces are mineral is aGrain, per vertex, because it is a property of a
 * material and nothing else in the frame can know it. This is the override on top: an
 * imported model that declares nothing is drawn with the pass's own answer, and a scene
 * can dial a whole draw down without rebuilding its geometry.
 */
uniform float uGrain;
/*
 * The material's own relief: how strong, and how many bumps to a metre.
 *
 * Two numbers rather than one because they are what separates the surfaces this exists for.
 * Asphalt is coarse and deep, orange peel on paint is fine and shallow, cast concrete sits
 * between them, and the geometry carrying them is identical in all three cases. See
 * Renderer.setSurfaceRelief.
 */
uniform float uRelief;
uniform float uReliefCycles;
/**
 * How hard the bound surface texture's own luminance turns the shading normal, 0 for not at all.
 *
 * **The other half of relief, and the half a photograph can give.** \`uRelief\` invents structure
 * from noise, which is right for asphalt and concrete because their structure has no particular
 * arrangement. A rock, a bark, a beaten-metal plate does: the bumps are *where the picture says
 * they are*, and noise cannot know. This reads the height off the image already bound as colour,
 * so one photograph lights as the surface it is a photograph of.
 *
 * **The image serves both roles rather than a second sampler being added**, which is a decision
 * and not a shortcut. This shader's widest permutation already declares one sampler more than
 * this project's adapter offers, and is legal only because of the \`wgsl:share\` markers on the
 * shadow cubemaps; a second image sampler here is not the free addition it would be in a smaller
 * shader. It is also what the consumer this was built for actually does — three.js's own
 * \`bumpMap\` is a height field, and a scene handing one image to \`map\` and \`bumpMap\` together
 * is the ordinary case rather than an unusual one.
 *
 * Scaled exactly as three.js's \`bumpScale\` is, so a scene porting one carries the number across
 * rather than refitting it, and negative inverts the relief there and here alike. Not clamped to
 * 0..1 like its neighbours for the same reason: this is an amplitude against a luminance
 * gradient, not a fraction of anything.
 */
uniform float uTextureRelief;

/**
 * How much of the environment this material mirrors, 0 to 1.
 *
 * Specular here is a highlight lobe and nothing else: a surface reflected the four lamps
 * above it and not the room around it. That is why polished paint read as opaque no matter
 * how tight the lobe was made, because what makes a car body look wet is mostly the world
 * in it rather than the lights on it.
 *
 * Off by default, so every scene written before it is unchanged.
 */
uniform float uReflectivity;
/**
 * How bright the environment these surfaces reflect is, as a multiplier on it.
 *
 * **This exists because a metal has no other way to be lit.** Its Fresnel base is its own albedo,
 * so \`f0\` is 1 and the environment blend reaches full weight at every angle: what a metal shows
 * is \`environment * albedo\` and nothing else — no ambient, no direct diffuse. When the only
 * environment available is a low-resolution cube of a room, a metal is exactly as bright as that
 * room's own surfaces happen to be, and in an interior lit by a handful of lamps that is dark. A
 * consumer reported it as an imported model reading dark in every world at once, which is the tell
 * that it is not any one world's lighting.
 *
 * It is a **stand-in for image-based lighting** and it says so. A real prefiltered environment
 * carries the sky and the sources a probe of nearby geometry never sees, and it would make this
 * unnecessary; until there is one, the honest thing is one named number rather than thirty worlds
 * each re-lit around the same missing term. See the \`image-based-lighting\` row in
 * docs/CAPABILITIES.md.
 *
 * Applies to whatever the surface reflects, probe or hemispheric approximation alike, and to the
 * probe's own irradiance where a caller asked for that. **1 is the default and the identity**, so
 * every scene written before this is unchanged.
 */
uniform float uEnvironmentGain;
/**
 * The room itself, as a cubemap baked from one point, and whether one exists.
 *
 * highp because a lowp sampler may hand back eight bits and this one carries an image the eye
 * looks *at* rather than a term that modulates something else. See the depth samplers.
 *
 * Sampled at a mip level chosen by roughness, which is the cheapest honest gloss blur there
 * is: a polished surface takes level 0 and a satin one takes a blurred level, for the price of
 * a fetch rather than a pass. This is the documented exception to the textureLod rule in
 * AGENTS.md 2026-08-07 — the level is *wanted* here — and it is still an explicit level rather
 * than an implicit derivative, so the rule holds either way.
 *
 * When no probe has been baked this stays at zero and the gradient below is used instead. It is
 * gated on a flag rather than on the texture being bound, because an unbaked cubemap contains
 * whatever the driver left in it, and a car mirroring uninitialised memory is worse than a car
 * mirroring an approximation.
 */
#if ENVIRONMENT_PROBE
uniform highp sampler2DArray uEnvironment;
uniform float uEnvironmentEnabled;
uniform float uEnvironmentMaxLod;
/**
 * Texels across one probe's map at level 0, which the footprint arithmetic needs and
 * \`uEnvironmentMaxLod\` no longer carries.
 *
 * They were one number while the environment was a cube: the chain ran to a single texel a face,
 * so the top level *was* the log of the face size. The chain now stops one level below the cosine
 * convolution, so the top level is 4 while the map is 256 across, and a footprint expressed as
 * \`exp2(uEnvironmentMaxLod)\` would say sixteen. That reads as every metal in the scene being
 * under-sampled and forced to a roughness it does not have.
 */
uniform float uEnvironmentEdge;
/**
 * Whether the probe blend consults what each probe can see, and where those moments are.
 *
 * **Zero is off, and off is what every published scene is gated at.** On, each probe's visibility
 * map is a *layer of this same array*, offset past the radiance layers by the grid's probe count:
 * two moments a texel, the mean distance to geometry along a direction and the mean of its square.
 *
 * **In this array rather than a sampler of its own, and branched at run time rather than compiled
 * in or out.** A sampler of its own would be a seventeenth on a backend that guarantees sixteen
 * units — the reason \`environmentProbe\` is a permutation at all — and a permutation flag of its
 * own would double the generated shader corpus for every consumer, which \`scripts/wgsl.ts\` prices
 * at 400,728 to 597,638 gzipped bytes. Sharing the array costs neither: no new unit, no new
 * permutation, and the arithmetic sits behind a branch on this uniform the way the clustered light
 * table's does.
 */
uniform float uProbeVisibilityEnabled;
/**
 * The level holding the cosine convolution, which is the scene's diffuse ambient.
 *
 * **One binding carries both integrals**, and this is the line between them. Levels up to
 * \`uEnvironmentMaxLod\` are the reflection at the roughness each stands for; this one is the
 * room's diffuse light, convolved against the cosine at bake time. Folding them into one array is
 * what leaves WebGL2's last guaranteed texture unit free.
 *
 * **It replaces nine spherical-harmonic coefficients**, which were projected on the CPU, read back
 * off the GPU and uploaded again — a synchronous \`readPixels\` on one backend and a \`mapAsync\`
 * answering a frame or two later on the other, with a second gate uniform to cover the gap. A
 * second-order fit also could not carry a sharp source; an eight-texel octahedral image carries
 * strictly more than nine coefficients did, and it costs a fetch rather than a readback.
 */
uniform float uEnvironmentIrradianceLevel;
/**
 * Where the probes stand, as a lattice: the first probe, the reciprocal of the step, and the
 * counts.
 *
 * **Four uniforms whatever the probe count, and that is not an economy but a requirement.** This
 * shader already declares 35 array uniforms totalling 385 uniform vectors against WebGL2's
 * guaranteed \`MAX_FRAGMENT_UNIFORM_VECTORS\` of 224, so it is 1.7x over the guarantee before a
 * probe is placed. Sixteen probes of position and extent would add about 48 vectors to a budget
 * nobody can raise. A lattice needs none: the layer index is arithmetic.
 *
 * Counts of \`(1, 1, 1)\` is a single probe, which is what every scene that bakes one environment
 * becomes, and it is not a special case anywhere below.
 */
uniform vec3 uProbeGridOrigin;
uniform vec3 uProbeGridInvSpacing;
uniform vec3 uProbeGridCounts;
/**
 * Whether the grid supplies the scene's diffuse ambient, or only its reflections.
 *
 * \`ProbeBakeOptions.irradiance\`, at grid scope. A bake used to do two things inseparably: fill
 * a cube that reflective surfaces sample, and replace every diffuse surface's ambient with the
 * room's own light. A consumer who wanted a car to mirror the village also got the whole scene
 * relit at whatever moment the bake landed, and filed it four times over two days as four
 * different bugs.
 *
 * Zero here declines the second half and the hemispheric gradient below is what lights the scene,
 * exactly as it did before any probe existed.
 */
uniform float uProbeGridAmbient;
#endif
/** A world-space box that lights up regardless of time of day (run finished). */
uniform vec3 uHighlightMin;
uniform vec3 uHighlightMax;
uniform float uHighlightGain;

/*
 * The froxel table, and the numbers needed to find a fragment's place in it.
 *
 * **Every layout constant is interpolated from \`clusteredLights.ts\` rather than written here.**
 * The binner, this shader and the WGSL kernel are three readers of one layout, and two of them
 * agreeing because both contain the number 8 is the shape of defect the conformance script exists
 * to catch. There is one definition and all three read it.
 *
 * **Declared unconditionally rather than behind a permutation, and that is a measured reversal.**
 * \`ARCHITECTURE.md\` §1 makes a feature inside the lit pass a compile-on-demand permutation, and a
 * fifth flag doubled the generated WGSL from sixteen variants to thirty-two — **914 KB to 1,906 KB
 * raw and 400,728 to 597,638 bytes gzipped, a 49% rise on every consumer including those who never
 * turn this on.** Gzip cannot dedupe near-identical copies across that span; its window is 32 KB
 * and a permutation is larger than that. So this is a runtime branch on a uniform, and what it
 * costs is stated below rather than hidden. \`ARCHITECTURE.md\` carries the finding.
 *
 * **\`texelFetch\` rather than \`texture\`, and it is not only a filtering choice.** An integer
 * texture cannot be filtered at all, so the sampler this declaration would otherwise bring is dead
 * weight against a per-stage ceiling; the \`wgsl:share\` marker gives it the shadow group's one,
 * which it never uses. It also means the 2026-08-07 rule does not apply here: \`texelFetch\` takes
 * no derivative, so reading it inside the light loop needs no explicit level and cannot be the
 * flattened-branch cost that rule is about.
 */
#define CLUSTER_X ${CLUSTER_X}
#define CLUSTER_Y ${CLUSTER_Y}
#define CLUSTER_Z ${CLUSTER_Z}
#define CLUSTER_TEXELS ${CLUSTER_TEXELS}
#define MAX_LIGHTS_PER_CLUSTER ${MAX_LIGHTS_PER_CLUSTER}
#define LIGHT_TEXELS ${LIGHT_TEXELS}
#define LIGHT_REGION_TEXELS ${LIGHT_REGION_TEXELS}
#define CLUSTER_TABLE_WIDTH ${TABLE_WIDTH}
uniform highp usampler2D uClusterTable;  // wgsl:share shadow
/**
 * The view matrix, so a fragment can find its own froxel.
 *
 * **From view space rather than from \`gl_FragCoord\`, and that is deliberate.** A WebGL2
 * framebuffer counts y upward and a WebGPU one counts it downward, so a tile row derived from the
 * fragment's window coordinate would be mirrored on one backend — the same trap the 2026-08-17
 * rule about \`dFdy\` is written for, arriving through a different door. View space has no such
 * disagreement, and it is also the space the binner works in, so the shader and the binner answer
 * the same question with the same arithmetic.
 */
uniform mat4 uView;
/** near, far, tan(fovY/2) and aspect: the four numbers the froxel grid is defined by. */
uniform vec4 uClusterFrustum;
/**
 * 1 when the light loop reads the froxel table, 0 when it reads the uniform slots.
 *
 * A uniform, so the branch is uniform control flow and every fragment in a draw takes the same
 * arm — which is what keeps it cheap and what keeps the 2026-08-07 rule satisfied. The table is
 * only ever read with \`texelFetch\`, which takes no derivative, so nothing here needs an explicit
 * level either way.
 *
 * **What this costs when it is 0**: one texture unit, one matrix and one vec4 in the block, and a
 * compare per light. What it buys is that a consumer who never enables it does not download a
 * second copy of the whole shader — see the note above the table's declaration.
 */
uniform int uClustered;

/**
 * One texel of the table, addressed by its flat index.
 *
 * The width divides both regions exactly, which is why this is a mask and a shift rather than a
 * divide — see \`TABLE_WIDTH\` for the arithmetic that guarantees it.
 */
uvec4 clusterTexel(int texel) {
  return texelFetch(
    uClusterTable,
    ivec2(texel % CLUSTER_TABLE_WIDTH, texel / CLUSTER_TABLE_WIDTH),
    0);
}

#define MAX_LIGHTS ${maxLights}
/*
 * How many times the light loop may go round.
 *
 * The clustered arm iterates a froxel's own list and the fixed arm iterates the uniform slots, so
 * the bound differs; GLSL needs a constant either way. Defined here rather than at the loop so
 * both numbers sit beside the budgets they come from.
 */
/*
 * **Both arms have the same bound, and that equality is deliberate.** There is one loop, so a
 * larger clustered cap would raise the bound for the fixed path too, and a scene that never asks
 * for froxels would carry a loop of 28 where it carries 16 today. \`MAX_LIGHTS_PER_CLUSTER\` is
 * pinned equal to \`MAX_LIGHTS\` for that reason; a test in \`textureUnitBudget.test.ts\` asserts it.
 */
#define LIGHT_LOOP_MAX MAX_LIGHTS
uniform int uLightCount;
/** 0 keeps the radius-shaped falloff; 1 is physical inverse-square with a soft cutoff. */
uniform int uLightFalloff;
uniform vec3 uLightPos[MAX_LIGHTS];
uniform vec3 uLightColor[MAX_LIGHTS];
uniform float uLightRadius[MAX_LIGHTS];
/*
 * Each light's emitter radius in metres. Zero is a mathematical point, which is what every
 * source was until a highlight narrower than a fragment turned out to be the cause of speckle
 * on glossy paint. See sphereLobe.
 */
uniform float uLightSourceRadius[MAX_LIGHTS];
/*
 * How present each light is, 0 to 1: the ramp it crosses the edge of view range on,
 * and the one it trades the last slot on. A world carries more lights than
 * MAX_LIGHTS, so membership changes as the camera moves, and without this it changes
 * by switching. See pointLightSelection.ts.
 */
uniform float uLightWeight[MAX_LIGHTS];
/**
 * Where each spot points, normalised, in world space. Unused by a light with no cone.
 *
 * Declared for every light rather than as a separate spot array, because a spot is a point light
 * with a direction and giving it arrays of its own would put a second loop in the largest shader
 * here — see \`ARCHITECTURE.md\` section 1 on what a fifth permutation cost.
 */
uniform vec3 uLightDir[MAX_LIGHTS];
/**
 * The cosine of each light's inner cone angle, then of its outer.
 *
 * A light with no cone carries -1 and -2, which makes \`smoothstep(outer, inner, dot)\` exactly 1
 * for every direction on the sphere. See \`POINT_LIGHT_COS_OUTER\`: the pair is chosen so a point
 * light collapses to the arithmetic it had rather than to something very close to it.
 */
uniform vec2 uLightCone[MAX_LIGHTS];
/**
 * Which row of the photometric atlas each light uses, or a negative index for none.
 *
 * A float rather than an int because it travels through the froxel record as one, and because the
 * shader turns it into a texture coordinate immediately anyway.
 */
uniform float uLightIesProfile[MAX_LIGHTS];
/**
 * Where each light's photometric azimuth zero points, in world space.
 *
 * **Read only by an asymmetric profile**, which is a street light or a wall washer and is almost
 * nothing else — every axially symmetric fixture ignores it, and a zero vector or one parallel to
 * the aim leaves the profile on its first plane. Orthogonalised against the light's direction in
 * the shader, so a caller hands the fixture's own forward and the aim decides the rest.
 *
 * **It cannot be derived from the direction.** There is no continuous field of unit vectors
 * tangent to a sphere, so any reference built from the aim alone flips somewhere — and the obvious
 * constructions put that flip exactly where these fixtures point, \`cross(worldUp, dir)\` being
 * singular for a light aimed straight down.
 */
uniform vec3 uLightIesAxis[MAX_LIGHTS];
/**
 * Which tile of the cookie atlas each light projects, or a negative index for none.
 *
 * A cookie is a mask the fixture throws — a window frame, a grille, foliage — and it is oriented
 * by \`uLightIesAxis\`, the same reference a photometric profile's azimuth uses, because both are
 * answering the same question about a fixture: which way is up.
 */
uniform float uLightCookie[MAX_LIGHTS];
/**
 * Photometric profiles: one row per fixture, a fixture's intensity by vertical angle across it.
 *
 * **Every row spans the same 0 to 180 degree arc**, whatever the file measured, which is what lets
 * a light carry only a row index — see \`iesProfile.ts\`. With no profile loaded this holds a
 * single row of ones, the multiplicative identity, because a declared sampler needs a complete
 * texture whether or not the branch reads it and a row of zeros would switch off every light.
 */
uniform sampler2D uIesAtlas;
/** Rows in the atlas, so a row index becomes a coordinate. At least 1. */
uniform float uIesAtlasRows;
/**
 * Horizontal planes each profile occupies, so a row is \`profile * planes + plane\`.
 *
 * **1 for an atlas with nothing asymmetric in it**, which is nearly every atlas, and the whole
 * plane path is branched away on that — see \`photometric\` in \`main.ts\`. One count for the atlas
 * rather than one per profile, because a per-profile count would need a second number in a light's
 * record to divide by, and a light's record is where space is expensive.
 */
uniform float uIesPlaneCount;
/**
 * Cookies: one row of square tiles, one tile a fixture's mask.
 *
 * **0 when no consumer has loaded one, and the whole projection is branched away on it** — a
 * \`uniform float\` is provably uniform control flow, so a scene with no cookie performs no
 * arithmetic and no fetch. With none loaded this holds a single white texel, the multiplicative
 * identity, because a declared sampler needs a complete texture whether or not the branch reads it
 * and a black stand-in would switch off every light that reached it.
 */
uniform sampler2D uCookieAtlas;
uniform float uCookieTiles;
/**
 * Half a texel of a tile, so a cookie's edge cannot reach its neighbour in the atlas.
 *
 * A row of tiles filtered bilinearly bleeds across the seam between two of them, and the seam is
 * exactly where a cone's edge lands — so the neighbour's colour would appear as a rim on every
 * cookie. Derived from \`COOKIE_TILE\` rather than written twice.
 */
#define COOKIE_INSET (0.5 / ${COOKIE_TILE}.0)
/**
 * Rectangular area lights, and how many of them are live.
 *
 * **Four, and a branch on this count rather than a shader permutation.** \`ARCHITECTURE.md\` section
 * 1 says a lit-pass feature earns a permutation only when carrying it compiled-in costs more than
 * doubling the shader corpus, and this session measured both sides of that: thirty lines of shared
 * code cost 6,215 gzipped bytes across the sixteen permutations, and fifty cost 10,517 — while the
 * fifth flag clustered lighting nearly took cost 196,910. So the whole area-light term compiled in
 * unconditionally is roughly a twentieth of what permuting it would cost, and the count being zero
 * is what makes it free at runtime.
 *
 * Four because a rectangle is a *fixture* — a window, a softbox, a panel — and a scene with more
 * than a handful is a scene that wants them baked. Raising it is a uniform-array size and an
 * iteration of the loop, exactly as \`MAX_LIGHTS\` is.
 */
#define MAX_AREA_LIGHTS ${maxAreaLights}
uniform int uAreaLightCount;
/** Centre of each rectangle, in world space. */
uniform vec3 uAreaLightPos[MAX_AREA_LIGHTS];
/** Colour times intensity, as the point lights carry it. */
uniform vec3 uAreaLightColor[MAX_AREA_LIGHTS];
/** The rectangle's in-plane axes, unit length, and its half extents along each. */
uniform vec3 uAreaLightRight[MAX_AREA_LIGHTS];
uniform vec3 uAreaLightUp[MAX_AREA_LIGHTS];
uniform vec2 uAreaLightSize[MAX_AREA_LIGHTS];
/**
 * Whether the rectangle emits from both faces, 1 or 0.
 *
 * A window is one-sided and a hanging panel is two-sided, and the difference is visible: a
 * one-sided light behind a surface must contribute nothing rather than lighting it from behind,
 * which is what an unsigned form factor would do.
 */
uniform float uAreaLightTwoSided[MAX_AREA_LIGHTS];
/** Pi, for turning a dot product into the angle a photometric row is indexed by. */
#define PI_IES 3.14159265359
/** A whole turn, for mapping an azimuth onto the plane grid. */
#define TAU_IES 6.28318530718
/** Index into the light arrays that each shadow cubemap belongs to, -1 if unused. */
/**
 * Sampled shadow maps — one per shaded light, deliberately.
 *
 * Any number below MAX_LIGHTS means some lights illuminate without occluding,
 * and *which* ones changes as the camera moves. That reads as shadows switching
 * on and off as you walk up to a lamp, which is worse than either extreme: a
 * missing shadow is merely flat, but one that appears and vanishes draws the
 * eye straight to it. Matching the two budgets is what makes the effect
 * impossible rather than rare.
 *
 * **One array texture, a layer per light, where there were twelve cubemaps.** That is
 * where eleven of WebGL2's sixteen guaranteed texture units came back from, and it is
 * also why the arrays below are indexed by the light rather than by a slot: GLSL ES
 * cannot index a sampler array with a non-constant expression, so selecting a cubemap
 * meant ten unrolled comparison arms. A layer is an ordinary integer, so it is a lookup.
 */
#if POINT_SHADOWS
/** Which array layer holds this light's shadow, or -1 for none. */
uniform int uPointShadowLayer[MAX_LIGHTS];
/*
 * **The projection each map was rendered under: \`xyz\` where from, \`w\` how far.**
 *
 * The origin is the half that is new and it is **not** the light's position. A light may drift
 * \`pointShadowRebakeDistance\` from its image before the image is re-rendered, because
 * re-baking six faces of the static world on every frame of a flicker is what made a brazier
 * the most expensive object in a scene. The ray below is built from this point rather than from
 * \`uLightPos\`, so it is the ray the picture was drawn along and the drift costs nothing.
 *
 * **It rides with the far plane because a row is a row.** A default-block \`float[N]\` spends a
 * whole uniform vector per element and uses one of its four components, so the far plane was
 * already paying for three floats it threw away — see \`uniformVectorBudget.ts\`. Declared as a
 * separate \`vec3\` array this would have cost sixteen more rows on each of the two sets, and
 * the ladder answers a 256-vector phone by halving \`MAX_LIGHTS\`: the measured price of a
 * separate array was **eight lights becoming four**. Folded in, the whole fix is free.
 *
 * **What it gives up** is that the shadow stops tracking the flame *within* the tolerance — a
 * flicker no longer nudges the shadow it casts, because the image it is read from did not move
 * either. That is the trade the tolerance was always making, now made honestly instead of by
 * reading a picture from the wrong place. **What would make it wrong** is a tolerance large
 * enough that a shadow visibly lags its light, which is a reason to lower
 * \`pointShadowRebakeDistance\` rather than to sample from a point the image cannot answer for.
 */
uniform vec4 uPointShadowProjection[MAX_LIGHTS];
uniform float uPointShadowNear[MAX_LIGHTS];
/** Emitter radius per light — drives how soft its shadows are. */
uniform float uPointShadowSize[MAX_LIGHTS];
// How present each bound map is, 0 to 1. See the ramp at the sampling site.
uniform float uPointShadowWeight[MAX_LIGHTS];
/*
 * **highp, and it is load-bearing.** GLSL ES gives a fragment shader's samplers a default
 * precision of lowp, whatever the file declares for its floats: that line is about float,
 * not about a sampler. A lowp sampler is entitled to return eight bits.
 *
 * This holds DEPTH_COMPONENT24 — see pointShadowArray.ts — carrying a radius as a fraction
 * of the light's far plane. Eight bits of that is a shadow quantised to eight steps of the
 * light's range, which reads as concentric rings around every lamp. The conversion is only a
 * multiply now rather than the perspective divide a cubemap needed, so the error is no longer
 * *magnified*; it is still eight bits where twenty-four were stored.
 *
 * The 2D shadow maps a hundred lines up already carry the qualifier, and the composite pass
 * was found reading depth at eight bits in 0.13.0. This is the same fault in the third place
 * it exists.
 */
uniform highp sampler2DArray uPointShadows;  // wgsl:share shadow

/**
 * Moving casters are separate from persistent world maps. Two live maps exist
 * only so ownership can crossfade when another light becomes nearer.
 *
 * Layers of the same array, and addressed by the light rather than by the pair, because a
 * light owns at most one of the two at a time.
 */
uniform int uLivePointShadowLayer[MAX_LIGHTS];
/** The live pair's own projection, by the same rule. See \`uPointShadowProjection\`. */
uniform vec4 uLivePointShadowProjection[MAX_LIGHTS];
uniform float uLivePointShadowNear[MAX_LIGHTS];
uniform float uLivePointShadowSize[MAX_LIGHTS];
uniform float uLivePointShadowWeight[MAX_LIGHTS];

/**
 * A rectangular area light's occlusion, in the same array a point light's lives in.
 *
 * **The same array because there is no second texture unit to put one in.** WebGL2 guarantees
 * sixteen and the lit pass binds sixteen — \`FlatShaderOptions.environmentProbe\` documents the
 * same wall from the other side, a seventeenth declared sampler silently sharing unit 0 with a
 * \`sampler2D\` shadow map. So an area shadow is a layer above the point pool rather than a
 * texture of its own, which also means **it rides \`POINT_SHADOWS\`**: a consumer whose scene is
 * lit by rectangles alone still needs that flag on, and \`RenderQuality.pointShadows\` is where it
 * is turned on. The renderer says so by name rather than drawing an unoccluded rectangle.
 *
 * Indexed by area-light slot, which is the same index the arrays above it use, because
 * \`selectAreaLights\` fills both from the caller's list in order. \`-1\` in a layer says this
 * rectangle has no image — a slot that does not cast, or one whose first bake has not landed.
 */
uniform int uAreaShadowLayer[MAX_AREA_LIGHTS];
uniform float uAreaShadowFar[MAX_AREA_LIGHTS];
uniform float uAreaShadowNear[MAX_AREA_LIGHTS];
/** How present the image is, so a first bake arrives rather than appears. */
uniform float uAreaShadowWeight[MAX_AREA_LIGHTS];
/**
 * The layer holding movers only, composed with the one above by multiplication.
 *
 * One per casting rectangle rather than a shared pair, which is where this differs from the point
 * lights above: those borrow two live maps and crossfade ownership because fifty lamps compete for
 * them, and at most \`MAX_AREA_LIGHTS\` rectangles exist, so each simply owns one. Nothing changes
 * hands, so nothing has to fade across a handover.
 */
uniform int uLiveAreaShadowLayer[MAX_AREA_LIGHTS];
uniform float uLiveAreaShadowFar[MAX_AREA_LIGHTS];
uniform float uLiveAreaShadowNear[MAX_AREA_LIGHTS];
uniform float uLiveAreaShadowWeight[MAX_AREA_LIGHTS];
#endif

/**
 * Omnidirectional shadow test against a depth cubemap.
 *
 * The comparison happens in *linear* distance, not in stored depth. Perspective
 * depth is wildly non-linear: near the far plane a bias of a few thousandths
 * spans metres of world space, which silently makes everything unshadowed. So
 * the sampled depth is converted back to a distance and compared in metres,
 * where a bias means what it looks like it means.
 */
/**
 * Twelve places on a disk across the light ray, for filtering an omnidirectional shadow.
 *
 * **These were eight, and the count is why a penumbra was stippled.** The list used to be the
 * eight corners and six faces of a cube, carried as \`vec3\` from the era when a tap offset a
 * direction by a 3D vector. Nothing has read the third component since the map became
 * octahedral — both filters take \`.xy\` — and flattening a cube's corners onto a plane makes
 * pairs of them coincide: \`(1, 1, 1)\` and \`(1, 1, -1)\` are one 2D offset, four times over. So
 * twelve taps asked eight questions and answered four of them twice, and every one of the eight
 * sat on the rim at radius 1 or 1.414 with nothing in between. A coverage estimate from a ring
 * moves in steps of two twelfths as the penumbra's edge sweeps a doubled pair across it, which
 * is the size of the speckle that was reported.
 *
 * **The replacement is the golden-angle disk this repository already uses for ambient
 * occlusion** — angle \`i\` turns of 137.5 degrees, radius \`sqrt((k + 0.5) / 12)\` — so the taps
 * are spread evenly over the area rather than crowded on the rim or at the centre, and no two
 * coincide. The nearest pair is 0.355 apart where the old set had a pair at zero.
 *
 * **The radii are dealt round rather than taken in order, and that is what makes a short filter
 * work.** \`shadowFilterTaps\` is 4, 8 or 12 and the loop below simply stops early, so every
 * prefix of this list is a filter somebody ships: in spiral order the first four taps would be
 * the four innermost and a low profile would quietly get a filter a third of the width it asked
 * for. Interleaved, the first four already span 0.21 to 0.91 of the disk's reach and sit around
 * its centre rather than to one side, which is a small filter rather than a narrow one.
 *
 * **What it gives up** is a little softness. The old set put two thirds of its taps at the
 * outermost radius, so it read the penumbra's widest part twice as often as an even disk does
 * and drew a shadow edge softer than the emitter's size calls for; an even disk is the honest
 * estimate and is very slightly crisper. **What would make it wrong** is a caller wanting the
 * filter's *reach* changed — that is \`MAX_FILTER_RADIUS\`, and the outermost tap here is 1.384
 * against the old 1.414 precisely so this change does not move it.
 */
#if POINT_SHADOWS
const vec2 PCF_OFFSETS[${MAX_SHADOW_FILTER_TAPS}] = vec2[${MAX_SHADOW_FILTER_TAPS}](
  vec2( 0.289,  0.000), vec2(-0.767,  0.703), vec2( 0.067, -0.761), vec2( 0.766,  0.999),
  vec2(-0.492, -0.087), vec2( 0.943, -0.600), vec2(-0.225,  0.836), vec2(-0.610, -1.174),
  vec2( 0.606,  0.221), vec2(-1.100,  0.454), vec2( 0.406, -0.867), vec2( 0.414,  1.321)
);
/**
 * The angle between the two tap sets a pair of neighbouring pixels uses. See \`pointShadow\`.
 *
 * Half the golden angle, because the offsets above are a golden-angle spiral: turning the whole
 * set by half a step drops the second pixel's taps between the first pixel's arms rather than
 * on top of them. Measured on the pair, the closest two of the twenty-four are 0.305 apart,
 * against 0.175 for a half turn and 0.233 for a whole golden angle — so this is the choice that
 * makes the pair's combined filter as even as the twelve it is built from.
 */
const float PCF_PAIR_TURN = 1.19998161;
#endif

/** A finite point-light shadow loses strength with the light that casts it. */`;
}
