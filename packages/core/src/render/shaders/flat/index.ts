import { resolveConditionals } from '../conditionals.ts';
import { OCTAHEDRAL_GLSL } from '../octahedral.ts';
import { PROBEGRID_GLSL } from './probeGrid.ts';
import { TANGENT_FRAME_GLSL } from '../tangentFrame.ts';
import { preambleGlsl } from './preamble.ts';
import { LOBES_GLSL } from './lobes.ts';
import { POINTSHADOW_GLSL } from './pointShadow.ts';
import { DIRECTIONALSHADOW_GLSL } from './directionalShadow.ts';
import { MORPH_GLSL } from '../morph.ts';
import { SKINNING_GLSL } from '../skinning.ts';
import { SURFACE_GLSL } from './surface.ts';
import { MAIN_GLSL } from './main.ts';
import { CHANNEL_ATTRIBUTE, CHANNEL_BEND } from '../vertexChannel.ts';
import { FULL_LIGHT_BUDGET, type LightBudget } from '../../uniformVectorBudget.ts';

/**
 * Flat-shaded vertex colours with one dominant directional source, ambient,
 * point lights, emissive geometry, directional + omnidirectional shadows and
 * the shared atmospheric medium. Colour comes from vertex data and shader
 * maths; no image assets are involved.
 */
