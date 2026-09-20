/**
 * The GPU-driven frame, as commands on a real encoder.
 *
 * **Every stage this runs already existed, twice.** `gpudriven/*.ts` is the arithmetic in
 * TypeScript, `shaders/gpudriven/*.wgsl.ts` is the same arithmetic in WGSL, and
 * `scripts/gpu-parity.mjs` runs both over generated input on a real device until they agree —
 * nine checks as this was written. `gpudriven/pipeline.ts` says what each stage reads and writes, as
 * frame-graph edges, and **the frame is scheduled by it**: each `prepare` records the stages,
 * `scheduleGraph` keeps the ones something reads, and this encodes those in the order kept. What
 * was missing, and what this is, is the encoder: the buffers, the bind groups, the targets and the
 * two indirect draws.
 *
 * **It is a contributed pass, not a branch inside the renderer, and that is the design.**
 * `registerPass` hands a definition a `GPUDevice` at registration and a `GPUCommandEncoder` once a
 * frame before the frame's own render pass opens — which is exactly the window a pipeline that
 * fills its own targets needs, and it is the seam `pass.ts` exists to provide. The alternative is
 * rerouting `drawMesh` through clusters, which would mean a second copy of the standard material
 * to draw anything at all; the plan refuses that in the same words this file does.
 * `createRenderer({ pipeline: 'gpu-driven' })` is the *permission* — it fails at boot on a backend
 * that cannot run this — and this is the implementation. A consumer states both.
 *
 * **What it draws.** Vertex colour times a material tint, one directional term with its specular
 * highlight and its shadow, the forward path's hemispheric ambient or a baked probe's irradiance,
 * the room a surface reflects, metalness, a glow scaled by the frame's clock, and DriftTexture
 * materials decoded per pixel — the standard material's subset, which `CAPABILITIES.md` §3 lists
 * with what it leaves out. The rigs that draw it are `DRAFT_SCENES`, never `SCENES`.
 *
 * **A mesh wholly outside the view is dropped before the cut reads a cluster of it**, since
 * 2026-09-17: `instanceCull` flags each mesh against the frustum, the cut leaves a flagged mesh's
 * clusters unselected, and the cluster cull skips whatever the cut did not select. `instances.ts`
 * says why the flag is read there and not by the cluster cull: eight storage bindings a stage, and
 * the cluster cull already had seven.
 *
 * **The shadow is this pipeline's own, and it costs what it costs.** One depth-only draw of every
 * cluster from the light, into a 2048 map: **0.46 ms** on a million triangles, which is nearly as
 * much again as the frame itself. There is no culling in it — the frame's cull is against the
 * camera and a caster behind the viewer still shadows what is in front of them — so the obvious
 * next measurement is a cull against the light's own box.
 *
 * **The visibility buffer is copied to a buffer once a frame, and that is a real cost.** The
 * binning passes read `array<u32>` and a render attachment cannot be bound as one. The copy is
 * ordered and correct where a fragment shader writing storage is neither — two fragments passing
 * the depth test for one pixel race, and the loser can land last. `width` is rounded up to a
 * multiple of 64 so that `bytesPerRow` is a multiple of 256 with no padding, which is what keeps
 * the buffer linear: a padded row would put undefined words where the binning reads pixels, and
 * an undefined word that happens to be zero is triangle 0 of cluster 0 — a real triangle.
 *
 * **The shading's pixel centre is the flipped row, and this is the one convention trap here.**
 * WebGPU's framebuffer origin is the top-left, so row zero is where clip `y` is `+1`; `screenOf`
 * maps clip `y = +1` to `height`. So the pixel at framebuffer row `y` is at screen `height - y`,
 * and the flip is applied to the pixel rather than to the shared function — which is checked
 * against the reference and must not learn about a framebuffer. Flipping all four points of a
 * barycentric evaluation leaves the weights unchanged, which is why this is the whole of it. It is
 * true of either projection, because it is a property of the viewport transform and not of the
 * matrix.
 *
 * **The projection is `depthCorrection` and not `clipCorrection`.** The Y negation in the latter
 * cancels the one `naga` writes into every *generated* vertex entry point; nothing here was
 * generated, so taking it mirrors the picture — and mirrors the winding with it, which is how it
 * reads as a culling problem. `PassDevice` carries both matrices and says which is which.
 */

import {
  DEPTH_CLEAR,
  DEPTH_COMPARE,
  DEPTH_COMPARE_EQUAL,
  DEPTH_FORMAT,
  SHADOW_DEPTH_CLEAR,
} from '../../depthConvention.ts';
import { DEFAULT_RENDER_QUALITY } from '../../renderQuality.ts';
import { SHADOW_FORMAT } from './depthPass.ts';
import {
  SHADOW_CULL_CORRECTION,
  SHADOW_LOOKUP_CORRECTION,
  SHADOW_RASTER_CORRECTION,
  correctShadowMatrix,
  fitShadow,
  lightConeEye,
} from '../../gpudriven/shadowCamera.ts';
import { DRAW_INDIRECT_WORDS, PHASE_ONE, PHASE_TWO } from '../../gpudriven/compact.ts';
import { BIN_DISPATCH_WORDS, BIN_GROUP_SIZE } from '../../gpudriven/materialBin.ts';
import { CLUSTER_INDEX_CAP } from '../../gpudriven/indirect.ts';
import { FRUSTUM_FLOATS, frustumPlanes } from '../../gpudriven/frustum.ts';
import { VIS_EMPTY } from '../../gpudriven/visbuffer.ts';
import { jitterClip } from '../../recon/jitter.ts';
import {
  GPU_DRIVEN_ORDERED,
  GPU_DRIVEN_PASSES,
  GPU_DRIVEN_RESOURCES,
  gpuDrivenLive,
  gpuDrivenRefusal,
  gpuDrivenSupported,
  recordGpuDrivenStages,
} from '../../gpudriven/pipeline.ts';
import type { GpuDrivenFrameShape, GpuDrivenPassName } from '../../gpudriven/pipeline.ts';
import { createDeps, resetDeps } from '../../frame/deps.ts';
import { createGraphPasses, createGraphScratch, scheduleGraph } from '../../frame/graphSchedule.ts';
import { hzbMipCount, hzbMipSize } from '../../gpudriven/hzb.ts';
import {
  CULL_CLUSTERS_WGSL,
  CULL_CONES,
  CULL_INSTANCES_WGSL,
  CULL_SETTINGS_FLOATS,
  HZB_REDUCE_WGSL,
  HZB_SEED_WGSL,
  LOD_CUT_WGSL,
  SHADOW_HZB_SEED_WGSL,
} from '../../shaders/gpudriven/cull.wgsl.ts';
import { COMPACT_CLUSTERS_WGSL } from '../../shaders/gpudriven/compact.wgsl.ts';
import {
  MATERIAL_COUNT_WGSL,
  MATERIAL_OFFSETS_WGSL,
  MATERIAL_SCATTER_WGSL,
} from '../../shaders/gpudriven/materialBin.wgsl.ts';
import { MEDIUM_FOG, type FogOptions } from '../../fog.ts';
import { MATERIAL_SLOTS } from '../../shaders/gpudriven/materialTable.wgsl.ts';
import { SHADE_MATERIAL_WGSL } from '../../shaders/gpudriven/shade.wgsl.ts';
import {
  GPU_DRIVEN_BLIT_DEPTH_WGSL,
  GPU_DRIVEN_BLIT_WGSL,
} from '../../shaders/gpudriven/present.wgsl.ts';
import { StreamingScene, type GeometrySink } from '../../gpudriven/streamScene.ts';
import { VISBUFFER_RASTER_WGSL } from '../../shaders/gpudriven/visbufferRaster.wgsl.ts';
import { BLEND_RASTER_WGSL, BLEND_RESOLVE_WGSL } from '../../shaders/gpudriven/blendRaster.wgsl.ts';
import { GPU_DRIVEN_VERTEX_FLOATS } from '../../gpudriven/sceneUpload.ts';
import {
  GPU_DRIVEN_MATERIAL_FLOATS,
  collectPrograms,
  writeMaterialTable,
  type GpuDrivenTextures,
  type MaterialPrograms,
} from '../../gpudriven/materialTable.ts';
import { packDecodeTables, type DecodeTables } from '../../gpudriven/decodeTables.ts';
import { DECODE_NODES_BYTES, DECODE_WEIGHTS_BYTES } from '../../shaders/gpudriven/decode.wgsl.ts';
import type {
  PassContext,
  PassDefinition,
  PassDevice,
  PassEnvironment,
  PrepareContext,
} from '../../pass.ts';

/* Bit values rather than the globals, which Node does not define — every `createTexture` in this
   backend already does the same, so a module can be imported by a test that never sees a GPU. */
const COPY_SRC = 0x0004;
/* A texture's copy bit is not a buffer's: 0x01 against 0x0004, and using the buffer's here reads
   as TEXTURE_BINDING, which is a usage the texture already had. The device caught it. */
const TEXTURE_COPY_SRC = 0x01;
/* And the same again for copying in: 0x02 on a texture, where the buffer's 0x0008 is
   STORAGE_BINDING. The latent array's upload was refused over it; textureUsage.test.ts holds it. */
const TEXTURE_COPY_DST = 0x02;
const COPY_DST = 0x0008;
const UNIFORM = 0x0040;
const STORAGE = 0x0080;
const INDIRECT = 0x0100;
const TEXTURE_BINDING = 0x04;
const STORAGE_BINDING = 0x08;
const RENDER_ATTACHMENT = 0x10;
const QUERY_RESOLVE = 0x0200;
const MAP_READ = 0x0001;

/** The jitter of a frame that is not reconstructed, until `prepare` is handed the frame's own. */
const NO_JITTER = new Float32Array(2);
const MAP_MODE_READ = 0x0001;

/**
 * Floats a material owns: tint rgb, emissive, roughness, specular, reflectivity, metalness.
 *
 * Five blocks since 2026-09-17 — the three texture programs, the UV scale and the map strengths
 * joined the eight — and `gpudriven/materialTable.ts` writes them.
 */
export const MATERIAL_FLOATS = GPU_DRIVEN_MATERIAL_FLOATS;

/** Floats a vertex in the one interleaved buffer: position, normal, colour, uv. */
export const VERTEX_FLOATS = GPU_DRIVEN_VERTEX_FLOATS;

/**
 * Floats the shading pass's frame block holds. Matches `FRAME_BLOCK_WGSL`'s `Frame`.
 *
 * Two matrices and fifteen vectors: the camera's, the light's, then the eye, the light's direction
 * and colour, the sky, the ground, the target's size, the shadow's settings in two, the probe's in
 * two, the medium's four, and the visibility buffer's row.
 */
const FRAME_FLOATS = 92;

/** Where each block starts in it, so the writer and the shader cannot drift apart. */
const FRAME_LIGHT_VIEW_PROJ = 16;
const FRAME_EYE = 32;
const FRAME_LIGHT_DIR = 36;
const FRAME_LIGHT_COLOUR = 40;
const FRAME_SKY = 44;
const FRAME_GROUND = 48;
const FRAME_SIZE = 52;
const FRAME_SHADOW = 56;
const FRAME_SHADOW_LIMITS = 60;
const FRAME_ENVIRONMENT = 64;
const FRAME_ENVIRONMENT_MIX = 68;
const FRAME_FOG_COLOUR = 72;
const FRAME_FOG_UNDERWATER = 76;
const FRAME_FOG_HEIGHT = 80;
const FRAME_FOG_RANGE = 84;
const FRAME_PITCH = 88;

/**
 * Pixels the internal width is rounded up to.
 *
 * `copyTextureToBuffer` wants `bytesPerRow` to be a multiple of 256, and a visibility texel is
 * four bytes — so a width that is a multiple of 64 needs no padding and the buffer stays linear.
 * See the header for why a padded row is not merely wasteful.
 */
const WIDTH_ALIGN = 64;

/** What a frame must leave behind: the colour the blit presents and the history phase one reads. */
const FRAME_LIVE = gpuDrivenLive(GPU_DRIVEN_RESOURCES);

/** Identifiers one frame's graph can name, which sizes the scheduler's working set once. */
const FRAME_IDENTIFIERS = Object.keys(GPU_DRIVEN_RESOURCES).length;

/** Floats a pyramid level is aligned to, so a level's byte offset is 256-aligned. */
const LEVEL_ALIGN = 64;

/**
 * The two weighted-transparency targets' formats, which are `flatPass.ts`'s `oitTarget`'s.
 *
 * Sixteen-bit float for the accumulation because it holds a weighted sum that runs to thousands,
 * and one byte for the revealage because it holds a product of numbers between zero and one.
 */
const OIT_ACCUM_FORMAT: GPUTextureFormat = 'rgba16float';
const OIT_REVEAL_FORMAT: GPUTextureFormat = 'r8unorm';

/**
 * The strides a streamed upload writes at, which are `StreamingScene`'s own.
 *
 * Named here rather than imported so the two files can be read side by side; `streamScene.ts`
 * carries the same three and `gpuDrivenPass.test.ts` asserts the buffers are sized by them.
 */
const STREAM_CULL_FLOATS = 8;
const STREAM_LOD_FLOATS = 6;
const STREAM_META_WORDS = 4;

/**
 * What the frame is timed in, one pair of timestamps each.
 *
 * **Measured rather than reasoned, because the whole wave rests on a cost claim.** A frame-time
 * reading from `requestAnimationFrame` measures the submission loop and nothing else — with vsync
 * off it reports half a millisecond for a scene of a million triangles, because the device is
 * still working when the callback returns. These are the device's own clock.
 *
 * Only where the device has `timestamp-query`, which `createRenderer` asks for when
 * `quality.gpuTiming` is set — `?gputiming=1` on the harness pages. Without it every figure is
 * `null`, which is `gpuTimer.ts`'s rule: zero is a claim and unmeasured is not zero.
 */
export const GPU_DRIVEN_STAGES = [
  'shadow',
  'instanceCull',
  'cut',
  'phaseOneDraw',
  'pyramid',
  'phaseTwoCull',
  'phaseTwoDraw',
  'blendCull',
  'blendDraw',
  'blendResolve',
  'bin',
  'shade',
] as const;

export type GpuDrivenStage = (typeof GPU_DRIVEN_STAGES)[number];

/**
 * The frame's four draw lists, each counted by the clusters it drew: phase one (what was visible
 * last frame and still is), phase two (what the pyramid found newly visible), the blended half, and
 * the light's map.
 *
 * **The occlusion cull's own figure.** A cluster the cull kept is one instance of its list's
 * indirect draw, so the second word of each list's arguments is that list's count — the number a
 * city in a street and above its roofs is there to show. Read back only where `countDrawn` asks.
 */
export const GPU_DRIVEN_LISTS = ['phaseOne', 'phaseTwo', 'blend', 'shadow'] as const;

export type GpuDrivenList = (typeof GPU_DRIVEN_LISTS)[number];

/** What a material tints and emits. */
export interface GpuDrivenMaterial {
  readonly tint: readonly [number, number, number];
  /** Added to the lit colour as `albedo * emissive`. Zero for an ordinary surface. */
  readonly emissive: number;
  /**
   * 0 is a mirror and 1 is fully rough. Defaults to 1, which is the matte this pipeline had.
   *
   * **Below 0.1 the highlight gets *dimmer* as the surface gets smoother**, which is the forward
   * path's own lobe and is recorded in `docs/IMPROVEMENTS.md` rather than fixed here — the
   * published scenes are calibrated against the shader that has it.
   */
  readonly roughness?: number;
  /**
   * How much of the light the surface returns as a highlight. Defaults to 0.
   *
   * **Zero is what keeps this from moving anything**: a material that says nothing about shininess
   * renders exactly the frame it rendered when the lit expression was four lines.
   */
  readonly specular?: number;
  /**
   * How much of the environment the surface returns, before angle and roughness. Defaults to 0.
   *
   * With no probe bound this reflects the same two-colour gradient the ambient comes from, which
   * is what the forward path reflects in the same situation — see `gpudriven/ibl.ts` for the two
   * weights and why the selector between them is exactly 0 or exactly 1.
   */
  readonly reflectivity?: number;
  /**
   * 0 is a dielectric and 1 is a metal. Defaults to 0.
   *
   * **One number a material, where `flat/main.ts` reads one texel of an ORM map.** That is the
   * whole of the difference and it is a subset rather than a second opinion: every expression it
   * enters is the forward path's with a constant standing in for a fetch. See `gpudriven/lit.ts`
   * for the four of them.
   *
   * **A metal reflects whether or not `reflectivity` asked for it**, because a metal is nothing but
   * its reflection — and with no probe bound, what it reflects is the sky-and-ground gradient. A
   * metal in a scene with neither is a smooth gradient rather than a picture, which is a statement
   * about the scene rather than about the material.
   */
  readonly metalness?: number;
  /**
   * The material's maps, as DriftTexture decode programs, decoded per shaded pixel on the device.
   *
   * **A material with none uploads exactly the entry it uploaded before textures existed**, so the
   * frame it draws is unchanged — the promise every term in this pipeline makes. See
   * `gpudriven/materialTable.ts` for what each program feeds and `decodeTables.ts` for the limits.
   */
  readonly textures?: GpuDrivenTextures;
  /**
   * Discard a fragment whose base-colour alpha is below this. Zero means no test.
   *
   * **The test happens in the raster rather than in the shading pass**, because that is where a
   * pixel learns which triangle owns it: a discard in `shade` would come after the visibility
   * buffer already held the leaf, and what stood behind it was never written.
   *
   * Zero is the default and it skips the fetch outright, so a material that says nothing about
   * cutout draws exactly the frame it drew before — the promise every term in this pipeline has
   * made since it was four lines. A cluster carries one material, so the branch is coherent across
   * every fragment of a draw rather than divergent within one.
   *
   * **It needs a `textures.baseColour` program to mean anything.** With no base-colour map there is
   * no alpha to test, and the raster reads 1 — so a cutoff at or below 1 keeps every fragment and
   * one above 1 discards the whole surface. Both are what the material asked for, stated here
   * because an invisible mesh is a hard thing to attribute.
   */
  readonly alphaCutoff?: number;
  /**
   * Draw this material's clusters blended instead of into the visibility buffer. Defaults to false.
   *
   * **A visibility buffer stores one surface a pixel, so it cannot hold a blend at all** — that is
   * architecture rather than an omission. What a blended material asks for is that its clusters
   * skip the opaque half entirely and be drawn again by a second raster that shades in its own
   * fragment stage and writes the two weighted-transparency targets. The cut runs a second time to
   * find them, and a scene with no blended material runs neither stage.
   *
   * **The opacity is `tint`'s fourth component, not this**; this only says which half of the frame
   * the surface belongs to. See `blendRaster.wgsl.ts` for what the second half does with it, and
   * `orderIndependent.ts` for the weight and what it approximates.
   */
  readonly blend?: boolean;
  /**
   * How much of a blended surface is its own colour rather than what is behind it. Defaults to 1.
   *
   * Read only where `blend` is set. One is a solid pane, which is what a material that asked to
   * blend and said nothing else gets — visible, and therefore findable.
   */
  readonly opacity?: number;
}

