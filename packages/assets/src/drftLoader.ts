/** Loading a `.drft` into drawable parts progressively, without stalling the frame. */

import type { MeshData } from '@driftengine/drft';
import type { MeshHandle, RendererApi, ShadowCasters, Vec3 } from '@driftengine/core';
import type {
  CompressedTextureSource,
  GlassOptions,
  SurfaceTextureHandle,
} from '@driftengine/core';
import {
  MeshBuilder,
  computeLightMatrixForBounds,
  concatMeshes,
  placeMesh,
} from '@driftengine/core';
import { PartDraws } from './partDraws.ts';
import type { DrftMaterial } from '@driftengine/drft';
import type { DrftSdfvEntry } from '@driftengine/drft';
import { placeFields } from './fieldPlacement.ts';
import type { DrftFieldPlacement } from './fieldPlacement.ts';
import type { DrftTexture } from '@driftengine/drft';
import { TextureSet, textureColorSpaces } from './drftTextures.ts';
import { bcPlan, createBcDecoder } from './bcLoad.ts';
import { createEtc2Encoder, etc2Plan } from './etc2Load.ts';
import type { Etc2Encoder } from './etc2Load.ts';
import type { BcDecoder, BcWorker } from './bcLoad.ts';
import { decodeBc } from './bcDecode.ts';
import { isCompressedSource, uploadsCompressed } from '@driftengine/core';
import { CODEC_BC, codecName, readBcPayload } from '@driftengine/drft';
import type { BcImage } from '@driftengine/drft';
import { drawKeyOf, resolveDrawGrouping } from './drawKey.ts';
import type { DrawGrouping, DrawSurfaceOverride } from './drawKey.ts';
import {
  streamDrft,
  CODEC_JPEG,
  CODEC_PNG,
  CODEC_RAW,
  CODEC_WEBP,
  DrftError,
  expandAssembly,
} from '@driftengine/drft';
import type { AnimationClip, DrftLight, DrftMorph, DrftNode, DrftSkin } from '@driftengine/drft';
import type { DrftLightVolume, EntsScene, NavPolyMesh } from '@driftengine/drft';
import type { DrftLoadProgress, DrftPart } from './loadProgress.ts';
import { RegionStore, fitCopies } from './regionStore.ts';
import type { LoadedRegion } from './regionStore.ts';
import {
  DEFAULT_REVEAL_SEC,
  DEFAULT_UPLOAD_MS_PER_FRAME,
  DEFAULT_UPLOADS_PER_FRAME,
  isDocumentResponse,
  mayBeginMore,
} from './uploadBudget.ts';

/**
 * How a loaded model is placed: fitted to a size, or left exactly where its file puts it.
 *
 * **`'none'` exists because the way to ask for nothing was to ask for the answer.** A game whose
 * importer has already put a model in its own frame — metres, y = 0 at the road — wanted no fit
 * at all, and the only way to say so was to hand `load` the footprint and height it would have
 * computed, which means measuring the model to tell the loader not to measure it. The obvious
 * shortcut is a trap and a consumer fell in it: `footprint: Number.MAX_SAFE_INTEGER` does not mean
 * "do not scale", it means a scale of 2.3e15, and a car drawn nine quadrillion metres wide looks
 * from inside exactly like a model that failed to load.
 */
export type DrftFit =
  | {
      /** The size the larger of the model's footprint and height is scaled to. */
      readonly footprint: number;
      readonly height: number;
      /** Where its lowest point sits, for a scene whose floor is not at zero. Zero unless stated. */
      readonly baseY?: number;
    }
  | {
      /** Scale 1 and no offset: the model arrives in the coordinates the file states. */
      readonly fit: 'none';
    };

/**
 * How a container is reached. `typeof fetch`, narrowed to the one call shape this file makes.
 *
 * `@driftengine/audio` has had the identical seam since it was written, under the same name, and
 * this package went without it — so the loader for the engine's *own* format was the one that
 * could not be pointed at a service worker, a packed archive, a memory map or a fixture.
 */
export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export interface DrftLoaderOptions {
  /**
   * Where the bytes come from. The global `fetch` unless a consumer says otherwise.
   *
   * Optional and defaulting to the browser's, so no existing caller changes — the shape
   * `AGENTS.md` asks for: take the capability as a parameter, ship a browser implementation as
   * the default.
   */
  readonly fetchImpl?: FetchLike;
  /**
   * What starts the worker a BC texture the device cannot take as blocks is decoded in:
   * `spawnBcWorker`, from `@driftengine/assets/bcWorkers`. Absent, they decode on the main
   * thread and the loader says so once — the factory is behind its own specifier so a consumer that
   * never names it has no worker in its build. See `bcWorkers.ts`.
   *
   * **On a device that samples ETC2 and not BC**, which is a phone, a second worker from the same
   * factory then re-encodes each such texture as ETC2 or EAC and swaps the chain in behind the
   * handle its decoded image went up under, at half a byte a texel, or a byte with alpha, where the
   * image holds four. Nothing arrives later for it; see `etc2Load.ts` for what it costs. Without a worker
   * the textures stay RGBA.
   */
  readonly bcWorker?: () => BcWorker;
  /**
   * The most parts one `update` may take, however cheap they turn out to be.
   *
   * **A ceiling, not the budget.** The budget is `uploadMsPerFrame`, because what a part costs
   * cannot be known by counting parts — see `mayBeginMore`. This stays as the guard against the
   * opposite shape of asset, a model of hundreds of tiny parts where the clock would happily take
   * a hundred of them in one frame and spend the whole reveal in two.
   */
  readonly uploadsPerFrame?: number;
  /**
   * How long one `update` may spend starting new stream work, in milliseconds.
   *
   * `DEFAULT_UPLOAD_MS_PER_FRAME` unless stated. Raise it for a tool that would rather have the
   * model in front of it sooner than hold a rate; lower it for a scene where the frame matters
   * more than the wait. Zero is the slowest honest setting rather than a stall: one piece a frame
   * still begins, because a load has to finish.
   */
  readonly uploadMsPerFrame?: number;
  /** Seconds for a part to fade from nothing to itself. Zero makes it appear. */
  readonly revealSec?: number;
  /**
   * Anisotropic filtering asked of every image, where the extension exists.
   *
   * A model's maps are the case for it: tread on a tyre, a panel gap, a plate, all bands of fine
   * detail seen at a grazing angle, which is exactly where a trilinear sample gives up.
   */
  readonly anisotropy?: number;
  /**
   * How every image this asset carries behaves past its own edge. `repeat` unless stated.
   *
   * **Reported from outside, and it is a real trap on a bought model.** A surface texture repeats
   * by default, which is right for a tiling map and wrong at the border of a UV island: a sample
   * whose footprint crosses the edge wraps to the far side of the image, and a mip level high
   * enough averages across islands that have nothing to do with each other. On a model whose
   * untextured surfaces sit at an exporter's default `0.8` grey, the result is single bright pixels
   * tracing every seam of every textured part, which is invisible against a light background and
   * obvious against black paint.
   *
   * `clamp` is the repair where an asset's own UV padding is thin, and it is stated rather than
   * assumed because a model that genuinely tiles a map needs `repeat` and would band without it.
   */
  readonly textureWrap?: 'repeat' | 'clamp';
  /**
   * A last chance to change a mesh's vertex data before it is uploaded.
   *
   * For a scene that dresses an import rather than taking it as it comes: a bought asset that
   * stores every surface as the same default grey while naming them `body`, `glass` and `chrome`
   * can have its paint decided here, per material, without the loader knowing what a car is.
   */
  readonly transform?: (mesh: MeshData, material: DrftMaterial | undefined) => MeshData;
  /** Per-material opacity, reflectivity and metalness overrides, for the same reason as `transform`. */
  readonly surface?: (material: DrftMaterial | undefined) => DrawSurfaceOverride | undefined;
  /**
   * Draw a coarse whole model while the parts arrive, where the file carries one.
   *
   * **On when the file carries one, and `false` refuses it.** This was off by default for two
   * releases, on the argument that a `LODM` chunk is a *decimated* model and how good it looks
   * is a property of the asset rather than of this code. That argument was about the old hull,
   * which was built by clustering vertices and joined clusters lying on different surfaces of
   * the model, so a car grew spikes through its own bodywork and somebody waiting for it saw
   * white cliffs. A bad preview reads as a broken import where an empty stage reads as a load,
   * so refusing to guess was right.
   *
   * The hull is the surface of an occupancy grid now (`buildCoarseLevel`), which cannot do that:
   * it emits the boundary of a solid, so the worst case is a coarse version of the shape rather
   * than a shape that was never there. And nothing carries a `LODM` by accident. A chunk exists
   * only because somebody baked one, so ignoring it by default meant the file said one thing and
   * the reader did another.
   *
   * `outline: false` still refuses, for a caller swapping a model already on screen for a better
   * one, where a coarse version of the new one is a step backwards.
   */
  readonly outline?: boolean;
  /**
   * Keep the arrival state after the load, so `replay` can put any point of it back on screen.
   *
   * **Off by default, because it costs a second copy of the model on the GPU.** The load
   * normally ends by disposing the outline and the per-part meshes, since the merged groups
   * draw the same geometry in seven draws rather than 188. Holding them is what makes the
   * reveal *inspectable* rather than a thing that happens once and cannot be looked at again:
   * a stage that is only ever seen while the bytes are arriving can only be studied by
   * reloading, at whatever speed the network happens to give.
   *
   * The cost is stated rather than hidden: on a 187-part car the per-part meshes are about the
   * same vertex count as the merged ones, so this roughly doubles the geometry the asset holds.
   * For a tool, a documentation page or a demo that is worth it. For a game shipping a level
   * it is not, which is why it is not the default.
   */
  readonly keepReveal?: boolean;
  /**
   * Put a small version of each image on its surfaces before the full one, at this many pixels
   * on the longest side. Absent means every image arrives once, at full size.
   *
   * **This is the blur-to-sharp arrival of docs/FORMAT.md §4.6, done from the bytes already in
   * the file.** The section asks for mip levels stored smallest first as separate chunks, which
   * is the better answer for a metered connection because it can stop early and keep the small
   * one. It needs the *baker* to resize an image, and the baker runs in Node where there is no
   * decoder for a JPEG, so that half is a dependency decision rather than an implementation.
   *
   * What is available without one: `createImageBitmap` resizes while it decodes. A 256 pixel
   * version of a 2048 square costs a fraction of the full decode, so a surface stops being
   * flat about a second earlier on a real model, and the full image then replaces it in the
   * same GPU object. It costs a second decode per image, off the main thread, and not one byte
   * of the file — which is why it is an option a caller weighs rather than a default.
   */
  readonly texturePreview?: number;
  /**
   * Take each image as it decodes, by the name its `TEXS` chunk gives it, and upload none: for a
   * consumer that builds its own textures — a world packing every picture into a layer of an
   * array — where a surface texture of each as well would spend the memory twice. On the same
   * frame clock as an upload, one a frame; `null` for an image that did not decode. Materials in
   * the file that name an image then draw untextured, which is the consumer's to answer.
   */
  readonly onImage?: (name: string, image: ImageBitmap | null) => void;
  /**
   * Offered each mesh no region holds as it arrives, by its ordinal in the file; return true to
   * take it, and it is neither uploaded as a part nor merged. For a consumer that draws some of a
   * file's meshes its own way — a crowd of kinds it instances and moves every frame — which a part
   * cannot be, since the merge bakes a part into a static group by the image it wears. Counted as
   * arrived, so a loading bar still finishes. What it gives up: the loader's upload budget and
   * fade, which a taken mesh leaves to the consumer.
   */
  readonly onMesh?: (mesh: MeshData, ordinal: number) => boolean;
}