const FLAT_VERT_SOURCE = `#version 300 es
layout(location = 0) in vec3 aPosition;
layout(location = 1) in vec3 aNormal;
layout(location = 2) in vec3 aColor;
layout(location = 3) in float aEmissive;
layout(location = 4) in float aSpecular;
layout(location = 5) in vec2 aUv;
layout(location = 6) in vec3 aEmissiveColor;
layout(location = 7) in float aRoughness;
layout(location = 8) in float aGrain;
layout(location = 9) in float aRelief;
/**
 * Which way is along the texture, four floats a vertex.
 *
 * xyz is the tangent and w is the bitangent sign, which is what a mirrored UV island needs: an
 * artist mapping the left and right of a model onto one patch gives one side a flipped frame, and
 * a bitangent computed without the sign lights that side inside out. See geometry/tangents.ts.
 *
 * Location 10 because that is where both backends already upload it — buffers.ts lists it and
 * mesh.ts attaches it — and nothing consumed it until now.
 */
layout(location = 10) in vec4 aTangent;
#if SKINNED
${SKINNING_GLSL}
#endif

uniform mat4 uViewProj;
/** 1 when the mesh carries a tangent frame. See vHasTangents. */
uniform int uHasTangents;
uniform mat4 uLightViewProj;
/**
 * How often the surface texture repeats across this mesh's UV range, per axis.
 *
 * Per-draw rather than baked into vertex data, so geometry built once in metres can be
 * textured at whatever density a material wants without rebuilding it — and so the same
 * wall mesh can carry a fine tile in one biome and a coarse one in another. Ignored
 * when no texture is bound.
 */
uniform vec2 uUvScale;

/*
 * **Placement and tint are declared last of the shared uniforms, and the position is the
 * requirement** — the same requirement, and for the same reason, that morph's uniforms are
 * declared after everything below.
 *
 * A uniform block is packed in declaration order and the renderer writes it by offset. The
 * instanced variant does not declare these two at all, so anything declared *after* them moves
 * when they go: with uModel second, the instanced block put uHasTangents at 64 where the plain
 * one has it at 128, and a renderer writing by the plain table would have written the tangent
 * flag into the model matrix. Measured, not feared — that is what the generated bindings said
 * before this block moved down here.
 *
 * Declared last, every field the two variants share keeps the offset it had, and the instanced
 * block is simply shorter.
 */
#if INSTANCED
/**
 * One instance's placement, four vec4 columns because GLSL ES 3.00 has no mat4 attribute, and
 * its tint.
 *
 * Locations 11 to 15, which is exactly the five left once the base mesh has spent eleven of
 * WebGL2's guaranteed sixteen.
 *
 * What it gives up is skinning: 11 and 12 are the joint indices and weights, so a draw cannot be
 * both, and flatVert refuses the pair rather than silently dropping one of them. Morphing goes
 * with it, for a different reason — a morph weight is per draw, so thirty instances would wear
 * one expression between them, which is a wrong picture rather than a refused one.
 *
 * What would make it wrong is a twelfth base attribute. The escape hatch is to carry the tint in
 * the w lanes of these four columns, which an affine matrix leaves unused, at the cost of
 * narrowing this to affine transforms and making a projective one silently wrong.
 */
layout(location = 11) in vec4 aInstanceModel0;
layout(location = 12) in vec4 aInstanceModel1;
layout(location = 13) in vec4 aInstanceModel2;
layout(location = 14) in vec4 aInstanceModel3;
layout(location = 15) in vec3 aInstanceTint;
#else
uniform mat4 uModel;
/**
 * Per-draw colour multiplier. White is the identity and the default, so nothing that
 * does not ask for one changes by a floating-point bit.
 *
 * Exists because colour in this engine is *vertex data* — that is what makes the whole
 * world a single flat-shaded draw call — and vertex data cannot answer a question about
 * the current frame. A caller that wants a mesh to take on a colour it learns at runtime
 * had only one option before this: rebuild the geometry, which for anything per-frame is
 * absurd. One uniform gives that whole class of effect a home without touching the
 * payload rule: still no textures, still colour from vertices, just scaled.
 */
uniform vec3 uTint;

/*
 * **The per-vertex channel lives in this branch and not above it.** Location 13 is
 * aInstanceModel2 in the instanced variant and one location cannot hold both, so an instanced
 * draw compiles no channel at all -- and InstancedMesh refuses a mesh that carries one, so the
 * absence is a loud error at construction rather than leaves that quietly never move.
 *
 * Declared after uModel and uTint and before the morph block, which is what keeps every variant
 * agreeing about where the shared uniforms sit: the instanced variant drops these five along with
 * the two above it, and a dropped field moves nothing. flatPass.ts asserts exactly that.
 */
${CHANNEL_ATTRIBUTE}
${CHANNEL_BEND}
#endif

/*
 * **After every uniform above it, and the position is the requirement.** A uniform block is packed
 * in declaration order, so morph's four uniforms declared *before* uViewProj move the offset of
 * every field the renderer already writes — and the renderer writes them by offset. That does not
 * fail: it puts the model matrix where the view projection should be and draws a scrambled frame.
 * Declared last, every shared field keeps the offset it had and all four vertex variants agree
 * about the block they share.
 */
#if MORPHED
${MORPH_GLSL}
#endif

out vec3 vNormal;
out vec3 vColor;
out vec3 vWorldPos;
out float vEmissive;
out float vSpecular;
out vec4 vLightPos;
out vec2 vUv;
out vec3 vEmissiveColor;
out float vRoughness;
out float vGrain;
out float vRelief;
out vec4 vTangent;
/**
 * How much of the directional term this vertex receives, and how opaque it is.
 *
 * Declared in every variant, including the instanced one that carries no channel: that variant
 * writes the neutral 1.0 for both, so the fragment stage reads one shape whatever drew it and
 * needs no permutation of its own.
 *
 * vSkyDirect scales the directional term and never the albedo, which is the whole reason it is a
 * lane rather than something folded into vColor. A sky factor in the vertex colour multiplies
 * ambient and sun together, so an enclosed face is darkened twice -- once for having no sky, once
 * for the ambient it should still have received. See MeshData.channel.
 */
out float vSkyDirect;
out float vAlpha;
/*
 * How much medium a refracting surface has behind this vertex, as a multiplier on the thickness
 * the draw states. The channel's .w lane, which 3.42.0 declared reserved and unread.
 *
 * It costs a varying and no attribute, where a fifteenth attribute would have spent one of the
 * two vertex locations left. Absent means 1.0, so a mesh with no channel refracts at exactly the
 * thickness its draw asked for.
 */
out float vThickness;
/**
 * Whether aTangent is a real frame or the absent-attribute constant.
 *
 * vertexDefaults.ts hands a mesh without tangents (1, 0, 0, 1) — a usable frame rather than a
 * sentinel, because a zero tangent normalises to a NaN and a NaN in a fragment takes the pixel
 * with it. So the attribute cannot report its own absence and the renderer has to.
 *
 * flat, because there is nothing to interpolate: it is one value for the whole draw.
 */
flat out int vHasTangents;

void main() {
  /*
   * **Morph before skin, and the order is the definition.** A morph target deforms the *bind pose*
   * — an expression on a face the skeleton has not moved yet — and the skeleton then carries that
   * shape wherever the joint goes. Skinning first would deform the posed vertex, so an expression
   * would drift as a limb moved.
   */
#if MORPHED
  vec3 basePosition = aPosition + morphOffset();
#else
  vec3 basePosition = aPosition;
#endif
#if SKINNED
  /*
   * The skin matrix is applied in model space, before uModel, because a palette entry already
   * carries the joint's inverse bind — it takes a vertex from the model's bind pose to where the
   * joint has moved it, and uModel then places the whole character.
   *
   * The normal takes the same upper 3x3. **Uniform joint scale is assumed**: a non-uniformly
   * scaled joint wants the inverse transpose, and this is not it, so such a joint lights slightly
   * wrong rather than being wrong in shape. What would make it right is a second palette of
   * inverse transposes, which doubles the texture — not worth it until a rig that squashes asks.
   */
  mat4 skin = skinMatrix();
  vec4 local = skin * vec4(basePosition, 1.0);
  vec3 localNormal = mat3(skin) * aNormal;
#else
  vec4 local = vec4(basePosition, 1.0);
  vec3 localNormal = aNormal;
#endif
#if INSTANCED
  mat4 model = mat4(aInstanceModel0, aInstanceModel1, aInstanceModel2, aInstanceModel3);
  vec3 tint = aInstanceTint;
#else
  mat4 model = uModel;
  vec3 tint = uTint;
#endif
  vec4 world = model * local;
  /*
   * **The bend lands here, before vWorldPos, vLightPos and gl_Position read it.** All three have
   * to see the same displaced vertex: a fragment shaded at one position and shadow-tested at
   * another self-shadows as the gust changes, which is a defect that only appears in motion.
   */
#if INSTANCED
  vec3 bent = world.xyz;
#else
  vec3 bent = channelBend(world.xyz, aChannel.x);
#endif
  world = vec4(bent, world.w);
  vWorldPos = world.xyz;
  // Rotation/translation-only models (our case): mat3 is a valid normal matrix.
  vec3 worldNormal = mat3(model) * localNormal;
  vNormal = worldNormal;
  vLightPos = uLightViewProj * world;
  vColor = aColor * tint;
  vEmissive = aEmissive;
  vSpecular = aSpecular;
  vUv = aUv * uUvScale;
  vEmissiveColor = aEmissiveColor;
  vRoughness = aRoughness;
  vGrain = aGrain;
  vRelief = aRelief;
  vTangent = aTangent;
#if INSTANCED
  /* No channel on this path; the neutral values are what every mesh read before it existed. */
  vSkyDirect = 1.0;
  vAlpha = 1.0;
  vThickness = 1.0;
#else
  vSkyDirect = aChannel.y;
  vAlpha = aChannel.z;
  vThickness = aChannel.w;
#endif
  vHasTangents = uHasTangents;
  gl_Position = uViewProj * world;
}
`;

