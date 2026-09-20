/** Loading a `.drft` into drawable parts progressively, without stalling the frame. */

import type { MeshData } from '@driftengine/drft';
import type { Mesh } from '@driftengine/core';
import type { MeshHandle, RendererApi } from '@driftengine/core';
import type { SurfaceTextureHandle } from '@driftengine/core';
import { MeshBuilder } from '@driftengine/core';
import type { DrftMaterial } from '@driftengine/drft';
import type { DrftTexture } from '@driftengine/drft';
import { TextureSet, textureColorSpaces } from './drftTextures.ts';
import { drawKeyOf, resolveDrawGrouping } from './drawKey.ts';
import { streamDrft, CODEC_PNG, CODEC_RAW, CODEC_WEBP, DrftError } from '@driftengine/drft';
import type { AnimationClip, DrftMorph, DrftNode, DrftSkin } from '@driftengine/drft';
import type { DrftLoadProgress, DrftPart } from './loadProgress.ts';
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
  /** Per-material opacity and reflectivity overrides, for the same reason as `transform`. */
  readonly surface?: (
    material: DrftMaterial | undefined,
  ) => { readonly opacity?: number; readonly reflectivity?: number } | undefined;
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
}

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
  private readonly queue: { mesh: MeshData; material: DrftMaterial | undefined }[] = [];
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
      builder: MeshBuilder;
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
  private readonly images: (ImageBitmap | null)[] = [];
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

  constructor(renderer: RendererApi, options: DrftLoaderOptions = {}) {
    this.renderer = renderer;
    this.options = options;
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

        onMesh: (mesh, ordinal) => {
          if (this.disposed) return;
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
          this.queue.push({ mesh: withMorph, material });
          this.arrived++;
          this.set({ phase: 'geometry', partsDone: this.arrived });
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
      if (this.uploadOne(next.mesh, next.material)) changed = true;
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
        this.rebuildTextures(ordinal);
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
        this.set({ phase: 'ready', fraction: 1 });
        changed = true;
      }
    }
    return changed;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
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
      reveal: this.outlinePart?.reveal ?? 0,
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
  private uploadOne(mesh: MeshData, material: DrftMaterial | undefined): boolean {
    const fit = this.fit;
    if (fit === null) return false;
    const dressed = this.options.transform?.(mesh, material) ?? mesh;
    const single = new MeshBuilder();
    single.addMesh(dressed, fit.x, fit.y, fit.z, fit.scale);
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
    } = g;

    /*
     * Added to its merged group here, while there is a budget governing how much of this happens
     * in one frame.
     */
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
        builder: new MeshBuilder(),
      };
      this.groups.set(key, group);
    }
    /* Not merged, for the reason above: a group's deltas would deform its neighbours. */
    if (dressed.morphTargets === undefined) {
      group.builder.addMesh(dressed, fit.x, fit.y, fit.z, fit.scale);
    }

    try {
      /*
       * **A morphed part bypasses the builder, and is never merged.**
       *
       * `MeshBuilder` carries the attributes it knows and morph deltas are not among them, so a
       * part built through it arrives on the GPU with its targets dropped. Merging is worse than
       * that rather than merely lossy: a merged group concatenates vertices from several parts,
       * and one part's deltas applied across that buffer would deform whatever geometry happened
       * to follow it.
       *
       * So the deltas are scaled by the fit and handed straight to `createMesh`. **Scaled and not
       * translated** — a delta is a displacement, and moving it by the fit's offset would drag
       * every vertex toward the origin of the model rather than deform it in place.
       */
      const built = single.build();
      const morphable =
        dressed.morphTargets !== undefined && dressed.morphTargetCount !== undefined
          ? {
              ...built,
              morphTargets: dressed.morphTargets.map((delta) => delta * fit.scale),
              morphTargetCount: dressed.morphTargetCount,
            }
          : built;
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
        reveal: 0,
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
  private buildGroup(key: string): void {
    const group = this.groups.get(key);
    if (group === undefined) return;
    try {
      this.mergedParts.push({
        mesh: this.renderer.createMesh(group.builder.build()),
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
        reveal: 1,
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
     * Nothing merged means every group failed to upload, and then the outline is the only thing
     * standing between a viewer and an empty room. Keeping it is the honest state: something
     * incomplete rather than nothing at all.
     */
    if (this.mergedParts.length === 0) return;
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
    if (existing !== null && arrived !== null) {
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
      const bitmap = this.images[at] ?? null;
      if (bitmap === null) return null;
      const anisotropy = this.options.anisotropy;
      const wrap = this.options.textureWrap;
      return this.renderer.createSurfaceTexture(bitmap, {
        ...(anisotropy === undefined ? {} : { anisotropy }),
        ...(wrap === undefined ? {} : { wrap }),
        colorSpace: spaces[at] ?? 'linear',
      });
    });
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

/**
 * The MIME type a codec's bytes carry, or `null` for one the browser has no decoder for.
 *
 * **Exported because the fall-through was the bug.** This was written inline as two ternaries
 * ending in `'image/jpeg'`, so every codec the chain did not name became a JPEG — and `CODEC_RAW`,
 * which the baker writes for every image it could not find, was handed four bytes of pixel and a
 * decoder that had no chance with them. Naming each codec and returning `null` for the one that is
 * not an encoded image makes the omission a value rather than a default, and lets a test say so.
 */
export function imageTypeFor(codec: number): string {
  if (codec === CODEC_PNG) return 'image/png';
  if (codec === CODEC_WEBP) return 'image/webp';
  return 'image/jpeg';
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
 * How every image a model carries is decoded: **straight alpha, and no colour conversion.**
 *
 * `createImageBitmap` premultiplies unless told not to, and the upload into a straight-alpha
 * texture then divides back out. A texel with no alpha comes back with no colour, so a cutout or an
 * emblem loses the colour its author padded past its edge, and filtering pulls black into the edge;
 * a partly transparent one comes back rounded to a coarser step. Colour management rewrites a normal
 * or ORM map, whose values are not colours at all, and glTF — which these assets are baked from —
 * says an image's own colour metadata is ignored. `render/imageTexels.ts` asks for the same two.
 *
 * What it gives up: an albedo authored in a wide-gamut space with a profile saying so is read as
 * sRGB. The baker is where that conversion belongs, and it has no colour management either.
 */
const AS_AUTHORED = {
  premultiplyAlpha: 'none',
  colorSpaceConversion: 'none',
} as const satisfies ImageBitmapOptions;

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
  const blob = new Blob([texture.bytes.slice()], { type: imageTypeFor(texture.codec) });
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