/** `shadowFit`'s fitted bounds, rewritten in place on each call. */
const FIT_MIN: Vec3 = [0, 0, 0];
const FIT_MAX: Vec3 = [0, 0, 0];

/**
 * A `.drft` loaded progressively: the model builds up on screen instead of appearing.
 *
 * **What this exists to prevent is the two obvious ways of doing it, both of which are worse.**
 * Reading the whole file and uploading it at the end switches from nothing to everything after
 * several seconds, which demonstrates nothing about a format built to arrive in priority order.
 * Uploading each part the moment its bytes land puts an unbounded number of GPU allocations in
 * one animation frame and hitches the page. This does neither: bytes stream, arrivals queue, and
 * a bounded number of parts are uploaded per frame with a fade.
 *
 * **It starts on an outline where the file carries one.** A `LODM` chunk is a coarse whole model
 * laid out ahead of everything else, so it is uploaded first and drawn until the real geometry is
 * complete — which turns "nothing, then parts appearing" into "an object, sharpening". The parts
 * fade in over it and the swap to the finished model is atomic, because a frame showing both is
 * showing the same car twice. A caller that would rather hold the last picture says
 * `outline: false`. See `DrftLoaderOptions.outline`.
 *
 * **It ends in one mesh per material group.** The reveal wants one upload per part and the steady
 * state wants as few draws as possible, so the load does the first and finishes by doing the
 * second: after the last byte the parts are merged by the image and blend they wear, uploaded
 * once, and the per-part meshes are disposed. On a 187-part car that is 187 draws while loading
 * and seven afterwards.
 *
 * Nothing here touches WebGL. Every GPU object comes from the `Renderer` it is handed, which is
 * what keeps the engine's rule about where raw GL may live intact.
 */
export class DrftLoader {
  private readonly renderer: RendererApi;
  private readonly options: DrftLoaderOptions;
  private readonly revealed: DrftPart[] = [];
  /** Arrived, not yet uploaded. Drained by `update` at the budget. */
  private readonly queue: {
    mesh: MeshData;
    ordinal: number;
    material: DrftMaterial | undefined;
    /** Sixteen floats a copy when the file draws this mesh many times, else null. */
    instances: Float32Array | null;
  }[] = [];
  /**
   * Paged region meshes asked for and not yet up, drained after `queue` on the same clock: each is
   * an expansion from the copies the file carried, then an upload.
   */
  private pageQueue: {
    ordinal: number;
    material: DrftMaterial | undefined;
    expand: () => MeshData;
  }[] = [];
  /** `INST`'s placements by mesh ordinal, in hand before the meshes they place arrive. */
  private readonly loadedInstances = new Map<number, Float32Array>();
  /**
   * The instanced parts, which the merge leaves alone: merging would bake one copy into a group
   * and lose the rest. Kept here so the swap to merged groups carries them across.
   */
  private readonly instancedParts: DrftPart[] = [];
  /**
   * Coarse levels that have arrived and not yet been uploaded, in arrival order.
   *
   * Its own queue rather than the part queue, because it must not wait behind a budget meant
   * for parts: the entire value of an outline is that it is on screen before them.
   */
  private readonly lodQueue: { mesh: MeshData; level: number }[] = [];
  /** The outline currently on screen, and its level. -1 means none has landed. */
  private outlinePart: DrftPart | null = null;
  private outlineMesh: MeshHandle | null = null;
  private outlineLevel = -1;
  /**
   * The merged groups, accumulated *as parts arrive* rather than all at once at the end.
   *
   * This is the second of the two stalls this class exists to avoid, and it was the worse one.
   * Building seven merged meshes out of 187 parts after the last byte is a million vertices of
   * copying in a single frame, and it landed exactly where a viewer had just started looking at a
   * finished car. Adding each part to its group as it is uploaded spreads that cost over the whole
   * load, where there is already a budget governing it, and leaves only one `build` and one upload
   * per group to do at the end — which `update` then spends one group per frame.
   */
  private readonly groups = new Map<
    string,
    {
      albedo: number;
      orm: number;
      normal: number;
      emissive: number;
      opacity: number;
      reflectivity: number;
      roughnessScale: number;
      metallicScale: number;
      occlusionStrength: number;
      cutout: number;
      blend: boolean;
      doubleSided: boolean;
      /** Built once when the group is made, and shared by every part drawn from it. */
      glass: GlassOptions | null;
      /** The group's parts, placed, joined once when the group is built. See `concatMeshes`. */
      members: MeshData[];
    }
  >();
  /** Group keys still to be built and uploaded, drained one per frame after the stream ends. */
  private readonly mergeQueue: string[] = [];
  private readonly mergedParts: DrftPart[] = [];
  /**
   * Every part in the order it arrived, and the finished model, held only for `keepReveal`.
   *
   * The load itself needs neither: it draws from `revealed` and throws the singles away at the
   * merge. These exist so `replay` can put an arrival state back, which needs the *order* as
   * much as the meshes — a reveal replayed in the order the groups merged would be a different
   * sequence from the one the file delivered.
   */
  private readonly arrivals: DrftPart[] = [];
  private readonly finished: DrftPart[] = [];
  /** Decoded images waiting for the GPU, uploaded one per frame for the same reason. */
  private readonly imageQueue: number[] = [];
  /** Which images have arrived at full size, so a late preview cannot blur one of them again. */
  private readonly sharp: boolean[] = [];
  /**
   * Which images are on the GPU, and how many, which is what `imagesDone` reports.
   *
   * Counted at the upload rather than at the arrival of the bytes, and the difference is a
   * second and three quarters on a real asset. See `DrftLoadProgress`.
   */
  private readonly bound: boolean[] = [];
  private boundCount = 0;
  private readonly singles: MeshHandle[] = [];
  private readonly images: (LoadedImage | null)[] = [];
  /** Started at the first BC texture that has to be decoded, and only then. See `bcLoad.ts`. */
  private bcDecoder: BcDecoder | null = null;
  private warnedBc = false;
  /** Started at the first BC texture this device takes better as ETC2. See `etc2Load.ts`. */
  private etc2Encoder: Etc2Encoder | null = null;
  private warnedEtc2 = false;
  /** Encoded chains whose image has not gone up yet, swapped in by `update` once it has. */
  private readonly swaps: {
    readonly ordinal: number;
    readonly blocks: CompressedTextureSource;
    readonly source: BcImage;
  }[] = [];
  private readonly chunks: DrftTexture[] = [];
  private materials: readonly DrftMaterial[] = [];
  /**
   * The rig, as its chunks land.
   *
   * **Collected here rather than dropped**, which is not a hypothetical worry about this class:
   * the normal-map texture index was written, carried and readable for a whole release while this
   * was the single layer that discarded it. A field the container carries and the loader does not
   * hand on is invisible to every test of either side.
   */
  private loadedNodes: readonly DrftNode[] = [];
  private loadedLights: readonly DrftLight[] = [];
  private loadedColliders: readonly Float32Array[] = [];
  private loadedNavigation: NavPolyMesh | null = null;
  private loadedEntities: EntsScene | null = null;
  private loadedLightVolume: DrftLightVolume | null = null;
  private loadedFields: readonly DrftSdfvEntry[] = [];
  /** The fields placed, built once the fit and the fields are both known. See `fields`. */
  private placedFields: readonly DrftFieldPlacement[] | null = null;
  private readonly loadedSkins: DrftSkin[] = [];
  private readonly loadedClips: AnimationClip[] = [];
  /**
   * Deltas as their chunks land, paired to their meshes when a part is built.
   *
   * Collected rather than applied on arrival because a `MORP` chunk can precede the `MESH` it
   * names, and the mesh ordinal in its payload is what makes the pairing independent of order.
   */
  private readonly loadedMorphs: DrftMorph[] = [];
  private textureSet: TextureSet<SurfaceTextureHandle> | null = null;
  private fit: { scale: number; x: number; y: number; z: number } | null = null;
  private bounds: readonly number[] = [];
  private meshShare = 0.5;
  private imageShare = 0.5;
  private state: DrftLoadProgress = {
    phase: 'idle',
    fraction: 0,
    partsDone: 0,
    partsTotal: 0,
    imagesDone: 0,
    imagesTotal: 0,
    totalBytes: 0,
    message: '',
  };
  /** Set once the last byte has landed, so `update` knows when to merge. */
  private streamed = false;
  private merged = false;
  private disposed = false;
  private arrived = 0;
  /** A streamed world's regions, kept apart from the parts and never merged. See `regionStore.ts`. */
  private readonly regionStore: RegionStore;
  /** What `draw`, `casters` and `prepare` do with the parts. See `partDraws.ts`. */
  private readonly partDraws: PartDraws;

