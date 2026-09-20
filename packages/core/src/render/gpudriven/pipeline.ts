/**
 * The GPU-driven frame, as an order and a set of dependencies.
 *
 * **Every stage of Wave 2A exists on its own and this is what says how they fit together.** The
 * frame's colour is cleared, the directional map is drawn, the meshes wholly outside the view are
 * flagged, the cut through the cluster graph is chosen without them and phase one culls what was
 * visible last frame, phase one draws, the depth pyramid is reduced from that, phase two culls the
 * rest against it and draws, the visibility is copied where a dispatch can read it, binned by
 * material, and each bin is shaded. Twelve stages, and the edges between them are what stop a
 * scheduler reordering the ones that must not move — see `twoPhase.ts` for the one that matters
 * most.
 *
 * **The pipeline is opt-in and WebGPU only.** `gpuDrivenSupported` is `indirectSupport`, which is
 * false on WebGL2 and not a thing a fallback can paper over: without an indirect draw the counts
 * this frame produces would have to come back to the processor, and a readback is slower than the
 * draw it would replace. Selecting it on a backend that cannot run it **fails at creation** rather
 * than falling back, because a silent fallback means a consumer ships believing they have a
 * pipeline they do not.
 *
 * **This is what `GpuDrivenPass` is scheduled by**, since 2026-09-17: the pass records these stages
 * into a `Deps` table each frame, `scheduleGraph` decides which of them run, and the pass encodes
 * the ones it kept in the order it kept them. Until then this was a description beside an encoder
 * with its own fixed order — and the description had drifted, naming a separate instance cull the
 * encoder never had and a colour both draws wrote when neither does. The instance cull is a stage
 * of the encoder now, 2026-09-17, which is `wave2a`'s fifth task finally reaching the frame. Binding real buffers and
 * issuing real dispatches stays the backend's; what moved here is the decision about what runs.
 */

import { indirectSupport } from '../backend/api.ts';
import { recordDeps } from '../frame/deps.ts';
import type { Deps } from '../frame/deps.ts';

/** Whether a backend can run this pipeline at all. */
export function gpuDrivenSupported(backend: 'webgl2' | 'webgpu'): boolean {
  return indirectSupport(backend);
}

/**
 * Why a backend cannot, in the words a consumer sees.
 *
 * A sentence rather than a code, because the one thing the reader needs is that this is a property
 * of the backend and not of their scene — and `''` where it can.
 */
export function gpuDrivenRefusal(backend: 'webgl2' | 'webgpu'): string {
  if (gpuDrivenSupported(backend)) return '';
  return (
    `the gpu-driven pipeline needs indirect draws and dispatches, which ${backend} does not have. ` +
    'Emulating them through a readback is slower than the draw it would replace, so this fails ' +
    'rather than falling back: a silent fallback ships a consumer a pipeline they do not have.'
  );
}

/**
 * Every resource a GPU-driven frame moves between its stages, as an identifier each.
 *
 * **Named for what the encoder actually binds**, which the first version of this table was not: it
 * described both draws writing the colour, which neither does, and an instance cull the encoder did
 * not then have. A description that is not the encoder is a comment, and this one is what the
 * encoder is scheduled by.
 */
export interface GpuDrivenResources {
  /** Everything uploaded once: bounds, cones, errors, indices, vertices, transforms, materials. */
  readonly clusters: number;
  /** Which clusters last frame drew. Imported: this frame reads it and never writes it. */
  readonly history: number;
  readonly shadowMap: number;
  /** Which meshes are wholly outside the view, one flag a mesh. */
  readonly instances: number;
  /** The cut through the cluster graph, one flag a cluster, with hidden meshes left out. */
  readonly cut: number;
  /** The cull's verdict, one flag a cluster, written by each phase for its own half. */
  readonly keep: number;
  /** Each phase's compacted list and the indirect draw that counts it. */
  readonly listOne: number;
  readonly listTwo: number;
  /** Which clusters this frame drew, which is next frame's history. */
  readonly drawn: number;
  readonly depth: number;
  /** The visibility attachment, and the buffer it is copied into so a dispatch can read it. */
  readonly visibility: number;
  readonly visibilityCopy: number;
  readonly hzb: number;
  readonly binCounts: number;
  readonly binOffsets: number;
  /** A copy of the offsets the scatter advances, because the offsets must survive it. */
  readonly binCursors: number;
  readonly binPixels: number;
  readonly colour: number;
  /** The compacted list of blended clusters and the indirect draw that counts it. */
  readonly blendList: number;
  /** The two weighted-transparency targets, and what resolving them writes. */
  readonly oitAccum: number;
  readonly oitReveal: number;
}

