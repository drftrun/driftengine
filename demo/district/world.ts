/**
 * The district as it streams: regions admitted to the HLOD set as they land, the chosen level of
 * each paged while it is drawn, and every part drawn in the material the scene file gives it.
 *
 * **Drawn by material across the whole frame.** Every part a frame draws is put in its material's
 * bucket first, and each bucket is drawn in one run, so a frame binds a material once however many
 * regions wear it: a street of forty shopfronts sharing a dozen materials is a dozen material
 * changes, which is the number the frame's material ring counts, rather than forty times that.
 *
 * **Opaque and cut-out now, translucent later**: glass and anything blended waits for `drawLater`,
 * which the frame calls after the sky, so it lies over what is behind it.
 *
 * **A copy group wears the scene file's material, not its mesh's.** A prototype's geometry is in
 * the container once and worn in every colour the source gives it, which the container's one
 * material a mesh cannot say, so the scene file names the row a group wears and this binds that.
 *
 * Nothing here allocates in `draw` or `drawLater`, once the buckets have grown to the frame's size.
 */
import { HlodSet, createHlodDraws, projectionScaleOf } from '../../packages/core/src/index';
import type {
  FrustumPlanes,
  MeshHandle,
  RendererApi,
  ShadowCasters,
  SurfaceMaterial,
  SurfaceTextureHandle,
  TranslucentMeshOptions,
} from '../../packages/core/src/index';
import { DrftLoader } from '@driftengine/assets';
import { spawnBcWorker } from '@driftengine/assets/src/bcWorkers.ts';
import type { DrftPart } from '@driftengine/assets';

import type { SceneFile } from './bake/write';
import { Glow } from './glow';

const IDENTITY = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
const CAPACITY = 1024;
/** Seconds a finest level may go undrawn before its meshes are freed. */
const RELEASE_SEC = 6;
/** A blended surface writes no depth, so the haze and the glows behind it are not stopped by it. */
const BLENDED: TranslucentMeshOptions = { depthWrite: false };
/** Copies are drawn within this of the eye; past it a region's own levels stand for its props. */
const COPIES_M = 420;
/**
 * In the mirror, copies only this near: the water reflects the street's walls, its ground and its
 * signs, and a second frame of every prop in the district would spend the draw ring on litter
 * seen upside down through ripples.
 */
const MIRROR_COPIES_M = 70;

interface Queued {
  part: DrftPart;
  dither: number;
}

export class DistrictWorld {
  readonly loader: DrftLoader;
  scene: SceneFile | null = null;
  readonly glow = new Glow();
  private readonly hlod: HlodSet;
  private readonly draws = createHlodDraws(CAPACITY);
  private readonly seen = new Map<number, number>();
  private materials: (SurfaceMaterial<SurfaceTextureHandle> | null)[] = [];
  /** Per material row: its queued parts this frame, and how many. */
  private readonly buckets: Queued[][] = [];
  private readonly filled: number[] = [];
  private readonly translucent: boolean[] = [];
  /** Each translucent row's draw: blended, and glass where its material lets light through. */
  private readonly through: TranslucentMeshOptions[] = [];
  /** Material rows left undrawn, `?hide=<row,row>`: the instrument for telling which surface is which. */
  hidden = new Set<number>();
  /** The regions past the core, every level of which is a clustering of the whole region. */
  private skyline = new Set<number>();
  private time = 0;
  private dt = 0;
  issued = 0;
  /** What the last frame queued, for the readout: statics, copy groups, coarse levels. */
  readonly queued = { statics: 0, copies: 0, coarse: 0, paging: 0 };
  /** Where the mirror's counts go, so the readout keeps the real frame's. */
  private readonly counted = { statics: 0, copies: 0, coarse: 0, paging: 0 };
  /**
   * Material changes the pass under way has spent, and what the last real pass spent: the frame's
   * ring holds 1,024 and a draw past it is skipped, so the mirror is given what the real frame
   * leaves rather than what it would like.
   */
  private changes = 0;
  private allowance = Infinity;
  lastChanges = 0;
  /** Draws the pass under way has issued, and how many it may: the ring of draws is finite too. */
  private drawn = 0;
  private drawAllowance = Infinity;
  shadowRange = 180;
  readonly shadowCentre = new Float32Array(2);