  constructor(renderer: RendererApi, options: DrftLoaderOptions = {}) {
    this.renderer = renderer;
    this.options = options;
    this.regionStore = new RegionStore(renderer, () => this.fit);
    this.partDraws = new PartDraws(renderer);
  }

  get progress(): DrftLoadProgress {
    return this.state;
  }

  /**
   * The parts to draw this frame. Grows while loading, then becomes the merged groups.
   *
   * While a coarse level is on screen it is the **first** entry, so a caller drawing them in
   * order draws the outline behind the parts that are replacing it. It leaves the list in the
   * same frame the merged model enters it.
   */
  get parts(): readonly DrftPart[] {
    return this.revealed;
  }

  /**
   * Whether a coarse level is on screen, or held for a replay.
   *
   * False for most loads: the file has to carry one *and* the consumer has to have asked. It is
   * here because a caller wording a readout needs it — with an outline, state 1 of a replay is
   * the outline alone and state 2 is the first part, and without one the states shift down by
   * one. A caller counting that out for itself would be guessing at what the file contained.
   */
  /**
   * The asset's hierarchy, or empty for a file carrying no `NODE`.
   *
   * Handed on rather than consumed here, because what to do with a hierarchy is the caller's:
   * this class draws parts, and placing them under a graph is a scene decision.
   */
  get nodes(): readonly DrftNode[] {
    return this.loadedNodes;
  }

  /**
   * The lights the file was authored with, in glTF's units, or empty. They arrive ahead of the
   * geometry. What a candela is in this scene's light units is the caller's decision.
   */
  get lights(): readonly DrftLight[] {
    return this.loadedLights;
  }

  /**
   * The convex hulls the asset collides as, in the file's own space and unfitted, or empty. Handed
   * on for the caller to build shapes from, as `hullShape` takes them.
   */
  get colliders(): readonly Float32Array[] {
    return this.loadedColliders;
  }

  /** The asset's navigation mesh, unfitted, or null for a file carrying no `NAVM`. */
  get navigation(): NavPolyMesh | null {
    return this.loadedNavigation;
  }

  /**
   * The asset's serialised entities, or null for a file carrying no `ENTS` — handed on as
   * `deserializeWorld` takes them, because what an entity is belongs to the caller's schemas.
   */
  get entities(): EntsScene | null {
    return this.loadedEntities;
  }

  /**
   * A streamed world's regions by id, each filling as its meshes and props upload — `pending` is 0
   * once one is whole. Their meshes are never among `parts`: a region's levels are alternatives,
   * drawn one at a time through `HlodSet`, and its batches cull instance by instance.
   */
  get regions(): ReadonlyMap<number, LoadedRegion> {
    return this.regionStore.regions;
  }

  /** One mesh to draw, from the stream or expanded from an assembly, queued for upload. */
  private take(mesh: MeshData, ordinal: number): void {
    if (this.disposed) return;
    /* A region's own meshes are known by now: a region is written ahead of what it introduces. */
    if (!this.regionStore.owns(ordinal) && this.options.onMesh?.(mesh, ordinal) === true) {
      this.arrived++;
      this.set({ phase: 'geometry', partsDone: this.arrived });
      return;
    }
    const material = this.materials[ordinal];
    /*
     * Deltas onto the mesh they name, before it is queued for upload. The container writes a
     * `MORP` immediately ahead of its `MESH` so this is in hand; a file that puts them the
     * other way round still opens, and that mesh simply does not morph — a defined
     * degradation rather than a wrong picture.
     */
    const morph = this.loadedMorphs.find((entry) => entry.mesh === ordinal);
    const withMorph =
      morph === undefined
        ? mesh
        : { ...mesh, morphTargets: morph.deltas, morphTargetCount: morph.targetCount };
    this.queue.push({
      mesh: withMorph,
      ordinal,
      material,
      instances: this.loadedInstances.get(ordinal) ?? null,
    });
    this.arrived++;
    this.set({ phase: 'geometry', partsDone: this.arrived });
  }

  /**
   * Bring a region's paged level up, or free it. A level that arrived as assemblies (`paged`) is
   * held as the copies the file carried; asked for, each mesh is expanded and uploaded on the
   * loader's clocked queue in later `update`s, and `resident` turns true when the last is up. Freed,
   * its meshes go and the copies stay. A level that is not paged ignores this.
   *
   * The caller decides from what it will draw: page in the levels `HlodSet` is choosing or about
   * to, draw a coarser one until the fine one is resident, and page out what the eye has left.
   */
  pageRegion(id: number, level: number, resident: boolean): void {
    const changes = this.regionStore.page(id, level, resident);
    if (resident) {
      for (const { ordinal, expand } of changes) {
        this.pageQueue.push({ ordinal, material: this.materials[ordinal], expand });
      }
      return;
    }
    if (changes.length === 0) return;
    const released = new Set(changes.map((c) => c.ordinal));
    this.pageQueue = this.pageQueue.filter((item) => !released.has(item.ordinal));
  }

  /**
   * A world's summed lights, unfitted, or null until `LVOL` lands and for a file carrying none.
   * Handed straight to `createWorldLightField`, whose volume it is shaped as.
   */
  get lightVolume(): DrftLightVolume | null {
    return this.loadedLightVolume;
  }

  /**
   * The distance fields the file carries, each where it stands: at the loader's fit, and once a
   * copy for a mesh drawn many times. Empty until the fields and the fit have both arrived, and for
   * a file carrying none. A scene declares these to `addDistanceField` every frame, with the colour
   * of the surface each covers. See `fieldPlacement.ts`.
   */
  get fields(): readonly DrftFieldPlacement[] {
    if (this.placedFields === null) {
      if (this.loadedFields.length === 0 || this.fit === null) return [];
      this.placedFields = placeFields(this.loadedFields, this.fit, this.loadedInstances);
    }
    return this.placedFields;
  }

  /** Skins the file carried, in the order their chunks appeared. Empty for a file with none. */
  get skins(): readonly DrftSkin[] {
    return this.loadedSkins;
  }

  /** Clips the file carried, in the order their chunks appeared. Empty for a file with none. */
  get clips(): readonly AnimationClip[] {
    return this.loadedClips;
  }

  /** Morph deltas the file carried, each naming the mesh ordinal it deforms. */
  get morphs(): readonly DrftMorph[] {
    return this.loadedMorphs;
  }

  get hasOutline(): boolean {
    return this.outlinePart !== null;
  }

  /**
   * How many states the finished reveal can be put back into, or 0 when none were kept.
   *
   * A **count of states rather than a fraction**, because the states are what a viewer is
   * actually choosing between and they are not evenly spaced in anything: an outline is one
   * thing, a part is one thing, and the merge is one thing. A caller drives it with an integer
   * so every state is reachable — a fraction would make the outline a band 1/188th of a slider
   * wide, which is a state nobody can stop on.
   *
   * State 0 is an empty stage. State 1 is the outline where the file carried one, and the first
   * part where it did not. The last state is the finished model, drawn exactly as `ready` draws
   * it. Everything between adds one more part, in the order the file delivered them.
   */
  get revealSteps(): number {
    if (this.options.keepReveal !== true || !this.merged) return 0;
    return 2 + (this.outlinePart === null ? 0 : 1) + this.arrivals.length;
  }

  /**
   * Put one state of the reveal back on screen. Needs `keepReveal`, and does nothing without it.
   *
   * **This is a presentation control, not a second loader.** Nothing is re-read, re-uploaded or
   * re-merged: the meshes the load made are all still there and this decides which of them
   * `parts` names. So it is free to call every frame, and a caller may scrub it as fast as it
   * likes without touching the GPU.
   */
  replay(step: number): void {
    if (this.disposed) return;
    const total = this.revealSteps;
    if (total === 0) return;
    const outline = this.outlinePart;
    const at = Math.max(0, Math.min(total - 1, Math.round(step)));

    this.revealed.length = 0;
    if (at === 0) return;
    if (at === total - 1) {
      for (const part of this.finished) this.revealed.push(part);
      return;
    }
    /* The outline sits under the parts that are replacing it, exactly as it does during a load. */
    if (outline !== null) this.revealed.push(outline);
    const parts = outline === null ? at : at - 1;
    for (let i = 0; i < parts && i < this.arrivals.length; i++) {
      const part = this.arrivals[i];
      if (part === undefined) break;
      /* Fully arrived rather than mid-fade: a state being *looked at* is a state that finished. */
      part.reveal = 1;
      this.revealed.push(part);
    }
  }

