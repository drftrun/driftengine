/*! DriftEngine | Copyright 2026 Drift Technologies | Apache-2.0 | https://github.com/drftrun/driftengine */
/** Public engine surface. Game code imports from '@driftengine/core' only. */

export { startLoop } from './core/loop.ts';
export type { LoopHooks, FrameSource, LoopOptions } from './core/loop.ts';
export { StepBudget } from './core/stepBudget.ts';
export type { StepBudgetOptions } from './core/stepBudget.ts';
export { hashToUnit, mulberry32, pickBySeed, savableMulberry32 } from './core/rng.ts';
export { exactAcos, exactCos, exactExp, exactLog, exactSin } from './math/exact.ts';
export type { SavableRandom } from './core/rng.ts';
export { TickTrace } from './core/tickTrace.ts';
export type { TickTraceLike } from './core/tickTrace.ts';
export { BrowserStore, MemoryStore, defaultStore } from './core/storage.ts';
export type { KeyValueStore } from './core/storage.ts';
/* The same seam over a backend that answers later, with the queue, the retry and the status. */
export { RemoteSaveStore, defaultSaveTimer } from './core/remoteSave.ts';
export type { RemoteSaveOptions, SaveBackend, SaveStatus, SaveTimer } from './core/remoteSave.ts';
/*
 * The rest of the capability seam, on `KeyValueStore`'s pattern and for its reason: the engine
 * declares what it needs and a host supplies it, so nothing under `src/` ever names a shell.
 *
 * The browser implementations are exported beside the interfaces because a consumer in a browser
 * is a consumer with a host — an ordinary one — and should not have to write `BrowserDisplay`
 * itself. `PlatformServices` has no default implementation on purpose: there is nothing honest a
 * browser can do with an achievement, and a consumer that never asks for one ships nothing.
 */
export { BrowserDisplay } from './host/display.ts';
export type { DisplayControl, DisplayInfo, WindowMode } from './host/display.ts';
/*
 * What a phone has instead of a window: an orientation, a safe area and a screen that sleeps.
 * Separate from `DisplayControl` because a desktop shell has no use for it and a phone has no use
 * for most of that — and public, because a game's own settings menu is what calls it.
 */
export { BrowserScreenPresentation } from './host/screen.ts';
export type { SafeAreaInsets, ScreenOrientation, ScreenPresentation } from './host/screen.ts';
export { BrowserLifecycle } from './host/lifecycle.ts';
export type { Lifecycle } from './host/lifecycle.ts';
export { BrowserFileDialogs } from './host/files.ts';
export type { FileDialogs, OpenedFile } from './host/files.ts';
export type { PlatformServices } from './host/platformServices.ts';
export { PreferenceStore, loadPreferences, savePreferences } from './core/preferences.ts';
export type { PreferenceSchema } from './core/preferences.ts';
export { OnceSet } from './core/onceSet.ts';
export {
  MAX_TIME_CURVE_AMOUNT,
  curveOffsetSec,
  curveSpanSec,
  linearCurve,
  timeCurve,
} from './core/timeCurve.ts';
export type { TimeCurve, TimeCurveKind, TimeCurveOptions } from './core/timeCurve.ts';
export { CinematicPlayer } from './cinematic/player.ts';
export { defineCinematic, validateCinematic } from './cinematic/script.ts';
export type {
  CameraKeyframe,
  CinematicLine,
  CinematicScript,
  CinematicShot,
} from './cinematic/script.ts';
export { MessageQueue } from './core/messageQueue.ts';
export type { MessageQueueOptions, QueuedMessage } from './core/messageQueue.ts';
export {
  celestialStateAt,
  createCelestialState,
  moonIllumination,
} from './environment/celestialClock.ts';
export type { CelestialSite, CelestialState } from './environment/celestialClock.ts';

export {
  TAU,
  DEG_TO_RAD,
  clamp,
  lerp,
  smoothstep,
  damp,
  dampTracking,
  angleDelta,
  dampAngle,
  wrapAngle,
  lerpAngle,
} from './math/scalar.ts';
export { hslToRgb, mixColor, mixColorInto, scaleColor } from './math/color.ts';
export type { Vec3 } from './math/color.ts';

export { Camera } from './render/camera.ts';
export { ThirdPersonCamera } from './render/thirdPersonCamera.ts';
export { CinematicCamera } from './render/cinematicCamera.ts';
export type { ShotKind, ShotParams } from './render/cinematicCamera.ts';
export type { BoomObstruction, ThirdPersonCameraOptions } from './render/thirdPersonCamera.ts';
/*
 * The arm's own timings, so a rig with a short boom can say so.
 *
 * `Boom` itself is exported because it is the one implementation of "shorten against geometry, but
 * gradually" and a consumer with its own rig should use it rather than write a third — which is the
 * argument its own header makes about the two that already existed.
 */
export { Boom, DEFAULT_BOOM_TIMING } from './render/boom.ts';
export type { BoomTiming } from './render/boom.ts';
export { billboardMatrix, billboardMatrixY } from './render/billboard.ts';
export { Mesh } from './render/mesh.ts';
export type { MeshData } from './render/mesh.ts';
export { UPLOAD_BYTES_PER_STEP } from './render/uploadStep.ts';
export { MAX_DEPTH_LAYER, Renderer, WebGL2Renderer } from './render/backend/webgl2/renderer.ts';
export type {
  Environment,
  FilmOptions,
  LightVolumeDrawOptions,
  SkyColors,
  TranslucentMeshOptions,
} from './render/backend/webgl2/renderer.ts';
/*
 * **The class as well as its two types, from 2026-09-03.** Every renderer holds one and
 * exposes it through `registerPickable` and `pickAt`, so picking has been reachable since
 * it shipped — but only against the set a renderer owns. A consumer that wants a second
 * set, over gizmo handles or over anything a renderer never draws, had the types to
 * describe one and no way to build it.
 */
