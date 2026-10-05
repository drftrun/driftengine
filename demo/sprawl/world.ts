/**
 * The city as it streams: the container read, every region admitted to the HLOD set as its chunk
 * lands, a level paged while it is drawn, and each drawn by class wearing the arrays.
 *
 * **A level is paged when `HlodSet` chooses it**, and until it is resident the coarser level stands
 * in, where that one is; **a finest level unseen for `RELEASE_SEC` is freed**, so the memory follows
 * the walker and a glance over the shoulder does not refill the queue. A coarse level is small and
 * stays once paged. **The walker's own regions are paged before the card lifts** (`pageAround`).
 *
 * **Drawn by class**: opaque and cut-out classes now, glows and panes queued for `drawLater`, which
 * the frame calls after everything opaque — additive glows adding their light, panes blended at
 * their class's opacity. A class whose pictures have not all arrived draws white.
 *
 * **Occluders near the eye only**: a region's building boxes are declared while it is within
 * `OCCLUDE_M`; one further off hides little, and every box is a draw into the occlusion buffer.
 *
 * Nothing here allocates in `draw` or `drawLater`.
 */
import { HlodSet, createHlodDraws, projectionScaleOf } from '../../packages/core/src/index';
import type {
  FrustumPlanes,
  MeshData,
  MeshHandle,
  RendererApi,
  ShadowCasters,
} from '../../packages/core/src/index';
import { DrftLoader } from '@driftengine/assets';
import { spawnBcWorker } from '@driftengine/assets/src/bcWorkers.ts';
import type { DrftPart, LoadedRegion } from '@driftengine/assets';

import { CityArrays } from './arrays';
import type { MaterialClass } from './arrays';
import { readCityScene } from './scene';
import type { CityScene } from './scene';

const IDENTITY = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
/** Room for every region of the city, with some to spare. */
const CAPACITY = 640;
/** Seconds a finest level may go undrawn before its meshes are freed. */
const RELEASE_SEC = 4;
/** How near a region must be for its building boxes to be declared occluders. */
const OCCLUDE_M = 400;
/*
 * A region's glows and panes lie on it and move only as it does, so the reconstruction resolves them
 * with it rather than drawing them after the upscale, where every edge they run along was covered
 * differently each frame. See `TranslucentMeshOptions.reconstructed`.
 */
const ADD = { additive: true, depthWrite: false, reconstructed: true } as const;
/** A class's place in the draw order: solid first, then what blends over it. */
const BLEND_ORDER: Readonly<Record<MaterialClass['blend'], number>> = {
  opaque: 0,
  cutout: 1,
  additive: 2,
  blend: 3,
};
const BLENDS = 4;
const SOLID_BLENDS = 2;

interface Queued {
  part: DrftPart;
  cls: MaterialClass;
  dither: number;
}
/** What a missing level draws, without building an empty list to say so. */
const NONE: readonly never[] = [];
const OVER = { additive: false, depthWrite: false, reconstructed: true } as const;

export interface WorldOptions {
  /** Pixels of geometric error a level may show; `HlodSet`'s own default unless given. */
  readonly pixelTolerance?: number;
  /** Seconds a switch of level crossfades; 0 for a held capture. */
  readonly fadeSec?: number;
}

export class CityWorld {
  readonly loader: DrftLoader;
  /** The meshes no region holds, by ordinal: the movers, which the frame instances itself. */
  readonly moverMeshes = new Map<number, MeshData>();
  scene: CityScene | null = null;
  arrays: CityArrays | null = null;
  private readonly early = new Map<string, ImageBitmap | null>();
  private readonly hlod: HlodSet;
  private readonly draws = createHlodDraws(CAPACITY);
  /** When each region's finest level was last drawn, by id. */
  private readonly seen = new Map<number, number>();
  private time = 0;
  private dt = 0;
  /** The draws of a frame by class — texture array and blend — each run in one material. */
  private readonly buckets: Queued[][] = [];
  private readonly filled: number[] = [];
  private readonly min = new Float32Array(3);
  private readonly max = new Float32Array(3);
  /** Draws issued in the last `draw` and `drawLater`. */
  issued = 0;

  constructor(
    private readonly renderer: RendererApi,
    options: WorldOptions = {},
  ) {
    this.hlod = new HlodSet({
      capacity: CAPACITY,
      ...(options.pixelTolerance === undefined ? {} : { pixelTolerance: options.pixelTolerance }),
      fadeSec: options.fadeSec ?? 0.4,
    });
    this.loader = new DrftLoader(renderer, {
      bcWorker: spawnBcWorker,
      revealSec: 0,
      onImage: (name, image) => {
        if (this.arrays === null) this.early.set(name, image);
        else this.arrays.take(name, image);
      },
      onMesh: (mesh, ordinal) => {
        this.moverMeshes.set(ordinal, mesh);
        return true;
      },
    });
  }