  /** The asset's images by the name its source gave them, or null before any have arrived. */
  get textures(): TextureSet<SurfaceTextureHandle> | null {
    return this.textureSet;
  }

  /** The model's own bounds, from `HEAD`, which arrives before any geometry. */
  get modelBounds(): readonly number[] {
    return this.bounds;
  }

  /**
   * How the model was fitted: a uniform scale and an offset that centres it on the origin with
   * its base at zero. Null until `HEAD` lands.
   */
  get placement(): {
    readonly scale: number;
    readonly x: number;
    readonly y: number;
    readonly z: number;
  } | null {
    return this.fit;
  }

  /**
   * Draw this frame's parts into the open mesh pass, each by every rule a baked container needs:
   * its whole material, its copies through the instanced path, a blended part translucent and
   * writing no depth, glass as glass, its own reflectivity. Returns the draws issued.
   *
   * **The one call a model wants**, because each rule missed is a wrong picture rather than an
   * error: a repeated arch drawn once, a decal as a black patch, foliage without its alpha test.
   * What it gives up, and what drawing `parts` by hand is for, is a per-part override; see
   * `PartDraws`.
   */
  draw(): number {
    return this.partDraws.draw(this.revealed, this.textureSet);
  }

  /**
   * Every part that stands in the light, for `drawShadowCasters` or a mirror's replay: all but a
   * decal, which would shadow its own surface, each with its material so a cutout casts the shape
   * in its texture, glass as glass and copies as copies. Always this frame's parts.
   */
  readonly casters: ShadowCasters = (sink) =>
    this.partDraws.cast(sink, this.revealed, this.textureSet);

  /**
   * Compile what every part's draw will take, off the frame, and wait for it. Call it once the load
   * has finished, behind whatever is showing then; one frame drawn there as well compiles the
   * shadow passes' own pipelines, which this cannot reach, and the first frame a player sees then
   * waits on nothing.
   */
  prepare(): Promise<void> {
    return this.partDraws.prepare(this.revealed, this.textureSet);
  }

  /**
   * A directional light's matrix covering the model whole, as fitted, into `out`, through
   * `computeLightMatrixForBounds`; returns the depth span for `shadowDepthSpan`, or null until
   * `HEAD` has said how large the model is.
   *
   * **What it gives up** is the bounds' own: they are the file's, fitted, so a `transform` that
   * moves a mesh moves it past them, and a model far larger than what the viewer sees spreads the
   * map over all of it — a city wants the map around the viewer instead, through
   * `computeLightMatrix`.
   */
  shadowFit(lightDir: Vec3, shadowMapSize: number, out: Float32Array): number | null {
    const fit = this.fit;
    const b = this.bounds;
    if (fit === null || b.length < 6) return null;
    const { scale, x, y, z } = fit;
    FIT_MIN[0] = (b[0] as number) * scale + x;
    FIT_MIN[1] = (b[1] as number) * scale + y;
    FIT_MIN[2] = (b[2] as number) * scale + z;
    FIT_MAX[0] = (b[3] as number) * scale + x;
    FIT_MAX[1] = (b[4] as number) * scale + y;
    FIT_MAX[2] = (b[5] as number) * scale + z;
    return computeLightMatrixForBounds(lightDir, FIT_MIN, FIT_MAX, shadowMapSize, out);
  }

  /**
   * Start loading, and resolve when the last byte has been read.
   *
   * Deliberately not the thing that produces the parts: the parts appear through `update`, so a
   * caller draws its frames as usual and never awaits anything. A failed load leaves the phase at
   * `failed` with a message rather than throwing, because a scene is usually still valid without
   * its model and a blank screen would report the wrong problem.
   *
   * `fitTo` is the size the model's larger of footprint and height is scaled to fit, which is the
   * one thing a loader cannot infer: a bought asset arrives in whatever units its author used.
   * `baseY` is where its lowest point should sit, for a scene whose floor is not at zero — a
   * plinth, a turntable, a deck. It defaults to zero, and getting it wrong is very visible: the
   * first version of this had no such parameter and put a car's wheels through the turntable it
   * was standing on.
   *
   * **`{ fit: 'none' }` declines all of it** — scale 1, no centring, no base — for a caller whose
   * importer has already placed the model. See `DrftFit` for why that is a stated option rather
   * than a very large footprint.
   */
  async load(url: string, fitTo: DrftFit): Promise<void> {
    this.set({ phase: 'connecting', message: '' });
    try {
      /*
       * `no-store`, because a model is the thing most likely to be re-baked while somebody is
       * looking at it. A browser holding fifty megabytes it fetched an hour ago does mean a fix
       * to the *baker* appears to have changed nothing, and the time lost to that is out of all
       * proportion to the saving.
       */
      // platform: browser default — `DrftLoaderOptions.fetchImpl` is the seam
      const response = await (this.options.fetchImpl ?? fetch)(url, { cache: 'no-store' });
      if (!response.ok) {
        this.set({ phase: 'absent', message: `no model at ${url}` });
        return;
      }
      /*
       * A 200 carrying a page is a model that was never deployed, not a model that is broken.
       * See `isDocumentResponse`: the phase has to be `absent` here, because `failed` sends
       * whoever reads it looking for a corrupt file that does not exist.
       */
      if (isDocumentResponse(response.headers.get('content-type'))) {
        this.set({ phase: 'absent', message: `${url} is a page, not a model` });
        return;
      }
      await this.consume(response, fitTo);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.set({ phase: 'failed', message });
    }
  }

  /**
   * The same load, from a container this class did not fetch.
   *
   * Split out because a `.drft` is not the only way a model arrives. A source format read at
   * runtime is parsed and written to a container in a worker, and what comes back is bytes
   * that have never been near a URL. Everything after the first byte is identical, so it would
   * be a second copy of the stream, the upload budget, the fade and the merge, kept in step by
   * hand. A `Response` is the seam because it is what `streamDrft` already takes, and one can
   * be built over an `ArrayBuffer` with no copy and no server.
   */
  async consume(response: Response, fitTo: DrftFit): Promise<void> {
    try {
      await streamDrft(response, {
        onMorph: (morph) => {
          this.loadedMorphs.push(morph);
        },
        onNodes: (nodes) => {
          this.loadedNodes = nodes;
        },
        onLights: (lights) => {
          this.loadedLights = lights;
        },
        onColliders: (hulls) => {
          this.loadedColliders = hulls;
        },
        onNavigation: (navigation) => {
          this.loadedNavigation = navigation;
        },
        onEntities: (entities) => {
          this.loadedEntities = entities;
        },
        onFields: (fields) => {
          this.loadedFields = fields;
          this.placedFields = null;
        },
        onInstances: (groups) => {
          for (const group of groups) this.loadedInstances.set(group.mesh, group.transforms);
        },
        onLightVolume: (volume) => {
          this.loadedLightVolume = volume;
        },
        onRegion: (region) => {
          if (this.disposed) return;
          this.regionStore.admit(region);
        },
        onSkin: (skin) => {
          this.loadedSkins.push(skin);
        },
        onClip: (clip) => {
          this.loadedClips.push(clip);
        },
        onManifest: (manifest) => {
          const carried = manifest.meshBytes + manifest.textureBytes;
          if (carried > 0) {
            this.meshShare = manifest.meshBytes / carried;
            this.imageShare = manifest.textureBytes / carried;
          }
          this.set({
            phase: 'manifest',
            partsTotal: manifest.meshCount,
            imagesTotal: manifest.textureCount,
            totalBytes: manifest.totalBytes,
          });
        },

        onHead: (head) => {
          /*
           * Fitted by height *and* footprint, not by the longest axis alone. Scaling the longest
           * span is right for a car, whose longest axis is horizontal, and wrong for anything
           * standing up: the same rule made a character nine metres tall in a nine metre room.
           * Whichever cap bites is the one the shape needed.
           */
          this.bounds = head.bounds;
          if ('fit' in fitTo) {
            /* Nothing at all, which is what a caller whose model is already placed asked for. */
            this.fit = { scale: 1, x: 0, y: 0, z: 0 };
            return;
          }
          const [minX, minY, minZ, maxX, maxY, maxZ] = head.bounds as number[];
          const spanX = (maxX as number) - (minX as number);
          const spanY = (maxY as number) - (minY as number);
          const spanZ = (maxZ as number) - (minZ as number);
          const footprint = Math.max(spanX, spanZ) || 1;
          const height = spanY || 1;
          const scale = Math.min(fitTo.footprint / footprint, fitTo.height / height);
          this.fit = {
            scale,
            x: -(((minX as number) + (maxX as number)) / 2) * scale,
            y: -(minY as number) * scale + (fitTo.baseY ?? 0),
            z: -(((minZ as number) + (maxZ as number)) / 2) * scale,
          };
        },

        /*
         * A coarse whole model, which is the first thing in a file laid out by this baker.
         *
         * Queued rather than uploaded here for the same reason a part is: this runs on the
         * stream's own callback, not inside a frame, and creating GPU objects from there is how
         * an unbounded amount of work lands in whichever frame happens to be running.
         */
        onLod: (mesh, level) => {
          /* Drawn unless this consumer refused one: see `DrftLoaderOptions.outline`. The chunk is
             read and validated either way, so a malformed one still fails loudly when refused. */
          if (this.disposed || this.options.outline === false) return;
          this.lodQueue.push({ mesh, level });
          this.set({ phase: 'outline' });
        },

        onMaterials: (list) => {
          this.materials = list;
          this.set({ phase: 'materials' });
        },

        onKit: (pieces) => {
          /* A piece is drawn only as copies: it is not a part, and the count said it was. */
          this.set({ partsTotal: Math.max(0, this.state.partsTotal - pieces.length) });
        },
        onAssembly: (assembly, ordinal, piece) => {
          if (this.disposed) return;
          if (this.regionStore.isLevelMesh(ordinal)) {
            this.regionStore.hold(ordinal, assembly, piece);
            this.arrived++;
            this.set({ phase: 'geometry', partsDone: this.arrived });
            return;
          }
          this.take(expandAssembly(assembly, piece), ordinal);
        },
        onMesh: (mesh, ordinal) => {
          this.take(mesh, ordinal);
        },

        onTexture: (texture, ordinal) => {
          if (this.disposed) return;
          this.chunks.push(texture);
          /*
           * The phase moves here and the count does not. The bytes arriving is not the picture
           * being right: what follows is a decode this deliberately does not await, and until it
           * lands the surfaces wearing this image draw untextured. Counting here made
           * `imagesDone` equal `imagesTotal` and `fraction` reach 1 while the model was still
           * visibly wrong, which a consumer's loading bar reported to a person as finished.
           */
          this.set({ phase: 'textures' });
          if (texture.codec === CODEC_BC) {
            this.acceptBc(texture, ordinal);
            return;
          }
          /*
           * Decoded through the browser's own image path, so the engine ships no decoder, and
           * **each one fails on its own**: a texture is the part of an asset most likely to be
           * wrong, and none of the ways it can be is a reason to lose the model. Not awaited
           * here, so a slow decode never holds up the next chunk of the stream.
           */
          /*
           * A small version first, where a caller asked for one, then the image itself.
           *
           * **This is the blur-to-sharp arrival docs/FORMAT.md §4.6 wanted, and it costs the file
           * nothing.** The section proposed mip levels stored smallest first as separate chunks,
           * which is right and needs the *baker* to resize an image — and the baker runs in Node,
           * where there is no decoder for a JPEG and adding one is a dependency decision rather
           * than an implementation. `createImageBitmap` resizes while it decodes, so the same
           * effect is available from the bytes already in the file: a 256 pixel version of a
           * 2048 square costs a fraction of the full decode and puts something on the surface
           * about a second earlier, and the full decode then replaces it in the same GPU object.
           */
          const preview = this.options.texturePreview;
          if (preview !== undefined && preview > 0) {
            void decodeImage(texture, preview)
              .then((bitmap) => {
                /* Dropped if the real thing beat it here: a preview arriving after the image it
                   previews would put a blurred texture on a surface that already had a sharp one. */
                if (this.disposed || this.sharp[ordinal] === true) return;
                this.images[ordinal] = bitmap;
                this.imageQueue.push(ordinal);
              })
              .catch(() => {
                /* A preview is an optimisation. Losing one costs nothing and says nothing about
                   whether the image itself will decode, so it is not even worth a warning. */
              });
          }
          void decodeImage(texture)
            .then((bitmap) => {
              this.images[ordinal] = bitmap;
              this.sharp[ordinal] = true;
              this.imageQueue.push(ordinal);
            })
            .catch((error: unknown) => {
              /*
               * **What arrived, not only that it was refused.** A decoder's own message is
               * `The source image could not be decoded` whatever went wrong, which is true of a
               * truncated file, a codec byte that disagrees with the bytes, and an empty view
               * alike — and those have completely different causes. The codec, the length and the
               * first four bytes separate them at a glance: a PNG opens `89 50 4e 47` and a JPEG
               * `ff d8 ff`, so a header that matches means the bytes are sound and the fault is
               * downstream of them.
               */
              const head = Array.from(texture.bytes.slice(0, 4))
                .map((byte) => byte.toString(16).padStart(2, '0'))
                .join(' ');
              console.warn(
                `DrftLoader: image ${ordinal} did not decode; its surfaces stay untextured` +
                  ` (codec ${texture.codec}, ${texture.bytes.length} bytes, ${texture.width}x${texture.height}, starts ${head})`,
                error,
              );
              this.images[ordinal] = null;
              this.sharp[ordinal] = true;
              this.imageQueue.push(ordinal);
            });
        },
      });
      this.streamed = true;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.set({ phase: 'failed', message });
    }
  }