export { PickableSet } from './render/pickable.ts';
export type { PickHit, PickableSource } from './render/pickable.ts';
/* How big a piece of geometry is, which everything that culls or picks a detail level starts from. */
export { boundsOfBox, boundsOfPositions, createBounds } from './math/bounds.ts';
export type { Bounds } from './math/bounds.ts';
export {
  boxInFrustum,
  createFrustum,
  frustumFromViewProjection,
  sphereInFrustum,
} from './math/frustum.ts';
export type { Frustum, FrustumPlanes } from './math/frustum.ts';
export { boundsVisible } from './render/visibility.ts';
export { apparentSize, lodForBounds } from './render/lod.ts';
/* A transform hierarchy. Additive: nothing in the renderer knows a node exists. */
export { SceneNode } from './scene/node.ts';
export {
  MAX_JOINTS,
  MAX_MORPH_TARGETS,
  SKIN_PALETTE_TEXTURE_UNIT,
  morphTexelIndex,
  paletteTextureWidth,
} from './render/skinPalette.ts';
export { createVisitResult, visitVisible } from './scene/visit.ts';
export type { VisitResult } from './scene/visit.ts';
/*
 * A pass a package contributes, which is the whole of what `splats`, `ui2d` and `xr` were
 * waiting for.
 *
 * `FrameResource` becomes public here and the rest of `frame/` does not: a contributor declares
 * what it reads by *name*, and the arena, the scheduler and the resource masks stay internal
 * because nothing outside the renderer has any business holding a bitset.
 */
export type {
  PassContext,
  PassDefinition,
  PassDevice,
  PassHandle,
  PrepareContext,
} from './render/pass.ts';
/*
 * A target the pass owns, which is the other half of what a rendering package needs.
 *
 * `reads` lets a contributor say what it samples of the *frame*; this lets it have something of
 * its own to sample. The two are asymmetric on purpose — see `PassTarget`, where the reason a
 * write to the frame stays refused while a write to a pass-owned target does not is written out.
 */
export type { PassAttachmentOptions, PassTarget } from './render/passTarget.ts';
/*
 * The mip chain a pass has to build for itself on WebGPU, and the level count it needs to ask for.
 *
 * **Public because `gl.generateMipmap` has no WebGPU equivalent and every contributed pass that
 * uploads a texture meets that the moment its texture is ever minified.** `ui2d` met it with a
 * glyph atlas baked at 96 px and drawn at 11; writing the blit a second time there would have been
 * a second WGSL shader to keep in step with this one, and the copy that quietly disagrees about
 * the colour space is the one that would ship. `MipPipelines` is an interface rather than the
 * renderer's cache so a pass can hand over a `Map` and nothing more.
 */
export {
  generateMipChain,
  mipLevelCount,
  type MipPipelines,
} from './render/backend/webgpu/surfaceTexturePass.ts';
export { createPassAttachment } from './render/passTarget.ts';
/*
 * What a pass drawing the world does with `PrepareContext.jitter`, so a reconstructed frame's
 * resolve finds its geometry where the renderer's own verbs put theirs.
 */
export { jitterClip } from './render/recon/jitter.ts';
export type { FrameResource } from './render/frame/index.ts';
/*
 * Occlusion culling, which is arithmetic rather than a GPU feature — so the class is public and a
 * consumer with its own draw loop can hold one, exactly as it can hold a `Frustum`.
 */
export type { OcclusionOptions } from './render/occlusion.ts';
export { OcclusionBuffer } from './render/occlusion.ts';
/*
 * Compute, which only one backend has.
 *
 * `computeSupported` on the renderer is the member to read before registering one, and
 * `ComputeDevice` has no WebGL2 arm because there is nothing to put in it — see `compute.ts`.
 */
export type {
  ComputeContext,
  ComputeDefinition,
  ComputeDevice,
  ComputeHandle,
} from './render/compute.ts';
/*
 * `Renderer` above stays exported and is not deprecated. `createRenderer` is the way to get
 * whichever backend a browser will give you, and it is asynchronous because asking for a
 * WebGPU adapter is; a consumer that does not want an await in its boot has no reason to
 * take one.
 */
export { createRenderer } from './render/backend/createRenderer.ts';
/*
 * Both halves of that call, because a consumer that passes options had no name for them.
 * `CreateRendererOptions` is what `preferWebGpu` lives on, so without it the only way to hold
 * one is to write the object inline at the call — which is exactly how a choice ends up
 * duplicated across the several places an application creates a renderer.
 */
export type {
  CreatedRenderer,
  CreateRendererOptions,
  RenderPipeline,
} from './render/backend/createRenderer.ts';
/*
 * The second pipeline, as the two things a consumer assembles: the scene packing and the pass
 * that draws it.
 *
 * **Exported here and reached by nobody who does not ask for it.** `pipeline: 'gpu-driven'` on
 * `createRenderer` is the permission — it fails at boot where the backend cannot run this — and
 * `GpuDrivenPass` is the implementation, registered the way `@driftengine/splats` registers one.
 * A consumer who names neither pays nothing: `core-only` is measured with these exported and does
 * not move, because nothing in the forward path reaches them.
 *
 * It draws vertex colour, one directional term, a hemispheric ambient and an emissive add — not
 * the standard material. `DRAFT_SCENES`, never `SCENES`, until it draws the six published ones.
 */
export {
  GPU_DRIVEN_LISTS,
  GpuDrivenPass,
  MATERIAL_FLOATS,
} from './render/backend/webgpu/gpuDrivenPass.ts';
export type {
  GpuDrivenList,
  GpuDrivenMaterial,
  GpuDrivenShadowOptions,
  GpuDrivenView,
} from './render/backend/webgpu/gpuDrivenPass.ts';
/*
 * **One environment, one haze, on both pipelines.** `GpuDrivenView.fog` is the medium the forward
 * path binds, and a consumer drawing both in one frame fills it from `atmosphereFog` rather than
 * working the numbers out again — the voxel sandbox's port is the first.
 */