  constructor(
    private readonly renderer: RendererApi,
    fadeSec = 0.4,
  ) {
    this.hlod = new HlodSet({ capacity: CAPACITY, fadeSec });
    /* A city's walls are seen along the street, at grazing angles, which is what anisotropy is for. */
    this.loader = new DrftLoader(renderer, {
      bcWorker: spawnBcWorker,
      revealSec: 0,
      anisotropy: 16,
    });
  }

  /** Stream the container and its scene file; resolves once the container's last byte has arrived. */
  async open(container: Response, file: Response): Promise<void> {
    const scene = (await file.json()) as SceneFile;
    this.scene = scene;
    for (const row of scene.materials) {
      this.buckets.push([]);
      this.filled.push(0);
      this.translucent.push(
        row.drft.opacity < 1 || row.drft.blend === true || (row.drft.transmission ?? 0) > 0,
      );
      const m = row.drft;
      this.through.push(
        (m.transmission ?? 0) > 0
          ? {
              ...BLENDED,
              glass: {
                transmission: m.transmission ?? 0,
                frost: m.frost ?? 0,
                tint: [m.tint?.[0] ?? 1, m.tint?.[1] ?? 1, m.tint?.[2] ?? 1],
              },
            }
          : BLENDED,
      );
    }
    this.glow.take(scene.materials);
    this.skyline = new Set(scene.skyline ?? []);
    await this.loader.consume(container, { fit: 'none' });
  }

  update(dt: number): void {
    this.time += dt;
    this.dt = dt;
    this.loader.update(dt);
    for (const region of this.loader.regions.values()) {
      if (!this.hlod.has(region.id))
        this.hlod.add(
          region.id,
          region.bounds,
          region.levels.map((l) => l.error),
        );
    }
    for (const [id, at] of this.seen) {
      if (this.time - at < RELEASE_SEC) continue;
      this.loader.pageRegion(id, 0, false);
      this.seen.delete(id);
    }
    if (this.materials.length === 0) this.build();
    else if (this.unresolved > 0) this.resolve();
  }

  /** Maps that were still decoding when the materials were built, bound as they arrive. */
  private unresolved = 0;

  private resolve(): void {
    const scene = this.scene;
    const textures = this.loader.textures;
    if (scene === null || textures === null) return;
    let missing = 0;
    scene.materials.forEach((row, i) => {
      const material = this.materials[i];
      if (material === null || material === undefined) return;
      const m = row.drft;
      if (material.albedo === null && m.albedo >= 0) material.albedo = textures.at(m.albedo);
      if (material.normal === null && m.normalMap >= 0) material.normal = textures.at(m.normalMap);
      if (material.orm === null && m.ormMap >= 0) material.orm = textures.at(m.ormMap);
      if (material.emissive === null && m.emissiveMap >= 0)
        material.emissive = textures.at(m.emissiveMap);
      if (
        (material.albedo === null && m.albedo >= 0) ||
        (material.normal === null && m.normalMap >= 0) ||
        (material.orm === null && m.ormMap >= 0) ||
        (material.emissive === null && m.emissiveMap >= 0)
      )
        missing++;
    });
    this.unresolved = missing;
  }

  /** Each material row as the renderer takes it, once the pictures have a set to live in. */
  private build(): void {
    const scene = this.scene;
    const textures = this.loader.textures;
    if (scene === null || textures === null) return;
    this.materials = scene.materials.map((row) => {
      const m = row.drft;
      return {
        albedo: textures.at(m.albedo),
        normal: textures.at(m.normalMap),
        orm: textures.at(m.ormMap),
        emissive: textures.at(m.emissiveMap),
        roughnessScale: m.roughnessScale,
        metallicScale: m.metallicScale,
        occlusionStrength: m.occlusionStrength,
        cutout: m.cutout,
        doubleSided: m.doubleSided === true,
        emissiveScale: [1, 1, 1],
      };
    });
    this.unresolved = 1;
    this.resolve();
  }

  /**
   * Page the finest level of every region within `radius` of (x, z); how many are resident, which
   * is a region whose finest level is up and whose props have all arrived: a street counted as
   * arrived with its lamps and shopfronts still on their way was a street a visitor watched fill in.
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
      if (level.resident && region.pending === 0) resident += 1;
      else this.loader.pageRegion(region.id, 0, true);
      this.seen.set(region.id, this.time);
    }
    return { resident, total };
  }

  /** The night's glow on every material, at `night` from 0 by day to 1 by night. */
  shine(night: number, seconds: number, gain = 1): void {
    this.glow.apply(this.materials, night, seconds, gain);
  }