  /**
   * Spend this frame's upload budget and advance the fades. Call once per frame.
   *
   * Returns whether anything changed, for a caller that wants to know it should redraw a
   * progress readout rather than rebuild one every frame.
   */
  update(dtSec: number): boolean {
    if (this.disposed) return false;
    let changed = false;

    /*
     * One clock over every kind of work, and that is the correction.
     *
     * These used to be three budgets, on the argument that a part, an image and a merged group are
     * not interchangeable and that spending "three things" of any kind would be three very
     * different frames. The observation was right and the conclusion did not follow: budgets that
     * cannot see each other still *sum*, so one frame could take three parts and an image and a
     * group merge with nothing anywhere counting the total. What the three have in common is the
     * only thing that ever mattered — they are all spending this frame — and a clock measures that
     * for all of them without needing to know what any of them is.
     */
    const startedMs = performance.now();
    const msBudget = this.options.uploadMsPerFrame ?? DEFAULT_UPLOAD_MS_PER_FRAME;
    let begun = 0;

    /*
     * The outline first, and still ahead of the parts. It is one mesh of a few thousand triangles
     * and the whole point of it is to be on screen first, so making it wait behind part uploads
     * would spend the one advantage it has. Only the best level that has arrived is uploaded: a
     * level the stream has already passed is work with nothing to show.
     *
     * It goes *on* the clock rather than beside it. Being allowed to start first is what it was
     * owed; being free was never part of it, and the parts that followed it into the same frame
     * are the ones that paid for that.
     */
    if (this.lodQueue.length > 0) {
      const best = this.lodQueue[this.lodQueue.length - 1];
      this.lodQueue.length = 0;
      if (best !== undefined && this.uploadOutline(best.mesh, best.level)) changed = true;
      begun++;
    }

    const budget = this.options.uploadsPerFrame ?? DEFAULT_UPLOADS_PER_FRAME;
    for (
      let spent = 0;
      spent < budget &&
      this.queue.length > 0 &&
      mayBeginMore(begun, performance.now() - startedMs, msBudget);
      spent++
    ) {
      const next = this.queue.shift();
      if (next === undefined) break;
      if (this.uploadOne(next.mesh, next.material, next.instances, next.ordinal)) changed = true;
      begun++;
    }
    /* Paged region meshes, after the stream's own: an expansion from the copies, then an upload. */
    while (
      this.pageQueue.length > 0 &&
      mayBeginMore(begun, performance.now() - startedMs, msBudget)
    ) {
      const next = this.pageQueue.shift();
      if (next === undefined) break;
      if (this.uploadOne(next.expand(), next.material, null, next.ordinal)) changed = true;
      begun++;
    }
    /* A region's prop batches, on the same clock: each is an allocation and an upload. Drained
       before the merge below can begin, which is what lets `ready` not wait on them separately. */
    while (
      this.regionStore.busy &&
      mayBeginMore(begun, performance.now() - startedMs, msBudget) &&
      this.regionStore.buildNext()
    ) {
      changed = true;
      begun++;
    }

    /* One image a frame, and only into a frame that has room for it. A 2048 square decodes
       off-thread and then uploads with its mips, which is the single most expensive thing in a
       load and lands right after the geometry — on top of the parts, until this was clocked. */
    if (
      this.imageQueue.length > 0 &&
      mayBeginMore(begun, performance.now() - startedMs, msBudget)
    ) {
      const ordinal = this.imageQueue.shift();
      if (ordinal !== undefined) {
        const take = this.options.onImage;
        if (take === undefined) this.rebuildTextures(ordinal);
        else take(this.chunks[ordinal]?.name ?? '', bitmapOf(this.images[ordinal] ?? null));
        /*
         * Counted here, once, and only for the image itself.
         *
         * A preview passes through this same queue and binding one is not the image being done —
         * it is a blurred stand-in for it, so counting it would put the old lie back in a
         * smaller size. `sharp` is set by the full decode and by a failed one, which is what
         * keeps a bar that cannot finish from being the price of an image that never decoded.
         */
        if (this.sharp[ordinal] === true && this.bound[ordinal] !== true) {
          this.bound[ordinal] = true;
          this.boundCount++;
          this.set({ imagesDone: this.boundCount });
        }
      }
      changed = true;
      begun++;
    }

    /* An encoded chain whose image has gone up since it arrived; one a frame, as images go. */
    if (this.swaps.length > 0 && mayBeginMore(begun, performance.now() - startedMs, msBudget)) {
      for (let at = 0; at < this.swaps.length; at++) {
        const swap = this.swaps[at] as (typeof this.swaps)[number];
        if (!this.swapIn(swap.ordinal, swap.blocks, swap.source)) continue;
        this.swaps.splice(at, 1);
        changed = true;
        begun++;
        break;
      }
    }

    const revealSec = this.options.revealSec ?? DEFAULT_REVEAL_SEC;
    for (const part of this.revealed) {
      if (part.reveal >= 1) continue;
      part.reveal = revealSec <= 0 ? 1 : Math.min(1, part.reveal + dtSec / revealSec);
      changed = true;
    }

    /*
     * The merge starts once the stream has finished and every arrival has been uploaded, so the
     * swap can never throw away a part that is still queued.
     */
    if (
      this.streamed &&
      !this.merged &&
      this.queue.length === 0 &&
      mayBeginMore(begun, performance.now() - startedMs, msBudget)
    ) {
      if (this.mergeQueue.length === 0 && this.mergedParts.length === 0) {
        for (const key of this.groups.keys()) this.mergeQueue.push(key);
      }
      /* One group a frame, and not in a frame the parts have already spent. A merge is a copy of
         every vertex in its group and it lands in exactly the frames where the last parts are
         still arriving: 11 to 36 ms measured, on top of 34 ms of parts. */
      const key = this.mergeQueue.shift();
      if (key !== undefined) {
        this.buildGroup(key);
        changed = true;
      }
      if (this.mergeQueue.length === 0) {
        this.merged = true;
        this.swapInMerged();
        changed = true;
      }
    }

    /*
     * **Ready once the picture is right, not once the parts are**, which is what `DrftLoadProgress`
     * has promised consumers since `imagesDone` was corrected, and what this did not do: it said
     * ready at the merge, with images still decoding behind it. A consumer that baked its light
     * probes on `ready` baked them against untextured stone, and came out overexposed on exactly the
     * runs where the decodes lost the race. Every image is counted whether it decoded or failed, so
     * this cannot wait for ever on a bad one.
     */
    if (
      this.merged &&
      this.state.phase !== 'ready' &&
      this.imageQueue.length === 0 &&
      this.state.imagesDone >= this.state.imagesTotal
    ) {
      this.set({ phase: 'ready', fraction: 1 });
      changed = true;
    }
    return changed;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.regionStore.dispose();
    this.bcDecoder?.dispose();
    this.bcDecoder = null;
    this.etc2Encoder?.dispose();
    this.etc2Encoder = null;
    this.swaps.length = 0;
    /*
     * Everything this class ever made, each disposed once.
     *
     * Through a set, because the same `Mesh` legitimately appears in more than one of these
     * lists: a part is in `revealed` and in `singles` and, under `keepReveal`, in `arrivals` as
     * well. Disposing it twice is a second `deleteBuffer` on a name the driver has already
     * freed, which is exactly the class of double-free that is silent until it is not.
     */
    const meshes = new Set<MeshHandle>();
    for (const part of this.revealed) meshes.add(part.mesh);
    for (const part of this.arrivals) meshes.add(part.mesh);
    for (const part of this.finished) meshes.add(part.mesh);
    for (const part of this.mergedParts) meshes.add(part.mesh);
    for (const mesh of this.singles) meshes.add(mesh);
    for (const part of this.instancedParts) {
      meshes.add(part.mesh);
      if (part.instances !== null) this.renderer.disposeInstanced(part.instances.batch);
    }
    this.instancedParts.length = 0;
    if (this.outlineMesh !== null) meshes.add(this.outlineMesh);
    for (const mesh of meshes) this.renderer.disposeMesh(mesh);
    this.revealed.length = 0;
    this.arrivals.length = 0;
    this.finished.length = 0;
    this.mergedParts.length = 0;
    this.singles.length = 0;
    this.outlineMesh = null;
    this.outlinePart = null;
    for (const texture of this.textureSet?.all() ?? [])
      this.renderer.disposeSurfaceTexture(texture);
    this.textureSet = null;
  }