export { atmosphereFog, createFogTarget } from './render/fog.ts';
export type { FogOptions, FogTarget } from './render/fog.ts';
export { buildGpuDrivenScene } from './render/gpudriven/sceneUpload.ts';
export type { GpuDrivenMesh, GpuDrivenScene } from './render/gpudriven/sceneUpload.ts';
/*
 * **The scene a `GpuDrivenPass` takes**, which is a streaming one since 2026-09-18 — a static
 * scene is one filled once, so there is a single path rather than two. `buildGpuDrivenScene` stays
 * exported because it is the packer `streamScene.test.ts` holds the streaming layout to.
 */
export { StreamingScene, streamingScene } from './render/gpudriven/streamScene.ts';
export type {
  DirtySpan,
  GeometrySink,
  StreamCapacity,
  StreamHandle,
  StreamUpload,
} from './render/gpudriven/streamScene.ts';
export type { ClusterSource } from './render/gpudriven/clusterUpload.ts';
export { packDecodeTables, programFromEncoded } from './render/gpudriven/decodeTables.ts';
export type {
  DecodeTables,
  EncodedProgramShape,
  GpuDrivenLatent,
  GpuDrivenNetwork,
  GpuDrivenProgram,
} from './render/gpudriven/decodeTables.ts';
export type { GpuDrivenTextures } from './render/gpudriven/materialTable.ts';
/*
 * **A network graph on a device**: the one neural runtime's device half. `@driftengine/texture`
 * holds the references and validates a graph; this runs the validated graph, whose shapes it takes
 * as given, on a device opened from whichever `GPU` the caller has — a browser's or the native
 * host's Dawn. Exported because the device may not leave `render/`, so a package that runs a
 * network does so through here or not at all.
 */
export { openInferenceDevice } from './render/inference/device.ts';
export type { InferenceDevice } from './render/inference/device.ts';
export { createGraphRunner } from './render/inference/runner.ts';
/* The buffer-reuse rule, exported because `@driftengine/texture`'s evaluator plans by this one
   rather than by a second copy of it — see `reuse.ts` for why it is on this side of the arrow. */
export { planReuse } from './render/inference/reuse.ts';
/* The tile lists a device draws a splat cloud from, beside the shader that walks them. */
export {
  countSplatTiles,
  fillSplatTiles,
  splatPixelBox,
  splatTileGrid,
  splatTileOffsets,
  SPLAT_BIN_FLOATS,
  SPLAT_TILE,
} from './render/inference/splatTiles.ts';
export type { BufferReuse } from './render/inference/reuse.ts';
export type { GraphRunner } from './render/inference/runner.ts';
export type {
  DeviceAttribute,
  DeviceGraph,
  DeviceGraphNode,
} from './render/inference/deviceGraph.ts';
/**
 * **Indirect light, as three levels that fall back to each other and never off the end.**
 *
 * `ROADMAP.md` refused screen-space global illumination because its error is unbounded — a ray
 * that leaves the frame has no answer, and every technique that ships one anyway invents one from
 * whatever happened to be on screen. This does not reverse that refusal: the screen is an
 * accelerator with a world-space distance field behind it, whose error is bounded by its own
 * resolution, and a probe volume behind *that*, which is never wrong and only ever coarse.
 *
 * **CPU-side, and reached by nobody who does not ask.** There is no WGSL, no pass and no renderer
 * option yet, so no scene renders differently for these existing — this wave's first constraint,
 * measured rather than asserted: the eight published scenes are 0 of 921,600 pixels against the
 * build before them, and `core-only` is byte-identical with these exported and without them.
 * Exported anyway, for the reason `bake/cluster.ts` was not: a capability with no route out of its
 * package is one the first consumer finds by failing a boundary test.
 */
export {
  GI_SOURCE_FIELD,
  GI_SOURCE_PROBES,
  GI_SOURCE_SCREEN,
  newIndirectResult,
  traceIndirect,
} from './render/gi/chain.ts';
export type { GiResources, GiSource, IndirectRay, IndirectResult } from './render/gi/chain.ts';
export {
  GLOBAL_FIELD_BLEND,
  composeGlobalField,
  createGlobalField,
  sampleGlobalField,
} from './render/gi/globalField.ts';
export type {
  FieldSource,
  GlobalField,
  GlobalFieldCascade,
  GlobalFieldInstance,
} from './render/gi/globalField.ts';
export {
  GI_SCREEN_MARCH,
  SCREEN_TRACE_BIAS_M,
  screenRayOrigin,
  traceScreen,
} from './render/gi/traceScreen.ts';
export { FIELD_MARCH, coneRadiusAt, newFieldHit, traceField } from './render/gi/traceField.ts';
export type { FieldHit, FieldMarch } from './render/gi/traceField.ts';
export {
  PROBE_VISIBILITY_SHARPNESS,
  bakeProbeVisibility,
  createProbeVisibility,
  probeUpdateSchedule,
  probeVisibilityWeight,
  sampleProbeVolume,
  visibleProbes,
} from './render/gi/probeVolume.ts';
export type { ProbeVisibility } from './render/gi/probeVolume.ts';
export {
  DENOISE_MIN_ALPHA,
  filterStepFor,
  newTemporalPixel,
  spatialDenoise,
  temporalDenoise,
} from './render/gi/denoise.ts';
export type { DenoiseFrame, SpatialOptions, TemporalPixel } from './render/gi/denoise.ts';
export { reflectDirection, reflectionCone, traceReflection } from './render/gi/reflection.ts';
/*
 * The pass that draws the renderer's field on a device. WebGPU only, and it says so at
 * registration rather than at the first frame: a distance field is composed by compute and WebGL2
 * has none. It no longer composes one of its own — `addDistanceField` is how a scene declares
 * what its indirect light may be traced against, and this marches what the renderer made of them.
 */