  /**
   * Draw the chosen levels' opaque and cut-out parts, by material.
   *
   * `mirror` is the same frame seen from under the water: the levels are chosen afresh for that
   * eye with the fade clock held, so the real frame's fades advance once, and the counters the
   * readout shows are the real frame's.
   */
  draw(
    eye: ArrayLike<number>,
    fovYDeg: number,
    heightPx: number,
    frustum: FrustumPlanes,
    mirror = false,
    allowance = Infinity,
    drawAllowance = Infinity,
  ): void {
    this.changes = 0;
    this.allowance = allowance;
    this.drawn = 0;
    this.drawAllowance = drawAllowance;
    if (!mirror) {
      this.issued = 0;
      this.queued.statics = this.queued.copies = this.queued.coarse = this.queued.paging = 0;
    }
    const counted = this.counted;
    for (let b = 0; b < this.filled.length; b++) this.filled[b] = 0;
    const scene = this.scene;
    if (scene === null || this.materials.length === 0) return;
    const scale = projectionScaleOf(fovYDeg, heightPx);
    const n = this.hlod.select(
      eye,
      scale,
      frustum,
      this.renderer,
      mirror ? 0 : this.dt,
      this.draws,
    );
    const queued = mirror ? counted : this.queued;
    const copiesM = mirror ? MIRROR_COPIES_M : COPIES_M;
    for (let i = 0; i < n; i++) {
      const id = this.draws.region[i] as number;
      const region = this.loader.regions.get(id);
      if (region === undefined) continue;
      let level = this.draws.level[i] as number;
      const chosen = region.levels[level];
      if (chosen === undefined) continue;
      if (!chosen.resident) {
        this.loader.pageRegion(id, level, true);
        const coarser = region.levels[level + 1];
        if (coarser === undefined || !coarser.resident) {
          if (coarser !== undefined) this.loader.pageRegion(id, level + 1, true);
          continue;
        }
        level += 1;
      }
      const dither = this.draws.dither[i] as number;
      /* A skyline region is the level its distance chose and nothing beside it. */
      if (this.skyline.has(id)) {
        const parts = region.levels[level]?.parts;
        const rows = scene.levelMaterial[id]?.[level];
        if (parts !== undefined && rows !== undefined)
          for (let p = 0; p < parts.length; p++)
            this.enqueue(rows[p] ?? -1, parts[p] as DrftPart, dither);
        queued.coarse += parts?.length ?? 0;
        this.seen.set(id, this.time);
        continue;
      }
      /*
       * The statics are the finest level and are drawn at every distance (the bake's `regions.ts`
       * says why); a coarser level stands only for the copies, which the finest draws instanced.
       */
      const finest = region.levels[0];
      if (finest !== undefined && !finest.resident) {
        this.loader.pageRegion(id, 0, true);
        queued.paging++;
      } else if (finest !== undefined) {
        const rows = scene.levelMaterial[id]?.[0];
        if (rows !== undefined)
          for (let p = 0; p < finest.parts.length; p++)
            this.enqueue(rows[p] ?? -1, finest.parts[p] as DrftPart, 0);
        queued.statics += finest.parts.length;
        this.seen.set(id, this.time);
      }
      if (level !== 0) {
        const coarse = region.levels[level]?.parts;
        const rows = scene.levelMaterial[id]?.[level];
        if (coarse !== undefined && rows !== undefined)
          for (let p = 0; p < coarse.length; p++)
            this.enqueue(rows[p] ?? -1, coarse[p] as DrftPart, dither);
        queued.coarse += coarse?.length ?? 0;
        continue;
      }
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
      if (dx * dx + dz * dz > copiesM * copiesM) continue;
      const groups = scene.groupMaterial[id];
      if (groups === undefined) continue;
      for (let g = 0; g < region.batches.length; g++) {
        this.enqueue(
          groups[region.batchGroups[g] ?? -1] ?? -1,
          region.batches[g] as DrftPart,
          dither,
        );
      }
      queued.copies += region.batches.length;
    }
    /* Rows in the bake's order, which is the statics' first: a mirror short of budget keeps the walls. */
    for (let row = 0; row < this.buckets.length; row++)
      if (this.translucent[row] !== true) this.drawBucket(row);
    this.renderer.setDitherFade(0);
    this.renderer.setMaterial(null);
    if (!mirror) this.lastChanges = this.changes;
  }