/** What the flat *vertex* stage compiles, as opposed to what it decides per frame. */
export interface FlatVertexOptions {
  /**
   * Whether this variant reads morph deltas and adds them to the bind-pose position.
   *
   * The vertex stage's second axis, which takes it from two variants to four, for **1,674 gzipped
   * bytes** against the 246,925 one more *fragment* flag costs. §3.2 of the plan asked for a
   * re-measurement before adding this on the assumption four diverging variants would dedupe far
   * worse than two; they dedupe somewhat worse, which is a different answer from the one feared.
   */
  readonly morphed: boolean;
  /**
   * Whether this variant reads a joint palette and moves the vertex by it.
   *
   * A permutation rather than a uniform gate, and the difference is measured rather than argued.
   * The vertex shader had no permutation axis at all until skinning, so a second variant costs
   * **1,118 bytes gzipped**, measured on the regenerated file. The two strings are 4.4 KB and
   * mostly alike, so deflate's 32 KB window dedupes most of it. One more *fragment* flag costs
   * **246,925** by the same measurement, because a fragment permutation is larger than that
   * window and sixteen copies cannot dedupe — so this is 0.45% of what the rule is written about.
   *
   * The estimate before it was built was 357, taken by duplicating the existing string with a
   * hand-written skinning body spliced in. It was a floor and is recorded as one: naga's real
   * output carries the palette binding, two more entry-point parameters and its own temporaries,
   * which the hand-written delta did not model. Three times an estimate is worth knowing about;
   * three orders of magnitude is what the decision turned on, and that did not move. So the 2^n rule `ARCHITECTURE.md` §1 states is a fact about the fragment
   * corpus and not about permutation itself.
   *
   * What a uniform gate would have cost instead is a branch on every vertex of every static mesh
   * in the engine, forever, for a feature most scenes never use. What would make the permutation
   * wrong is a second vertex flag: four diverging variants dedupe less well than two, so
   * re-measure before adding one.
   */
  readonly skinned: boolean;
  /**
   * Whether placement and tint arrive once per instance instead of once per draw.
   *
   * Excludes `skinned`: the joint attributes and the instance matrix want the same locations.
   */
  readonly instanced: boolean;
}