export { GiFieldPass } from './render/backend/webgpu/giFieldPass.ts';
export type { GiFieldOptions } from './render/backend/webgpu/giFieldPass.ts';
export { DistanceFieldScene, MAX_DISTANCE_FIELDS } from './render/gi/fieldScene.ts';
export type { DistanceFieldInstance } from './render/gi/fieldScene.ts';
export { placeCascade } from './render/gi/globalField.ts';
export type { ReflectionOptions, ReflectiveSample } from './render/gi/reflection.ts';
/*
 * The acceptance probe, exported because a consumer may want to ask the question itself — an
 * editor deciding whether to offer a backend, a shell deciding what to tell the player — and
 * because `demo/dev/backend-probe.html` drives it the way a consumer would rather than by
 * reaching past the barrel into `src/render/`.
 */
/*
 * The colour grade: a lookup table over display values, applied at the composite.
 *
 * `identityGradeLut` is exported because it is where a consumer building one by hand starts —
 * take the identity, bend it, hand it back — and because it is what the placeholder is.
 */
export { GRADE_PLACEHOLDER_SIZE, MAX_GRADE_SIZE, identityGradeLut } from './render/colourGrade.ts';
export type { ColourGradeLut } from './render/colourGrade.ts';
export { probeDevice } from './render/backend/probe.ts';
export type { ProbeVerdict } from './render/backend/probe.ts';
/*
 * Every handle the surface hands back, because a consumer has to be able to name what it is
 * holding. `CausticsHandle` and `SurfaceTextureHandle` were the two that were not exported, and
 * both are reachable from `RendererApi` — so a consumer could receive one from `createCaustics`
 * or `createSurfaceTexture` and then had no way to declare the field it kept it in. Found by
 * migrating a consumer that holds both.
 */
export type {
  BoltHandle,
  CausticsHandle,
  FlockHandle,
  IncrementalMeshHandle,
  LineHandle,
  MeshHandle,
  MeshOptions,
  RenderBackend,
  RendererApi,
  ParticleHandle,
  PlumeHandle,
  ScatterHandle,
  InstancedHandle,
  SdfTextHandle,
  SurfaceTextureHandle,
  TextHandle,
  WaterHandle,
  WindStreakHandle,
} from './render/backend/api.ts';

/**
 * What a frame asked of a backend, against the ceilings that backend imposes.
 *
 * Exported because a consumer's own headless check is the intended reader: `frameBudget.dropped`
 * is the boolean to fail on, and typing the walk over `lines` needs the two shapes.
 */
export type { BudgetLine, FrameBudget } from './render/backend/budget.ts';
export type { FrameTimer } from './render/backend/timer.ts';
/*
 * **All four, because this interface is implemented outwards.** `ShadowCasterSink` was published
 * and `SceneCasterMaterial` was not, so a consumer could accept the material its `mesh` and
 * `skinnedMesh` are obliged to take and had no way to name it. They wrote
 * `Parameters<ShadowCasterSink['mesh']>[2]` instead, which is exact and cost them a paragraph
 * explaining why it was not an import.
 *
 * `SceneCasters` goes with it for the same reason rather than a different one: `drawSceneCasters`
 * documents itself by pointing at that name, and a doc comment referring a reader to something the
 * barrel does not publish is a reference into a private module.
 */
export type {
  SceneCasterMaterial,
  SceneCasters,
  ShadowCasterSink,
  ShadowCasters,
} from './render/shadowCasters.ts';
export type { Atmosphere, UnderwaterAtmosphere } from './render/atmosphere.ts';
/*
 * Reading an image's texels back exactly, which no canvas and no `VideoFrame` will do.
 *
 * Here rather than in the package that needed it — `@driftengine/splats`, for `.sog` captures whose
 * images are lookups rather than pictures — because it is raw WebGL and `AGENTS.md` allows that
 * only under `render/`. The module's own header carries the measurement.
 */
export { createImageTexelDecoder } from './render/imageTexels.ts';
export type { ImageTexelDecoder, ImageTexels } from './render/imageTexels.ts';
export { DEFAULT_RENDER_QUALITY, resolveRenderQuality } from './render/renderQuality.ts';
/**
 * The global medium's own arithmetic, so a consumer can clamp its numbers the way the engine will.
 *
 * The pass itself is not exported and should not be: `setGlobalMedium` is the whole surface, and a
 * consumer holding a `GlobalMediumPass` would own a target the renderer already owns. What is here
 * is the type the setter takes and the two bounds a settings screen has to know about.
 */
export {
  DEFAULT_GLOBAL_MEDIUM,
  MAX_GLOBAL_MEDIUM_STEPS,
  WEAK_GPU_MEDIUM_STEPS,
  resolveGlobalMedium,
} from './render/globalMedium.ts';
export type { GlobalMediumOptions } from './render/globalMedium.ts';
/*
 * Equirectangular to cube faces, and the roughness a prefiltered level stands for.
 *
 * Exported because a consumer that wants to load an environment needs the first, and a consumer
 * writing its own probe tooling needs the second. Neither pulls in a decoder: reading a `.hdr` is
 * `@driftengine/assets`, and a game that never loads one imports none of it.
 */
export { equirectToCubeFaces } from './render/equirectToCube.ts';
export type { EquirectSource } from './render/equirectToCube.ts';
export {
  IRRADIANCE_EDGE,
  PREFILTER_SAMPLE_COUNTS,
  ggxMaxLevelFor,
  irradianceLevelFor,
  octahedralEdgeFor,
  roughnessForLevel,
} from './render/prefilterEnvMap.ts';
/**
 * Where probes stand, and which of them light a point.
 *
 * Exported because placement is a consumer's decision and because a consumer sizing its own
 * storage needs `MAX_ENV_PROBES` — every probe is one layer of one array texture, so the budget is
 * memory rather than texture units. `nearestProbes` is the same trilinear blend the shader
 * computes from three uniforms, which is what makes a consumer's bake ordering agree with what the
 * lit pass will read.
 */
