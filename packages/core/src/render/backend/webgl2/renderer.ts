import { FrameBudget } from '../budget.ts';
import { MaterialChanges, ownsMaterial } from '../materialChanges.ts';
import { mat4 } from 'gl-matrix';
import {
  DEPTH_OFFSET_SIGN,
  GL_DEPTH_REMAP,
  MAX_DEPTH_LAYER,
  depthClearFor,
  depthOffsetForLayer,
  GL_SHADOW_REMAP,
  REVERSED_DEPTH,
  SHADOW_DEPTH_CLEAR,
  glDepthFuncEqual,
  glShadowDepthFunc,
} from '../../depthConvention.ts';
import type { FrameView } from '../../frameView.ts';
import type { ClipControlExtension } from '../../depthConvention.ts';
import type { ReadonlyMat4 } from 'gl-matrix';
import type { Camera } from '../../camera.ts';
import { PickableSet } from '../../pickable.ts';
import type { PickHit, PickableSource } from '../../pickable.ts';
import {
  TEMPORAL_HISTORY_BLEND,
  TemporalHistory,
  jitterOffset,
  jitterProjection,
} from '../../temporalAa.ts';
import { DecalPass } from '../../decalPass.ts';
import { SsrPass } from '../../ssrPass.ts';
import { GlobalMediumPass } from '../../globalMediumPass.ts';
import {
  DEFAULT_GLOBAL_MEDIUM,
  WEAK_GPU_MEDIUM_STEPS,
  mediumActive,
  resolveGlobalMedium,
} from '../../globalMedium.ts';
import type { GlobalMediumOptions } from '../../globalMedium.ts';
import { REFLECTION_EDGE_FADE, ReflectionQueue } from '../../screenSpaceReflection.ts';
import type { ReflectiveSurface } from '../../screenSpaceReflection.ts';
import { DecalQueue } from '../../decalQueue.ts';
import type { DecalProjector } from '../../decalProjector.ts';
import { OitPass } from '../../oitPass.ts';
import { OIT_MULTISAMPLE_REFUSAL } from '../../orderIndependent.ts';
import { INDIRECT_LIGHT_WEBGL2_REFUSAL } from '../../gi/probeTrace.ts';
import type { FieldSource } from '../../gi/globalField.ts';
import { TranslucentQueue } from '../../translucentQueue.ts';
import { createFrustum, frustumFromViewProjection } from '../../../math/frustum.ts';
import type { Frustum } from '../../../math/frustum.ts';
import type { Bounds } from '../../../math/bounds.ts';
import { OcclusionBuffer } from '../../occlusion.ts';
import { boundsVisible } from '../../visibility.ts';
import { createPassRegistry, drainRegistry, passAt, registerIn, unregisterIn } from '../../pass.ts';
import type { ComputeDefinition, ComputeHandle } from '../../compute.ts';
import {
  MAX_CLUSTERED_LIGHTS,
  TABLE_HEIGHT,
  TABLE_WIDTH,
  buildLightClusters,
  createClusterTable,
  type ClusterLightSet,
} from '../../clusteredLights.ts';
import type {
  PassContext,
  PassDefinition,
  PassDevice,
  PassHandle,
  PassRegistry,
} from '../../pass.ts';
import type { Vec3 } from '../../../math/color.ts';
import { clamp } from '../../../math/scalar.ts';
import { attachContextLoss } from '../../contextLoss.ts';
import { isWeakGpuFamily, webgl2RendererName } from '../../gpuCapability.ts';
import { GpuTimer } from '../../gpuTimer.ts';
import { compileProgram, uniformLocations } from '../../shader.ts';
import {
  FULL_LIGHT_BUDGET,
  type LightBudget,
  nextLightBudget,
  planLightBudget,
} from '../../uniformVectorBudget.ts';
import { FILM_FRAG, FILM_VERT } from '../../shaders/film.ts';
import { SceneTarget } from '../../sceneTarget.ts';
import type { ColourGradeLut } from '../../colourGrade.ts';
import { bloomProfileWarning } from '../../bloomChain.ts';
import {
  createEmptyTexture2D,
  createEmptyTexture2DArray,
  createEmptyTextureCube,
} from '../../emptyTexture.ts';

/**
 * How far the rush's outermost tap reaches at full strength, in UV.
 *
 * In UV rather than pixels so the smear is the same fraction of the screen at any
 * resolution — a blur measured in pixels is twice as strong on a phone at DPR 2, which is
 * exactly backwards from where the budget is.
 */
/* Shared with the other backend; see `vertexDefaults.ts`. */
/**
 * How far a camera-blur smear may reach, in UV.
 *
 * A ceiling rather than a scale: a fast turn can reproject a pixel most of the way across
 * the screen, and sampling that far turns a frame into streaks rather than into motion.
 * Beyond this the velocity is shortened and the direction kept.
 */

import type { RendererApi } from '../api.ts';
import { flatFrag, flatVert } from '../../shaders/flat/index.ts';
import { MORPH_DELTA_TEXTURE_UNIT, SKIN_PALETTE_TEXTURE_UNIT } from '../../lightBudget.ts';
import { SkinPaletteTexture } from './skinPaletteTexture.ts';

/** Shader-side encoding of `RenderQuality.outputTransform`. */
/* The codes the shader reads, stated once in `vertexDefaults.ts` for both backends. */
import { LIGHT_VOLUME_VERT, lightVolumeFrag } from '../../shaders/lightVolume.ts';
import { PANEL_FRAG, PANEL_VERT } from '../../shaders/panel.ts';
import { ReflectionProbe, cubeFaceProjection } from '../../reflectionProbe.ts';
import type { ProbeBakeOptions } from '../../reflectionProbe.ts';
import { EnvProbeArray } from '../../envProbeArray.ts';
import { ProbeGrid, SINGLE_PROBE, UNIT_STEP, WORLD_ORIGIN, sameGrid } from '../../probeGrid.ts';
import type { ProbeGridOptions } from '../../probeGrid.ts';
import { octahedralEdgeFor } from '../../prefilterEnvMap.ts';
import { EnvironmentPrefilterPass } from '../../prefilterPass.ts';
import { packIesAtlas } from '../../iesProfile.ts';
import type { AreaLightBuffer, AreaLightSource } from '../../areaLights.ts';
import { MAX_AREA_LIGHTS } from '../../areaLights.ts';
import {
  areaShadowLayerCount,
  castingRange,
  createResolvedAreaShadows,
  firstAreaShadowLayer,
  AreaShadowSet,
} from '../../areaShadowSet.ts';
import type { PhotometricProfile } from '../../iesProfile.ts';
import { equirectToCubeFaces } from '../../equirectToCube.ts';

import { SKY_FRAG, skyVertFor } from '../../shaders/sky.ts';
import {
  DEPTH_FRAG,
  DEPTH_INSTANCED_VERT,
  DEPTH_SKINNED_VERT,
  DEPTH_VERT,
} from '../../shaders/depth.ts';
import { PointShadowArray } from '../../pointShadowArray.ts';
import { ShadowMap } from '../../shadowMap.ts';
import { POINT_SHADOW_SAMPLER, PointShadowSystem } from '../../pointShadowSystem.ts';
import type { ShadowLight } from '../../pointShadowSystem.ts';
import type { SceneCasterMaterial, ShadowCasterSink, ShadowCasters } from '../../shadowCasters.ts';
import { FACE_COUNT, PointShadowMap } from '../../pointShadowMap.ts';
import { createResolvedPointShadows, DEFAULT_SOURCE_RADIUS } from '../../pointShadowImage.ts';
import {
  createBakeScratch,
  runPointShadowBakes,
  selectCastingLights,
} from '../../pointShadowBudget.ts';
import {
  DIRECTIONAL_SHADOW_UNITS,
  LIVE_POINT_SHADOW_MAPS,
  MAX_POINT_LIGHTS,
  NORMAL_TEXTURE_UNIT,
  ORM_TEXTURE_UNIT,
  POINT_SHADOW_POOL,
  POINT_SHADOW_UNITS,
  CLUSTER_TABLE_TEXTURE_UNIT,
  EMISSIVE_TEXTURE_UNIT,
  ENVIRONMENT_TEXTURE_UNIT,
  SURFACE_TEXTURE_UNIT,
  bindPointLights,
  COOKIE_ATLAS_TEXTURE_UNIT,
  REFRACT_SCENE_TEXTURE_UNIT,
  COOKIE_TILE,
  IES_ATLAS_TEXTURE_UNIT,
  bindAreaLights,
  bindAreaShadows,
  openCones,
} from '../../lightBudget.ts';
import { resolveRenderQuality } from '../../renderQuality.ts';
import type { RenderQuality, RenderQualityOptions } from '../../renderQuality.ts';
import { drawingBufferSize } from '../../drawingBuffer.ts';
import type { BufferSize } from '../../drawingBuffer.ts';
import { Mesh, createMeshIncremental } from '../../mesh.ts';
import type { IncrementalMesh } from '../../mesh.ts';
import type { MeshData } from '../../mesh.ts';
import type { MeshOptions } from '../api.ts';
import { SurfaceTexture } from '../../surfaceTexture.ts';
import type { SurfaceMaterial, SurfaceTextureOptions } from '../../surfaceTexture.ts';
import { PlumeRenderer } from '../../plumeRenderer.ts';
import { createScatterDeform, resolveScatterDeform } from '../../scatterDeform.ts';
import type { ScatterDeform } from '../../scatterDeform.ts';
import {
  DEPTH_01_TO_CLIP,
  createResolvedLightVolume,
  resolveLightVolume,
  volumeMediumGain,
} from '../../lightVolumeDraw.ts';
import type { PlumeOptions, PlumePlacement } from '../../plumeRenderer.ts';
import { WaterRenderer } from '../../waterRenderer.ts';
import type { WaterBody } from '../../waterRenderer.ts';
import { CausticsRenderer } from '../../causticsRenderer.ts';
import type { CausticSheet } from '../../causticsRenderer.ts';
import { bindAtmosphere } from '../../atmosphere.ts';
import type { Atmosphere } from '../../atmosphere.ts';
import { PlanarReflection } from '../../planarReflection.ts';
import { InstancedMesh } from '../../instancedMesh.ts';
import { ParticleBatch } from '../../particleBatch.ts';
import type { ParticleBatchOptions } from '../../particleBatch.ts';
import type { ParticleInstances } from '../../particlePool.ts';
import { BoltBatch } from '../../boltBatch.ts';
import type { BoltSegments } from '../../boltPool.ts';
import { LineBatch } from '../../lineBatch.ts';
import type { LineSegments } from '../../linePoints.ts';
import type { InstanceData } from '../../instancedMesh.ts';
import { SCATTER_DEPTH_VERT, SCATTER_FRAG, SCATTER_VERT } from '../../shaders/scatter.ts';
import { FlockRenderer } from '../../flockRenderer.ts';
import { TextRenderer } from '../../textRenderer.ts';
import { SdfTextRenderer } from '../../sdfTextRenderer.ts';
import type { SdfFont } from '../../sdfFont.ts';
import type { SdfTextStyle } from '../../sdfTextLayout.ts';
import { MOTION_BLUR_MAX_UV, RUSH_REACH_UV } from '../../vertexDefaults.ts';
import { OUTPUT_TRANSFORM_CODE } from '../../vertexDefaults.ts';
import type { RenderBackend } from '../api.ts';
import { deviceSnappedCellSize } from '../../textLayout.ts';
import type { TextStyle } from '../../textLayout.ts';
import { WindStreakRenderer } from '../../windStreakRenderer.ts';
import type { WindStreakOptions } from '../../windStreakRenderer.ts';
import type { WindField } from '../../windField.ts';
import type { FlockParams } from '../../flockRenderer.ts';
import { InstancedBatch } from './instanced.ts';
import type { MeshInstances } from '../../instances.ts';

/**
 * How many frames `firstFrameSettled` will ask before it stops asking.
 *
 * Two seconds at 120 Hz. A first frame has never taken anything like that, and a
 * driver whose fence never signals is a driver that must not be able to hold a
 * consumer's loading screen up for the rest of the session.
 */
const FIRST_FRAME_MAX_WAITS = 240;

/** Reused each frame: which shader light slot each bound cubemap serves. */

export type { ShadowCasterSink, ShadowCasters } from '../../shadowCasters.ts';

/** Lighting and atmosphere for a frame. The game decides what goes in it. */
export interface Environment extends Atmosphere {
  /** Dominant outdoor directional source: sun by day, moon by night. */
  directionalDir: Vec3;
  directionalColor: Vec3;
  ambient: Vec3;
  /**
   * Ambient arriving from below. Omitted, it matches `ambient` and the fill is uniform.
   *
   * A hemispheric fill is the difference between a room whose floor and ceiling are made
   * of different things and one where they are the same colour at different brightness.
   */
  ambientGround?: Vec3;
  /** Strength of self-illuminated geometry, once `nightFactor` lets it through. */
  emissiveGain: number;
  /**
   * **Whether self-illuminated geometry emits at all. Despite the name, this is not a clock.**
   *
   * It reads as a time of day and it is the emissive master switch: `flat.ts` multiplies every
   * emissive term by it, so at 0 nothing in the world glows, whatever `emissiveGain` says and
   * whatever a mesh declared. The name is accurate for the case it was written for, an outdoor
   * world whose lamps come on at dusk, and it is a trap for every other one.
   *
   * **A daylit scene containing a lit thing must set this to 1 and live with the name.** A
   * studio with softboxes, a shop sign, a screen wall, a subway platform, a lava field: each is
   * self-illuminated at noon. Reported from outside after an evening lost to a white cyclorama
   * that shipped with four grey plastic rectangles where its lights should have been, because
   * the field describing the time of day had been set correctly.
   *
   * It is not renamed because it is on the public surface and a second name for one field is
   * worse than an inaccurate one. Read it as "does emissive emit", and use `emissiveGain` for
   * how strongly.
   */
  nightFactor: number;
  /**
   * Emission that only shows where the dominant light does not reach, 0 and off by default.
   *
   * **The case it exists for is a lamp field on something that turns.** City lights are a
   * property of the ground, so they are authored into the surface where the ground is. Whether
   * they should be *visible* is a property of where the sun is, which the ground turns past, and
   * nothing could say the second thing: `emissive` is per vertex and the light direction is per
   * frame, and no term multiplied them.
   *
   * Reported from outside with the arithmetic, on a rotating planet whose night lights were
   * built, photographed and then deleted because they could not be made to work. With an ambient
   * of 0.07 and a directional of 1.15, a patch bright enough to read on the night side arrived at
   * sixteen times that on the day side, as an orange blot on a continent. The ratio is fixed by
   * the lighting, so no choice of value separates the two.
   *
   * Added to the ordinary emissive rather than replacing it, and weighted by how far the surface
   * faces away from `directionalDir`, so the same mesh can carry day-side paint and night-side
   * lamps. It is deliberately a hard cut at the terminator: softening it is what puts the lights
   * back on the day side, which is the defect.
   *
   * Independent of `nightFactor`, which is a fact about the world's clock. This is a fact about
   * where a surface is pointing, and a planet has a night side at any hour.
   */
  nightEmissive?: number;
  /** World → light clip space, from `computeLightMatrix`. */
  lightViewProj: ReadonlyMat4;
  /** 0 disables shadow sampling — set to 0 whenever the map is not refreshed. */
  shadowStrength: number;
  /** Linear depth span returned by `computeLightMatrix`, in metres. */
  shadowDepthSpan: number;
  /** World-space box lit independently of the clock; 0 gain disables it. */
  highlightMin: Vec3;
  highlightMax: Vec3;
  highlightGain: number;
  /** Active point lights: 3 floats each for position/colour, 1 for radius. */
  lightCount: number;
  lightPositions: Float32Array;
  lightColors: Float32Array;
  lightRadii: Float32Array;
  /** Each shaded light's emitter radius in metres. See `PointLightBuffer.sourceRadii`. */
  lightSourceRadii: Float32Array;
  /**
   * How present each active light is, 0 to 1, from `selectPointLights`.
   *
   * Shorter than `MAX_POINT_LIGHTS` means a consumer that packs lights itself and has
   * nothing to say about presence; those lights are taken as fully present, which is
   * what every consumer got before this existed.
   */
  lightWeights: Float32Array;
  /**
   * Three per active light: where a spot points, normalised. Zeroes make a light a point light.
   *
   * Optional in spirit and required in the type, like every other member of this family: a short
   * or absent array falls back in `resolvePointLights` to a direction of nothing and a cone that
   * admits everything, which is the arithmetic every scene had before spot lights existed.
   */
  lightDirections: Float32Array;
  /** Two per active light: the cosine of the inner cone angle, then of the outer. */
  lightConeCos: Float32Array;
  /** One per active light: a row of the photometric atlas, or −1 for none. */
  lightIesProfiles: Float32Array;
  /**
   * Three per active light: where an asymmetric profile's azimuth zero points, in world space.
   *
   * Zeroes leave a profile on its first plane, which is what every axially symmetric fixture does
   * anyway — so a scene that has never heard of this shades exactly as it did. See
   * `PointLightSet.lightIesAxes` for why it cannot be derived from the light's direction.
   */
  lightIesAxes: Float32Array;
  /** One per active light: a tile of the cookie atlas, or −1 for none. */
  lightCookies: Float32Array;
  /**
   * The rectangular emitters this frame, or null for none.
   *
   * A buffer rather than loose arrays, unlike the point lights: those grew their arrays one at a
   * time over years and the family is now seven wide, which is exactly the shape `bindPointLights`
   * exists to stop anybody forgetting a member of. One object cannot be half-passed.
   */
  areaLights: AreaLightBuffer | null;
  /**
   * For each active light slot, which world light it holds. The shadow system
   * needs this to translate a world light into the shader slot the fragment
   * loop is iterating.
   */
  activeLightWorldIndices: Int32Array;
}

/**
 * A complete `Environment`, with every field at a value that means "nothing special".
 *
 * The engine had no way to *make* one of these, so every caller assembled the whole
 * interface by hand — and the first caller that wanted a small, self-contained lit scene
 * (a character portrait in a box on a menu) wrote a partial literal, cast it to
 * `Environment` to satisfy the compiler, and put `undefined` into `uniformMatrix4fv`. The
 * type had been describing the contract all along; nothing was helping anyone meet it.
 *
 * So: a factory with a neutral baseline — no shadows, no point lights, an identity light
 * matrix, no fog — and shallow overrides on top. A caller that forgets a field now gets
 * the harmless value rather than a WebGL error, and a caller that needs the day's sky
 * still assembles exactly what it did before.
 *
 * Fresh arrays every call. Sharing one `lightPositions` between two environments is the
 * kind of aliasing that shows up as one scene's lamps appearing in another's.
 */
export function createEnvironment(overrides: Partial<Environment> = {}): Environment {
  return {
    directionalDir: [0, 1, 0],
    directionalColor: [1, 1, 1],
    ambient: [0.25, 0.28, 0.34],
    emissiveGain: 1,
    nightFactor: 0,
    // Identity: with `shadowStrength` at zero nothing samples it, but a matrix uniform
    // still has to be given sixteen real numbers.
    lightViewProj: IDENTITY_MAT4,
    shadowStrength: 0,
    shadowDepthSpan: 1,
    highlightMin: [0, 0, 0],
    highlightMax: [0, 0, 0],
    highlightGain: 0,
    lightCount: 0,
    /*
     * Full length rather than empty, so an environment that never binds a light is merely unlit.
     *
     * These were `new Float32Array(0)`, which reads as "nothing here yet" and is not what a
     * uniform declared as `MAX_POINT_LIGHTS` floats can be given: `uniform1fv` refuses a short
     * array outright. A consumer who set `lightCount` and bound five of the six therefore got
     * `INVALID_VALUE` every frame and a uniform still holding its zeros, which shades every
     * light as a mathematical point. Reported from outside, and it had silently disabled the
     * emitter-size shading in the app that asked for it.
     *
     * `lightWeights` is the exception and is filled with **one**, because its documented meaning
     * inverts with length: a short array means every light is fully present, so a full one of
     * zeros would mean every light is absent. Same array, opposite sense, which is exactly the
     * kind of thing a default gets wrong quietly.
     */
    lightPositions: new Float32Array(MAX_POINT_LIGHTS * 3),
    lightColors: new Float32Array(MAX_POINT_LIGHTS * 3),
    lightRadii: new Float32Array(MAX_POINT_LIGHTS),
    lightSourceRadii: new Float32Array(MAX_POINT_LIGHTS),
    lightWeights: new Float32Array(MAX_POINT_LIGHTS).fill(1),
    /* Zero direction and the open cone, which together are exactly a point light. */
    lightDirections: new Float32Array(MAX_POINT_LIGHTS * 3),
    lightConeCos: openCones(),
    /* −1, because row 0 is a real fixture and no light here has asked for one. */
    lightIesProfiles: new Float32Array(MAX_POINT_LIGHTS).fill(-1),
    /* Zeroes, which leave any profile on its first plane — what a symmetric fixture does. */
    lightIesAxes: new Float32Array(MAX_POINT_LIGHTS * 3),
    /* −1, because tile 0 is a real cookie and no light here has asked for one. */
    lightCookies: new Float32Array(MAX_POINT_LIGHTS).fill(-1),
    /* None, so the shader's loop breaks before it reads anything. */
    areaLights: null,
    activeLightWorldIndices: new Int32Array(MAX_POINT_LIGHTS).fill(-1),
    fogColor: [0.5, 0.6, 0.7],
    fogDensity: 0,
    fogHeightFalloff: 0,
    fogBaseY: 0,
    underwater: null,
    ...overrides,
  };
}

/**
 * How many frames running a map must be stale before its bake is treated as one that
 * will not stick.
 *
 * Three, so a light that is nudged once and then stops keeps its place in line, and a
 * light that has not held an image across three consecutive frames stops competing with
 * lights whose bakes last. A single good frame clears it, so settling is immediate.
 */

/** Sixteen numbers that change nothing, for a matrix uniform nobody is sampling. */
const IDENTITY_MAT4: ReadonlyMat4 = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

/** A rectangle of the canvas, in CSS pixels from its top-left corner — i.e. a `DOMRect`. */
export interface InsetRect {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

export interface SkyColors {
  top: Vec3;
  horizon: Vec3;
  deep: Vec3;
  sunDir: Vec3;
  sunColor: Vec3;
  /** Apparent angular radius in radians; independent from emitted light. */
  sunAngularRadius: number;
  moonDir: Vec3;
  moonColor: Vec3;
  /** Apparent angular radius in radians; independent from emitted light. */
  moonAngularRadius: number;
  /** 0..1 across the lunar cycle. */
  moonPhase: number;
  nightFactor: number;
  /** Accumulated cloud drift, metres of texture travel on each axis. */
  cloudOffsetX: number;
  cloudOffsetZ: number;
}

/**
 * The whole WebGL2 surface of the engine. No raw `gl` calls may exist outside
 * this directory (AGENTS.md): a shadow pass, a flat-shaded mesh pass, a sky
 * pass, and any number of plume batches.
 */
/**
 * How far a press reaches into the foliage, metres, and how much of a plant it takes.
 *
 * A little wider than a body, so a character leaves a path rather than a line of holes;
 * 80% of the height, because grass that flattens completely reads as grass that has
 * been deleted. Passing through foliage has to move it, so that it reads as being
 * pressed down toward the ground rather than as vanishing.
 */
/**
 * How far an overlay mesh is pulled toward the camera — see `drawMesh`.
 *
 * Both terms are in the units `glPolygonOffset` takes: the slope factor multiplies
 * the polygon's own depth gradient, and the constant is in smallest-resolvable-depth
 * units. Negative pulls toward the viewer.
 *
 * Deliberately small. It has to beat rounding at a coincident surface, which is one
 * or two units, and it must not be large enough to pull a kerb out through a wall it
 * genuinely stands behind — two units is a fraction of a millimetre at the distances
 * a kerb is read at, and grows with distance exactly as the ambiguity does.
 */
/**
 * Depth offset applied per layer — see `drawMesh`.
 *
 * **The slope term does not scale with the layer, and that is the whole point of
 * splitting these two.** It multiplies the polygon's own depth gradient, which at a
 * grazing angle is enormous: one pixel of a deck seen almost edge-on spans a large
 * depth range, so a slope factor that is safe head-on can drag a flush marking metres
 * toward the camera and out in front of geometry that genuinely stands over it. Scaled
 * by the layer as well, it did exactly that: on a terrace, elements *underneath* the
 * main platform showed through it at certain camera angles, as if trying to emerge
 * from beneath something standing over them.
 *
 * So the slope term is **zero**, and the constant term carries the whole ordering.
 *
 * Zero rather than one, in the end, because the slope factor is the only part of this
 * that depends on where the camera is — it multiplies the polygon's own depth gradient —
 * and "certain camera angles" was the one constant in every report. A constant offset
 * biases a layer by the same amount from every direction, so it can order two surfaces
 * without ever being able to drag one out through the other as the view swings round.
 *
 * Kept as a named constant at zero rather than deleted: the next person to see a flush
 * marking lose to its floor at a grazing angle will reach for a slope factor, and this is
 * where the reason not to is written down.
 */

/**
 * Re-exported from the depth convention, which is where the ceiling and the offset it scales now
 * live together — one decision, read by this backend around a draw and by the other one inside a
 * pipeline. Kept exported from here because the barrel has always named it from this module.
 */
export { MAX_DEPTH_LAYER } from '../../depthConvention.ts';

/** The identity tint, handed back after any draw that asked for one. See `drawMesh`. */
const WHITE_TINT = new Float32Array([1, 1, 1]);

/**
 * What a film should do beyond shimmering, which until now was nothing.
 *
 * **A wet street at night is defined by everything above it appearing twice**, and `sheen`
 * cannot supply that: it is an interference pattern, so raising it makes a road oilier rather
 * than wetter. This is the other half, kept a separate number for exactly that reason.
 *
 * Requires a planar reflection to have been rendered this frame for the plane the film lies on,
 * which needs `RenderQuality.planarReflections` where the scene has no water to allocate one.
 * Absent or zero means the pass behaves as it always did, so nothing that predates it moves.
 *
 * **New, and honestly reported: the plumbing is proven and the look is not.** Measured on
 * `demo/nightStreet.ts` held at frame 900, turning it from 0 to 1 changes 46,129 pixels and the
 * largest change to any channel is **12 of 255**, so it is present and it does not yet read as a
 * mirror. The reason is believed to be the film's own coverage alpha, which scales the mirrored
 * term along with everything else, and a camera angle that keeps the grazing weight small. That
 * is a weighting to tune rather than a mechanism to find, and the rig is where to tune it:
 * `?scene=7&model=car&hold=900&wet=1` against `&wet=0`. Do not assume it looks right because it
 * compiles.
 */
export interface FilmOptions {
  /**
   * How much of the mirrored scene shows through, 0 to 1.
   *
   * Weighted by the viewing angle on top of this, because that is what a reflection does: a wet
   * surface underfoot shows almost nothing and the same surface down the street shows everything.
   */
  readonly reflectionStrength?: number;
  /**
   * The plane the film lies on, defaulting to 0.
   *
   * Only used to check it against the plane the reflection was rendered for, so a film on a
   * different plane gets no mirror rather than somebody else's. A patch lifted a centimetre clear
   * of the road still names the road's own height: the lift is to stop it fighting for the depth
   * buffer, not a different plane to mirror across.
   */
  readonly reflectionPlaneY?: number;
  /**
   * How rough the film's own surface is, 0 to 1. Zero is a mirror, which is what this pass was.
   *
   * A film had one finish before this and it was the wrong one for the commonest use: a wet road
   * is water lying *in* aggregate, so the stone under it scatters the reflection into a smear.
   * Without this, a patch of film over a textured surface met it at a hard rim with mirror on one
   * side and stone on the other — and softening the patch's coverage does not touch it, because
   * the alpha was never what the eye was reading there.
   *
   * Displaces the reflection rather than blurring it. A rough surface scatters what it reflects
   * rather than softening it, so a lamp becomes a streak and not a soft disc; it is also the only
   * affordable choice, since the mirror has no mip chain and an honest blur costs taps.
   */
  readonly roughness?: number;
  /**
   * How coarse that roughness is, in bumps per metre. Defaults to 60.
   *
   * The same quantity `setSurfaceRelief` takes, and **matching the two is the point**: given the
   * same field at the same scale, the water is broken up by the aggregate the dry surface beside
   * it is already showing, and the wet and the dry stop reading as two materials. Ignored when
   * `roughness` is zero.
   */
  readonly roughnessCyclesPerMetre?: number;
}

/**
 * The two things a volume of light can have beyond its shape. See `drawLightVolume`.
 *
 * Both default to nothing, and that is not only compatibility: a torch beam is a smooth cone
 * and should stay one. These are what turn a beam into a shaft of daylight, which is a
 * different phenomenon that happens to be drawn by the same pass.
 */
export interface LightVolumeDrawOptions {
  /**
   * How much structure the air in the beam has, 0 to 1. Zero computes nothing.
   *
   * A shaft of sun through a window is not smooth: what is lit is the dust in it, and the dust
   * is uneven. Useful values are low, around 0.2 to 0.5; past that the beam reads as smoke.
   */
  readonly dust?: number;
  /** Metres per cell of the dust field. Around a metre for motes, several for weather. */
  readonly dustScaleM?: number;
  /**
   * Where the dust field has drifted to, in metres. Defaults to standing still.
   *
   * A position rather than a rate, so this pass never reads a clock and a caller asking for
   * the same instant twice gets the same frame. Air moves with the scene's wind, so the drift
   * to hand it is the one `WindField` has already accumulated — the same value the smoke and
   * the grass are answering to, which is what stops a shaft of dust drifting one way while the
   * smoke beside it goes another.
   */
  readonly driftM?: Vec3;
  /**
   * How much the sun's own shadow map cuts the volume, 0 to 1. Zero samples nothing.
   *
   * **The directional light, which is to say the sun.** A shaft through a window carries the
   * bars of that window because the light did; without this the floor under a mullioned window
   * is barred and the shaft above it is smooth, and one frame disagreeing with itself about
   * where the light went is most of what reads as fake. A beam from a lamp is not sunlight and
   * wants this left at 0, which is why it is a per-draw amount and not a renderer setting.
   *
   * Needs `env`, and needs the renderer built with `directionalShadows`. Without either it is
   * ignored rather than throwing, because this is a frame-loop call.
   *
   * The occlusion is evaluated at every step of the march, so this is a shadow carried through
   * the air rather than stamped on a surface. What it still does not do is let one volume
   * shadow another behind it: each is integrated on its own.
   */
  readonly sunShadow?: number;
  /** Where the sun's shadow map is. Required by `sunShadow` and unused without it. */
  readonly env?: Environment;
  /**
   * The air this volume stands in, and the density at which it reads at full strength.
   *
   * **A beam is only as visible as the medium it is lighting**, and until 2026-08-28 nothing
   * here knew what the weather was: the same headlight cone was drawn in clear air and in thick
   * fog, because `strength` is a number a caller authored once. Given this, the cone fades out
   * as the air clears and blooms as it thickens, which is what turns fog from a filter over the
   * frame into something that changes how the road is read.
   *
   * `fullAtDensity` is in the units of `Atmosphere.fogDensity` and is the density at which the
   * beam is drawn exactly as authored; below it the beam is proportionally dimmer, above it
   * nothing further happens. Absent means the beam ignores the weather, which is every volume
   * drawn before this existed and every torch beam indoors.
   *
   * Density is read at the *volume's* own height rather than the camera's, so a car in a valley
   * of fog seen from the ridge above carries its own weather.
   */
  readonly medium?: {
    readonly atmosphere: Atmosphere;
    readonly fullAtDensity: number;
  };
  /**
   * Where the drawn volume starts along its own +Z, matching the `nearM` its hull was built
   * with. Defaults to the apex.
   *
   * The march is clipped to the same slab the hull covers, so a shaft that is a slice taken
   * far down a very wide cone has to say where its slice begins or the walk starts at an apex
   * above the roof and integrates air that was never drawn.
   */
  readonly nearM?: number;
}

/**
 * The two things a translucent draw can turn off. See `Renderer.drawTranslucentMesh`.
 *
 * Both default to `true`, which is the world exactly as it drew before this existed: lit,
 * fogged, shaded like everything else. An options object rather than a positional boolean —
 * `drawTranslucentMesh(mesh, model, opacity, false)` reads as a flag on the call rather than
 * as a description of what got drawn, which `AGENTS.md` rules out for the same reason a bare
 * boolean is refused everywhere else in this file.
 */
export interface TranslucentMeshOptions {
  /**
   * `false` draws the mesh exactly its own vertex colour times its own texture, with no
   * ambient, sun, point lights, specular, reflectivity, grain or emissive touching it —
   * three.js calls this `meshBasicMaterial`. For a glow shell, a flat backdrop plate or
   * anything else whose art direction says "this colour, unconditionally."
   */
  readonly lit?: boolean;
  /**
   * `false` keeps this draw out of the atmospheric haze and the underwater tint, both —
   * see the shader's own comment on `uFogEnabled` for why the two travel together and what
   * a draw that opts out of both gives up.
   *
   * Independent of `lit`: an unlit marker at the edge of view range can still want to fade
   * into the haze, so the two are separate switches rather than one covering both.
   */
  readonly fog?: boolean;
  /**
   * `false` skips the *tone curve* for this draw, keeping the colour-space conversion — which
   * is exactly what three.js's `toneMapped: false` does and what it is for.
   *
   * **A meter is not a surface.** ACES is a photographic response: it compresses highlights and
   * desaturates as it goes, which is right for a world made of light and wrong for a swatch
   * whose colour *is* the reading. A spectrum bar authored at `#00d84a` renders through the
   * curve as `(106, 213, 102)` — a pale sage where the author wrote a pure green — and the
   * error cannot be dialled out of the source colour either: the AP1 matrix mixes channels, so
   * that stop's red is pinned at 113 of 255 even with the input's red at zero. There is no
   * value a caller can author that comes out right, which is why this is a switch rather than a
   * tuning problem.
   *
   * **Honoured where this pass grades itself, which is a renderer with no composite.** With one,
   * the frame is graded as a whole after every pass has written into it, and no per-draw flag
   * can reach back through that; the draw is graded like everything else. That is a real limit
   * of grading once at the end rather than per material, stated rather than hidden: three.js
   * can honour it always because it tone maps inside every material's own fragment stage.
   */
  readonly toneMapped?: boolean;
  /**
   * How far this surface bends what is behind it, in screen UV at the frame's own resolution.
   *
   * **0 is off and is the default, which is what every call that predates this means**, so no
   * existing draw and no published scene moves by a bit.
   *
   * Translucent only, and that is a statement about what the branch reads rather than a
   * restriction: it samples the colour drawn *before* this surface, and an opaque draw has
   * already occluded it.
   *
   * **What it costs is one copy of the frame's colour**, taken at the first refracting draw of a
   * frame and reused by every later one. So glass does not refract other glass — which is right,
   * a pane behind a pane should show the room — and opaque geometry drawn *after* the first pane
   * is missing from what that pane shows. Draw the world, then the glass.
   */
  readonly refraction?: number;
  /**
   * What survives one metre of this medium, per channel. White is clear glass and is the default.
   *
   * **Beer-Lambert, stated in the units a caller thinks in.** The transmitted colour is
   * `pow(tint, pathLength)`, which is `exp(-absorption * d)` with `absorption = -log(tint)`. What
   * it costs is that a caller holding absorption coefficients from a reference converts them
   * once; what it buys is that clear glass is `(1, 1, 1)` with no special case, and that there is
   * no `log(0)` at the API to trap on.
   *
   * **Named apart from `tint` below, which is a different quantity on the same object.** That one
   * multiplies the surface's own colour; this one absorbs what passes *through* it. A draw wanting
   * a coloured pane that does not bend already has the first, and one name for both would be a
   * noun lying about what it does.
   *
   * Does nothing without `refraction`, deliberately.
   */
  readonly refractTint?: Vec3;
  /**
   * Metres of medium at `dot(N, V) = 1`, multiplied by the per-vertex channel's `.w` lane.
   *
   * The lane is optional and absent means 1.0, so a mesh carrying no channel refracts at exactly
   * this thickness. **An instanced draw cannot carry the lane at all** — location 13 is the
   * instance matrix, and `InstancedMesh` refuses a channelled mesh at construction — so an
   * instanced refracting draw is uniform in thickness rather than wrong.
   *
   * The path a ray takes is this divided by `dot(N, V)`, so a pane seen edge-on absorbs more than
   * the same pane seen face-on. That is what makes a glass edge go green while its middle stays
   * clear, and it is the whole difference between this and a flat tint.
   */
  readonly thicknessM?: number;
  /**
   * Whether this draw writes depth. `true`, which is what it has always done, unless a caller
   * says otherwise.
   *
   * **Writing depth is right for a piece and wrong for a set of them.** A sign hung in the air
   * has to occupy the depth buffer or the sky, drawn last over everything the world left
   * untouched, paints straight over it — that is why this pass writes depth at all, and the
   * reason is in `drawTranslucentMesh`'s own docstring. But depth written by a blended surface
   * *rejects* the blended surfaces behind it, so a model whose interior is blended draws the
   * first of each overlapping pair and discards the rest, and which one is first is the order
   * the caller happened to submit in.
   *
   * So `false` is the tool for the second case: a set of blended surfaces that belong to one
   * object and have to blend through each other. Measured on an imported vehicle, a quarter of
   * whose materials declare a blend: 96 interior surfaces drawn against the shell they sit
   * inside.
   *
   * **What it costs, and it is the whole reason this is not the default.** Nothing in the depth
   * buffer means nothing to sort by, so the caller owns the order — draw back to front, or accept
   * that two surfaces overlapping in view blend in submission order. And a surface that writes no
   * depth cannot occlude the sky. A caller wanting both wants the pieces sorted and this left
   * alone.
   */
  readonly depthWrite?: boolean;
  /**
   * Orders geometry that occupies the same surface as other geometry, exactly as `drawMesh`'s
   * parameter of the same name and with the same ceiling.
   *
   * A decal lying on the surface it decorates is coplanar with it, and coplanar surfaces do not
   * merely tie: their interpolated depths are equal in exact arithmetic, so which one survives is
   * decided per pixel by which way the rounding fell. `drawMesh` has had the answer since the
   * defect turned up in six places in one session, and this call did not — so the same marking
   * declared over the same slab was ordered when it was opaque and a coin toss when it blended.
   *
   * A higher layer wins wherever two surfaces coincide. 0, the default, is the base world and
   * takes no offset at all.
   */
  readonly depthLayer?: number;
  /**
   * A per-draw colour multiplier, exactly as `drawMesh`'s fourth argument.
   *
   * **Here rather than as a fifth positional parameter**, because it belongs to the same set of
   * per-draw decisions the rest of this interface holds and a fifth argument after an options bag
   * reads as an afterthought.
   *
   * It exists because the opaque and blended paths were not interchangeable for a caller that
   * tints: a consumer fading a coloured model in — every surface translucent for the length of the
   * fade — lost its colour for exactly as long as the fade ran and then snapped to it. Reported
   * from a game whose cars arrive that way.
   */
  readonly tint?: Vec3 | null;
}

/** Handed to the shader when a batch has no press field. See `drawScatter`. */

/**
 * What a contributed pass pre-multiplies its projection by on this backend: nothing.
 *
 * Stated rather than left as an absence, because the field has to be answered honestly by both
 * backends — the 2026-08-13 rule about a missing property being `undefined` and `undefined` in
 * arithmetic being a picture rather than an error.
 */
const IDENTITY_CLIP = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);

/** Standing still, for a caller that asked for dust and not for wind. */
const NO_DRIFT: Vec3 = [0, 0, 0];

export class WebGL2Renderer implements RendererApi {
  /**
   * Private on purpose. The GL context never leaves this directory, so a
   * second backend (WebGPU) stays a contained
   * addition rather than a rewrite of every caller. Resources are created
   * through the factories below.
   *
   * **`registerPass` is the one exception, and it is a deliberate one.** A package that draws
   * cannot be given a lowest common denominator of two APIs without inventing a second renderer,
   * so `PassContext` hands over this context by name and the WebGPU encoder by another. The
   * reason above is unharmed: what kept the second backend a contained addition was that no
   * *caller* holds a GL type, and a contributor that asks for one branches on the backend it
   * asked for.
   */
  private readonly gl: WebGL2RenderingContext;

  private readonly canvas: HTMLCanvasElement;
  private readonly contextLostListeners: (() => void)[] = [];
  private readonly contextRestoredListeners: (() => void)[] = [];

  /** Removes the canvas listeners `attachContextLoss` installed. See `dispose`. */
  private readonly detachContextLoss: () => void;
  private disposed = false;

  /**
   * Whether the drawing context is currently gone.
   *
   * Every GL entry point below returns early while this is true, and that is a
   * reliability fix rather than an optimisation. A lost context does not stop the
   * caller's frame loop — `requestAnimationFrame` keeps firing, the game keeps calling
   * `beginFrame`, and every object this renderer holds now belongs to a context that no
   * longer exists. The browser answers each call with INVALID_OPERATION, so a single
   * loss becomes an unbounded flood of "object does not belong to this context" at sixty
   * frames a second, which buries the one message that mattered and makes the console
   * useless for finding the cause.
   *
   * It was reported as a wall of console errors after the picture stopped, with the
   * trace running through the frame loop — the renderer drawing long after there was
   * anything to draw to.
   *
   * Public so a consumer can skip its own per-frame work too; the guard here only makes
   * the engine's half harmless.
   *
   * **Asks the context, not only the event.** `webglcontextlost` is dispatched
   * asynchronously, so there is a window — however many calls the caller makes before
   * the task queue drains — in which the context is already dead and the flag is still
   * false. Every guard built on the flag alone fails open in that window, which is how a
   * `resize` reached `PlanarReflection.ensureSize` and threw FRAMEBUFFER_UNSUPPORTED
   * (0x8CDD) against a context that no longer existed.
   *
   * `isContextLost()` is the authority and is cheap. The flag is kept because it is what
   * `onContextLost` listeners fire from, and it holds across the gap until
   * `webglcontextrestored` clears it.
   */
  get contextLost(): boolean {
    return this.contextLostFlag || this.gl.isContextLost();
  }

  private contextLostFlag = false;

  /**
   * The material texture `setSurfaceTexture` last bound, or `null` when albedo is off.
   *
   * A boolean alone used to be enough, because nothing between two `drawMesh` calls
   * ever touched `SURFACE_TEXTURE_UNIT`'s actual GL binding. `drawSdfText` does: the atlas
   * borrows that same unit for the length of one draw (see `SDF_TEXT_TEXTURE_UNIT`), so
   * after it returns the unit no longer necessarily holds what this flat-program state
   * still says it holds. This is what lets `drawSdfText` put the *right* texture back
   * rather than just a flag saying one should be there.
   */
  private currentSurfaceTexture: SurfaceTexture | null = null;

  /**
   * GPU time for the frame's three parts, when the driver will report it.
   *
   * Public because the consumer is a diagnostic, not the renderer: the game brackets
   * its own frame with `beginFrame`/`endFrame` and reads samples with `poll`.
   */
  readonly gpuTimer: GpuTimer;
  /**
   * The drawing-buffer density ceiling, in effect right now.
   *
   * Not `readonly`: `applyResolutionScale` moves it, which is what lets a governor hold a
   * frame budget without rebuilding anything. It starts at the resolved quality's own
   * `maxDevicePixelRatio` and is re-read by every `resize()`.
   */
  private maxDpr: number;
  /** Area cap in pixels, 0 for uncapped. Mutable: see `setMaxDrawingBufferPixels`. */
  private maxDrawingBufferPixels: number;
  /** Reused by `resize`, which runs every frame and may not allocate. */
  private readonly budgeted: BufferSize = { width: 0, height: 0 };
  /** Per-frame bake planning scratch, sized once. See `pointShadowBudget.ts`. */
  /*
   * Pool-length, not shader-length: baking now covers the warm lights too, so these
   * index everything holding a slot. `bind` still reads only the shaded eight.
   */
  /**
   * How many frames running each slot has been stale, which light that was, and whether
   * that run is long enough to call the map chronically stale.
   *
   * A light that moves, or animates its radius, is owed a bake again the frame after it
   * gets one. Counting the run is what separates it from a static light that drifted once
   * and would then hold its image indefinitely, so the budget can serve the bake that
   * will *stick* first. The owner is tracked because pool slots change hands: a new light
   * in an old slot starts at zero rather than inheriting the last tenant's record.
   */
  /** The shaded lights that also cast, which is not the same list. See `updatePointShadows`. */
  private readonly castingWorldIndices = new Int32Array(POINT_SHADOW_POOL).fill(-1);
  /** Per-slot scratch for the bake round; see `runPointShadowBakes`. */
  private readonly bakeScratch = createBakeScratch(POINT_SHADOW_POOL);
  /** Resolved once; a size/profile change recreates the renderer's resources. */
  readonly quality: Readonly<RenderQuality>;
  /**
   * What `UNMASKED_RENDERER_WEBGL` calls this part, or `''` when the browser withholds it.
   *
   * Public because a bug report is worth more with it than without: every performance
   * report this project has acted on was read GPU-string first.
   */
  readonly rendererName: string;
  /**
   * Which backend is drawing, from the renderer rather than from the address bar.
   *
   * **`createRenderer` returns this too and says to report it and never infer it** — the
   * inference being a query string, which says what was *asked for* and is wrong in exactly
   * the case that matters, a silent fallback. A consumer holding only a renderer could not
   * ask before this existed, so it inferred or it said nothing.
   *
   * Not the same question as `rendererName`, which is the GPU's own string and identifies the
   * part rather than the API.
   */
  readonly backend: RenderBackend = 'webgl2';
  /**
   * Whether this part was recognised as one that cannot hold the profile it asked for, and
   * had its pixel terms clamped at construction. Carried into bug snapshots, so a report
   * says whether the clamp fired rather than leaving it to be inferred.
   */
  readonly capabilityClamped: boolean;

  /**
   * How many frames this renderer has actually presented, monotonic for its whole lifetime.
   *
   * **Incremented where `endFrame` reaches its end, not where it is called.** WebGL2 has no
   * swap chain to acquire the way WebGPU's `getCurrentTexture` gives one — the canvas *is*
   * the default framebuffer, and `beginFrame` clears it directly, so there is no separate
   * "taken" instant to hang this on. `endFrame`'s only early return is a lost context, so its
   * far end, right beside `framePresented`, is this backend's honest equivalent: the one
   * point every call is guaranteed to reach if and only if the frame it opened is what the
   * browser is about to show. A consumer compositing an offline export reads this after
   * `endFrame` and compares it with what it read last, which is how it tells a frame that
   * drew something from one that repeated the canvas it already had — see `ExportTarget`.
   */
  get presentedFrames(): number {
    return this.presentedFrameCount;
  }

  private presentedFrameCount = 0;

  private readonly flatProgram: WebGLProgram;
  private readonly flatUniforms: Record<string, WebGLUniformLocation>;
  /**
   * The lit fragment source every flat program is built from, and the budget it was built at.
   *
   * **One string for all four variants, built once.** The four flags `flatFrag` permutes on are
   * fixed by the time the first program is compiled — three are resolved quality and the fourth is
   * a `readonly` field — so the skinned, morphed and instanced programs differ only in their
   * *vertex* stage. Building it three more times cost 0.84 ms each, measured, and made it possible
   * for a lazily compiled variant to end up at a different light budget from the one the renderer
   * uploads for, which is a picture nobody could explain.
   */
  private readonly flatFragSource: string;
  /**
   * How many lights this renderer's shader has room for, after the device had its say.
   *
   * `FULL_LIGHT_BUDGET` on anything with room, which is every desktop part and most phones. See
   * `uniformVectorBudget.ts`, and `shadedLights` for what a consumer should do about it.
   */
  private readonly lightBudget: LightBudget;
  /**
   * The skinned twin of `flatProgram`, compiled the first time a rigged mesh is built.
   *
   * **Lazy, and at `createMesh` rather than at construction or in the frame loop.** At
   * construction it would cost a compile to every game for a feature most never use; in the frame
   * loop it could throw, and the rule is that initialisation fails loudly so a running frame never
   * has to. `createMesh` is construction, it is off the frame, and it is where joints first exist.
   */
  private flatSkinnedProgram: WebGLProgram | null = null;
  private flatSkinnedUniforms: Record<string, WebGLUniformLocation> | null = null;
  /**
   * The vertex stage's other two variants, compiled on the first mesh that needs each.
   *
   * Four programs where the shader has four variants, and each is compiled only if a mesh actually
   * asks for it — a game with characters and no morph targets pays for two, and one with neither
   * pays for one. `bindMeshPass` feeds every program that exists, so the frame state cannot go
   * missing from one of them.
   */
  private flatMorphedProgram: WebGLProgram | null = null;
  private flatMorphedUniforms: Record<string, WebGLUniformLocation> | null = null;
  private flatBothProgram: WebGLProgram | null = null;
  private flatBothUniforms: Record<string, WebGLUniformLocation> | null = null;
  /** The morph weights the following draws use, or null for none. */
  private morphWeights: Float32Array | null = null;
  /**
   * Every flat program with the frame state it needs, preallocated so the loop allocates nothing.
   *
   * One entry until a rigged mesh is built, two after. `bindMeshPass` walks it.
   */
  private readonly flatTargets: {
    readonly program: WebGLProgram;
    readonly uniforms: Record<string, WebGLUniformLocation>;
  }[] = [];
  /**
   * The last camera and environment `bindMeshPass` was given.
   *
   * Held so a program compiled *after* this frame's pass was bound can be fed at once rather than
   * drawing one frame with every uniform at zero. Two references rather than copies, so this
   * costs no allocation.
   */
  private lastPassCamera: Camera | null = null;
  private lastPassEnv: Environment | null = null;
  /** Light in the air, which is not a material. See `shaders/lightVolume.ts`. */
  private readonly lightVolumeProgram: WebGLProgram;
  private readonly lightVolumeUniforms: Record<string, WebGLUniformLocation>;
  /** Two triangles in screen space, for `fillPanel`. Built once. */
  private readonly panelProgram: WebGLProgram;
  private readonly panelUniforms: Record<string, WebGLUniformLocation>;
  private readonly panelVao: WebGLVertexArrayObject;
  private readonly filmProgram: WebGLProgram;
  /**
   * The off-screen colour target, when screen effects are on. Null is not a failure —
   * it is the low-end path, and the scene goes straight to the canvas exactly as it did
   * before this existed.
   */
  private readonly sceneTarget: SceneTarget | null;
  /** So the refusal below is once per renderer rather than once per frame. See `setColourGrade`. */
  private warnedGradeWithoutComposite = false;
  /** Scratch for a volume's `uDepthToLocal`. Built per draw and never allocated in the loop. */
  private readonly volumeDepthToLocal = new Float32Array(16);
  private readonly volumeDepthScratch = new Float32Array(16);
  /**
   * What a declared-but-unused sampler slot reads, instead of nothing.
   *
   * A profile with shadows off still compiles the samplers that would sample them, and a
   * unit bound to `null` is an *incomplete* texture whose descriptor a driver may fetch
   * before it evaluates the runtime branch that would have skipped the read. See
   * `emptyTexture.ts`: on RDNA4 that fetch page-faults and resets the GPU.
   */
  /**
   * The joint palette the next skinned `drawMesh` reads, or empty until one is set.
   *
   * Held rather than passed, like every other per-draw state on this renderer: `setSkinPalette`
   * chooses and the following draws use it, which is the shape `setMaterial` already has.
   */
  private readonly skinPalette = new SkinPaletteTexture();
  /** Whether a palette is currently chosen. Distinct from whether one was ever uploaded. */
  private skinPaletteSet = false;

  private readonly emptyTexture2D: WebGLTexture;
  private readonly emptyTexture2DArray: WebGLTexture;
  private readonly emptyTextureCube: WebGLTexture;
  /** How hard the rush blurs this frame, and how far its outermost tap reaches. */
  private rushStrength = 0;
  /** How much of the motion-blur ceiling this frame takes. See `setCameraMotionBlur`. */
  /**
   * Order-independent transparency: the frame's translucent draws, and the pass that resolves them.
   *
   * **Recorded rather than drawn**, because the accumulation and the revealage are two blend states
   * over the same geometry and this renderer otherwise draws immediately. See `TranslucentQueue`
   * for why every field is copied.
   */
  private readonly translucentQueue = new TranslucentQueue();
  private oit: OitPass | null = null;
  /**
   * The frame's drawn decals, and the pass that marks the scene with them.
   *
   * Recorded rather than drawn where the call is made, because a projected mark is decided
   * from the depth the frame has drawn and therefore cannot run until the opaque world is
   * finished. See `DecalQueue`.
   */
  private readonly decalQueue = new DecalQueue();
  /** Built on the first frame that submits a mark, and never for a scene with none. */
  private decals: DecalPass | null = null;
  /** Said once where a mark cannot be drawn at all, rather than dropped in silence. */
  private decalsRefused = false;
  /**
   * The frame's reflective surfaces, and the pass that marches them.
   *
   * Recorded rather than traced where the call is made, because the march reads the *finished*
   * picture: what a ray finds is a pixel of the scene the frame has already drawn.
   */
  private readonly reflectionQueue = new ReflectionQueue();
  /** Built on the first frame that submits a surface, and never for a scene with none. */
  private ssr: SsrPass | null = null;
  /** Said once where a reflection cannot be traced at all. */
  private reflectionsRefused = false;
  /** Where the frame's camera stands, which is what gives a reconstructed normal its sign. */
  private readonly frameEye = new Float32Array(3);
  /** Whether this frame is recording translucent draws instead of blending them as they arrive. */
  private oitActive = false;
  /** True while the queue is being replayed, so a replayed draw does not record itself again. */
  private oitReplaying = false;
  /** Said once, not per frame, where the context cannot give the float target the sum needs. */
  private oitRefused = false;
  /** Said once for the whole renderer. See `refuseOitMultisampled`. */
  private oitMultisampleRefused = false;
  /**
   * The options object the replay hands back to `drawTranslucentMesh`, reused.
   *
   * Mutable where `TranslucentMeshOptions` is readonly, and built once: a fresh literal per draw
   * would allocate once per translucent surface per pass per frame, which is what `AGENTS.md`
   * forbids in the frame loop.
   */
  private readonly oitReplayOptions: {
    lit: boolean;
    fog: boolean;
    toneMapped: boolean;
    depthWrite: boolean;
    depthLayer: number;
    tint: Vec3 | null;
    refraction: number;
    refractTint: Vec3 | undefined;
    thicknessM: number;
  } = {
    lit: true,
    fog: true,
    toneMapped: true,
    depthWrite: true,
    depthLayer: 0,
    tint: null,
    refraction: 0,
    refractTint: undefined,
    thicknessM: 0,
  };

  private motionBlurScale = 1;
  /** How much of the bloom ceiling this frame takes. See `setBloom`. */
  private bloomScale = 1;
  /**
   * This frame's exposure into the tone curve. See `setOutputExposure`.
   *
   * Starts at the construction-time grade, so a world that never calls the setter is exposed
   * exactly as it asked to be and nothing about it changes.
   */
  private exposure: number;
  /**
   * This frame's veil colour, and how much of it to composite. See `setFrameVeil`.
   *
   * A mutable tuple rather than a fresh array per call, so a transition calling this every
   * frame costs no allocation to hold it. `veilAlpha` is reset to zero at the end of every
   * `endFrame` — unlike `rushStrength` and the two scales above, which are held until a caller
   * changes them — because a forgotten veil is a stuck white or black frame, and that failure
   * is worse than one that has to ask again. See `setFrameVeil` for the ordering ruling.
   */
  private readonly veilColor: Vec3 = [0, 0, 0];
  private veilAlpha = 0;
  /**
   * The view-projection the *previous* frame was drawn with, and the reprojection built
   * from it. Held here because camera motion blur is the only thing that wants it and it
   * costs one matrix either way.
   *
   * Scratch, allocated once: `endFrame` runs every frame and may not allocate.
   */
  private readonly previousViewProj = mat4.create();
  private readonly reprojection = mat4.create();
  /**
   * Temporal antialiasing: the history's state, this frame's sub-pixel offset, and the jittered
   * matrix geometry is actually drawn with.
   *
   * **`frameViewProj` stays unjittered and that is the whole design.** The reprojection above is
   * built from it, and the history holds a resolved picture standing for the *unjittered* scene —
   * so reprojecting through a jittered matrix would look every sample up half a pixel from where
   * it is and cancel the accumulation it is trying to build. Only `viewProjFor` jitters, and only
   * for the frame's own camera.
   */
  private readonly temporalHistory = new TemporalHistory();
  private readonly jitteredViewProj = mat4.create();
  private temporalJitterX = 0;
  private temporalJitterY = 0;
  /** Whether this frame's geometry uploads are jittered. False for a mirror, a probe and when off. */
  private temporalJittering = false;
  /** Whether the resolve may sample what the last frame left. False on frame one, a resize, a cut. */
  private temporalHistoryUsable = false;
  private hasPreviousView = false;
  /** The camera the frame was actually drawn with, captured by `bindMeshPass`. */
  private frameViewProj: ReadonlyMat4 | null = null;
  /**
   * That camera's projection, and its inverse, for ambient occlusion.
   *
   * The projection alone rather than the whole view-projection, because occlusion is measured
   * in *view* space: distances there are metres from the eye, so a radius means the same
   * thing wherever the camera is standing, and the numbers stay small enough that a depth
   * reconstruction keeps its precision. A world-space reconstruction of the same points would
   * be the camera's position plus a small offset, which is where a float loses the offset.
   *
   * Scratch, filled in `endFrame`, which may not allocate.
   */
  private frameProjection: ReadonlyMat4 | null = null;
  private readonly aoInvProjection = mat4.create();
  private readonly aoProjScale = new Float32Array(2);
  /**
   * Whether this frame has already been resolved to the canvas.
   *
   * Anything drawn *after* `endFrame` — a UI inset, a portrait box — belongs on the
   * presented image, not in a target that has already been sampled. So once the frame is
   * presented, "back to the whole frame" means the canvas again.
   */
  private framePresented = false;
  /**
   * A fence placed behind the first presented frame, and whether it has cleared.
   *
   * `endFrame` returning is not the frame being finished — it is the frame being
   * *asked for*. The driver pays for every pipeline the first time it is used, and
   * on a built game that bill is 150 ms of a saturated GPU process arriving after
   * the renderer's own callbacks are back down to a millisecond each (traced
   * 2026-08-07). A consumer covering the load with a plate has no way to see that
   * from the main thread, so it uncovers the screen exactly in time for the player
   * to watch it happen.
   *
   * The fence is the only thing that knows. `waited` bounds it: a driver that never
   * signals must not be able to hold a plate up for ever, and two seconds of frames
   * is far longer than any first frame and far shorter than a player waiting.
   */
  private firstFrameFence: WebGLSync | null = null;
  private firstFrameCleared = false;
  private firstFrameWaits = 0;
  private readonly filmUniforms: Record<string, WebGLUniformLocation>;
  private readonly skyProgram: WebGLProgram;
  private readonly skyUniforms: Record<string, WebGLUniformLocation>;
  private readonly skyVao: WebGLVertexArrayObject;
  private readonly scatterProgram: WebGLProgram;
  private readonly scatterUniforms: Record<string, WebGLUniformLocation>;
  private readonly depthProgram: WebGLProgram;
  /**
   * The depth program that reads a joint palette.
   *
   * A second program rather than a uniform gate on the first, which is the decision
   * `skinning.ts` measured for the flat shader and which is cheaper here: this vertex stage is a
   * fifth the size, so the second copy dedupes almost entirely.
   */
  private readonly depthSkinnedProgram: WebGLProgram;
  private readonly depthSkinnedUniforms: Record<string, WebGLUniformLocation | null>;
  private readonly depthUniforms: Record<string, WebGLUniformLocation>;
  private readonly depthInstancedProgram: WebGLProgram;
  private readonly depthInstancedUniforms: Record<string, WebGLUniformLocation>;
  private readonly scatterDepthProgram: WebGLProgram;
  private readonly scatterDepthUniforms: Record<string, WebGLUniformLocation>;
  private readonly shadowMap: ShadowMap | null;
  private readonly peeledShadowMap: ShadowMap | null;
  private readonly dynamicShadowMap: ShadowMap | null;
  private readonly pointShadows: PointShadowSystem<PointShadowMap> | null;
  /**
   * The layers a world's casting rectangles hold, above the point pool in the same array.
   *
   * Null exactly when `pointShadows` is, because an area shadow is read out of that array and
   * WebGL2 has no seventeenth texture unit to put a second one in. See `areaShadowSet.ts`.
   */
  private readonly areaShadows: AreaShadowSet<PointShadowMap> | null;
  /** What the lit pass is told about each rectangle. Refilled per frame, never allocated. */
  private readonly resolvedAreaShadows = createResolvedAreaShadows(MAX_AREA_LIGHTS);
  /** Per-slot scratch for the area bake round; caller-owned, because that runs every frame. */
  private readonly areaBakeScratch = createBakeScratch(MAX_AREA_LIGHTS);
  /** Said once per renderer, naming the field a rectangle left out. */
  private warnedAreaShadowRange = false;
  /** Said once per renderer, naming the quality flag an area shadow rides. */
  private warnedAreaShadowsOff = false;
  private warnedAreaShadowLayers = false;
  /**
   * How many point lights the array was last sized for.
   *
   * Kept because `firstAreaShadowLayer` needs it and the pool does not publish it: the area layers
   * begin where the pool's end, and re-deriving that from anything else is the one number that must
   * not be guessed — a rectangle told the wrong first layer samples a lamp's map.
   */
  private preparedPointLightCount = 0;
  /**
   * Every point light's octahedral map, in one array texture, or null until a world says how
   * many lights it has.
   *
   * Not built in the constructor, because `texStorage3D` is immutable and the size depends on the
   * world. See `prepareStaticPointShadows`.
   */
  private pointShadowArray: PointShadowArray | null = null;
  /** The photometric atlas, allocated on first use. See `setIesProfiles`. */
  private iesTexture: WebGLTexture | null = null;
  /** Rows in that atlas. One until a consumer loads a profile, which is the row of ones. */
  private iesRows = 1;
  private cookieTexture: WebGLTexture | null = null;
  /** Tiles in the cookie atlas. 0 is the white placeholder and the whole off path. */
  private cookieTiles = 0;
  /** Horizontal planes each profile occupies. 1 unless something asymmetric was loaded. */
  private iesPlanes = 1;
  private readonly planarReflection: PlanarReflection | null;
  /**
   * The cube six faces are drawn into, and the only one there is however many probes a grid holds.
   *
   * **Scratch, and reused by every probe.** A face is consumed the moment the convolution reads
   * it, so a grid of thirty-two probes needs one capture rather than thirty-two — the same economy
   * `pointShadowArray.ts` makes with its own single scratch, arrived at the same way.
   */
  private readonly probeCapture: ReflectionProbe | null;
  /** Every probe of the grid, as one array texture. Allocated when a grid is declared. */
  private probeArray: EnvProbeArray | null = null;
  /**
   * Where those probes stand. A single baked probe is a grid of one at that probe's own origin.
   *
   * Null until a caller bakes or declares one, because a grid's layer count is what the array is
   * sized from and `texStorage3D` is immutable.
   */
  private probes: ProbeGrid | null = null;
  /** Whether the grid supplies the scene's ambient. `ProbeBakeOptions.irradiance`, at grid scope. */
  private probeAmbient = true;
  /** Where the probe being baked stands. Reused, so a bake allocates nothing. */
  private readonly probeOrigin: Vec3 = [0, 0, 0];
  /**
   * The convolution that fills the probe's prefiltered cube. Null exactly when the probe is.
   *
   * Built beside the probe rather than on first bake, because a program compile in the frame a
   * caller happens to bake in is a stall in the middle of play — the argument `planarReflection.ts`
   * makes about its own target, and the same cost.
   */
  private readonly environmentPrefilter: EnvironmentPrefilterPass | null;
  /** Said once per renderer; see `updatePointShadows`. */
  private warnedNoPointShadowArray = false;
  /** Said once, for the retired ambient dial. */
  private warnedEnvironmentAmbient = false;
  /** Whether a probe is being baked, so the passes that would recurse into one can tell. */
  private probePassActive = false;
  /** The clip-control extension, or null where this context does not offer it. */
  private clipControl: ClipControlExtension | null = null;
  /**
   * Whether this context really is drawing reversed. See `RendererApi.reversedDepth`.
   *
   * Separate from `REVERSED_DEPTH`, which is what the engine wants: this is what it got. Every
   * depth decision below reads this one, so a context without `EXT_clip_control` behaves exactly
   * as it did before rather than half-reversed — and it is public because a consumer choosing a
   * near plane needs the granted answer and not the wished-for one.
   */
  reversedDepth = false;
  /**
   * What to clear depth to, for the convention this context was actually granted.
   *
   * **`DEPTH_CLEAR` is compile-time and this must not be.** That constant is `REVERSED_DEPTH ? 0 :
   * 1`, and `REVERSED_DEPTH` is what the engine wants rather than what a context gave — so on a
   * context without `EXT_clip_control` the buffer was cleared to 0 while `depthFunc` was correctly
   * set to `LEQUAL`, and **nothing in the scene could ever pass**: every fragment is at depth >= 0,
   * and only depth <= 0 passes. The frame that reaches the screen is the colour clear.
   *
   * **Reported from Firefox on Linux, which exposes no `EXT_clip_control`**, as every consumer
   * drawing one flat colour with its interface still on top, at a healthy 60 fps. The compare
   * beside it was already runtime; this was the half that was not, and the asymmetry is what made
   * it total rather than subtle.
   */
  private get depthClear(): number {
    return depthClearFor(this.reversedDepth);
  }
  /** `GL_DEPTH_REMAP * camera.viewProjection`, rebuilt once a frame. */
  private readonly sceneViewProj = new Float32Array(16);
  /**
   * The same matrix with clip y negated, for the six faces of a probe.
   *
   * Its own buffer rather than `sceneViewProj`, because `cubeFaceProjection` reads what
   * `sceneMatrix` just wrote and the two would be the same array.
   */
  private readonly cubeFaceViewProj = new Float32Array(16);
  /**
   * One buffer per shadow matrix that outlives a call, and that is not fussiness.
   *
   * A single scratch was enough while only the directional pass used it; two passes share the
   * correction now — the directional pass holds its result for the length of the pass and a point
   * shadow face holds it for the face — and one buffer means whichever ran last silently rewrites
   * the other. That is the same aliasing that sent a whole scene through the wrong projection when
   * the frame projection was cached.
   */
  private readonly shadowViewProj = new Float32Array(16);
  private readonly faceViewProjStore = new Float32Array(16);
  /** The shim `frameViewFor` hands out. One object, never two live at once. */
  private readonly correctedView: {
    position: FrameView['position'];
    view: FrameView['view'];
    viewProjection: FrameView['viewProjection'];
  } = {
    position: new Float32Array(3) as unknown as FrameView['position'],
    view: new Float32Array(16) as unknown as FrameView['view'],
    viewProjection: new Float32Array(16) as unknown as FrameView['viewProjection'],
  };

  /**
   * The scene's view-projection in the space this context's depth buffer expects.
   *
   * **The camera's own matrix stays OpenGL-convention and that is deliberate.** `frustum.ts`
   * extracts its planes on that assumption and says so, and the WebGPU backend corrects at the
   * last moment for the same reason — so the correction lives here, in the one place that uploads
   * it, and culling is untouched by any of this. Where the context is not reversed this hands back
   * the camera's matrix unchanged and multiplies nothing.
   */
  private viewProjFor(camera: { readonly viewProjection: ReadonlyMat4 }): ReadonlyMat4 {
    const scene = this.probePassActive
      ? (cubeFaceProjection(
          this.cubeFaceViewProj,
          this.sceneMatrix(camera.viewProjection) as unknown as ArrayLike<number>,
        ) as unknown as ReadonlyMat4)
      : this.sceneMatrix(camera.viewProjection);
    /*
     * **The jitter goes on here and nowhere else.** This is the one funnel every geometry upload
     * passes through, so one line covers the mesh passes, the sky, the water and the effects
     * without each of them learning what temporal antialiasing is. Shadow maps take
     * `shadowViewProj` and never reach this, which is correct: jittering a shadow map moves the
     * shadow rather than the sample, and would put a fringe on every contact edge.
     */
    if (!this.temporalJittering) return scene;
    return jitterProjection(
      this.jitteredViewProj,
      scene,
      this.temporalJitterX,
      this.temporalJitterY,
      Math.max(1, this.gl.drawingBufferWidth),
      Math.max(1, this.gl.drawingBufferHeight),
    );
  }

  /**
   * The same remap for a caller holding a matrix instead of a camera.
   *
   * **Only geometry wants this.** A matrix whose depth row never reaches a depth test must stay
   * raw: `uReflectionViewProj` is read as `.xy / .w` and nothing else, and the motion blur builds
   * its reprojection from `frameViewProj` and inverts it against a clip z the shader recovered in
   * OpenGL's sense — remapping either would be correcting something that was never wrong.
   */
  /**
   * The camera as the frame's drawing paths should see it: corrected once, here.
   *
   * **This is the seam this backend did not have.** WebGPU applies `CLIP_CORRECTION` in one place
   * at the last moment; every path here read `camera.viewProjection` for itself, in this file and
   * in five renderers beside it, so reversing depth meant finding and remapping each one. The
   * frame now owns one corrected view and hands it over, which is why `FrameView` exists.
   *
   * Rebuilt per call rather than cached per frame: `sceneMatrix` writes into one buffer, so a
   * caller holding this across a second call would see it move. Every consumer uses it and drops
   * it within the same draw.
   */
  private frameViewFor(camera: FrameView): FrameView {
    if (!this.reversedDepth) return camera;
    this.correctedView.position = camera.position;
    this.correctedView.view = camera.view;
    this.correctedView.viewProjection = this.sceneMatrix(camera.viewProjection);
    return this.correctedView as FrameView;
  }

  /** The shadow passes' range correction, which changes the range and not the sense. */
  private shadowMatrix(viewProj: ReadonlyMat4, into = this.shadowViewProj): ReadonlyMat4 {
    mat4.multiply(into as unknown as mat4, GL_SHADOW_REMAP as unknown as ReadonlyMat4, viewProj);
    return into as unknown as ReadonlyMat4;
  }

  private sceneMatrix(viewProj: ReadonlyMat4): ReadonlyMat4 {
    if (!this.reversedDepth) return viewProj;
    mat4.multiply(
      this.sceneViewProj as unknown as mat4,
      GL_DEPTH_REMAP as unknown as ReadonlyMat4,
      viewProj,
    );
    return this.sceneViewProj as unknown as ReadonlyMat4;
  }
  private shadowPassActive = false;
  /** Non-zero while the drawing buffer is pinned; see `lockDrawingBuffer`. */
  private lockedWidth = 0;
  private lockedHeight = 0;
  private activeShadowMap: ShadowMap | null = null;
  private reflectionPassActive = false;
  private reflectionReadyThisFrame = false;
  private reflectionAtmosphereY = 0;

  /** Callback state for allocation-free point-shadow depth passes. */
  private pointShadowCasters: ShadowCasters | null = null;

  /**
   * What the depth programs are currently configured to project by, and whether the
   * pass is peeling.
   *
   * Two programs record depth now — rigid meshes and instanced scatter — and only
   * one can be bound at a time. Rebinding one means re-uploading its matrix, so the
   * pass records what that matrix is instead of each draw guessing.
   */
  private activeDepthViewProj: ReadonlyMat4 = IDENTITY_MAT4;
  private activeDepthPeel = false;
  /**
   * Whether the depth pass this scatter draw interrupts wants back-face culling.
   *
   * Foliage is two-sided, so a scatter batch must be rasterised with culling off or
   * a blade facing away from the light casts nothing. The *directional* pass culls;
   * `PointShadowMap.bake` deliberately culls nothing for all six faces. Blindly
   * re-enabling after the draw would therefore start culling halfway through a
   * cubemap — so the pass states what it wants and this restores that.
   */
  private depthPassCullsFaces = true;

  /**
   * The one sink handed to every caster enumeration.
   *
   * Built once at construction, arrow properties closing over `this`: a sink created
   * per pass would allocate six objects per light per frame.
   */
  private readonly casterSink: ShadowCasterSink = {
    mesh: (mesh, model) => {
      this.shadowDrawBudget.ask();
      const { gl } = this;
      gl.uniformMatrix4fv(this.depthUniforms['uModel'] ?? null, false, model);
      /*
       * The sink takes the opaque handle both backends share, and this renderer only ever
       * handed out its own `Mesh`. Narrowing is safe here for that reason and nowhere else:
       * a handle from the other backend would have to have crossed renderers to arrive.
       */
      (mesh as Mesh).draw(gl);
    },
    /**
     * A batch into the depth map, placed by the same matrices the visible draw uses.
     *
     * No `uModel`: the instanced depth program has none, its placement being the four attribute
     * columns the batch's own buffer supplies.
     */
    instanced: (batch, data) => {
      const { gl } = this;
      const gpuBatch = batch as InstancedBatch;
      const count = Math.min(data.count, gpuBatch.capacity);
      if (count === 0) return;
      this.shadowDrawBudget.ask();
      const u = this.depthInstancedUniforms;
      gl.useProgram(this.depthInstancedProgram);
      gl.uniformMatrix4fv(u['uLightViewProj'] ?? null, false, this.activeDepthViewProj);
      gl.uniform1i(u['uPeelShadowLayer'] ?? null, this.activeDepthPeel ? 1 : 0);
      if (this.activeDepthPeel) gl.uniform1i(u['uPreviousShadowMap'] ?? null, 0);
      gpuBatch.mesh.drawInstances(gl, count);
      gl.useProgram(this.depthProgram);
    },
    skinnedMesh: (mesh, model, palette) => {
      this.shadowDrawBudget.ask();
      const { gl } = this;
      const u = this.depthSkinnedUniforms;
      gl.useProgram(this.depthSkinnedProgram);
      gl.uniformMatrix4fv(u['uLightViewProj'] ?? null, false, this.activeDepthViewProj);
      gl.uniform1i(u['uPeelShadowLayer'] ?? null, this.activeDepthPeel ? 1 : 0);
      /* The peel layer reads the first pass's depths; `beginShadowPass` bound that texture to
         unit 0 for the rigid program and this one samples the same unit. */
      if (this.activeDepthPeel) gl.uniform1i(u['uPreviousShadowMap'] ?? null, 0);
      gl.uniformMatrix4fv(u['uModel'] ?? null, false, model);
      this.skinPalette.update(gl, palette);
      this.skinPalette.bind(gl, SKIN_PALETTE_TEXTURE_UNIT);
      gl.uniform1i(u['uJointPalette'] ?? null, SKIN_PALETTE_TEXTURE_UNIT);
      /* Narrowing is safe for the reason `mesh` above gives: this renderer only ever handed
         out its own `Mesh`. */
      (mesh as Mesh).draw(gl);
      /* Hand the pass back exactly as it was found, the same contract `scatter` keeps: the
         enumeration may submit a rigid mesh next, and that one relies on the depth program
         still being bound. */
      gl.useProgram(this.depthProgram);
    },
    scatter: (scatter, data, windX, windZ, windGust, timeSeconds, trample = null) => {
      if (data.count === 0) return;
      this.scatterDepthBudget.ask();
      const { gl } = this;
      const u = this.scatterDepthUniforms;
      gl.useProgram(this.scatterDepthProgram);
      gl.uniformMatrix4fv(u['uLightViewProj'] ?? null, false, this.activeDepthViewProj);
      gl.uniform1i(u['uPeelShadowLayer'] ?? null, this.activeDepthPeel ? 1 : 0);
      // The peel layer reads the first pass's depths; `beginShadowPass` has already
      // bound that texture to unit 0 for the rigid program.
      if (this.activeDepthPeel) gl.uniform1i(u['uPreviousShadowMap'] ?? null, 0);
      this.bindScatterDeform(u, windX, windZ, windGust, timeSeconds, trample);

      gl.disable(gl.CULL_FACE);
      /* The surface hands out an opaque handle; this backend's are always its own. */
      (scatter as InstancedMesh).draw(gl, data.count);
      if (this.depthPassCullsFaces) gl.enable(gl.CULL_FACE);
      // Hand the pass back exactly as it was found: the enumeration may submit a
      // rigid mesh next, and that one relies on the depth program still being bound.
      gl.useProgram(this.depthProgram);
    },
  };

  private readonly drawPointShadowFace = (viewProj: ReadonlyMat4): void => {
    const casters = this.pointShadowCasters;
    if (casters === null) return;
    const { gl } = this;
    /*
     * **Range-corrected but not reversed, exactly as `beginShadowPass` does for the directional
     * cascades.** `EXT_clip_control` is context state: with it on, a face matrix still emitting
     * OpenGL's `[-1, 1]` loses everything below zero, so half of every point-shadow face is
     * clipped away. The map then shadows the wrong things and the scene reads as *shaded* rather
     * than broken, which is why it survived six attempts — it is the point-light shadow term, and
     * bisecting the lit expression is what finally named it.
     */
    const faceViewProj = this.reversedDepth
      ? this.shadowMatrix(viewProj, this.faceViewProjStore)
      : viewProj;
    this.activeDepthViewProj = faceViewProj;
    this.activeDepthPeel = false;
    gl.useProgram(this.depthProgram);
    gl.uniform1i(this.depthUniforms['uPeelShadowLayer'] ?? null, 0);
    gl.uniformMatrix4fv(this.depthUniforms['uLightViewProj'] ?? null, false, faceViewProj);
    casters(this.casterSink);
  };

  /**
   * Viewport in CSS pixels rather than device pixels.
   *
   * What screen-space overlays lay out against: sizing text in the drawing
   * buffer makes it a third the size on a high-DPI phone, which is exactly the
   * screen where it is hardest to read.
   */
  get cssWidth(): number {
    return this.canvas.clientWidth;
  }

  get cssHeight(): number {
    return this.canvas.clientHeight;
  }

  /**
   * Told when the drawing context is lost. See `attachContextLoss`.
   *
   * A lost context is a black screen the game does not otherwise notice: nothing
   * throws, the loop keeps running, and every draw call quietly does nothing.
   */
  onContextLost(listener: () => void): void {
    this.contextLostListeners.push(listener);
  }

  /**
   * Told when the drawing context comes back. See `attachContextLoss`.
   *
   * **This does not rebuild anything, and cannot:** every resource field on this class is
   * `readonly` and set in the constructor, which is the same reason a quality change is
   * construction-time. A listener that wants to draw again has to take the page through a
   * reload. It is here so the moment is visible in a trace rather than silent, and so the
   * promise `preventDefault` makes has somebody on the other end of it.
   */
  onContextRestored(listener: () => void): void {
    this.contextRestoredListeners.push(listener);
  }

  /* -- Visibility ----------------------------------------------------------------------- */

  /** Rebuilt once per `bindMeshPass`, never per draw. */
  private readonly frustum: Frustum = createFrustum();

  /**
   * Whether a mesh placed by this matrix is anywhere in the frame.
   *
   * Valid between `bindMeshPass` and `endFrame`, because that is when a camera has been given.
   * **A consumer is better placed to use this than `cullDraws` is**: it can skip the model
   * matrix, the animation update and the material switch as well, none of which the renderer can
   * avoid once `drawMesh` has been called.
   */
  visible(bounds: Bounds, model: ReadonlyMat4): boolean {
    return boundsVisible(this.frustum, bounds, model);
  }

  /* -- Occlusion culling ----------------------------------------------------------------- */

  /**
   * The occlusion buffer, or null where the profile did not ask for one.
   *
   * **Built at the first `bindMeshPass` rather than at construction**, because a field initialiser
   * runs before the constructor body and `quality` is not resolved yet there. Resized when the
   * drawing buffer's aspect changes and cleared at every pass — which is also where the
   * view-projection it projects through comes from.
   */
  private occlusion: OcclusionBuffer | null = null;

  /**
   * Declare a box that things behind it may safely be hidden by.
   *
   * **Between `bindMeshPass` and the first `drawMesh`**, because the pass is what supplies the
   * camera and the first test is what freezes the pyramid. A no-op when the profile asked for no
   * occlusion buffer, so a consumer may call it unconditionally.
   *
   * The box is in the model matrix's own space, and it is the box you may be *hidden by* rather
   * than the one you occupy — an occluder larger than the solid it stands for culls things that are
   * visible, which is a hole in the world. `OcclusionBuffer` carries the rest of the reasoning.
   */
  addOccluder(min: ArrayLike<number>, max: ArrayLike<number>, model: ReadonlyMat4): void {
    this.occlusion?.addOccluder(min as Float32Array, max as Float32Array, model);
  }

  /**
   * Declare a baked distance field that indirect light may be traced against.
   *
   * **Recorded by nothing on this backend, and that is the refusal rather than an oversight.**
   * Composing the world's field and marching probes through it is compute, and WebGL2 has no
   * compute stage — `INDIRECT_LIGHT_WEBGL2_REFUSAL` says so once a frame-loop when
   * `quality.indirectLight` is on. The method exists here because `RendererApi` is this class's
   * shape, and a consumer that declares its fields unconditionally must not have to ask which
   * backend it got: this is a no-op for the same reason `addOccluder` is one when the profile
   * asked for no occlusion buffer.
   *
   * The field is in the model matrix's own space and the matrix must carry uniform scale only.
   * `composeGlobalField` gives the reason: a distance is not preserved by a non-uniform scale.
   */
  addDistanceField(_field: FieldSource, _model: ReadonlyMat4, _albedo?: ArrayLike<number>): void {
    /* Deliberately nothing. See the comment above. */
  }

  /** Forget the fields declared this frame. A no-op here, as `addDistanceField` is. */
  clearDistanceFields(): void {
    /* Deliberately nothing. See `addDistanceField`. */
  }

  /** Never measured here, because nothing is composed. See `addDistanceField`. */
  get distanceFieldMs(): number | null {
    return null;
  }

  /** Never traced here either, so there is no refresh to time. See `addDistanceField`. */
  get indirectBakeMs(): number | null {
    return null;
  }

  /** Nothing to read, for the same reason. A consumer may call it unconditionally. */
  readDistanceFieldTimings(): void {
    /* Deliberately nothing. See `addDistanceField`. */
  }

  /**
   * Whether a mesh is entirely behind the occluders declared this frame.
   *
   * **False whenever anything is uncertain**, including when no occluders were declared and when
   * the profile asked for no buffer — so a consumer may call it unconditionally and a scene that
   * declares nothing behaves exactly as it did before. Read it beside `visible`, which answers the
   * other half of the same question.
   */
  occluded(bounds: Bounds, model: ReadonlyMat4): boolean {
    return this.occlusion?.occluded(bounds, model) ?? false;
  }

  /* -- Registered passes ---------------------------------------------------------------- */

  private readonly passes: PassRegistry = createPassRegistry();
  /** Built once so invoking somebody else's pass allocates nothing. See `PassDefinition.draw`. */
  /**
   * Built once and mutated, because `drawPass` is a per-frame path and the house rule about
   * allocation binds it. The grade is written each call, since it depends on the frame.
   */
  private passContext: {
    backend: 'webgl2';
    gl: WebGL2RenderingContext;
    outputTransform: number;
    outputExposure: number;
  } | null = null;
  private passDevice: PassDevice | null = null;

  /**
   * Let something outside this file draw into the frame.
   *
   * **The one thing that makes a rendering package possible.** The verb surface here is fixed and
   * a package cannot add to it, so `splats`, `ui2d` and `xr` had nowhere at all to put a draw
   * call. `init` runs now rather than at the first frame, because building a pipeline in the
   * frame loop is the allocation the house rules are about.
   */
  registerPass(definition: PassDefinition): PassHandle {
    const handle = registerIn(this.passes, definition);
    /* Identity: this backend's clip space is the one the projections are built for. */
    /* Both are identity here: this backend runs the GLSL natively, so there is nothing to
       correct and nothing a generator has flipped. */
    this.passDevice ??= {
      backend: 'webgl2',
      gl: this.gl,
      clipCorrection: IDENTITY_CLIP,
      depthCorrection: IDENTITY_CLIP,
    };
    if (definition.prepare !== undefined) this.preparingPasses++;
    definition.init?.(this.passDevice);
    return handle;
  }

  /**
   * How many registered passes declare `prepare`, so a frame with none walks nothing.
   *
   * The registry is a slot table and enumerating it every frame to discover that nobody wants a
   * step is exactly the per-frame work the house rules are about. A counter is one integer and
   * two increments over the life of a pass.
   */
  private preparingPasses = 0;
  /** Mutated in place, because `beginFrame` is a per-frame path. See `PassDefinition.prepare`. */
  private prepareContext: { backend: 'webgl2'; gl: WebGL2RenderingContext } | null = null;

  /**
   * Give every pass that owns a target its chance to fill it, before the frame's own is bound.
   *
   * **The default framebuffer is bound here and must still be bound when this returns** — the
   * contract `PrepareContext` writes out. Nothing verifies it, which is the honest state of this
   * backend: there is no verb-level graph to schedule against, so ordering is the caller's
   * politeness rather than a property of an encoder. What would make that wrong is two
   * target-owning passes and one of them misbehaving, and the answer then is a debug build that
   * reads the binding back after each `prepare` and names the pass that lost it.
   */
  private runPreparePasses(): void {
    if (this.preparingPasses === 0) return;
    this.prepareContext ??= { backend: 'webgl2', gl: this.gl };
    for (const definition of this.passes.definitions) {
      definition?.prepare?.(this.prepareContext);
    }
  }

  /**
   * Run one, here, now.
   *
   * **Immediate, because this backend draws immediately**: the framebuffer the frame is going
   * into is already bound and a callback *is* a pass. The WebGPU side records it instead and
   * runs it at the flush, and the difference is invisible to the caller — which is the point of
   * both. The caller's position in its own draw order is the only thing that decides where this
   * geometry lands, exactly as it is for every built-in verb.
   */
  drawPass(handle: PassHandle): void {
    if (this.contextLost) return;
    const definition = passAt(this.passes, handle);
    if (definition === undefined) return;
    this.passContext ??= {
      backend: 'webgl2',
      gl: this.gl,
      outputTransform: 0,
      outputExposure: 1,
    };
    const context = this.passContext;
    context.outputTransform = this.gradeCode();
    context.outputExposure = this.gradeExposure();
    definition.draw(context as PassContext);
  }

  /** Let go of a pass. A handle kept past this draws nothing; see `PassHandle`. */
  unregisterPass(handle: PassHandle): void {
    const definition = unregisterIn(this.passes, handle);
    if (definition?.prepare !== undefined) this.preparingPasses--;
    if (definition !== undefined && this.passDevice !== null) definition.dispose?.(this.passDevice);
  }

  /**
   * Whether this backend can run a compute definition at all. It cannot.
   *
   * **A value-typed member answered honestly**, which the 2026-08-13 rule requires of every
   * backend: a missing method names itself and a missing property is `undefined`, which in
   * arithmetic is a picture rather than an error. `FrameTimer.available` is the same shape, and
   * its comment names the alternative as the worst number available to invent.
   *
   * What it gives up: a consumer must branch, and a package that wants a GPU sort has to carry a
   * second implementation. What would make it wrong: nothing short of WebGL2 gaining compute
   * shaders, which it will not — the specification has none and is closed.
   */
  /*
   * Annotated `boolean` rather than left to infer `false`. `RendererApi` is derived from this
   * class, so an inferred literal type would make the *shared surface* demand `false` and the
   * other backend's honest `true` would not satisfy it. A member both backends answer must be
   * typed as the question, not as this backend's answer to it.
   */
  readonly computeSupported: boolean = false;

  /** Labels already refused, so a refusal is once a definition rather than once a frame. */
  private readonly refusedComputes = new Set<string>();

  /* -- The froxel table ----------------------------------------------------------------- */

  /**
   * The table the lit pass fetches, and the scratch the binner fills.
   *
   * **Allocated whether or not clustering is on**, because the sampler is declared
   * unconditionally and a declared sampler needs a complete texture bound to it — an incomplete
   * one is undefined behaviour a driver may read before it evaluates the branch that would have
   * skipped it, which is the argument `emptyTexture.ts` already makes. With clustering off this is
   * one texel rather than 292 KB.
   */
  private clusterTexture: WebGLTexture | null = null;
  private clusterTable: Uint32Array | null = null;
  /** Refilled per frame; holds references and allocates nothing. See `resolvePointLights`. */
  private readonly clusterLights: {
    count: number;
    positions: Float32Array;
    colors: Float32Array;
    radii: Float32Array;
    sourceRadii: Float32Array;
    weights: Float32Array;
  } = {
    count: 0,
    positions: new Float32Array(0),
    colors: new Float32Array(0),
    radii: new Float32Array(0),
    sourceRadii: new Float32Array(0),
    weights: new Float32Array(0),
  };
  /** near, far, tan(fovY/2), aspect — written per frame, uploaded as one vec4. */
  private readonly clusterFrustum = new Float32Array(4);

  /**
   * Bind the froxel table and the four numbers that address it.
   *
   * **Always, even with clustering off.** `uClustered` is what decides whether the shader reads
   * any of it, and the binding has to be valid either way; see `clusterTexture`.
   */
  /**
   * Upload the photometric profiles a consumer loaded, and bind the atlas.
   *
   * **Called once per set rather than per frame**, because a profile is an asset: a fixture's
   * distribution does not change while the game runs, and re-uploading it every frame would be a
   * texture upload per frame for data that is constant.
   *
   * Passing an empty list is how a consumer clears them, and it leaves the single row of ones the
   * atlas falls back to — which is the multiplicative identity rather than darkness, so a scene
   * that drops its profiles goes back to plain lights rather than going black.
   */
  /**
   * Upload the cookies a consumer loaded, and bind the atlas.
   *
   * **One row of square tiles**, `COOKIE_TILE` a side, each image scaled into its tile by the
   * driver. Called once per set rather than per frame, because a cookie is an asset: a fixture's
   * mask does not change while the game runs.
   *
   * Passing an empty list clears them and leaves the single white texel the atlas falls back to,
   * which is the multiplicative identity — a scene that drops its cookies goes back to plain
   * lights rather than going black.
   *
   * **The engine ships no cookie and never will**, which is the same line the glyph keys draw:
   * what a fixture throws is a consumer's art. `zero texture files` in `AGENTS.md` is a rule about
   * what the *engine* carries, and a consumer's own image has always been allowed — it is what
   * `createSurfaceTexture` and the material maps take.
   */
  setSpotCookies(images: readonly TexImageSource[]): void {
    const { gl } = this;
    this.cookieTiles = images.length;
    if (this.cookieTexture === null) this.cookieTexture = gl.createTexture();
    gl.activeTexture(gl.TEXTURE0 + COOKIE_ATLAS_TEXTURE_UNIT);
    gl.bindTexture(gl.TEXTURE_2D, this.cookieTexture);
    if (images.length === 0) {
      /* White, not black: this multiplies a light's colour. */
      gl.texImage2D(
        gl.TEXTURE_2D,
        0,
        gl.RGBA8,
        1,
        1,
        0,
        gl.RGBA,
        gl.UNSIGNED_BYTE,
        new Uint8Array([255, 255, 255, 255]),
      );
    } else {
      gl.texImage2D(
        gl.TEXTURE_2D,
        0,
        gl.RGBA8,
        COOKIE_TILE * images.length,
        COOKIE_TILE,
        0,
        gl.RGBA,
        gl.UNSIGNED_BYTE,
        null,
      );
      for (let tile = 0; tile < images.length; tile++) {
        const image = images[tile];
        if (image === undefined) continue;
        gl.texSubImage2D(gl.TEXTURE_2D, 0, tile * COOKIE_TILE, 0, gl.RGBA, gl.UNSIGNED_BYTE, image);
      }
    }
    /* Linear and clamped: a cookie is an image, and the shader's own inset is what keeps a tile
       from reaching its neighbour — clamping alone cannot, the seam being interior to the row. */
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.activeTexture(gl.TEXTURE0);
  }

  setIesProfiles(profiles: readonly PhotometricProfile[]): void {
    const { gl } = this;
    const atlas = packIesAtlas(profiles);
    if (this.iesTexture === null) this.iesTexture = gl.createTexture();
    gl.activeTexture(gl.TEXTURE0 + IES_ATLAS_TEXTURE_UNIT);
    gl.bindTexture(gl.TEXTURE_2D, this.iesTexture);
    /*
     * `LINEAR` across a row and clamped, unlike the froxel table's `NEAREST`. This one *is* a
     * curve rather than data addressed by index: interpolating between two columns is sampling
     * the distribution between two angles, which is exactly what is wanted, and clamping stops a
     * row bleeding into its neighbour at the edges.
     */
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    /*
     * One channel, because a row holds one number per angle and the other three would be three
     * quarters of the upload spent on nothing — and **half float rather than full**, matching what
     * the other backend must use: a 32-bit float texture is not filterable in core WebGPU, and this
     * row is a curve that wants linear filtering. Keeping the two formats the same is the
     * 2026-08-13 rule rather than tidiness; the driver converts the float data on the way in.
     */
    gl.texImage2D(
      gl.TEXTURE_2D,
      0,
      gl.R16F,
      atlas.width,
      atlas.height,
      0,
      gl.RED,
      gl.FLOAT,
      atlas.data,
    );
    this.iesRows = atlas.height;
    this.iesPlanes = atlas.planes;
    gl.bindTexture(gl.TEXTURE_2D, null);
  }

  /** Bind the atlas and say how many rows it has. Always, for the reason `bindClusters` gives. */
  private bindIesAtlas(u: Record<string, WebGLUniformLocation>): void {
    const { gl } = this;
    if (this.iesTexture === null) this.setIesProfiles([]);
    gl.activeTexture(gl.TEXTURE0 + IES_ATLAS_TEXTURE_UNIT);
    gl.bindTexture(gl.TEXTURE_2D, this.iesTexture);
    gl.uniform1i(u['uIesAtlas'] ?? null, IES_ATLAS_TEXTURE_UNIT);
    gl.uniform1f(u['uIesAtlasRows'] ?? null, this.iesRows);
    gl.uniform1f(u['uIesPlaneCount'] ?? null, this.iesPlanes);
    /* Built on demand rather than at construction, for the reason the grade's placeholder is: a
       scene that never projects a cookie should not carry a texture, and a declared sampler still
       needs a complete one. */
    if (this.cookieTexture === null) this.setSpotCookies([]);
    gl.activeTexture(gl.TEXTURE0 + COOKIE_ATLAS_TEXTURE_UNIT);
    gl.bindTexture(gl.TEXTURE_2D, this.cookieTexture);
    gl.uniform1i(u['uCookieAtlas'] ?? null, COOKIE_ATLAS_TEXTURE_UNIT);
    gl.uniform1f(u['uCookieTiles'] ?? null, this.cookieTiles);
    gl.activeTexture(gl.TEXTURE0);
  }

  private bindClusters(
    u: Record<string, WebGLUniformLocation>,
    camera: Camera,
    env: Environment,
  ): void {
    const { gl } = this;
    const on = this.quality.clusteredLights;

    if (this.clusterTexture === null) {
      this.clusterTexture = gl.createTexture();
      gl.activeTexture(gl.TEXTURE0 + CLUSTER_TABLE_TEXTURE_UNIT);
      gl.bindTexture(gl.TEXTURE_2D, this.clusterTexture);
      /*
       * `NEAREST` and clamped, because this is data rather than a picture: every read is a
       * `texelFetch`, which ignores filtering, and a filtered integer texture is invalid anyway.
       */
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA32UI, on ? TABLE_WIDTH : 1, on ? TABLE_HEIGHT : 1);
    }

    gl.activeTexture(gl.TEXTURE0 + CLUSTER_TABLE_TEXTURE_UNIT);
    gl.bindTexture(gl.TEXTURE_2D, this.clusterTexture);
    gl.uniform1i(u['uClusterTable'] ?? null, CLUSTER_TABLE_TEXTURE_UNIT);
    gl.uniform1i(u['uClustered'] ?? null, on ? 1 : 0);
    if (!on) return;

    /*
     * The frustum, read off the projection rather than taken as a parameter.
     *
     * A perspective matrix carries `1 / tan(fovY/2)` at [5] and that over the aspect at [0], and
     * the near and far planes in [14] and [10]. Deriving them here means the binner and the shader
     * cannot disagree with the matrix the world was actually drawn with — which a caller-supplied
     * field of view could, silently, on any frame where the two got out of step.
     */
    const p = camera.projection;
    const tanHalfFovY = 1 / (p[5] ?? 1);
    const aspect = (p[5] ?? 1) / (p[0] ?? 1);
    const near = (p[14] ?? 0) / ((p[10] ?? -1) - 1);
    const far = (p[14] ?? 0) / ((p[10] ?? -1) + 1);
    this.clusterFrustum[0] = near;
    this.clusterFrustum[1] = far;
    this.clusterFrustum[2] = tanHalfFovY;
    this.clusterFrustum[3] = aspect;
    gl.uniform4fv(u['uClusterFrustum'] ?? null, this.clusterFrustum);
    gl.uniformMatrix4fv(u['uView'] ?? null, false, camera.view);

    this.clusterTable ??= createClusterTable();
    const lights = this.clusterLights;
    lights.count = Math.min(env.lightCount ?? 0, MAX_CLUSTERED_LIGHTS);
    lights.positions = env.lightPositions;
    lights.colors = env.lightColors;
    lights.radii = env.lightRadii;
    lights.sourceRadii = env.lightSourceRadii ?? env.lightRadii;
    lights.weights = env.lightWeights;
    buildLightClusters(
      lights as ClusterLightSet,
      camera.view as Float32Array,
      near,
      far,
      tanHalfFovY,
      aspect,
      this.clusterTable,
      /*
       * The budget this renderer's shader was built at, not the engine's own. A froxel record
       * carries the light's shadow slot, and on a part whose uniform grid could not hold the full
       * budget the shadow arrays are shorter than the light list: a light past the end has no slot
       * to name, and saying so here is what stops the shader having to discover it. The shader
       * guards the read as well, for a build that reaches it another way.
       */
      this.lightBudget.maxLights,
    );
    gl.texSubImage2D(
      gl.TEXTURE_2D,
      0,
      0,
      0,
      TABLE_WIDTH,
      TABLE_HEIGHT,
      gl.RGBA_INTEGER,
      gl.UNSIGNED_INT,
      this.clusterTable,
    );
  }

  /**
   * Refuse, in words, and hand back the handle that names nothing.
   *
   * **This is the defined-state half of the 2026-08-13 rule**, whose other half forbids a silent
   * no-op. There is nothing to degrade *to* here — a pass this backend cannot run can at least be
   * an empty method that leaves a visible hole in the picture, and a compute stage has no picture
   * to leave a hole in. So the degraded state is the refusal itself, spoken at the one moment a
   * consumer can still act on it: registration, which is init time, where the house rule puts
   * failures and never the frame loop, where it forbids them.
   *
   * **Zero rather than a live handle**, because `definitionAt` already reads zero as naming
   * nothing — handles start at 1 for exactly this reason — so the `dispatchCompute` that follows
   * is a no-op which has already announced itself rather than one that never speaks.
   *
   * `console.error` rather than a throw, for the reason `createGpuSurface` gives about the same
   * choice: a consumer registering during boot should get a diagnostic it can act on, not an
   * exception that takes the page down over a capability it can live without.
   */
  registerCompute(definition: ComputeDefinition): ComputeHandle {
    if (!this.refusedComputes.has(definition.label)) {
      this.refusedComputes.add(definition.label);
      console.error(
        `[driftengine] registerCompute(${JSON.stringify(definition.label)}) on the WebGL2 ` +
          'backend: WebGL2 has no compute shaders, so this will never be dispatched. Read ' +
          'renderer.computeSupported before registering, and supply the work another way.',
      );
    }
    return 0;
  }

  /** Nothing was registered, so there is nothing to dispatch. See `registerCompute`. */
  dispatchCompute(_handle: ComputeHandle): void {}

  /** Nothing was registered, so there is nothing to release. See `registerCompute`. */
  unregisterCompute(_handle: ComputeHandle): void {}

  /** Side length of the depth map, so callers can size the light frustum. */
  get shadowMapSize(): number {
    return this.quality.directionalShadowMapSize;
  }

  private readonly pickables = new PickableSet();
  private readonly pickOrigin = new Float32Array(3);
  private readonly pickDirection = new Float32Array(3);

  /**
   * Construct the WebGL2 renderer directly.
   *
   * @deprecated Use `createRenderer(canvas, quality)`. This constructor can only ever give
   * you WebGL2, so a consumer that calls it opts out of WebGPU permanently and silently.
   * `createRenderer` returns the best backend the browser will give, falls back to this one
   * on its own, and tells you which it built.
   *
   * **It keeps working and it is not going away.** Three applications construct one today
   * and none of them is being made to move on a schedule that is not theirs; the deprecation
   * is how a *new* consumer is pointed at the right door, not a removal notice. The engine's
   * own factory calls it, which is the point: this is the implementation of the WebGL2
   * branch rather than a path being retired.
   */
  constructor(canvas: HTMLCanvasElement, qualityOptions: RenderQualityOptions = {}) {
    this.quality = resolveRenderQuality(qualityOptions);
    /* The grade this world asked for, until a frame says otherwise. See `setOutputExposure`. */
    this.exposure = this.quality.outputExposure;
    /*
     * Multisampling, but only when anything can use it.
     *
     * With `screenEffects` on, the scene is drawn into a single-sampled off-screen
     * target and the *only* thing that reaches the default framebuffer is one
     * fullscreen triangle carrying the finished image. A triangle covering the
     * viewport has no interior edges, so multisampling it is provably a no-op:
     * forcing `antialias: false` moved `gl.SAMPLES` from 4 to 0 with screenshots
     * that compare identical.
     *
     * It was not free, though. `antialias: true` makes the browser allocate a
     * multisampled backbuffer and resolve it every frame — at 4x and 4K that is
     * hundreds of megabytes of allocation and a full-screen resolve, spent on
     * nothing. Worth 2.5% even on a card with bandwidth to spare, and far more on
     * an integrated part where that memory comes out of the same budget the
     * shadow pool is already competing for.
     *
     * When `screenEffects` is off the scene draws straight to the canvas, its
     * geometry edges land here, and multisampling is exactly what it should be.
     */
    /*
     * `alpha: false` because the canvas has never had anything to say about what is
     * behind it, and saying so is worth a full-screen composite every frame.
     *
     * The default is `true`, and it is a promise the renderer then never uses: `beginFrame`
     * clears with an alpha of 1 and source-alpha blending leaves the destination at 1, so
     * every pixel handed to the browser is already opaque. Believing otherwise, the
     * compositor has to blend the whole drawing buffer over the page for every frame, and
     * it cannot treat the layer as opaque — which is the fast path fullscreen exists to
     * hand out, and the one place the cost of getting this wrong is most visible.
     *
     * Nothing here wants the other behaviour. `uOpacity` blends meshes against the *scene*,
     * not against the document; the page behind is `#000` in the one place any of the
     * canvas's box is uncovered, which is the letterboxing around a locked export buffer.
     */
    const gl = canvas.getContext('webgl2', {
      alpha: false,
      antialias: !this.quality.screenEffects,
      powerPreference: 'high-performance',
    });
    if (gl === null) {
      throw new Error('WebGL2 is not available. This engine requires a WebGL2-capable browser.');
    }

    this.gl = gl;
    this.canvas = canvas;
    /*
     * Before any pass can bind a sampler, so there is never a frame where "unused" means
     * "unbound". Two 1x1 uploads for the life of the renderer.
     */
    this.emptyTexture2D = createEmptyTexture2D(gl);
    this.emptyTexture2DArray = createEmptyTexture2DArray(gl);
    this.emptyTextureCube = createEmptyTextureCube(gl);
    this.gpuTimer = new GpuTimer(gl);
    this.detachContextLoss = attachContextLoss(
      canvas,
      () => {
        this.contextLostFlag = true;
        for (const listener of this.contextLostListeners) listener();
      },
      () => {
        this.contextLostFlag = false;
        for (const listener of this.contextRestoredListeners) listener();
      },
    );
    /*
     * What the part says it is. Read here because this is the first moment the context
     * exists and the last moment before anything is sized against it.
     *
     * The game used to read this itself with its own `canvas.getContext('webgl2')`, which
     * was a trap as well as a duplicate: a second `getContext` on the same canvas returns
     * the *existing* context and silently ignores the attributes, so whoever called it
     * first decided `alpha`, `antialias` and `powerPreference` for everybody.
     */
    this.rendererName = webgl2RendererName(gl);

    /*
     * A known-weak part opens softer than it was asked to.
     *
     * The shape already exists here and `main.ts` already reports it: settings *ask* for a
     * profile, the renderer *resolves* one, and a `TRACE.quality` mark carries both so a
     * bug report shows the difference. This is one more reason they can differ, and
     * `NFD6QQ` is why it needs to exist — an Adreno 619 opened at dpr 2.625 with a
     * full-size reflection because the default quality is a constant for every device.
     *
     * **Only the pixel terms move.** The shadow and water switches are what a preset
     * *means*, and silently drawing a different scene than the settings screen describes
     * is worse than drawing the right one at fewer pixels. Both terms here are also ones
     * the player can already reach themselves, so nothing is happening that the settings
     * screen could not do.
     *
     * It is a floor and not a verdict: `ResolutionGovernor` moves the density afterwards
     * from measurement, in both directions, so a wrong guess costs one soft second rather
     * than a soft session.
     *
     * **`capabilityClamp: false` turns the whole thing off**, and a caller passes it to mean
     * "this person chose these numbers themselves". A player who deliberately asks a weak
     * part for the good profile is entitled to it and to the frame rate that comes with it;
     * a setting that silently does not apply is worse than a slow game.
     */
    this.capabilityClamped = this.quality.capabilityClamp && isWeakGpuFamily(this.rendererName);
    if (this.capabilityClamped) {
      this.quality = {
        ...this.quality,
        maxDevicePixelRatio: Math.min(this.quality.maxDevicePixelRatio, 1),
        waterReflectionScale: Math.min(this.quality.waterReflectionScale, 0.5),
        /*
         * **The one ceiling here that is a per-pixel loop**, so it is the one a weak part gains
         * most from and the one a settings screen would have to know about to lower by hand. It
         * is still a floor and not a verdict: a consumer that means the number it asked for
         * passes `capabilityClamp: false`, exactly as it does for the two above.
         */
        globalMediumSteps: Math.min(this.quality.globalMediumSteps, WEAK_GPU_MEDIUM_STEPS),
      };
    }

    this.maxDpr = this.quality.maxDevicePixelRatio;
    this.maxDrawingBufferPixels = this.quality.maxDrawingBufferPixels;

    /*
     * The texture units the shading pass needs, against the units this device has.
     *
     * **The lit pass binds five and WebGL2 guarantees sixteen.** Three directional maps at
     * 0-2, the point-shadow array at 3, and `SURFACE_TEXTURE_UNIT` at 4. It used to bind all
     * sixteen — the point shadows were twelve separate cubemaps — and the highest index it
     * wrote was a constant that was never once compared against what the driver offers.
     *
     * Every Apple GPU reports exactly 16. So does a great deal of mobile hardware. An
     * engine sitting precisely on a hard limit is fragile whether or not a given driver
     * happens to tolerate it, and the failure it produces is the worst kind: the samplers
     * bind, the program links, the draw is issued, and the *shading* comes out wrong. A
     * scene lit only by point lights renders as its emissive geometry on a black field,
     * which is not recognisable as a resource problem by anybody looking at it.
     *
     * So it is checked, and the thing given up is the one that costs the least: shadows
     * from point lights. **A light that cannot have a shadow is still a light** — it goes
     * on lighting the scene, and the room stays lit. Giving up the light instead, or
     * throwing, would both be worse than a slightly flatter picture.
     *
     * The budget was once allowed to fill the limit **exactly**, and that was not an
     * oversight. `MAX_TEXTURE_IMAGE_UNITS` is a count, so a device reporting 16 has units 0
     * through 15 and a surface at 15 was the last legal one — an exact fit, not an overflow.
     * Keeping a spare unit back instead cost every Apple GPU its point shadows, since 16 is
     * exactly what they all report, and the warning it printed then sent a real investigation
     * chasing a resource limit that was never exceeded. A guard that cries wolf on conformant
     * hardware is worse than no guard: it is a false lead with the engine's own authority
     * behind it. That is why this still compares rather than assumes, even with eleven units
     * spare — the arithmetic below is the thing that has to stay true, not the margin.
     */
    const maxTextureUnits = gl.getParameter(gl.MAX_TEXTURE_IMAGE_UNITS) as number;
    /*
     * `POINT_SHADOW_UNITS`, not one per light. It was `MAX_POINT_LIGHTS + LIVE_POINT_SHADOW_MAPS`
     * while each map was its own `samplerCube`; leaving it that way while raising the light cap
     * would have counted eighteen units for one binding and switched point shadows off on every
     * device reporting the guaranteed sixteen — the exact false alarm this guard's own comment
     * warns about, from the other direction.
     */
    const unitsWanted =
      (this.quality.directionalShadows ? DIRECTIONAL_SHADOW_UNITS : 0) +
      (this.quality.pointShadows ? POINT_SHADOW_UNITS : 0) +
      1;
    if (this.quality.pointShadows && unitsWanted > maxTextureUnits) {
      console.warn(
        `Renderer: the shading pass wants ${unitsWanted} texture units and this GPU offers ` +
          `${maxTextureUnits}. Point-light shadows are off; the lights themselves are not.`,
      );
      this.quality = { ...this.quality, pointShadows: false };
    }

    /*
     * The reflection probe, if one was asked for and there is a unit left to bind it to.
     *
     * The seventeenth unit, and WebGL2 guarantees sixteen — see `ENVIRONMENT_TEXTURE_UNIT`.
     * Where there is no room, the probe is what goes rather than the point shadows: a surface
     * that cannot mirror the room still reflects the approximation it always did, while a scene
     * that lost its shadows to make room for one material's reflection would be a worse picture
     * everywhere. Declined out loud, because a quality option that silently does not apply is
     * the failure `capabilityClamp` exists to avoid.
     *
     * Built before the flat program is compiled, because whether it exists decides whether that
     * program declares the probe array at all.
     */
    /* Both: the size says how good and `environmentReflections` says whether at all, and a
       consumer turning the feature off keeps the sky-and-ground gradient below. */
    const probeWanted = this.quality.environmentReflections && this.quality.reflectionProbeSize > 0;
    if (probeWanted && maxTextureUnits <= ENVIRONMENT_TEXTURE_UNIT) {
      console.warn(
        `Renderer: a reflection probe needs texture unit ${ENVIRONMENT_TEXTURE_UNIT} and this ` +
          `GPU offers ${maxTextureUnits}. Reflective surfaces keep the sky-and-ground ` +
          `approximation; nothing else changes.`,
      );
    }
    this.probeCapture =
      probeWanted && maxTextureUnits > ENVIRONMENT_TEXTURE_UNIT
        ? new ReflectionProbe(gl, this.quality.reflectionProbeSize, this.quality.hdrScene)
        : null;
    this.environmentPrefilter =
      this.probeCapture === null ? null : new EnvironmentPrefilterPass(gl);

    const maxTextureSize = gl.getParameter(gl.MAX_TEXTURE_SIZE) as number;
    const maxCubeSize = gl.getParameter(gl.MAX_CUBE_MAP_TEXTURE_SIZE) as number;
    if (this.quality.directionalShadows && this.quality.directionalShadowMapSize > maxTextureSize) {
      throw new Error(
        `Directional shadow size ${this.quality.directionalShadowMapSize} exceeds GPU limit ${maxTextureSize}`,
      );
    }
    if (this.quality.pointShadows && this.quality.pointShadowFaceSize > maxCubeSize) {
      throw new Error(
        `Point shadow face size ${this.quality.pointShadowFaceSize} exceeds GPU limit ${maxCubeSize}`,
      );
    }

    gl.enable(gl.DEPTH_TEST);

    /*
     * **Reversed depth needs clip z in [0, 1], and OpenGL's is [-1, 1].**
     *
     * `EXT_clip_control` is what moves it, and it is asked for rather than assumed: without it
     * the flip can still be folded into the projection, but the float exponent then lands its
     * resolution in the middle of the range instead of at the near plane, which is most of the
     * point. So a context that does not offer the extension keeps the conventional sense, and
     * says so once — a silent fallback here would be a consumer wondering why their decals still
     * fight on one machine and not another.
     *
     * Measured on an RX 9070 XT through ANGLE/Vulkan: offered. `scripts/depth-survey.mjs` is what
     * asks, and it also reports what WebGPU can do.
     */
    this.clipControl = gl.getExtension('EXT_clip_control') as ClipControlExtension | null;
    if (REVERSED_DEPTH && this.clipControl !== null) {
      this.clipControl.clipControlEXT(
        this.clipControl.LOWER_LEFT_EXT,
        this.clipControl.ZERO_TO_ONE_EXT,
      );
      this.reversedDepth = true;
    } else if (REVERSED_DEPTH) {
      console.warn(
        '[drift] EXT_clip_control is not available, so depth stays conventional on this context. ' +
          'Decals will need the offsets a hyperbolic depth buffer asks for.',
      );
    }

    gl.depthFunc(this.reversedDepth ? gl.GEQUAL : gl.LEQUAL);
    gl.clearDepth(this.reversedDepth ? 0 : 1);
    gl.enable(gl.CULL_FACE);
    gl.cullFace(gl.BACK);

    /*
     * Built for the profile this renderer resolved, not for every profile at once — so a
     * world with shadows off compiles none of the shadow path. See `shaders/flat.ts`.
     */
    const fitted = this.fitFlatProgram(gl);
    this.flatProgram = fitted.program;
    this.flatFragSource = fitted.source;
    this.lightBudget = fitted.budget;
    this.flatUniforms = uniformLocations(gl, this.flatProgram, 'flat');
    this.flatTargets.push({ program: this.flatProgram, uniforms: this.flatUniforms });

    this.lightVolumeProgram = compileProgram(
      gl,
      LIGHT_VOLUME_VERT,
      lightVolumeFrag({ directionalShadows: this.quality.directionalShadows }),
      'lightVolume',
    );
    this.lightVolumeUniforms = uniformLocations(gl, this.lightVolumeProgram, 'lightVolume');

    this.panelProgram = compileProgram(gl, PANEL_VERT, PANEL_FRAG, 'panel');
    this.panelUniforms = uniformLocations(gl, this.panelProgram, 'panel');
    const panelVao = gl.createVertexArray();
    if (panelVao === null) throw new Error('Failed to create panel VAO');
    this.panelVao = panelVao;
    gl.bindVertexArray(panelVao);
    const panelBuffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, panelBuffer);
    // A unit quad. The rectangle it becomes is a uniform, so this is uploaded once
    // for the life of the renderer however many panels are drawn.
    gl.bufferData(
      gl.ARRAY_BUFFER,
      new Float32Array([0, 0, 1, 0, 0, 1, 0, 1, 1, 0, 1, 1]),
      gl.STATIC_DRAW,
    );
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.bindVertexArray(null);
    this.filmProgram = compileProgram(gl, FILM_VERT, FILM_FRAG, 'film');
    this.sceneTarget = this.quality.screenEffects
      ? new SceneTarget(
          gl,
          this.quality.sceneSamples,
          this.quality.hdrScene,
          this.quality.discardResolvedAttachments,
        )
      : null;
    /*
     * Said once at init, because the number a caller asked for and the number the part gave
     * them are not always the same, and a silently clamped sample count is a quality setting
     * that does not apply — the same failure mode `capabilityClamp` exists to avoid.
     */
    const got = this.sceneTarget?.sampleCount ?? 1;
    if (this.quality.sceneSamples > 1 && got !== this.quality.sceneSamples) {
      console.warn(
        `Renderer: ${this.quality.sceneSamples}x scene multisampling was requested and this ` +
          `context gives ${got}x.`,
      );
    }
    /*
     * Bloom asked for where it cannot mean what it says, said once at init.
     *
     * Not a clamp and not a refusal: the effect still runs and still spreads whatever passes
     * its threshold. What it cannot do is separate a light from a white wall, because on a
     * target that does not keep the range they arrive as the same colour. That is the class of
     * fault this engine has already shipped twice under other names — a shadow strength of
     * zero behind an enabled shadow pass, an exposure with no curve to be exposed into — where
     * everything is switched on, nothing is wrong, and nothing happens.
     */
    if (this.quality.bloom > 0) {
      const profile = bloomProfileWarning(this.quality);
      if (profile !== null) {
        console.warn(`Renderer: ${profile}`);
      } else if (this.sceneTarget?.keepsRange === false) {
        console.warn(
          'Renderer: hdrScene was asked for and this context has no EXT_color_buffer_float, so ' +
            'the scene target is eight-bit and the bloom threshold means whiteness rather than ' +
            'brightness.',
        );
      }
    }
    this.filmUniforms = uniformLocations(gl, this.filmProgram, 'film');
    /* The variant matching what this context was granted, not what the engine wants. See
       `skyVertFor`: a sky written at the reversed far plane on a conventional context sits in the
       middle of the depth range and paints over everything behind it. */
    this.skyProgram = compileProgram(gl, skyVertFor(this.reversedDepth), SKY_FRAG, 'sky');
    this.skyUniforms = uniformLocations(gl, this.skyProgram, 'sky');
    this.scatterProgram = compileProgram(gl, SCATTER_VERT, SCATTER_FRAG, 'scatter');
    this.scatterUniforms = uniformLocations(gl, this.scatterProgram, 'scatter');
    this.depthProgram = compileProgram(gl, DEPTH_VERT, DEPTH_FRAG, 'depth');
    this.depthUniforms = uniformLocations(gl, this.depthProgram, 'depth');
    this.depthSkinnedProgram = compileProgram(gl, DEPTH_SKINNED_VERT, DEPTH_FRAG, 'depth-skinned');
    /* The third depth program: placement from attributes, so an instanced batch casts one shadow
       per instance rather than one for the batch. See `DEPTH_INSTANCED_VERT`. */
    this.depthInstancedProgram = compileProgram(
      gl,
      DEPTH_INSTANCED_VERT,
      DEPTH_FRAG,
      'depth-instanced',
    );
    this.depthInstancedUniforms = uniformLocations(
      gl,
      this.depthInstancedProgram,
      'depth-instanced',
    );
    this.depthSkinnedUniforms = uniformLocations(gl, this.depthSkinnedProgram, 'depth-skinned');
    /*
     * Compiled unconditionally, alongside every other program, even on a profile with
     * shadows off. An unused shader is a compile error waiting for its first caller —
     * this repo has shipped a black screen that way, because a program nobody compiled
     * typechecks, builds and tests green.
     */
    this.scatterDepthProgram = compileProgram(gl, SCATTER_DEPTH_VERT, DEPTH_FRAG, 'scatterDepth');
    this.scatterDepthUniforms = uniformLocations(gl, this.scatterDepthProgram, 'scatterDepth');
    this.shadowMap = this.quality.directionalShadows
      ? new ShadowMap(gl, this.quality.directionalShadowMapSize)
      : null;
    // A second static depth layer preserves both occluders where two world
    // shadows overlap. It is depth-peeled from the first map below.
    this.peeledShadowMap =
      this.quality.directionalShadows && this.quality.directionalShadowDepthLayers > 1
        ? new ShadowMap(gl, this.quality.directionalShadowMapSize)
        : null;
    // Movers get an independent layer. It preserves distance fading when a
    // moving and a static caster overlap: their transmissions multiply rather
    // than one depth replacing the other.
    this.dynamicShadowMap = this.quality.directionalShadows
      ? new ShadowMap(gl, this.quality.directionalShadowMapSize)
      : null;
    // Static maps are allocated once the world reports its light count. No
    // cubemap resources exist at all when the quality profile disables them.
    /*
     * A factory rather than a context, because the pool is shared with the other backend and
     * a pool that named a device would be two pools. See `PointShadowSource`.
     */
    this.pointShadows = this.quality.pointShadows
      ? new PointShadowSystem<PointShadowMap>(
          /*
           * `() => this.pointShadowArray` rather than the array itself: the live maps are built
           * inside this constructor, before any world has said how many lights it has, and the
           * array is sized from that count and rebuilt if a later world says more. A map reads
           * it once per resolved face, which is nowhere near a per-fragment path.
           */
          (layer) =>
            new PointShadowMap(
              () => this.pointShadowArray,
              layer,
              this.quality.pointShadowFaceSize,
            ),
          (map) => map.dispose(gl),
        )
      : null;
    /*
     * A rectangle's layers, above the pool in the same array — so this is null exactly when the
     * pool is. Same factory, because an area light's map *is* a point light's map on another
     * layer; see `AreaShadowMap` for why neither backend needs a second class.
     */
    this.areaShadows = this.quality.pointShadows
      ? new AreaShadowSet<PointShadowMap>(
          (layer) =>
            new PointShadowMap(
              () => this.pointShadowArray,
              layer,
              this.quality.pointShadowFaceSize,
            ),
          (map) => map.dispose(gl),
        )
      : null;
    /* Water's own reflection, or a surface that asked for one without being water. See
       `RenderQuality.planarReflections`. */
    this.planarReflection =
      (this.quality.water && this.quality.waterReflections) || this.quality.planarReflections
        ? new PlanarReflection(
            gl,
            this.quality.waterReflectionScale,
            maxTextureSize,
            this.quality.discardResolvedAttachments,
          )
        : null;

    const skyVao = gl.createVertexArray();
    if (skyVao === null) throw new Error('createVertexArray failed');
    this.skyVao = skyVao;
  }

  // --- Resource factories --------------------------------------------------

  /**
   * Release the drawing context and everything this renderer created on it.
   *
   * Needed by any consumer whose renderer does not live as long as its page. A game that
   * *is* the page builds its renderer once and never tears it down, and for a long time
   * nothing here noticed the other shape existed: a game embedded in a website is mounted
   * when the player enters it and unmounted when they leave.
   *
   * Without this, each mount leaks a WebGL context. Browsers cap how many a process may
   * hold — Chrome at around sixteen — and past the cap `getContext` starts returning
   * null, so the failure is not a slow leak but a game that abruptly refuses to start
   * with "WebGL2 is not available" on a machine that plainly has it. Entering and
   * leaving a level a dozen times is enough.
   *
   * **The context is not dropped by default, and that is the hard-won part.** The obvious
   * implementation ends with `WEBGL_lose_context.loseContext()`, since the context is the
   * capped resource and deleting objects does not hand it back. But the context belongs
   * to the *canvas*, and the canvas belongs to the consumer — and a canvas whose context
   * has been lost this way is dead until something calls `restoreContext` on it.
   *
   * A React consumer keeps the same `<canvas>` element across an effect re-run, so a
   * default `loseContext` poisons the element the next renderer is about to be built on:
   * it reports success, then every call fails with "object does not belong to this
   * context" and the screen is black. Measured exactly that way while porting an
   * embedded scene, where a hot reload made it look like the renderer had broken itself.
   *
   * So the default frees what this class allocated and leaves the canvas usable. A
   * consumer that is *discarding* the canvas — the normal unmount — can pass
   * `releaseContext` to hand the context back immediately rather than waiting for the
   * element to be collected, which is worth doing because browsers cap contexts per
   * process (Chrome at about sixteen) and past the cap `getContext` returns null.
   *
   * Idempotent, because a teardown path that can run twice — a React effect cleanup
   * racing an unmount — must not throw on the second call.
   */
  /**
   * Resolve once every pipeline this renderer holds is ready to draw with.
   *
   * **Immediate on this backend, and that is the point of it being here.** WebGL2 links a
   * program synchronously inside `compileProgram`, so nothing is ever outstanding by the time
   * a caller holds a renderer. WebGPU is the opposite: `createRenderPipeline` returns before
   * the driver has compiled anything and leaves the shader to the first draw that needs it,
   * which puts the cost inside a frame with the queue stalled behind it. A consumer awaiting
   * this before its first frame gets the right behaviour on both without asking which backend
   * it has, which is the contract `RendererApi` exists to keep.
   */
  async ready(): Promise<void> {}

  dispose(options: { releaseContext?: boolean } = {}): void {
    if (this.disposed) return;
    this.disposed = true;

    const { gl } = this;
    this.detachContextLoss();
    this.contextLostListeners.length = 0;
    this.contextRestoredListeners.length = 0;

    /*
     * Registered passes let go of what they built, before this renderer lets go of its own.
     *
     * **Nothing released them until now.** `unregisterPass` always has, and nothing called it on
     * teardown, so a consumer that creates and destroys renderers — a page switching worlds, an
     * editor reopening a viewport, a test suite — kept a program and its buffers per registration
     * per renderer for as long as the process lived.
     *
     * **Told only while there is a context**, for the reason the block below is gated the same
     * way: a lost context already took every object a definition built, and asking the
     * replacement to delete the dead one's is the INVALID_OPERATION that block counts. The
     * registry is emptied either way, because that part is bookkeeping and costs nothing — and a
     * handle kept past teardown then draws nothing rather than answering to a released slot.
     *
     * What it costs: a contributor holding something that is *not* a GL object is not told on the
     * lost-context path. What would make it wrong: `PassDefinition.dispose` coming to mean more
     * than releasing what `init` built, which is what its own comment says it means.
     */
    const passDevice = this.contextLost ? null : this.passDevice;
    drainRegistry(this.passes, (definition) => {
      if (passDevice !== null) definition.dispose?.(passDevice);
    });
    /* The drain releases every slot without going through `unregisterPass`, so the counter it
       keeps has to be cleared here rather than decremented there. */
    this.preparingPasses = 0;

    /*
     * Only if there is still a context to delete them from. A lost context already took
     * every program with it, and asking the replacement to delete the dead one's objects
     * is an INVALID_OPERATION each — one measured teardown logged 48 of them.
     */
    if (!this.contextLost) {
      for (const extra of [
        this.flatSkinnedProgram,
        this.flatMorphedProgram,
        this.flatBothProgram,
      ]) {
        if (extra !== null) gl.deleteProgram(extra);
      }
      for (const program of [
        this.flatProgram,
        this.panelProgram,
        this.filmProgram,
        this.skyProgram,
        this.scatterProgram,
        this.depthProgram,
        this.scatterDepthProgram,
      ]) {
        gl.deleteProgram(program);
      }
      this.skinPalette.dispose(gl);
      gl.deleteTexture(this.emptyTexture2D);
      gl.deleteTexture(this.emptyTexture2DArray);
      gl.deleteTexture(this.emptyTextureCube);
      /* A cubemap and its whole mip chain, which is the largest single thing this
         renderer allocates outside the shadow maps. */
      this.probeCapture?.dispose(gl);
      this.probeArray?.dispose(gl);
      this.environmentPrefilter?.dispose(gl);
    }

    if (options.releaseContext === true) {
      gl.getExtension('WEBGL_lose_context')?.loseContext();
    }
  }

  createMesh(data: MeshData, options: MeshOptions = {}): Mesh {
    /*
     * **Every variant this mesh can be drawn with, not only the widest one.** A mesh with a rig
     * *and* targets can be drawn four ways, because the caller decides per draw whether to set a
     * palette, weights, both or neither — so compiling only the both-variant leaves a
     * palette-without-weights draw finding no program and falling all the way back to the plain
     * one. Measured on hardware: WebGL2 drew neither the bend nor the bulge while WebGPU drew
     * both, which is the two-backend comparison doing exactly what it is for.
     */
    this.warmVariants(data);
    return new Mesh(this.gl, data, options.dynamic === true);
  }

  /**
   * Geometry in, handle out — but the geometry lands over as many frames as the caller gives it.
   *
   * See `RendererApi.createMeshIncremental` for what this is for and what a caller may do with a
   * mesh that has not finished arriving. The iterator here adds the one thing `mesh.ts` cannot
   * know about: **a lost context ends the upload**, because an upload that spans frames can
   * straddle one and every buffer it was filling is gone. Done with `complete` still false is
   * the signal that it was abandoned.
   */
  createMeshIncremental(data: MeshData, options: MeshOptions = {}): IncrementalMesh {
    this.warmVariants(data);
    const { mesh, upload } = createMeshIncremental(this.gl, data, options.dynamic === true);
    return {
      mesh,
      upload: {
        next: (): IteratorResult<void, void> => {
          if (this.contextLost) return { done: true, value: undefined };
          return upload.next();
        },
      },
    };
  }

  /**
   * Compile every flat variant this mesh can be drawn with.
   *
   * Shared by the two `createMesh` entry points: which variants a mesh needs is decided by the
   * data, not by whether the geometry lands in one call or over six frames.
   */
  private warmVariants(data: MeshData): void {
    const skinnable = data.joints !== undefined;
    const morphable = data.morphTargets !== undefined;
    for (const skinned of skinnable ? [false, true] : [false]) {
      for (const morphed of morphable ? [false, true] : [false]) {
        if (skinned || morphed) this.ensureVariant(skinned, morphed);
      }
    }
  }

  /**
   * Rewrite a mesh's positions, and its normals where the caller has them.
   *
   * The VAO is left alone: an attribute pointer describes where a buffer's data *is*, and the
   * buffer is the same buffer. Rebinding here would cost a state change for nothing.
   */
  updateMesh(mesh: Mesh, positions: Float32Array, normals?: Float32Array): void {
    mesh.update(this.gl, positions, normals);
  }

  /**
   * Compile the skinned flat program, once, on the first rigged mesh.
   *
   * The four quality flags are construction-time and give this renderer one flat program.
   * Skinning is not: one scene holds rigged characters and static walls, and both draw through
   * the lit pass — so it is a second program rather than a fifth flag, selected per draw.
   *
   * **It is fed immediately if a pass is already bound.** A program compiled after this frame's
   * `bindMeshPass` would otherwise carry every uniform at zero, and zero is a real value for most
   * of them — the failure this file records for `uGrain` and `uAmbientGround`. `createMesh` is
   * construction rather than a frame path, so the extra write costs nothing anyone measures.
   *
   * What it costs is a second compile and a program switch between skinned and unskinned batches,
   * which a caller controls by drawing its characters together. What would make it wrong is a
   * fifth quality flag arriving that skinning should have been: it should not, because a quality
   * flag is chosen once for a renderer and this is chosen per mesh.
   */
  private ensureSkinnedProgram(): void {
    this.ensureVariant(true, false);
  }

  /**
   * Compile one flat variant, once, and feed it this frame's state.
   *
   * Lazy and at `createMesh` for the reason the skinned one was: at construction it costs every
   * game a compile for a feature most never use, and in the frame loop it could throw where the
   * rule is that initialisation fails loudly so a running frame never has to.
   *
   * **Fed immediately if a pass is already bound.** A program compiled after this frame's
   * `bindMeshPass` would otherwise carry every uniform at zero, and zero is a real value for most
   * of them — the failure this file records for `uGrain` and `uAmbientGround`.
   */
  private ensureVariant(skinned: boolean, morphed: boolean): void {
    if (this.contextLost) return;
    if (skinned && morphed && this.flatBothProgram !== null) return;
    if (skinned && !morphed && this.flatSkinnedProgram !== null) return;
    if (!skinned && morphed && this.flatMorphedProgram !== null) return;
    if (!skinned && !morphed) return;

    const { gl } = this;
    const label = `flat.${morphed ? 'morphed' : ''}${skinned ? 'skinned' : ''}`;
    /* `flatFragSource`, not a fresh `flatFrag`: every variant shades through one fragment stage
       at one light budget, and the uploads are written for that budget. */
    const program = compileProgram(
      gl,
      flatVert({ skinned, morphed, instanced: false }),
      this.flatFragSource,
      label,
    );
    const uniforms = uniformLocations(gl, program, label);
    if (skinned && morphed) {
      this.flatBothProgram = program;
      this.flatBothUniforms = uniforms;
    } else if (skinned) {
      this.flatSkinnedProgram = program;
      this.flatSkinnedUniforms = uniforms;
    } else {
      this.flatMorphedProgram = program;
      this.flatMorphedUniforms = uniforms;
    }
    this.flatTargets.push({ program, uniforms });

    const camera = this.lastPassCamera;
    const env = this.lastPassEnv;
    if (camera !== null && env !== null) {
      gl.useProgram(program);
      this.writeMeshPassState(uniforms, camera, env);
      this.useFlatProgram();
    }
  }

  /**
   * Upload an image the caller already has, for use as surface colour.
   *
   * Takes a `TexImageSource` rather than a URL, and that is the whole boundary: the
   * engine ships no image assets and fetches nothing, so where the pixels came from —
   * a canvas drawn procedurally at runtime, a decoded bitmap, a video frame — stays
   * the consumer's decision. What it gains is a GPU object with sane sampler state.
   */
  createSurfaceTexture(
    source: TexImageSource,
    options: SurfaceTextureOptions = {},
  ): SurfaceTexture {
    return new SurfaceTexture(this.gl, source, options);
  }

  /**
   * Replace a surface texture's pixels, keeping the GPU object and its sampler state.
   *
   * Goes through the renderer because the GL context does not leave this directory, and
   * `SurfaceTexture.update` needs one — without this a consumer could create a texture
   * and dispose it but never change it, which is exactly the case an image that decodes
   * *after* the world is built runs into. Re-uploading beats constructing a second
   * texture: the binding a draw loop already holds stays valid, so the swap is a swap
   * rather than a rebuild.
   *
   * Not a hot path — it re-uploads the whole image and regenerates the mip chain.
   */
  updateSurfaceTexture(texture: SurfaceTexture, source: TexImageSource): void {
    if (this.contextLost) return;
    texture.update(this.gl, source);
  }

  disposeSurfaceTexture(texture: SurfaceTexture): void {
    if (this.contextLost) return;
    texture.dispose(this.gl);
  }

  /**
   * Choose the surface texture the following `drawMesh` calls sample, or `null` for none.
   *
   * State rather than an argument to `drawMesh`, for two reasons. A texture belongs to a
   * *material*, and a material covers many draws — a biome's walls are one image and
   * twenty meshes — so setting it per draw would re-bind the same texture twenty times
   * to say the same thing. And `drawMesh` already carries a model, a layer and a tint;
   * a fifth and sixth positional argument is where a signature stops being readable.
   *
   * `bindMeshPass` resets this to none, so a pass cannot inherit a material from the
   * one before it and every caller starts from the same known state.
   *
   * `uScale`/`vScale` are repeats across the mesh's own UV range: geometry authored in
   * metres is textured at whatever density the material wants without rebuilding it.
   */
  /**
   * Choose the joint palette the following `drawMesh` calls skin by, or null for none.
   *
   * Null is what an unskinned draw needs and is the default, so a game that never animates never
   * allocates a palette texture and never leaves one bound.
   *
   * The palette is sixteen floats a joint, column-major, exactly as `Skeleton.palette` produces —
   * this renderer never learns where it came from, which is the boundary that keeps the animation
   * runtime out of core.
   */
  setSkinPalette(palette: Float32Array | null): void {
    if (this.contextLost) return;
    if (palette === null) {
      this.skinPaletteSet = false;
      return;
    }
    this.skinPalette.update(this.gl, palette);
    this.skinPaletteSet = true;
  }

  /**
   * Choose the morph weights the following `drawMesh` calls deform by, or null for none.
   *
   * One weight per target the mesh carries. **The weights are per draw and the deltas are per
   * mesh**, which is the split that matters: two characters sharing one head mesh wear different
   * expressions without a second copy of the geometry.
   */
  setMorphWeights(weights: Float32Array | null): void {
    if (this.contextLost) return;
    this.morphWeights = weights;
  }

  setMaterial(material: SurfaceMaterial | null): void {
    if (this.contextLost) return;
    this.materials.dirty();
    this.currentSurfaceTexture = material?.albedo ?? null;
    /*
     * Written to every flat program, because material state persists across draws and a skinned
     * draw is entitled to the material the caller set before it. A second program holding none of
     * it would sample unit 0 for every map and shade the character from whatever happened to be
     * bound there.
     *
     * The whole body runs per program, texture binds included, for the reason `bindMeshPass`
     * gives: a global half and a per-program half would be two statements of one decision and
     * would drift invisibly. Rebinding a texture to the unit it is already on is a no-op.
     */
    for (const target of this.flatTargets) {
      this.gl.useProgram(target.program);
      this.writeMaterialState(target.uniforms, material);
    }
    this.useFlatProgram();
  }

  /**
   * One flat program's view of the current material.
   *
   * **The `albedoEnabled` cache that used to guard the last two writes is gone.** It skipped a
   * `uniform1i` when the flag had not changed, which was correct for one program and is a wrong
   * answer for two: the second would keep whatever it was left with. One uniform write per
   * material change is not a cost worth a cache that can be wrong.
   */
  private writeMaterialState(
    u: Record<string, WebGLUniformLocation>,
    material: SurfaceMaterial | null,
  ): void {
    const { gl } = this;
    const albedo = material?.albedo ?? null;
    const normal = material?.normal ?? null;

    /*
     * The normal map first, and **before the albedo early return** — a material carrying a normal
     * and no albedo is a legitimate one, vertex colour with authored normals, and must not fall
     * out of this function through the no-texture path as though it were no material at all.
     *
     * The stand-in and never `null`. An unbound sampler is *incomplete*, and a driver may fetch
     * its descriptor before evaluating the branch that would have skipped the read — which
     * page-faulted an RDNA4 card and wedged the device. See `emptyTexture.ts`.
     */
    gl.activeTexture(gl.TEXTURE0 + NORMAL_TEXTURE_UNIT);
    gl.bindTexture(gl.TEXTURE_2D, this.emptyTexture2D);
    if (normal !== null) normal.bind(gl, NORMAL_TEXTURE_UNIT);
    gl.uniform1i(u['uNormalMap'] ?? null, NORMAL_TEXTURE_UNIT);
    gl.uniform1f(
      u['uNormalStrength'] ?? null,
      normal === null ? 0 : (material?.normalStrength ?? 1),
    );

    /*
     * The ORM map, on the same terms as the normal map above and for the same two reasons: before
     * the albedo early return, because a material carrying an ORM map and no colour is a
     * legitimate one; and the stand-in rather than `null`, because an unbound sampler is
     * *incomplete* and a driver may fetch its descriptor before evaluating the branch that would
     * have skipped the read. See `emptyTexture.ts` for the card that wedged.
     *
     * The scale vector is component-aligned with the map — r occlusion, g roughness, b metallic —
     * so the order here is not alphabetical and not the field order of `SurfaceMaterial`. It is
     * the channel order, which is the one thing that cannot be got wrong silently.
     */
    const orm = material?.orm ?? null;
    gl.activeTexture(gl.TEXTURE0 + ORM_TEXTURE_UNIT);
    gl.bindTexture(gl.TEXTURE_2D, this.emptyTexture2D);
    if (orm !== null) orm.bind(gl, ORM_TEXTURE_UNIT);
    gl.uniform1i(u['uOrmMap'] ?? null, ORM_TEXTURE_UNIT);
    gl.uniform1i(u['uOrmEnabled'] ?? null, orm === null ? 0 : 1);
    gl.uniform3f(
      u['uOrmScale'] ?? null,
      material?.occlusionStrength ?? 1,
      material?.roughnessScale ?? 1,
      material?.metallicScale ?? 1,
    );

    /*
     * The emissive map, on exactly the terms the two maps above it are bound: before the albedo
     * early return, and the stand-in rather than `null`.
     *
     * **White is the right stand-in here and black would be a bug.** The shader multiplies by this
     * map, so the placeholder has to be the multiplicative identity; `emptyTexture2D` is white,
     * which is what makes an unbound material collapse to the arithmetic it had before. A black
     * placeholder would switch every glow in the scene off the moment the gate was ever wrong.
     */
    const emissiveMap = material?.emissive ?? null;
    gl.activeTexture(gl.TEXTURE0 + EMISSIVE_TEXTURE_UNIT);
    gl.bindTexture(gl.TEXTURE_2D, this.emptyTexture2D);
    if (emissiveMap !== null) emissiveMap.bind(gl, EMISSIVE_TEXTURE_UNIT);
    gl.uniform1i(u['uEmissiveMap'] ?? null, EMISSIVE_TEXTURE_UNIT);
    gl.uniform1i(u['uEmissiveMapEnabled'] ?? null, emissiveMap === null ? 0 : 1);
    const emissiveScale = material?.emissiveScale ?? null;
    gl.uniform3f(
      u['uEmissiveScale'] ?? null,
      emissiveScale?.[0] ?? 1,
      emissiveScale?.[1] ?? 1,
      emissiveScale?.[2] ?? 1,
    );

    /*
     * **The scale belongs to the material, not to the albedo.** It was uploaded on the albedo
     * path alone, which was right while albedo was the only map: a material with a normal and no
     * colour then kept whatever `bindMeshPass` last left, and tiled the normal map at a density
     * nobody asked for. Caught by `demo/dev/normal.html`, where the two backends disagreed about
     * how big a dome was — WebGPU writes it before its own early return and WebGL2 did not.
     */
    gl.uniform2f(u['uUvScale'] ?? null, material?.uScale ?? 1, material?.vScale ?? 1);

    if (albedo === null) {
      gl.uniform1i(u['uAlbedoEnabled'] ?? null, 0);
      return;
    }
    albedo.bind(gl, SURFACE_TEXTURE_UNIT);
    gl.uniform1f(u['uAlbedoCutout'] ?? null, material?.cutout ?? 0);
    gl.uniform1i(u['uAlbedoEnabled'] ?? null, 1);
  }

  /**
   * @deprecated Use `setMaterial`.
   *
   * Kept because it has 56 call sites across four repositories, three of which deploy on push;
   * removing it is a major version taken deliberately rather than a side effect of adding a map.
   * `material.test.ts` asserts the two make the same calls, which is the only thing that makes a
   * wrapper safe to leave standing.
   */
  setSurfaceTexture(texture: SurfaceTexture | null, uScale = 1, vScale = 1, cutout = 0): void {
    this.setMaterial(texture === null ? null : { albedo: texture, uScale, vScale, cutout });
  }

  /**
   * Rebind `SURFACE_TEXTURE_UNIT` to whatever `setSurfaceTexture` last put there.
   *
   * Only `drawSdfText` calls this, after the atlas has finished borrowing the same unit.
   * No uniform is written here — the flat program's `uAlbedo`/`uAlbedoEnabled` were never
   * touched by the text draw and are still correct, since that draw runs its own separate
   * program. What moved is unit 15's actual `WebGLTexture` binding, which is GL state, not
   * program state, and this puts it back to what `currentSurfaceTexture` says it should be.
   */
  private restoreSurfaceTextureUnit(): void {
    const gl = this.gl;
    if (this.currentSurfaceTexture !== null) {
      this.currentSurfaceTexture.bind(gl, SURFACE_TEXTURE_UNIT);
      return;
    }
    gl.activeTexture(gl.TEXTURE0 + SURFACE_TEXTURE_UNIT);
    gl.bindTexture(gl.TEXTURE_2D, this.emptyTexture2D);
  }

  /**
   * A pass-level scale over the grain the geometry itself declared, 0 to 1.
   *
   * Which surfaces are mineral is now `MeshData.grain`, stated per vertex through
   * `MeshBuilder.setGrain` — because it is a property of a material, and absent means none.
   * This stays as the override for the case that has no answer to state: an imported model
   * arrives with no grain information at all, and a caller drawing one decides for it.
   *
   * Pass state, like `setSurfaceTexture`, because a material covers many draws. The default
   * is 1 and `bindMeshPass` restores it, so it scales geometry that declared grain and
   * leaves geometry that did not exactly as it is.
   */
  /**
   * How much of the environment the following draws mirror, 0 to 1.
   *
   * Pass state beside the grain, and the counterpart to it: grain is a surface being uneven,
   * this is a surface being smooth enough to carry an image. Polished paint, glass, chrome
   * and still water want it; plaster and stone want none.
   *
   * Defaults to zero and bindMeshPass restores it, so a scene that never calls this looks
   * exactly as it did.
   */
  setSurfaceReflectivity(amount: number): void {
    if (this.contextLost) return;
    this.materials.dirty();
    this.useFlatProgram();
    this.gl.uniform1f(this.flatUniforms['uReflectivity'] ?? null, Math.min(1, Math.max(0, amount)));
  }

  /**
   * How bright the environment the surfaces drawn next reflect is. 1 is the default and identity.
   *
   * See `uEnvironmentGain` in the preamble for the whole argument. In one line: a metal's Fresnel
   * base is its own albedo, so it takes no ambient and no direct diffuse and *is* its reflection,
   * and when the only environment is a cube of nearby geometry that leaves it as dark as the room
   * happens to be. This is the stand-in for the image-based lighting that would carry the sky and
   * the sources instead, and it goes away when there is one.
   *
   * Not clamped above: the case it exists for is a room that is too dim, and a value below 1 is as
   * legitimate as one above. Held non-negative, because a negative environment is not a darker one.
   */
  setEnvironmentGain(gain: number): void {
    if (this.contextLost) return;
    this.materials.dirty();
    this.useFlatProgram();
    this.gl.uniform1f(this.flatUniforms['uEnvironmentGain'] ?? null, Math.max(0, gain));
  }

  /**
   * Kept as a no-op that says so once, because it was a stand-in for a term that now exists.
   *
   * It mixed the ambient toward a box-filtered level of the probe, three below the coarsest,
   * lifted by a `max` so a partial probe could not darken a subject. Irradiance is nine projected
   * spherical-harmonic coefficients now, evaluated per fragment against the normal, and it is on
   * whenever a probe has been baked — with nothing to tune, because an approximation needed a dial
   * for the ways it was wrong and a cosine integral does not have them.
   *
   * **Deprecated rather than removed, and that is a compatibility decision rather than a
   * preference.** It is on the public surface and consumers call it; deleting it today would be a
   * breaking change across four repositories to save one method. It goes at the next major, where
   * a coordinated release is happening anyway.
   */
  setEnvironmentAmbient(_amount: number): void {
    if (this.warnedEnvironmentAmbient) return;
    this.warnedEnvironmentAmbient = true;
    console.warn(
      'Renderer: setEnvironmentAmbient no longer does anything. A baked probe now lights a ' +
        'surface through projected irradiance, and there is nothing left to tune.',
    );
  }

  setSurfaceGrain(amount: number): void {
    if (this.contextLost) return;
    this.materials.dirty();
    this.useFlatProgram();
    this.gl.uniform1f(this.flatUniforms['uGrain'] ?? null, Math.min(1, Math.max(0, amount)));
  }

  /**
   * How strong the microscopic relief on the surfaces drawn next is, and how coarse.
   *
   * **The material half of `MeshData.relief`.** The geometry says which surfaces have texture;
   * this says what texture, because the same amount over a different scale is a different
   * material entirely. Asphalt is coarse and deep, roughly 60 bumps to the metre at full
   * strength; cast concrete is finer; orange peel on paint is finer again and shallow. The
   * geometry carrying all three is identical, which is exactly why the two halves are separate.
   *
   * `amount` scales whatever each vertex declared, so 0 switches it off for a pass without
   * rebuilding a mesh, the same way `setSurfaceGrain` does. `cyclesPerMetre` is how many bumps
   * fit in a metre of world.
   *
   * **The roughness of a surface grows with its relief**, automatically and not optionally: a
   * normal that wanders cannot hold a highlight narrower than the wander, and a narrow one on a
   * fast-varying normal is the sub-pixel sparkle 0.20.0 was spent removing. The amount is known
   * here rather than measured off the screen, which is what makes it safe; see the specular
   * speckle entry in docs/IMPROVEMENTS.md for the version that measured it instead and made
   * things three times worse.
   *
   * Defaults to off and `bindMeshPass` restores that, so a scene that never calls this is
   * unchanged.
   */
  setSurfaceRelief(amount: number, cyclesPerMetre = 60): void {
    if (this.contextLost) return;
    this.materials.dirty();
    this.useFlatProgram();
    const u = this.flatUniforms;
    this.gl.uniform1f(u['uRelief'] ?? null, Math.min(1, Math.max(0, amount)));
    this.gl.uniform1f(u['uReliefCycles'] ?? null, Math.max(0.01, cyclesPerMetre));
  }

  /**
   * How hard the bound surface texture's own luminance turns the shading normal, 0 for not at all.
   *
   * **Relief a photograph can give, where `setSurfaceRelief` invents it.** Noise is the right
   * answer for asphalt and cast concrete, whose structure has no particular arrangement. A rock,
   * a bark, a hammered plate has one: the bumps are where the picture says they are, and no noise
   * function can know where that is. This reads the height off the image `setSurfaceTexture`
   * already bound as colour, so a surface lights as the thing the photograph is of.
   *
   * **One image in both roles rather than a second sampler**, which is a decision with a cost
   * behind it: the fragment shader's widest permutation already declares more samplers than this
   * project's adapter offers and is legal only because several of them are marked as shared. It
   * is also the ordinary case rather than an unusual one, since a scene handing one image to
   * three.js's `map` and `bumpMap` together is exactly what this replaces.
   *
   * Scaled as three.js's `bumpScale` is, so a scene porting one carries the number over rather
   * than refitting it by eye, and a negative value inverts the relief there and here alike.
   * Deliberately not clamped to 0..1 the way `setSurfaceRelief` and `setSurfaceGrain` are: those
   * scale something the geometry declared, and this is an amplitude against a luminance gradient
   * with no natural ceiling.
   *
   * Nothing happens without a texture bound, because the shader gates on the same flag
   * `setSurfaceTexture(null)` clears. Defaults to off and `bindMeshPass` restores that, so a
   * scene that never calls this is unchanged.
   */
  setSurfaceTextureRelief(scale: number): void {
    if (this.contextLost) return;
    this.materials.dirty();
    this.useFlatProgram();
    this.gl.uniform1f(
      this.flatUniforms['uTextureRelief'] ?? null,
      Number.isFinite(scale) ? scale : 0,
    );
  }

  /**
   * Release a mesh's GPU buffers.
   *
   * Needed by anything that rebuilds geometry at runtime — a character
   * customiser recolouring an avatar, a level editor, a streamed chunk. Without
   * it every rebuild leaks a VAO and its buffers, which is invisible until a
   * player has spent a minute on one screen.
   */
  /**
   * Scale the emissive of the following draws, or reset to what the environment says.
   *
   * Pass state, like `setSurfaceTexture`, and for the same reason: emissive strength
   * belongs to a *material* and a material covers many draws. `bindMeshPass` sets it from
   * `env.emissiveGain` and this overrides it between draws.
   *
   * It exists because emissive is per-vertex data, so anything that *pulses* — a threshold
   * breathing, a ceiling answering a kick drum — could not be expressed at all without
   * rebuilding geometry every frame. The light around such a thing could pulse and the
   * glowing surface itself could not, which reads as a lamp brightening while its own bulb
   * stays flat.
   */
  setEmissiveGain(gain: number): void {
    if (this.contextLost) return;
    this.materials.dirty();
    this.useFlatProgram();
    this.gl.uniform1f(this.flatUniforms['uEmissiveGain'] ?? null, gain);
  }

  /* -- Instanced meshes --------------------------------------------------------------- */

  /** The instanced program, compiled on first use. See `ensureInstancedProgram`. */
  private flatInstancedProgram: WebGLProgram | null = null;
  private flatInstancedUniforms: Record<string, WebGLUniformLocation> | null = null;

  /**
   * Compile the instanced variant, once, and feed it this frame's pass state.
   *
   * The same shape as `ensureVariant` and for the same reason: a program compiled after this
   * frame's `bindMeshPass` would otherwise carry every uniform at zero, and zero is a real value
   * for most of them — `uGrain` unwritten switches grain off across every surface rather than
   * weakening it.
   */
  private ensureInstancedProgram(): void {
    if (this.contextLost || this.flatInstancedProgram !== null) return;
    const { gl } = this;
    /* `flatFragSource`, not a fresh `flatFrag`: every variant shades through one fragment stage
       at one light budget, and the uploads are written for that budget. */
    const program = compileProgram(
      gl,
      flatVert({ skinned: false, morphed: false, instanced: true }),
      this.flatFragSource,
      'flat.instanced',
    );
    const uniforms = uniformLocations(gl, program, 'flat.instanced');
    this.flatInstancedProgram = program;
    this.flatInstancedUniforms = uniforms;
    this.flatTargets.push({ program, uniforms });

    const camera = this.lastPassCamera;
    const env = this.lastPassEnv;
    if (camera !== null && env !== null) {
      gl.useProgram(program);
      this.writeMeshPassState(uniforms, camera, env);
      this.useFlatProgram();
    }
  }

  /**
   * Attach per-instance placement to a mesh already on the device.
   *
   * One batch per mesh: the attributes bind to the mesh's own vertex array, of which a mesh has
   * one. `Mesh.attachInstances` is what refuses a second, and says why.
   */
  createInstanced(mesh: Mesh, capacity: number): InstancedBatch {
    /* The same refusal as the other backend, for the same reason: the instanced attributes take
       the two locations a skinned mesh's joints and weights already occupy. */
    if (mesh.isSkinned) {
      throw new Error(
        'WebGL2: a skinned mesh cannot be instanced — an instanced draw binds the two attribute ' +
          'locations the joint indices and weights occupy, and this mesh supplies them.',
      );
    }
    this.ensureInstancedProgram();
    return new InstancedBatch(this.gl, mesh, capacity);
  }

  /** Push placement and colour. Only the live prefix. */
  uploadInstanced(batch: InstancedBatch, data: MeshInstances): void {
    if (this.contextLost) return;
    batch.upload(this.gl, data);
  }

  /** Draw every live instance, opaque. */
  drawInstanced(batch: InstancedBatch, data: MeshInstances): void {
    this.submitInstanced(batch, data, 1, false, {});
  }

  /** Draw every live instance, blended. See `drawTranslucentMesh` for what the options mean. */
  drawTranslucentInstanced(
    batch: InstancedBatch,
    data: MeshInstances,
    opacity: number,
    options: TranslucentMeshOptions = {},
  ): void {
    this.submitInstanced(batch, data, opacity, true, options);
  }

  /** Release the placement. The mesh is the caller's and is not released. */
  disposeInstanced(batch: InstancedBatch): void {
    if (this.contextLost) return;
    batch.dispose(this.gl);
  }

  /**
   * One draw and one material, however many instances.
   *
   * **No `uModel` and no `uTint` written**, because the instanced program declares neither — its
   * placement and colour arrive as attributes. Writing them would be a `uniform*` call against
   * location `null`, which GL ignores, so this would look like it worked; it is left out because
   * saying it is the point of the variant.
   *
   * **No frustum cull**, unlike `drawMesh`. A batch's bounds are the union of its instances and
   * the mesh's own bounds describe one of them at the origin, so testing that box would cull a
   * street of cars whenever the copy at the origin left the view. Culling a batch is the
   * consumer's, which is also where the placements are.
   */
  private submitInstanced(
    batch: InstancedBatch,
    data: MeshInstances,
    opacity: number,
    blend: boolean,
    options: TranslucentMeshOptions,
  ): void {
    if (this.contextLost) return;
    const mesh = batch.mesh;
    if (!mesh.complete) return;
    const count = Math.min(data.count, batch.capacity);
    if (count === 0) return;
    this.drawBudget.ask();
    this.ensureInstancedProgram();
    const program = this.flatInstancedProgram;
    const u = this.flatInstancedUniforms;
    if (program === null || u === null) return;

    const { gl } = this;
    gl.useProgram(program);
    gl.uniform1i(u['uHasTangents'] ?? null, mesh.hasTangents ? 1 : 0);

    const lit = options.lit ?? true;
    const fog = options.fog ?? true;
    const toneMapped = options.toneMapped ?? true;
    /* An instanced draw does not refract. See `materialChanges.ts`. */
    const own = ownsMaterial({ opacity, lit, fog, toneMapped, refracting: false });
    if (own) this.materials.dirty();
    this.takeMaterial();
    const depthWrite = options.depthWrite ?? true;
    const layer = Math.min(Math.max(Math.round(options.depthLayer ?? 0), 0), MAX_DEPTH_LAYER);

    if (opacity < 1) gl.uniform1f(u['uOpacity'] ?? null, opacity);
    /*
     * **Refraction, and the snapshot it reads is latched at the first draw that asks.**
     *
     * A frame that refracts nothing takes no copy at all, which is what keeps this off the bill of
     * every consumer who never wants glass. The rest of the frame reuses that one copy, so glass
     * does not refract other glass — correct, a pane behind a pane should show the room — and
     * opaque geometry drawn *after* the first pane is missing from what a pane shows. Draw the
     * world, then the glass; `SceneTarget.snapshotColor` carries the same trap `snapshotDepth`
     * documents.
     *
     * **A null snapshot leaves the strength at zero**, so the draw shades as an ordinary
     * translucent one rather than sampling a black texture and painting the pane the colour of a
     * hole. That is the defined state the two-backends rule asks for instead of a silent no-op.
     */
    const refraction = options.refraction ?? 0;
    let refracting = false;
    if (refraction > 0) {
      const snapshot = this.sceneTarget?.snapshotColor() ?? null;
      if (snapshot !== null) {
        refracting = true;
        gl.activeTexture(gl.TEXTURE0 + REFRACT_SCENE_TEXTURE_UNIT);
        gl.bindTexture(gl.TEXTURE_2D, snapshot);
        gl.uniform1f(u['uRefractStrength'] ?? null, refraction);
        gl.uniform3fv(u['uRefractTint'] ?? null, options.refractTint ?? WHITE_TINT);
        gl.uniform1f(u['uRefractThickness'] ?? null, options.thicknessM ?? 0);
      }
    }
    if (!lit) gl.uniform1i(u['uLightingEnabled'] ?? null, 0);
    if (!fog) gl.uniform1i(u['uFogEnabled'] ?? null, 0);
    if (!toneMapped) gl.uniform1i(u['uOutputTransform'] ?? null, Math.min(this.gradeCode(), 1));

    if (blend) {
      gl.enable(gl.BLEND);
      gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
      if (!depthWrite) gl.depthMask(false);
    }
    /* The sign follows the compare, which `depthOffsetForLayer` owns — see `drawMesh`, where the
       same call carries the reasoning and the reversed-depth caveat. */
    const offset = depthOffsetForLayer(layer, this.reversedDepth);
    if (layer > 0) {
      gl.enable(gl.POLYGON_OFFSET_FILL);
      gl.polygonOffset(offset.slope, offset.units);
    }

    mesh.drawInstances(gl, count);

    if (layer > 0) {
      gl.polygonOffset(0, 0);
      gl.disable(gl.POLYGON_OFFSET_FILL);
    }
    if (blend) {
      if (!depthWrite) gl.depthMask(true);
      gl.disable(gl.BLEND);
    }
    /* Back to the defaults, for the reason the WebGPU twin gives: these are pass state, so a
       value left dirtied here is worn by every draw after this one. */
    if (opacity < 1) gl.uniform1f(u['uOpacity'] ?? null, 1);
    /* The binding is released with the uniform, which is the 2026-08-27 rule: a WebGL2 binding
       outlives its frame, so a snapshot left on unit 14 is held against the next frame's copy. */
    if (refracting) {
      gl.uniform1f(u['uRefractStrength'] ?? null, 0);
      gl.activeTexture(gl.TEXTURE0 + REFRACT_SCENE_TEXTURE_UNIT);
      gl.bindTexture(gl.TEXTURE_2D, this.emptyTexture2D);
    }
    if (!lit) gl.uniform1i(u['uLightingEnabled'] ?? null, 1);
    if (!fog) gl.uniform1i(u['uFogEnabled'] ?? null, 1);
    if (!toneMapped) gl.uniform1i(u['uOutputTransform'] ?? null, this.gradeCode());
    if (own) this.materials.dirty();
    this.useFlatProgram();
  }

  disposeMesh(mesh: Mesh): void {
    /*
     * Nothing to release when the context is gone: it took every buffer and VAO with it,
     * and asking the *new* context to delete the old one's objects is an
     * INVALID_OPERATION per object. A consumer tearing a level down after a context loss
     * therefore produced one error per mesh, which is noise burying whatever caused the
     * loss — the same shape as the framebuffer checks, on the way out instead of in.
     */
    if (this.contextLost) return;
    mesh.dispose(this.gl);
  }

  /**
   * Release a resource this renderer created, for every kind that needs the context back.
   *
   * **Reported from outside, and it was a real leak.** `disposeMesh` and
   * `disposeSurfaceTexture` existed and nothing else did, so eight other kinds of resource
   * were handed out with no way to release them: each one's own `dispose` takes the
   * `WebGL2RenderingContext`, which this package deliberately never exposes. The engine's own
   * demos could call them because they hold their own `gl` from creating the canvas; nobody
   * outside could. It costs nothing when a consumer tears the whole renderer down, since
   * releasing the context takes the programs and buffers with it, and it costs a program per
   * rebuild for anyone who swaps weather or scenery without rebuilding the renderer. That is
   * the ordinary case for a scene that changes, and the consumer who reported it was leaking
   * one per scenario switch and living with it.
   *
   * Each guards on a lost context for the same reason `disposeMesh` does: the old context took
   * its objects with it, and asking the new one to delete them is an INVALID_OPERATION apiece,
   * which buries whatever caused the loss under a page of noise.
   */
  disposePlumes(plumes: PlumeRenderer): void {
    if (this.contextLost) return;
    plumes.dispose(this.gl);
  }

  /** Release a wind streak lattice. See `disposePlumes`. */
  disposeWindStreaks(streaks: WindStreakRenderer): void {
    if (this.contextLost) return;
    streaks.dispose(this.gl);
  }

  /** Release a flock. See `disposePlumes`. */
  disposeFlock(flock: FlockRenderer): void {
    if (this.contextLost) return;
    flock.dispose(this.gl);
  }

  /** Release an instanced batch made by `createScatter`. See `disposePlumes`. */
  disposeScatter(scatter: InstancedMesh): void {
    if (this.contextLost) return;
    scatter.dispose(this.gl);
  }

  /** Release a particle batch. See `disposePlumes`. */
  disposeParticles(particles: ParticleBatch): void {
    if (this.contextLost) return;
    particles.dispose(this.gl);
  }

  /** Release a bolt batch. See `disposePlumes`. */
  disposeBolts(bolts: BoltBatch): void {
    if (this.contextLost) return;
    bolts.dispose(this.gl);
  }

  /** Release a line batch. See `disposePlumes`. */
  disposeLines(lines: LineBatch): void {
    if (this.contextLost) return;
    lines.dispose(this.gl);
  }

  /** Release a water renderer. See `disposePlumes`. */
  disposeWater(water: WaterRenderer): void {
    if (this.contextLost) return;
    water.dispose(this.gl);
  }

  /** Release a caustics renderer. See `disposePlumes`. */
  disposeCaustics(caustics: CausticsRenderer): void {
    if (this.contextLost) return;
    caustics.dispose(this.gl);
  }

  createPlumes(plumes: readonly PlumePlacement[], options: PlumeOptions): PlumeRenderer {
    return new PlumeRenderer(this.gl, plumes, options, this.quality.plumeNoiseOctaves);
  }

  createWindStreaks(options: WindStreakOptions = {}): WindStreakRenderer {
    return new WindStreakRenderer(this.gl, options);
  }

  /** Draw after the opaque scene: streaks are blended and write no depth. */
  drawWindStreaks(
    streaks: WindStreakRenderer,
    camera: Camera,
    wind: WindField,
    timeSeconds: number,
    tint: Vec3,
    env: Environment,
  ): void {
    // The engine decides, not the caller: every pass already knows where the
    // waterline is, and leaving it to each call site is how one of them ends up
    // raining dust into the sea.
    const surface = env.underwater?.surfaceY;
    const submerged = surface !== undefined && (camera.position[1] ?? 0) < surface;
    if (streaks.draw(this.gl, this.frameViewFor(camera), wind, timeSeconds, tint, submerged)) {
      this.windStreakBudget.ask();
    }
  }

  /**
   * A 3D text object: one string, drawn as instanced glyph cubes over the
   * scene. Create one per message slot and reuse it — `setText` is a no-op when
   * the string has not changed.
   */
  createText(): TextRenderer {
    return new TextRenderer(this.gl);
  }

  /** Lay a string out. A no-op when it is the string already laid out. */
  setText(text: TextRenderer, content: string): void {
    text.setText(content);
  }

  /** A solid rectangle of cells, for a keycap or a backing plate. See `TextLayout.setPlate`. */
  setPlate(text: TextRenderer, widthCells: number, heightCells: number, bottomCell: number): void {
    text.setPlate(widthCells, heightCells, bottomCell);
  }

  /**
   * Draw a laid-out string over the scene.
   *
   * The viewport is the caller's rather than this renderer's: an overlay is positioned in
   * whatever box the caller lays out in, and the game's own card is not always the canvas.
   */
  drawText(
    text: TextRenderer,
    viewportWidth: number,
    viewportHeight: number,
    originX: number,
    originY: number,
    style: TextStyle,
    timeSec: number,
  ): void {
    if (text.draw(viewportWidth, viewportHeight, originX, originY, style, timeSec)) {
      this.textBudget.ask();
    }
  }

  /**
   * The cell size to draw a bitmap glyph at so every cell covers whole device pixels.
   *
   * **The caller snaps, and then measures and draws with the one number.** 4.1.4 applied this
   * inside `drawText` instead, where `textWidthPx` could not see it — it takes no viewport and so
   * cannot know the ratio — and every consumer went on laying out against the cell it asked for
   * while the engine drew a smaller one. A centred line, a right-aligned column and a line fitted
   * to a box broke together. Snapped here, the arithmetic and the picture cannot disagree.
   *
   * **It is on the renderer because only the renderer knows the second number.** `viewportWidth`
   * is the caller's, and it already passes it to `drawText`; the drawing buffer is not on the
   * shared surface and a game's text layout is a pure function over CSS pixels, so reaching it
   * meant threading a canvas through an interface layer to a value the renderer was holding.
   *
   * The decision itself stays in `textLayout.ts` and only this binding is per backend, which is
   * the 2026-08-13 rule: a cell already whole comes back untouched, and the snap is downward so a
   * line fitted to a box can only leave a gap rather than overflow it.
   */
  snapTextCellSize(cellSize: number, viewportWidth: number): number {
    return deviceSnappedCellSize(cellSize, viewportWidth, this.gl.drawingBufferWidth);
  }

  /** Width of the string this handle currently holds, in pixels at a given cell size. */
  textWidth(text: TextRenderer, cellSize: number): number {
    return text.widthPx(cellSize);
  }

  disposeText(text: TextRenderer): void {
    text.dispose();
  }

  /**
   * A text label from an SDF font. Opt-in: a consumer that never calls this pays nothing,
   * which is what keeps `pixelFont.ts`'s no-asset promise true for everybody else.
   */
  createSdfText(): SdfTextRenderer {
    return new SdfTextRenderer(this.gl);
  }

  /**
   * Lay a string out against a font, and retain the atlas `drawSdfText` will sample.
   *
   * The engine fetches nothing: `font` was parsed from a metrics document the caller already
   * had, and `atlas` is a `SurfaceTexture` the caller already uploaded. A no-op, and no
   * re-upload, when neither the text nor the style moved since the last call.
   */
  setSdfText(
    handle: SdfTextRenderer,
    font: SdfFont,
    atlas: SurfaceTexture,
    content: string,
    style: SdfTextStyle,
  ): void {
    handle.setText(font, atlas, content, style);
  }

  /**
   * Draw a laid-out SDF string into the scene, at `model`.
   *
   * Takes no camera: it draws against the view-projection `bindMeshPass` captured for the
   * frame, the same one `drawMesh` uses, so a caller positions text with a model matrix
   * alone — `billboardMatrixY` for a label that faces the camera, a surface's own matrix for
   * one painted flush against it. A no-op before the first `bindMeshPass` of a session, same
   * as every other pass that reads `frameViewProj`.
   *
   * **Puts `SURFACE_TEXTURE_UNIT` back the way it found it.** The atlas binds through
   * `SDF_TEXT_TEXTURE_UNIT`, which is that same unit — see the constant's own comment for
   * why that is safe — so once the glyphs are drawn this rebinds whatever `drawMesh`'s
   * material state currently says should be there. Without it, a `drawMesh` call *after*
   * this one would go on sampling unit 15 as its albedo and find the glyph atlas sitting on
   * it instead of its own texture. Skipped when nothing was actually drawn, since only a
   * real draw call touches the unit in the first place.
   */
  /**
   * The output transform a forward pass should apply, and the exposure it should apply it at.
   *
   * **Only where that pass is genuinely the last one to touch the frame.** With a scene target
   * the resolve grades, so a pass that graded as well would be applying a curve to its own
   * output, and grading early throws away the range a float target exists to keep. With
   * `screenEffects` off there is no resolve at all and every pass writes straight to the canvas,
   * so each one has to grade itself or the frame comes out half converted: linear values in an
   * eight-bit buffer read as display values, which is a saturated, clipped version of the colour
   * the caller asked for rather than a slightly different one.
   *
   * One pair of accessors rather than the expression written out at each site, because that is
   * how the mesh pass and the particle pass came to disagree in the first place: the mesh pass
   * gated, and the particle pass uploaded the transform unconditionally to a stage that did not
   * yet declare it.
   */
  private gradeCode(): number {
    return this.sceneTarget === null || !this.quality.hdrScene
      ? OUTPUT_TRANSFORM_CODE[this.quality.outputTransform]
      : 0;
  }

  private gradeExposure(): number {
    return this.sceneTarget === null || !this.quality.hdrScene ? this.exposure : 1;
  }

  drawSdfText(handle: SdfTextRenderer, model: Float32Array, color: Vec3, opacity: number): void {
    if (this.contextLost) return;
    const viewProj = this.frameViewProj;
    if (viewProj === null) return;
    /* Geometry, so the remapped matrix: `frameViewProj` itself stays raw for the motion blur. */
    if (
      handle.draw(
        this.sceneMatrix(viewProj),
        model,
        color,
        opacity,
        this.gradeCode(),
        this.gradeExposure(),
      )
    ) {
      this.sdfTextBudget.ask();
      this.restoreSurfaceTextureUnit();
    }
  }

  /** Release an SDF text label. Takes no context; see `disposeText`. */
  disposeSdfText(handle: SdfTextRenderer): void {
    handle.dispose();
  }

  createFlock(count: number): FlockRenderer {
    return new FlockRenderer(this.gl, count);
  }

  drawFlock(
    flock: FlockRenderer,
    camera: Camera,
    timeSeconds: number,
    params: FlockParams,
    tint: Vec3,
    windX = 0,
    windZ = 0,
  ): void {
    this.flockBudget.ask();
    flock.draw(this.gl, this.frameViewFor(camera), timeSeconds, params, tint, windX, windZ);
  }

  /**
   * Build a scatter batch and fill it. Takes the data rather than handing back
   * something the caller has to upload, because uploading needs the GL context
   * and that never leaves this directory (AGENTS.md).
   */
  createScatter(base: MeshData, data: InstanceData): InstancedMesh {
    const mesh = new InstancedMesh(this.gl, base, data.capacity);
    mesh.upload(this.gl, data);
    return mesh;
  }

  /**
   * Push changed instances to the GPU.
   *
   * Only for batches that *move*. Foliage is placed once at generation and never
   * touched again, so `createScatter` uploads it and `drawScatter` deliberately does
   * not — a per-frame upload of every blade of grass in the world would be pure waste.
   *
   * A live particle system is the other case, and it was silently broken: the drift
   * plume's grains were drawn from the positions they happened to hold at boot, because
   * nothing ever re-uploaded them. Only the *count* animated, so a drift threw a
   * growing pile of stationary grit instead of a spray. Explicit rather than automatic,
   * so the cost stays visible at the call site that needs it.
   */
  uploadScatter(scatter: InstancedMesh, data: InstanceData): void {
    scatter.upload(this.gl, data);
  }

  /**
   * Build a particle material: one program, one VAO, one draw call per pool.
   *
   * A material rather than a renderer, and the distinction is the reason this
   * exists at all. Particles used to be drawn through `drawScatter` — the foliage
   * material — which is opaque, lit like a leaf and has no opacity channel, so
   * every effect in the game that emitted particles rendered as small solid cubes
   * that turned black instead of fading. The fix is not a tuning pass on the
   * emitters; it is a material that knows what a particle is.
   */
  createParticles(capacity: number, options: ParticleBatchOptions): ParticleBatch {
    return new ParticleBatch(this.gl, capacity, options);
  }

  /**
   * Draw a live particle pool.
   *
   * Uploads and draws together, unlike the scatter path where the two are
   * deliberately separate: a particle pool's data changes *every* frame without
   * exception, so leaving the upload to the caller only creates the opportunity to
   * forget it — which is exactly what happened to the skate sparks, drawn for a
   * whole milestone from a buffer nothing had ever written.
   */
  drawParticles(
    batch: ParticleBatch,
    data: ParticleInstances,
    camera: Camera,
    env: Environment,
    timeSeconds: number,
  ): void {
    if (data.count === 0) return;
    const { gl } = this;
    const u = batch.uniforms;
    gl.useProgram(batch.program);
    batch.upload(gl, data);
    batch.bindMaterial(gl);
    gl.uniformMatrix4fv(u['uViewProj'] ?? null, false, this.viewProjFor(camera));
    gl.uniform3fv(u['uCameraPos'] ?? null, camera.position);
    gl.uniform1f(u['uTime'] ?? null, timeSeconds);
    gl.uniform3fv(u['uDirectionalDir'] ?? null, env.directionalDir);
    gl.uniform3fv(u['uDirectionalColor'] ?? null, env.directionalColor);
    /* Gated, unlike the line this replaces. That one predates the particle fragment declaring
       the uniform at all, so it was a write to a location that did not exist; now that the
       stage grades itself it has to obey the same "only where this pass is last" rule the mesh
       pass does, or a scene with a composite grades its particles twice. */
    gl.uniform1i(u['uOutputTransform'] ?? null, this.gradeCode());
    gl.uniform1f(u['uOutputExposure'] ?? null, this.gradeExposure());
    gl.uniform3fv(u['uAmbient'] ?? null, env.ambient);
    gl.uniform3fv(u['uAmbientGround'] ?? null, env.ambientGround ?? env.ambient);
    gl.uniform1i(u['uNoiseOctaves'] ?? null, this.quality.plumeNoiseOctaves);
    /*
     * The same point lights the world is lit by. Smoke that ignored them was the
     * single biggest tell: a drift beside a brazier threw grey grit at night.
     */
    bindPointLights(gl, u, env, this.quality.pointLightFalloff);
    bindAtmosphere(
      gl,
      u,
      env,
      this.reflectionPassActive ? this.reflectionAtmosphereY : (camera.position[1] ?? 0),
      this.quality.underwaterAtmosphere,
    );
    batch.drawTo(gl, data.count);
  }

  /** Build a batch for electrical arcs. `capacity` is in segments, not arcs. */
  createBolts(segmentCapacity: number, label = 'bolts'): BoltBatch {
    return new BoltBatch(this.gl, segmentCapacity, label);
  }

  /**
   * Draw a pool of arcs.
   *
   * `widthM` is the filament's own half-width and `minWidthPerMetre` the floor that
   * keeps a distant arc above a pixel — under one, a bright thin line does not fade,
   * it strobes as the rasteriser catches it on some frames and not others.
   */
  drawBolts(
    batch: BoltBatch,
    data: BoltSegments,
    camera: Camera,
    env: Environment,
    timeSeconds: number,
    core: Vec3,
    edge: Vec3,
    widthM: number,
    coreGain: number,
    minWidthPerMetre = 0.004,
  ): void {
    if (data.count === 0) return;
    const { gl } = this;
    const u = batch.uniforms;
    const count = batch.upload(gl, data);
    if (count === 0) return;
    this.boltBudget.ask();
    gl.useProgram(batch.program);
    gl.uniformMatrix4fv(u['uViewProj'] ?? null, false, this.viewProjFor(camera));
    gl.uniform3fv(u['uCameraPos'] ?? null, camera.position);
    gl.uniform1f(u['uTime'] ?? null, timeSeconds);
    gl.uniform1f(u['uWidth'] ?? null, widthM);
    gl.uniform1f(u['uMinWidthPerMetre'] ?? null, minWidthPerMetre);
    gl.uniform3fv(u['uCoreColor'] ?? null, core);
    gl.uniform3fv(u['uEdgeColor'] ?? null, edge);
    gl.uniform1f(u['uCoreGain'] ?? null, coreGain);
    bindAtmosphere(
      gl,
      u,
      env,
      this.reflectionPassActive ? this.reflectionAtmosphereY : (camera.position[1] ?? 0),
      this.quality.underwaterAtmosphere,
    );
    batch.drawTo(gl, count);
  }

  /**
   * A polyline with a real width, for anything that is a stroke rather than a surface.
   *
   * Separate from `drawBolts` rather than a flag on it. The two share a vertex expansion
   * and nothing else: an arc is additive, unlit, unfogged and jittered along its own path,
   * a line is a flat fogged colour with a clean edge. A `jitter: 0` argument meaning
   * "actually draw a line" would be a noun lying about what it draws, which `AGENTS.md`
   * rules out for good reasons.
   *
   * There is no portable alternative. WebGL2 clamps `lineWidth` to one pixel on nearly
   * every driver and WebGPU has no line width at all, so a wide line is a triangle
   * everywhere or it is nowhere.
   *
   * **A handle holds one polyline's geometry for the frame it is drawn in.** Drawing it more
   * than once in a frame is fine — three widths of one shape is exactly that, and costs nothing
   * beyond the re-upload — because the data underneath does not change between those calls.
   * *Changing* what it holds and drawing it more than once in the same frame is not fine: on
   * WebGPU, `queue.writeBuffer` does not interleave with a pass's already-recorded draw
   * commands, so every draw against this handle in a frame reads whichever write landed last by
   * the time the frame submits, not the content that was current when each call was made.
   * WebGL2 draws immediately on each call and happens to give the answer a caller expects, so
   * the two backends disagree silently rather than loudly. A caller drawing several polylines
   * whose geometry differs within one frame needs one handle each, not one handle reused.
   */
  createLines(segmentCapacity: number, label = 'lines'): LineBatch {
    return new LineBatch(this.gl, segmentCapacity, label);
  }

  /**
   * Draw a polyline.
   *
   * `widthM` is the stroke's own half-width and `minWidthPerMetre` the floor that keeps a
   * distant line above a pixel — under one, a thin line does not fade, it strobes as the
   * rasteriser catches it on some frames and not others. `softness` widens the antialiased
   * edge inward, as a fraction of the half-width; zero is a clean edge.
   */
  drawLines(
    lines: LineBatch,
    data: LineSegments,
    model: ReadonlyMat4,
    camera: Camera,
    env: Environment,
    color: Vec3,
    widthM: number,
    opacity: number,
    softness = 0,
    minWidthPerMetre = 0,
    additive = false,
  ): void {
    if (data.count === 0) return;
    const { gl } = this;
    const u = lines.uniforms;
    const count = lines.upload(gl, data);
    if (count === 0) return;
    this.lineBudget.ask();
    gl.useProgram(lines.program);
    gl.uniformMatrix4fv(u['uViewProj'] ?? null, false, this.viewProjFor(camera));
    gl.uniformMatrix4fv(u['uModel'] ?? null, false, model);
    gl.uniform3fv(u['uCameraPos'] ?? null, camera.position);
    gl.uniform1f(u['uWidth'] ?? null, widthM);
    gl.uniform1f(u['uMinWidthPerMetre'] ?? null, minWidthPerMetre);
    gl.uniform3fv(u['uColor'] ?? null, color);
    gl.uniform1f(u['uOpacity'] ?? null, opacity);
    gl.uniform1f(u['uSoftness'] ?? null, softness);
    gl.uniform1i(u['uOutputTransform'] ?? null, this.gradeCode());
    gl.uniform1f(u['uOutputExposure'] ?? null, this.gradeExposure());
    bindAtmosphere(
      gl,
      u,
      env,
      this.reflectionPassActive ? this.reflectionAtmosphereY : (camera.position[1] ?? 0),
      this.quality.underwaterAtmosphere,
    );
    lines.drawTo(gl, count, additive);
  }

  /**
   * Draw a scatter batch. Wind arrives as a value rather than being sampled
   * here: every system in the world must answer to the same gust, and a
   * renderer that sampled its own would be a second wind by definition.
   *
   * **It binds no point lights, and that is a rule about what may be instanced rather than a
   * performance note.** A field of grass shaded by ten lamps is a cost nobody wanted, so this
   * material answers to the sun and the ambient alone. The consequence is invisible from the
   * call site and a consumer has to know it: anything a lamp in the scene is meant to reach has
   * to be merged into a mesh instead. Choosing wrongly is not slow, it is unlit. Reported from
   * outside, where it had become a rule written on a consumer's own wrapper.
   */
  drawScatter(
    scatter: InstancedMesh,
    data: InstanceData,
    camera: Camera,
    env: Environment,
    windX: number,
    windZ: number,
    windGust: number,
    timeSeconds: number,
    /**
     * Recent presses, from a `TrampleField`, or null for foliage nothing walks
     * through. Four floats per slot: world position and how pressed.
     */
    trample: Float32Array | null = null,
  ): void {
    if (data.count === 0) return;
    const { gl } = this;
    const u = this.scatterUniforms;
    gl.useProgram(this.scatterProgram);
    gl.uniformMatrix4fv(u['uViewProj'] ?? null, false, this.viewProjFor(camera));
    this.bindScatterDeform(u, windX, windZ, windGust, timeSeconds, trample);

    gl.uniform3fv(u['uDirectionalDir'] ?? null, env.directionalDir);
    gl.uniform3fv(u['uDirectionalColor'] ?? null, env.directionalColor);
    gl.uniform3fv(u['uAmbient'] ?? null, env.ambient);
    gl.uniform3fv(u['uCameraPos'] ?? null, camera.position);
    bindAtmosphere(
      gl,
      u,
      env,
      this.reflectionPassActive ? this.reflectionAtmosphereY : (camera.position[1] ?? 0),
      this.quality.underwaterAtmosphere,
    );

    // Foliage is thin and seen from both faces; culling it loses half of it.
    gl.disable(gl.CULL_FACE);
    scatter.draw(gl, data.count);
    gl.enable(gl.CULL_FACE);
  }

  /**
   * Upload the instance transform's inputs — the shared half of the scatter material.
   *
   * One function for both scatter programs, so the picture and its shadow are bent
   * and pressed by identical numbers. Splitting these into two call sites is how the
   * two poses drift apart by a tuning constant nobody remembers changing twice.
   */
  private bindScatterDeform(
    u: Record<string, WebGLUniformLocation>,
    windX: number,
    windZ: number,
    windGust: number,
    timeSeconds: number,
    trample: Float32Array | null,
  ): void {
    const { gl } = this;
    /* Chosen in `scatterDeform.ts` so both backends bend the same grass. */
    const d = resolveScatterDeform(windX, windZ, windGust, timeSeconds, trample, this.deform);
    this.uploadWind(u, d);
    gl.uniform4fv(u['uTrample'] ?? null, d.trample);
    gl.uniform1f(u['uTrampleRadius'] ?? null, d.trampleRadius);
    gl.uniform1f(u['uTrampleDepth'] ?? null, d.trampleDepth);
  }

  /** Refilled per call rather than allocated; see `createScatterDeform`. */
  private readonly deform = createScatterDeform();

  /**
   * The frame's wind, as the mesh and depth programs read it.
   *
   * **A second target from `deform` above, and one conversion between them.** The scatter batch
   * takes its wind as arguments to its own draw call, which predates this, so the two cannot share
   * a target without changing that signature. What they do share is `resolveScatterDeform`, which
   * is where every number that matters is decided — a normalised direction, metres of bend from a
   * speed, a gust amplitude and a scaled clock. `scatterDeform.ts` says why that has to be one
   * function: a copy of any of those conversions drifts, and a field of grass then leans
   * differently from the canopy above it.
   *
   * **What this does not defend against** is a consumer calling `setWind` with one gust and
   * `drawScatter` with another. That is the same hazard `drawFlock` already carries, and the
   * answer is the one AGENTS.md gives: sample the field once a frame and pass it down.
   */
  private readonly frameWind = createScatterDeform();

  /**
   * The five wind uniforms, uploaded through one function wherever they are read.
   *
   * Separate from the trample array beside it because the mesh programs want the wind and have no
   * concept of something having walked through them.
   */
  private uploadWind(u: Record<string, WebGLUniformLocation | null>, d: ScatterDeform): void {
    const { gl } = this;
    gl.uniform2fv(u['uWindDirection'] ?? null, d.direction);
    gl.uniform1f(u['uWindSpeed'] ?? null, d.bend);
    gl.uniform1f(u['uWindGust'] ?? null, d.gust);
    gl.uniform1f(u['uWindTime'] ?? null, d.time);
    gl.uniform2fv(u['uWindSpatialPhase'] ?? null, d.spatialPhase);
  }

  /**
   * The frame's wind, sampled once by the caller and handed down.
   *
   * Every mesh carrying a per-vertex channel bends to this, in the colour pass and in the depth
   * pass, so a canopy and its own shadow move together. A caller that never calls it gets a still
   * world, which is exactly what every scene drew before the channel existed.
   */
  setWind(windX: number, windZ: number, windGust: number, timeSeconds: number): void {
    resolveScatterDeform(windX, windZ, windGust, timeSeconds, null, this.frameWind);
  }

  /** The point-shadow set, chosen by the pool and bound below. Refilled, never allocated. */
  private readonly resolvedPointShadows = createResolvedPointShadows(MAX_POINT_LIGHTS);

  /**
   * Put the resolved point-shadow set on the GL program: one array texture and five arrays.
   *
   * **It was twelve cubemaps on twelve units.** They are one `TEXTURE_2D_ARRAY` now, a layer per
   * light, which is where eleven of WebGL2's sixteen guaranteed units came back from.
   *
   * **The thin half of a split, and the arrays are why it is worth splitting.** Everything
   * about *which* map a light samples and how present it is comes out of the pool, which both
   * backends share; this turns that into a texture unit and `uniform*v` calls, which is the only
   * part WebGL2 does differently.
   *
   * The array uniforms are addressed as `name[0]`, and that is not decoration. GLSL ES exposes
   * an array uniform under the name of its first element; `name[1]` returns nothing from the
   * cached table, so uploading element by element left slots 1–7 at zero and made their shadows
   * vanish.
   */
  private bindPointShadows(
    uniforms: Record<string, WebGLUniformLocation>,
    firstUnit: number,
  ): void {
    const pool = this.pointShadows;
    if (pool === null) return;
    const { gl } = this;
    const resolved = this.resolvedPointShadows;

    gl.activeTexture(gl.TEXTURE0 + firstUnit);
    /*
     * Never `null`: an unbound sampler reads undefined, see `emptyTexture.ts` — a descriptor for
     * a texture that does not exist page-faulted an RDNA4 card and wedged the device. The
     * stand-in is a one-texel array for the frames before a world has sized the real one.
     */
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, this.pointShadowArray?.texture ?? this.emptyTexture2DArray);
    gl.uniform1i(uniforms[POINT_SHADOW_SAMPLER] ?? null, firstUnit);

    gl.uniform1iv(uniforms['uPointShadowLayer[0]'] ?? null, resolved.layers);
    /* Origin and far plane in one row; see `uPointShadowProjection` in the preamble. */
    gl.uniform4fv(uniforms['uPointShadowProjection[0]'] ?? null, resolved.projections);
    gl.uniform1fv(uniforms['uPointShadowNear[0]'] ?? null, resolved.near);
    gl.uniform1fv(uniforms['uPointShadowSize[0]'] ?? null, resolved.sourceRadius);
    gl.uniform1fv(uniforms['uPointShadowWeight[0]'] ?? null, resolved.presence);
    gl.uniform1iv(uniforms['uLivePointShadowLayer[0]'] ?? null, resolved.liveLayers);
    gl.uniform4fv(uniforms['uLivePointShadowProjection[0]'] ?? null, resolved.liveProjections);
    gl.uniform1fv(uniforms['uLivePointShadowNear[0]'] ?? null, resolved.liveNear);
    gl.uniform1fv(uniforms['uLivePointShadowSize[0]'] ?? null, resolved.liveSourceRadius);
    gl.uniform1fv(uniforms['uLivePointShadowWeight[0]'] ?? null, resolved.liveWeights);
  }

  /** The same, for a light volume's local-space camera; see `createResolvedLightVolume`. */
  private readonly volume = createResolvedLightVolume();

  createWater(resolution?: number, nearExtent?: number, farHalfExtent?: number): WaterRenderer {
    return new WaterRenderer(
      this.gl,
      resolution ?? this.quality.waterResolution,
      nearExtent,
      farHalfExtent,
      this.quality.waterReflectionFilterTaps,
    );
  }

  /**
   * Surfaces lit from below by the water under them.
   *
   * Null when the profile has water off or there is nothing to light, so a world
   * with no covered water pays no program compile, no buffer and no draw. The
   * matching draw accepts null for the same reason: a caller should not need a
   * branch to express "this world has none".
   */
  createCaustics(sheets: readonly CausticSheet[]): CausticsRenderer | null {
    if (!this.quality.water || sheets.length === 0) return null;
    return new CausticsRenderer(this.gl, sheets);
  }

  // --- Draws that own their context ----------------------------------------

  drawPlumes(
    plumes: PlumeRenderer,
    camera: Camera,
    timeSeconds: number,
    env: Environment,
    windX = 0,
    windZ = 0,
    originX = 0,
    originY = 0,
    originZ = 0,
  ): void {
    plumes.draw(
      this.gl,
      this.frameViewFor(camera),
      timeSeconds,
      env,
      this.quality.underwaterAtmosphere,
      this.reflectionPassActive ? this.reflectionAtmosphereY : (camera.position[1] ?? 0),
      this.reflectionPassActive ? (this.planarReflection?.clipPlane ?? null) : null,
      windX,
      windZ,
      originX,
      originY,
      originZ,
    );
  }

  drawWater(
    water: WaterRenderer,
    camera: Camera,
    timeSeconds: number,
    settings: WaterBody,
    env: Environment,
    windX = 0,
    windZ = 0,
  ): void {
    if (!this.quality.water) return;
    this.waterBudget.ask();
    water.draw(
      this.gl,
      this.frameViewFor(camera),
      timeSeconds,
      settings,
      env.directionalDir,
      env.directionalColor,
      env.ambient,
      env,
      this.quality.underwaterAtmosphere,
      this.reflectionReadyThisFrame ? this.planarReflection : null,
      env,
      this.quality.pointLightFalloff,
      windX,
      windZ,
    );
  }

  /**
   * Draw after the opaque scene: this is light added to surfaces already shaded,
   * from the water under them.
   */
  drawCaustics(
    caustics: CausticsRenderer | null,
    camera: Camera,
    timeSeconds: number,
    env: Environment,
    windX = 0,
    windZ = 0,
    strength = 1,
  ): void {
    if (caustics === null || !this.quality.water) return;
    const drew = caustics.draw(
      this.gl,
      this.frameViewFor(camera),
      timeSeconds,
      env.directionalDir,
      env.directionalColor,
      env.ambient,
      env,
      this.quality.underwaterAtmosphere,
      windX,
      windZ,
      strength,
    );
    if (drew) this.causticsBudget.ask();
  }

  /**
   * Begin a scene render mirrored across a horizontal plane. Draw ordinary
   * mesh, sky and plume passes with the returned camera, then call
   * `endPlanarReflection`; the next water draw samples the completed target.
   */
  /**
   * **This is a water feature, not a renderer one, and the name hides that.**
   *
   * The target is allocated only when `water` *and* `waterReflections` are both on, and the
   * only thing that samples it is `WaterRenderer`. So a scenario whose ground is a mesh slab
   * with `drawFilm` patches over it, which is what a wet street is, cannot mirror the scene
   * into it however it calls this. Reported from outside after being attempted, which is the
   * cost of a name that promises more than the wiring does.
   *
   * What is available to a surface that is not water: `bakeReflectionProbe`, which is a room
   * rather than a mirror, and `drawFilm`'s sheen, which is iridescence rather than reflection.
   * Neither is a substitute for a mirrored pass and this comment is not pretending otherwise.
   */
  /* Like `bakeReflectionProbe`, this re-enters the **mesh pass only**: anything a scene draws
     after the world, particles, light volumes, the sky, is missing from the mirror unless it is
     moved into the pass this reflects. */
  beginPlanarReflection(source: Camera, planeY: number, clearColor: Vec3): Camera | null {
    const reflection = this.planarReflection;
    /*
     * `usable` as well as present, and the check has to come before anything is opened.
     *
     * A target that failed to allocate returns no camera, so a caller skips the pass and
     * never calls `endPlanarReflection` — which would leave the GPU timer's bracket open
     * for the rest of the frame and swallow the `rest` measurement with it. Deciding
     * here, before the bracket and the pass flag, is what keeps a disabled reflection a
     * missing reflection rather than a corrupted frame.
     */
    if (reflection === null || !reflection.usable) return null;
    this.reflectionReadyThisFrame = false;
    this.reflectionAtmosphereY = source.position[1] ?? 0;
    const camera = reflection.begin(
      this.gl,
      this.canvas.width,
      this.canvas.height,
      source,
      planeY,
      clearColor,
    );
    this.gpuTimer.begin('reflection');
    this.reflectionPassActive = true;
    return camera;
  }

  endPlanarReflection(): void {
    if (this.contextLost) return;
    const reflection = this.planarReflection;
    if (!this.reflectionPassActive || reflection === null) return;
    reflection.end(this.gl);
    this.gpuTimer.end();
    this.reflectionPassActive = false;
    this.reflectionReadyThisFrame = true;
    this.restoreViewport();
  }

  get aspect(): number {
    return this.canvas.width / Math.max(this.canvas.height, 1);
  }

  /**
   * The size the world is drawn at, which on this backend is always the drawing buffer.
   *
   * **Here so that a contributed pass has one question to ask on both backends.** WebGPU can draw
   * the world smaller than the canvas and let its composite enlarge it — `quality.reconstruction`
   * — and a pass filling a target of its own has to follow that size or draw a picture the frame
   * pass clips. This backend has no compute stage and no reconstruction, so the answer never moves;
   * a pass that reads it is correct on both, and one that reads `canvas.width` is correct on one.
   */
  get sceneWidth(): number {
    return Math.max(1, this.canvas.width);
  }

  get sceneHeight(): number {
    return Math.max(1, this.canvas.height);
  }

  /**
   * Point rendering back at the frame's own target, whole.
   *
   * Every pass that borrows the viewport — the shadow maps, the reflection, the export
   * target, an inset — has to hand it back, and each of them was spelling the same three
   * arguments out. Five copies of "what does the full frame mean" is five chances to drift
   * from the drawing buffer's real size after a resize.
   *
   * It restores the **framebuffer** as well, and that is not tidiness. A borrowing pass
   * releases by binding `null`, which is the canvas — correct when the canvas was where the
   * frame was going, and wrong the moment a scene target exists: everything drawn after a
   * reflection would land on the canvas and then be overwritten by the resolve of a target
   * missing half its content. This is the one place that knows where a frame is going, so
   * it is the one place that can say so.
   */
  private restoreViewport(): void {
    if (this.sceneTarget !== null && !this.framePresented) {
      this.sceneTarget.bind();
      return;
    }
    this.gl.bindFramebuffer(this.gl.FRAMEBUFFER, null);
    this.gl.viewport(0, 0, this.canvas.width, this.canvas.height);
  }

  /**
   * Match the drawing buffer to CSS size × clamped DPR, under the pixel budget.
   * Cheap when unchanged.
   *
   * The budget is deliberately not applied to a locked buffer: a lock is a caller naming
   * an exact size for a reason no quality setting knows about — a clip is 1080x1920
   * whatever anybody's frame rate is — and silently handing back a different one would
   * write a file that is not the size it claims.
   */
  resize(): void {
    if (this.contextLost) return;
    drawingBufferSize(
      this.canvas.clientWidth,
      this.canvas.clientHeight,
      Math.min(window.devicePixelRatio || 1, this.maxDpr),
      this.lockedWidth,
      this.lockedHeight,
      this.maxDrawingBufferPixels,
      this.budgeted,
    );
    const { width, height } = this.budgeted;
    if (this.canvas.width !== width || this.canvas.height !== height) {
      this.canvas.width = width;
      this.canvas.height = height;
      this.gl.viewport(0, 0, width, height);
      /*
       * Size the reflection with the frame, not on the first frame that shows water.
       * It is a full drawing-buffer colour target plus a depth renderbuffer, and
       * allocating it lazily put that in the middle of play: 28% of a 62 ms frame the
       * first time a character came in sight of the sea. Here it is paid where the rest
       * of the frame's memory is paid, at a size that is already known.
       */
      this.planarReflection?.prepare(this.gl, width, height);
    }
  }

  /**
   * Move the drawing-buffer area cap, in pixels. Zero is uncapped.
   *
   * Live, unlike every other quality lever, and that is the feature rather than an
   * inconsistency. The rest size an allocation at construction — shadow maps, reflection
   * targets, the wave surface — so moving one means rebuilding every GPU resource the
   * world hangs off. This one only changes how many pixels the next frame covers, and
   * everything sized from the drawing buffer already re-fits itself when it changes. A
   * player hunting their own frame rate can therefore move this and see the answer, which
   * is the only way anybody finds out that pixels were what it cost them.
   */
  setMaxDrawingBufferPixels(pixels: number): void {
    if (this.contextLost) return;
    this.maxDrawingBufferPixels = Number.isFinite(pixels) && pixels > 0 ? pixels : 0;
    this.resize();
  }

  /**
   * Move the drawing-buffer density cap at runtime, without rebuilding anything.
   *
   * Live for the same reason `setMaxDrawingBufferPixels` is, and it is the other half of
   * the same idea: `resize()` re-reads this cap, and the scene target and the planar
   * reflection are both sized *from* the drawing buffer, so nothing here owns an
   * allocation that a new density invalidates.
   *
   * This is the one quality lever a governor can drive, which is exactly why the governor
   * drives this and not the preset. A preset means shadow maps and wave surfaces sized at
   * construction; changing one of those mid-session means rebuilding every GPU resource the
   * world hangs off, and that is what a reload is for.
   *
   * Cheap to call every few hundred frames and pointless to call every frame: it forces a
   * `resize()`, which reallocates the scene target when the size actually changes.
   */
  applyResolutionScale(scale: number): void {
    if (this.contextLost) return;
    if (!Number.isFinite(scale) || scale <= 0) return;
    if (scale === this.maxDpr) return;
    this.maxDpr = scale;
    this.resize();
  }

  /**
   * The density actually in force, which is where a governor has to start from.
   *
   * `applyResolutionScale` could always be *written* and never read, and that was enough for
   * the consumer that drives it from a stored preset. It is not enough for one that drives it
   * from measurement: `ResolutionGovernor` is constructed around a starting scale and moves
   * relative to it, so a caller with no way to ask has to guess.
   *
   * **The effective density and not `maxDpr`, and the difference is not academic.** `maxDpr` is
   * a *ceiling*: `resize` takes `min(devicePixelRatio, maxDpr)`, so on an ordinary 1x display a
   * ceiling of 2 is already doing nothing. A governor seeded from the ceiling there spends its
   * first four decisions walking 2 down to 1 while the drawing buffer does not change by a
   * single pixel, which is a machine stuttering for several seconds through a fix that is
   * being applied to a number nobody is reading. Found exactly that way, at 20x throttle: three
   * decisions, no change in buffer size.
   *
   * `capabilityClamp` is the other half of the same point, and it argues the same direction:
   * `maxDevicePixelRatio` is a request the clamp is entitled to have already lowered.
   */
  get resolutionScale(): number {
    return Math.min(window.devicePixelRatio || 1, this.maxDpr);
  }

  /**
   * Pin the drawing buffer to an exact pixel size, ignoring CSS and DPR.
   *
   * For recording a frame at a size that has nothing to do with the window: a
   * clip is 1080x1920 whatever shape the browser is, and `aspect` follows the
   * lock, so a camera given `renderer.aspect` composes for the *export* rather
   * than for the screen. That is the difference between rendering at an aspect
   * and cropping to one, and cropping throws away the half of the frame the shot
   * was built around.
   *
   * Not a quality option, deliberately. `RenderQualityOptions` describes how good
   * the picture is for the whole session and is resolved before any GPU resource
   * exists; this is a temporary, caller-driven override that must be released.
   * The CSS box is untouched — a page that wants the preview letterboxed is
   * styling, not rendering.
   */
  lockDrawingBuffer(width: number, height: number): void {
    if (this.contextLost) return;
    this.lockedWidth = Math.max(2, Math.round(width));
    this.lockedHeight = Math.max(2, Math.round(height));
    this.resize();
  }

  /** Back to following the CSS box. The next `resize` restores it. */
  unlockDrawingBuffer(): void {
    if (this.contextLost) return;
    this.lockedWidth = 0;
    this.lockedHeight = 0;
    this.resize();
  }

  /**
   * Render one directional shadow layer. Bracket `drawShadowCasters` calls
   * between this and `endShadowPass`. Static and dynamic layers are sampled
   * together; pass `shadowStrength: 0` whenever the dominant source is not
   * emitting, because a stale map must never be sampled.
   */
  beginShadowPass(
    lightViewProj: ReadonlyMat4,
    layer: 'static' | 'static-peel' | 'dynamic' = 'static',
  ): void {
    const shadowMap =
      layer === 'static'
        ? this.shadowMap
        : layer === 'static-peel'
          ? this.peeledShadowMap
          : this.dynamicShadowMap;
    if (shadowMap === null) {
      this.shadowPassActive = false;
      this.activeShadowMap = null;
      return;
    }
    const { gl } = this;
    this.gpuTimer.begin('shadows');
    this.shadowPassActive = true;
    this.activeShadowMap = shadowMap;
    /*
     * **Range-corrected but not reversed.** `EXT_clip_control` is context state, so a light matrix
     * that still emits OpenGL's `[-1, 1]` loses everything below zero the moment it is on. See
     * `GL_SHADOW_REMAP`.
     */
    this.activeDepthViewProj = this.reversedDepth
      ? this.shadowMatrix(lightViewProj)
      : lightViewProj;
    this.activeDepthPeel = layer === 'static-peel';
    // The directional pass keeps the frame's back-face culling; only a cubemap bake
    // turns it off wholesale. See `depthPassCullsFaces`.
    this.depthPassCullsFaces = true;
    /*
     * **Shadows keep the conventional sense and this is where that is enforced.** The directional
     * cascades are orthographic, where depth is already linear and a float buffer gains nothing,
     * and their maps are sampled by shaders written against `LEQUAL`. Reversing them would mean
     * flipping every comparison in the shadow path for no precision at all, so the light matrices
     * are handed over raw and the compare goes back for the length of the pass.
     */
    gl.depthFunc(glShadowDepthFunc(gl));
    gl.clearDepth(SHADOW_DEPTH_CLEAR);
    // The previous mesh pass left all directional maps bound for sampling.
    // A texture cannot be sampled while it is attached to the active depth
    // target, even when the shader branch would skip that sample.
    const targetUnit = layer === 'static' ? 0 : layer === 'static-peel' ? 1 : 2;
    gl.activeTexture(gl.TEXTURE0 + targetUnit);
    gl.bindTexture(gl.TEXTURE_2D, null);
    shadowMap.begin(gl);
    gl.useProgram(this.depthProgram);
    const peel = layer === 'static-peel';
    gl.uniform1i(this.depthUniforms['uPeelShadowLayer'] ?? null, peel ? 1 : 0);
    if (peel) {
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, this.shadowMap?.texture ?? null);
      gl.uniform1i(this.depthUniforms['uPreviousShadowMap'] ?? null, 0);
    }
    /* The corrected one, matching `activeDepthViewProj` above: a pass must render its map with the
       same matrix every draw in it uses, or the two disagree by the range correction. */
    gl.uniformMatrix4fv(
      this.depthUniforms['uLightViewProj'] ?? null,
      false,
      this.activeDepthViewProj ?? lightViewProj,
    );
    /*
     * **The same wind the colour pass reads, uploaded to both rigid depth programs.**
     *
     * A caster that bends in the picture and stands still in the shadow map slides its shade off
     * the ground it belongs to, and the offset follows the gust, so it never settles into
     * something a still frame would show. `scatter.ts` records having fixed exactly this for its
     * own two programs.
     *
     * The skinned program is written here rather than in the sink because the sink runs per draw
     * and this does not change inside a pass.
     */
    this.uploadWind(this.depthUniforms, this.frameWind);
    gl.useProgram(this.depthSkinnedProgram);
    this.uploadWind(this.depthSkinnedUniforms, this.frameWind);
    gl.useProgram(this.depthProgram);
  }

  /**
   * Submit everything that casts into the layer `beginShadowPass` opened.
   *
   * The same `ShadowCasters` closure the point-light bakes are given, so a world has
   * exactly one answer to "what occludes light" and the sun and the lamps cannot
   * disagree about it. A no-op when the profile has directional shadows off.
   */
  /**
   * The same enumeration, replayed into the colour pass that is open.
   *
   * See `SceneCasters` in `shadowCasters.ts` for why this exists and why scatter is declined. The
   * sink is built once and held, because a caster enumeration runs per pass and a sink allocated
   * per call would allocate per pass.
   */
  private readonly sceneCasterSink: ShadowCasterSink = {
    mesh: (mesh, model, material) => {
      /* The opaque handle narrowed to this backend's own, for the reason `casterSink`
         gives about the mesh: nothing else ever handed one out. */
      this.bindSceneCasterMaterial(material);
      this.drawMesh(mesh as Mesh, model);
    },
    skinnedMesh: (mesh, model, palette, material) => {
      /* The opaque handle narrowed to this backend's own, for the reason `casterSink`
         gives about the mesh: nothing else ever handed one out. */
      this.bindSceneCasterMaterial(material);
      this.setSkinPalette(palette);
      this.drawMesh(mesh as Mesh, model);
      /* Put back, or the next rigid draw in the replay skins by whatever this one left bound. */
      this.setSkinPalette(null);
    },
    instanced: (batch, data, material) => {
      /* The opaque handle narrowed to this backend's own, for the reason `casterSink`
         gives about the mesh: nothing else ever handed one out. */
      this.bindSceneCasterMaterial(material);
      this.drawInstanced(batch as InstancedBatch, data);
    },
    /* Declined, and the absence is meant to be visible. `SceneCasters` says why. */
    scatter: () => {},
  };

  /**
   * The material the open replay has bound, or `undefined` before its first entry.
   *
   * The twin of the WebGPU field, which carries the whole argument: a sink's material is optional
   * and omitting it means *no material* rather than *unchanged*, so a run of entries sharing one
   * material had no shorter spelling and bound once per entry. What it costs here is not a ring
   * that runs out but `setMaterial`'s own body — a `useProgram` and a full `writeMaterialState`
   * for **every** flat program, texture binds included, per entry rather than per surface.
   *
   * Reference identity, and `undefined` rather than `null` for "nothing bound yet", both for the
   * reasons given there.
   */
  private sceneCasterMaterial: SurfaceMaterial<SurfaceTexture> | null | undefined;

  /** Bind one replay entry's material, unless it is the one already standing. */
  private bindSceneCasterMaterial(material: SceneCasterMaterial | undefined): void {
    const wanted = (material ?? null) as SurfaceMaterial<SurfaceTexture> | null;
    if (wanted === this.sceneCasterMaterial) return;
    this.sceneCasterMaterial = wanted;
    this.setMaterial(wanted);
  }

  /**
   * Draw everything a caster enumeration contains into the open colour pass, with its materials.
   *
   * The colour counterpart of `drawShadowCasters`, so one closure answers "what is in this frame"
   * for the shadow cascade, every cubemap face, and a second viewpoint such as a mirror or a probe
   * face. What it replaces is a consumer re-entering its whole draw path with a second camera.
   */
  drawSceneCasters(casters: ShadowCasters): void {
    if (this.contextLost) return;
    /* Nothing carried in from the pass around this: the replay's first entry binds whatever it
       asks for, because what `setMaterial` was last given is not this sink's to assume. */
    this.sceneCasterMaterial = undefined;
    casters(this.sceneCasterSink);
  }

  drawShadowCasters(casters: ShadowCasters): void {
    if (this.contextLost) return;
    if (!this.shadowPassActive) return;
    casters(this.casterSink);
  }

  endShadowPass(): void {
    if (this.contextLost) return;
    const shadowMap = this.activeShadowMap;
    if (!this.shadowPassActive || shadowMap === null) return;
    shadowMap.end(this.gl);
    /* Back to the frame's sense; see `beginShadowPass` for why it left it. */
    this.gl.depthFunc(glDepthFuncEqual(this.gl));
    this.gl.clearDepth(this.depthClear);
    this.gpuTimer.end();
    this.shadowPassActive = false;
    this.activeShadowMap = null;
    // Restore the drawing-buffer viewport the shadow pass overrode.
    this.restoreViewport();
  }

  /**
   * The lit program, built at the largest light budget this device will actually link.
   *
   * **Why the engine fits the shader to the part rather than leaving it to a consumer.** `flat`
   * at the full budget declares **440** rows of the fragment uniform grid — twenty arrays sized by
   * `MAX_LIGHTS` and fourteen by `MAX_AREA_LIGHTS`, and GLSL ES gives an array a whole row per
   * element whatever its base type. An Adreno 740 offers **256**. So the program does not link,
   * `compileProgram` throws out of this constructor, and a game that awaited `createRenderer` gets
   * no renderer, no reason and no frame — the page's background colour for as long as the player
   * is willing to look at it, with the splash covering the first second of it. Reported from
   * outside exactly that way.
   *
   * The only lever a consumer had was `pointShadows: false`, and it is not enough to be a fix: it
   * pays a whole feature on every part under 440, and the lit path *without* point shadows is
   * still 248, so it cannot reach a conforming device at all — WebGL2 guarantees 224. Sizing the
   * arrays reaches it with everything compiled in: 8 lights and 2 rectangles is 252 rows **with**
   * point shadows, and 4 and 1 is 158.
   *
   * **Counted first, then linked, and both are load-bearing.** The count is an upper bound over
   * the source (see `countUniformVectors`), which is what lets the first attempt be the right one
   * on a part that is short; the link is the driver's own answer, and a refusal steps down a rung
   * rather than propagating. Only a shader that will not link at *any* budget throws, and it
   * throws a sentence with the device's numbers in it rather than a bare driver string.
   */
  private fitFlatProgram(gl: WebGL2RenderingContext): {
    program: WebGLProgram;
    source: string;
    budget: LightBudget;
  } {
    const variant = {
      pointShadows: this.quality.pointShadows,
      directionalShadows: this.quality.directionalShadows,
      environmentProbe: this.probeCapture !== null,
      nightEmissive: this.quality.nightEmissive,
    };
    const build = (budget: LightBudget): string =>
      flatFrag({ ...variant, maxLights: budget.maxLights, maxAreaLights: budget.maxAreaLights });
    const vert = flatVert({ skinned: false, morphed: false, instanced: false });
    const limit = gl.getParameter(gl.MAX_FRAGMENT_UNIFORM_VECTORS) as number;
    const ceiling: LightBudget = {
      maxLights: Math.min(this.quality.maxLights, FULL_LIGHT_BUDGET.maxLights),
      maxAreaLights: Math.min(this.quality.maxAreaLights, FULL_LIGHT_BUDGET.maxAreaLights),
    };
    const planned = planLightBudget(limit, ceiling, build);
    if (!planned.fits) {
      /*
       * Out loud, for the same reason the texture-unit clamp above says its piece: a quality
       * setting that silently does not apply is worse than a slow game, and a consumer sizing
       * their own `PointLightBuffer` needs to know the shader stopped reading past slot N.
       */
      console.warn(
        `Renderer: the lit shader wants ${planned.ceilingVectors} fragment uniform ` +
          `vectors at ${ceiling.maxLights} lights and this GPU offers ${limit}. Building at ` +
          `${planned.budget.maxLights} lights and ${planned.budget.maxAreaLights} rectangles ` +
          `instead (${planned.vectors}). Every feature is still compiled in; see \`shadedLights\`.`,
      );
    }

    let budget = planned.budget;
    let source = planned.source;
    let refusal: unknown = null;
    for (;;) {
      try {
        return { program: compileProgram(gl, vert, source, 'flat'), source, budget };
      } catch (error) {
        refusal ??= error;
        const smaller = nextLightBudget(budget);
        if (smaller === null) {
          const detail = refusal instanceof Error ? refusal.message : String(refusal);
          throw new Error(
            `${detail} — and it did not link at any smaller light budget either, down to ` +
              `${budget.maxLights} lights and ${budget.maxAreaLights} rectangles. This GPU ` +
              `reports ${limit} fragment uniform vectors; the first attempt wanted ` +
              `${planned.vectors} at ${planned.budget.maxLights} lights.`,
            { cause: refusal },
          );
        }
        budget = smaller;
        source = build(budget);
      }
    }
  }

  /**
   * How many point lights this renderer's shader shades at once.
   *
   * **Read it when sizing a `PointLightBuffer`.** `selectPointLights` fills a buffer to the
   * buffer's own capacity and evicts the weakest when it is full, so the winners are the nearest
   * ones but they are not in any order — which means a buffer wider than this leaves the shader
   * shading an arbitrary subset rather than the nearest N. Sizing the buffer from this number is
   * what makes a clamped budget a smaller scene instead of a flickering one. A wider upload is
   * otherwise harmless: GL ignores array elements past the end of a uniform, measured on ANGLE.
   */
  get shadedLights(): number {
    return this.lightBudget.maxLights;
  }

  /** How many rectangular emitters this renderer's shader shades at once. */
  get shadedAreaLights(): number {
    return this.lightBudget.maxAreaLights;
  }

  /** How many point-light shadows the shader samples at once. */
  get sampledShadowLights(): number {
    return this.pointShadows === null ? 0 : this.lightBudget.maxLights;
  }

  /**
   * Size the point-shadow pool for a world's lights. Call at load.
   *
   * It used to bake a map for every light here and keep them all forever, which is
   * why it was called `bakeStaticPointShadows`. That allocated one cubemap per
   * lamp — about 327 MB for 50 of them — so that the eight the shader can bind
   * could be read. See `POINT_SHADOW_POOL`.
   *
   * Nothing is baked now. Maps are borrowed from the pool and baked by
   * `updatePointShadows` the first time a light is actually sampled, which is the
   * only moment the result can be seen. Load is correspondingly faster: it no
   * longer renders six passes over the static world for every lamp in the day,
   * most of which were never looked at.
   */
  prepareStaticPointShadows(
    lights: readonly ShadowLight[],
    /**
     * The rectangles this world will shade, so the ones that cast get layers of the same array.
     *
     * **A second parameter on this call rather than a call of its own, because there is one array
     * and `texStorage3D` sizes it once.** A separate `prepareAreaShadows` would either rebuild the
     * array — throwing away every baked lamp — or depend on being called first, and a consumer
     * getting that order wrong would see the rectangles cast and the lamps stop. Optional, so
     * every existing caller is unchanged and allocates exactly what it did before.
     *
     * The name says point and this takes area lights too. It stays, because what it prepares is
     * *the* shadow array and both kinds of light are layers in it — the alternative was a second
     * name for one thing.
     */
    areaLights: readonly AreaLightSource[] = [],
  ): void {
    if (this.contextLost) return;
    if (this.pointShadows === null) {
      this.warnAreaShadowsOff(areaLights);
      return;
    }
    /*
     * The array is built here and rebuilt only to grow, because `texStorage3D` is immutable and
     * because a world with three lamps has no use for the storage of twenty-two —
     * `PointShadowArray` carries the full argument. `prepareStaticMaps` forgets every slot
     * assignment anyway, so a rebuild costs the baked images at a moment they were being
     * discarded regardless.
     */
    const extra = areaShadowLayerCount(areaLights);
    const wanted = Math.min(lights.length, POINT_SHADOW_POOL) + LIVE_POINT_SHADOW_MAPS + extra;
    if (this.pointShadowArray === null || this.pointShadowArray.layers < wanted) {
      this.pointShadowArray?.dispose(this.gl);
      this.pointShadowArray = new PointShadowArray(
        this.gl,
        this.quality.pointShadowFaceSize,
        lights.length,
        extra,
      );
      this.pointShadows.forgetEveryImage();
      this.areaShadows?.forgetEveryImage();
    }
    this.pointShadows.prepareStaticMaps(lights.length);
    this.preparedPointLightCount = lights.length;
    /*
     * After the pool, because the area layers begin where it ends and `firstAreaShadowLayer`
     * answers that from the same expression the array sized itself with.
     */
    this.areaShadows?.prepare(areaLights, firstAreaShadowLayer(lights.length));
    this.warnAreaShadowRange(areaLights);
  }

  /**
   * Say once that a rectangle asked to cast and named no range, naming the field.
   *
   * **A warning rather than a throw, because this is reachable from a frame.** `AGENTS.md` says
   * fail fast at init and never throw in the frame loop, and a consumer may re-prepare when its
   * world changes. What it must not be is silent: the picture of a rectangle that declined to cast
   * and one whose range was forgotten is the same picture, and the second is a typo.
   */
  private warnAreaShadowRange(areaLights: readonly AreaLightSource[]): void {
    if (this.warnedAreaShadowRange) return;
    const count = Math.min(areaLights.length, MAX_AREA_LIGHTS);
    for (let slot = 0; slot < count; slot++) {
      const light = areaLights[slot];
      if (light?.castsShadow !== true || castingRange(light) > 0) continue;
      this.warnedAreaShadowRange = true;
      console.warn(
        `Renderer: area light ${slot} declares castsShadow but no usable shadowRange, so it will ` +
          'light through whatever stands in front of it. A rectangle has no radius to take a far ' +
          'plane from — set shadowRange to how far this fixture should occlude, in metres.',
      );
      return;
    }
  }

  /**
   * Say once that a rectangle wants layers the array was not sized for.
   *
   * **This is the area-light shape of the failure `updatePointShadows` warns about above**, and it
   * is just as quiet: `prepareStaticPointShadows` sizes the array — `texStorage3D` and
   * `createTexture` are both immutable — so a consumer that passes its rectangles here and not
   * there gets an array with no room above the pool. Every declaration is then honoured except the
   * storage, the set holds no maps, every layer publishes -1, and the frame is indistinguishable
   * from one whose rectangles declined to cast.
   */
  private warnAreaShadowLayers(): void {
    if (this.warnedAreaShadowLayers) return;
    this.warnedAreaShadowLayers = true;
    console.warn(
      `Renderer: an area light asks to cast into layers this shadow array does not have. The ` +
        'array is sized once, so pass the same rectangles to prepareStaticPointShadows(lights, ' +
        'areaLights) that you pass here — otherwise they light through whatever stands in front ' +
        'of them.',
    );
  }

  /** Say once that a rectangle asked to cast while the array it would read is switched off. */
  private warnAreaShadowsOff(areaLights: readonly AreaLightSource[]): void {
    if (this.warnedAreaShadowsOff) return;
    const count = Math.min(areaLights.length, MAX_AREA_LIGHTS);
    for (let slot = 0; slot < count; slot++) {
      if (areaLights[slot]?.castsShadow !== true) continue;
      this.warnedAreaShadowsOff = true;
      console.warn(
        'Renderer: an area light declares castsShadow while RenderQuality.pointShadows is off. ' +
          'A rectangle reads its occlusion from the same array texture a point light does — ' +
          'WebGL2 guarantees sixteen texture units and the lit pass binds sixteen, so there is no ' +
          'second array to give it. Turn pointShadows on, or the rectangle lights through stone.',
      );
      return;
    }
  }

  /**
   * Per frame: bind the shading pass's exact light set, refresh any sampled map
   * whose source moved, and rebuild the live-caster map nearest the supplied
   * focus. A second live map exists only during its ownership crossfade.
   * Fixed-light world maps remain untouched.
   */
  updatePointShadows(
    lights: readonly ShadowLight[],
    activeWorldIndices: Int32Array,
    activeCount: number,
    liveX: number,
    liveY: number,
    liveZ: number,
    frameDt: number,
    staticCasters: ShadowCasters,
    dynamicCasters: ShadowCasters,
    /*
     * The nearest lights beyond the shaded ones, kept baked before they are wanted.
     * Optional so a consumer that has not been updated still behaves as before.
     */
    warmWorldIndices?: Int32Array,
    warmCount = 0,
    /**
     * The rectangles this frame shades, in the order `selectAreaLights` was given them.
     *
     * **The same list and the same order, which is what makes a slot mean one thing.** The lit
     * pass reads `uAreaShadow*[a]` at the slot it is shading, and those arrays are filled from this
     * list's position — so handing a different order here than to `selectAreaLights` puts one
     * fixture's shadow under another. Optional, so an existing caller is unchanged.
     *
     * Their bakes ride this call rather than one of their own because the budget, the casters and,
     * on the other backend, the encoder are all already here. See `AreaShadowSet.update`.
     */
    areaLights: readonly AreaLightSource[] = [],
  ): void {
    const pointShadows = this.pointShadows;
    if (pointShadows === null) {
      this.warnAreaShadowsOff(areaLights);
      return;
    }
    /*
     * **A bake into an array that does not exist spends the budget and draws nothing, silently.**
     *
     * `prepareStaticPointShadows` builds the octahedral array — `texStorage3D` is immutable, so it
     * is sized from the world's light count — and it is a separate call a consumer makes once.
     * Until 2026-08-25 forgetting it was completely quiet: this method ran, `selectCastingLights`
     * found lights, the bake budget was spent every frame, and no shadow appeared anywhere. It
     * cost an investigation that produced four confident eliminations, every one of them measuring
     * the missing call rather than the thing it was pointed at.
     *
     * Said once per renderer rather than once per frame, and it names the call to make: the whole
     * failure is that the picture is indistinguishable from a world whose lamps do not cast.
     */
    if (this.pointShadowArray === null) {
      if (!this.warnedNoPointShadowArray) {
        this.warnedNoPointShadowArray = true;
        console.warn(
          'Renderer: updatePointShadows was called before prepareStaticPointShadows, so there ' +
            'is no shadow array to bake into and no point light will cast. Call ' +
            'prepareStaticPointShadows(lights) once, after the lights exist.',
        );
      }
      return;
    }

    /*
     * A light that says it does not cast does not get a cubemap, wherever it came from.
     *
     * `selectPointLights` already leaves such a light out of the *eligible* list, and
     * that was taken for the whole of the promise — but the shaded set is a separate
     * list, a caller passes it here as the set to bind, and a light in it was given a
     * slot and baked whatever it had declared. So `castsShadow: false` held for a lamp
     * out of range and silently failed for the one standing in front of you, which is
     * the only one whose bake anybody would notice.
     *
     * It surfaced as a shadow with nothing to throw it: a lamp that rides the camera
     * declines to cast for exactly that reason, and cast anyway — an invisible object
     * throwing a visible shadow. Pulsing markers in the world are the same story one
     * step quieter: they declared it too, and the courtyard full of them that `castsShadow`
     * was written for was still baking them every frame.
     */
    const casting = selectCastingLights(
      lights,
      activeWorldIndices,
      activeCount,
      this.castingWorldIndices,
    );
    pointShadows.sync(this.castingWorldIndices, casting, warmWorldIndices, warmCount);
    pointShadows.updateLiveSelection(lights, liveX, liveY, liveZ, frameDt);
    /*
     * Before the bakes below, so an image that completes this frame is bound at no
     * presence at all and ramps from there. Advancing afterwards would give it a
     * frame's worth on the frame it lands, which is most of the pop on a slow frame.
     */
    pointShadows.advance(frameDt);

    /*
     * The whole round — staleness, the chronic demotion, the budget and the live pair — is
     * `runPointShadowBakes`, so the other backend spends its faces in the same order. Every
     * rule in it was bought with a measured frame; see that function.
     */
    runPointShadowBakes(
      pointShadows,
      lights,
      this.quality.pointShadowFacesPerFrame,
      this.quality.liveShadowFacesPerFrame,
      this.quality.pointShadowRebakeDistance,
      FACE_COUNT,
      this.bakeScratch,
      staticCasters,
      dynamicCasters,
      (map, light, casters, maxFaces) =>
        this.bakeOne(map, light, casters as ShadowCasters, maxFaces),
    );
    this.updateAreaShadows(areaLights, frameDt, staticCasters, dynamicCasters);
    this.restoreViewport();
  }

  /**
   * The rectangles' own round: their static layers under the same face budget, then their movers.
   *
   * **A separate allocation of the same two numbers rather than what the pool left over**, and the
   * reason is which failure each choice produces. Sharing one budget means a courtyard full of lamps
   * can starve a rectangle indefinitely, and a shadow that never arrives is worse than a shadow
   * that arrives late — the pool's own ordering rule says so. Allocating separately doubles the
   * worst case, and that worst case is bounded: `MAX_AREA_LIGHTS` is four against a pool of twenty,
   * and a fixture's static layer is baked once because a fixture does not move.
   *
   * Which leaves the recurring cost as the live layers alone: `liveShadowFacesPerFrame` shared
   * round-robin across the casting rectangles, of a handful of moving meshes each.
   */
  private updateAreaShadows(
    areaLights: readonly AreaLightSource[],
    frameDt: number,
    staticCasters: ShadowCasters,
    dynamicCasters: ShadowCasters,
  ): void {
    const set = this.areaShadows;
    if (set === null) return;
    /*
     * **A declaration that no longer matches is re-prepared here rather than trusted.** A layer is
     * fixed for the life of a map and the shader is told its index, so a rectangle that starts or
     * stops casting moves every layer after it — carrying on would publish one fixture's layer
     * under another, which is its shadow appearing under the wrong light. The array itself is only
     * resized by `prepareStaticPointShadows`, so this cannot grow it: a world that adds a casting
     * rectangle without re-preparing gets no layer for it rather than a layer that does not exist.
     */
    if (!set.matchesDeclaration(areaLights)) {
      const first = firstAreaShadowLayer(this.preparedPointLightCount);
      const layers = this.pointShadowArray?.layers ?? 0;
      if (first + areaShadowLayerCount(areaLights) <= layers) set.prepare(areaLights, first);
      else {
        if (areaShadowLayerCount(areaLights) > 0) this.warnAreaShadowLayers();
        if (set.castingCount > 0) set.release();
      }
    }
    set.update(
      areaLights,
      frameDt,
      this.quality.pointShadowFacesPerFrame,
      this.quality.liveShadowFacesPerFrame,
      this.quality.pointShadowRebakeDistance,
      FACE_COUNT,
      this.areaBakeScratch,
      staticCasters,
      dynamicCasters,
      (map, light, range, near, casters, maxFaces) =>
        this.bakeAreaOne(map, light, range, near, casters as ShadowCasters, maxFaces),
    );
    /*
     * Resolved once a frame here rather than per pass bind, because it needs the light *list* and
     * the binder only has the buffer. The point pool resolves at bind time for the opposite
     * reason: it already holds everything it needs.
     */
    set.resolve(areaLights, this.resolvedAreaShadows);
  }

  /**
   * Every point-shadow bake, under the one set of conventions all of them need.
   *
   * **It exists because the bracket was written on one of the two bake paths and not the other.**
   * A point-shadow face is rendered from a light matrix `depthConvention.ts` deliberately leaves
   * conventional, so the pass has to compare and clear conventionally too. `bakeAreaOne` did that;
   * `bakeOne` — the ordinary lamp, which is nearly every point shadow a scene has — ran under the
   * frame's own `GEQUAL` against a scratch cleared to 0, so every fragment won or lost the wrong
   * comparison. That does not look broken. It looks *shaded*, which is why it outlived nine
   * attempts at reversed depth and was only named by neutralising the term and watching the
   * backends agree.
   *
   * Both callers go through here now, and the state is set unconditionally: conventional depth is
   * already in this configuration, so there is no branch to forget.
   */
  private bakePointShadow(drawCasters: ShadowCasters, bake: () => number): number {
    const { gl } = this;
    this.pointShadowCasters = drawCasters;
    // `PointShadowMap.bake` disables culling for the faces it renders, so a
    // scatter batch inside it must not switch culling back on between them.
    this.depthPassCullsFaces = false;
    gl.depthFunc(glShadowDepthFunc(gl));
    gl.clearDepth(SHADOW_DEPTH_CLEAR);
    try {
      return bake();
    } finally {
      /* Back to the frame's sense, which `beginShadowPass` leaves the same way. */
      gl.depthFunc(glDepthFuncEqual(gl));
      gl.clearDepth(this.depthClear);
      this.pointShadowCasters = null;
      this.depthPassCullsFaces = true;
    }
  }

  /** Spend up to `maxFaces` on one rectangle's layer, from its centre. */
  private bakeAreaOne(
    map: PointShadowMap,
    light: AreaLightSource,
    range: number,
    near: number,
    drawCasters: ShadowCasters,
    maxFaces: number,
  ): number {
    const { gl } = this;
    /*
     * **`DEFAULT_SOURCE_RADIUS` rather than the rectangle's extent**, and it is the same argument
     * `AreaShadowSet.update` passes to `matchesSource` for the same reason: the emitter's size is
     * read by the *filter*, in the shader, and never by the bake. The two have to agree or the
     * map is stale on every frame it is checked — `pointShadowImage.ts` records that exact bug
     * from two readers disagreeing about this argument's default.
     */
    return this.bakePointShadow(drawCasters, () =>
      map.bake(
        gl,
        light.x,
        light.y,
        light.z,
        range,
        this.drawPointShadowFace,
        near,
        DEFAULT_SOURCE_RADIUS,
        maxFaces,
      ),
    );
  }

  /** Spend up to `maxFaces` on this map, returning how many it used. */
  private bakeOne(
    map: PointShadowMap,
    light: ShadowLight,
    drawCasters: ShadowCasters,
    maxFaces: number,
  ): number {
    const { gl } = this;
    return this.bakePointShadow(drawCasters, () =>
      map.bake(
        gl,
        light.x,
        light.y,
        light.z,
        light.radius,
        this.drawPointShadowFace,
        light.shadowNear,
        light.sourceRadius,
        maxFaces,
      ),
    );
  }

  /**
   * Draw into a rectangle of the canvas, on its own terms.
   *
   * For a *portrait*: a character preview standing in a box on a menu, lit and framed by
   * whatever the caller wants, with nothing of the world in it. The scissor is what makes
   * that true — the clear only touches the box, so the frame already drawn survives around
   * it, and only the meshes the caller issues appear inside.
   *
   * Kept as a pair of calls rather than a callback so the caller's draw sequence reads the
   * same inside a box as outside one: `beginInset`, bind a pass, draw meshes, `endInset`.
   * It returns the **aspect** of the rectangle it set up, for the camera that will fill it.
   *
   * The rectangle is in **CSS pixels with the DOM's top-left origin** — a `DOMRect`, in
   * other words, which is what a caller actually has. The first version took GL's own
   * convention and left the caller to scale by the device pixel ratio and flip the y axis;
   * that is arithmetic about *this* object's canvas, so it belongs here. A caller doing it
   * has two chances to be wrong about somebody else's state, and on a high-DPI screen the
   * mistake is a box in the wrong place at the wrong size.
   *
   * **`clearColor: null` keeps the picture and clears only depth**, which is the
   * difference between an object *in* the frame and an object in a box cut out of it.
   * A backdrop is right for a preview inside a panel, where the box is furniture and a
   * dark case is what makes a small object read. It is wrong the moment the same inset
   * is used over a live frame: the caller gets a filled rectangle pasted onto the
   * picture, whatever colour it picks, because any colour that is not the scene is a
   * rectangle. Depth alone still puts the meshes in front of everything already drawn
   * inside the box, which is what a caller compositing over its own frame wants.
   */
  beginInset(rect: InsetRect, clearColor: Vec3 | null): number {
    const { gl } = this;
    const cssWidth = Math.max(this.canvas.clientWidth, 1);
    const cssHeight = Math.max(this.canvas.clientHeight, 1);
    /*
     * Canvas-relative, not viewport-relative. A `DOMRect` is measured from the viewport and
     * the canvas is not obliged to fill it — the difference is silent and looks like a box
     * drawn in the wrong place, which is the hardest kind of mistake to attribute.
     */
    const origin = this.canvas.getBoundingClientRect();
    // The renderer owns the canvas, so it is the only thing that should be doing this
    // arithmetic: a caller converting CSS pixels into drawing-buffer pixels *and* flipping
    // the origin is a caller with two chances to be wrong about somebody else's state.
    const scaleX = this.canvas.width / cssWidth;
    const scaleY = this.canvas.height / cssHeight;
    const left = rect.left - origin.left;
    const top = rect.top - origin.top;
    const w = Math.max(1, Math.round(rect.width * scaleX));
    const h = Math.max(1, Math.round(rect.height * scaleY));
    const x = Math.round(left * scaleX);
    const y = Math.round((cssHeight - top - rect.height) * scaleY);

    gl.viewport(x, y, w, h);
    gl.enable(gl.SCISSOR_TEST);
    gl.scissor(x, y, w, h);
    if (clearColor === null) {
      // Depth only. The frame behind survives, so what is drawn next sits over the
      // scene rather than over a rectangle of flat colour.
      gl.clear(gl.DEPTH_BUFFER_BIT);
    } else {
      gl.clearColor(clearColor[0], clearColor[1], clearColor[2], 1);
      gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    }
    /*
     * The aspect of the pixels the viewport *actually* got, returned rather than left for
     * the caller to work out again. Two calculations of one number is how a camera ends up
     * composing for a rectangle that does not exist, and the rounding above means the CSS
     * ratio and this one are not always identical.
     */
    return w / h;
  }

  /**
   * Hand a rectangle of the frame to a 2D canvas, at its own pixel size.
   *
   * For content that has to appear *in front of* the page rather than behind it. The
   * menu's panels carry `backdrop-filter: blur(6px)`, so anything drawn into the canvas
   * underneath a panel — including an inset in a hole cut through one — is shown blurred,
   * by design: the world behind a menu is meant to be out of focus. A character preview
   * shown through that hole inherits the blur along with everything else.
   *
   * A copy is what escapes it. The pixels become an ordinary image inside a DOM element,
   * so the blur has nothing to do with them. It is one `drawImage` of a few tens of
   * thousands of pixels, GPU-side, which is cheaper than any of the alternatives — a second
   * WebGL context, or a mask cut out of the blurring layer and kept in step with the
   * element it is hiding.
   *
   * **Must be called in the same task as the draw.** A WebGL drawing buffer is only
   * guaranteed readable until the page composites; afterwards this copies black. That is
   * the same rule the still export learned the hard way.
   */
  copyRegionTo(rect: InsetRect, target: HTMLCanvasElement): void {
    const origin = this.canvas.getBoundingClientRect();
    const scaleX = this.canvas.width / Math.max(this.canvas.clientWidth, 1);
    const scaleY = this.canvas.height / Math.max(this.canvas.clientHeight, 1);
    const sw = Math.max(1, Math.round(rect.width * scaleX));
    const sh = Math.max(1, Math.round(rect.height * scaleY));
    // Sized to the source, so the copy is pixel-for-pixel and never resampled. Written
    // only when it changes: assigning width or height clears the canvas.
    if (target.width !== sw || target.height !== sh) {
      target.width = sw;
      target.height = sh;
    }
    const ctx = target.getContext('2d');
    if (ctx === null) return;
    ctx.drawImage(
      this.canvas,
      Math.round((rect.left - origin.left) * scaleX),
      Math.round((rect.top - origin.top) * scaleY),
      sw,
      sh,
      0,
      0,
      sw,
      sh,
    );
  }

  /**
   * Fill a rectangle of the frame with one flat colour, blended.
   *
   * The plain surface an overlay is read against. Neither of the two things that
   * could nearly do this actually can: `beginInset` *clears*, so it is opaque by
   * definition, and `TextRenderer.setPlate` builds its rectangle from one lit cube
   * per cell — correct for a keycap and a grid of seams at panel size.
   *
   * `rect` is in CSS pixels from the top-left of the **canvas** — `cssWidth` and
   * `cssHeight`'s space, which is what an overlay laying itself out already has.
   * Deliberately *not* `beginInset`'s viewport-relative `DOMRect`: that one takes
   * what its callers hold, which is a measured DOM element, and this one takes what
   * its callers hold, which is a rectangle they computed against the frame. The two
   * spaces differ exactly when the canvas does not fill the window — a letterboxed
   * export — so a single convention would be silently wrong on one side or the
   * other in the case that matters most.
   *
   * Depth-test off and depth writes off: this is furniture drawn over a finished
   * frame, and it must neither be occluded by the scene nor occlude what is drawn
   * after it.
   */
  fillPanel(rect: InsetRect, color: Vec3, alpha: number): void {
    if (alpha <= 0 || rect.width <= 0 || rect.height <= 0) return;
    /* Counted against no ceiling: the other backend refuses past its own, and a consumer here
       should be able to see that coming. See `budget.ts`. */
    this.panelBudget.ask();
    const { gl } = this;

    gl.useProgram(this.panelProgram);
    gl.bindVertexArray(this.panelVao);
    gl.disable(gl.DEPTH_TEST);
    gl.depthMask(false);
    /*
     * And culling, which is on for the life of the renderer because the world is
     * solid. A screen-space quad has no meaningful facing, and the y flip into clip
     * space reverses its winding — so with culling left on this draws nothing at
     * all, silently and with no GL error.
     */
    gl.disable(gl.CULL_FACE);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);

    gl.uniform4f(this.panelUniforms['uRect'] ?? null, rect.left, rect.top, rect.width, rect.height);
    gl.uniform2f(
      this.panelUniforms['uViewport'] ?? null,
      Math.max(this.canvas.clientWidth, 1),
      Math.max(this.canvas.clientHeight, 1),
    );
    /* Identity: this backend's clip space is the one the shader was written against. */
    gl.uniformMatrix4fv(this.panelUniforms['uClipCorrection'] ?? null, false, IDENTITY_MAT4);
    gl.uniform3fv(this.panelUniforms['uColor'] ?? null, color);
    gl.uniform1f(this.panelUniforms['uAlpha'] ?? null, alpha);

    gl.drawArrays(gl.TRIANGLES, 0, 6);

    gl.bindVertexArray(null);
    gl.depthMask(true);
    gl.enable(gl.DEPTH_TEST);
    gl.enable(gl.CULL_FACE);
  }

  /** Give the whole canvas back. Safe to call without a matching `beginInset`. */
  endInset(): void {
    if (this.contextLost) return;
    const { gl } = this;
    gl.disable(gl.SCISSOR_TEST);
    this.restoreViewport();
  }

  /**
   * How much speed blur the frame about to be drawn should resolve with, 0 to 1.
   *
   * Set before `beginFrame`, held until changed, and ignored entirely when screen effects
   * are off. A *renderer* parameter rather than a scene one: it describes how the finished
   * image is presented, not anything in the world, which is why nothing about the world has
   * to know it exists.
   */
  setSpeedRush(strength: number): void {
    this.rushStrength = Math.min(Math.max(strength, 0), 1);
  }

  /**
   * How much of the frame's camera motion blur to apply, 0 to 1. Scales `cameraMotionBlur`.
   *
   * **A ceiling and a dial, rather than one number.** `cameraMotionBlur` is
   * construction-time because it decides whether the pass exists at all; this decides how
   * much of it a given frame wants, and a frame is exactly the granularity that matters.
   * Blur that is always on is not a speed cue, it is a filter: a viewer stops reading it
   * within seconds, and it costs eight taps on every moving pixel while doing so. Reported
   * from play, twice, by two different people, one of whom turned the setting off inside a
   * minute.
   *
   * So a caller ramps it with whatever "fast" means in its world. 1 keeps what a scene
   * written before this got, so nothing changes for anyone who does not call it.
   *
   * Set before `beginFrame` and held until changed, like `setSpeedRush`, which it sits
   * beside for the same reason: both describe how the finished image is presented rather
   * than anything in the world.
   */
  setCameraMotionBlur(scale: number): void {
    this.motionBlurScale = Math.min(Math.max(scale, 0), 1);
  }

  /**
   * Where this frame's lens is focused, how deep the sharp zone is, and how much of the ceiling
   * to take.
   *
   * **The ceiling-and-dial split `setCameraMotionBlur` argues for, with a third number that is
   * neither.** `depthOfField` is construction-time and decides how far a defocused point may
   * spread, which is what the effect *costs*; `scale` decides how much of that this frame wants,
   * so 0 turns it off for a moment without paying for it. `distance` and `range` are not a
   * fraction of anything — they are where the camera is looking, in metres, and a caller changes
   * them when the subject moves.
   *
   * **Racking focus is the caller's, and that is the same boundary `setOutputExposure` draws.** A
   * game knows what its camera is looking at; the renderer could only find out by reading a depth
   * sample back a frame late. Easing `distance` toward a target is two lines wherever that state
   * already lives, and the clock belongs to the caller in this engine.
   *
   * `range` is clamped above zero because it is the divisor of the ramp: at zero, every pixel not
   * exactly on the plane would be at full blur, which is a different effect and not one anybody
   * asked for.
   *
   * Set before `beginFrame` and held until changed, like `setSpeedRush` and
   * `setCameraMotionBlur` beside it. Ignored entirely when `depthOfField` is 0.
   */
  setDepthOfField(distance: number, range: number, scale = 1): void {
    this.focusDistance = Number.isFinite(distance) ? Math.max(distance, 0) : 0;
    this.focusRange = Number.isFinite(range) ? Math.max(range, 1e-3) : 1e-3;
    this.dofScale = Math.min(Math.max(scale, 0), 1);
  }

  /** Where the lens is focused and how deep the sharp zone is, in metres. See `setDepthOfField`. */
  private focusDistance = 0;
  private focusRange = 1;
  /** How much of `depthOfField` this frame takes. See `setDepthOfField`. */
  private dofScale = 1;
  /** The inverse projection, and the four elements of it a depth-to-distance needs. */
  private readonly dofInvProjection = new Float32Array(16);
  private readonly dofDepthToView = new Float32Array(4);

  /**
   * How much of the frame's bloom to apply, 0 to 1. **Scales** `bloom`, like
   * `setCameraMotionBlur` scales `cameraMotionBlur`.
   *
   * A scale rather than a replacement, and the distinction is worth being explicit about
   * because the setter beside this one — `setOutputExposure` — is the other kind. A grade has
   * no natural full value to take a fraction of, so exposure replaces. A strength does: how
   * much a world blooms is that world's look, decided once, and what a frame gets to say is
   * how much of it this moment wants. So `bloom: 0.4` with `setBloom(0.5)` is 0.2, and a
   * caller that never calls this keeps exactly what it asked for at construction.
   *
   * That is also what keeps a quality profile meaningful: a part that cannot afford the effect
   * has it capped in one place rather than in every frame that sets a dial.
   *
   * Set before `beginFrame` and held until changed. Ignored entirely when `bloom` is 0, since
   * the chain is never built.
   */
  setBloom(scale: number): void {
    this.bloomScale = Math.min(Math.max(scale, 0), 1);
  }

  /**
   * How thick the air is, this frame: a global participating medium filling the whole frustum.
   *
   * **The dial beside `globalMediumSteps`' ceiling**, on the split every other effect here uses.
   * The profile says what a march may cost, and this says what the weather is doing — so a game
   * can walk into a fog bank without the settings screen changing under it, and a device that
   * cannot afford a medium never draws one however thick the game says the air is.
   *
   * `density` is extinction per metre and **0 is a real off**: no target is allocated, no march
   * runs and no composite is drawn, so a frame at 0 is identical to a build with the feature
   * absent rather than merely close to it. Everything else is optional and holds until changed:
   * `albedo` is how much of what the air takes out comes back as light, `anisotropy` is the
   * Henyey-Greenstein g that makes haze glow toward a low sun, and `maxDistance` is where the
   * search for light to scatter stops — not where the fog stops, which is what extinction says.
   *
   * This is the air, not a beam. `drawLightVolume` is a shaft somebody placed inside a hull;
   * this is everything between the camera and whatever the frame already drew, and it is the one
   * of the two that can put the shape of a doorway on a floor.
   */
  setGlobalMedium(
    density: number,
    albedo?: number,
    anisotropy?: number,
    maxDistance?: number,
  ): void {
    this.mediumOptions = resolveGlobalMedium({
      density: Number.isFinite(density) ? density : 0,
      albedo,
      anisotropy,
      maxDistance,
    });
  }

  /** This frame's medium. Off until a caller says otherwise. See `setGlobalMedium`. */
  private mediumOptions: GlobalMediumOptions = DEFAULT_GLOBAL_MEDIUM;
  /** Built on the first frame that asks for a medium, and never on one that does not. */
  private medium: GlobalMediumPass | null = null;

  /**
   * How far this frame's scene is scaled into the tone curve. Replaces `outputExposure`.
   *
   * **The same ceiling-and-dial split as `setCameraMotionBlur`, for the same reason.**
   * `outputExposure` is construction-time and is a *grade*: it says how this world's light
   * levels are meant to sit in the curve. What it cannot express is that one scene has both a
   * lit showroom and a dark interior in it, which is where a single exposure is wrong twice —
   * blown out in the room and unreadable inside. So a frame gets to say what it wants, and a
   * caller that never says anything keeps the grade it asked for at construction.
   *
   * **Adaptation is the caller's, and that is a deliberate boundary rather than a shortcut.**
   * A game knows it walked into a cave; the renderer can only find out by measuring pixels a
   * frame late. Easing toward a target is two lines wherever the state already lives, and the
   * clock belongs to the caller in this engine — see the determinism rules. What the engine
   * *could* add on top, and has not, is the measurement half: a mip of the scene target read as
   * an average luminance and smoothed in a 1x1 ping-pong, so a scene that cannot say what it is
   * looking at gets a number anyway. RENDERING.md §4 has that written down as what is left.
   *
   * Ignored unless `outputTransform` is `aces`, because there is no curve to be exposed into
   * otherwise. Clamped above zero: a zero exposure is a black frame, and a negative one is a
   * black frame with a sign error in it.
   */
  setOutputExposure(exposure: number): void {
    this.exposure = Number.isFinite(exposure)
      ? Math.max(exposure, 1e-3)
      : this.quality.outputExposure;
  }

  /**
   * Composite a flat colour over the finished frame — for a cut dipping to white or to black.
   *
   * `alpha` 0 leaves the picture untouched and is the default; 1 replaces it outright. Nothing
   * else on this renderer can reach either end: `setOutputExposure`'s own guard clamps above
   * zero, so black is unreachable by design, and white is not an exposure at all under `aces`,
   * which is built to roll off rather than clip — driving exposure up gives a bloomed, tinted,
   * still-legible frame, which is a different effect and a nice one. A veil is the operation
   * that gap was missing, not a knob left unturned on an existing one.
   *
   * **Composited after the tone map, before grain and vignette. That is a ruling, not a
   * measurement, and it is written out here because a caller reading this is exactly who needs
   * it.**
   *
   * After the tone map, because a transition has to hit exact black and exact white
   * deterministically: `setFrameVeil(0, 0, 0, 1)` must be pure black and
   * `setFrameVeil(1, 1, 1, 1)` pure white. Compositing before a curve built to roll off makes
   * "full white" an asymptote no caller could solve for — the same trap `setOutputExposure` is
   * already in, and this must not be that.
   *
   * Before grain and vignette, because that is the complaint this replaces: painted on top of
   * an already-finished frame, a dip to black flattens grain and a vignette instead of taking
   * them down with it, which reads as a sheet laid over the picture rather than the picture
   * going dark. Composited here, ahead of anything that still runs after the grade, a dip fades
   * the whole image together.
   *
   * This also answers the bloom question by construction rather than by choice: bloom is
   * resolved upstream of this pass, from the pre-tonemap scene — see `SceneTarget.resolve` —
   * so a veil composited here never feeds it. That is the right side of its own framing: a dip
   * is a cut rather than a light, and a veil that bloomed would mean dipping to white lit the
   * whole frame instead of covering it.
   *
   * **Cleared with the frame, unlike `setSpeedRush` and `setCameraMotionBlur` beside it: one
   * call per frame, and a frame that does not call it draws with no veil at all**, rather than
   * inheriting whatever the last cut left behind. A transition that forgets to turn itself off
   * is a worse failure than one that forgets to turn on, which is why this resets in `endFrame`
   * where those two are held until changed.
   *
   * Costs nothing at zero: the shader's `withVeil` is a single comparison that hands the pixel
   * back unmixed, and nothing extra is allocated on the CPU side to reach it.
   */
  setFrameVeil(r: number, g: number, b: number, alpha: number): void {
    this.veilColor[0] = Math.min(Math.max(r, 0), 1);
    this.veilColor[1] = Math.min(Math.max(g, 0), 1);
    this.veilColor[2] = Math.min(Math.max(b, 0), 1);
    this.veilAlpha = Math.min(Math.max(alpha, 0), 1);
  }

  /**
   * The colour grade this and every later frame applies, until it is set again.
   *
   * A lookup table over **display** values, applied after the tone curve and before the veil —
   * `colourGrade.ts` argues both placements and `uGradeLut`'s own comment in `rush.ts` states
   * them. Held rather than per-frame, so a consumer sets it once; the table is uploaded only
   * when the object it was given changes, which makes calling this from a frame loop free.
   *
   * **It needs `screenEffects`, and says so rather than doing nothing.** Without a composite
   * every forward pass is the last thing to touch the frame and grades itself, so there is no
   * single place a look could be applied — the same rule and the same words `hdrScene` already
   * carries. A silent no-op here would be a consumer wondering why their grade does not apply,
   * which is precisely the failure this engine's rules exist to prevent. Once per renderer,
   * because a consumer setting a grade every frame would otherwise flood a console.
   */
  setColourGrade(lut: ColourGradeLut | null, strength = 1): void {
    if (this.sceneTarget === null) {
      if (lut !== null && !this.warnedGradeWithoutComposite) {
        this.warnedGradeWithoutComposite = true;
        console.warn(
          '[driftengine] setColourGrade needs `screenEffects`: without a composite every pass ' +
            'is the last thing to touch the frame and grades itself, so there is nowhere to ' +
            'apply a look once. The grade was not applied.',
        );
      }
      return;
    }
    this.sceneTarget.setColourGrade(lut, strength);
  }

  /**
   * What this frame asked for. **Every ceiling here is `null`, and that is the finding.**
   *
   * This backend imposes no per-frame limit on anything: it sets uniforms per draw and has no
   * ring to run out of, so it draws whatever it is handed. WebGPU holds thirteen ceilings and
   * skips the work past any of them. The same scene therefore renders differently on the two
   * backends with nothing failing anywhere, and a developer working here — which is where most
   * development happens, because it is the fallback that runs everywhere — cannot see a WebGPU
   * ceiling approaching.
   *
   * Reporting the count with an honest `null` is what makes that visible: a consumer reads the
   * same line name on both, compares its own number against the ceiling the other backend
   * publishes, and finds out before a player does rather than after.
   */
  private readonly budget = new FrameBudget();
  private readonly drawBudget = this.budget.line('draws', null);
  /**
   * Every line the other backend declares, in its order and with none of its ceilings.
   *
   * **Counted after the same guards**, so one scene reports one number on both: the verbs each
   * ask once they are past the checks that make them draw nothing on either backend — a panel
   * with no alpha, a string with no glyphs, a beam with no strength, a calm wind — and a material
   * change is counted by the rule both share (`materialChanges.ts`). `webgpu/renderer.test.ts`
   * runs one scene through both and compares every line.
   */
  private readonly materialBudget = this.budget.line('materials', null);
  /** Whether the next mesh draw shares the open material or opens one, by the rule both count. */
  private readonly materials = new MaterialChanges();

  /** A mesh draw: counted as a material change when something has changed the material since. */
  private takeMaterial(): void {
    if (this.materials.open) return;
    this.materialBudget.ask();
    this.materials.slot = 0;
  }
  /**
   * Declared here and never asked, because this backend builds none.
   *
   * A bind group is a WebGPU object; the equivalent here is loose uniform and sampler calls, which
   * are not a thing that is created and cached and so not a thing that can leak. Reporting a
   * standing zero rather than omitting the line is the same argument the `draws` line above makes
   * in the other direction: a consumer comparing the two backends reads one name on both, and a
   * line that is absent on one is a line no cross-backend check can compare. The number it is
   * being compared against should also be zero once the other backend's cache is warm.
   */
  private readonly bindGroupBudget = this.budget.line('bind groups', null);
  private readonly shadowDrawBudget = this.budget.line('shadow draws', null);
  private readonly scatterDepthBudget = this.budget.line('scatter shadow draws', null);
  private readonly waterBudget = this.budget.line('water bodies', null);
  private readonly lightVolumeBudget = this.budget.line('light volumes', null);
  private readonly windStreakBudget = this.budget.line('wind streak fields', null);
  private readonly flockBudget = this.budget.line('flocks', null);
  private readonly boltBudget = this.budget.line('bolt batches', null);
  private readonly causticsBudget = this.budget.line('caustics', null);
  private readonly textBudget = this.budget.line('text draws', null);
  private readonly sdfTextBudget = this.budget.line('sdf text draws', null);
  private readonly lineBudget = this.budget.line('line draws', null);
  /** The other backend's panel ceiling, reported here as a count with none. */
  private readonly panelBudget = this.budget.line('panels', null);

  /** What the frame just drawn asked for. See `budget.ts`, and the note on `budget` above. */
  get frameBudget(): FrameBudget {
    return this.budget;
  }

  /**
   * Mark whatever the depth buffer holds inside a projector's box.
   *
   * **The drawn half of decals, and `projectDecal` is the other.** That one clips the receiving
   * surface's triangles once and hands back a mesh, which is cheaper every frame and exact — and
   * which cannot follow a surface that deforms or streams in afterwards. This decides the mark
   * from the frame's own depth instead, so the receiver may be a skinned mesh, a heightfield being
   * rewritten, an instanced crowd, or geometry that arrived after the mark was placed.
   *
   * **The mark multiplies.** A forward renderer has no G-buffer, so the pixel is already lit by
   * the time this runs: multiplying takes the receiver's lighting exactly, at the cost that a mark
   * can darken and tint and never brighten. `decalProjector.ts` argues that at length.
   *
   * Recorded here and drawn in `endFrame`, before the frame is composited, so the post chain sees
   * the mark. Silently nothing where the profile has no screen effects, since there is then no
   * depth to read: the same rule `hdrScene` and `orderIndependent` carry.
   */
  drawDecal(projector: DecalProjector): void {
    if (this.contextLost) return;
    this.decalQueue.record(projector);
  }

  /**
   * Reflect what the frame drew, in the surfaces inside a box.
   *
   * **What a planar reflection cannot reach.** `beginPlanarReflection` re-renders the world from a
   * mirrored camera for one horizontal plane at one height, which is exactly right for a lake and
   * gives nothing for a floor that undulates, a bonnet or a tilted pane — and it costs a second
   * pass over the scene. This costs one scissored fullscreen pass per surface, follows the surface
   * per pixel whatever shape it is, and is exact where an object meets the floor.
   *
   * **It can only reflect what is on screen.** Anything behind the camera or hidden behind the
   * reflecting surface is not in the colour buffer and cannot be recovered from it; the fades in
   * `screenSpaceReflection.ts` are what keep that from being an obvious limit rather than a
   * pretence that it is not one.
   *
   * Recorded here and traced in `endFrame`, after the decals so a mark appears in the reflection
   * and before the translucent resolve so a pane of glass is drawn over it. Needs `screenEffects`,
   * and says so once where there is none.
   */
  drawReflection(surface: ReflectiveSurface): void {
    if (this.contextLost) return;
    this.reflectionQueue.record(surface);
  }

  /** Said once, not per frame, where this renderer cannot read the picture a march samples. */
  private refuseReflections(): void {
    if (this.reflectionsRefused) return;
    this.reflectionsRefused = true;
    console.warn(
      "driftengine: a screen-space reflection marches against the scene target's own colour and " +
        'depth, and this renderer has neither to read — so surfaces submitted to drawReflection ' +
        'are dropped. `screenEffects` is what turns the target on, and multisampling excludes it: ' +
        'a multisampled attachment is not a texture until it has been resolved.',
    );
  }

  /** Said once, not per frame, where a medium was asked for and there is no depth to march against. */
  private refuseMedium(): void {
    if (this.mediumRefused) return;
    this.mediumRefused = true;
    console.warn(
      "driftengine: a global medium marches against the scene target's own depth, and this " +
        'renderer has none to read — so setGlobalMedium draws nothing. `screenEffects` is what ' +
        'turns the target on, and multisampling excludes it: a multisampled attachment is not a ' +
        'texture until it has been resolved.',
    );
  }
  private mediumRefused = false;

  /** Said once, not per frame, where this renderer cannot read the depth a mark is decided from. */
  private refuseDecals(): void {
    if (this.decalsRefused) return;
    this.decalsRefused = true;
    console.warn(
      "driftengine: a drawn decal is read out of the scene target's depth, and this renderer " +
        'has none to read — so marks submitted to drawDecal are dropped. `screenEffects` is what ' +
        'turns the target on, and `projectDecal` needs no target at all.',
    );
  }

  /**
   * Said once, not per frame, where multisampling excludes the effect a profile asked for.
   *
   * **A refusal rather than a silent sort, and the reason is who is on the other side of it.** The
   * two are both switches on a graphics screen, so a player turning antialiasing on turns this off
   * — and a quality setting that is enabled and does nothing is the fault `capabilityClamp` and
   * the bloom warning in the constructor exist to prevent. The other backend refuses the same
   * profile from the same constant, which is what stops the two compositing different pictures
   * from one `RenderQuality` — see `OIT_MULTISAMPLE_REFUSAL` for why it is a constant and not two
   * literals kept in step by hand.
   */
  /** Said once rather than every frame, as the translucent set's own refusal is. */
  private indirectLightRefused = false;

  private refuseOitMultisampled(): void {
    if (this.oitMultisampleRefused) return;
    this.oitMultisampleRefused = true;
    console.warn(OIT_MULTISAMPLE_REFUSAL);
  }

  beginFrame(clearColor: Vec3): void {
    if (this.contextLost) return;
    this.budget.reset();
    this.materials.dirty();
    /*
     * Said once, for the reason `refuseOitMultisampled` gives: a quality setting that is enabled
     * and does nothing is the fault the capability clamp exists to prevent.
     */
    if (this.quality.indirectLight && !this.indirectLightRefused) {
      this.indirectLightRefused = true;
      console.warn(INDIRECT_LIGHT_WEBGL2_REFUSAL);
    }

    const { gl } = this;
    this.reflectionReadyThisFrame = false;
    /*
     * Passes that own a target fill it here, with the default framebuffer bound and before the
     * scene target takes it. See `PassDefinition.prepare`: this is the one fixed point, and it is
     * before the line below rather than after it precisely so the contract can be stated as
     * "the default framebuffer is bound".
     */
    this.runPreparePasses();
    // The scene lands off-screen when there is somewhere to put it, so `endFrame` has a
    // finished image to sample. Sized from the drawing buffer, so an export lock and a
    // resize both land exactly.
    this.framePresented = false;

    /*
     * **Decided here and held for the frame**, so a draw cannot be recorded by one rule and
     * replayed under another. It needs the off-screen target, since the resolve composites over
     * the finished scene, and it needs a float colour buffer, since the accumulation is a sum
     * whose weight reaches three thousand — eight bits of that is white everywhere.
     *
     * **And it excludes multisampling, which is the same line the other backend carries.** Both
     * passes attach `depthAttachment()` and depth-test against it, and above one sample that
     * texture is not what the frame is being drawn into: `ensureSize` attaches `msaaDepth`, a
     * renderbuffer, and the texture is written only by the depth blit at the end of `resolve` —
     * which itself runs only when something else asked for depth, so with occlusion, motion blur
     * and depth of field all off it never runs at all. Without this the two passes reject a pane
     * against the previous frame's depth, or against a texture the frame has never written.
     * `colorAttachment()` guards the colour half of exactly this and says so in the same words.
     */
    this.translucentQueue.reset();
    this.decalQueue.reset();
    this.reflectionQueue.reset();
    this.oitActive = false;
    if (this.quality.orderIndependent && this.sceneTarget !== null) {
      if (this.sceneTarget.sampleCount > 1) {
        this.refuseOitMultisampled();
      } else {
        this.oit ??= new OitPass(gl);
        if (this.oit.available) {
          this.oitActive = true;
        } else if (!this.oitRefused) {
          this.oitRefused = true;
          console.warn(
            'driftengine: order-independent transparency needs a float colour buffer and this ' +
              'context has no EXT_color_buffer_float, so translucent draws stay sorted and blended.',
          );
        }
      }
    }

    this.sceneTarget?.begin(this.canvas.width, this.canvas.height);
    gl.clearColor(clearColor[0], clearColor[1], clearColor[2], 1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
  }

  /**
   * Present the frame.
   *
   * Called at the very end of a render pass, and **always resolves to the canvas** — a
   * frame recorder reads the canvas to build a clip and a still is a canvas copy, so a
   * scene left in a framebuffer would export black while the screen looked right. A no-op
   * when screen effects are off, so a caller may call it unconditionally.
   */
  endFrame(): void {
    if (this.contextLost) return;

    /*
     * Camera motion blur, built from the camera the frame was *rendered* with.
     *
     * Not from the simulation step, and the difference is the whole trap: a velocity taken
     * from the fixed 1/60 tick makes the blur pulse at 60 Hz against a display running at
     * any other rate, which reads as a stutter and gets blamed on frame pacing. What is
     * multiplied here is the matrix `bindMeshPass` was handed, interpolation included.
     *
     * The first frame has no previous camera, so it blurs nothing rather than reprojecting
     * through an identity and smearing the whole image toward a corner.
     */
    const view = this.frameViewProj;
    const blur = this.quality.cameraMotionBlur * this.motionBlurScale;
    let motion: { reprojection: Float32Array; strength: number; max: number } | undefined;
    let temporal: { reprojection: Float32Array; blend: number } | undefined;
    /*
     * **Both effects want the same one matrix**, so it is built once when either asks. The
     * reprojection was previously kept only while the blur was on, which is why this reads as it
     * does now: a consumer running temporal antialiasing without motion blur would otherwise
     * reproject through a `previousViewProj` that had never been written.
     */
    const wantsReprojection = blur > 0 || this.temporalJittering;
    if (wantsReprojection && view !== null) {
      if (this.hasPreviousView) {
        mat4.invert(this.reprojection, view);
        mat4.multiply(this.reprojection, this.previousViewProj, this.reprojection);
        if (blur > 0) {
          motion = {
            reprojection: this.reprojection as Float32Array,
            strength: blur,
            max: MOTION_BLUR_MAX_UV,
          };
        }
      }
      mat4.copy(this.previousViewProj, view);
      this.hasPreviousView = true;
    }
    if (this.temporalJittering) {
      /*
       * A blend of zero is what the first frame, a resize and a cut all pass, and the shader takes
       * its early exit on it — so this is present every jittered frame rather than absent on some,
       * and the pass still runs and fills the history for the next one.
       */
      temporal = {
        reprojection: this.reprojection as Float32Array,
        blend: this.temporalHistoryUsable ? TEMPORAL_HISTORY_BLEND : 0,
      };
    }

    /*
     * Ambient occlusion, from the projection the frame was drawn with.
     *
     * Nothing is uploaded when the strength is zero, so a renderer that was not asked for
     * occlusion does not invert a matrix per frame to describe an effect that is off.
     *
     * The projection is null until the first `bindMeshPass`, which is the honest guard: a
     * frame with no mesh pass has no camera, and occlusion built on an identity projection
     * would sample the depth of a scene nobody drew.
     */
    const aoStrength = this.quality.ambientOcclusion;
    const projection = this.frameProjection;
    let ao:
      | {
          strength: number;
          radius: number;
          projScale: Float32Array;
          invProjection: Float32Array;
        }
      | undefined;
    if (aoStrength > 0 && projection !== null) {
      mat4.invert(this.aoInvProjection, projection);
      /* Column major, so `[0][0]` is element 0 and `[1][1]` is element 5. Together they are
         the field of view and the aspect, which is all the shader needs to turn a radius in
         metres into a radius in UV. */
      this.aoProjScale[0] = projection[0] ?? 1;
      this.aoProjScale[1] = projection[5] ?? 1;
      ao = {
        strength: aoStrength,
        radius: this.quality.ambientOcclusionRadius,
        projScale: this.aoProjScale,
        invProjection: this.aoInvProjection as Float32Array,
      };
    }

    /*
     * Bloom, whose ceiling decides whether the chain exists at all and whose dial decides how
     * much of it this frame takes. Nothing is passed when the product is zero, so a renderer
     * that was not asked for bloom never builds the targets, and one that was may still turn
     * the effect off for a frame without paying for it.
     */
    const bloomStrength = this.quality.bloom * this.bloomScale;
    const bloom =
      bloomStrength > 0
        ? { strength: bloomStrength, threshold: this.quality.bloomThreshold }
        : undefined;

    /* The grade travels to the resolve only where the mesh pass gave it up. See `bindMeshPass`. */
    const lateGrade = this.quality.hdrScene
      ? { transform: OUTPUT_TRANSFORM_CODE[this.quality.outputTransform], exposure: this.exposure }
      : { transform: 0, exposure: 1 };
    /*
     * Depth of field, on the same ceiling-and-dial split as bloom above: `depthOfField` decides
     * how far a defocused point may spread and this frame's `setDepthOfField` decides where the
     * lens is and how much of that ceiling it takes. Nothing is passed at zero, so a renderer
     * nobody asked for it never resolves a depth buffer to feed it.
     */
    const dofStrength = this.quality.depthOfField * this.dofScale;
    let dof:
      | {
          distance: number;
          range: number;
          strength: number;
          depthToView: Float32Array;
        }
      | undefined;
    if (dofStrength > 0 && projection !== null) {
      mat4.invert(this.dofInvProjection, projection);
      /* Column major: 10 and 14 are M[2][2] and M[2][3], 11 and 15 are M[3][2] and M[3][3] —
         the only four elements a depth-to-view-distance needs. See `uDepthToView`. */
      this.dofDepthToView[0] = this.dofInvProjection[10] ?? 0;
      this.dofDepthToView[1] = this.dofInvProjection[14] ?? 0;
      this.dofDepthToView[2] = this.dofInvProjection[11] ?? 0;
      this.dofDepthToView[3] = this.dofInvProjection[15] ?? 1;
      dof = {
        distance: this.focusDistance,
        range: this.focusRange,
        strength: dofStrength,
        depthToView: this.dofDepthToView,
      };
    }
    /*
     * **The marks, before the translucent set and before anything composites the frame.**
     *
     * After every opaque draw is in, because the mark is decided from the depth buffer and a pass
     * run earlier would mark a world that was not finished. Before the translucent resolve, so a
     * pane of glass is drawn *over* the mark rather than under it, and before the post chain, so
     * bloom and the grade see a marked scene exactly as they would have seen a painted texture.
     *
     * The depth copy is asked for afresh: something drawn mid-frame may already have taken one,
     * and that copy is of a world with the last few draws missing. See `snapshotDepth`.
     */
    if (this.decalQueue.length > 0 && this.frameViewProj !== null) {
      /*
       * Null on two counts, and both are worth saying out loud once: a profile with no screen
       * effects has no off-screen target at all, and a driver that refuses a depth-only
       * framebuffer has a target and no copy — which `SceneTarget` already warns about for light
       * volumes. Either way this backend would draw nothing while WebGPU drew the mark, which is
       * two backends drawing different pictures with nothing said about it.
       */
      const marks = this.sceneTarget?.snapshotDepth(true) ?? null;
      if (marks === null) {
        this.refuseDecals();
      } else if (this.sceneTarget !== null) {
        this.decals ??= new DecalPass(this.gl);
        this.sceneTarget.bind();
        this.decals.drawDecals(
          this.decalQueue,
          marks,
          this.frameViewProj,
          this.frameEye,
          this.canvas.width,
          this.canvas.height,
        );
      }
    }

    /*
     * **The reflections, after the marks and before the glass.**
     *
     * After the decals because a march samples the *finished* picture and a mark on a floor belongs
     * in the reflection of that floor. Before the translucent resolve because a pane of glass is
     * drawn over a reflective floor rather than under it, and before the post chain so bloom and
     * the grade see a reflection exactly as they would see any other part of the picture.
     */
    if (this.reflectionQueue.length > 0 && this.frameViewProj !== null) {
      const scene = this.sceneTarget?.colorAttachment() ?? null;
      const depth = this.sceneTarget?.snapshotDepth(true) ?? null;
      if (scene === null || depth === null || this.sceneTarget === null) {
        this.refuseReflections();
      } else {
        this.ssr ??= new SsrPass(this.gl, this.sceneTarget.keepsRange);
        this.ssr.traceReflections(
          this.reflectionQueue,
          scene,
          depth,
          this.frameViewProj,
          this.frameEye,
          this.canvas.width,
          this.canvas.height,
          REFLECTION_EDGE_FADE,
        );
        /* `traceReflections` finished on the default framebuffer, which is not where the frame is
           being drawn. The composite goes into the scene, so the scene is bound again first. */
        this.sceneTarget.bind();
        this.ssr.resolveReflections();
      }
    }

    /*
     * **The translucent set, resolved before anything composites the frame.**
     *
     * Two passes over the recorded queue and one fullscreen resolve, all against the scene's own
     * depth so a pane behind a wall is rejected at the wall. The resolve composites into the scene
     * target, which is what the post chain below then reads — so bloom, occlusion and the grade all
     * see the glass, exactly as they would have with sorted blending.
     */
    const oitDepth = this.sceneTarget?.depthAttachment() ?? null;
    if (
      this.oitActive &&
      this.oit !== null &&
      oitDepth !== null &&
      this.translucentQueue.length > 0
    ) {
      const flat = this.flatUniforms;
      const options = this.oitReplayOptions;
      /*
       * **The copy a refracting pane reads is taken here, before the buffers are bound.** Taking
       * it puts the scene's framebuffer back as the one drawn into, so taken inside the replay —
       * at the first pane that refracts, which is where it was taken until 2026-09-19 — it sent
       * that pane into the scene instead of the accumulation, and every refracting pane came out
       * flat paint with the effect on. The opaque frame is finished here, which is what a pane
       * should show; the latch then serves every pane in the replay. Only when something refracts.
       */
      if (this.translucentQueue.refracts) this.sceneTarget?.snapshotColor();
      this.oit.accumulateOit(this.canvas.width, this.canvas.height, oitDepth, (weighted) => {
        this.oitReplaying = true;
        this.useFlatProgram();
        this.gl.uniform1f(flat['uOitWeighted'] ?? null, weighted ? 1 : 0);
        this.translucentQueue.replay((draw) => {
          options.lit = draw.lit;
          options.fog = draw.fog;
          options.toneMapped = draw.toneMapped;
          options.depthWrite = draw.depthWrite;
          options.depthLayer = draw.depthLayer;
          options.tint = draw.tint as unknown as Vec3 | null;
          /* Replayed too, or a pane refracts under sorted blending and stands clear under
             order-independent transparency — which reads as a bug in the transparency mode. */
          options.refraction = draw.refraction;
          options.refractTint = draw.refractTint as unknown as Vec3 | undefined;
          options.thicknessM = draw.thicknessM;
          this.drawTranslucentMesh(draw.mesh as Mesh, draw.model, draw.opacity, options);
        });
        /* Back to zero for every other draw in the frame, exactly as `uOpacity` and `uTint` are. */
        this.gl.uniform1f(flat['uOitWeighted'] ?? null, 0);
        this.oitReplaying = false;
      });
      this.sceneTarget?.bind();
      this.oit.resolveOit();
    }

    /*
     * **The medium, after everything that draws and before anything that composites.**
     *
     * After the glass, the marks and the reflections because it is the air *in front of* the
     * finished picture: fog over a reflective floor dims the reflection, and a shaft of light
     * crossing a pane of glass is in front of it. Before the post chain, so bloom sees a lit fog
     * bank as brightness and the grade sees the frame the viewer will — which is the placement
     * every other in-scene effect here already argues for.
     *
     * Nothing runs at density 0. Not a cheap pass, not a composite that adds zero: no target is
     * allocated and no program is compiled, so a build that never asks for weather is the build
     * that existed before this feature. `medium-check.mjs` photographs that claim rather than
     * trusting it.
     */
    if (
      mediumActive(this.mediumOptions, this.quality.globalMediumSteps) &&
      projection !== null &&
      view !== null
    ) {
      const depthCopy = this.sceneTarget?.snapshotDepth(true) ?? null;
      if (depthCopy === null || this.sceneTarget === null) {
        this.refuseMedium();
      } else {
        this.medium ??= new GlobalMediumPass(this.gl, this.sceneTarget.keepsRange);
        const env = this.lastPassEnv;
        /*
         * The sun's map, on the two conditions the shaft draw uses: the profile has to have built
         * one, and the frame has to have refreshed it. `shadowStrength` is the second — a scene
         * that did not run a shadow pass leaves it at zero, and marching against a stale map puts
         * last frame's shafts in this frame's air.
         */
        const sunShadow =
          this.quality.directionalShadows && env !== null ? clamp(env.shadowStrength, 0, 1) : 0;
        const marched = this.medium.marchMedium(
          depthCopy,
          this.canvas.width,
          this.canvas.height,
          this.quality.globalMediumHalfResolution,
          this.quality.globalMediumSteps,
          this.mediumOptions,
          view,
          projection,
          this.frameEye,
          {
            sunDir: env?.directionalDir ?? [0, 1, 0],
            sunColor: env?.directionalColor ?? [0, 0, 0],
            ambient: env?.ambient ?? [0, 0, 0],
            sunShadow,
            lightViewProj: env?.lightViewProj ?? IDENTITY_MAT4,
            /* The placeholder rather than null where a map is merely absent, for the reason
               `emptyTexture.ts` gives: white is depth 1, the far plane, nothing in the way. */
            staticShadowMap: this.shadowMap?.texture ?? this.emptyTexture2D,
            peeledShadowMap: this.peeledShadowMap?.texture ?? this.emptyTexture2D,
            dynamicShadowMap: this.dynamicShadowMap?.texture ?? this.emptyTexture2D,
            peeledEnabled: this.peeledShadowMap !== null,
          },
        );
        if (marched) {
          /* The march finished on the default framebuffer, which is not where the frame is being
             drawn. See `resolveReflections`, which is the same two-step for the same reason. */
          this.sceneTarget.bind();
          this.medium.compositeMedium(depthCopy, this.canvas.width, this.canvas.height);
        }
      }
    }

    this.sceneTarget?.resolve(
      this.rushStrength,
      RUSH_REACH_UV,
      lateGrade,
      motion,
      ao,
      bloom,
      dof,
      this.veilColor,
      this.veilAlpha,
      temporal,
    );
    /* The history now holds this frame, so the next one may sample it. */
    if (temporal !== undefined) this.temporalHistory.accumulated();
    /*
     * Cleared rather than held. See `setFrameVeil`: a veil is one cut's instruction, and a
     * frame that never calls the setter again must not inherit the last one's colour.
     */
    this.veilAlpha = 0;
    this.framePresented = true;
    /* See `presentedFrames`: this is the line its whole design points at. */
    this.presentedFrameCount++;
    if (!this.firstFrameCleared && this.firstFrameFence === null) {
      /*
       * Behind everything the first frame asked for, including every pass whose
       * programs and attachments the driver is about to compile and validate.
       * Flushed rather than left in the queue, because a fence nobody has sent
       * cannot signal.
       */
      this.firstFrameFence = this.gl.fenceSync(this.gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
      this.gl.flush();
      if (this.firstFrameFence === null) this.firstFrameCleared = true;
    }
  }

  /**
   * Whether the driver has finished the first frame, not merely been asked for it.
   *
   * For whatever is covering the load: a plate lifted on the frame being submitted
   * uncovers the screen while the GPU process is still paying that frame's
   * first-use bill, and the player watches the last of the load rather than being
   * spared it. Poll it once a frame; it never goes back to false.
   *
   * Non-blocking by construction — a zero timeout asks the driver what it has
   * finished and takes the answer, rather than waiting for the one it wants.
   */
  get firstFrameSettled(): boolean {
    if (this.firstFrameCleared) return true;
    const fence = this.firstFrameFence;
    if (fence === null) return false;
    const { gl } = this;
    const status = gl.clientWaitSync(fence, 0, 0);
    this.firstFrameWaits++;
    if (
      status === gl.ALREADY_SIGNALED ||
      status === gl.CONDITION_SATISFIED ||
      status === gl.WAIT_FAILED ||
      this.firstFrameWaits > FIRST_FRAME_MAX_WAITS
    ) {
      gl.deleteSync(fence);
      this.firstFrameFence = null;
      this.firstFrameCleared = true;
    }
    return this.firstFrameCleared;
  }

  /**
   * Make the flat program current, before anything writes one of its uniforms.
   *
   * **A uniform location belongs to a program, and writing it while a different program
   * is bound is an `INVALID_OPERATION` that uploads nothing.** Every method here that
   * writes `flatUniforms` calls this first, and that is a rule about this class rather
   * than a suggestion: the flat pass is bound once by `bindMeshPass` and then *interrupted*
   * by every other pass there is — water, particles, plumes, flock, bolts, streaks, film,
   * sky — each of which binds a program of its own. Any flat-pass call made after one of
   * those was writing to a program that had not been current since.
   *
   * Measured, on the demos, before this existed: `drawTranslucentMesh` in the chamber
   * scene wrote `uModel` and `uOpacity` to the flat program while the particle program was
   * bound, and `drawMesh` in the sea scene wrote `uModel` while the flock program was. Both
   * raised `INVALID_OPERATION` every frame, and both then drew the mesh through whichever
   * shader *was* bound, since a draw call takes the program it finds.
   *
   * That error mattered beyond the geometry it spoiled. A pending GL error is not attached
   * to the call that raised it — the next `getError` anywhere reads it and concludes
   * whatever it was checking has failed. The depth-blit guard in `sceneTarget.ts` did
   * exactly that: it read this error as a driver refusing a depth resolve and switched
   * camera motion blur off for the session.
   *
   * The other repair — having each interrupting pass hand the flat program back — was
   * rejected. It puts the obligation on every pass that will ever be added rather than on
   * the six places that write these uniforms, and a pass that forgets reintroduces exactly
   * this, silently.
   *
   * Not filtered for redundancy. A cache of "what is bound" would have to be invalidated
   * by every call that delegates to a pass module, which is the same forgettable
   * obligation in a new shape, and the wrong answer is a silent no-op rather than a
   * redundant bind. The engine's draw budget is under 100 calls a frame; measured on the
   * chamber and sea scenes, GPU time did not move.
   */
  private useFlatProgram(): void {
    this.gl.useProgram(this.flatProgram);
  }

  /** Bind the flat pass once per frame; then issue any number of drawMesh calls. */
  bindMeshPass(camera: Camera, env: Environment): void {
    /* The pass's own material is reopened, so the next draw opens one. See `materialChanges.ts`. */
    this.materials.dirty();
    /*
     * Captured here rather than taken as an argument to `endFrame`, because this is the
     * camera the world was drawn with and a caller should not have to hand it over twice.
     * A reflection pass binds its own camera and is skipped: blurring toward a mirror's
     * previous view is not what a viewer moved through.
     */
    if (!this.reflectionPassActive && !this.probePassActive) {
      this.frameViewProj = camera.viewProjection;
      /* Copied rather than referenced: a caller moves its camera in place, and the decal pass
         reads this at the end of the frame. */
      this.frameEye.set(camera.position);
      /*
       * **The frame's sub-pixel offset is decided here**, where the scene's own camera arrives and
       * before anything is drawn with it. A mirror and a probe are skipped by the same guard that
       * skips them for motion blur, and for the same reason: they are not the picture the history
       * holds, and jittering them would sample a reflection against a history of the viewer's
       * frame.
       */
      this.temporalJittering = this.quality.temporalAa && this.quality.screenEffects;
      if (this.temporalJittering) {
        this.temporalHistoryUsable = this.temporalHistory.openFrame(
          Math.max(1, this.gl.drawingBufferWidth),
          Math.max(1, this.gl.drawingBufferHeight),
        );
        const [jx, jy] = jitterOffset(this.temporalHistory.frameIndex);
        this.temporalJitterX = jx;
        this.temporalJitterY = jy;
      } else {
        this.temporalHistoryUsable = false;
      }
      /*
       * **The camera's own projection, not the drawn one, and that was checked.** Ambient
       * occlusion inverts this to turn a stored depth back into a view position, and it looked
       * like it should follow the depth remap — it does not: `ambientOcclusion.ts` recovers
       * OpenGL's clip z through `glslSceneDepthToNdc` first, so the inverse it wants is of the
       * matrix that clip z belongs to. Remapping it was measured and made one scene worse and no
       * scene better, which is what settled it.
       */
      this.frameProjection = camera.projection;
    }
    /*
     * The frustum, once a frame rather than once a draw.
     *
     * Rebuilt for the mirror and the probe too: a draw between `beginPlanarReflection` and its
     * end is seen from the mirrored camera, so culling it against the viewer's frustum would
     * remove exactly the geometry a reflection exists to show.
     */
    frustumFromViewProjection(camera.viewProjection, this.frustum);
    /*
     * The occlusion buffer starts here, for the same reason the frustum does: this is where the
     * camera arrives. Sized to the drawing buffer's aspect so a rectangle test is a rectangle on
     * screen rather than one stretched by it.
     */
    const across = this.quality.occlusionCulling;
    if (across > 0) {
      this.occlusion ??= new OcclusionBuffer({ width: across, height: across });
      /*
       * **The aspect comes from the projection, not from the canvas**, and both halves of that
       * matter. A DOM read in `bindMeshPass` is the thing the house rules forbid outright; and the
       * buffer has to match the matrix it projects through rather than the element it is displayed
       * in, which are the same number until a caller draws through a camera it built for something
       * else. `[0][0]` is `focal / aspect` and `[1][1]` is `focal`, so their ratio is the reciprocal
       * of the aspect and needs neither.
       */
      const p00 = camera.projection[0] ?? 1;
      const p11 = camera.projection[5] ?? 1;
      this.occlusion.resize({
        width: across,
        height: Math.max(1, Math.round((across * Math.abs(p00)) / Math.max(1e-6, Math.abs(p11)))),
      });
      this.occlusion.begin(camera.viewProjection);
    }
    if (this.contextLost) return;

    this.lastPassCamera = camera;
    this.lastPassEnv = env;

    /*
     * Once per flat program, and there are two the moment a skinned mesh exists.
     *
     * **A uniform location belongs to a program**, so a second program starts with none of this
     * frame's lighting, shadows, atmosphere or froxel table — and an unwritten GL uniform is zero,
     * which is a real value for most of them. That is not a dim picture, it is the class of
     * failure this file already records twice: `uGrain` unwritten switched grain off everywhere,
     * and `uAmbientGround` unwritten made every downward face pure black.
     *
     * The **whole** body runs again rather than a per-program half of it, and the dozen repeated
     * `bindTexture` calls are the price. Splitting it would be two statements of one decision and
     * they would drift — the 2026-08-17 rule — and the drift would be invisible, because a shader
     * reading a stale uniform draws a picture rather than raising anything. What it costs is a
     * dozen idempotent texture binds a frame, only in a game that skins. What would make it wrong
     * is a non-idempotent step entering this body; there is none today, and one added would show
     * as a skinned game behaving differently from an unskinned one.
     */
    for (const target of this.flatTargets) {
      this.gl.useProgram(target.program);
      this.writeMeshPassState(target.uniforms, camera, env);
    }
    /* Leave the plain program current, which is what every other pass expects to find. */
    this.useFlatProgram();
  }

  /**
   * Everything one flat program needs to know about this frame.
   *
   * Split out of `bindMeshPass` so it can be run against each program rather than only the one
   * that happened to be bound. Takes its uniform table as a parameter for exactly that reason: a
   * method reaching for `this.flatUniforms` would silently write the plain program's locations
   * whichever program is current, which is an `INVALID_OPERATION` that uploads nothing.
   */
  private writeMeshPassState(
    u: Record<string, WebGLUniformLocation>,
    camera: Camera,
    env: Environment,
  ): void {
    const { gl } = this;
    gl.uniformMatrix4fv(u['uViewProj'] ?? null, false, this.viewProjFor(camera));
    /* The frame's wind, for any geometry carrying a per-vertex sway lane. A program that does not
       declare these gets `null` locations and uploads nothing, which is what makes this safe to
       run against every mesh program rather than only the ones that bend. */
    this.uploadWind(u, this.frameWind);
    /*
     * **Refraction off, and the sampler pointed at a real texture anyway.**
     *
     * An unbound sampler defaults to unit 0, which this pass holds a shadow map in — two sampler
     * types on one unit is undefined at best and an INVALID_OPERATION at worst, for a fetch the
     * branch was never going to take. So the empty texture is bound every frame and read nowhere
     * unless a draw sets the strength above zero.
     */
    gl.activeTexture(gl.TEXTURE0 + REFRACT_SCENE_TEXTURE_UNIT);
    gl.bindTexture(gl.TEXTURE_2D, this.emptyTexture2D);
    gl.uniform1i(u['uRefractScene'] ?? null, REFRACT_SCENE_TEXTURE_UNIT);
    gl.uniform1f(u['uRefractStrength'] ?? null, 0);
    gl.uniform3fv(u['uRefractTint'] ?? null, WHITE_TINT);
    gl.uniform1f(u['uRefractThickness'] ?? null, 0);
    gl.uniform3fv(u['uDirectionalDir'] ?? null, env.directionalDir);
    gl.uniform3fv(u['uDirectionalColor'] ?? null, env.directionalColor);
    gl.uniform3fv(u['uAmbient'] ?? null, env.ambient);
    /*
     * The ground half of the hemisphere, which this pass never uploaded.
     *
     * `flat.ts` is the only shader that declares `uAmbientGround`, and the only place it
     * was written was the plume pass — where the shader does not declare it, so that write
     * went nowhere. An unwritten GL uniform is **zero**, so every downward-facing surface
     * in every world drawn by this engine took an ambient of pure black, and the
     * `mix(uAmbientGround, uAmbient, n.y * 0.5 + 0.5)` that is supposed to be a hemisphere
     * was a fade from the sky colour to nothing.
     *
     * The same failure as `uTint`, which rendered a whole world black for the same reason:
     * a uniform nobody writes is not "the default", it is zero. Both stayed invisible to
     * the first consumer for the same kind of reason — it tints avatar parts, so `uTint`
     * was set by accident, and it is an outdoor game whose surfaces face the sky, so the
     * ground half never had anything to light. An indoor world is all ceiling, and the
     * ceiling came out
     * nearly black: measured at 0.017 against the 0.094 of the renderer being reproduced.
     */
    gl.uniform3fv(u['uAmbientGround'] ?? null, env.ambientGround ?? env.ambient);
    /*
     * And the output transform, which this pass also never uploaded.
     *
     * The same fault, found by the same test in the same minute: the only write was in the
     * plume pass, so the *world* has been drawn with `uOutputTransform` at its unwritten
     * value of 0 — `none` — ever since the option was added. A consumer asking for `aces`
     * got tone mapping on its smoke and linear values on everything else, which is exactly
     * the "dark and muddy midtones" the option exists to remove. It presents as the option
     * not working rather than as the option not arriving.
     */
    /*
     * The grade, and **only where this pass is the last one.**
     *
     * With a scene target the resolve applies it, so the mesh pass must not: grading twice is a
     * curve applied to its own output, and grading early throws away the range a float target
     * exists to keep. With `screenEffects` off there is no resolve at all and the mesh pass
     * writes straight to the canvas, so it stays where it always was.
     *
     * The consequence worth stating: full grading needs the composite. Without it the sky, the
     * particles, the film and the water are still ungraded beside a world that is, which is the
     * inconsistency that existed everywhere before this moved.
     */
    gl.uniform1i(u['uOutputTransform'] ?? null, this.gradeCode());
    gl.uniform1f(u['uOutputExposure'] ?? null, this.gradeExposure());
    gl.uniform3fv(u['uCameraPos'] ?? null, camera.position);
    /*
     * Solid, every frame, before anything asks otherwise. A GL uniform starts at
     * zero, so an opacity nobody set is a world drawn with an alpha of nothing —
     * invisible the moment the canvas is composited over the page, and perfectly
     * fine until it is.
     */
    gl.uniform1f(u['uOpacity'] ?? null, 1);
    /*
     * Lit and fogged by default, for the same reason `uOpacity` is reset rather than left to
     * GL's own zero: every draw before `drawTranslucentMesh`'s options existed shaded and
     * fogged, and an unwritten `uLightingEnabled` would silently draw the entire world flat.
     * `drawTranslucentMesh` overrides these per call and puts them back afterwards, the same
     * shape `uOpacity` and `uTint` already use.
     */
    gl.uniform1i(u['uLightingEnabled'] ?? null, 1);
    gl.uniform1i(u['uFogEnabled'] ?? null, 1);
    /* Grain on by default, so every scene written before it was a choice looks unchanged. */
    gl.uniform1f(u['uGrain'] ?? null, 1);
    /* No environment reflection unless a caller asks, so existing scenes are unchanged. */
    gl.uniform1f(u['uReflectivity'] ?? null, 0);
    /* 1, not 0: this one is a multiplier and its identity is one. See `setEnvironmentGain`. */
    gl.uniform1f(u['uEnvironmentGain'] ?? null, 1);
    /* And no relief unless a caller asks, for the same reason. */
    gl.uniform1f(u['uRelief'] ?? null, 0);
    gl.uniform1f(u['uReliefCycles'] ?? null, 60);
    /* And no relief read off a surface texture either, for the same reason. */
    gl.uniform1f(u['uTextureRelief'] ?? null, 0);
    gl.uniform1i(u['uClipEnabled'] ?? null, this.reflectionPassActive ? 1 : 0);
    const reflection = this.planarReflection;
    if (this.reflectionPassActive && reflection !== null) {
      gl.uniform4fv(u['uClipPlane'] ?? null, reflection.clipPlane);
    }
    bindAtmosphere(
      gl,
      u,
      env,
      this.reflectionPassActive ? this.reflectionAtmosphereY : (camera.position[1] ?? 0),
      this.quality.underwaterAtmosphere,
    );
    gl.uniform1f(u['uEmissiveGain'] ?? null, env.emissiveGain);
    gl.uniform1f(u['uNightFactor'] ?? null, env.nightFactor);
    /* Absent means zero, so a world written before this term existed adds nothing. */
    gl.uniform1f(u['uNightEmissive'] ?? null, env.nightEmissive ?? 0);
    /*
     * **The light matrix as the scene built it, uncorrected, whichever way scene depth runs.**
     *
     * `shadowFactor` projects with this and then does `p = p * 0.5 + 0.5` on all three axes — the
     * OpenGL convention, written into the shader — while `GL_SHADOW_REMAP` performs that same
     * range change in the matrix. Handing the corrected one here applies it twice and lands every
     * receiver depth in `[0.5, 1]` against a map holding `[0, 1]`, which biases every comparison
     * and drags the far fade across the whole cascade. `webgpu/renderer.ts` states the rule for
     * its own copy of this lookup; the two backends have to project the same way.
     */
    gl.uniformMatrix4fv(u['uLightViewProj'] ?? null, false, env.lightViewProj);
    gl.uniform1f(u['uShadowStrength'] ?? null, this.shadowMap === null ? 0 : env.shadowStrength);
    gl.uniform1f(u['uShadowMapSize'] ?? null, this.quality.directionalShadowMapSize);
    gl.uniform1f(u['uShadowDepthSpan'] ?? null, env.shadowDepthSpan);
    gl.uniform1f(u['uShadowMaxDistance'] ?? null, this.quality.directionalShadowMaxDistance);
    gl.uniform1i(u['uPeeledShadowEnabled'] ?? null, this.peeledShadowMap === null ? 0 : 1);
    gl.uniform1f(u['uShadowMaxSlope'] ?? null, this.quality.directionalShadowMaxSlope);
    gl.uniform1i(u['uShadowFilterTaps'] ?? null, this.quality.shadowFilterTaps);
    gl.uniform3fv(u['uHighlightMin'] ?? null, env.highlightMin);
    gl.uniform3fv(u['uHighlightMax'] ?? null, env.highlightMax);
    gl.uniform1f(u['uHighlightGain'] ?? null, env.highlightGain);

    bindPointLights(gl, u, env, this.quality.pointLightFalloff);
    this.bindClusters(u, camera, env);
    this.bindIesAtlas(u);
    bindAreaLights(gl, u, env.areaLights);

    /*
     * Only when the shader has somewhere to put them. With directional shadows off these
     * three samplers are not compiled, so binding to their units is describing a feature
     * that does not exist in the program about to run.
     *
     * The placeholder rather than `null` where a map is merely absent: an unbound sampler
     * is an *incomplete* texture, and a driver may fetch its descriptor before evaluating
     * the runtime branch that would have skipped the read. See `emptyTexture.ts`.
     */
    if (this.quality.directionalShadows) {
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, this.shadowMap?.texture ?? this.emptyTexture2D);
      gl.uniform1i(u['uStaticShadowMap'] ?? null, 0);

      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, this.peeledShadowMap?.texture ?? this.emptyTexture2D);
      gl.uniform1i(u['uPeeledShadowMap'] ?? null, 1);

      gl.activeTexture(gl.TEXTURE2);
      gl.bindTexture(gl.TEXTURE_2D, this.dynamicShadowMap?.texture ?? this.emptyTexture2D);
      gl.uniform1i(u['uDynamicShadowMap'] ?? null, 2);
    }

    if (this.pointShadows === null) {
      /*
       * Nothing to point anywhere: with point shadows off the shader is compiled without
       * a single cubemap sampler, so there are no units to fill and no index array to
       * mark inactive. This used to bind twelve textures and write twelve uniforms every
       * frame to describe a feature that was switched off.
       */
    } else {
      /* Chosen in `pointShadowSystem.ts` and bound here; see `resolve` for the split. */
      this.pointShadows.resolve(this.resolvedPointShadows);
      this.bindPointShadows(u, DIRECTIONAL_SHADOW_UNITS);
      /*
       * The rectangles' layers, into the array `bindPointShadows` just put on its unit. Resolved
       * in `updateAreaShadows` rather than here, and bound unconditionally: with no casting
       * rectangle every layer is -1, which is what the lit pass reads as "no image" — so a scene
       * with none writes eight arrays of a constant and performs no fetch.
       */
      bindAreaShadows(gl, u, this.resolvedAreaShadows);
    }

    /*
     * The pass opens untextured, so a caller that never asks for a surface texture gets
     * exactly the shading it always did.
     *
     * The sampler is pointed at its unit once here rather than per draw: it is constant
     * for the life of the program, and re-writing a uniform that cannot have changed is
     * the sort of per-draw cost this renderer avoids everywhere else.
     */
    /*
     * And the surface unit, which starts every pass with no texture on it: `uAlbedoEnabled`
     * is 0 until a caller asks for one, and a world that never asks would otherwise leave
     * this sampler incomplete for the whole session.
     */
    /*
     * The room, for whatever `setSurfaceReflectivity` is turned up on.
     *
     * Only when a probe exists: without one the program declares no probe array here at all, and
     * none of these names are in it.
     *
     * **Off, and bound to the placeholder, while a probe is being baked.** WebGL2's
     * rendering-feedback-loop check is per texture object rather than per image, so sampling the
     * array while any layer of it is attached is undefined — on a layer the pass does not write. The strength going to
     * zero would not be enough on its own — a driver may fetch a sampler's descriptor before it
     * evaluates the arithmetic that discards the result, which is the same reason
     * `emptyTexture.ts` exists.
     */
    if (this.probeCapture !== null) {
      const array = this.probeArray;
      const grid = this.probes;
      const usable = array !== null && grid !== null && array.ready && !this.probePassActive;
      gl.activeTexture(gl.TEXTURE0 + ENVIRONMENT_TEXTURE_UNIT);
      gl.bindTexture(gl.TEXTURE_2D_ARRAY, usable ? array.texture : this.emptyTexture2DArray);
      gl.uniform1i(u['uEnvironment'] ?? null, ENVIRONMENT_TEXTURE_UNIT);
      gl.uniform1f(u['uEnvironmentEnabled'] ?? null, usable ? 1 : 0);
      /*
       * Which chain was baked into the layers, because the level and the weight both depend on it.
       *
       * **Read at bake time now rather than at bind time.** There were two cubes and this chose
       * between them; there is one array, so `RenderQuality.environmentPrefilter` decides what the
       * convolution writes and a profile that changes it has to bake again.
       */
      gl.uniform1f(u['uEnvironmentPrefiltered'] ?? null, this.quality.environmentPrefilter ? 1 : 0);
      gl.uniform1f(u['uEnvironmentMaxLod'] ?? null, array?.ggxMaxLevel ?? 0);
      /*
       * The map's edge, which used to be `exp2(maxLod)` and is not any more: the chain stops one
       * level below the cosine convolution, so the top level is 4 while the map is 256 across. The
       * shader's footprint arithmetic wants the edge and its level clamp wants the top, and those
       * are two numbers now.
       */
      gl.uniform1f(u['uEnvironmentEdge'] ?? null, array?.edge ?? 1);
      /* Never on this backend: what fills a visibility map is a compute dispatch. See `probeGrid.ts`. */
      gl.uniform1f(u['uProbeVisibilityEnabled'] ?? null, 0);
      gl.uniform1f(u['uEnvironmentIrradianceLevel'] ?? null, array?.irradianceLevel ?? 0);
      /*
       * Where the probes stand: four uniforms whatever the probe count, because this shader is
       * already 1.7x over WebGL2's guaranteed fragment uniform budget before a probe is placed.
       */
      const origin = grid?.origin ?? WORLD_ORIGIN;
      const invSpacing = grid?.invSpacing ?? UNIT_STEP;
      const counts = grid?.counts ?? UNIT_STEP;
      gl.uniform3f(u['uProbeGridOrigin'] ?? null, origin[0], origin[1], origin[2]);
      gl.uniform3f(u['uProbeGridInvSpacing'] ?? null, invSpacing[0], invSpacing[1], invSpacing[2]);
      gl.uniform3f(u['uProbeGridCounts'] ?? null, counts[0], counts[1], counts[2]);
      /*
       * Whether the grid supplies the scene's ambient, which is `ProbeBakeOptions.irradiance` at
       * grid scope. Separate from `usable` for the reason the projection's own gate was: a
       * consumer can want the reflection and not the substitution, and wanting that was filed four
       * times over two days as four different bugs before it could be asked for.
       */
      gl.uniform1f(u['uProbeGridAmbient'] ?? null, usable && this.probeAmbient ? 1 : 0);
    }

    gl.activeTexture(gl.TEXTURE0 + SURFACE_TEXTURE_UNIT);
    gl.bindTexture(gl.TEXTURE_2D, this.emptyTexture2D);
    gl.uniform1i(u['uAlbedo'] ?? null, SURFACE_TEXTURE_UNIT);
    gl.uniform1i(u['uAlbedoEnabled'] ?? null, 0);
    gl.uniform2f(u['uUvScale'] ?? null, 1, 1);
    gl.uniform1f(u['uAlbedoCutout'] ?? null, 0);
    this.currentSurfaceTexture = null;

    /*
     * **And the normal map, which this did not reset and had to.**
     *
     * `setMaterial`'s own comment says a pass cannot inherit a material from the one before it,
     * and that was true of the albedo alone. `uNormalStrength` is an ordinary GL uniform and
     * survives a pass boundary, so a pass that ended normal-mapped handed its map to the next one
     * until something called `setMaterial` — every mesh in it lit through an image it never asked
     * for, at whatever strength the previous pass chose.
     *
     * Invisible in every capture this repository takes, because no published scene binds a normal
     * map. And **the two backends disagreed about it**: WebGPU sets `materialSlot` to -1 when a
     * pass opens, so the next draw copies the pass's base block, in which this term is zero.
     *
     * The sampler goes back to the stand-in rather than being left on the caller's texture,
     * matching the albedo above and for the same reason `emptyTexture.ts` gives: a driver may
     * fetch a sampler's descriptor before it evaluates the branch that would have skipped the read.
     */
    gl.activeTexture(gl.TEXTURE0 + NORMAL_TEXTURE_UNIT);
    gl.bindTexture(gl.TEXTURE_2D, this.emptyTexture2D);
    gl.uniform1i(u['uNormalMap'] ?? null, NORMAL_TEXTURE_UNIT);
    gl.uniform1f(u['uNormalStrength'] ?? null, 0);

    /* And the ORM map, for the reason directly above and the one above that. */
    gl.activeTexture(gl.TEXTURE0 + ORM_TEXTURE_UNIT);
    gl.bindTexture(gl.TEXTURE_2D, this.emptyTexture2D);
    gl.uniform1i(u['uOrmMap'] ?? null, ORM_TEXTURE_UNIT);
    gl.uniform1i(u['uOrmEnabled'] ?? null, 0);
    gl.uniform3f(u['uOrmScale'] ?? null, 1, 1, 1);

    /* And the emissive map. The scale goes back to one, which is the identity it multiplies by. */
    gl.activeTexture(gl.TEXTURE0 + EMISSIVE_TEXTURE_UNIT);
    gl.bindTexture(gl.TEXTURE_2D, this.emptyTexture2D);
    gl.uniform1i(u['uEmissiveMap'] ?? null, EMISSIVE_TEXTURE_UNIT);
    gl.uniform1i(u['uEmissiveMapEnabled'] ?? null, 0);
    gl.uniform3f(u['uEmissiveScale'] ?? null, 1, 1, 1);

    /*
     * White, because a uniform nobody has written is **zero**, and this one multiplies
     * vertex colour.
     *
     * `drawMesh` writes `uTint` only when a caller passes one, and hands it back to white
     * afterwards. That is correct bookkeeping for a tint that arrives, and it leaves a
     * hole for one that never does: until the first tinted draw in the life of the
     * program, `uTint` is `vec3(0)` and `vColor = aColor * uTint` is black. Every surface
     * in the world renders black, with no GL error and nothing in the console.
     *
     * The first consumer never saw it because it draws avatar parts with a tint, so its
     * first frames set the uniform as a side effect and the reset leaves white behind. A
     * consumer that tints nothing — a world lit entirely by its own vertex colours and a
     * surface texture — gets a black screen and no clue why. Found exactly that way.
     *
     * Here rather than in the constructor because this is where the pass declares the
     * state it starts from; one uniform write per pass is not a cost worth reasoning about,
     * and it also covers a program left mid-tint by an aborted frame.
     */
    gl.uniform3fv(u['uTint'] ?? null, WHITE_TINT);
  }

  /**
   * Draw world geometry.
   *
   * `depthLayer` orders geometry that **occupies the same surface** as other geometry
   * — a deck crossing another deck, a kerb fused into the slab it trims, a marking
   * inlaid in a floor. A higher layer wins the depth test wherever two surfaces
   * coincide. 0, the default, is the base world and takes no offset at all.
   *
   * The engine cannot guess which of two fused surfaces should win, so it does not
   * try: the consumer declares the order once, and the engine's promise is that the
   * answer is then the *same from every angle*. That is the whole defect — not that
   * the wrong surface wins, but that which one wins is not decided anywhere.
   *
   * Without it, two coplanar surfaces are a coin toss taken per pixel. Their
   * interpolated depths are equal in exact arithmetic, so the comparison is decided
   * by which way the rounding fell in each triangle's interpolators, and that
   * pattern changes with the view: a kerb reads as a full band from one angle and a
   * hairline from another, and the seam between two fused slabs crawls with a hatch.
   *
   * It turned up in six places in a single session, and the right call was to refuse
   * the workaround: this belongs at engine level, and level design should not be bent
   * around an engine bug. The workaround is real — consumers had been lifting markings
   * a centimetre or two off the surfaces they belong to, one hand-tuned constant at a
   * time, to dodge this.
   *
   * Two measurements narrowed it to exactly this and are worth keeping, because both
   * eliminate a plausible cure:
   *
   * - **Not depth precision.** With the near plane at 2.0 the buffer resolves seven
   *   microns at the distances involved and the artefact was unchanged. So the
   *   surfaces are not nearly-coincident, they are *coincident* — and no depth
   *   format separates equal depths. That is what took a reversed-Z conversion off
   *   the table.
   * - **Not the shadow pass.** With `?shadows=0`, unchanged.
   *
   * `POLYGON_OFFSET_FILL` is the feature built for this. The slope term matters as
   * much as the constant one: a band seen at a grazing angle covers many depth units
   * across one pixel, and a fixed nudge that suffices head-on vanishes there.
   */
  drawMesh(
    mesh: Mesh,
    model: ReadonlyMat4,
    depthLayer = 0,
    /**
     * Optional per-draw colour multiplier, or null for the mesh's own colours.
     *
     * For anything that has to take on a colour decided at runtime — a part matching the
     * surface underneath it, a highlight, a team tint — where the alternative is
     * rebuilding vertex data every frame. Reset to white after the call, so a caller that
     * passes one cannot leak it into the next draw.
     */
    tint: Vec3 | null = null,
    /**
     * Where the mesh was last frame, which this backend takes and ignores.
     *
     * Accepted rather than absent so that one scene draws through both renderers unchanged — the
     * parity rule this repository is built on. Reconstruction is WebGPU's, having no compute stage
     * here, so there is no motion target for this to be written into.
     */
    _previousModel: ReadonlyMat4 | null = null,
  ): void {
    if (this.contextLost) return;
    /* Geometry that has not all arrived is not drawn. See `Mesh.complete`. */
    if (!mesh.complete) return;

    /*
     * Skipped where the flag asks and the bounds say so.
     *
     * **Only the draw is saved, and that is the smaller half.** A caller has already paid for
     * the model matrix, whatever animation produced it and any material state it set, and none
     * of that can be recovered from here — `visible` exists so a consumer can skip all of it.
     * What this saves is the GPU's share, which for a heavy mesh is most of the cost and for a
     * trivial one is very little.
     */
    if (this.quality.cullDraws && !this.visible(mesh.bounds, model)) return;
    /*
     * And the other half of the same question, where the profile asked for one. Gated on
     * `cullDraws` alongside the frustum test, because both are the renderer doing a consumer's
     * culling for it and a consumer that culls its own wants neither. `occluded` answers false
     * whenever anything is uncertain, so a scene that declared no occluders draws exactly as it
     * did before.
     */
    if (this.quality.cullDraws && this.occluded(mesh.bounds, model)) return;
    this.drawBudget.ask();
    this.takeMaterial();
    const { gl } = this;
    /*
     * A rigged mesh takes the skinned program, an unrigged one the plain program.
     *
     * Per draw rather than per renderer, because one scene holds both. The palette binds to a
     * **vertex** texture unit, which is a separate sixteen from the fragment stage's — see
     * `skinPalette.ts`.
     *
     * A rigged mesh whose caller set no palette falls back to the plain program rather than
     * skinning by an unbound sampler: an incomplete sampler is what page-faulted an RDNA4 card in
     * this renderer's history, and a bind pose is a defined state a viewer can see and report.
     */
    const wantSkin = mesh.isSkinned && this.skinPaletteSet;
    const wantMorph = mesh.morph !== null && this.morphWeights !== null;
    /*
     * Both flags first, then the table for that pair — and each flag is dropped only if the pair it
     * belongs to was never compiled. Deriving one from the other, as the first version did, made a
     * missing skinned-only program silently switch morph off as well.
     */
    const both = wantSkin && wantMorph && this.flatBothUniforms !== null;
    const skinned = both || (wantSkin && this.flatSkinnedUniforms !== null);
    const morphed = both || (wantMorph && !wantSkin && this.flatMorphedUniforms !== null);
    const variant =
      skinned && morphed
        ? this.flatBothUniforms
        : skinned
          ? this.flatSkinnedUniforms
          : morphed
            ? this.flatMorphedUniforms
            : null;
    const u = variant ?? this.flatUniforms;
    const program =
      skinned && morphed
        ? this.flatBothProgram
        : skinned
          ? this.flatSkinnedProgram
          : morphed
            ? this.flatMorphedProgram
            : null;

    if (program !== null) {
      gl.useProgram(program);
      if (skinned) {
        this.skinPalette.bind(gl, SKIN_PALETTE_TEXTURE_UNIT);
        gl.uniform1i(u['uJointPalette'] ?? null, SKIN_PALETTE_TEXTURE_UNIT);
      }
      if (morphed && mesh.morph !== null) {
        mesh.morph.bind(gl, MORPH_DELTA_TEXTURE_UNIT);
        gl.uniform1i(u['uMorphDeltas'] ?? null, MORPH_DELTA_TEXTURE_UNIT);
        gl.uniform1i(u['uMorphTargetCount'] ?? null, mesh.morph.targetCount);
        gl.uniform1i(u['uMorphTextureWidth'] ?? null, mesh.morph.width);
        gl.uniform1fv(u['uMorphWeights'] ?? null, this.morphWeights as Float32Array);
      }
    } else {
      this.useFlatProgram();
    }
    gl.uniformMatrix4fv(u['uModel'] ?? null, false, model);
    /*
     * Whether this mesh's tangent frame is real, which the attribute cannot say for itself: the
     * absent-attribute constant is a *usable* frame rather than a sentinel. See `mesh.ts`.
     */
    gl.uniform1i(u['uHasTangents'] ?? null, mesh.hasTangents ? 1 : 0);
    if (tint !== null) gl.uniform3fv(u['uTint'] ?? null, tint);
    const layer = Math.min(Math.max(Math.round(depthLayer), 0), MAX_DEPTH_LAYER);
    /*
     * `LESS`, not the `LEQUAL` this context is set up with, and it is the other half of
     * the coincident-surface fix — the half `depthLayer` cannot reach.
     *
     * Under `LEQUAL` a fragment whose depth *equals* what is stored passes and overwrites
     * it. So two coplanar surfaces do not merely tie, they re-write each other, and a
     * single unit of rounding either way decides which one survives at each pixel. That is
     * the residual that kept turning up after the layers went in — tiny borders of the
     * elements *under* a platform showing on it at certain camera angles — and it is the case no
     * polygon offset can touch, because the two faces are inside one draw call and there
     * is nothing to bias them apart with.
     *
     * `LESS` rejects the tie instead. The first surface written wins, at every pixel,
     * whatever the rounding did — so a stone's underside cannot come through the terrace
     * it stands on, and the answer does not change when the camera moves.
     *
     * Scoped to this call and handed straight back, rather than changed at setup, because
     * other passes genuinely need the equal case: the sky is a full-screen triangle at
     * depth 1.0 against a buffer cleared to 1.0, and under `LESS` it would not draw at
     * all. Film, caustics and text lie flush on surfaces for the same reason.
     */
    gl.depthFunc(this.reversedDepth ? gl.GREATER : gl.LESS);
    if (layer === 0) {
      mesh.draw(gl);
      gl.depthFunc(this.reversedDepth ? gl.GEQUAL : gl.LEQUAL);
      if (tint !== null) gl.uniform3fv(u['uTint'] ?? null, WHITE_TINT);
      if (program !== null) this.useFlatProgram();
      return;
    }
    gl.enable(gl.POLYGON_OFFSET_FILL);
    /*
     * **The sign follows the compare**, which `depthOffsetForLayer` owns: `POLYGON_OFFSET_FILL`
     * adds to depth, so under `LESS` nearer is smaller and an overlay is pulled forward with a
     * negative offset, while under `GREATER` that same nudge would push it *behind* the surface it
     * belongs to. The symptom of getting it wrong is a marking vanishing into the road, which
     * reads as a draw call that never happened.
     *
     * A context that did not grant `EXT_clip_control` runs conventional depth whatever the
     * convention asks for, so the sign is taken from what this renderer actually got.
     */
    const offset = depthOffsetForLayer(layer, this.reversedDepth);
    gl.polygonOffset(offset.slope, offset.units);
    mesh.draw(gl);
    gl.polygonOffset(0, 0);
    gl.disable(gl.POLYGON_OFFSET_FILL);
    if (program !== null) this.useFlatProgram();
    gl.depthFunc(this.reversedDepth ? gl.GEQUAL : gl.LEQUAL);
    if (tint !== null) gl.uniform3fv(u['uTint'] ?? null, WHITE_TINT);
  }

  /**
   * Draw a mesh you can see through, in the same material as everything else by default.
   *
   * For geometry that is *present* without being solid — a sign hung in the air, a
   * hologram, a marker over a course. Lit, fogged and shaded exactly as the world
   * is, because it belongs to the world; the only difference is that the world
   * carries on behind it.
   *
   * **`options` turns either of those off, and it is the same draw doing it rather than a
   * second one.** Geometry, blend state and depth behaviour are unchanged either way; only
   * whether the fragment stage runs lighting and fog differs. See `TranslucentMeshOptions`
   * for what each half means and why they are independent. A glow shell or a flat backdrop
   * plate that needs to read exactly its own colour — three.js's `meshBasicMaterial` — is
   * `{ lit: false, fog: false }`; everything that called this before keeps drawing lit and
   * fogged, since both default to `true`.
   *
   * **It writes depth**, unlike every other blended pass here, and that is not an
   * oversight. The sky is drawn last, as a full-screen triangle that fills every
   * pixel the world left untouched — so anything translucent that declined to
   * write depth is simply painted over wherever it stood against open air.
   * The first version showed it plainly: a gate came out half visible, clipped away
   * except for the part that overlapped the deck behind it. A sign hung in the
   * air is exactly the case that stands against the sky.
   *
   * The cost is the usual one: two translucent surfaces in this pass sort by depth instead of
   * blending through each other, and which of an overlapping pair survives is the order they
   * were submitted in. **`{ depthWrite: false }` is the tool for a caller with overlapping
   * glass**, and it was missing for as long as this paragraph named it without providing it —
   * a consumer importing vehicles found it on a model whose interior is 96 blended surfaces
   * inside a shell. `{ depthLayer }` is the other half, for a blended surface *coplanar* with
   * what it decorates, which no ordering can separate. What it buys is that the piece
   * exists in the depth buffer like everything else in the world.
   *
   * Back faces stay culled, so a closed shape blends once rather than twice, and
   * a marker seen from below reads the same weight as one seen from above.
   *
   * Call inside the flat pass, after the opaque draws. Everything it changes is
   * handed straight back.
   */
  drawTranslucentMesh(
    mesh: Mesh,
    model: ReadonlyMat4,
    opacity: number,
    options: TranslucentMeshOptions = {},
  ): void {
    if (this.contextLost) return;
    /* Geometry that has not all arrived is not drawn. See `Mesh.complete`. */
    if (!mesh.complete) return;

    if (opacity <= 0) return;

    /*
     * **Recorded rather than drawn**, when the effect is on and this is not already the replay.
     * The two buffers are two blend states over the same geometry, so the set has to survive until
     * the end of the pass. Everything is copied — see `TranslucentQueue`.
     */
    if (this.oitActive && !this.oitReplaying) {
      this.translucentQueue.record(mesh, model, opacity, options);
      return;
    }
    /* Counted where it is submitted, as the other backend counts it: once per replay pass under
       order-independent transparency, and not once more when it was recorded. */
    this.drawBudget.ask();

    const { gl } = this;
    const u = this.flatUniforms;
    this.useFlatProgram();
    gl.uniformMatrix4fv(u['uModel'] ?? null, false, model);
    gl.uniform1f(u['uOpacity'] ?? null, Math.min(opacity, 1));
    /*
     * Both default to what `bindMeshPass` already put there — lit and fogged — so the
     * common call with no fourth argument writes the same two values it always implicitly
     * drew with, and only a caller that asks pays for the branch that skips them.
     */
    const lit = options.lit ?? true;
    const fog = options.fog ?? true;
    const toneMapped = options.toneMapped ?? true;
    if (!lit) gl.uniform1i(u['uLightingEnabled'] ?? null, 0);
    if (!fog) gl.uniform1i(u['uFogEnabled'] ?? null, 0);
    /* `1` is sRGB alone: the conversion without the curve, which is what dropping the tone map
       means rather than dropping the whole transform. `Math.min` rather than a literal, so a
       renderer asked for `none` stays at none and one asked for `srgb` is already there. */
    if (!toneMapped) gl.uniform1i(u['uOutputTransform'] ?? null, Math.min(this.gradeCode(), 1));
    /* Scoped and handed back like every other state here, so a tinted draw cannot leak its
       colour onto the next one. See `TranslucentMeshOptions.tint`. */
    const tint = options.tint ?? null;
    if (tint !== null) gl.uniform3fv(u['uTint'] ?? null, tint);
    /*
     * **Refraction, and the snapshot it reads is latched at the first draw that asks.**
     *
     * A frame that refracts nothing takes no copy at all, which is what keeps this off the bill of
     * every consumer who never wants glass. The rest of the frame reuses that one copy, so glass
     * does not refract other glass -- correct, a pane behind a pane should show the room -- and
     * opaque geometry drawn *after* the first pane is missing from what a pane shows. Draw the
     * world, then the glass; `SceneTarget.snapshotColor` carries the same trap `snapshotDepth`
     * documents.
     *
     * **A null snapshot leaves the strength at zero**, so the draw shades as an ordinary
     * translucent one rather than sampling a black texture and painting the pane the colour of a
     * hole. That is the defined state the two-backends rule asks for instead of a silent no-op.
     */
    const refraction = options.refraction ?? 0;
    let refracting = false;
    if (refraction > 0) {
      const snapshot = this.sceneTarget?.snapshotColor() ?? null;
      if (snapshot !== null) {
        refracting = true;
        gl.activeTexture(gl.TEXTURE0 + REFRACT_SCENE_TEXTURE_UNIT);
        gl.bindTexture(gl.TEXTURE_2D, snapshot);
        gl.uniform1f(u['uRefractStrength'] ?? null, refraction);
        gl.uniform3fv(u['uRefractTint'] ?? null, options.refractTint ?? WHITE_TINT);
        gl.uniform1f(u['uRefractThickness'] ?? null, options.thicknessM ?? 0);
      }
    }
    /*
     * **The blend and the depth mask belong to whoever owns the pass.** In the ordinary case that
     * is this draw; during an order-independent replay it is `OitPass`, which has set an additive
     * or a multiplicative blend for the whole set and turned depth writes off for all of it. A
     * replayed draw that reset either would break the pass around it.
     */
    /* Taken for itself when any option differs from the pass, and put back below: the rule both
       backends count material changes by. See `materialChanges.ts`. */
    const own = ownsMaterial({ opacity, lit, fog, toneMapped, refracting });
    if (own) this.materials.dirty();
    this.takeMaterial();
    const ownsState = !this.oitReplaying;
    if (ownsState) {
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    }
    /*
     * The two depth options, both scoped to this draw and handed straight back — the same
     * discipline every other state here keeps, and the reason a caller may set either on one
     * draw without reasoning about the next.
     *
     * On the other backend both of these are baked into a pipeline, because WebGPU has no way to
     * toggle them around a draw. `depthOffsetForLayer` is what keeps the two answers the same.
     */
    const depthWrite = options.depthWrite ?? true;
    if (!depthWrite && ownsState) gl.depthMask(false);
    const offset = depthOffsetForLayer(options.depthLayer ?? 0, this.reversedDepth);
    if (offset.units !== 0) {
      gl.enable(gl.POLYGON_OFFSET_FILL);
      gl.polygonOffset(offset.slope, offset.units);
    }
    mesh.draw(gl);
    if (offset.units !== 0) {
      gl.polygonOffset(0, 0);
      gl.disable(gl.POLYGON_OFFSET_FILL);
    }
    if (!depthWrite && ownsState) gl.depthMask(true);
    if (ownsState) gl.disable(gl.BLEND);
    gl.uniform1f(u['uOpacity'] ?? null, 1);
    if (tint !== null) gl.uniform3fv(u['uTint'] ?? null, WHITE_TINT);
    /* Put back for whatever is drawn next, exactly as `uOpacity` and `uTint` are — a pass
       cannot inherit a material from the draw before it. */
    if (!lit) gl.uniform1i(u['uLightingEnabled'] ?? null, 1);
    if (!fog) gl.uniform1i(u['uFogEnabled'] ?? null, 1);
    if (!toneMapped) gl.uniform1i(u['uOutputTransform'] ?? null, this.gradeCode());
    if (own) this.materials.dirty();
  }

  /**
   * Capture the room into a cubemap, once, so reflective surfaces can mirror it.
   *
   * `drawFace` is handed a camera already aimed and submits the scene exactly as it would to
   * the screen: a `bindMeshPass`, the world's draws, the sky. It is called six times, and the
   * whole thing is one bake rather than anything per frame — six submissions at the moment a
   * caller says the room is finished, then a cubemap fetch per reflective pixel for ever after.
   *
   * **Called once the world exists and not before.** A probe baked in a constructor captures a
   * room that has not been built yet, which is a reflection of nothing that looks exactly like
   * a reflection of something.
   *
   * A no-op without `reflectionProbeSize`, and a no-op on a device with no spare texture unit,
   * so a caller may issue it unconditionally. Returns whether the room was captured, for a
   * caller that wants to say so.
   *
   * What it must not contain: the passes that bind framebuffers of their own. A shadow bake or
   * a planar reflection inside `drawFace` would unbind the probe's target halfway through a
   * face. Shadow maps baked *before* the probe are fine and are the normal arrangement, since
   * what the probe wants is the lit room.
   */
  /* **Re-enters the mesh pass only.** The callback runs six times and each is a chance to submit
     geometry, so whatever a consumer draws in a *later* pass is absent from the result: particles,
     light volumes and the sky are all drawn after the world and none of them appear here. That is
     right for what this is and it decides where a scene puts its geometry, which is why it is
     stated. A consumer whose sky is in a later pass gets a probe of a black hole; move it into the
     mesh pass. Reported from outside, where "submits the scene exactly as it would to the screen"
     was read as the whole frame. */
  bakeReflectionProbe(
    origin: Vec3,
    clearColor: Vec3,
    drawFace: (camera: Camera) => void,
    options?: ProbeBakeOptions,
  ): boolean {
    if (!this.setProbeGrid({ origin, spacing: UNIT_STEP, counts: SINGLE_PROBE })) return false;
    return this.bakeProbe(0, clearColor, drawFace, options);
  }

  /**
   * Declare where a grid's probes stand, and allocate the layers for them.
   *
   * **`texStorage3D` is immutable, so the layer count is fixed here and not grown later.** A grid
   * that already matches is left alone, which is what makes `bakeReflectionProbe` cheap to call
   * every time a scene rebakes its one probe.
   *
   * Answers false when no probe was allowed at all — no `reflectionProbeSize`, or a device with no
   * spare texture unit — so a caller may issue it unconditionally.
   */
  setProbeGrid(options: ProbeGridOptions): boolean {
    if (this.contextLost || this.probeCapture === null) return false;
    const grid = new ProbeGrid(options);
    const current = this.probes;
    if (current !== null && this.probeArray !== null && sameGrid(current, grid)) return true;

    this.probeArray?.dispose(this.gl);
    this.probes = grid;
    this.probeArray = new EnvProbeArray(
      this.gl,
      octahedralEdgeFor(this.quality.reflectionProbeSize),
      grid.layers,
      this.quality.hdrScene,
    );
    return this.probeArray.usable;
  }

  /**
   * Bake one probe of the declared grid: six faces into the scratch cube, then one convolution.
   *
   * **One probe per call, and that is the budget question a grid actually raises.** A bake is six
   * passes plus a convolution per level, which `prefilterEnvMap.ts` says is affordable only because
   * it happens once per scene; a grid multiplies it by the probe count. A consumer spreading
   * thirty-two probes over thirty-two frames is doing what the point-shadow pool already does.
   *
   * The grid is not sampled until every layer has been filled, so a scene paced this way keeps the
   * gradient it had until the last probe lands rather than showing half a grid.
   */
  bakeProbe(
    layer: number,
    clearColor: Vec3,
    drawFace: (camera: Camera) => void,
    options?: ProbeBakeOptions,
  ): boolean {
    if (this.contextLost) return false;
    const probe = this.probeCapture;
    const array = this.probeArray;
    const grid = this.probes;
    if (probe === null || array === null || grid === null) return false;
    if (layer < 0 || layer >= grid.layers) return false;

    this.probeAmbient = options?.irradiance ?? true;
    grid.positionOf(layer, this.probeOrigin);

    this.probePassActive = true;
    /*
     * **A probe stores radiance, not display pixels.**
     *
     * `gradeCode()` is the ACES curve and the sRGB encode whenever the frame has no HDR target,
     * so every face was baked through the whole output transform and the shader then sampled the
     * result as though it were light. Two things came of that and both read as "the reflection is
     * dull": the curve pulls everything bright toward 1 *before* it reaches the cube, so no
     * highlight survives to be reflected at all, and the sRGB encode lifts the mid-tones, so what
     * does survive is washed out. The frame then applies the same transform a second time to a
     * value that already carries it.
     *
     * Held at 0 for the bake and put back after. `uOutputExposure` goes with it: an exposure is
     * part of the same viewing transform and has no business inside a stored radiance either.
     */
    this.useFlatProgram();
    this.gl.uniform1i(this.flatUniforms['uOutputTransform'] ?? null, 0);
    this.gl.uniform1f(this.flatUniforms['uOutputExposure'] ?? null, 1);
    this.materials.dirty();
    /*
     * **Clockwise for the duration, because a face is rendered mirrored.** `cubeFaceProjection`
     * negates clip y so the face is stored the way a cubemap reads it, and negating one axis
     * reverses every triangle's winding: without this the room is culled inside out and the cube
     * holds its own back faces.
     *
     * **A perturbation survives this line and it is kept anyway**, which is worth the sentence.
     * Deleting it moves `ibl-check.mjs`'s figures — 12.5 to 13.1 of 255 on the movement check and
     * 182.0 to 184.9 on the mirror rung — so it is not dead; but no check *fails*, because every
     * room this repository bakes into a probe is made of closed boxes whose two sides carry the
     * same colour, and looking at the far one's outside instead of the near one's inside draws
     * almost the same picture. What it actually decides is a scene with **one-sided** geometry: a
     * room built from single quads facing inward disappears from its own probe without it, and
     * there is no such scene here to fail on.
     */
    this.gl.frontFace(this.gl.CW);
    let baked = false;
    try {
      baked = probe.bake(this.gl, this.probeOrigin, clearColor, drawFace);
      /*
       * The convolution, immediately after the faces and inside the same guard, because it reads
       * the chain `bake` has just generated. A bake that failed leaves the layer untouched rather
       * than convolving whatever the driver left in the capture.
       */
      if (baked && this.environmentPrefilter !== null) {
        this.environmentPrefilter.run(
          this.gl,
          probe,
          array,
          layer,
          ENVIRONMENT_TEXTURE_UNIT,
          this.quality.environmentPrefilterSamples,
          this.quality.environmentPrefilter,
        );
      }
    } finally {
      this.gl.frontFace(this.gl.CCW);
      this.useFlatProgram();
      this.gl.uniform1i(this.flatUniforms['uOutputTransform'] ?? null, this.gradeCode());
      this.gl.uniform1f(this.flatUniforms['uOutputExposure'] ?? null, this.gradeExposure());
      this.materials.dirty();
      /*
       * Cleared even if a caller's own draw threw, because leaving this set would keep every
       * later frame reading the placeholder and quietly reflecting nothing.
       */
      this.probePassActive = false;
      /* Back to the canvas, or to the frame's own target if one is bound. See `SceneTarget`. */
      if (this.sceneTarget !== null && !this.framePresented) this.sceneTarget.bind();
      else {
        this.gl.bindFramebuffer(this.gl.FRAMEBUFFER, null);
        this.gl.viewport(0, 0, this.canvas.width, this.canvas.height);
      }
    }
    return baked;
  }

  /**
   * Bake every probe of the declared grid, in one call.
   *
   * The whole grid at once, for a scene that can afford a stall at load. `bakeProbe` is the same
   * work paced by the caller, and a grid of any size is worth pacing.
   */
  bakeProbeGrid(
    clearColor: Vec3,
    drawFace: (camera: Camera) => void,
    options?: ProbeBakeOptions,
  ): boolean {
    const grid = this.probes;
    if (grid === null) return false;
    let all = true;
    for (let layer = 0; layer < grid.layers; layer++) {
      if (!this.bakeProbe(layer, clearColor, drawFace, options)) all = false;
    }
    return all;
  }

  /**
   * Light the scene from an environment it did not photograph.
   *
   * **Downstream of the capture this is exactly a bake**, which is the whole design: the faces are
   * uploaded into the same cube a bake fills and the same convolution runs over them. A loaded sky
   * is therefore not a second lighting path that can be wrong on its own.
   *
   * A loaded environment is a grid of one, at the origin, because it is the same everywhere.
   */
  setEnvironmentImage(
    image: {
      readonly width: number;
      readonly height: number;
      readonly data: Float32Array;
    },
    options?: ProbeBakeOptions,
  ): boolean {
    const probe = this.probeCapture;
    if (probe === null) {
      /* In words rather than quietly, because the difference between "no probe was allowed" and
         "the environment did nothing" is invisible in the picture and both look like a bug here. */
      console.warn(
        'Renderer: setEnvironmentImage was called on a profile with no reflection probe, so the ' +
          'environment was ignored. Set `reflectionProbeSize` to allocate one.',
      );
      return false;
    }
    if (!this.setProbeGrid({ origin: WORLD_ORIGIN, spacing: UNIT_STEP, counts: SINGLE_PROBE })) {
      return false;
    }
    const array = this.probeArray;
    if (array === null) return false;
    if (!probe.upload(this.gl, equirectToCubeFaces(image, probe.size))) return false;
    this.probeAmbient = options?.irradiance ?? true;
    this.environmentPrefilter?.run(
      this.gl,
      probe,
      array,
      0,
      ENVIRONMENT_TEXTURE_UNIT,
      this.quality.environmentPrefilterSamples,
      this.quality.environmentPrefilter,
    );
    return true;
  }

  /**
   * Draw a volume of light: a beam from a lamp, a shaft through a window, the cone under a
   * street light.
   *
   * **Not a material, and that is the whole point of it being a separate call.** Everything
   * `drawMesh` does to a surface is wrong for light: it lights it, fogs it toward the medium's
   * colour, and scales its emissive by how dark the world is. Light is what the fog is *made
   * of*; a beam is more visible in mist, not less. This pass adds, and does nothing else.
   *
   * Two attempts to express a beam as geometry in the flat pass failed, in opposite
   * directions, and both are worth knowing before reaching for a material again. Alpha blended
   * it *subtracted*: blending moves the background toward the surface's own colour, so an unlit
   * wedge darker than the dusk behind it swept a solid dark shape across the frame, which was
   * reported five times as a bird. Made additive but still fogged, ninety metres of it
   * multiplied down to nothing at twenty times the emissive.
   *
   * **What the caller supplies is a closed hull, and the pass walks the view ray inside it.**
   * The geometry decides which pixels run and nothing else: every one of them integrates the
   * air along its own line of sight, so the path length that makes a volume read as a volume
   * comes out of the walk rather than being modelled.
   *
   * It used to rasterise a few flat panes through the axis and weight each fragment by how far
   * from face-on its pane was turned, which stands in for that path length and works from the
   * side. It cannot work down the barrel: every pane contains the axis, so a view lying near
   * that axis lies nearly within all of them at once, each collapses to a narrow bright wedge,
   * and their union reads as a six-armed asterisk instead of a disc. Reported twice from
   * outside — as a beam whose shape never changed however it was tuned, and as raw lines in the
   * opening of a room — and no correction to the weight could have fixed either, because the
   * fault was that a handful of flat sheets is not a volume.
   *
   * Culling is off, because a volume seen from inside is still lit. Depth *testing* stays on,
   * so a beam passes behind whatever stands in front of it; depth *writing* is off, because a
   * volume of light occludes nothing.
   *
   * **The volume opens from its own origin along its local +Z**, and `length` and `spread` say
   * how far and how wide: `spread` is half-width over distance, so the tangent of the
   * half-angle. The shader fades the light to nothing at that length and at that aperture,
   * which is what lets a beam dissolve into the air rather than stop at a bright square, and
   * it is why the hull can be a coarse frustum rather than anything shaped like light.
   * Building the gradient into the geometry instead is a staircase, because `MeshBuilder`
   * states one emissive per quad.
   *
   * **All three numbers describe geometry this call cannot see, and each one fails silently
   * when it disagrees with the mesh.** `buildLightVolume` in `src/geometry/` builds the hull
   * from the same `length` and `spread` passed here, which is the way to have none of this
   * apply; the following is what a caller building its own has to get right, and every one of
   * them has been paid for from outside this repository.
   *
   * - **`length` is measured in the geometry's own units, not in world metres**, because the
   *   shader compares it against the untransformed vertex position. A beam authored as a unit
   *   wedge and placed with an orthonormal basis is *one unit long* whatever `length` says, so
   *   a length of 7.4 puts the whole mesh inside the first 13% of its own falloff and the beam
   *   is invisible. Either the model matrix carries the scale, or the hull is built at world
   *   size. There is no error and no warning: the draw succeeds and nothing appears.
   * - **`spread` has to be at or under the geometry's own flare**, since the across-axis fade
   *   reaches zero at this aperture and clamps there. Wider than the hull and the fade is still
   *   climbing where the hull ends, which cuts the volume instead of dissolving it. Narrower is
   *   safe and merely reads as a beam thinner than its own silhouette.
   * - **`strength` is clamped to 1.** Raising it is the natural response to a beam that looks
   *   faint, and above 1 it does nothing at all — so a faint beam is one of the two faults
   *   above, or a colour and emissive that are too low in the mesh itself.
   *
   * `strength` fades the whole thing, for a lamp coming up at dusk or dimming at dawn. At 0 it
   * draws nothing at all rather than adding black, so a caller may keep the call in the frame.
   */
  drawLightVolume(
    mesh: Mesh,
    model: ReadonlyMat4,
    camera: Camera,
    strength: number,
    length: number,
    spread: number,
    options: LightVolumeDrawOptions = {},
  ): void {
    if (this.contextLost) return;
    /* Geometry that has not all arrived is not drawn. See `Mesh.complete`. */
    if (!mesh.complete) return;
    const shown =
      options.medium === undefined
        ? strength
        : strength *
          volumeMediumGain(options.medium.atmosphere, model, options.medium.fullAtDensity);
    /* At zero it draws nothing rather than adding black — which now also covers a clear night,
       where the beam has no medium to be seen in and skipping it is the whole saving. */
    if (shown <= 0) return;
    this.lightVolumeBudget.ask();
    const { gl } = this;
    const u = this.lightVolumeUniforms;
    gl.useProgram(this.lightVolumeProgram);
    gl.uniformMatrix4fv(u['uViewProj'] ?? null, false, this.viewProjFor(camera));
    gl.uniformMatrix4fv(u['uModel'] ?? null, false, model);
    gl.uniform3fv(u['uCameraPos'] ?? null, camera.position);
    gl.uniform1f(u['uStrength'] ?? null, Math.min(shown, 1));
    gl.uniform1f(u['uLength'] ?? null, length);
    gl.uniform1f(u['uSpread'] ?? null, spread);
    gl.uniform1f(u['uDust'] ?? null, clamp(options.dust ?? 0, 0, 1));
    gl.uniform1f(u['uDustScale'] ?? null, options.dustScaleM ?? 1);
    gl.uniform3fv(u['uDustOffset'] ?? null, options.driftM ?? NO_DRIFT);
    gl.uniformMatrix4fv(u['uModelWorld'] ?? null, false, model);
    gl.uniform1f(u['uNear'] ?? null, options.nearM ?? 0);
    gl.uniform1i(u['uSamples'] ?? null, this.quality.lightVolumeSamples);

    /*
     * The camera in the volume's own space, and which half of the hull to keep.
     *
     * Both are chosen by `resolveLightVolume` rather than here, because both are rules rather
     * than bindings and a second copy of either is a beam that behaves differently depending
     * on which backend drew it. See that module, and `AGENTS.md` 2026-08-13.
     */
    const { cameraLocal, inside } = resolveLightVolume(
      model,
      camera.position,
      length,
      spread,
      this.volume,
    );

    /*
     * The sun's map, bound only where the program has somewhere to put it.
     *
     * Two conditions rather than one: the permutation decides whether the samplers exist at
     * all, and a caller that did not ask for the term still has to zero it, or a beam drawn
     * after a shaft would inherit the shaft's uniform. The placeholder rather than `null`
     * where a map is merely absent, for the reason `emptyTexture.ts` gives.
     */
    if (this.quality.directionalShadows) {
      const env = options.env;
      const sunShadow = env === undefined ? 0 : clamp(options.sunShadow ?? 0, 0, 1);
      gl.uniform1f(u['uSunShadow'] ?? null, sunShadow);
      if (sunShadow > 0 && env !== undefined) {
        /* Uncorrected, for the reason the lit program's copy of this line carries: the shaft's
           lookup does its own `* 0.5 + 0.5` and correcting the matrix as well doubles it. */
        gl.uniformMatrix4fv(u['uLightViewProj'] ?? null, false, env.lightViewProj);
        gl.uniform1f(u['uShadowMapSize'] ?? null, this.quality.directionalShadowMapSize);
        gl.uniform1i(u['uPeeledShadowEnabled'] ?? null, this.peeledShadowMap === null ? 0 : 1);

        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, this.shadowMap?.texture ?? this.emptyTexture2D);
        gl.uniform1i(u['uStaticShadowMap'] ?? null, 0);

        gl.activeTexture(gl.TEXTURE1);
        gl.bindTexture(gl.TEXTURE_2D, this.peeledShadowMap?.texture ?? this.emptyTexture2D);
        gl.uniform1i(u['uPeeledShadowMap'] ?? null, 1);

        gl.activeTexture(gl.TEXTURE2);
        gl.bindTexture(gl.TEXTURE_2D, this.dynamicShadowMap?.texture ?? this.emptyTexture2D);
        gl.uniform1i(u['uDynamicShadowMap'] ?? null, 2);
      }
    }

    gl.uniform3fv(u['uCameraLocal'] ?? null, cameraLocal);

    /*
     * The clamp that makes a beam end where the light lands, and the snapshot it reads.
     *
     * **A copy of the depth and never the attachment**, which is `SceneTarget.snapshotDepth`'s
     * whole reason for existing: sampling a texture that is attached to the bound framebuffer is
     * undefined in WebGL2, and undefined here means a plausible picture on this driver and a
     * different one on the next.
     *
     * Off where there is no scene target to copy from — a profile with no screen effects draws
     * straight to the canvas, whose depth is a renderbuffer that cannot be sampled at all. The
     * WebGPU path reaches the same answer for the same profile, which is the parity that matters:
     * the two agree about *when* a beam is clamped, not merely about how.
     *
     * `uDepthToLocal` is built from the **raw** view-projection on both backends, and that is not
     * an oversight on the other one. What differs there is the framebuffer's direction, and it
     * is carried by a matrix of its own: see `DEPTH_01_TO_CLIP_Y_DOWN` beside the one used here.
     */
    const snapshot = this.sceneTarget?.snapshotDepth() ?? null;
    gl.uniform1i(u['uSceneDepthEnabled'] ?? null, snapshot === null ? 0 : 1);
    if (snapshot !== null) {
      gl.uniform2f(
        u['uInvViewport'] ?? null,
        1 / Math.max(1, gl.drawingBufferWidth),
        1 / Math.max(1, gl.drawingBufferHeight),
      );
      mat4.multiply(this.volumeDepthScratch, camera.viewProjection, model);
      mat4.invert(this.volumeDepthToLocal, this.volumeDepthScratch);
      mat4.multiply(this.volumeDepthToLocal, this.volumeDepthToLocal, DEPTH_01_TO_CLIP);
      gl.uniformMatrix4fv(u['uDepthToLocal'] ?? null, false, this.volumeDepthToLocal);
      /* Unit 3: the three shadow layers above hold 0, 1 and 2 whenever they are bound. */
      gl.activeTexture(gl.TEXTURE3);
      gl.bindTexture(gl.TEXTURE_2D, snapshot);
      gl.uniform1i(u['uSceneDepth'] ?? null, 3);
    }

    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE);
    gl.depthMask(false);
    gl.cullFace(inside ? gl.FRONT : gl.BACK);
    mesh.draw(gl);
    gl.cullFace(gl.BACK);
    gl.depthMask(true);
    gl.disable(gl.BLEND);
  }

  /**
   * Draw a thin wet film — an oil slick, a puddle, a wet patch — over the world.
   *
   * Its own pass because it is its own material: view-dependent iridescence and a
   * dissolving edge, neither of which the flat shader can express. It runs *after*
   * the world with depth writes off and blending on, so a slick lies on the
   * surface it was built against instead of fighting it for the depth buffer.
   *
   * The caller never sees a GL call: it hands over a mesh, the camera, the clock
   * and how strong the sheen should be.
   *
   * **`sheen` is iridescence, not wetness, and the two are not the same dial.** Raising it to
   * make a road look wetter makes it look oilier: the surface bands green to magenta like fuel
   * on water, because that is what the term models. A consumer found the usable range for wet
   * tarmac at night by bisection twice, at 0.7 and again at 0.24, and landed on **0.15 to
   * 0.18**. Start there rather than repeating the search.
   *
   * There is no mirror term here to raise instead. A surface that should reflect the scene
   * rather than shimmer needs a planar pass, and `beginPlanarReflection` is water-only; see the
   * comment on it. Splitting the two is an open request from outside and is not built.
   */
  drawFilm(
    mesh: Mesh,
    camera: Camera,
    timeSeconds: number,
    env: Environment,
    sheen: number,
    options: FilmOptions = {},
  ): void {
    const { gl } = this;
    const u = this.filmUniforms;
    gl.useProgram(this.filmProgram);
    gl.uniformMatrix4fv(u['uViewProj'] ?? null, false, this.viewProjFor(camera));

    /*
     * The mirrored scene, where this film lies on the plane one was rendered for.
     *
     * `isReadyFor` is what ties the two together, so a film on a plane the reflection was not
     * rendered for simply gets none rather than a mirror of somewhere else. The caller therefore
     * does not restate the plane here: `beginPlanarReflection` already established it, and a
     * second statement of the same number is a second thing to keep in step.
     */
    const filmReflection = this.planarReflection;
    const mirrorStrength = options.reflectionStrength ?? 0;
    const mirrorReady =
      mirrorStrength > 0 &&
      filmReflection !== null &&
      !this.reflectionPassActive &&
      filmReflection.isReadyFor(options.reflectionPlaneY ?? 0);
    gl.uniformMatrix4fv(
      u['uReflectionViewProj'] ?? null,
      false,
      mirrorReady && filmReflection !== null
        ? filmReflection.viewProjection
        : camera.viewProjection,
    );
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(
      gl.TEXTURE_2D,
      mirrorReady && filmReflection !== null ? filmReflection.texture : null,
    );
    gl.uniform1i(u['uReflectionMap'] ?? null, 0);
    gl.uniform1i(u['uReflectionEnabled'] ?? null, mirrorReady ? 1 : 0);
    gl.uniform1f(u['uReflectionStrength'] ?? null, mirrorReady ? mirrorStrength : 0);
    gl.uniform3fv(u['uCameraPos'] ?? null, camera.position);
    gl.uniform1f(u['uTime'] ?? null, timeSeconds);
    gl.uniform1f(u['uSheen'] ?? null, sheen);
    gl.uniform1f(u['uFilmRoughness'] ?? null, Math.min(1, Math.max(0, options.roughness ?? 0)));
    gl.uniform1f(
      u['uFilmRoughnessCycles'] ?? null,
      Math.max(0.01, options.roughnessCyclesPerMetre ?? 60),
    );
    gl.uniform1i(u['uClipEnabled'] ?? null, this.reflectionPassActive ? 1 : 0);
    const reflection = this.planarReflection;
    if (this.reflectionPassActive && reflection !== null) {
      gl.uniform4fv(u['uClipPlane'] ?? null, reflection.clipPlane);
    }
    bindAtmosphere(
      gl,
      u,
      env,
      this.reflectionPassActive ? this.reflectionAtmosphereY : (camera.position[1] ?? 0),
      this.quality.underwaterAtmosphere,
    );

    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    gl.depthMask(false);
    mesh.draw(gl);
    gl.depthMask(true);
    gl.disable(gl.BLEND);
  }

  /**
   * Scale one plume in a batch, 0 to hide it.
   *
   * For a fire that is not always burning — an oil slick on its ignition cycle. The caller owns
   * *when*; nothing here knows what a slick is.
   */
  setPlumeScale(plumes: PlumeRenderer, index: number, scale: number): void {
    plumes.setScale(this.gl, index, scale);
  }

  /** Draw last: the sky only fills pixels the world left untouched. */
  drawSky(camera: Camera, sky: SkyColors, env: Environment): void {
    const { gl } = this;
    const u = this.skyUniforms;
    gl.useProgram(this.skyProgram);
    gl.uniformMatrix4fv(u['uInvViewProj'] ?? null, false, camera.invViewProjection);
    gl.uniform3fv(u['uCameraPos'] ?? null, camera.position);
    gl.uniform3fv(u['uTopColor'] ?? null, sky.top);
    gl.uniform3fv(u['uHorizonColor'] ?? null, sky.horizon);
    gl.uniform3fv(u['uDeepColor'] ?? null, sky.deep);
    gl.uniform3fv(u['uSunDir'] ?? null, sky.sunDir);
    gl.uniform3fv(u['uSunColor'] ?? null, sky.sunColor);
    gl.uniform1f(u['uSunDiscExponent'] ?? null, angularDiscExponent(sky.sunAngularRadius));
    gl.uniform3fv(u['uMoonDir'] ?? null, sky.moonDir);
    gl.uniform3fv(u['uMoonColor'] ?? null, sky.moonColor);
    gl.uniform1f(u['uMoonAngularRadius'] ?? null, sky.moonAngularRadius);
    gl.uniform1f(u['uMoonPhase'] ?? null, sky.moonPhase);
    gl.uniform1f(u['uNightFactor'] ?? null, sky.nightFactor);
    gl.uniform2f(u['uCloudOffset'] ?? null, sky.cloudOffsetX, sky.cloudOffsetZ);
    bindAtmosphere(
      gl,
      u,
      env,
      this.reflectionPassActive ? this.reflectionAtmosphereY : (camera.position[1] ?? 0),
      this.quality.underwaterAtmosphere,
    );

    gl.bindVertexArray(this.skyVao);
    gl.depthMask(false);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.depthMask(true);
    gl.bindVertexArray(null);
  }

  /**
   * What is under a pixel, for a consumer that has to answer a click.
   *
   * The engine says *what*, and nothing else: enter, leave, capture, bubbling and the
   * difference between a click and a drag are the consumer's, which already has that
   * logic for anything with a drag in it. An event system here would be a second one,
   * disagreeing with the first.
   */
  registerPickable(source: PickableSource, model: Float32Array): number {
    return this.pickables.add(source, model);
  }

  updatePickable(handle: number, model: Float32Array): void {
    this.pickables.update(handle, model);
  }

  unregisterPickable(handle: number): void {
    this.pickables.remove(handle);
  }

  pickAt(camera: Camera, cssX: number, cssY: number): PickHit | null {
    camera.rayThrough(
      this.pickOrigin,
      this.pickDirection,
      cssX,
      cssY,
      this.cssWidth,
      this.cssHeight,
    );
    return this.pickables.pick(this.pickOrigin, this.pickDirection);
  }
}

/** Gaussian-disc exponent whose half-intensity point is `angularRadius`. */
function angularDiscExponent(angularRadius: number): number {
  const finiteRadius = Number.isFinite(angularRadius) ? angularRadius : 0.001;
  const radius = Math.min(Math.max(finiteRadius, 0.001), 0.5);
  return Math.LN2 / -Math.log(Math.cos(radius));
}

/**
 * The name this class had until 2026-08-24, kept because it is on the public barrel.
 *
 * **An alias rather than a rename with a migration**, because nothing measured needs one: no
 * consumer in this repository binds either renderer class. Every one of them reaches the engine
 * through `createRenderer` and holds the result as `RendererApi`, which is the surface both
 * backends implement — so the concrete class is an implementation detail everywhere but here.
 *
 * **What it costs**: two names for one class, and a reader who meets `Renderer` has to learn it
 * means the WebGL2 one. **What would make it wrong**: a consumer starting to bind it, which would
 * turn a free alias into a migration owed. Nothing does today, and `docs/PORTING.md` says which
 * name to prefer. It goes when something else forces a major, and not before.
 */
export { WebGL2Renderer as Renderer };