/** What the pass needs told once a frame, before `beginFrame`. */
export interface GpuDrivenView {
  /** The camera's view-projection, built the way the forward path builds one. */
  readonly viewProj: ArrayLike<number>;
  readonly eye: readonly [number, number, number];
  /** Toward the light, normalised, as `Environment.directionalDir` is. */
  readonly lightDir: readonly [number, number, number];
  readonly lightColour: readonly [number, number, number];
  readonly ambient: readonly [number, number, number];
  readonly ambientGround: readonly [number, number, number];
  /**
   * The medium between the camera and everything this pass draws. Absent is no fog at all.
   *
   * **Absent means a density of zero and the medium mode**, which makes `mediumFog` exactly zero at
   * every distance — arithmetically the frame this pipeline drew before it had a haze, which is the
   * promise every term here has made since it was four lines. The three rigs pass nothing.
   *
   * **It is the same expression the forward path fogs with**, held to `render/fog.ts` by
   * `scripts/gpu-parity.mjs`; a scene drawing through both pipelines at once — which is what the
   * voxel sandbox's port is — would otherwise have its terrain recede at a different rate than its
   * mobs do.
   */
  readonly fog?: FogOptions;
  /**
   * The projected error a cluster may carry before its children are drawn instead, in pixels.
   *
   * Larger keeps coarser clusters and draws fewer triangles. `lodCut.ts` is what reads it.
   */
  readonly lodThreshold: number;
  /** The vertical field of view in radians, which the cut needs to project an error. */
  readonly fovY: number;
  /**
   * How much of the directional light the shadow map may take away. 0 is off and 1 is the whole
   * of it.
   *
   * **Off is exact rather than nearly**: `shadowFactor` returns 1 before any arithmetic at zero,
   * so a frame that asks for none is the frame this pipeline drew before it had a map. Defaults
   * to 1, because a pipeline that renders a map and then ignores it is a cost with no picture.
   */
  readonly shadowStrength?: number;
  /**
   * The simulation's clock, in seconds, which an animated DriftTexture reads. **Never a wall
   * clock**: a flipbook read off one would replay differently. Defaults to 0.
   */
  readonly time?: number;
  /**
   * The frame's emissive gain and night factor, as `Environment` carries them. **Both default to
   * 1**, which is the glow this pipeline drew before it read either.
   *
   * `flat/main.ts` scales every emission by their product, so a forward frame whose clock says it
   * is day glows nowhere. A caller drawing both pipelines from one `Environment` passes its two
   * numbers here, or the second pipeline glows where the first does not.
   */
  readonly emissiveGain?: number;
  readonly nightFactor?: number;
}

/**
 * What the pass is told once, at construction, about the map it renders.
 *
 * **Its own defaults rather than a `RenderQuality`**, because a contributed pass is handed a
 * device and not the frame's settings — `PassDevice` is the whole of what it gets. The numbers are
 * the forward path's, taken from `DEFAULT_RENDER_QUALITY` so the two pipelines fade a shadow out
 * over the same distance and give up on the same low sun rather than nearly.
 */
export interface GpuDrivenShadowOptions {
  /** Texels a side. 2048 is `directionalShadowMapSize`, and a draft can afford it. */
  readonly mapSize?: number;
  /** Metres a shadow travels along the ground before it has dissolved. */
  readonly maxDistance?: number;
  /** The steepest sun that still casts, as horizontal metres per vertical one. */
  readonly maxSlope?: number;
  /** Taps of the twelve the filter may take. Fewer is cheaper and harder-edged. */
  readonly taps?: number;
  /**
   * Hand the frame this pass's depth as well as its colour, so both pipelines share one.
   *
   * **Off by default, because every consumer before 2026-09-18 drew nothing but this pipeline.**
   * For them the frame's depth is something nothing reads and a write into it is a change to a
   * frame they did not ask to change; the three GPU-driven rigs leave it alone, which is what keeps
   * them 0 of 921,600 and keeps them the control.
   *
   * **On, it is what lets a forward-path mesh stand behind GPU-driven geometry.** Without it the
   * two have no depth relationship at all and no ordering of them produces one — which is the gap
   * the voxel sandbox's port found, where mobs, particles, falling blocks and the block highlight
   * all draw on the forward path. `scripts/depth-share-check.mjs` is the gate.
   *
   * It costs one more sampled texture in the blit and a fragment depth write over the pixels this
   * pipeline covered. A pixel it did not cover is discarded before either, so the sky keeps the
   * depth the frame already had.
   */
  readonly presentDepth?: boolean;
  /**
   * Metres around the eye the map covers once the scene is larger than that. See `fitShadow`.
   *
   * **Unset, the map is fitted to the whole scene, as it always was** — right for rigs a few
   * metres across and the fit all three were photographed with. A world sets it: the voxel
   * sandbox's port at radius 14 is a sphere hundreds of metres across, over which one map has
   * texels a quarter of a metre wide. Past the radius the map follows the eye, snapped to whole
   * texels, and reaches toward the sun as far as the scene does.
   */
  readonly followRadius?: number;
}

interface Level {
  readonly width: number;
  readonly height: number;
  /** Where this level's texels start in the pyramid buffer, in floats. */
  readonly start: number;
  readonly size: GPUBuffer;
}

/**
 * The pipeline, as one registered pass.
 *
 * Built once at registration, recorded once a frame in `prepare`, and composited in `draw`.
 * `setView` and `resize` are the two things a caller says, and neither allocates on a frame that
 * did not change size.
 */
/**
 * Refuse, by name, a storage buffer the device cannot bind whole.
 *
 * **A buffer that can be created is not a buffer that can be bound**: `maxBufferSize` and
 * `maxStorageBufferBindingSize` are two limits, and every buffer here is bound whole. Past the
 * second, what a device answers is an invalid bind group — a warning a frame, a hundred frames,
 * and a scene that is simply absent, with nothing naming the capacity that caused it. The voxel
 * sandbox's port at a radius of ten did exactly that. `select.ts` asks the adapter for all the
 * binding it offers; this is what a device that offers too little says.
 */
/**
 * What a buffer's size comes from, which is what a refusal tells the caller to make smaller: most
 * are the scene's declared capacity, the targets are the frame's pixels, and the light's pyramid is
 * its map.
 */
const SIZED_BY = {
  capacity: "The scene's declared capacity sizes it: a smaller capacity fits",
  frame: "The frame's size sizes it: a smaller frame fits",
  map: "The shadow map's size sizes it: a smaller mapSize fits",
} as const;

type SizedBy = keyof typeof SIZED_BY;

function bindable(
  device: GPUDevice,
  label: string,
  bytes: number,
  sizedBy: SizedBy = 'capacity',
): void {
  const ceiling = (device.limits as Partial<GPUSupportedLimits> | undefined)
    ?.maxStorageBufferBindingSize;
  if (typeof ceiling === 'number' && bytes > ceiling) {
    throw new Error(
      `[driftengine] the gpu-driven ${label} needs ${bytes} bytes bound at once, and this device ` +
        `binds at most ${ceiling}. ${SIZED_BY[sizedBy]}, or an adapter that offers a larger ` +
        `maxStorageBufferBindingSize.`,
    );
  }
}

/**
 * The two buffers a streaming scene writes its geometry into, as the scene sees them.
 *
 * **The scene keeps no copy of its vertices and indices**, so this is where they live: written
 * when a mesh is placed, from a scratch array the scene reuses, which `queue.writeBuffer` copies
 * before it returns. Offsets and sizes are whole records, so always whole multiples of four bytes.
 */
function geometrySink(queue: GPUQueue, indices: GPUBuffer, vertices: GPUBuffer): GeometrySink {
  return {
    writeVertices(firstVertex, rows, count) {
      queue.writeBuffer(vertices, firstVertex * VERTEX_FLOATS * 4, rows, 0, count * VERTEX_FLOATS);
    },
    writeIndices(firstIndex, values, count) {
      queue.writeBuffer(indices, firstIndex * 4, values, 0, count);
    },
  };
}

export class GpuDrivenPass implements PassDefinition {
  readonly label = 'driftengine.gpu-driven';

  private readonly scene: StreamingScene;
  private readonly materials: readonly GpuDrivenMaterial[];

  private device: GPUDevice | null = null;
  private width = 0;
  private height = 0;
  /** The width the targets are actually allocated at: `width` rounded up. See `WIDTH_ALIGN`. */
  private stride = 0;

  private readonly frameParams = new Float32Array(FRAME_FLOATS);
  private readonly planes = new Float32Array(FRUSTUM_FLOATS);
  /** The light's box as six planes, from the matrix the lookup reads. */
  private readonly lightPlanes = new Float32Array(FRUSTUM_FLOATS);
  private readonly cullSettings = new Float32Array(CULL_SETTINGS_FLOATS);
  private readonly lodParams = new Float32Array(7);
  private readonly binSettings = new Uint32Array(4);
  private readonly viewProj = new Float32Array(16);
  private readonly corrected = new Float32Array(16);
  /** The light's own, in the OpenGL convention, and the two corrections of it. */
  private readonly light = new Float32Array(16);
  private readonly lightRaster = new Float32Array(16);
  private readonly lightLookup = new Float32Array(16);
  /** The scene's bounding sphere, computed once: centre and radius. */
  private readonly bounds = new Float32Array(4);
  /** Which programs each material names, and the programs themselves, once each. */
  private readonly programs: MaterialPrograms;
  /** Those programs flattened into what the shading pass binds. */
  private readonly decode: DecodeTables;
  /**
   * Every cluster's bounds, cone and error **through the transform of the mesh it belongs to**.
   *
   * Computed at construction and held, because it is what both the cull buffer and the LOD buffer
   * are written from and what the light's box is fitted to — one transform, read three times. This
   * pipeline never moves a mesh, so it is a property of the scene; a pipeline that did would have
   * to rewrite these two buffers on the frame it moved one.
   */
  /**
   * Each mesh's world sphere, round its clusters' world spheres — `instances.ts`. Fitted here
   * rather than at mount so a cluster naming a mesh the transforms do not have is refused where the
   * scene was handed in.
   */
  private readonly meshCount: number;
  private shadowSpan = 1;
  private readonly shadowSize: number;
  /** What the frame offered this time, or null. Read in `writeFrame` and nowhere else. */
  private environment: PassEnvironment | null = null;
  private readonly shadowMaxDistance: number;
  private readonly shadowMaxSlope: number;
  private readonly shadowTaps: number;
  private clipCorrection: Float32Array | null = null;
  private view: GpuDrivenView | null = null;

  /* Static, uploaded once. */
  private clusterCull: GPUBuffer | null = null;
  private clusterLod: GPUBuffer | null = null;
  private clusterMeta: GPUBuffer | null = null;
  private instanceSpheres: GPUBuffer | null = null;
  private indices: GPUBuffer | null = null;
  private vertices: GPUBuffer | null = null;
  private transformBuffer: GPUBuffer | null = null;
  private materialOf: GPUBuffer | null = null;
  private materialTable: GPUBuffer | null = null;
  private jobs: GPUBuffer | null = null;
  /**
   * **The light's own front half, in the camera's two phases**: the camera's cut with no mesh
   * hidden, a cull against the light's box from the sun's side, and a compaction into the list each
   * half of the map draws — phase one what the light kept last frame, phase two the rest against a
   * pyramid of what phase one drew. Every buffer the light writes is its own. See `drawShadow`.
   */
  private shadowList: GPUBuffer | null = null;
  private shadowListTwo: GPUBuffer | null = null;
  private shadowArgs: GPUBuffer | null = null;
  private shadowArgsTwo: GPUBuffer | null = null;
  private shadowSelected: GPUBuffer | null = null;
  private shadowKeep: GPUBuffer | null = null;
  private shadowPlanes: GPUBuffer | null = null;
  private shadowCullSettings: GPUBuffer | null = null;
  private shadowCullSettingsTwo: GPUBuffer | null = null;
  /**
   * The light's cull settings: its cone eye, stood `LIGHT_CONE_DISTANCE` toward the sun from the
   * camera's (`lightConeEye`), whether to read the pyramid, the pyramid's shape, the count and the
   * cones, which are on. One array, written into phase one's buffer and then phase two's.
   */
  private readonly shadowCullValues = new Float32Array(CULL_SETTINGS_FLOATS);
  private readonly shadowConeEye: [number, number, number] = [0, 0, 0];
  private shadowCompactSettings: GPUBuffer | null = null;
  private shadowCompactSettingsTwo: GPUBuffer | null = null;
  /**
   * **The light's history, one word a cluster, in two halves that swap each frame the map is
   * drawn** — and only then, so a frame with no shadow leaves the next one reading what the last
   * one wrote. One history per view, as `twoPhase.ts` says: the camera's would put what the camera
   * saw into the light's phase one.
   */
  private shadowHistories: [GPUBuffer, GPUBuffer] | null = null;
  private shadowFlipped = false;
  /**
   * The light's pyramid: half its map and every level below it (`shadowPyramidBase`), stored
   * turned over so the camera's reduction and cull read it, and where each level starts.
   */
  private shadowHzb: GPUBuffer | null = null;
  private shadowLevels: Level[] = [];
  private shadowLevelStart: GPUBuffer | null = null;
  private shadowSeedSize: GPUBuffer | null = null;
  /** The raster's matrix with its depth turned over, which is what the light's cull projects by. */
  private shadowCullMatrix: GPUBuffer | null = null;
  private readonly lightCull = new Float32Array(16);
  private instanceNone: GPUBuffer | null = null;
  private shadowLodGroup: GPUBindGroup | null = null;
  private shadowCullGroups: [GPUBindGroup, GPUBindGroup] | null = null;
  /** Each half's compaction, for each way round the history is: `[flipped][phase]`. */
  private shadowCompactGroups: [[GPUBindGroup, GPUBindGroup], [GPUBindGroup, GPUBindGroup]] | null =
    null;
  private shadowSeedGroup: GPUBindGroup | null = null;
  private shadowReduceGroups: GPUBindGroup[] = [];
  private shadowSeedPipeline: GPUComputePipeline | null = null;
  private shadowMatrix: GPUBuffer | null = null;
  private shadowTexture: GPUTexture | null = null;
  private decodeNodes: GPUBuffer | null = null;
  private decodeWeights: GPUBuffer | null = null;
  private latents: GPUTexture | null = null;
  private latentsView: GPUTextureView | null = null;
  private latentClamp: GPUSampler | null = null;
  private latentRepeat: GPUSampler | null = null;
  private shadowView: GPUTextureView | null = null;
  /**
   * What is bound as the probe where the frame has none.
   *
   * **One texel, one layer, and it exists because a bind group must supply every binding.** The
   * alternative is a second pipeline and a second layout for the unlit case, which is two copies
   * of the shading pass to avoid one 4-byte texture. The renderer binds a stand-in in exactly the
   * same situation and for exactly the same reason — see `depthPass.ts` on the peel.
   */
  private emptyEnvironment: GPUTexture | null = null;
  private emptyEnvironmentView: GPUTextureView | null = null;
  private emptySampler: GPUSampler | null = null;
  /** The probe the last frame offered, so the bind group is rebuilt only when it changes. */
  private environmentView: GPUTextureView | null = null;
  private environmentSampler: GPUSampler | null = null;

  /* Per frame. */
  private planesBuffer: GPUBuffer | null = null;
  private viewProjBuffer: GPUBuffer | null = null;
  /**
   * The two numbers the raster's alpha test needs and nothing else in that stage carries.
   *
   * **A buffer of its own rather than four more floats on `viewProjBuffer`**, which the instance
   * cull also binds and declares as `array<f32, 16>`: growing a buffer two shaders read means both
   * have an opinion about what is past the sixteenth float, and one of them would be wrong on the
   * day somebody used the spare.
   */
  private rasterParams: GPUBuffer | null = null;
  /**
   * The transparent half's own buffers, textures and pipelines.
   *
   * **`zeroHistory` is what makes the cut's second run see every cluster.** The compaction
   * filters on `history[i] != 0` against its phase, which is how the two occlusion phases divide
   * the scene between them; the blended set is not divided, so it is compacted as phase one against
   * a history that is all zeros — every cluster then lands on the side that draws. `historySink` is
   * the history that run writes and nothing reads, which is the price of leaving the compaction
   * shader alone rather than growing it a third phase nothing else would ever take.
   */
  private blendList: GPUBuffer | null = null;
  private blendArgs: GPUBuffer | null = null;
  private blendLodBuffer: GPUBuffer | null = null;
  private blendCompactSettings: GPUBuffer | null = null;
  private zeroHistory: GPUBuffer | null = null;
  private historySink: GPUBuffer | null = null;
  private oitAccum: GPUTexture | null = null;
  private oitReveal: GPUTexture | null = null;
  private oitAccumView: GPUTextureView | null = null;
  private oitRevealView: GPUTextureView | null = null;
  private blendPipeline: GPURenderPipeline | null = null;
  /**
   * Whether the device has actually accepted the blend pipeline.
   *
   * **False until it says so, and 4.1.2 had this the wrong way round.** That version built the
   * pipeline, bound a group against its layout, encoded the pass, and disowned the handle when the
   * error scope came back — but a scope comes back on a microtask, after all three. The reporter's
   * next run carried the new warning *and* every error it was meant to prevent: `GetBindGroupLayout`
   * on an invalid pipeline, a bind group against an invalid layout, a `SetPipeline` with it, and a
   * refused submit.
   *
   * Nothing touches the handle until this is true. The cost is no transparency for the frames
   * before the device answers, which nobody sees; the alternative is a frame that draws nothing.
   */
  private blendUsable = false;
  /**
   * The same question about *every other* pipeline in this pass, and the reason it exists is that
   * 4.1.3 asked it about one.
   *
   * **The guard above was written from a log that named `gpu-driven blend`, and the four render
   * pipelines and eight compute pipelines beside it were left with the shape that caused the
   * report.** Reported again from an Android handset once that fix shipped: the transparent pass
   * now skips itself correctly, the overlay still draws and the frame counter still counts — and
   * the world is black, which is what an invalid *opaque* pipeline looks like once the blended one
   * has stopped taking the command buffer with it.
   *
   * So the whole of `buildPipelines` is built inside one pair of scopes and nothing this pass
   * encodes runs until they come back clean. The blend pipeline pushes its own pair *inside* that
   * region, so the two verdicts stay separate: a device that refuses only the transparent pipeline
   * still draws everything opaque, and a device that refuses anything else turns this pass off
   * rather than encoding against a handle the driver has already rejected.
   *
   * **What it gives up** is the first frames, which draw nothing while the device is still
   * answering. **What would make it wrong** is a device that never resolves an error scope; the
   * `popErrorScope` check below is the same concession the blend guard makes, for the same reason.
   */
  private usable = false;
  /** Why this pass refused itself, in the words the device used, or null while it has not. */
  private refusal: string | null = null;
  /** Builds the transparent raster's bindings, held until there is a pipeline worth binding to. */
  private makeBlendGroup: (() => GPUBindGroup) | null = null;
  private blendResolvePipeline: GPURenderPipeline | null = null;
  private blendLodGroup: GPUBindGroup | null = null;
  private blendCompactGroup: GPUBindGroup | null = null;
  private blendRasterGroup: GPUBindGroup | null = null;
  private blendResolveGroup: GPUBindGroup | null = null;
  /** Seven floats: the cut's six, and a seventh saying which half of the frame it is selecting. */
  private readonly lodParamsBlend = new Float32Array(7);
  private readonly rasterParamValues = new Float32Array(4);
  /** One a phase, for the reason `writeFrame` gives. */
  /** Phase one, phase two, and the blended run: see `CULL_CONES` for why the third exists. */
  private cullBuffers: [GPUBuffer, GPUBuffer, GPUBuffer] | null = null;
  private lodBuffer: GPUBuffer | null = null;
  /** One word a mesh, written by the instance cull and read by the cut. */
  private instanceFlags: GPUBuffer | null = null;
  private frameBuffer: GPUBuffer | null = null;
  private selected: GPUBuffer | null = null;
  private keep: GPUBuffer | null = null;
  private history: GPUBuffer | null = null;
  private drawn: GPUBuffer | null = null;
  private lists: [GPUBuffer, GPUBuffer] | null = null;
  private args: [GPUBuffer, GPUBuffer] | null = null;
  private phaseSettings: [GPUBuffer, GPUBuffer] | null = null;