export { MAX_ENV_PROBES, ProbeGrid, createProbeBlend, nearestProbes } from './render/probeGrid.ts';
export type { ProbeBlend, ProbeGridOptions } from './render/probeGrid.ts';
export { IES_ATLAS_WIDTH, packIesAtlas } from './render/iesProfile.ts';
export { MAX_AREA_LIGHTS, createAreaLightBuffer, selectAreaLights } from './render/areaLights.ts';
export type { AreaLightBuffer, AreaLightSource } from './render/areaLights.ts';
/**
 * A rectangle's occlusion. Exported because a consumer sizing its own storage budget needs the
 * layer arithmetic, and because `castingRange` is the one predicate that decides whether a
 * declaration will actually cast — a consumer asserting that its fixtures do should ask the engine
 * rather than re-implement the two conditions.
 */
export {
  areaShadowLayerCount,
  castingRange,
  firstAreaShadowLayer,
} from './render/areaShadowSet.ts';
export type { PhotometricProfile } from './render/iesProfile.ts';
export type { PrefilterQuality } from './render/prefilterEnvMap.ts';
/**
 * What a probe bake is for: the reflection alone, or the reflection and the scene's ambient.
 *
 * Exported because declining the second half is a decision only a consumer can make — see
 * `ProbeBakeOptions`, which is the whole of the reasoning.
 */
export type { ProbeBakeOptions } from './render/reflectionProbe.ts';
export type {
  DirectionalShadowDepthLayers,
  OutputTransform,
  RenderQuality,
  RenderQualityOptions,
  ShadowFilterTaps,
  WaterReflectionFilterTaps,
} from './render/renderQuality.ts';
export { MAX_POINT_LIGHTS, SURFACE_TEXTURE_UNIT } from './render/lightBudget.ts';
export { SurfaceTexture } from './render/surfaceTexture.ts';
export type { SurfaceMaterial, SurfaceTextureOptions } from './render/surfaceTexture.ts';
export { DEFAULT_GOVERNOR_LIMITS, ResolutionGovernor } from './render/resolutionGovernor.ts';
export type { GovernorLimits } from './render/resolutionGovernor.ts';
export { isWeakGpuFamily } from './render/gpuCapability.ts';
/**
 * The same question `isWeakGpuFamily` answers, asked early enough to choose a profile with.
 *
 * `RendererApi.rendererName` and `CreatedRenderer.rendererName` are this answer after the fact,
 * which is the right time for a boot log and too late for a decision.
 */
export { describeGpu } from './render/gpuCapability.ts';
export type { GpuIdentity, DescribeGpuOptions } from './render/gpuCapability.ts';
export {
  DEFAULT_POINT_LIGHT_VIEW_RANGE,
  createPointLightBuffer,
  selectPointLights,
} from './render/pointLightSelection.ts';
export type { PointLightBuffer, PointLightSource } from './render/pointLightSelection.ts';
export { computeLightMatrix } from './render/lightMatrix.ts';
export { PlumeRenderer } from './render/plumeRenderer.ts';
export { createEnvironment } from './render/backend/webgl2/renderer.ts';
export type { InsetRect } from './render/backend/webgl2/renderer.ts';
export { TrampleField, TRAMPLE_SLOTS } from './render/trample.ts';
export type { PlumePlacement, PlumeOptions, PlumeBlend } from './render/plumeRenderer.ts';
export type { PlumeMaterial } from './render/plumeMaterial.ts';
export type { ParticleMaterial } from './render/particleMaterial.ts';
/*
 * Turns a silent uniform miss into a warning. See `shader.ts` — writing to a uniform the
 * program does not have is a legal no-op, which is how an effect can quietly not exist.
 */
export { setUniformStrictMode } from './render/shader.ts';
/*
 * And everything an app is waiting for as one weighted number, which is the part every consumer
 * was writing for itself. Ids and numbers only: what to call a stage depends on who is reading it,
 * so the words stay with whoever is showing them.
 */
export { LoadTracker } from './core/loadTracker.ts';
export type { LoadTask, LoadSummary } from './core/loadTracker.ts';
/*
 * Closing the inside of a model that is only a surface, which a great many bought models are: a
 * car with no cabin, a building with no rooms. Drawn alone they are correct, and any opening in
 * them shows straight through the object and out the far side. Takes sizes and fractions; what a
 * subject looks like is the caller's to state.
 */
export {
  buildShellFill,
  shellSkin,
  shellFillMatrix,
  DEFAULT_SHELL_PROFILE,
} from './geometry/shellFill.ts';
export type { ShellStation, ShellFillOptions } from './geometry/shellFill.ts';
/*
 * The grade a forward pass applies when nothing follows it.
 *
 * **Exported because a package cannot obey the rule otherwise.** `AGENTS.md`, 2026-08-17: every
 * forward pass grades itself when nothing follows it, `outputTransform.ts` is the single
 * definition, and *do not copy the curve*. A pass contributed through `registerPass` is a forward
 * pass like any other — a splat cloud writes straight to the canvas with no composite — and until
 * this line the only way for it to comply was to copy, which is what the rule forbids.
 */