/**
 * The flat vertex shader, built for one variant.
 *
 * `resolveConditionals` cuts the skinning prelude and both attribute declarations out entirely
 * when `skinned` is false, so an unskinned pipeline declares locations 11 and 12 nowhere and a
 * driver is never handed a palette sampler it cannot reach.
 */
export function flatVert(options: FlatVertexOptions): string {
  if (options.skinned && options.instanced) {
    throw new Error(
      'flatVert: a variant cannot be both skinned and instanced — the joint attributes and the ' +
        'instance matrix want locations 11 and 12, and WebGL2 guarantees only sixteen in all.',
    );
  }
  if (options.morphed && options.instanced) {
    throw new Error(
      'flatVert: a variant cannot be both morphed and instanced — a morph weight is per draw, ' +
        'so every instance of the batch would wear one expression between them.',
    );
  }
  return resolveConditionals(
    FLAT_VERT_SOURCE,
    { SKINNED: options.skinned, MORPHED: options.morphed, INSTANCED: options.instanced },
    'flatVert',
  );
}

/** What the flat pass *compiles*, as opposed to what it decides per frame. */
export interface FlatShaderOptions {
  readonly pointShadows: boolean;
  readonly directionalShadows: boolean;
  /**
   * Whether the mirror direction samples a baked cubemap of the scene.
   *
   * Cut out of the source rather than left in and multiplied by zero, and that is a
   * correctness matter rather than a saving. The lit pass already binds sixteen texture
   * units, which is exactly what WebGL2 guarantees, so a seventeenth sampler that is
   * *declared* would default to unit 0 and share it with a `sampler2D` shadow map. Two
   * sampler types on one unit is undefined at best and an INVALID_OPERATION at worst, for
   * a fetch whose result was going to be discarded.
   */
  readonly environmentProbe: boolean;
  /**
   * Whether the night-side emissive term is compiled in at all.
   *
   * **Cut out rather than multiplied by zero, and that is measured rather than tidiness.** The
   * term names `emissiveTint` and `vEmissive`, which the ordinary emissive line above it also
   * names, and giving those a second consumer lets the compiler re-plan the arithmetic they
   * share. Held on the gilded chamber with the amount at 0, against the build before the term
   * existed: **109 pixels of 750,080 moved**, mean delta 17, where a shadow tap sat exactly on
   * its boundary and flipped sides on an emissive surface.
   *
   * Isolated by elimination rather than guessed. The uniform declared and never used moves 0
   * pixels; the branch present with an empty body moves 1, which is that scene's own floor; a
   * body naming nothing the emissive line names moves 0; the real expression moves 109. So the
   * cost is the operands, and the only way to charge nothing for a feature nobody asked for is
   * for its instructions not to be there.
   */
  readonly nightEmissive: boolean;
  /**
   * How many point lights this build declares room for. `MAX_POINT_LIGHTS` when absent.
   *
   * **Not a permutation axis and not a picture setting: a way to fit the uniform grid.** Ten of
   * this shader's uniform arrays are sized by it with point shadows off and twenty with them on,
   * and GLSL ES gives an array one row of the grid per element whatever its base type — so
   * `uniform float uLightRadius[16]` costs the same sixteen rows a `vec3` array of sixteen does.
   * At the full budget the lit fragment stage declares **440** rows with point shadows and **248**
   * without; an Adreno 740 offers **256** and WebGL2 guarantees only **224**. So a phone could not
   * link this shader at all, and switching point shadows off — the only lever a consumer had — pays
   * a whole feature and still does not reach a conforming device.
   *
   * Lowering it costs lights, which is a picture decision, and that is why it is stated rather
   * than derived: 8 lights and 2 rectangles is 252 rows **with** point shadows compiled in.
   *
   * **WebGL2 only in effect.** The generated WGSL is built at the full budget and committed, and
   * WebGPU has no per-stage uniform-vector ceiling to be short of — its whole block is about 7 KB
   * against a 64 KB guaranteed binding size. A consumer that sets this and lands on WebGPU gets
   * the full budget, which is the better picture and the one the device can afford.
   */
  readonly maxLights?: number;
  /** How many rectangular emitters this build declares room for. `MAX_AREA_LIGHTS` when absent. */
  readonly maxAreaLights?: number;
}

