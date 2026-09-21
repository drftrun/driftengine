import { mat4 } from 'gl-matrix';
import type { ProbeBakeOptions } from '../../reflectionProbe.ts';
import {
  TEMPORAL_HISTORY_BLEND,
  TemporalHistory,
  jitterOffset,
  jitterProjection,
} from '../../temporalAa.ts';
import { OIT_MULTISAMPLE_REFUSAL } from '../../orderIndependent.ts';
import { TranslucentQueue } from '../../translucentQueue.ts';
import {
  DEPTH_CLEAR,
  DEPTH_COMPARE_EQUAL,
  MAX_DEPTH_LAYER,
  REVERSED_DEPTH,
} from '../../depthConvention.ts';
import { RECONSTRUCTION_MULTISAMPLE_REFUSAL, reconRenderSize } from '../../recon/frameSizes.ts';
import { jitterOffset as jitterOffsetFor, reconJitterPhases } from '../../recon/jitter.ts';
import {
  RECON_HISTORY_FORMAT,
  RECON_PARAM_FLOATS,
  RECON_WORKGROUP,
  reconResolveWgsl,
} from '../../shaders/recon/resolve.wgsl.ts';
import {
  MOTION_DRAW_FLOATS,
  MOTION_DRAW_STRIDE,
  MOTION_FRAME_FLOATS,
  MOTION_TARGET_FORMAT,
  RECON_MOTION_WGSL,
} from '../../shaders/recon/motion.wgsl.ts';
import { DEFAULT_DISOCCLUSION } from '../../recon/disocclusion.ts';
import { DEFAULT_RECON_QUALITY } from '../../recon/resolve.ts';
import type { ReadonlyMat4 } from 'gl-matrix';

import type { Vec3 } from '../../../math/color.ts';
import { clamp } from '../../../math/scalar.ts';
import { Camera } from '../../camera.ts';
import { PickableSet } from '../../pickable.ts';
import type { PickHit, PickableSource } from '../../pickable.ts';
import type { RendererApi } from '../api.ts';
import { GpuTimestamps } from './gpuTimestamps.ts';
import { isWeakGpuFamily } from '../../gpuCapability.ts';
import type {
  Environment,
  FilmOptions,
  InsetRect,
  LightVolumeDrawOptions,
  SkyColors,
  TranslucentMeshOptions,
} from '../webgl2/renderer.ts';
import type { IncrementalMeshHandle, MeshOptions } from '../api.ts';
import { resolveAtmosphere, type ResolvedAtmosphere } from '../../atmosphere.ts';
import {
  BLOOM_FILTER_RADIUS_UV,
  BLOOM_LEVELS,
  bloomLevelSizes,
  bloomProfileWarning,
} from '../../bloomChain.ts';
import {
  createResolvedWater,
  resolveWater,
  waterAppearance,
  type ResolvedWater,
} from '../../waterDraw.ts';
import type { WaterBody } from '../../waterRenderer.ts';
import {
  createResolvedLightVolume,
  DEPTH_01_TO_CLIP_Y_DOWN,
  resolveLightVolume,
  type ResolvedLightVolume,
  volumeMediumGain,
} from '../../lightVolumeDraw.ts';
import {
  WIND_STREAK_DEFAULTS,
  createResolvedWindStreaks,
  resolveWindStreaks,
  type ResolvedWindStreaks,
} from '../../windStreakDraw.ts';
import type { WindStreakOptions } from '../../windStreakRenderer.ts';
import type { WindField } from '../../windField.ts';
import type { FlockParams } from '../../flockRenderer.ts';
import { expandBoltSegments, expandLineSegments } from '../../segmentQuads.ts';
import { LIVE_POINT_SHADOW_MAPS, MAX_POINT_LIGHTS, POINT_SHADOW_POOL } from '../../lightBudget.ts';
import { roughnessForLevel } from '../../prefilterEnvMap.ts';
import { equirectToCubeFaces } from '../../equirectToCube.ts';
import {
  MAX_ENV_PROBES,
  ProbeGrid,
  SINGLE_PROBE,
  UNIT_STEP,
  WORLD_ORIGIN,
  sameGrid,
} from '../../probeGrid.ts';
import type { ProbeGridOptions } from '../../probeGrid.ts';
import { ggxMaxLevelFor, irradianceLevelFor, octahedralEdgeFor } from '../../prefilterEnvMap.ts';
import { environmentTexels } from './environmentTexels.ts';
import { packIesAtlas } from '../../iesProfile.ts';
import { COOKIE_TILE } from '../../lightBudget.ts';
import { FULL_LIGHT_BUDGET } from '../../uniformVectorBudget.ts';
import { toHalfFloats } from '../../halfFloat.ts';
import type { PhotometricProfile } from '../../iesProfile.ts';

import {
  DEFAULT_SOURCE_RADIUS,
  FACE_COUNT,
  createResolvedPointShadows,
  type ResolvedPointShadows,
} from '../../pointShadowImage.ts';
import { MAX_AREA_LIGHTS, type AreaLightSource } from '../../areaLights.ts';
import {
  areaShadowLayerCount,
  castingRange,
  createResolvedAreaShadows,
  firstAreaShadowLayer,
  AreaShadowSet,
} from '../../areaShadowSet.ts';
import {
  createBakeScratch,
  runPointShadowBakes,
  selectCastingLights,
} from '../../pointShadowBudget.ts';
import {
  POINT_SHADOW_SAMPLER,
  PointShadowSystem,
  type ShadowLight,
} from '../../pointShadowSystem.ts';
import { GpuPointShadowArray, GpuPointShadowMap } from './pointShadowPass.ts';
import {
  createPanelBindGroup,
  createPanelBindGroupLayout,
  createPanelCorners,
  panelPipeline,
  PANEL_FRAG_FIELDS,
  PANEL_FRAG_SIZE,
  PANEL_VERTEX_COUNT,
  PANEL_VERT_FIELDS,
  PANEL_VERT_SIZE,
} from './panelPass.ts';
import {
  createGpuTextCube,
  createTextBindGroup,
  createTextBindGroupLayout,
  GpuText,
  textPipeline,
  TEXT_FRAG_FIELDS,
  TEXT_FRAG_SIZE,
  TEXT_VERT_FIELDS,
  TEXT_VERT_SIZE,
  type GpuTextCube,
} from './textPass.ts';
import type { TextStyle } from '../../textLayout.ts';
import { deviceSnappedCellSize, deviceSnappedOrigin } from '../../textLayout.ts';
import { GpuSurfaceTexture } from './surfaceTexturePass.ts';
import {
  createSdfTextBindGroup,
  createSdfTextBindGroupLayout,
  GpuSdfText,
  sdfTextPipeline,
  SDF_TEXT_FRAG_FIELDS,
  SDF_TEXT_FRAG_SIZE,
  SDF_TEXT_VERT_FIELDS,
  SDF_TEXT_VERT_SIZE,
} from './sdfTextPass.ts';
import type { SdfFont } from '../../sdfFont.ts';
import type { SdfTextStyle } from '../../sdfTextLayout.ts';
import {
  createFilmBindGroup,
  createFilmBindGroupLayout,
  filmPipeline,
  FILM_FRAG_FIELDS,
  FILM_FRAG_SIZE,
  FILM_VERT_FIELDS,
  FILM_VERT_SIZE,
} from './filmPass.ts';
import type { SurfaceMaterial, SurfaceTextureOptions } from '../../surfaceTexture.ts';
import type { RenderBackend } from '../api.ts';
import { reflectionTargetSize, type ReflectionSize } from '../../planarReflectionDraw.ts';
import { drawingBufferSize } from '../../drawingBuffer.ts';
import { MOTION_BLUR_MAX_UV, OUTPUT_TRANSFORM_CODE, RUSH_REACH_UV } from '../../vertexDefaults.ts';
import type { UniformFields } from './scatterPass.ts';
import {
  createDepthResolveLayout,
  createPostStageLayout,
  depthResolvePipeline,
  postPipeline,
  sceneColorFormat,
  AO_BLUR_FIELDS,
  AO_BLUR_FRAG_WGSL,
  AO_BLUR_SIZE,
  AO_BLUR_TEXTURES,
  AO_BLUR_UNIFORMS,
  AO_FRAG_FIELDS,
  AO_FRAG_SIZE,
  AO_FRAG_WGSL,
  AO_TEXTURES,
  AO_UNIFORMS,
  ADDITIVE_BLEND,
  BLOOM_DOWNSAMPLE_FIELDS,
  BLOOM_DOWNSAMPLE_FRAG_WGSL,
  BLOOM_PREFILTER_FIELDS,
  BLOOM_PREFILTER_FRAG_WGSL,
  BLOOM_STAGE_SIZE,
  BLOOM_TEXTURES,
  BLOOM_UNIFORMS,
  BLOOM_UPSAMPLE_FIELDS,
  BLOOM_UPSAMPLE_FRAG_WGSL,
  RESOLVED_DEPTH_FORMAT,
  RUSH_FRAG_FIELDS,
  RUSH_FRAG_SIZE,
  RUSH_FRAG_WGSL,
  RUSH_TEXTURES,
  RUSH_UNIFORMS,
  TAA_FRAG_FIELDS,
  TAA_FRAG_SIZE,
  TAA_TEXTURES,
  TAA_UNIFORMS,
  TEMPORAL_RESOLVE_FRAG_WGSL,
  MEDIUM_FRAG_FIELDS,
  MEDIUM_FRAG_SIZE,
  MEDIUM_FRAG_WGSL,
  MEDIUM_TEXTURES,
  MEDIUM_TRANSMIT_BLEND,
  MEDIUM_UNIFORMS,
  MEDIUM_UPSAMPLE_FIELDS,
  MEDIUM_UPSAMPLE_FRAG_WGSL,
  MEDIUM_UPSAMPLE_SIZE,
  MEDIUM_UPSAMPLE_TEXTURES,
  MEDIUM_UPSAMPLE_UNIFORMS,
  OIT_COMPOSITE_BLEND,
  OIT_RESOLVE_FRAG_WGSL,
  OIT_TEXTURES,
  DECAL_FRAG_FIELDS,
  DECAL_FRAG_SIZE,
  DECAL_MULTIPLY_BLEND,
  DECAL_PROJECT_FRAG_WGSL,
  DECAL_TEXTURES,
  DECAL_UNIFORMS,
  PREMULTIPLIED_OVER_BLEND,
  SSR_FRAG_FIELDS,
  SSR_FRAG_SIZE,
  SSR_RESOLVE_FRAG_WGSL,
  SSR_RESOLVE_TEXTURES,
  SSR_TEXTURES,
  SSR_TRACE_FRAG_WGSL,
  SSR_UNIFORMS,
  createOitResolveLayout,
  createSsrResolveLayout,
} from './postPass.ts';
import {
  type ColourGradeLut,
  GRADE_PLACEHOLDER_SIZE,
  identityGradeLut,
  validateGradeLut,
} from '../../colourGrade.ts';
import {
  createProbeMipBindGroupLayout,
  createProbePrefilterBindGroupLayout,
  PREFILTER_SAMPLER_BINDING,
  PREFILTER_TEXTURE_BINDING,
  PREFILTER_UNIFORM_BINDING,
  PREFILTER_UNIFORM_OFFSETS,
  probeLevels,
  probeMipPipeline,
  probePrefilterPipeline,
  PROBE_FACES,
  PROBE_FACE_BASIS,
  PROBE_FAR_M,
  PROBE_FOV_DEG,
  PROBE_MIP_UNIFORM_SIZE,
  PROBE_NEAR_M,
} from './probePass.ts';
import { CAUSTICS_CELL_M, CAUSTICS_MAX_DROP_M } from '../../causticsRenderer.ts';
import type { CausticSheet } from '../../causticsRenderer.ts';
import { buildSheets } from '../../surfaceSheet.ts';
import { seaStateForWind } from '../../seaState.ts';
import {
  causticsPipeline,
  createCausticsBindGroup,
  createCausticsBindGroupLayout,
  createGpuCaustics,
  CAUSTICS_FRAG_FIELDS,
  CAUSTICS_FRAG_SIZE,
  CAUSTICS_VERT_FIELDS,
  CAUSTICS_VERT_SIZE,
  type GpuCaustics,
} from './causticsPass.ts';
import {
  createInsetBindGroup,
  createInsetBindGroupLayout,
  insetPipeline,
  INSET_UNIFORM_SIZE,
} from './insetPass.ts';
import type { BoltSegments } from '../../boltPool.ts';
import type { LineSegments } from '../../linePoints.ts';
import { buildPlumeGeometry } from '../../plumeGeometry.ts';
import type { ParticleMaterial } from '../../particleMaterial.ts';
import type { ParticleBatchOptions } from '../../particleBatch.ts';
import type { ParticleInstances } from '../../particlePool.ts';
import { PARTICLE_INDICES } from '../../shaders/particle.ts';
import type { PlumeOptions, PlumePlacement } from '../../plumeRenderer.ts';
import type { InstanceData } from '../../instancedMesh.ts';
import {
  createScatterDeform,
  resolveScatterDeform,
  type ScatterDeform,
} from '../../scatterDeform.ts';
import { resolvePointLights, type ResolvedPointLights } from '../../lightBudget.ts';
import { resolveRenderQuality, type RenderQuality } from '../../renderQuality.ts';
import {
  DEFAULT_GLOBAL_MEDIUM,
  mediumActive,
  mediumTargetSize,
  WEAK_GPU_MEDIUM_STEPS,
  resolveGlobalMedium,
} from '../../globalMedium.ts';
import type { GlobalMediumOptions } from '../../globalMedium.ts';
import type { MeshData } from '../../mesh.ts';
import type { SceneCasterMaterial, ShadowCasterSink, ShadowCasters } from '../../shadowCasters.ts';
import { VERTEX_LAYOUT, createGpuMesh, createGpuMeshIncremental, type GpuMesh } from './buffers.ts';
import type { GpuSurface } from './device.ts';
import { SkinPaletteRing } from './skinPaletteRing.ts';
import {
  DEPTH_FORMAT,
  FLAT_VERT_FIELDS,
  FLAT_VERT_SIZE,
  createFlatBindGroup,
  createFlatBindGroupLayout,
  flatFragmentBindings,
  flatVariant,
  flatVertexBindings,
  type FlatVariant,
  flatPipeline,
  flatPipelineAsync,
} from './flatPass.ts';
import type { OitTarget } from './flatPass.ts';
import {
  DEPTH_FRAG_BINDING,
  DEPTH_FRAG_SIZE,
  DEPTH_FRAG_WGSL,
  DEPTH_PREVIOUS_BINDING,
  DEPTH_VERT_FIELDS,
  DEPTH_VERT_SIZE,
  SHADOW_FORMAT,
  createDepthBindGroup,
  createDepthBindGroupLayout,
  depthPipeline,
} from './depthPass.ts';
import { PipelineCache } from './pipelineCache.ts';
import {
  SKY_FIELDS,
  SKY_UNIFORM_SIZE,
  createSkyBindGroup,
  createSkyBindGroupLayout,
  skyPipeline,
} from './skyPass.ts';
import {
  SCATTER_DEPTH_FIELDS,
  SCATTER_DEPTH_SIZE,
  SCATTER_FRAG_FIELDS,
  SCATTER_FRAG_SIZE,
  SCATTER_VERT_FIELDS,
  SCATTER_VERT_SIZE,
  createGpuScatter,
  createScatterBindGroup,
  createScatterBindGroupLayout,
  createScatterDepthBindGroup,
  createScatterDepthBindGroupLayout,
  scatterDepthPipeline,
  scatterPipeline,
  type GpuScatter,
} from './scatterPass.ts';
import {
  WATER_FRAG_FIELDS,
  WATER_FRAG_SIZE,
  WATER_VERT_FIELDS,
  WATER_VERT_SIZE,
  createGpuWater,
  createWaterBindGroup,
  createWaterBindGroupLayout,
  waterPipeline,
  type GpuWater,
} from './waterPass.ts';
import {
  PLUME_FRAG_FIELDS,
  PLUME_FRAG_SIZE,
  PLUME_VERT_FIELDS,
  PLUME_VERT_SIZE,
  createGpuPlumes,
  createPlumeBindGroup,
  createPlumeBindGroupLayout,
  plumePipeline,
  type GpuPlumes,
} from './plumePass.ts';
import {
  PARTICLE_VERT_FIELDS,
  PARTICLE_VERT_SIZE,
  createGpuParticles,
  createParticleBindGroupLayout,
  packInstances,
  particleFragBindings,
  particlePipeline,
  type GpuParticles,
} from './particlePass.ts';
import {
  WIND_STREAK_FRAG_FIELDS,
  WIND_STREAK_FRAG_SIZE,
  WIND_STREAK_VERT_FIELDS,
  WIND_STREAK_VERT_SIZE,
  createGpuWindStreaks,
  createWindStreakBindGroup,
  createWindStreakBindGroupLayout,
  windStreakPipeline,
  type GpuWindStreaks,
} from './windStreakPass.ts';
import {
  FLOCK_FRAG_FIELDS,
  FLOCK_FRAG_SIZE,
  FLOCK_VERT_FIELDS,
  FLOCK_VERT_SIZE,
  createFlockBindGroup,
  createFlockBindGroupLayout,
  createGpuFlock,
  flockPipeline,
  type GpuFlock,
} from './flockPass.ts';
import {
  BOLT_FRAG_FIELDS,
  BOLT_FRAG_SIZE,
  BOLT_VERT_FIELDS,
  BOLT_VERT_SIZE,
  boltPipeline,
  createBoltBindGroup,
  createBoltBindGroupLayout,
  createGpuBolts,
  type GpuBolts,
} from './boltPass.ts';
import {
  LINE_FRAG_FIELDS,
  LINE_FRAG_SIZE,
  LINE_VERT_FIELDS,
  LINE_VERT_SIZE,
  createGpuLines,
  createLineBindGroup,
  createLineBindGroupLayout,
  linePipeline,
  type GpuLines,
} from './linePass.ts';
import {
  LIGHT_VOLUME_VERT_FIELDS,
  LIGHT_VOLUME_VERT_SIZE,
  createLightVolumeBindGroup,
  createLightVolumeBindGroupLayout,
  lightVolumeFragmentBindings,
  lightVolumePipeline,
  type LightVolumeVariant,
} from './lightVolumePass.ts';
import { aimReflection, createGpuReflection, type GpuReflection } from './reflectionPass.ts';
import { FrameBudget } from '../budget.ts';
import { MaterialChanges, ownsMaterial } from '../materialChanges.ts';
import { DYNAMIC_ALIGNMENT as DYNAMIC_UNIFORM_ALIGNMENT, UniformRing } from './uniformRing.ts';
import { DecalQueue, MAX_DRAWN_DECALS } from '../../decalQueue.ts';
import { DistanceFieldScene } from '../../gi/fieldScene.ts';
import { DEFAULT_FIELD_COMPOSE, FieldComposer } from './fieldCompose.ts';
import { ProbeBaker } from './probeBake.ts';
import { distanceFieldBounds } from '../../gi/fieldScene.ts';
import { fitProbeGrid } from '../../gi/probeGridFit.ts';

/**
 * Metres between probes when the renderer fits a grid itself.
 *
 * **Two, which is a room rather than a building.** The spacing is what decides how local the light
 * can be: a bounce off a wall reaches a surface two metres away and no nearer detail than that.
 * `fitProbeGrid` widens it uniformly when the budget bites, so a large scene gets a coarser grid
 * rather than a truncated one.
 */
const INDIRECT_PROBE_SPACING = 2;

/** What the trace is given when a frame never said what was lighting it. */
const NO_SUN: readonly number[] = [0, 0, 0];
import type { ComposedField } from './fieldCompose.ts';
import type { FieldSource } from '../../gi/globalField.ts';
import {
  CLIP_Y_FLIP,
  MAX_REFLECTIVE_SURFACES,
  REFLECTION_EDGE_FADE,
  ReflectionQueue,
} from '../../screenSpaceReflection.ts';
import type { ReflectiveSurface } from '../../screenSpaceReflection.ts';
import { decalScissor } from '../../decalProjector.ts';
import type { DecalProjector } from '../../decalProjector.ts';
import { createCommandPool, resetPool, takeCommand } from './drawCommand.ts';
import type { CommandPool, DrawCommand } from './drawCommand.ts';
import {
  RESOURCE_COUNT,
  createArena,
  createFlushSchedule,
  keptNodes,
  maskOf,
  nodeCount,
  nodeState,
  nodeVerb,
  recordNode,
  resetArena,
  schedule,
  scheduleFlush,
  scratchFor,
} from '../../frame/index.ts';
import { createFrustum, frustumFromViewProjection } from '../../../math/frustum.ts';
import type { Frustum } from '../../../math/frustum.ts';
import type { Bounds } from '../../../math/bounds.ts';
import { OcclusionBuffer } from '../../occlusion.ts';
import { boundsVisible } from '../../visibility.ts';
import { createPassRegistry, drainRegistry, passAt, registerIn, unregisterIn } from '../../pass.ts';
import { ClusterBinner } from './clusterBinner.ts';
import { MAX_CLUSTERED_LIGHTS, type ClusterLightSet } from '../../clusteredLights.ts';
import {
  computeAt,
  createComputeRegistry,
  type ComputeContext,
  type ComputeDefinition,
  type ComputeDevice,
  type ComputeHandle,
  type ComputeRegistry,
} from '../../compute.ts';
import type {
  PassContext,
  PassDefinition,
  PassDevice,
  PassEnvironment,
  PassHandle,
  PassRegistry,
  PrepareContext,
} from '../../pass.ts';
import type { Arena, FlushSchedule, ScheduledPass } from '../../frame/index.ts';
import { GpuInstancedBatch } from './instanced.ts';
import type { MeshInstances } from '../../instances.ts';

/**
 * How many draws one frame may make before the ring is full.
 *
 * **Four thousand and ninety-six, and the number is an allocation rather than a limit.**
 * `UniformRing.flush` uploads `used * slotSize`, so a frame that draws two hundred pays for two
 * hundred whatever this says: raising it costs no per-frame bandwidth at all. What it costs is
 * memory, once — and only in the three things below that cannot grow. `commands` and `arena` are
 * preallocation hints and already reallocate on demand, so of the five things this sizes, three
 * were never ceilings.
 *
 * One slot is **1,540 bytes**: `perDraw` at 512 and `shadowDraws` at 256, each paid twice for a
 * CPU staging array and a GPU buffer, plus 4 for `replayScratch`. So this is 6.0 MB where 1024
 * was 1.5 MB, against a single loaded car body of 36 MB in the consumer that asked for it.
 *
 * **What it gives up** is that memory on every device, including the phone the 60 fps gate is
 * measured on. **What would make it wrong** is a consumer whose frames genuinely approach it:
 * four thousand draw calls is a CPU cost long before it is a ring cost, and past the ring this
 * writes one console line and skips the rest.
 */
const MAX_DRAWS_PER_FRAME = 4096;

/**
 * The size to grow a ring to, having been asked for `count`.
 *
 * **The next power of two, so a scene that creeps upwards grows a handful of times and not once a
 * frame.** A ring grown to exactly what was asked for is a ring that runs out again on the next
 * draw somebody adds, and each regrowth costs a device allocation and every bind group over it.
 */
function roomFor(count: number): number {
  let slots = 1;
  while (slots < count) slots *= 2;
  return slots;
}

/**
 * How many scatter batches one shadow round may record.
 *
 * A round is either one directional layer or one light's bake, and a bake is up to `FACE_COUNT`
 * faces of every batch a world submits. Two hundred and fifty-six is sixteen faces of sixteen
 * batches, which no consuming world approaches — the game's is three — and at `SCATTER_DEPTH_SIZE`
 * padded to the dynamic-offset alignment it is 64 KB of staging for a ceiling nothing reaches.
 */
const MAX_SCATTER_DEPTH_DRAWS = 256;

/**
 * Panels and strings a frame may draw.
 *
 * Far below `MAX_DRAWS_PER_FRAME` because an overlay is furniture: the loader draws two of each,
 * and the game's busiest card is a dozen strings. Sized to be generous against that rather than
 * against the world.
 */
const MAX_OVERLAYS = 64;

/**
 * Distinct materials a frame may set.
 *
 * A slot is spent per *change*, not per draw, so this counts how many times a scene switches
 * material rather than how much it draws.
 *
 * **A thousand and twenty-four, and it is the expensive one of the two.** A slot is the fragment
 * block — 3,376 to 6,656 bytes depending on which of the sixteen permutations is built — paid
 * twice for staging and buffer, so **7,168 to 13,312 bytes a slot** against 1,540 for a draw.
 * Raising it from 256 costs 5.25 to 9.75 MB.
 *
 * It is worth paying for how it *fails* rather than how it performs. Past the ring
 * `materialSlotForDraw` returns null and **every draw that needed a new material is skipped** —
 * a stretch of the world simply not drawn, which has been reported from a consumer as
 * ground that appears and disappears as the camera moves. A budget that hopes to stay under a
 * ceiling is a budget that ships this the first time somebody adds a model.
 *
 * **This comment said "silently reuses the last material" until 2026-09-02, and so did the
 * warning, and neither was ever true.** The skip has been there since `9d90bf7` wrote both
 * halves in one diff. It is recorded because the wrong failure was the stated argument for
 * raising this number from 256, and because "wrong texture" and "no geometry" send a consumer
 * looking in completely different places — one at materials, the other at culling, which is
 * where the reporting game spent its weeks. `frameBudget` reports the count now, so the next
 * consumer reads a number instead of a sentence.
 *
 * **What would make it wrong** is a scene switching material every draw: a thousand material
 * changes is a thousand uniform copies, and a consumer reaching this has a batching problem no
 * ring size answers — many copies of one mesh want one material and one instanced draw.
 */
const MAX_MATERIALS_PER_FRAME = 1024;

/**
 * Whether the environment probe's permutation fits this device's per-stage binding limits.
 *
 * The widest flat variant declares one albedo, three directional shadow maps, twelve
 * point-shadow cubes and the probe: seventeen textures and seventeen samplers. WebGPU's default
 * is sixteen of each and an adapter is free to offer no more — this one offers 48 textures and
 * exactly 16 samplers, so the samplers are what decide it.
 */
function probeFits(device: GPUDevice): boolean {
  /*
   * **Two ceilings, counted separately, and they are no longer the same number.**
   *
   * The widest permutation declares seventeen sampled textures — one albedo, three directional
   * shadow maps, the point-shadow array, a normal map and the probe's own cube — **seven**, where
   * it was seventeen while every point light's shadow was a `samplerCube` of its own. `select.ts` asks
   * for the adapter's ceiling, which is 48 on this machine against a device default of 16, so
   * six fits everywhere and the probe no longer depends on the request being granted.
   *
   * It used to declare seventeen *samplers* too, and that was the binding constraint: this
   * adapter offers exactly sixteen and no request can raise it, so the probe stood down and
   * reflective surfaces kept a gradient. The shadow bindings share one declaration — see
   * `// wgsl:share shadow` in `flat/preamble.ts`, which costs nothing because they were already
   * one object — so the count is four, and the fourth is the normal map's: it is a colour image
   * and wants filtering, which a non-filtering shadow sampler cannot give it.
   *
   * **Counted from the generated bindings rather than typed**: `FLAT_BINDINGS.flatFrag`'s
   * widest variant is `directionalShadows+environmentProbe+pointShadows`, seven textures and
   * four samplers. A stale number here reads as a device declining a feature it can run.
   */
  const TEXTURES = 7;
  const SAMPLERS = 4;
  const fits =
    device.limits.maxSampledTexturesPerShaderStage >= TEXTURES &&
    device.limits.maxSamplersPerShaderStage >= SAMPLERS;
  if (!fits) {
    console.warn(
      `[driftengine] this device allows ${device.limits.maxSampledTexturesPerShaderStage} sampled ` +
        `textures and ${device.limits.maxSamplersPerShaderStage} samplers per shader stage; the ` +
        `environment probe needs ${TEXTURES} and ${SAMPLERS}. Reflective surfaces keep the ` +
        `sky-and-ground gradient. Nothing else is affected.`,
    );
  }
  return fits;
}

/** What a depth-only inset writes into the colour it is masked out of. */
const BLACK_CLEAR: Vec3 = [0, 0, 0];

/**
 * How many volumes of light one frame may draw.
 *
 * Far below `MAX_DRAWS_PER_FRAME` because each of these is a full march per covered pixel, and
 * a scene wanting more than sixteen has a cost problem rather than a ring problem. The demo
 * scenes draw one each. Raising it costs 256 bytes of staging per slot per block.
 */
/**
 * A node is a draw or a boundary, and nothing finer.
 *
 * One verb id for every drawing verb, because the command carries everything that differs
 * between them. The graph does not need to know a plume from a panel.
 */
/**
 * Why a flush happened, which is the difference between progress and the frame's own shape.
 *
 * A `verb` flush is one caused by a verb about to issue commands itself, and goes to zero as
 * the migration completes. A `boundary` flush is the frame changing target, encoder or
 * viewport, and never does.
 */
type FlushCause = 'verb' | 'boundary';

const VERB_DRAW = 1;

/** What a mesh draw writes: the scene's colour and its depth. */
const SCENE_TARGET = maskOf('sceneColor', 'sceneDepth');

/**
 * A boundary rather than a draw: the target changes here.
 *
 * Recorded so the scheduler can see every point the frame's pass ends, which is what lets it
 * derive `storeOp` per attachment. A reopen that loads is a read; an attachment nothing loads
 * back is discardable. None of the three boundaries is removable — the mirror needs its own
 * target, the frame must resume after it, and text is drawn after `endFrame` on purpose so a
 * consumer's interface escapes the post chain — and removing them was never the point.
 */
const VERB_SCOPE = 2;

/**
 * A pass somebody else owns.
 *
 * Recorded rather than called, for the same reason every verb is: it belongs in the caller's
 * order among the draws around it, not ahead of all of them. Its node's state slot holds the
 * `PassHandle` where a draw's holds a command index.
 */
const VERB_PASS = 3;

/** What the depth snapshot copies from, and what it copies into. */
const DEPTH_SOURCE = maskOf('sceneDepth');
const DEPTH_SNAPSHOT = maskOf('depthSnapshot');

/** The mirror's own colour and depth. */
const MIRROR_TARGET = maskOf('mirrorColor', 'mirrorDepth');

/**
 * The half of the mirror anything samples.
 *
 * Water and the film bind `reflection.view` and its sampler, which is the colour. **Nothing
 * reads the mirror's depth** — it sorts the mirror against itself and is never looked at again
 * — so declaring `MIRROR_TARGET` as a read, which water did, holds a whole attachment at
 * `store` every frame that reflects, for no reader. That is the shape of loss this design
 * exists to find, so it would be a poor thing to leave in the first verb to declare a read.
 */
const MIRROR_COLOR = maskOf('mirrorColor');

/** What the canvas pass touches, for text drawn after the frame resolves. */
const CANVAS_TARGET = maskOf('canvas');

/**
 * What one sample of `depth24plus` is counted at.
 *
 * The format is implementation-defined and a driver may spend more — `depth24plus` permits a
 * 32-bit representation and most take it. Four is the floor, which makes every figure derived
 * from it a floor as well, and a floor is the honest direction for a saving to be quoted in.
 */
const DEPTH_BYTES_PER_SAMPLE = 4;

/** Every resource in the table, which is where a live-out set starts. */
const EVERY_RESOURCE = (1 << RESOURCE_COUNT) - 1;

/**
 * How many volumes of light one frame may draw.
 *
 * **A ring capacity rather than a rendering decision.** `lightVolumeVertices` and
 * `lightVolumeFragments` are `UniformRing`s and a ring cannot grow inside a frame, so the number
 * is what they are sized for. The other backend has no equivalent: `renderer.ts` uploads a
 * volume's uniforms and draws it immediately, so it draws whatever it is handed. That asymmetry
 * is the reason this is a cap and not a budget — past it a shaft is *skipped*, and the console
 * says so, which is the defined state the 2026-08-13 rule asks for rather than parity.
 *
 * **Thirty-two, from a survey rather than from a preference.** Twenty-six worlds of a consuming
 * application were instrumented at the call, four instants each, and only one asks for more than
 * sixteen: it asks for **24**, and it had been losing eight shafts on this backend on every frame
 * anybody photographed. Two more sit at **15**, one shaft under the old cap. So sixteen was not a
 * generous ceiling that one world happened to exceed; it was inside the range worlds are actually
 * built in, and the two nearest were a single window away from silently losing beams too.
 *
 * The cost is 12 KiB of uniform buffer. A slot is padded to `DYNAMIC_ALIGNMENT`, so a volume is
 * 256 bytes of vertex block and 512 of fragment block in the shadowed variant, and doubling the
 * ring adds 768 bytes a slot for sixteen slots.
 *
 * **What would make it wrong** is treating the headroom as a licence to stop counting. The cap
 * exists so a scene asking for hundreds of shafts is told rather than quietly allocated for, and
 * a number large enough to make that message unreachable would trade a visible limit for an
 * invisible cost. If a world legitimately needs more than this, the answer is a ring that grows
 * between frames on the demand it recorded, not a larger literal.
 */
const MAX_LIGHT_VOLUMES_PER_FRAME = 32;

/**
 * How many plume batches one frame may draw.
 *
 * A scene draws one per phenomenon — a flame and its smoke are two — and doubles that when it
 * mirrors the world. Thirty-two is generous for both; the cost is 256 bytes of staging per slot
 * per block.
 */
const MAX_PLUMES_PER_FRAME = 32;

/**
 * How many bodies of water one frame may draw.
 *
 * A world has a sea and a handful of placed bodies — a basin, a trough, the runs of a ditch — and
 * doubles that when it mirrors itself. Sixteen is generous for that and the cost is a slot of
 * staging each; a consumer with a ditch network longer than sixteen straight runs is the case that
 * would raise it, and it is told rather than quietly truncated.
 */
const MAX_WATER_BODIES_PER_FRAME = 16;

/**
 * How many batches of each of the four batched effects one frame may draw.
 *
 * **Sized by what a batch is for, not by symmetry with the water above.** Each of these takes a
 * handle per batch and a batch is already a *pool*: one `BoltHandle` holds every arc of a storm,
 * one `FlockHandle` every bird, one lattice all the rain, one `CausticsHandle` every lit sheet. So
 * the count here is how many *distinct settings* a frame wants — a red arc from a pylon and a
 * white one from a mast, gulls over the harbour and crows over the field, rain in front of the
 * camera and dust behind it — and eight is generous for all four.
 *
 * The cost is a slot of staging each, and a slot is one alignment unit: 256 bytes. Eight slots of
 * two rings across four passes is 16 KB of staging for the whole set.
 *
 * A caller past the ceiling is **told once and its draw skipped**, which is the rule the water
 * ring already follows: a batch that cannot be addressed must not be drawn with another batch's
 * numbers, because that is precisely the defect the ring exists to end.
 */
const MAX_BATCHES_PER_FRAME = 8;

/** Buffer usage flags, from the specification. See `buffers.ts` for why they are not read off the global. */
const USAGE_UNIFORM_DST = 0x0040 | 0x0008;

/**
 * What to do with a resolving colour attachment's own contents once the pass has ended.
 *
 * When a `resolveTarget` is set the resolve happens at end-of-pass either way; `storeOp`
 * decides only whether the *multisampled* texture is additionally written back to memory. No
 * shader can read one — `post.sceneColorMsaa`, `reflection.colorMsaa` and `probe.colorMsaa`
 * are created with `RENDER_ATTACHMENT` and no `TEXTURE_BINDING` — so on a tile-based GPU,
 * where the samples live in tile memory and resolve there, `store` is the one word that drags
 * all four out to DRAM for nothing. Measured on the consumer at 824x1830 with four
 * samples: 23 MB per store, five stores a frame, 115 MB a frame.
 *
 * **`terminal` is the whole of the correctness, and it cannot be settled by looking at the
 * picture.** Discarding is sound only where nothing later loads the same attachment back, and
 * this backend closes the frame's pass and reopens it with `loadOp: 'load'` three times over —
 * for the mirror, for the light volume's depth snapshot and for text. After a discard those
 * loads are reading contents the specification calls undefined.
 *
 * **Held against the shot harness with every attachment discarding, reopened ones included:
 * all seven scenes came back inside the readout's own 130-pixel noise, two of them at zero.**
 * That is not permission, it is the trap. An immediate-mode desktop GPU has nowhere else to
 * put the samples, so `discard` costs it nothing and changes nothing. A tile-based mobile GPU
 * really does drop them, because dropping them is the entire point of the operation there —
 * so this renders perfectly on every machine that can be tested here and returns garbage on
 * exactly the device the change was made for. That failure is invisible to the gate.
 *
 * So the reopens are not a bandwidth cost to be tidied up later. They are what holds the
 * frame's own attachment at `store`, and removing them is what makes the other 69 MB a frame
 * safe to take rather than merely available.
 */
function resolvedStoreOp(multisampled: boolean, terminal: boolean, allowed: boolean): GPUStoreOp {
  return multisampled && terminal && allowed ? 'discard' : 'store';
}

/**
 * Clip space differs between the two APIs in **one** way, and the other half of `CLIP_CORRECTION`
 * cancels something this repository writes itself.
 *
 * **Depth lands in a different range, and that half is a real difference between the APIs.**
 * OpenGL clips z to [-1, 1] and WebGPU to [0, 1], so an uncorrected matrix throws away the near
 * half of the depth buffer and compares what remains against the wrong distances.
 *
 * **The Y negation cancels one the generator writes, and this comment used to say otherwise.**
 * It claimed the flip was the framebuffer origin: WebGPU's is the top-left and OpenGL's is the
 * bottom-left, so a projection built for WebGL2 "draws the world upside down here". That is not
 * what either viewport transform does — both put clip `y = +1` at the top of the image, because
 * OpenGL measures its window upward from the bottom-left and WebGPU measures its framebuffer
 * downward from the top-left. An uncorrected projection lands the same way up on both.
 *
 * What does flip it is `naga`. Every module in `shaders/generated/` ends its vertex entry point
 * with `gl_Position.y = -gl_Position.y`, which is how that translator adapts a GLSL shader to
 * WebGPU — and the first frame this backend rendered, a colonnade hanging from the ceiling, was
 * *that* line and not the API. So the pair is: the generator negates, this negates back, and the
 * net effect on a generated shader is the depth remap alone. `shaders/generated.test.ts` pins the
 * generator's half so the two cannot drift apart.
 *
 * **Which makes it the wrong matrix for a shader somebody wrote by hand**, since there is no
 * negation to cancel — see `DEPTH_CORRECTION` below, and `PassDevice` for the seam where a
 * contributed pass chooses. Wiring the GPU-driven pipeline's hand-written raster found it: the
 * picture was an exact vertical mirror of the forward path's, and `frontFace: 'cw'` made it draw
 * the right faces of a mirrored world.
 *
 * **This one is for a target that gets presented. `SHADOW_CLIP_CORRECTION` is for one that
 * gets sampled, and they are not the same transform.**
 */
const CLIP_CORRECTION = new Float32Array([
  1,
  0,
  0,
  0,
  0,
  -1,
  0,
  0,
  /*
   * **The depth row is negated, which is the whole of reversed-Z on this backend.** It used to be
   * `0.5z + 0.5`, mapping OpenGL's [-1, 1] onto WebGPU's [0, 1] in the same sense. It is now
   * `0.5 - 0.5z`, which maps the near plane to 1 and the far plane to 0 — so the far distances
   * land where a float has its resolution, and the hyperbolic loss and the floating-point gain
   * very nearly cancel. See `depthConvention.ts` for what that is worth and what it does not fix.
   *
   * Every scene pipeline compares with `DEPTH_COMPARE` and every scene attachment clears to
   * `DEPTH_CLEAR`, both from that module, so the three cannot drift apart. Shadows are not
   * reversed and use `SHADOW_CLIP_CORRECTION` below, which keeps the old row.
   */
  0,
  0,
  REVERSED_DEPTH ? -0.5 : 0.5,
  0,
  0,
  0,
  0.5,
  1,
]);

/**
 * The same depth remap, **without the Y flip**, for a target that is sampled rather than shown.
 *
 * The flip above earns its place by making a *presented* image the right way up: the swap
 * chain's first row is drawn at the top of the canvas, so a projection built for OpenGL has to
 * be turned over on its way there. A shadow map is never presented. It is read back out by
 * `flat.ts` as `p = p * 0.5 + 0.5` and a texture fetch, and normalised texture coordinates
 * address texel memory identically in both APIs — v = 0 is the first row of texels in WebGL2
 * and in WebGPU alike. So the only thing that has to agree is **which row of texel memory a
 * given light-space Y lands in**, and flipping the projection moves every row to the mirror of
 * where that lookup goes looking.
 *
 * **Measured rather than argued, because arguing about framebuffer origins got it wrong once
 * already.** Both backends' maps were read back and compared texel for texel, at the same
 * frame of `demo/dayClock`, in two orientations:
 *
 * | | rows as stored | rows mirrored |
 * |---|---:|---:|
 * | with the Y flip | 63,718 of 65,536 differ | 285 differ |
 * | without it | **388 differ, worst 15/255** | 63,631 differ |
 *
 * The maps were exact mirrors of each other, and dropping the flip made them the same picture.
 * The comment this replaces claimed the corrected render and the uncorrected lookup "are
 * consistent rather than an oversight". They were not, and the frame it produced was wrong in
 * a way that still looked like shadows: broad dark bands where a mirrored sample happened to
 * find a nearer occluder, and stipple everywhere the receiver stopped matching its own texel.
 *
 * **It also fixes the winding.** A Y flip reverses triangle winding, so `cullMode: 'back'` in
 * `depthPass.ts` was culling front faces — the textbook shadow-acne answer that file argues
 * against, applied by accident. Without the flip it culls what it says it culls, and matches
 * what `renderer.ts` does through the directional pass.
 */
/**
 * `CLIP_CORRECTION` without the Y negation: the depth remap alone, reversed.
 *
 * **What a hand-written WGSL shader wants.** The negation in `CLIP_CORRECTION` is there to cancel
 * the one `naga` writes into every generated vertex entry point; a shader that was not generated
 * carries no such line, so taking that matrix mirrors its picture vertically — and mirrors its
 * triangle winding with it, which is how it reads as a culling problem rather than as a flip.
 *
 * The depth half is not optional and is the reason this is a matrix rather than nothing: OpenGL
 * clips z to [-1, 1] and WebGPU to [0, 1], and the row is `0.5 - 0.5z` rather than `0.5z + 0.5`
 * because `depthConvention.ts` puts the near plane at one.
 */
const DEPTH_CORRECTION = new Float32Array([
  1,
  0,
  0,
  0,
  0,
  1,
  0,
  0,
  0,
  0,
  REVERSED_DEPTH ? -0.5 : 0.5,
  0,
  0,
  0,
  0.5,
  1,
]);

const SHADOW_CLIP_CORRECTION = new Float32Array([
  1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0.5, 0, 0, 0, 0.5, 1,
]);

/**
 * `CLIP_CORRECTION` undone: WebGPU clip space back to the OpenGL one.
 *
 * **For the one draw that reads its own clip position back.** `sky.ts` emits an
 * attribute-less fullscreen triangle, `gl_Position = vec4(vNdc, 1, 1)`, and then unprojects
 * that same `vNdc` with `uInvViewProj` to get a view ray. It is the only draw in the engine
 * with no matrix on its vertex position, so `CLIP_CORRECTION` cannot reach it the way it
 * reaches everything else — and that left the sky disagreeing with the world by a Y flip
 * while every other draw was corrected.
 *
 * **The symptom was a sky that looked like a sky.** Top of screen rendered the ray for the
 * bottom, so the zenith drew `uDeepColor`, the below-horizon shade. Caught numerically rather
 * than by eye: unprojecting `demo/collapse`'s captured matrix at the top of frame gives
 * 142,159,186 for the upward ray and 79,102,147 for the mirrored one, against measured
 * WebGL2 150,166,192 and WebGPU 60,85,137.
 *
 * So the sky is handed `invViewProjection * INVERSE_CLIP_CORRECTION`, which takes the
 * rasteriser's WebGPU NDC back to the GL NDC the camera's own inverse expects: Y the other
 * way, and z from [0, 1] back to [-1, 1]. That second half matters as much as the first —
 * the shader passes z = 1 meaning the far plane, and `2z - w` is what makes it one.
 *
 * A constant multiply rather than inverting the corrected matrix per frame, which is the same
 * result by `inverse(A * B) = inverse(B) * inverse(A)` and cannot fail on a singular matrix.
 */
const INVERSE_CLIP_CORRECTION = new Float32Array([
  1, 0, 0, 0, 0, -1, 0, 0, 0, 0, 2, 0, 0, 0, -1, 1,
]);

/**
 * What the composite's reprojection has to swallow, because the shader was written for OpenGL.
 *
 * **`rush.ts` rebuilds a clip position from the depth texture**, and it does it the only way
 * that works on the other backend: `vec4(vUv * 2 - 1, depth * 2 - 1, 1)`. That last remap takes
 * a 0-to-1 depth buffer into OpenGL's −1-to-1 NDC. `CLIP_CORRECTION` has already put this
 * backend's z in 0 to 1, so the depth *is* the z and doubling it sends every pixel to a point
 * roughly twice as far away as the one it came from.
 *
 * **The symptom is a blur that points the right way and travels the wrong distance**, which is
 * why it survived being looked at: measured on `demo/dev/probe.html`, this backend moved 39,940
 * pixels where WebGL2 moved 21,109, and the two frames differed in 29,246 of 857,600. The
 * direction being right is what makes it read as a strength that wants tuning.
 *
 * So the reprojection is post-multiplied by the remap's inverse and the shader's expression
 * comes out meaning what it means on the other backend. Correcting the matrix rather than the
 * shader, for the reason `CLIP_CORRECTION` gives: the shaders are generated from one GLSL
 * source and a backend-specific branch written into them is a difference no generator could
 * keep honest.
 *
 * Numerically the same as `SHADOW_CLIP_CORRECTION` and deliberately not shared with it. That
 * one is about where a sampled map's rows live; this is about what a depth means. Two reasons
 * that happen to agree today, and a single constant would hide the day they stop.
 */
const DEPTH_CLIP_CORRECTION = new Float32Array([
  1,
  0,
  0,
  0,
  0,
  1,
  0,
  0,
  /*
   * **This row is the inverse of what the shader does, so it moves when the shader moves.** Under
   * reversed depth the buffer holds `0.5 - 0.5z` and `rush.ts` recovers `1 - 2 * stored`; the
   * matrix behind it wants the stored value back, which is `0.5 - 0.5z` again. Under the
   * conventional sense both are `0.5z + 0.5`. Leaving this at the old sign while the shader
   * flipped is a reprojection that points correctly and travels the wrong way, which is the same
   * class of symptom this constant was created to fix.
   */
  0,
  0,
  REVERSED_DEPTH ? -0.5 : 0.5,
  0,
  0,
  0,
  0.5,
  1,
]);

/**
 * Gaussian-disc exponent whose half-intensity point is `angularRadius`.
 *
 * The same function `renderer.ts` computes for the WebGL2 sky, because it is the shader's
 * parameter rather than the scene's: `SkyColors` carries an angular radius and the shader
 * wants an exponent. Duplicated rather than shared only until Task 11 moves it somewhere
 * both can import; a copy that drifts would give the two backends different suns.
 */
function discExponent(angularRadius: number): number {
  const finite = Number.isFinite(angularRadius) ? angularRadius : 0.001;
  const radius = Math.min(Math.max(finite, 0.001), 0.5);
  return Math.LN2 / -Math.log(Math.cos(radius));
}

/**
 * Write a packed array into a `std140` array field, one element per stride.
 *
 * `components` is how many floats each element actually carries — 3 for a `vec3`, 1 for a
 * `float` — while the slot it lands in is `stride` bytes wide regardless. Stops at whichever
 * runs out first, so a source shorter than the field leaves the tail as it was rather than
 * reading past its end.
 *
 * Free rather than a method because two passes need it: the flat block holds the light arrays
 * and the scatter block holds the trample ring, and neither should own the arithmetic.
 */
/**
 * The same, into a ring slot.
 *
 * Its own function rather than a flag on `scatterInto`, because the two write through different
 * things — one a `Float32Array` view of a whole block, the other a slot at a byte offset — and
 * a shared one would take the union of both and be clearer about neither.
 */
function scatterIntoRing(
  ring: UniformRing,
  slot: number,
  field:
    { readonly offset: number; readonly length?: number; readonly stride?: number } | undefined,
  source: Float32Array,
  components: number,
): void {
  if (field?.length === undefined || field.stride === undefined) return;
  const elements = Math.min(field.length, Math.floor(source.length / components));
  for (let e = 0; e < elements; e++) {
    for (let c = 0; c < components; c++) {
      ring.writeFloat(
        slot,
        field.offset + e * field.stride + c * 4,
        source[e * components + c] as number,
      );
    }
  }
}

function scatterInto(
  target: Float32Array,
  field:
    { readonly offset: number; readonly length?: number; readonly stride?: number } | undefined,
  source: Float32Array,
  components: number,
): void {
  if (field?.length === undefined || field.stride === undefined) return;
  const step = field.stride / 4;
  const base = field.offset / 4;
  const elements = Math.min(field.length, Math.floor(source.length / components));
  for (let e = 0; e < elements; e++) {
    for (let c = 0; c < components; c++) {
      target[base + e * step + c] = source[e * components + c] as number;
    }
  }
}

/**
 * How many samples the frame rasterises at, from the resolved profile.
 *
 * **WebGPU offers 1 and 4 and nothing else.** `GPUTextureDescriptor.sampleCount` is specified
 * to accept only those two, where `SceneTarget` on the other backend asks the driver for
 * whatever `MAX_SAMPLES` allows and takes what it gets. So a profile asking for 2 or 8 is
 * answered with 4 rather than refused: the request means "antialias this", and the alternative
 * is a validation error at construction over a number a consumer had no way to know was
 * unavailable.
 *
 * Recorded in the parity ledger because it is a place the two backends can legitimately
 * differ — at `sceneSamples: 8` WebGL2 may take eight and this takes four.
 */
function supportedSampleCount(asked: number): number {
  return asked > 1 ? 4 : 1;
}

/** One level of the bloom pyramid, with the size the stage writing it needs for its viewport. */
interface BloomLevel {
  readonly texture: GPUTexture;
  readonly view: GPUTextureView;
  readonly width: number;
  readonly height: number;
}

/**
 * A slot in the bloom uniform buffer, and how many of them there are.
 *
 * One per stage that needs its own block: the prefilter, one per downsample, and a single one
 * the whole way back up — every upsample draw reads the same tent radius, so a slot each would
 * be five copies of one constant. Aligned to what a dynamic offset requires, which is a device
 * limit rather than a preference; see `uniformRing.ts` for what happens when it is not.
 */
/**
 * One aligned block per mark, so a frame's decals are written once and bound by offset.
 *
 * `queue.writeBuffer` does not interleave with recorded commands, so a single block rewritten
 * between two passes would give both passes the last write — the hazard `bloomStaging` records,
 * met again by a pass that runs many times in one frame.
 */
const DECAL_SLOT = DYNAMIC_UNIFORM_ALIGNMENT;
/**
 * One aligned block per reflective surface.
 *
 * **Rounded up rather than assumed to be one alignment**, which the decal block happens to be and
 * this one is not: the trace carries three matrices and comes to 272 bytes, so a slot of 256 would
 * put every surface after the first inside its neighbour's block.
 */
const SSR_SLOT = Math.ceil(SSR_FRAG_SIZE / DYNAMIC_UNIFORM_ALIGNMENT) * DYNAMIC_UNIFORM_ALIGNMENT;
const BLOOM_SLOT = DYNAMIC_UNIFORM_ALIGNMENT;
const BLOOM_SLOTS = BLOOM_LEVELS + 1;
/** One slot per blur axis, aligned like every other dynamic-offset block here. */
const AO_BLUR_SLOT = DYNAMIC_UNIFORM_ALIGNMENT;

/** The last slot, holding the tent radius every upsample draw binds. */
const BLOOM_UPSAMPLE_SLOT = BLOOM_LEVELS;

/**
 * What one particle material's fragment stage needs a bind group *shaped* like, built once and
 * kept. Purely structural — no buffer, no data — which is what makes it safe to share across
 * every batch of that material; see `particleLayoutFor` and the doc comment on
 * `createGpuParticles` for the data it deliberately does not hold.
 */
interface ParticleLayout {
  readonly layout: GPUBindGroupLayout;
  readonly fields: Readonly<
    Record<
      string,
      {
        readonly offset: number;
        readonly size: number;
        readonly length?: number;
        readonly stride?: number;
      }
    >
  >;
  readonly fragSize: number;
}

/** Which directional shadow map a pass is filling, matching `renderer.ts`. */
type ShadowLayer = 'static' | 'static-peel' | 'dynamic';

/** The tint a draw gets when it asks for none, matching the WebGL2 path's reset-to-white. */
const WHITE = new Float32Array([1, 1, 1]);
/** No surface-texture scaling, which is what an untextured mesh wants. */
const UNIT_UV = new Float32Array([1, 1]);
/** A dust field standing still, for a light volume that asked for dust and not for wind. */
const NO_DRIFT = new Float32Array([0, 0, 0]);
/**
 * What a light volume projects with when it was given no environment.
 *
 * Written rather than skipped. `uSunShadow` is zero in that case so the shader never reaches
 * `sunReach`, but these blocks come out of a ring and a slot holds whatever the volume that
 * used it last frame left there — so "the shader will not look" is a stale matrix waiting for
 * the frame where it does.
 */
const NO_LIGHT_MATRIX = new Float32Array(16);
/**
 * The clip plane written when there is no mirror to clip against.
 *
 * All zeroes, which is what an unwritten uniform would be anyway — and is safe only because
 * `uClipEnabled` is what the shader branches on. Written rather than skipped for the reason
 * `NO_LIGHT_MATRIX` gives: these blocks are reused between frames.
 */
const NO_CLIP_PLANE = new Float32Array(4);

/**
 * The WebGPU backend.
 *
 * **`RendererApi`, in full, with no `Partial` and no cast.** It implemented
 * `Partial<RendererApi>` for as long as its passes were being written, and the `Partial` was
 * the schedule: every member still missing was a row of work, and `createRenderer` needed a
 * cast to hand an incomplete backend back behind the complete surface.
 *
 * That is over. The derived type now does the job it exists for — add a method to `Renderer`
 * and this class stops compiling until it has one too, which is the compile-time form of the
 * failure the 2026-08-02 design spec named as the real risk: a fallback that rots because only
 * the developer's own backend is ever exercised.
 *
 * **Present is not the same as honoured, and the reverse is a trap of its own.** `setBloom`,
 * `setSpeedRush` and `setCameraMotionBlur` warned that the composite did not exist here, which
 * was true when they were written and stopped being true when it landed — so the backend spent
 * a while telling consumers that working effects did nothing. All three are read by
 * `composite()` now, and each has been compared against WebGL2 on `demo/dev/probe.html`.
 */
/**
 * The y negation every generated vertex stage ends with, as a matrix.
 *
 * **A hand-written shader has no such line, so it has to carry it.** `CLIP_CORRECTION` negates y
 * precisely to cancel the one `naga` writes, and the pair's net effect on a generated shader is the
 * depth remap alone — §3 rows 56 and 57. The motion pass has to put its vertices exactly where the
 * scene put them or its depth test admits nothing, so the renderer multiplies this through the
 * matrix the scene drew with and hands over the product.
 */
const MOTION_CLIP_FLIP = mat4.fromValues(1, 0, 0, 0, 0, -1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1);

export class WebGPURenderer implements RendererApi {
  /**
   * Real timestamp queries, where the adapter offers them.
   *
   * Typed as the concrete class rather than as `FrameTimer` because this file needs the two
   * methods the interface has no room for: `writesFor`, which every `beginRenderPass` below
   * passes into its descriptor, and `resolve`, which rides the frame's last encoder. A
   * consumer still sees only `FrameTimer` through `RendererApi`.
   */
  readonly gpuTimer: GpuTimestamps;

  /** What drew the frame, for the meter and for bug reports. */
  readonly rendererName: string;

  /**
   * See `RendererApi.reversedDepth`. Always the engine's own setting on this backend: WebGPU's
   * clip space is `[0, 1]` already, so reversing costs an extension nothing and cannot be refused.
   */
  readonly reversedDepth = REVERSED_DEPTH;
  /** Which backend is drawing. See `Renderer.backend` for why this is asked rather than guessed. */
  readonly backend: RenderBackend = 'webgpu';

  /**
   * The profile this renderer was built against, resolved once.
   *
   * **Resolved by the caller and held, rather than defaulted per use.** Every shadow term
   * below reads it, and the constants they replaced were `DEFAULT_RENDER_QUALITY` copies —
   * which measured wrong the moment a scene overrode one. `demo/dayClock` resolves
   * `directionalShadowMaxSlope` to 9 where the default is 3.
   */
  readonly quality: Readonly<RenderQuality>;

  /** Whether `endFrame` put an image on the canvas. Read by the recorder and the harness. */
  framePresented = false;

  /**
   * How many frames this renderer has actually presented, monotonic for its whole lifetime.
   *
   * **Incremented in `swapView`, at the one line that calls `getCurrentTexture`** — the real
   * acquisition, guarded there to fire at most once per frame no matter how many callers ask
   * for the view. Deliberately not `beginFrame` or `endFrame`: a frame that dies before
   * drawing anything never reaches `swapView` at all — see the comment on `frameSwapView` in
   * `beginFrame` — so it correctly never counts, while a frame drawn through the eager
   * `deferFramePass: false` path counts the moment it takes the swap chain rather than
   * waiting for `endFrame` to say so after the fact. A consumer compositing an offline export
   * reads this after `endFrame` and compares it with what it read last, which is how it
   * tells a frame that drew something from one that repeated the canvas it already had —
   * see `ExportTarget`.
   */
  get presentedFrames(): number {
    return this.presentedFrameCount;
  }

  /**
   * Resolve once every pipeline asked for so far has finished compiling.
   *
   * **Await this before the first frame.** A pipeline is not ready when `createRenderPipeline`
   * returns: the driver compiles the shader at the first draw that uses it, inside the frame,
   * with the queue stalled behind. Measured on an S23 Ultra, that was a 5.2 second frame with
   * an idle main thread, no allocation and nothing on any CPU-side timer — the queue simply
   * did not drain. Compiling asynchronously and waiting here moves that work in front of the
   * first frame, where it can be waited on honestly instead of appearing as a hang.
   *
   * Safe to call at any point and safe to call more than once: it waits for whatever is in
   * flight at the time, so a consumer that builds more meshes later can wait again.
   */
  async ready(): Promise<void> {
    await Promise.all(this.pipelineTargets.map((cache) => cache.ready()));
  }

  private presentedFrameCount = 0;

  /**
   * The joint palettes this frame has set, one slot each. The WebGL2 field of this name is a
   * single texture, and `SkinPaletteRing` carries why the two differ.
   *
   * Held rather than passed, like every other per-draw state here: `setSkinPalette` chooses and
   * the following draws use it, which is the shape `setMaterial` already has.
   */
  private readonly skinPalettes = new SkinPaletteRing();
  private readonly skinnedBindGroupLayout: GPUBindGroupLayout;
  private readonly morphedBindGroupLayout: GPUBindGroupLayout;
  private readonly bothBindGroupLayout: GPUBindGroupLayout;
  /** The morph weights the following draws use, or null for none. */
  private morphWeights: Float32Array | null = null;
  /**
   * One cached bind group per palette slot, at `slot + 1`, with index 0 for a morphed draw that
   * is not skinned.
   *
   * **An array and not a field, because the palette is a ring now.** A single cached group was
   * correct while every skinned draw in a frame bound the same texture; with a slot per character
   * the view changes between them, so one field would miss on every character and build a bind
   * group per character per frame — an allocation in the frame loop, which `AGENTS.md` forbids.
   * Keyed by slot instead, the groups are built once and reused for the life of the renderer.
   */
  private readonly skinnedGroups: (GPUBindGroup | null)[] = [];
  /** The unskinned group each was built beside, for identity-based invalidation. */
  private readonly skinnedGroupsBeside: (GPUBindGroup | null)[] = [];
  private readonly skinnedGroupsPalette: (GPUTextureView | null)[] = [];
  private readonly skinnedGroupsDeltas: (GPUTextureView | null)[] = [];
  /**
   * Which palette slot the following draws skin by, or -1 for none.
   *
   * The slot rather than a flag: two characters in one frame hold two slots at once, and a draw
   * has to name the one that was uploaded for it. Cleared by `beginFrame`, so a frame that draws a
   * rigged mesh without setting a palette takes the plain pipeline — the same defined fallback a
   * caller who passed null gets — rather than reading a slot this frame has already re-let.
   */
  private skinPaletteSlot = -1;

  private readonly surface: GpuSurface;
  /** The encoder for the frame in flight, or null between frames. */
  private encoder: GPUCommandEncoder | null = null;
  /** Which optional attributes each mesh key supplied. See the fallback in `submitMesh`. */
  private readonly meshPresent = new Map<string, Readonly<Record<string, boolean>>>();
  private pass: GPURenderPassEncoder | null = null;

  private readonly pipelines: PipelineCache;
  /**
   * The same pipelines again, built for the canvas, for anything drawn after `endFrame`.
   *
   * **A second cache rather than a second key in the first one**, because `PipelineCache` carries
   * the format and the sample count as the *authority* for every pipeline it holds — that is the
   * 2026-08-14 rule, and it is what stops a pass disagreeing with the attachment it is about to
   * be used on. A cache holding pipelines that disagree with its own `format` would give that up
   * and put the check back in each caller.
   *
   * So there are two target states and two caches: the world's, wherever the world lands, and the
   * overlay's, which is the canvas at one sample. `ensurePass` reopens on the canvas because the
   * composite has already run — see `overlayDepth` — and a pipeline built against the scene target
   * is rejected there. Measured on `overlay.html?after=1&samples=4`: the whole overlay was dropped,
   * with *"Attachment state of [RenderPipeline "inset|color"] is not compatible with
   * [RenderPassEncoder "overlay"]"* the only evidence anywhere.
   *
   * **The same object as `pipelines` when the two states already agree**, which is the common case
   * of a profile with no composite at one sample — nothing is built twice for a target that is the
   * same target. `pipelineTargets` is what `createMesh` walks so it cannot build one and forget
   * the other.
   */
  private readonly overlayPipelines: PipelineCache;
  /** Every distinct cache above, so a mesh's pipelines are built for each. One entry when aliased. */
  private readonly pipelineTargets: readonly PipelineCache[];
  private readonly bindGroupLayout: GPUBindGroupLayout;
  /** One slot per draw, uploaded once a frame. See `UniformRing`. */
  private readonly perDraw: UniformRing;
  /** The lights, fog and camera, settled once per frame by `bindMeshPass`. */
  private readonly perFrame: UniformRing;
  /**
   * The material block as the CPU holds it, patched by the setters and copied into a slot.
   *
   * Authoritative between draws: a setter changes one field here and marks the block dirty, and
   * the next `drawMesh` takes a slot and copies the whole thing in. That keeps a setter free of
   * any knowledge of slots, which is what lets it be called anywhere a scene wants.
   */
  private readonly perFrameStaging: ArrayBuffer;
  private readonly perFrameFloats: Float32Array;
  private readonly perFrameInts: Int32Array;
  /** The slot the open material occupies, and whether the next draw must take a new one. */
  private readonly materials = new MaterialChanges();

  /*
   * The frame graph's recording, and the machinery that replays it.
   *
   * Off unless `quality.frameGraph`. While it is on, a mesh draw records a node instead of
   * issuing its calls, and every other verb flushes the recording before its own — which
   * `ensurePass` does for all nineteen of them at once, because every drawing verb goes
   * through it.
   *
   * `graphMesh`, `graphPipeline` and `graphMaterial` are parallel to the arena's nodes and
   * hold what will not fit in an `Int32Array`. They are overwritten by index rather than
   * replaced, so a frame allocates nothing after the first.
   */
  /**
   * What this frame asked for against the ceilings above, reported rather than only warned about.
   *
   * **Declared here, before the rings, because a ring takes its line at construction.** Every
   * ceiling in this file already wrote one `console.warn` per renderer lifetime and nothing else,
   * which cannot be asserted on, cannot be read from a headless check and is gone by the time
   * anybody looks. The order below is the order a report reads in, so the two that lose world
   * geometry come first.
   */
  private readonly budget = new FrameBudget();
  private readonly drawBudget = this.budget.line('draws', MAX_DRAWS_PER_FRAME);
  private readonly materialBudget = this.budget.line('materials', MAX_MATERIALS_PER_FRAME);
  /**
   * Native bind groups built this frame, which is the one cost a consumer could not see.
   *
   * **No ceiling, because the honest number is nought.** Every other line here counts something
   * rationed; this counts something cached, so a steady scene settles at zero and any standing
   * figure is a cache missing. The measurement that found the albedo-keyed cache had to be taken
   * from outside, by reading a consumer's baked models and replaying this state machine over them
   * in draw order, precisely because the frame reported draws and material changes and never this.
   */
  private readonly bindGroupBudget = this.budget.line('bind groups', null);
  private readonly shadowDrawBudget = this.budget.line('shadow draws', MAX_DRAWS_PER_FRAME);
  private readonly scatterDepthBudget = this.budget.line(
    'scatter shadow draws',
    MAX_SCATTER_DEPTH_DRAWS,
  );
  private readonly waterBudget = this.budget.line('water bodies', MAX_WATER_BODIES_PER_FRAME);
  private readonly lightVolumeBudget = this.budget.line(
    'light volumes',
    MAX_LIGHT_VOLUMES_PER_FRAME,
  );
  private readonly windStreakBudget = this.budget.line('wind streak fields', MAX_BATCHES_PER_FRAME);
  private readonly flockBudget = this.budget.line('flocks', MAX_BATCHES_PER_FRAME);
  private readonly boltBudget = this.budget.line('bolt batches', MAX_BATCHES_PER_FRAME);
  private readonly causticsBudget = this.budget.line('caustics', MAX_BATCHES_PER_FRAME);
  private readonly textBudget = this.budget.line('text draws', MAX_OVERLAYS);
  private readonly sdfTextBudget = this.budget.line('sdf text draws', MAX_OVERLAYS);
  private readonly lineBudget = this.budget.line('line draws', MAX_OVERLAYS);
  private readonly panelBudget = this.budget.line('panels', MAX_OVERLAYS);

  /**
   * What the frame just drawn asked for, and what it was refused.
   *
   * The same object every frame, updated in place — see `budget.ts` for why a number rather than
   * a log, and why `dropped` is the one field a consumer's own check should fail on.
   */
  get frameBudget(): FrameBudget {
    return this.budget;
  }

  private readonly arena: Arena = createArena(MAX_DRAWS_PER_FRAME);
  /**
   * Node indices the last schedule kept.
   *
   * **Sized from the arena at replay, which this used to only claim.** It was allocated at
   * `MAX_DRAWS_PER_FRAME` and never grown, while the arena beside it reallocates at twice its
   * capacity — so a frame recording more nodes than this holds had the tail of its passes
   * dropped by `keptNodes`, silently. A node is one per *verb*, not per draw, so overlays,
   * scatter, plumes and text reached it long before the draw ring was full.
   */
  private replayScratch: Int32Array = new Int32Array(MAX_DRAWS_PER_FRAME);
  /**
   * The identifier graph's working set, where `quality.identifierGraph` asks for it and not
   * otherwise: a renderer scheduling by masks carries none of it. Sized with the arena, and grown
   * by `scheduleFlush` the way the arena grows.
   */
  private readonly flushSchedule: FlushSchedule | null;
  private readonly scheduledPasses: ScheduledPass[] = Array.from({ length: 64 }, () => ({
    writes: 0,
    first: 0,
    count: 0,
    clear: 0,
    discard: 0,
  }));
  private readonly commands: CommandPool = createCommandPool(MAX_DRAWS_PER_FRAME);
  /** Guards `ensurePass` against re-entering the flush that is already running. */
  private flushing = false;
  /** Starts near the verb count; reaching zero is what says the migration is done. */
  private flushesThisFrame = 0;
  private verbFlushesThisFrame = 0;
  /** Passes the last flush scheduled. Zero when nothing has flushed this frame. */
  private passesLastFlush = 0;
  /** Every resource the last flush derived a discard for, as one mask. */
  private discardsLastFlush = 0;
  /** Every resource the last flush derived a clear for, as one mask. */
  private clearsLastFlush = 0;
  /**
   * What still owes a clear this frame.
   *
   * **Owed by attachment rather than by frame**, which `frameNeedsClear` could not express. The
   * rule it carried is that a scene opening the mirror before it draws anything still owes the
   * frame its clear afterwards, and a scene that drew first does not — a rule that lived inside
   * one branch and could not be asked about. Bits are removed by the open that performs them.
   */
  private pendingClearMask = 0;
  /**
   * What the next frame pass to open may discard.
   *
   * Held rather than passed, because the open happens inside `openPass`, which the direct path
   * uses too — threading a graph concept through its signature would put the graph in the one
   * method that exists to have nothing to do with it. Cleared on use, so a pass opened outside a
   * flush gets zero, which is the conservative answer and the right one.
   */
  private pendingDiscard = 0;

  /**
   * Every flush this frame, of either kind.
   *
   * Exposed because the plan gates narrowing `liveOut` on a flush count, and a private counter
   * no caller can read is a claim rather than a measurement. Reading it costs a field access,
   * so a scene can print it every frame without paying for the privilege.
   */
  get graphFlushes(): number {
    return this.flushesThisFrame;
  }

  /**
   * Flushes caused by a verb about to draw directly, which is what must reach zero.
   *
   * **The plan asks for `flushesThisFrame` to reach zero and that number cannot.** A boundary
   * flush is inherent: the mirror gets a different encoder and its own submit, the overlay is
   * closed on a microtask, the depth snapshot ends the pass to copy the attachment out, and an
   * inset changes the viewport. The design says as much about the reopens — all three are
   * inherent and removing them was never the point — so a frame that reflects will always
   * flush at least twice however complete the migration is.
   *
   * What the migration is actually measured by is the *other* kind: a verb reaching
   * `ensurePass` because it is about to issue commands itself. That is the number that starts
   * near the verb count and goes to zero, and it is the one the gate belongs on.
   */
  get graphVerbFlushes(): number {
    return this.verbFlushesThisFrame;
  }

  /**
   * Passes the last flush scheduled, which is how a write-set declaration becomes observable.
   *
   * A node declaring a target it does not write is invisible in the picture — the executor
   * replays into whatever pass is open regardless — and shows up here as a pass count that does
   * not match the boundaries the frame actually has.
   */
  get graphPasses(): number {
    return this.passesLastFlush;
  }

  /**
   * Everything the last flush derived a discard for, as one mask.
   *
   * **Derived, and not yet acted on.** The executor replays every node into the pass `openPass`
   * gives it, so this changes no bytes on any device. It is the derivation `resolvedStoreOp`
   * takes from a person today, in a form a test can read — which is the whole difference the
   * design claimed for itself, and the only part of it verifiable without a tiler.
   */
  get graphDiscards(): number {
    return this.discardsLastFlush;
  }

  /**
   * Everything the last flush derived a clear for.
   *
   * The scheduler and `pendingClearMask` compute the same thing, and the mask is what the open
   * acts on — see `openPass` for why it has to be, since a pass can be opened where no schedule
   * describes it. This is the scheduler's answer, exposed so the two can be held against each
   * other rather than assumed to agree.
   */
  get graphClears(): number {
    return this.clearsLastFlush;
  }

  /**
   * What the last flush's discards are worth, in attachment bytes a frame.
   *
   * The figure the design is arguing about, computed from the schedule and the sizes this
   * renderer allocated rather than estimated from a viewport somebody quoted. Only the two
   * depth attachments can appear in it, because they are the only resources the derivation
   * finds dead — see `liveOutMidFrame`.
   *
   * **A byte here is a byte a tiler would not write.** An immediate-mode GPU has nowhere else
   * to put the data and writes it regardless, which is exactly why this number cannot be
   * confirmed on the machines available here however carefully it is computed.
   *
   * `depth24plus` is counted at four bytes a sample. The format is implementation-defined and
   * a driver may use more; four is the floor, so this number is a floor too.
   */
  get graphDiscardBytes(): number {
    const mask = this.discardsLastFlush;
    let bytes = 0;
    if ((mask & maskOf('sceneDepth')) !== 0) {
      const width = this.depth?.width ?? 0;
      const height = this.depth?.height ?? 0;
      bytes += width * height * DEPTH_BYTES_PER_SAMPLE * this.samples;
    }
    if ((mask & maskOf('mirrorDepth')) !== 0 && this.reflection !== null) {
      const { width, height } = this.reflection;
      /* The mirror's depth is allocated at the mirror's own sample count, which
         `createGpuReflection` takes from the same `samples` the frame uses. */
      bytes += width * height * DEPTH_BYTES_PER_SAMPLE * this.samples;
    }
    return bytes;
  }
  private bindGroup: GPUBindGroup;
  /** Kept so the flat bind group can be rebuilt when a cubemap changes hands. */
  private readonly flatTextures: (name: string) => { view: GPUTextureView; sampler: GPUSampler };

  /**
   * Which permutation of the fragment shader this renderer draws with.
   *
   * **Chosen from the resolved profile, which is what `renderer.ts` does — and it does it
   * once, not per material.** `flatFrag` is compiled at construction there from the same four
   * flags, so a world with shadows off compiles none of the shadow path on either backend.
   * This was pinned to `directionalShadows` while the point-shadow samplers had nowhere to
   * come from, which meant the two backends could be running different programs for one
   * profile and nothing said so.
   *
   * `environmentProbe` is false because `bakeReflectionProbe` is not on this class at all, so
   * a scene that wants one gets a named `TypeError` rather than a shader compiled around a
   * probe that will never be filled. That is the loud failure the 2026-08-13 rule asks for.
   *
   * It was `none` for a day, because turning it on drew the scene uniformly black. That was
   * not the shadow path: `shadowMapSize` was missing from this class, so the light matrix
   * every scene builds from it was NaN. See the accessor for what that cost and how it hid.
   */
  private readonly variant: FlatVariant;
  /** Whether this profile compiled the point-shadow path, and so has sentinels to write. */
  private readonly pointShadowsCompiled: boolean;
  /** What the generator recorded about that permutation: sizes, offsets and bindings. */
  private readonly fragment: ReturnType<typeof flatFragmentBindings>;

  private depth: GPUTexture | null = null;
  private depthView: GPUTextureView | null = null;

  /**
   * The pass a draw arriving *after* `endFrame` goes into, and the depth it needs.
   *
   * **An application is allowed to draw its interface after the frame resolves, and one does.**
   * One consumer puts its announcements, its portraits and its item cases after `endFrame`
   * deliberately, so the interface is not inside the off-screen target and is not blurred by the
   * screen-space effects that sample it. WebGL2 allows that for free: its commands run eagerly
   * against the canvas, so a draw after the resolve simply lands on top of it.
   *
   * This backend records into an encoder that `endFrame` has already submitted, so every one of
   * those calls found `this.pass === null` and returned — no text, and a portrait box holding
   * whatever the canvas had, which through a transparent canvas is nothing at all. It reported
   * none of it, which is the failure this whole backend keeps producing.
   *
   * So the pass is reopened on demand, on the canvas itself rather than on the scene target: the
   * composite has already run and this content is meant to sit over its output, untouched by it.
   * Its depth is its own and single-sampled, because the frame's depth carries the scene's sample
   * count and WebGPU requires every attachment in a pass to agree.
   */
  private overlayDepth: GPUTexture | null = null;
  private overlayDepthView: GPUTextureView | null = null;
  /** Whether the open pass is one reopened after the frame was submitted. */
  private overlayActive = false;
  /** Whether a flush is already queued, so a hundred overlay draws queue one. */
  private overlayFlushQueued = false;
  /**
   * The multisampled colour target, when the profile asked for one.
   *
   * Null at one sample, where the swap chain texture is drawn into directly and there is
   * nothing to resolve. Above one it is the *render* target and the swap chain becomes the
   * `resolveTarget`, which is where the averaging happens — the whole reason this exists.
   */
  private colorMsaa: GPUTexture | null = null;
  private colorMsaaView: GPUTextureView | null = null;
  /** This frame's swap-chain view, taken once so the mirror pass can reopen onto the same one. */
  private frameSwapView: GPUTextureView | null = null;

  /* -- The composite ------------------------------------------------------------------- */

  /**
   * Where the frame lands when there is a composite to resolve it.
   *
   * Null where `screenEffects` is off, and then every pass writes straight to the swap chain
   * exactly as it did before this existed — which is also what makes `bindMeshPass` grade in
   * the mesh pass in that case, because that pass is then the last one.
   */
  private sceneColor: GPUTexture | null = null;
  /**
   * The colour the frame had already drawn when the first refracting draw arrived.
   *
   * **A copy, because no shader can read what the pass is writing.** `post.sceneColorMsaa` is
   * created `RENDER_ATTACHMENT` with no `TEXTURE_BINDING` and `post.sceneColor` is the pass's own
   * resolve target, so the only readable thing is a texture nothing is currently attached to.
   * `takeRefractSnapshot` ends the pass, which resolves, copies, and reopens.
   */
  private refractSnapshot: GPUTexture | null = null;
  private refractSnapshotView: GPUTextureView | null = null;
  /** Whether this frame has taken it. One snapshot serves every refracting draw. */
  private refractSnapshotTaken = false;
  private sceneColorView: GPUTextureView | null = null;
  /** The multisampled twin, when the profile asks for samples. Resolved into `sceneColor`. */
  private sceneColorMsaa: GPUTexture | null = null;
  private sceneColorMsaaView: GPUTextureView | null = null;
  /** Sample zero of the depth, as something the generated shaders can read. See `postPass.ts`. */
  private resolvedDepth: GPUTexture | null = null;
  private resolvedDepthView: GPUTextureView | null = null;
  private aoTarget: GPUTexture | null = null;
  private aoTargetView: GPUTextureView | null = null;
  /**
   * Where the blur's first axis lands, so the second can read it.
   *
   * **The blur is not a polish step on this estimate, it is half of the algorithm.**
   * `ambientOcclusion.ts` says so at the top: the estimate turns its twelve taps by a rotation
   * that repeats over a 4×4 tile, and the four-wide blur is what averages all sixteen rotations
   * back into one answer. Twelve taps are only enough *because* the blur completes the kernel.
   *
   * Without it the estimate is what that file calls salt and pepper over every surface, and that
   * is exactly what shipped here: `AO_BLUR_FRAG_WGSL` was imported into this file and never
   * called, while `runOcclusion`'s own comment said "then a blur across it". Reported from both
   * consumers as a fine grain — white on one's pillars, dark on the ground under
   * the other's character — and measured on `gilded-chamber` under the first's grade at 41,106
   * speckled pixels against WebGL2's 28,107.
   *
   * Separable, so it is two passes over a half-resolution target rather than one wide one:
   * across into here, then down and back into `aoTarget`, which is what the composite samples.
   */
  private aoScratch: GPUTexture | null = null;
  private aoScratchView: GPUTextureView | null = null;
  /**
   * The bloom pyramid, level 0 at half the frame and each one after it half again.
   *
   * A list rather than one target, because bloom *is* the pyramid: the frame is thresholded into
   * level 0, halved down the chain, and added back up so level 0 holds every octave at once.
   * This backend had the first of those eleven draws and nothing else, which drew a thresholded
   * image with no blur in it — see `bloomChain.ts` for what that measured.
   */
  private bloomLevels: BloomLevel[] = [];
  /**
   * One bind group per distinct *source*: the scene first, then each level.
   *
   * Built on resize rather than per stage, because `AGENTS.md` forbids allocating in the frame
   * loop and eleven `createBindGroup` calls a frame is exactly that. What differs between stages
   * beyond the source is the uniform block, and that rides on a dynamic offset instead, which is
   * what the layout already declares.
   */
  private bloomGroups: GPUBindGroup[] = [];
  private frameWidth = 1;
  private frameHeight = 1;
  /**
   * What the scene is drawn at, which is the drawing buffer unless a reconstruction is enlarging it.
   *
   * **Everything before the resolve is this size and everything after it is the drawing buffer's.**
   * The scene colour and its multisampled twin, the depth, the refraction snapshot, the resolved
   * depth, the occlusion pair, the medium, the translucent buffers, the reflection march, the
   * decals, the temporal history and the frame pass's own viewport are all before it; the composite
   * and the overlay are after it, and they are what the viewer's pixels are counted in.
   *
   * **The composite is what enlarges the picture, and it does so by existing.** It draws a
   * full-screen triangle into the swap chain sampling the scene by `uv` through a linear sampler, so
   * a smaller scene target is magnified by that sample and nothing else changes — which is why this
   * needs `screenEffects` and is refused without it: with no composite the world draws straight into
   * the swap chain and there is nothing to enlarge from.
   *
   * Equal to the drawing buffer whenever `quality.reconstruction` is 0, which is the default, and
   * `recon/frameSizes.ts` is the one place the two are related.
   */
  private renderWidth = 0;
  private renderHeight = 0;
  /** The view-projection this frame was drawn with, for the reprojection motion blur needs. */
  private readonly previousViewProj = new Float32Array(16);
  private readonly reprojection = new Float32Array(16);
  private hasPreviousView = false;
  /** The projection, for occlusion. Null until a mesh pass has settled one. */
  private frameProjection: Float32Array | null = null;
  private readonly aoInvProjection = new Float32Array(16);
  private readonly aoProjScale = new Float32Array(2);
  /**
   * Whether this frame has already taken the depth snapshot a light volume clamps against.
   *
   * One per frame, not one per volume: every volume in a frame reads the same opaque scene, and
   * a second snapshot would cost a pass break and a full-screen resolve to produce identical
   * texels. Reset by `beginFrame`.
   */
  private volumeDepthTaken = false;
  /** Scratch for `uDepthToLocal`, built per volume draw and never allocated in the frame loop. */
  private readonly volumeDepthToLocal = new Float32Array(16);
  private readonly volumeDepthScratch = new Float32Array(16);

  private readonly pickables = new PickableSet();
  private readonly pickOrigin = new Float32Array(3);
  private readonly pickDirection = new Float32Array(3);

  private readonly depthResolveLayout: GPUBindGroupLayout;
  private readonly rushLayout: GPUBindGroupLayout;
  private readonly rushUniforms: GPUBuffer;
  private readonly rushStaging = new ArrayBuffer(RUSH_FRAG_SIZE);
  private readonly rushFloats = new Float32Array(this.rushStaging);
  private readonly rushInts = new Int32Array(this.rushStaging);
  private rushBindGroup: GPUBindGroup | null = null;
  /**
   * The colour grade, as a 3D texture, and the table it was built from.
   *
   * The source is kept to compare identities rather than to read: a consumer setting a grade
   * every frame would otherwise re-upload 131 kilobytes sixty times a second for bytes that did
   * not change. See `SceneTarget.setColourGrade`, which keeps the same pair for the same reason.
   */
  private gradeTexture: GPUTexture | null = null;
  private gradeView: GPUTextureView | null = null;
  private gradeSource: ColourGradeLut | null = null;
  private gradeSize = GRADE_PLACEHOLDER_SIZE;
  private gradeStrength = 0;
  /** So the refusal in `setColourGrade` is once per renderer rather than once per frame. */
  private warnedGradeWithoutComposite = false;
  private readonly aoLayout: GPUBindGroupLayout;
  private readonly aoUniforms: GPUBuffer;
  /**
   * The global medium: one half-res march and one composite, each with a block of its own.
   *
   * **Two layouts rather than one, because they read different things.** The march reads the
   * depth and the three shadow maps; the composite reads the depth and what the march wrote.
   * The march's target is `rgba16float` — scattered light has no reason to sit in 0 to 1 against
   * an HDR scene, and transmittance wants more than eight bits near 1, where a thin fog lives and
   * where banding would therefore show first.
   */
  private readonly mediumLayout: GPUBindGroupLayout;
  private readonly mediumUniforms: GPUBuffer;
  private readonly mediumStaging = new ArrayBuffer(MEDIUM_FRAG_SIZE);
  private readonly mediumFloats = new Float32Array(this.mediumStaging);
  private readonly mediumInts = new Int32Array(this.mediumStaging);
  private mediumTarget: GPUTexture | null = null;
  private mediumTargetView: GPUTextureView | null = null;
  private mediumBindGroup: GPUBindGroup | null = null;
  private readonly mediumUpsampleLayout: GPUBindGroupLayout;
  private readonly mediumUpsampleUniforms: GPUBuffer;
  private readonly mediumUpsampleStaging = new ArrayBuffer(MEDIUM_UPSAMPLE_SIZE);
  private readonly mediumUpsampleFloats = new Float32Array(this.mediumUpsampleStaging);
  private mediumUpsampleGroup: GPUBindGroup | null = null;
  /** The inverse projection the composite linearises a depth with, built once per frame. */
  private readonly mediumInvProjection = mat4.create();
  /** This frame's medium. Off until a caller says otherwise. See `setGlobalMedium`. */
  private mediumOptions: GlobalMediumOptions = DEFAULT_GLOBAL_MEDIUM;
  /**
   * The temporal resolve: its block, its ping-pong pair, and the jitter state.
   *
   * **`correctedViewProj` stays unjittered and `viewProj` is what draws.** The reprojection is
   * built from the former, because the history holds a resolved picture standing for the
   * *unjittered* scene — reprojecting through a jittered matrix would look every sample up half a
   * pixel from where it is and cancel the accumulation.
   */
  private readonly taaStaging = new ArrayBuffer(TAA_FRAG_SIZE);
  private readonly taaFloats = new Float32Array(this.taaStaging);
  private taaLayout!: GPUBindGroupLayout;
  private taaUniforms!: GPUBuffer;
  private taaTextures: (GPUTexture | null)[] = [null, null];
  private taaViews: (GPUTextureView | null)[] = [null, null];
  /** Group `i` reads history `i` and the pass writes into the other one. */
  private taaBindGroups: (GPUBindGroup | null)[] = [null, null];
  private taaWrite = 0;
  private readonly temporalHistory = new TemporalHistory();
  private readonly jitteredViewProj = mat4.create();
  private temporalJitterX = 0;
  private temporalJitterY = 0;
  private temporalJittering = false;
  /**
   * Whether this frame is being reconstructed, settled once in `bindMeshPass`.
   *
   * It is not `quality.reconstruction > 0` on its own: a mirror pass is skipped for the same reason
   * the temporal jitter skips one — a reflection is not the picture the history holds — and without
   * a composite there is nothing to enlarge the render from.
   */
  private reconstructing = false;
  /** Said once rather than every frame, as the translucent set's own refusal is. */
  private reconMultisampleSaid = false;
  private reconFrameIndex = -1;
  private readonly reconJitter = new Float32Array(2);
  private readonly reconPreviousJitter = new Float32Array(2);
  /**
   * `reconJitter` as a fraction of the clip square, which is what a contributed pass is handed.
   * See `PrepareContext.jitter`; zero on a frame that is not reconstructed.
   */
  private readonly passJitter = new Float32Array(2);
  /**
   * The reconstruction's own targets, allocated only while a consumer asks for one.
   *
   * **Two histories rather than one**, for the reason the temporal resolve keeps two: a dispatch
   * cannot read the texture it is writing. The shown picture is a third, because the history holds
   * the *unsharpened* result — sharpening into the history would sharpen a sharpened picture every
   * frame, which is the halo the reference's own clamp exists to prevent, compounded.
   *
   * The motion target is render size and carries a drawn object's own motion where something wrote
   * one. **Nothing writes it yet**, so it is cleared every frame and every pixel takes the camera's
   * motion, which the resolve derives from the depth and the reprojection. Static geometry is
   * exact that way and a moving object ghosts until the motion pass lands.
   */
  private reconHistories: (GPUTexture | null)[] = [null, null];
  private reconHistoryViews: (GPUTextureView | null)[] = [null, null];
  private reconWrite = 0;
  private reconHasHistory = false;
  private reconShown: GPUTexture | null = null;
  private reconShownView: GPUTextureView | null = null;
  private reconMotion: GPUTexture | null = null;
  private reconMotionView: GPUTextureView | null = null;
  private reconPreviousDepth: GPUTexture | null = null;
  private reconPreviousDepthView: GPUTextureView | null = null;
  private reconParams: GPUBuffer | null = null;
  private readonly reconStaging = new ArrayBuffer(RECON_PARAM_FLOATS * 4);
  private readonly reconFloats = new Float32Array(this.reconStaging);
  private readonly reconInts = new Uint32Array(this.reconStaging);
  private reconLayout: GPUBindGroupLayout | null = null;
  private reconResolvePipeline: GPUComputePipeline | null = null;
  private reconSharpenPipeline: GPUComputePipeline | null = null;
  private reconGroups: (GPUBindGroup | null)[] = [null, null];
  private reconSharpenGroups: (GPUBindGroup | null)[] = [null, null];
  private reconRushGroup: GPUBindGroup | null = null;
  /**
   * What the motion pass will draw, recorded by `drawMesh` and spent once a frame.
   *
   * A parallel array of meshes and one flat matrix buffer rather than an array of objects, because
   * this is written on the frame's hot path and the house rule about allocating there binds it: the
   * matrices are copied into a buffer that only ever grows, and the count is what resets.
   */
  private readonly motionMeshes: GpuMesh[] = [];
  private motionMatrices = new Float32Array(0);
  private motionCount = 0;
  private motionLayout: GPUBindGroupLayout | null = null;
  /**
   * One pipeline per vertex stride, because a stride is a property of the *mesh*.
   *
   * Which optional attributes a mesh supplied decides how far apart its positions are, and this
   * pass reads nothing but positions — so two meshes drawn by the same shader still need two
   * vertex layouts. A map rather than a cache key on the pipeline cache: there is one shader here
   * and a handful of strides in any scene.
   */
  private readonly motionPipelines = new Map<number, GPURenderPipeline>();
  private motionModule: GPUShaderModule | null = null;
  private motionPipelineLayout: GPUPipelineLayout | null = null;
  private motionFrameBuffer: GPUBuffer | null = null;
  private motionDrawBuffer: GPUBuffer | null = null;
  private motionDrawCapacity = 0;
  private motionGroup: GPUBindGroup | null = null;
  private readonly motionFrameStaging = new Float32Array(MOTION_FRAME_FLOATS);
  private motionDrawStaging = new Uint8Array(0);
  /** The scene's own clip transform with the generated shaders' y negation folded in. */
  private readonly motionRaster = mat4.create();
  private reconSizeKey = '';
  /** Last frame's raw view-projection and its inverse, and the two eyes. */
  private readonly reconPreviousRawViewProj = mat4.create();
  private readonly reconInverseViewProj = mat4.create();
  private readonly reconPreviousInverseViewProj = mat4.create();
  private readonly reconEye = new Float32Array(3);
  private readonly reconPreviousEye = new Float32Array(3);
  private temporalHistoryUsable = false;

  private readonly aoStaging = new ArrayBuffer(AO_FRAG_SIZE);
  private readonly aoFloats = new Float32Array(this.aoStaging);
  private aoBindGroup: GPUBindGroup | null = null;
  private readonly aoBlurLayout: GPUBindGroupLayout;
  /**
   * Both blur axes' blocks in one buffer, a slot each, reached by dynamic offset.
   *
   * The same shape the bloom chain uses and for the same reason: the two passes differ only in
   * `uStep`, and a buffer holding one block would give the second pass the first one's axis —
   * which is a blur run twice across and never down, and looks like a blur that half worked.
   */
  private readonly aoBlurUniforms: GPUBuffer;
  private readonly aoBlurStaging = new ArrayBuffer(AO_BLUR_SLOT * 2);
  private readonly aoBlurFloats = new Float32Array(this.aoBlurStaging);
  /** One group per source: the estimate for the across pass, the scratch for the down pass. */
  private aoBlurAcrossGroup: GPUBindGroup | null = null;
  private aoBlurDownGroup: GPUBindGroup | null = null;
  private readonly bloomLayout: GPUBindGroupLayout;
  private readonly bloomUniforms: GPUBuffer;
  /**
   * Every stage's block at once, one aligned slot each, written on resize and not per frame.
   *
   * **Nothing in these blocks changes between frames.** A texel size is a function of the
   * target, the threshold is construction-time on the profile, and the tent radius is a
   * constant — so a per-frame upload would rewrite the same bytes sixty times a second. Written
   * together also sidesteps the hazard this file has met twice: `queue.writeBuffer` does not
   * interleave with recorded commands, so one buffer rewritten between two passes gives both
   * passes the last write.
   */
  private readonly bloomStaging = new ArrayBuffer(BLOOM_SLOT * BLOOM_SLOTS);
  private readonly bloomFloats = new Float32Array(this.bloomStaging);
  private readonly postSampler: GPUSampler;
  private readonly postDepthSampler: GPUSampler;

  /** Whether the profile asked for a composite at all. Everything below is null when it did not. */
  private get hasComposite(): boolean {
    return this.quality.screenEffects;
  }

  /**
   * Whether this renderer is set up to reconstruct, asked in one place by everything that cares.
   *
   * **One condition and not three**, which §3 row 132 is the lesson of: the frame's flag, the size
   * the targets are built at and the size the world is drawn at all turn on the same question, and
   * three copies of it are three lines no test can fail — each covering the others, so breaking any
   * one of them changes nothing anybody can see.
   *
   * A composite, because the composite is what enlarges the render; one sample, because the motion
   * pass draws against the depth the scene left and every attachment in a pass must agree about its
   * sample count — `RECONSTRUCTION_MULTISAMPLE_REFUSAL` says the rest. Whether a *frame* is
   * reconstructed adds one more question, the mirror's, and that one belongs to the frame.
   */
  private get reconstructionWanted(): boolean {
    return this.quality.reconstruction > 0 && this.hasComposite && this.samples === 1;
  }

  /** What a frame pass writes into: the scene target where there is one, the swap chain else. */
  /**
   * This frame's swap-chain view, taken on first use rather than at `beginFrame`.
   *
   * `getCurrentTexture` is an acquisition and not a read: the texture it hands back is what the
   * browser presents when the task ends, whether or not anything drew into it. Taking it only
   * when something is about to draw is what keeps a frame that fails from blanking the screen.
   */
  private swapView(): GPUTextureView | null {
    if (this.frameSwapView !== null) return this.frameSwapView;
    if (this.surface.lost) return null;
    this.frameSwapView = this.surface.context.getCurrentTexture().createView();
    /* See `presentedFrames`: this line is the acquisition it exists to count. */
    this.presentedFrameCount++;
    return this.frameSwapView;
  }

  private compositeTarget(): GPUTextureView | null {
    return this.hasComposite ? this.sceneColorView : this.swapView();
  }

  /** Its multisampled twin, or null at one sample. */
  private compositeMsaa(): GPUTextureView | null {
    return this.hasComposite ? this.sceneColorMsaaView : this.colorMsaaView;
  }
  /** Samples per pixel, settled at construction. See `supportedSampleCount`. */
  private readonly samples: number;
  /** The camera the frame is being drawn with, copied into every draw's slot. */
  private viewProj: Float32Array | null = null;
  /**
   * The frame's camera as the caller built it, uncorrected and unjittered.
   *
   * **`viewProj` is not this**, and a decal wants this one. That matrix carries `CLIP_CORRECTION`
   * and the frame's sub-pixel jitter; the generated vertex stages then negate Y a second time, so
   * the Y the rasteriser actually used is *this* matrix's. `DEPTH_01_TO_CLIP_Y_DOWN` carries the
   * derivation and what one missing negation costs.
   */
  private readonly frameRawViewProj = mat4.create();
  private frameCameraSeen = false;
  /** Where the frame's camera stands, which gives a reconstructed normal its sign. */
  private readonly frameEye = new Float32Array(3);
  /** The environment the frame was drawn with. See `bindMeshPass`. */
  private frameEnv: Environment | null = null;
  /** That matrix with the clip-space correction folded in, rebuilt once a frame. */
  private readonly correctedViewProj = new Float32Array(16);

  private readonly skyLayout: GPUBindGroupLayout;
  private readonly skyUniforms: GPUBuffer;
  private readonly skyStaging = new ArrayBuffer(SKY_UNIFORM_SIZE);
  private readonly skyFloats = new Float32Array(this.skyStaging);
  private readonly skyBindGroup: GPUBindGroup;
  /** The camera's inverse with the clip correction undone, rebuilt once a frame. */
  private readonly skyInvViewProj = new Float32Array(16);
  /* -- The mirror pass ----------------------------------------------------------------- */

  /**
   * The reflection target, or null where the profile has no use for one.
   *
   * Allocated on the same condition `renderer.ts` allocates its own: water with reflections
   * on, or `planarReflections` asked for outright by a scene whose mirror is not water.
   */
  /**
   * Whether this profile has any use for a mirror, on the same condition `renderer.ts` uses:
   * water with reflections on, or a scene that asked for one outright because its mirror is
   * not water. A profile with neither never pays for the target.
   */
  private readonly wantsReflection: boolean;
  private reflection: GpuReflection | null = null;
  /** Refilled on resize rather than allocated; see `reflectionTargetSize`. */
  private readonly reflectionSize: ReflectionSize = { width: 0, height: 0 };
  /**
   * Order-independent transparency: the recorded set, the two buffers, and which one is open.
   *
   * **Recorded rather than drawn**, because the accumulation and the revealage are two blend
   * states over the same geometry — and on this backend a blend state is baked into a pipeline, so
   * they are two pipelines as well. `TranslucentQueue` is what lets the set be submitted twice.
   */
  private readonly translucentQueue = new TranslucentQueue();
  private oitActive = false;
  /** Said once for the whole renderer. See `refuseOitMultisampled`. */
  private oitMultisampleRefused = false;
  private oitReplaying = false;
  /** Which buffer the replay is filling, which the pipeline key must carry. */
  private oitMode: OitTarget = 'none';
  /**
   * The pass the replay draws into.
   *
   * **While this is set, `openPass` hands it back and `recordDraw` refuses.** The frame graph
   * records draws to replay them into the frame's own passes; these draws belong to a pass of
   * their own, opened here and closed before anything else runs.
   */
  private oitEncoder: GPURenderPassEncoder | null = null;
  private oitAccum: GPUTexture | null = null;
  private oitAccumView: GPUTextureView | null = null;
  private oitReveal: GPUTexture | null = null;
  private oitRevealView: GPUTextureView | null = null;
  /**
   * The frame's drawn decals, their block per mark, and the group that reads the resolved depth.
   *
   * Recorded rather than drawn where the call is made: a projected mark is decided from the depth
   * the frame has drawn, so it cannot run until the opaque world is finished. See `DecalQueue`.
   */
  private readonly decalQueue = new DecalQueue();
  /** The fields this frame declared, composed at `endFrame`. See `addDistanceField`. */
  private readonly distanceFields = new DistanceFieldScene();
  /**
   * The composition of them, built at the first frame that has both the flag and a field.
   *
   * **Not at construction**, because it is 1.4 MB of device buffers and a compute pipeline, and a
   * profile with `indirectLight` on is entitled to declare no fields at all — a scene that lights
   * itself entirely from a baked probe grid, for one. Nothing is allocated until something would
   * be composed.
   */
  private fieldComposer: FieldComposer | null = null;
  /**
   * The probes' own bake, built at the first frame that has the flag, a field and an array.
   *
   * Not at construction, for `fieldComposer`'s reason: it is two compute pipelines, a render
   * pipeline and a handful of buffers, and a profile with the flag on may never declare a field.
   */
  private probeBaker: ProbeBaker | null = null;
  /** Which array the baker's views were built against, so a replacement is noticed. */
  private bakerArray: GPUTexture | null = null;
  /** Reused, because deriving a grid from the declared fields runs in the frame path. */
  private readonly fieldBoundsMin = new Float32Array(3);
  private readonly fieldBoundsMax = new Float32Array(3);
  /** Said once rather than every frame, as the other refusals are. */
  private indirectGridRefused = false;
  private decalLayout!: GPUBindGroupLayout;
  private decalUniforms!: GPUBuffer;
  private readonly decalStaging = new ArrayBuffer(DECAL_SLOT * MAX_DRAWN_DECALS);
  private readonly decalFloats = new Float32Array(this.decalStaging);
  private decalBindGroup: GPUBindGroup | null = null;
  /** Said once where a mark cannot be drawn at all, rather than dropped in silence. */
  private decalsRefused = false;
  /**
   * The frame's reflective surfaces, their block per surface, and the buffer the trace writes into.
   *
   * Recorded rather than traced where the call is made, because a march reads the *finished*
   * picture: what a ray finds is a pixel of the scene the frame has already drawn.
   */
  private readonly reflectionQueue = new ReflectionQueue();
  private ssrLayout!: GPUBindGroupLayout;
  private ssrResolveLayout!: GPUBindGroupLayout;
  private ssrUniforms!: GPUBuffer;
  private readonly ssrStaging = new ArrayBuffer(SSR_SLOT * MAX_REFLECTIVE_SURFACES);
  private readonly ssrFloats = new Float32Array(this.ssrStaging);
  private ssrReflection: GPUTexture | null = null;
  private ssrReflectionView: GPUTextureView | null = null;
  private ssrBindGroup: GPUBindGroup | null = null;
  private ssrResolveGroup: GPUBindGroup | null = null;
  /** `inverse(viewProjection) * DEPTH_01_TO_CLIP_Y_DOWN`, rebuilt once a frame. */
  private readonly ssrDepthToWorld = mat4.create();
  /** `CLIP_Y_FLIP * viewProjection`, the matrix the trace projects its samples back through. */
  private readonly ssrViewProj = mat4.create();
  private readonly ssrScissor = new Int32Array(4);
  /** Said once where a reflection cannot be traced at all. */
  private reflectionsRefused = false;
  /** `inverse(viewProjection) * DEPTH_01_TO_CLIP_Y_DOWN`, rebuilt once a frame and not per mark. */
  private readonly decalDepthToWorld = mat4.create();
  private readonly decalScissorRect = new Int32Array(4);
  private oitResolveLayout!: GPUBindGroupLayout;
  private oitResolveGroup: GPUBindGroup | null = null;
  /**
   * Reused, because the frame loop may not allocate. Mirrors the WebGL2 backend's own, which it
   * had stopped doing: the other one carried a pane's refraction and this one did not.
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
    depthWrite: false,
    depthLayer: 0,
    tint: null,
    refraction: 0,
    refractTint: undefined,
    thicknessM: 0,
  };

  private reflectionPassActive = false;
  /** Said once: a mirror asked for outside a frame is a call-order fault, not a device limit. */
  private saidMirrorOutsideFrame = false;
  /**
   * Whether the target holds this frame's mirror yet.
   *
   * Cleared when the pass opens and set when it closes, so water drawn *before* the mirror
   * finished samples nothing rather than last frame's. `PlanarReflection.isReadyFor` is the
   * same guard on the other backend, with the plane's height in it as well.
   */
  private reflectionReady = false;
  /** The plane the ready target was drawn for, so water at a different height does not use it. */
  private reflectionPlaneY = 0;
  /**
   * The height the medium is resolved at while the mirror is being drawn.
   *
   * **The source camera's, not the mirrored one's.** Fog is a property of where the *viewer*
   * stands, and a mirrored camera stands as far below the water as the viewer stands above it —
   * so resolving the medium from it puts the reflection underwater whenever the viewer is not.
   * `renderer.ts` keeps the same value for the same reason.
   */
  private reflectionAtmosphereY = 0;

  /**
   * Open the mirror pass: the world about to be drawn from behind the water.
   *
   * **The frame's pass is ended and reopened, which is the shape WebGPU makes explicit.** A
   * caller calls this *after* `beginFrame`, so there is a pass open on the swap chain; WebGL2
   * answers by rebinding a framebuffer, and here the only way to draw somewhere else is a
   * second render pass. `endPlanarReflection` reopens the frame's with `load`, so the clear and
   * anything drawn before the mirror survive it.
   *
   * **Declining is a supported state rather than a stub**, and is what a device that refuses
   * the allocation gets: every caller already branches on `null` — `demo/nightCourt` draws the
   * world once instead of twice — and `WaterRenderer` has a complete path for water with
   * nothing to sample.
   */
  beginPlanarReflection(source: Camera, planeY: number, clearColor: Vec3): Camera | null {
    const reflection = this.reflection;
    if (this.surface.lost || reflection === null) return null;
    /*
     * **A mirror belongs inside a frame, and saying so is the whole of this branch.**
     *
     * This pass records into the frame's own encoder, and there is no encoder until `beginFrame`
     * opens one — so a caller that mirrors *before* the frame got null here and read it as the
     * documented "no target could be allocated", which is what the other backend's null means.
     * The other backend has no encoder at all, so the same call order works there and the two
     * disagreed in silence: a consumer lost every planar reflection it had on this backend, on
     * every frame, with nothing in the console and a plausible picture on screen.
     *
     * `beginFrame` clears `reflectionReady` as well, so even an encoder handed over early would
     * have had its mirror marked stale before anything sampled it. The order is the contract; a
     * null that means "you called this too early" now says so once rather than looking like a
     * device that could not spare a target.
     */
    if (this.encoder === null) {
      if (!this.saidMirrorOutsideFrame) {
        this.saidMirrorOutsideFrame = true;
        console.warn(
          'WebGpuRenderer: beginPlanarReflection was called outside a frame, so no mirror was ' +
            'drawn. Call it after beginFrame, as the other backend also expects.',
        );
      }
      return null;
    }
    /*
     * Decided before anything is opened, exactly as `renderer.ts` decides it: a caller that
     * gets no camera skips the pass and never calls `endPlanarReflection`, so a half-opened
     * pass here would leave the frame's own encoder closed for the rest of the frame.
     */
    if (this.reflectionPassActive) return null;

    this.reflectionReady = false;
    this.reflectionPlaneY = planeY;
    this.reflectionAtmosphereY = source.position[1] ?? 0;
    const camera = aimReflection(reflection, source, planeY);

    /*
     * **The frame so far is submitted before the mirror is recorded, and that is not tidiness.**
     *
     * Every per-frame uniform block in this backend is one buffer, written by `bindMeshPass`,
     * `drawPlumes` and the rest. A scene draws its world twice — once mirrored, once not — so
     * each of those is written twice in a frame, and `queue.writeBuffer` does not interleave
     * with recorded commands: both passes would read whichever write landed last, which is the
     * main camera's. The mirror would come out with the frame's fog, the frame's camera
     * position and, worst of all, `uClipEnabled` at zero — a reflection containing everything
     * below the waterline, and no error anywhere.
     *
     * Submitting between the two puts the writes and the draws in the order they were made.
     * The alternative is a ring per uniform block, which is six of them to solve a problem two
     * submissions solve. See `UniformRing` for the same hazard one level down.
     */
    /*
     * Flush before the boundary, because these three do not go through `ensurePass`.
     *
     * Anything recorded and not yet replayed belongs to the pass that is about to end. Leaving
     * it would replay it into whichever pass opened next — the mirror's — which is a draw in
     * the wrong target rather than a missing one.
     */
    if (this.quality.frameGraph) this.flushGraph();
    /* The target changes here: the mirror is cleared, so this boundary reads nothing. */
    if (this.quality.frameGraph) recordNode(this.arena, VERB_SCOPE, 0, MIRROR_TARGET, 0, 0);
    this.pass?.end();
    this.flushRings();
    this.surface.device.queue.submit([this.encoder.finish()]);
    this.encoder = this.surface.device.createCommandEncoder({ label: 'reflection' });
    /*
     * **Opened on demand, like the frame's own.** Nothing has been recorded into the mirror yet,
     * so no schedule describes it, and a pass opened here would have its `loadOp` and `storeOp`
     * typed in before anything could derive them. `openPass` opens it at the first flush that
     * needs it, and `endPlanarReflection` opens it even where nothing drew, because the clear is
     * still owed.
     */
    this.pass = null;
    this.mirrorClearColor[0] = clearColor[0];
    this.mirrorClearColor[1] = clearColor[1];
    this.mirrorClearColor[2] = clearColor[2];
    this.pendingClearMask |= MIRROR_TARGET;
    this.reflectionPassActive = true;
    /* Closed in `endPlanarReflection`, matching `renderer.ts:2054`. */
    this.gpuTimer.begin('reflection');
    return camera;
  }

  /** The mirrored viewProjection under the clip correction, rebuilt per water draw. */
  private readonly correctedReflectionViewProj = new Float32Array(16);

  /**
   * Push every ring's slots up before the commands that read them are submitted.
   *
   * That ordering is the whole thing a ring depends on — writes land on the queue timeline
   * ahead of the pass that reads them — and it has to happen once per *submission* rather than
   * once per frame, because a frame with a mirror in it submits three times. Re-flushing a
   * prefix that has already been uploaded costs one write of unchanged bytes and cannot be
   * wrong: a ring only ever appends within a frame.
   */
  private flushRings(): void {
    this.perDraw.flush();
    this.lightVolumeVertices.flush();
    this.lightVolumeFragments.flush();
    this.plumeVerts.flush();
    this.plumeFrags.flush();
    this.waterVerts.flush();
    this.waterFrags.flush();
    this.boltVerts.flush();
    this.boltFrags.flush();
    this.causticsVerts.flush();
    this.causticsFrags.flush();
    this.flockVerts.flush();
    this.flockFrags.flush();
    this.windStreakVerts.flush();
    this.windStreakFrags.flush();
    this.scatterVerts.flush();
    this.perFrame.flush();
    this.filmVerts.flush();
    this.filmFrags.flush();
    this.insetUniforms.flush();
    this.panelVerts.flush();
    this.panelFrags.flush();
    this.textVerts.flush();
    this.textFrags.flush();
    this.sdfTextVerts.flush();
    this.sdfTextFrags.flush();
    this.lineVerts.flush();
    this.lineFrags.flush();
  }

  /* -- The film ------------------------------------------------------------------------- */

  private readonly filmLayout: GPUBindGroupLayout;
  private readonly filmVerts: UniformRing;
  private readonly filmFrags: UniformRing;
  private filmBindGroup: GPUBindGroup;
  /** The film's group with the blank in the mirror's slot; see where it is built. */
  private readonly filmBindGroupBlank: GPUBindGroup;

  /**
   * A thin wet layer over the world: an oil slick, a puddle, a wet patch.
   *
   * `renderer.ts` carries the argument about what `sheen` is and is not, and about why the
   * caller does not restate the plane the mirror was rendered for. The one thing this backend
   * adds is that the mirror's matrix is corrected, for the reason `drawWater` gives: the
   * reflection texture holds a frame in WebGPU's clip space, so a lookup projecting a world
   * point has to be in that same space or the film samples its own mirror image.
   */
  drawFilm(
    mesh: GpuMesh,
    camera: Camera,
    timeSeconds: number,
    env: Environment,
    sheen: number,
    options: FilmOptions = {},
  ): void {
    if (!this.canDraw()) return;
    const geometry = mesh as GpuMesh & { key?: string };
    if (geometry.vertexBuffers === undefined) return;
    const vertexSlot = this.filmVerts.allocate();
    const fragmentSlot = this.filmFrags.allocate();
    if (vertexSlot === null || fragmentSlot === null) return;

    const atV = (name: string): number => FILM_VERT_FIELDS[name]?.offset ?? 0;
    mat4.multiply(this.correctedViewProj, CLIP_CORRECTION, camera.viewProjection);
    this.filmVerts.writeFloats(vertexSlot, atV('uViewProj'), this.correctedViewProj);

    /*
     * The mirror this film lies in, or nothing.
     *
     * `reflectionFor` is what ties the two together, so a film on a plane the reflection was
     * not rendered for gets none rather than a mirror of somewhere else. A film drawn *inside*
     * the mirror pass gets none either: reflecting the reflection is what `renderer.ts` guards
     * with `!this.reflectionPassActive`.
     */
    const strength = options.reflectionStrength ?? 0;
    const mirror =
      strength > 0 && !this.reflectionPassActive
        ? this.reflectionFor(options.reflectionPlaneY ?? 0)
        : null;
    if (mirror === null) {
      this.filmVerts.writeFloats(vertexSlot, atV('uReflectionViewProj'), this.correctedViewProj);
    } else {
      mat4.multiply(
        this.correctedReflectionViewProj,
        CLIP_CORRECTION,
        mirror.camera.viewProjection,
      );
      this.filmVerts.writeFloats(
        vertexSlot,
        atV('uReflectionViewProj'),
        this.correctedReflectionViewProj,
      );
    }

    const f = this.filmFragFloats;
    const i = this.filmFragInts;
    const atF = (name: string): number => (FILM_FRAG_FIELDS[name]?.offset ?? -4) / 4;
    i[atF('uReflectionEnabled')] = mirror === null ? 0 : 1;
    f[atF('uReflectionStrength')] = mirror === null ? 0 : strength;
    f.set(camera.position, atF('uCameraPos'));
    f[atF('uTime')] = timeSeconds;
    i[atF('uClipEnabled')] = this.reflectionPassActive ? 1 : 0;
    f.set(this.reflection?.clipPlane ?? NO_CLIP_PLANE, atF('uClipPlane'));
    f[atF('uSheen')] = sheen;
    f[atF('uFilmRoughness')] = Math.min(1, Math.max(0, options.roughness ?? 0));
    f[atF('uFilmRoughnessCycles')] = Math.max(0.01, options.roughnessCyclesPerMetre ?? 60);

    const medium = resolveAtmosphere(
      env,
      this.atmosphereHeight(camera),
      this.quality.underwaterAtmosphere,
      this.medium,
    );
    f.set(medium.fogColor, atF('uFogColor'));
    f[atF('uFogDensity')] = medium.fogDensity;
    f[atF('uFogHeightFalloff')] = medium.fogHeightFalloff;
    f[atF('uFogEyeY')] = medium.fogEyeY;
    f.set(medium.underwaterColor, atF('uUnderwaterColor'));
    f[atF('uUnderwaterFogDensity')] = medium.underwaterFogDensity;
    f[atF('uUnderwaterFactor')] = medium.underwaterFactor;
    i[atF('uFogMode')] = medium.fogMode;
    f[atF('uFogNear')] = medium.fogNear;
    f[atF('uFogFar')] = medium.fogFar;
    this.filmFrags.writeBlock(fragmentSlot, this.filmFragInts);

    const filmPipe = filmPipeline(
      this.pipelines,
      this.surface.device,
      this.filmLayout,
      `film|${geometry.key ?? ''}`,
      this.presentOf(geometry),
    );
    /* The mirror is an attachment right now, so the group that does not hold it. */
    const filmGroup = this.reflectionPassActive ? this.filmBindGroupBlank : this.filmBindGroup;
    /*
     * Read from the group rather than from the intent, which is the only version that stays
     * true. A film inside the mirror binds the blank and samples nothing; a film outside it
     * holds the mirror's colour whatever `uReflectionEnabled` says, and WebGPU validates the
     * binding rather than the read — the argument `filmBindGroupBlank` exists for.
     */
    const filmCommand = this.recordDraw(
      filmGroup === this.filmBindGroup ? MIRROR_COLOR : 0,
      this.currentTarget(),
    );
    if (filmCommand !== null) {
      filmCommand.pipeline = filmPipe;
      filmCommand.bindGroup = filmGroup;
      filmCommand.offsetA = vertexSlot;
      filmCommand.offsetB = fragmentSlot;
      filmCommand.offsetCount = 2;
      for (let index = 0; index < geometry.vertexBuffers.length; index++) {
        filmCommand.vertexBuffers[index] = geometry.vertexBuffers[index] as GPUBuffer;
      }
      filmCommand.vertexCount = geometry.vertexBuffers.length;
      filmCommand.indexBuffer = geometry.indexBuffer;
      filmCommand.indexed = true;
      filmCommand.count = geometry.indexCount;
    } else {
      const pass = this.openPass();
      if (pass === null) return;
      pass.setPipeline(filmPipe);
      pass.setBindGroup(0, filmGroup, [vertexSlot, fragmentSlot]);
      for (let index = 0; index < geometry.vertexBuffers.length; index++) {
        pass.setVertexBuffer(index, geometry.vertexBuffers[index] as GPUBuffer);
      }
      pass.setIndexBuffer(geometry.indexBuffer, 'uint32');
      pass.drawIndexed(geometry.indexCount);
    }
  }

  /** Scratch for the film's fragment block, filled then copied into a slot. */
  private readonly filmFragStaging = new ArrayBuffer(FILM_FRAG_SIZE);
  private readonly filmFragFloats = new Float32Array(this.filmFragStaging);
  private readonly filmFragInts = new Int32Array(this.filmFragStaging);

  /* -- Surface textures ----------------------------------------------------------------- */

  /**
   * The image the following draws sample, and the bind group that carries it.
   *
   * **A bind group per texture, cached, rather than one rebuilt per material.** `createBindGroup`
   * is an allocation, and a scene like `night-street` switches texture once per textured part of
   * a loaded model — so rebuilding on every switch is exactly the per-frame allocation the house
   * rules forbid, and the same trap `rebindPointShadowsIfMoved` avoids by dirty-checking. The
   * map is keyed by the texture object, so a material switched away from and back to costs a
   * lookup.
   */
  private albedo: GpuSurfaceTexture | null = null;
  /**
   * The material's normal map, or null for the stand-in.
   *
   * Not cached per texture the way albedo is: a material changes its albedo far more often than
   * its normal map, and a second cache keyed on a second texture is a product of the two.
   */
  private normalMap: GpuSurfaceTexture | null = null;
  private ormMap: GpuSurfaceTexture | null = null;
  /** The caller's emissive map, or null for the stand-in. See `setMaterial`. */
  private emissiveMap: GpuSurfaceTexture | null = null;
  /**
   * The flat group for a material, keyed on **all four** of its maps.
   *
   * **It used to be keyed on the albedo alone, and that is why it was emptied so often.** Every
   * group it holds carries the normal, ORM and emissive views that were current when it was built,
   * so a cache keyed on one of the four could only stay correct by being thrown away whenever any
   * of the other three moved. `setMaterial` did that once per changed map, then missed the cache it
   * had just cleared, so a material differing from the one before it in a single map cost up to
   * four `createBindGroup` calls and destroyed every entry a later material would have hit.
   *
   * A consumer measured what that cost over the materials its cars merge to: 476 groups a pass for
   * seven models with 247 distinct signatures between them, drawn a second time for the water's
   * mirror, so about 950 a frame that should have been nought after the first. It scaled with
   * distinct models rather than with cars, because identical cars share a batch, which is why it
   * read from the outside as the frame rate falling off when a second kind of car appeared.
   *
   * **Nested rather than one map under a composite key**, because a key built per lookup is an
   * allocation on a path that runs per material change, and the number of material changes in a
   * frame is exactly the number this is trying to stop being expensive. Four `Map.get` calls
   * allocate nothing. What a miss costs is up to three empty `Map`s, which is bounded by the
   * distinct signatures a scene has and is zero once it has been seen.
   *
   * The four texture invalidations that remain are in `rebuildFlatBindGroup`, and they are the
   * ones that move something *every* group holds: the shadow cubemaps, the probe fence, the cookie
   * atlas and the IES rows. None of those is a frame path.
   */
  private readonly flatBindGroups = new Map<
    GpuSurfaceTexture | null,
    Map<
      GpuSurfaceTexture | null,
      Map<GpuSurfaceTexture | null, Map<GpuSurfaceTexture | null, GPUBindGroup>>
    >
  >();
  /** The group holding the one-pixel stand-in, for every draw with no texture set. */
  private blankAlbedoBindGroup: GPUBindGroup;
  /** Repeats across the mesh's own UV range. Per draw, because `uUvScale` is a vertex uniform. */
  private readonly uvScale = new Float32Array([1, 1]);

  createSurfaceTexture(
    source: TexImageSource,
    options: SurfaceTextureOptions = {},
  ): GpuSurfaceTexture {
    return new GpuSurfaceTexture(this.surface.device, this.pipelines, source, options);
  }

  /**
   * GPU textures an `updateSurfaceTexture` replaced, destroyed when the next frame begins.
   *
   * Not at once, because a draw recorded earlier in the frame the update landed in may still read
   * one, and a destroyed texture in a submit loses the whole command buffer. Every encoder a frame
   * opens is submitted by the time the next one begins.
   */
  private readonly retiredTextures: GPUTexture[] = [];

  updateSurfaceTexture(texture: GpuSurfaceTexture, source: TexImageSource): void {
    if (this.surface.lost) return;
    const replaced = texture.update(source);
    if (replaced === null) return;
    /* A new size is a new view, so every group holding the old one is dropped — see below. */
    this.retiredTextures.push(replaced);
    this.forgetBindingsOf(texture);
  }

  disposeSurfaceTexture(texture: GpuSurfaceTexture): void {
    if (this.surface.lost) return;
    if (this.albedo === texture) {
      this.albedo = null;
      this.bindGroup = this.blankAlbedoBindGroup;
    }
    /*
     * **Every flat group is rebuilt, not only the ones this texture is the albedo of.**
     *
     * The albedo's comment above says why it matters — a group "hands a destroyed texture to the
     * next draw that asks" — and the cache acted on the albedo alone. But `flatBindGroups` is
     * keyed on all four maps now, and a group is reachable only by the exact combination it was
     * built for — so there is no key to delete a disposed texture under that would find every group
     * holding a view of it, and `blankAlbedoBindGroup` holds views too. Clearing the lot is the
     * answer that does not have to be reasoned about.
     *
     * Reported as `Destroyed texture [Texture "surface.texture"] used in a submit` on loading a
     * second model, which is the first moment a consumer disposes one set of maps while another
     * set is bound.
     *
     * Rebuilding unconditionally rather than tracking which groups reference what: this runs when
     * a model is unloaded, not per draw, and a cache that has to be reasoned about to be correct
     * is the thing that was wrong here.
     */
    if (this.normalMap === texture) this.normalMap = null;
    if (this.ormMap === texture) this.ormMap = null;
    if (this.emissiveMap === texture) this.emissiveMap = null;
    this.forgetBindingsOf(texture);
    texture.dispose();
  }

  /**
   * Drop every bind group that may hold `texture`'s view, and rebuild the ones bound now.
   *
   * For a texture going away and for one whose view has been replaced, which are the same problem:
   * a group holding the old view hands a destroyed texture to the next draw that asks.
   */
  private forgetBindingsOf(texture: GpuSurfaceTexture): void {
    /* Same reasoning, for whichever SDF labels were bound against this atlas. */
    this.sdfTextBindGroups.delete(texture);
    this.flatBindGroups.clear();
    /*
     * The blank one is built with the albedo held aside, because `buildFlatBindGroup` reads
     * `this.albedo` for that slot — leaving it in place would put a real colour map into the
     * group whose whole job is not to have one.
     */
    const held = this.albedo;
    this.albedo = null;
    this.blankAlbedoBindGroup = this.buildFlatBindGroup();
    this.albedo = held;
    this.bindGroup = this.flatGroupForMaps(held, this.normalMap, this.ormMap, this.emissiveMap);
  }

  /**
   * Choose the surface texture the following `drawMesh` calls sample, or null for none.
   *
   * State rather than an argument to `drawMesh`, for the two reasons `renderer.ts` gives: a
   * texture belongs to a material and a material covers many draws, and `drawMesh` already
   * carries a model, a layer and a tint. `bindMeshPass` resets this to none, so a pass cannot
   * inherit a material from the one before it.
   */
  /**
   * Choose the joint palette the following `drawMesh` calls skin by, or null for none.
   *
   * The twin of the WebGL2 method, answering the same way — a value-typed member of the shared
   * surface must be answered by every backend, and answered honestly, per the 2026-08-13 rule.
   */
  setSkinPalette(palette: Float32Array | null): void {
    if (this.surface.lost) return;
    if (palette === null) {
      this.skinPaletteSlot = -1;
      return;
    }
    /* Its own slot, because a palette uploaded over another one reaches both draws rather than
       one. See `SkinPaletteRing`; a full ring declines the draw instead of mixing two rigs. */
    this.skinPaletteSlot = this.skinPalettes.take(this.surface.device, palette) ?? -1;
  }

  /**
   * Choose the morph weights the following `drawMesh` calls deform by, or null for none.
   *
   * The twin of the WebGL2 method: the weights are per draw and the deltas are per mesh, so two
   * characters sharing one head mesh wear different expressions without a second copy of it.
   */
  setMorphWeights(weights: Float32Array | null): void {
    if (this.surface.lost) return;
    this.morphWeights = weights;
  }

  setMaterial(material: SurfaceMaterial<GpuSurfaceTexture> | null): void {
    if (this.surface.lost) return;
    const albedo = material?.albedo ?? null;
    this.uvScale[0] = material?.uScale ?? 1;
    this.uvScale[1] = material?.vScale ?? 1;
    const normal = (material?.normal ?? null) as GpuSurfaceTexture | null;
    const orm = (material?.orm ?? null) as GpuSurfaceTexture | null;
    const emissiveMap = (material?.emissive ?? null) as GpuSurfaceTexture | null;
    this.material((f, i) => {
      i[this.materialField('uAlbedoEnabled')] = albedo === null ? 0 : 1;
      f[this.materialField('uAlbedoCutout')] = material?.cutout ?? 0;
      /* 0 is no map, and gates the whole block in the shader. See `uNormalStrength`. */
      f[this.materialField('uNormalStrength')] =
        normal === null ? 0 : (material?.normalStrength ?? 1);
      i[this.materialField('uOrmEnabled')] = orm === null ? 0 : 1;
      /*
       * Component-aligned with the map — r occlusion, g roughness, b metallic — so this order is
       * the channel order rather than the field order of `SurfaceMaterial`. Written component by
       * component because `materialField` returns a float index and this is the only vec3 the
       * material block carries.
       */
      const scale = this.materialField('uOrmScale');
      f[scale] = material?.occlusionStrength ?? 1;
      f[scale + 1] = material?.roughnessScale ?? 1;
      f[scale + 2] = material?.metallicScale ?? 1;
      i[this.materialField('uEmissiveMapEnabled')] = emissiveMap === null ? 0 : 1;
      /*
       * One rather than zero on every component, because this multiplies rather than adds: an
       * unwritten float is zero, and zero here would switch off every glow the mesh's own vertex
       * data asked for. The block's base copy writes the same three ones for the same reason.
       */
      const emissive = this.materialField('uEmissiveScale');
      const asked = material?.emissiveScale ?? null;
      f[emissive] = asked?.[0] ?? 1;
      f[emissive + 1] = asked?.[1] ?? 1;
      f[emissive + 2] = asked?.[2] ?? 1;
    });
    /*
     * **One lookup for the whole material, and nothing thrown away.**
     *
     * Each of these three used to assign its field and call `rebuildFlatBindGroup`, which empties
     * the cache — so a material carrying a different normal map from the one before it cleared
     * every entry, and the albedo lookup that followed then missed the cache it had just emptied
     * and built a fourth group. The cache is keyed on all four now, so a combination it has seen
     * costs nothing and a combination it has not costs exactly one.
     */
    if (
      this.albedo === albedo &&
      this.normalMap === normal &&
      this.ormMap === orm &&
      this.emissiveMap === emissiveMap
    ) {
      return;
    }
    this.albedo = albedo;
    this.normalMap = normal;
    this.ormMap = orm;
    this.emissiveMap = emissiveMap;
    this.bindGroup = this.flatGroupForMaps(albedo, normal, orm, emissiveMap);
  }

  /**
   * @deprecated Use `setMaterial`. See `renderer.ts` for why this stays: 56 call sites across four
   * repositories, three of which deploy on push, so removing it is a major version rather than a
   * side effect. Both renderers implement the same public surface, and a divergence here is a
   * consumer that works on one backend and not the other.
   */
  setSurfaceTexture(texture: GpuSurfaceTexture | null, uScale = 1, vScale = 1, cutout = 0): void {
    this.setMaterial(texture === null ? null : { albedo: texture, uScale, vScale, cutout });
  }

  /**
   * The group for this exact set of four maps, built on the first ask and kept.
   *
   * **All four null is the stand-in's group**, which stays a field of its own rather than an entry
   * here: it is what a pass starts from and what `disposeSurfaceTexture` and the ring rebuild have
   * to refresh directly, and giving it two homes would be two things to keep in step.
   *
   * `buildFlatBindGroup` reads the live material fields, so every caller assigns all four before
   * asking. Passing them in as well is deliberate: it is what makes the key and the group agree by
   * construction rather than by the caller having remembered.
   */
  private flatGroupForMaps(
    albedo: GpuSurfaceTexture | null,
    normal: GpuSurfaceTexture | null,
    orm: GpuSurfaceTexture | null,
    emissive: GpuSurfaceTexture | null,
  ): GPUBindGroup {
    if (albedo === null && normal === null && orm === null && emissive === null) {
      return this.blankAlbedoBindGroup;
    }
    let byNormal = this.flatBindGroups.get(albedo);
    if (byNormal === undefined) {
      byNormal = new Map();
      this.flatBindGroups.set(albedo, byNormal);
    }
    let byOrm = byNormal.get(normal);
    if (byOrm === undefined) {
      byOrm = new Map();
      byNormal.set(normal, byOrm);
    }
    let byEmissive = byOrm.get(orm);
    if (byEmissive === undefined) {
      byEmissive = new Map();
      byOrm.set(orm, byEmissive);
    }
    const existing = byEmissive.get(emissive);
    if (existing !== undefined) return existing;
    const built = this.buildFlatBindGroup();
    this.bindGroupBudget.ask();
    byEmissive.set(emissive, built);
    return built;
  }

  /* -- Material state ------------------------------------------------------------------ */

  /**
   * Patch one field of the open material and make the next draw take a new slot.
   *
   * The block is the CPU's until a draw copies it, so a setter is free to be called between
   * draws, several times, or never — which is what "pass state" means on the other backend too.
   */
  private material(write: (f: Float32Array, i: Int32Array) => void): void {
    if (this.surface.lost) return;
    write(this.perFrameFloats, this.perFrameInts);
    this.materials.dirty();
  }

  private materialField(name: string): number {
    return (this.fragment.fields[name]?.offset ?? 0) / 4;
  }

  /**
   * Kept as a no-op that says so once. See `renderer.ts` for the whole argument; in one line, it
   * was the stand-in for a term that now exists, and it is deprecated rather than removed because
   * it is on the public surface and removing it would break four repositories to save a method.
   */
  setEnvironmentAmbient(_amount: number): void {
    if (this.warnedEnvironmentAmbient) return;
    this.warnedEnvironmentAmbient = true;
    console.warn(
      'WebGPU: setEnvironmentAmbient no longer does anything. A baked probe now lights a ' +
        'surface through projected irradiance, and there is nothing left to tune.',
    );
  }

  /** How reflective the surfaces drawn next are. Clamped, as `renderer.ts` clamps it. */
  setSurfaceReflectivity(amount: number): void {
    this.material((f) => {
      f[this.materialField('uReflectivity')] = Math.min(1, Math.max(0, amount));
    });
  }

  /** How bright the environment the surfaces drawn next reflect is. See `renderer.ts`. */
  setEnvironmentGain(gain: number): void {
    this.material((f) => {
      f[this.materialField('uEnvironmentGain')] = Math.max(0, gain);
    });
  }

  setSurfaceGrain(amount: number): void {
    this.material((f) => {
      f[this.materialField('uGrain')] = Math.min(1, Math.max(0, amount));
    });
  }

  /**
   * How strong the microscopic relief on the surfaces drawn next is, and how coarse.
   *
   * The 60 that `renderer.ts` defaults to is repeated there and here; the two must move
   * together, and that file says why the number is what it is.
   */
  setSurfaceRelief(amount: number, cyclesPerMetre = 60): void {
    this.material((f) => {
      f[this.materialField('uRelief')] = Math.min(1, Math.max(0, amount));
      f[this.materialField('uReliefCycles')] = Math.max(0.01, cyclesPerMetre);
    });
  }

  /**
   * How hard the bound surface texture's own luminance turns the shading normal.
   *
   * See `Renderer.setSurfaceTextureRelief` for what this is for, why the colour image serves as
   * the height field rather than a second sampler being added, and why this one is not clamped
   * to 0..1 the way its neighbours are.
   */
  setSurfaceTextureRelief(scale: number): void {
    this.material((f) => {
      f[this.materialField('uTextureRelief')] = Number.isFinite(scale) ? scale : 0;
    });
  }

  /** Scale the emissive of the following draws. See `Renderer.setEmissiveGain` for why. */
  setEmissiveGain(gain: number): void {
    this.material((f) => {
      f[this.materialField('uEmissiveGain')] = gain;
    });
  }

  /* -- Overlays ------------------------------------------------------------------------ */

  /**
   * The plain surface an overlay is read against. See `Renderer.fillPanel` for the argument
   * about why neither an inset nor a plate of glyph cubes can stand in for it.
   *
   * **Reopens the pass, like the rest of this section.** A panel is the backdrop a caption or a
   * plate is read against, so it is drawn wherever they are — and they are drawn after `endFrame`
   * by the consumer that has one, to keep the interface out of the screen-space chain. Held to
   * `this.pass`, it was the only member of `-- Overlays --` that still went silently nowhere in
   * that order, which is the shape of failure the 2026-08-13 rule is about.
   */
  fillPanel(rect: InsetRect, color: Vec3, alpha: number): void {
    if (!this.canDraw()) return;
    if (alpha <= 0 || rect.width <= 0 || rect.height <= 0) return;
    const vertexSlot = this.panelVerts.allocate();
    const fragmentSlot = this.panelFrags.allocate();
    if (vertexSlot === null || fragmentSlot === null) {
      /*
       * Said, as its text and line siblings say it: this returned without a word until 2026-09-19,
       * so an interface of panels lost everything past its sixty-fourth here and nothing on WebGL2.
       */
      if (!this.warnedPanelsFull) {
        this.warnedPanelsFull = true;
        console.warn(
          `WebGPU: more than ${MAX_OVERLAYS} panels in a frame; the rest are skipped. renderer.frameBudget names the line and the count.`,
        );
      }
      return;
    }

    const at = (name: string): number => PANEL_VERT_FIELDS[name]?.offset ?? 0;
    this.panelVerts.writeFloats(vertexSlot, at('uRect'), [
      rect.left,
      rect.top,
      rect.width,
      rect.height,
    ]);
    this.panelVerts.writeFloats(vertexSlot, at('uViewport'), [this.cssWidth, this.cssHeight]);
    /* The correction this draw would otherwise never meet — see the shader's own comment. */
    this.panelVerts.writeFloats(vertexSlot, at('uClipCorrection'), CLIP_CORRECTION);

    const fragAt = (name: string): number => PANEL_FRAG_FIELDS[name]?.offset ?? 0;
    this.panelFrags.writeFloats(fragmentSlot, fragAt('uColor'), color);
    this.panelFrags.writeFloat(fragmentSlot, fragAt('uAlpha'), alpha);

    const panelPipe = panelPipeline(this.targetPipelines(), this.surface.device, this.panelLayout);
    /* `allocate` already returns a byte offset, not an index. Multiplying by the stride
        again put the second panel 64 KB into a 16 KB ring — the device said so, in as many
        words, the first time a frame ran. */
    const panelCommand = this.recordDraw(0, this.currentTarget());
    if (panelCommand !== null) {
      panelCommand.pipeline = panelPipe;
      panelCommand.bindGroup = this.panelBindGroup;
      panelCommand.offsetA = vertexSlot;
      panelCommand.offsetB = fragmentSlot;
      panelCommand.offsetCount = 2;
      panelCommand.vertexBuffers[0] = this.panelCorners;
      panelCommand.vertexCount = 1;
      panelCommand.count = PANEL_VERTEX_COUNT;
    } else {
      const pass = this.openPass();
      if (pass === null) return;
      pass.setPipeline(panelPipe);
      pass.setBindGroup(0, this.panelBindGroup, [vertexSlot, fragmentSlot]);
      pass.setVertexBuffer(0, this.panelCorners);
      pass.draw(PANEL_VERTEX_COUNT);
    }
  }

  /** Said once rather than every frame, for the reason `warnedFull` gives. */
  private warnedPanelsFull = false;

  /** A 3D text object. See `textPass.ts`; the layout it holds is shared with WebGL2. */
  createText(): GpuText {
    return new GpuText(this.surface.device);
  }

  setText(text: GpuText, content: string): void {
    text.setText(content);
  }

  setPlate(text: GpuText, widthCells: number, heightCells: number, bottomCell: number): void {
    text.setPlate(widthCells, heightCells, bottomCell);
  }

  textWidth(text: GpuText, cellSize: number): number {
    return text.layout.widthPx(cellSize);
  }

  disposeText(text: GpuText): void {
    text.dispose();
  }

  /** A text label from an SDF font. See `sdfTextPass.ts`; the layout it holds is shared with WebGL2. */
  createSdfText(): GpuSdfText {
    return new GpuSdfText(this.surface.device);
  }

  setSdfText(
    text: GpuSdfText,
    font: SdfFont,
    atlas: GpuSurfaceTexture,
    content: string,
    style: SdfTextStyle,
  ): void {
    text.setText(font, atlas, content, style);
  }

  disposeSdfText(text: GpuSdfText): void {
    text.dispose();
  }

  /** The bind group for this atlas, built on the first ask and kept. See `sdfTextBindGroups`. */
  private sdfTextBindGroupFor(atlas: GpuSurfaceTexture): GPUBindGroup {
    const existing = this.sdfTextBindGroups.get(atlas);
    if (existing !== undefined) return existing;
    const built = createSdfTextBindGroup(
      this.surface.device,
      this.sdfTextLayout,
      this.sdfTextVerts.buffer,
      this.sdfTextFrags.buffer,
      atlas.view,
      atlas.sampler,
    );
    this.sdfTextBindGroups.set(atlas, built);
    return built;
  }

  /**
   * Draw a laid-out SDF string into the scene, at `model`.
   *
   * **Inside whatever pass is already open, against `this.viewProj` — not a pass of its own.**
   * `drawText` calls `openTextPass` because the pixel font's cubes need their own cleared depth
   * buffer to sort against themselves; SDF text is a flat, blended quad with depth *testing*
   * left at the pass's own ambient state, the same assumption `drawTranslucentMesh` makes, so
   * reopening the pass here would do nothing but discard whatever the frame had drawn before
   * it — see `openTextPass`'s own comment for the failure that shape caused once already.
   * `this.viewProj` is `bindMeshPass`'s corrected matrix, the same one `submitMesh` reads; a
   * no-op before the first `bindMeshPass` of a session, same as every other pass that reads it.
   */
  drawSdfText(text: GpuSdfText, model: Float32Array, color: Vec3, opacity: number): void {
    const viewProj = this.viewProj;
    if (!this.canDraw() || viewProj === null) return;
    const font = text.font;
    const atlas = text.atlas;
    if (text.layout.quadCount === 0 || opacity <= 0 || font === null || atlas === null) return;

    const vertexSlot = this.sdfTextVerts.allocate();
    const fragmentSlot = this.sdfTextFrags.allocate();
    if (vertexSlot === null || fragmentSlot === null) {
      if (!this.warnedSdfTextFull) {
        this.warnedSdfTextFull = true;
        console.warn(
          `WebGPU: more than ${MAX_OVERLAYS} SDF text draws in a frame; the rest are skipped`,
        );
      }
      return;
    }

    const vertAt = (name: string): number => SDF_TEXT_VERT_FIELDS[name]?.offset ?? 0;
    this.sdfTextVerts.writeFloats(vertexSlot, vertAt('uViewProj'), viewProj);
    this.sdfTextVerts.writeFloats(vertexSlot, vertAt('uModel'), model);

    const fragAt = (name: string): number => SDF_TEXT_FRAG_FIELDS[name]?.offset ?? 0;
    this.sdfTextFrags.writeFloats(fragmentSlot, fragAt('uColor'), color);
    this.sdfTextFrags.writeFloat(fragmentSlot, fragAt('uOpacity'), opacity);
    this.sdfTextFrags.writeFloat(fragmentSlot, fragAt('uDistanceRange'), font.distanceRange);
    this.sdfTextFrags.writeFloats(fragmentSlot, fragAt('uAtlasSize'), [
      font.atlasWidth,
      font.atlasHeight,
    ]);
    this.sdfTextFrags.writeInt(fragmentSlot, fragAt('uOutputTransform'), this.gradeCode());
    this.sdfTextFrags.writeFloat(fragmentSlot, fragAt('uOutputExposure'), this.gradeExposure());

    const sdfPipe = sdfTextPipeline(
      this.targetPipelines(),
      this.surface.device,
      this.sdfTextLayout,
    );
    const sdfGroup = this.sdfTextBindGroupFor(atlas);
    const sdfCommand = this.recordDraw(0, this.currentTarget());
    if (sdfCommand !== null) {
      sdfCommand.pipeline = sdfPipe;
      sdfCommand.bindGroup = sdfGroup;
      sdfCommand.offsetA = vertexSlot;
      sdfCommand.offsetB = fragmentSlot;
      sdfCommand.offsetCount = 2;
      sdfCommand.vertexBuffers[0] = text.positions;
      sdfCommand.vertexBuffers[1] = text.uvs;
      sdfCommand.vertexCount = 2;
      sdfCommand.indexBuffer = text.indices;
      sdfCommand.indexed = true;
      sdfCommand.count = text.layout.quadCount * 6;
    } else {
      const pass = this.openPass();
      if (pass === null) return;
      pass.setPipeline(sdfPipe);
      pass.setBindGroup(0, sdfGroup, [vertexSlot, fragmentSlot]);
      pass.setVertexBuffer(0, text.positions);
      pass.setVertexBuffer(1, text.uvs);
      pass.setIndexBuffer(text.indices, 'uint32');
      pass.drawIndexed(text.layout.quadCount * 6);
    }
  }

  /** Said once rather than every frame, for the reason `warnedFull` gives. */
  private warnedSdfTextFull = false;
  private warnedTextFull = false;

  /**
   * Draw a laid-out string over the scene.
   *
   * **A pass of its own, because the depth buffer has to be cleared and WebGPU cannot clear one
   * in the middle of a pass.** `TextRenderer` calls `gl.clear(DEPTH_BUFFER_BIT)` here and the
   * reason is in its comment: the cubes are solid, so text drawn with no depth test renders as
   * one flat facet, and text drawn against the scene's depth disappears into it. Reopening with
   * `depthLoadOp: 'clear'` and `loadOp: 'load'` on colour is the same statement in this API.
   *
   * One pass per string rather than one per frame, which is what WebGL2 does by clearing on
   * every `draw` — two strings do not sort against each other on either backend.
   */
  drawText(
    text: GpuText,
    viewportWidth: number,
    viewportHeight: number,
    originX: number,
    originY: number,
    style: TextStyle,
    timeSec: number,
  ): void {
    /* Only to prove there is somewhere to draw; `openTextPass` below picks the real one, and
       flushes at its own boundary. Asked rather than opened, because text records. */
    if (!this.canDraw()) return;
    if (text.layout.instanceCount === 0 || style.alpha <= 0) return;
    const vertexSlot = this.textVerts.allocate();
    const fragmentSlot = this.textFrags.allocate();
    if (vertexSlot === null || fragmentSlot === null) {
      /*
       * **A silent cap, on one backend, where both of this call's siblings say so.**
       *
       * `drawSdfText` and `drawLine` warn when they run out of ring; this returned without a
       * word, and `renderer.ts`'s `drawText` has no ceiling at all — it just draws. So a
       * consumer past sixty-four text draws in a frame got every one of them on WebGL2 and the
       * first sixty-four on WebGPU, with nothing anywhere to say which. That is not a rendering
       * difference anybody can debug from the picture: the text is simply not there, on one
       * backend, and the console is clean.
       *
       * Once per session, like its siblings, because a caller over the ceiling is over it every
       * frame and a per-frame warning is a console nobody can read.
       */
      if (!this.warnedTextFull) {
        this.warnedTextFull = true;
        console.warn(
          `WebGPU: more than ${MAX_OVERLAYS} text draws in a frame; the rest are skipped. ` +
            `WebGL2 has no such ceiling, so this is a difference between the backends rather ` +
            `than a limit of the engine.`,
        );
      }
      return;
    }

    const at = (name: string): number => TEXT_VERT_FIELDS[name]?.offset ?? 0;
    const v = this.textVerts;
    v.writeFloats(vertexSlot, at('uViewport'), [viewportWidth, viewportHeight]);
    /* Snapped with the cell below: a whole pitch on a fractional origin still splits a stroke.
       See `deviceSnappedOrigin`. */
    v.writeFloats(vertexSlot, at('uOrigin'), [
      deviceSnappedOrigin(originX, viewportWidth, this.surface.canvas.width),
      deviceSnappedOrigin(originY, viewportHeight, this.surface.canvas.height),
    ]);
    /* Whole device pixels per cell, or a 5x7 face draws strokes of two different widths. The
       decision is shared with WebGL2; only this binding is per-backend. See `textLayout.ts`. */
    v.writeFloat(
      vertexSlot,
      at('uCellSize'),
      deviceSnappedCellSize(style.cellSize, viewportWidth, this.surface.canvas.width),
    );
    /* Far enough that a whole line barely converges, near enough that a turn reads as a turn. */
    v.writeFloat(vertexSlot, at('uDepth'), Math.max(viewportWidth, 600) * 1.4);
    v.writeFloat(vertexSlot, at('uReveal'), style.reveal);
    v.writeFloat(
      vertexSlot,
      at('uCharCount'),
      Math.max(1, style.charSpan ?? text.layout.charCount),
    );
    v.writeFloat(vertexSlot, at('uCharOffset'), style.charOffset ?? 0);
    v.writeFloat(vertexSlot, at('uSpin'), style.spin);
    v.writeFloat(vertexSlot, at('uPunch'), style.punch);
    v.writeFloat(vertexSlot, at('uBob'), style.bob);
    v.writeFloat(vertexSlot, at('uTime'), timeSec);
    /* Without this the message is upside down and half of every glyph is clipped away. */
    v.writeFloats(vertexSlot, at('uClipCorrection'), CLIP_CORRECTION);

    const fragAt = (name: string): number => TEXT_FRAG_FIELDS[name]?.offset ?? 0;
    this.textFrags.writeFloats(fragmentSlot, fragAt('uColor'), style.color);
    this.textFrags.writeFloat(fragmentSlot, fragAt('uGlow'), style.glow);
    this.textFrags.writeFloat(fragmentSlot, fragAt('uAlpha'), style.alpha);

    const pass = this.openTextPass();
    if (pass === null) return;
    const textPipe = textPipeline(this.targetPipelines(), this.surface.device, this.textLayout);
    const textCommand = this.recordDraw(0, this.currentTarget());
    if (textCommand !== null) {
      textCommand.pipeline = textPipe;
      textCommand.bindGroup = this.textBindGroup;
      textCommand.offsetA = vertexSlot;
      textCommand.offsetB = fragmentSlot;
      textCommand.offsetCount = 2;
      textCommand.vertexBuffers[0] = this.textCube.positions;
      textCommand.vertexBuffers[1] = this.textCube.normals;
      textCommand.vertexBuffers[2] = text.cells;
      textCommand.vertexBuffers[3] = text.chars;
      textCommand.vertexCount = 4;
      textCommand.count = this.textCube.vertexCount;
      textCommand.instances = text.layout.instanceCount;
    } else {
      pass.setPipeline(textPipe);
      pass.setBindGroup(0, this.textBindGroup, [vertexSlot, fragmentSlot]);
      pass.setVertexBuffer(0, this.textCube.positions);
      pass.setVertexBuffer(1, this.textCube.normals);
      pass.setVertexBuffer(2, text.cells);
      pass.setVertexBuffer(3, text.chars);
      pass.draw(this.textCube.vertexCount, text.layout.instanceCount);
    }
  }

  /**
   * End the frame's pass and reopen it with the depth buffer cleared.
   *
   * The colour attachment loads, so everything drawn so far survives; only depth is thrown
   * away. `this.pass` is replaced, so whatever a scene draws after its text carries on into
   * the reopened pass and against the cleared depth — which is exactly what happens on WebGL2
   * after its `gl.clear`.
   */
  private openTextPass(): GPURenderPassEncoder | null {
    /* Already on the canvas, over a composite that has run: this is where text belongs. */
    if (this.overlayActive) return this.pass;
    /*
     * Inside the mirror, draw into the mirror rather than reopening on the frame.
     *
     * The reopen below targets the composite, so performing it during a reflection would end the
     * mirror's pass — discarding what it held on a tile-based GPU — and send the text, and
     * everything drawn after it, into the frame instead. See `takeVolumeDepth` for the same
     * boundary and the same reason. The cost is that text in a mirror does not get its own
     * cleared depth, which is a strange thing to want and a far smaller loss than the mirror.
     */
    /* Opened rather than assumed: the mirror's pass is lazy now, like the frame's. */
    if (this.reflectionPassActive) return this.openPass();
    /*
     * **After `endFrame` there is no encoder, and `openPass` is the one that makes one.**
     *
     * `canDraw` says in as many words that "after `endFrame` an overlay pass can still be
     * opened", and `openPass` implements exactly that: past `framePresented` it builds an
     * overlay depth, creates a fresh encoder and opens the overlay on the swap view. This
     * function never reached it. It read `this.encoder` two lines down, found the null that
     * `endFrame` leaves behind, and returned — so **text drawn after the frame was a silent
     * no-op on WebGPU and drew normally on WebGL2**, which has no encoder to miss.
     *
     * It survived because it is invisible whenever anything *else* has already opened the
     * overlay: `demo/dev/overlay.ts` draws an inset beside its label and so always had one,
     * which is why the engine's own after-`endFrame` test passed throughout. A consumer whose
     * overlay is text and nothing else got no text at all, and no warning either.
     *
     * Found by forcing a persistent message in a consumer and capturing both backends —
     * 456 `drawText` calls in a frame, every one of them past every guard, and 456 nulls here.
     */
    if (this.framePresented) return this.openPass();
    const encoder = this.encoder;
    const swap = this.compositeTarget();
    if (encoder === null || swap === null) return null;
    /*
     * Flush before the boundary, because these three do not go through `ensurePass`.
     *
     * Anything recorded and not yet replayed belongs to the pass that is about to end. Leaving
     * it would replay it into whichever pass opened next — the mirror's — which is a draw in
     * the wrong target rather than a missing one.
     */
    if (this.quality.frameGraph) this.flushGraph();
    /* Text lands on the canvas after the frame resolved, loading what is already there. */
    if (this.quality.frameGraph) {
      recordNode(this.arena, VERB_SCOPE, CANVAS_TARGET, CANVAS_TARGET, 0, 0);
    }
    this.pass?.end();
    const multisampled = this.compositeMsaa() !== null;
    this.pass = encoder.beginRenderPass({
      label: 'text',
      timestampWrites: this.gpuTimer.writesFor(),
      colorAttachments: [
        {
          view: this.compositeMsaa() ?? swap,
          resolveTarget: multisampled ? swap : undefined,
          loadOp: 'load',
          storeOp: resolvedStoreOp(multisampled, false, this.quality.discardResolvedAttachments),
        },
      ],
      depthStencilAttachment:
        this.depthView === null
          ? undefined
          : {
              view: this.depthView,
              depthClearValue: DEPTH_CLEAR,
              depthLoadOp: 'clear',
              depthStoreOp: 'store',
            },
    });
    return this.pass;
  }

  /**
   * The mirror to sample for water resting at `planeY`, or null.
   *
   * **Three conditions, not one.** There has to be a target; this frame has to have drawn into
   * it, or the pool shows the frame before; and it has to have been drawn for *this* plane, or
   * a scene with two bodies of water at different heights reflects one into the other.
   * `PlanarReflection.isReadyFor` is the same test on the other backend.
   */
  private reflectionFor(planeY: number): GpuReflection | null {
    if (!this.reflectionReady) return null;
    if (Math.abs(this.reflectionPlaneY - planeY) >= 1e-4) return null;
    return this.reflection;
  }

  /** Close the mirror and put the frame's own pass back, keeping what it already held. */
  endPlanarReflection(): void {
    if (this.surface.lost || !this.reflectionPassActive || this.encoder === null) return;
    /*
     * Flush before the boundary, because these three do not go through `ensurePass`.
     *
     * Anything recorded and not yet replayed belongs to the pass that is about to end. Leaving
     * it would replay it into whichever pass opened next — the mirror's — which is a draw in
     * the wrong target rather than a missing one.
     */
    if (this.quality.frameGraph) this.flushGraph();
    /*
     * A reflection nobody drew into still has to be cleared. `reflectionReady` is set below
     * either way, so water samples this target regardless, and an unopened lazy pass would hand
     * it whatever the mirror held last frame. Opening it performs the clear still owed.
     */
    this.openPass();
    /*
     * Back to the frame, and it loads **both** colour and depth — `openFramePass` resumes with
     * `loadOp: 'load'` and `depthLoadOp: 'load'`, because geometry drawn after the mirror has
     * to depth-test against geometry drawn before it. So depth is not discardable at this
     * boundary, whatever would be convenient. It is discardable at the frame's last pass,
     * where nothing loads it again, and recording the truth here is what lets the scheduler
     * find that rather than be told it.
     */
    if (this.quality.frameGraph) {
      recordNode(this.arena, VERB_SCOPE, SCENE_TARGET, SCENE_TARGET, 0, 0);
    }
    this.pass?.end();
    this.flushRings();
    this.surface.device.queue.submit([this.encoder.finish()]);
    this.encoder = this.surface.device.createCommandEncoder({ label: 'frame.resumed' });
    this.reflectionPassActive = false;
    this.reflectionReady = true;
    this.gpuTimer.end();
    /*
     * **Nothing is reopened here.** This used to call `openFramePass(null)` — the frame's
     * attachment, read back in full — so a scene with two bodies of water paid two loads and
     * two extra stores of a 23 MB target. `ensurePass` opens it on the next draw instead, and
     * `pendingClearMask` keeps the distinction that matters: a scene that had already drawn gets
     * its `load` exactly as before, one that opened the mirror first gets its single `clear`
     * late.
     */
    /* A resumed frame pass loads by definition, and no schedule describes what goes into it. */
    this.pass = this.quality.deferFramePass ? null : this.openFramePass(0, 0);
  }

  /**
   * The frame's own render pass, opened to clear or to resume.
   *
   * One place, because `beginFrame` and `endPlanarReflection` have to agree about which view is
   * the attachment and which is the resolve target — and at four samples those are two
   * different textures, so a second copy of the rule is a mirror pass that quietly redirects
   * the rest of the frame to the wrong one.
   */
  /**
   * The mirror's pass: the world about to be drawn from behind the water.
   *
   * `beginPlanarReflection`'s descriptor, moved here so the mirror is opened through the same
   * door as everything else and takes its load and store from the same two masks.
   */
  private openMirrorPass(clear: number, discard: number): GPURenderPassEncoder | null {
    const encoder = this.encoder;
    const reflection = this.reflection;
    if (encoder === null || reflection === null) return null;
    return encoder.beginRenderPass({
      label: 'reflection',
      timestampWrites: this.gpuTimer.writesFor(),
      colorAttachments: [
        {
          view: reflection.attachmentView,
          resolveTarget: reflection.resolveView ?? undefined,
          clearValue: {
            r: this.mirrorClearColor[0],
            g: this.mirrorClearColor[1],
            b: this.mirrorClearColor[2],
            a: 1,
          },
          ...((clear & maskOf('mirrorColor')) === 0
            ? { loadOp: 'load' as const }
            : { loadOp: 'clear' as const }),
          /*
           * **Not the graph's question.** `resolvedStoreOp` decides whether a *multisampled
           * attachment* is worth keeping once it has been resolved, which is a fact about MSAA
           * rather than about what the frame reads: the table's `mirrorColor` bit names the
           * sampled texture, and the multisampled twin beside it is sampled by nothing ever.
           */
          storeOp: resolvedStoreOp(
            reflection.resolveView !== null,
            true,
            this.quality.discardResolvedAttachments,
          ),
        },
      ],
      depthStencilAttachment: {
        view: reflection.depthView,
        depthClearValue: DEPTH_CLEAR,
        ...((clear & maskOf('mirrorDepth')) === 0
          ? { depthLoadOp: 'load' as const }
          : { depthLoadOp: 'clear' as const }),
        /*
         * Derived, and with the judgement it replaced still standing behind it.
         *
         * This was `discardResolvedAttachments ? 'discard' : 'store'` with a comment saying
         * `reflection.depth` is `RENDER_ATTACHMENT` and nothing else, so no shader can sample
         * it — true, and true *because no verb declares a read of it*, which is a thing the
         * scheduler checks and a comment cannot. Worth 23 MB a mirror at a phone-sized frame
         * with four samples, and the consumer draws two of them.
         *
         * **With `?graph=0` there is no derivation, and the saving is far too large to drop on
         * the default path while waiting for one.** So the flag chooses which of the two
         * answers applies, rather than the graph's absence quietly meaning `store`.
         */
        depthStoreOp:
          (this.quality.frameGraph ? (discard & maskOf('mirrorDepth')) !== 0 : true) &&
          this.quality.discardResolvedAttachments
            ? 'discard'
            : 'store',
      },
    });
  }

  private openFramePass(clear: number, discard: number): GPURenderPassEncoder | null {
    const encoder = this.encoder;
    const swap = this.compositeTarget();
    if (encoder === null || swap === null) return null;
    const multisampled = this.compositeMsaa() !== null;
    return encoder.beginRenderPass({
      label: clear === 0 ? 'frame.resumed' : 'frame',
      timestampWrites: this.gpuTimer.writesFor(),
      colorAttachments: [
        {
          /*
           * At one sample this *is* the swap chain. Above one the multisampled texture is drawn
           * into and the swap chain receives the average, which is what `resolveTarget` means —
           * and why nothing downstream has to know which of the two is happening.
           */
          view: this.compositeMsaa() ?? swap,
          resolveTarget: multisampled ? swap : undefined,
          ...((clear & maskOf('sceneColor')) === 0
            ? { loadOp: 'load' as const }
            : {
                clearValue: {
                  r: this.pendingClearColor[0],
                  g: this.pendingClearColor[1],
                  b: this.pendingClearColor[2],
                  a: 1,
                },
                /*
                 * `clear` rather than `load`: the swap chain texture is not guaranteed to hold
                 * what was there last frame, so loading it is reading undefined contents that
                 * happen to look right on the driver being developed against.
                 */
                loadOp: 'clear' as const,
              }),
          storeOp: resolvedStoreOp(multisampled, false, this.quality.discardResolvedAttachments),
        },
      ],
      depthStencilAttachment:
        this.depthView === null
          ? undefined
          : {
              view: this.depthView,
              ...((clear & maskOf('sceneDepth')) === 0
                ? { depthLoadOp: 'load' as const }
                : { depthClearValue: DEPTH_CLEAR, depthLoadOp: 'clear' as const }),
              /*
               * **Derived, not judged.** This was `'store'` with a comment naming three readers
               * — occlusion, the light volume and the depth resolve — and each of those three is
               * a declared read the scheduler can see, so the answer is computable rather than
               * asserted. `store` whenever anything at all might load this depth again.
               *
               * The quality dial still has the last word, so a consumer that distrusts the
               * derivation turns every discard in this backend off in one place, which is the
               * same escape `resolvedStoreOp` gives the colour attachment.
               */
              depthStoreOp:
                (discard & maskOf('sceneDepth')) !== 0 && this.quality.discardResolvedAttachments
                  ? 'discard'
                  : 'store',
            },
    });
  }

  /* -- Particles ---------------------------------------------------------------------- */

  /**
   * Build a particle pool: the shared cross, instance storage sized to its capacity, and this
   * batch's own uniform buffers and bind group — see the doc comment on `createGpuParticles`
   * for why those may not be shared with another batch of the same material. The bind group
   * *layout* is the one thing still shared per material, resolved here and handed down: it is
   * structural (what the shader binds, not what value is in it), so sharing it carries none of
   * the same risk.
   */
  createParticles(capacity: number, options: ParticleBatchOptions): GpuParticles {
    const layout = this.particleLayoutFor(options.material);
    return createGpuParticles(
      this.surface.device,
      capacity,
      options.material,
      options.blend,
      options.stretchSec ?? 0,
      options.facing ?? 'camera',
      options.erosion ?? 0,
      options.coreGain ?? 1,
      options.fog ?? false,
      layout.layout,
      layout.fields,
      layout.fragSize,
    );
  }

  disposeParticles(batch: GpuParticles): void {
    batch.dispose();
  }

  /**
   * Draw a pool's live particles.
   *
   * **The instance streams are interleaved here rather than uploaded separately**, because
   * ten attributes will not fit in eight vertex-buffer slots. `packInstances` writes into an
   * array allocated with the batch, so the frame loop still allocates nothing.
   */
  /**
   * The output transform a forward pass should apply, and the exposure it should apply it at.
   *
   * The WebGPU half of `Renderer.gradeCode`, and it has to agree with it draw for draw: this is
   * one verb with two implementations, and a frame that grades on one backend and not the other
   * is the silent kind of disagreement. See that method for what the gate is protecting.
   */
  private gradeCode(): number {
    return !this.hasComposite || !this.quality.hdrScene
      ? (OUTPUT_TRANSFORM_CODE[this.quality.outputTransform] ?? 0)
      : 0;
  }

  private gradeExposure(): number {
    return !this.hasComposite || !this.quality.hdrScene ? this.exposure : 1;
  }

  drawParticles(
    batch: GpuParticles,
    data: ParticleInstances,
    camera: Camera,
    env: Environment,
    timeSeconds: number,
  ): void {
    if (!this.canDraw() || data.count === 0) return;
    const live = packInstances(batch, data);
    if (live === 0) return;

    const device = this.surface.device;
    device.queue.writeBuffer(batch.instances, 0, batch.staging, 0, live * 14);

    const v = batch.vertFloats;
    const atV = (name: string): number => (PARTICLE_VERT_FIELDS[name]?.offset ?? -4) / 4;
    mat4.multiply(this.correctedViewProj, CLIP_CORRECTION, camera.viewProjection);
    v.set(this.correctedViewProj, atV('uViewProj'));
    v.set(camera.position, atV('uCameraPos'));
    v[atV('uStretchSec')] = batch.stretchSec;
    v[atV('uCameraFacing')] = batch.facing === 'camera' ? 1 : 0;

    const f = batch.fragFloats;
    const i = batch.fragInts;
    const fields = batch.fields;
    const atF = (name: string): number => (fields[name]?.offset ?? -4) / 4;
    const has = (name: string): boolean => fields[name] !== undefined;
    /* Guarded like every other material-specific field below: the mote fragment has no use for
       the clock (no flicker, no noise phase) and does not declare uTime, unlike uCameraPos,
       which every material needs for fog and stays unconditional. */
    if (has('uTime')) f[atF('uTime')] = timeSeconds;
    f.set(camera.position, atF('uCameraPos'));
    if (has('uDirectionalDir')) f.set(env.directionalDir, atF('uDirectionalDir'));
    if (has('uDirectionalColor')) f.set(env.directionalColor, atF('uDirectionalColor'));
    if (has('uAmbient')) f.set(env.ambient, atF('uAmbient'));
    if (has('uNoiseOctaves')) i[atF('uNoiseOctaves')] = this.quality.plumeNoiseOctaves;
    if (has('uErosion')) f[atF('uErosion')] = batch.erosion;
    if (has('uCoreGain')) f[atF('uCoreGain')] = batch.coreGain;

    if (has('uLightCount')) {
      const lights = resolvePointLights(env, this.quality.pointLightFalloff, this.lights);
      i[atF('uLightCount')] = lights.count;
      scatterInto(f, fields['uLightPos'], lights.positions, 3);
      scatterInto(f, fields['uLightColor'], lights.colors, 3);
      scatterInto(f, fields['uLightRadius'], lights.radii, 1);
      scatterInto(f, fields['uLightWeight'], lights.weights, 1);
    }

    const medium = resolveAtmosphere(
      env,
      camera.position[1] ?? 0,
      this.quality.underwaterAtmosphere,
      this.medium,
    );
    f.set(medium.fogColor, atF('uFogColor'));
    f[atF('uFogDensity')] = medium.fogDensity;
    f[atF('uFogHeightFalloff')] = medium.fogHeightFalloff;
    f[atF('uFogEyeY')] = medium.fogEyeY;
    f.set(medium.underwaterColor, atF('uUnderwaterColor'));
    f[atF('uUnderwaterFogDensity')] = medium.underwaterFogDensity;
    f[atF('uUnderwaterFactor')] = medium.underwaterFactor;
    i[atF('uFogMode')] = medium.fogMode;
    f[atF('uFogNear')] = medium.fogNear;
    f[atF('uFogFar')] = medium.fogFar;
    /* Only the mote fragment declares this — spark and smoke stay unconditionally fogged and
       have no such field. See ParticleBatchOptions.fog. */
    if (has('uFogEnabled')) i[atF('uFogEnabled')] = batch.fog ? 1 : 0;
    /* Every material's fragment stage declares these, so they are unconditional like
       `uCameraPos` rather than guarded like the material-specific fields above. */
    i[atF('uOutputTransform')] = this.gradeCode();
    f[atF('uOutputExposure')] = this.gradeExposure();

    device.queue.writeBuffer(batch.vertUniforms, 0, batch.vertStaging);
    device.queue.writeBuffer(batch.fragUniforms, 0, batch.fragStaging);

    const layout = this.particleLayoutFor(batch.material).layout;
    const particlePipe = particlePipeline(
      this.pipelines,
      device,
      layout,
      batch.material,
      batch.blend,
    );
    const particleCommand = this.recordDraw(0, this.currentTarget());
    if (particleCommand !== null) {
      particleCommand.pipeline = particlePipe;
      particleCommand.bindGroup = batch.bindGroup;
      particleCommand.vertexBuffers[0] = batch.corners;
      particleCommand.vertexBuffers[1] = batch.instances;
      particleCommand.vertexCount = 2;
      particleCommand.indexBuffer = batch.indexBuffer;
      particleCommand.indexed = true;
      particleCommand.count = PARTICLE_INDICES;
      particleCommand.instances = live;
    } else {
      const pass = this.openPass();
      if (pass === null) return;
      pass.setPipeline(particlePipe);
      pass.setBindGroup(0, batch.bindGroup);
      pass.setVertexBuffer(0, batch.corners);
      pass.setVertexBuffer(1, batch.instances);
      pass.setIndexBuffer(batch.indexBuffer, 'uint32');
      pass.drawIndexed(PARTICLE_INDICES, live);
    }
  }

  /**
   * The bind group layout for one particle material, built on first use.
   *
   * Per material rather than shared across all three, because the fragment blocks are
   * different sizes (`'spark'`'s is 560 bytes, `'mote'`'s is 80) and a bind group whose
   * `minBindingSize` came from another material's block is rejected at bind time. Safe to
   * share *within* a material — unlike the uniform buffers and bind group `createGpuParticles`
   * now builds per batch — because a layout describes what a shader binds, never a value, so
   * nothing about handing the same one to two batches can go stale mid-frame.
   */
  private particleLayoutFor(material: ParticleMaterial): ParticleLayout {
    const existing = this.particleLayoutByMaterial.get(material);
    if (existing !== undefined) return existing;
    const device = this.surface.device;
    const frag = particleFragBindings(material);
    const built: ParticleLayout = {
      layout: createParticleBindGroupLayout(device, frag.size),
      fields: frag.fields,
      fragSize: frag.size,
    };
    this.particleLayoutByMaterial.set(material, built);
    return built;
  }

  /* -- Plumes ------------------------------------------------------------------------- */

  /** Build a plume batch: crossed quads per placement, and the material's own pipeline. */
  createPlumes(plumes: readonly PlumePlacement[], options: PlumeOptions): GpuPlumes {
    return createGpuPlumes(
      this.surface.device,
      buildPlumeGeometry(plumes),
      options.material,
      options.blend,
      options.sizePulse ?? 0,
      options.windResponse ?? 0,
      /* White when unnamed, exactly as `PlumeRenderer` defaults it, so neither backend
         invents a colour the other does not. */
      options.tint ?? [1, 1, 1],
    );
  }

  disposePlumes(plumes: GpuPlumes): void {
    plumes.dispose();
  }

  /**
   * Draw a plume batch after the opaque scene.
   *
   * **`uClipEnabled` is zero and stays zero until planar reflections land.** `renderer.ts`
   * passes the reflection's clip plane here so a plume is cut at the water line while the
   * mirror pass draws it; with no reflection pass there is nothing to clip against, which is
   * the same state a world with reflections switched off is in.
   */
  drawPlumes(
    plumes: GpuPlumes,
    camera: Camera,
    timeSeconds: number,
    env: Environment,
    windX = 0,
    windZ = 0,
    originX = 0,
    originY = 0,
    originZ = 0,
  ): void {
    if (!this.canDraw() || plumes.indexCount === 0) return;

    const vertexSlot = this.plumeVerts.allocate();
    const fragmentSlot = this.plumeFrags.allocate();
    if (vertexSlot === null || fragmentSlot === null) return;

    const verts = this.plumeVerts;
    const atV = (name: string): number => PLUME_VERT_FIELDS[name]?.offset ?? 0;
    mat4.multiply(this.correctedViewProj, CLIP_CORRECTION, camera.viewProjection);
    verts.writeFloats(vertexSlot, atV('uViewProj'), this.correctedViewProj);
    verts.writeFloats(vertexSlot, atV('uCameraPos'), camera.position);
    verts.writeFloat(vertexSlot, atV('uTime'), timeSeconds);
    /*
     * **Per batch, which is why these blocks come out of a ring.** A flame's `windResponse` is
     * 0.12 and the smoke above it 1.35, and a scene draws both in one pass; from a single
     * buffer the second write won for both draws and the fire leaned like smoke.
     */
    verts.writeFloat(vertexSlot, atV('uSizePulse'), plumes.sizePulse);
    verts.writeFloat(vertexSlot, atV('uWindResponse'), plumes.windResponse);
    verts.writeFloat(vertexSlot, atV('uWind'), windX);
    verts.writeFloat(vertexSlot, atV('uWind') + 4, windZ);
    verts.writeFloat(vertexSlot, atV('uOrigin'), originX);
    verts.writeFloat(vertexSlot, atV('uOrigin') + 4, originY);
    verts.writeFloat(vertexSlot, atV('uOrigin') + 8, originZ);

    const frags = this.plumeFrags;
    const atF = (name: string): number => PLUME_FRAG_FIELDS[name]?.offset ?? 0;
    frags.writeFloat(fragmentSlot, atF('uTime'), timeSeconds);
    frags.writeInt(fragmentSlot, atF('uNoiseOctaves'), this.quality.plumeNoiseOctaves);
    /* The mirror's half-space, as the flat pass writes it; see `bindMeshPass`. */
    frags.writeInt(fragmentSlot, atF('uClipEnabled'), this.reflectionPassActive ? 1 : 0);
    frags.writeFloats(fragmentSlot, atF('uClipPlane'), this.reflection?.clipPlane ?? NO_CLIP_PLANE);
    const medium = resolveAtmosphere(
      env,
      this.atmosphereHeight(camera),
      this.quality.underwaterAtmosphere,
      this.medium,
    );
    frags.writeFloats(fragmentSlot, atF('uFogColor'), medium.fogColor);
    frags.writeFloat(fragmentSlot, atF('uFogDensity'), medium.fogDensity);
    frags.writeFloat(fragmentSlot, atF('uFogHeightFalloff'), medium.fogHeightFalloff);
    frags.writeFloat(fragmentSlot, atF('uFogEyeY'), medium.fogEyeY);
    frags.writeFloats(fragmentSlot, atF('uUnderwaterColor'), medium.underwaterColor);
    frags.writeFloat(fragmentSlot, atF('uUnderwaterFogDensity'), medium.underwaterFogDensity);
    frags.writeFloat(fragmentSlot, atF('uUnderwaterFactor'), medium.underwaterFactor);
    frags.writeInt(fragmentSlot, atF('uFogMode'), medium.fogMode);
    frags.writeFloat(fragmentSlot, atF('uFogNear'), medium.fogNear);
    frags.writeFloat(fragmentSlot, atF('uFogFar'), medium.fogFar);
    /*
     * **Written for every material, not only the one that reads it.** `arcane` is the only
     * plume whose block declares `uTint`, and the slot it lands in is past the end of fire's
     * and smoke's blocks — harmless, because their shaders never look there, and the ring's
     * stride covers the widest block. Writing it unconditionally is what keeps this in step
     * with `PlumeRenderer`, which has set `uTint` on every draw since before this backend.
     */
    frags.writeFloats(fragmentSlot, atF('uTint'), plumes.tint);

    const plumePipe = plumePipeline(
      this.pipelines,
      this.surface.device,
      this.plumeLayout,
      plumes.material,
      plumes.blend,
    );
    const plumeCommand = this.recordDraw(0, this.currentTarget());
    if (plumeCommand !== null) {
      plumeCommand.pipeline = plumePipe;
      plumeCommand.bindGroup = this.plumeBindGroup;
      plumeCommand.offsetA = vertexSlot;
      plumeCommand.offsetB = fragmentSlot;
      plumeCommand.offsetCount = 2;
      for (let index = 0; index < plumes.vertexBuffers.length; index++) {
        plumeCommand.vertexBuffers[index] = plumes.vertexBuffers[index] as GPUBuffer;
      }
      plumeCommand.vertexCount = plumes.vertexBuffers.length;
      plumeCommand.indexBuffer = plumes.indexBuffer;
      plumeCommand.indexed = true;
      plumeCommand.count = plumes.indexCount;
    } else {
      const pass = this.openPass();
      if (pass === null) return;
      pass.setPipeline(plumePipe);
      pass.setBindGroup(0, this.plumeBindGroup, [vertexSlot, fragmentSlot]);
      for (let index = 0; index < plumes.vertexBuffers.length; index++) {
        pass.setVertexBuffer(index, plumes.vertexBuffers[index] as GPUBuffer);
      }
      pass.setIndexBuffer(plumes.indexBuffer, 'uint32');
      pass.drawIndexed(plumes.indexCount);
    }
  }

  /* -- Water -------------------------------------------------------------------------- */

  /**
   * Build a body of water: the ocean's two sheets and a unit patch for bounded bodies.
   *
   * The grid's own numbers — cell size and the two extents — travel with the handle, because
   * `resolveWater` needs them and they belong to this body rather than to the renderer.
   */
  createWater(resolution = 128, nearExtent = 500, farHalfExtent = 4000): GpuWater {
    return createGpuWater(
      this.surface.device,
      resolution,
      nearExtent,
      farHalfExtent,
      this.quality.waterReflectionFilterTaps,
    );
  }

  /** Release a body of water. */
  disposeWater(water: GpuWater): void {
    water.dispose();
  }

  /**
   * Draw a body of water, after the opaque scene.
   *
   * **A mirror is used only if this frame drew one for this water plane.** `reflectionFor`
   * answers that; where it says no, the binding takes the one-pixel stand-in and
   * `uReflectionEnabled` is zero, which is the shader's own "no reflection" path and exactly
   * what `renderer.ts` binds for a world with reflections switched off.
   */
  drawWater(
    water: GpuWater,
    camera: Camera,
    timeSeconds: number,
    settings: WaterBody,
    env: Environment,
    windX = 0,
    windZ = 0,
  ): void {
    if (!this.canDraw() || !this.quality.water) return;

    /*
     * A slot each, before anything is prepared: a body that cannot be addressed must not be
     * drawn with another body's numbers, which is what a shared buffer did before the ring.
     */
    const vertexSlot = this.waterVerts.allocate();
    const fragmentSlot = this.waterFrags.allocate();
    if (vertexSlot === null || fragmentSlot === null) {
      if (!this.warnedWaterFull) {
        this.warnedWaterFull = true;
        console.warn(
          `WebGPU: more than ${MAX_WATER_BODIES_PER_FRAME} bodies of water in a frame; the rest are skipped`,
        );
      }
      return;
    }

    const v = this.waterVertFloats;
    const atV = (name: string): number => (WATER_VERT_FIELDS[name]?.offset ?? -4) / 4;
    mat4.multiply(this.correctedViewProj, CLIP_CORRECTION, camera.viewProjection);
    v.set(this.correctedViewProj, atV('uViewProj'));
    /*
     * The mirror's own projection, or the camera's where there is no mirror.
     *
     * The fallback is what `renderer.ts` binds when a reflection is absent: `uReflectionEnabled`
     * decides whether the matrix is read at all, and an unwritten one would be singular.
     *
     * **Corrected, like every other matrix that reaches a vertex stage here.** The mirror was
     * rasterised through `CLIP_CORRECTION`, so its texture holds a frame in WebGPU's clip
     * space; the lookup projects a world point with this matrix and reads that texture, so the
     * two have to be in the same space or the reflection samples its own mirror image.
     */
    const mirror = this.reflectionFor(settings.level);
    if (mirror === null) {
      v.set(this.correctedViewProj, atV('uReflectionViewProj'));
    } else {
      mat4.multiply(
        this.correctedReflectionViewProj,
        CLIP_CORRECTION,
        mirror.camera.viewProjection,
      );
      v.set(this.correctedReflectionViewProj, atV('uReflectionViewProj'));
    }
    v.set(camera.position, atV('uCameraPos'));
    v[atV('uTime')] = timeSeconds;

    /* Laid and settled in `waterDraw.ts`, so both backends get the same sea. */
    const w = resolveWater(
      settings,
      camera.position[0] ?? 0,
      camera.position[2] ?? 0,
      water.cellSize,
      water.nearHalfExtent,
      water.farHalfExtent,
      windX,
      windZ,
      this.resolvedWater,
    );
    v.set(w.origin, atV('uGridOrigin'));
    /* Pairs since 2026-08-28: a body is bounded along each of its own axes, and `forward` is the
       direction those axes take. The ocean passes one number twice and is unchanged. */
    v.set(w.span, atV('uGridSpan'));
    v.set(w.half, atV('uGridHalf'));
    v.set(w.nearHalf, atV('uNearHalf'));
    v.set(w.forward, atV('uGridForward'));
    v.set(w.windDir, atV('uWindDir'));
    v[atV('uWaveGain')] = w.waveGain;

    const look = waterAppearance(settings);
    const f = this.waterFragFloats;
    const i = this.waterFragInts;
    const atF = (name: string): number => (WATER_FRAG_FIELDS[name]?.offset ?? -4) / 4;
    /* `uWaterLevel` is a vertex term and `uGridHalf` is read by both stages. */
    v[atV('uWaterLevel')] = look.level;
    f.set(w.half, atF('uGridHalf'));
    f[atF('uFoamGain')] = w.foamGain;
    f[atF('uNadirOpacity')] = look.nadirOpacity;
    f[atF('uVisibility')] = look.visibility;
    f[atF('uMirror')] = look.mirror;
    f.set(look.deepColor, atF('uDeepColor'));
    f.set(look.shallowColor, atF('uShallowColor'));
    f.set(env.directionalDir, atF('uDirectionalDir'));
    f.set(env.directionalColor, atF('uDirectionalColor'));
    f.set(env.ambient, atF('uAmbient'));
    f.set(camera.position, atF('uCameraPos'));

    const lights = resolvePointLights(env, this.quality.pointLightFalloff, this.lights);
    i[atF('uLightCount')] = lights.count;
    i[atF('uLightFalloff')] = lights.falloff;
    scatterInto(f, WATER_FRAG_FIELDS['uLightPos'], lights.positions, 3);
    scatterInto(f, WATER_FRAG_FIELDS['uLightColor'], lights.colors, 3);
    scatterInto(f, WATER_FRAG_FIELDS['uLightRadius'], lights.radii, 1);
    scatterInto(f, WATER_FRAG_FIELDS['uLightSourceRadius'], lights.sourceRadii, 1);
    scatterInto(f, WATER_FRAG_FIELDS['uLightWeight'], lights.weights, 1);

    const medium = resolveAtmosphere(
      env,
      camera.position[1] ?? 0,
      this.quality.underwaterAtmosphere,
      this.medium,
    );
    f.set(medium.fogColor, atF('uFogColor'));
    f[atF('uFogDensity')] = medium.fogDensity;
    f[atF('uFogHeightFalloff')] = medium.fogHeightFalloff;
    f[atF('uFogEyeY')] = medium.fogEyeY;
    f.set(medium.underwaterColor, atF('uUnderwaterColor'));
    f[atF('uUnderwaterFogDensity')] = medium.underwaterFogDensity;
    f[atF('uUnderwaterFactor')] = medium.underwaterFactor;
    i[atF('uFogMode')] = medium.fogMode;
    f[atF('uFogNear')] = medium.fogNear;
    f[atF('uFogFar')] = medium.fogFar;

    /* No reflection pass yet: the shader's own "off" path, not an improvised one. */
    i[atF('uReflectionEnabled')] = mirror === null ? 0 : 1;
    i[atF('uReflectionFilterTaps')] = water.reflectionFilterTaps;
    f[atF('uReflectionTexelSize')] = mirror === null ? 1 : 1 / mirror.width;
    f[atF('uReflectionTexelSize') + 1] = mirror === null ? 1 : 1 / mirror.height;

    /*
     * Into this body's own slots, bit for bit through the integer views — a block mixing floats
     * and `i32`s copied as floats would canonicalise a sentinel NaN, which is `UniformRing`'s
     * own warning. The rings are uploaded once for the whole frame in `endFrame`.
     */
    this.waterVerts.writeBlock(vertexSlot, this.waterVertBlock);
    this.waterFrags.writeBlock(fragmentSlot, this.waterFragInts);

    const mesh = w.bounded ? water.patch : water.sheet;
    const waterPipe = waterPipeline(this.pipelines, this.surface.device, this.waterLayout);
    /* Water samples the planar reflection's colour, so that has to survive this draw. Its
       depth is not sampled by anything and is deliberately not claimed here. */
    const waterCommand = this.recordDraw(MIRROR_COLOR, this.currentTarget());
    if (waterCommand !== null) {
      waterCommand.pipeline = waterPipe;
      waterCommand.bindGroup = this.waterBindGroup;
      waterCommand.offsetA = vertexSlot;
      waterCommand.offsetB = fragmentSlot;
      waterCommand.offsetCount = 2;
      waterCommand.vertexBuffers[0] = mesh.buffer;
      waterCommand.vertexCount = 1;
      waterCommand.indexBuffer = mesh.index;
      waterCommand.indexed = true;
      waterCommand.count = mesh.count;
    } else {
      const pass = this.openPass();
      if (pass === null) return;
      pass.setPipeline(waterPipe);
      pass.setBindGroup(0, this.waterBindGroup, [vertexSlot, fragmentSlot]);
      pass.setVertexBuffer(0, mesh.buffer);
      pass.setIndexBuffer(mesh.index, 'uint32');
      pass.drawIndexed(mesh.count);
    }
  }

  /* -- Light volumes ------------------------------------------------------------------ */

  /**
   * Chosen from the profile rather than pinned, because there are two of it and both are
   * generated. `renderer.ts` compiles `lightVolumeFrag({ directionalShadows })` from the same
   * field, so a profile with the sun's shadows off gets a shader with no map to read on either
   * backend. The flat pass is still pinned to one of its sixteen; that is its own row.
   */
  private readonly lightVolumeVariant: LightVolumeVariant;
  private readonly lightVolumeFragment: ReturnType<typeof lightVolumeFragmentBindings>;
  private readonly lightVolumeLayout: GPUBindGroupLayout;
  private readonly lightVolumeVertices: UniformRing;
  private readonly lightVolumeFragments: UniformRing;
  /**
   * Not `readonly`, because one of the views it holds is allocated with the drawing buffer.
   *
   * A bind group holds views, and the depth snapshot a volume clamps against is created and
   * destroyed by `ensureComposite` — so this is rebuilt there for the same reason `rushBindGroup`
   * and the water's are. Built once at construction it would hold the stand-in for ever, which
   * is a beam that still draws and never clamps.
   */
  private lightVolumeBindGroup: GPUBindGroup;
  /** The two things `buildLightVolumeBindGroup` needs that are settled in the constructor. */
  private readonly volumeShadowSampler: GPUSampler;
  private readonly volumeBlank: { readonly view: GPUTextureView; readonly sampler: GPUSampler };
  /** Where the camera stands in the volume, filled per draw into an object this class owns. */
  private readonly volume: ResolvedLightVolume = createResolvedLightVolume();

  /**
   * Draw a volume of light: a closed hull, and the air inside it integrated along the view ray.
   *
   * **Two things are decided on the CPU and both are `resolveLightVolume`'s**: the camera in the
   * volume's own space, which is the frame the march runs in, and whether the camera is inside
   * the cone, which decides which half of the hull to keep. Neither is a binding, so neither is
   * written twice — see that module.
   *
   * Everything else here is one draw's uniforms, and **every field is written every draw**. A
   * ring slot holds whatever the volume that used it last frame put there, so a field left out
   * on the grounds that the shader will not reach it is a stale value waiting for the frame
   * where it does.
   */
  drawLightVolume(
    mesh: GpuMesh,
    model: ReadonlyMat4,
    camera: Camera,
    strength: number,
    length: number,
    spread: number,
    options: LightVolumeDrawOptions = {},
  ): void {
    /* Only to prove there is somewhere to draw. The pass itself is opened below, immediately
       before `takeVolumeDepth`, which is the one thing here that genuinely needs one open —
       it ends the current pass to copy the depth out and opens another in its place. */
    if (!this.canDraw()) return;
    /* Geometry that has not all arrived is not drawn, which is the surface's contract and what
       every other mesh verb here and the other backend's volume already kept. This one drew a
       beam from a buffer still filling, and counted it, until 2026-09-19. See `Mesh.complete`. */
    if (!mesh.complete) return;
    /* At zero it draws nothing rather than adding black, so a caller may keep the call in. That
       now covers a clear night too: a beam with no medium to light is not drawn at all. */
    const shown =
      options.medium === undefined
        ? strength
        : strength *
          volumeMediumGain(options.medium.atmosphere, model, options.medium.fullAtDensity);
    if (shown <= 0) return;

    const vertexSlot = this.lightVolumeVertices.allocate();
    const fragmentSlot = this.lightVolumeFragments.allocate();
    if (vertexSlot === null || fragmentSlot === null) {
      if (!this.warnedVolumesFull) {
        this.warnedVolumesFull = true;
        console.warn(
          `WebGPU: more than ${MAX_LIGHT_VOLUMES_PER_FRAME} light volumes in a frame; the rest are skipped`,
        );
      }
      return;
    }

    mat4.multiply(this.correctedViewProj, CLIP_CORRECTION, camera.viewProjection);
    this.lightVolumeVertices.writeFloats(
      vertexSlot,
      LIGHT_VOLUME_VERT_FIELDS.uViewProj.offset,
      this.correctedViewProj,
    );
    this.lightVolumeVertices.writeFloats(
      vertexSlot,
      LIGHT_VOLUME_VERT_FIELDS.uModel.offset,
      model as Float32Array,
    );

    const ring = this.lightVolumeFragments;
    const at = (name: string): number => {
      const field = this.lightVolumeFragment.fields[name];
      if (field === undefined) {
        throw new Error(`lightVolume: no field ${name} in variant ${this.lightVolumeVariant}`);
      }
      return field.offset;
    };
    const resolved = resolveLightVolume(model, camera.position, length, spread, this.volume);

    ring.writeFloats(fragmentSlot, at('uCameraPos'), camera.position);
    ring.writeFloats(fragmentSlot, at('uCameraLocal'), resolved.cameraLocal);
    ring.writeFloats(fragmentSlot, at('uModelWorld'), model as Float32Array);
    /* Clamped to 1 exactly as `renderer.ts` clamps it: above 1 it does nothing on either side. */
    ring.writeFloat(fragmentSlot, at('uStrength'), Math.min(shown, 1));
    ring.writeFloat(fragmentSlot, at('uLength'), length);
    ring.writeFloat(fragmentSlot, at('uSpread'), spread);
    ring.writeFloat(fragmentSlot, at('uDust'), clamp(options.dust ?? 0, 0, 1));
    ring.writeFloat(fragmentSlot, at('uDustScale'), options.dustScaleM ?? 1);
    ring.writeFloats(fragmentSlot, at('uDustOffset'), options.driftM ?? NO_DRIFT);
    ring.writeFloat(fragmentSlot, at('uNear'), options.nearM ?? 0);
    ring.writeInt(fragmentSlot, at('uSamples'), this.quality.lightVolumeSamples);

    /*
     * The clamp that makes a beam end on the floor, and the snapshot it reads.
     *
     * Taken here rather than at `beginFrame`, because the depth a volume must not march past is
     * the *opaque scene's*, and at `beginFrame` nothing has been drawn into it yet. Taken once a
     * frame however many volumes there are — see `volumeDepthTaken`.
     *
     * **The raw `camera.viewProjection`, not the corrected one**, and that is the line worth
     * reading twice on this backend. Every other matrix here is corrected because WebGPU's clip
     * space differs from WebGL2's in two ways; the Y half of that correction is then undone
     * again by the flip naga writes into every generated vertex stage, so what the rasteriser
     * used *is* the raw matrix's Y. Handing this `correctedViewProj` would mirror the clamp
     * about the middle of the frame and still draw a plausible beam, which is the failure this
     * whole backend keeps producing.
     *
     * The one thing that does not cancel is the framebuffer's own direction, and that is what
     * `DEPTH_01_TO_CLIP_Y_DOWN` carries rather than `DEPTH_01_TO_CLIP`. Its comment has the
     * derivation and the measurement; this is the line it is about.
     */
    /*
     * Opened here rather than at the top, so a frame whose volumes are all skipped above never
     * opens a pass for them. `takeVolumeDepth` ends whatever is current, so there has to be one.
     */
    if (this.openPass() === null) return;
    const clamped = this.takeVolumeDepth();
    /* Re-read: the snapshot above closed the pass this was called on. */
    const pass = this.pass;
    if (pass === null) return;
    ring.writeInt(fragmentSlot, at('uSceneDepthEnabled'), clamped ? 1 : 0);
    if (clamped) {
      const width = Math.max(1, this.depth?.width ?? 1);
      const height = Math.max(1, this.depth?.height ?? 1);
      ring.writeFloats(fragmentSlot, at('uInvViewport'), [1 / width, 1 / height]);
      mat4.multiply(this.volumeDepthScratch, camera.viewProjection, model);
      mat4.invert(this.volumeDepthToLocal, this.volumeDepthScratch);
      mat4.multiply(this.volumeDepthToLocal, this.volumeDepthToLocal, DEPTH_01_TO_CLIP_Y_DOWN);
      ring.writeFloats(fragmentSlot, at('uDepthToLocal'), this.volumeDepthToLocal);
    }

    if (this.lightVolumeVariant === 'directionalShadows') {
      /*
       * The sun's map, and the two conditions `renderer.ts` applies to it: the permutation
       * decides whether the samplers exist at all, and a caller that did not supply an
       * environment has no matrix to project with, so the term is zero rather than guessed.
       *
       * **`uLightViewProj` is the light matrix as the scene built it, uncorrected.** The lookup
       * is `p = p * 0.5 + 0.5` on all three axes — the OpenGL convention — exactly as `flat.ts`
       * does it, and `SHADOW_CLIP_CORRECTION` is what the map was *rendered* with. Handing this
       * the corrected one mirrors every bar a shaft carries.
       */
      const env = options.env;
      const sunShadow = env === undefined ? 0 : clamp(options.sunShadow ?? 0, 0, 1);
      ring.writeFloat(fragmentSlot, at('uSunShadow'), sunShadow);
      ring.writeFloats(
        fragmentSlot,
        at('uLightViewProj'),
        env === undefined ? NO_LIGHT_MATRIX : (env.lightViewProj as Float32Array),
      );
      ring.writeFloat(fragmentSlot, at('uShadowMapSize'), this.quality.directionalShadowMapSize);
      /* Sampled only where a pass filled it — see `peelFilled` for why existing is not enough. */
      ring.writeInt(fragmentSlot, at('uPeeledShadowEnabled'), this.peelFilled ? 1 : 0);
    }

    const key = `lightVolume|${this.lightVolumeVariant}|${resolved.inside ? 'front' : 'back'}|${
      (mesh as GpuMesh & { key?: string }).key ?? ''
    }`;
    const volumePipe = lightVolumePipeline(
      this.pipelines,
      this.surface.device,
      this.lightVolumeLayout,
      this.lightVolumeVariant,
      resolved.inside ? 'front' : 'back',
      this.presentOf(mesh),
      key,
    );
    /*
     * Reads the snapshot, and only when one was taken: `clamped` is exactly the question of
     * whether `uSceneDepth` is a real copy or the stand-in, and it is already answered above.
     *
     * **The three shadow layers are sampled too and are deliberately not declared.** They are
     * baked on their own encoder, submitted before the frame, and no node writes them — so a
     * read here would name nothing and protect nothing. When the shadow passes record, every
     * lit verb's reads have to be revisited together, and declaring a fraction of that now
     * would look like the job was done.
     */
    const volumeCommand = this.recordDraw(clamped ? DEPTH_SNAPSHOT : 0, this.currentTarget());
    if (volumeCommand !== null) {
      volumeCommand.pipeline = volumePipe;
      volumeCommand.bindGroup = this.lightVolumeBindGroup;
      volumeCommand.offsetA = vertexSlot;
      volumeCommand.offsetB = fragmentSlot;
      volumeCommand.offsetCount = 2;
      for (let index = 0; index < mesh.vertexBuffers.length; index++) {
        volumeCommand.vertexBuffers[index] = mesh.vertexBuffers[index] as GPUBuffer;
      }
      volumeCommand.vertexCount = mesh.vertexBuffers.length;
      volumeCommand.indexBuffer = mesh.indexBuffer;
      volumeCommand.indexed = true;
      volumeCommand.count = mesh.indexCount;
    } else {
      pass.setPipeline(volumePipe);
      pass.setBindGroup(0, this.lightVolumeBindGroup, [vertexSlot, fragmentSlot]);
      for (let index = 0; index < mesh.vertexBuffers.length; index++) {
        pass.setVertexBuffer(index, mesh.vertexBuffers[index] as GPUBuffer);
      }
      pass.setIndexBuffer(mesh.indexBuffer, 'uint32');
      pass.drawIndexed(mesh.indexCount);
    }
  }

  /** Said once rather than every frame, for the reason `warnedFull` gives. */
  private warnedVolumesFull = false;

  /* -- Wind streaks, the flock and the arcs -------------------------------------------- */

  private readonly windStreakLayout: GPUBindGroupLayout;
  /** A slot per batch, for the reason `windStreakPass.ts`'s layout gives. */
  private readonly windStreakVerts: UniformRing;
  private readonly windStreakFrags: UniformRing;
  private readonly windStreakVertStaging = new ArrayBuffer(WIND_STREAK_VERT_SIZE);
  private readonly windStreakVertFloats = new Float32Array(this.windStreakVertStaging);
  /** The same bytes as an `i32` view, which is what a ring slot is copied through. */
  private readonly windStreakVertBlock = new Int32Array(this.windStreakVertStaging);
  private readonly windStreakFragStaging = new ArrayBuffer(WIND_STREAK_FRAG_SIZE);
  private readonly windStreakFragFloats = new Float32Array(this.windStreakFragStaging);
  private readonly windStreakFragBlock = new Int32Array(this.windStreakFragStaging);
  private readonly windStreakBindGroup: GPUBindGroup;
  /** Said once rather than every frame, for the reason `warnedFull` gives. */
  private warnedStreaksFull = false;
  /** Refilled per call rather than allocated; see `createResolvedWindStreaks`. */
  private readonly streaks: ResolvedWindStreaks = createResolvedWindStreaks();

  /**
   * Build a lattice of wind-borne debris.
   *
   * The thresholds are resolved here rather than left on the handle, because
   * `windStreakDraw.ts` owns the defaults and a second copy of an onset speed is debris that
   * appears at a different wind on one backend.
   */
  createWindStreaks(options: WindStreakOptions = {}): GpuWindStreaks {
    return createGpuWindStreaks(
      this.surface.device,
      options.count ?? WIND_STREAK_DEFAULTS.count,
      options.cellSize ?? WIND_STREAK_DEFAULTS.cellSize,
      options.onsetSpeed ?? WIND_STREAK_DEFAULTS.onsetSpeed,
      options.fullSpeed ?? WIND_STREAK_DEFAULTS.fullSpeed,
    );
  }

  disposeWindStreaks(streaks: GpuWindStreaks): void {
    streaks.dispose();
  }

  /**
   * Draw the wind, after the opaque scene.
   *
   * **Whether the camera is under water is the engine's question, not the caller's**, exactly as
   * `renderer.ts` argues: every pass already knows where the waterline is, and leaving it to
   * each call site is how one of them ends up raining dust into the sea.
   */
  drawWindStreaks(
    streaks: GpuWindStreaks,
    camera: Camera,
    wind: WindField,
    timeSeconds: number,
    tint: Vec3,
    env: Environment,
  ): void {
    if (!this.canDraw()) return;

    const surface = env.underwater?.surfaceY;
    const submerged = surface !== undefined && (camera.position[1] ?? 0) < surface;
    const settled = resolveWindStreaks(
      wind.speed,
      wind.driftX,
      wind.driftZ,
      streaks.onsetSpeed,
      streaks.fullSpeed,
      submerged,
      this.streaks,
    );
    /* A calm day costs no draw at all, which is the WebGL2 path's rule and not an optimisation. */
    if (!settled.visible) return;

    /*
     * A slot each, before anything is prepared: a batch that cannot be addressed must not be
     * drawn with another batch's numbers, which is what a shared buffer did before the ring.
     */
    const vertexSlot = this.windStreakVerts.allocate();
    const fragmentSlot = this.windStreakFrags.allocate();
    if (vertexSlot === null || fragmentSlot === null) {
      if (!this.warnedStreaksFull) {
        this.warnedStreaksFull = true;
        console.warn(
          `WebGPU: more than ${MAX_BATCHES_PER_FRAME} wind-streak fields in a frame; the rest are skipped`,
        );
      }
      return;
    }

    const v = this.windStreakVertFloats;
    const at = (name: string): number => (WIND_STREAK_VERT_FIELDS[name]?.offset ?? -4) / 4;
    mat4.multiply(this.correctedViewProj, CLIP_CORRECTION, camera.viewProjection);
    v.set(this.correctedViewProj, at('uViewProj'));
    v.set(camera.position, at('uCameraPos'));
    v[at('uWind')] = wind.velocityX;
    v[at('uWind') + 1] = wind.velocityZ;
    v[at('uDrift')] = settled.driftX;
    v[at('uDrift') + 1] = settled.driftZ;
    v[at('uSpeed')] = wind.speed;
    v[at('uStrength')] = settled.strength;
    v[at('uCount')] = streaks.count;
    v[at('uCellSize')] = streaks.cellSize;
    v[at('uTime')] = timeSeconds;

    this.windStreakFragFloats.set(tint, (WIND_STREAK_FRAG_FIELDS.uTint.offset ?? 0) / 4);

    const { queue } = this.surface.device;
    this.windStreakVerts.writeBlock(vertexSlot, this.windStreakVertBlock);
    this.windStreakFrags.writeBlock(fragmentSlot, this.windStreakFragBlock);

    const windPipe = windStreakPipeline(this.pipelines, this.surface.device, this.windStreakLayout);
    /* Two uniform buffers and two vertex buffers. Nothing is sampled, so nothing is read. */
    const windCommand = this.recordDraw(0, this.currentTarget());
    if (windCommand !== null) {
      windCommand.pipeline = windPipe;
      windCommand.bindGroup = this.windStreakBindGroup;
      windCommand.offsetA = vertexSlot;
      windCommand.offsetB = fragmentSlot;
      windCommand.offsetCount = 2;
      windCommand.vertexBuffers[0] = streaks.corners;
      windCommand.vertexBuffers[1] = streaks.indices;
      windCommand.vertexCount = 2;
      windCommand.count = streaks.vertexCount;
    } else {
      const pass = this.openPass();
      if (pass === null) return;
      pass.setPipeline(windPipe);
      pass.setBindGroup(0, this.windStreakBindGroup, [vertexSlot, fragmentSlot]);
      pass.setVertexBuffer(0, streaks.corners);
      pass.setVertexBuffer(1, streaks.indices);
      pass.draw(streaks.vertexCount);
    }
  }

  private readonly flockLayout: GPUBindGroupLayout;
  /** A slot per batch, for the reason `flockPass.ts`'s layout gives. */
  private readonly flockVerts: UniformRing;
  private readonly flockFrags: UniformRing;
  private readonly flockVertStaging = new ArrayBuffer(FLOCK_VERT_SIZE);
  private readonly flockVertFloats = new Float32Array(this.flockVertStaging);
  /** The same bytes as an `i32` view, which is what a ring slot is copied through. */
  private readonly flockVertBlock = new Int32Array(this.flockVertStaging);
  private readonly flockFragStaging = new ArrayBuffer(FLOCK_FRAG_SIZE);
  private readonly flockFragFloats = new Float32Array(this.flockFragStaging);
  private readonly flockFragBlock = new Int32Array(this.flockFragStaging);
  private readonly flockBindGroup: GPUBindGroup;
  /** Said once rather than every frame, for the reason `warnedFull` gives. */
  private warnedFlockFull = false;

  createFlock(count: number): GpuFlock {
    return createGpuFlock(this.surface.device, count);
  }

  disposeFlock(flock: GpuFlock): void {
    flock.dispose();
  }

  /**
   * Draw a flock.
   *
   * **No `uCameraPos`, because the shader no longer declares one.** It fed a banking term that
   * turned a wing plane toward the viewer, reverted with the rest of the flock work when the
   * shape being reported turned out to be a lighthouse beam; see `AGENTS.md` 2026-08-10 and the
   * comment in `flockRenderer.ts`. Binding one here would be reintroducing it on one backend.
   */
  drawFlock(
    flock: GpuFlock,
    camera: Camera,
    timeSeconds: number,
    params: FlockParams,
    tint: Vec3,
    windX = 0,
    windZ = 0,
  ): void {
    if (!this.canDraw()) return;

    /*
     * A slot each, before anything is prepared: a batch that cannot be addressed must not be
     * drawn with another batch's numbers, which is what a shared buffer did before the ring.
     */
    const vertexSlot = this.flockVerts.allocate();
    const fragmentSlot = this.flockFrags.allocate();
    if (vertexSlot === null || fragmentSlot === null) {
      if (!this.warnedFlockFull) {
        this.warnedFlockFull = true;
        console.warn(
          `WebGPU: more than ${MAX_BATCHES_PER_FRAME} flocks in a frame; the rest are skipped`,
        );
      }
      return;
    }

    const v = this.flockVertFloats;
    const at = (name: string): number => (FLOCK_VERT_FIELDS[name]?.offset ?? -4) / 4;
    mat4.multiply(this.correctedViewProj, CLIP_CORRECTION, camera.viewProjection);
    v.set(this.correctedViewProj, at('uViewProj'));
    v.set(params.center, at('uCenter'));
    v[at('uRadius')] = params.radius;
    v[at('uHeight')] = params.height;
    v[at('uSpeed')] = params.speed;
    v[at('uCount')] = params.count;
    v[at('uScale')] = params.scale;
    v[at('uTime')] = timeSeconds;
    v[at('uWind')] = windX;
    v[at('uWind') + 1] = windZ;

    this.flockFragFloats.set(tint, (FLOCK_FRAG_FIELDS.uTint.offset ?? 0) / 4);

    const { queue } = this.surface.device;
    this.flockVerts.writeBlock(vertexSlot, this.flockVertBlock);
    this.flockFrags.writeBlock(fragmentSlot, this.flockFragBlock);

    const flockPipe = flockPipeline(this.pipelines, this.surface.device, this.flockLayout);
    const flockCommand = this.recordDraw(0, this.currentTarget());
    if (flockCommand !== null) {
      flockCommand.pipeline = flockPipe;
      flockCommand.bindGroup = this.flockBindGroup;
      flockCommand.offsetA = vertexSlot;
      flockCommand.offsetB = fragmentSlot;
      flockCommand.offsetCount = 2;
      flockCommand.vertexBuffers[0] = flock.corners;
      flockCommand.vertexBuffers[1] = flock.wings;
      flockCommand.vertexBuffers[2] = flock.indices;
      flockCommand.vertexCount = 3;
      flockCommand.count = flock.vertexCount;
    } else {
      const pass = this.openPass();
      if (pass === null) return;
      pass.setPipeline(flockPipe);
      pass.setBindGroup(0, this.flockBindGroup, [vertexSlot, fragmentSlot]);
      pass.setVertexBuffer(0, flock.corners);
      pass.setVertexBuffer(1, flock.wings);
      pass.setVertexBuffer(2, flock.indices);
      pass.draw(flock.vertexCount);
    }
  }

  private readonly boltLayout: GPUBindGroupLayout;
  /** A slot per batch, for the reason `boltPass.ts`'s layout gives. */
  private readonly boltVerts: UniformRing;
  private readonly boltFrags: UniformRing;
  private readonly boltVertStaging = new ArrayBuffer(BOLT_VERT_SIZE);
  private readonly boltVertFloats = new Float32Array(this.boltVertStaging);
  /** The same bytes as an `i32` view, which is what a ring slot is copied through. */
  private readonly boltVertBlock = new Int32Array(this.boltVertStaging);
  private readonly boltFragStaging = new ArrayBuffer(BOLT_FRAG_SIZE);
  private readonly boltFragFloats = new Float32Array(this.boltFragStaging);
  private readonly boltFragInts = new Int32Array(this.boltFragStaging);
  private readonly boltBindGroup: GPUBindGroup;
  /** Said once rather than every frame, for the reason `warnedFull` gives. */
  private warnedBoltsFull = false;

  createBolts(segmentCapacity: number, label = 'bolts'): GpuBolts {
    return createGpuBolts(this.surface.device, segmentCapacity, label);
  }

  disposeBolts(batch: GpuBolts): void {
    batch.dispose();
  }

  /**
   * Draw a pool of arcs.
   *
   * The per-frame streams are expanded by `expandBoltSegments` and written whole: three writes
   * of the live prefix rather than one per segment, into staging allocated with the batch.
   */
  drawBolts(
    batch: GpuBolts,
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
    if (!this.canDraw() || data.count === 0) return;
    const count = expandBoltSegments(data, batch.capacity, batch.from, batch.to, batch.arc);
    if (count === 0) return;
    const verts = count * 4;

    /*
     * A slot each, before anything is prepared: a batch that cannot be addressed must not be
     * drawn with another batch's numbers, which is what a shared buffer did before the ring.
     */
    const vertexSlot = this.boltVerts.allocate();
    const fragmentSlot = this.boltFrags.allocate();
    if (vertexSlot === null || fragmentSlot === null) {
      if (!this.warnedBoltsFull) {
        this.warnedBoltsFull = true;
        console.warn(
          `WebGPU: more than ${MAX_BATCHES_PER_FRAME} bolt batches in a frame; the rest are skipped`,
        );
      }
      return;
    }

    const { queue } = this.surface.device;
    queue.writeBuffer(batch.fromBuffer, 0, batch.from, 0, verts * 3);
    queue.writeBuffer(batch.toBuffer, 0, batch.to, 0, verts * 3);
    queue.writeBuffer(batch.arcBuffer, 0, batch.arc, 0, verts * 4);

    const v = this.boltVertFloats;
    const atV = (name: string): number => (BOLT_VERT_FIELDS[name]?.offset ?? -4) / 4;
    mat4.multiply(this.correctedViewProj, CLIP_CORRECTION, camera.viewProjection);
    v.set(this.correctedViewProj, atV('uViewProj'));
    v.set(camera.position, atV('uCameraPos'));
    v[atV('uWidth')] = widthM;
    v[atV('uMinWidthPerMetre')] = minWidthPerMetre;

    const f = this.boltFragFloats;
    const i = this.boltFragInts;
    const atF = (name: string): number => (BOLT_FRAG_FIELDS[name]?.offset ?? -4) / 4;
    f[atF('uTime')] = timeSeconds;
    f.set(core, atF('uCoreColor'));
    f.set(edge, atF('uEdgeColor'));
    f[atF('uCoreGain')] = coreGain;
    f.set(camera.position, atF('uCameraPos'));
    /* The medium, through the same resolver every other pass here binds from. */
    const medium = resolveAtmosphere(
      env,
      camera.position[1] ?? 0,
      this.quality.underwaterAtmosphere,
      this.medium,
    );
    f.set(medium.fogColor, atF('uFogColor'));
    f[atF('uFogDensity')] = medium.fogDensity;
    f[atF('uFogHeightFalloff')] = medium.fogHeightFalloff;
    f[atF('uFogEyeY')] = medium.fogEyeY;
    f.set(medium.underwaterColor, atF('uUnderwaterColor'));
    f[atF('uUnderwaterFogDensity')] = medium.underwaterFogDensity;
    f[atF('uUnderwaterFactor')] = medium.underwaterFactor;
    i[atF('uFogMode')] = medium.fogMode;
    f[atF('uFogNear')] = medium.fogNear;
    f[atF('uFogFar')] = medium.fogFar;

    this.boltVerts.writeBlock(vertexSlot, this.boltVertBlock);
    this.boltFrags.writeBlock(fragmentSlot, this.boltFragInts);

    const boltPipe = boltPipeline(this.pipelines, this.surface.device, this.boltLayout);
    const boltCommand = this.recordDraw(0, this.currentTarget());
    if (boltCommand !== null) {
      boltCommand.pipeline = boltPipe;
      boltCommand.bindGroup = this.boltBindGroup;
      boltCommand.offsetA = vertexSlot;
      boltCommand.offsetB = fragmentSlot;
      boltCommand.offsetCount = 2;
      boltCommand.vertexBuffers[0] = batch.fromBuffer;
      boltCommand.vertexBuffers[1] = batch.toBuffer;
      boltCommand.vertexBuffers[2] = batch.corners;
      boltCommand.vertexBuffers[3] = batch.arcBuffer;
      boltCommand.vertexCount = 4;
      boltCommand.indexBuffer = batch.indices;
      boltCommand.indexed = true;
      boltCommand.count = count * 6;
    } else {
      const pass = this.openPass();
      if (pass === null) return;
      pass.setPipeline(boltPipe);
      pass.setBindGroup(0, this.boltBindGroup, [vertexSlot, fragmentSlot]);
      pass.setVertexBuffer(0, batch.fromBuffer);
      pass.setVertexBuffer(1, batch.toBuffer);
      pass.setVertexBuffer(2, batch.corners);
      pass.setVertexBuffer(3, batch.arcBuffer);
      pass.setIndexBuffer(batch.indices, 'uint32');
      pass.drawIndexed(count * 6);
    }
  }

  private readonly lineLayout: GPUBindGroupLayout;
  /** One slot per draw, not one block like `boltBindGroup` — see `linePass.ts`'s own comment. */
  private readonly lineVerts: UniformRing;
  private readonly lineFrags: UniformRing;
  private readonly lineBindGroup: GPUBindGroup;
  /** Said once rather than every frame, for the reason `warnedFull` gives. */
  private warnedLinesFull = false;

  /** Build a batch for a polyline. `capacity` is in segments, not points. See `boltPass.ts`'s
   * `createBolts` for the shape; a line's batch carries two dynamic streams instead of three. */
  createLines(segmentCapacity: number, label = 'lines'): GpuLines {
    return createGpuLines(this.surface.device, segmentCapacity, label);
  }

  disposeLines(lines: GpuLines): void {
    lines.dispose();
  }

  /**
   * Draw a polyline.
   *
   * The per-frame streams are expanded by `expandLineSegments` and written whole, the same
   * shape `drawBolts` uses for its own three. `uModel` is the one field `LINE_VERT` carries
   * that `BOLT_VERT` does not — see `linePass.ts`'s own comment for why: an arc has no model
   * transform and a line, usually attached to something that moves, does.
   *
   * Takes a slot from `lineVerts`/`lineFrags` rather than writing a single shared block —
   * `MAX_OVERLAYS` draws a frame, the same ceiling `drawSdfText` uses, because a caller drawing
   * more than one polyline a frame (several trails, a waveform split into pieces) is the normal
   * case here rather than the exception a single bolt pool is.
   *
   * **The uniforms are ringed; `lines.fromBuffer`/`.toBuffer` are not.** See `createLines`'s own
   * comment for the contract that protects them instead: this handle's geometry must not change
   * between two draws of it inside one frame, because these two buffers get exactly one write
   * each here, and a second write before the frame's command buffer submits silently replaces
   * the first for every draw already recorded against it.
   */
  drawLines(
    lines: GpuLines,
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
    if (!this.canDraw() || data.count === 0) return;
    const count = expandLineSegments(data, lines.capacity, lines.from, lines.to);
    if (count === 0) return;
    const verts = count * 4;

    const vertexSlot = this.lineVerts.allocate();
    const fragmentSlot = this.lineFrags.allocate();
    if (vertexSlot === null || fragmentSlot === null) {
      if (!this.warnedLinesFull) {
        this.warnedLinesFull = true;
        console.warn(
          `WebGPU: more than ${MAX_OVERLAYS} line draws in a frame; the rest are skipped`,
        );
      }
      return;
    }

    const { queue } = this.surface.device;
    queue.writeBuffer(lines.fromBuffer, 0, lines.from, 0, verts * 3);
    queue.writeBuffer(lines.toBuffer, 0, lines.to, 0, verts * 3);

    const atV = (name: string): number => LINE_VERT_FIELDS[name]?.offset ?? 0;
    mat4.multiply(this.correctedViewProj, CLIP_CORRECTION, camera.viewProjection);
    this.lineVerts.writeFloats(vertexSlot, atV('uViewProj'), this.correctedViewProj);
    this.lineVerts.writeFloats(vertexSlot, atV('uModel'), model as ArrayLike<number>);
    this.lineVerts.writeFloats(vertexSlot, atV('uCameraPos'), camera.position);
    this.lineVerts.writeFloat(vertexSlot, atV('uWidth'), widthM);
    this.lineVerts.writeFloat(vertexSlot, atV('uMinWidthPerMetre'), minWidthPerMetre);

    const atF = (name: string): number => LINE_FRAG_FIELDS[name]?.offset ?? 0;
    this.lineFrags.writeFloats(fragmentSlot, atF('uColor'), color);
    this.lineFrags.writeFloat(fragmentSlot, atF('uOpacity'), opacity);
    this.lineFrags.writeFloats(fragmentSlot, atF('uCameraPos'), camera.position);
    this.lineFrags.writeFloat(fragmentSlot, atF('uSoftness'), softness);
    this.lineFrags.writeInt(fragmentSlot, atF('uOutputTransform'), this.gradeCode());
    this.lineFrags.writeFloat(fragmentSlot, atF('uOutputExposure'), this.gradeExposure());
    /* The medium, through the same resolver every other pass here binds from. */
    const medium = resolveAtmosphere(
      env,
      camera.position[1] ?? 0,
      this.quality.underwaterAtmosphere,
      this.medium,
    );
    this.lineFrags.writeFloats(fragmentSlot, atF('uFogColor'), medium.fogColor);
    this.lineFrags.writeFloat(fragmentSlot, atF('uFogDensity'), medium.fogDensity);
    this.lineFrags.writeFloat(fragmentSlot, atF('uFogHeightFalloff'), medium.fogHeightFalloff);
    this.lineFrags.writeFloat(fragmentSlot, atF('uFogEyeY'), medium.fogEyeY);
    this.lineFrags.writeFloats(fragmentSlot, atF('uUnderwaterColor'), medium.underwaterColor);
    this.lineFrags.writeFloat(
      fragmentSlot,
      atF('uUnderwaterFogDensity'),
      medium.underwaterFogDensity,
    );
    this.lineFrags.writeFloat(fragmentSlot, atF('uUnderwaterFactor'), medium.underwaterFactor);
    this.lineFrags.writeInt(fragmentSlot, atF('uFogMode'), medium.fogMode);
    this.lineFrags.writeFloat(fragmentSlot, atF('uFogNear'), medium.fogNear);
    this.lineFrags.writeFloat(fragmentSlot, atF('uFogFar'), medium.fogFar);

    const linePipe = linePipeline(this.pipelines, this.surface.device, this.lineLayout, additive);
    /* Two uniform blocks and three vertex buffers, and no attachment among them. */
    const lineCommand = this.recordDraw(0, this.currentTarget());
    if (lineCommand !== null) {
      lineCommand.pipeline = linePipe;
      lineCommand.bindGroup = this.lineBindGroup;
      lineCommand.offsetA = vertexSlot;
      lineCommand.offsetB = fragmentSlot;
      lineCommand.offsetCount = 2;
      lineCommand.vertexBuffers[0] = lines.fromBuffer;
      lineCommand.vertexBuffers[1] = lines.toBuffer;
      lineCommand.vertexBuffers[2] = lines.corners;
      lineCommand.vertexCount = 3;
      lineCommand.indexBuffer = lines.indices;
      lineCommand.indexed = true;
      lineCommand.count = count * 6;
    } else {
      const pass = this.openPass();
      if (pass === null) return;
      pass.setPipeline(linePipe);
      pass.setBindGroup(0, this.lineBindGroup, [vertexSlot, fragmentSlot]);
      pass.setVertexBuffer(0, lines.fromBuffer);
      pass.setVertexBuffer(1, lines.toBuffer);
      pass.setVertexBuffer(2, lines.corners);
      pass.setIndexBuffer(lines.indices, 'uint32');
      pass.drawIndexed(count * 6);
    }
  }

  /* -- Particles ---------------------------------------------------------------------- */

  /** Built on first use per material, because the three fragment blocks are different sizes. */
  private readonly particleLayoutByMaterial = new Map<ParticleMaterial, ParticleLayout>();

  /* -- Plumes ------------------------------------------------------------------------- */

  private readonly plumeLayout: GPUBindGroupLayout;
  /** One slot per batch, because `sizePulse` and `windResponse` belong to the batch. */
  private readonly plumeVerts: UniformRing;
  private readonly plumeFrags: UniformRing;
  private readonly plumeBindGroup: GPUBindGroup;

  /* -- Water -------------------------------------------------------------------------- */

  private readonly waterLayout: GPUBindGroupLayout;
  /** The one-pixel stand-in, kept so the water bind group can be rebuilt without one. */
  private readonly blankView: GPUTextureView;
  private readonly blankSampler: GPUSampler;
  /**
   * A slot per body, not one buffer rewritten before each draw.
   *
   * **A frame draws more than one body of water.** A ditch at its own level, a basin in a
   * courtyard and the sea behind them are three draws off one pass, and from a single buffer the
   * last write won all three: every body then wore the last one's extents, level, colours and
   * direction. `UniformRing`'s header describes the hazard in general and `AGENTS.md` records it
   * on 2026-08-27 as a hard rule; water was the pass still holding it, and it was invisible for
   * as long as nothing drew two — the same reason a single character hid the joint palette's
   * copy of this for eight releases.
   */
  private readonly waterVerts: UniformRing;
  private readonly waterFrags: UniformRing;
  private readonly waterVertStaging = new ArrayBuffer(WATER_VERT_SIZE);
  private readonly waterVertFloats = new Float32Array(this.waterVertStaging);
  private readonly waterVertBlock = new Int32Array(this.waterVertStaging);
  private readonly waterFragStaging = new ArrayBuffer(WATER_FRAG_SIZE);
  private readonly waterFragFloats = new Float32Array(this.waterFragStaging);
  private readonly waterFragInts = new Int32Array(this.waterFragStaging);
  /** Said once when a frame asks for more bodies than the ring holds. */
  private warnedWaterFull = false;
  /**
   * Rebuilt whenever the reflection target is, because a bind group holds the *view* and a
   * resized target is a new texture. Not readonly for that reason alone.
   */
  private waterBindGroup: GPUBindGroup;
  /** Refilled per draw rather than allocated; see `createResolvedWater`. */
  private readonly resolvedWater: ResolvedWater = createResolvedWater();

  /* -- Scatter ------------------------------------------------------------------------ */

  private readonly scatterLayout: GPUBindGroupLayout;
  /** One slot per batch: the gust and the trample field belong to the batch, not the frame. */
  private readonly scatterVerts: UniformRing;
  private readonly scatterFragUniforms: GPUBuffer;
  private readonly scatterFragStaging = new ArrayBuffer(SCATTER_FRAG_SIZE);
  private readonly scatterFragFloats = new Float32Array(this.scatterFragStaging);
  private readonly scatterFragInts = new Int32Array(this.scatterFragStaging);
  private readonly scatterBindGroup: GPUBindGroup;
  private readonly scatterDepthLayout: GPUBindGroupLayout;
  /**
   * A slot per scatter draw, not one buffer rewritten before each of them.
   *
   * **The point light's bake is what makes this load-bearing.** Six cube faces are recorded on
   * one encoder and submitted once, so a `queue.writeBuffer` between two of them lands ahead of
   * all six — every scatter batch in every face then draws under the *last* face's
   * `uLightViewProj`. Five sixths of a field of grass therefore went into the octahedral map at
   * directions the grass does not occupy, and what the shader read back out of them is an
   * occluder standing beside a lamp with nothing above it. The reported symptom was a
   * hard-edged patch of shadow near a brazier, on this backend only, gone the moment lamp
   * shadows were switched off — the other backend sets a uniform and draws, in that order,
   * so it never had it.
   *
   * `UniformRing`'s own header describes this failure in general and `scatterVerts` already
   * carried the fix for the *visible* scatter pass; only the depth half was left behind.
   */
  private readonly scatterDepthDraws: UniformRing;
  private readonly scatterDepthStaging = new ArrayBuffer(SCATTER_DEPTH_SIZE);
  private readonly scatterDepthFloats = new Float32Array(this.scatterDepthStaging);
  /** The same bytes as an integer view, so a whole block copies into a slot bit for bit. */
  private readonly scatterDepthBlock = new Int32Array(this.scatterDepthStaging);
  private readonly scatterDepthBindGroup: GPUBindGroup;
  /** Refilled per draw rather than allocated; see `createScatterDeform`. */
  private readonly deform: ScatterDeform = createScatterDeform();

  /**
   * The frame's wind, as the mesh and depth programs read it.
   *
   * A second target from `deform` above and one conversion between them, for the reason the
   * WebGL2 backend gives at the same field: the scatter batch takes its wind as arguments to its
   * own draw call and cannot share a target without that signature changing, but both go through
   * `resolveScatterDeform`, which is where every number is actually decided.
   */
  private readonly frameWind: ScatterDeform = createScatterDeform();

  /**
   * The frame's wind, sampled once by the caller and handed down.
   *
   * Every mesh carrying a per-vertex channel bends to this, in the colour pass and in the depth
   * pass, so a canopy and its own shadow move together. A caller that never calls it gets a still
   * world, which is what every scene drew before the channel existed.
   */
  setWind(windX: number, windZ: number, windGust: number, timeSeconds: number): void {
    resolveScatterDeform(windX, windZ, windGust, timeSeconds, null, this.frameWind);
  }

  /**
   * The five wind fields of one shadow-draw slot.
   *
   * The rigid and skinned depth variants declare these; the instanced one does not, and nothing
   * writes this for it. A canopy that bends in the picture and stands still in the shadow map
   * slides its shade off the ground, which is the defect scatter.ts records having fixed between
   * its own two programs.
   */
  private writeShadowWind(slot: number): void {
    const d = this.frameWind;
    this.shadowDraws.writeFloats(slot, DEPTH_VERT_FIELDS.uWindDirection.offset, d.direction);
    this.shadowDraws.writeFloat(slot, DEPTH_VERT_FIELDS.uWindSpeed.offset, d.bend);
    this.shadowDraws.writeFloat(slot, DEPTH_VERT_FIELDS.uWindGust.offset, d.gust);
    this.shadowDraws.writeFloat(slot, DEPTH_VERT_FIELDS.uWindTime.offset, d.time);
    this.shadowDraws.writeFloats(slot, DEPTH_VERT_FIELDS.uWindSpatialPhase.offset, d.spatialPhase);
  }

  /**
   * The five wind fields of one per-draw slot.
   *
   * **Never called for an instanced draw.** That variant declares none of these, and
   * `flatPass.ts` records what writing a field a variant does not declare costs: the block is
   * shorter, so the write lands on whatever occupies that offset instead.
   */
  private writeWind(slot: number): void {
    const d = this.frameWind;
    this.perDraw.writeFloats(slot, FLAT_VERT_FIELDS.uWindDirection.offset, d.direction);
    this.perDraw.writeFloat(slot, FLAT_VERT_FIELDS.uWindSpeed.offset, d.bend);
    this.perDraw.writeFloat(slot, FLAT_VERT_FIELDS.uWindGust.offset, d.gust);
    this.perDraw.writeFloat(slot, FLAT_VERT_FIELDS.uWindTime.offset, d.time);
    this.perDraw.writeFloats(slot, FLAT_VERT_FIELDS.uWindSpatialPhase.offset, d.spatialPhase);
  }

  /** Refilled per frame rather than allocated; see `resolvePointLights`. */
  private readonly lights: ResolvedPointLights = {
    count: 0,
    falloff: 0,
    positions: new Float32Array(0),
    colors: new Float32Array(0),
    radii: new Float32Array(0),
    sourceRadii: new Float32Array(0),
    weights: new Float32Array(0),
    directions: new Float32Array(0),
    coneCos: new Float32Array(0),
    iesProfiles: new Float32Array(0),
    iesAxes: new Float32Array(0),
    cookies: new Float32Array(0),
  };
  /** Refilled per frame rather than allocated; see `resolveAtmosphere`. */
  private readonly medium: ResolvedAtmosphere = {
    fogColor: new Float32Array(3),
    underwaterColor: new Float32Array(3),
    fogDensity: 0,
    fogHeightFalloff: 0,
    fogEyeY: 0,
    fogMode: 0,
    fogNear: 0,
    fogFar: 1,
    underwaterFogDensity: 0,
    underwaterFactor: 0,
  };
  /* -- Overlays: panels and text ------------------------------------------------------ */

  private readonly panelLayout: GPUBindGroupLayout;
  private readonly panelCorners: GPUBuffer;
  private readonly panelVerts: UniformRing;
  private readonly panelFrags: UniformRing;
  private readonly panelBindGroup: GPUBindGroup;

  private readonly textLayout: GPUBindGroupLayout;
  private readonly textCube: GpuTextCube;
  private readonly textVerts: UniformRing;
  private readonly textFrags: UniformRing;
  private readonly textBindGroup: GPUBindGroup;

  /**
   * SDF text, world geometry rather than an overlay — see `drawSdfText`.
   *
   * **A bind group per atlas, cached, matching `flatBindGroups`' own reasoning.** A scene
   * reuses one font's atlas across every label built from it, so building a fresh bind group
   * per draw would be exactly the per-frame allocation `AGENTS.md` forbids for the common case
   * of two labels sharing a font.
   */
  private readonly sdfTextLayout: GPUBindGroupLayout;
  private readonly sdfTextVerts: UniformRing;
  private readonly sdfTextFrags: UniformRing;
  private readonly sdfTextBindGroups = new Map<GpuSurfaceTexture, GPUBindGroup>();

  /* -- The shadow pass -------------------------------------------------------------- */

  private readonly shadowMap: GPUTexture;
  private readonly shadowView: GPUTextureView;
  private readonly shadowLayout: GPUBindGroupLayout;
  /** The same layout plus the joint palette. See `createDepthBindGroupLayout`. */
  private readonly shadowSkinnedLayout: GPUBindGroupLayout;
  /**
   * The skinned shadow bind groups, one per palette slot, cached against what can invalidate them.
   *
   * The same argument `flatBindGroupFor` makes, and per slot for the same reason: the group it was
   * built beside, and the palette view, which now differs between two characters casting into one
   * bake. Comparing object identity makes a missed invalidation impossible rather than unlikely.
   */
  private readonly shadowSkinnedGroups: (GPUBindGroup | null)[] = [];
  private readonly shadowSkinnedGroupsBeside: (GPUBindGroup | null)[] = [];
  private readonly shadowSkinnedGroupsPalette: (GPUTextureView | null)[] = [];
  /** Held from construction so the skinned group can be rebuilt without them being threaded. */
  private shadowBlankView: GPUTextureView | null = null;
  private shadowBlankSampler: GPUSampler | null = null;
  private shadowPassUniforms: GPUBuffer | null = null;
  private readonly shadowBindGroup: GPUBindGroup;
  /**
   * The second static layer, or null where the profile asks for one depth layer.
   *
   * Null on the same condition `renderer.ts` builds its `peeledShadowMap` on — one decision,
   * read twice — so a profile that switches peeling off gets no map and no pass on either
   * backend rather than a map nothing writes.
   */
  private readonly peelMap: GPUTexture | null;
  private readonly peelView: GPUTextureView | null;
  /**
   * The movers' own layer: the character, the rope it swings on, and anything else that walks.
   *
   * **Its own map rather than more geometry in the static one**, which is the decision
   * `renderer.ts` made and states: where a moving and a static caster overlap, two independent
   * layers keep each one's own distance fade and multiply their transmissions, where a single
   * depth buffer would keep whichever is nearer and throw the other away. It is also what lets
   * the static layer be drawn from geometry that does not change while this one is redrawn per
   * frame.
   *
   * Null on the same condition `renderer.ts` builds its `dynamicShadowMap` on — directional
   * shadows at all — so one decision is read twice rather than restated.
   *
   * **This backend had no such map and `beginShadowPass('dynamic')` returned false**, so every
   * mover's shadow was silently absent while every static one was drawn. Reported from a consumer
   * exactly that way: *"sun shadow works for other than the character itself"*. It degraded
   * honestly — `uDynamicShadowMap` resolved to the white stand-in, which reads as the far plane
   * and therefore as lit — so nothing looked broken, only empty, which is why it survived the
   * port and every gate in it.
   */
  private readonly dynamicMap: GPUTexture | null;
  private readonly dynamicView: GPUTextureView | null;
  /** The peel's own bind groups: `uPeelShadowLayer` at 1, and the static map to peel against. */
  private readonly shadowPeelBindGroup: GPUBindGroup | null;
  private readonly scatterDepthPeelBindGroup: GPUBindGroup | null;
  /** Which layer the open pass is writing, so the sink picks the bindings that match it. */
  private shadowLayerIsPeel = false;
  /**
   * Whether a peel pass has filled the map, which is what the frame may sample it on.
   *
   * **Not whether the map exists.** `renderer.ts` can ask that question because a GL texture is
   * born cleared; a WebGPU texture no pass has written holds undefined contents, so a scene
   * that builds a peel map and never opens the layer would sample garbage. Cleared when the
   * static layer opens and set when a peel pass ends, which is per frame because both demo
   * scenes that peel do so every frame.
   */
  private peelFilled = false;
  /** One slot per caster, the same trick `perDraw` uses and for the same reason. */
  private readonly shadowDraws: UniformRing;
  private shadowEncoder: GPUCommandEncoder | null = null;
  private shadowPass: GPURenderPassEncoder | null = null;
  /**
   * Which faces the depth pass culls, because the two shadow passes want different answers.
   *
   * The directional map culls `back`, matching the frame. A cubemap face culls nothing, and
   * `pointShadowMap.ts` gives the reason: back faces only stores the far side of every caster,
   * and for a character's limbs the two sides are centimetres apart, so the caster effectively
   * vanishes from the map. It is on the key as well as on the pipeline, or the second pass
   * would get the first one's.
   */
  private depthCullMode: GPUCullMode = 'back';
  /**
   * The light's matrix under `SHADOW_CLIP_CORRECTION`, once per pass rather than once per
   * caster. Depth remapped to [0, 1]; **Y deliberately not flipped** — see that constant for
   * the texel-for-texel comparison that settled it.
   */
  private readonly correctedLightViewProj = new Float32Array(16);
  /**
   * The same matrix *uncorrected*, which is what the flat shader must project with.
   *
   * **The two differ on purpose and getting it wrong mirrors every shadow**, which is not a
   * figure of speech: it happened, and the two maps were measured as exact mirrors. The lookup
   * in `flat.ts` is `p = p * 0.5 + 0.5` on all three axes, the OpenGL convention, and it
   * expects `vLightPos` in GL clip space.
   *
   * The map is rendered with the depth half of the correction and not the Y half, and the
   * depth halves are what make the pair agree: the render stores 0.5·z + 0.5 and the lookup
   * computes 0.5·z + 0.5, so a receiver and its occluder are on one scale.
   */
  private readonly lightViewProj = new Float32Array(16);

  /**
   * The bindings for the layer currently open — the peel's where one is, the static pass's
   * otherwise. A lookup rather than a rebind, because a `createBindGroup` per draw is the
   * per-frame allocation the house rules forbid; both groups are built once at init.
   */
  private shadowGroup(): GPUBindGroup {
    return this.shadowLayerIsPeel && this.shadowPeelBindGroup !== null
      ? this.shadowPeelBindGroup
      : this.shadowBindGroup;
  }

  /**
   * The skinned shadow bind group for the current layer, rebuilt only when it must be.
   *
   * **The peel layer is not served here and casts rigidly**, deliberately: the peel exists so a
   * second independently fading occluder can be recorded, and a character is not one — it is the
   * thing in front. Serving it would mean a second cached group for a case nothing produces.
   */
  private shadowSkinnedGroup(palette: GPUTextureView, at: number): GPUBindGroup {
    const beside = this.shadowBindGroup;
    if (
      (this.shadowSkinnedGroups[at] ?? null) === null ||
      this.shadowSkinnedGroupsBeside[at] !== beside ||
      this.shadowSkinnedGroupsPalette[at] !== palette
    ) {
      this.shadowSkinnedGroups[at] = createDepthBindGroup(
        this.surface.device,
        this.shadowSkinnedLayout,
        this.shadowDraws.buffer,
        this.shadowPassUniforms as GPUBuffer,
        this.shadowBlankView as GPUTextureView,
        this.shadowBlankSampler as GPUSampler,
        palette,
      );
      this.shadowSkinnedGroupsBeside[at] = beside;
      this.shadowSkinnedGroupsPalette[at] = palette;
    }
    return this.shadowSkinnedGroups[at] as GPUBindGroup;
  }

  private scatterDepthGroup(): GPUBindGroup {
    return this.shadowLayerIsPeel && this.scatterDepthPeelBindGroup !== null
      ? this.scatterDepthPeelBindGroup
      : this.scatterDepthBindGroup;
  }

  /**
   * Where a caster is drawn from, given to `drawShadowCasters` as the engine's own sink.
   *
   * Built once and held, rather than made per call: it closes over `this` and a fresh one
   * every frame would be an allocation in a per-frame path.
   */
  private readonly casterSink: ShadowCasterSink = {
    mesh: (mesh, model) => {
      const pass = this.shadowPass;
      if (pass === null) return;
      const slot = this.shadowDraws.allocate();
      if (slot === null) return;

      this.shadowDraws.writeFloats(
        slot,
        DEPTH_VERT_FIELDS.uLightViewProj.offset,
        this.correctedLightViewProj,
      );
      this.shadowDraws.writeFloats(slot, DEPTH_VERT_FIELDS.uModel.offset, model as Float32Array);
      this.writeShadowWind(slot);

      const geometry = mesh as GpuMesh & { key?: string };
      if (geometry.vertexBuffers === undefined) return;
      pass.setPipeline(
        depthPipeline(
          this.pipelines,
          this.surface.device,
          this.shadowLayout,
          `depth|${this.depthCullMode}|${geometry.key ?? ''}`,
          this.presentOf(geometry),
          this.depthCullMode,
        ),
      );
      pass.setBindGroup(0, this.shadowGroup(), [slot]);
      for (let index = 0; index < geometry.vertexBuffers.length; index++) {
        pass.setVertexBuffer(index, geometry.vertexBuffers[index] as GPUBuffer);
      }
      pass.setIndexBuffer(geometry.indexBuffer, 'uint32');
      pass.drawIndexed(geometry.indexCount);
    },
    /**
     * A batch of rigid meshes into the depth map, placed by the same matrices the visible draw
     * uses — one draw, however many instances, exactly as the colour pass does it.
     */
    instanced: (batch, data) => {
      const pass = this.shadowPass;
      if (pass === null) return;
      const gpuBatch = batch as GpuInstancedBatch;
      const geometry = gpuBatch.mesh as GpuMesh & { key?: string };
      if (geometry.vertexBuffers === undefined) return;
      const count = Math.min(data.count, gpuBatch.capacity);
      if (count === 0) return;

      const slot = this.shadowDraws.allocate();
      if (slot === null) return;
      /* Only the light matrix: the instanced depth variant has no uModel, its placement being
         the four attribute columns the batch's buffer supplies. */
      this.shadowDraws.writeFloats(
        slot,
        DEPTH_VERT_FIELDS.uLightViewProj.offset,
        this.correctedLightViewProj,
      );

      pass.setPipeline(
        depthPipeline(
          this.pipelines,
          this.surface.device,
          this.shadowLayout,
          `depth-instanced|${this.depthCullMode}|${geometry.key ?? ''}`,
          this.presentOf(geometry),
          this.depthCullMode,
          false,
          true,
        ),
      );
      pass.setBindGroup(0, this.shadowGroup(), [slot]);
      let index = 0;
      for (; index < geometry.vertexBuffers.length; index++) {
        pass.setVertexBuffer(index, geometry.vertexBuffers[index] as GPUBuffer);
      }
      pass.setVertexBuffer(index, gpuBatch.buffer);
      pass.setIndexBuffer(geometry.indexBuffer, 'uint32');
      pass.drawIndexed(geometry.indexCount, count);
    },
    skinnedMesh: (mesh, model, palette) => {
      const pass = this.shadowPass;
      if (pass === null) return;
      /* Its own slot, so two characters casting into one bake do not both take the second one's
         pose — the bake's encoder is submitted after every upload it contains, exactly like the
         frame's. See `SkinPaletteRing`. */
      const paletteSlot = this.skinPalettes.take(this.surface.device, palette);
      const view = paletteSlot === null ? null : this.skinPalettes.view(paletteSlot);
      /* No palette texture means no skinning is possible; casting rigidly here would put a
         bind pose in the map, which is the failure this verb exists to prevent. Skipping
         leaves the character shadowless for a frame, which is the smaller wrong. */
      if (view === null || paletteSlot === null) return;

      const slot = this.shadowDraws.allocate();
      if (slot === null) return;
      this.shadowDraws.writeFloats(
        slot,
        DEPTH_VERT_FIELDS.uLightViewProj.offset,
        this.correctedLightViewProj,
      );
      this.shadowDraws.writeFloats(slot, DEPTH_VERT_FIELDS.uModel.offset, model as Float32Array);
      this.writeShadowWind(slot);

      const geometry = mesh as GpuMesh & { key?: string };
      if (geometry.vertexBuffers === undefined) return;
      pass.setPipeline(
        depthPipeline(
          this.pipelines,
          this.surface.device,
          this.shadowSkinnedLayout,
          `depth-skinned|${this.depthCullMode}|${geometry.key ?? ''}`,
          this.presentOf(geometry),
          this.depthCullMode,
          true,
        ),
      );
      pass.setBindGroup(0, this.shadowSkinnedGroup(view, paletteSlot), [slot]);
      for (let index = 0; index < geometry.vertexBuffers.length; index++) {
        pass.setVertexBuffer(index, geometry.vertexBuffers[index] as GPUBuffer);
      }
      pass.setIndexBuffer(geometry.indexBuffer, 'uint32');
      pass.drawIndexed(geometry.indexCount);
    },
    /**
     * A field of grass into the depth map, bent by the same gust that bends the visible one.
     *
     * The gust arrives as arguments rather than being looked up, which is `ShadowCasterSink`'s
     * own design and the reason it can be honoured: handing the depth pass a different wind
     * from the colour pass is how a shadow comes loose from its caster.
     */
    scatter: (scatter, data, windX, windZ, windGust, timeSeconds, trample = null) => {
      const pass = this.shadowPass;
      if (pass === null || data.count === 0) return;
      const geometry = scatter as GpuScatter;
      if (geometry.vertexBuffers === undefined) return;

      const v = this.scatterDepthFloats;
      const at = (name: string): number => (SCATTER_DEPTH_FIELDS[name]?.offset ?? -4) / 4;
      v.set(this.correctedLightViewProj, at('uLightViewProj'));
      const d = resolveScatterDeform(windX, windZ, windGust, timeSeconds, trample, this.deform);
      v.set(d.direction, at('uWindDirection'));
      v[at('uWindSpeed')] = d.bend;
      v[at('uWindGust')] = d.gust;
      v[at('uWindTime')] = d.time;
      v.set(d.spatialPhase, at('uWindSpatialPhase'));
      v[at('uTrampleRadius')] = d.trampleRadius;
      v[at('uTrampleDepth')] = d.trampleDepth;
      scatterInto(v, SCATTER_DEPTH_FIELDS['uTrample'], d.trample, 4);
      /* Into this draw's own slot, uploaded once before the encoder is submitted. A write here
         would reach every face of the bake instead of this one; see the ring's declaration. */
      const slot = this.scatterDepthDraws.allocate();
      if (slot === null) {
        if (!this.warnedScatterDepthFull) {
          this.warnedScatterDepthFull = true;
          console.warn(
            `WebGPU: more than ${MAX_SCATTER_DEPTH_DRAWS} scatter batches in one shadow round; ` +
              'the rest cast no shadow this round.',
          );
        }
        return;
      }
      this.scatterDepthDraws.writeBlock(slot, this.scatterDepthBlock);

      pass.setPipeline(
        scatterDepthPipeline(
          this.pipelines,
          this.surface.device,
          this.scatterDepthLayout,
          SHADOW_FORMAT,
          DEPTH_FRAG_WGSL,
        ),
      );
      pass.setBindGroup(0, this.scatterDepthGroup(), [slot]);
      for (let index = 0; index < geometry.vertexBuffers.length; index++) {
        pass.setVertexBuffer(index, geometry.vertexBuffers[index] as GPUBuffer);
      }
      pass.setIndexBuffer(geometry.indexBuffer, 'uint32');
      pass.drawIndexed(geometry.indexCount, data.count);
    },
  };

  /** Said once rather than every frame, because a full ring is a flood otherwise. */
  private warnedFull = false;
  /** The same, for the shadow round's scatter ring. See `scatterDepthDraws`. */
  private warnedScatterDepthFull = false;
  /** The density ceiling a governor has asked for, applied on the next resize. */
  private scale = 1;

  /** The density ceiling in effect, matching the WebGL2 renderer's accessor. */
  get resolutionScale(): number {
    return this.scale;
  }

  /**
   * Side of the directional shadow map, in texels.
   *
   * **A scene divides by this, so its absence is not an absence — it is a NaN.** Every caller
   * reaches `computeLightMatrix`, which computes `texelWorldSize = radius * 2 / shadowMapSize`
   * to snap the light frustum to the texel grid. `undefined` there makes the snap NaN, and the
   * NaN reaches all sixteen entries of the light matrix through `mat4.ortho`.
   *
   * That is what "the whole scene comes out uniformly occluded" was. Both halves of the shadow
   * path were poisoned by it and neither of them was wrong: the depth pass drew a caster whose
   * every vertex was NaN, so nothing rasterised and the map stayed at its clear value — read
   * back on hardware as 4,194,304 texels of exactly 1.0 — while the flat pass projected the
   * receiver with the same NaN, and `shadowFactor` compares with `<=`, which is false against
   * a NaN, so every fragment fell past the four early returns into the filter loop and out of
   * it as NaN.
   *
   * **It was diagnosed as the shadow *sample* returning a constant, and that was wrong.** The
   * evidence was that substituting the clip-corrected light matrix for the uncorrected one
   * changed not one pixel, which looked like proof the lookup ignored its projection. Both
   * matrices were NaN; a correction applied to a NaN is a NaN, so the test could not have
   * distinguished them.
   *
   * **The general hazard, which is worth more than this accessor.** A missing *method* on this
   * class throws — `renderer.createMesh is not a function` is how the backend announced itself
   * reaching a browser at all. A missing *property* returns `undefined`, and `undefined` in
   * arithmetic is a picture rather than an error. The rest of that group is below, and they
   * are grouped deliberately: the hazard is the class, not this one member of it.
   */
  get shadowMapSize(): number {
    return this.quality.directionalShadowMapSize;
  }

  /*
   * ---------------------------------------------------------------------------------------
   * The rest of the quiet ones.
   *
   * Every member here is a value rather than a method, which is exactly what makes them
   * dangerous to omit: a scene calling a missing method gets a `TypeError` naming it, and a
   * scene reading a missing property gets `undefined` and carries on into arithmetic. That
   * cost two bugs on this branch before anybody looked at the list — see `shadowMapSize`.
   *
   * Each answers the same question `renderer.ts` answers, from the same source where there is
   * one, and says so where there is not.
   * ---------------------------------------------------------------------------------------
   */

  /** Viewport in CSS pixels, which is what a screen-space overlay lays out against. */
  get cssWidth(): number {
    return this.surface.canvas.clientWidth;
  }

  get cssHeight(): number {
    return this.surface.canvas.clientHeight;
  }

  /** Drawing-buffer aspect, guarded against a zero-height canvas exactly as WebGL2 guards it. */
  get aspect(): number {
    const { canvas } = this.surface;
    return canvas.width / Math.max(canvas.height, 1);
  }

  /** The canvas being drawn into, for a consumer that needs to measure or place against it. */
  get canvas(): HTMLCanvasElement {
    return this.surface.canvas;
  }

  /**
   * The size the world is drawn at this frame, which is **not** the canvas when a reconstruction
   * is enlarging it.
   *
   * **A contributed pass that fills a target of its own must size it from here.** The GPU-driven
   * rig sized its own targets from `canvas.width` and drew a full drawing-buffer picture into a
   * scene target two thirds as wide: the frame pass clipped it to the top-left corner and the
   * composite magnified that corner back over the screen, which is a plausible-looking picture of
   * the wrong part of the world. The device raises nothing — a viewport smaller than the thing
   * drawn is legal — so there is no failure to see, only a scene that has moved.
   *
   * Valid from `beginFrame`; before the first frame it is the canvas, which is what a pass sizing
   * itself at registration wants.
   */
  get sceneWidth(): number {
    return this.sceneSize().width;
  }

  get sceneHeight(): number {
    return this.sceneSize().height;
  }

  /**
   * The render size this frame will use, computed rather than remembered.
   *
   * **Computed, because a pass asks before the frame it is asking about.** `GpuDrivenPass.resize`
   * runs before `beginFrame` — that is when `prepare` records the pipeline — so a stored field
   * would answer with the previous frame's size, which is right every frame but the one where it
   * changed. The first frame after a reconstruction is switched on is exactly the frame that
   * matters.
   */
  private sceneSize(): { width: number; height: number } {
    const { canvas } = this.surface;
    return this.reconstructionWanted
      ? reconRenderSize(canvas.width, canvas.height, this.quality.reconstruction)
      : { width: Math.max(1, canvas.width), height: Math.max(1, canvas.height) };
  }

  /**
   * Whether the device has gone.
   *
   * Named for the WebGL concept because that is what the shared surface calls it, and the two
   * failures are the same event to a consumer: `device.lost` here, `webglcontextlost` there.
   * `device.ts` already absorbed the difference in shape.
   */
  get contextLost(): boolean {
    return this.surface.lost;
  }

  /**
   * Whether a part this backend recognises as weak had its pixel terms lowered at construction.
   *
   * **This used to be a hardcoded `false`**, because `rendererName` was the literal string
   * `WebGPU` and `isWeakGpuFamily` had nothing to match — so the clamp that rescued an
   * Adreno 619 on WebGL2 was dead on the backend that replaced it, and `capabilityClamp: true`
   * from a consumer silently did nothing. `select.ts` now builds the name from `adapter.info`,
   * so the same predicate over the same table answers on both backends.
   *
   * Only the pixel terms move, exactly as in `renderer.ts`: the shadow and water switches are
   * what a preset *means*, and drawing a different scene than the settings screen describes is
   * worse than drawing the right one at fewer pixels.
   */
  readonly capabilityClamped: boolean;

  /** Zero until row 3 ports the point-shadow cube maps, and zero is what WebGL2 reports then too. */
  get sampledShadowLights(): number {
    return 0;
  }

  /**
   * The full budget, always, and that is a fact about the backend rather than a stub.
   *
   * WebGL2 sizes these arrays to what the part's fragment uniform grid will hold — see
   * `uniformVectorBudget.ts` — because a shader declaring more rows than the device offers does
   * not link. WebGPU has no such ceiling to be short of: the lit block is about 7 KB against a
   * guaranteed 64 KB binding size, and the generated WGSL is built and committed at the full
   * budget either way. So a consumer who lowered `maxLights` for a phone's WebGL2 path and lands
   * on WebGPU gets all sixteen, which is the better picture and one this device can afford.
   */
  get shadedLights(): number {
    return FULL_LIGHT_BUDGET.maxLights;
  }

  /** All four, for the reason `shadedLights` gives. */
  get shadedAreaLights(): number {
    return FULL_LIGHT_BUDGET.maxAreaLights;
  }

  /**
   * **True from the first presented frame, which is weaker than what WebGL2 means by it.**
   *
   * There it is a fence: `clientWaitSync` on the first frame's commands, so it turns true when
   * the driver has actually finished the first frame's compiles and uploads, which is what a
   * loading screen wants to wait for. The equivalent here is `onSubmittedWorkDone`, and wiring
   * it is row 24's business alongside the timestamp queries.
   *
   * Reported as "a frame has been presented" until then. A consumer polling this gets a true
   * that is early rather than one that never arrives, and early is the failure that shows a
   * loading screen dismissed a little too soon rather than one that hangs forever.
   */
  get firstFrameSettled(): boolean {
    return this.presentedAnyFrame;
  }

  private presentedAnyFrame = false;

  /** Whether the loss below has already been said. Said once, never once per frame. */
  private reportedLost = false;

  /**
   * Say, exactly once, that this renderer is drawing nothing and why.
   *
   * **A lost device is silent here, and that silence is the defect.** Every entry point guards
   * on `surface.lost` and returns, so a frame loop goes on calling forty of them at full rate
   * and produces a black canvas with no error, no exception and no warning. A host that is not
   * already listening to `onContextLost` has no way to tell that apart from a rendering bug —
   * which is what happened: a demos page showed a black frame indefinitely and reported it as a
   * broken renderer.
   *
   * WebGPU cannot restore a device, only replace one, so the recovery is a consumer's to
   * perform. This makes sure the consumer at least knows there is something to recover from,
   * and names the call that does it.
   */
  private reportLostOnce(): void {
    if (this.reportedLost) return;
    this.reportedLost = true;
    console.error(
      '[driftengine] the GPU device was lost, so nothing is being drawn. A WebGPU device ' +
        'cannot be restored, only replaced: build a new renderer with `createRenderer` on the ' +
        'same canvas, which acquires a fresh device. Listen to `Renderer.onContextLost` to be ' +
        'told at the moment it happens rather than at the next frame.',
    );
  }

  /**
   * The colour this frame clears to, held until the frame's pass is actually opened.
   *
   * A preallocated tuple rather than the caller's, because `beginFrame` runs every frame and
   * keeping a reference to a consumer's array would let them mutate it under us.
   */
  private readonly pendingClearColor: Vec3 = [0, 0, 0];
  /** What `beginPlanarReflection` was asked to clear the mirror to, held until it opens. */
  private readonly mirrorClearColor: Vec3 = [0, 0, 0];
  /** Whether the frame's pass still owes its clear. False from the first open onwards. */

  constructor(
    surface: GpuSurface,
    quality: Readonly<RenderQuality> = resolveRenderQuality({}),
    rendererName = 'WebGPU',
  ) {
    this.surface = surface;
    this.rendererName = rendererName;
    this.capabilityClamped = quality.capabilityClamp && isWeakGpuFamily(rendererName);
    this.quality = this.capabilityClamped
      ? {
          ...quality,
          maxDevicePixelRatio: Math.min(quality.maxDevicePixelRatio, 1),
          waterReflectionScale: Math.min(quality.waterReflectionScale, 0.5),
          globalMediumSteps: Math.min(quality.globalMediumSteps, WEAK_GPU_MEDIUM_STEPS),
        }
      : quality;
    quality = this.quality;
    this.maxDrawingBufferPixels = quality.maxDrawingBufferPixels;
    this.exposure = quality.outputExposure;
    this.flushSchedule =
      quality.frameGraph && quality.identifierGraph
        ? createFlushSchedule(MAX_DRAWS_PER_FRAME)
        : null;

    const { device } = surface;
    /* Off unless a consumer asked: see `RenderQuality.gpuTiming`. A timer that can
       invalidate a command buffer must not be something everybody pays for. */
    this.gpuTimer = new GpuTimestamps(device, quality.gpuTiming);
    /*
     * **One decision, read by three things**: the shader variant, the cube's allocation and the
     * uniform guard. Computing it at each of them is how the variant ended up without the probe
     * while the cube existed, so `bindMeshPass` wrote a field the compiled block did not have
     * and threw in the frame loop.
     */
    this.probeEnabled =
      quality.environmentReflections &&
      quality.reflectionProbeSize > 0 &&
      probeFits(surface.device);
    this.samples = supportedSampleCount(quality.sceneSamples);
    /* The same sentence `renderer.ts` says, from the same place, so a profile that cannot mean
       what it says is told so whichever backend it lands on. There is no third branch here:
       WebGL2 also checks `EXT_color_buffer_float`, and a WebGPU device that offered
       `rgba16float` cannot then decline to render to it. */
    const bloomWarning = bloomProfileWarning(quality);
    if (bloomWarning !== null) console.warn(`[driftengine] ${bloomWarning}`);
    /*
     * **One format for everywhere the world lands, and it is not the swap chain's.**
     *
     * A pipeline's colour target must equal its attachment's format exactly, and WebGPU raises
     * the disagreement at `finish` rather than at the draw — so the whole command buffer is
     * invalidated and the frame is dropped entire, with an empty canvas and nothing to say why.
     * Under a composite the world does not reach the swap chain at all; it lands in
     * `post.sceneColor`, and that is `rgba16float` where the profile keeps range.
     *
     * This was `surface.format` and the two agreed only by coincidence: this machine's
     * `getPreferredCanvasFormat()` is `rgba8unorm`, which is exactly the non-HDR scene target —
     * measured. So `hdrScene` read as a broken effect here while every `bgra8unorm` device drew
     * nothing at all under the default profile, which is on. The cache carries it for the same
     * reason it carries the sample count: no pass can then disagree with the attachment.
     */
    this.pipelines = new PipelineCache(
      device,
      quality.screenEffects ? sceneColorFormat(quality.hdrScene) : surface.format,
      this.samples,
    );
    /*
     * The canvas' own state, for the pass `ensurePass` reopens after `endFrame`.
     *
     * One sample and the surface format, always, because that is what a swap-chain texture is —
     * neither is a choice this makes. Aliased to the cache above when the world already lands on
     * exactly that, so the ordinary profile builds each pipeline once and the two names are the
     * one object. See the field.
     */
    this.overlayPipelines =
      this.pipelines.format === surface.format && this.samples === 1
        ? this.pipelines
        : new PipelineCache(device, surface.format, 1);
    this.pipelineTargets =
      this.overlayPipelines === this.pipelines
        ? [this.pipelines]
        : [this.pipelines, this.overlayPipelines];
    this.variant = flatVariant({
      directionalShadows: quality.directionalShadows,
      /* No `bakeReflectionProbe` here; see the field. */
      /*
       * On when the profile asked for a probe **and the device has binding room for it**.
       *
       * The widest permutation declares seventeen samplers and this adapter offers sixteen —
       * measured, on a current AMD part — so the probe is the one that gives way. It is the
       * feature `reflectionProbe.ts` already calls an improvement to an appearance rather than
       * a requirement: without it a reflective surface keeps the sky-and-ground gradient
       * `flat.ts` had before probes existed, and everything else is unaffected.
       *
       * Said out loud, because a scene that asked for a probe and silently did not get one is
       * the exact shape of failure this backend keeps being bitten by.
       */
      environmentProbe: this.probeEnabled,
      nightEmissive: quality.nightEmissive,
      pointShadows: quality.pointShadows,
    });
    this.pointShadowsCompiled = quality.pointShadows;
    this.fragment = flatFragmentBindings(this.variant);
    this.bindGroupLayout = createFlatBindGroupLayout(device, this.variant);
    /*
     * The skinned twin, built eagerly because it is a descriptor rather than a compile — WebGPU
     * builds no shader here — and because a layout created lazily mid-frame would have to be
     * threaded through the bind-group cache below at the moment it is least safe to.
     */
    this.skinnedBindGroupLayout = createFlatBindGroupLayout(device, this.variant, true);
    this.morphedBindGroupLayout = createFlatBindGroupLayout(device, this.variant, false, true);
    this.bothBindGroupLayout = createFlatBindGroupLayout(device, this.variant, true, true);
    this.perDraw = new UniformRing(
      device,
      FLAT_VERT_SIZE,
      MAX_DRAWS_PER_FRAME,
      USAGE_UNIFORM_DST,
      'flat.vertRing',
      this.drawBudget,
    );
    this.perFrameStaging = new ArrayBuffer(this.fragment.uniformSize);
    this.perFrameFloats = new Float32Array(this.perFrameStaging);
    this.perFrameInts = new Int32Array(this.perFrameStaging);
    /*
     * **A ring, because the block holds material state and a material changes between draws.**
     *
     * `setSurfaceTexture`, `setSurfaceGrain` and their siblings are pass state on both backends
     * — a material covers many draws, so the alternative is rebinding the same values twenty
     * times to say the same thing. On WebGL2 each is a `uniform1f` that lands immediately. Here
     * they live in this block, and `queue.writeBuffer` does not interleave with recorded
     * commands, so one buffer rewritten between two draws gives *both* the second value. Every
     * surface in a scene would wear the last material set, which is bug 7's shape at pass scale.
     *
     * A slot per *material change* rather than per draw: `drawMesh` reuses the open slot until
     * something dirties it, so a scene drawing a hundred meshes of one material spends one.
     */
    this.perFrame = new UniformRing(
      device,
      this.fragment.uniformSize,
      MAX_MATERIALS_PER_FRAME,
      USAGE_UNIFORM_DST,
      'flat.fragRing',
      this.materialBudget,
    );

    /*
     * A one-pixel stand-in for the albedo binding. `uAlbedoEnabled` is zero for untextured
     * geometry, which is nearly all of it, so the shader never samples this — but WebGPU
     * requires every declared binding to be filled. WebGL2 keeps an `emptyTexture2D` for
     * exactly the same reason.
     */
    const blank = device.createTexture({
      label: 'flat.emptyAlbedo',
      size: [1, 1],
      format: 'rgba8unorm',
      usage: 0x2 | 0x4, // COPY_DST | TEXTURE_BINDING
    });
    device.queue.writeTexture({ texture: blank }, new Uint8Array([255, 255, 255, 255]), {}, [1, 1]);

    /*
     * Every texture the variant declares gets the stand-in for now. The shadow maps arrive
     * with row 2 of Task 11, and they arrive by this function returning a real view for
     * `uStaticShadowMap` rather than by anything here changing shape.
     */
    const blankView = blank.createView();
    const blankSampler = device.createSampler({ label: 'flat.sampler' });

    /*
     * A one-texel cube for every point-shadow sampler the variant declares.
     *
     * Twelve of them exist in the `pointShadows` permutation and none has a map behind it
     * until row 3, but WebGPU requires every declared binding to be filled — and a cube view
     * needs six array layers, so the flat 1×1 stand-in above cannot serve.
     *
     * **White is the second guard, and it is a deliberate value rather than a spare one.** The
     * first is `uPointShadowIndex`, written to −1 for every light in `bindMeshPass`. If that
     * ever failed, a full-depth texel reads as an occluder at the far plane — `pointShadow`
     * converts the stored value back to a distance and 1.0 comes out as `far` — so the worst a
     * mis-selected light can do is find nothing in the way. Zeroes would have meant an
     * occluder pressed against the lamp, and every surface in the scene in shadow.
     */
    const blankCube = device.createTexture({
      label: 'flat.emptyPointShadow',
      size: [1, 1, 6],
      format: 'rgba8unorm',
      usage: 0x2 | 0x4, // COPY_DST | TEXTURE_BINDING
    });
    device.queue.writeTexture(
      { texture: blankCube },
      new Uint8Array(4 * 6).fill(255),
      { bytesPerRow: 4, rowsPerImage: 1 },
      [1, 1, 6],
    );
    const blankCubeView = blankCube.createView({ dimension: 'cube' });

    /*
     * A one-texel integer stand-in for the froxel table.
     *
     * **Needed whether or not clustering is on**, because the sampler is declared in every
     * permutation — see the note at its declaration in `shaders/flat/preamble.ts` for why it is a
     * runtime branch rather than a permutation, and what that cost measurement was. WebGPU
     * requires every declared binding to be filled, and an integer texture cannot be filled by any
     * of the blanks above: a `uint` binding rejects an `rgba8unorm` view outright.
     *
     * Zero rather than white, and the value matters less than it does for the shadow blanks: the
     * only thing read out of it would be a light count, and zero lights is the honest answer for a
     * table nobody filled.
     */
    const blankTable = device.createTexture({
      label: 'flat.emptyClusterTable',
      size: [1, 1],
      format: 'rgba32uint',
      usage: 0x2 | 0x4, // COPY_DST | TEXTURE_BINDING
    });
    device.queue.writeTexture(
      { texture: blankTable },
      new Uint32Array(4),
      { bytesPerRow: 16, rowsPerImage: 1 },
      [1, 1],
    );
    const blankTableView = blankTable.createView({ label: 'flat.emptyClusterTable' });
    this.blankTableView = blankTableView;

    /*
     * A one-texel, one-layer array for the frames before a world has sized the real one.
     *
     * WebGPU requires every declared binding to be filled, and a scene is free to draw before it
     * reports its lights. White for the same reason the blank cube is: a full-depth texel reads
     * as an occluder at the far plane, so the worst a lookup that should not have happened can
     * do is find nothing in the way. Zeroes would put an occluder against every lamp.
     */
    const blankArray = device.createTexture({
      label: 'flat.emptyPointShadowArray',
      size: [1, 1, 1],
      format: 'rgba8unorm',
      usage: 0x2 | 0x4, // COPY_DST | TEXTURE_BINDING
    });
    device.queue.writeTexture(
      { texture: blankArray },
      new Uint8Array(4).fill(255),
      { bytesPerRow: 4, rowsPerImage: 1 },
      [1, 1, 1],
    );
    const blankArrayView = blankArray.createView({ dimension: '2d-array' });

    this.shadowMap = device.createTexture({
      label: 'shadow.static',
      size: [this.quality.directionalShadowMapSize, this.quality.directionalShadowMapSize],
      format: SHADOW_FORMAT,
      usage: 0x10 | 0x4, // RENDER_ATTACHMENT | TEXTURE_BINDING
    });
    this.shadowView = this.shadowMap.createView();
    /*
     * The peel layer, on the condition `renderer.ts` builds its own on: more than one depth
     * layer asked for. `depth.ts` fills it by discarding every fragment at or in front of what
     * the static pass stored, so what lands here is the second independently fading occluder.
     */
    this.peelMap =
      this.quality.directionalShadowDepthLayers > 1
        ? device.createTexture({
            label: 'shadow.peel',
            size: [this.quality.directionalShadowMapSize, this.quality.directionalShadowMapSize],
            format: SHADOW_FORMAT,
            usage: 0x10 | 0x4, // RENDER_ATTACHMENT | TEXTURE_BINDING
          })
        : null;
    this.peelView = this.peelMap === null ? null : this.peelMap.createView();
    /*
     * The movers' layer, on the condition `renderer.ts` builds its own on: directional shadows
     * at all. Same size and same format as the static map, because the shader samples all three
     * with one `uShadowMapSize` and one set of PCF offsets.
     */
    this.dynamicMap = this.quality.directionalShadows
      ? device.createTexture({
          label: 'shadow.dynamic',
          size: [this.quality.directionalShadowMapSize, this.quality.directionalShadowMapSize],
          format: SHADOW_FORMAT,
          usage: 0x10 | 0x4, // RENDER_ATTACHMENT | TEXTURE_BINDING
        })
      : null;
    this.dynamicView = this.dynamicMap === null ? null : this.dynamicMap.createView();

    /*
     * **Cleared once, here, because a texture no pass has written holds undefined contents.**
     *
     * A GL depth texture is born defined and reads as the far plane, so `renderer.ts` can hand
     * an unrendered shadow map to the shader and get "nothing occludes anything". WebGPU makes
     * no such promise, and a scene is entitled to switch directional shadows *on* and never
     * open a pass — `night-street` does exactly that, with `shadowStrength` at 0.85 and no
     * `beginShadowPass` anywhere in it. Sampling garbage then shadows whatever the garbage
     * happens to say, which is a picture rather than an error and reads as a lighting bug.
     *
     * Found by dumping the flat block off both live renderers and comparing it field by field;
     * `uPeeledShadowEnabled` came back 1 against 0 and pointed straight at the maps behind it.
     * Bug 10, arrived at from the other direction.
     */
    const clear = device.createCommandEncoder({ label: 'shadow.clear' });
    for (const view of [this.shadowView, this.peelView, this.dynamicView]) {
      if (view === null) continue;
      clear
        .beginRenderPass({
          label: 'shadow.clear',
          colorAttachments: [],
          depthStencilAttachment: {
            view,
            depthClearValue: 1,
            depthLoadOp: 'clear',
            depthStoreOp: 'store',
          },
        })
        .end();
    }
    device.queue.submit([clear.finish()]);
    /*
     * `nearest` on a depth texture sampled as an ordinary float, matching what
     * `shadowMap.ts` asks WebGL2 for. A filtering sampler cannot be used on a depth format
     * without a comparison, and the filtering the engine wants is the shader's own PCF loop
     * rather than the hardware's.
     */
    const shadowSampler = device.createSampler({ label: 'shadow.sampler' });
    /*
     * The photometric atlas's own sampler, **created here rather than reusing `postSampler`.**
     *
     * `buildFlatBindGroup` runs a hundred lines before `postSampler` is assigned, so resolving
     * this binding to it handed the bind group an `undefined` sampler — which threw inside the
     * WebGPU constructor, made `createRenderer` fall back, and then failed again on a canvas that
     * already held a WebGPU context. What reached the console was "WebGL2 is not available",
     * which is true and names neither the cause nor the backend that actually failed.
     *
     * Linear across a row because this is a curve sampled between two angles, and clamped so a
     * row cannot bleed into its neighbour at the edges.
     */
    const iesSampler = device.createSampler({
      label: 'ies.sampler',
      magFilter: 'linear',
      minFilter: 'linear',
      addressModeU: 'clamp-to-edge',
      addressModeV: 'clamp-to-edge',
    });

    this.flatTextures = (name) => {
      if (name === 'uStaticShadowMap') return { view: this.shadowView, sampler: shadowSampler };
      /*
       * The movers' layer. Cleared at construction like the others, so a profile with
       * directional shadows on that never opens the layer reads the far plane and therefore
       * "nothing moving is in the way" — not whatever the allocation happened to contain.
       */
      if (name === 'uDynamicShadowMap' && this.dynamicView !== null) {
        return { view: this.dynamicView, sampler: shadowSampler };
      }
      /*
       * The caller's image, or the stand-in. Read from the field rather than passed in, because
       * `createFlatBindGroup` resolves every declared texture by name and this is the only one
       * that changes between draws — see `flatBindGroups` for why the answer is cached.
       */
      /*
       * The caller's normal map, or the stand-in. Read from the field for the reason `uAlbedo`
       * gives just below: `createFlatBindGroup` resolves every declared texture by name, and this
       * is one of the two that change between materials.
       */
      if (name === 'uNormalMap') {
        const map = this.normalMap;
        return map === null
          ? { view: blankView, sampler: blankSampler }
          : { view: map.view, sampler: map.sampler };
      }
      /* The caller's ORM map, or the stand-in, for the reason `uNormalMap` gives just above. */
      /* The caller's emissive map, or the stand-in, for the reason `uNormalMap` gives above. */
      if (name === 'uEmissiveMap') {
        const map = this.emissiveMap;
        return map === null
          ? { view: blankView, sampler: blankSampler }
          : { view: map.view, sampler: map.sampler };
      }
      if (name === 'uOrmMap') {
        const map = this.ormMap;
        return map === null
          ? { view: blankView, sampler: blankSampler }
          : { view: map.view, sampler: map.sampler };
      }
      if (name === 'uAlbedo') {
        const albedo = this.albedo;
        return albedo === null
          ? { view: blankView, sampler: blankSampler }
          : { view: albedo.view, sampler: albedo.sampler };
      }
      /* The peel, where the profile asked for one. `uPeeledShadowEnabled` gates the sample. */
      if (name === 'uPeeledShadowMap' && this.peelView !== null) {
        return { view: this.peelView, sampler: shadowSampler };
      }
      /*
       * The room, once a bake has filled it. Unbaked reads as the blank cube: nothing to mirror.
       *
       * **And the blank cube again while a bake is running**, which is not belt and braces
       * beside the uniform above. `renderer.ts` says why the flag alone is not enough: a driver
       * may fetch a sampler's descriptor before it evaluates the arithmetic that discards the
       * result. WebGPU is stricter still and rejects the pass outright for holding the cube it
       * is writing, so the binding has to move whatever the shader intends to do with it.
       */
      if (name === 'uEnvironment') {
        return this.probeView === null || !this.probeBaked || this.probePassActive
          ? { view: blankArrayView, sampler: blankSampler }
          : { view: this.probeView, sampler: this.probeSampler };
      }
      /*
       * The froxel table the binner writes, or the one-texel stand-in.
       *
       * The sampler is the shadow group's and is never used: every read is a `texelFetch`, and an
       * integer texture cannot be filtered at all. See `separateSamplers` for why it shares one.
       */
      if (name === 'uClusterTable') {
        const view = this.clusterBinner?.tableView ?? null;
        return { view: view ?? blankTableView, sampler: shadowSampler };
      }
      /*
       * The photometric atlas, or the single row of ones a scene with no profile falls back to.
       *
       * A **filtering** sampler rather than the shadow group's, unlike the froxel table beside it:
       * this one is a curve sampled between two angles rather than data addressed by index, so
       * interpolation across a row is the point. `postSampler` is linear and clamped.
       */
      if (name === 'uIesAtlas') {
        return { view: this.iesView ?? blankView, sampler: iesSampler };
      }
      /*
       * The cookie atlas, or the single white texel a scene with no cookie falls back to.
       *
       * A filtering sampler, like the photometric atlas and unlike the froxel table: a cookie is
       * an image and its whole point is that it is soft at the edges. The shader's own half-texel
       * inset is what keeps one tile out of the next; a clamp cannot, the seam being interior.
       */
      if (name === 'uCookieAtlas') {
        return { view: this.cookieView ?? blankView, sampler: iesSampler };
      }
      /*
       * The colour the frame had already drawn, or the blank texel a frame that refracts nothing
       * falls back to.
       *
       * **Always an entry, even where nothing refracts.** A bind group missing an entry its layout
       * declares is a validation failure at `submit` — which takes the whole command buffer with
       * it and draws no frame at all, from a frame that recorded correctly, with the cause in a
       * console line nobody is reading.
       *
       * A filtering sampler, like the cookie atlas above: the refracted sample lands between
       * texels by construction, an offset that snapped to one being no offset at all.
       */
      if (name === 'uRefractScene') {
        return { view: this.refractSnapshotView ?? blankView, sampler: iesSampler };
      }
      /*
       * Every point light's shadow, in one binding.
       *
       * **This was twelve cube views resolved by name**, one per declared `samplerCube`, and the
       * `boundShadowMaps` cache existed so that the bind group could be rebuilt only when those
       * twelve identities changed. One array texture has one identity, so the binding no longer
       * moves when a light changes hands — only the layer index in the uniform block does.
       */
      if (name === POINT_SHADOW_SAMPLER) {
        const array = this.pointShadowArray;
        return array === null
          ? { view: blankArrayView, sampler: shadowSampler }
          : { view: array.view, sampler: shadowSampler };
      }
      return { view: blankView, sampler: blankSampler };
    };
    /*
     * The binner, when the profile asked for froxels — **before the bind group is built, and the
     * order is the whole of it.**
     *
     * `registerCompute` runs the definition's `init`, which is what creates the table texture, and
     * the resolver above hands out `blankTableView` while there is none. A group built first
     * captures that stand-in permanently: the dispatch then fills a real table every frame that
     * nothing is bound to, and the floor comes out black with no error anywhere. That is exactly
     * what it did on the first run of `cluster-lights-check.mjs` — sixteen lamps lit without
     * clustering and **zero** with it, which reads as a broken binner and was a binding order.
     *
     * Registered at construction rather than at the first frame for the reason `registerPass`
     * gives about its own `init`: building a pipeline in the frame loop is the allocation the
     * house rules are about.
     */
    if (quality.clusteredLights) {
      this.clusterBinner = new ClusterBinner();
      this.clusterHandle = this.registerCompute(this.clusterBinner.definition());
    }
    this.bindGroup = this.buildFlatBindGroup();
    /* The same group: no texture is set at construction, so this is the stand-in's. */
    this.blankAlbedoBindGroup = this.bindGroup;

    this.skyLayout = createSkyBindGroupLayout(device);
    this.skyUniforms = device.createBuffer({
      label: 'sky.uniforms',
      size: SKY_UNIFORM_SIZE,
      usage: USAGE_UNIFORM_DST,
    });
    this.skyBindGroup = createSkyBindGroup(device, this.skyLayout, this.skyUniforms);

    this.plumeLayout = createPlumeBindGroupLayout(device);
    this.plumeVerts = new UniformRing(
      device,
      PLUME_VERT_SIZE,
      MAX_PLUMES_PER_FRAME,
      USAGE_UNIFORM_DST,
    );
    this.plumeFrags = new UniformRing(
      device,
      PLUME_FRAG_SIZE,
      MAX_PLUMES_PER_FRAME,
      USAGE_UNIFORM_DST,
    );
    this.plumeBindGroup = createPlumeBindGroup(
      device,
      this.plumeLayout,
      this.plumeVerts.buffer,
      this.plumeFrags.buffer,
    );
    this.waterLayout = createWaterBindGroupLayout(device);
    this.waterVerts = new UniformRing(
      device,
      WATER_VERT_SIZE,
      MAX_WATER_BODIES_PER_FRAME,
      USAGE_UNIFORM_DST,
      'water.vertUniforms',
      this.waterBudget,
    );
    this.waterFrags = new UniformRing(
      device,
      WATER_FRAG_SIZE,
      MAX_WATER_BODIES_PER_FRAME,
      USAGE_UNIFORM_DST,
      'water.fragUniforms',
    );
    /*
     * The stand-in until the first `resize` allocates a reflection, and for the whole session
     * on a profile that has no use for one. `uReflectionEnabled` is what decides whether the
     * shader looks; WebGPU requires something bound either way.
     */
    this.blankView = blankView;
    this.blankSampler = blankSampler;

    this.waterBindGroup = createWaterBindGroup(
      device,
      this.waterLayout,
      this.waterVerts.buffer,
      this.waterFrags.buffer,
      blankView,
      blankSampler,
    );
    /*
     * The probe, when the profile asked for one. `renderer.ts` allocates on the same condition,
     * so a profile with `reflectionProbeSize` at 0 gets no cube and no variant on either side.
     */
    this.probeSize = Math.max(
      16,
      Math.min(quality.reflectionProbeSize, device.limits.maxTextureDimension2D),
    );
    this.probe = this.probeEnabled
      ? device.createTexture({
          label: 'probe.cube',
          size: [this.probeSize, this.probeSize, 6],
          /* The world's format: a bake draws the world into these faces with the very
               pipelines the cache holds, so a cube of any other format drops the bake's
               command buffer entire. */
          format: this.pipelines.format,
          mipLevelCount: probeLevels(this.probeSize),
          /*
           * COPY_DST as well, because `setEnvironmentImage` writes six faces into this rather
           * than drawing them. Without it every such call is a validation failure reported at
           * `submit` rather than at the write — no picture, from a frame that recorded
           * correctly, with the cause in a console line nobody was reading.
           */
          usage: 0x10 | 0x4 | 0x2, // RENDER_ATTACHMENT | TEXTURE_BINDING | COPY_DST
        })
      : null;
    /*
     * The prefiltered twin, allocated on exactly the condition the capture is and with exactly
     * its format and level count. Same format because a pipeline's colour target must equal its
     * attachment's format exactly — the 2026-08-14 rule, whose failure mode is no picture at all
     * from a frame that recorded correctly — and the convolution renders into these levels.
     */
    /*
     * The grid starts as one probe, which is what every scene that bakes an environment already
     * is. `setProbeGrid` replaces this when a caller declares more, and rebuilds the flat bind
     * groups with it — a group built here holds the texture that existed here.
     */
    this.probeEdge = octahedralEdgeFor(this.probeSize);
    if (this.probeEnabled) this.allocateProbeArray(1, device);
    /*
     * The composite's layouts and blocks. Built whatever the profile says, because they cost a
     * few hundred bytes and building them lazily would put a pipeline compile in the first frame
     * that turns an effect on — which is the stall `ensureComposite` exists to avoid.
     */
    this.depthResolveLayout = createDepthResolveLayout(device, this.samples > 1);
    /* Linear, because every stage of this chain reads a half-size target at full size. */
    this.postSampler = device.createSampler({
      label: 'post.sampler',
      magFilter: 'linear',
      minFilter: 'linear',
      addressModeU: 'clamp-to-edge',
      addressModeV: 'clamp-to-edge',
    });
    /* All-nearest, which is what `non-filtering` means, for the `r32float` depth. */
    this.postDepthSampler = device.createSampler({
      label: 'post.depthSampler',
      addressModeU: 'clamp-to-edge',
      addressModeV: 'clamp-to-edge',
    });
    this.rushLayout = createPostStageLayout(device, RUSH_UNIFORMS, RUSH_FRAG_SIZE, [
      { binding: RUSH_TEXTURES.uScene },
      { binding: RUSH_TEXTURES.uDepth, filterable: false },
      { binding: RUSH_TEXTURES.uAo },
      { binding: RUSH_TEXTURES.uBloom },
      /* The colour grade's lookup table: a cube of display values, and the one post input that
         is not a screen-sized target. Filtering is what makes a 32-lattice table smooth rather
         than banded, so it is declared filterable like the colour inputs and unlike the depth. */
      { binding: RUSH_TEXTURES.uGradeLut, dimension: '3d' },
    ]);
    this.rushUniforms = device.createBuffer({
      label: 'post.rushUniforms',
      size: RUSH_FRAG_SIZE,
      usage: USAGE_UNIFORM_DST,
    });
    this.oitResolveLayout = createOitResolveLayout(device);
    /* The resolved depth is `r32float`, which is unfilterable — the declaration
       `createPostStageLayout` documents at length, and the only input a mark reads. */
    this.decalLayout = createPostStageLayout(device, DECAL_UNIFORMS, DECAL_FRAG_SIZE, [
      { binding: DECAL_TEXTURES.uDecalDepth, filterable: false },
    ]);
    /* Depth is `r32float` and unfilterable; the scene is an ordinary render target and filters,
       which is what lets a hit be sampled between texels rather than snapped to one. */
    this.ssrLayout = createPostStageLayout(device, SSR_UNIFORMS, SSR_FRAG_SIZE, [
      { binding: SSR_TEXTURES.uSsrDepth, filterable: false },
      { binding: SSR_TEXTURES.uSsrScene },
    ]);
    this.ssrResolveLayout = createSsrResolveLayout(device);
    this.ssrUniforms = device.createBuffer({
      label: 'post.ssrUniforms',
      size: SSR_SLOT * MAX_REFLECTIVE_SURFACES,
      usage: USAGE_UNIFORM_DST,
    });
    this.decalUniforms = device.createBuffer({
      label: 'post.decalUniforms',
      /* Every mark's block at once, not one: the pass binds by dynamic offset, and a buffer sized
         to a single block would put every mark after the first out of bounds. */
      size: DECAL_SLOT * MAX_DRAWN_DECALS,
      usage: USAGE_UNIFORM_DST,
    });
    this.aoLayout = createPostStageLayout(device, AO_UNIFORMS, AO_FRAG_SIZE, [
      { binding: AO_TEXTURES.uDepth, filterable: false },
    ]);
    this.aoUniforms = device.createBuffer({
      label: 'post.aoUniforms',
      size: AO_FRAG_SIZE,
      usage: USAGE_UNIFORM_DST,
    });
    /*
     * The march's inputs: the resolved depth, and the sun's three layers.
     *
     * All four `unfilterable-float`, and the depth for the reason `createPostStageLayout`
     * documents at length. The shadow maps are declared the same way for the reason
     * `lightVolumePass.ts` gives about its own: a depth format's supported sample types are
     * `UnfilterableFloat | Depth` and never plain `Float`, and this shader wants exactly that —
     * `sunReach` takes one explicit-level tap per map and asks the hardware to blend nothing.
     */
    this.mediumLayout = createPostStageLayout(device, MEDIUM_UNIFORMS, MEDIUM_FRAG_SIZE, [
      { binding: MEDIUM_TEXTURES.uDepth, filterable: false },
      { binding: MEDIUM_TEXTURES.uStaticShadowMap, filterable: false },
      { binding: MEDIUM_TEXTURES.uPeeledShadowMap, filterable: false },
      { binding: MEDIUM_TEXTURES.uDynamicShadowMap, filterable: false },
    ]);
    this.mediumUniforms = device.createBuffer({
      label: 'post.mediumUniforms',
      size: MEDIUM_FRAG_SIZE,
      usage: USAGE_UNIFORM_DST,
    });
    /*
     * The composite's, and the medium is declared unfilterable too.
     *
     * `rgba16float` filters perfectly well; this pass does not want it to. It computes the four
     * bilinear weights itself so that it can *refuse* one across a depth edge, and it fetches
     * each texel at its own centre — so a filtering sampler would blend back exactly the taps the
     * pass exists to separate. `GlobalMediumPass` sets `NEAREST` on the other backend for the
     * same reason, which is the parity that matters here.
     */
    this.mediumUpsampleLayout = createPostStageLayout(
      device,
      MEDIUM_UPSAMPLE_UNIFORMS,
      MEDIUM_UPSAMPLE_SIZE,
      [
        { binding: MEDIUM_UPSAMPLE_TEXTURES.uMedium, filterable: false },
        { binding: MEDIUM_UPSAMPLE_TEXTURES.uDepth, filterable: false },
      ],
    );
    this.mediumUpsampleUniforms = device.createBuffer({
      label: 'post.mediumUpsampleUniforms',
      size: MEDIUM_UPSAMPLE_SIZE,
      usage: USAGE_UNIFORM_DST,
    });
    /* Scene and history filter; the resolved depth is `r32float` and cannot, which is the
       declaration `createPostStageLayout` documents at length. */
    this.taaLayout = createPostStageLayout(device, TAA_UNIFORMS, TAA_FRAG_SIZE, [
      { binding: TAA_TEXTURES.uScene },
      { binding: TAA_TEXTURES.uHistory },
      { binding: TAA_TEXTURES.uDepth, filterable: false },
    ]);
    this.taaUniforms = device.createBuffer({
      label: 'post.taaUniforms',
      size: TAA_FRAG_SIZE,
      usage: USAGE_UNIFORM_DST,
    });
    /* The estimate is an ordinary `r8unorm` target and filters; the depth beside it is
       `r32float` and cannot, which is the declaration `createPostStageLayout` documents. */
    this.aoBlurLayout = createPostStageLayout(device, AO_BLUR_UNIFORMS, AO_BLUR_SIZE, [
      { binding: AO_BLUR_TEXTURES.uAo },
      { binding: AO_BLUR_TEXTURES.uDepth, filterable: false },
    ]);
    this.aoBlurUniforms = device.createBuffer({
      label: 'post.aoBlurUniforms',
      size: AO_BLUR_SLOT * 2,
      usage: USAGE_UNIFORM_DST,
    });
    this.bloomLayout = createPostStageLayout(device, BLOOM_UNIFORMS, BLOOM_STAGE_SIZE, [
      { binding: BLOOM_TEXTURES.uSource },
    ]);
    this.bloomUniforms = device.createBuffer({
      label: 'post.bloomUniforms',
      /* Every stage's slot at once, not one block: the chain binds by dynamic offset, and a
         buffer sized to a single block would put every stage after the first out of bounds. */
      size: BLOOM_SLOT * BLOOM_SLOTS,
      usage: USAGE_UNIFORM_DST,
    });

    this.probeMipLayout = createProbeMipBindGroupLayout(device);
    this.probePrefilterLayout = createProbePrefilterBindGroupLayout(device);
    this.probeMipUniforms = new UniformRing(
      device,
      PROBE_MIP_UNIFORM_SIZE,
      /*
       * Six faces for every level the chain fills, taken from the cube this renderer actually
       * allocated rather than from a round number. 64 covered every size up to 1024 and silently
       * lost the top of the chain above it, which is the kind of cap the house rules ask to be
       * either impossible or loud; this makes it impossible and `buildProbeChain` makes it loud.
       *
       * **Two passes share this ring now**, so it holds both their needs: the box chain fills
       * every level but the base, and the convolution fills every level including it. Sizing it
       * for one of them and running both is the silent version of the cap described above — the
       * second pass would find the ring full, `allocate` would answer null, and the warning that
       * fires would name whichever pass happened to be second.
       */
      6 * Math.max(1, probeLevels(this.probeSize) - 1) + 6 * probeLevels(this.probeSize),
      USAGE_UNIFORM_DST,
      'probe.mipRing',
    );
    /* Linear across levels, because the chain is the roughness and a hard step would band it. */
    this.probeSampler = device.createSampler({
      label: 'probe.sampler',
      magFilter: 'linear',
      minFilter: 'linear',
      mipmapFilter: 'linear',
      addressModeU: 'clamp-to-edge',
      addressModeV: 'clamp-to-edge',
    });

    this.causticsLayout = createCausticsBindGroupLayout(device);
    this.causticsVerts = new UniformRing(
      device,
      CAUSTICS_VERT_SIZE,
      MAX_BATCHES_PER_FRAME,
      USAGE_UNIFORM_DST,
      'caustics.vertUniforms',
      this.causticsBudget,
    );
    this.causticsFrags = new UniformRing(
      device,
      CAUSTICS_FRAG_SIZE,
      MAX_BATCHES_PER_FRAME,
      USAGE_UNIFORM_DST,
      'caustics.fragUniforms',
    );
    this.causticsBindGroup = createCausticsBindGroup(
      device,
      this.causticsLayout,
      this.causticsVerts.buffer,
      this.causticsFrags.buffer,
    );

    this.insetLayout = createInsetBindGroupLayout(device);
    this.insetUniforms = new UniformRing(
      device,
      INSET_UNIFORM_SIZE,
      MAX_OVERLAYS,
      USAGE_UNIFORM_DST,
      'inset.ring',
    );
    this.insetBindGroup = createInsetBindGroup(device, this.insetLayout, this.insetUniforms.buffer);

    this.filmLayout = createFilmBindGroupLayout(device);
    this.filmVerts = new UniformRing(
      device,
      FILM_VERT_SIZE,
      MAX_OVERLAYS,
      USAGE_UNIFORM_DST,
      'film.vertRing',
    );
    this.filmFrags = new UniformRing(
      device,
      FILM_FRAG_SIZE,
      MAX_OVERLAYS,
      USAGE_UNIFORM_DST,
      'film.fragRing',
    );
    this.filmBindGroup = createFilmBindGroup(
      device,
      this.filmLayout,
      this.filmVerts.buffer,
      this.filmFrags.buffer,
      blankView,
      blankSampler,
    );
    /*
     * The same group, permanently holding the blank rather than the mirror, for drawing a film
     * *inside* the mirror pass.
     *
     * **Turning the uniform off is not enough, and this is the case that proves it.** `drawFilm`
     * has always set `uReflectionEnabled` to 0 while `reflectionPassActive`, so nothing sampled
     * the half-drawn mirror — but the bind group went on *holding* it, and WebGPU validates the
     * binding rather than the read: *"[Texture "reflection.color"] usage
     * (TextureBinding|RenderAttachment) includes writable usage and another usage in the same
     * synchronization scope"*, raised at `finish`, which invalidates the whole command buffer and
     * drops the entire reflection. Measured in a consumer on an RX 9070 XT, where the film is
     * drawn from `drawOpaqueScene` and so is drawn once for the mirror as well.
     *
     * The 2026-08-14 rule in `AGENTS.md` says exactly this about the probe cube and gives the
     * reason it is not merely pedantic: a driver may fetch a sampler's descriptor before it
     * evaluates the arithmetic that discards the result. The binding has to move too.
     */
    this.filmBindGroupBlank = this.filmBindGroup;

    this.scatterLayout = createScatterBindGroupLayout(device);
    this.scatterVerts = new UniformRing(
      device,
      SCATTER_VERT_SIZE,
      MAX_PLUMES_PER_FRAME,
      USAGE_UNIFORM_DST,
    );
    this.scatterFragUniforms = device.createBuffer({
      label: 'scatter.fragUniforms',
      size: SCATTER_FRAG_SIZE,
      usage: USAGE_UNIFORM_DST,
    });
    this.scatterBindGroup = createScatterBindGroup(
      device,
      this.scatterLayout,
      this.scatterVerts.buffer,
      this.scatterFragUniforms,
    );

    this.shadowLayout = createDepthBindGroupLayout(device);
    this.shadowSkinnedLayout = createDepthBindGroupLayout(device, true);
    this.shadowDraws = new UniformRing(
      device,
      DEPTH_VERT_SIZE,
      MAX_DRAWS_PER_FRAME,
      USAGE_UNIFORM_DST,
      'shadow.drawRing',
      this.shadowDrawBudget,
    );
    const depthPassUniforms = device.createBuffer({
      label: 'depth.passUniforms',
      size: DEPTH_FRAG_SIZE,
      usage: USAGE_UNIFORM_DST,
    });
    /* `uPeelShadowLayer` is zero: the peel layer is the rest of row 2. */
    device.queue.writeBuffer(depthPassUniforms, 0, new Int32Array([0]));
    this.scatterDepthLayout = createScatterDepthBindGroupLayout(
      device,
      DEPTH_FRAG_BINDING,
      DEPTH_FRAG_SIZE,
      DEPTH_PREVIOUS_BINDING,
    );
    this.scatterDepthDraws = new UniformRing(
      device,
      SCATTER_DEPTH_SIZE,
      MAX_SCATTER_DEPTH_DRAWS,
      USAGE_UNIFORM_DST,
      'scatter.depthDrawRing',
      this.scatterDepthBudget,
    );
    this.scatterDepthBindGroup = createScatterDepthBindGroup(
      device,
      this.scatterDepthLayout,
      this.scatterDepthDraws.buffer,
      { binding: DEPTH_FRAG_BINDING, buffer: depthPassUniforms, size: DEPTH_FRAG_SIZE },
      DEPTH_PREVIOUS_BINDING,
      blankView,
      blankSampler,
    );
    this.shadowBindGroup = createDepthBindGroup(
      device,
      this.shadowLayout,
      this.shadowDraws.buffer,
      depthPassUniforms,
      blankView,
      blankSampler,
    );
    this.shadowBlankView = blankView;
    this.shadowBlankSampler = blankSampler;
    this.shadowPassUniforms = depthPassUniforms;

    /*
     * The peel's bindings, which are the whole difference between the two layers.
     *
     * `uPeelShadowLayer` at 1 turns on the discard in `depth.ts`, and `uPreviousShadowMap` is
     * the static map it discards against. **Its own uniform buffer rather than a rewrite of
     * the static one**: `queue.writeBuffer` does not interleave with recorded commands, so one
     * buffer written twice in a frame gives both passes the last write — the flame that leaned
     * forty degrees. Two buffers cannot have that bug.
     *
     * Sharing the static pass's bind group instead was measured and is wrong in a way worth
     * recording: with `uPeelShadowLayer` at 0 the peel pass keeps nothing out, so it stores the
     * first surface a second time and the frame gets two copies of one occluder.
     */
    const peelPassUniforms =
      this.peelView === null
        ? null
        : device.createBuffer({
            label: 'depth.peelPassUniforms',
            size: DEPTH_FRAG_SIZE,
            usage: USAGE_UNIFORM_DST,
          });
    if (peelPassUniforms !== null) {
      device.queue.writeBuffer(peelPassUniforms, 0, new Int32Array([1]));
    }
    this.shadowPeelBindGroup =
      peelPassUniforms === null
        ? null
        : createDepthBindGroup(
            device,
            this.shadowLayout,
            this.shadowDraws.buffer,
            peelPassUniforms,
            this.shadowView,
            shadowSampler,
          );
    this.scatterDepthPeelBindGroup =
      peelPassUniforms === null
        ? null
        : createScatterDepthBindGroup(
            device,
            this.scatterDepthLayout,
            this.scatterDepthDraws.buffer,
            { binding: DEPTH_FRAG_BINDING, buffer: peelPassUniforms, size: DEPTH_FRAG_SIZE },
            DEPTH_PREVIOUS_BINDING,
            this.shadowView,
            shadowSampler,
          );

    /*
     * The light volume, last because it wants the shadow map and the stand-in that everything
     * above already built. The peel and dynamic maps get the white one-pixel texture, which is
     * depth 1 and therefore nothing in the way — see `createLightVolumeBindGroup` for why a
     * stand-in of zero would put every beam in shadow instead.
     */
    const uniformBuffer = (label: string, size: number): GPUBuffer =>
      device.createBuffer({ label, size, usage: USAGE_UNIFORM_DST });

    /*
     * The overlays. Rings rather than single blocks because a frame draws several of each —
     * the loader alone is two panels and two strings — and `queue.writeBuffer` does not
     * interleave with recorded commands, so one block written twice gives every draw the last
     * write. See `createPanelBindGroup`.
     */
    this.panelLayout = createPanelBindGroupLayout(device);
    this.panelCorners = createPanelCorners(device);
    /* The budget on one of the pair only: a panel is one ask, whichever ring runs out. */
    this.panelVerts = new UniformRing(
      device,
      PANEL_VERT_SIZE,
      MAX_OVERLAYS,
      USAGE_UNIFORM_DST,
      'panel.vertRing',
      this.panelBudget,
    );
    this.panelFrags = new UniformRing(
      device,
      PANEL_FRAG_SIZE,
      MAX_OVERLAYS,
      USAGE_UNIFORM_DST,
      'panel.fragRing',
    );
    this.panelBindGroup = createPanelBindGroup(
      device,
      this.panelLayout,
      this.panelVerts.buffer,
      this.panelFrags.buffer,
    );

    this.textLayout = createTextBindGroupLayout(device);
    this.textCube = createGpuTextCube(device);
    this.textVerts = new UniformRing(
      device,
      TEXT_VERT_SIZE,
      MAX_OVERLAYS,
      USAGE_UNIFORM_DST,
      'text.vertRing',
      this.textBudget,
    );
    this.textFrags = new UniformRing(
      device,
      TEXT_FRAG_SIZE,
      MAX_OVERLAYS,
      USAGE_UNIFORM_DST,
      'text.fragRing',
    );
    this.textBindGroup = createTextBindGroup(
      device,
      this.textLayout,
      this.textVerts.buffer,
      this.textFrags.buffer,
    );

    /*
     * No shared bind group here, unlike the panel/text rings above: SDF text's atlas differs
     * per label, so `sdfTextBindGroupFor` builds one lazily per atlas and this only readies
     * the layout and the two rings every bind group is built against.
     */
    this.sdfTextLayout = createSdfTextBindGroupLayout(device);
    this.sdfTextVerts = new UniformRing(
      device,
      SDF_TEXT_VERT_SIZE,
      MAX_OVERLAYS,
      USAGE_UNIFORM_DST,
      'sdfText.vertRing',
      this.sdfTextBudget,
    );
    this.sdfTextFrags = new UniformRing(
      device,
      SDF_TEXT_FRAG_SIZE,
      MAX_OVERLAYS,
      USAGE_UNIFORM_DST,
      'sdfText.fragRing',
    );

    this.windStreakLayout = createWindStreakBindGroupLayout(device);
    this.windStreakVerts = new UniformRing(
      device,
      WIND_STREAK_VERT_SIZE,
      MAX_BATCHES_PER_FRAME,
      USAGE_UNIFORM_DST,
      'windStreaks.vertUniforms',
      this.windStreakBudget,
    );
    this.windStreakFrags = new UniformRing(
      device,
      WIND_STREAK_FRAG_SIZE,
      MAX_BATCHES_PER_FRAME,
      USAGE_UNIFORM_DST,
      'windStreaks.fragUniforms',
    );
    this.windStreakBindGroup = createWindStreakBindGroup(
      device,
      this.windStreakLayout,
      this.windStreakVerts.buffer,
      this.windStreakFrags.buffer,
    );

    this.flockLayout = createFlockBindGroupLayout(device);
    this.flockVerts = new UniformRing(
      device,
      FLOCK_VERT_SIZE,
      MAX_BATCHES_PER_FRAME,
      USAGE_UNIFORM_DST,
      'flock.vertUniforms',
      this.flockBudget,
    );
    this.flockFrags = new UniformRing(
      device,
      FLOCK_FRAG_SIZE,
      MAX_BATCHES_PER_FRAME,
      USAGE_UNIFORM_DST,
      'flock.fragUniforms',
    );
    this.flockBindGroup = createFlockBindGroup(
      device,
      this.flockLayout,
      this.flockVerts.buffer,
      this.flockFrags.buffer,
    );

    this.boltLayout = createBoltBindGroupLayout(device);
    this.boltVerts = new UniformRing(
      device,
      BOLT_VERT_SIZE,
      MAX_BATCHES_PER_FRAME,
      USAGE_UNIFORM_DST,
      'bolt.vertUniforms',
      this.boltBudget,
    );
    this.boltFrags = new UniformRing(
      device,
      BOLT_FRAG_SIZE,
      MAX_BATCHES_PER_FRAME,
      USAGE_UNIFORM_DST,
      'bolt.fragUniforms',
    );
    this.boltBindGroup = createBoltBindGroup(
      device,
      this.boltLayout,
      this.boltVerts.buffer,
      this.boltFrags.buffer,
    );

    this.lineLayout = createLineBindGroupLayout(device);
    /* A ring, not a block, for the reason `linePass.ts`'s own top comment gives: more than one
       polyline a frame is the normal case here, not the exception a bolt pool is. */
    this.lineVerts = new UniformRing(
      device,
      LINE_VERT_SIZE,
      MAX_OVERLAYS,
      USAGE_UNIFORM_DST,
      'line.vertRing',
      this.lineBudget,
    );
    this.lineFrags = new UniformRing(
      device,
      LINE_FRAG_SIZE,
      MAX_OVERLAYS,
      USAGE_UNIFORM_DST,
      'line.fragRing',
    );
    this.lineBindGroup = createLineBindGroup(
      device,
      this.lineLayout,
      this.lineVerts.buffer,
      this.lineFrags.buffer,
    );

    /*
     * A factory rather than a size, because the pool is `renderer.ts`'s and knows no device.
     * Null where the profile switched cube shadows off, which is also when the flat shader
     * compiled without a single cubemap sampler.
     */
    this.pointShadows = quality.pointShadows
      ? new PointShadowSystem<GpuPointShadowMap>(
          /* See `renderer.ts`: the array cannot exist until a world says how many lights it has. */
          (layer) =>
            new GpuPointShadowMap(() => this.pointShadowArray, layer, quality.pointShadowFaceSize),
          (map) => map.dispose(),
        )
      : null;
    /*
     * Null exactly when the pool is, because a rectangle reads its occlusion out of that array.
     * Same factory: an area light's map is a point light's map on another layer.
     */
    this.areaShadows = quality.pointShadows
      ? new AreaShadowSet<GpuPointShadowMap>(
          (layer) =>
            new GpuPointShadowMap(() => this.pointShadowArray, layer, quality.pointShadowFaceSize),
          (map) => map.dispose(),
        )
      : null;

    this.wantsReflection = (quality.water && quality.waterReflections) || quality.planarReflections;

    this.lightVolumeVariant = quality.directionalShadows ? 'directionalShadows' : 'none';
    this.lightVolumeFragment = lightVolumeFragmentBindings(this.lightVolumeVariant);
    this.lightVolumeLayout = createLightVolumeBindGroupLayout(device, this.lightVolumeVariant);
    this.lightVolumeVertices = new UniformRing(
      device,
      LIGHT_VOLUME_VERT_SIZE,
      MAX_LIGHT_VOLUMES_PER_FRAME,
      USAGE_UNIFORM_DST,
      'lightVolume.vertRing',
      this.lightVolumeBudget,
    );
    this.lightVolumeFragments = new UniformRing(
      device,
      this.lightVolumeFragment.uniformSize,
      MAX_LIGHT_VOLUMES_PER_FRAME,
      USAGE_UNIFORM_DST,
      'lightVolume.fragRing',
    );
    this.volumeShadowSampler = shadowSampler;
    this.volumeBlank = { view: blankView, sampler: blankSampler };
    this.lightVolumeBindGroup = this.buildLightVolumeBindGroup();
  }

  /**
   * The height the medium is resolved at, which is the *viewer's* and not the camera's.
   *
   * They are the same except inside the mirror pass, where the camera stands as far below the
   * water as the viewer stands above it. Resolving fog from that puts the whole reflection
   * underwater whenever the viewer is not, and the result is a pool that reads as filled with
   * the wrong medium rather than as a camera in the wrong place. `renderer.ts` keeps
   * `reflectionAtmosphereY` for exactly this and passes it to four binders.
   */
  private atmosphereHeight(camera: Camera): number {
    return this.reflectionPassActive ? this.reflectionAtmosphereY : (camera.position[1] ?? 0);
  }

  /**
   * One array of the block, at the stride the generator declared.
   *
   * Element by element rather than `set`, for the reason `scatterInto` gives: an array element
   * in one of these blocks has its own slot, and a straight fill would lay ten answers across
   * the first two and a half.
   */
  private writeShadowParams(floats: Float32Array, name: string, values: Float32Array): void {
    const field = this.fragment.fields[name];
    if (field?.length === undefined || field.stride === undefined) return;
    for (let k = 0; k < field.length && k < values.length; k++) {
      floats[(field.offset + k * field.stride) / 4] = values[k] as number;
    }
  }

  /** The index and the weight of one selection array, which are always written together. */
  private writeShadowSelection(
    floats: Float32Array,
    ints: Int32Array,
    prefix: string,
    indices: Int32Array,
    weights: Float32Array,
  ): void {
    const index = this.fragment.fields[`${prefix}Layer`];
    if (index?.length === undefined || index.stride === undefined) return;
    for (let k = 0; k < index.length && k < indices.length; k++) {
      ints[(index.offset + k * index.stride) / 4] = indices[k] as number;
    }
    this.writeShadowParams(floats, `${prefix}Weight`, weights);
  }

  /**
   * Say that no light in one selection array owns a cubemap.
   *
   * Written per element at the block's declared stride rather than filled, for the reason
   * `scatterInto` gives: an array element in one of these blocks has its own sixteen-byte slot
   * and a straight fill would lay ten answers across the first two and a half.
   */
  private clearShadowSelection(
    floats: Float32Array,
    ints: Int32Array,
    indexField: string,
    weightField: string,
  ): void {
    const indices = this.fragment.fields[indexField];
    const weights = this.fragment.fields[weightField];
    if (indices?.length === undefined || indices.stride === undefined) return;
    if (weights?.stride === undefined) return;
    for (let light = 0; light < indices.length; light++) {
      ints[(indices.offset + light * indices.stride) / 4] = -1;
      floats[(weights.offset + light * weights.stride) / 4] = 0;
    }
  }

  /** Which optional attributes a mesh supplied, recovered from its buffers for the depth pass. */
  private presentOf(mesh: GpuMesh & { key?: string }): Record<string, boolean> {
    const present: Record<string, boolean> = {};
    const key = mesh.key ?? '';
    for (const attribute of VERTEX_LAYOUT) {
      if (!attribute.optional) continue;
      present[String(attribute.name)] = key.includes(`:${String(attribute.name)}`);
    }
    return present;
  }

  /**
   * Open the frame and clear to the sky.
   *
   * **Every entry point returns early on a lost device rather than throwing.** A consumer's
   * `requestAnimationFrame` loop keeps calling after a driver reset, and `AGENTS.md`'s rule
   * that the frame loop never throws is what stops that turning one GPU fault into sixty
   * uncaught exceptions a second in somebody's error reporting.
   */
  beginFrame(clearColor: Vec3): void {
    /* Whatever an update replaced during the last frame; nothing recorded can read it now. */
    for (const texture of this.retiredTextures) texture.destroy();
    this.retiredTextures.length = 0;
    /*
     * **Decided here and held for the frame**, so a draw cannot be recorded under one rule and
     * replayed under another. Multisampling is excluded: the two buffers are single-sampled and a
     * pass cannot mix them with a multisampled depth attachment, so the set stays sorted there and
     * says so once rather than drawing something else.
     */
    this.translucentQueue.reset();
    this.decalQueue.reset();
    this.reflectionQueue.reset();
    /* Redeclared every frame, so a field a consumer stops declaring stops lighting. */
    this.distanceFields.reset();
    this.oitActive =
      this.quality.orderIndependent && this.quality.screenEffects && this.samples === 1;
    /* Read off the line above rather than restating its last term: with the other two true, the
       sample count is the only thing left that can have turned it off, and a second copy of an
       expression is what `compositeWantsDepth` cost this file a release ago. */
    if (!this.oitActive && this.quality.orderIndependent && this.quality.screenEffects) {
      this.refuseOitMultisampled();
    }
    if (this.surface.lost) {
      this.reportLostOnce();
      return;
    }
    this.flushesThisFrame = 0;
    this.verbFlushesThisFrame = 0;
    this.passesLastFlush = 0;
    this.discardsLastFlush = 0;
    this.clearsLastFlush = 0;
    this.pendingDiscard = 0;
    /* Anything drawn after the last `endFrame` goes now, before its encoder is replaced. */
    this.flushOverlay();

    this.framePresented = false;
    /* Before the budget is cleared, because what to grow to is what the last frame asked for. */
    this.growRings();
    this.budget.reset();
    this.perDraw.reset();
    /*
     * The palette ring, and the chosen slot with it.
     *
     * Here rather than at `endFrame`, and after `flushOverlay` rather than before it: a slot may
     * only be re-let once every draw pointing at it has been submitted, and anything drawn after
     * the last `endFrame` went in the line above.
     */
    this.skinPalettes.reset();
    this.skinPaletteSlot = -1;
    this.lightVolumeVertices.reset();
    this.lightVolumeFragments.reset();
    /*
     * The mirror is stale until this frame draws it. A scene that opened one last frame and
     * not this one would otherwise water-mark the pool with the frame before it.
     */
    this.reflectionReady = false;
    this.reflectionPassActive = false;
    /* Last frame's snapshot is last frame's scene. See `volumeDepthTaken`. */
    this.volumeDepthTaken = false;
    /* Last frame's snapshot is last frame's scene. */
    this.refractSnapshotTaken = false;
    this.plumeVerts.reset();
    this.plumeFrags.reset();
    this.waterVerts.reset();
    this.waterFrags.reset();
    /* The four batched effects, which each hold a slot per batch as of 3.30.1. */
    this.boltVerts.reset();
    this.boltFrags.reset();
    this.causticsVerts.reset();
    this.causticsFrags.reset();
    this.flockVerts.reset();
    this.flockFrags.reset();
    this.windStreakVerts.reset();
    this.windStreakFrags.reset();
    this.scatterVerts.reset();
    this.panelVerts.reset();
    this.panelFrags.reset();
    this.filmVerts.reset();
    this.filmFrags.reset();
    this.insetUniforms.reset();
    this.textVerts.reset();
    this.textFrags.reset();
    this.sdfTextVerts.reset();
    this.sdfTextFrags.reset();
    this.lineVerts.reset();
    this.lineFrags.reset();
    /* The material ring, and the open slot with it: last frame's slots are gone. */
    this.perFrame.reset();
    this.materials.dirty();
    /* Spent by `runMotion` at the end of the last frame; a frame states its movers afresh. */
    this.motionCount = 0;
    /*
     * The canvas rather than the swap chain's texture, and the difference is that reading this
     * does not *acquire* anything. See `swapView`.
     *
     * They cannot disagree: `configure` sizes the swap chain from the canvas, so a frame's
     * drawing buffer is `canvas.width` by `canvas.height` by construction. Beside the depth
     * rather than only in `resize`, for the reason the depth is here: a frame must not begin
     * without the target it draws into, and a scene is free never to call `resize`.
     */
    const { canvas } = this.surface;
    /*
     * **The render size first, because every target below is sized from it.** Off — and without a
     * composite to enlarge from — it is the drawing buffer exactly, which is what makes a frame
     * with no reconstruction byte-for-byte the frame this renderer has always drawn.
     */
    const render = this.sceneSize();
    this.renderWidth = render.width;
    this.renderHeight = render.height;
    this.ensureDepth(render.width, render.height);
    this.ensureComposite(render.width, render.height);
    this.ensureReconstruction(
      render.width,
      render.height,
      Math.max(1, canvas.width),
      Math.max(1, canvas.height),
    );
    /*
     * **Not acquired here, and that is the fix for a frame flashing black.**
     *
     * `getCurrentTexture` does not read the swap chain, it *takes* it: whatever is in the
     * returned texture is what the browser presents at the end of the task, drawn into or not.
     * So a frame that acquired and then failed to submit — a lost surface, a null encoder, a
     * composite target that had gone, an exception in the consumer's own frame code between
     * `beginFrame` and `endFrame` — presented an untouched texture. That is a black frame, and
     * it is indistinguishable from a rendering fault while being nothing of the kind.
     *
     * Acquired on first use instead, which for the ordinary profile is the composite at the very
     * end of the frame. A frame that dies before then never takes the swap chain at all, so the
     * browser has nothing new to present and the last good frame stays on the screen. A dropped
     * frame reads as a dropped frame rather than as a flash.
     */
    this.frameSwapView = null;
    this.encoder = this.surface.device.createCommandEncoder();
    this.settleReconJitter();
    /*
     * Passes that own a target fill it here — after the encoder exists and before anything opens
     * the frame's render pass, including the eager path twenty lines below. See
     * `PassDefinition.prepare`: this is the one fixed point, and being above the `deferFramePass`
     * branch is what makes it one rather than two.
     */
    this.runPreparePasses(this.encoder);
    /*
     * **Not opened here, and that is the whole of the reopen fix.** Opening the frame's pass
     * eagerly meant a scene drawing a mirror had to close it, submit and reopen it with
     * `loadOp: 'load'` — a full read of the attachment back into tile memory and a full write
     * at the end of the resumed pass, twice over in a world with a sea and a fountain, measured
     * at 92 MB a frame at 824x1830. `ensurePass` opens it on the first draw that wants it, which
     * for such a scene is after the last mirror, so it is opened once and cleared once.
     */
    this.pendingClearColor[0] = clearColor[0];
    this.pendingClearColor[1] = clearColor[1];
    this.pendingClearColor[2] = clearColor[2];
    this.pendingClearMask = SCENE_TARGET;
    if (this.quality.deferFramePass) {
      this.pass = null;
    } else {
      /*
       * The eager path, restored whole: the swap chain is taken here as well as the pass opened.
       * Deferring only the pass would still leave `getCurrentTexture` until the composite, and it
       * is *that* half — when the frame's image is acquired — that a browser can disagree about.
       * Chrome on iOS came back black with it deferred, so `deferFramePass: false` has to mean
       * what it did before the deferral existed rather than most of it.
       */
      this.swapView();
      this.pass = this.ensurePass();
    }
  }

  /**
   * The depth buffer, rebuilt only when the drawing buffer changes size.
   *
   * WebGPU has no depth attachment of its own the way a default framebuffer does, so one is
   * owned here. Rebuilding it every frame would allocate in the frame loop; rebuilding it
   * never would mean a resized canvas draws against a depth buffer of the old size, which is
   * a validation error rather than a wrong picture.
   */
  private ensureDepth(width: number, height: number): void {
    if (this.depth !== null && this.depth.width === width && this.depth.height === height) return;
    const size: [number, number] = [Math.max(1, width), Math.max(1, height)];
    this.depth?.destroy();
    this.depth = this.surface.device.createTexture({
      label: 'flat.depth',
      size,
      format: DEPTH_FORMAT,
      /*
       * **The depth attachment carries the same sample count as the colour one.** WebGPU
       * requires every attachment in a pass to agree, and a depth buffer left at one sample
       * beside a four-sample colour target is rejected at `beginRenderPass` — which reads as
       * a depth problem and is a multisampling one.
       */
      sampleCount: this.samples,
      /*
       * **Bindable as well as an attachment**, because the composite reads it. Occlusion and
       * camera motion blur both want the frame's depth, and WebGPU has no multisample depth
       * resolve — so `postPass.ts` reads sample zero out of this with `textureLoad`, and a
       * texture that is only ever an attachment cannot be read at all.
       */
      usage: 0x10 | 0x4, // RENDER_ATTACHMENT | TEXTURE_BINDING
    });
    this.depthView = this.depth.createView();

    this.colorMsaa?.destroy();
    /*
     * Nothing to resolve at one sample, and nothing to resolve *into* under a composite either:
     * there the twin is `post.sceneColorMsaa` and this one would be a full-size four-sample
     * target that no pass ever opens. `compositeMsaa` is the single place that chooses.
     */
    if (this.samples === 1 || this.hasComposite) {
      this.colorMsaa = null;
      this.colorMsaaView = null;
      return;
    }
    this.colorMsaa = this.surface.device.createTexture({
      label: 'flat.colorMsaa',
      size,
      /* The world's format, which is the swap chain's only where the world reaches it. */
      format: this.pipelines.format,
      sampleCount: this.samples,
      usage: 0x10, // RENDER_ATTACHMENT
    });
    this.colorMsaaView = this.colorMsaa.createView();
  }

  /**
   * Upload the frame's geometry, build one mesh's buffers, and hand back a handle.
   *
   * Construction time, never per frame: `MeshData` arrays are the caller's and are uploaded
   * once. The pipeline is built here too, for the same reason — which attributes a mesh
   * supplied decides the vertex layout, so it is known now and never recomputed.
   */
  /**
   * Compile every pipeline this mesh can be drawn with, and say which key it draws under.
   *
   * Shared by the two `createMesh` entry points, because warming is decided by the *data* and
   * neither the pipeline set nor the key depends on whether the geometry lands in one call or
   * over six frames.
   */
  private warmFlatPipelines(data: MeshData): string {
    /*
     * **Every optional attribute, not the two that come to mind.** `present` decides where
     * each attribute sits in the interleaved buffer, and `createGpuMesh` decides the same
     * thing from the data itself. If the two disagree by one attribute, every field after it
     * is read from the wrong offset: the first version listed only `specular` and `uvs`, and
     * `dayClock` — which supplies `emissiveColor` — drew a fan of coloured spikes, because
     * positions were being read out of the middle of somebody else's vertex.
     */
    const present: Record<string, boolean> = {};
    let key = 'flat';
    for (const attribute of VERTEX_LAYOUT) {
      if (!attribute.optional) continue;
      const supplied = data[attribute.name as keyof MeshData] !== undefined;
      present[String(attribute.name)] = supplied;
      key += supplied ? `:${String(attribute.name)}` : '';
    }
    const fullKey = `${this.variant}|${key}`;
    /*
     * **For every target this mesh can land on, which is two when the overlay is its own.**
     *
     * A mesh drawn after `endFrame` — a portrait, a display piece case — goes into the pass reopened on
     * the canvas, and needs a pipeline built against that. Which meshes those are is the
     * consumer's business and unknowable here, so every mesh gets both: `submitMesh` throws on a
     * key the cache does not hold, and a mesh that has to compile on the frame it is first drawn
     * in is the per-frame allocation `PipelineCache` exists to prevent. `pipelineTargets` holds
     * one entry where the two agree, so the ordinary profile pays nothing for this.
     */
    /*
     * **Compiled off the main thread, and `renderer.ready()` is what waits for it.**
     *
     * These used to be built synchronously here, which reads as "built at construction time,
     * never inside a frame" and is only half true: `createRenderPipeline` returns before the
     * driver has compiled anything and leaves the shader to the first draw. So the cost landed
     * in the first frame after all, and on a phone that frame took five seconds with the whole
     * GPU queue stalled behind it. The async build resolves when the pipeline is genuinely
     * ready, so waiting for it is possible at all.
     */
    /* Kept so a draw that arrives before the compile finishes can still build its own. */
    this.meshPresent.set(fullKey, present);
    /*
     * **Only the target this mesh is actually going to be drawn on.**
     *
     * A mesh can land on two: the frame's own target, and the pass reopened on the canvas
     * after `endFrame` for overlay work. Which meshes those are is the consumer's business,
     * so every mesh used to get a pipeline for both — and where the two disagree on sample
     * count, that is two compiles per mesh instead of one, for a target most consumers never
     * draw to. Measured on a scene with no overlay meshes at all: 20 pipelines compiled where
     * 10 were used, and every one of them is translated and compiled fresh by Dawn on every
     * page load, with no driver shader cache behind it.
     *
     * So the second target is built on demand now. `submitMesh` builds what it is missing, and
     * a consumer that does draw overlay meshes pays one compile the first time rather than all
     * of them up front. `pipelineTargets` still holds one entry where the two agree, so the
     * ordinary profile is unchanged and pays nothing for this either way.
     */
    for (const pipelines of this.pipelineTargets.slice(0, 1)) {
      void flatPipelineAsync(
        pipelines,
        this.surface.device,
        this.bindGroupLayout,
        this.variant,
        fullKey,
        present,
      );
      /* Its blended twin, built here so `drawTranslucentMesh` never compiles inside a frame. */
      void flatPipelineAsync(
        pipelines,
        this.surface.device,
        this.bindGroupLayout,
        this.variant,
        `${fullKey}|blend`,
        present,
        true,
      );
      /*
       * And the skinned pair for a rigged mesh, whose draw key carries `|skin` and would otherwise
       * miss every pipeline warmed above — compiling inside the first frame that draws a
       * character, which is exactly what this block exists to prevent.
       */
      /*
       * The variants this mesh can actually take, warmed here so none compiles inside the first
       * frame that draws it. A mesh with both a rig and targets can be drawn four ways — the
       * caller may set a palette, weights, both or neither — so all four are warmed rather than
       * guessing which the scene will use.
       */
      const skinnable = data.joints !== undefined;
      const morphable = data.morphTargets !== undefined;
      for (const wantSkin of skinnable ? [false, true] : [false]) {
        for (const wantMorph of morphable ? [false, true] : [false]) {
          if (!wantSkin && !wantMorph) continue;
          const suffix = `${wantMorph ? '|morph' : ''}${wantSkin ? '|skin' : ''}`;
          for (const translucent of [false, true]) {
            void flatPipelineAsync(
              pipelines,
              this.surface.device,
              this.flatLayoutFor(wantSkin, wantMorph),
              this.variant,
              `${fullKey}${suffix}${translucent ? '|blend' : ''}`,
              present,
              translucent,
              wantSkin,
              wantMorph,
            );
          }
        }
      }
    }
    return fullKey;
  }

  /**
   * The pipeline key stapled to a mesh, on the mesh itself.
   *
   * **Not a spread**, which is what this was. `{ ...mesh, key }` copies the value a getter held
   * at that instant, so `complete` would have been frozen at whatever it was when the mesh was
   * made — false, for every incremental mesh, for ever, and nothing spread would ever have been
   * drawn. It also handed the caller a different object from the one the upload was filling.
   */
  private keyed(mesh: GpuMesh, fullKey: string): GpuMesh & { key: string } {
    const keyed = mesh as GpuMesh & { key: string };
    keyed.key = fullKey;
    return keyed;
  }

  createMesh(data: MeshData, options: MeshOptions = {}): GpuMesh {
    const fullKey = this.warmFlatPipelines(data);
    return this.keyed(createGpuMesh(this.surface.device, data, options.dynamic === true), fullKey);
  }

  /**
   * Geometry in, handle out — but the geometry lands over as many frames as the caller gives it.
   *
   * See `RendererApi.createMeshIncremental` for what this is for and what a caller may do with a
   * mesh that has not finished arriving. The iterator here adds the one thing the buffer code
   * cannot know about: **a lost device ends the upload.** An upload that spans frames can
   * straddle one, and going on writing to a dead device would raise validation errors a consumer
   * can do nothing about. Done with `complete` still false is the signal that it was abandoned.
   */
  createMeshIncremental(data: MeshData, options: MeshOptions = {}): IncrementalMeshHandle {
    const fullKey = this.warmFlatPipelines(data);
    const { mesh, upload } = createGpuMeshIncremental(
      this.surface.device,
      data,
      options.dynamic === true,
    );
    const surface = this.surface;
    return {
      mesh: this.keyed(mesh, fullKey),
      upload: {
        next(): IteratorResult<void, void> {
          if (surface.lost) return { done: true, value: undefined };
          return upload.next();
        },
      },
    };
  }

  /**
   * Rewrite a mesh's positions, and its normals where the caller has them.
   *
   * Refused in words on a mesh that did not declare itself dynamic, because the thing that makes
   * an update possible on this backend — the interleaved array the vertex data was built from —
   * is only kept when a consumer asked for it. See `GpuMesh.update`.
   */
  updateMesh(mesh: GpuMesh, positions: Float32Array, normals?: Float32Array): void {
    if (mesh.update === null) {
      throw new Error(
        'this mesh was not created with { dynamic: true }, so the interleaved vertex data it ' +
          'would be patched from was not kept. Say so at `createMesh` — the flag is what decides ' +
          'what is kept and what a buffer is hinted as.',
      );
    }
    mesh.update(this.surface.device, positions, normals);
  }

  /**
   * Settle everything the frame shares: the camera, the lights and the fog.
   *
   * Written into the fragment block at the offsets the generator computed, which is the one
   * place these numbers are stated. The vertex block's `uViewProj` is copied into every
   * draw's slot instead, because a dynamic-offset binding cannot mix per-frame and per-draw
   * data in one buffer.
   */
  bindMeshPass(camera: Camera, env: Environment): void {
    if (this.surface.lost) return;

    /* Corrected once a frame, not once a draw: every draw copies the same matrix. */
    mat4.multiply(this.correctedViewProj, CLIP_CORRECTION, camera.viewProjection);
    /*
     * The frame's own camera, copied rather than referenced because a caller moves its camera in
     * place. A mirror is skipped by the same guard the jitter uses: a mark belongs to the picture
     * the viewer sees, and bounding it through a mirrored camera puts it in the wrong half of the
     * screen.
     */
    if (!this.reflectionPassActive) {
      mat4.copy(this.frameRawViewProj, camera.viewProjection);
      /* The eye in world space, which the resolve's normals are turned to face. */
      this.reconEye.set(camera.position);
      this.frameEye.set(camera.position);
      /* Held for the medium's march, which runs long after every draw and needs the sun the
         frame was lit by. Referenced rather than copied, exactly as `renderer.ts` holds its
         `lastPassEnv`: a caller that mutates an environment mid-frame gets the mutation on both
         backends, which is one behaviour rather than two. */
      this.frameEnv = env;
      this.frameCameraSeen = true;
    }
    /*
     * **The jitter goes on the matrix that draws and never on the one that reprojects.** A mirror
     * is skipped by the same guard that skips it for motion blur: it is not the picture the
     * history holds, and jittering it would resolve a reflection against the viewer's frame.
     */
    /*
     * **Reconstruction jitters instead of the temporal resolve, never as well as it.** Both
     * accumulate a history out of a jittered sequence, and running them together would resolve the
     * frame twice — once at the render size and again at the output size, against a history whose
     * own frames had already been mixed. So this is a choice rather than a pair, reconstruction
     * wins where a consumer asked for both, and `temporalResolve` is skipped while it runs.
     *
     * Its sequence is its own: `reconJitterPhases` takes eight positions for every output pixel a
     * render pixel covers, where the temporal resolve's eight are enough at one to one.
     */
    this.reconstructing = this.reconstructionWanted && !this.reflectionPassActive;
    if (this.quality.reconstruction > 0 && this.samples > 1 && !this.reconMultisampleSaid) {
      this.reconMultisampleSaid = true;
      console.warn(RECONSTRUCTION_MULTISAMPLE_REFUSAL);
    }
    if (this.reconstructing) {
      /*
       * The offset `settleReconJitter` chose for the frame at `beginFrame`, applied here and not
       * advanced here: a frame binding its mesh pass twice is one frame of the sequence.
       *
       * **The y offset is negated on the way in, and that is not a preference.** This shifts the
       * *corrected* matrix, whose y `CLIP_CORRECTION` has already negated so that the negation
       * every generated vertex stage ends with cancels out — §3 row 56. So an offset added here
       * arrives on screen with its sign reversed, while x, which nothing negates, arrives as
       * given. The temporal resolve cannot see this because its shader never reads the offset; the
       * reconstruction reads it at every texel it unprojects, and a sign error there moves every
       * sample two jitters away from where the depth says it is.
       */
      this.viewProj = jitterProjection(
        this.jitteredViewProj,
        this.correctedViewProj,
        this.reconJitter[0] as number,
        -(this.reconJitter[1] as number),
        this.renderWidth,
        this.renderHeight,
      ) as Float32Array;
      this.temporalJittering = false;
      this.temporalHistoryUsable = false;
    }
    this.temporalJittering =
      !this.reconstructing &&
      this.quality.temporalAa &&
      this.quality.screenEffects &&
      !this.reflectionPassActive;
    if (this.temporalJittering) {
      /* The scene's size, not the drawing buffer's: the history is a picture of the render. */
      this.temporalHistoryUsable = this.temporalHistory.openFrame(
        this.renderWidth,
        this.renderHeight,
      );
      const [jx, jy] = jitterOffset(this.temporalHistory.frameIndex);
      this.temporalJitterX = jx;
      this.temporalJitterY = jy;
      /* A jitter is half a *render* texel, which is what the sequence is spread over. */
      this.viewProj = jitterProjection(
        this.jitteredViewProj,
        this.correctedViewProj,
        jx,
        jy,
        this.renderWidth,
        this.renderHeight,
      ) as Float32Array;
    } else if (!this.reconstructing) {
      this.temporalHistoryUsable = false;
      this.viewProj = this.correctedViewProj;
    }
    /*
     * The frustum, once a frame, and from the **uncorrected** matrix.
     *
     * `CLIP_CORRECTION` maps OpenGL's -1..1 depth onto WebGPU's 0..1, which is a fact about where
     * the pixels go and not about where the camera is. Extracting planes from the corrected
     * matrix gives a near plane in the wrong place, and the symptom is geometry culled just in
     * front of the eye — the one place a scene can least afford to lose any.
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

    const f = this.perFrameFloats;
    const i = this.perFrameInts;
    const at = (name: string): number => {
      const field = this.fragment.fields[name];
      if (field === undefined) throw new Error(`flat: no field ${name} in variant ${this.variant}`);
      return field.offset / 4;
    };

    f.set(env.directionalDir, at('uDirectionalDir'));
    f.set(env.directionalColor, at('uDirectionalColor'));
    f.set(env.ambient, at('uAmbient'));
    f.set(env.ambientGround ?? env.ambient, at('uAmbientGround'));
    f.set(camera.position, at('uCameraPos'));
    f[at('uOpacity')] = 1;
    /*
     * Lit and fogged by default, matching `renderer.ts` value for value: every draw before
     * `TranslucentMeshOptions` existed shaded and fogged, and an unwritten field here is
     * zero, which would silently flatten the whole world. `drawTranslucentMesh` overrides
     * these per draw through the material block, the same shape `uOpacity` already uses.
     */
    i[at('uLightingEnabled')] = 1;
    i[at('uFogEnabled')] = 1;
    i[at('uAlbedoEnabled')] = 0;

    /*
     * **The camera medium, which this pass did not upload until 2026-08-29.**
     *
     * `uFogEnabled` was set here and the medium behind it never was, so the mesh pass read
     * whatever the block happened to hold. Every other pass in this backend resolves and writes
     * it — plumes, film, lines, water — and WebGL2's `writeMeshPassState` calls `bindAtmosphere`
     * for exactly this reason, with a comment beside it saying an unwritten uniform is zero.
     *
     * What it looked like: a world in which every surface came out at full fog colour, or black
     * where the ramp inverted, while the sky and anything drawn by another pass stayed correct.
     * `uFogNear` and `uFogFar` at zero make `span` collapse to 1e-4, and the linear ramp
     * saturates at any distance past a tenth of a millimetre — so the failure was total rather
     * than subtle, and it hid behind scenes whose fog is off.
     *
     * Found by a voxel scene that is the first in the tree to use `fogMode: 'linear'` on WebGPU.
     */
    const meshMedium = resolveAtmosphere(
      env,
      this.atmosphereHeight(camera),
      this.quality.underwaterAtmosphere,
      this.medium,
    );
    f.set(meshMedium.fogColor, at('uFogColor'));
    f[at('uFogDensity')] = meshMedium.fogDensity;
    f[at('uFogHeightFalloff')] = meshMedium.fogHeightFalloff;
    f[at('uFogEyeY')] = meshMedium.fogEyeY;
    i[at('uFogMode')] = meshMedium.fogMode;
    f[at('uFogNear')] = meshMedium.fogNear;
    f[at('uFogFar')] = meshMedium.fogFar;
    f.set(meshMedium.underwaterColor, at('uUnderwaterColor'));
    f[at('uUnderwaterFogDensity')] = meshMedium.underwaterFogDensity;
    f[at('uUnderwaterFactor')] = meshMedium.underwaterFactor;
    /*
     * The mirror's half-space, and only while the mirror is being drawn.
     *
     * Without it the reflected pass draws the world *below* the water as well as above it, and
     * the pool fills with the underside of everything standing in it — which reads as the
     * reflection being wrong rather than as the clip being absent. The plane is written every
     * frame either way, because an unwritten one is four zeroes and `dot(p, 0) < 0` is false,
     * so the term would silently pass everything the first time somebody enabled it.
     */
    i[at('uClipEnabled')] = this.reflectionPassActive ? 1 : 0;
    f.set(this.reflection?.clipPlane ?? NO_CLIP_PLANE, at('uClipPlane'));

    /*
     * The material and grading terms, matching `renderer.ts` value for value.
     *
     * **Found by diffing the two `bindMeshPass` implementations' uniform lists**, rather than
     * one at a time — which is how `uEmissiveGain` sat at a hard-coded 1 while `dayClock`
     * computes it as `nightFactor² · 1.4` and therefore *zero* in daylight. Every lamp head in
     * the scene emitted at full strength at 10:21, and they were the worst pixels in the frame:
     * 139,140,82 on the other backend against 255,255,136 here.
     *
     * **An unwritten uniform is zero, and zero is a real value for most of these.** `uGrain`
     * multiplies a per-vertex material term, so leaving it unwritten did not weaken grain, it
     * switched grain off. That is the same failure the missing properties had — silence that
     * reads as a setting rather than as an omission.
     *
     * `uReliefCycles` is 60 because `renderer.ts` says 60. Nothing in either file explains the
     * number, so this is a copy and is marked as one; the two must move together.
     */
    f[at('uGrain')] = 1;
    f[at('uReflectivity')] = 0;
    /* 1, not 0: a multiplier's identity is one. See `setEnvironmentGain`. */
    f[at('uEnvironmentGain')] = 1;
    /*
     * **Only where the variant declares it.** The irradiance block lives inside the probe's own
     * `#if`, because it exists to be filled from a cube only that permutation has, so `at` throws
     * on those names in the eight variants without one — the same shape as `uNightEmissive` below.
     *
     * `renderer.ts` writes them unconditionally, where a missing GL location is a silent no-op.
     */
    if (this.probeEnabled) {
      /*
       * Where the probes stand: four uniforms whatever the probe count.
       *
       * **Nine spherical-harmonic coefficients used to sit here, one whole stride apart** — a
       * `vec3` in a uniform block aligns to sixteen bytes, so twenty-seven contiguous floats put
       * every coefficient after the first in the wrong place and produced a room lit by something
       * plausible rather than an error. They are gone with the readback that filled them: the
       * diffuse term is a level of the probe array now, and this backend no longer has a state
       * where the reflection is usable and the ambient has not landed.
       */
      const grid = this.probes;
      const origin = grid?.origin ?? WORLD_ORIGIN;
      const invSpacing = grid?.invSpacing ?? UNIT_STEP;
      const counts = grid?.counts ?? UNIT_STEP;
      const originAt = this.fragment.fields['uProbeGridOrigin'];
      if (originAt !== undefined) {
        const base = originAt.offset / 4;
        f[base] = origin[0];
        f[base + 1] = origin[1];
        f[base + 2] = origin[2];
      }
      const spacingAt = this.fragment.fields['uProbeGridInvSpacing'];
      if (spacingAt !== undefined) {
        const base = spacingAt.offset / 4;
        f[base] = invSpacing[0];
        f[base + 1] = invSpacing[1];
        f[base + 2] = invSpacing[2];
      }
      const countsAt = this.fragment.fields['uProbeGridCounts'];
      if (countsAt !== undefined) {
        const base = countsAt.offset / 4;
        f[base] = counts[0];
        f[base + 1] = counts[1];
        f[base + 2] = counts[2];
      }
      /* Which chain is bound, because the level and the weight both depend on it. */
      f[at('uEnvironmentPrefiltered')] = this.quality.environmentPrefilter ? 1 : 0;
    }
    /*
     * The ORM scales, whose base is 1 and not 0 — the value an unwritten uniform would hold.
     *
     * `uOrmEnabled` needs no line here: an unwritten int is zero, and zero is exactly "no map".
     * These three are the opposite case, the one this block's own header is about: a scale of
     * zero is a real and wrong value, so leaving them silent would not switch the map off, it
     * would read every channel as its floor the moment one was bound.
     */
    const ormScale = at('uOrmScale');
    f[ormScale] = 1;
    f[ormScale + 1] = 1;
    f[ormScale + 2] = 1;
    /* And the emissive scale, one for one with the paragraph above: it multiplies a glow. */
    const emissiveScale = at('uEmissiveScale');
    f[emissiveScale] = 1;
    f[emissiveScale + 1] = 1;
    f[emissiveScale + 2] = 1;
    f[at('uRelief')] = 0;
    f[at('uReliefCycles')] = 60;
    f[at('uTextureRelief')] = 0;
    f[at('uEmissiveGain')] = env.emissiveGain;
    f[at('uNightFactor')] = env.nightFactor;
    /*
     * **Only where the variant declares it**, because `at` throws on a name the permutation does
     * not hold and this term is compiled in by `nightEmissive` alone.
     *
     * `renderer.ts` writes it unconditionally — a missing GL location is a silent no-op — so it
     * was simply absent here, and absent means zero, which switches the whole night-side emissive
     * term off. Exactly the `uGrain` and `uEmissiveGain` failure a third time: a scene that asked
     * for the feature, compiled the permutation that has it, and got a value that reads as a
     * setting rather than as an omission.
     *
     * Found by diffing what each backend writes against the generated field list rather than by
     * looking at a picture, which is the audit the 2026-08-13 rule asks for.
     */
    if (this.quality.nightEmissive) f[at('uNightEmissive')] = env.nightEmissive ?? 0;
    f.set(env.highlightMin, at('uHighlightMin'));
    f.set(env.highlightMax, at('uHighlightMax'));
    f[at('uHighlightGain')] = env.highlightGain;
    /*
     * No grading here. `renderer.ts` grades in this pass only when there is no composite to do
     * it in; this backend has no composite yet, and adding one is its own row. Exposure is 1
     * rather than 0 for the same reason it is there: it is a multiplier, and an unwritten one
     * would be a black frame the day the transform is switched on.
     */
    /*
     * **Graded here, because there is nowhere else.**
     *
     * `renderer.ts` grades in the mesh pass only when it is the last one — with a scene target
     * the resolve applies the curve, and doing it twice is a curve applied to its own output.
     * This backend has no scene target, so this pass is always the last one and always grades.
     * It was pinned at `none` and 1, which meant a profile asking for `aces` got a linear
     * world and no indication that the option had not arrived.
     */
    /*
     * The probe, and only where the variant has one.
     *
     * **Guarded rather than unguarded, because `at()` throws by design.** A profile with no
     * probe compiles a *smaller* block with no `uEnvironmentEnabled` in it at all, and that
     * throw is right for a typo and wrong for a field the shader legitimately does not have.
     *
     * The flag is what stops an unfilled cube being sampled: what is in one before a bake is
     * whatever the driver left, and a car mirroring uninitialised memory is worse than a car
     * mirroring a gradient. `reflectionProbe.ts` makes the same point.
     *
     * **And off again while a bake is running**, which `renderer.ts` has always done and this
     * did not. The faces being drawn belong to the cube the bind group is holding, and WebGPU
     * says so rather than leaving it undefined: *"[Texture "probe.cube"] usage
     * (TextureBinding|RenderAttachment) includes writable usage and another usage in the same
     * synchronization scope"* — the encoder is invalidated and the entire bake is dropped.
     *
     * Only ever on the *second* bake, because `probeBaked` turns true at the end of the first,
     * which is why nothing met it: both scenes that ask for a probe gate their bake on a model
     * that is not in this checkout, so no bake had ever run twice. `demo/dev/probe.html` runs
     * it every frame.
     */
    if (this.probeEnabled) {
      const usable = this.probeBaked && !this.probePassActive;
      f[at('uEnvironmentEnabled')] = usable ? 1 : 0;
      f[at('uEnvironmentMaxLod')] = this.probeMaxLod;
      /*
       * The map's edge and the level the cosine convolution sits at. Two numbers where the cube
       * needed one: its chain ran to a single texel a face, so the top level was the log of the
       * face size, and the array's stops one level below the diffuse term.
       */
      f[at('uEnvironmentEdge')] = this.probeEdge;
      /* Off until the indirect pass fills the moment layers. See `quality.indirectLight`. */
      f[at('uProbeVisibilityEnabled')] = 0;
      f[at('uEnvironmentIrradianceLevel')] = irradianceLevelFor(this.probeEdge);
      f[at('uProbeGridAmbient')] = usable && this.probeAmbient ? 1 : 0;
    }
    /*
     * **Graded here only where this pass is the last one**, which is `renderer.ts`'s rule and
     * now true on both backends for the same reason: with a composite that keeps range, the
     * resolve applies the curve, and grading twice is a curve applied to its own output. With
     * `screenEffects` off, or on without `hdrScene`, the mesh pass writes what reaches the
     * canvas and grades as it always did.
     */
    i[at('uOutputTransform')] = this.gradeCode();
    f[at('uOutputExposure')] = this.gradeExposure();
    /* The projection occlusion needs, settled by the pass that has a camera. */
    this.frameProjection = camera.projection as Float32Array;

    /*
     * The point lights, scattered rather than copied.
     *
     * **A uniform block is not a tightly packed array and this is where that bites.** The
     * engine's light arrays hold three floats per position and one per radius, back to back;
     * std140 gives every array element its own sixteen-byte slot whatever it contains, so a
     * `float[10]` occupies 160 bytes and not 40. A straight `set` would lay ten lights across
     * the first two and a half, and the picture would be lights in the wrong places rather
     * than an error.
     *
     * The stride is read from the generated layout rather than written as 16 here, for the
     * reason `flatPass.ts` gives: a number restated is a number that can disagree.
     */
    const lights = resolvePointLights(env, this.quality.pointLightFalloff, this.lights);
    i[at('uLightCount')] = lights.count;
    i[at('uLightFalloff')] = lights.falloff;
    this.bindClusters(camera, env, f, i, at);
    scatterInto(f, this.fragment.fields['uLightPos'], lights.positions, 3);
    scatterInto(f, this.fragment.fields['uLightColor'], lights.colors, 3);
    scatterInto(f, this.fragment.fields['uLightRadius'], lights.radii, 1);
    scatterInto(f, this.fragment.fields['uLightSourceRadius'], lights.sourceRadii, 1);
    scatterInto(f, this.fragment.fields['uLightWeight'], lights.weights, 1);
    /*
     * The cone, written for every light. The shader reads these two arrays unconditionally,
     * because a point light's pair is what makes its term collapse to exactly 1 — so leaving them
     * unwritten is a uniform block holding zeros, which is a cone that admits nothing and a world
     * with every lamp switched off. The 2026-08-13 rule's fourth clause is precisely this: a
     * uniform added on one backend is bound on both in the same change.
     */
    scatterInto(f, this.fragment.fields['uLightDir'], lights.directions, 3);
    scatterInto(f, this.fragment.fields['uLightCone'], lights.coneCos, 2);
    scatterInto(f, this.fragment.fields['uLightIesProfile'], lights.iesProfiles, 1);
    scatterInto(f, this.fragment.fields['uLightIesAxis'], lights.iesAxes, 3);
    scatterInto(f, this.fragment.fields['uLightCookie'], lights.cookies, 1);
    f[at('uIesAtlasRows')] = this.iesRows;
    f[at('uIesPlaneCount')] = this.iesPlanes;
    f[at('uCookieTiles')] = this.cookieTiles;

    /*
     * The rectangular emitters. Bound on both backends in the same change, per the 2026-08-13
     * rule's fourth clause — and the count is what makes the whole thing free to a scene with
     * none, because the shader's loop breaks on it before reading an array.
     */
    const area = env.areaLights;
    i[at('uAreaLightCount')] = area?.count ?? 0;
    if (area !== null && area !== undefined && area.count > 0) {
      scatterInto(f, this.fragment.fields['uAreaLightPos'], area.positions, 3);
      scatterInto(f, this.fragment.fields['uAreaLightColor'], area.colors, 3);
      scatterInto(f, this.fragment.fields['uAreaLightRight'], area.right, 3);
      scatterInto(f, this.fragment.fields['uAreaLightUp'], area.up, 3);
      scatterInto(f, this.fragment.fields['uAreaLightSize'], area.sizes, 2);
      scatterInto(f, this.fragment.fields['uAreaLightTwoSided'], area.twoSided, 1);
    }

    /*
     * The medium, from the same resolver `renderer.ts` binds through.
     *
     * **Not writing these left the world with no aerial perspective at all**, because
     * `flat.ts` ends on `mix(lit, mediumColor(), fog)` and an unwritten `uFogDensity` is zero.
     * That reads as a backend whose distances are simply wrong rather than as a missing pass,
     * and it was the whole remaining difference on both scenes that reach a frame once the sky
     * was corrected.
     *
     * `resolveAtmosphere` rather than a second copy of the selection rules: the water and the
     * sky decide their medium the same way, and a backend that decided it differently is the
     * drift `bindAtmosphere` was written to prevent.
     */
    const medium = resolveAtmosphere(
      env,
      this.atmosphereHeight(camera),
      this.quality.underwaterAtmosphere,
      this.medium,
    );
    f.set(medium.fogColor, at('uFogColor'));
    f[at('uFogDensity')] = medium.fogDensity;
    f[at('uFogHeightFalloff')] = medium.fogHeightFalloff;
    f[at('uFogEyeY')] = medium.fogEyeY;
    i[at('uFogMode')] = medium.fogMode;
    f[at('uFogNear')] = medium.fogNear;
    f[at('uFogFar')] = medium.fogFar;
    f.set(medium.underwaterColor, at('uUnderwaterColor'));
    f[at('uUnderwaterFogDensity')] = medium.underwaterFogDensity;
    f[at('uUnderwaterFactor')] = medium.underwaterFactor;

    /*
     * The shadow terms, matching what `renderer.ts` binds at default quality.
     *
     * `uLightViewProj` goes into the *vertex* block rather than here — the vertex stage is
     * what projects a fragment into light space — so it is written per draw beside the
     * model matrix, and this half is only the filtering and the falloff.
     *
     * `uShadowStrength` is the scene's own and not a constant: `dayClock` fades it from 0.42 to
     * 0.9 across the cycle and `renderer.ts` binds exactly this field, so the 1 that used to be
     * here drew shadows the WebGL2 path never draws and would have charged the difference to
     * the backend.
     */
    i[at('uShadowFilterTaps')] = this.quality.shadowFilterTaps;
    /*
     * **Guarded, because six of these exist only in the shadow permutations.**
     * `at()` throws on a field the variant does not declare, which is the right answer for a
     * typo and the wrong one for a profile that legitimately compiled a smaller block — and
     * this runs in the frame loop, where `AGENTS.md` allows no throw at all. `renderer.ts`
     * writes them unconditionally and `uniformLocations` swallows the miss; here the
     * condition has to be said out loud, and it is the same one that chose the variant.
     */
    if (this.quality.directionalShadows) {
      f[at('uShadowStrength')] = env.shadowStrength;
      f[at('uShadowMapSize')] = this.quality.directionalShadowMapSize;
      f[at('uShadowDepthSpan')] = env.shadowDepthSpan;
      f[at('uShadowMaxDistance')] = this.quality.directionalShadowMaxDistance;
      f[at('uShadowMaxSlope')] = this.quality.directionalShadowMaxSlope;
      /* Sampled only where a pass filled it — see `peelFilled` for why existing is not enough. */
      i[at('uPeeledShadowEnabled')] = this.peelFilled ? 1 : 0;
    }

    /*
     * **No point light has a cubemap yet, and −1 is how the shader is told so.**
     *
     * `flat.ts` chooses a map with a chain of `i == uPointShadowIndex[k]`, and its own comment
     * says the arms cannot be eliminated because nothing proves at compile time that every
     * index is −1. So the sentinel is −1, and **zero is a valid index meaning light 0** — the
     * shape the 2026-08-13 rule is about. Leaving the array unwritten would have handed light
     * zero of every scene the contents of an empty stand-in cube and called it occlusion, on
     * the frame this permutation was first compiled.
     *
     * `uPointShadowWeight` is the second guard and is zero for the same reason: it is how
     * present a cubemap is, so a zero says "not present" even if an index ever matched.
     * Row 3 replaces both with the pool's real answers.
     */
    if (this.pointShadowsCompiled) {
      /*
       * **The pool's answers, or −1 everywhere when there is no pool.**
       *
       * `flat.ts` reads `uPointShadowLayer[i]` and samples where it is not negative, and −1 is
       * the sentinel that matches nothing. Zero is a *valid* layer — a live transition map — so
       * an unwritten array is not "no point shadows" but every light in every scene reading
       * layer zero. That is why the arrays are written on both paths. It was a slot index and
       * the same trap, with a milder failure: slot zero was often empty where layer zero is
       * always allocated.
       */
      const resolved = this.pointShadows === null ? null : this.resolvedPointShadows;
      if (resolved === null) {
        this.clearShadowSelection(f, i, 'uPointShadowLayer', 'uPointShadowWeight');
        this.clearShadowSelection(f, i, 'uLivePointShadowLayer', 'uLivePointShadowWeight');
      } else {
        this.writeShadowSelection(f, i, 'uPointShadow', resolved.layers, resolved.presence);
        /*
         * A `vec4` row carrying the bake origin and the far plane, so `scatterInto` rather than
         * `writeShadowParams` — it reads the stride out of the generated layout instead of
         * counting rows, which is what AGENTS.md's 2026-09-20 alignment rule asks for.
         */
        scatterInto(f, this.fragment.fields['uPointShadowProjection'], resolved.projections, 4);
        this.writeShadowParams(f, 'uPointShadowNear', resolved.near);
        this.writeShadowParams(f, 'uPointShadowSize', resolved.sourceRadius);
        this.writeShadowSelection(
          f,
          i,
          'uLivePointShadow',
          resolved.liveLayers,
          resolved.liveWeights,
        );
        scatterInto(
          f,
          this.fragment.fields['uLivePointShadowProjection'],
          resolved.liveProjections,
          4,
        );
        this.writeShadowParams(f, 'uLivePointShadowNear', resolved.liveNear);
        this.writeShadowParams(f, 'uLivePointShadowSize', resolved.liveSourceRadius);
      }
      /*
       * The rectangles' layers, written on both paths for the reason above: −1 is the sentinel
       * that matches nothing and layer *zero* is a real layer, so an unwritten array is not "no
       * area shadows" but every rectangle in every scene reading the first live transition map.
       *
       * Bound in the same change as the WebGL2 side, per the 2026-08-13 rule's fourth clause —
       * which the shared surface cannot enforce here: `updatePointShadows` grew an *optional*
       * parameter, and a function that ignores it is still assignable to one that takes it. The
       * compiler catches a missing method and never a missing argument.
       */
      const areas = this.areaShadows === null ? null : this.resolvedAreaShadows;
      if (areas === null) {
        this.clearShadowSelection(f, i, 'uAreaShadowLayer', 'uAreaShadowWeight');
        this.clearShadowSelection(f, i, 'uLiveAreaShadowLayer', 'uLiveAreaShadowWeight');
      } else {
        this.writeShadowSelection(f, i, 'uAreaShadow', areas.layer, areas.weight);
        this.writeShadowParams(f, 'uAreaShadowFar', areas.far);
        this.writeShadowParams(f, 'uAreaShadowNear', areas.near);
        this.writeShadowSelection(f, i, 'uLiveAreaShadow', areas.liveLayer, areas.liveWeight);
        this.writeShadowParams(f, 'uLiveAreaShadowFar', areas.liveFar);
        this.writeShadowParams(f, 'uLiveAreaShadowNear', areas.liveNear);
      }
    }

    /*
     * The pass's own material is the base every setter patches, so opening a pass reopens the
     * block rather than uploading it: the next draw takes the slot. `renderer.ts` resets the
     * same terms here, which is why a pass cannot inherit a material from the one before it.
     */
    this.materials.dirty();
    /* A pass starts with no material, exactly as `renderer.ts` resets these terms. */
    this.albedo = null;
    this.bindGroup = this.blankAlbedoBindGroup;
    this.uvScale[0] = 1;
    this.uvScale[1] = 1;
  }

  /**
   * The slot the next draw's material lives in, taking a new one when something dirtied it.
   *
   * **A copy per material change, not per draw.** A scene drawing a hundred meshes of one
   * material spends one slot and one copy; a scene switching material every draw spends one
   * each, which is what it asked for.
   */
  private materialSlotForDraw(): number | null {
    if (this.materials.open) return this.materials.slot;
    const slot = this.perFrame.allocate();
    if (slot === null) {
      if (!this.warnedMaterialsFull) {
        this.warnedMaterialsFull = true;
        console.warn(
          `WebGPU: more than ${MAX_MATERIALS_PER_FRAME} material changes in a frame; the draws asking for the rest are skipped. renderer.frameBudget names the line and the count.`,
        );
      }
      return null;
    }
    this.perFrame.writeBlock(slot, this.perFrameInts);
    this.materials.slot = slot;
    return slot;
  }

  /** Said once rather than every frame, for the reason `warnedFull` gives. */
  private warnedMaterialsFull = false;

  /**
   * Draw one mesh.
   *
   * Takes a slot from the ring for its own model matrix and tint, so that draws do not
   * overwrite each other's uniforms — see `UniformRing` for why a single buffer cannot work.
   */
  /**
   * `depthLayer` reaches a pipeline here, where it used to be accepted and dropped.
   *
   * It was `_depthLayer` for as long as this backend has existed: the parameter was on the
   * interface, the other backend honoured it, and a consumer that declared which of two fused
   * surfaces should win got the answer on WebGL2 and a per-pixel coin toss here — with nothing
   * failing and nothing in the parity ledger saying so.
   */
  drawMesh(
    mesh: GpuMesh,
    model: ArrayLike<number>,
    depthLayer = 0,
    tint: Vec3 | null = null,
    /** Where it was last frame. See `RendererApi.drawMesh`, and `runMotion` for what reads it. */
    previousModel: ArrayLike<number> | null = null,
  ): void {
    /*
     * Skipped where the flag asks and the bounds say so.
     *
     * **Only the draw is saved, and that is the smaller half.** A caller has already paid for
     * the model matrix, whatever animation produced it and any material state it set, and none
     * of that can be recovered from here — `visible` exists so a consumer can skip all of it.
     * What this saves is the GPU's share, which for a heavy mesh is most of the cost and for a
     * trivial one is very little.
     */
    if (this.quality.cullDraws && !this.visible(mesh.bounds, model as ReadonlyMat4)) return;
    /*
     * And the other half of the same question, where the profile asked for one. Gated on
     * `cullDraws` alongside the frustum test, because both are the renderer doing a consumer's
     * culling for it and a consumer that culls its own wants neither. `occluded` answers false
     * whenever anything is uncertain, so a scene that declared no occluders draws exactly as it
     * did before.
     */
    if (this.quality.cullDraws && this.occluded(mesh.bounds, model as ReadonlyMat4)) return;
    /*
     * Recorded after the two culls rather than before: a mesh the frame does not draw writes no
     * depth, so a motion pass drawing it would either be depth-rejected everywhere — wasted — or,
     * where it happened to pass, write motion for a surface no pixel of the frame belongs to.
     */
    if (previousModel !== null) this.recordMotion(mesh, model, previousModel);
    this.submitMesh(mesh, model, tint, 1, false, { depthLayer });
  }

  /**
   * Draw a mesh that lets the world through, at `opacity`.
   *
   * Its own pipeline rather than a blend toggle, because WebGPU bakes blend state into one —
   * see `flatPipeline`. `uOpacity` is material state like every other term the shader reads per
   * draw, so it takes a material slot and is put back afterwards; `renderer.ts` restores it to
   * 1 for the same reason.
   *
   * `options` turns lighting and fog off independently, without a second pipeline: see
   * `TranslucentMeshOptions` and `submitMesh` for how each rides the same material slot
   * `uOpacity` already uses. Both default to `true`, so this reads identically for every call
   * site that predates the parameter.
   */
  /**
   * Mark whatever the depth buffer holds inside a projector's box.
   *
   * The WebGL2 renderer's own `drawDecal` carries what this is for and what it costs; the two
   * record the same thing and draw it in the same place in the frame. Silently nothing where the
   * profile has no screen effects, since there is then no resolved depth to read.
   */
  drawDecal(projector: DecalProjector): void {
    if (this.surface.lost) return;
    this.decalQueue.record(projector);
  }

  /**
   * Reflect what the frame drew, in the surfaces inside a box.
   *
   * The WebGL2 renderer's own `drawReflection` carries what this is for and what it cannot do; the
   * two record the same thing and trace it in the same place in the frame.
   */
  drawReflection(surface: ReflectiveSurface): void {
    if (this.surface.lost) return;
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

  /**
   * Said once, not per frame, where this renderer cannot read the depth a mark is decided from.
   *
   * **Called from `endFrame` as well as from the pass, and that is not belt and braces.** A
   * profile with no screen effects never opens a composite at all, so `runDecals` is never reached
   * and the marks would be dropped in silence — while the other backend, whose decal block sits in
   * its own `endFrame`, says so. One backend explaining itself and the other not is the
   * disagreement the parity rule exists to prevent, and it is what the first run of
   * `scripts/decal-check.mjs` caught here.
   */
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
   * **The comment above the decision has claimed since the effect shipped that it "says so once",
   * and for two releases nothing did.** Both are switches on a graphics screen, so a player
   * turning antialiasing on turns this off — and a quality setting that is enabled and does
   * nothing is the fault this engine has now shipped under three other names. `refuseDecals`
   * carries the argument for why the *other* backend saying it and this one not is worse than
   * neither saying it; the words are `OIT_MULTISAMPLE_REFUSAL`, which both backends read rather
   * than each keeping a copy.
   */
  private refuseOitMultisampled(): void {
    if (this.oitMultisampleRefused) return;
    this.oitMultisampleRefused = true;
    console.warn(OIT_MULTISAMPLE_REFUSAL);
  }

  drawTranslucentMesh(
    mesh: GpuMesh,
    model: ReadonlyMat4,
    opacity: number,
    options: TranslucentMeshOptions = {},
  ): void {
    if (opacity <= 0) return;

    /*
     * **Recorded rather than drawn**, when the effect is on and this is not already the replay.
     * Everything is copied — see `TranslucentQueue`, and the scratch matrix that made it necessary.
     */
    if (this.oitActive && !this.oitReplaying) {
      this.translucentQueue.record(mesh, model, opacity, options);
      return;
    }

    /* The tint travels in the options here, where `drawMesh` takes it positionally — see
       `TranslucentMeshOptions.tint` for why, and for the fade it was added for. */
    this.submitMesh(
      mesh,
      model as ArrayLike<number>,
      options.tint ?? null,
      Math.min(opacity, 1),
      true,
      options,
    );
  }

  /**
   * @param blend Which of the two entry points above this came through, and **not** something to
   * infer from `opacity`.
   *
   * `outColor.a` is `uOpacity * coverage`, and `coverage` is the bound texture's own alpha. So a
   * caller passing an opacity of 1 to `drawTranslucentMesh` is not saying *opaque*, it is saying
   * *the shape is in the image*: a caption, a decal, a painted shadow, a glow. Reading that as
   * opaque takes the unblended pipeline, and then every texel the cutout kept is written at full
   * strength — the soft edge of a blurred shadow lands as a solid slab bounded by the cutout's
   * iso-contour. One consumer's cover visualiser drew its caption that way: a hard black outline
   * around every letter, and none in the same frame on `?backend=webgl2`.
   *
   * The other backend has no way to make this mistake, and that is the parity being kept rather
   * than a new rule: `renderer.ts` enables `BLEND` on the way into `drawTranslucentMesh` and
   * disables it on the way out, without ever consulting the number.
   *
   * @param options `drawMesh` passes only `depthLayer` and takes the `bindMeshPass` default of
   * lit and fogged for the rest. `uLightingEnabled`/`uFogEnabled` are material
   * state exactly like `uOpacity` above them — dirtied while they differ from the default and
   * restored unconditionally afterward, whether or not a material slot was available for this
   * particular draw to use them. Never a pipeline permutation.
   */
  private submitMesh(
    mesh: GpuMesh,
    model: ArrayLike<number>,
    tint: Vec3 | null,
    opacity: number,
    blend: boolean,
    options: TranslucentMeshOptions = {},
  ): void {
    if (!this.canDraw() || this.viewProj === null) return;
    /* Geometry that has not all arrived is not drawn. See `GpuMesh.complete`. */
    if (!mesh.complete) return;

    const slot = this.perDraw.allocate();
    if (slot === null) {
      if (!this.warnedFull) {
        this.warnedFull = true;
        console.warn(
          `WebGPU: more than ${MAX_DRAWS_PER_FRAME} draws in a frame; the rest are skipped`,
        );
      }
      return;
    }

    this.perDraw.writeFloats(slot, FLAT_VERT_FIELDS.uViewProj.offset, this.viewProj);
    this.perDraw.writeFloats(slot, FLAT_VERT_FIELDS.uModel.offset, model);
    this.perDraw.writeFloats(slot, FLAT_VERT_FIELDS.uTint.offset, tint ?? WHITE);
    /* The frame's wind, for a mesh carrying a sway lane. Written on this path and not the
       instanced one, which declares none of these fields. */
    this.writeWind(slot);
    /* The material's repeats, not a constant: geometry authored in metres is textured at
       whatever density the material asks for without rebuilding it. */
    this.perDraw.writeFloats(slot, FLAT_VERT_FIELDS.uUvScale.offset, this.uvScale);
    this.perDraw.writeFloats(slot, FLAT_VERT_FIELDS.uLightViewProj.offset, this.lightViewProj);
    /*
     * Whether this mesh's tangent frame is real. WebGPU has no disabled attribute, so location 10
     * is always backed — by the caller's data or by the constant buffer — which makes the binding
     * indistinguishable from a real frame. `buffers.ts` carries the fact beside the mesh instead.
     */
    this.perDraw.writeInt(slot, FLAT_VERT_FIELDS.uHasTangents.offset, mesh.hasTangents ? 1 : 0);

    /*
     * The uniform is about the *number* and the pipeline is about the *pass*: a translucent draw
     * at 1 still blends, and there is nothing to dim while it does.
     *
     * Written directly into the scratch arrays rather than through `material()`'s callback.
     * That wrapper exists for the public setters (`setSurfaceReflectivity` and its siblings),
     * which change per *material* and are cheap to allocate a closure for; this runs on every
     * dimmed, unlit or unfogged *draw*, which the six components queued behind this task turn
     * into a high-frequency call — the closure `material((f) => {...})` used to allocate here is
     * exactly the hot-path cost `AGENTS.md` rules out, and this method already has direct field
     * access, being inside the same class `material()` is.
     */
    const dimmed = opacity < 1;
    if (dimmed) {
      this.perFrameFloats[this.materialField('uOpacity')] = opacity;
      /* Material state exactly like `uOpacity`, dirtied for the accumulation pass and restored
         below — the revealage pass draws with it at zero and its colour multiplied away. */
      this.perFrameFloats[this.materialField('uOitWeighted')] = this.oitMode === 'accum' ? 1 : 0;
    }
    /* Same shape as `dimmed`: a slot is only worth taking when either differs from the default
       `bindMeshPass` already wrote, and both are put back together once the draw is submitted. */
    const lit = options.lit ?? true;
    const fog = options.fog ?? true;
    const toneMapped = options.toneMapped ?? true;
    const unlitOrUnfogged = !lit || !fog;
    if (unlitOrUnfogged) {
      if (!lit) this.perFrameInts[this.materialField('uLightingEnabled')] = 0;
      if (!fog) this.perFrameInts[this.materialField('uFogEnabled')] = 0;
    }
    /* `1` is sRGB alone: the conversion without the curve. `Math.min` rather than a literal, so
       a renderer asked for `none` stays at none. See `TranslucentMeshOptions.toneMapped`. */
    if (!toneMapped) {
      this.perFrameInts[this.materialField('uOutputTransform')] = Math.min(this.gradeCode(), 1);
    }
    /*
     * **Refraction, and the snapshot it reads is taken here or the draw does not refract.**
     *
     * `takeRefractSnapshot` ends and reopens the pass, so it runs before anything about this draw
     * is recorded — and it refuses inside a mirror or a probe bake, where ending the pass would
     * throw away what that pass had drawn. A refusal leaves the strength at zero, so the draw
     * shades as an ordinary translucent one rather than sampling a texture holding the frame
     * before last. That is the defined state the two-backends rule asks for.
     */
    const refraction = options.refraction ?? 0;
    const refracting = refraction > 0 && this.takeRefractSnapshot();
    if (refracting) {
      this.perFrameFloats[this.materialField('uRefractStrength')] = refraction;
      const refractTint = options.refractTint;
      const tintAt = this.materialField('uRefractTint');
      this.perFrameFloats[tintAt] = refractTint?.[0] ?? 1;
      this.perFrameFloats[tintAt + 1] = refractTint?.[1] ?? 1;
      this.perFrameFloats[tintAt + 2] = refractTint?.[2] ?? 1;
      this.perFrameFloats[this.materialField('uRefractThickness')] = options.thicknessM ?? 0;
    }
    /* Taken for itself when any of those differs from the pass, and put back below: the rule both
       backends count material changes by. See `materialChanges.ts`. */
    const own = ownsMaterial({ opacity, lit, fog, toneMapped, refracting });
    if (own) this.materials.dirty();
    const base = (mesh as GpuMesh & { key?: string }).key ?? 'flat:s0:u0';
    /*
     * A rigged mesh takes the skinned vertex variant, an unrigged one the plain variant, and the
     * key carries the flag so the two never share a cached pipeline. A rigged mesh whose caller
     * set no palette falls back to the plain variant rather than binding a layout with nothing in
     * its palette slot: a bind group missing an entry its layout declares is a validation failure
     * at `submit`, which takes the whole command buffer with it and draws no frame at all.
     */
    const skinned = this.skinPaletteSlot >= 0 && mesh.isSkinned;
    const morphed = this.morphWeights !== null && mesh.morph !== null;
    const deltas = morphed && mesh.morph !== null ? mesh.morph.view() : null;
    const keyed = `${base}${morphed ? '|morph' : ''}${skinned ? '|skin' : ''}`;
    /*
     * Depth writing and the overlay layer are pipeline state on this backend, so they belong in
     * the key: two draws of one mesh differing only in these would otherwise share a cached
     * pipeline and the second would silently take the first one's depth behaviour.
     *
     * **Both suffixes are empty for the defaults**, which is what keeps the keys `createMesh`
     * warms — `fullKey` and `${'`'}${'$'}{fullKey}|blend${'`'}` — the ones an ordinary draw still asks for. A
     * caller that opts in pays one compile on its first draw, the same bargain the overlay
     * pipelines above already make.
     */
    const depthWrite = options.depthWrite ?? true;
    const layer = Math.min(Math.max(Math.round(options.depthLayer ?? 0), 0), MAX_DEPTH_LAYER);
    const key =
      `${keyed}${blend ? '|blend' : ''}` +
      `${depthWrite ? '' : '|nodepth'}${layer > 0 ? `|dl${layer}` : ''}` +
      /* The two order-independent buffers are two formats and two blend states, so a draw into
         one must never share a cached pipeline with the same mesh drawn into the other. */
      `${this.oitMode === 'none' ? '' : `|oit${this.oitMode}`}`;

    /*
     * The morph uniforms, written only for a morphed draw and read from the *morphed* variant's
     * field table. `FLAT_VERT_FIELDS` is the plain variant's and does not name them at all — every
     * field the two share keeps its offset, which is what `flat/index.ts` declares morph's uniforms
     * last for, but the morph fields exist only in the larger block.
     */
    if (morphed && mesh.morph !== null && this.morphWeights !== null) {
      const fields = flatVertexBindings(skinned, true).fields;
      this.perDraw.writeFloats(slot, fields.uMorphWeights.offset, this.morphWeights);
      this.perDraw.writeInt(slot, fields.uMorphTargetCount.offset, mesh.morph.targetCount);
      this.perDraw.writeInt(slot, fields.uMorphTextureWidth.offset, mesh.morph.width);
    }
    /*
     * **Asynchronous by default, synchronous if it has to be, and never absent.**
     *
     * `createMesh` compiles off the main thread, so a draw can legitimately arrive before the
     * driver has finished — a consumer that awaits `ready()` never sees this, and one that
     * draws immediately gets the old behaviour rather than an exception. Correctness cannot be
     * allowed to depend on which of those happened, so the miss builds the pipeline here and
     * pays the compile it was trying to avoid. That is a slow frame; the alternative is a
     * thrown error in the middle of one.
     */
    const pipelines = this.targetPipelines();
    let pipeline = pipelines.peek(key);
    if (pipeline === undefined) {
      const present = this.meshPresent.get(base);
      if (present === undefined) {
        throw new Error(`WebGPU: no pipeline for ${key}; createMesh builds it`);
      }
      pipeline = flatPipeline(
        pipelines,
        this.surface.device,
        this.flatLayoutFor(skinned, morphed),
        this.variant,
        key,
        present,
        blend,
        skinned,
        morphed,
        depthWrite,
        layer,
        false,
        this.oitMode,
      );
    }

    /*
     * Guards the draw call only, not the restore below.
     *
     * `materialSlotForDraw` returns null once `MAX_MATERIALS_PER_FRAME` is exhausted, and an
     * early `return` here used to skip the restore too — which left `uOpacity`,
     * `uLightingEnabled` and `uFogEnabled` dirtied in `perFrameFloats`/`perFrameInts` for the
     * rest of the frame, since that scratch block is cumulative state shared by every draw
     * after this one. A single draw hitting the cap partway through a frame would then have
     * rendered every later draw unlit, unfogged and undimmed regardless of what it asked for —
     * ordinary lit opaque geometry included. `dimmed` had the identical shape from the original
     * commit; nothing shipping passes `{ lit: false }` yet, so it never fired, but the scene
     * this capability exists for (39 cover quads at four frame boxes each, the histogram bars,
     * the glow shells, the backdrop planes, the bodies, the asteroids, the star) is already
     * close to the 256-slot budget before the gateway, the play controls, the waveform, the
     * label handles and the sparkles are even counted.
     */
    const material = this.materialSlotForDraw();
    if (material !== null) {
      /*
       * Record rather than issue. Every per-draw value is already in `slot` and `material` —
       * the uniform rings are the state arena this design would otherwise have had to build —
       * so the command carries them as its two dynamic offsets.
       */
      const command = this.recordDraw(0, this.currentTarget());
      if (command !== null) {
        command.pipeline = pipeline;
        command.bindGroup = this.flatBindGroupFor(skinned, morphed, deltas);
        command.offsetA = slot;
        command.offsetB = material;
        command.offsetCount = 2;
        for (let index = 0; index < mesh.vertexBuffers.length; index++) {
          command.vertexBuffers[index] = mesh.vertexBuffers[index] as GPUBuffer;
        }
        command.vertexCount = mesh.vertexBuffers.length;
        command.indexBuffer = mesh.indexBuffer;
        command.indexed = true;
        command.count = mesh.indexCount;
      } else {
        const pass = this.openPass();
        if (pass === null) return;
        pass.setPipeline(pipeline);
        pass.setBindGroup(0, this.flatBindGroupFor(skinned, morphed, deltas), [slot, material]);
        for (let index = 0; index < mesh.vertexBuffers.length; index++) {
          pass.setVertexBuffer(index, mesh.vertexBuffers[index] as GPUBuffer);
        }
        pass.setIndexBuffer(mesh.indexBuffer, 'uint32');
        pass.drawIndexed(mesh.indexCount);
      }
    }
    /* Back to the defaults for whatever is drawn next, exactly as `renderer.ts` restores them —
       unconditionally, because the scratch state above is shared by every draw after this one
       whether or not this one found a slot to draw with. */
    if (dimmed) {
      this.perFrameFloats[this.materialField('uOpacity')] = 1;
      this.perFrameFloats[this.materialField('uOitWeighted')] = 0;
    }
    if (unlitOrUnfogged) {
      if (!lit) this.perFrameInts[this.materialField('uLightingEnabled')] = 1;
      if (!fog) this.perFrameInts[this.materialField('uFogEnabled')] = 1;
    }
    if (refracting) {
      /* Back to off for every other draw in the frame, exactly as `uOpacity` is: this scratch is
         shared, so a strength left set is worn by everything drawn after it. */
      this.perFrameFloats[this.materialField('uRefractStrength')] = 0;
    }
    if (!toneMapped) {
      this.perFrameInts[this.materialField('uOutputTransform')] = this.gradeCode();
    }
    if (own) this.materials.dirty();
  }

  /** Release geometry. */
  disposeMesh(mesh: GpuMesh): void {
    mesh.dispose();
  }

  /* -- Instanced meshes --------------------------------------------------------------- */

  /**
   * Attach per-instance placement to a mesh already on the device.
   *
   * One batch per mesh is not enforced here — this backend could hold several, since the
   * instance buffer is bound per draw rather than baked into a vertex array — but it is refused
   * anyway, because WebGL2 *cannot* and a capability one backend has and the other does not is
   * the shape this repository spent a week removing.
   */
  createInstanced(mesh: GpuMesh, capacity: number): GpuInstancedBatch {
    /*
     * **A skinned mesh cannot be instanced, and the reason is the vertex layout rather than the
     * shader.** An instanced pipeline reclaims locations 11 and 12 from the joint indices and
     * weights; a mesh that supplies them interleaves them, so dropping them would shift the
     * stride under every other attribute and draw scrambled geometry. An unskinned mesh carries
     * both as constants, where removing them costs nothing.
     */
    if (mesh.isSkinned) {
      throw new Error(
        'WebGPU: a skinned mesh cannot be instanced — an instanced pipeline takes the two ' +
          'attribute locations the joint indices and weights occupy, and this mesh supplies them.',
      );
    }
    /*
     * **And a channelled mesh cannot, for the same arithmetic one location along.** The per-vertex
     * channel sits at 13, which an instanced pipeline spends on `aInstanceModel2`; the INSTANCED
     * shader variant declares no `aChannel` at all. `InstancedMesh` on the other backend has
     * refused this since the channel landed and this did not, which is the one-backend capability
     * the two-backends rule forbids — and worse than a missing error, because `vertexBufferLayouts`
     * would then be asked to drop an attribute this mesh interleaves.
     */
    if (mesh.hasChannel) {
      throw new Error(
        'WebGPU: this mesh carries a per-vertex channel, which needs attribute location 13, and ' +
          'an instanced draw already spends 11 through 15 on its transform and tint. Draw it as ' +
          'an ordinary mesh, or drop the channel — the sway, sky and alpha lanes cannot reach an ' +
          'instanced pipeline.',
      );
    }
    if (this.instanced.has(mesh)) {
      throw new Error(
        'WebGPU: this mesh already has an instanced batch — a mesh may have one, because the ' +
          "other backend binds the attributes to the mesh's own vertex array.",
      );
    }
    const batch = new GpuInstancedBatch(
      this.surface.device,
      mesh,
      capacity,
      `flat.instances:${(mesh as GpuMesh & { key?: string }).key ?? 'mesh'}`,
    );
    this.instanced.set(mesh, batch);
    return batch;
  }

  /** Which meshes already carry a batch, so a second is refused rather than silently shared. */
  private readonly instanced = new Map<GpuMesh, GpuInstancedBatch>();

  /** Push placement and colour. Only the live prefix; see `GpuInstancedBatch.upload`. */
  uploadInstanced(batch: GpuInstancedBatch, data: MeshInstances): void {
    if (this.surface.lost) return;
    batch.upload(this.surface.device.queue, data);
  }

  /** Draw every live instance, opaque. */
  drawInstanced(batch: GpuInstancedBatch, data: MeshInstances): void {
    this.submitInstanced(batch, data, 1, false, {});
  }

  /** Draw every live instance, blended. See `drawTranslucentMesh` for what the options mean. */
  drawTranslucentInstanced(
    batch: GpuInstancedBatch,
    data: MeshInstances,
    opacity: number,
    options: TranslucentMeshOptions = {},
  ): void {
    this.submitInstanced(batch, data, opacity, true, options);
  }

  /** Release the placement. The mesh is the caller's and is not released. */
  disposeInstanced(batch: GpuInstancedBatch): void {
    this.instanced.delete(batch.mesh);
    batch.dispose();
  }

  /**
   * One draw, one material slot, one uniform slot, however many instances.
   *
   * **The uniform slot carries only what the instanced block declares.** That variant has no
   * `uModel` and no `uTint` — they arrive as attributes — so this writes the four fields the two
   * variants share and nothing else. Their offsets are identical by construction and
   * `flatPass.ts` asserts it; writing `uModel`'s plain offset here would land in a part of the
   * slot the shader does not read, which is harmless and still wrong to do.
   *
   * **What it gives up** against `drawMesh` is skinning and morphing, refused where the variant
   * is built, and a per-instance opacity: `opacity` here dims the whole batch.
   */
  private submitInstanced(
    batch: GpuInstancedBatch,
    data: MeshInstances,
    opacity: number,
    blend: boolean,
    options: TranslucentMeshOptions,
  ): void {
    if (!this.canDraw() || this.viewProj === null) return;
    const mesh = batch.mesh;
    if (!mesh.complete) return;
    const count = Math.min(data.count, batch.capacity);
    if (count === 0) return;

    const slot = this.perDraw.allocate();
    if (slot === null) {
      if (!this.warnedFull) {
        this.warnedFull = true;
        console.warn(
          `WebGPU: more than ${MAX_DRAWS_PER_FRAME} draws in a frame; the rest are skipped`,
        );
      }
      return;
    }

    this.perDraw.writeFloats(slot, FLAT_VERT_FIELDS.uViewProj.offset, this.viewProj);
    this.perDraw.writeFloats(slot, FLAT_VERT_FIELDS.uUvScale.offset, this.uvScale);
    this.perDraw.writeFloats(slot, FLAT_VERT_FIELDS.uLightViewProj.offset, this.lightViewProj);
    this.perDraw.writeInt(slot, FLAT_VERT_FIELDS.uHasTangents.offset, mesh.hasTangents ? 1 : 0);

    const dimmed = opacity < 1;
    if (dimmed) {
      this.perFrameFloats[this.materialField('uOpacity')] = opacity;
    }
    const lit = options.lit ?? true;
    const fog = options.fog ?? true;
    const toneMapped = options.toneMapped ?? true;
    const unlitOrUnfogged = !lit || !fog;
    if (unlitOrUnfogged) {
      if (!lit) this.perFrameInts[this.materialField('uLightingEnabled')] = 0;
      if (!fog) this.perFrameInts[this.materialField('uFogEnabled')] = 0;
    }
    if (!toneMapped) {
      this.perFrameInts[this.materialField('uOutputTransform')] = Math.min(this.gradeCode(), 1);
    }

    const depthWrite = options.depthWrite ?? true;
    const layer = Math.min(Math.max(Math.round(options.depthLayer ?? 0), 0), MAX_DEPTH_LAYER);
    /* An instanced draw does not refract. See `materialChanges.ts`. */
    const own = ownsMaterial({ opacity, lit, fog, toneMapped, refracting: false });
    if (own) this.materials.dirty();
    const base = (mesh as GpuMesh & { key?: string }).key ?? 'flat:s0:u0';
    /* `|inst` in the key, for the reason every other suffix is there: an instanced pipeline binds
       a third vertex buffer and a different vertex module, and sharing a cache entry with the
       plain one would hand a draw the wrong layout. */
    const key =
      `${base}|inst${blend ? '|blend' : ''}` +
      `${depthWrite ? '' : '|nodepth'}${layer > 0 ? `|dl${layer}` : ''}`;

    const pipelines = this.targetPipelines();
    let pipeline = pipelines.peek(key);
    if (pipeline === undefined) {
      const present = this.meshPresent.get(base);
      if (present === undefined) {
        throw new Error(`WebGPU: no mesh attributes recorded for ${base}; createMesh records them`);
      }
      pipeline = flatPipeline(
        pipelines,
        this.surface.device,
        this.flatLayoutFor(false, false),
        this.variant,
        key,
        present,
        blend,
        false,
        false,
        depthWrite,
        layer,
        true,
      );
    }

    const material = this.materialSlotForDraw();
    if (material !== null) {
      const command = this.recordDraw(0, this.currentTarget());
      if (command !== null) {
        command.pipeline = pipeline;
        command.bindGroup = this.flatBindGroupFor(false, false, null);
        command.offsetA = slot;
        command.offsetB = material;
        command.offsetCount = 2;
        let index = 0;
        for (; index < mesh.vertexBuffers.length; index++) {
          command.vertexBuffers[index] = mesh.vertexBuffers[index] as GPUBuffer;
        }
        command.vertexBuffers[index] = batch.buffer;
        command.vertexCount = mesh.vertexBuffers.length + 1;
        command.indexBuffer = mesh.indexBuffer;
        command.indexed = true;
        command.count = mesh.indexCount;
        command.instances = count;
      } else {
        const pass = this.openPass();
        if (pass === null) return;
        pass.setPipeline(pipeline);
        pass.setBindGroup(0, this.flatBindGroupFor(false, false, null), [slot, material]);
        let index = 0;
        for (; index < mesh.vertexBuffers.length; index++) {
          pass.setVertexBuffer(index, mesh.vertexBuffers[index] as GPUBuffer);
        }
        pass.setVertexBuffer(index, batch.buffer);
        pass.setIndexBuffer(mesh.indexBuffer, 'uint32');
        pass.drawIndexed(mesh.indexCount, count);
      }
    }
    /* Back to the defaults, unconditionally and for the reason `drawMesh` gives at length: this
       scratch block is cumulative state shared by every draw after this one, and an early return
       past the restore leaves the rest of the frame unlit, unfogged or undimmed. */
    if (dimmed) {
      this.perFrameFloats[this.materialField('uOpacity')] = 1;
    }
    if (unlitOrUnfogged) {
      this.perFrameInts[this.materialField('uLightingEnabled')] = 1;
      this.perFrameInts[this.materialField('uFogEnabled')] = 1;
    }
    if (!toneMapped) {
      this.perFrameInts[this.materialField('uOutputTransform')] = this.gradeCode();
    }
    if (own) this.materials.dirty();
  }

  /* -- Scatter ------------------------------------------------------------------------ */

  /** Upload a base mesh and size its per-instance buffers. See `createGpuScatter`. */
  createScatter(base: MeshData, data: InstanceData): GpuScatter {
    return this.uploadScatter(createGpuScatter(this.surface.device, base, data.capacity), data);
  }

  /**
   * Push placement to the device.
   *
   * Returns the batch so `createScatter` can upload in one expression. Only the live prefix
   * is written — `data.count` instances of a buffer sized for `capacity` — because the rest
   * is not drawn and uploading it would be the per-frame waste `uploadScatter` exists to
   * make visible.
   */
  uploadScatter(scatter: GpuScatter, data: InstanceData): GpuScatter {
    if (this.surface.lost) return scatter;
    const { queue } = this.surface.device;
    const instanced = scatter.vertexBuffers.slice(3);
    const sources: readonly [Float32Array, number][] = [
      [data.positions, 3],
      [data.scaleAndYaw, 2],
      [data.tints, 3],
      [data.windResponse, 3],
    ];
    for (let i = 0; i < sources.length; i++) {
      const [values, perInstance] = sources[i] as [Float32Array, number];
      const buffer = instanced[i];
      if (buffer === undefined || data.count === 0) continue;
      queue.writeBuffer(buffer, 0, values, 0, data.count * perInstance);
    }
    return scatter;
  }

  /** Release a batch. */
  disposeScatter(scatter: GpuScatter): void {
    scatter.dispose();
  }

  /**
   * Draw every live instance of a batch, in one call.
   *
   * **Its own uniform buffers rather than the flat pass's**, because it is a different
   * program with a different block: the vertex stage here carries the wind and the trample
   * ring, and the fragment stage carries lighting and the medium and nothing else.
   */
  drawScatter(
    scatter: GpuScatter,
    data: InstanceData,
    camera: Camera,
    env: Environment,
    windX: number,
    windZ: number,
    windGust: number,
    timeSeconds: number,
    trample: Float32Array | null = null,
  ): void {
    if (!this.canDraw() || data.count === 0) return;

    const slot = this.scatterVerts.allocate();
    if (slot === null) return;

    const verts = this.scatterVerts;
    const atV = (name: string): number => SCATTER_VERT_FIELDS[name]?.offset ?? 0;
    /* Corrected, like every other drawn matrix: this one does reach a presented target. */
    mat4.multiply(this.correctedViewProj, CLIP_CORRECTION, camera.viewProjection);
    verts.writeFloats(slot, atV('uViewProj'), this.correctedViewProj);

    /*
     * Chosen in `scatterDeform.ts` so both backends bend the same grass, and written into a
     * slot of its own because the gust and the trample field are this *batch's* rather than
     * the frame's — see `createScatterBindGroupLayout` for what one buffer did to the plumes.
     */
    const d = resolveScatterDeform(windX, windZ, windGust, timeSeconds, trample, this.deform);
    verts.writeFloats(slot, atV('uWindDirection'), d.direction);
    verts.writeFloat(slot, atV('uWindSpeed'), d.bend);
    verts.writeFloat(slot, atV('uWindGust'), d.gust);
    verts.writeFloat(slot, atV('uWindTime'), d.time);
    verts.writeFloats(slot, atV('uWindSpatialPhase'), d.spatialPhase);
    verts.writeFloat(slot, atV('uTrampleRadius'), d.trampleRadius);
    verts.writeFloat(slot, atV('uTrampleDepth'), d.trampleDepth);
    /* `vec4[8]` at the block's own stride, for the reason `scatter` documents. */
    scatterIntoRing(verts, slot, SCATTER_VERT_FIELDS['uTrample'], d.trample, 4);

    const f = this.scatterFragFloats;
    const i = this.scatterFragInts;
    const atF = (name: string): number => (SCATTER_FRAG_FIELDS[name]?.offset ?? -4) / 4;
    f.set(env.directionalDir, atF('uDirectionalDir'));
    f.set(env.directionalColor, atF('uDirectionalColor'));
    f.set(env.ambient, atF('uAmbient'));
    f.set(camera.position, atF('uCameraPos'));
    const medium = resolveAtmosphere(
      env,
      camera.position[1] ?? 0,
      this.quality.underwaterAtmosphere,
      this.medium,
    );
    f.set(medium.fogColor, atF('uFogColor'));
    f[atF('uFogDensity')] = medium.fogDensity;
    f[atF('uFogHeightFalloff')] = medium.fogHeightFalloff;
    f[atF('uFogEyeY')] = medium.fogEyeY;
    f.set(medium.underwaterColor, atF('uUnderwaterColor'));
    f[atF('uUnderwaterFogDensity')] = medium.underwaterFogDensity;
    f[atF('uUnderwaterFactor')] = medium.underwaterFactor;
    i[atF('uFogMode')] = medium.fogMode;
    f[atF('uFogNear')] = medium.fogNear;
    f[atF('uFogFar')] = medium.fogFar;

    this.surface.device.queue.writeBuffer(this.scatterFragUniforms, 0, this.scatterFragStaging);

    const scatterPipe = scatterPipeline(this.pipelines, this.surface.device, this.scatterLayout);
    /* One dynamic offset, and a group of two uniform buffers: nothing sampled, nothing read. */
    const scatterCommand = this.recordDraw(0, this.currentTarget());
    if (scatterCommand !== null) {
      scatterCommand.pipeline = scatterPipe;
      scatterCommand.bindGroup = this.scatterBindGroup;
      scatterCommand.offsetA = slot;
      scatterCommand.offsetCount = 1;
      for (let index = 0; index < scatter.vertexBuffers.length; index++) {
        scatterCommand.vertexBuffers[index] = scatter.vertexBuffers[index] as GPUBuffer;
      }
      scatterCommand.vertexCount = scatter.vertexBuffers.length;
      scatterCommand.indexBuffer = scatter.indexBuffer;
      scatterCommand.indexed = true;
      scatterCommand.count = scatter.indexCount;
      scatterCommand.instances = data.count;
    } else {
      const pass = this.openPass();
      if (pass === null) return;
      pass.setPipeline(scatterPipe);
      pass.setBindGroup(0, this.scatterBindGroup, [slot]);
      for (let index = 0; index < scatter.vertexBuffers.length; index++) {
        pass.setVertexBuffer(index, scatter.vertexBuffers[index] as GPUBuffer);
      }
      pass.setIndexBuffer(scatter.indexBuffer, 'uint32');
      pass.drawIndexed(scatter.indexCount, data.count);
    }
  }

  /**
   * Move the drawing-buffer density ceiling, as a governor does to hold a frame budget.
   *
   * Stored and applied on the next `resize`, which is where the WebGL2 path applies it too.
   */
  applyResolutionScale(scale: number): void {
    this.scale = Math.max(0.1, Math.min(1, scale));
    this.resize();
  }

  /*
   * ---------------------------------------------------------------------------------------
   * Deliberate no-ops, for passes this backend has not ported yet.
   *
   * **They exist so a scene runs rather than so it looks right**, and the difference matters:
   * a missing method throws and stops the frame, while an empty one draws a world with no
   * shadows and lets everything else be seen and compared. Each is a row of Task 11 and each
   * disappears when that row lands. Nothing here should be read as "this backend has
   * shadows" — the parity ledger is where that claim would have to be made and earned.
   * ---------------------------------------------------------------------------------------
   */

  /**
   * Open the shadow pass: the world about to be drawn from the light's point of view.
   *
   * **Its own encoder, because a scene calls this before `beginFrame`.** The ordering is the
   * scene's — shadows are baked, then the frame is drawn against them — and this backend
   * follows it rather than reorganising it.
   *
   * All three layers, which is what the shader multiplies together. The `dynamic` one used to
   * return false here — see `dynamicMap` for what that cost and why nothing caught it.
   */
  beginShadowPass(lightViewProj: ReadonlyMat4, layer: ShadowLayer = 'static'): boolean {
    if (this.surface.lost) return false;
    /* Bracketed here and closed in `endShadowPass`, matching `renderer.ts:2251` exactly — the
       two backends have to attribute the same passes to the same slot or the numbers cannot
       be compared, which is the whole reason a consumer reads them. */
    this.gpuTimer.begin('shadows');
    const peel = layer === 'static-peel';
    const dynamic = layer === 'dynamic';
    /* No peel map means the profile asked for one depth layer, as it does on the other side;
       no dynamic map means directional shadows are off entirely. */
    const view = peel ? this.peelView : dynamic ? this.dynamicView : this.shadowView;
    if (view === null) return false;

    this.lightViewProj.set(lightViewProj as Float32Array);
    mat4.multiply(this.correctedLightViewProj, SHADOW_CLIP_CORRECTION, lightViewProj);
    this.shadowLayerIsPeel = peel;
    /*
     * A frame's peel is only as good as the pass that fills it, and the static layer is the one
     * that opens first.
     *
     * **`layer === 'static'`, not `!peel`.** The dynamic layer opens after both of them, so a
     * negated test invalidated the peel that had just been filled and the frame sampled none of
     * it. That is a one-word difference between "the mover's shadow arrived" and "the mover's
     * shadow arrived and the second static occluder left".
     */
    if (layer === 'static') this.peelFilled = false;
    this.shadowDraws.reset();
    this.scatterDepthDraws.reset();
    this.shadowEncoder = this.surface.device.createCommandEncoder({ label: 'shadow' });
    this.shadowPass = this.shadowEncoder.beginRenderPass({
      label: peel ? 'shadow.peel' : dynamic ? 'shadow.dynamic' : 'shadow.static',
      timestampWrites: this.gpuTimer.writesFor(),
      colorAttachments: [],
      depthStencilAttachment: {
        view,
        depthClearValue: 1,
        depthLoadOp: 'clear',
        depthStoreOp: 'store',
      },
    });
    return true;
  }

  /** Submit everything that casts into the layer `beginShadowPass` opened. */
  /**
   * The same enumeration, replayed into the colour pass that is open.
   *
   * See `SceneCasters` in `shadowCasters.ts` for why this exists and why scatter is declined. The
   * sink is built once and held, because a caster enumeration runs per pass and a sink allocated
   * per call would allocate per pass.
   */
  private readonly sceneCasterSink: ShadowCasterSink = {
    mesh: (mesh, model, material) => {
      /* The opaque handle narrowed to this backend's own, for the reason `casterSink` gives about
         the mesh: nothing else ever handed one out. */
      this.bindSceneCasterMaterial(material);
      this.drawMesh(mesh as GpuMesh, model);
    },
    skinnedMesh: (mesh, model, palette, material) => {
      this.bindSceneCasterMaterial(material);
      this.setSkinPalette(palette);
      this.drawMesh(mesh as GpuMesh, model);
      /* Put back, or the next rigid draw in the replay skins by whatever this one left bound. */
      this.setSkinPalette(null);
    },
    instanced: (batch, data, material) => {
      this.bindSceneCasterMaterial(material);
      this.drawInstanced(batch as GpuInstancedBatch, data);
    },
    /* Declined, and the absence is meant to be visible. `SceneCasters` says why. */
    scatter: () => {},
  };

  /**
   * The material the open replay has bound, or `undefined` before its first entry.
   *
   * `ShadowCasterSink`'s material is optional and omitting it means *no material* rather than
   * *unchanged*, so a run of entries sharing one material has no shorter spelling and the sink
   * bound once per entry. On this backend that is a cliff rather than a slope: `setMaterial`
   * dirties `materialSlot`, so a bind per entry is a **slot per draw** out of
   * `MAX_MATERIALS_PER_FRAME` — and past the ring `materialSlotForDraw` returns null and the draw
   * is skipped, which is the world that appears and disappears that constant's own comment
   * describes. A consumer measured 82 materials a model over two to four draws each, and a
   * reflection replaying the frame shares the ring with the pass that recorded it.
   *
   * **Reference identity, not a deep compare.** A caster list holds the material objects its draws
   * bound, so a run from one surface is literally one object; two structurally equal materials from
   * different surfaces are rare and cost exactly what they cost today.
   *
   * `undefined` rather than `null` for "nothing bound yet", because `null` is a material an entry
   * can legitimately ask for — it is what an entry carrying no material means.
   */
  private sceneCasterMaterial: SurfaceMaterial<GpuSurfaceTexture> | null | undefined;

  /** Bind one replay entry's material, unless it is the one already standing. */
  private bindSceneCasterMaterial(material: SceneCasterMaterial | undefined): void {
    const wanted = (material ?? null) as SurfaceMaterial<GpuSurfaceTexture> | null;
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
    if (this.surface.lost) return;
    /* Nothing carried in from the pass around this: the replay's first entry binds whatever it
       asks for, because what `setMaterial` was last given is not this sink's to assume. */
    this.sceneCasterMaterial = undefined;
    casters(this.sceneCasterSink);
  }

  drawShadowCasters(casters: ShadowCasters): void {
    if (this.surface.lost || this.shadowPass === null) return;
    casters(this.casterSink);
  }

  /** Close the shadow pass and submit it, so the frame can sample what it wrote. */
  endShadowPass(): void {
    if (this.surface.lost || this.shadowPass === null || this.shadowEncoder === null) return;
    this.shadowDraws.flush();
    this.scatterDepthDraws.flush();
    this.shadowPass.end();
    this.surface.device.queue.submit([this.shadowEncoder.finish()]);
    /* The map now holds a rendered peel rather than whatever it was created with. */
    if (this.shadowLayerIsPeel) this.peelFilled = true;
    this.shadowLayerIsPeel = false;
    this.shadowPass = null;
    this.shadowEncoder = null;
    this.gpuTimer.end();
  }

  /* -- Point shadows ------------------------------------------------------------------ */

  /**
   * The pool, or null where the profile switched cube shadows off.
   *
   * `PointShadowSystem` over `GpuPointShadowMap`: the pooling, the staleness and the crossfade
   * are the same code the WebGL2 path runs, and only the cubemap is this backend's. See
   * `PointShadowSource`.
   */
  private readonly pointShadows: PointShadowSystem<GpuPointShadowMap> | null;
  /** A world's casting rectangles, on layers above the pool in the same array. See `renderer.ts`. */
  private readonly areaShadows: AreaShadowSet<GpuPointShadowMap> | null;
  private readonly resolvedAreaShadows = createResolvedAreaShadows(MAX_AREA_LIGHTS);
  private readonly areaBakeScratch = createBakeScratch(MAX_AREA_LIGHTS);
  private warnedAreaShadowRange = false;
  private warnedAreaShadowsOff = false;
  private warnedAreaShadowLayers = false;
  /** How many point lights the array was last sized for; see the other backend's copy. */
  private preparedPointLightCount = 0;
  /** See `renderer.ts`: built when a world reports its lights, and rebuilt only to grow. */
  private pointShadowArray: GpuPointShadowArray | null = null;
  private readonly bakeScratch = createBakeScratch(POINT_SHADOW_POOL);
  /** Said once per renderer; see `updatePointShadows`. */
  private warnedNoPointShadowArray = false;
  /** Said once, for the retired ambient dial. */
  private warnedEnvironmentAmbient = false;
  private readonly castingWorldIndices = new Int32Array(POINT_SHADOW_POOL).fill(-1);
  private readonly resolvedPointShadows = createResolvedPointShadows(MAX_POINT_LIGHTS);
  /** One face's view-projection, rebuilt per face rather than allocated. */
  private readonly faceViewProj = mat4.create();
  /** The corrected copy the vertex stage is handed. See `SHADOW_CLIP_CORRECTION`. */
  private readonly correctedFaceViewProj = new Float32Array(16);

  /** Size the pool once the world reports its light count. Nothing is baked here. */
  prepareStaticPointShadows(
    lights: readonly ShadowLight[],
    /** The world's rectangles, so the casting ones get layers. See `renderer.ts`. */
    areaLights: readonly AreaLightSource[] = [],
  ): void {
    if (this.surface.lost) return;
    if (this.pointShadows === null) {
      this.warnAreaShadowsOff(areaLights);
      return;
    }
    /* The same sizing rule as `renderer.ts`, and for the same reason. See `PointShadowArray`. */
    const extra = areaShadowLayerCount(areaLights);
    const wanted = Math.min(lights.length, POINT_SHADOW_POOL) + LIVE_POINT_SHADOW_MAPS + extra;
    if (this.pointShadowArray === null || this.pointShadowArray.layers < wanted) {
      this.pointShadowArray?.dispose();
      this.pointShadowArray = new GpuPointShadowArray(
        this.surface.device,
        this.quality.pointShadowFaceSize,
        lights.length,
        extra,
      );
      this.pointShadows.forgetEveryImage();
      this.areaShadows?.forgetEveryImage();
      /*
       * **`rebuildFlatBindGroup`, not `buildFlatBindGroup`.** The group built here is only the
       * one a draw *with* an albedo texture uses; every draw without one — which is nearly all
       * geometry — takes `blankAlbedoBindGroup`, and the per-texture cache holds groups built
       * against the old array too. Assigning `this.bindGroup` alone left both pointing at the
       * 1x1 stand-in, so the lit pass sampled an empty array and no light cast a shadow.
       *
       * It cost a capture cycle to find, because it looks exactly like a resolve that never
       * ran: the frame came out brighter and was byte-identical under every change made to the
       * resolve, which is what sampling a stand-in does.
       */
      this.rebuildFlatBindGroup();
    }
    this.pointShadows.prepareStaticMaps(lights.length);
    this.preparedPointLightCount = lights.length;
    this.areaShadows?.prepare(areaLights, firstAreaShadowLayer(lights.length));
    this.warnAreaShadowRange(areaLights);
  }

  /** Say once that a rectangle asked to cast and named no range. See `renderer.ts`. */
  private warnAreaShadowRange(areaLights: readonly AreaLightSource[]): void {
    if (this.warnedAreaShadowRange) return;
    const count = Math.min(areaLights.length, MAX_AREA_LIGHTS);
    for (let slot = 0; slot < count; slot++) {
      const light = areaLights[slot];
      if (light?.castsShadow !== true || castingRange(light) > 0) continue;
      this.warnedAreaShadowRange = true;
      console.warn(
        `WebGpuRenderer: area light ${slot} declares castsShadow but no usable shadowRange, so ` +
          'it will light through whatever stands in front of it. A rectangle has no radius to ' +
          'take a far plane from — set shadowRange to how far this fixture should occlude, in ' +
          'metres.',
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
      `WebGpuRenderer: an area light asks to cast into layers this shadow array does not have. The ` +
        'array is sized once, so pass the same rectangles to prepareStaticPointShadows(lights, ' +
        'areaLights) that you pass here — otherwise they light through whatever stands in front ' +
        'of them.',
    );
  }

  /** Say once that a rectangle asked to cast while the array it would read is off. */
  private warnAreaShadowsOff(areaLights: readonly AreaLightSource[]): void {
    if (this.warnedAreaShadowsOff) return;
    const count = Math.min(areaLights.length, MAX_AREA_LIGHTS);
    for (let slot = 0; slot < count; slot++) {
      if (areaLights[slot]?.castsShadow !== true) continue;
      this.warnedAreaShadowsOff = true;
      console.warn(
        'WebGpuRenderer: an area light declares castsShadow while RenderQuality.pointShadows is ' +
          'off. A rectangle reads its occlusion from the same array texture a point light does, ' +
          'so with that flag the array does not exist. Turn pointShadows on, or the rectangle ' +
          'lights through stone.',
      );
      return;
    }
  }

  /**
   * Refresh the cubemaps this frame's budget allows, and settle what the shader will sample.
   *
   * Every decision here is shared: `selectCastingLights` keeps a light that declined to cast
   * out of the pool, `sync` hands out slots, `updateLiveSelection` runs the crossfade, and
   * `runPointShadowBakes` spends the face budget in the order a measured frame chose. What is
   * this backend's is one callback — a render pass per face — and the bind group.
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
    warmWorldIndices?: Int32Array,
    warmCount = 0,
    /** The rectangles this frame shades, in `selectAreaLights` order. See `renderer.ts`. */
    areaLights: readonly AreaLightSource[] = [],
  ): void {
    const pool = this.pointShadows;
    if (this.surface.lost || pool === null) {
      this.warnAreaShadowsOff(areaLights);
      return;
    }
    /*
     * **A bake into an array that does not exist spends the budget and draws nothing, silently.**
     *
     * `prepareStaticPointShadows` builds the octahedral array and is a separate call a consumer
     * makes once. Until 2026-08-25 forgetting it was completely quiet: this method ran,
     * `selectCastingLights` found lights, the bake budget was spent every frame, and no shadow
     * appeared anywhere. It cost an investigation that produced four confident eliminations, every
     * one of them measuring the missing call rather than the thing it was pointed at.
     *
     * Said once per renderer rather than once per frame, and it names the call to make: the whole
     * failure is that the picture is indistinguishable from a world whose lamps do not cast.
     */
    if (this.pointShadowArray === null) {
      if (!this.warnedNoPointShadowArray) {
        this.warnedNoPointShadowArray = true;
        console.warn(
          'WebGpuRenderer: updatePointShadows was called before prepareStaticPointShadows, so ' +
            'there is no shadow array to bake into and no point light will cast. Call ' +
            'prepareStaticPointShadows(lights) once, after the lights exist.',
        );
      }
      return;
    }

    const casting = selectCastingLights(
      lights,
      activeWorldIndices,
      activeCount,
      this.castingWorldIndices,
    );
    pool.sync(this.castingWorldIndices, casting, warmWorldIndices, warmCount);
    pool.updateLiveSelection(lights, liveX, liveY, liveZ, frameDt);
    /*
     * Before the bakes, so an image that completes this frame is bound at no presence at all
     * and ramps from there. Advancing afterwards would give it a frame's worth on the frame it
     * lands, which is most of the pop on a slow frame.
     */
    pool.advance(frameDt);

    /*
     * One encoder for the whole round rather than one per face. Every face is its own render
     * pass — WebGPU attaches a single subresource to a depth attachment — but they share a
     * submission, so the ring is flushed once and the slots are up before any of them reads.
     */
    this.shadowDraws.reset();
    this.scatterDepthDraws.reset();
    this.shadowEncoder = this.surface.device.createCommandEncoder({ label: 'pointShadow' });
    /* A cube face is a shadow pass like any other, and the courtyard is where it matters: six of
       them a frame is the difference this slot exists to make visible. */
    this.gpuTimer.begin('shadows');
    this.depthCullMode = 'none';
    /* A cube face is never a peel layer, and it drives `shadowPass` without `beginShadowPass`. */
    this.shadowLayerIsPeel = false;
    /* A frame's resolves take slots in the array's ring; see it for why they cannot share one. */
    this.pointShadowArray?.beginFrame();
    try {
      runPointShadowBakes(
        pool,
        lights,
        this.quality.pointShadowFacesPerFrame,
        this.quality.liveShadowFacesPerFrame,
        this.quality.pointShadowRebakeDistance,
        FACE_COUNT,
        this.bakeScratch,
        staticCasters,
        dynamicCasters,
        (map, light, casters, maxFaces) =>
          map.bake(
            light.x,
            light.y,
            light.z,
            light.radius,
            (view, viewProj) => this.bakeFace(view, viewProj, casters as ShadowCasters),
            (layer, face, far, near) => this.resolveFace(layer, face, far, near),
            this.faceViewProj,
            light.shadowNear,
            light.sourceRadius,
            maxFaces,
          ),
      );
      /*
       * **Inside the same encoder and the same try, which is the whole reason the rectangles' bakes
       * ride this call.** Every face is its own render pass, they share one submission, and the
       * ring is flushed once in the `finally` below — a second entry point would need a second
       * encoder, a second submit and a second `shadows` timer slot for work that is the same work.
       */
      this.updateAreaShadows(areaLights, frameDt, staticCasters, dynamicCasters);
    } finally {
      this.depthCullMode = 'back';
      this.shadowDraws.flush();
      this.scatterDepthDraws.flush();
      /*
       * **Before the submit, and that ordering is the whole point of the ring.** A write to the
       * queue lands ahead of the encoder's commands whenever it is issued, so uploading per
       * resolve would give every pass the last face's uniforms; uploading once here gives each
       * its own slot.
       */
      this.pointShadowArray?.flush();
      this.surface.device.queue.submit([this.shadowEncoder.finish()]);
      this.shadowEncoder = null;
      this.shadowPass = null;
      this.gpuTimer.end();
    }

    /*
     * **No rebind here any more.** Twelve cube views meant the bind group named twelve textures,
     * so a light changing hands moved a binding and the group had to be rebuilt — dirty-checked,
     * because rebuilding per frame allocates in the frame loop. One array texture has one
     * identity that never moves; which layer a light reads is a number in the uniform block,
     * written every frame regardless.
     */
    pool.resolve(this.resolvedPointShadows);
  }

  /**
   * The rectangles' round, inside the shadow encoder this backend already opened.
   *
   * Every decision — which layers, when they re-bake, what the shader is told — is
   * `AreaShadowSet`'s and is shared with the other backend. What is this one's is the callback:
   * a render pass per face and a resolve into the layer.
   */
  private updateAreaShadows(
    areaLights: readonly AreaLightSource[],
    frameDt: number,
    staticCasters: ShadowCasters,
    dynamicCasters: ShadowCasters,
  ): void {
    const set = this.areaShadows;
    if (set === null) return;
    /* A declaration that no longer matches is re-prepared, never carried. See `renderer.ts`. */
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
        map.bake(
          light.x,
          light.y,
          light.z,
          range,
          (view, viewProj) => this.bakeFace(view, viewProj, casters as ShadowCasters),
          (layer, face, far, mapNear) => this.resolveFace(layer, face, far, mapNear),
          this.faceViewProj,
          near,
          /* The filter reads the emitter's size, never the bake. See `renderer.ts`'s copy. */
          DEFAULT_SOURCE_RADIUS,
          maxFaces,
        ),
    );
    set.resolve(areaLights, this.resolvedAreaShadows);
  }

  /**
   * One cubemap face: a depth pass, the casters, done.
   *
   * **Corrected by `SHADOW_CLIP_CORRECTION`, not `CLIP_CORRECTION`.** This map is sampled and
   * never presented, so it wants the depth remap without the Y flip, exactly as the directional
   * map does — see that constant for the texel-for-texel comparison that settled it. The
   * lookup is `flat.ts`'s `pointShadow`, which normalises a direction and reads the cube; a
   * flipped face would mirror every shadow about its own axis and still look like shadows.
   */
  private bakeFace(view: GPUTextureView, viewProj: mat4, casters: ShadowCasters): void {
    const encoder = this.shadowEncoder;
    if (encoder === null) return;
    mat4.multiply(this.correctedFaceViewProj, SHADOW_CLIP_CORRECTION, viewProj);
    this.correctedLightViewProj.set(this.correctedFaceViewProj);
    this.shadowPass = encoder.beginRenderPass({
      label: 'pointShadow.face',
      timestampWrites: this.gpuTimer.writesFor(),
      colorAttachments: [],
      depthStencilAttachment: {
        view,
        depthClearValue: 1,
        depthLoadOp: 'clear',
        depthStoreOp: 'store',
      },
    });
    casters(this.casterSink);
    this.shadowPass.end();
    this.shadowPass = null;
  }

  /**
   * One rendered face into its region of the light's octahedral layer.
   *
   * On the bake's own encoder, between two face passes, which is what lets one scratch texture
   * serve every light: the face is consumed before the next one is drawn. See
   * `pointShadowArray.ts` for why the regions are disjoint.
   */
  private resolveFace(layer: number, face: number, far: number, near: number): void {
    const encoder = this.shadowEncoder;
    const array = this.pointShadowArray;
    if (encoder === null || array === null) return;
    array.resolve(encoder, layer, face, far, near);
  }

  private buildFlatBindGroup(): GPUBindGroup {
    return createFlatBindGroup(
      this.surface.device,
      this.bindGroupLayout,
      this.variant,
      this.perDraw.buffer,
      this.perFrame.buffer,
      this.flatTextures,
    );
  }

  /**
   * The bind group a draw uses, skinned or not.
   *
   * **The skinned twin is cached against the two things that can invalidate it**, rather than
   * against a flag somebody has to remember to clear at six call sites: the unskinned group it was
   * built beside — which is rebuilt whenever the material or a shadow slot moves — and the palette
   * view, which changes only when the texture is reallocated. Comparing object identity means a
   * missed invalidation is not possible rather than merely unlikely, and it is why
   * `SkinPaletteTexture.view()` caches: a fresh view every call never compares equal and would
   * rebuild this every draw.
   */
  private flatBindGroupFor(
    skinned: boolean,
    morphed: boolean,
    deltas: GPUTextureView | null,
  ): GPUBindGroup {
    if (!skinned && !morphed) return this.bindGroup;
    const palette = skinned ? this.skinPalettes.view(this.skinPaletteSlot) : null;
    /* Slot `k` caches at `k + 1`; index 0 is the morphed draw that is not skinned and has no
       slot of its own. See `skinnedGroups`. */
    const at = skinned ? this.skinPaletteSlot + 1 : 0;
    if (
      (this.skinnedGroups[at] ?? null) === null ||
      this.skinnedGroupsBeside[at] !== this.bindGroup ||
      this.skinnedGroupsPalette[at] !== palette ||
      this.skinnedGroupsDeltas[at] !== deltas
    ) {
      this.skinnedGroups[at] = createFlatBindGroup(
        this.surface.device,
        this.flatLayoutFor(skinned, morphed),
        this.variant,
        this.perDraw.buffer,
        this.perFrame.buffer,
        this.flatTextures,
        palette,
        deltas,
      );
      this.skinnedGroupsBeside[at] = this.bindGroup;
      this.skinnedGroupsPalette[at] = palette;
      this.skinnedGroupsDeltas[at] = deltas;
    }
    return this.skinnedGroups[at] as GPUBindGroup;
  }

  /** The layout matching a pair of vertex flags. A pipeline and its bind group must agree. */
  private flatLayoutFor(skinned: boolean, morphed: boolean): GPUBindGroupLayout {
    if (skinned && morphed) return this.bothBindGroupLayout;
    if (skinned) return this.skinnedBindGroupLayout;
    if (morphed) return this.morphedBindGroupLayout;
    return this.bindGroupLayout;
  }

  /**
   * Give a ring that ran out last frame the room to draw this one whole.
   *
   * **Here and nowhere else.** `flushOverlay` above has submitted everything outstanding and the
   * frame's encoder has not been replaced yet, so no command references the buffer about to be
   * destroyed and nothing has been written into the staging that discarding it would lose.
   * `UniformRing.allocate` still refuses to grow where it runs out, for the reason it gives: that
   * would stall the frame to make room.
   *
   * **Only the two rings that scale with the scene.** A frame that switches material 1,267 times
   * has 1,267 materials' worth of world in it and the honest answer is to draw them; a frame
   * asking for a ninth simultaneous flock has hit a ceiling that means something else, and those
   * keep skipping and reporting. The two here are also the two whose staleness has an answer
   * already written — every flat bind group is reachable from `flatBindGroups`, the blank, and
   * the skinned twins, and nothing else holds either buffer.
   *
   * **What it costs is one frame.** A scene that grows past a ceiling loses geometry for the frame
   * that discovers it and is whole from the next, where before it lost that geometry for as long
   * as the scene stayed big. What would make it wrong is a consumer whose frame legitimately
   * oscillates across a ceiling: the ring keeps the larger size, so that settles rather than
   * thrashing.
   */
  private growRings(): void {
    let grew = false;
    if (this.drawBudget.dropped > 0) {
      grew = this.perDraw.growTo(roomFor(this.drawBudget.used)) || grew;
    }
    if (this.materialBudget.dropped > 0) {
      grew = this.perFrame.growTo(roomFor(this.materialBudget.used)) || grew;
    }
    if (grew) this.rebuildFlatGroupsForNewRings();
  }

  /**
   * Every flat bind group, rebuilt against buffers that have just been replaced.
   *
   * **The blank is built with the maps forced to null rather than with whatever the last frame
   * left set**, which is the one thing here that is not obvious. `blankAlbedoBindGroup` is what a
   * pass starts from and it means *no maps at all*; `buildFlatBindGroup` reads the live material
   * fields through `flatTextures`, so building it at frame start with a normal map still held from
   * the last frame would produce a "blank" group that quietly carries one. The fields are put back
   * immediately, because they are the material a caller set and this is not a material change.
   *
   * The skinned twins invalidate themselves off `bindGroup`'s identity and are cleared anyway:
   * they hold `perDraw.buffer` directly, and a cache that is only *probably* invalid is the kind
   * that is wrong once.
   */
  private rebuildFlatGroupsForNewRings(): void {
    this.flatBindGroups.clear();
    this.skinnedGroups.length = 0;

    const albedo = this.albedo;
    const normalMap = this.normalMap;
    const ormMap = this.ormMap;
    const emissiveMap = this.emissiveMap;
    this.albedo = null;
    this.normalMap = null;
    this.ormMap = null;
    this.emissiveMap = null;
    this.blankAlbedoBindGroup = this.buildFlatBindGroup();
    this.albedo = albedo;
    this.normalMap = normalMap;
    this.ormMap = ormMap;
    this.emissiveMap = emissiveMap;

    this.bindGroup = this.flatGroupForMaps(
      this.albedo,
      this.normalMap,
      this.ormMap,
      this.emissiveMap,
    );
    /* The open material lives in a slot of a buffer that no longer exists. */
    this.materials.dirty();
  }

  /**
   * Rebuild the group for the open material, and drop every cached one.
   *
   * **The cache is keyed by albedo and every entry also holds the shadow cubemaps**, so when a
   * cubemap moves slot the entries are all stale in a way nothing about the albedo reveals. A
   * scene that switched back to an earlier texture would get a group pointing at the pool's
   * previous occupant — a shadow from another light, on the right surface, which reads as a
   * lighting bug rather than as a stale binding.
   */
  private rebuildFlatBindGroup(): void {
    this.flatBindGroups.clear();
    if (
      this.albedo === null &&
      this.normalMap === null &&
      this.ormMap === null &&
      this.emissiveMap === null
    ) {
      this.blankAlbedoBindGroup = this.buildFlatBindGroup();
      this.bindGroupBudget.ask();
      this.bindGroup = this.blankAlbedoBindGroup;
      return;
    }
    this.bindGroup = this.flatGroupForMaps(
      this.albedo,
      this.normalMap,
      this.ormMap,
      this.emissiveMap,
    );
  }

  /**
   * The sky, as one triangle covering the screen with the world reconstructed per fragment.
   *
   * `sky.sunDir` and the rest go in at the offsets the generator computed, and **so does the
   * medium the camera is standing in**, which for a fortnight they did not.
   *
   * The block declares `uUnderwaterColor` and `uUnderwaterFactor` and this method never wrote
   * either, so both held the zero a `Float32Array` is born with for the life of the session.
   * Zero factor means "not submerged", so the shader's last line —
   * `col = mix(col, uUnderwaterColor * waterLight, uUnderwaterFactor)` — was a mix that never
   * moved: **a camera under the sea drew the sunset it would have seen from above it**, sun,
   * stars, clouds and all, while every other pass in the frame correctly went green. The
   * comment that stood here called the atmosphere uniforms a later task's, which is how a
   * missing bind reads as a scheduled one.
   *
   * `resolveAtmosphere` through `atmosphereHeight`, matching `renderer.ts`'s `bindAtmosphere`
   * call in its own `drawSky` exactly — including the mirror's eye height, or a reflection
   * renders its sky from the camera's side of the surface.
   */
  drawSky(camera: Camera, sky: SkyColors, env: Environment): void {
    if (!this.canDraw()) return;

    const f = this.skyFloats;
    const at = (name: keyof typeof SKY_FIELDS): number => SKY_FIELDS[name].offset / 4;

    /*
     * Through the corrected clip space, because the sky unprojects its own NDC and its
     * triangle is the one thing `CLIP_CORRECTION` never multiplied. See that constant.
     */
    mat4.multiply(this.skyInvViewProj, camera.invViewProjection, INVERSE_CLIP_CORRECTION);
    f.set(this.skyInvViewProj, at('uInvViewProj'));
    f.set(camera.position, at('uCameraPos'));
    f.set(sky.top, at('uTopColor'));
    f.set(sky.horizon, at('uHorizonColor'));
    f.set(sky.deep, at('uDeepColor'));
    f.set(sky.sunDir, at('uSunDir'));
    f.set(sky.sunColor, at('uSunColor'));
    f[at('uSunDiscExponent')] = discExponent(sky.sunAngularRadius);
    f.set(sky.moonDir, at('uMoonDir'));
    f.set(sky.moonColor, at('uMoonColor'));
    f[at('uMoonAngularRadius')] = sky.moonAngularRadius;
    f[at('uMoonPhase')] = sky.moonPhase;
    f[at('uNightFactor')] = sky.nightFactor;
    f.set([sky.cloudOffsetX, sky.cloudOffsetZ], at('uCloudOffset'));

    /* The two fields that make a sky stop being one. See the note above. */
    const medium = resolveAtmosphere(
      env,
      this.atmosphereHeight(camera),
      this.quality.underwaterAtmosphere,
      this.medium,
    );
    f.set(medium.underwaterColor, at('uUnderwaterColor'));
    f[at('uUnderwaterFactor')] = medium.underwaterFactor;

    this.surface.device.queue.writeBuffer(this.skyUniforms, 0, this.skyStaging);

    const skyPipe = skyPipeline(this.pipelines, this.surface.device, this.skyLayout);
    /* Reads nothing: the group is one uniform buffer, and the sky samples no attachment. */
    const skyCommand = this.recordDraw(0, this.currentTarget());
    if (skyCommand !== null) {
      skyCommand.pipeline = skyPipe;
      skyCommand.bindGroup = this.skyBindGroup;
      skyCommand.count = 3;
    } else {
      const pass = this.openPass();
      if (pass === null) return;
      pass.setPipeline(skyPipe);
      pass.setBindGroup(0, this.skyBindGroup);
      pass.draw(3);
    }
  }

  /** Close the pass and present. A no-op when no frame was begun. */
  /**
   * The scene from its off-screen target onto the canvas, with everything that happens on the way.
   *
   * One pass does the lot, because every effect here reads the same resolved image: the speed
   * blur, the camera motion blur, the occlusion it multiplies in, the bloom it adds and the tone
   * curve it ends on. The stages before it exist only to produce the two textures that pass
   * consumes.
   *
   * `sceneTarget.ts` is the same order on the other backend, including *why* the grade lands
   * here rather than in the mesh pass: with a target, the resolve is the last pass, and grading
   * twice is a curve applied to its own output.
   */
  private composite(encoder: GPUCommandEncoder): void {
    const scene = this.sceneColorView;
    const swap = this.swapView();
    if (scene === null || swap === null) return;
    const { device } = this.surface;

    /*
     * Camera motion blur, from the camera the frame was *rendered* with rather than from the
     * simulation step. `renderer.ts` names the trap: a velocity taken from the fixed 1/60 tick
     * pulses at 60 Hz against a display running at any other rate, reads as a stutter and gets
     * blamed on frame pacing. The first frame has no previous camera and blurs nothing.
     */
    const blur = this.quality.cameraMotionBlur * this.motionBlurScale;
    let motionStrength = 0;
    /*
     * **Built from `correctedViewProj` and not from `viewProj`**, which are the same matrix
     * unless the frame is jittered. The history holds a picture standing for the unjittered
     * scene, so reprojecting through the jitter would look every sample up half a pixel from
     * where it is; motion blur wants the unjittered one for the same reason, its smear being
     * measured against where the frame's pixels actually are.
     *
     * Kept whenever *either* effect wants it: this was previously behind `blur > 0`, so a
     * consumer running the temporal resolve without motion blur would have reprojected through a
     * `previousViewProj` nothing had ever written.
     */
    const wantsReprojection = blur > 0 || this.temporalJittering || this.reconstructing;
    if (wantsReprojection && this.viewProj !== null) {
      if (this.hasPreviousView) {
        mat4.invert(this.reprojection, this.correctedViewProj);
        mat4.multiply(this.reprojection, this.previousViewProj, this.reprojection);
        /* And the depth remap the shader is about to apply, undone. See
           `DEPTH_CLIP_CORRECTION`: without it the smear points the right way and travels
           roughly twice as far as it should. */
        mat4.multiply(this.reprojection, this.reprojection, DEPTH_CLIP_CORRECTION);
        motionStrength = blur;
      }
      this.previousViewProj.set(this.correctedViewProj);
      this.hasPreviousView = true;
    }

    /*
     * Depth of field, on the ceiling-and-dial split `setDepthOfField` describes. Its four
     * coefficients come from the same inverse projection the occlusion pass builds, and it needs
     * the depth for the same reason the smear does — so it joins the condition that resolves one.
     */
    const dofStrength =
      this.frameProjection === null ? 0 : this.quality.depthOfField * this.dofScale;
    /* `compositeWantsDepth` and not a second copy of it — its own comment says why. */
    /*
     * **The depth first, because the marks read it**, and it is the same copy everything after
     * this reads. Nothing between here and the composite writes depth — the order-independent
     * passes attach it read-only and the decals do not attach it at all — so resolving it before
     * them rather than after is the same picture and one copy instead of two.
     */
    if (this.compositeWantsDepth()) this.resolveDepth(encoder);
    /*
     * **The marks, before the translucent set.** After every opaque draw is in, because a mark is
     * decided from the depth buffer, and before the glass, so a pane is drawn over the mark rather
     * than under it.
     */
    this.runDecals(encoder);
    /*
     * **The reflections, after the marks and before the glass.** A march samples the finished
     * picture, so a mark on a floor belongs in the reflection of that floor; and a pane of glass is
     * drawn over a reflective floor rather than under it.
     */
    this.runReflections(encoder);
    /* The translucent set, into its two buffers and back over the scene. */
    this.runOit(encoder);
    /*
     * **The medium, after everything that draws and before anything that composites.**
     *
     * After the glass, the marks and the reflections because it is the air in front of the
     * finished picture; before the temporal resolve and the post chain, so bloom sees a lit fog
     * bank as brightness and the history holds the frame the viewer saw. `renderer.ts` puts it at
     * the same point in the other backend's sequence.
     */
    if (mediumActive(this.mediumOptions, this.quality.globalMediumSteps)) this.runMedium(encoder);
    /* After the depth it reprojects through, and before anything reads the scene. */
    this.temporalResolve(encoder);
    /*
     * **Reconstruction stands where the temporal resolve stands**, for the same reasons: after
     * everything that draws into the scene and after the depth it reprojects through, and before
     * bloom and the composite read the picture. It cannot copy its result back over the scene the
     * way the temporal resolve does — the two are different sizes — so the composite is given a
     * bind group of its own instead, which is the second group `temporalResolve` declined.
     */
    this.runMotion(encoder);
    this.runReconstruction(encoder);
    const aoStrength = this.quality.ambientOcclusion;
    if (aoStrength > 0 && this.frameProjection !== null) this.runOcclusion(encoder);
    const bloomStrength = this.quality.bloom * this.bloomScale;
    if (bloomStrength > 0) this.runBloom(encoder);

    /* The grade travels here only where the mesh pass gave it up. See `bindMeshPass`. */
    const graded = this.quality.hdrScene;
    const f = this.rushFloats;
    const i = this.rushInts;
    const at = (name: string): number => this.postField(RUSH_FRAG_FIELDS, name);
    f[at('uStrength')] = this.rushStrength;
    f[at('uReach')] = RUSH_REACH_UV;
    i[at('uOutputTransform')] = graded
      ? (OUTPUT_TRANSFORM_CODE[this.quality.outputTransform] ?? 0)
      : 0;
    f[at('uOutputExposure')] = graded ? this.exposure : 1;
    f.set(this.reprojection, at('uReprojection'));
    f[at('uMotionStrength')] = motionStrength;
    f[at('uMotionMax')] = MOTION_BLUR_MAX_UV;
    f[at('uAoStrength')] = this.frameProjection === null ? 0 : aoStrength;
    f[at('uDofStrength')] = dofStrength;
    if (dofStrength > 0 && this.frameProjection !== null) {
      mat4.invert(this.dofInvProjection, this.frameProjection);
      /* Column major: 10 and 14 are M[2][2] and M[2][3], 11 and 15 are M[3][2] and M[3][3] —
         the only four elements a depth-to-view-distance needs. See `uDepthToView`. */
      this.dofDepthToView[0] = this.dofInvProjection[10] ?? 0;
      this.dofDepthToView[1] = this.dofInvProjection[14] ?? 0;
      this.dofDepthToView[2] = this.dofInvProjection[11] ?? 0;
      this.dofDepthToView[3] = this.dofInvProjection[15] ?? 1;
      f[at('uFocusDistance')] = this.focusDistance;
      f[at('uFocusRange')] = this.focusRange;
      /* Height over width, so a radius in fractions of the height is a circle on screen. */
      f[at('uDofAspect')] = this.surface.canvas.height / Math.max(1, this.surface.canvas.width);
      f[at('uDofAspect') + 1] = 1;
      f.set(this.dofDepthToView, at('uDepthToView'));
    }
    f[at('uBloomStrength')] = bloomStrength;
    /* The veil, composited last of everything this pass does. See `setFrameVeil`. */
    f.set(this.veilColor, at('uVeilColor'));
    f[at('uVeilAlpha')] = this.veilAlpha;
    /* The grade, sampled after the curve and before the veil. See `uGradeLut` in `rush.ts`. */
    f[at('uGradeStrength')] = this.gradeStrength;
    f[at('uGradeSize')] = this.gradeSize;
    device.queue.writeBuffer(this.rushUniforms, 0, this.rushStaging);

    const pass = encoder.beginRenderPass({
      label: 'post.composite',
      timestampWrites: this.gpuTimer.writesFor(),
      colorAttachments: [
        { view: swap, loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 1] },
      ],
    });
    pass.setPipeline(
      postPipeline(
        this.pipelines,
        device,
        this.rushLayout,
        'post.rush',
        RUSH_FRAG_WGSL,
        this.surface.format,
      ),
    );
    const rush = this.reconstructing ? this.reconRushGroup : this.rushBindGroup;
    if (rush === null) return;
    pass.setBindGroup(0, rush, [0]);
    pass.draw(3);
    pass.end();
  }

  /**
   * The composite's bind group, rebuilt from whatever views exist now.
   *
   * **Extracted from `ensureComposite` because a colour grade also invalidates it.** A bind group
   * holds the *views* it was built with, so a resized target and a replaced lookup table are the
   * same problem — and having two places build one group is how the two would come to disagree
   * about which bindings it carries.
   *
   * A null scene view means the composite has not been sized yet, and `ensureComposite` will call
   * this when it is. Doing nothing here is correct rather than a deferral: there is nothing to
   * bind and no frame in flight to break.
   */
  private rebuildRushBindGroup(): void {
    if (this.sceneColorView === null || this.resolvedDepthView === null) return;
    if (this.aoTargetView === null) return;
    this.rushBindGroup = this.buildRushBindGroup('post.rushBindGroup', this.sceneColorView);
    /*
     * **And the reconstruction's twin, from the same three call sites.** A colour grade replaces
     * the lookup table and a resize replaces the depth and the occlusion target, and both groups
     * hold all three — so a second place that rebuilt only one of them is how the composite would
     * come to read a stale view on exactly the frames a consumer changed something.
     */
    if (this.reconShownView !== null) {
      this.reconRushGroup = this.buildRushBindGroup('recon.rushBindGroup', this.reconShownView);
    }
  }

  /** The composite's group over one scene source. See `rebuildRushBindGroup`. */
  private buildRushBindGroup(label: string, sceneView: GPUTextureView): GPUBindGroup | null {
    const { device } = this.surface;
    if (this.resolvedDepthView === null || this.aoTargetView === null) return null;
    const entry = (
      b: { texture: number; sampler: number },
      view: GPUTextureView,
      depth = false,
    ) => [
      { binding: b.texture, resource: view },
      { binding: b.sampler, resource: depth ? this.postDepthSampler : this.postSampler },
    ];
    return device.createBindGroup({
      label,
      entries: [
        { binding: RUSH_UNIFORMS, resource: { buffer: this.rushUniforms, size: RUSH_FRAG_SIZE } },
        ...entry(RUSH_TEXTURES.uScene, sceneView),
        ...entry(RUSH_TEXTURES.uDepth, this.resolvedDepthView, true),
        ...entry(RUSH_TEXTURES.uAo, this.aoTargetView),
        /* Level 0, which is where every octave has been added by the time the composite reads
           it. Falling back to the scene keeps a texture bound where the pyramid would not fit;
           the strength is zero in that case, and an unbound texture is not a thing to hand a
           driver that may fetch a descriptor before it evaluates the branch that skips the read.
           `sceneTarget.ts` binds its own placeholder for the same reason. */
        ...entry(RUSH_TEXTURES.uBloom, this.bloomLevels[0]?.view ?? sceneView),
        /* The grade, with the identity placeholder built on demand rather than at construction:
           a frame that never grades anything should not carry a texture, and a declared binding
           must still have a complete one — the argument the bloom fallback above makes. */
        ...entry(RUSH_TEXTURES.uGradeLut, this.ensureGradeView()),
      ],
      layout: this.rushLayout,
    });
  }

  /**
   * A field's offset in a post-chain block, or a throw.
   *
   * **Loud, like the flat pass's own, and for a reason this file proved the hard way.** These
   * blocks are small and their names are easy to guess wrong: the occlusion block has no
   * `uTexelSize` and the bloom block calls it `uTexel` and has no `uStrength` at all. A lookup
   * returning −1 writes to index −1 of a typed array, which is *silently discarded* — so a
   * mistyped name is an effect that runs with an unset uniform and draws a plausible picture.
   * Both of those were written here and neither raised anything.
   */
  private postField(fields: UniformFields, name: string): number {
    const field = fields[name];
    if (field === undefined) throw new Error(`post: no field ${name}`);
    return field.offset / 4;
  }

  /** Sample zero of the depth, into something the generated shaders can sample. */
  /**
   * Allocate what a reconstruction needs, and release it when nobody is asking.
   *
   * Sized by a key rather than by comparing four numbers, because three of the six targets are the
   * output's size and three are the render's, and a comparison that checked one pair would rebuild
   * half of them on a resize and keep the other half at the old size — which the device accepts,
   * a bind group holding views of two different sizes being perfectly legal, and which draws a
   * picture with a piece of it at the wrong scale.
   */
  private ensureReconstruction(
    renderWidth: number,
    renderHeight: number,
    outputWidth: number,
    outputHeight: number,
  ): void {
    const wanted = this.reconstructionWanted;
    const key = wanted ? `${renderWidth}x${renderHeight}:${outputWidth}x${outputHeight}` : '';
    if (key === this.reconSizeKey) return;
    this.reconSizeKey = key;

    for (const dead of [
      ...this.reconHistories,
      this.reconShown,
      this.reconMotion,
      this.reconPreviousDepth,
    ]) {
      dead?.destroy();
    }
    this.reconHistories = [null, null];
    this.reconHistoryViews = [null, null];
    this.reconShown = null;
    this.reconShownView = null;
    this.reconMotion = null;
    this.reconMotionView = null;
    this.reconPreviousDepth = null;
    this.reconPreviousDepthView = null;
    this.reconGroups = [null, null];
    this.reconSharpenGroups = [null, null];
    this.reconRushGroup = null;
    /* A history of a size that no longer exists is not a history of this frame. */
    this.reconHasHistory = false;
    if (!wanted) return;

    const { device } = this.surface;
    const HISTORY_USAGE = 0x4 | 0x8; // TEXTURE_BINDING | STORAGE_BINDING
    for (let i = 0; i < 2; i += 1) {
      const texture = device.createTexture({
        label: `recon.history${String(i)}`,
        size: [outputWidth, outputHeight],
        format: RECON_HISTORY_FORMAT,
        usage: HISTORY_USAGE,
      });
      this.reconHistories[i] = texture;
      this.reconHistoryViews[i] = texture.createView();
    }
    this.reconShown = device.createTexture({
      label: 'recon.shown',
      size: [outputWidth, outputHeight],
      format: RECON_HISTORY_FORMAT,
      usage: HISTORY_USAGE,
    });
    this.reconShownView = this.reconShown.createView();
    this.reconMotion = device.createTexture({
      label: 'recon.motion',
      size: [renderWidth, renderHeight],
      format: RECON_HISTORY_FORMAT,
      /* An attachment as well, because the pass that will write it is a draw. Nothing writes it
         today and nothing needs to clear it either: WebGPU zero-initialises a new texture, and
         a zero in the fourth channel is what tells the resolve to derive the camera's motion. */
      usage: 0x4 | 0x10,
    });
    this.reconMotionView = this.reconMotion.createView();
    this.reconPreviousDepth = device.createTexture({
      label: 'recon.previousDepth',
      size: [renderWidth, renderHeight],
      format: RESOLVED_DEPTH_FORMAT,
      usage: 0x4 | 0x2, // TEXTURE_BINDING | COPY_DST
    });
    this.reconPreviousDepthView = this.reconPreviousDepth.createView();

    this.reconParams ??= device.createBuffer({
      label: 'recon.params',
      size: this.reconStaging.byteLength,
      usage: 0x40 | 0x8, // UNIFORM | COPY_DST
    });
    this.buildReconPipelines();
    this.rebuildReconGroups();
  }

  /**
   * The two dispatches, over one explicit layout.
   *
   * **Explicit and not `layout: 'auto'`**, which §3 row 51 is about: an inferred layout names only
   * the bindings its own entry point reads, and these two read different subsets of one module —
   * the sharpen touches nothing but the history and the target. Two inferred layouts cannot share
   * a bind group, and building two groups over the same resources is two things to keep in step.
   */
  private buildReconPipelines(): void {
    if (this.reconLayout !== null) return;
    const { device } = this.surface;
    const COMPUTE = 0x4; // GPUShaderStage.COMPUTE
    const sampled = (binding: number, sampleType: GPUTextureSampleType) => ({
      binding,
      visibility: COMPUTE,
      texture: { sampleType, viewDimension: '2d' as const },
    });
    this.reconLayout = device.createBindGroupLayout({
      label: 'recon.layout',
      entries: [
        sampled(0, 'float'),
        /* r32float is not filterable, and the resolve only ever loads a depth texel. */
        sampled(1, 'unfilterable-float'),
        sampled(2, 'float'),
        sampled(3, 'unfilterable-float'),
        sampled(4, 'float'),
        { binding: 5, visibility: COMPUTE, sampler: { type: 'filtering' as const } },
        { binding: 6, visibility: COMPUTE, buffer: { type: 'uniform' as const } },
        {
          binding: 7,
          visibility: COMPUTE,
          storageTexture: {
            access: 'write-only' as const,
            format: RECON_HISTORY_FORMAT,
            viewDimension: '2d' as const,
          },
        },
      ],
    });
    const module = device.createShaderModule({ label: 'recon.resolve', code: reconResolveWgsl() });
    const layout = device.createPipelineLayout({ bindGroupLayouts: [this.reconLayout] });
    this.reconResolvePipeline = device.createComputePipeline({
      label: 'recon.resolve',
      layout,
      compute: { module, entryPoint: 'resolveMain' },
    });
    this.reconSharpenPipeline = device.createComputePipeline({
      label: 'recon.sharpen',
      layout,
      compute: { module, entryPoint: 'sharpenMain' },
    });
  }

  /**
   * The four groups, one a direction of the ping-pong and one a dispatch.
   *
   * The resolve reads history `1 - write` and writes history `write`; the sharpen reads history
   * `write` and writes the shown picture. A group holds the views it was built with, so this is
   * called whenever any of them is replaced.
   */
  private rebuildReconGroups(): void {
    const layout = this.reconLayout;
    const params = this.reconParams;
    if (layout === null || params === null) return;
    if (this.sceneColorView === null || this.resolvedDepthView === null) return;
    if (this.reconMotionView === null || this.reconPreviousDepthView === null) return;
    if (this.reconShownView === null) return;
    const { device } = this.surface;
    const build = (label: string, history: GPUTextureView, target: GPUTextureView) =>
      device.createBindGroup({
        label,
        layout,
        entries: [
          { binding: 0, resource: this.sceneColorView as GPUTextureView },
          { binding: 1, resource: this.resolvedDepthView as GPUTextureView },
          { binding: 2, resource: this.reconMotionView as GPUTextureView },
          { binding: 3, resource: this.reconPreviousDepthView as GPUTextureView },
          { binding: 4, resource: history },
          { binding: 5, resource: this.postSampler },
          { binding: 6, resource: { buffer: params } },
          { binding: 7, resource: target },
        ],
      });
    for (let write = 0; write < 2; write += 1) {
      const read = this.reconHistoryViews[1 - write];
      const target = this.reconHistoryViews[write];
      if (read === null || target === null) continue;
      this.reconGroups[write] = build(`recon.resolve${String(write)}`, read, target);
      this.reconSharpenGroups[write] = build(
        `recon.sharpen${String(write)}`,
        target,
        this.reconShownView,
      );
    }
    /* The composite's own group, over the resolved picture instead of the scene target. */
    this.reconRushGroup = this.buildRushBindGroup('recon.rushBindGroup', this.reconShownView);
    /* And the scene's, because `ensureComposite` built it before this one existed. */
    this.rebuildRushBindGroup();
  }

  /**
   * Remember that this mesh moved, so the motion pass can draw where it was.
   *
   * Silent unless a reconstruction is running: a scene that always states its previous transforms
   * — which is the right thing for a scene to do, the alternative being to know what the renderer
   * is configured as — must cost nothing at all when nobody is going to read them.
   */
  private recordMotion(
    mesh: GpuMesh,
    model: ArrayLike<number>,
    previousModel: ArrayLike<number>,
  ): void {
    if (!this.reconstructing) return;
    const at = this.motionCount;
    const wanted = (at + 1) * MOTION_DRAW_FLOATS;
    if (this.motionMatrices.length < wanted) {
      /* Doubling, so a scene settles on one allocation rather than one a draw. */
      const grown = new Float32Array(Math.max(wanted, this.motionMatrices.length * 2, 64));
      grown.set(this.motionMatrices);
      this.motionMatrices = grown;
    }
    this.motionMatrices.set(model as ArrayLike<number> & Iterable<number>, at * MOTION_DRAW_FLOATS);
    this.motionMatrices.set(
      previousModel as ArrayLike<number> & Iterable<number>,
      at * MOTION_DRAW_FLOATS + 16,
    );
    this.motionMeshes[at] = mesh;
    this.motionCount = at + 1;
  }

  /**
   * The pipeline the motion pass draws with, built once.
   *
   * **The position buffer alone**, because that is all the shader reads and a mesh keeps one buffer
   * an attribute — so this binds buffer zero and nothing else, whatever else the mesh carries.
   */
  private buildMotionPipeline(): void {
    if (this.motionLayout !== null) return;
    const { device } = this.surface;
    this.motionLayout = device.createBindGroupLayout({
      label: 'recon.motion.layout',
      entries: [
        { binding: 0, visibility: 0x1, buffer: { type: 'uniform' as const } },
        {
          binding: 1,
          visibility: 0x1,
          buffer: { type: 'uniform' as const, hasDynamicOffset: true },
        },
      ],
    });
    this.motionModule = device.createShaderModule({
      label: 'recon.motion',
      code: RECON_MOTION_WGSL,
    });
    this.motionPipelineLayout = device.createPipelineLayout({
      bindGroupLayouts: [this.motionLayout],
    });
  }

  /** The pipeline for one vertex stride, built on first sight of it. */
  private motionPipelineFor(stride: number): GPURenderPipeline | null {
    const held = this.motionPipelines.get(stride);
    if (held !== undefined) return held;
    const module = this.motionModule;
    const layout = this.motionPipelineLayout;
    if (module === null || layout === null) return null;
    const { device } = this.surface;
    const pipeline = device.createRenderPipeline({
      label: `recon.motion.${String(stride)}`,
      layout,
      vertex: {
        module,
        entryPoint: 'motionVert',
        /* Positions are the layout's first attribute and are never optional, so they are at offset
           zero of every stride this can be handed. */
        buffers: [
          {
            arrayStride: stride,
            attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x3' }],
          },
        ],
      },
      fragment: { module, entryPoint: 'motionFrag', targets: [{ format: MOTION_TARGET_FORMAT }] },
      /*
       * **The scene's own winding**, because this draws the scene's geometry through the scene's
       * clip transform — the product the renderer hands over already carries the negation that
       * `naga` writes into every generated vertex stage, so the faces come out the way they did
       * and a `cw` front face here would draw the inside of every mesh. §3 row 57.
       */
      primitive: { topology: 'triangle-list', cullMode: 'back' },
      depthStencil: {
        format: DEPTH_FORMAT,
        /*
         * **Tested and not written.** The frame's depth is finished; this pass only wants the
         * pixels the scene actually kept, and `DEPTH_COMPARE_EQUAL` is the comparison that admits
         * exactly them — the same transform on the same positions gives the same depth, which is
         * why the rasterisation matrix is handed over whole rather than rebuilt here.
         *
         * **And the equality is not fragile here**, which was worth measuring rather than
         * assuming: this driver contracts multiply-adds (§3 row 107) and two shader modules can
         * contract a matrix product differently, so an equality across them could have admitted
         * only some of a surface. Run with `greater-equal` instead, the ghost measured the same
         * to the pixel — 5,942 either way — so nothing is being dropped.
         */
        depthWriteEnabled: false,
        depthCompare: DEPTH_COMPARE_EQUAL,
      },
    });
    this.motionPipelines.set(stride, pipeline);
    return pipeline;
  }

  /**
   * Where every mover was last frame, into the motion target.
   *
   * **After everything that draws and before the resolve reads it.** The frame's depth has to be
   * finished for the equality test to mean anything, and the resolve is what consumes the result.
   */
  private runMotion(encoder: GPUCommandEncoder): void {
    const target = this.reconMotionView;
    const depth = this.depthView;
    if (!this.reconstructing || target === null || depth === null) return;
    const { device } = this.surface;
    this.buildMotionPipeline();
    const layout = this.motionLayout;
    if (layout === null) return;

    /*
     * **Cleared every frame, even when nothing moved.** A texel left from last frame is a flag
     * saying "a draw wrote this", and the resolve would take a motion belonging to a surface that
     * is no longer there. The clear is the pass's own load operation, so an empty queue still runs
     * it — which is why this is not returned from before the pass is opened.
     */
    const pass = encoder.beginRenderPass({
      label: 'recon.motion',
      timestampWrites: this.gpuTimer.writesFor(),
      colorAttachments: [
        { view: target, loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 0] },
      ],
      depthStencilAttachment: {
        view: depth,
        depthLoadOp: 'load',
        depthStoreOp: 'store',
        depthReadOnly: false,
      },
    });

    const count = this.motionCount;
    if (count > 0) {
      const bytes = count * MOTION_DRAW_STRIDE;
      if (this.motionDrawCapacity < count) {
        this.motionDrawBuffer?.destroy();
        this.motionDrawCapacity = Math.max(count, this.motionDrawCapacity * 2, 16);
        this.motionDrawBuffer = device.createBuffer({
          label: 'recon.motion.draws',
          size: this.motionDrawCapacity * MOTION_DRAW_STRIDE,
          usage: 0x40 | 0x8, // UNIFORM | COPY_DST
        });
        this.motionDrawStaging = new Uint8Array(this.motionDrawCapacity * MOTION_DRAW_STRIDE);
        this.motionGroup = null;
      }
      this.motionFrameBuffer ??= device.createBuffer({
        label: 'recon.motion.frame',
        size: MOTION_FRAME_FLOATS * 4,
        usage: 0x40 | 0x8,
      });
      this.motionGroup ??= device.createBindGroup({
        label: 'recon.motion.group',
        layout,
        entries: [
          { binding: 0, resource: { buffer: this.motionFrameBuffer } },
          {
            binding: 1,
            resource: { buffer: this.motionDrawBuffer as GPUBuffer, size: MOTION_DRAW_STRIDE },
          },
        ],
      });

      /* The scene's clip transform, with the generated stages' y negation folded in. */
      mat4.multiply(this.motionRaster, MOTION_CLIP_FLIP, this.viewProj ?? this.correctedViewProj);
      this.motionFrameStaging.set(this.motionRaster as Float32Array, 0);
      this.motionFrameStaging.set(this.frameRawViewProj as Float32Array, 16);
      this.motionFrameStaging.set(this.reconPreviousRawViewProj as Float32Array, 32);
      device.queue.writeBuffer(this.motionFrameBuffer, 0, this.motionFrameStaging);

      const draws = new Float32Array(this.motionDrawStaging.buffer);
      for (let i = 0; i < count; i += 1) {
        draws.set(
          this.motionMatrices.subarray(i * MOTION_DRAW_FLOATS, (i + 1) * MOTION_DRAW_FLOATS),
          (i * MOTION_DRAW_STRIDE) / 4,
        );
      }
      device.queue.writeBuffer(
        this.motionDrawBuffer as GPUBuffer,
        0,
        this.motionDrawStaging,
        0,
        bytes,
      );

      let bound: GPURenderPipeline | null = null;
      for (let i = 0; i < count; i += 1) {
        const mesh = this.motionMeshes[i];
        if (mesh === undefined) continue;
        const pipeline = this.motionPipelineFor(mesh.vertexStride);
        if (pipeline === null) continue;
        if (pipeline !== bound) {
          pass.setPipeline(pipeline);
          bound = pipeline;
        }
        pass.setBindGroup(0, this.motionGroup, [i * MOTION_DRAW_STRIDE]);
        pass.setVertexBuffer(0, mesh.vertexBuffers[0] as GPUBuffer);
        pass.setIndexBuffer(mesh.indexBuffer, 'uint32');
        pass.drawIndexed(mesh.indexCount);
      }
    }
    pass.end();
  }

  /**
   * DriftTR tier 0: the jittered render at the render size into the picture at the output size.
   *
   * `recon/resolve.ts` is the reference this is held to and `scripts/recon-parity.mjs` compares the
   * two; nothing here decides anything the reference does not.
   */
  private runReconstruction(encoder: GPUCommandEncoder): void {
    if (!this.reconstructing) return;
    const resolve = this.reconResolvePipeline;
    const sharpen = this.reconSharpenPipeline;
    const params = this.reconParams;
    const write = this.reconWrite;
    const group = this.reconGroups[write];
    const sharpenGroup = this.reconSharpenGroups[write];
    if (resolve === null || sharpen === null || params === null) return;
    if (group === null || sharpenGroup === null) return;
    const { device } = this.surface;
    const outputWidth = Math.max(1, this.surface.canvas.width);
    const outputHeight = Math.max(1, this.surface.canvas.height);

    /*
     * **The unjittered matrices**, which is what the reference's own header insists on: the
     * history stands for the scene as it would have been drawn with no jitter, and the motion the
     * resolve derives carries none. `frameRawViewProj` is the camera's own view-projection, in
     * OpenGL's depth convention — which is the convention the shader's accessor converts the
     * renderer's reversed buffer into.
     */
    mat4.invert(this.reconInverseViewProj, this.frameRawViewProj);
    const f = this.reconFloats;
    const u = this.reconInts;
    u[0] = this.renderWidth;
    u[1] = this.renderHeight;
    u[2] = outputWidth;
    u[3] = outputHeight;
    f[4] = this.reconJitter[0] as number;
    f[5] = this.reconJitter[1] as number;
    f[6] = this.reconPreviousJitter[0] as number;
    f[7] = this.reconPreviousJitter[1] as number;
    f.set(this.reconInverseViewProj as Float32Array, 8);
    f.set(this.reconPreviousRawViewProj as Float32Array, 24);
    f.set(this.reconPreviousInverseViewProj as Float32Array, 40);
    f.set(this.reconEye, 56);
    f.set(this.reconPreviousEye, 60);
    f[64] = DEFAULT_RECON_QUALITY.alpha;
    f[65] = DEFAULT_RECON_QUALITY.sharpen;
    f[66] = DEFAULT_RECON_QUALITY.clampGamma;
    u[67] = this.reconHasHistory ? 1 : 0;
    f[68] = DEFAULT_DISOCCLUSION.depthTolerance;
    f[69] = DEFAULT_DISOCCLUSION.motionScale;
    f[70] = DEFAULT_DISOCCLUSION.normalFloor;
    f[71] = DEFAULT_DISOCCLUSION.normalCeiling;
    device.queue.writeBuffer(params, 0, this.reconStaging);

    const groupsX = Math.ceil(outputWidth / RECON_WORKGROUP);
    const groupsY = Math.ceil(outputHeight / RECON_WORKGROUP);
    const pass = encoder.beginComputePass({
      label: 'recon.resolve',
      timestampWrites: this.gpuTimer.writesFor(),
    });
    pass.setPipeline(resolve);
    pass.setBindGroup(0, group);
    pass.dispatchWorkgroups(groupsX, groupsY, 1);
    /*
     * **The sharpen in the same pass, and that is legal because it reads a different texture.**
     * The resolve wrote history `write`; the sharpen reads it and writes the shown picture. Two
     * dispatches in one compute pass see each other's writes in recording order, and the rule
     * §3 row 52 is about — one buffer writable and readable in a single synchronisation scope —
     * does not bite, because no resource here is both.
     */
    pass.setPipeline(sharpen);
    pass.setBindGroup(0, sharpenGroup);
    pass.dispatchWorkgroups(groupsX, groupsY, 1);
    pass.end();

    /* Last frame's depth, for the disocclusion test and the normals derived from it. */
    const depth = this.resolvedDepth;
    const previous = this.reconPreviousDepth;
    if (depth !== null && previous !== null) {
      encoder.copyTextureToTexture({ texture: depth }, { texture: previous }, [
        previous.width,
        previous.height,
        1,
      ]);
    }

    this.reconWrite = 1 - write;
    this.reconHasHistory = true;
    mat4.copy(this.reconPreviousRawViewProj, this.frameRawViewProj);
    mat4.copy(this.reconPreviousInverseViewProj, this.reconInverseViewProj);
    this.reconPreviousEye.set(this.reconEye);
  }

  private resolveDepth(encoder: GPUCommandEncoder): void {
    const target = this.resolvedDepthView;
    const source = this.depthView;
    if (target === null || source === null) return;
    const { device } = this.surface;
    const multisampled = this.samples > 1;
    const pass = encoder.beginRenderPass({
      label: 'post.depthResolve',
      timestampWrites: this.gpuTimer.writesFor(),
      colorAttachments: [
        { view: target, loadOp: 'clear', storeOp: 'store', clearValue: [1, 1, 1, 1] },
      ],
    });
    pass.setPipeline(
      depthResolvePipeline(this.pipelines, device, this.depthResolveLayout, multisampled),
    );
    pass.setBindGroup(
      0,
      device.createBindGroup({
        layout: this.depthResolveLayout,
        entries: [{ binding: 0, resource: source }],
      }),
    );
    pass.draw(3);
    pass.end();
  }

  /**
   * Occlusion from the depth the resolve produced, then a blur across it.
   *
   * The projection is what turns a radius in metres into a radius in UV, and it is null until a
   * mesh pass has settled one — the honest guard `renderer.ts` uses, because occlusion built on
   * an identity projection samples the depth of a scene nobody drew.
   */
  /**
   * This frame resolved against the history, into the half of the pair it did not read.
   *
   * **A blend of zero still runs the pass.** The first frame, the frame after a resize and the
   * frame after a cut have nothing to sample and the shader exits early on that — but the pass
   * must still write, or the history it leaves for the next frame is whatever was in the texture.
   */
  private temporalResolve(encoder: GPUCommandEncoder): void {
    /*
     * **One guard, not two.** A second test on `reconstructing` here read as belt and braces and
     * was worse than nothing: it and the `!reconstructing` in `temporalJittering`'s own condition
     * each covered the other, so breaking either one changed no behaviour and no test could see
     * it. `temporalJittering` is where the choice is made, and it is made once.
     */
    if (!this.temporalJittering) return;
    const write = this.taaWrite;
    const target = this.taaViews[write];
    const group = this.taaBindGroups[1 - write];
    if (target === null || group === null) return;
    const { device } = this.surface;

    const f = this.taaFloats;
    const at = (name: string): number => this.postField(TAA_FRAG_FIELDS, name);
    f.set(this.reprojection, at('uReprojection'));
    f[at('uTexel')] = 1 / this.renderWidth;
    f[at('uTexel') + 1] = 1 / this.renderHeight;
    f[at('uHistoryBlend')] = this.temporalHistoryUsable ? TEMPORAL_HISTORY_BLEND : 0;
    device.queue.writeBuffer(this.taaUniforms, 0, this.taaStaging);

    const pass = encoder.beginRenderPass({
      label: 'post.taa',
      timestampWrites: this.gpuTimer.writesFor(),
      colorAttachments: [
        { view: target, loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 1] },
      ],
    });
    pass.setPipeline(
      postPipeline(
        this.pipelines,
        device,
        this.taaLayout,
        'post.taa',
        TEMPORAL_RESOLVE_FRAG_WGSL,
        sceneColorFormat(this.quality.hdrScene),
      ),
    );
    pass.setBindGroup(0, group, [0]);
    pass.draw(3);
    pass.end();

    /*
     * **Copied back over the scene, rather than rebound downstream.**
     *
     * Bloom, occlusion and the composite each hold bind groups built against the scene view, and
     * a group holds the view it was built with — so pointing them at the resolved texture means a
     * second group for every one of them, on this backend only. WebGL2 rebinds a texture unit and
     * pays nothing for the same result, and two backends that composite *different pictures* is
     * the disagreement this repository exists to prevent.
     *
     * So the resolved frame is copied into the scene target and every reader downstream is
     * untouched, on both backends, by construction. The cost is one full-frame copy on a frame
     * that asked for the effect, and it buys parity that would otherwise have to be argued.
     */
    const scene = this.sceneColor;
    const resolved = this.taaTextures[write];
    if (scene !== null && resolved !== null) {
      encoder.copyTextureToTexture({ texture: resolved }, { texture: scene }, [
        scene.width,
        scene.height,
        1,
      ]);
    }

    this.taaWrite = 1 - write;
    this.temporalHistory.accumulated();
  }

  /**
   * The frame's reflective surfaces, marched against the picture and composited over it.
   *
   * **Two passes, and the first cannot write where it reads.** The trace samples the scene colour
   * to find out what a ray hit, so it writes into a buffer of its own; the resolve then hands those
   * premultiplied texels to an `over` blend. Either half writing into the texture the other reads
   * would be a validation failure here and a feedback loop on the other backend, which is the same
   * argument `runOit` makes about its own resolve.
   *
   * **Excluded while multisampling**, which is not timidity: the other backend cannot sample a
   * multisampled colour attachment at all, and a reflection that appears on one backend and not the
   * other is the disagreement the parity rule exists to prevent. Said once rather than dropped.
   */
  private runReflections(encoder: GPUCommandEncoder): void {
    if (this.reflectionQueue.length === 0) return;
    const scene = this.sceneColorView;
    const reflection = this.ssrReflectionView;
    const group = this.ssrBindGroup;
    const resolveGroup = this.ssrResolveGroup;
    if (scene === null || reflection === null || group === null || resolveGroup === null) {
      this.refuseReflections();
      return;
    }
    if (this.samples > 1) {
      this.refuseReflections();
      return;
    }
    if (!this.frameCameraSeen) return;
    const { device } = this.surface;
    /* The scene's size: this marches through the picture's own texels, not the viewer's. */
    const width = this.renderWidth;
    const height = this.renderHeight;
    const view = this.frameRawViewProj as Float32Array;

    mat4.invert(this.ssrDepthToWorld, view);
    mat4.multiply(this.ssrDepthToWorld, this.ssrDepthToWorld, DEPTH_01_TO_CLIP_Y_DOWN);
    /* The framebuffer's Y sense, premultiplied in rather than branched on inside the shader. See
       `CLIP_Y_FLIP`, and `DEPTH_01_TO_CLIP_Y_DOWN` for what one missing negation costs. */
    mat4.multiply(this.ssrViewProj, CLIP_Y_FLIP, view);

    const f = this.ssrFloats;
    const at = (name: string): number => this.postField(SSR_FRAG_FIELDS, name);
    let slot = 0;
    this.reflectionQueue.replay((surface) => {
      const base = (slot * SSR_SLOT) / 4;
      f.set(this.ssrDepthToWorld, base + at('uSsrDepthToWorld'));
      f.set(this.ssrViewProj, base + at('uSsrViewProj'));
      f.set(surface.worldToSurface, base + at('uWorldToSurface'));
      f.set(this.frameEye, base + at('uSsrEye'));
      f.set(surface.axis, base + at('uSsrAxis'));
      f.set(surface.tint, base + at('uSsrTint'));
      f[base + at('uSsrStrength')] = surface.strength;
      f[base + at('uSsrFacingCos')] = surface.facingCos;
      f[base + at('uSsrReach')] = surface.reachM;
      f[base + at('uSsrThickness')] = surface.thicknessM;
      f[base + at('uSsrSteps')] = surface.steps;
      f[base + at('uSsrEdgeFade')] = REFLECTION_EDGE_FADE;
      slot++;
    });
    device.queue.writeBuffer(this.ssrUniforms, 0, this.ssrStaging, 0, slot * SSR_SLOT);

    /* Cleared whole and then scissored per surface: the resolve reads every pixel, and one left
       from the last frame would composite that reflection over this frame's scene. */
    const trace = encoder.beginRenderPass({
      label: 'post.ssr.trace',
      colorAttachments: [
        { view: reflection, loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 0] },
      ],
    });
    trace.setPipeline(
      postPipeline(
        this.pipelines,
        device,
        this.ssrLayout,
        'post.ssrTrace',
        SSR_TRACE_FRAG_WGSL,
        this.pipelines.format,
        PREMULTIPLIED_OVER_BLEND,
      ),
    );
    slot = 0;
    this.reflectionQueue.replay((surface) => {
      const index = slot++;
      if (!decalScissor(view, surface.surfaceToWorld, width, height, true, this.ssrScissor)) {
        return;
      }
      trace.setScissorRect(
        this.ssrScissor[0] ?? 0,
        this.ssrScissor[1] ?? 0,
        this.ssrScissor[2] ?? 0,
        this.ssrScissor[3] ?? 0,
      );
      trace.setBindGroup(0, group, [index * SSR_SLOT]);
      trace.draw(3);
    });
    trace.end();

    const resolve = encoder.beginRenderPass({
      label: 'post.ssr.resolve',
      colorAttachments: [{ view: scene, loadOp: 'load', storeOp: 'store' }],
    });
    resolve.setPipeline(
      postPipeline(
        this.pipelines,
        device,
        this.ssrResolveLayout,
        'post.ssrResolve',
        SSR_RESOLVE_FRAG_WGSL,
        this.pipelines.format,
        PREMULTIPLIED_OVER_BLEND,
      ),
    );
    resolve.setBindGroup(0, resolveGroup);
    resolve.draw(3);
    resolve.end();
  }

  /**
   * The frame's marks, multiplied into the finished scene.
   *
   * **One scissored triangle each and no geometry at all.** The mark is decided per pixel from the
   * resolved depth, so the rasteriser is only asked for coverage of the part of the screen the
   * projector box can reach — `decalScissor` computes that from the box's eight corners, and
   * argues there why a rectangle stands in for drawing the box as a mesh.
   *
   * **Every block is written before the pass opens.** `queue.writeBuffer` is ordered on the queue
   * timeline and does not interleave with recorded commands, so writing one block between two
   * draws would give both draws the last write — every mark wearing the last projector's pose.
   * That is the hazard `bloomStaging` records, met by a pass that runs many times in one frame.
   */
  private runDecals(encoder: GPUCommandEncoder): void {
    if (this.decalQueue.length === 0) return;
    const scene = this.sceneColorView;
    const group = this.decalBindGroup;
    if (scene === null || group === null) {
      this.refuseDecals();
      return;
    }
    if (!this.frameCameraSeen) return;
    const { device } = this.surface;
    /* The scene's size: a mark is projected onto the depth this frame drew, at that depth's size. */
    const width = this.renderWidth;
    const height = this.renderHeight;
    const view = this.frameRawViewProj as Float32Array;

    mat4.invert(this.decalDepthToWorld, view);
    mat4.multiply(this.decalDepthToWorld, this.decalDepthToWorld, DEPTH_01_TO_CLIP_Y_DOWN);

    const f = this.decalFloats;
    const at = (name: string): number => this.postField(DECAL_FRAG_FIELDS, name);
    let slot = 0;
    this.decalQueue.replay((decal) => {
      const base = (slot * DECAL_SLOT) / 4;
      f.set(this.decalDepthToWorld, base + at('uDecalDepthToWorld'));
      f.set(decal.worldToDecal, base + at('uWorldToDecal'));
      f.set(this.frameEye, base + at('uDecalEye'));
      f.set(decal.axis, base + at('uDecalAxis'));
      f.set(decal.color, base + at('uDecalColor'));
      f[base + at('uDecalOpacity')] = decal.opacity;
      f[base + at('uDecalFacingCos')] = decal.facingCos;
      f[base + at('uDecalSoftness')] = decal.softness;
      slot++;
    });
    device.queue.writeBuffer(this.decalUniforms, 0, this.decalStaging, 0, slot * DECAL_SLOT);

    const pass = encoder.beginRenderPass({
      label: 'post.decals',
      colorAttachments: [{ view: scene, loadOp: 'load', storeOp: 'store' }],
    });
    pass.setPipeline(
      postPipeline(
        this.pipelines,
        device,
        this.decalLayout,
        'post.decal',
        DECAL_PROJECT_FRAG_WGSL,
        /* Off the cache rather than computed again: `sceneColorFormat` is called once, at
           construction, and a second call is a second chance to disagree with the pipelines. */
        this.pipelines.format,
        DECAL_MULTIPLY_BLEND,
      ),
    );
    slot = 0;
    this.decalQueue.replay((decal) => {
      const index = slot++;
      /* Y down, because this is `setScissorRect` and its origin is the top left. The pair is one
         function taking which convention the caller counts rows in, for the reason
         `DEPTH_01_TO_CLIP_Y_DOWN` gives: a convention held in two places is a pass that marks the
         mirror image of what it should on one backend, with nothing raising. */
      if (!decalScissor(view, decal.decalToWorld, width, height, true, this.decalScissorRect)) {
        return;
      }
      pass.setScissorRect(
        this.decalScissorRect[0] ?? 0,
        this.decalScissorRect[1] ?? 0,
        this.decalScissorRect[2] ?? 0,
        this.decalScissorRect[3] ?? 0,
      );
      pass.setBindGroup(0, group, [index * DECAL_SLOT]);
      pass.draw(3);
    });
    pass.end();
  }

  /**
   * The recorded translucent set, accumulated and revealed, then composited over the scene.
   *
   * **Two passes over the same geometry**, because the two buffers are two blend states and a
   * blend state is baked into a pipeline here. The accumulation sums weighted colour; the revealage
   * multiplies what each layer let through. Both commute, which is the whole property — the frame
   * stops depending on which surface was submitted first.
   *
   * **Depth is attached read-only.** They test against the opaque world so a pane behind a wall is
   * rejected at the wall, and neither writes, so nothing hides anything else and there is something
   * left to blend.
   */
  private runOit(encoder: GPUCommandEncoder): void {
    if (!this.oitActive || this.translucentQueue.length === 0) return;
    const accum = this.oitAccumView;
    const reveal = this.oitRevealView;
    const scene = this.sceneColorView;
    const group = this.oitResolveGroup;
    const depth = this.depthView;
    if (accum === null || reveal === null || scene === null || group === null || depth === null) {
      return;
    }
    const { device } = this.surface;
    const options = this.oitReplayOptions;
    /*
     * **A refracting pane reads the frame behind it, and here that frame is finished.** So the
     * copy it reads is taken now, from the resolved scene, once for the whole set — the immediate
     * path takes it by ending the scene's pass, and that pass has already ended. Only when
     * something in the set refracts, because a copy of the frame is not free.
     */
    if (this.translucentQueue.refracts && !this.refractSnapshotTaken) {
      const snapshot = this.refractSnapshot;
      const source = this.sceneColor;
      if (snapshot !== null && source !== null) {
        encoder.copyTextureToTexture({ texture: source }, { texture: snapshot }, [
          snapshot.width,
          snapshot.height,
        ]);
        this.refractSnapshotTaken = true;
      }
    }

    const buffers = [
      { mode: 'accum' as const, view: accum, clear: [0, 0, 0, 0] as const },
      /* Cleared to one: nothing has covered this pixel yet. Cleared to zero the resolve would show
         no scene anywhere the effect ran, which is a black frame that looks like the blend. */
      { mode: 'reveal' as const, view: reveal, clear: [1, 1, 1, 1] as const },
    ];

    for (const buffer of buffers) {
      const pass = encoder.beginRenderPass({
        label: `post.oit.${buffer.mode}`,
        colorAttachments: [
          {
            view: buffer.view,
            loadOp: 'clear',
            storeOp: 'store',
            clearValue: [...buffer.clear],
          },
        ],
        depthStencilAttachment: { view: depth, depthReadOnly: true },
      });
      this.oitEncoder = pass;
      this.oitMode = buffer.mode;
      this.oitReplaying = true;
      this.translucentQueue.replay((draw) => {
        options.lit = draw.lit;
        options.fog = draw.fog;
        options.toneMapped = draw.toneMapped;
        options.depthWrite = false;
        options.depthLayer = draw.depthLayer;
        options.tint = draw.tint as unknown as Vec3 | null;
        /* Replayed too, as the other backend replays it: a pane that refracts under sorted
           blending and stands clear under this effect reads as a bug in the effect. It did stand
           clear here until 2026-09-19. */
        options.refraction = draw.refraction;
        options.refractTint = draw.refractTint as unknown as Vec3 | undefined;
        options.thicknessM = draw.thicknessM;
        this.drawTranslucentMesh(draw.mesh as GpuMesh, draw.model, draw.opacity, options);
      });
      this.oitReplaying = false;
      this.oitMode = 'none';
      this.oitEncoder = null;
      pass.end();
    }

    /*
     * **The rings are flushed again, and without this the passes above draw nothing.**
     *
     * `endFrame` flushes every ring *before* it calls the composite, because until now nothing in
     * the composite submitted geometry — it is all fullscreen triangles with their own uniforms.
     * These two passes do submit geometry, so their per-draw slots are written after that flush
     * and would reach the GPU as zeroes: a zero model matrix is a degenerate triangle, so the
     * draws are issued, no fragments are produced, and the frame comes back black with no error
     * anywhere. `queue.writeBuffer` is ordered on the queue timeline ahead of the submit that
     * follows, so flushing here lands them in front of the commands that read them.
     */
    this.flushRings();

    const resolve = encoder.beginRenderPass({
      label: 'post.oit.resolve',
      colorAttachments: [{ view: scene, loadOp: 'load', storeOp: 'store' }],
    });
    resolve.setPipeline(
      postPipeline(
        this.pipelines,
        device,
        this.oitResolveLayout,
        'post.oitResolve',
        OIT_RESOLVE_FRAG_WGSL,
        sceneColorFormat(this.quality.hdrScene),
        OIT_COMPOSITE_BLEND,
      ),
    );
    resolve.setBindGroup(0, group);
    resolve.draw(3);
    resolve.end();
  }

  /**
   * The global medium: a half-res march, then one composite blended over the scene.
   *
   * **After the glass and before the post chain**, which is where the other backend puts it and
   * for the same reasons: it is the air *in front of* the finished picture, so fog over a
   * reflective floor dims the reflection; and bloom should see a lit fog bank as brightness.
   *
   * Nothing here runs at density 0 — the caller's guard is `mediumActive`, which both backends
   * share so that "identical to the pass being absent" cannot become true on one of them only.
   */
  private runMedium(encoder: GPUCommandEncoder): void {
    const projection = this.frameProjection;
    const scene = this.sceneColorView;
    const target = this.mediumTargetView;
    const marchGroup = this.mediumBindGroup;
    const upsampleGroup = this.mediumUpsampleGroup;
    const env = this.frameEnv;
    if (projection === null || scene === null || target === null) return;
    if (marchGroup === null || upsampleGroup === null) return;
    const { device } = this.surface;
    const options = this.mediumOptions;

    /*
     * Straight from a stored depth to world space. `DEPTH_01_TO_CLIP_Y_DOWN` and not its sibling,
     * and that constant's own derivation is the reason: this backend's framebuffer Y runs down and
     * the generated vertex stages flip Y a second time, so `2v - 1` is the *negation* of what the
     * unprojection has to be handed. One missing negation shortens every reconstructed distance by
     * `cos(2t)` off the view axis, which reads as a fog that thins toward the top of the frame.
     */
    mat4.invert(this.mediumDepthToWorld, this.frameRawViewProj);
    mat4.multiply(this.mediumDepthToWorld, this.mediumDepthToWorld, DEPTH_01_TO_CLIP_Y_DOWN);

    const f = this.mediumFloats;
    const ints = this.mediumInts;
    const at = (name: string): number => this.postField(MEDIUM_FRAG_FIELDS, name);
    f.set(this.mediumDepthToWorld, at('uDepthToWorld'));
    f.set(this.frameEye, at('uCameraPos'));
    f.set(env?.directionalDir ?? [0, 1, 0], at('uSunDir'));
    f.set(env?.directionalColor ?? [0, 0, 0], at('uSunColor'));
    f.set(env?.ambient ?? [0, 0, 0], at('uAmbient'));
    f[at('uDensity')] = options.density;
    f[at('uAlbedo')] = options.albedo;
    f[at('uAnisotropy')] = options.anisotropy;
    f[at('uMaxDistance')] = options.maxDistance;
    ints[at('uSteps')] = this.quality.globalMediumSteps;
    /*
     * Two conditions, as the shaft draw uses: the profile has to have built a map, and the frame
     * has to have refreshed it. A scene that ran no shadow pass leaves `shadowStrength` at zero,
     * and marching against a stale map puts last frame's shafts in this frame's air.
     */
    f[at('uSunShadow')] =
      this.quality.directionalShadows && env !== null
        ? Math.min(1, Math.max(0, env.shadowStrength))
        : 0;
    /* Uncorrected, for the reason the shaft's own copy of this line carries: the shader does its
       own `* 0.5 + 0.5`, and correcting the matrix as well doubles it. */
    f.set(env?.lightViewProj ?? this.mediumIdentity, at('uLightViewProj'));
    ints[at('uPeeledShadowEnabled')] = this.peelView === null || !this.peelFilled ? 0 : 1;
    device.queue.writeBuffer(this.mediumUniforms, 0, this.mediumStaging);

    const g = this.mediumUpsampleFloats;
    const upsampleAt = (name: string): number => this.postField(MEDIUM_UPSAMPLE_FIELDS, name);
    g[upsampleAt('uMediumTexel')] = 1 / Math.max(1, this.mediumTarget?.width ?? 1);
    g[upsampleAt('uMediumTexel') + 1] = 1 / Math.max(1, this.mediumTarget?.height ?? 1);
    /* Column major, so `[2][2]` is element 10 and `[3][3]` is element 15 — the same four
       `ambientOcclusionPass.ts` reads, in the same order. */
    mat4.invert(this.mediumInvProjection, projection);
    const inv = this.mediumInvProjection;
    g[upsampleAt('uDepthToViewZ')] = inv[10] ?? 0;
    g[upsampleAt('uDepthToViewZ') + 1] = inv[14] ?? 0;
    g[upsampleAt('uDepthToViewZ') + 2] = inv[11] ?? 0;
    g[upsampleAt('uDepthToViewZ') + 3] = inv[15] ?? 1;
    device.queue.writeBuffer(this.mediumUpsampleUniforms, 0, this.mediumUpsampleStaging);

    const march = encoder.beginRenderPass({
      label: 'post.medium',
      timestampWrites: this.gpuTimer.writesFor(),
      colorAttachments: [
        { view: target, loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 1] },
      ],
    });
    march.setPipeline(
      postPipeline(
        this.pipelines,
        device,
        this.mediumLayout,
        'post.medium',
        MEDIUM_FRAG_WGSL,
        'rgba16float',
      ),
    );
    march.setBindGroup(0, marchGroup, [0]);
    march.draw(3);
    march.end();

    const composite = encoder.beginRenderPass({
      label: 'post.mediumComposite',
      timestampWrites: this.gpuTimer.writesFor(),
      colorAttachments: [{ view: scene, loadOp: 'load', storeOp: 'store' }],
    });
    composite.setPipeline(
      postPipeline(
        this.pipelines,
        device,
        this.mediumUpsampleLayout,
        'post.mediumComposite',
        MEDIUM_UPSAMPLE_FRAG_WGSL,
        sceneColorFormat(this.quality.hdrScene),
        MEDIUM_TRANSMIT_BLEND,
      ),
    );
    composite.setBindGroup(0, upsampleGroup, [0]);
    composite.draw(3);
    composite.end();
  }

  /** `inverse(viewProj) * DEPTH_01_TO_CLIP_Y_DOWN`, rebuilt once a frame rather than per pass. */
  private readonly mediumDepthToWorld = mat4.create();
  /** Sixteen real numbers for a frame that never set a light matrix. */
  private readonly mediumIdentity = mat4.create();

  private runOcclusion(encoder: GPUCommandEncoder): void {
    const projection = this.frameProjection;
    const depth = this.resolvedDepthView;
    const target = this.aoTargetView;
    if (projection === null || depth === null || target === null) return;
    const { device } = this.surface;

    mat4.invert(this.aoInvProjection, projection);
    /* Column major, so [0][0] is element 0 and [1][1] is element 5: the field of view and the
       aspect, which is all the shader needs. */
    this.aoProjScale[0] = projection[0] ?? 1;
    this.aoProjScale[1] = projection[5] ?? 1;

    const f = this.aoFloats;
    const at = (name: string): number => this.postField(AO_FRAG_FIELDS, name);
    f[at('uRadius')] = this.quality.ambientOcclusionRadius;
    f.set(this.aoProjScale, at('uProjScale'));
    f.set(this.aoInvProjection, at('uInvProjection'));
    device.queue.writeBuffer(this.aoUniforms, 0, this.aoStaging);

    const pass = encoder.beginRenderPass({
      label: 'post.ao',
      timestampWrites: this.gpuTimer.writesFor(),
      colorAttachments: [
        { view: target, loadOp: 'clear', storeOp: 'store', clearValue: [1, 1, 1, 1] },
      ],
    });
    pass.setPipeline(
      postPipeline(this.pipelines, device, this.aoLayout, 'post.ao', AO_FRAG_WGSL, 'r8unorm'),
    );
    if (this.aoBindGroup === null) return;
    pass.setBindGroup(0, this.aoBindGroup, [0]);
    pass.draw(3);
    pass.end();

    this.blurOcclusion(encoder);
  }

  /**
   * The other half of the estimate: across, then down.
   *
   * **Not a smoothing pass over a finished answer.** `ambientOcclusion.ts` designs the two
   * together — twelve taps turned by a rotation that repeats over a 4×4 tile, and a four-wide
   * blur that averages all sixteen turns back into one number — so the estimate on its own is
   * not a rougher occlusion, it is a quarter of one, and it reads as salt and pepper. Skipped
   * entirely here until now; see `aoScratch`.
   *
   * Depth-aware, which is what keeps it a blur rather than a smear: an ordinary gaussian over
   * this estimate draws a dark halo around every silhouette, and that is more obviously wrong
   * than the noise it removes. The shader weights each tap by how close its view-space depth is
   * to the centre's, which is why both passes bind the depth as well as the estimate.
   */
  private blurOcclusion(encoder: GPUCommandEncoder): void {
    const target = this.aoTargetView;
    const scratch = this.aoScratchView;
    const across = this.aoBlurAcrossGroup;
    const down = this.aoBlurDownGroup;
    if (target === null || scratch === null || across === null || down === null) return;
    const { device } = this.surface;

    /*
     * The four terms that carry a depth back to view-space metres, off the inverse projection
     * this frame's estimate already computed. Column major, so `[2][2]` is element 10 and
     * `[3][3]` is element 15 — the same four `ambientOcclusionPass.ts` reads, in the same order.
     */
    const inv = this.aoInvProjection;
    const f = this.aoBlurFloats;
    const at = (name: string): number => this.postField(AO_BLUR_FIELDS, name);
    const slot = (index: number): number => (index * AO_BLUR_SLOT) / 4;
    /* The estimate is half the frame each way, so a texel of it is two of the frame's. Written
       from the target's own size rather than the frame's, which is the arithmetic that would
       otherwise halve the blur and leave half the pattern standing. */
    const width = Math.max(1, this.aoTarget?.width ?? 1);
    const height = Math.max(1, this.aoTarget?.height ?? 1);
    for (const [index, step] of [
      [0, [1 / width, 0]],
      [1, [0, 1 / height]],
    ] as const) {
      f[slot(index) + at('uStep')] = step[0];
      f[slot(index) + at('uStep') + 1] = step[1];
      f[slot(index) + at('uDepthToViewZ')] = inv[10] ?? 0;
      f[slot(index) + at('uDepthToViewZ') + 1] = inv[14] ?? 0;
      f[slot(index) + at('uDepthToViewZ') + 2] = inv[11] ?? 0;
      f[slot(index) + at('uDepthToViewZ') + 3] = inv[15] ?? 1;
    }
    device.queue.writeBuffer(this.aoBlurUniforms, 0, this.aoBlurStaging);

    const pipeline = postPipeline(
      this.pipelines,
      device,
      this.aoBlurLayout,
      'post.aoBlur',
      AO_BLUR_FRAG_WGSL,
      'r8unorm',
    );
    /* Across into the scratch, then down and back into the estimate — which is the view the
       composite's bind group already holds, so nothing downstream has to know this ran. */
    for (const [view, group, index] of [
      [scratch, across, 0],
      [target, down, 1],
    ] as const) {
      const pass = encoder.beginRenderPass({
        label: index === 0 ? 'post.aoBlurAcross' : 'post.aoBlurDown',
        timestampWrites: this.gpuTimer.writesFor(),
        colorAttachments: [{ view, loadOp: 'clear', storeOp: 'store', clearValue: [1, 1, 1, 1] }],
      });
      pass.setPipeline(pipeline);
      pass.setBindGroup(0, group, [index * AO_BLUR_SLOT]);
      pass.draw(3);
      pass.end();
    }
  }

  /**
   * The bright part of the frame, blurred, for the composite to add back.
   *
   * **The pyramid, which is what bloom is.** Threshold the frame into level 0, halve it down the
   * chain, then add each level back into the one above it, so level 0 ends up holding every
   * octave at once and the falloff is their sum rather than one kernel's. `bloomPass.ts` runs
   * exactly this on the other backend, and `bloomChain.ts` holds the three numbers that decide
   * the pyramid's shape so neither side can build a different one.
   *
   * **This was the prefilter alone**, and how that survived is the part worth keeping: it
   * compiled, it validated, and it drew a picture. A thresholded frame at half resolution read
   * bilinearly is entirely plausible-looking and has no glare in it at all, and no scene turns
   * bloom on — so nothing compared it against anything until the format defect above made the
   * effect measurable. Six of this port's bugs are that shape.
   *
   * Nothing is uploaded here. Every block these stages read was written on resize; see
   * `bloomStaging` for why that is not merely an optimisation.
   */
  private runBloom(encoder: GPUCommandEncoder): void {
    const levels = this.bloomLevels;
    const top = levels[0];
    if (top === undefined) return;
    const format = this.pipelines.format;

    /**
     * One stage: a fullscreen triangle from a bound source into `target`, at `slot`'s block.
     *
     * `load` rather than `clear` wherever there is a blend, and that is the other half of what
     * makes the sum of the octaves a sum: a cleared attachment discards the level the downsample
     * wrote and adds the octave to nothing. See `ADDITIVE_BLEND`.
     */
    const stage = (
      label: string,
      key: string,
      fragment: string,
      target: BloomLevel,
      source: number,
      slot: number,
      blend?: GPUBlendState,
    ): void => {
      const group = this.bloomGroups[source];
      if (group === undefined) return;
      const pass = encoder.beginRenderPass({
        label,
        timestampWrites: this.gpuTimer.writesFor(),
        colorAttachments: [
          {
            view: target.view,
            loadOp: blend === undefined ? 'clear' : 'load',
            storeOp: 'store',
            clearValue: [0, 0, 0, 1],
          },
        ],
      });
      pass.setPipeline(
        postPipeline(
          this.pipelines,
          this.surface.device,
          this.bloomLayout,
          key,
          fragment,
          format,
          blend,
        ),
      );
      pass.setBindGroup(0, group, [slot * BLOOM_SLOT]);
      pass.draw(3);
      pass.end();
    };

    /* Threshold, reading the scene at full resolution into the half-size level 0. The only stage
       that reads the scene, which is why source 0 is the scene and every level is one along. */
    stage('post.bloomPrefilter', 'post.bloomPrefilter', BLOOM_PREFILTER_FRAG_WGSL, top, 0, 0);

    /* Down the chain. Each level reads the one above it, written a pass ago. */
    for (let index = 1; index < levels.length; index++) {
      const target = levels[index];
      if (target === undefined) break;
      stage(
        'post.bloomDown',
        'post.bloomDownsample',
        BLOOM_DOWNSAMPLE_FRAG_WGSL,
        target,
        index,
        index,
      );
    }

    /* And back up. Every draw reads the same tent radius, so they share one slot rather than
       holding five copies of one constant. */
    for (let index = levels.length - 1; index > 0; index--) {
      const target = levels[index - 1];
      if (target === undefined) break;
      stage(
        'post.bloomUp',
        'post.bloomUpsample',
        BLOOM_UPSAMPLE_FRAG_WGSL,
        target,
        index + 1,
        BLOOM_UPSAMPLE_SLOT,
        ADDITIVE_BLEND,
      );
    }
  }

  /**
   * Snapshot the opaque scene's depth, so a volume can clamp its march to it.
   *
   * **Neither backend may sample the depth it is testing against**, so this is a copy and not
   * the attachment: WebGL2 calls that undefined and WebGPU rejects the pass outright. The copy
   * already exists here — `resolveDepth` writes sample zero into a single-sample float target
   * for occlusion and motion blur — so what this adds is taking it *earlier*, at the moment a
   * volume first needs it, rather than in the composite.
   *
   * The pass has to be broken to do it, because the depth is an attachment of the open one. That
   * is the same end-and-reopen `openTextPass` performs, with one difference that decides whether
   * the frame survives: **both attachments load**. Text reopens with the depth *cleared*, which
   * is what puts a message in front of the scene; a volume is in the scene and still has to sort
   * against it, so clearing here would let every beam draw straight through the world.
   *
   * Returns false where there is no copy to take — a profile with no composite has no target for
   * one — and the caller then leaves the clamp switched off rather than sampling something else.
   * WebGL2 reaches the same answer for the same profile, which is the parity that matters: the
   * two backends agree about *when* a beam is clamped, not merely about how.
   */
  /**
   * Everything a volume samples: the three shadow layers, and the frame's own depth.
   *
   * All three layers because `lightVolume.ts` samples all three — a shaft is interrupted by
   * whatever stands in it, and a mover standing in it is the case the dynamic layer exists for.
   * Bound here as well as in the mesh group, matching `renderer.ts`, which binds its
   * `dynamicShadowMap` to both.
   *
   * A method rather than a constructor expression because the depth snapshot is allocated with
   * the drawing buffer: `ensureComposite` calls this again whenever it rebuilds that target.
   */
  private buildLightVolumeBindGroup(): GPUBindGroup {
    return createLightVolumeBindGroup(
      this.surface.device,
      this.lightVolumeLayout,
      this.lightVolumeVariant,
      this.lightVolumeVertices.buffer,
      this.lightVolumeFragments.buffer,
      (name) =>
        name === 'uStaticShadowMap'
          ? { view: this.shadowView, sampler: this.volumeShadowSampler }
          : name === 'uPeeledShadowMap' && this.peelView !== null
            ? { view: this.peelView, sampler: this.volumeShadowSampler }
            : name === 'uDynamicShadowMap' && this.dynamicView !== null
              ? { view: this.dynamicView, sampler: this.volumeShadowSampler }
              : /* The frame's own depth, snapshotted before the first volume of the frame draws.
                   Null under a profile with no composite, and then `uSceneDepthEnabled` is 0 and
                   the stand-in is never sampled. */
                name === 'uSceneDepth' && this.resolvedDepthView !== null
                ? { view: this.resolvedDepthView, sampler: this.postDepthSampler }
                : this.volumeBlank,
    );
  }

  /**
   * Copy the colour the frame has drawn so far, so a refracting draw can read it.
   *
   * **Neither backend can read what it is writing, and this one cannot even resolve on demand.**
   * `post.sceneColorMsaa` is `RENDER_ATTACHMENT` with no `TEXTURE_BINDING`, so the only readable
   * copy of the frame is what ending the pass resolves into `post.sceneColor` — and that is the
   * pass's own attachment, which a bind group may not sample while it is attached. So: end the
   * pass, copy the resolved texture aside, reopen with `loadOp: 'load'`.
   *
   * **A fourth instance of a boundary this backend already runs three times** — the mirror, the
   * light volume's depth snapshot and text — rather than a new mechanism. It is modelled on
   * `takeVolumeDepth` line for line, including its two refusals, which hold here for the same
   * reasons: ending the mirror's pass would throw away what the mirror had drawn and send the rest
   * of the scene into the frame instead, invisibly on an immediate-mode GPU and not at all on a
   * tile-based one.
   *
   * Latched, so one copy serves every refracting draw in a frame: glass does not refract other
   * glass, and a frame that refracts nothing breaks no pass at all.
   */
  private takeRefractSnapshot(): boolean {
    if (this.reflectionPassActive || this.probePassActive) return false;
    if (this.refractSnapshotTaken) return true;
    /* The replay of an order-independent set runs after the scene's pass has ended, and `runOit`
       took the copy for it before it began; there is no pass here to end and reopen. */
    if (this.oitReplaying) return false;
    const snapshot = this.refractSnapshot;
    const source = this.sceneColor;
    const encoder = this.encoder;
    const target = this.compositeTarget();
    if (snapshot === null || source === null) return false;
    if (encoder === null || target === null) return false;

    /*
     * **The pass is opened here if it is not already, and that is not a formality.**
     *
     * This backend opens a pass lazily, at the draw that first needs one, and with the frame graph
     * on the draws before this one are recorded rather than submitted. So at the moment a
     * refracting draw asks, there may be no pass at all and nothing of the world in `sceneColor`
     * yet — copying then gives every pane in the frame the *previous* frame's picture, which moves
     * with the camera one frame late and reads as a lag in the glass rather than as an empty copy.
     *
     * Opening it commits whatever is pending, and ending it immediately below is what resolves
     * that into the texture this copies. Found by this row's own check: WebGL2 was pixel-perfect
     * and WebGPU drew flat paint, because `this.pass` was null and the snapshot silently refused.
     */
    if (this.pass === null && this.openPass() === null) return false;
    if (this.pass === null) return false;

    /* Flushed before the boundary for the reason `takeVolumeDepth` gives: the copy takes the
       colour *as it stands*, so a draw recorded before this line and replayed after it would be
       missing from what every pane in the frame shows. */
    if (this.quality.frameGraph) this.flushGraph();

    this.pass.end();
    /* Ending the pass is what resolved `sceneColor`; this takes it somewhere nothing is attached
       to, which is the only thing a bind group may sample. */
    encoder.copyTextureToTexture({ texture: source }, { texture: snapshot }, [
      snapshot.width,
      snapshot.height,
    ]);
    const multisampled = this.compositeMsaa() !== null;
    this.pass = encoder.beginRenderPass({
      label: 'refract.snapshotTaken',
      timestampWrites: this.gpuTimer.writesFor(),
      colorAttachments: [
        {
          view: this.compositeMsaa() ?? target,
          resolveTarget: multisampled ? target : undefined,
          /* Loaded, not cleared: everything already drawn stays, and the glass goes over it. */
          loadOp: 'load',
          storeOp: resolvedStoreOp(multisampled, false, this.quality.discardResolvedAttachments),
        },
      ],
      depthStencilAttachment:
        this.depthView === null
          ? undefined
          : { view: this.depthView, depthLoadOp: 'load', depthStoreOp: 'store' },
    });
    this.refractSnapshotTaken = true;
    return true;
  }

  private takeVolumeDepth(): boolean {
    /*
     * **Never while the mirror is open, and this is a correctness fix rather than a saving.**
     *
     * This method ends whatever pass is current and opens a new one on the *composite* target.
     * Called during a planar reflection it therefore ends the mirror's pass, throws away what
     * the mirror had drawn, and sends everything the scene draws afterwards into the frame
     * instead — a mirror that is empty and a frame with the mirror's geometry in it.
     *
     * On an immediate-mode GPU the first half is invisible, because a discarded attachment has
     * nowhere else to be and keeps its contents anyway. On a tile-based GPU it is exactly what
     * `storeOp: 'discard'` promises, so the same scene loses its reflection there and only
     * there. `drawFilm` already guards the same boundary with `!this.reflectionPassActive`; this
     * did not, and the asymmetry is what let it survive.
     *
     * Returning false means the volume draws unclamped inside the mirror, which is right on its
     * own terms: `resolvedDepthView` holds the *frame's* depth, and clamping a mirrored beam
     * against it would stop it at geometry that is not in front of it.
     */
    if (this.reflectionPassActive) return false;
    if (this.resolvedDepthView === null) return false;
    if (this.volumeDepthTaken) return true;
    const encoder = this.encoder;
    const target = this.compositeTarget();
    if (encoder === null || this.pass === null || target === null) return false;

    /*
     * Flush before the boundary, and then say what the boundary does.
     *
     * The flush is the same argument the mirror's two ends make, with a sharper edge: the
     * resolve below copies the depth *as it stands*, so a draw recorded before this line and
     * replayed after it would be missing from the snapshot — and a beam would march straight
     * through geometry that is plainly in front of it. Same target either side, so the picture
     * would not otherwise say a word about it.
     *
     * The node is the frame's one honest statement about depth. `resolveDepth` reads
     * `sceneDepth`, which is what forbids the pass before this from discarding it, and writes
     * `depthSnapshot`, which is what stops the scheduler dropping a resolve whose only reader
     * is a volume. Depth is discardable at the frame's *last* pass and not at this one, and
     * this is the node that tells the difference.
     */
    if (this.quality.frameGraph) {
      this.flushGraph();
      recordNode(this.arena, VERB_SCOPE, DEPTH_SOURCE, DEPTH_SNAPSHOT, 0, 0);
    }

    this.pass.end();
    this.resolveDepth(encoder);
    const multisampled = this.compositeMsaa() !== null;
    this.pass = encoder.beginRenderPass({
      label: 'volume.depthTaken',
      timestampWrites: this.gpuTimer.writesFor(),
      colorAttachments: [
        {
          view: this.compositeMsaa() ?? target,
          resolveTarget: multisampled ? target : undefined,
          loadOp: 'load',
          storeOp: resolvedStoreOp(multisampled, false, this.quality.discardResolvedAttachments),
        },
      ],
      depthStencilAttachment:
        this.depthView === null
          ? undefined
          : {
              view: this.depthView,
              /* Loaded, not cleared. See above — this is the line that keeps a beam behind the
                 world it is in. */
              depthLoadOp: 'load',
              depthStoreOp: 'store',
            },
    });
    this.volumeDepthTaken = true;
    return true;
  }

  /**
   * The pass to record into, reopening one on the canvas if the frame has already gone.
   *
   * Returns null only where there is genuinely nowhere to draw: a lost surface, or a call before
   * any frame has begun. See `overlayDepth` for why this exists at all.
   */
  /**
   * Schedule and replay whatever the graph has recorded, then empty it.
   *
   * The schedule is computed and its pass count asserted in development, but **it does not yet
   * drive pass creation**: every node recorded so far is a mesh draw writing the scene target,
   * so the schedule is one pass and `ensurePass` already opens exactly that. Letting the
   * schedule open passes is the next plan's work, and doing it here would change pass
   * boundaries in the same commit that introduces recording — two things to bisect instead of
   * one.
   */
  private flushGraph(cause: FlushCause = 'boundary', liveOut = this.liveOutMidFrame()): void {
    const total = nodeCount(this.arena);
    if (total === 0) return;
    this.flushing = true;
    try {
      /*
       * Scheduled on the real path even though the result does not drive anything yet, so the
       * scheduler is exercised by every frame rather than by its unit tests alone. Every node
       * recorded so far writes the scene target, so this must come out as exactly one pass;
       * anything else means a node declared a write it does not perform.
       */
      /*
       * **Either scheduler, into the same records**, so nothing below knows which ran. The identifier
       * graph is the one that can also express the second pipeline's frame; running it here is what
       * shows it is a generalisation of this one rather than a different renderer — see
       * `quality.identifierGraph` for the captures that say so.
       */
      const passes =
        this.flushSchedule === null
          ? schedule(this.arena, this.pendingClearMask, liveOut, this.scheduledPasses)
          : scheduleFlush(
              this.arena,
              this.pendingClearMask,
              liveOut,
              this.flushSchedule,
              this.scheduledPasses,
            );
      this.passesLastFlush = passes;
      let discards = 0;
      let clears = 0;
      for (let i = 0; i < passes; i += 1) {
        discards |= this.scheduledPasses[i]?.discard ?? 0;
        clears |= this.scheduledPasses[i]?.clear ?? 0;
      }
      this.discardsLastFlush = discards;
      this.clearsLastFlush = clears;
      /*
       * Only the open that happens on the next line may use it, and `openPass` clears it whether
       * it opens or not. A flush that finds a pass already open cannot apply a store op to it —
       * that was settled when it opened — so the mask is simply spent, which is correct.
       */
      this.pendingDiscard = discards;
      if (passes === 0) {
        console.warn(
          `WebGPU: the frame graph dropped all ${total} of its nodes; a write is declared that nothing performs`,
        );
      }

      /*
       * The schedule, not the arena.
       *
       * A pass the scheduler dropped writes something nothing reads, and replaying its nodes
       * anyway is what made every capture in the verb migration unable to fail: `liveOut` could
       * have been anything at all and the five published scenes would still have been identical.
       *
       * Read **before** `openPass`, which is what spends `pendingDiscard`: the schedule has to
       * be finished with before the pass it describes exists.
       */
      this.replayScratch = scratchFor(this.replayScratch, nodeCount(this.arena));
      const kept = keptNodes(this.scheduledPasses, passes, this.replayScratch);
      const pass = this.openPass();
      if (pass !== null) {
        for (let i = 0; i < kept; i += 1) this.replayNode(pass, this.replayScratch[i] ?? 0);
      }
    } finally {
      this.flushing = false;
      resetArena(this.arena);
      resetPool(this.commands);
      this.flushesThisFrame += 1;
      if (cause === 'verb') this.verbFlushesThisFrame += 1;
    }
  }

  /**
   * What must survive a flush that is not the frame's last.
   *
   * **The plan said this becomes `maskOf('canvas')` once every verb records, and it does not.**
   * Tried, and a frame of three scene draws schedules zero passes: the composite reads the
   * scene's colour and the composite is not a graph node, so the scheduler sees a write nothing
   * reads and drops the whole frame. Nothing else in this programme could have found that — the
   * executor replays every node regardless of the schedule, so the picture is identical either
   * way — which is exactly the failure mode the plan warned a wrong `reads` would have.
   *
   * The honest set is therefore everything the graph cannot see a reader for, minus what is
   * provably dead. Expressed as a subtraction rather than a list on purpose: a resource added
   * to the table later defaults to surviving, which is the safe direction to be wrong in.
   *
   * **Only one thing is dead here.** Nothing samples the mirror's depth and nothing loads it
   * back — it sorts the mirror against itself and is never looked at again. The frame's own
   * depth is not dead mid-frame, because `openFramePass` resumes with `depthLoadOp: 'load'` so
   * that geometry drawn after the mirror depth-tests against geometry drawn before it, and a
   * load is a read.
   */
  private liveOutMidFrame(): number {
    return EVERY_RESOURCE & ~maskOf('mirrorDepth');
  }

  /** What a registered pass has claimed it samples, which the frame therefore keeps. */
  private liveOutForPasses(): number {
    return this.passReadsUnion;
  }

  /**
   * What must survive the frame's last flush, which is where the depth prize is.
   *
   * **Nothing loads the frame's depth after this point**, so it is stored every frame for a
   * reader that does not exist — the case the design named as the one that pays. The exception
   * is a composite that resolves it, for camera motion blur or ambient occlusion, and the test
   * here is the same expression `composite` applies a few lines later so the two cannot drift
   * apart without both being wrong.
   *
   * Conservative on the first frame of a run: `hasPreviousView` is false then and the composite
   * blurs nothing, but this keeps depth live anyway rather than encode a second copy of that
   * rule. One stored attachment on one frame is not worth a second place for it to be wrong.
   */
  private liveOutFinalFlush(): number {
    let live = this.liveOutMidFrame();
    if (!this.compositeWantsDepth()) live &= ~maskOf('sceneDepth');
    /* And whatever a package said it samples, which the renderer cannot see the timing of. */
    return live | this.liveOutForPasses();
  }

  /**
   * Whether the composite is going to resolve the frame's depth out.
   *
   * **One expression, called from both places, because the two copies drifted the first time
   * anybody added a third reader.** The comment above used to say "the test here is the same
   * expression `composite` applies a few lines later so the two cannot drift apart without both
   * being wrong", and depth of field was added to `composite`'s copy and not to this one — so the
   * effect ran against a depth attachment the scheduler had discarded, read zero everywhere, and
   * produced a *plausible* picture: every pixel at the near plane, so every pixel at full blur,
   * blurred correctly and focused on nothing. It responded to the blur radius and not to the focus
   * distance, which is what made it findable. Same expression now means the same call.
   *
   * Conservative where `composite` could be exact: the motion term is the raw ceiling and dial,
   * where the composite also requires a previous view to reproject through. That costs one
   * unused depth resolve on the first frame of a run and buys the property this comment is about.
   */
  private compositeWantsDepth(): boolean {
    return (
      this.quality.cameraMotionBlur * this.motionBlurScale > 0 ||
      this.quality.ambientOcclusion > 0 ||
      this.quality.depthOfField * this.dofScale > 0 ||
      /* The temporal resolve reprojects through the depth, so a frame running it needs the
         resolve just as the smear does. `depthOfField` was added to a *copy* of this expression
         once and ran against a discarded attachment that read zero everywhere — which is why
         there is one of these and why this line is in it. */
      (this.quality.temporalAa && this.quality.screenEffects) ||
      /*
       * **And so does a reconstruction, for the same reason, and it was missing for the same
       * reason.** Without it the resolve read a discarded attachment as zero — the far plane
       * reversed — so every surface stood at infinity: a turning camera reprojected correctly,
       * since a turn moves every depth alike, and a sliding one moved nothing, and the history
       * trailed every slide by the parallax it never saw.
       */
      this.reconstructing ||
      /*
       * **The order-independent passes attach the depth and test against it**, so a frame running
       * them needs it to survive the main pass. Without this it is discarded, those passes test
       * against nothing, and every translucent surface fails — which is a *black* frame that looks
       * like the blend rather than like a missing attachment. Measured: 2,332 lit pixels against
       * WebGL2's 160,436 for the identical scene.
       */
      this.oitActive ||
      /*
       * **A drawn decal is decided from the resolved depth**, so a frame with marks in it needs
       * the same copy the smear and the occlusion do. Left out of this, the attachment is
       * discarded before the resolve runs and every mark reads a depth of zero — which is the far
       * plane reversed, so nothing is inside any box and no mark appears at all: a feature that
       * silently does nothing rather than one that looks wrong.
       */
      this.decalQueue.length > 0 ||
      /* And a march reads the same copy, for the same reason and with the same failure if it is
         discarded: a depth of zero is the far plane reversed, so every ray finds nothing. */
      this.reflectionQueue.length > 0 ||
      /* And the medium's own march, which stops where the frame's depth says a surface is. Left
         out of this, every ray runs to `maxDistance` through the walls and the fog is drawn on
         top of the room rather than in it. */
      mediumActive(this.mediumOptions, this.quality.globalMediumSteps)
    );
  }

  /**
   * What the pass `ensurePass` hands back actually writes.
   *
   * A verb can draw either side of `endFrame` — a consumer puts its interface after it on
   * purpose, so the interface escapes the post chain — and after that the target is the canvas
   * rather than the scene. Declaring one or the other unconditionally would be wrong half the
   * time, and wrong in a way nothing notices until `liveOut` narrows.
   */
  private currentTarget(): number {
    /*
     * **The mirror comes first, and it is not an edge case.** `beginPlanarReflection` draws the
     * whole world a second time through these same verbs, so every draw between it and
     * `endPlanarReflection` writes the mirror's attachments and not the frame's. Declaring the
     * scene there is wrong for the majority of a reflecting scene's draws, and wrong in the
     * direction that makes the scheduler discard an attachment those draws had just filled.
     */
    if (this.reflectionPassActive) return MIRROR_TARGET;
    return this.framePresented ? CANVAS_TARGET : SCENE_TARGET;
  }

  /**
   * Take a command to record this draw into, or `null` to draw directly.
   *
   * **Returns the command rather than taking a callback**, which the plan first proposed: a
   * closure per draw is an allocation, and this is the hottest path in the renderer. A call
   * site reads as one `if` either way.
   */
  private recordDraw(reads: number, writes: number): DrawCommand | null {
    /* The order-independent replay owns its pass and issues directly into it; a recorded command
       would be replayed into the frame's passes instead, which is not where these belong. */
    if (this.oitEncoder !== null) return null;
    if (!this.quality.frameGraph) return null;
    const at = takeCommand(this.commands);
    const command = this.commands.commands[at];
    if (command === undefined) return null;
    /* The fields a caller may leave alone. Everything else it fills. */
    command.offsetCount = 0;
    command.vertexCount = 0;
    command.indexBuffer = null;
    command.indexed = false;
    command.instances = 1;
    recordNode(this.arena, VERB_DRAW, reads, writes, at, 0);
    return command;
  }

  /** Replay one recorded draw into an open pass. */
  private replayNode(pass: GPURenderPassEncoder, at: number): void {
    /*
     * A scope node is a boundary, not a draw, and carries no command.
     *
     * Checked on the verb rather than left to a null pipeline, because that happens to skip it
     * today and stops being right the moment a boundary needs to carry anything.
     */
    const verb = nodeVerb(this.arena, at);
    if (verb === VERB_PASS) {
      const definition = passAt(this.passes, nodeState(this.arena, at));
      if (definition === undefined) return;
      this.passContext.pass = pass;
      /* The frame's grade, so a contributed pass can obey the 2026-08-17 rule. See `PassContext`. */
      this.passContext.outputTransform = this.gradeCode();
      this.passContext.outputExposure = this.gradeExposure();
      definition.draw(this.passContext as PassContext);
      return;
    }
    if (verb !== VERB_DRAW) return;
    const command = this.commands.commands[nodeState(this.arena, at)];
    if (command === undefined || command.pipeline === null || command.bindGroup === null) return;

    pass.setPipeline(command.pipeline);
    if (command.offsetCount === 2) {
      pass.setBindGroup(0, command.bindGroup, [command.offsetA, command.offsetB]);
    } else if (command.offsetCount === 1) {
      pass.setBindGroup(0, command.bindGroup, [command.offsetA]);
    } else {
      pass.setBindGroup(0, command.bindGroup);
    }
    for (let i = 0; i < command.vertexCount; i += 1) {
      const buffer = command.vertexBuffers[i];
      if (buffer != null) pass.setVertexBuffer(i, buffer);
    }
    if (command.indexed && command.indexBuffer !== null) {
      pass.setIndexBuffer(command.indexBuffer, 'uint32');
      pass.drawIndexed(command.count, command.instances);
    } else {
      pass.draw(command.count, command.instances);
    }
  }

  private ensurePass(): GPURenderPassEncoder | null {
    /*
     * The flush, at the one point every verb that still *issues* commands passes through.
     *
     * An unmigrated verb flushes whatever the graph has recorded before issuing its own calls,
     * and order holds whatever fraction of the migration has landed. `flushing` stops the
     * replay itself re-entering: the executor calls `openPass` to obtain the pass it draws into.
     *
     * **A verb that records must not come through here**, and that is what `openPass` is for.
     * Flushing per verb would keep the count off zero however complete the migration got —
     * every verb after the first would schedule and replay the one before it — and zero is the
     * precondition for narrowing `liveOut`.
     *
     * **No verb calls this any more**, so `graphVerbFlushes` is zero by construction rather
     * than by measurement, which is the stronger of the two. What is left is `beginFrame` and
     * `endFrame`, and both meet an empty arena. It stays because a verb added later that issues
     * rather than records needs it, and because the alternative — deleting it and rediscovering
     * the ordering rule the hard way — is how the migration would quietly come undone.
     */
    if (!this.flushing && nodeCount(this.arena) > 0) this.flushGraph('verb');
    return this.openPass();
  }

  /**
   * The pass a verb will draw into, without flushing what is already recorded.
   *
   * For a verb that records: its draw goes into the arena *behind* everything already there, so
   * there is nothing to get out of the way first. It still opens the pass, because the caller's
   * guard needs to know there is somewhere to draw at all, and because the replay needs one.
   *
   * With the switch off nothing ever reaches the arena, so a recording verb's direct path is
   * reached with the arena empty and the two entry points do the same thing.
   */
  /**
   * Whether there is somewhere to draw, without opening it.
   *
   * `openPass` answers the same question by doing the thing, which is what a verb needed while it
   * drew directly and is exactly wrong while it records: **the schedule cannot describe a pass
   * that is already open.** Every recording verb asks this instead, and the pass itself is
   * obtained only where it is used, which is the direct branch.
   *
   * The conditions are `openPass`'s own with the opening removed, in the same order.
   */
  private canDraw(): boolean {
    if (this.surface.lost) return false;
    if (this.pass !== null) return true;
    /* Inside a reflection the mirror's pass is opened on demand, exactly like the frame's. */
    if (this.encoder !== null && this.reflectionPassActive) return true;
    if (this.encoder !== null && !this.framePresented) return true;
    /* After `endFrame` an overlay pass can still be opened, and only then. */
    return this.framePresented;
  }

  private openPass(): GPURenderPassEncoder | null {
    /* While the replay is running this is the only pass there is. See `oitEncoder`. */
    if (this.oitEncoder !== null) return this.oitEncoder;
    /*
     * Taken and cleared on **every** call, opening or not.
     *
     * Left standing it is a mask from one frame applied to a pass in the next. That is not
     * hypothetical: `storm-sea` draws a light volume, whose snapshot opens the frame's pass
     * outside any flush, and it inherited the previous frame's "the depth is dead" from
     * `endFrame`. The pass then ended by discarding a depth buffer `resolveDepth` reads one line
     * later, and 41,783 pixels of the sea changed. A mask means "the schedule just now
     * described this", and one call later it does not.
     */
    const discard = this.pendingDiscard;
    this.pendingDiscard = 0;
    if (this.pass !== null) return this.pass;
    if (this.surface.lost) return null;

    /*
     * Mid-frame with no pass open: this is the frame's own, opened late. `pendingClearMask`
     * decides between clearing and loading, and the bits come off it at the open that performs
     * them — a scene that draws, opens a mirror and draws again must load the second time or it
     * throws away everything it drew before the mirror.
     */
    if (this.reflectionPassActive) {
      const clear = this.pendingClearMask & MIRROR_TARGET;
      this.pass = this.openMirrorPass(clear, discard);
      if (this.pass !== null) this.pendingClearMask &= ~clear;
      return this.pass;
    }

    if (this.encoder !== null && !this.framePresented) {
      const clear = this.pendingClearMask & SCENE_TARGET;
      this.pass = this.openFramePass(clear, discard);
      /* Only on a pass that actually opened. A flush finding one already open cleared nothing,
         and the debt has to survive it. */
      if (this.pass !== null) this.pendingClearMask &= ~clear;
      return this.pass;
    }

    if (!this.framePresented) return null;
    const swap = this.swapView();
    if (swap === null) return null;

    const width = this.depth?.width ?? 1;
    const height = this.depth?.height ?? 1;
    if (
      this.overlayDepth === null ||
      this.overlayDepth.width !== width ||
      this.overlayDepth.height !== height
    ) {
      this.overlayDepth?.destroy();
      this.overlayDepth = this.surface.device.createTexture({
        label: 'overlay.depth',
        size: [Math.max(1, width), Math.max(1, height)],
        format: DEPTH_FORMAT,
        /* One sample: the canvas is not multisampled and every attachment has to agree. */
        sampleCount: 1,
        usage: 0x10, // RENDER_ATTACHMENT
      });
      this.overlayDepthView = this.overlayDepth.createView();
    }

    this.encoder = this.surface.device.createCommandEncoder({ label: 'overlay' });
    this.pass = this.encoder.beginRenderPass({
      label: 'overlay',
      timestampWrites: this.gpuTimer.writesFor(),
      colorAttachments: [
        {
          view: swap,
          /* Loaded, never cleared: the frame this sits over is already on the canvas. */
          loadOp: 'load',
          storeOp: 'store',
        },
      ],
      depthStencilAttachment:
        this.overlayDepthView === null
          ? undefined
          : {
              view: this.overlayDepthView,
              depthClearValue: DEPTH_CLEAR,
              depthLoadOp: 'clear',
              /* Created `RENDER_ATTACHMENT`-only a few lines above, and cleared on every open:
                 it sorts the overlay against itself and nothing ever reads it back. */
              depthStoreOp: this.quality.discardResolvedAttachments ? 'discard' : 'store',
            },
    });
    this.overlayActive = true;

    /*
     * **Submitted on a microtask, which runs before the browser presents.** There is no second
     * `endFrame` to hang this on — a consumer thinks the frame is over — and presentation happens
     * when the task ends, after the microtask checkpoint. Anything that needs the pixels sooner
     * flushes synchronously; `copyRegionTo` is the one that does.
     */
    if (!this.overlayFlushQueued) {
      this.overlayFlushQueued = true;
      queueMicrotask(() => this.flushOverlay());
    }
    return this.pass;
  }

  /**
   * The cache whose pipelines match the pass this draw will land in.
   *
   * Read at the draw rather than settled once, because the same call draws into either: `drawText`
   * is an announcement over the canvas in one frame and a label inside the world in the next. The
   * lookup is a field read and a branch — `PipelineCache` exists so the pipeline itself is a `Map`
   * hit — so this stays inside the per-frame budget.
   *
   * **`framePresented` is read beside `overlayActive`, and that is the whole of a bug that kept
   * `frameGraph` off by default.** The question is which pass the draw *ends up in*, and
   * `overlayActive` only answers which one is open *now*. Those differ whenever a verb resolves its
   * pipeline before the pass exists, which is every recorded draw: recording defers the draw to a
   * flush, and the flush is what calls `openPass` and sets `overlayActive`. So a mesh drawn after
   * `endFrame` took a scene pipeline at 4 samples into an overlay pass at 1, and WebGPU reported it
   * at `finish` — dropping the whole command buffer and the frame with it.
   *
   * These two conditions are `openPass`'s own, in its order: past `framePresented` it builds the
   * overlay. Reading the same field here is what makes the pipeline and the pass agree by
   * construction rather than by timing.
   *
   * **Two things do legitimately want the scene's pipeline after the frame is presented**, and this
   * clause once said nothing did — which was wrong and was caught by a device rather than by
   * reading. A probe bake and a planar reflection both draw into targets of their own, built at the
   * scene's sample count and format, and a scene is entitled to bake either one after `endFrame`.
   * The showroom does exactly that, and routing its bake to the overlay cache put a one-sample
   * pipeline into a four-sample face — the same fault as the original, inverted.
   *
   * So the order here is `openPass`'s order: its own two early branches first, then the overlay.
   * That is not a coincidence to be tidied away — the two functions answer the same question, and
   * any future branch added to one belongs in the other.
   */
  private targetPipelines(): PipelineCache {
    if (this.probePassActive || this.reflectionPassActive) return this.pipelines;
    return this.overlayActive || this.framePresented ? this.overlayPipelines : this.pipelines;
  }

  /** End and submit a reopened pass. Safe to call when there is none. */
  private flushOverlay(): void {
    this.overlayFlushQueued = false;
    /*
     * Anything still recorded goes now, for the reason `endFrame` gives — and this is the
     * boundary `endFrame` does not own. A consumer's interface is drawn *after* `endFrame` so
     * it escapes the post chain, and the pass those verbs record into is closed here, on a
     * microtask, with nothing calling into the renderer in between. Without this the frame's
     * last panel or caption sat in the arena until `beginFrame` reset it: silent, and invisible
     * to every capture, because no published scene draws an overlay.
     *
     * **Before the active check, and that ordering is load-bearing.** An overlay verb records
     * rather than opening a pass, so with the graph on there is nothing active yet and there is
     * still something to draw — the replay below is what opens the overlay pass at all.
     * `flushGraph` returns at once on an empty arena, so the direct path is unchanged.
     */
    this.flushGraph();
    if (!this.overlayActive || this.encoder === null) return;
    this.overlayActive = false;
    this.flushRings();
    this.pass?.end();
    this.pass = null;
    if (!this.surface.lost) this.surface.device.queue.submit([this.encoder.finish()]);
    this.encoder = null;
  }

  endFrame(): void {
    if (this.surface.lost || this.encoder === null) return;
    /*
     * Anything still recorded goes now.
     *
     * Without this a frame whose last work is a mesh draw loses it: nothing calls `ensurePass`
     * after the final verb, so nothing flushes, and the draws sit in the arena until
     * `beginFrame` resets it. Silent, and exactly the kind of loss the arena is designed
     * against everywhere else.
     */
    this.flushGraph('boundary', this.liveOutFinalFlush());
    /*
     * `ensurePass` rather than a null check: the frame's pass is opened on demand now, so a
     * frame that drew nothing has never opened one and still owes the canvas its clear.
     * Returning early would present whatever the swap chain last held.
     */
    const framePass = this.ensurePass();
    if (framePass === null) return;

    this.flushRings();
    framePass.end();
    this.pass = null;
    /*
     * **The one window in the frame where every declaration is in and no render pass is open.**
     * A consumer declares its fields wherever in its own frame the objects live, so the earliest
     * the set is complete is after the last verb; and a compute pass cannot be recorded inside a
     * render pass, so the latest it can be recorded is before the composite opens its own. The
     * probes traced from it are read by the next frame's shading, which is what a probe volume
     * does anyway — it accumulates.
     */
    this.runIndirectLight(this.encoder);
    if (this.hasComposite) this.composite(this.encoder);
    /* And where there is no composite there is no depth to read, so a frame that submitted marks
       is told once rather than losing them quietly. See `refuseDecals`. */
    else if (this.decalQueue.length > 0) this.refuseDecals();
    /* And the same for a march, which needs the picture as well as the depth. */
    if (!this.hasComposite && this.reflectionQueue.length > 0) this.refuseReflections();
    /*
     * Cleared rather than held. See `setFrameVeil`: a veil is one cut's instruction, and a
     * frame that never calls the setter again must not inherit the last one's colour. Cleared
     * even where there was no composite to consume it, so the two backends agree on what "one
     * call per frame" means regardless of the profile.
     */
    this.veilAlpha = 0;
    /*
     * The queries ride the frame's last encoder, and this is the only place that can be.
     * `FrameTimer.endFrame` belongs to the consumer and runs after this returns, by which
     * point every encoder the frame had is finished and submitted, so a resolve recorded
     * there would have nothing to ride on. See `GpuTimestamps.resolve`.
     */
    this.gpuTimer.resolve(this.encoder);
    this.surface.device.queue.submit([this.encoder.finish()]);
    this.encoder = null;
    this.framePresented = true;
    /* Latched rather than assigned: `framePresented` goes back to false every `beginFrame`. */
    this.presentedAnyFrame = true;
  }

  /**
   * Match the drawing buffer to the canvas, taking no arguments.
   *
   * **The signature is the WebGL2 renderer's, and the derived surface is what enforced it.**
   * This was written taking a width and a height, which is the natural shape for
   * `GPUCanvasContext.configure`, and `tsc` rejected it against `RendererApi` before it
   * could reach a consumer. `Renderer.resize()` reads the canvas and the device pixel ratio
   * itself, so a caller never passes a size and must not have to learn which backend it
   * holds in order to know that.
   *
   * **The sizing policy is `drawingBufferSize`'s, not this file's.** Locked dimensions, the
   * pixel ceiling and the density a governor moves are one set of rules, and a second copy of
   * them here would be a frame that is a different size on each backend for reasons nobody
   * could see. The budget is deliberately not applied to a *locked* buffer, for the reason
   * `renderer.ts` gives: a lock is a caller naming an exact size for a reason no quality
   * setting knows about, and quietly returning a different one writes a file that is not the
   * size it claims.
   */
  resize(): void {
    if (this.surface.lost) return;
    const canvas = this.surface.context.canvas as HTMLCanvasElement;
    drawingBufferSize(
      canvas.clientWidth,
      canvas.clientHeight,
      Math.min(globalThis.devicePixelRatio || 1, this.quality.maxDevicePixelRatio) * this.scale,
      this.lockedWidth,
      this.lockedHeight,
      this.maxDrawingBufferPixels,
      this.budgeted,
    );
    const width = Math.max(1, this.budgeted.width);
    const height = Math.max(1, this.budgeted.height);
    this.surface.configure(width, height);
    /*
     * **The same split `beginFrame` makes, and it has to be made twice.** This path resized the
     * composite to the drawing buffer while the frame resized it to the render size, so the two
     * fought every time a canvas changed — and the reconstruction's bind groups, built here
     * against the previous scene depth, held a view of a texture this call had just destroyed.
     * The device's words for that are "destroyed texture used in a submit", on the next frame,
     * after a resize, which is as far from the cause as a message gets.
     */
    const render = this.sceneSize();
    this.ensureComposite(render.width, render.height);
    this.ensureReconstruction(render.width, render.height, width, height);
    this.ensureReflection(width, height);
  }

  /**
   * Move the drawing-buffer area cap, in pixels. Zero is uncapped.
   *
   * Live, unlike every other quality lever, and `renderer.ts` explains why that is the feature:
   * everything sized *from* the drawing buffer re-fits itself, so this changes how many pixels
   * the next frame covers and nothing else. A player hunting their own frame rate can move it
   * and see the answer.
   */
  setMaxDrawingBufferPixels(pixels: number): void {
    if (this.surface.lost) return;
    this.maxDrawingBufferPixels = Number.isFinite(pixels) && pixels > 0 ? pixels : 0;
    this.resize();
  }

  /**
   * Told when the device is lost, immediately if it already has been.
   *
   * **The lateness is the interesting half and `device.ts` owns it.** WebGL fires
   * `webglcontextlost` once and a listener that arrives afterwards hears nothing; a WebGPU
   * device's loss is a promise that stays resolved, so a renderer built after a driver reset
   * can still be told. `GpuSurface.onLost` latches it and this hands the listener straight
   * through, which is why there is no list of listeners here to keep.
   */
  onContextLost(listener: () => void): void {
    this.surface.onLost(listener);
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
   * **The seam is `addOccluder`'s, and for `addOccluder`'s reason.** A distance field is the shape
   * of a thing it is safe to be *traced against*, and only a consumer knows which of its objects
   * that is true of — the walls and the terrain, not the leaves, not the water, not the thing it
   * is about to delete. A renderer that derived the field from whatever was drawn would trace
   * against the foliage and light the room with a hedge.
   *
   * **Declared anywhere in the frame and composed at its end**, which is the one window where
   * every declaration is in and the encoder has no render pass open. Cleared at `beginFrame` with
   * the decal and reflection queues, so a consumer redeclares every frame and a field it stops
   * declaring stops lighting.
   *
   * The field is in the model matrix's own space and the matrix must carry uniform scale only —
   * `composeGlobalField` gives the reason: a distance is not preserved by a non-uniform scale, and
   * the factor to correct by depends on the direction to the nearest surface, which is exactly
   * what a distance field does not record.
   *
   * **`albedo` is what colour this placement's surface is, and it decides what the bounce carries.**
   * What leaves a surface is the light arriving times its albedo, so a ray that lands on a wall
   * and does not know its colour returns the same answer for a red wall and a white one — measured
   * on `demo/dev/bounce.html` before this argument existed. It is a placement's rather than a
   * field's, because the same baked shape is placed many times and two pillars cut from one mould
   * may be painted differently. White where it is left out, so every existing caller is unchanged.
   */
  addDistanceField(field: FieldSource, model: ReadonlyMat4, albedo?: ArrayLike<number>): void {
    this.distanceFields.record(field, model, albedo);
  }

  /** Forget the fields declared this frame, for a consumer that rebuilds its list mid-frame. */
  clearDistanceFields(): void {
    this.distanceFields.reset();
  }

  /**
   * Compose what the frame declared, or nothing at all.
   *
   * **Nothing at all is the ordinary case and must cost nothing.** `quality.indirectLight` is off
   * by default and a frame that declared no fields has nothing to compose, so both are answered
   * before the composer exists — which is what keeps the eighteen scenes byte-identical with the
   * flag off rather than merely close.
   */
  private runIndirectLight(encoder: GPUCommandEncoder): void {
    /*
     * **The flag is read here and in no other place.** It used to be read again by each of the two
     * steps, and a perturbation proved neither of those could fail: the bake needs a composed
     * field, and only the composition makes one. A guard another guard covers is a line no test
     * can hold — this session has had to remove three of them.
     */
    if (!this.quality.indirectLight) return;
    this.composeDistanceField(encoder);
    this.bakeIndirectProbes(encoder);
  }

  private composeDistanceField(encoder: GPUCommandEncoder): void {
    /*
     * **An empty frame still reaches the composer, and a test had to find that.** The early return
     * used to cover the whole method, so a frame that declared nothing left `composed` true from
     * the frame before — and the bake traced against a field built out of geometry the consumer
     * had stopped declaring. What the guard is actually for is not *building* a composer for a
     * profile that never declares anything, so that is all it now guards.
     */
    if (this.fieldComposer === null) {
      if (this.distanceFields.length === 0) return;
      this.fieldComposer = new FieldComposer(this.surface.device, DEFAULT_FIELD_COMPOSE);
    }
    this.fieldComposer.compose(encoder, this.distanceFields, this.frameEye);
  }

  /** The world field this frame composed, or null where none was. For a pass that marches it. */
  get distanceField(): ComposedField | null {
    return this.fieldComposer?.field ?? null;
  }

  /**
   * Refresh this frame's share of the probe grid from the world field, or do nothing at all.
   *
   * **Doing nothing is the ordinary case and must cost nothing**, which is why every condition is
   * answered before the baker exists: a frame may have composed no field — including a frame that
   * declared none after a frame that did, where the composer exists and holds nothing — and a
   * profile may have asked for no probe array. With either false this returns having allocated
   * nothing and recorded nothing, which is what keeps the scenes byte-identical.
   *
   * **The grid is the declared one, or one fitted to the fields themselves.** A consumer that
   * placed its probes always wins. One that did not gets a grid around whatever it said its light
   * may be traced against — which is the right extent rather than a convenient one, because a grid
   * sized to everything drawn would spend its probes on the inside of the sky.
   */
  private bakeIndirectProbes(encoder: GPUCommandEncoder): void {
    const field = this.fieldComposer?.field;
    if (field === undefined || field === null) return;

    /*
     * **The grid is settled before the array is read, and the first version read it first.**
     * Fitting a grid calls `setProbeGrid`, which reallocates the array for the new layer count —
     * so a baker built from the array captured a line earlier held the one-layer array the
     * renderer starts with, and asked it for a view of layer 1. The device refused in those words.
     * It is the trap `setProbeGrid` already documents for the flat bind groups: a group holds
     * whatever texture existed when it was built, for ever, with no error anywhere until the
     * sizes disagree.
     */
    const grid = this.indirectGrid();
    if (grid === null) return;
    const array = this.probeArray;
    const view = this.probeView;
    if (array === null || view === null) return;

    if (this.probeBaker !== null && this.bakerArray !== array) {
      this.probeBaker.dispose();
      this.probeBaker = null;
    }
    this.probeBaker ??= new ProbeBaker(this.surface.device, {
      array,
      view,
      sampler: this.probeSampler,
      edge: this.probeEdge,
      format: this.pipelines.format,
    });
    this.bakerArray = array;
    /*
     * **Whether the scene rasterised this grid first**, which decides two things: that the
     * roughness chain is already valid and must not be overwritten by a diffuse map, and that the
     * probes hold direct light for the trace to bounce. A grid that was never rasterised is traced
     * anyway and converges on whatever it started with — see `ProbeBaker`'s header.
     */
    /*
     * The frame's own sun, taken from the environment `bindMeshPass` was given rather than from a
     * capture — which is what makes a bounce follow a light that moved. A frame that drew no mesh
     * has no environment and traces with the sun off, which is the honest answer for a frame that
     * never said what was lighting it.
     */
    const env = this.frameEnv;
    this.probeBaker.bake(encoder, field, grid, this.probeBaked, {
      direction: env?.directionalDir ?? NO_SUN,
      colour: env?.directionalColor ?? NO_SUN,
      /* What a ray that left the world finds. The frame's own ambient, not a capture. */
      sky: env?.ambient ?? NO_SUN,
    });
    /*
     * **The bake is what fills the layers now, so it is what marks them filled.** `probeBaked`
     * gates the whole array, and a grid nothing rasterised would otherwise never be sampled — the
     * lit pass would read the hemispheric gradient and the traced light would go nowhere.
     */
    if (this.probeBaker.complete) {
      for (let layer = 0; layer < grid.layers; layer += 1) this.markProbeFilled(layer);
    }
  }

  /** The declared grid, or one fitted to this frame's fields, or null where neither is possible. */
  private indirectGrid(): ProbeGrid | null {
    if (this.probes !== null) return this.probes;
    if (!distanceFieldBounds(this.distanceFields, this.fieldBoundsMin, this.fieldBoundsMax)) {
      return null;
    }
    const fitted = fitProbeGrid(
      { min: this.fieldBoundsMin, max: this.fieldBoundsMax },
      INDIRECT_PROBE_SPACING,
      MAX_ENV_PROBES,
    );
    if (!this.setProbeGrid(fitted)) {
      if (!this.indirectGridRefused) {
        this.indirectGridRefused = true;
        console.warn(
          '[driftengine] indirect light needs a probe grid and this profile has no probe array, ' +
            'so nothing is traced. Ask for a quality profile with the environment probe enabled.',
        );
      }
      return null;
    }
    return this.probes;
  }

  /**
   * The device milliseconds the last composed field took, or null where nothing measured it.
   *
   * One frame behind, because a timestamp is read back and a readback that blocked would be the
   * measurement changing what it measures. Null also where no field has ever been composed, and
   * where the device was not asked for `timestamp-query`.
   */
  get distanceFieldMs(): number | null {
    return this.fieldComposer?.composeMs ?? null;
  }

  /**
   * The device milliseconds the last traced probe refresh took, or null where nothing measured it.
   *
   * **A refresh rather than a grid**, which is `PROBES_PER_FRAME` probes and is what a frame
   * actually pays. One frame behind, for the reason `distanceFieldMs` gives.
   */
  get indirectBakeMs(): number | null {
    return this.probeBaker?.bakeMs ?? null;
  }

  /** Ask for the last frame's figures, once the frame that recorded them has been submitted. */
  readDistanceFieldTimings(): void {
    this.fieldComposer?.readTimings();
    this.probeBaker?.readTimings();
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
  /** Each registered pass's declared reads, as a mask, resolved once at registration. */
  private readonly passReads = new Map<PassHandle, number>();
  /**
   * Everything any registered pass says it samples, unioned.
   *
   * **This reaches `liveOut` and not the node's reads, and the difference took a failing test to
   * see.** A read declared on a node only protects an attachment from work *later in the same
   * arena*, because that is what `storeOp` is about — what happens after the pass ends. A
   * package drawing into the frame cannot sample the frame's own depth at all while it is an
   * attachment, so a read declared there would be meaningless.
   *
   * What a contributor actually means by `reads` is "I sample this somewhere", and the renderer
   * has no idea when. So it is treated as the conservative thing it is: the frame keeps it.
   */
  private passReadsUnion = 0;
  /**
   * Mutated in place rather than rebuilt, because `draw` is a per-frame path.
   *
   * A fresh object per invocation is an allocation per registered pass per frame, which is the
   * thing the house rule about hot paths forbids. The contract in `PassDefinition.draw` says the
   * context is valid for the duration of the call for exactly this reason.
   */
  private readonly passContext: {
    backend: 'webgpu';
    pass: GPURenderPassEncoder | null;
    outputTransform: number;
    outputExposure: number;
    jitter: Float32Array;
  } = {
    backend: 'webgpu',
    pass: null,
    outputTransform: 0,
    outputExposure: 1,
    jitter: this.passJitter,
  };

  /**
   * Let something outside this file draw into the frame. See `Renderer.registerPass`.
   *
   * The format and the sample count travel with the device because a render pipeline cannot be
   * built without them and a package has no other way to learn what the frame is.
   */
  registerPass(definition: PassDefinition): PassHandle {
    const handle = registerIn(this.passes, definition);
    /* Resolved once: `maskOf` builds an array, and the frame path may not. */
    const reads = maskOf(...(definition.reads ?? []));
    this.passReads.set(handle, reads);
    this.passReadsUnion |= reads;
    if (definition.prepare !== undefined) this.preparingPasses++;
    definition.init?.(this.passDevice());
    return handle;
  }

  /**
   * How many registered passes declare `prepare`, so a frame with none walks nothing.
   *
   * The registry is a slot table and enumerating it every frame to discover that nobody wants a
   * step is exactly the per-frame work the house rules are about.
   */
  private preparingPasses = 0;
  /** Mutated in place, because `beginFrame` is a per-frame path. See `PassDefinition.prepare`. */
  private readonly prepareContext: {
    backend: 'webgpu';
    encoder: GPUCommandEncoder | null;
    environment: PassEnvironment | null;
    distanceField: ComposedField | null;
    jitter: Float32Array;
  } = {
    backend: 'webgpu',
    encoder: null,
    environment: null,
    distanceField: null,
    jitter: this.passJitter,
  };
  /**
   * The object handed to a pass as `PrepareContext.environment`, rebuilt only when it changes.
   *
   * **Mutated in place for the reason the context above is**: this runs once a frame for every
   * registered pass, and the house rule about per-frame allocation binds the seam as much as the
   * verbs. The view is the only field that can change identity, and it changes when the grid's
   * layer count does.
   */
  private readonly passEnvironment: {
    view: GPUTextureView | null;
    sampler: GPUSampler | null;
    edge: number;
    maxLod: number;
    irradianceLevel: number;
    irradiance: boolean;
    layers: number;
  } = {
    view: null,
    sampler: null,
    edge: 0,
    maxLod: 0,
    irradianceLevel: 0,
    irradiance: false,
    layers: 0,
  };

  /**
   * The frame's reconstruction jitter: one step of the sequence a frame, taken before any pass
   * prepares.
   *
   * **Here and not in `bindMeshPass`, for two reasons that were both defects.** A registered pass
   * prepares at `beginFrame`, before any mesh pass is bound, so a jitter chosen there could not
   * reach it — and the GPU-driven pipeline draws its whole world in `prepare`, unjittered, into a
   * resolve that un-jitters everything. And a frame that bound its mesh pass twice took two steps
   * of the sequence and resolved against the second.
   *
   * The sizes are the frame's by now: `ensureReconstruction` has run.
   */
  private settleReconJitter(): void {
    if (!this.reconstructionWanted) {
      this.passJitter[0] = 0;
      this.passJitter[1] = 0;
      return;
    }
    this.reconFrameIndex += 1;
    this.reconPreviousJitter.set(this.reconJitter);
    jitterOffsetFor(
      this.reconFrameIndex,
      reconJitterPhases(this.renderWidth, this.surface.canvas.width),
      this.reconJitter,
    );
    /* A render pixel is two over the render's size of the clip square; y upward, as the resolve's
       rows and the camera's own matrix both run. */
    this.passJitter[0] = (2 * (this.reconJitter[0] as number)) / this.renderWidth;
    this.passJitter[1] = (2 * (this.reconJitter[1] as number)) / this.renderHeight;
  }

  /**
   * Give every pass that owns a target its chance to fill it, before the frame's own opens.
   *
   * **The ordering is a property of the encoder rather than of a schedule.** Commands recorded on
   * one `GPUCommandEncoder` execute in recording order, and this runs after `beginFrame` created
   * the frame's encoder and before anything opens the frame's render pass — so a target filled
   * here has completed by the time any frame pass could sample it. Nothing in the graph learns
   * about it and nothing is reordered, which is what keeps gate 1.2's withdrawal of dependency
   * ordering intact.
   */
  private runPreparePasses(encoder: GPUCommandEncoder): void {
    if (this.preparingPasses === 0) return;
    this.prepareContext.encoder = encoder;
    /*
     * **The same test the lit pass applies to its own binding**: a view exists from the moment the
     * array is created, and what makes it *readable* is a completed bake that is not the one
     * currently open. Offering it earlier hands a pass a texture of undefined contents, which is
     * the failure `probeBaked` was introduced for on the forward path.
     */
    const usable = this.probeView !== null && this.probeBaked && !this.probePassActive;
    if (usable) {
      const environment = this.passEnvironment;
      environment.view = this.probeView;
      environment.sampler = this.probeSampler;
      environment.edge = this.probeEdge;
      environment.maxLod = this.probeMaxLod;
      environment.irradianceLevel = irradianceLevelFor(this.probeEdge);
      environment.irradiance = this.probeAmbient;
      environment.layers = this.probes?.layers ?? 1;
      this.prepareContext.environment = environment as PassEnvironment;
    } else {
      this.prepareContext.environment = null;
    }
    /*
     * The field the *previous* frame composed, because this runs at `beginFrame` and the
     * composition runs at `endFrame`. `PrepareContext.distanceField` says why that is right rather
     * than merely what happens.
     */
    this.prepareContext.distanceField = this.fieldComposer?.field ?? null;
    for (const definition of this.passes.definitions) {
      definition?.prepare?.(this.prepareContext as PrepareContext);
    }
  }

  /**
   * Record one, to be run where the caller put it.
   *
   * With the graph off there is nothing to record into, so it runs at once against the pass the
   * caller is drawing into — which is what every verb's direct path does, and is why the two
   * behave identically from outside.
   */
  drawPass(handle: PassHandle): void {
    if (!this.canDraw()) return;
    const definition = passAt(this.passes, handle);
    if (definition === undefined) return;
    if (!this.quality.frameGraph) {
      const pass = this.openPass();
      if (pass === null) return;
      this.passContext.pass = pass;
      /* The frame's grade, so a contributed pass can obey the 2026-08-17 rule. See `PassContext`. */
      this.passContext.outputTransform = this.gradeCode();
      this.passContext.outputExposure = this.gradeExposure();
      definition.draw(this.passContext as PassContext);
      return;
    }
    recordNode(
      this.arena,
      VERB_PASS,
      this.passReads.get(handle) ?? 0,
      this.currentTarget(),
      handle,
      0,
    );
  }

  /** Let go of a pass. A handle kept past this draws nothing; see `PassHandle`. */
  unregisterPass(handle: PassHandle): void {
    const definition = unregisterIn(this.passes, handle);
    if (definition?.prepare !== undefined) this.preparingPasses--;
    this.passReads.delete(handle);
    /* Rebuilt rather than subtracted: two passes may name the same resource, and clearing a bit
       one of them still needs is how an attachment gets thrown away underneath a reader. */
    this.passReadsUnion = 0;
    for (const mask of this.passReads.values()) this.passReadsUnion |= mask;
    definition?.dispose?.(this.passDevice());
  }

  /* -- Compute ------------------------------------------------------------------------- */

  /** Whether this backend can run a compute definition. See `Renderer.computeSupported`. */
  readonly computeSupported = true;

  private readonly computes: ComputeRegistry = createComputeRegistry();

  /* -- The froxel table ----------------------------------------------------------------- */

  /**
   * The binner, held only when the profile asked for clustering.
   *
   * **Registered through the public seam rather than called directly**, which is not ceremony: it
   * is the only consumer of `registerCompute` inside the engine, so if the seam were wrong for its
   * first real user that is worth finding here rather than in a package that does not exist yet.
   */
  private clusterBinner: ClusterBinner | null = null;
  private clusterHandle: ComputeHandle = 0;
  /** The one-texel stand-in bound when there is no table. Assigned in the constructor. */
  private blankTableView: GPUTextureView | null = null;
  /** near, far, tan(fovY/2), aspect. Written per frame into the fragment block. */
  private readonly clusterFrustum = new Float32Array(4);
  /** Refilled per frame; holds references and allocates nothing. */
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

  /**
   * Reused per dispatch rather than allocated, for the reason `passContext` gives beside it: a
   * fresh object per dispatch is an allocation on a per-frame path. The contract in
   * `ComputeDefinition.dispatch` says the context is valid for the duration of the call for
   * exactly this reason.
   */
  private readonly computeContext: { backend: 'webgpu'; pass: GPUComputePassEncoder | null } = {
    backend: 'webgpu',
    pass: null,
  };

  /** Let something outside this file compute. See `Renderer.registerCompute`. */
  registerCompute(definition: ComputeDefinition): ComputeHandle {
    const handle = registerIn(this.computes, definition);
    definition.init?.(this.computeDevice());
    return handle;
  }

  /**
   * Run one, now, on an encoder of its own.
   *
   * **Its own encoder, and that is the whole of the design.** `beginComputePass` cannot be opened
   * while a render pass is open, and this frame's render pass is opened late and then deliberately
   * kept open — closing and reopening it was measured at 92 MB a frame at 824x1830, which is what
   * `beginFrame` stopped paying. A dispatch that closed it would spend that again on every frame
   * that computed, which is the largest single cost this backend has ever removed.
   *
   * **Submitted here rather than deferred to `endFrame`**, because submission order is execution
   * order and a frame with a mirror in it submits three times before `endFrame` runs. Deferring
   * would land the compute *after* the reflection's submit and quietly starve the pass most likely
   * to want it. One submit per dispatch is what that costs; batching several into one compute pass
   * is a measured optimisation and would bring the ordering question back with it.
   *
   * **`flushRings` first**, for the reason `endPlanarReflection` calls it before its own submit: a
   * ring's writes have to land on the queue ahead of the commands that read them. A ring with
   * nothing in it returns immediately, so a dispatch early in the frame pays almost nothing for
   * the guarantee — and a ring in neither `flushRings` nor `beginFrame`'s reset is exactly how the
   * probe's mip chain came to read a buffer nobody uploaded.
   */
  dispatchCompute(handle: ComputeHandle): void {
    if (this.surface.lost) return;
    const definition = computeAt(this.computes, handle);
    if (definition === undefined) return;
    const { device } = this.surface;
    const encoder = device.createCommandEncoder({ label: `compute.${definition.label}` });
    const pass = encoder.beginComputePass({ label: definition.label });
    this.computeContext.pass = pass;
    definition.dispatch(this.computeContext as ComputeContext);
    pass.end();
    this.flushRings();
    device.queue.submit([encoder.finish()]);
  }

  /** Let go of a definition. A handle kept past this dispatches nothing; see `ComputeHandle`. */
  unregisterCompute(handle: ComputeHandle): void {
    const definition = unregisterIn(this.computes, handle);
    definition?.dispose?.(this.computeDevice());
  }

  /**
   * Fill the froxel table for this frame, and write the four numbers that address it.
   *
   * **Dispatched here rather than at `beginFrame`**, because this is the one place a camera and an
   * environment arrive together, and a froxel grid is defined by the camera's frustum. It is also
   * before any draw the table feeds, and `dispatchCompute` submits where it is issued, so the
   * ordering the lit pass depends on holds without anything having to reason about it.
   *
   * The frustum is read off the projection rather than taken as a parameter, for the reason
   * `renderer.ts` gives at its own copy: derived numbers cannot disagree with the matrix the world
   * was actually drawn with, and a caller-supplied field of view can.
   */
  private bindClusters(
    camera: Camera,
    env: Environment,
    f: Float32Array,
    i: Int32Array,
    at: (name: string) => number,
  ): void {
    const binner = this.clusterBinner;
    i[at('uClustered')] = binner === null ? 0 : 1;
    if (binner === null) return;

    const p = camera.projection;
    const tanHalfFovY = 1 / (p[5] ?? 1);
    const aspect = (p[5] ?? 1) / (p[0] ?? 1);
    const near = (p[14] ?? 0) / ((p[10] ?? -1) - 1);
    const far = (p[14] ?? 0) / ((p[10] ?? -1) + 1);
    this.clusterFrustum[0] = near;
    this.clusterFrustum[1] = far;
    this.clusterFrustum[2] = tanHalfFovY;
    this.clusterFrustum[3] = aspect;
    const frustumAt = at('uClusterFrustum');
    f[frustumAt] = near;
    f[frustumAt + 1] = far;
    f[frustumAt + 2] = tanHalfFovY;
    f[frustumAt + 3] = aspect;
    f.set(camera.view as Float32Array, at('uView'));

    const set = this.clusterLights;
    set.count = Math.min(env.lightCount ?? 0, MAX_CLUSTERED_LIGHTS);
    set.positions = env.lightPositions;
    set.colors = env.lightColors;
    set.radii = env.lightRadii;
    set.sourceRadii = env.lightSourceRadii ?? env.lightRadii;
    set.weights = env.lightWeights;
    binner.setFrame({
      lights: set as ClusterLightSet,
      view: camera.view as Float32Array,
      near,
      far,
      tanHalfFovY,
      aspect,
      shadowSlots: MAX_POINT_LIGHTS,
    });
    this.dispatchCompute(this.clusterHandle);
  }

  /** Allocates, and may: registration and disposal are init-time, exactly as `passDevice` is. */
  private computeDevice(): ComputeDevice {
    return { backend: 'webgpu', device: this.surface.device };
  }

  private passDevice(): PassDevice {
    return {
      backend: 'webgpu',
      device: this.surface.device,
      format: this.pipelines.format,
      /* The frame's own depth attachment, so a contributed pass can be occluded by the world
         rather than guessing a format. See `PassDevice`. */
      depthFormat: DEPTH_FORMAT,
      /* The same four numbers this backend's own verbs are projected through. See `PassDevice`. */
      clipCorrection: CLIP_CORRECTION,
      /* And the one a pass that wrote its own WGSL wants, which is the same without the Y
         negation — that negation cancels `naga`'s, and a hand-written shader has none. */
      depthCorrection: DEPTH_CORRECTION,
      samples: this.samples,
      /* Whether a pass drawing the world owes the frame its jitter and its depth. See `PassDevice`. */
      reconstruction: this.reconstructionWanted,
    };
  }

  /**
   * Told when the drawing context comes back — which, on this backend, it does not.
   *
   * **A device is not restored, it is replaced.** WebGL2 has a `webglcontextrestored` event
   * and `renderer.ts` reports it while saying plainly that it rebuilds nothing, because every
   * resource field there is `readonly` and set in the constructor. WebGPU does not even offer
   * the event: recovering means requesting a new device and building a new renderer on it,
   * which is a decision for whatever owns the canvas.
   *
   * So this registers a listener that will not fire, and that is the honest shape rather than
   * an omission — the alternative is a missing method, which throws and takes the frame with
   * it. A consumer wanting to survive a reset listens to `onContextLost` and remounts.
   */
  onContextRestored(_listener: () => void): void {
    /* Deliberately never called; see above. */
  }

  /* -- Insets ------------------------------------------------------------------------- */

  private readonly insetLayout: GPUBindGroupLayout;
  private readonly insetUniforms: UniformRing;
  private readonly insetBindGroup: GPUBindGroup;

  /**
   * Draw the next thing into a rectangle of the canvas, and give the rest back with `endInset`.
   *
   * `rect` is viewport-relative — a measured DOM element — which is why the canvas's own
   * bounding box is subtracted here. `renderer.ts` makes the argument for doing that arithmetic
   * in the renderer: a caller converting CSS pixels into drawing-buffer pixels *and* flipping
   * the origin is a caller with two chances to be wrong about somebody else's state.
   *
   * **The clear is a drawn quad rather than a clear**, because WebGPU clears whole attachments
   * and cannot confine one to a scissor. See `insetPass.ts`.
   *
   * Returns the drawing-buffer height of the inset, as the other backend does.
   */
  beginInset(rect: InsetRect, clearColor: Vec3 | null): number {
    /*
     * A boundary rather than a verb, and counted as one: the viewport and scissor set below are
     * pass state, so everything recorded before this line belongs to the rectangle that was in
     * force before it. `endInset` makes the same argument on the way out.
     */
    if (this.quality.frameGraph) this.flushGraph();
    const pass = this.openPass();
    if (this.surface.lost || pass === null) return 0;
    const canvas = this.surface.context.canvas as HTMLCanvasElement;
    const cssWidth = Math.max(canvas.clientWidth, 1);
    const cssHeight = Math.max(canvas.clientHeight, 1);
    const origin = canvas.getBoundingClientRect();
    /*
     * **CSS pixels to the scene's pixels, not the viewer's.** A viewport is state on the frame's
     * own pass, which draws into the render-size targets, so a box measured in the drawing buffer
     * would be scaled by the reconstruction ratio and land off the side of a smaller attachment.
     */
    const scaleX = this.renderWidth / cssWidth;
    const scaleY = this.renderHeight / cssHeight;
    const left = rect.left - origin.left;
    const top = rect.top - origin.top;
    const w = Math.max(1, Math.round(rect.width * scaleX));
    const h = Math.max(1, Math.round(rect.height * scaleY));
    const x = Math.round(left * scaleX);
    /*
     * **Y counts down here and up on WebGL2.** `gl.viewport` measures from the bottom, so that
     * backend computes `cssHeight - top - height`; a WebGPU viewport and scissor measure from
     * the top, which is what the caller already handed over. Converting twice is how a box ends
     * up mirrored about the middle of the frame.
     */
    const y = Math.round(top * scaleY);

    /*
     * **Clamped to the attachment, because this API will not take anything else.**
     *
     * `setScissorRect` is `[EnforceRange] unsigned long` and a viewport must lie inside the
     * attachment at both ends, so a negative origin *throws* — inside the frame, which loses
     * every draw recorded after it. A panel animating in from the left edge is momentarily
     * exactly that, and it is how this was found: a real game packaged for the desktop threw on
     * every frame of a slide-in.
     *
     * **WebGL2 has no such rule**: `gl.viewport` and `gl.scissor` take negatives and draw the
     * part that lands, so the same inset slides correctly there and this one is pinned to the
     * edge for the frames it is half-off. That asymmetry is the cost of the clamp, it is
     * recorded in the parity ledger, and the alternative was an exception.
     */
    /* The attachment this pass draws into, which is the scene's size — see `renderWidth`. */
    const targetWidth = this.renderWidth;
    const targetHeight = this.renderHeight;
    const clampedX = Math.max(0, Math.min(x, targetWidth));
    const clampedY = Math.max(0, Math.min(y, targetHeight));
    const clampedW = Math.max(0, Math.min(x + w, targetWidth) - clampedX);
    const clampedH = Math.max(0, Math.min(y + h, targetHeight) - clampedY);

    /*
     * Entirely outside is nothing to draw rather than a rectangle to clamp: a zero-width scissor
     * is itself invalid. The aspect is still the one the caller asked for, so a camera composed
     * against it does not lurch on the frame a panel finishes leaving.
     */
    if (clampedW === 0 || clampedH === 0) return w / h;

    pass.setViewport(clampedX, clampedY, clampedW, clampedH, 0, 1);
    pass.setScissorRect(clampedX, clampedY, clampedW, clampedH);

    const slot = this.insetUniforms.allocate();
    if (slot !== null) {
      /* Only the colour: the quad covers the viewport set above, so it needs no geometry. */
      const color = clearColor ?? BLACK_CLEAR;
      this.insetUniforms.writeFloats(slot, 0, [color[0], color[1], color[2], 1]);
      const insetPipe = insetPipeline(
        this.targetPipelines(),
        this.surface.device,
        this.insetLayout,
        clearColor !== null,
      );
      /*
       * Recorded even though the viewport it fills is state on the pass, because it is set
       * above and `endInset` flushes before restoring it. So the quad is replayed while its own
       * rectangle is still in force, whichever flush gets to it.
       */
      const insetCommand = this.recordDraw(0, this.currentTarget());
      if (insetCommand !== null) {
        insetCommand.pipeline = insetPipe;
        insetCommand.bindGroup = this.insetBindGroup;
        insetCommand.offsetA = slot;
        insetCommand.offsetCount = 1;
        insetCommand.count = 6;
      } else {
        pass.setPipeline(insetPipe);
        pass.setBindGroup(0, this.insetBindGroup, [slot]);
        pass.draw(6);
      }
    }
    /*
     * **The aspect of the pixels the viewport actually got, which is what `Renderer` returns.**
     *
     * This returned `h` — the height in device pixels — and both are a `number`, so nothing
     * anywhere could catch it. A caller does what the contract says and hands it straight to
     * `camera.updateMatrices(aspect)`, so a portrait three hundred pixels tall composed for an
     * aspect of three hundred: the figure it was aiming at ends up somewhere off the side of a
     * projection squeezed flat, and what lands in the box is unrecognisable rather than absent.
     * Reported from the game as the character replica and the display showcase both being wrong, which
     * is both of the places it uses an inset.
     *
     * The rounding above is why it is returned rather than recomputed by the caller: the CSS
     * ratio and this one are not always identical, and two calculations of one number is how a
     * camera composes for a rectangle that does not exist.
     */
    return w / h;
  }

  /** Give the whole canvas back. Safe to call without a matching `beginInset`. */
  endInset(): void {
    /*
     * Flush before the boundary, for the reason the mirror's two ends give.
     *
     * A viewport and a scissor are state on the pass, applied when a command is *issued*. A
     * draw recorded inside the box and replayed after this line is drawn across the whole frame
     * instead of into it — a figure at the wrong size in the wrong place, which is the one
     * thing an inset exists to prevent. `beginInset` needs no such line: it draws its own clear
     * quad, so it goes through `ensurePass` and flushes there.
     */
    if (this.quality.frameGraph) this.flushGraph();
    const pass = this.pass;
    if (this.surface.lost || pass === null) return;
    /* The whole of what this pass draws into, which is the scene's size and not the viewer's. */
    pass.setViewport(0, 0, this.renderWidth, this.renderHeight, 0, 1);
    pass.setScissorRect(0, 0, this.renderWidth, this.renderHeight);
  }

  /**
   * Copy a rectangle of the frame into a 2D canvas, pixel for pixel.
   *
   * **Backend-agnostic, and the same code on both.** `drawImage` takes the canvas element,
   * which is the canvas whichever API drew into it, so nothing here touches a device. Sized to
   * the source so the copy is never resampled, and written only when it changes because
   * assigning width or height clears the target.
   */
  copyRegionTo(rect: InsetRect, target: HTMLCanvasElement): void {
    if (this.surface.lost) return;
    /* Synchronously, because `drawImage` below reads the canvas and a recorded pass has not
       written it yet. This is the one caller that cannot wait for the microtask. */
    this.flushOverlay();
    const canvas = this.surface.context.canvas as HTMLCanvasElement;
    const origin = canvas.getBoundingClientRect();
    const scaleX = canvas.width / Math.max(canvas.clientWidth, 1);
    const scaleY = canvas.height / Math.max(canvas.clientHeight, 1);
    const sw = Math.max(1, Math.round(rect.width * scaleX));
    const sh = Math.max(1, Math.round(rect.height * scaleY));
    if (target.width !== sw || target.height !== sh) {
      target.width = sw;
      target.height = sh;
    }
    const ctx = target.getContext('2d');
    if (ctx === null) return;
    ctx.drawImage(
      canvas,
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
   * How far into the tone curve this frame is exposed.
   *
   * Live, and it reaches the picture here rather than through a composite: this backend grades
   * in the mesh pass because that is the last pass it has. See `bindMeshPass`.
   */
  setOutputExposure(exposure: number): void {
    this.exposure = Number.isFinite(exposure)
      ? Math.max(exposure, 1e-3)
      : this.quality.outputExposure;
  }

  /** This frame's exposure into the tone curve. Starts at the profile's own. */
  private exposure: number;

  /*
   * -----------------------------------------------------------------------------------------
   * The three screen effects, which this backend cannot yet honour — and says so.
   *
   * **Each needs the composite that does not exist here.** `renderer.ts` renders the world into
   * an off-screen `sceneTarget` and resolves it through a chain: bloom is a threshold, a blur
   * and an add; the speed rush is a radial blur of the resolved image; camera motion blur
   * reprojects the previous frame's view-projection across it. None of the three can be
   * expressed in a mesh pass, which is all this backend has, so there is nothing to store the
   * value into that would change a pixel.
   *
   * **Kept as members that warn rather than as members that quietly do nothing.** A missing
   * method throws and takes the frame with it; a silent no-op is the failure this whole branch
   * exists to avoid — a governor turning bloom down to recover frame rate, seeing no change,
   * and concluding that bloom was not what cost it. The value is stored so a later composite
   * has it, and the warning is said once per renderer for the reason `warnedFull` gives.
   * -----------------------------------------------------------------------------------------
   */

  private bloomScale = 1;
  private rushStrength = 0;
  private motionBlurScale = 1;
  /**
   * This frame's veil colour, and how much of it to composite. See `Renderer.setFrameVeil`.
   *
   * Reset to zero alpha at the end of every `endFrame`, unlike the three fields above: a
   * forgotten veil is a stuck white or black frame, which is worse than one that has to ask
   * again.
   */
  private readonly veilColor: Vec3 = [0, 0, 0];
  private veilAlpha = 0;

  /*
   * **These three warned that the composite did not exist, and went on warning after it did.**
   *
   * They were honest when written and the frame really was unchanged. The composite landed, the
   * values started being read, and nobody came back — so a consumer turning the speed rush on
   * was told the effect does nothing while it was drawing. Measured on `demo/dev/probe.html`
   * against WebGL2: the rush differs in **zero** pixels of 857,600.
   *
   * What is left worth saying is a question about the *profile* rather than about the backend,
   * and `bloomChain.ts` says it once for both of them, at init, where `renderer.ts` always said
   * it. See the constructor.
   */

  /** How much of the frame's bloom to apply, 0 to 1. Scales the profile's `bloom`. */
  /**
   * The colour grade this and every later frame applies, until it is set again.
   *
   * The same contract `Renderer.setColourGrade` states and the same refusal: it needs a
   * composite, because without one every forward pass grades itself and there is nowhere to
   * apply a look once. Said out loud rather than silently ignored — this backend spent a while
   * telling consumers that working effects did nothing, and the correction was to make present
   * and honoured the same thing rather than to stop saying anything.
   *
   * **The bind group holds the view, so a new table rebuilds it.** A bind group is built with
   * the view it was given and cannot be handed another, which is the rule `ensureComposite`
   * already records about resized targets — and the reason the upload is gated on the object
   * changing rather than done every frame.
   */
  setColourGrade(lut: ColourGradeLut | null, strength = 1): void {
    if (!this.hasComposite) {
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
    this.gradeStrength = lut === null ? 0 : Math.max(0, Math.min(1, strength));
    if (lut === null || lut === this.gradeSource) return;
    validateGradeLut(lut);
    this.uploadGrade(lut);
    this.gradeSource = lut;
    /* Rebuilt rather than patched: a group holds the view it was made with. Null here and the
       composite skips its draw for one frame, which `ensureComposite` will not do — so it is
       rebuilt eagerly, at a setter, which is not a frame path. */
    this.rebuildRushBindGroup();
  }

  /** The grade's view, building the identity placeholder the first time anything asks. */
  private ensureGradeView(): GPUTextureView {
    if (this.gradeView === null) this.uploadGrade(identityGradeLut(GRADE_PLACEHOLDER_SIZE));
    return this.gradeView as GPUTextureView;
  }

  /**
   * Put a table on the device, replacing whatever was there.
   *
   * `rgba8unorm` and a filtering sampler, which is what makes a 32-lattice table smooth rather
   * than banded. `bytesPerRow` is the lattice times four and `rowsPerImage` the lattice, because
   * a 3D write needs both and a wrong one silently shears the cube.
   */
  private uploadGrade(lut: ColourGradeLut): void {
    const { device } = this.surface;
    this.gradeTexture?.destroy();
    this.gradeTexture = device.createTexture({
      label: 'post.colourGrade',
      size: [lut.size, lut.size, lut.size],
      dimension: '3d',
      format: 'rgba8unorm',
      usage: 0x4 | 0x2, // TEXTURE_BINDING | COPY_DST
    });
    device.queue.writeTexture(
      { texture: this.gradeTexture },
      lut.data,
      { bytesPerRow: lut.size * 4, rowsPerImage: lut.size },
      [lut.size, lut.size, lut.size],
    );
    this.gradeView = this.gradeTexture.createView({ dimension: '3d' });
    this.gradeSize = lut.size;
  }

  setBloom(scale: number): void {
    this.bloomScale = Math.min(Math.max(scale, 0), 1);
  }

  /**
   * How thick the air is, this frame: a global participating medium filling the whole frustum.
   *
   * The dial beside `globalMediumSteps`' ceiling. `renderer.ts` carries the full note; the short
   * version is that `density` is extinction per metre, 0 is a real off that allocates nothing and
   * draws nothing, and the three optional arguments are held until changed.
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

  /** How much speed blur the frame should resolve with, 0 to 1. */
  setSpeedRush(strength: number): void {
    this.rushStrength = Math.min(Math.max(strength, 0), 1);
  }

  /** How much of the frame's camera motion blur to apply, 0 to 1. */
  setCameraMotionBlur(scale: number): void {
    this.motionBlurScale = Math.min(Math.max(scale, 0), 1);
  }

  /**
   * Where this frame's lens is focused, how deep the sharp zone is, and how much of the ceiling
   * to take. **The other backend's `setDepthOfField` carries the reasoning**, whole: the
   * ceiling-and-dial split, why racking focus is the caller's, and why `range` is clamped above
   * zero. This is the same setter over the same state.
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
   * Composite a flat colour over the finished frame — for a cut dipping to white or to black.
   *
   * See `Renderer.setFrameVeil` for the full ruling on where this sits: after the tone map,
   * before grain and vignette, upstream of nothing bloom reads. Both backends draw it from the
   * same generated `rush.ts` shader, so there is one place that reasoning has to be written.
   */
  setFrameVeil(r: number, g: number, b: number, alpha: number): void {
    this.veilColor[0] = Math.min(Math.max(r, 0), 1);
    this.veilColor[1] = Math.min(Math.max(g, 0), 1);
    this.veilColor[2] = Math.min(Math.max(b, 0), 1);
    this.veilAlpha = Math.min(Math.max(alpha, 0), 1);
  }

  /* -- Caustics ------------------------------------------------------------------------ */

  private readonly causticsLayout: GPUBindGroupLayout;
  /** A slot per batch, for the reason `causticsPass.ts`'s layout gives. */
  private readonly causticsVerts: UniformRing;
  private readonly causticsFrags: UniformRing;
  private readonly causticsBindGroup: GPUBindGroup;
  private readonly causticsVertStaging = new ArrayBuffer(CAUSTICS_VERT_SIZE);
  private readonly causticsVertFloats = new Float32Array(this.causticsVertStaging);
  /** The same bytes as an `i32` view, which is what a ring slot is copied through. */
  private readonly causticsVertBlock = new Int32Array(this.causticsVertStaging);
  private readonly causticsFragStaging = new ArrayBuffer(CAUSTICS_FRAG_SIZE);
  private readonly causticsFragFloats = new Float32Array(this.causticsFragStaging);
  private readonly causticsFragInts = new Int32Array(this.causticsFragStaging);
  /** Said once rather than every frame, for the reason `warnedFull` gives. */
  private warnedCausticsFull = false;
  /** The light's tint, refilled per draw rather than allocated. See `causticsRenderer.ts`. */
  private readonly causticsTint = new Float32Array(3);

  /**
   * A surface lit by nearby water: a pool floor, a soffit, the mouth of a cave.
   *
   * Null on a profile with water off or with no sheets, exactly as `renderer.ts` returns null,
   * so a scene's own `drawCaustics(null, …)` guard works the same on both.
   */
  createCaustics(sheets: readonly CausticSheet[]): GpuCaustics | null {
    if (!this.quality.water || sheets.length === 0) return null;
    /* The same sheets from the same builder, so the two backends light the same geometry. */
    const mesh = buildSheets(sheets, CAUSTICS_CELL_M, (sheet, out) => {
      out[0] = sheet.waterY;
      out[1] = 0;
    });
    return createGpuCaustics(
      this.surface.device,
      mesh.positions,
      mesh.locals,
      mesh.params,
      mesh.vertexCount,
    );
  }

  disposeCaustics(caustics: GpuCaustics | null): void {
    caustics?.dispose();
  }

  /** Add the water's light to an already-shaded scene. Draw after the opaque pass. */
  drawCaustics(
    caustics: GpuCaustics | null,
    camera: Camera,
    timeSeconds: number,
    env: Environment,
    windX = 0,
    windZ = 0,
    strength = 1,
  ): void {
    if (!this.canDraw() || caustics === null) return;
    if (!this.quality.water || caustics.vertexCount === 0) return;

    /*
     * A slot each, before anything is prepared: a batch that cannot be addressed must not be
     * drawn with another batch's numbers, which is what a shared buffer did before the ring.
     */
    const vertexSlot = this.causticsVerts.allocate();
    const fragmentSlot = this.causticsFrags.allocate();
    if (vertexSlot === null || fragmentSlot === null) {
      if (!this.warnedCausticsFull) {
        this.warnedCausticsFull = true;
        console.warn(
          `WebGPU: more than ${MAX_BATCHES_PER_FRAME} caustic batches in a frame; the rest are skipped`,
        );
      }
      return;
    }

    const v = this.causticsVertFloats;
    const atV = (name: string): number => (CAUSTICS_VERT_FIELDS[name]?.offset ?? -4) / 4;
    mat4.multiply(this.correctedViewProj, CLIP_CORRECTION, camera.viewProjection);
    v.set(this.correctedViewProj, atV('uViewProj'));

    const f = this.causticsFragFloats;
    const i = this.causticsFragInts;
    const atF = (name: string): number => (CAUSTICS_FRAG_FIELDS[name]?.offset ?? -4) / 4;
    f.set(camera.position, atF('uCameraPos'));
    f[atF('uTime')] = timeSeconds;
    f[atF('uMaxDrop')] = CAUSTICS_MAX_DROP_M;
    f[atF('uStrength')] = strength;
    f.set(env.directionalDir, atF('uLightDir'));

    /*
     * What the water is reflecting: the dominant source plus a share of the ambient standing in
     * for the sky. `causticsRenderer.ts` makes the case that the ambient term is not decoration
     * — under a bridge at night the sun contributes nothing, and a caustic that switched off
     * with the sun would take the best image in the game with it.
     */
    const tint = this.causticsTint;
    tint[0] = (env.directionalColor[0] ?? 0) * 0.85 + (env.ambient[0] ?? 0) * 1.5;
    tint[1] = (env.directionalColor[1] ?? 0) * 0.85 + (env.ambient[1] ?? 0) * 1.5;
    tint[2] = (env.directionalColor[2] ?? 0) * 0.85 + (env.ambient[2] ?? 0) * 1.5;
    f.set(tint, atF('uTint'));

    /* The same sea state, from the same wind, as every other body of water. */
    const windSpeed = Math.hypot(windX, windZ);
    const sea = seaStateForWind(windSpeed);
    const inv = windSpeed > 1e-5 ? 1 / windSpeed : 0;
    f[atF('uWindDir')] = inv === 0 ? 1 : windX * inv;
    f[atF('uWindDir') + 1] = inv === 0 ? 0 : windZ * inv;
    f[atF('uWaveGain')] = sea.steepness;

    const medium = resolveAtmosphere(
      env,
      this.atmosphereHeight(camera),
      this.quality.underwaterAtmosphere,
      this.medium,
    );
    f.set(medium.fogColor, atF('uFogColor'));
    f[atF('uFogDensity')] = medium.fogDensity;
    f[atF('uFogHeightFalloff')] = medium.fogHeightFalloff;
    f[atF('uFogEyeY')] = medium.fogEyeY;
    f.set(medium.underwaterColor, atF('uUnderwaterColor'));
    f[atF('uUnderwaterFogDensity')] = medium.underwaterFogDensity;
    f[atF('uUnderwaterFactor')] = medium.underwaterFactor;
    i[atF('uFogMode')] = medium.fogMode;
    f[atF('uFogNear')] = medium.fogNear;
    f[atF('uFogFar')] = medium.fogFar;

    this.causticsVerts.writeBlock(vertexSlot, this.causticsVertBlock);
    this.causticsFrags.writeBlock(fragmentSlot, this.causticsFragInts);

    const causticsPipe = causticsPipeline(this.pipelines, this.surface.device, this.causticsLayout);
    /* The pattern is generated in the shader from the two uniform blocks; nothing is sampled. */
    const causticsCommand = this.recordDraw(0, this.currentTarget());
    if (causticsCommand !== null) {
      causticsCommand.pipeline = causticsPipe;
      causticsCommand.bindGroup = this.causticsBindGroup;
      causticsCommand.offsetA = vertexSlot;
      causticsCommand.offsetB = fragmentSlot;
      causticsCommand.offsetCount = 2;
      for (let index = 0; index < caustics.vertexBuffers.length; index++) {
        causticsCommand.vertexBuffers[index] = caustics.vertexBuffers[index] as GPUBuffer;
      }
      causticsCommand.vertexCount = caustics.vertexBuffers.length;
      causticsCommand.count = caustics.vertexCount;
    } else {
      const pass = this.openPass();
      if (pass === null) return;
      pass.setPipeline(causticsPipe);
      pass.setBindGroup(0, this.causticsBindGroup, [vertexSlot, fragmentSlot]);
      for (let index = 0; index < caustics.vertexBuffers.length; index++) {
        pass.setVertexBuffer(index, caustics.vertexBuffers[index] as GPUBuffer);
      }
      pass.draw(caustics.vertexCount);
    }
  }

  /** Scale one plume in a batch, 0 to hide it. See `GpuPlumes.setScale`. */
  setPlumeScale(plumes: GpuPlumes, index: number, scale: number): void {
    if (this.surface.lost) return;
    plumes.setScale(index, scale);
  }

  /** Scratch for `drawingBufferSize`, which fills a caller's object rather than allocating. */
  private readonly budgeted: { width: number; height: number } = { width: 1, height: 1 };
  private maxDrawingBufferPixels: number;
  /** A caller's exact size, or zero for "follow the CSS box". */
  private lockedWidth = 0;
  private lockedHeight = 0;

  /**
   * Pin the drawing buffer to an exact size, whatever the page is doing.
   *
   * For an export: a clip is 1080x1920 whatever anybody's frame rate or device ratio is. The
   * pixel budget deliberately does not apply to a locked buffer — see `resize` — because
   * quietly returning a different size writes a file that is not the size it claims.
   */
  lockDrawingBuffer(width: number, height: number): void {
    if (this.surface.lost) return;
    this.lockedWidth = Math.max(2, Math.round(width));
    this.lockedHeight = Math.max(2, Math.round(height));
    this.resize();
  }

  /** Back to following the CSS box. The next `resize` restores it. */
  unlockDrawingBuffer(): void {
    if (this.surface.lost) return;
    this.lockedWidth = 0;
    this.lockedHeight = 0;
    this.resize();
  }

  /* -- The environment probe ------------------------------------------------------------ */

  /** Whether this device and profile have an environment probe at all. See the constructor. */
  private readonly probeEnabled: boolean;
  /**
   * The captured cube: what the bake draws into, and the source the convolution reads.
   *
   * **Not what the lit pass samples.** It carries a box-filtered chain, which is a filter the
   * specular integral does not want and only ever wanted as a stand-in. It stays because filtered
   * importance sampling needs a chain to select a level from, and because the spherical-harmonic
   * projection reads it — the irradiance term is an integral over the capture and would be wrong
   * over a lobe-convolved one.
   */
  private readonly probe: GPUTexture | null;
  /**
   * The prefiltered cube: what the lit pass samples, one GGX-convolved level per roughness.
   *
   * **A second texture rather than the capture written in place**, and the cost is one cube of
   * memory. What it buys: no level is ever convolved from a level that was already convolved,
   * which applies the lobe twice and compounds up the chain; and the capture survives for the
   * projection above. **What would make it wrong** is a probe large enough that a second cube is
   * the memory decision — at 128 with a chain this is about a megabyte at half float.
   */
  /**
   * Every probe of the grid as one array texture, octahedral, gutter included.
   *
   * **Recreated when a grid's layer count changes**, and the flat bind groups are rebuilt with it:
   * a group built at construction holds the texture that existed then, so a larger array created
   * later would never be read and the picture would keep the one-probe grid it started with.
   */
  private probeArray: GPUTexture | null = null;
  /** Where the probes stand. A single baked probe is a grid of one at that probe's own origin. */
  private probes: ProbeGrid | null = null;
  /** Whether the grid supplies the scene's ambient. `ProbeBakeOptions.irradiance`, at grid scope. */
  private probeAmbient = true;
  /** Where the probe being baked stands. Reused, so a bake allocates nothing. */
  private readonly probeOrigin: Vec3 = [0, 0, 0];
  /** Texels across one probe's map at level 0. Twice the capture's face; see `octahedralEdgeFor`. */
  private readonly probeEdge: number;
  /** The view bound as `uEnvironment`: the prefilter's, never the capture's. */
  private probeView: GPUTextureView | null = null;
  private readonly probeSize: number;
  private readonly probeMipLayout: GPUBindGroupLayout;
  /** The photometric atlas, allocated on first use. See `setIesProfiles`. */
  private iesTexture: GPUTexture | null = null;
  private iesView: GPUTextureView | null = null;
  private cookieTexture: GPUTexture | null = null;
  private cookieView: GPUTextureView | null = null;
  /** Tiles in the cookie atlas. 0 is the white placeholder and the whole off path. */
  private cookieTiles = 0;
  /** Rows in that atlas. One until a consumer loads a profile, which is the row of ones. */
  private iesRows = 1;
  /** Horizontal planes each profile occupies. 1 unless something asymmetric was loaded. */
  private iesPlanes = 1;
  /** The convolution's own layout: the generator's binding numbers, not the mip blit's. */
  private readonly probePrefilterLayout: GPUBindGroupLayout;
  private readonly probeMipUniforms: UniformRing;
  private readonly probeSampler: GPUSampler;
  /** The camera each face is drawn with. Reused, so a bake allocates nothing. */
  private readonly probeCamera = new Camera();
  /** Whether anything has been rendered into it. The shader must not sample an unfilled cube. */
  /**
   * One flag a layer, because a grid may be baked a probe at a time across frames.
   *
   * **The gate is the whole grid rather than any part of it.** A fragment blending eight corners
   * would read whatever the device left in the layers that have not been filled, and a car
   * mirroring uninitialised memory is worse than a car mirroring a gradient — the rule one probe
   * already had, unchanged by there being more of them.
   */
  private probeFilled = new Uint8Array(1);
  private probeFilledCount = 0;
  /**
   * Whether a bake is running, which is when the cube may be neither sampled nor bound.
   *
   * `renderer.ts` carries the same flag under the same name and for the same reason. Here it is
   * load-bearing rather than defensive: WebGPU rejects a pass that holds the texture it writes.
   */
  private probePassActive = false;

  /** How many mip levels the roughness blur has to work with. `flat.ts` reads this. */
  private get probeMaxLod(): number {
    return ggxMaxLevelFor(this.probeEdge);
  }

  /** Whether every layer of the grid has been convolved. See `probeFilled`. */
  private get probeBaked(): boolean {
    return this.probes !== null && this.probeFilledCount === this.probes.layers;
  }

  /**
   * Record that one layer now holds a convolution, without counting a rebake twice.
   *
   * **And rebuild the flat groups on the last one**, which is the third time this backend has paid
   * for a bind group holding whatever texture existed when it was built. `flatTextures` resolves
   * `uEnvironment` to a one-texel **white** stand-in while `probeBaked` is false, so a grid filled
   * by the trace rather than by `bakeProbeGrid` — which runs before any frame and therefore before
   * any group — leaves every flat group holding that white for the life of the renderer. The
   * uniform beside it flips to "use the grid" and the grid the shader reads is pure white.
   *
   * Measured on `demo/dev/bounce.html?seed=0`: every surface came back at exactly its own albedo
   * times 255, with the sun switched off and the trace pinned to a constant. It had been recorded
   * as undefined memory in the probe array; it is a deliberate white texture, read on purpose.
   * The refraction snapshot's own note two hundred lines below says the same thing about the same
   * mistake, and `setProbeGrid` says it about the array being replaced.
   */
  private markProbeFilled(layer: number): void {
    if (layer < 0 || layer >= this.probeFilled.length) return;
    if (this.probeFilled[layer] === 1) return;
    this.probeFilled[layer] = 1;
    this.probeFilledCount++;
    if (this.probeBaked) this.rebuildFlatGroupsForNewRings();
  }

  /**
   * The array every probe is a layer of, sized for a grid.
   *
   * Separate from the constructor because a grid is declared after it, and the flat bind groups
   * hold whatever texture existed when they were built — which is why the caller rebuilds them.
   */
  private allocateProbeArray(layers: number, device: GPUDevice): void {
    this.probeArray?.destroy();
    this.probeArray = device.createTexture({
      label: 'probe.array',
      size: [this.probeEdge, this.probeEdge, layers],
      format: this.pipelines.format,
      /* Up to and including the irradiance level, and nothing above it. */
      mipLevelCount: irradianceLevelFor(this.probeEdge) + 1,
      usage: 0x10 | 0x4, // RENDER_ATTACHMENT | TEXTURE_BINDING
    });
    this.probeView = this.probeArray.createView({ dimension: '2d-array' });
    this.probeFilled = new Uint8Array(layers);
    this.probeFilledCount = 0;

    /*
     * **Cleared here, because a texture no pass has written holds undefined contents** — the same
     * sentence the directional shadow maps are cleared under, arrived at from the other end.
     *
     * A traced probe reads the array's own irradiance level back as the light that has already
     * bounced, so an unwritten array is not "nothing has bounced yet": it is whatever the
     * allocator left, amplified by every refresh. Measured on `demo/dev/bounce.html` with
     * `?seed=0`, a grid nothing had rasterised settled on a uniform **209 of 255** in every
     * channel, which reads as a working ambient term and is memory.
     *
     * **Every level, not only the one the bake writes.** The roughness chain is sampled by
     * reflective surfaces long before any bake has filled it, and a first fill writes the whole
     * chain only for a layer the scheduler has reached.
     */
    const clear = device.createCommandEncoder({ label: 'probe.clear' });
    const levels = irradianceLevelFor(this.probeEdge) + 1;
    for (let layer = 0; layer < layers; layer += 1) {
      for (let level = 0; level < levels; level += 1) {
        clear
          .beginRenderPass({
            label: 'probe.clear',
            colorAttachments: [
              {
                view: this.probeArray.createView({
                  dimension: '2d',
                  baseArrayLayer: layer,
                  arrayLayerCount: 1,
                  baseMipLevel: level,
                  mipLevelCount: 1,
                }),
                clearValue: { r: 0, g: 0, b: 0, a: 1 },
                loadOp: 'clear',
                storeOp: 'store',
              },
            ],
          })
          .end();
      }
    }
    device.queue.submit([clear.finish()]);
  }

  /**
   * Declare where a grid's probes stand, and allocate the layers for them.
   *
   * **The flat bind groups are rebuilt when the array is replaced**, and that is the trap this
   * backend documents elsewhere: a group is built once and cached, so a texture created later
   * resolves to whatever the group was built with, forever, with no error anywhere.
   */
  setProbeGrid(options: ProbeGridOptions): boolean {
    if (this.surface.lost || !this.probeEnabled) return false;
    const grid = new ProbeGrid(options);
    const current = this.probes;
    if (current !== null && this.probeArray !== null && sameGrid(current, grid)) return true;
    this.probes = grid;
    if (this.probeArray === null || this.probeArray.depthOrArrayLayers !== grid.layers) {
      this.allocateProbeArray(grid.layers, this.surface.device);
      this.rebuildFlatGroupsForNewRings();
    }
    return true;
  }

  /** Bake every probe of the declared grid, in one call. See the other backend's own note. */
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
   * Capture the room into a cubemap, once, so reflective surfaces can mirror it.
   *
   * `drawFace` is handed a camera already aimed and submits the scene exactly as it would to the
   * screen. Six passes, one submission, at the moment a caller says the room is finished — then
   * a cubemap fetch per reflective pixel for ever after.
   *
   * **The chain afterwards is the roughness**, not a nicety: a polished surface samples level 0
   * and a satin one samples further up. WebGPU has no `generateMipmap`, so it is built here by
   * rendering each level from the one above, sampling the cube by direction so the blur crosses
   * face edges instead of seaming along them.
   *
   * Returns whether the bake happened, as `renderer.ts` does: false means a caller carries on
   * with the sky-and-ground gradient `flat.ts` had before probes existed.
   */
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
   * Bake one probe of the declared grid: six faces into the scratch cube, then one convolution.
   *
   * One probe per call, so a grid can be paced across frames. See the other backend's own note on
   * why a bake is the budget question a grid raises rather than the texture units.
   */
  bakeProbe(
    layer: number,
    clearColor: Vec3,
    drawFace: (camera: Camera) => void,
    options?: ProbeBakeOptions,
  ): boolean {
    const probe = this.probe;
    const grid = this.probes;
    if (this.surface.lost || probe === null || grid === null) return false;
    if (layer < 0 || layer >= grid.layers) return false;
    this.probeAmbient = options?.irradiance ?? true;
    grid.positionOf(layer, this.probeOrigin);
    const origin = this.probeOrigin;

    const camera = this.probeCamera;
    camera.position[0] = origin[0] ?? 0;
    camera.position[1] = origin[1] ?? 0;
    camera.position[2] = origin[2] ?? 0;
    camera.fovYDeg = PROBE_FOV_DEG;
    camera.near = PROBE_NEAR_M;
    camera.far = PROBE_FAR_M;
    camera.roll = 0;

    const { device } = this.surface;
    const depth = device.createTexture({
      label: 'probe.depth',
      size: [this.probeSize, this.probeSize],
      format: DEPTH_FORMAT,
      /*
       * **The world's sample count, because a bake draws the world with the world's pipelines.**
       * A pipeline whose count disagrees with its attachment is rejected at `finish` and takes
       * the whole bake with it, and WebGPU requires every attachment in a pass to agree — so a
       * single-sample depth beside a four-sample colour is refused in words that read as a depth
       * problem and are a multisampling one.
       */
      sampleCount: this.samples,
      usage: 0x10, // RENDER_ATTACHMENT
    });
    const depthView = depth.createView();
    /*
     * The multisampled twin the faces are drawn into, resolved into the cube.
     *
     * **A cube face cannot be both multisampled and sampled**, which is the same bind the mirror
     * is in and it is solved the same way: render into this, name the face as `resolveTarget`,
     * and the averaging happens on the way out. One twin for all six faces, because they are
     * drawn one at a time and nothing reads it between them.
     */
    const colorMsaa =
      this.samples > 1
        ? device.createTexture({
            label: 'probe.colorMsaa',
            size: [this.probeSize, this.probeSize],
            format: this.pipelines.format,
            sampleCount: this.samples,
            usage: 0x10, // RENDER_ATTACHMENT
          })
        : null;
    const colorMsaaView = colorMsaa?.createView() ?? null;

    /*
     * The frame's own pass is set aside and restored, because `drawFace` calls straight back into
     * `bindMeshPass` and `drawMesh`, which record into whatever `this.pass` is. That is the same
     * arrangement `bakeFace` uses for a point light's cube, and it is why a bake must not be
     * opened inside a frame's pass by a caller who then expects the frame to continue.
     */
    const savedPass = this.pass;
    /*
     * **A bake is a boundary, and boundaries flush.** The mirror says why in its own words: what
     * has been recorded and not yet replayed belongs to the pass that is about to end, and leaving
     * it replays it into whichever pass opens next — a draw in the wrong target rather than a
     * missing one. This is the fourth such boundary in the backend and the only one that was never
     * given the treatment, which is what let a bake carry the frame's pending draws into a cube
     * face.
     */
    if (this.quality.frameGraph) this.flushGraph();
    const savedEncoder = this.encoder;
    const encoder = device.createCommandEncoder({ label: 'probe' });
    this.encoder = encoder;
    /*
     * Fenced before the first face and released after the last, with the group rebuilt on both
     * edges so the cube is not bound while it is being written. Two `createBindGroup` calls per
     * bake, which is not a frame path: a bake is six passes and a mip chain, asked for by a
     * scene at a moment of its choosing.
     */
    this.probePassActive = true;
    this.rebuildFlatBindGroup();
    /*
     * **A probe stores radiance, not display pixels.** See `renderer.ts` for the whole argument:
     * baking through the output transform crushes every highlight with the tone curve before it
     * reaches the cube and lifts the mid-tones with the sRGB encode, and the frame then applies
     * the same transform a second time to a value that already carries it.
     */
    const heldGrade = this.perFrameInts[this.materialField('uOutputTransform')] ?? 0;
    const heldExposure = this.perFrameFloats[this.materialField('uOutputExposure')] ?? 1;
    this.perFrameInts[this.materialField('uOutputTransform')] = 0;
    this.perFrameFloats[this.materialField('uOutputExposure')] = 1;
    this.materials.dirty();

    for (let face = 0; face < PROBE_FACES.length; face++) {
      const aim = PROBE_FACES[face];
      if (aim === undefined) continue;
      camera.yaw = aim.yaw;
      camera.pitch = aim.pitch;
      /*
       * Square, so the aspect is 1. Handing the drawing buffer's aspect in here stretches every
       * face and shows up as a reflection that slides at the wrong rate across a curved surface.
       */
      camera.updateMatrices(1);

      const faceView = probe.createView({
        dimension: '2d',
        baseArrayLayer: face,
        arrayLayerCount: 1,
        baseMipLevel: 0,
        mipLevelCount: 1,
      });
      this.pass = encoder.beginRenderPass({
        label: `probe.face${face}`,
        colorAttachments: [
          {
            /* The twin where there is one, and the face itself at a single sample. Same shape
               as the mirror's pass and the frame's own. */
            view: colorMsaaView ?? faceView,
            resolveTarget: colorMsaaView === null ? undefined : faceView,
            loadOp: 'clear',
            storeOp: resolvedStoreOp(
              colorMsaaView !== null,
              true,
              this.quality.discardResolvedAttachments,
            ),
            clearValue: {
              r: clearColor[0] ?? 0,
              g: clearColor[1] ?? 0,
              b: clearColor[2] ?? 0,
              a: 1,
            },
          },
        ],
        depthStencilAttachment: {
          view: depthView,
          depthClearValue: DEPTH_CLEAR,
          depthLoadOp: 'clear',
          depthStoreOp: 'store',
        },
      });
      drawFace(camera);
      /*
       * **And the face's own draws are replayed before its pass ends**, which is the whole of a
       * bug that made `frameGraph` bake an empty cube.
       *
       * `drawFace` is the consumer's, and every verb it calls *records* while the graph is on. Not
       * one of those draws reached the face — measured: six draws with the graph off, zero with it
       * on — so the probe stored the clear colour and nothing else, and a scene with a mirror
       * reflected an empty room while reporting no error at all. The six recorded nodes then
       * outlived the bake and were replayed into whatever pass opened next, carrying pipelines
       * built for a four-sample target into a one-sample one.
       *
       * `openPass` returns the pass already open, so the replay lands in this face and not in a
       * pass of its own.
       */
      if (this.quality.frameGraph) this.flushGraph();
      this.pass.end();
    }
    this.pass = null;
    this.buildProbeChain(encoder, probe, layer);
    this.flushRings();
    device.queue.submit([encoder.finish()]);
    depth.destroy();
    colorMsaa?.destroy();

    this.encoder = savedEncoder;
    this.pass = savedPass;
    this.markProbeFilled(layer);
    this.perFrameInts[this.materialField('uOutputTransform')] = heldGrade;
    this.perFrameFloats[this.materialField('uOutputExposure')] = heldExposure;
    this.materials.dirty();
    this.probePassActive = false;
    this.rebuildFlatBindGroup();
    return true;
  }

  /**
   * The room's diffuse light, projected once — started here and deliberately not awaited.
   *
   * **The caller is drawing a frame around this call**, and where a bake sits inside a frame is the
   * scene's decision rather than this backend's, so `bakeReflectionProbe` cannot become
   * asynchronous to hide the fact that this is. `uEnvIrradianceEnabled` stays 0 until the promise
   * resolves, a frame or two later, and until then the picture is exactly what it was.
   *
   * **A refusal is not a failed bake.** The reflection is already in the cube and is unaffected, so
   * this is a missing improvement rather than a fault, and it says so once: a device that refuses
   * one readback refuses every one and a warning per scene is a flood.
   */
  /**
   * Light the scene from an environment it did not photograph.
   *
   * **Downstream of the cube this is exactly a bake**, which is the design rather than a
   * convenience: the faces are written into the same texture a bake fills, `buildProbeChain` runs
   * the same box chain and the same convolution over them, and `projectProbeIrradiance` reads them
   * back the same way. A loaded sky is therefore not a second lighting path that can be wrong on
   * its own.
   *
   * **Its own encoder, submitted here.** A bake has a frame's encoder to borrow; this can be
   * called before `beginFrame` has opened one, and recording into a null encoder is the shape of
   * defect `beginPlanarReflection` already paid for — it answered null before a frame existed and
   * a consumer read that as "no target" on every frame.
   */
  setEnvironmentImage(
    image: {
      readonly width: number;
      readonly height: number;
      readonly data: Float32Array;
    },
    options?: ProbeBakeOptions,
  ): boolean {
    const probe = this.probe;
    if (this.surface.lost) return false;
    if (probe === null) {
      console.warn(
        'WebGpuRenderer: setEnvironmentImage was called on a profile with no reflection probe, so ' +
          'the environment was ignored. Set `reflectionProbeSize` to allocate one.',
      );
      return false;
    }

    const { device } = this.surface;
    if (!this.setProbeGrid({ origin: WORLD_ORIGIN, spacing: UNIT_STEP, counts: SINGLE_PROBE })) {
      return false;
    }
    const faces = equirectToCubeFaces(image, this.probeSize);
    const format = this.pipelines.format;
    for (let face = 0; face < faces.length; face++) {
      const pixels = faces[face];
      if (pixels === undefined) continue;
      /*
       * **Converted to the cube's own format first, and this is not `writeTexture` being helpful.**
       *
       * `writeTexture` does not convert. Its `bytesPerRow` describes the *source* stride, and it
       * reads `width * bytesPerTexel-of-the-destination` bytes out of each row — so handing it
       * float data for an eight-bit cube is a perfectly legal layout that reinterprets the raw
       * bytes of the floats as unorm bytes. **Nothing raises anything**: no validation error, no
       * device message, and a cube full of a plausible-looking dark environment.
       *
       * Measured on `demo/dev/ibl.html?env=` with a uniform sky: WebGL2 read 81 of 255 and this
       * backend read 45.7 for the same file. The two backends being a control for each other is
       * the only thing that found it — one of them alone looks entirely reasonable.
       *
       * The cube takes the *scene* colour format rather than a format of its own, for the reason
       * its allocation gives: a bake draws the world into these faces with the world's own
       * pipelines. So this has to answer for every format that can be.
       */
      const converted = environmentTexels(pixels, format);
      device.queue.writeTexture(
        { texture: probe, mipLevel: 0, origin: { x: 0, y: 0, z: face } },
        converted.data,
        { bytesPerRow: this.probeSize * converted.bytesPerTexel, rowsPerImage: this.probeSize },
        { width: this.probeSize, height: this.probeSize, depthOrArrayLayers: 1 },
      );
    }

    const encoder = device.createCommandEncoder({ label: 'probe.environmentImage' });
    this.buildProbeChain(encoder, probe, 0);
    device.queue.submit([encoder.finish()]);

    this.markProbeFilled(0);
    this.probeAmbient = options?.irradiance ?? true;
    this.rebuildFlatBindGroup();
    return true;
  }

  /**
   * Upload the photometric profiles a consumer loaded, and rebuild the bind group that holds them.
   *
   * **Once per set rather than per frame**, because a fixture's distribution is an asset and does
   * not change while the game runs. Passing an empty list clears them back to the single row of
   * ones, which is the multiplicative identity — a scene that drops its profiles goes back to
   * plain lights rather than going black.
   */
  /**
   * Upload the cookies a consumer loaded, and bind the atlas.
   *
   * The same contract `Renderer.setSpotCookies` states: one row of square tiles, `COOKIE_TILE` a
   * side, an empty list clearing back to the white texel that is the multiplicative identity.
   *
   * **`copyExternalImageToTexture` per tile**, which is what puts a decoded image on the device
   * here — the same call `createSurfaceTexture` makes, and it takes a destination origin, so one
   * call a tile fills the row without a canvas in between.
   */
  setSpotCookies(images: readonly TexImageSource[]): void {
    if (this.surface.lost) return;
    const { device } = this.surface;
    const tiles = images.length;
    const width = tiles === 0 ? 1 : COOKIE_TILE * tiles;
    const height = tiles === 0 ? 1 : COOKIE_TILE;
    if (this.cookieTexture === null || this.cookieTexture.width !== width) {
      this.cookieTexture?.destroy();
      this.cookieTexture = device.createTexture({
        label: 'cookie.atlas',
        size: [width, height],
        format: 'rgba8unorm',
        /* `RENDER_ATTACHMENT` because `copyExternalImageToTexture` writes through one. */
        usage: 0x4 | 0x2 | 0x10,
      });
      this.cookieView = this.cookieTexture.createView();
    }
    if (tiles === 0) {
      /* White, not black: this multiplies a light's colour. */
      device.queue.writeTexture(
        { texture: this.cookieTexture },
        new Uint8Array([255, 255, 255, 255]),
        { bytesPerRow: 4, rowsPerImage: 1 },
        { width: 1, height: 1, depthOrArrayLayers: 1 },
      );
    } else {
      for (let tile = 0; tile < tiles; tile++) {
        const source = images[tile];
        if (source === undefined) continue;
        device.queue.copyExternalImageToTexture(
          { source: source as GPUCopyExternalImageSource },
          { texture: this.cookieTexture, origin: { x: tile * COOKIE_TILE, y: 0 } },
          { width: COOKIE_TILE, height: COOKIE_TILE },
        );
      }
    }
    this.cookieTiles = tiles;
    this.rebuildFlatBindGroup();
  }

  setIesProfiles(profiles: readonly PhotometricProfile[]): void {
    if (this.surface.lost) return;
    const { device } = this.surface;
    const atlas = packIesAtlas(profiles);
    /*
     * Reallocated when the row count changes, because a texture's size is immutable. A set of the
     * same size overwrites in place, which is the common case of a consumer swapping one fixture.
     */
    if (this.iesTexture === null || this.iesTexture.height !== atlas.height) {
      this.iesTexture?.destroy();
      this.iesTexture = device.createTexture({
        label: 'ies.atlas',
        size: [atlas.width, atlas.height],
        /*
         * **`r16float`, not `r32float`, and that is a filtering constraint rather than a size
         * choice.** A 32-bit float texture is not filterable in core WebGPU — it needs the
         * optional `float32-filterable` feature — and binding one to a filtering sampler is a
         * validation failure that takes the whole bind group with it. This row *wants* linear
         * filtering: it is a curve sampled between two angles, which is the entire reason it is
         * not `NEAREST` like the froxel table beside it.
         *
         * Half precision holds a normalised intensity to about three decimal digits, which is far
         * finer than the eight-bit frame it ends up in. **What would make it wrong** is a profile
         * carrying absolute candela rather than a normalised curve, which would run out of range —
         * and `packIesAtlas` normalises for its own reasons.
         */
        format: 'r16float',
        usage: 0x4 | 0x2, // TEXTURE_BINDING | COPY_DST
      });
      this.iesView = this.iesTexture.createView();
    }
    device.queue.writeTexture(
      { texture: this.iesTexture },
      /* Converted, because `writeTexture` does not — see `environmentTexels` for what handing it
         the wrong width silently produces. */
      toHalfFloats(atlas.data),
      { bytesPerRow: atlas.width * 2, rowsPerImage: atlas.height },
      { width: atlas.width, height: atlas.height, depthOrArrayLayers: 1 },
    );
    this.iesRows = atlas.height;
    this.iesPlanes = atlas.planes;
    this.rebuildFlatBindGroup();
  }

  /** Each level from the one above it, six faces at a time. See `probePass.ts`. */
  private buildProbeChain(encoder: GPUCommandEncoder, probe: GPUTexture, layer: number): void {
    const { device } = this.surface;
    /*
     * **Reset and flushed here, because a bake is not a frame.**
     *
     * This ring is the only one not in `flushRings` or in the reset `beginFrame` does, and for a
     * while it was in neither — so the blur's uniforms were written into staging and never
     * uploaded, and every fragment read a buffer of zeros. That gives `normalize(vec3(0))` for
     * the direction a texel stands for, which is undefined, and the whole chain came back as one
     * constant on all six faces: measured at 0.0213 for every face of every level above zero,
     * against a level 0 that was correct.
     *
     * **The picture that produces is a metal reflecting a single flat colour**, which is
     * indistinguishable from matte paint and was reported exactly that way, twice, while the
     * other backend was fine. Level 0 being right is what made it invisible to a check that
     * looked at the bake: the bake was never the problem.
     *
     * Reset as well as flushed, because nothing else resets it: without that a second bake found
     * the ring full, `allocate` answered null, and the chain was skipped in silence.
     */
    this.probeMipUniforms.reset();
    /* The cube's own format, which is the world's. See where it is allocated. */
    const pipeline = probeMipPipeline(
      this.pipelines,
      device,
      this.probeMipLayout,
      this.pipelines.format,
    );
    const levels = probeLevels(this.probeSize);
    for (let level = 1; level < levels; level++) {
      /* A view of the whole cube at the level above, so the blur can cross a face edge. */
      const source = probe.createView({
        dimension: 'cube',
        baseMipLevel: level - 1,
        mipLevelCount: 1,
      });
      for (let face = 0; face < PROBE_FACE_BASIS.length; face++) {
        const basis = PROBE_FACE_BASIS[face];
        if (basis === undefined) continue;
        const slot = this.probeMipUniforms.allocate();
        if (slot === null) {
          /* Sized from the probe's own level count, so this cannot happen without the ring or
             the cube changing. It says so rather than returning quietly: a chain that stops
             part way is a roughness that stops working above some value, which reads as one
             material being wrong rather than as a missing pass. */
          console.warn(
            `WebGpuRenderer: the probe blur ran out of uniform slots at level ${level}, so a ` +
              'rough reflection samples an unfilled level. Nothing else is affected.',
          );
          this.probeMipUniforms.flush();
          return;
        }
        this.probeMipUniforms.writeFloats(slot, 0, [...basis.basisX, 0]);
        this.probeMipUniforms.writeFloats(slot, 16, [...basis.basisY, 0]);
        this.probeMipUniforms.writeFloats(slot, 32, [...basis.forward, 0]);
        this.probeMipUniforms.writeFloats(slot, 48, [0, 0, 0, 0]);

        const pass = encoder.beginRenderPass({
          label: `probe.mip${level}.face${face}`,
          colorAttachments: [
            {
              view: probe.createView({
                dimension: '2d',
                baseArrayLayer: face,
                arrayLayerCount: 1,
                baseMipLevel: level,
                mipLevelCount: 1,
              }),
              loadOp: 'clear',
              storeOp: 'store',
              clearValue: { r: 0, g: 0, b: 0, a: 1 },
            },
          ],
        });
        pass.setPipeline(pipeline);
        pass.setBindGroup(
          0,
          device.createBindGroup({
            layout: this.probeMipLayout,
            entries: [
              {
                binding: 0,
                resource: { buffer: this.probeMipUniforms.buffer, size: PROBE_MIP_UNIFORM_SIZE },
              },
              { binding: 1, resource: source },
              { binding: 2, resource: this.probeSampler },
            ],
          }),
          [slot],
        );
        pass.draw(3);
        pass.end();
      }
    }
    /*
     * And now the convolution, from the box chain above into the cube the lit pass reads.
     *
     * **Two passes rather than one, and the box chain is not waste.** Filtered importance
     * sampling needs a chain to select a level from: a sample much wider than a texel that reads
     * the base level lets a few bright texels land in some samples and not others, and that
     * variance survives the average as fireflies. So the cheap chain is what makes the expensive
     * one quiet, and it is also what the irradiance projection reads.
     *
     * **Every level including the base**, because the shader takes roughness 0 as a direct fetch
     * rather than as a sum — a delta distribution collapses every sample onto one direction and
     * would leave level 0 noisier than the capture it came from.
     */
    const prefilterTarget = this.probeArray;
    if (prefilterTarget !== null) {
      const prefilter = probePrefilterPipeline(
        this.pipelines,
        device,
        this.probePrefilterLayout,
        this.pipelines.format,
      );
      /* The whole chain, so a wide sample can select a level from it. */
      const source = probe.createView({ dimension: 'cube' });
      const offsets = PREFILTER_UNIFORM_OFFSETS;
      const topLevel = levels - 1;
      const samples = this.quality.environmentPrefilterSamples;
      const edge = this.probeEdge;
      const irradianceLevel = irradianceLevelFor(edge);
      const ggxTop = ggxMaxLevelFor(edge);
      const boxChain = !this.quality.environmentPrefilter;

      /*
       * **One draw a level, where the cube needed six.** An octahedral map has no faces, so the
       * six-way loop is gone rather than moved, and a probe's convolution is six times fewer
       * passes than the cube it replaces.
       */
      for (let level = 0; level <= irradianceLevel; level++) {
        const irradiance = level === irradianceLevel;
        const roughness = irradiance ? 1 : roughnessForLevel(level, ggxTop);
        const slot = this.probeMipUniforms.allocate();
        if (slot === null) {
          /* Loud rather than partial, exactly as the chain above is: a convolution that stops
             part way is a roughness that stops working above some value, which reads as one
             material being wrong rather than as a missing pass. */
          console.warn(
            `WebGpuRenderer: the environment prefilter ran out of uniform slots at level ` +
              `${level}, so a rough reflection samples an unconvolved level. Nothing else is ` +
              'affected.',
          );
          this.probeMipUniforms.flush();
          return;
        }
        /* Written at the generator's own offsets rather than at literals, because a roughness at
           the wrong offset is a level convolved for some other roughness — which looks like a
           plausible reflection and points at nothing. */
        this.probeMipUniforms.writeFloats(slot, offsets.uPrefilterEdge.offset, [
          Math.max(1, edge >> level),
        ]);
        this.probeMipUniforms.writeFloats(slot, offsets.uPrefilterIrradiance.offset, [
          irradiance ? 1 : 0,
        ]);
        this.probeMipUniforms.writeFloats(slot, offsets.uPrefilterBox.offset, [boxChain ? 1 : 0]);
        this.probeMipUniforms.writeFloats(slot, offsets.uPrefilterLevel.offset, [level]);
        this.probeMipUniforms.writeFloats(slot, offsets.uPrefilterRoughness.offset, [roughness]);
        this.probeMipUniforms.writeFloats(slot, offsets.uPrefilterSamples.offset, [samples]);
        this.probeMipUniforms.writeFloats(slot, offsets.uPrefilterSourceTexels.offset, [
          this.probeSize,
        ]);
        this.probeMipUniforms.writeFloats(slot, offsets.uPrefilterSourceMaxLod.offset, [topLevel]);

        const pass = encoder.beginRenderPass({
          label: `probe.prefilter${level}.layer${layer}`,
          colorAttachments: [
            {
              view: prefilterTarget.createView({
                dimension: '2d',
                baseArrayLayer: layer,
                arrayLayerCount: 1,
                baseMipLevel: level,
                mipLevelCount: 1,
              }),
              loadOp: 'clear',
              storeOp: 'store',
              clearValue: { r: 0, g: 0, b: 0, a: 1 },
            },
          ],
        });
        pass.setPipeline(prefilter);
        pass.setBindGroup(
          0,
          device.createBindGroup({
            layout: this.probePrefilterLayout,
            entries: [
              {
                binding: PREFILTER_UNIFORM_BINDING,
                resource: { buffer: this.probeMipUniforms.buffer, size: PROBE_MIP_UNIFORM_SIZE },
              },
              { binding: PREFILTER_TEXTURE_BINDING, resource: source },
              { binding: PREFILTER_SAMPLER_BINDING, resource: this.probeSampler },
            ],
          }),
          [slot],
        );
        pass.draw(3);
        pass.end();
      }
    }

    /* Before the caller submits, so the writes land on the queue ahead of the passes above. */
    this.probeMipUniforms.flush();
  }

  /**
   * Allocate the mirror at the size the frame is about to be, and rebind the water to it.
   *
   * **From `resize` rather than from the first frame that shows water**, which is the reason
   * `planarReflection.ts` gives on the other side: allocated lazily it lands in whichever frame
   * first puts water on screen, measured there as 28% of a 62 ms frame — a stall in the middle
   * of play rather than during a load.
   *
   * Rebuilding the water bind group is not optional. A bind group holds a *view*, and a resized
   * target is a different texture; keeping the old group would sample a destroyed one.
   */
  /**
   * The composite's targets, sized with the drawing buffer.
   *
   * Allocated from `resize` rather than from the first frame that needs one, which is the
   * argument `planarReflection.ts` makes and the same cost: a full-size colour target paid for
   * in the middle of play is a stall a player feels, and paid here it lands where the rest of
   * the frame's memory is paid.
   *
   * The occlusion and bloom targets are half size. Both are blurs read back at full size, so a
   * full-resolution intermediate buys nothing a bilinear fetch does not already give.
   */
  private ensureComposite(width: number, height: number): void {
    if (!this.hasComposite) return;
    if (this.sceneColor !== null && this.frameWidth === width && this.frameHeight === height)
      return;
    const { device } = this.surface;
    this.frameWidth = width;
    this.frameHeight = height;
    for (const dead of [
      this.sceneColor,
      this.sceneColorMsaa,
      this.refractSnapshot,
      this.resolvedDepth,
      this.aoTarget,
      this.aoScratch,
    ]) {
      dead?.destroy();
    }
    for (const dead of this.bloomLevels) dead.texture.destroy();
    const USAGE = 0x10 | 0x4; // RENDER_ATTACHMENT | TEXTURE_BINDING
    /* Read off the cache rather than computed again here. `sceneColorFormat` is called once, at
       construction, and a second call is a second chance to disagree with the pipelines. */
    const format = this.pipelines.format;
    this.sceneColor = device.createTexture({
      label: 'post.sceneColor',
      size: [width, height],
      format,
      /* `COPY_DST` because the temporal resolve copies its result back over this, so that bloom,
         occlusion and the composite read the resolved picture without a second bind group each.
         See `temporalResolve`. **`COPY_SRC` because refraction copies it out**: a shader may not
         sample the texture the pass is resolving into, so `takeRefractSnapshot` takes it aside. */
      usage: USAGE | 0x2 | 0x1,
    });
    this.sceneColorView = this.sceneColor.createView();
    this.sceneColorMsaa =
      this.samples > 1
        ? device.createTexture({
            label: 'post.sceneColorMsaa',
            size: [width, height],
            format,
            sampleCount: this.samples,
            usage: 0x10,
          })
        : null;
    this.sceneColorMsaaView = this.sceneColorMsaa?.createView() ?? null;
    /*
     * The refraction snapshot: `post.sceneColor`'s format exactly, because `copyTextureToTexture`
     * requires it, and `COPY_DST` because that is what receives the copy.
     *
     * Allocated with the rest of the frame's targets rather than at the first refracting draw, for
     * the reason `registerPass` gives about its own `init`: creating a texture in the frame loop is
     * the allocation the house rules are about. A frame that never refracts pays the memory and
     * takes no copy.
     */
    this.refractSnapshot = device.createTexture({
      label: 'refract.snapshot',
      size: [width, height],
      format,
      usage: 0x4 | 0x2,
    });
    this.refractSnapshotView = this.refractSnapshot.createView();
    /*
     * **Every cached flat bind group is stale the moment this view changes**, and the failure is
     * silent: `flatTextures` resolves `uRefractScene` to the one-texel white stand-in when there is
     * no snapshot, and a group built at construction holds that stand-in for the life of the
     * renderer. A refracting draw then reads pure white, so every pane in the frame is a white
     * rectangle — a plausible picture, on a backend with no validation error to raise, while
     * WebGL2 refracts correctly beside it.
     *
     * Found exactly that way: this row's own check measured 255,255,255 on WebGPU against 108.9 on
     * WebGL2, with `none` and `off` agreeing to a tenth on both.
     */
    this.rebuildFlatGroupsForNewRings();
    this.resolvedDepth = device.createTexture({
      label: 'post.resolvedDepth',
      size: [width, height],
      format: RESOLVED_DEPTH_FORMAT,
      /*
       * **`COPY_SRC` only where a reconstruction is going to keep it**, because a usage is a
       * promise about the whole life of the texture and every frame that does not reconstruct
       * would be paying for one it never makes. A reconstruction copies this into its own target
       * at the end of the frame, which is what its disocclusion tests against next frame.
       */
      usage: this.quality.reconstruction > 0 ? USAGE | 0x1 : USAGE,
    });
    this.resolvedDepthView = this.resolvedDepth.createView();
    /*
     * **The occlusion estimate at the frame's own size, matching the other backend.**
     *
     * It was half each way, undocumented, and it is the whole of why the same setting looked
     * softer here than on WebGL2 for the same scene on the same machine — reported as contact
     * shading that is "fuzzy, not seamless and smooth". Halving it is not a free saving on this
     * effect the way it is on bloom: `ambientOcclusion.ts` builds the estimate and its blur as
     * one design, twelve taps turned by a rotation that repeats over a 4x4 *pixel* tile and a
     * four-*pixel* blur that averages all sixteen back. At half size that tile is four frame
     * pixels wide, so every structure the pass leaves behind — its noise, and the fringe along
     * every silhouette — arrives on screen at twice the size, through a bilinear upsample that
     * softens the join without removing the structure.
     *
     * The cost is real and is the same cost the other backend has always paid: measured there
     * at 0.18 ms over 1.46 MP. A part that cannot afford it has the switch the profile already
     * exposes, which is a better answer than a quieter effect nobody chose.
     */
    this.aoTarget = device.createTexture({
      label: 'post.ao',
      size: [width, height],
      format: 'r8unorm',
      usage: USAGE,
    });
    this.aoTargetView = this.aoTarget.createView();
    /* Where the first axis lands. Same size and format as the estimate, because the second axis
       reads it back and writes into the estimate again. */
    this.aoScratch = device.createTexture({
      label: 'post.aoScratch',
      size: [width, height],
      format: 'r8unorm',
      usage: USAGE,
    });
    this.aoScratchView = this.aoScratch.createView();

    /*
     * The medium's march target, at the size the profile asks for — half the frame each way by
     * default, which is a quarter of the march.
     *
     * **Allocated with the rest of the frame's targets and not at the first foggy frame**, for the
     * reason `refractSnapshot` above gives: creating a texture inside the frame loop is exactly the
     * allocation the house rules are about. A frame that never sets a density pays this memory and
     * runs no pass; a profile with `globalMediumSteps` at 0 does not reach here at all, because
     * nothing below is built when the ceiling is zero.
     */
    this.mediumTarget?.destroy();
    if (this.quality.globalMediumSteps > 0) {
      const size = mediumTargetSize(width, height, this.quality.globalMediumHalfResolution);
      this.mediumTarget = device.createTexture({
        label: 'post.medium',
        size: [size.width, size.height],
        format: 'rgba16float',
        usage: USAGE,
      });
      this.mediumTargetView = this.mediumTarget.createView();
    } else {
      this.mediumTarget = null;
      this.mediumTargetView = null;
    }

    /*
     * The resolve's pair, at the scene's own size and format.
     *
     * **Matched to `format` and not to something cheaper**: a half-float scene resolved through an
     * eight-bit history would be squashed into 0 to 1 on the way in and read back squashed, so the
     * accumulation would pull every value above white down over eight frames and a bloom threshold
     * would stop meaning brightness.
     *
     * Two of them because a pass cannot read the texture it writes: the history is sampled at a
     * reprojected coordinate, which is somewhere else in the same image.
     */
    for (let i = 0; i < 2; i++) {
      this.taaTextures[i]?.destroy();
      const texture = device.createTexture({
        label: `post.taa${i}`,
        size: [width, height],
        format,
        /* `COPY_SRC` for the copy back over the scene; see `temporalResolve`. */
        usage: USAGE | 0x1,
      });
      this.taaTextures[i] = texture;
      this.taaViews[i] = texture.createView();
    }
    this.taaWrite = 0;
    /* A resized target is a new texture, so whatever the history held is gone. */
    this.temporalHistory.invalidate();

    /*
     * The order-independent pair.
     *
     * **`rgba16float` for the accumulation and it has to be**: it holds a *sum* of colour times a
     * weight that reaches three thousand, so eight bits of it is white everywhere after one bright
     * layer. `r8unorm` for the revealage, which holds a product of values in 0..1 and never leaves
     * that range — a step of 1/255 in how much scene shows through, below what a viewer can see
     * against a blended surface.
     */
    this.oitAccum?.destroy();
    this.oitAccum = device.createTexture({
      label: 'post.oitAccum',
      size: [width, height],
      format: 'rgba16float',
      usage: USAGE,
    });
    this.oitAccumView = this.oitAccum.createView();
    this.oitReveal?.destroy();
    this.oitReveal = device.createTexture({
      label: 'post.oitReveal',
      size: [width, height],
      format: 'r8unorm',
      usage: USAGE,
    });
    this.oitRevealView = this.oitReveal.createView();

    /*
     * The pyramid, from the shape both backends agree on. Level 0 is half the frame — a blur read
     * back at full size, so a full-resolution intermediate buys nothing a bilinear fetch does not
     * already give — and each level after it is half again.
     *
     * An empty list is a real answer for a frame too small to hold one, and `runBloom` reads it
     * as no bloom rather than as a target it should have had.
     */
    this.bloomLevels = bloomLevelSizes(width, height).map((size, index) => {
      const texture = device.createTexture({
        label: `post.bloom${index}`,
        size: [size.width, size.height],
        format,
        usage: USAGE,
      });
      return { texture, view: texture.createView(), width: size.width, height: size.height };
    });

    /*
     * The groups hold *views*, and a resized target is a different texture — so these are
     * rebuilt here rather than once, for the reason `ensureReflection` gives about the water:
     * keeping the old group would sample a destroyed texture.
     */
    const entry = (
      b: { texture: number; sampler: number },
      view: GPUTextureView,
      depth = false,
    ) => [
      { binding: b.texture, resource: view },
      { binding: b.sampler, resource: depth ? this.postDepthSampler : this.postSampler },
    ];
    this.rebuildRushBindGroup();
    this.oitResolveGroup =
      this.oitAccumView === null || this.oitRevealView === null
        ? null
        : device.createBindGroup({
            label: 'post.oitResolveGroup',
            layout: this.oitResolveLayout,
            entries: [
              ...entry(OIT_TEXTURES.uOitAccum, this.oitAccumView),
              ...entry(OIT_TEXTURES.uOitReveal, this.oitRevealView),
            ],
          });
    /*
     * The reflection buffer, in the scene's own format.
     *
     * A half-float scene composited through an eight-bit reflection would clip every highlight the
     * reflection carries, which is exactly the part of a scene that shows in a wet floor.
     */
    this.ssrReflection?.destroy();
    this.ssrReflection = device.createTexture({
      label: 'post.ssrReflection',
      size: [width, height],
      format,
      usage: USAGE,
    });
    this.ssrReflectionView = this.ssrReflection.createView();
    this.ssrBindGroup =
      this.resolvedDepthView === null || this.sceneColorView === null
        ? null
        : device.createBindGroup({
            label: 'post.ssrBindGroup',
            layout: this.ssrLayout,
            entries: [
              {
                binding: SSR_UNIFORMS,
                resource: { buffer: this.ssrUniforms, size: SSR_FRAG_SIZE },
              },
              ...entry(SSR_TEXTURES.uSsrDepth, this.resolvedDepthView, true),
              ...entry(SSR_TEXTURES.uSsrScene, this.sceneColorView),
            ],
          });
    this.ssrResolveGroup = device.createBindGroup({
      label: 'post.ssrResolveGroup',
      layout: this.ssrResolveLayout,
      entries: [...entry(SSR_RESOLVE_TEXTURES.uSsrReflection, this.ssrReflectionView)],
    });
    this.decalBindGroup =
      this.resolvedDepthView === null
        ? null
        : device.createBindGroup({
            label: 'post.decalBindGroup',
            layout: this.decalLayout,
            entries: [
              {
                binding: DECAL_UNIFORMS,
                resource: { buffer: this.decalUniforms, size: DECAL_FRAG_SIZE },
              },
              ...entry(DECAL_TEXTURES.uDecalDepth, this.resolvedDepthView, true),
            ],
          });
    this.aoBindGroup = device.createBindGroup({
      label: 'post.aoBindGroup',
      layout: this.aoLayout,
      entries: [
        { binding: AO_UNIFORMS, resource: { buffer: this.aoUniforms, size: AO_FRAG_SIZE } },
        ...entry(AO_TEXTURES.uDepth, this.resolvedDepthView, true),
      ],
    });
    /*
     * The medium's two groups, holding the shadow views the march reads.
     *
     * **The stand-in has to read as unoccluded and not as absent**, which is `emptyTexture.ts`'s
     * point and `createLightVolumeBindGroup`'s: the dynamic layer is sampled unconditionally, and
     * `occlusion()` calls any stored depth below the receiver's a blocker — so a black stand-in
     * would put the whole medium in shadow, which is a picture rather than an error. `volumeBlank`
     * is the white one-texel texture already built for exactly this.
     */
    const shadowPair = (
      b: { texture: number; sampler: number },
      view: GPUTextureView | null,
    ): GPUBindGroupEntry[] => [
      { binding: b.texture, resource: view ?? this.volumeBlank.view },
      {
        binding: b.sampler,
        resource: view === null ? this.volumeBlank.sampler : this.volumeShadowSampler,
      },
    ];
    this.mediumBindGroup =
      this.resolvedDepthView === null
        ? null
        : device.createBindGroup({
            label: 'post.mediumBindGroup',
            layout: this.mediumLayout,
            entries: [
              {
                binding: MEDIUM_UNIFORMS,
                resource: { buffer: this.mediumUniforms, size: MEDIUM_FRAG_SIZE },
              },
              ...entry(MEDIUM_TEXTURES.uDepth, this.resolvedDepthView, true),
              ...shadowPair(MEDIUM_TEXTURES.uStaticShadowMap, this.shadowView),
              ...shadowPair(MEDIUM_TEXTURES.uPeeledShadowMap, this.peelView),
              ...shadowPair(MEDIUM_TEXTURES.uDynamicShadowMap, this.dynamicView),
            ],
          });
    this.mediumUpsampleGroup =
      this.resolvedDepthView === null || this.mediumTargetView === null
        ? null
        : device.createBindGroup({
            label: 'post.mediumUpsampleGroup',
            layout: this.mediumUpsampleLayout,
            entries: [
              {
                binding: MEDIUM_UPSAMPLE_UNIFORMS,
                resource: {
                  buffer: this.mediumUpsampleUniforms,
                  size: MEDIUM_UPSAMPLE_SIZE,
                },
              },
              ...entry(MEDIUM_UPSAMPLE_TEXTURES.uMedium, this.mediumTargetView, true),
              ...entry(MEDIUM_UPSAMPLE_TEXTURES.uDepth, this.resolvedDepthView, true),
            ],
          });
    /*
     * One group per history, and the composite's own group per resolved source.
     *
     * A bind group holds the *view* it was built with, so a ping-pong cannot swap a view inside
     * one group — and `AGENTS.md` forbids allocating in the frame loop, so they cannot be built
     * per frame either. Four small groups built here is what those two rules leave, and it is the
     * arrangement `blurGroup` below already uses for the occlusion's two directions.
     */
    for (let i = 0; i < 2; i++) {
      const scene = this.sceneColorView;
      const history = this.taaViews[i];
      const resolved = this.taaViews[1 - i];
      if (scene === null || history === null || resolved === null) continue;
      this.taaBindGroups[i] = device.createBindGroup({
        label: `post.taaBindGroup${i}`,
        layout: this.taaLayout,
        entries: [
          { binding: TAA_UNIFORMS, resource: { buffer: this.taaUniforms, size: TAA_FRAG_SIZE } },
          ...entry(TAA_TEXTURES.uScene, scene),
          ...entry(TAA_TEXTURES.uHistory, history),
          ...entry(TAA_TEXTURES.uDepth, this.resolvedDepthView, true),
        ],
      });
    }
    this.rebuildRushBindGroup();
    /*
     * The blur's two directions, as two groups differing only in which target they read.
     *
     * They cannot be one group with a swapped view: a bind group holds the view it was built
     * with. And they cannot be built per frame — `AGENTS.md` forbids allocating in the frame
     * loop — so they are built here with the targets they read, like `bloomGroups`.
     */
    const depthView = this.resolvedDepthView;
    const blurGroup = (label: string, source: GPUTextureView): GPUBindGroup =>
      device.createBindGroup({
        label,
        layout: this.aoBlurLayout,
        entries: [
          {
            binding: AO_BLUR_UNIFORMS,
            resource: { buffer: this.aoBlurUniforms, size: AO_BLUR_SIZE },
          },
          ...entry(AO_BLUR_TEXTURES.uAo, source),
          ...entry(AO_BLUR_TEXTURES.uDepth, depthView, true),
        ],
      });
    this.aoBlurAcrossGroup = blurGroup('post.aoBlurAcross', this.aoTargetView);
    this.aoBlurDownGroup = blurGroup('post.aoBlurDown', this.aoScratchView);
    /* The volume's group holds the depth snapshot, which is one of the targets just replaced.
       Keeping the old group would clamp every beam against a destroyed texture. */
    this.lightVolumeBindGroup = this.buildLightVolumeBindGroup();
    /*
     * One group per source the chain reads, in the order `runBloom` indexes them: the scene
     * first, then every level. The prefilter reads the scene; the downsample into level `i`
     * reads level `i - 1`, which is group `i`; the upsample into level `i - 1` reads level
     * `i`, which is group `i + 1`.
     */
    this.bloomGroups = [this.sceneColorView, ...this.bloomLevels.map((level) => level.view)].map(
      (view, index) =>
        device.createBindGroup({
          label: `post.bloomGroup${index}`,
          layout: this.bloomLayout,
          entries: [
            {
              binding: BLOOM_UNIFORMS,
              resource: { buffer: this.bloomUniforms, size: BLOOM_STAGE_SIZE },
            },
            ...entry(BLOOM_TEXTURES.uSource, view),
          ],
        }),
    );
    this.writeBloomBlocks();
  }

  /**
   * Every bloom stage's uniform block, written once per size rather than once per frame.
   *
   * **By name off each stage's own layout**, and that is not ceremony: the three blocks are all
   * sixteen bytes and hold different things — a texel and a threshold, a texel, a radius — so a
   * field read off the wrong one lands at a plausible offset and writes a plausible number.
   * `postField` throws on a name a block does not have, which is what turns that into a crash at
   * init rather than an effect that quietly runs on somebody else's uniform.
   */
  private writeBloomBlocks(): void {
    const f = this.bloomFloats;
    const levels = this.bloomLevels;
    if (levels.length === 0) return;
    const slot = (index: number): number => (index * BLOOM_SLOT) / 4;

    /* The prefilter reads the *scene*, so its texel is the frame's rather than a level's.
       `uTexel`, not `uTexelSize`, and the block carries no strength at all: the composite
       applies that when it adds the result back. Both were written wrong here first. */
    const prefilter = (name: string): number => this.postField(BLOOM_PREFILTER_FIELDS, name);
    f[slot(0) + prefilter('uTexel')] = 1 / Math.max(1, this.frameWidth);
    f[slot(0) + prefilter('uTexel') + 1] = 1 / Math.max(1, this.frameHeight);
    /* In scene units, which is why an HDR target is what makes a threshold above 1 mean
       anything: against a clamped buffer nothing is ever brighter than white. */
    f[slot(0) + prefilter('uThreshold')] = this.quality.bloomThreshold;

    /* Each downsample's texel is its *source's*, which is the level above it. */
    const down = (name: string): number => this.postField(BLOOM_DOWNSAMPLE_FIELDS, name);
    for (let index = 1; index < levels.length; index++) {
      const source = levels[index - 1];
      if (source === undefined) break;
      f[slot(index) + down('uTexel')] = 1 / Math.max(1, source.width);
      f[slot(index) + down('uTexel') + 1] = 1 / Math.max(1, source.height);
    }

    const up = (name: string): number => this.postField(BLOOM_UPSAMPLE_FIELDS, name);
    f[slot(BLOOM_UPSAMPLE_SLOT) + up('uRadius')] = BLOOM_FILTER_RADIUS_UV;

    this.surface.device.queue.writeBuffer(this.bloomUniforms, 0, this.bloomStaging);
  }

  private ensureReflection(width: number, height: number): void {
    if (!this.wantsReflection) return;
    const { device } = this.surface;
    const size = reflectionTargetSize(
      width,
      height,
      this.quality.waterReflectionScale,
      device.limits.maxTextureDimension2D,
      this.reflectionSize,
    );
    const current = this.reflection;
    if (current !== null && current.width === size.width && current.height === size.height) return;

    current?.dispose();
    this.reflectionReady = false;
    const reflection = createGpuReflection(
      device,
      /* The world's format again: the mirror pass draws the world a second time, through the
         same pipelines, so this target has no freedom to be anything else. */
      this.pipelines.format,
      width,
      height,
      this.quality.waterReflectionScale,
      device.limits.maxTextureDimension2D,
      this.samples,
      this.reflectionSize,
    );
    this.reflection = reflection;
    this.waterBindGroup = createWaterBindGroup(
      device,
      this.waterLayout,
      this.waterVerts.buffer,
      this.waterFrags.buffer,
      reflection.view,
      reflection.sampler,
    );
    /* The film samples the same mirror, so it is rebound on the same event. */
    this.filmBindGroup = createFilmBindGroup(
      device,
      this.filmLayout,
      this.filmVerts.buffer,
      this.filmFrags.buffer,
      reflection.view,
      reflection.sampler,
    );
  }

  /** What is under a pixel. See `Renderer.registerPickable` in `renderer.ts` for why this answers only *what* and dispatches no events. */
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

  /**
   * Give the device back, and everything registered against it first.
   *
   * **The registries are drained before `surface.dispose()`, and the order is the whole of it.**
   * That call ends in `device.destroy()` — see `device.ts` — and a definition releasing a buffer
   * against a destroyed device is the one way this goes wrong. Nothing released them at all until
   * now: `unregisterPass` and `unregisterCompute` always have, and neither was called on teardown,
   * so every pipeline and bind group a contributor built outlived the renderer that asked for it.
   *
   * Unconditional here where the WebGL2 side asks whether it still has a context, because the two
   * backends fail differently: a lost GL context makes deleting its objects an error, and a lost
   * WebGPU device swallows the call instead. Each backend does what is true of it, which is what
   * the 2026-08-13 rule asks for — one decision, bound twice.
   */
  dispose(): void {
    for (const texture of this.retiredTextures) texture.destroy();
    this.retiredTextures.length = 0;
    const passDevice = this.passDevice();
    drainRegistry(this.passes, (definition) => definition.dispose?.(passDevice));
    this.passReads.clear();
    this.passReadsUnion = 0;
    /* The drain releases every slot without going through `unregisterPass`, so the counter it
       keeps has to be cleared here rather than decremented there. */
    this.preparingPasses = 0;
    const computeDevice = this.computeDevice();
    drainRegistry(this.computes, (definition) => definition.dispose?.(computeDevice));

    this.fieldComposer?.dispose();
    this.fieldComposer = null;

    this.pass = null;
    this.encoder = null;
    this.skinPalettes.dispose();
    this.gpuTimer.dispose();
    this.reflection?.dispose();
    this.reflection = null;
    this.surface.dispose();
  }
}