  /** Stream the container; resolves once its last byte has arrived, not once it is drawn. */
  async open(response: Response): Promise<void> {
    await this.loader.consume(response, { fit: 'none' });
  }

  /** Advance the stream and the paging by `dt` seconds. */
  update(dt: number): void {
    this.time += dt;
    this.dt = dt;
    this.loader.update(dt);
    const entities = this.loader.entities;
    if (this.scene === null && entities !== null) {
      this.scene = readCityScene(entities);
      this.arrays = new CityArrays(this.renderer, this.scene.plan);
      for (const [name, image] of this.early) this.arrays.take(name, image);
      this.early.clear();
    }
    for (const region of this.loader.regions.values()) {
      if (!this.hlod.has(region.id)) {
        this.hlod.add(
          region.id,
          region.bounds,
          region.levels.map((l) => l.error),
        );
      }
    }
    for (const [id, at] of this.seen) {
      if (this.time - at < RELEASE_SEC) continue;
      this.loader.pageRegion(id, 0, false);
      this.seen.delete(id);
    }
  }

  /**
   * Page the finest level of every region whose box is within `radius` of (x, z), and say how many
   * of them are resident: the walker's first frame, which the card waits for.
   */
  pageAround(x: number, z: number, radius: number): { resident: number; total: number } {
    let [resident, total] = [0, 0];
    for (const region of this.loader.regions.values()) {
      const b = region.bounds;
      const dx = Math.max((b[0] as number) - x, 0, x - (b[3] as number));
      const dz = Math.max((b[2] as number) - z, 0, z - (b[5] as number));
      if (Math.hypot(dx, dz) > radius) continue;
      total += 1;
      const level = region.levels[0];
      if (level === undefined) continue;
      if (level.resident) resident += 1;
      else this.loader.pageRegion(region.id, 0, true);
      this.seen.set(region.id, this.time);
    }
    return { resident, total };
  }

  /**
   * Draw every opaque and cut-out class of the chosen levels; the glows and panes wait for
   * `drawLater`. Each class is drawn in one run across every region, so a frame changes material
   * once a class rather than once a draw.
   */
  draw(eye: ArrayLike<number>, fovYDeg: number, heightPx: number, frustum: FrustumPlanes): void {
    this.issued = 0;
    for (let b = 0; b < this.filled.length; b++) this.filled[b] = 0;
    const scene = this.scene;
    if (scene === null) return;
    for (const region of this.loader.regions.values()) this.occlude(region, eye);
    const scale = projectionScaleOf(fovYDeg, heightPx);
    const n = this.hlod.select(eye, scale, frustum, this.renderer, this.dt, this.draws);
    for (let i = 0; i < n; i++) {
      const id = this.draws.region[i] as number;
      const region = this.loader.regions.get(id);
      const classes = scene.regions.get(id);
      if (region === undefined || classes === undefined) continue;
      let level = this.draws.level[i] as number;
      const chosen = region.levels[level];
      if (chosen === undefined) continue;
      if (level === 0) this.seen.set(id, this.time);
      if (!chosen.resident) {
        this.loader.pageRegion(id, level, true);
        /* The coarser level stands in until the chosen one is up. */
        const coarser = region.levels[level + 1];
        if (coarser === undefined || !coarser.resident) {
          if (coarser !== undefined) this.loader.pageRegion(id, level + 1, true);
          continue;
        }
        level += 1;
      }
      const dither = this.draws.dither[i] as number;
      const parts = region.levels[level]?.parts ?? NONE;
      const levelClasses = classes.levels[level] ?? NONE;
      for (let p = 0; p < parts.length; p++) {
        this.enqueue(parts[p] as DrftPart, levelClasses[p], dither);
      }
      if (level === 0) {
        for (let b = 0; b < region.batches.length; b++) {
          this.enqueue(
            region.batches[b] as DrftPart,
            classes.groups[region.batchGroups[b] ?? -1],
            dither,
          );
        }
      }
    }
    for (let key = 0; key < this.buckets.length; key++) {
      if (key % BLENDS < SOLID_BLENDS) this.drawBucket(key);
    }
    this.renderer.setDitherFade(0);
    this.renderer.setMaterial(null);
  }