  /* Sized to the target. */
  private visibilityTexture: GPUTexture | null = null;
  private depthTexture: GPUTexture | null = null;
  private colourTexture: GPUTexture | null = null;
  private colourView: GPUTextureView | null = null;
  private visibility: GPUBuffer | null = null;
  private hzb: GPUBuffer | null = null;
  private levelStart: GPUBuffer | null = null;
  private levels: Level[] = [];
  private binCounts: GPUBuffer | null = null;
  private binOffsets: GPUBuffer | null = null;
  private binCursors: GPUBuffer | null = null;
  private binDispatch: GPUBuffer | null = null;
  private binPixels: GPUBuffer | null = null;
  private binSettingsBuffer: GPUBuffer | null = null;

  /* Pipelines. */
  private instancePipeline: GPUComputePipeline | null = null;
  private lodPipeline: GPUComputePipeline | null = null;
  private cullPipeline: GPUComputePipeline | null = null;
  private compactPipeline: GPUComputePipeline | null = null;
  private seedPipeline: GPUComputePipeline | null = null;
  private reducePipeline: GPUComputePipeline | null = null;
  private countPipeline: GPUComputePipeline | null = null;
  private offsetsPipeline: GPUComputePipeline | null = null;
  private scatterPipeline: GPUComputePipeline | null = null;
  private shadePipeline: GPUComputePipeline | null = null;
  private rasterPipeline: GPURenderPipeline | null = null;
  private shadowPipeline: GPURenderPipeline | null = null;
  private blitPipeline: GPURenderPipeline | null = null;
  /** See `GpuDrivenShadowOptions.presentDepth`: what the consumer asked for. */
  private readonly presentDepthAsked: boolean;
  /**
   * Whether the blit hands the frame this pass's depth: when asked, and whenever the renderer
   * reconstructs, which reprojects every pixel's history through that depth. Settled at `init`,
   * where the device says which; the pipeline follows it.
   */
  private presentDepth = false;
  /**
   * The frame's jitter, as `prepare` was last handed it: zero until then, and on every frame that
   * is not reconstructed. See `PrepareContext.jitter`.
   */
  private jitter: ArrayLike<number> = NO_JITTER;
  /** See `GpuDrivenShadowOptions.followRadius`. Unset, the map is fitted to the whole scene. */
  private readonly shadowFollow: number | undefined;
  private frameDepthFormat: GPUTextureFormat | null = null;

  /* Bind groups that outlive a resize. */
  private lodGroup: GPUBindGroup | null = null;
  private instanceGroup: GPUBindGroup | null = null;
  private compactGroups: [GPUBindGroup, GPUBindGroup] | null = null;
  private rasterGroups: [GPUBindGroup, GPUBindGroup] | null = null;
  private shadowGroup: GPUBindGroup | null = null;
  private shadowGroupTwo: GPUBindGroup | null = null;
  private jobGroups: GPUBindGroup[] = [];

  /* Bind groups rebuilt on resize. */
  private cullGroups: [GPUBindGroup, GPUBindGroup, GPUBindGroup] | null = null;
  private seedGroup: GPUBindGroup | null = null;
  private reduceGroups: GPUBindGroup[] = [];
  private countGroup: GPUBindGroup | null = null;
  private offsetsGroup: GPUBindGroup | null = null;
  private scatterGroup: GPUBindGroup | null = null;
  private shadeGroup: GPUBindGroup | null = null;
  private blitGroup: GPUBindGroup | null = null;

  /* The device's own clock. Null everywhere when the feature was not granted. */
  private queries: GPUQuerySet | null = null;
  private queryResolve: GPUBuffer | null = null;
  private queryRead: GPUBuffer | null = null;
  private queryCopied = false;
  private queryMapping = false;
  private readonly stageMs = new Float64Array(GPU_DRIVEN_STAGES.length);
  private timed = false;

  /**
   * **Whether phase two and the blended run test clusters against the depth pyramid** — the
   * occlusion cull — **and the light's second half against its own.** On by default and off only
   * to measure it: the instance cull is the frustum alone and phase one never reads a pyramid, so
   * with this off each view draws every cluster its frustum and cones keep, and the drawn count's
   * difference is the occlusion cull's own share. The pyramids are still built; a frame that
   * measures does not also save their cost.
   */
  occlusion = true;

  /**
   * **Whether the pass reads back how many clusters each list drew.** Off, it encodes nothing for
   * it and makes no buffer, which is why it is asked for rather than always on: the figure is a
   * demo's readout and a measurement's, and a consumer who reads neither pays nothing.
   */
  countDrawn = false;
  /* The four counts' copy, made the first frame one is asked for. */
  private counts: GPUBuffer | null = null;
  private countsCopied = false;
  private countsMapping = false;
  /* A word a list, and the map's second half beside its first. */
  private readonly drawnCounts = new Uint32Array(GPU_DRIVEN_LISTS.length + 1);
  private counted = false;

  /** Whether `history` and `drawn` have been swapped an odd number of times. */
  private flipped = false;

  /*
   * **This frame's graph**, recorded and scheduled every `prepare` and allocated once here: twelve
   * nodes and the identifiers `GPU_DRIVEN_RESOURCES` names. `shape` is written in place for the
   * same reason.
   */
  private readonly graph = createDeps(GPU_DRIVEN_PASSES.length, 64);
  private readonly scheduled = createGraphPasses(GPU_DRIVEN_PASSES.length);
  private readonly graphScratch = createGraphScratch(GPU_DRIVEN_PASSES.length, FRAME_IDENTIFIERS);
  private readonly shape: { shadowed: boolean; blended: boolean } & GpuDrivenFrameShape = {
    shadowed: true,
    blended: false,
  };
  private gradeWarned = false;

  constructor(
    scene: StreamingScene,
    materials: readonly GpuDrivenMaterial[],
    shadow: GpuDrivenShadowOptions = {},
  ) {
    if (materials.length > MATERIAL_SLOTS) {
      throw new Error(
        `[driftengine] the gpu-driven pass holds ${MATERIAL_SLOTS} materials and was given ` +
          `${materials.length}. See MATERIAL_SLOTS in shade.wgsl.ts for why it is a fixed table.`,
      );
    }
    /*
     * **Packed at construction so a program past a limit is refused where it was handed in**,
     * with the limit in the message, rather than at the first frame on a device.
     */
    this.programs = collectPrograms(materials);
    this.decode = packDecodeTables(this.programs.programs);
    this.scene = scene;
    this.materials = materials;
    this.shadowSize = shadow.mapSize ?? DEFAULT_RENDER_QUALITY.directionalShadowMapSize;
    this.shadowMaxDistance =
      shadow.maxDistance ?? DEFAULT_RENDER_QUALITY.directionalShadowMaxDistance;
    this.shadowMaxSlope = shadow.maxSlope ?? DEFAULT_RENDER_QUALITY.directionalShadowMaxSlope;
    this.shadowTaps = shadow.taps ?? DEFAULT_RENDER_QUALITY.shadowFilterTaps;
    this.presentDepthAsked = shadow.presentDepth === true;
    this.shadowFollow = shadow.followRadius;
    /*
     * **The scene's extent, and it moves now.** This used to be computed once here, because the
     * clusters were uploaded at construction and the transforms with them — a box that stood still
     * and shadow edges that stayed put, which `shadowCamera.ts` records the price of. A streaming
     * scene keeps its own bounds and `prepare` refits them when a mesh arrives or leaves, so the
     * box follows the world and its edges crawl. That is a named limitation rather than an
     * oversight: `specs/2026-09-18-gpu-driven-living-scene-design.md` §3.4 says why neither demo
     * this was built for cares, and that cascades are the eventual answer.
     */
    this.meshCount = scene.capacity.meshes;
    scene.sceneBounds(this.bounds);
  }

  /** How many clusters the scene holds, which every per-cluster dispatch is sized by. */
  get clusterCount(): number {
    return this.scene.capacity.clusters;
  }

  /**
   * What this frame is looking at. Called before `beginFrame`, once, by the caller.
   *
   * Held by reference rather than copied: the caller owns a `GpuDrivenView` it fills each frame,
   * and copying it here would allocate on a per-frame path for no gain.
   */
  setView(view: GpuDrivenView): void {
    this.view = view;
  }

  /**
   * Size the targets. Called on mount and whenever the frame's own size changes.
   *
   * **Dispose and recreate rather than resize**, which is `passTarget.ts`'s rule and is right for
   * the same reason: a resize is not a per-frame path and a mutable target is one more thing to
   * keep consistent.
   */
  resize(width: number, height: number): void {
    const wanted = Math.max(1, Math.floor(width));
    const tall = Math.max(1, Math.floor(height));
    if (wanted === this.width && tall === this.height) return;
    this.width = wanted;
    this.height = tall;
    this.stride = Math.ceil(wanted / WIDTH_ALIGN) * WIDTH_ALIGN;
    if (this.device !== null) this.buildTargets(this.device);
  }

  init(device: PassDevice): void {
    if (device.backend !== 'webgpu') {
      /* Loud at registration rather than silent at the first frame: the refusal is the same
         sentence `createRenderer` throws, because it is the same fact about the backend. */
      throw new Error(`[driftengine] ${gpuDrivenRefusal('webgl2')}`);
    }
    if (!gpuDrivenSupported('webgpu'))
      throw new Error(`[driftengine] ${gpuDrivenRefusal('webgpu')}`);
    this.device = device.device;
    /*
     * **The frame's depth format, kept because `buildPipelines` is handed a `GPUDevice`** and a
     * raw device does not know what the frame it belongs to attached. Only read where the depth is
     * actually handed over.
     */
    this.frameDepthFormat = device.depthFormat;
    /*
     * **Handed over under reconstruction whether or not it was asked for.** A pixel of this
     * pipeline's with no depth in the frame reads as the clear — infinitely far — so the resolve
     * never moves its history for a sliding camera, and everything this pass drew trails the
     * picture. The city came back with its windows forty pixels from the native frame.
     */
    this.presentDepth = this.presentDepthAsked || device.reconstruction;
    /*
     * **`depthCorrection`, not `clipCorrection`, and the difference is one negated row.** The Y
     * negation in the other matrix cancels the one `naga` writes into every generated vertex
     * entry point; these shaders are hand-written and carry no such line, so taking it mirrors the
     * picture vertically. See `PassDevice`.
     */
    this.clipCorrection = new Float32Array(device.depthCorrection);
    if (device.device.features.has('timestamp-query')) {
      const pairs = GPU_DRIVEN_STAGES.length * 2;
      this.queries = device.device.createQuerySet({
        label: 'gpu-driven timings',
        type: 'timestamp',
        count: pairs,
      });
      this.queryResolve = device.device.createBuffer({
        label: 'gpu-driven timings resolve',
        size: pairs * 8,
        usage: QUERY_RESOLVE | COPY_SRC,
      });
      this.queryRead = device.device.createBuffer({
        label: 'gpu-driven timings read',
        size: pairs * 8,
        usage: COPY_DST | MAP_READ,
      });
    }
    this.buildBuffers(device.device);
    /*
     * **Every pipeline this pass owns, inside one pair of scopes.** See `usable`: the blend
     * pipeline pushes its own pair within this region, so its refusal stays its own and any other
     * refusal is caught here and turns the pass off instead of reaching an encoder.
     */
    const scoped = typeof device.device.pushErrorScope === 'function';
    if (scoped) {
      device.device.pushErrorScope('validation');
      device.device.pushErrorScope('internal');
    }
    this.buildPipelines(device.device, device.format, device.samples);
    this.watchPipelines(device.device, scoped);
    if (this.width > 0) this.buildTargets(device.device);
  }

  private storage(device: GPUDevice, label: string, data: ArrayBufferView, extra = 0): GPUBuffer {
    const size = Math.max(4, Math.ceil(data.byteLength / 4) * 4);
    bindable(device, label, size);
    const buffer = device.createBuffer({
      label: `gpu-driven ${label}`,
      size,
      usage: STORAGE | COPY_DST | extra,
    });
    device.queue.writeBuffer(buffer, 0, data as unknown as ArrayBufferView);
    return buffer;
  }

  private empty(
    device: GPUDevice,
    label: string,
    bytes: number,
    extra = 0,
    sizedBy: SizedBy = 'capacity',
  ): GPUBuffer {
    const size = Math.max(4, bytes);
    bindable(device, label, size, sizedBy);
    return device.createBuffer({
      label: `gpu-driven ${label}`,
      size,
      usage: STORAGE | COPY_DST | extra,
    });
  }