  /**
   * The coarse whole model, on screen until the real one is complete.
   *
   * **Drawn as a part rather than through a second path**, so a scene that already iterates
   * `parts` needs no change and cannot forget it. It wears no image and no reflection, because
   * a level of detail carries the four mandatory attributes only — see `buildCoarseLevel`, and
   * §4.6 for why a silhouette does not pay for the roughness of a surface nobody looks at.
   *
   * **The replacement is atomic**, which §4.6 asks for by name: a better level takes the worse
   * one's place in the draw list in the same call it is uploaded in, so no frame draws both and
   * none draws neither. It keeps the fade it had, or a finer level arriving would restart it and
   * the model would appear to flash.
   */
  private uploadOutline(mesh: MeshData, level: number): boolean {
    const fit = this.fit;
    /*
     * `merged` is the one case worth guarding: the model itself is on screen by then, and an
     * outline added after it would draw a second, coarser copy of the same object inside it.
     */
    if (fit === null || this.merged || level <= this.outlineLevel) return false;
    const single = new MeshBuilder();
    single.addMesh(mesh, fit.x, fit.y, fit.z, fit.scale);
    let uploaded: MeshHandle;
    try {
      uploaded = this.renderer.createMesh(single.build());
    } catch (error) {
      /* An outline that will not upload costs the outline. The model is still coming. */
      console.warn(
        'DrftLoader: the coarse level would not upload; the load goes on without it',
        error,
      );
      return false;
    }

    const previous = this.outlineMesh;
    const part: DrftPart = {
      mesh: uploaded,
      albedo: -1,
      orm: -1,
      normal: -1,
      emissive: -1,
      opacity: 1,
      reflectivity: 0,
      roughnessScale: 1,
      metallicScale: 1,
      occlusionStrength: 0,
      cutout: 0,
      blend: false,
      doubleSided: false,
      glass: null,
      reveal: this.outlinePart?.reveal ?? 0,
      instances: null,
    };
    const at = this.outlinePart === null ? -1 : this.revealed.indexOf(this.outlinePart);
    /* First in the list, so it is drawn before the parts that stand in front of it. */
    if (at >= 0) this.revealed[at] = part;
    else this.revealed.unshift(part);
    this.outlinePart = part;
    this.outlineMesh = uploaded;
    this.outlineLevel = level;
    if (previous !== null) this.renderer.disposeMesh(previous);
    return true;
  }

  /** One part, transformed, dressed and uploaded. Returns whether it landed. */
  private uploadOne(
    mesh: MeshData,
    material: DrftMaterial | undefined,
    instances: Float32Array | null,
    ordinal: number,
  ): boolean {
    const fit = this.fit;
    if (fit === null) return false;
    const dressed = this.options.transform?.(mesh, material) ?? mesh;
    /* The file's mesh itself where the fit is the identity, with its tangents and every other
       attribute it carried. It went through a builder here, which copied it and dropped them. */
    const placed = placeMesh(dressed, fit.x, fit.y, fit.z, fit.scale);
    const override = this.options.surface?.(material);
    /*
     * **The resolution and the key both live in `drawKey.ts`, and that is the point of them.**
     *
     * Four texture indices, the two fields an override may replace, and four scalars. What each
     * default is and why the override wins for two of them is written there, at the resolution,
     * because a consumer counting the draws a bake will cost has to answer the same question and
     * was answering it with a copy of this code that went stale when `cutout` joined the key.
     */
    const g = resolveDrawGrouping(material, override);
    const {
      albedo,
      orm,
      normal,
      emissive,
      opacity,
      reflectivity,
      roughnessScale,
      metallicScale,
      occlusionStrength,
      cutout,
      blend,
      doubleSided,
    } = g;

    /*
     * A region's mesh — a level or a prop's prototype — is one part of its own, never grouped: the
     * merge would weld a region's levels together and one region to the next. See `regionStore.ts`.
     */
    if (this.regionStore.owns(ordinal)) {
      try {
        this.regionStore.arrived(ordinal, {
          mesh: this.renderer.createMesh(placed),
          albedo,
          orm,
          normal,
          emissive,
          opacity,
          reflectivity,
          roughnessScale,
          metallicScale,
          occlusionStrength,
          cutout,
          blend,
          doubleSided,
          glass: glassOf(g),
          reveal: 1,
          instances: null,
        });
        return true;
      } catch (error) {
        console.warn(`DrftLoader: region mesh ${ordinal} would not upload and was skipped`, error);
        return false;
      }
    }

    /*
     * Added to its merged group here, while there is a budget governing how much of this happens
     * in one frame.
     */
    if (instances !== null) {
      return this.uploadInstanced(placed, instances, fit, {
        albedo,
        orm,
        normal,
        emissive,
        opacity,
        reflectivity,
        roughnessScale,
        metallicScale,
        occlusionStrength,
        cutout,
        blend,
        doubleSided,
        glass: glassOf(g),
      });
    }

    const key = drawKeyOf(material, override);
    let group = this.groups.get(key);
    if (group === undefined) {
      group = {
        albedo,
        orm,
        normal,
        emissive,
        opacity,
        reflectivity,
        roughnessScale,
        metallicScale,
        occlusionStrength,
        cutout,
        blend,
        doubleSided,
        glass: glassOf(g),
        members: [],
      };
      this.groups.set(key, group);
    }
    /* Not merged, for the reason above: a group's deltas would deform its neighbours. */
    if (dressed.morphTargets === undefined) group.members.push(placed);

    try {
      /*
       * **A morphed part is never merged.** A merged group concatenates vertices from several
       * parts, and one part's deltas applied across that buffer would deform whatever geometry
       * happened to follow it.
       *
       * So the deltas are scaled by the fit and handed straight to `createMesh`. **Scaled and not
       * translated** — a delta is a displacement, and moving it by the fit's offset would drag
       * every vertex toward the origin of the model rather than deform it in place.
       */
      const morphable =
        dressed.morphTargets !== undefined && dressed.morphTargetCount !== undefined
          ? {
              ...placed,
              morphTargets: dressed.morphTargets.map((delta) => delta * fit.scale),
              morphTargetCount: dressed.morphTargetCount,
            }
          : placed;
      const uploaded = this.renderer.createMesh(morphable);
      this.singles.push(uploaded);
      const part: DrftPart = {
        mesh: uploaded,
        albedo,
        orm,
        normal,
        emissive,
        opacity,
        reflectivity,
        roughnessScale,
        metallicScale,
        occlusionStrength,
        cutout,
        blend,
        doubleSided,
        glass: group.glass,
        reveal: 0,
        instances: null,
      };
      this.revealed.push(part);
      if (this.options.keepReveal === true) this.arrivals.push(part);
      return true;
    } catch (error) {
      /* One bad part costs one surface rather than the model. Uploading is where a malformed
         asset reaches the driver, and a throw here would leak every buffer already made. */
      console.warn('DrftLoader: a part would not upload and was skipped', error);
      return false;
    }
  }