  /** The glows and panes `draw` held back, after everything opaque. */
  drawLater(): void {
    for (let key = 0; key < this.buckets.length; key++) {
      if (key % BLENDS >= SOLID_BLENDS) this.drawBucket(key);
    }
    this.renderer.setDitherFade(0);
    this.renderer.setMaterial(null);
  }

  private enqueue(part: DrftPart, cls: MaterialClass | undefined, dither: number): void {
    if (cls === undefined) return;
    const key = cls.texture * BLENDS + BLEND_ORDER[cls.blend];
    while (this.buckets.length <= key) {
      this.buckets.push([]);
      this.filled.push(0);
    }
    const bucket = this.buckets[key] as Queued[];
    const at = this.filled[key] as number;
    const slot = bucket[at];
    if (slot === undefined) bucket.push({ part, cls, dither });
    else {
      slot.part = part;
      slot.cls = cls;
      slot.dither = dither;
    }
    this.filled[key] = at + 1;
  }

  private drawBucket(key: number): void {
    const count = this.filled[key] as number;
    if (count === 0) return;
    const bucket = this.buckets[key] as Queued[];
    const first = bucket[0] as Queued;
    this.renderer.setMaterial(this.arrays?.material(first.cls) ?? null);
    let dither = 0;
    this.renderer.setDitherFade(0);
    for (let i = 0; i < count; i++) {
      const { part, cls } = bucket[i] as Queued;
      const d = (bucket[i] as Queued).dither;
      if (d !== dither) {
        dither = d;
        this.renderer.setDitherFade(d);
      }
      const glow = cls.blend === 'additive';
      if (glow || cls.blend === 'blend') {
        const opacity = glow ? 1 : cls.alpha;
        if (part.instances !== null) {
          this.renderer.drawTranslucentInstanced(
            part.instances.batch,
            part.instances.data,
            opacity,
            glow ? ADD : OVER,
          );
        } else {
          this.renderer.drawTranslucentMesh(
            part.mesh as MeshHandle,
            IDENTITY,
            opacity,
            glow ? ADD : OVER,
          );
        }
      } else if (part.instances !== null) {
        this.renderer.drawInstanced(part.instances.batch, part.instances.data);
      } else {
        this.renderer.drawMesh(part.mesh as MeshHandle, IDENTITY);
      }
      this.issued++;
    }
  }

  /**
   * What casts the sun's shadow: the finest level of every resident region within `shadowRange` of
   * `shadowCentre`, opaque classes only — a glow casts nothing, and a leaf's cut-out is not handed
   * to the shadow pass yet, so the trees cast none.
   */
  readonly casters: ShadowCasters = (sink) => {
    const scene = this.scene;
    if (scene === null) return;
    const [cx, cz, range] = [
      this.shadowCentre[0] as number,
      this.shadowCentre[1] as number,
      this.shadowRange,
    ];
    for (const region of this.loader.regions.values()) {
      const b = region.bounds;
      const dx = Math.max((b[0] as number) - cx, 0, cx - (b[3] as number));
      const dz = Math.max((b[2] as number) - cz, 0, cz - (b[5] as number));
      if (dx * dx + dz * dz > range * range) continue;
      const level = region.levels[0];
      const classes = scene.regions.get(region.id)?.levels[0];
      if (level === undefined || classes === undefined || !level.resident) continue;
      for (let p = 0; p < level.parts.length; p++) {
        if (classes[p]?.blend !== 'opaque') continue;
        sink.mesh((level.parts[p] as DrftPart).mesh as MeshHandle, IDENTITY);
      }
    }
  };
  /** Where the sun's shadow is centred, (x, z), and how far it reaches. */
  readonly shadowCentre = new Float32Array(2);
  shadowRange = 160;

  private occlude(region: LoadedRegion, eye: ArrayLike<number>): void {
    const b = region.bounds;
    const dx = Math.max(
      (b[0] as number) - (eye[0] as number),
      0,
      (eye[0] as number) - (b[3] as number),
    );
    const dz = Math.max(
      (b[2] as number) - (eye[2] as number),
      0,
      (eye[2] as number) - (b[5] as number),
    );
    if (dx * dx + dz * dz > OCCLUDE_M * OCCLUDE_M) return;
    const o = region.occluders;
    for (let i = 0; i + 5 < o.length; i += 6) {
      this.min[0] = o[i] as number;
      this.min[1] = o[i + 1] as number;
      this.min[2] = o[i + 2] as number;
      this.max[0] = o[i + 3] as number;
      this.max[1] = o[i + 4] as number;
      this.max[2] = o[i + 5] as number;
      this.renderer.addOccluder(this.min, this.max, IDENTITY);
    }
  }
}