export { OUTPUT_TRANSFORM_GLSL } from './render/shaders/outputTransform.ts';
export { PLUME_VERT, FIRE_FRAG } from './render/shaders/fire.ts';
export { ARCANE_FRAG } from './render/shaders/arcane.ts';
export { SMOKE_FRAG } from './render/shaders/smoke.ts';
export { WaterRenderer } from './render/waterRenderer.ts';
export type { WaterBody, WaterBounds, WaterSettings } from './render/waterRenderer.ts';
export { MeshBuilder } from './geometry/meshBuilder.ts';
/* A tangent frame, which every map in the material track reads. */
export { generateTangents } from './geometry/tangents.ts';
export type { MeshBuildOptions } from './geometry/meshBuilder.ts';
export { Spline, createSplineSample } from './geometry/spline.ts';
export type { SplinePoint, SplineSample } from './geometry/spline.ts';
export { RIBBON_COLLIDER_GIVE_M, RIBBON_STEP_M } from './geometry/ribbon.ts';
export { buildRibbon } from './geometry/ribbon.ts';
export { buildFilmPatch } from './geometry/filmPatch.ts';
export { buildLightVolume } from './geometry/lightVolume.ts';
export type { LightVolumeOptions } from './geometry/lightVolume.ts';
export { buildTextMesh, textMeshHeightM, textMeshWidthM } from './geometry/textMesh.ts';
export type { TextMeshStyle } from './geometry/textMesh.ts';
export { CausticsRenderer } from './render/causticsRenderer.ts';
export type { CausticSheet } from './render/causticsRenderer.ts';
export { buildSheets } from './render/surfaceSheet.ts';
export type { SheetMesh, SheetSpan } from './render/surfaceSheet.ts';
export type { FilmPatchOptions } from './geometry/filmPatch.ts';
export type { RibbonHole, RibbonMesh, RibbonOptions } from './geometry/ribbon.ts';
export { RibbonSurface, createSurfaceHit } from './physics/ribbonSurface.ts';
export type { GroundSurface, RibbonSurfaceOptions, SurfaceHit } from './physics/ribbonSurface.ts';
export { CompositeSurface } from './physics/compositeSurface.ts';
export { colliderSurface } from './physics/colliderSurface.ts';
/*
 * **Which way depth runs, reachable.** A consumer choosing a near plane or an offset for a decal
 * has to know: a conventional buffer resolves about `z² / (near · 2^bits)` and a reversed float one
 * is near enough uniform, and the difference is millimetres of offset and a factor on the near
 * plane. Reported per renderer as `reversedDepth`, which is what the context *granted*; these are
 * what the engine asks for, and the two agree everywhere except a WebGL2 context without
 * `EXT_clip_control`.
 */
export {
  DEPTH_CLEAR,
  DEPTH_COMPARE,
  DEPTH_COMPARE_EQUAL,
  DEPTH_FORMAT,
  DEPTH_OFFSET_SIGN,
  REVERSED_DEPTH,
  conventionalDepth,
} from './render/depthConvention.ts';
export type { ColliderSurfaceOptions } from './physics/colliderSurface.ts';
export { BoxSurface } from './physics/boxSurface.ts';
export { heightSurface } from './physics/heightSurface.ts';
export { DebugLines } from './render/debugLines.ts';
/*
 * The gizmo is a generator, the way `DebugLines` above it is: it answers what a ray is
 * over and what a drag does, and fills line buffers the caller draws with `drawLines`.
 * Nothing here touches a context.
 */
/*
 * Ray intersection, exported because a consumer building a tool needs the same arithmetic the
 * gizmo does. `editor/src/viewport/gizmo.ts` reaching into `src/math/intersect.ts` by path would
 * be the editor using a private hook, which `ARCHITECTURE.md` treats as a hole in the engine
 * rather than as the editor's problem — so the hole is closed here.
 */
export { rayClosestOnLine, rayPlane, raySphere } from './math/intersect.ts';
export {
  GIZMO_GROUP_ACTIVE,
  GIZMO_GROUP_COLORS,
  GIZMO_GROUP_COUNT,
  GIZMO_GROUP_NEUTRAL,
  GIZMO_GROUP_X,
  GIZMO_GROUP_Y,
  GIZMO_GROUP_Z,
  GIZMO_NONE,
  GIZMO_ROTATE_X,
  GIZMO_ROTATE_Y,
  GIZMO_ROTATE_Z,
  GIZMO_SCALE_UNIFORM,
  GIZMO_SCALE_X,
  GIZMO_SCALE_Y,
  GIZMO_SCALE_Z,
  GIZMO_TRANSLATE_X,
  GIZMO_TRANSLATE_XY,
  GIZMO_TRANSLATE_Y,
  GIZMO_TRANSLATE_YZ,
  GIZMO_TRANSLATE_Z,
  GIZMO_TRANSLATE_ZX,
  Gizmo,
  gizmoScaleFor,
} from './render/gizmo.ts';
export type { GizmoMode, GizmoSpace } from './render/gizmo.ts';
export { RainField } from './render/rainField.ts';
export type { RainFieldOptions } from './render/rainField.ts';
export { coveredAbove } from './physics/heightSurface.ts';
export { buildNavGraph, nearestNavNode } from './nav/navGraph.ts';
export type { NavEdge, NavGraph } from './nav/navGraph.ts';
export { NavSearch } from './nav/navSearch.ts';
export { NavPath, createNavSteer } from './nav/navPath.ts';
export {
  BehaviorRunner,
  FAILURE,
  RUNNING,
  SUCCESS,
  buildBehaviorTree,
} from './behavior/behaviorTree.ts';
export { projectDecal } from './geometry/decal.ts';
export type { DecalOptions } from './geometry/decal.ts';
export { DecalProjector } from './render/decalProjector.ts';
export type { DecalBox, DecalProjectorOptions } from './render/decalProjector.ts';
export { ReflectiveSurface } from './render/screenSpaceReflection.ts';
export type { ReflectiveSurfaceOptions } from './render/screenSpaceReflection.ts';
export type {
  BehaviorSpec,
  BehaviorStatus,
  BehaviorTasks,
  BehaviorTree,
} from './behavior/behaviorTree.ts';
export type { NavPathOptions, NavSteer } from './nav/navPath.ts';
export type { HeightField, HeightSurfaceOptions } from './physics/heightSurface.ts';
export type { SurfaceBox } from './physics/boxSurface.ts';