  /** The translucent parts `draw` held back, after everything opaque. */
  drawLater(): void {
    this.allowance = Infinity;
    this.changes = 0;
    this.drawAllowance = Infinity;
    for (let row = 0; row < this.buckets.length; row++)
      if (this.translucent[row] === true) this.drawBucket(row);
    this.renderer.setDitherFade(0);
    this.renderer.setMaterial(null);
    this.lastChanges += this.changes;
  }

  private enqueue(row: number, part: DrftPart, dither: number): void {
    if (row < 0 || row >= this.buckets.length) return;
    const bucket = this.buckets[row] as Queued[];
    const at = this.filled[row] as number;
    const slot = bucket[at];
    if (slot === undefined) bucket.push({ part, dither });
    else {
      slot.part = part;
      slot.dither = dither;
    }
    this.filled[row] = at + 1;
  }

  private drawBucket(row: number): void {
    const count = this.filled[row] as number;
    if (count === 0 || this.changes >= this.allowance || this.hidden.has(row)) return;
    const renderer = this.renderer;
    const material = this.materials[row] ?? null;
    const drft = this.scene?.materials[row]?.drft;
    renderer.setMaterial(material);
    renderer.setSurfaceReflectivity(drft?.reflectivity ?? 0);
    const translucent = this.translucent[row] === true;
    const opacity = drft?.opacity ?? 1;
    let dither = -1;
    const bucket = this.buckets[row] as Queued[];
    for (let i = 0; i < count && this.drawn < this.drawAllowance; i++) {
      const queued = bucket[i] as Queued;
      if (queued.dither !== dither) {
        dither = queued.dither;
        renderer.setDitherFade(dither);
        /* A new fade is a new material: the first opens the bucket's, every later one another. */
        this.changes++;
      }
      const part = queued.part;
      if (translucent) {
        const through = this.through[row] ?? BLENDED;
        if (part.instances !== null)
          renderer.drawTranslucentInstanced(
            part.instances.batch,
            part.instances.data,
            opacity,
            through,
          );
        else renderer.drawTranslucentMesh(part.mesh as MeshHandle, IDENTITY, opacity, through);
      } else if (part.instances !== null)
        renderer.drawInstanced(part.instances.batch, part.instances.data);
      else renderer.drawMesh(part.mesh as MeshHandle, IDENTITY);
      this.issued++;
      this.drawn++;
    }
  }

  /** What casts the sun's shadow: the finest statics of every resident region within reach. */
  readonly casters: ShadowCasters = (sink) => {
    const scene = this.scene;
    if (scene === null) return;
    const cx = this.shadowCentre[0] as number;
    const cz = this.shadowCentre[1] as number;
    const range = this.shadowRange;
    for (const region of this.loader.regions.values()) {
      const b = region.bounds;
      const dx = Math.max((b[0] as number) - cx, 0, cx - (b[3] as number));
      const dz = Math.max((b[2] as number) - cz, 0, cz - (b[5] as number));
      if (dx * dx + dz * dz > range * range) continue;
      const level = region.levels[0];
      const rows = scene.levelMaterial[region.id]?.[0];
      if (level === undefined || rows === undefined || !level.resident) continue;
      for (let p = 0; p < level.parts.length; p++) {
        if (this.translucent[rows[p] ?? -1] === true) continue;
        sink.mesh((level.parts[p] as DrftPart).mesh as MeshHandle, IDENTITY);
      }
      /* Buildings are copies as often as statics, and a street of them casts the street's shade. */
      if (sink.instanced === undefined) continue;
      const groups = scene.groupMaterial[region.id];
      for (let g = 0; g < region.batches.length; g++) {
        const batch = region.batches[g] as DrftPart;
        if (
          batch.instances === null ||
          this.translucent[groups?.[region.batchGroups[g] ?? -1] ?? -1] === true
        )
          continue;
        sink.instanced(batch.instances.batch, batch.instances.data);
      }
    }
  };
}