  /**
   * Every buffer the scene lives in, at its declared capacity.
   *
   * **Called `buildStatic` until 2026-09-18**, and the word was the whole of what changed: these
   * are sized by `scene.capacity` rather than by what the scene currently holds, so there is room
   * for a mesh that has not arrived yet. A static scene declares a capacity equal to its content,
   * so nothing about it moves.
   *
   * **The scene writes two of them itself and keeps no copy of either.** `vertices` and `indices`
   * are made empty at capacity and handed to the scene as a `GeometrySink`; the interleave —
   * twelve floats a vertex, position, normal, colour, uv and glow — is the scene's. It is one
   * buffer rather than five because of a device limit: a compute stage may bind eight storage
   * buffers by default, and the shading pass wanted twelve and was refused at pipeline creation.
   *
   * **The two culling buffers are already in the world.** What a bake writes is a cluster in its
   * mesh's own space, and this pass used to upload that — while the raster and the shading both
   * multiplied by `transforms[mesh]`. A mesh placed anywhere but the origin was then frustum-culled
   * against the wrong region, cone-culled with the wrong orientation, LOD-cut on a misprojected
   * error and occlusion-tested on the wrong rectangle, and every rig in `DRAFT_SCENES` stood at the
   * origin so nothing ever said so. `StreamingScene` computes them when a mesh is placed.
   */
  private buildBuffers(device: GPUDevice): void {
    const count = this.scene.capacity.clusters;
    this.clusterCull = this.storage(device, 'cluster bounds', this.scene.cull);
    this.clusterLod = this.storage(device, 'cluster errors', this.scene.lod);
    this.clusterMeta = this.storage(device, 'cluster meta', this.scene.meta);
    this.instanceSpheres = this.storage(device, 'instance spheres', this.scene.instanceSpheres);
    const capacity = this.scene.capacity;
    const indices = this.empty(device, 'indices', capacity.indices * 4);
    const vertices = this.empty(device, 'vertices', capacity.vertices * VERTEX_FLOATS * 4);
    this.indices = indices;
    this.vertices = vertices;
    this.transformBuffer = this.storage(device, 'transforms', this.scene.transforms);
    this.materialOf = this.storage(device, 'material of', this.scene.materialOf);
    /*
     * **The journal is taken and thrown away, because these buffers now hold all of it.** A scene
     * filled before the pass was mounted has every span outstanding, and without this the first
     * frame would upload the whole scene a second time — which is correct and wasteful, and would
     * make "a frame that changed nothing uploads nothing" false for exactly one frame.
     */
    /*
     * **The scene writes its own geometry into these two, and keeps none of it.** A mesh placed
     * before this pass mounted arrives now; every one after arrives when it is placed. A scene
     * already attached to a pass is refused here, by name.
     */
    this.scene.attach(geometrySink(device.queue, indices, vertices));
    this.scene.takeDirty();
    this.materialTable = device.createBuffer({
      label: 'gpu-driven materials',
      size: MATERIAL_SLOTS * MATERIAL_FLOATS * 4,
      usage: UNIFORM | COPY_DST,
    });
    /*
     * **Roughness defaults to one and specular to zero**, which is the matte this pipeline drew
     * before the highlight existed — so a caller that says nothing gets the frame it already had.
     * The table is written through a DataView because one of its blocks is integers.
     */
    device.queue.writeBuffer(
      this.materialTable,
      0,
      writeMaterialTable(this.materials, this.programs.indices, MATERIAL_SLOTS),
    );

    /*
     * One 256-byte block a material, holding the one number a shading dispatch cannot otherwise
     * learn: which material it is. There is no builtin for "which dispatch am I", and a shader per
     * material would be a pipeline per material.
     */
    const jobs = new Uint32Array(Math.max(1, this.materials.length) * 64);
    for (let m = 0; m < this.materials.length; m += 1) jobs[m * 64] = m;
    this.jobs = device.createBuffer({
      label: 'gpu-driven jobs',
      size: Math.max(256, jobs.byteLength),
      usage: UNIFORM | COPY_DST,
    });
    device.queue.writeBuffer(this.jobs, 0, jobs);

    /*
     * **The light's own list, and it is not the visibility pass's.** The raster's vertex stage keys
     * off `clusterList[instance_index]`, so a shadow draw is the same shader with a different list
     * — and the frame's list is culled against the *camera*: a caster standing behind the viewer is
     * off screen and still throwing a shadow across everything in front of them.
     *
     * **It was the identity until 2026-09-18**: every cluster slot the scene had room for, live or
     * not, at every level at once, 384 vertex invocations each. The voxel sandbox's port measured
     * that at 2.10 ms of shadow at radius 6 and 9.04 at radius 14 — a cost set by the memory budget
     * rather than by anything the light could see. Now the front half runs a fourth time, as the
     * blended half runs a second: the camera's cut with no mesh hidden, a cull against the light's
     * own box with the pyramid and the cones off, and a compaction into this list against a history
     * of zeros. **No new binding in any stage** — new buffers and groups, the same three pipelines.
     */
    this.shadowList = this.empty(device, 'shadow list', count * 4);
    this.shadowListTwo = this.empty(device, 'shadow list two', count * 4);
    /* Each half's draw block: a cluster's index cap and a count the compaction adds to. */
    const shadowArgs = new Uint32Array(DRAW_INDIRECT_WORDS);
    shadowArgs[0] = CLUSTER_INDEX_CAP;
    this.shadowArgs = this.storage(device, 'draw shadow', shadowArgs, INDIRECT | COPY_SRC);
    this.shadowArgsTwo = this.storage(device, 'draw shadow two', shadowArgs, INDIRECT | COPY_SRC);
    this.shadowSelected = this.empty(device, 'shadow selected', count * 4);
    this.shadowKeep = this.empty(device, 'shadow keep', count * 4);
    this.shadowPlanes = this.empty(device, 'shadow planes', FRUSTUM_FLOATS * 4);
    this.shadowHistories = [
      this.empty(device, 'shadow history a', count * 4),
      this.empty(device, 'shadow history b', count * 4),
    ];
    /* The pyramid, from half the map down: its shape is the map's, which is fixed at mount. */
    const shadowBase = hzbMipSize(this.shadowSize, this.shadowSize);
    const shadowPyramid = this.pyramidLevels(
      device,
      'shadow level',
      shadowBase.width,
      shadowBase.height,
    );
    this.shadowLevels = shadowPyramid.levels;
    this.shadowHzb = this.empty(device, 'shadow pyramid', shadowPyramid.floats * 4, 0, 'map');
    this.shadowLevelStart = this.storage(device, 'shadow level starts', shadowPyramid.starts);
    this.shadowSeedSize = this.storage(
      device,
      'shadow seed size',
      Uint32Array.from([this.shadowSize, this.shadowSize]),
    );
    this.shadowCullMatrix = this.empty(device, 'shadow cull matrix', 16 * 4);
    /* The pyramid's shape, the count and the cones now; the eye and the switch each frame. */
    this.shadowCullValues[4] = shadowBase.width;
    this.shadowCullValues[5] = shadowBase.height;
    this.shadowCullValues[6] = shadowPyramid.levels.length;
    this.shadowCullValues[7] = count;
    this.shadowCullValues[CULL_CONES] = 1;
    this.shadowCullSettings = this.storage(device, 'cull settings, shadow', this.shadowCullValues);
    this.shadowCullSettingsTwo = this.storage(
      device,
      'cull settings, shadow two',
      this.shadowCullValues,
    );
    this.shadowCompactSettings = this.storage(
      device,
      'phase shadow',
      Uint32Array.from([PHASE_ONE, count]),
    );
    this.shadowCompactSettingsTwo = this.storage(
      device,
      'phase shadow two',
      Uint32Array.from([PHASE_TWO, count]),
    );
    /* Nonzero is hidden, and the light hides nothing: see `CULL_INSTANCES_WGSL`. */
    this.instanceNone = this.empty(device, 'instance flags, none', this.meshCount * 4);
    this.shadowMatrix = this.empty(device, 'shadow matrix', 16 * 4);
    /*
     * **Its own target, because a contributed pass is handed none.** `PassDevice` carries a device,
     * the frame's formats and the sample count, and nothing else — there is no attachment of the
     * forward path's to sample even where one exists. Depth only: what a shadow map holds is how
     * far the light reached, and a colour target here would be written and never read.
     */
    this.shadowTexture = device.createTexture({
      label: 'gpu-driven shadow',
      size: { width: this.shadowSize, height: this.shadowSize },
      format: SHADOW_FORMAT,
      usage: RENDER_ATTACHMENT | TEXTURE_BINDING,
    });
    this.shadowView = this.shadowTexture.createView();

    this.emptyEnvironment = device.createTexture({
      label: 'gpu-driven no environment',
      size: { width: 1, height: 1, depthOrArrayLayers: 1 },
      format: 'rgba16float',
      usage: TEXTURE_BINDING | TEXTURE_COPY_DST,
    });
    this.emptyEnvironmentView = this.emptyEnvironment.createView({ dimension: '2d-array' });
    this.emptySampler = device.createSampler({
      label: 'gpu-driven no environment',
      magFilter: 'linear',
      minFilter: 'linear',
    });

    /*
     * **The decode resources, created whether or not a material is textured.** The shading
     * pipeline's layout is inferred from the module, and the module reads them — so a pass with no
     * textures binds one layer one texel across and two tables of zeros, which no program names.
     */
    this.decodeNodes = device.createBuffer({
      label: 'gpu-driven decode nodes',
      size: DECODE_NODES_BYTES,
      usage: UNIFORM | COPY_DST,
    });
    device.queue.writeBuffer(this.decodeNodes, 0, this.decode.nodes);
    this.decodeWeights = device.createBuffer({
      label: 'gpu-driven decode weights',
      size: DECODE_WEIGHTS_BYTES,
      usage: UNIFORM | COPY_DST,
    });
    device.queue.writeBuffer(this.decodeWeights, 0, this.decode.weights);
    const edge0 = this.decode.layerSize;
    this.latents = device.createTexture({
      label: 'gpu-driven latents',
      size: { width: edge0, height: edge0, depthOrArrayLayers: this.decode.layerCount },
      format: 'rgba8unorm',
      mipLevelCount: this.decode.levels.length,
      usage: TEXTURE_BINDING | TEXTURE_COPY_DST,
    });
    this.decode.levels.forEach((bytes, level) => {
      const edge = Math.max(1, edge0 >> level);
      device.queue.writeTexture(
        { texture: this.latents as GPUTexture, mipLevel: level },
        bytes as unknown as ArrayBufferView,
        { bytesPerRow: edge * 4, rowsPerImage: edge },
        { width: edge, height: edge, depthOrArrayLayers: this.decode.layerCount },
      );
    });
    this.latentsView = this.latents.createView({ dimension: '2d-array' });
    const filtered = { magFilter: 'linear', minFilter: 'linear', mipmapFilter: 'linear' } as const;
    this.latentClamp = device.createSampler({
      label: 'gpu-driven latents, clamped',
      ...filtered,
      addressModeU: 'clamp-to-edge',
      addressModeV: 'clamp-to-edge',
    });
    this.latentRepeat = device.createSampler({
      label: 'gpu-driven latents, repeated',
      ...filtered,
      addressModeU: 'repeat',
      addressModeV: 'repeat',
    });

    this.planesBuffer = this.empty(device, 'planes', FRUSTUM_FLOATS * 4);
    this.viewProjBuffer = this.empty(device, 'view projection', 16 * 4);
    this.rasterParams = device.createBuffer({
      label: 'gpu-driven raster params',
      size: 4 * 4,
      usage: UNIFORM | COPY_DST,
    });
    this.cullBuffers = [
      this.empty(device, 'cull settings, phase one', CULL_SETTINGS_FLOATS * 4),
      this.empty(device, 'cull settings, phase two', CULL_SETTINGS_FLOATS * 4),
      this.empty(device, 'cull settings, blend', CULL_SETTINGS_FLOATS * 4),
    ];
    this.lodBuffer = this.empty(device, 'lod params', 8 * 4);
    this.blendLodBuffer = this.empty(device, 'lod params blend', 8 * 4);
    this.instanceFlags = this.empty(device, 'instance flags', this.meshCount * 4);
    this.frameBuffer = device.createBuffer({
      label: 'gpu-driven frame',
      size: FRAME_FLOATS * 4,
      usage: UNIFORM | COPY_DST,
    });
    this.selected = this.empty(device, 'selected', count * 4);
    this.keep = this.empty(device, 'keep', count * 4);
    this.history = this.empty(device, 'history a', count * 4);
    this.drawn = this.empty(device, 'history b', count * 4);
    this.lists = [
      this.empty(device, 'list one', count * 4),
      this.empty(device, 'list two', count * 4),
    ];
    const args = new Uint32Array(DRAW_INDIRECT_WORDS);
    args[0] = CLUSTER_INDEX_CAP;
    this.args = [
      this.storage(device, 'draw one', args, INDIRECT | COPY_SRC),
      this.storage(device, 'draw two', args, INDIRECT | COPY_SRC),
    ];
    this.phaseSettings = [
      this.storage(device, 'phase one', Uint32Array.from([PHASE_ONE, count])),
      this.storage(device, 'phase two', Uint32Array.from([PHASE_TWO, count])),
    ];

    /*
     * **The transparent half's list, and the trick that makes one compaction serve both.**
     *
     * `COMPACT_CLUSTERS_WGSL` keeps a cluster only where `history[i] != 0` disagrees with the
     * phase, which is how the two occlusion phases divide the opaque scene between them. The
     * blended set is not divided — every blended cluster in the cut is drawn, once — so it is
     * compacted as **phase two against a history of zeros**: `seen` is false for every cluster, the
     * phase says false too, and none of them is skipped. `historySink` catches the history that run
     * writes and nothing reads.
     *
     * The alternative was a third phase in the shader, which would be a branch every opaque frame
     * pays for and a case `scripts/gpu-parity.mjs`'s `compactPhase` check would have to grow.
     */
    this.blendList = this.empty(device, 'list blend', count * 4);
    this.blendArgs = this.storage(device, 'draw blend', args, INDIRECT | COPY_SRC);
    this.blendCompactSettings = this.storage(
      device,
      'phase blend',
      Uint32Array.from([PHASE_TWO, count]),
    );
    this.zeroHistory = this.empty(device, 'history zero', count * 4);
    this.historySink = this.empty(device, 'history sink', count * 4);
  }

  /**
   * Close the two scopes the blend pipeline was built in, and disown it where the device refused.
   *
   * **Asynchronous because a pipeline failure is.** Nothing can be known at the call that creates
   * it, so the first frames draw no transparency and then either it arrives or it never does. That
   * is the honest order: a pane missing for two frames is invisible, and a frame missing entirely
   * is what this exists to prevent.
   *
   * The warning is once, in the words the device used, because the whole difficulty of the report
   * this came from was five errors that were all the same one.
   */
  private watchBlendPipeline(device: GPUDevice): void {
    /*
     * **A device with no error scopes is taken at its word.** Nothing can be asked of it, and
     * refusing transparency forever on a device that never said no would be a worse failure than
     * the one this guards: a frame that quietly loses its glass on hardware that could draw it.
     */
    if (typeof device.popErrorScope !== 'function') {
      this.blendUsable = true;
      if (this.makeBlendGroup !== null) this.blendRasterGroup = this.makeBlendGroup();
      return;
    }

    let outstanding = 2;
    const settle = (error: GPUError | null, scope: string): void => {
      outstanding -= 1;
      if (error !== null && this.blendPipeline !== null) {
        this.blendPipeline = null;
        this.blendRasterGroup = null;
        this.makeBlendGroup = null;
        console.warn(
          `[driftengine] this device refused the gpu-driven blend pipeline (${scope}), so the ` +
            `transparent pass is off and everything opaque still draws: ${error.message}`,
        );
      }
      /* Usable only once both scopes have come back clean, and only then is anything bound. */
      if (outstanding > 0 || this.blendPipeline === null) return;
      this.blendUsable = true;
      if (this.makeBlendGroup !== null) this.blendRasterGroup = this.makeBlendGroup();
    };
    void device.popErrorScope().then((error) => settle(error, 'internal'));
    void device.popErrorScope().then((error) => settle(error, 'validation'));
  }

  /**
   * Close the scopes every other pipeline was built in, and refuse the pass where one came back.
   *
   * **This is `watchBlendPipeline` widened to the rest of the pass**, and the reason it is separate
   * is that the two refusals mean different things: a blend pipeline nobody can compile costs the
   * glass, and a raster, shadow, blit or compute pipeline nobody can compile costs the world. The
   * first degrades; the second has nothing to degrade to, so it says so and draws nothing rather
   * than encoding a command buffer the driver will reject whole.
   *
   * A device with no scopes is taken at its word, exactly as the blend guard takes it: refusing to
   * draw on hardware that never said no is the worse of the two failures.
   */
  private watchPipelines(device: GPUDevice, scoped: boolean): void {
    if (!scoped || typeof device.popErrorScope !== 'function') {
      this.usable = true;
      return;
    }
    let outstanding = 2;
    const settle = (error: GPUError | null, scope: string): void => {
      outstanding -= 1;
      if (error !== null && this.refusal === null) {
        this.refusal = error.message;
        console.warn(
          `[driftengine] this device refused a gpu-driven pipeline (${scope}), so this pass draws ` +
            `nothing and the rest of the frame is unaffected: ${error.message}`,
        );
      }
      /* Usable only once both have come back clean, which is what keeps an invalid handle out. */
      if (outstanding > 0 || this.refusal !== null) return;
      this.usable = true;
    };
    void device.popErrorScope().then((error) => settle(error, 'internal'));
    void device.popErrorScope().then((error) => settle(error, 'validation'));
  }

  /**
   * Why this pass is drawing nothing, in the words the device used, or null where it is not.
   *
   * **Exposed because a black frame that says nothing is the bug this was reported as, twice.** A
   * pipeline refusal arrives asynchronously, long after `createRenderer` has decided the backend
   * can run this at all, so there is no earlier place to throw — and a scene that can read this can
   * tell somebody what happened instead of presenting an empty picture.
   */
  refusedBecause(): string | null {
    return this.refusal;
  }