/*
 * `@driftengine/physics` is re-exported **wholesale**, and the star is the point.
 *
 * This was a hand-written list of names, and it drifted: by the time Track B finished, seventy-nine
 * of the package's hundred and ten exports were missing from it, so a consumer reaching for the
 * solver, the joints, the queries, the controller or the ragdolls through this barrel found
 * nothing. Nothing failed, because a name that is not re-exported is simply a name nobody can
 * import — the quietest kind of gap there is.
 *
 * A star cannot drift. **What it costs** is that this file no longer lists what collision offers,
 * so a reader has to open the package; **what would make it wrong** is a name collision between the
 * two, which is a compile error here rather than a silent shadow — and it is why the physics
 * package renamed `Pose` to `ShapePose` and `collide` to `collideShapes` before this line existed,
 * since `Pose` already means a skeleton's pose one package over.
 *
 * Core depends on this package rather than the other way round, because the cameras, the contact
 * probe and the ribbon builder all need the sweep.
 */
export * from '@driftengine/physics';
export {
  AXIS_X,
  AXIS_Y,
  AXIS_Z,
  ColliderSet,
  aabbFromCenter,
  bodyBounds,
  boxCollider,
  boxShape,
  capsuleShape,
  colliderFromShape,
  createBodyBounds,
  cylinderShape,
  createMassProperties,
  ejectFromSolid,
  faceCount,
  faceVertices,
  fingerprintBodies,
  fingerprintColliders,
  hullShape,
  moveAxis,
  segmentHit,
  shapeBounds,
  shapeMassProperties,
  sphereShape,
} from '@driftengine/physics';

export { InputSource } from './input/input.ts';
export { isTypingTarget } from './input/typingTarget.ts';
export type { TouchPoint, InputCallbacks } from './input/input.ts';
export type { GamepadIdentity, GamepadView, InputOptions, InputSourceName } from './input/input.ts';
export type { InputDevice } from './input/activeDevice.ts';
export type { GamepadFamily } from './input/gamepadIdentity.ts';
/* Positions rather than lettering, and the constant a consumer overrides to taste. */
export { DEFAULT_DEADZONE } from './input/gamepadMapping.ts';
/* The platform's own ceiling on one haptic effect, so a settings screen can bound its slider. */
export { MAX_RUMBLE_MS } from './input/rumble.ts';
export type { GamepadAxis, GamepadButton } from './input/gamepadMapping.ts';
export { ActionMap } from './input/actionMap.ts';
export type { ActionDefinition, AnalogAction, Binding, DigitalAction } from './input/actionMap.ts';
export { TouchControls } from './input/touchControls.ts';
export type { TouchControlsOptions } from './input/touchControls.ts';

export { pixelCursor } from './ui/pixelCursor.ts';
export { fullscreenWanted, requestFullscreenOnGesture } from './ui/fullscreen.ts';
export type { FullscreenConditions } from './ui/fullscreen.ts';
/*
 * The engine badge. `createRenderer` mounts it by default, so a game needs none of these names —
 * they are here for the consumer that declines the automatic one and places its own, and because
 * the two decisions behind it are worth reading before overriding either.
 */
export {
  SPLASH_FADE_MS,
  SPLASH_HARD_CAP_MS,
  SPLASH_MIN_MS,
  forcedSplash,
  mountSplash,
  splashDecision,
  splashWanted,
} from './ui/splash.ts';
export type {
  MountedSplash,
  SplashConditions,
  SplashDecision,
  SplashOptions,
} from './ui/splash.ts';
export { DEFAULT_CLIP_FPS, FrameRecorder, offerClip } from './ui/frameRecorder.ts';
// Not on `FrameRecorder`, so a screenshot does not cost a clip pipeline. See the module.
export { stillFrame } from './ui/stillFrame.ts';
/*
 * From `clipMime` rather than `frameRecorder`, and re-exporting them from there would
 * undo the point: a consumer asking whether this browser can record at all must not
 * pull the recorder in to find out. See `ui/clipMime.ts`.
 */
export { describeClipMime, supportedClipMimeType } from './ui/clipMime.ts';
export type { ClipMimeDescription } from './ui/clipMime.ts';
export {
  EXPORT_FALLBACK_SCALE,
  ExportTarget,
  clipBitrate,
  exportAspect,
  exportSizeExact,
  isDuplicateFrame,
  CLIP_FPS_LADDER,
  clipFpsFor,
  exportSizeFor,
} from './ui/exportTarget.ts';
export type { ExportSize, ExportTargetOptions, LockableSurface } from './ui/exportTarget.ts';
export { FramePacer } from './ui/framePacer.ts';
export type { FramePacingReport } from './ui/framePacer.ts';
export { bakeOverlay, drawPixelText, pixelTextCells, pixelTextSize } from './ui/frameOverlay.ts';
export type {
  FrameOverlay,
  OverlayImage,
  OverlayImageSource,
  OverlayText,
} from './ui/frameOverlay.ts';
export type { FrameRecorderOptions } from './ui/frameRecorder.ts';
export type { PixelCursorOptions } from './ui/pixelCursor.ts';

export { FpsMeter } from './dev/fpsMeter.ts';
export type { FpsMeterOptions } from './dev/fpsMeter.ts';

export { CONTACT_LIMIT, createContactReports, describeContacts } from './dev/contactProbe.ts';
export type { ContactReport } from './dev/contactProbe.ts';

export { GPU_SLOTS, GpuTimer } from './render/gpuTimer.ts';
export type { GpuSample, GpuSlot } from './render/gpuTimer.ts';

/*
 * Per-pass timings, which are a readout rather than a frame graph.
 *
 * **`render/frame/index.ts` says nothing under it may be reached from outside `render/` yet, and
 * this module is the exception with a reason.** The rest of that directory is the graph's
 * construction — declarations, lifetimes, aliasing, scheduling — whose public shape the design
 * leaves to a later phase, and exporting it now would fix a shape nobody has had to live with.
 * A timing readout is not that: it is seven functions over three arrays, its own header argues why
 * it is not a widening of `GpuTimer`, and anything that profiles a frame needs it.
 *
 * The editor is what made this concrete. `AGENTS.md`'s rule is that a consumer needing a private
 * import has found a hole in the engine, and the hole is fixed here rather than worked around
 * there — which is the whole reason the editor was built outside `packages/`.
 */