/**
 * The flat fragment shader, built for one quality profile.
 *
 * A permutation rather than a constant, because a profile with shadows off was still
 * compiling every line of shadow code it could never reach: ten `samplerCube` uniforms, a
 * ten-way branch chain over them, a 190-line cubemap filter and two PCF loops. GLSL has no
 * way to prove at compile time that `uPointShadowIndex[k]` is always -1, so none of it is
 * eliminated — it becomes register pressure and sampler state paid by every fragment of
 * every frame, in a shader whose author had already switched the feature off.
 *
 * That is ordinary waste on most parts and not ordinary on all of them. On a Radeon RX
 * 9070 XT (RDNA4, Mesa 25.2.8) a dense interior world drawn with the full shader faults the
 * GPU within seconds — an `SQC (data)` page fault, then a `gfx_0.0.0` ring timeout and a
 * driver reset that takes the WebGL context with it. The fault scales with fragment count:
 * a quarter of the pixels bought four times the survival time, and the same scene under
 * the renderer this replaced never faults at all. A driver should not fault whatever it is
 * handed, so that half is a driver bug worth reporting — but a shader carrying five times
 * the work it needs is ours, and this is the half we own.
 *
 * `#if` rather than stripping by hand, so the enabled path stays one readable shader and
 * the disabled one is genuinely absent rather than merely unreachable.
 */
/**
 * The fragment shader, assembled from its sections.
 *
 * The sections concatenate in exactly the order they occupied when this was one file, and
 * `flatSource.test.ts` is what holds that: sixteen permutations pinned by hash and one in
 * full. A reordering here changes the picture, and the snapshot is what says it has not.
 */