/** The identifiers one frame uses. A frame is its own graph, so they start at zero. */
export const GPU_DRIVEN_RESOURCES: GpuDrivenResources = {
  clusters: 0,
  history: 1,
  shadowMap: 2,
  cut: 3,
  keep: 4,
  listOne: 5,
  listTwo: 6,
  drawn: 7,
  depth: 8,
  visibility: 9,
  visibilityCopy: 10,
  hzb: 11,
  binCounts: 12,
  binOffsets: 13,
  binCursors: 14,
  binPixels: 15,
  colour: 16,
  instances: 17,
  blendList: 18,
  oitAccum: 19,
  oitReveal: 20,
};

/**
 * What each stage is called, in the order they are recorded — one render or compute pass each, or
 * one copy between them.
 */
export const GPU_DRIVEN_PASSES = [
  'clearColour',
  'shadow',
  'instanceCull',
  'cut',
  'phaseOneDraw',
  'pyramid',
  'phaseTwoCull',
  'phaseTwoDraw',
  'blendCull',
  'blendDraw',
  'visibilityCopy',
  'bin',
  'cursorCopy',
  'shade',
  'blendResolve',
] as const;

export type GpuDrivenPassName = (typeof GPU_DRIVEN_PASSES)[number];

/**
 * **Every stage is ordered, so none merges with a neighbour.** Two adjacent compute stages could
 * share a pass as far as their results go; they do not, because each is bracketed by its own pair
 * of timestamps and a pair brackets a pass. What the schedule decides here is which stages run,
 * and it checks the order the names give against the edges the stages declare.
 */
export const GPU_DRIVEN_ORDERED: Uint8Array = new Uint8Array(GPU_DRIVEN_PASSES.length).fill(1);

/** Where each pass landed in the dependency table, by name. */
export type GpuDrivenNodes = Readonly<Record<GpuDrivenPassName, number>>;

/** What about this frame changes which stages it needs. */
export interface GpuDrivenFrameShape {
  /**
   * Whether the shading reads the directional map. A frame whose shadow strength is zero does not:
   * the lookup answers one before any arithmetic, so the map's contents cannot reach a pixel and
   * the stage that renders it is culled rather than run for nothing.
   */
  readonly shadowed: boolean;
  /**
   * Whether any material in the table asks to be blended.
   *
   * A frame with none schedules the whole transparent half away — the second run of the cut, the
   * blended draw and the resolve — so a scene that never mentions transparency encodes the frame it
   * encoded before transparency existed, command for command. `gpuDrivenPass.test.ts` holds that
   * against a fixed list rather than against a promise.
   */
  readonly blended: boolean;
}

/** One stage's reads and writes. */
type Edges = readonly [reads: readonly number[], writes: readonly number[]];

/**
 * The frame's edges, stage by stage. The claim is here, and five parts of it are load-bearing
 * enough to name:
 *
 * - `cut` reads the flags `instanceCull` wrote, so a mesh wholly outside the view has its clusters
 *   left out of the cut before the cluster cull or the compaction reads one of them.
 * - `pyramid` reads the depth `phaseOneDraw` wrote, and `phaseTwoCull` reads the pyramid. Together
 *   those are "the occlusion is tested against depth from this frame", which is the whole reason
 *   the frame has two halves — and `cut` reads no pyramid at all, which is the other half of it.
 * - `cut` and `phaseTwoCull` both read the history and both write the next one: the history
 *   decides which half judges a cluster, never whether one does.
 * - `cursorCopy` reads the offsets `bin` wrote and `shade` reads the cursors. The scatter cannot
 *   start before the sum has, and neither ordering is a comment anybody has to obey.
 * - `shade` reads the map only where the frame is shadowed — `unshadowedShade` — so an unshadowed
 *   frame's map is something nothing reads, and `scheduleGraph` culls the stage that draws it.
 */