  /**
   * Replace the per-part meshes with one per material group.
   *
   * Grouped by opacity and reflectivity as well as by image, because two surfaces can share a map
   * and differ in blend: merging on the image alone means one cannot be made translucent without
   * taking the other with it.
   */
  /**
   * A mesh the file draws many times: uploaded once, placed by a batch, and kept out of the merge.
   *
   * **The fit is conjugated into each placement** by `fitCopies`, which a region's props share: the
   * prototype is uploaded with the fit already applied, so the copies land where its geometry does
   * and are not scaled twice.
   */
  private uploadInstanced(
    prototype: MeshData,
    instances: Float32Array,
    fit: { scale: number; x: number; y: number; z: number },
    surface: Omit<DrftPart, 'mesh' | 'reveal' | 'instances'>,
  ): boolean {
    try {
      const uploaded = this.renderer.createMesh(prototype);
      const data = fitCopies(instances, fit);
      const batch = this.renderer.createInstanced(uploaded, data.count);
      this.renderer.uploadInstanced(batch, data);
      const part: DrftPart = { mesh: uploaded, ...surface, reveal: 0, instances: { batch, data } };
      this.revealed.push(part);
      this.instancedParts.push(part);
      if (this.options.keepReveal === true) this.arrivals.push(part);
      return true;
    } catch (error) {
      console.warn('DrftLoader: an instanced part would not upload and was skipped', error);
      return false;
    }
  }

  private buildGroup(key: string): void {
    const group = this.groups.get(key);
    if (group === undefined) return;
    try {
      this.mergedParts.push({
        mesh: this.renderer.createMesh(concatMeshes(group.members)),
        albedo: group.albedo,
        orm: group.orm,
        normal: group.normal,
        emissive: group.emissive,
        opacity: group.opacity,
        reflectivity: group.reflectivity,
        roughnessScale: group.roughnessScale,
        metallicScale: group.metallicScale,
        occlusionStrength: group.occlusionStrength,
        cutout: group.cutout,
        blend: group.blend,
        doubleSided: group.doubleSided,
        glass: group.glass,
        reveal: 1,
        instances: null,
      });
    } catch (error) {
      /* One bad group costs one surface rather than the model. */
      console.warn('DrftLoader: a merged group would not upload and was skipped', error);
    }
    this.groups.delete(key);
  }

  /**
   * Put the merged groups on screen and throw the per-part meshes away.
   *
   * **In one step, once every group exists.** A frame drawn with both sets present would draw the
   * model twice and blend its translucent surfaces against themselves, and a frame drawn with the
   * singles already gone would show a model with holes in it. So the groups are built over as many
   * frames as it takes and swapped in together.
   */
  private swapInMerged(): void {
    /*
     * Nothing merged and nothing instanced means every part failed to upload, and then the outline
     * is the only thing standing between a viewer and an empty room. Keeping it is the honest
     * state: something incomplete rather than nothing at all. **Instanced parts count**: a file
     * whose every mesh is instanced merges nothing, and a guard on merged groups alone kept its
     * outline on screen over the finished model for ever.
     */
    if (this.mergedParts.length === 0 && this.instancedParts.length === 0) return;
    /*
     * The outline leaves in the same frame the model arrives. Two representations of one object
     * is worse than either of them, and it is what a fade would otherwise cross-dissolve.
     *
     * Kept rather than disposed under `keepReveal`, along with the singles below: a reveal that
     * can be replayed is one whose pieces still exist.
     */
    const keep = this.options.keepReveal === true;
    if (this.outlineMesh !== null && !keep) {
      this.renderer.disposeMesh(this.outlineMesh);
      this.outlineMesh = null;
      this.outlinePart = null;
    }
    this.revealed.length = 0;
    for (const part of this.mergedParts) this.revealed.push(part);
    /* Never merged, so carried across as they are: see `uploadInstanced`. */
    for (const part of this.instancedParts) {
      part.reveal = 1;
      this.revealed.push(part);
    }
    this.mergedParts.length = 0;
    /* Solid first, blended last, which is the whole of the sort: a translucent surface needs the
       world behind it already drawn to blend against. */
    this.revealed.sort((a, b) => b.opacity - a.opacity);
    if (keep) {
      /* Copied after the sort, so a replay of the finished state draws it in the order the
         finished state is actually drawn in. */
      this.finished.length = 0;
      for (const part of this.revealed) this.finished.push(part);
      return;
    }
    for (const mesh of this.singles) this.renderer.disposeMesh(mesh);
    this.singles.length = 0;
  }

  /**
   * Rebuild the name-addressed texture set as images decode.
   *
   * Rebuilt rather than mutated because `TextureSet` is immutable once made, and this happens
   * once per image rather than once per frame. Addressing by name is what stops a regroup
   * silently reassigning an image to a different surface.
   */
  private rebuildTextures(ordinal: number): void {
    if (this.disposed) return;
    const previous = this.textureSet;
    /*
     * An ordinal that already has a texture and a better image is **re-uploaded into the GPU
     * object it already has**, rather than given a new one. That is what makes a preview
     * replaceable at all: every draw loop is holding the handle from the frame the preview landed
     * in, so handing out a second handle would leave the sharp image on a texture nothing draws.
     * `updateSurfaceTexture` exists for exactly this and is what `replaceTexture` is built on.
     */
    const existing = previous?.at(ordinal) ?? null;
    const arrived = this.images[ordinal] ?? null;
    /* Blocks never arrive as a replacement: a BC texture has no preview to replace. */
    if (existing !== null && arrived !== null && !isCompressedSource(arrived)) {
      this.renderer.updateSurfaceTexture(existing, arrived);
      return;
    }

    /*
     * Which images are pictures and which are data, so each is sampled the way its role needs.
     * `textureColorSpaces` owns that question and says at length why it has two answers.
     */
    const spaces = textureColorSpaces(this.materials, this.chunks.length);

    this.textureSet = TextureSet.from(this.chunks, (_, at) => {
      const held = previous?.at(at) ?? null;
      if (held !== null) return held;
      const image = this.images[at] ?? null;
      if (image === null) return null;
      const anisotropy = this.options.anisotropy;
      const wrap = this.options.textureWrap;
      const colorSpace = spaces[at] ?? 'linear';
      return this.renderer.createSurfaceTexture(this.uploadable(image, colorSpace === 'srgb'), {
        ...(anisotropy === undefined ? {} : { anisotropy }),
        ...(wrap === undefined ? {} : { wrap }),
        colorSpace,
      });
    });
  }

  /**
   * A BC texture: its blocks kept, to go up as they are where this device samples them, or decoded
   * off the main thread where it does not — which on a phone is every one. See `bcLoad.ts`.
   *
   * **A consumer taking images through `onImage` gets a decoded image either way**, as an ordinary
   * picture: what it builds from them is its own, and a texture array of bitmaps cannot hold blocks.
   * Like every image, a BC texture fails on its own and its surfaces draw untextured.
   */
  private acceptBc(texture: DrftTexture, ordinal: number): void {
    const done = (image: LoadedImage | null): void => {
      if (this.disposed) return;
      this.images[ordinal] = image;
      this.sharp[ordinal] = true;
      this.imageQueue.push(ordinal);
    };
    const failed = (error: unknown): void => {
      console.warn(
        `DrftLoader: image ${ordinal} did not decode; its surfaces stay untextured` +
          ` (codec BC, ${texture.bytes.length} bytes, ${texture.width}x${texture.height})`,
        error,
      );
      done(null);
    };
    let image: BcImage;
    try {
      image = readBcPayload(texture.width, texture.height, texture.bytes);
    } catch (error) {
      failed(error);
      return;
    }
    const asImage = this.options.onImage !== undefined;
    const srgb = textureColorSpaces(this.materials, ordinal + 1)[ordinal] === 'srgb';
    if (!asImage && bcPlan(image, srgb, this.renderer.compressedFormats) === 'blocks') {
      done(image);
      return;
    }
    if (this.bcDecoder === null) this.bcDecoder = createBcDecoder(this.options.bcWorker ?? null);
    const decoder = this.bcDecoder;
    decoder
      .decode(image, asImage)
      .then(async (rgba) => {
        /* Said once, where a worker could not be had or failed: a slower load nobody could
           otherwise attribute. */
        if (decoder.reason !== '' && !this.warnedBc) {
          this.warnedBc = true;
          console.warn(`DrftLoader: ${decoder.reason}`);
        }
        const pixels = imageDataOf(rgba, image.width, image.height);
        done(asImage ? await createImageBitmap(pixels, AS_AUTHORED) : pixels);
        if (!asImage) this.encodeLater(image, ordinal, srgb);
      })
      .catch(failed);
  }

  /**
   * A BC texture just decoded for the picture, re-encoded as ETC2 or EAC where this device samples
   * that and not BC, and swapped in behind its handle when the chain comes back — at once where the
   * image has gone up, and from `update` where it is still queued. See `etc2Load.ts`.
   */
  private encodeLater(image: BcImage, ordinal: number, srgb: boolean): void {
    const spawn = this.options.bcWorker;
    if (spawn === undefined || !etc2Plan(image, srgb, this.renderer.compressedFormats)) return;
    if (this.etc2Encoder === null) this.etc2Encoder = createEtc2Encoder(spawn);
    const encoder = this.etc2Encoder;
    encoder
      .encode(image, srgb)
      .then((blocks) => {
        if (this.disposed) return;
        if (!this.swapIn(ordinal, blocks, image))
          this.swaps.push({ ordinal, blocks, source: image });
      })
      .catch((error: unknown) => {
        /* Said once: the texture stays the image it already is, which is a cost and not a fault. */
        if (this.disposed || this.warnedEtc2) return;
        this.warnedEtc2 = true;
        console.warn(
          `DrftLoader: ${encoder.reason !== '' ? encoder.reason : `image ${ordinal} did not re-encode as ETC2 and stays RGBA`}`,
          error,
        );
      });
  }