export function flatFrag(options: FlatShaderOptions): string {
  /*
   * `??` per field rather than a spread over the defaults, because a spread copies a key whose
   * value is an explicit `undefined` and destroys the default under it — which is what 3.60.2 was.
   */
  const budget: LightBudget = {
    maxLights: options.maxLights ?? FULL_LIGHT_BUDGET.maxLights,
    maxAreaLights: options.maxAreaLights ?? FULL_LIGHT_BUDGET.maxAreaLights,
  };
  /*
   * Refused rather than clamped, at the only moment anybody can act on it. A budget of zero
   * declares `uniform vec3 uLightPos[0]`, which does not compile, and a fractional one interpolates
   * `[7.5]` into the source — both arrive as a shader compile error naming a line nobody wrote.
   */
  for (const [name, value] of [
    ['maxLights', budget.maxLights],
    ['maxAreaLights', budget.maxAreaLights],
  ] as const) {
    if (!Number.isInteger(value) || value < 1) {
      throw new Error(
        `flatFrag: ${name} must be a whole number of at least 1, not ${String(value)} — it is an ` +
          `array size interpolated straight into the shader.`,
      );
    }
  }
  return resolveConditionals(
    /*
     * Joined with a newline, not concatenated bare. Each section holds the lines it owned
     * and no trailing break, so a bare `+` would run the last line of one section into the
     * first line of the next — which is a GLSL syntax error at best and a changed shader at
     * worst. The snapshot caught it on the first run.
     */
    [
      preambleGlsl(budget),
      /*
       * **Before `LOBES_GLSL`, and that position is a correction rather than a preference.**
       *
       * This used to sit between `LOBES_GLSL` and `POINTSHADOW_GLSL` under a comment saying it was
       * "outside every `#if`". It was not: `LOBES_GLSL` opens a conditional that
       * `DIRECTIONALSHADOW_GLSL` closes, so everything between them is inside it, and `octEncode`
       * was compiled only into the permutations with point shadows. Nothing noticed, because the
       * only caller was `pointShadow`, which is inside the same arm.
       *
       * A probe grid calls `octInsetUv` from an arm that has nothing to do with shadows, so the
       * claim had to become true. Here it is: the preamble balances its own conditionals, so this
       * is at depth zero, and it is still declared before `pointShadow` uses it.
       */
      OCTAHEDRAL_GLSL,
      LOBES_GLSL,
      POINTSHADOW_GLSL,
      DIRECTIONALSHADOW_GLSL,
      SURFACE_GLSL,
      /*
       * **Here because this is depth zero, which is what the chunk needs and where it was not.**
       *
       * Placed after `OCTAHEDRAL_GLSL` it landed inside the conditional `LOBES_GLSL` opens, so
       * `gridIrradiance` was compiled out of every permutation without point shadows while `main`
       * still called it — glslang answering "no matching overloaded function found" for a function
       * whose definition was in the source, which is the same failure the note below records.
       * Measured by counting `#if` against `#endif` per chunk rather than by reading them.
       */
      PROBEGRID_GLSL,
      /*
       * **Immediately before `MAIN_GLSL`, and the position is the requirement.**
       *
       * These chunks are not a flat list: several of them open an `#if` that a later one closes,
       * so a chunk placed between two of them lands *inside* a conditional. Put beside
       * `OCTAHEDRAL_GLSL` this was inside `#if POINT_SHADOWS` and compiled out of all eight
       * permutations without them — glslang answering "no matching overloaded function found" for
       * a function whose definition was there in the source. Here it cannot be: `main` follows,
       * and `main` is unconditional by construction.
       */
      TANGENT_FRAME_GLSL,
      MAIN_GLSL,
    ].join('\n'),
    {
      POINT_SHADOWS: options.pointShadows,
      ENVIRONMENT_PROBE: options.environmentProbe,
      NIGHT_EMISSIVE: options.nightEmissive,
      DIRECTIONAL_SHADOWS: options.directionalShadows,
    },
    'flat',
  );
}