function edgesFor(res: GpuDrivenResources): {
  readonly stages: readonly Edges[];
  readonly unshadowedShade: readonly number[];
} {
  const table: Record<GpuDrivenPassName, Edges> = {
    clearColour: [[], [res.colour]],
    shadow: [[res.clusters], [res.shadowMap]],
    instanceCull: [[res.clusters], [res.instances]],
    cut: [
      [res.clusters, res.history, res.instances],
      [res.cut, res.keep, res.listOne, res.drawn],
    ],
    phaseOneDraw: [
      [res.listOne, res.clusters],
      [res.depth, res.visibility],
    ],
    pyramid: [[res.depth], [res.hzb]],
    phaseTwoCull: [
      [res.hzb, res.cut, res.clusters, res.history],
      [res.keep, res.listTwo, res.drawn],
    ],
    phaseTwoDraw: [
      [res.listTwo, res.clusters, res.depth, res.visibility],
      [res.depth, res.visibility],
    ],
    /*
     * **The cut's second run, over the other half of the scene.** It reads what the first run read
     * and writes the same working buffers, which is safe because it runs after both draws have
     * taken what they needed from them — and it writes a list of its own, which is what the blended
     * draw reads. It reads the pyramid too: a pane wholly behind a wall is occluded exactly as an
     * opaque cluster there would be.
     */
    blendCull: [
      [res.clusters, res.instances, res.hzb],
      [res.cut, res.keep, res.blendList],
    ],
    /*
     * **It reads the depth the opaque half wrote and does not write it.** A pane behind a wall is
     * rejected at the wall; nothing here writes depth, so two panes do not hide each other and
     * there is something left to blend.
     */
    blendDraw: [
      [res.blendList, res.clusters, res.depth],
      [res.oitAccum, res.oitReveal],
    ],
    visibilityCopy: [[res.visibility], [res.visibilityCopy]],
    bin: [[res.visibilityCopy], [res.binCounts, res.binOffsets]],
    cursorCopy: [[res.binOffsets], [res.binCursors]],
    shade: [
      [res.visibilityCopy, res.binOffsets, res.binCursors, res.clusters, res.colour, res.shadowMap],
      [res.binPixels, res.colour],
    ],
    /*
     * **After the shading, because it composites over what the shading wrote.** The opaque picture
     * is the background a transparent layer is blended against, so this is the last thing the
     * frame does to its own colour target.
     */
    blendResolve: [[res.oitAccum, res.oitReveal, res.colour], [res.colour]],
  };
  return {
    stages: GPU_DRIVEN_PASSES.map((name) => table[name]),
    unshadowedShade: table.shade[0].filter((id) => id !== res.shadowMap),
  };
}

/* Built once a resource table, so a frame records without constructing an edge list. */
const EDGES = new WeakMap<GpuDrivenResources, ReturnType<typeof edgesFor>>();

const SHADE = GPU_DRIVEN_PASSES.indexOf('shade');

/**
 * The three stages a frame with nothing transparent does not record at all.
 *
 * **Culled by giving them no edges rather than by filtering a read**, which is how the shadow map
 * is culled one line above and does not work here: `blendResolve` writes the colour, the colour is
 * what the frame is kept alive for, so a stage that writes it survives any amount of filtering. A
 * stage with no writes is read by nothing and the scheduler drops it, which is the same answer
 * reached the only way that is true for this one.
 */
const BLEND_STAGES: readonly number[] = [
  GPU_DRIVEN_PASSES.indexOf('blendCull'),
  GPU_DRIVEN_PASSES.indexOf('blendDraw'),
  GPU_DRIVEN_PASSES.indexOf('blendResolve'),
];
const NOTHING: readonly number[] = [];

/**
 * Record the whole frame, in order, and answer the index its first stage landed at.
 *
 * Allocates nothing once a resource table has been seen, which is what lets `GpuDrivenPass` call it
 * every frame. Stage `i` of `GPU_DRIVEN_PASSES` is node `first + i`.
 */
export function recordGpuDrivenStages(
  deps: Deps,
  res: GpuDrivenResources,
  shape: GpuDrivenFrameShape,
): number {
  let edges = EDGES.get(res);
  if (edges === undefined) {
    edges = edgesFor(res);
    EDGES.set(res, edges);
  }
  const first = deps.count;
  for (let stage = 0; stage < edges.stages.length; stage += 1) {
    if (!shape.blended && BLEND_STAGES.includes(stage)) {
      recordDeps(deps, NOTHING, NOTHING);
      continue;
    }
    const [reads, writes] = edges.stages[stage] as Edges;
    recordDeps(deps, stage === SHADE && !shape.shadowed ? edges.unshadowedShade : reads, writes);
  }
  return first;
}

/** Record the whole frame and answer where each pass went, by name. For a reader, not a frame. */
export function recordGpuDrivenFrame(
  deps: Deps,
  res: GpuDrivenResources,
  shape: GpuDrivenFrameShape,
): GpuDrivenNodes {
  const first = recordGpuDrivenStages(deps, res, shape);
  return Object.fromEntries(
    GPU_DRIVEN_PASSES.map((name, index) => [name, first + index]),
  ) as unknown as GpuDrivenNodes;
}

/**
 * What a frame leaves behind, which is what `scheduleGraph` is asked to keep alive.
 *
 * The colour, which the blit presents, and the history, which next frame's phase one reads. The
 * depth, the pyramid, the visibility buffer and every bin are this frame's working set and nothing
 * outside reads them. Naming more than is needed keeps resources alive that could have been
 * aliased — which is `alias.ts`'s whole subject — and naming fewer culls a pass that was doing
 * something.
 */
export function gpuDrivenLive(res: GpuDrivenResources): readonly number[] {
  return [res.colour, res.drawn];
}

/** What a frame reads without having written: the scene, and last frame's history. */
export function gpuDrivenImports(res: GpuDrivenResources): readonly number[] {
  return [res.clusters, res.history];
}