  private buildPipelines(device: GPUDevice, format: GPUTextureFormat, samples: number): void {
    const compute = (label: string, code: string): GPUComputePipeline =>
      device.createComputePipeline({
        label: `gpu-driven ${label}`,
        layout: 'auto',
        compute: { module: device.createShaderModule({ label, code }), entryPoint: 'main' },
      });

    this.instancePipeline = compute('cull instances', CULL_INSTANCES_WGSL);
    this.lodPipeline = compute('lod cut', LOD_CUT_WGSL);
    this.cullPipeline = compute('cull clusters', CULL_CLUSTERS_WGSL);
    this.compactPipeline = compute('compact', COMPACT_CLUSTERS_WGSL);
    this.seedPipeline = compute('hzb seed', HZB_SEED_WGSL);
    this.shadowSeedPipeline = compute('shadow hzb seed', SHADOW_HZB_SEED_WGSL);
    this.reducePipeline = compute('hzb reduce', HZB_REDUCE_WGSL);
    this.countPipeline = compute('bin count', MATERIAL_COUNT_WGSL);
    this.offsetsPipeline = compute('bin offsets', MATERIAL_OFFSETS_WGSL);
    this.scatterPipeline = compute('bin scatter', MATERIAL_SCATTER_WGSL);
    this.shadePipeline = compute('shade', SHADE_MATERIAL_WGSL);

    const raster = device.createShaderModule({ label: 'visbuffer', code: VISBUFFER_RASTER_WGSL });
    this.rasterPipeline = device.createRenderPipeline({
      label: 'gpu-driven visbuffer',
      layout: 'auto',
      vertex: { module: raster, entryPoint: 'vertexMain' },
      fragment: { module: raster, entryPoint: 'fragmentMain', targets: [{ format: 'r32uint' }] },
      /*
       * **The default winding, which is the forward path's, once the projection is the right
       * one.** This read `frontFace: 'cw'` for an afternoon and the reason was a mirror: taking
       * `clipCorrection` in a hand-written shader negates Y once too often, and a Y flip reverses
       * screen winding — so a single-sided surface vanished under `ccw` and `cw` drew the correct
       * faces of a vertically mirrored world. Two captures of one scene settled it, the same
       * geometry through `drawMesh` and through here, mirrored about the canvas centre to the
       * pixel. See `depthCorrection` in `PassDevice`.
       */
      primitive: { topology: 'triangle-list', cullMode: 'back' },
      depthStencil: { format: DEPTH_FORMAT, depthWriteEnabled: true, depthCompare: DEPTH_COMPARE },
    });

    /*
     * **The same vertex stage as the frame's, with no fragment stage at all.** What a depth-only
     * pass needs is exactly the transform the visibility raster already does, so sharing the module
     * is what keeps the map and the frame agreeing about where a triangle is — a second copy of
     * that transform would be a shadow standing slightly beside its caster with nothing to compare.
     *
     * **`frontFace: 'cw'` travels with the light matrix's Y negation and neither is inert.** The
     * flip reverses screen winding, so the default would cull precisely the faces this pass exists
     * to record — and what that draws is not a missing shadow, it is a scene uniformly in shadow,
     * because every fragment compares itself against a depth recorded behind it. `depthPass.ts`
     * paid for that lesson on the other pipeline and its comment is the long version.
     *
     * **Not reversed**: `depthConvention.ts` leaves shadow maps conventional, so this clears to
     * `SHADOW_DEPTH_CLEAR` and compares with `less` while the frame beside it clears to 0 and
     * compares with `greater`. A scatter batch already cast no shadow at all on this backend for
     * taking the frame's pair here.
     *
     * The bias is `depthPass.ts`'s, which is `shadowMap.ts`'s on the other backend: a map with no
     * separation between a caster and its receiver is acne everywhere the two are the same surface.
     */
    this.shadowPipeline = device.createRenderPipeline({
      label: 'gpu-driven shadow',
      layout: 'auto',
      vertex: { module: raster, entryPoint: 'vertexMain' },
      primitive: { topology: 'triangle-list', cullMode: 'back', frontFace: 'cw' },
      depthStencil: {
        format: SHADOW_FORMAT,
        depthWriteEnabled: true,
        depthCompare: 'less',
        depthBias: 4,
        depthBiasSlopeScale: 1.1,
      },
    });
    /*
     * **Six entries until the raster gained an alpha test, and seven after it.** This pass shares
     * that module's vertex stage, and the stage now reads `materialOf` to carry a material into the
     * fragment stage this pipeline does not have — so `layout: 'auto'` derives a seventh binding
     * here too, and a bind group of six is refused outright. It failed exactly that way, and what
     * it drew was nothing: the shadow encoder's whole command buffer was invalid.
     *
     * The buffer is bound rather than the read moved, because the alternative is reading the
     * material per fragment instead of per vertex and an opaque scene would pay for it.
     */
    const shadowRasterFor = (list: GPUBuffer): GPUBindGroup =>
      device.createBindGroup({
        layout: (this.shadowPipeline as GPURenderPipeline).getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: this.shadowMatrix as GPUBuffer } },
          { binding: 1, resource: { buffer: list } },
          { binding: 2, resource: { buffer: this.clusterMeta as GPUBuffer } },
          { binding: 3, resource: { buffer: this.indices as GPUBuffer } },
          { binding: 4, resource: { buffer: this.vertices as GPUBuffer } },
          { binding: 5, resource: { buffer: this.transformBuffer as GPUBuffer } },
          { binding: 6, resource: { buffer: this.materialOf as GPUBuffer } },
        ],
      });
    this.shadowGroup = shadowRasterFor(this.shadowList as GPUBuffer);
    this.shadowGroupTwo = shadowRasterFor(this.shadowListTwo as GPUBuffer);

    /*
     * **The transparent half's raster: one indirect draw into two targets at once.**
     *
     * The accumulation sums and the revealage multiplies, which is the whole mechanism — both
     * commute, so the frame does not depend on the order the panes arrived in. `flatPass.ts`'s
     * `oitTarget` sets the same pair on the forward path; it needs two passes because it replays a
     * draw queue through a shader that writes one target, and this writes both at once.
     *
     * **No culling**, because a pane is a surface seen from both sides and there is no interior to
     * hide. The opaque raster culls back faces, where a closed hull's far side is a wasted draw.
     */
    const blend = device.createShaderModule({ label: 'blend raster', code: BLEND_RASTER_WGSL });
    /*
     * **Built inside error scopes, because a driver that refuses this must not take the frame.**
     *
     * Reported from a Galaxy S23 Ultra: `CreateGraphicsPipelines failed with VK_ERROR_UNKNOWN`
     * for this pipeline, and then four more errors that were all the same one. `createRenderPipeline`
     * does not throw where a driver refuses — it hands back an *invalid* pipeline and reports
     * asynchronously — so the code that followed built a bind group from its layout, set it on a
     * pass, and submitted a command buffer, each of which is invalid because the one before it was.
     * The city drew **nothing**, on a device that could have drawn all of it but the glass.
     *
     * So the handle is disowned where the device refused it and the transparent pass skips itself.
     * Both scopes, because a shader a driver cannot compile is reported as internal on some
     * backends and as validation on others, and this is exactly the case where guessing which
     * costs the whole frame.
     */
    /* Only where the device offers them: see `watchBlendPipeline` for the case where it does not. */
    if (typeof device.pushErrorScope === 'function') {
      device.pushErrorScope('validation');
      device.pushErrorScope('internal');
    }
    this.blendPipeline = device.createRenderPipeline({
      label: 'gpu-driven blend',
      layout: 'auto',
      vertex: { module: blend, entryPoint: 'blendVert' },
      fragment: {
        module: blend,
        entryPoint: 'blendFrag',
        targets: [
          {
            format: OIT_ACCUM_FORMAT,
            blend: {
              color: { srcFactor: 'one', dstFactor: 'one', operation: 'add' },
              alpha: { srcFactor: 'one', dstFactor: 'one', operation: 'add' },
            },
          },
          {
            format: OIT_REVEAL_FORMAT,
            blend: {
              color: { srcFactor: 'zero', dstFactor: 'one-minus-src-alpha', operation: 'add' },
              alpha: { srcFactor: 'zero', dstFactor: 'one-minus-src-alpha', operation: 'add' },
            },
          },
        ],
      },
      primitive: { topology: 'triangle-list', cullMode: 'none' },
      /* Read-only: a pane behind a wall is rejected, and two panes do not hide each other. */
      depthStencil: {
        format: DEPTH_FORMAT,
        depthWriteEnabled: false,
        depthCompare: DEPTH_COMPARE,
      },
    });
    this.watchBlendPipeline(device);

    /*
     * **Premultiplied over, where `renderer.ts`'s composite is a lerp**, and `blendRaster.wgsl.ts`
     * carries why: this pipeline's colour target has a coverage mask in its alpha, which the blit
     * reads to decide whether the pass drew a pixel at all, and a lerp would leave a pane over
     * empty sky marked as undrawn.
     */
    const resolve = device.createShaderModule({ label: 'blend resolve', code: BLEND_RESOLVE_WGSL });
    this.blendResolvePipeline = device.createRenderPipeline({
      label: 'gpu-driven blend resolve',
      layout: 'auto',
      vertex: { module: resolve, entryPoint: 'resolveVert' },
      fragment: {
        module: resolve,
        entryPoint: 'resolveFrag',
        targets: [
          {
            format: 'rgba16float',
            blend: {
              color: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
              alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
            },
          },
        ],
      },
      primitive: { topology: 'triangle-list' },
    });

    /*
     * **The frame's depth format has to be this pass's, and it is asserted rather than assumed.**
     * Both take `DEPTH_FORMAT` from `depthConvention.ts` today, so there is no conversion here at
     * all — and a backend that ever differed would not fail, it would produce a depth test that is
     * silently inverted or quantised, which is the shape of defect this repository writes refusals
     * for. Only checked where the depth is actually handed over.
     */
    if (this.presentDepth && this.frameDepthFormat !== DEPTH_FORMAT) {
      throw new Error(
        `[driftengine] the gpu-driven pass was asked to present its depth into a frame whose ` +
          `depth format is ${String(this.frameDepthFormat)}, and its own is ${DEPTH_FORMAT}. Both ` +
          `read DEPTH_FORMAT in depthConvention.ts, so this is a backend that has diverged from it.`,
      );
    }
    const blitLabel = this.presentDepth ? 'gpu-driven blit depth' : 'gpu-driven blit';
    const blit = device.createShaderModule({
      label: blitLabel,
      code: this.presentDepth ? GPU_DRIVEN_BLIT_DEPTH_WGSL : GPU_DRIVEN_BLIT_WGSL,
    });
    this.blitPipeline = device.createRenderPipeline({
      label: blitLabel,
      layout: 'auto',
      vertex: { module: blit, entryPoint: 'vertexMain' },
      fragment: {
        module: blit,
        entryPoint: 'fragmentMain',
        targets: [
          {
            format,
            /*
             * **Premultiplied over, because that is what the target holds.** Colour with a
             * coverage in its alpha: one wherever the visibility buffer covered a pixel, so over
             * is a plain write there, and a blended surface's own coverage where nothing else of
             * this pipeline was — a pane against the sky. Written as opaque, that pane was painted
             * over black and the sky behind it thrown away; `depth-share-check.mjs` measured a
             * pane over a dark backdrop and over a bright one come back as the same pixel.
             */
            blend: {
              color: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
              alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
            },
          },
        ],
      },
      primitive: { topology: 'triangle-list' },
      multisample: { count: samples },
      /*
       * **Over whatever is there unless the caller asked to share a depth buffer.** Without the
       * flag this pass *is* the scene and the sky behind it is a backdrop; with it, a forward-path
       * mesh can stand behind this pipeline's geometry, which needs the depth written and needs the
       * comparison to be the frame's own rather than `always`.
       *
       * **The frame's own comparison or equal**, and the equal is for a pane with nothing of this
       * pipeline behind it. Its pixel carries the depth the pass cleared to, which is the frame's
       * own clear, so a strict test refuses it over the sky every time and the pane is gone; with
       * equal it passes there and writes back the value that was already there. Over geometry the
       * frame drew *before* the blit such a pixel still fails, which is why a consumer draws its
       * own meshes after this pass rather than before it.
       */
      depthStencil: {
        format: DEPTH_FORMAT,
        depthWriteEnabled: this.presentDepth,
        depthCompare: this.presentDepth ? DEPTH_COMPARE_EQUAL : 'always',
      },
    });

    const lodFor = (params: GPUBuffer): GPUBindGroup =>
      device.createBindGroup({
        layout: (this.lodPipeline as GPUComputePipeline).getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: params } },
          { binding: 1, resource: { buffer: this.clusterLod as GPUBuffer } },
          { binding: 2, resource: { buffer: this.selected as GPUBuffer } },
          { binding: 3, resource: { buffer: this.clusterMeta as GPUBuffer } },
          { binding: 4, resource: { buffer: this.instanceFlags as GPUBuffer } },
          { binding: 5, resource: { buffer: this.materialOf as GPUBuffer } },
          { binding: 6, resource: { buffer: this.materialTable as GPUBuffer } },
        ],
      });
    /* The same cut with one number changed: which half of the frame it is being asked for. */
    this.lodGroup = lodFor(this.lodBuffer as GPUBuffer);
    this.blendLodGroup = lodFor(this.blendLodBuffer as GPUBuffer);
    /*
     * **The camera's cut, with no mesh hidden and a selection of its own.** The camera's parameters,
     * so a surface is shadowed at the level it is drawn at; not the camera's instance flags, which
     * drop a tree behind the viewer that is still shadowing the path in front of them.
     */
    this.shadowLodGroup = device.createBindGroup({
      layout: (this.lodPipeline as GPUComputePipeline).getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: this.lodBuffer as GPUBuffer } },
        { binding: 1, resource: { buffer: this.clusterLod as GPUBuffer } },
        { binding: 2, resource: { buffer: this.shadowSelected as GPUBuffer } },
        { binding: 3, resource: { buffer: this.clusterMeta as GPUBuffer } },
        { binding: 4, resource: { buffer: this.instanceNone as GPUBuffer } },
        { binding: 5, resource: { buffer: this.materialOf as GPUBuffer } },
        { binding: 6, resource: { buffer: this.materialTable as GPUBuffer } },
      ],
    });
    /*
     * **Both halves of the light's compaction, both ways round the history**, made once: the light's
     * history swaps only on a frame that draws the map, so which way round is the light's own flag
     * and not the camera's.
     */
    const shadowCompactFor = (
      settings: GPUBuffer,
      list: GPUBuffer,
      args: GPUBuffer,
      read: GPUBuffer,
      write: GPUBuffer,
    ): GPUBindGroup =>
      device.createBindGroup({
        layout: (this.compactPipeline as GPUComputePipeline).getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: settings } },
          { binding: 1, resource: { buffer: this.shadowSelected as GPUBuffer } },
          { binding: 2, resource: { buffer: this.shadowKeep as GPUBuffer } },
          { binding: 3, resource: { buffer: read } },
          { binding: 4, resource: { buffer: list } },
          { binding: 5, resource: { buffer: write } },
          { binding: 6, resource: { buffer: args } },
        ],
      });
    const [historyA, historyB] = this.shadowHistories as [GPUBuffer, GPUBuffer];
    const halves = (read: GPUBuffer, write: GPUBuffer): [GPUBindGroup, GPUBindGroup] => [
      shadowCompactFor(
        this.shadowCompactSettings as GPUBuffer,
        this.shadowList as GPUBuffer,
        this.shadowArgs as GPUBuffer,
        read,
        write,
      ),
      shadowCompactFor(
        this.shadowCompactSettingsTwo as GPUBuffer,
        this.shadowListTwo as GPUBuffer,
        this.shadowArgsTwo as GPUBuffer,
        read,
        write,
      ),
    ];
    this.shadowCompactGroups = [halves(historyA, historyB), halves(historyB, historyA)];
    /*
     * **The light's cull, each half, against the light's own pyramid** through the raster's matrix
     * turned over; phase one's settings switch the pyramid off. Made once, because nothing it
     * binds is sized by the frame.
     */
    const shadowCullFor = (settings: GPUBuffer): GPUBindGroup =>
      device.createBindGroup({
        layout: (this.cullPipeline as GPUComputePipeline).getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: this.shadowPlanes as GPUBuffer } },
          { binding: 1, resource: { buffer: this.shadowCullMatrix as GPUBuffer } },
          { binding: 2, resource: { buffer: settings } },
          { binding: 3, resource: { buffer: this.clusterCull as GPUBuffer } },
          { binding: 4, resource: { buffer: this.shadowHzb as GPUBuffer } },
          { binding: 5, resource: { buffer: this.shadowLevelStart as GPUBuffer } },
          { binding: 6, resource: { buffer: this.shadowKeep as GPUBuffer } },
          { binding: 7, resource: { buffer: this.shadowSelected as GPUBuffer } },
        ],
      });
    this.shadowCullGroups = [
      shadowCullFor(this.shadowCullSettings as GPUBuffer),
      shadowCullFor(this.shadowCullSettingsTwo as GPUBuffer),
    ];
    this.shadowSeedGroup = device.createBindGroup({
      layout: (this.shadowSeedPipeline as GPUComputePipeline).getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: this.shadowSeedSize as GPUBuffer } },
        { binding: 1, resource: this.shadowView as GPUTextureView },
        { binding: 2, resource: { buffer: this.shadowHzb as GPUBuffer } },
      ],
    });
    this.shadowReduceGroups = [];
    for (let level = 1; level < this.shadowLevels.length; level += 1) {
      const src = this.shadowLevels[level - 1] as Level;
      this.shadowReduceGroups.push(
        device.createBindGroup({
          layout: (this.reducePipeline as GPUComputePipeline).getBindGroupLayout(0),
          entries: [
            { binding: 0, resource: { buffer: src.size } },
            { binding: 1, resource: { buffer: this.shadowHzb as GPUBuffer } },
          ],
        }),
      );
    }
    this.blendCompactGroup = device.createBindGroup({
      layout: (this.compactPipeline as GPUComputePipeline).getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: this.blendCompactSettings as GPUBuffer } },
        { binding: 1, resource: { buffer: this.selected as GPUBuffer } },
        { binding: 2, resource: { buffer: this.keep as GPUBuffer } },
        { binding: 3, resource: { buffer: this.zeroHistory as GPUBuffer } },
        { binding: 4, resource: { buffer: this.blendList as GPUBuffer } },
        { binding: 5, resource: { buffer: this.historySink as GPUBuffer } },
        { binding: 6, resource: { buffer: this.blendArgs as GPUBuffer } },
      ],
    });
    /*
     * **The corrected matrix, which is the one the cluster planes come from**, so a mesh and its
     * clusters are judged against one frustum. The shader extracts its planes per invocation, which
     * is six rows' arithmetic a mesh; a scene has meshes by the handful.
     */
    this.instanceGroup = device.createBindGroup({
      layout: this.instancePipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: this.viewProjBuffer as GPUBuffer } },
        { binding: 1, resource: { buffer: this.instanceSpheres as GPUBuffer } },
        { binding: 2, resource: { buffer: this.instanceFlags as GPUBuffer } },
      ],
    });

    this.jobGroups = [];
    for (let m = 0; m < this.materials.length; m += 1) {
      this.jobGroups.push(
        device.createBindGroup({
          layout: this.shadePipeline.getBindGroupLayout(1),
          entries: [
            { binding: 0, resource: { buffer: this.jobs as GPUBuffer, offset: m * 256, size: 16 } },
          ],
        }),
      );
    }
    this.buildSwappedGroups(device);
  }

  /**
   * The groups that name `history` and `drawn`, rebuilt when the two swap.
   *
   * **Two sets rather than a copy**, because the alternative is copying a buffer the size of the
   * cluster count every frame to keep one binding pointing at the right half. A bind group is
   * cheap to build and this happens once a frame; making it twice and alternating would be
   * cheaper still, and is what this does — `flipped` picks the pair.
   */
  private buildSwappedGroups(device: GPUDevice): void {
    const compact = this.compactPipeline as GPUComputePipeline;
    const raster = this.rasterPipeline as GPURenderPipeline;
    const [listOne, listTwo] = this.lists as [GPUBuffer, GPUBuffer];
    const [argsOne, argsTwo] = this.args as [GPUBuffer, GPUBuffer];
    const [phaseOne, phaseTwo] = this.phaseSettings as [GPUBuffer, GPUBuffer];
    const read = this.flipped ? (this.drawn as GPUBuffer) : (this.history as GPUBuffer);
    const write = this.flipped ? (this.history as GPUBuffer) : (this.drawn as GPUBuffer);

    const compactFor = (settings: GPUBuffer, list: GPUBuffer, args: GPUBuffer): GPUBindGroup =>
      device.createBindGroup({
        layout: compact.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: settings } },
          { binding: 1, resource: { buffer: this.selected as GPUBuffer } },
          { binding: 2, resource: { buffer: this.keep as GPUBuffer } },
          { binding: 3, resource: { buffer: read } },
          { binding: 4, resource: { buffer: list } },
          { binding: 5, resource: { buffer: write } },
          { binding: 6, resource: { buffer: args } },
        ],
      });
    this.compactGroups = [
      compactFor(phaseOne, listOne, argsOne),
      compactFor(phaseTwo, listTwo, argsTwo),
    ];

    const rasterFor = (list: GPUBuffer): GPUBindGroup =>
      device.createBindGroup({
        layout: raster.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: this.viewProjBuffer as GPUBuffer } },
          { binding: 1, resource: { buffer: list } },
          { binding: 2, resource: { buffer: this.clusterMeta as GPUBuffer } },
          { binding: 3, resource: { buffer: this.indices as GPUBuffer } },
          { binding: 4, resource: { buffer: this.vertices as GPUBuffer } },
          { binding: 5, resource: { buffer: this.transformBuffer as GPUBuffer } },
          { binding: 6, resource: { buffer: this.materialOf as GPUBuffer } },
          { binding: 7, resource: { buffer: this.materialTable as GPUBuffer } },
          { binding: 8, resource: { buffer: this.rasterParams as GPUBuffer } },
          { binding: 9, resource: this.latentsView as GPUTextureView },
          { binding: 10, resource: this.latentClamp as GPUSampler },
          { binding: 11, resource: this.latentRepeat as GPUSampler },
          { binding: 12, resource: { buffer: this.decodeNodes as GPUBuffer } },
          { binding: 13, resource: { buffer: this.decodeWeights as GPUBuffer } },
        ],
      });
    this.rasterGroups = [rasterFor(listOne), rasterFor(listTwo)];
  }

  private disposeTargets(): void {
    this.oitAccum?.destroy();
    this.oitReveal?.destroy();
    this.oitAccum = null;
    this.oitReveal = null;
    this.oitAccumView = null;
    this.oitRevealView = null;
    this.visibilityTexture?.destroy();
    this.depthTexture?.destroy();
    this.colourTexture?.destroy();
    this.visibility?.destroy();
    this.hzb?.destroy();
    this.levelStart?.destroy();
    for (const level of this.levels) level.size.destroy();
    this.binCounts?.destroy();
    this.binOffsets?.destroy();
    this.binCursors?.destroy();
    this.binDispatch?.destroy();
    this.binPixels?.destroy();
    this.binSettingsBuffer?.destroy();
    this.levels = [];
  }

  /**
   * A pyramid's levels over a base this size, down to one texel: each level padded so its byte
   * offset is one a bind group may name, with its own size block — the source's shape, where it
   * starts, and where its output goes, because the reduction addresses both ends of one buffer
   * itself (see `HZB_REDUCE_WGSL`). The camera's is over the frame; the light's over half its map.
   */
  private pyramidLevels(
    device: GPUDevice,
    label: string,
    width: number,
    height: number,
  ): { levels: Level[]; floats: number; starts: Uint32Array } {
    const count = hzbMipCount(width, height);
    const starts = new Uint32Array(count);
    let floats = 0;
    let levelWidth = width;
    let levelHeight = height;
    const levels: Level[] = [];
    for (let level = 0; level < count; level += 1) {
      starts[level] = floats;
      const texels = Math.ceil((levelWidth * levelHeight) / LEVEL_ALIGN) * LEVEL_ALIGN;
      levels.push({
        width: levelWidth,
        height: levelHeight,
        start: floats,
        size: this.storage(
          device,
          `${label} ${level}`,
          Uint32Array.from([levelWidth, levelHeight, floats, floats + texels]),
        ),
      });
      floats += texels;
      const next = hzbMipSize(levelWidth, levelHeight);
      levelWidth = next.width;
      levelHeight = next.height;
    }
    return { levels, floats, starts };
  }

  private buildTargets(device: GPUDevice): void {
    this.disposeTargets();
    const { stride, height } = this;
    const pixels = stride * height;

    this.visibilityTexture = device.createTexture({
      label: 'gpu-driven visibility',
      size: { width: stride, height },
      format: 'r32uint',
      usage: RENDER_ATTACHMENT | TEXTURE_COPY_SRC,
    });
    this.depthTexture = device.createTexture({
      label: 'gpu-driven depth',
      size: { width: stride, height },
      format: DEPTH_FORMAT,
      usage: RENDER_ATTACHMENT | TEXTURE_BINDING,
    });
    this.colourTexture = device.createTexture({
      label: 'gpu-driven colour',
      size: { width: stride, height },
      format: 'rgba16float',
      /* `RENDER_ATTACHMENT` only so a clear-only render pass can empty it each frame: a storage
         texture has no clear, and the alternative is a dispatch over every pixel. */
      usage: STORAGE_BINDING | TEXTURE_BINDING | RENDER_ATTACHMENT,
    });
    this.colourView = this.colourTexture.createView();
    this.oitAccum = device.createTexture({
      label: 'gpu-driven oit accum',
      size: { width: stride, height },
      format: OIT_ACCUM_FORMAT,
      usage: RENDER_ATTACHMENT | TEXTURE_BINDING,
    });
    this.oitReveal = device.createTexture({
      label: 'gpu-driven oit reveal',
      size: { width: stride, height },
      format: OIT_REVEAL_FORMAT,
      usage: RENDER_ATTACHMENT | TEXTURE_BINDING,
    });
    this.oitAccumView = this.oitAccum.createView();
    this.oitRevealView = this.oitReveal.createView();
    this.visibility = this.empty(device, 'visibility', pixels * 4, COPY_DST, 'frame');

    /*
     * **Over the width the raster drew, not the padded row.** The cull maps a cluster's rectangle
     * across the base's width; over the row, a cluster was tested against the depth of a point
     * further right than it stood, and at the right edge against the padding, which hides nothing.
     * A storage buffer has no row alignment to keep, so the pyramid takes the picture's own size.
     */
    const pyramid = this.pyramidLevels(device, 'level', this.width, height);
    this.levels = pyramid.levels;
    this.hzb = this.empty(device, 'pyramid', pyramid.floats * 4, 0, 'frame');
    this.levelStart = this.storage(device, 'level starts', pyramid.starts);

    const materials = Math.max(1, this.materials.length);
    this.binCounts = this.empty(device, 'bin counts', materials * 4);
    /* Copied into the cursors each frame, so the scatter can consume a copy and leave these
       readable — which is what tells a shading group where its material's list begins. */
    this.binOffsets = this.empty(device, 'bin offsets', materials * 4, COPY_SRC);
    this.binCursors = this.empty(device, 'bin cursors', materials * 4, COPY_DST);
    this.binDispatch = this.empty(
      device,
      'bin dispatch',
      materials * BIN_DISPATCH_WORDS * 4,
      INDIRECT,
    );
    this.binPixels = this.empty(device, 'bin pixels', pixels * 4, 0, 'frame');
    this.binSettings[0] = pixels;
    this.binSettings[1] = materials;
    this.binSettings[2] = BIN_GROUP_SIZE;
    this.binSettingsBuffer = this.storage(device, 'bin settings', this.binSettings);

    this.buildSizedGroups(device);
  }

  private buildSizedGroups(device: GPUDevice): void {
    const cullGroup = (settings: GPUBuffer): GPUBindGroup =>
      device.createBindGroup({
        layout: (this.cullPipeline as GPUComputePipeline).getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: this.planesBuffer as GPUBuffer } },
          { binding: 1, resource: { buffer: this.viewProjBuffer as GPUBuffer } },
          { binding: 2, resource: { buffer: settings } },
          { binding: 3, resource: { buffer: this.clusterCull as GPUBuffer } },
          { binding: 4, resource: { buffer: this.hzb as GPUBuffer } },
          { binding: 5, resource: { buffer: this.levelStart as GPUBuffer } },
          { binding: 6, resource: { buffer: this.keep as GPUBuffer } },
          { binding: 7, resource: { buffer: this.selected as GPUBuffer } },
        ],
      });
    const [phaseOne, phaseTwo, blend] = this.cullBuffers as [GPUBuffer, GPUBuffer, GPUBuffer];
    this.cullGroups = [cullGroup(phaseOne), cullGroup(phaseTwo), cullGroup(blend)];

    const base = this.levels[0] as Level;
    this.seedGroup = device.createBindGroup({
      layout: (this.seedPipeline as GPUComputePipeline).getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: base.size } },
        { binding: 1, resource: (this.depthTexture as GPUTexture).createView() },
        { binding: 2, resource: { buffer: this.hzb as GPUBuffer } },
      ],
    });

    /*
     * **The whole pyramid, once, as one writable binding per level.** Binding a sub-range read-only
     * beside a writable one is refused: a buffer used writably in a compute pass may be used no
     * other way in that scope, whatever the offsets. So the level's size block carries where its
     * source starts and where its output goes, and the shader indexes both.
     */
    this.reduceGroups = [];
    for (let level = 1; level < this.levels.length; level += 1) {
      const src = this.levels[level - 1] as Level;
      this.reduceGroups.push(
        device.createBindGroup({
          layout: (this.reducePipeline as GPUComputePipeline).getBindGroupLayout(0),
          entries: [
            { binding: 0, resource: { buffer: src.size } },
            { binding: 1, resource: { buffer: this.hzb as GPUBuffer } },
          ],
        }),
      );
    }

    const binEntries = [
      { binding: 0, resource: { buffer: this.binSettingsBuffer as GPUBuffer } },
      { binding: 1, resource: { buffer: this.visibility as GPUBuffer } },
      { binding: 2, resource: { buffer: this.materialOf as GPUBuffer } },
    ];
    this.countGroup = device.createBindGroup({
      layout: (this.countPipeline as GPUComputePipeline).getBindGroupLayout(0),
      entries: [...binEntries, { binding: 3, resource: { buffer: this.binCounts as GPUBuffer } }],
    });
    /*
     * **The prefix sum binds three of the five, because `layout: 'auto'` infers a layout from what
     * the shader actually reads.** `MATERIAL_OFFSETS_WGSL` shares a preamble with the other two
     * and never touches the visibility buffer or the material table, so those bindings are not in
     * its layout and naming them is an error rather than a redundancy. The device says so by
     * index: "binding index 1 not present in the bind group layout".
     */
    this.offsetsGroup = device.createBindGroup({
      layout: (this.offsetsPipeline as GPUComputePipeline).getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: this.binSettingsBuffer as GPUBuffer } },
        { binding: 3, resource: { buffer: this.binCounts as GPUBuffer } },
        { binding: 4, resource: { buffer: this.binOffsets as GPUBuffer } },
        { binding: 5, resource: { buffer: this.binDispatch as GPUBuffer } },
      ],
    });
    this.scatterGroup = device.createBindGroup({
      layout: (this.scatterPipeline as GPUComputePipeline).getBindGroupLayout(0),
      entries: [
        ...binEntries,
        { binding: 3, resource: { buffer: this.binCursors as GPUBuffer } },
        { binding: 4, resource: { buffer: this.binPixels as GPUBuffer } },
      ],
    });

    this.shadeGroup = device.createBindGroup({
      layout: (this.shadePipeline as GPUComputePipeline).getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: this.frameBuffer as GPUBuffer } },
        { binding: 1, resource: { buffer: this.visibility as GPUBuffer } },
        { binding: 2, resource: { buffer: this.binPixels as GPUBuffer } },
        { binding: 3, resource: { buffer: this.binOffsets as GPUBuffer } },
        { binding: 4, resource: { buffer: this.binCounts as GPUBuffer } },
        { binding: 5, resource: { buffer: this.clusterMeta as GPUBuffer } },
        { binding: 6, resource: { buffer: this.indices as GPUBuffer } },
        { binding: 7, resource: { buffer: this.vertices as GPUBuffer } },
        { binding: 8, resource: { buffer: this.transformBuffer as GPUBuffer } },
        { binding: 9, resource: { buffer: this.materialTable as GPUBuffer } },
        { binding: 10, resource: this.colourView as GPUTextureView },
        { binding: 11, resource: this.shadowView as GPUTextureView },
        {
          binding: 12,
          resource: this.environmentView ?? (this.emptyEnvironmentView as GPUTextureView),
        },
        { binding: 13, resource: this.environmentSampler ?? (this.emptySampler as GPUSampler) },
        { binding: 14, resource: this.latentsView as GPUTextureView },
        { binding: 15, resource: this.latentClamp as GPUSampler },
        { binding: 16, resource: this.latentRepeat as GPUSampler },
        { binding: 17, resource: { buffer: this.decodeNodes as GPUBuffer } },
        { binding: 18, resource: { buffer: this.decodeWeights as GPUBuffer } },
      ],
    });

    this.blitGroup = device.createBindGroup({
      layout: (this.blitPipeline as GPURenderPipeline).getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: (this.colourTexture as GPUTexture).createView() },
        /* The depth the raster wrote, sampled so the blit can hand it to the frame. */
        ...(this.presentDepth
          ? [
              {
                binding: 1,
                resource: (this.depthTexture as GPUTexture).createView(),
              },
            ]
          : []),
      ],
    });

    /* Everything the transparent raster reads: the same scene, the same frame, its own list. */
    /*
     * Held rather than built, because whether the pipeline is usable is not known yet: the error
     * scopes settle on a microtask and this runs synchronously. `watchBlendPipeline` runs it once
     * the device has answered, and never if the answer was no.
     */
    this.makeBlendGroup = (): GPUBindGroup =>
      device.createBindGroup({
        layout: (this.blendPipeline as GPURenderPipeline).getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: this.viewProjBuffer as GPUBuffer } },
          { binding: 1, resource: { buffer: this.blendList as GPUBuffer } },
          { binding: 2, resource: { buffer: this.clusterMeta as GPUBuffer } },
          { binding: 3, resource: { buffer: this.indices as GPUBuffer } },
          { binding: 4, resource: { buffer: this.vertices as GPUBuffer } },
          { binding: 5, resource: { buffer: this.transformBuffer as GPUBuffer } },
          { binding: 6, resource: { buffer: this.materialOf as GPUBuffer } },
          { binding: 7, resource: { buffer: this.materialTable as GPUBuffer } },
          { binding: 8, resource: { buffer: this.frameBuffer as GPUBuffer } },
          {
            binding: 9,
            resource: this.environmentView ?? (this.emptyEnvironmentView as GPUTextureView),
          },
          {
            binding: 10,
            resource: this.environmentSampler ?? (this.emptySampler as GPUSampler),
          },
          { binding: 11, resource: this.latentsView as GPUTextureView },
          { binding: 12, resource: this.latentClamp as GPUSampler },
          { binding: 13, resource: this.latentRepeat as GPUSampler },
          { binding: 14, resource: { buffer: this.decodeNodes as GPUBuffer } },
          { binding: 15, resource: { buffer: this.decodeWeights as GPUBuffer } },
        ],
      });

    /*
     * And build it now where the device has already answered, which is the ordinary case: the
     * verdict lands before this runs on a device with no error scopes, and after it on one that
     * has them. Whichever order, exactly one of the two places builds the group.
     */
    if (this.blendUsable) this.blendRasterGroup = this.makeBlendGroup();
    this.blendResolveGroup = device.createBindGroup({
      layout: (this.blendResolvePipeline as GPURenderPipeline).getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: this.oitAccumView as GPUTextureView },
        { binding: 1, resource: this.oitRevealView as GPUTextureView },
      ],
    });
  }

  /**
   * Take the frame's probe, and say whether the shading pass's bind group has to be rebuilt.
   *
   * **Compared by identity rather than copied**, because a texture view is the thing that changes
   * when a grid is rebaked at a different size and nothing else in the block does. A frame that
   * offers the same view as the last one rebuilds nothing.
   */
  private adoptEnvironment(environment: PassEnvironment | null): boolean {
    const view = environment?.view ?? null;
    const sampler = environment?.sampler ?? null;
    const changed = view !== this.environmentView || sampler !== this.environmentSampler;
    this.environmentView = view;
    this.environmentSampler = sampler;
    this.environment = environment;
    return changed;
  }

  /** Fill the per-frame blocks from the view the caller set. */
  /**
   * Upload the records the scene has changed since the last frame (its geometry went up when it
   * was placed), and nothing else.
   *
   * **Before anything is recorded into the encoder, because a dispatch reads what a queue write
   * has not landed.** `queue.writeBuffer` is ordered against other queue work and *not* against an
   * encoder's commands, which this backend has already paid for once: rewriting one params buffer
   * between dispatches gave every dispatch the last write, and the fix there was one bind group per
   * dispatch at a 256-aligned offset. Here the ordering is simply respected.
   *
   * **A frame that changed nothing uploads nothing**, which is what makes a static scene cost what
   * it cost before this existed.
   */
  private applyStream(queue: GPUQueue): void {
    const scene = this.scene;
    const dirty = scene.takeDirty();
    if (dirty.clusters.length === 0 && dirty.meshes.length === 0) return;

    for (const span of dirty.clusters) {
      const count = span.to - span.from;
      queue.writeBuffer(
        this.clusterCull as GPUBuffer,
        span.from * STREAM_CULL_FLOATS * 4,
        scene.cull,
        span.from * STREAM_CULL_FLOATS,
        count * STREAM_CULL_FLOATS,
      );
      queue.writeBuffer(
        this.clusterLod as GPUBuffer,
        span.from * STREAM_LOD_FLOATS * 4,
        scene.lod,
        span.from * STREAM_LOD_FLOATS,
        count * STREAM_LOD_FLOATS,
      );
      queue.writeBuffer(
        this.clusterMeta as GPUBuffer,
        span.from * STREAM_META_WORDS * 4,
        scene.meta,
        span.from * STREAM_META_WORDS,
        count * STREAM_META_WORDS,
      );
      queue.writeBuffer(
        this.materialOf as GPUBuffer,
        span.from * 4,
        scene.materialOf,
        span.from,
        count,
      );
    }
    for (const span of dirty.meshes) {
      const count = span.to - span.from;
      queue.writeBuffer(
        this.transformBuffer as GPUBuffer,
        span.from * 16 * 4,
        scene.transforms,
        span.from * 16,
        count * 16,
      );
      queue.writeBuffer(
        this.instanceSpheres as GPUBuffer,
        span.from * 4 * 4,
        scene.instanceSpheres,
        span.from * 4,
        count * 4,
      );
    }

    /*
     * **Refitted, because the sphere the light is fitted to is a property of the scene.** It stood
     * still while the geometry did; a world that streams moves it, so its edges crawl — the known
     * limitation §3.4 of the design names and neither demo this was built for depends on.
     */
    scene.sceneBounds(this.bounds);
  }

  /** The radius of the sphere the shadow camera is fitted to. Diagnostic, and a test reads it. */
  shadowExtent(): number {
    return this.bounds[3] as number;
  }

  private writeFrame(device: GPUDevice): boolean {
    const view = this.view;
    if (view === null || this.clipCorrection === null) return false;
    /*
     * **Jittered as the renderer's own verbs are, before the correction**, so a reconstructed
     * frame's resolve finds this pipeline's surfaces where it un-jitters them to. Zero, and so the
     * consumer's matrix bit for bit, on a frame that is not reconstructed.
     */
    jitterClip(this.viewProj, view.viewProj, this.jitter);
    multiply(this.corrected, this.clipCorrection, this.viewProj);
    frustumPlanes(this.corrected, this.planes);

    /*
     * **Fitted every frame, because the sun moves and the eye may.** The box is the scene's
     * bounding sphere seen from wherever the light is now, or — once the scene is larger than
     * `followRadius` — a sphere of that radius around the eye, snapped to whole texels. See
     * `fitShadow`; a few dozen multiplies either way, and a day cycle needs nothing else.
     */
    this.shadowSpan = fitShadow(
      this.bounds,
      view.eye,
      this.shadowFollow,
      view.lightDir,
      this.shadowSize,
      this.light,
    );
    correctShadowMatrix(SHADOW_RASTER_CORRECTION, this.light, this.lightRaster);
    correctShadowMatrix(SHADOW_LOOKUP_CORRECTION, this.light, this.lightLookup);
    /* In the lookup's convention, depth 0 to 1, which is the one the cull's two depth planes read. */
    frustumPlanes(this.lightLookup, this.lightPlanes);

    const params = this.frameParams;
    params.set(this.corrected, 0);
    params.set(this.lightLookup, FRAME_LIGHT_VIEW_PROJ);
    params[FRAME_EYE] = view.eye[0];
    params[FRAME_EYE + 1] = view.eye[1];
    params[FRAME_EYE + 2] = view.eye[2];
    params[FRAME_LIGHT_DIR] = view.lightDir[0];
    params[FRAME_LIGHT_DIR + 1] = view.lightDir[1];
    params[FRAME_LIGHT_DIR + 2] = view.lightDir[2];
    params[FRAME_LIGHT_COLOUR] = view.lightColour[0];
    params[FRAME_LIGHT_COLOUR + 1] = view.lightColour[1];
    params[FRAME_LIGHT_COLOUR + 2] = view.lightColour[2];
    params[FRAME_SKY] = view.ambient[0];
    params[FRAME_SKY + 1] = view.ambient[1];
    params[FRAME_SKY + 2] = view.ambient[2];
    params[FRAME_GROUND] = view.ambientGround[0];
    params[FRAME_GROUND + 1] = view.ambientGround[1];
    params[FRAME_GROUND + 2] = view.ambientGround[2];
    /*
     * **The width the raster drew at, and the row the buffer stores, apart.** The shading pass
     * finds a pixel by the row and places a triangle's corners by the width; with one number for
     * both, every frame whose width is not a multiple of `WIDTH_ALIGN` placed its corners as
     * though it were wider, and every texture coordinate slid sideways.
     */
    params[FRAME_SIZE] = this.width;
    params[FRAME_SIZE + 1] = this.height;
    params[FRAME_PITCH] = this.stride;
    params[FRAME_SIZE + 2] = view.time ?? 0;
    params[FRAME_SIZE + 3] = this.decode.layerSize;
    params[FRAME_SHADOW] = Math.min(Math.max(view.shadowStrength ?? 1, 0), 1);
    params[FRAME_SHADOW + 1] = this.shadowSize;
    params[FRAME_SHADOW + 2] = this.shadowSpan;
    params[FRAME_SHADOW + 3] = this.shadowMaxDistance;
    params[FRAME_SHADOW_LIMITS] = this.shadowMaxSlope;
    params[FRAME_SHADOW_LIMITS + 1] = this.shadowTaps;

    /*
     * **The probe's four numbers, or zeros.** `environment.w` at zero is what turns both
     * image-based terms off in the shader — the radiance falls back to the two-colour gradient the
     * forward path reflects in the same situation, and the split sum's selector goes with it,
     * because that fit is the correct share of a prefiltered chain and of nothing else.
     */
    const room = this.environment;
    params[FRAME_ENVIRONMENT] = room?.edge ?? 0;
    params[FRAME_ENVIRONMENT + 1] = room?.maxLod ?? 0;
    params[FRAME_ENVIRONMENT + 2] = room?.irradianceLevel ?? 0;
    params[FRAME_ENVIRONMENT + 3] = room === null ? 0 : 1;
    /*
     * **A view with no fog writes a density of zero**, which `mediumFog` answers zero to at every
     * distance — so the block is always present and the shader never branches on whether it is.
     */
    const fog = view.fog;
    params[FRAME_FOG_COLOUR] = fog?.colour[0] ?? 0;
    params[FRAME_FOG_COLOUR + 1] = fog?.colour[1] ?? 0;
    params[FRAME_FOG_COLOUR + 2] = fog?.colour[2] ?? 0;
    params[FRAME_FOG_COLOUR + 3] = fog?.eyeY ?? 0;
    params[FRAME_FOG_UNDERWATER] = fog?.underwaterColour[0] ?? 0;
    params[FRAME_FOG_UNDERWATER + 1] = fog?.underwaterColour[1] ?? 0;
    params[FRAME_FOG_UNDERWATER + 2] = fog?.underwaterColour[2] ?? 0;
    params[FRAME_FOG_UNDERWATER + 3] = fog?.underwaterFactor ?? 0;
    params[FRAME_FOG_HEIGHT] = fog?.heightFalloff ?? 0;
    params[FRAME_FOG_HEIGHT + 1] = fog?.density ?? 0;
    params[FRAME_FOG_RANGE] = fog?.near ?? 0;
    params[FRAME_FOG_RANGE + 1] = fog?.far ?? 0;
    params[FRAME_FOG_RANGE + 2] = fog?.mode ?? MEDIUM_FOG;
    params[FRAME_FOG_RANGE + 3] = fog?.underwaterDensity ?? 0;
    /* The scene's own decision about whether its grid supplies the ambient, as it is on the
       forward path: `ProbeBakeOptions.irradiance` reaches here as `PassEnvironment.irradiance`. */
    params[FRAME_ENVIRONMENT_MIX] = room !== null && room.irradiance ? 1 : 0;
    /* Every glow's scale, as `uEmissiveGain * uNightFactor` is on the forward path. */
    params[FRAME_ENVIRONMENT_MIX + 1] = (view.emissiveGain ?? 1) * (view.nightFactor ?? 1);

    this.lodParams[0] = this.height;
    this.lodParams[1] = view.fovY;
    this.lodParams[2] = view.lodThreshold;
    this.lodParams[3] = view.eye[0];
    this.lodParams[4] = view.eye[1];
    this.lodParams[5] = view.eye[2];
    /* Zero: the opaque half. The blended half is the same six numbers with a one here. */
    this.lodParams[6] = 0;
    this.lodParamsBlend.set(this.lodParams);
    this.lodParamsBlend[6] = 1;

    const base = this.levels[0] as Level;
    this.cullSettings[0] = view.eye[0];
    this.cullSettings[1] = view.eye[1];
    this.cullSettings[2] = view.eye[2];
    this.cullSettings[4] = base.width;
    this.cullSettings[5] = base.height;
    this.cullSettings[6] = this.levels.length;
    this.cullSettings[7] = this.clusterCount;

    const queue = device.queue;
    queue.writeBuffer(this.viewProjBuffer as GPUBuffer, 0, this.corrected);
    /* The same two numbers the shading pass reads out of its frame block, for the alpha test. */
    this.rasterParamValues[0] = params[FRAME_SIZE + 2] as number;
    this.rasterParamValues[1] = params[FRAME_SIZE + 3] as number;
    queue.writeBuffer(this.rasterParams as GPUBuffer, 0, this.rasterParamValues);
    queue.writeBuffer(this.shadowMatrix as GPUBuffer, 0, this.lightRaster);
    queue.writeBuffer(this.shadowPlanes as GPUBuffer, 0, this.lightPlanes);
    correctShadowMatrix(SHADOW_CULL_CORRECTION, this.lightRaster, this.lightCull);
    queue.writeBuffer(this.shadowCullMatrix as GPUBuffer, 0, this.lightCull);
    lightConeEye(view.eye, view.lightDir, this.shadowConeEye);
    this.shadowCullValues[0] = this.shadowConeEye[0];
    this.shadowCullValues[1] = this.shadowConeEye[1];
    this.shadowCullValues[2] = this.shadowConeEye[2];
    /* Two buffers for the reason the camera's phases have two: a queue write lands when made. */
    this.shadowCullValues[3] = 0;
    queue.writeBuffer(this.shadowCullSettings as GPUBuffer, 0, this.shadowCullValues);
    this.shadowCullValues[3] = this.occlusion ? 1 : 0;
    queue.writeBuffer(this.shadowCullSettingsTwo as GPUBuffer, 0, this.shadowCullValues);
    queue.writeBuffer(this.planesBuffer as GPUBuffer, 0, this.planes);
    queue.writeBuffer(this.frameBuffer as GPUBuffer, 0, params);
    queue.writeBuffer(this.lodBuffer as GPUBuffer, 0, this.lodParams);
    if (this.blendLodBuffer !== null) {
      queue.writeBuffer(this.blendLodBuffer, 0, this.lodParamsBlend);
    }
    /*
     * **Phase one has no pyramid, and it has a buffer of its own to say so.** The pyramid it would
     * test against is last frame's, seen from last frame's camera, and a cluster that one wrongly
     * hides is lost for the frame: phase one does not draw it, and phase two judges only what the
     * history does not hold.
     *
     * This was one buffer written twice — 0 here and 1 just before phase two — and a queue write
     * lands when it is made, while the frame's commands run at submit. So phase one read the 1.
     * `gpuDrivenPass.test.ts` reads each dispatch's settings as the device would.
     */
    const [phaseOne, phaseTwo, blend] = this.cullBuffers as [GPUBuffer, GPUBuffer, GPUBuffer];
    this.cullSettings[CULL_CONES] = 1;
    this.cullSettings[3] = 0;
    queue.writeBuffer(phaseOne, 0, this.cullSettings);
    /* Phase two's pyramid, and the blended run's after it, unless occlusion was switched off. */
    this.cullSettings[3] = this.occlusion ? 1 : 0;
    queue.writeBuffer(phaseTwo, 0, this.cullSettings);
    /*
     * **Phase two's settings with the cones off, in a buffer of its own** for the reason phase one
     * has one: a queue write lands when it is made, so one buffer written twice is read as the
     * second write by every dispatch in the frame.
     */
    this.cullSettings[CULL_CONES] = 0;
    queue.writeBuffer(blend, 0, this.cullSettings);
    return true;
  }

  prepare(ctx: PrepareContext): void {
    if (ctx.backend !== 'webgpu') return;
    /* Nothing is encoded until the device has answered for the pipelines. See `usable`. */
    if (!this.usable) return;
    const device = this.device;
    if (device === null || this.levels.length === 0) return;
    /* Before `writeFrame`, which reads what this took, and before the groups it may invalidate. */
    if (this.adoptEnvironment(ctx.environment)) this.buildSizedGroups(device);
    /* Last frame's figures, now that last frame's encoder has been submitted. See `readTimings`. */
    this.readTimings();
    this.readCounts();
    /* Before `writeFrame`, which fits the shadow to bounds this may have moved. */
    this.applyStream(device.queue);
    this.jitter = ctx.jitter;
    if (!this.writeFrame(device)) return;

    const encoder = ctx.encoder;
    const [argsOne, argsTwo] = this.args as [GPUBuffer, GPUBuffer];

    /*
     * **Asked of the material table rather than of the frame**, because it cannot change within
     * one: the table is written when the pass is built. A scene with nothing blended schedules the
     * three transparent stages away entirely and encodes the frame it encoded before they existed.
     */
    this.shape.blended = this.materials.some((material) => material.blend === true);

    /* `instanceCount` is the one word the compaction touches; the other three never change. */
    encoder.clearBuffer(argsOne, 4, 4);
    encoder.clearBuffer(argsTwo, 4, 4);
    if (this.shape.blended) encoder.clearBuffer(this.blendArgs as GPUBuffer, 4, 4);
    encoder.clearBuffer(this.writeHistory());
    encoder.clearBuffer(this.binCounts as GPUBuffer);

    /*
     * **Scheduled, then encoded.** The shading reads the map only where the frame is shadowed, and
     * the test is the shader's own — it returns before the lookup when the strength is not above
     * zero — so a frame that asked for no shadow schedules the stage that draws one away.
     */
    this.shape.shadowed = !((this.frameParams[FRAME_SHADOW] ?? 0) <= 0);
    resetDeps(this.graph);
    const first = recordGpuDrivenStages(this.graph, GPU_DRIVEN_RESOURCES, this.shape);
    const passes = scheduleGraph(
      this.graph,
      this.graph.count,
      FRAME_LIVE,
      GPU_DRIVEN_ORDERED,
      this.scheduled,
      this.graphScratch,
    );
    for (let p = 0; p < passes; p += 1) {
      const pass = this.scheduled[p];
      if (pass === undefined) break;
      for (let node = pass.first; node < pass.first + pass.count; node += 1) {
        this.encodeStage(encoder, GPU_DRIVEN_PASSES[node - first] as GpuDrivenPassName);
      }
    }

    if (this.queries !== null && this.queryResolve !== null && this.queryRead !== null) {
      if (!this.queryCopied && !this.queryMapping) {
        const pairs = GPU_DRIVEN_STAGES.length * 2;
        encoder.resolveQuerySet(this.queries, 0, pairs, this.queryResolve, 0);
        encoder.copyBufferToBuffer(this.queryResolve, 0, this.queryRead, 0, pairs * 8);
        this.queryCopied = true;
      }
    }
    if (this.countDrawn) this.copyCounts(device, encoder);

    this.flipped = !this.flipped;
    this.buildSwappedGroups(device);
  }

  /**
   * One stage of the frame, onto the encoder. `pipeline.ts` says what each reads and writes, and
   * the schedule says whether it runs; this is what it issues.
   */
  private encodeStage(encoder: GPUCommandEncoder, stage: GpuDrivenPassName): void {
    const groups = this.clusterGroups();
    const pixels = Math.ceil((this.stride * this.height) / BIN_GROUP_SIZE);
    switch (stage) {
      case 'clearColour':
        /*
         * **Emptied, because the shading writes only what the frame covered.** Alpha is what the
         * blit reads to decide whether this pipeline drew a pixel at all; left over from last frame
         * it paints a stale picture over the sky, and never cleared at all it paints black over it.
         */
        encoder
          .beginRenderPass({
            label: 'gpu-driven clear colour',
            colorAttachments: [
              {
                view: this.colourView as GPUTextureView,
                clearValue: { r: 0, g: 0, b: 0, a: 0 },
                loadOp: 'clear',
                storeOp: 'store',
              },
            ],
          })
          .end();
        return;
      case 'shadow':
        this.drawShadow(encoder);
        return;
      case 'instanceCull': {
        /* Before the cut, which reads what this writes. See `instances.ts`. */
        const instances = encoder.beginComputePass({
          label: 'gpu-driven instance cull',
          timestampWrites: this.writesFor('instanceCull'),
        });
        instances.setPipeline(this.instancePipeline as GPUComputePipeline);
        instances.setBindGroup(0, this.instanceGroup as GPUBindGroup);
        instances.dispatchWorkgroups(Math.max(1, Math.ceil(this.meshCount / 64)));
        instances.end();
        return;
      }
      case 'cut': {
        const first = encoder.beginComputePass({
          label: 'gpu-driven cut and phase one cull',
          timestampWrites: this.writesFor('cut'),
        });
        first.setPipeline(this.lodPipeline as GPUComputePipeline);
        first.setBindGroup(0, this.lodGroup as GPUBindGroup);
        first.dispatchWorkgroups(groups);
        first.setPipeline(this.cullPipeline as GPUComputePipeline);
        first.setBindGroup(0, (this.cullGroups as [GPUBindGroup, GPUBindGroup, GPUBindGroup])[0]);
        first.dispatchWorkgroups(groups);
        first.setPipeline(this.compactPipeline as GPUComputePipeline);
        first.setBindGroup(0, (this.compactGroups as [GPUBindGroup, GPUBindGroup])[0]);
        first.dispatchWorkgroups(groups);
        first.end();
        return;
      }
      case 'phaseOneDraw':
        this.drawPhase(encoder, 0, true);
        return;
      case 'pyramid': {
        /* From the depth phase one just wrote. This is the whole reason for two halves. */
        const pyramid = encoder.beginComputePass({
          label: 'gpu-driven depth pyramid',
          timestampWrites: this.writesFor('pyramid'),
        });
        const base = this.levels[0] as Level;
        pyramid.setPipeline(this.seedPipeline as GPUComputePipeline);
        pyramid.setBindGroup(0, this.seedGroup as GPUBindGroup);
        pyramid.dispatchWorkgroups(Math.ceil(base.width / 8), Math.ceil(base.height / 8));
        pyramid.setPipeline(this.reducePipeline as GPUComputePipeline);
        for (let level = 1; level < this.levels.length; level += 1) {
          const size = this.levels[level] as Level;
          pyramid.setBindGroup(0, this.reduceGroups[level - 1] as GPUBindGroup);
          pyramid.dispatchWorkgroups(Math.ceil(size.width / 8), Math.ceil(size.height / 8));
        }
        pyramid.end();
        return;
      }
      case 'phaseTwoCull': {
        /* The same cull with the pyramid switched on, over what phase one did not hold. */
        const second = encoder.beginComputePass({
          label: 'gpu-driven phase two cull',
          timestampWrites: this.writesFor('phaseTwoCull'),
        });
        second.setPipeline(this.cullPipeline as GPUComputePipeline);
        second.setBindGroup(0, (this.cullGroups as [GPUBindGroup, GPUBindGroup, GPUBindGroup])[1]);
        second.dispatchWorkgroups(groups);
        second.setPipeline(this.compactPipeline as GPUComputePipeline);
        second.setBindGroup(0, (this.compactGroups as [GPUBindGroup, GPUBindGroup])[1]);
        second.dispatchWorkgroups(groups);
        second.end();
        return;
      }
      case 'phaseTwoDraw':
        this.drawPhase(encoder, 1, false);
        return;
      case 'blendCull': {
        /*
         * **The front half, run again over the other half of the scene.** Three dispatches, the
         * same three the opaque cut issues and the same three pipelines: which clusters, at which
         * level of detail, and pack the survivors into a list. Only the cut's seventh parameter
         * and the buffers the compaction writes into are different.
         *
         * **The cull runs with the pyramid on**, which is the phase-two settings: the depth is
         * complete by now, so a pane wholly behind a wall is occluded exactly as an opaque cluster
         * there would be.
         */
        const cut = encoder.beginComputePass({
          label: 'gpu-driven blend cull',
          timestampWrites: this.writesFor('blendCull'),
        });
        cut.setPipeline(this.lodPipeline as GPUComputePipeline);
        cut.setBindGroup(0, this.blendLodGroup as GPUBindGroup);
        cut.dispatchWorkgroups(groups);
        cut.setPipeline(this.cullPipeline as GPUComputePipeline);
        /* Phase two's settings with the cone test off: the blended raster draws both sides. */
        cut.setBindGroup(0, (this.cullGroups as [GPUBindGroup, GPUBindGroup, GPUBindGroup])[2]);
        cut.dispatchWorkgroups(groups);
        cut.setPipeline(this.compactPipeline as GPUComputePipeline);
        cut.setBindGroup(0, this.blendCompactGroup as GPUBindGroup);
        cut.dispatchWorkgroups(groups);
        cut.end();
        return;
      }
      case 'blendDraw': {
        /*
         * **Skipped where the device refused the pipeline, rather than drawn with an invalid one.**
         * Everything opaque has already been drawn by the time this runs, so what is lost is the
         * glass and not the city. See `watchBlendPipeline`.
         */
        if (!this.blendUsable || this.blendPipeline === null || this.blendRasterGroup === null)
          return;
        const pass = encoder.beginRenderPass({
          label: 'gpu-driven blend draw',
          colorAttachments: [
            {
              view: this.oitAccumView as GPUTextureView,
              clearValue: { r: 0, g: 0, b: 0, a: 0 },
              loadOp: 'clear',
              storeOp: 'store',
            },
            {
              /*
               * **Cleared to one: nothing has covered this pixel yet.** Cleared to zero the resolve
               * would show no scene anywhere the pass ran, which is a black frame that looks like
               * the blend working. `renderer.ts`'s own pass carries the same line.
               */
              view: this.oitRevealView as GPUTextureView,
              clearValue: { r: 1, g: 1, b: 1, a: 1 },
              loadOp: 'clear',
              storeOp: 'store',
            },
          ],
          depthStencilAttachment: {
            view: (this.depthTexture as GPUTexture).createView(),
            depthReadOnly: true,
          },
          timestampWrites: this.writesFor('blendDraw'),
        });
        pass.setPipeline(this.blendPipeline);
        pass.setBindGroup(0, this.blendRasterGroup);
        pass.setViewport(0, 0, this.width, this.height, 0, 1);
        pass.drawIndirect(this.blendArgs as GPUBuffer, 0);
        pass.end();
        return;
      }
      case 'blendResolve': {
        const pass = encoder.beginRenderPass({
          label: 'gpu-driven blend resolve',
          colorAttachments: [
            { view: this.colourView as GPUTextureView, loadOp: 'load', storeOp: 'store' },
          ],
          timestampWrites: this.writesFor('blendResolve'),
        });
        pass.setPipeline(this.blendResolvePipeline as GPURenderPipeline);
        pass.setBindGroup(0, this.blendResolveGroup as GPUBindGroup);
        pass.draw(3);
        pass.end();
        return;
      }
      case 'visibilityCopy':
        /* The binning reads a buffer and a render attachment is not one. See the header. */
        encoder.copyTextureToBuffer(
          { texture: this.visibilityTexture as GPUTexture },
          { buffer: this.visibility as GPUBuffer, bytesPerRow: this.stride * 4 },
          { width: this.stride, height: this.height },
        );
        return;
      case 'bin': {
        const binning = encoder.beginComputePass({
          label: 'gpu-driven material bins',
          timestampWrites: this.writesFor('bin'),
        });
        binning.setPipeline(this.countPipeline as GPUComputePipeline);
        binning.setBindGroup(0, this.countGroup as GPUBindGroup);
        binning.dispatchWorkgroups(pixels);
        binning.setPipeline(this.offsetsPipeline as GPUComputePipeline);
        binning.setBindGroup(0, this.offsetsGroup as GPUBindGroup);
        binning.dispatchWorkgroups(1);
        binning.end();
        return;
      }
      case 'cursorCopy':
        /* The cursors start as a copy of the offsets, because the offsets must survive the scatter. */
        encoder.copyBufferToBuffer(
          this.binOffsets as GPUBuffer,
          0,
          this.binCursors as GPUBuffer,
          0,
          Math.max(1, this.materials.length) * 4,
        );
        return;
      case 'shade': {
        const shade = encoder.beginComputePass({
          label: 'gpu-driven scatter and shade',
          timestampWrites: this.writesFor('shade'),
        });
        shade.setPipeline(this.scatterPipeline as GPUComputePipeline);
        shade.setBindGroup(0, this.scatterGroup as GPUBindGroup);
        shade.dispatchWorkgroups(pixels);
        shade.setPipeline(this.shadePipeline as GPUComputePipeline);
        shade.setBindGroup(0, this.shadeGroup as GPUBindGroup);
        for (let m = 0; m < this.jobGroups.length; m += 1) {
          shade.setBindGroup(1, this.jobGroups[m] as GPUBindGroup);
          /* Indirect, from the block the prefix sum wrote: an empty bin is zero groups. */
          shade.dispatchWorkgroupsIndirect(
            this.binDispatch as GPUBuffer,
            m * BIN_DISPATCH_WORDS * 4,
          );
        }
        shade.end();
        return;
      }
    }
  }

  /**
   * The device milliseconds each stage took, or null where nothing measured them.
   *
   * One frame behind, because a timestamp is read back and a readback that blocked would be the
   * measurement changing what it measures. `null` until a frame has completed a map.
   */
  stageTime(stage: GpuDrivenStage): number | null {
    if (!this.timed) return null;
    return this.stageMs[GPU_DRIVEN_STAGES.indexOf(stage)] ?? null;
  }

  /** Every stage added up, which is what the pipeline costs the device. */
  get totalMs(): number | null {
    if (!this.timed) return null;
    let total = 0;
    for (const value of this.stageMs) total += value;
    return total;
  }

  /** The pair of slots a stage writes, or nothing where the device cannot time. */
  private writesFor(stage: GpuDrivenStage): GPUComputePassTimestampWrites | undefined {
    if (this.queries === null) return undefined;
    const at = GPU_DRIVEN_STAGES.indexOf(stage) * 2;
    return { querySet: this.queries, beginningOfPassWriteIndex: at, endOfPassWriteIndex: at + 1 };
  }

  /**
   * Ask for last frame's figures, once the frame that recorded them has been submitted.
   *
   * **At the start of the next frame rather than at the end of this one**, which is the whole of
   * the care this needs: `mapAsync` settles against the work already enqueued, and the copy is
   * still sitting in an encoder the renderer has not submitted yet.
   */
  private readTimings(): void {
    const read = this.queryRead;
    if (read === null || !this.queryCopied || this.queryMapping) return;
    this.queryMapping = true;
    void read
      .mapAsync(MAP_MODE_READ)
      .then(() => {
        const stamps = new BigUint64Array(read.getMappedRange().slice(0));
        for (let stage = 0; stage < GPU_DRIVEN_STAGES.length; stage += 1) {
          const began = stamps[stage * 2] ?? 0n;
          const ended = stamps[stage * 2 + 1] ?? 0n;
          this.stageMs[stage] = ended > began ? Number(ended - began) / 1e6 : 0;
        }
        this.timed = true;
        read.unmap();
      })
      .catch(() => {
        /* A device lost mid-map answers nothing, which is the honest figure for a frame that
           did not finish. The next frame asks again. */
      })
      .finally(() => {
        this.queryMapping = false;
        this.queryCopied = false;
      });
  }

  /**
   * How many clusters `list` drew, one frame behind as the stage times are, or null until a frame
   * has been read — and null always where `countDrawn` was not asked for.
   */
  drawnClusters(list: GpuDrivenList): number | null {
    if (!this.counted) return null;
    const at = GPU_DRIVEN_LISTS.indexOf(list);
    const counted = this.drawnCounts[at] as number;
    /* The map is drawn in two halves, and its count is both. */
    return list === 'shadow' ? counted + (this.drawnCounts[at + 1] as number) : counted;
  }

  /**
   * Each list's count into the read buffer, **after the whole frame**, so every draw that reads an
   * argument block has been encoded before the copy out of it. The buffer is cleared first, so a
   * list the frame did not draw — no blended material, no shadow — reads as none rather than as
   * whatever the last frame that drew it left. Nothing while a read is in flight: a buffer that is
   * mapped cannot be copied into. (A copy not yet read cannot be here: `readCounts` runs at the top
   * of every frame this ends, and maps whatever was copied.)
   */
  private copyCounts(device: GPUDevice, encoder: GPUCommandEncoder): void {
    if (this.countsMapping) return;
    const bytes = this.drawnCounts.byteLength;
    this.counts ??= device.createBuffer({
      label: 'gpu-driven drawn',
      size: bytes,
      usage: MAP_READ | COPY_DST,
    });
    const [argsOne, argsTwo] = this.args as [GPUBuffer, GPUBuffer];
    encoder.clearBuffer(this.counts, 0, bytes);
    encoder.copyBufferToBuffer(argsOne, 4, this.counts, 0, 4);
    encoder.copyBufferToBuffer(argsTwo, 4, this.counts, 4, 4);
    if (this.shape.blended) {
      encoder.copyBufferToBuffer(this.blendArgs as GPUBuffer, 4, this.counts, 8, 4);
    }
    if (this.shape.shadowed) {
      encoder.copyBufferToBuffer(this.shadowArgs as GPUBuffer, 4, this.counts, 12, 4);
      encoder.copyBufferToBuffer(this.shadowArgsTwo as GPUBuffer, 4, this.counts, 16, 4);
    }
    this.countsCopied = true;
  }

  /** Last frame's counts, asked for as `readTimings` asks for its figures and for its reason. */
  private readCounts(): void {
    const read = this.counts;
    if (read === null || !this.countsCopied || this.countsMapping) return;
    this.countsMapping = true;
    void read
      .mapAsync(MAP_MODE_READ)
      .then(() => {
        this.drawnCounts.set(new Uint32Array(read.getMappedRange().slice(0)));
        this.counted = true;
        read.unmap();
      })
      .catch(() => {
        /* A device lost mid-map answers nothing; the next frame asks again. */
      })
      .finally(() => {
        this.countsMapping = false;
        this.countsCopied = false;
      });
  }

  /** How many workgroups one dispatch over every cluster takes. */
  private clusterGroups(): number {
    return Math.max(1, Math.ceil(this.clusterCount / 64));
  }

  /** The half of the ping-pong this frame writes, which next frame will read. */
  private writeHistory(): GPUBuffer {
    return this.flipped ? (this.history as GPUBuffer) : (this.drawn as GPUBuffer);
  }

  /**
   * The map: what the light's own cull kept, drawn from the light, depth only — **in the camera's
   * two halves.**
   *
   * **The front half's three pipelines over buffers of the light's, twice**: the cut, the cull
   * against the light's box from the sun's side, and a compaction of what the light kept last
   * frame, drawn; then a pyramid of that depth, the same cull against it, and a compaction of the
   * rest, drawn over it. A three-degree sun over a city sees a strip of it a kilometre deep, and
   * everything behind the first row toward the sun is in that row's shadow — which is exactly what
   * the pyramid of the first half says, and what the frustum and the cones alone could not.
   * `CLUSTER_INDEX_CAP` vertices by one instance a listed cluster, as in the frame's own draw.
   *
   * **One figure for the stage**: the first compute pass writes where the stage began and the
   * second render pass where it ended, so `shadow` in the stage times is all of it.
   */
  private drawShadow(encoder: GPUCommandEncoder): void {
    const groups = this.clusterGroups();
    const writes = this.writesFor('shadow');
    const [cullOne, cullTwo] = this.shadowCullGroups as [GPUBindGroup, GPUBindGroup];
    const way = this.shadowFlipped ? 1 : 0;
    const [compactOne, compactTwo] = (
      this.shadowCompactGroups as [[GPUBindGroup, GPUBindGroup], [GPUBindGroup, GPUBindGroup]]
    )[way];
    /* The two words the compactions count in, and the half of the history this frame writes. */
    encoder.clearBuffer(this.shadowArgs as GPUBuffer, 4, 4);
    encoder.clearBuffer(this.shadowArgsTwo as GPUBuffer, 4, 4);
    encoder.clearBuffer((this.shadowHistories as [GPUBuffer, GPUBuffer])[1 - way] as GPUBuffer);

    const first = encoder.beginComputePass({
      label: 'gpu-driven shadow cull',
      timestampWrites:
        writes === undefined
          ? undefined
          : {
              querySet: writes.querySet,
              beginningOfPassWriteIndex: writes.beginningOfPassWriteIndex,
            },
    });
    first.setPipeline(this.lodPipeline as GPUComputePipeline);
    first.setBindGroup(0, this.shadowLodGroup as GPUBindGroup);
    first.dispatchWorkgroups(groups);
    first.setPipeline(this.cullPipeline as GPUComputePipeline);
    first.setBindGroup(0, cullOne);
    first.dispatchWorkgroups(groups);
    first.setPipeline(this.compactPipeline as GPUComputePipeline);
    first.setBindGroup(0, compactOne);
    first.dispatchWorkgroups(groups);
    first.end();
    this.drawShadowHalf(encoder, 0, undefined);

    /* From the depth the first half just wrote. This is the whole reason for two halves. */
    const second = encoder.beginComputePass({ label: 'gpu-driven shadow occlusion' });
    const base = this.shadowLevels[0] as Level;
    second.setPipeline(this.shadowSeedPipeline as GPUComputePipeline);
    second.setBindGroup(0, this.shadowSeedGroup as GPUBindGroup);
    second.dispatchWorkgroups(Math.ceil(base.width / 8), Math.ceil(base.height / 8));
    second.setPipeline(this.reducePipeline as GPUComputePipeline);
    for (let level = 1; level < this.shadowLevels.length; level += 1) {
      const size = this.shadowLevels[level] as Level;
      second.setBindGroup(0, this.shadowReduceGroups[level - 1] as GPUBindGroup);
      second.dispatchWorkgroups(Math.ceil(size.width / 8), Math.ceil(size.height / 8));
    }
    second.setPipeline(this.cullPipeline as GPUComputePipeline);
    second.setBindGroup(0, cullTwo);
    second.dispatchWorkgroups(groups);
    second.setPipeline(this.compactPipeline as GPUComputePipeline);
    second.setBindGroup(0, compactTwo);
    second.dispatchWorkgroups(groups);
    second.end();
    this.drawShadowHalf(encoder, 1, writes);
    this.shadowFlipped = !this.shadowFlipped;
  }

  /** One half of the map: the first clears it, the second draws over it and closes the stage's time. */
  private drawShadowHalf(
    encoder: GPUCommandEncoder,
    half: 0 | 1,
    writes: GPUComputePassTimestampWrites | undefined,
  ): void {
    const pass = encoder.beginRenderPass({
      label: half === 0 ? 'gpu-driven shadow' : 'gpu-driven shadow, phase 2',
      colorAttachments: [],
      depthStencilAttachment: {
        view: this.shadowView as GPUTextureView,
        depthClearValue: SHADOW_DEPTH_CLEAR,
        depthLoadOp: half === 0 ? 'clear' : 'load',
        depthStoreOp: 'store',
      },
      timestampWrites:
        writes === undefined
          ? undefined
          : { querySet: writes.querySet, endOfPassWriteIndex: writes.endOfPassWriteIndex },
    });
    pass.setPipeline(this.shadowPipeline as GPURenderPipeline);
    pass.setBindGroup(0, (half === 0 ? this.shadowGroup : this.shadowGroupTwo) as GPUBindGroup);
    pass.drawIndirect((half === 0 ? this.shadowArgs : this.shadowArgsTwo) as GPUBuffer, 0);
    pass.end();
  }

  private drawPhase(encoder: GPUCommandEncoder, phase: 0 | 1, clear: boolean): void {
    const pass = encoder.beginRenderPass({
      label: `gpu-driven phase ${phase + 1}`,
      colorAttachments: [
        {
          view: (this.visibilityTexture as GPUTexture).createView(),
          /* Cleared to the sentinel, not to zero: zero is triangle 0 of cluster 0, a real one. */
          clearValue: { r: VIS_EMPTY, g: 0, b: 0, a: 0 },
          loadOp: clear ? 'clear' : 'load',
          storeOp: 'store',
        },
      ],
      depthStencilAttachment: {
        view: (this.depthTexture as GPUTexture).createView(),
        depthClearValue: DEPTH_CLEAR,
        depthLoadOp: clear ? 'clear' : 'load',
        depthStoreOp: 'store',
      },
      timestampWrites: this.writesFor(phase === 0 ? 'phaseOneDraw' : 'phaseTwoDraw'),
    });
    pass.setPipeline(this.rasterPipeline as GPURenderPipeline);
    pass.setBindGroup(0, (this.rasterGroups as [GPUBindGroup, GPUBindGroup])[phase]);
    /* The used region, inside a target widened for the copy's row alignment. */
    pass.setViewport(0, 0, this.width, this.height, 0, 1);
    pass.drawIndirect((this.args as [GPUBuffer, GPUBuffer])[phase], 0);
    pass.end();
  }

  draw(ctx: PassContext): void {
    if (ctx.backend !== 'webgpu') return;
    /* The same gate as `prepare`: an unanswered or refused pipeline set encodes nothing at all. */
    if (!this.usable) return;
    if (this.blitPipeline === null || this.blitGroup === null) return;
    if (ctx.outputTransform !== 0 && !this.gradeWarned) {
      this.gradeWarned = true;
      /*
       * The pass writes linear light and expects a composite to grade it. A frame with no
       * composite grades per pass, and applying the curve here would be a second copy of it —
       * which is the thing `SHADE_MATERIAL_WGSL` is built to avoid. Said once, out loud, because
       * a silently ungraded frame is a difference somebody would attribute to the pipeline.
       */
      console.warn(
        '[driftengine] the gpu-driven pass writes linear light and this frame has no composite ' +
          'to grade it, so the picture will be flat. Use a quality profile with a scene target.',
      );
    }
    ctx.pass.setPipeline(this.blitPipeline);
    ctx.pass.setBindGroup(0, this.blitGroup);
    ctx.pass.draw(3);
  }

  dispose(device: PassDevice): void {
    /* Before the buffers go: a write to a destroyed buffer is a device error. See `detach`. */
    this.scene.detach();
    if (device.backend !== 'webgpu') return;
    this.disposeTargets();
    this.shadowTexture?.destroy();
    this.emptyEnvironment?.destroy();
    this.latents?.destroy();
    this.queries?.destroy();
    this.queryResolve?.destroy();
    this.queryRead?.destroy();
    this.counts?.destroy();
    for (const buffer of [
      this.clusterCull,
      this.clusterLod,
      this.clusterMeta,
      this.instanceSpheres,
      this.instanceFlags,
      this.indices,
      this.vertices,
      this.transformBuffer,
      this.materialOf,
      this.materialTable,
      this.decodeNodes,
      this.decodeWeights,
      this.jobs,
      this.shadowList,
      this.shadowMatrix,
      this.planesBuffer,
      this.viewProjBuffer,
      this.rasterParams,
      ...(this.cullBuffers ?? []),
      this.lodBuffer,
      this.blendLodBuffer,
      this.blendList,
      this.blendArgs,
      this.blendCompactSettings,
      this.zeroHistory,
      this.historySink,
      this.shadowArgs,
      this.shadowArgsTwo,
      this.shadowListTwo,
      this.shadowSelected,
      this.shadowKeep,
      this.shadowPlanes,
      this.shadowCullSettings,
      this.shadowCullSettingsTwo,
      this.shadowCompactSettings,
      this.shadowCompactSettingsTwo,
      ...(this.shadowHistories ?? []),
      this.shadowHzb,
      this.shadowLevelStart,
      this.shadowSeedSize,
      this.shadowCullMatrix,
      ...this.shadowLevels.map((level) => level.size),
      this.instanceNone,
      this.frameBuffer,
      this.selected,
      this.keep,
      this.history,
      this.drawn,
      ...(this.lists ?? []),
      ...(this.args ?? []),
      ...(this.phaseSettings ?? []),
    ]) {
      buffer?.destroy();
    }
    this.device = null;
  }
}

/**
 * `out = a · b`, column-major, the same order `renderer.ts` applies `CLIP_CORRECTION` in.
 *
 * Its own four lines rather than `gl-matrix`, because `render/backend/webgpu/` does not import it
 * and one multiply is not a reason to start.
 */
function multiply(out: Float32Array, a: ArrayLike<number>, b: ArrayLike<number>): void {
  for (let column = 0; column < 4; column += 1) {
    for (let row = 0; row < 4; row += 1) {
      let sum = 0;
      for (let k = 0; k < 4; k += 1) {
        sum += (a[k * 4 + row] as number) * (b[column * 4 + k] as number);
      }
      out[column * 4 + row] = sum;
    }
  }
}