export {
  createPassTimings,
  passLabel,
  passMs,
  recordPassLabel,
  recordPassSample,
  resetPassTimings,
} from './render/frame/passTimings.ts';
export type { PassTimings } from './render/frame/passTimings.ts';
export { classifyRightGesture } from './input/rightGesture.ts';
export type { RightGesture, RightGestureOptions } from './input/rightGesture.ts';
export { createWindState, sampleWind } from './render/wind.ts';
export { advanceWindField, createWindField } from './render/windField.ts';
export type { WindField } from './render/windField.ts';
export { seaStateForAgitation, seaStateForWind } from './render/seaState.ts';
export type { SeaState } from './render/seaState.ts';
export { InstancedMesh, createInstanceData, writeInstance } from './render/instancedMesh.ts';
/*
 * The instanced *mesh* surface, which is not the scatter above it: a scatter owns its own base
 * geometry and carries a scale, a yaw and a wind response, because it describes a plant. These
 * attach to a mesh the consumer already uploaded and carry a full transform, because a vehicle
 * pitches and rolls and a yaw cannot say so.
 */
export {
  createMeshInstances,
  packInstances,
  INSTANCE_FLOATS,
  INSTANCE_STRIDE,
} from './render/instances.ts';
export { ParticlePool } from './render/particlePool.ts';
export type { ParticlePoolOptions, ParticleInstances } from './render/particlePool.ts';
export { ParticleBatch } from './render/particleBatch.ts';
export type {
  ParticleBatchOptions,
  ParticleBlend,
  ParticleFacing,
} from './render/particleBatch.ts';
export {
  PARTICLE_MOTE_FRAG,
  PARTICLE_SMOKE_FRAG,
  PARTICLE_SPARK_FRAG,
  PARTICLE_VERT,
} from './render/shaders/particle.ts';
export { BoltPool } from './render/boltPool.ts';
export type { BoltPoolOptions, BoltSegments, BoltColors } from './render/boltPool.ts';
export { BoltBatch } from './render/boltBatch.ts';
export { createLineSegments, setPolyline } from './render/linePoints.ts';
export type { LineSegments } from './render/linePoints.ts';
export { FlockRenderer } from './render/flockRenderer.ts';
/*
 * Text is reached through the renderer, not constructed.
 *
 * `TextRenderer` is no longer exported: it holds a `WebGL2RenderingContext`, so a caller that
 * built one was a caller pinned to one backend — which is exactly what kept `showroom` off
 * WebGPU. `renderer.createText()` hands back an opaque `TextHandle` and the renderer draws it,
 * the same shape scatter, plumes, particles, flocks and bolts already have. The measuring
 * helpers were statics on the class and are free functions now, because neither needs a device.
 */
export { DEFAULT_TEXT_STYLE, textHeightPx, textWidthPx } from './render/textLayout.ts';
export type { TextStyle } from './render/textLayout.ts';
export {
  GLYPH_HEIGHT,
  GLYPH_SPACING,
  GLYPH_WIDTH,
  countCells,
  forEachCell,
  forEachRun,
  glyphRows,
  hasGlyph,
  measureText,
} from './geometry/pixelFont.ts';
/*
 * SDF text, reached the same way pixel text is: the verbs are on the renderer and the
 * handle is opaque. What a consumer does need in its own hands is the metrics document,
 * because the engine fetches nothing — `setSdfText` takes a parsed font and an atlas the
 * consumer already owns, so a consumer that could not call `parseSdfFont` could not call
 * `setSdfText` either. Phase one shipped the verbs and not this, which made the whole
 * capability unreachable through the barrel; `demo/dev/sdf-text.ts` was reaching two
 * directories deeper to work around it.
 */
export { parseSdfFont } from './render/sdfFont.ts';
export type { SdfFont, SdfGlyph } from './render/sdfFont.ts';
export { DEFAULT_SDF_TEXT_STYLE, SdfTextLayout } from './render/sdfTextLayout.ts';
export type { SdfTextStyle } from './render/sdfTextLayout.ts';
export { WindStreakRenderer } from './render/windStreakRenderer.ts';
export type { WindStreakOptions } from './render/windStreakRenderer.ts';
export type { FlockParams } from './render/flockRenderer.ts';
export { buildTree } from './geometry/treeBuilder.ts';
export type { TreeParams, TreeGeometry } from './geometry/treeBuilder.ts';
export type { InstanceData } from './render/instancedMesh.ts';
export type { MeshInstances } from './render/instances.ts';
export type { WindProfile, WindState } from './render/wind.ts';

/*
 * Large worlds: the cell grid that streams and freezes, and the origin that rendering rebases
 * against while the simulation never does. See `world/rebase.ts` for why that asymmetry is the
 * rule the whole design hangs on.
 */
export {
  cellBounds,
  cellCoord,
  cellCoordInRange,
  cellCoordsOf,
  cellIdFor,
  cellIdFrom,
  cellsInFrustum,
  cellsInRadius,
  createCellGrid,
} from './world/cell.ts';
export type { CellGrid } from './world/cell.ts';
export { renderOrigin, toRenderSpace, toWorldSpace } from './world/rebase.ts';
export {
  cameraPositionFrom,
  cellPredictor,
  createCellStream,
  pumpCellStream,
  setCellStreamOrigin,
} from './world/cellStream.ts';
export type { CellStore, CellStream, CellStreamOptions } from './world/cellStream.ts';
export {
  createFrozenCells,
  freezeCell,
  frozenEntities,
  frozenFingerprintContribution,
  isCellFrozen,
  thawCell,
} from './world/freeze.ts';
export type { FreezableWorld, FrozenCell, FrozenCells } from './world/freeze.ts';