  /**
   * An encoded chain into the texture its image went up as: false where that texture is not made
   * yet. **The decoded image is let go**, and the BC blocks it came from held in its place — a
   * view over the file the loader keeps anyway — so a texture made again from them later decodes
   * as it first did. A chain the texture refuses, where the slot came to read a colour space the
   * blocks have no twin in, leaves the image where it is.
   */
  private swapIn(ordinal: number, blocks: CompressedTextureSource, source: BcImage): boolean {
    const held = this.textureSet?.at(ordinal) ?? null;
    if (held === null) return false;
    try {
      this.renderer.updateSurfaceTexture(held, blocks);
      this.images[ordinal] = source;
    } catch (error) {
      if (!this.warnedEtc2) {
        this.warnedEtc2 = true;
        console.warn(`DrftLoader: image ${ordinal} stays RGBA`, error);
      }
    }
    return true;
  }

  /**
   * What goes to `createSurfaceTexture`: the image as it is, unless it is blocks this device cannot
   * take in the colour space the slot reads — a material read after its texture arrived can change
   * that — in which case they are decoded here, on the spot.
   */
  private uploadable(image: LoadedImage, srgb: boolean): ImageBitmap | ImageData | BcImage {
    if (!isCompressedSource(image)) return image;
    const { format, width, height } = image;
    if (uploadsCompressed(format, srgb, width, height, this.renderer.compressedFormats)) {
      return image;
    }
    return imageDataOf(
      decodeBc(format, width, height, image.levels[0] as Uint8Array),
      width,
      height,
    );
  }

  /** One place that writes the progress, so every field stays consistent with the phase. */
  private set(patch: Partial<DrftLoadProgress>): void {
    const next = { ...this.state, ...patch };
    const parts = next.partsTotal > 0 ? next.partsDone / next.partsTotal : 0;
    const images = next.imagesTotal > 0 ? next.imagesDone / next.imagesTotal : 1;
    this.state = {
      ...next,
      fraction: patch.fraction ?? Math.min(1, parts * this.meshShare + images * this.imageShare),
    };
  }
}

/** A group's glass as the renderer takes it, or null for a group that lets no light through. */
function glassOf(g: DrawGrouping): GlassOptions | null {
  if (g.transmission <= 0) return null;
  return { transmission: g.transmission, frost: g.frost, tint: [g.tint[0], g.tint[1], g.tint[2]] };
}

/**
 * The MIME type a codec's bytes carry, or `null` for one the browser has no decoder for.
 *
 * **Exported because the fall-through was the bug.** This was written inline as two ternaries
 * ending in `'image/jpeg'`, so every codec the chain did not name became a JPEG — and `CODEC_RAW`,
 * which the baker writes for every image it could not find, was handed four bytes of pixel and a
 * decoder that had no chance with them. Naming each codec and returning `null` for the one that is
 * not an encoded image makes the omission a value rather than a default, and lets a test say so.
 */
export function imageTypeFor(codec: number): string | null {
  if (codec === CODEC_PNG) return 'image/png';
  if (codec === CODEC_WEBP) return 'image/webp';
  if (codec === CODEC_JPEG) return 'image/jpeg';
  return null;
}

/**
 * Whether a codec is decoded from its own bytes rather than through an image decoder.
 *
 * Raw is the only one, and it is not an encoded image at all: the bytes *are* the pixels.
 */
export function isRawCodec(codec: number): boolean {
  return codec === CODEC_RAW;
}

/**
 * An embedded image as a bitmap, through the browser's own decoders.
 *
 * The `.slice()` matters: the bytes are a view into the streamed buffer, and a `Blob` built on
 * the view would keep the whole file alive for as long as the image does.
 */
/**
 * How every image a model carries is decoded: **premultiplied, and no colour conversion.**
 *
 * **Straight alpha was tried in 4.0.0 and it is what this reverts.** The argument for it was that
 * `createImageBitmap` premultiplies by default, so a texel with no alpha comes back with no colour
 * and a cutout or an emblem loses the colour its author padded past its edge. That reasoning is
 * sound about the pixels and wrong about the content: an imported material's albedo routinely
 * carries arbitrary bytes under its fully transparent texels, and premultiplying was what kept
 * them out of the frame.
 *
 * **What it cost, reported and then reproduced.** A car came through with its interior, grille,
 * mirrors and lamps as hard black and white shards. Held frames of one scene in the showroom, on
 * one machine, at one frame: a model with 41 images drew clean and two with 64 and 65 drew shards,
 * on **both** backends, with the old container and the new one alike — the count only decides how
 * likely a model is to carry a masked texture at all. Restoring this one option drew the car
 * correctly again.
 *
 * **Why an opaque material sees it.** Nothing discards on an opaque draw, so the shader takes
 * `texel.rgb` whatever the alpha beside it says. Premultiplied, the bytes under a mask arrive as
 * black and disappear into a dark surface; straight, they arrive as whatever the exporter left
 * there. A material that genuinely means to cut out says so with its own alpha reference, which is
 * what `kn5.ts`'s `alphaReference` now reads correctly.
 *
 * **What would make this wrong:** content authored *for* straight alpha, whose colour under a mask
 * is meaningful and wanted — a decal atlas relying on the padding. Nothing measured here is that,
 * and the day one arrives it wants the option per material rather than per engine.
 *
 * `colorSpaceConversion` stays off: a normal or ORM map holds values that are not colours, and
 * glTF says an image's own colour metadata is ignored.
 */
const AS_AUTHORED = {
  premultiplyAlpha: 'premultiply',
  colorSpaceConversion: 'none',
} as const satisfies ImageBitmapOptions;

/** What the loader holds for an image: decoded, or blocks to upload as they are. */
type LoadedImage = ImageBitmap | ImageData | BcImage;

/** RGBA as an `ImageData`, which every upload path takes as it takes a bitmap. */
function imageDataOf(rgba: Uint8Array, width: number, height: number): ImageData {
  return new ImageData(
    new Uint8ClampedArray(rgba.buffer as ArrayBuffer, rgba.byteOffset, rgba.length),
    width,
    height,
  );
}

/** The bitmap `onImage` is handed. Only bitmaps reach that path, BC decoded to one on the way. */
function bitmapOf(image: LoadedImage | null): ImageBitmap | null {
  return image === null || isCompressedSource(image) || 'data' in image ? null : image;
}

async function decodeImage(texture: DrftTexture, longestSide?: number): Promise<ImageBitmap> {
  /*
   * **A raw texture has no decoder, because it is already decoded.**
   *
   * The baker writes one wherever an image was named and could not be found: a 1x1 white
   * `CODEC_RAW` stand-in, so that every material's `albedo` ordinal keeps meaning what it meant
   * rather than renumbering the whole table. Handing those four bytes to `createImageBitmap` as a
   * JPEG fails, as it should — and the result was that every model with a missing map logged one
   * `did not decode` per stand-in and the surface it stood in for went untextured, which is the
   * outcome the stand-in exists to avoid. `blankTextures` in a consumer is written expecting these
   * to arrive as 1x1 white; they never did.
   *
   * `ImageData` takes the bytes as they are, which is what raw means, and needs no round trip
   * through an encoder. Anything not four bytes a pixel is not something this format can describe,
   * so it is refused with a message that says so rather than by a decoder's generic one.
   */
  if (isRawCodec(texture.codec)) {
    const pixels = texture.width * texture.height;
    if (pixels <= 0 || texture.bytes.length < pixels * 4) {
      throw new DrftError(
        `a raw texture needs ${pixels * 4} bytes for ${texture.width}x${texture.height} and carries ${texture.bytes.length}`,
      );
    }
    return await createImageBitmap(
      new ImageData(
        new Uint8ClampedArray(texture.bytes.slice(0, pixels * 4)),
        texture.width,
        texture.height,
      ),
      AS_AUTHORED,
    );
  }
  const type = imageTypeFor(texture.codec);
  if (type === null) {
    throw new DrftError(
      `texture codec ${codecName(texture.codec)} is not one this loader reads: a newer baker ` +
        'wrote it, or the file is damaged. Update @driftengine/assets, or bake with the baker ' +
        'that matches it',
    );
  }
  const blob = new Blob([texture.bytes.slice()], { type });
  if (longestSide === undefined) return await createImageBitmap(blob, AS_AUTHORED);
  /*
   * Resized while it decodes, which is the point: asking for a 256 pixel version of a 2048
   * square is a fraction of the work of decoding one and throwing most of it away, and the
   * browser is the only party here that can do either.
   *
   * Both sides are given so the aspect ratio survives; `width` and `height` come from the
   * chunk, which read them out of the image's own header at bake time. A file that predates
   * those fields reports zero, and then there is nothing to scale against and the full decode
   * is the honest answer.
   */
  const longest = Math.max(texture.width, texture.height);
  if (longest <= 0 || longest <= longestSide) return await createImageBitmap(blob, AS_AUTHORED);
  const scale = longestSide / longest;
  return await createImageBitmap(blob, {
    ...AS_AUTHORED,
    resizeWidth: Math.max(1, Math.round(texture.width * scale)),
    resizeHeight: Math.max(1, Math.round(texture.height * scale)),
    resizeQuality: 'medium',
  });
}
