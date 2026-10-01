/**
 * The regions of a streamed world as they arrive: each one's meshes at every level, its prop
 * batches, its occluders and its collision, kept apart from the loader's parts and never merged.
 *
 * **Apart, because a region's levels are alternatives rather than pieces.** The loader merges its
 * parts by material into one mesh a group, which is right for one model and wrong here twice over:
 * it would weld a district's finest level to its coarsest, drawing both, and weld one district to
 * the next, so none could be dropped when the eye leaves. So a region's meshes upload on the
 * loader's clocked queue like any part and land here instead, one part a mesh, a list a level.
 *
 * **A prop's prototype arrives once and serves every region that places it.** A region naming a
 * prototype already up gets its batch at the next budgeted build; one naming a prototype still to
 * come waits for it. Either way the batch is built inside a frame's budget, never from the stream's
 * callback, and culls instance by instance (`createInstanced`'s `cull`).
 *
 * **A level that arrives as assemblies is paged** (`MSHC`, `drftAssembly.ts`). A city's finest
 * level is millions of triangles, more than any device keeps resident, so such a level is held as
 * the copies the file carried — tens of kilobytes a district — and comes up only when the caller
 * pages it in, expanded and uploaded on the same clocked queue; paged out, its meshes are freed and
 * the copies stay. What it costs is a region that is not yet up when the eye arrives: the caller
 * draws a coarser level until `resident` says the fine one is there, and pages ahead of the eye.
 *
 * Everything is in the loader's placement: a world loads with `{ fit: 'none' }`, where that is the
 * file's own space.
 */
import { createMeshInstances } from '@driftengine/core';
import type { MeshHandle, MeshInstances, RendererApi } from '@driftengine/core';
import type { DrftAssembly, DrftRegion, DrftRegionCollision, PieceLookup } from '@driftengine/drft';
import { expandAssembly } from '@driftengine/drft';
import type { MeshData } from '@driftengine/drft';
import type { DrftPart } from './loadProgress.ts';

/** How the loader placed the model: `p · scale + (x, y, z)`. */
export interface LoaderFit {
  readonly scale: number;
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

export interface LoadedRegionLevel {
  /** How far, in metres of the file, this level may stand from the real surface. */
  readonly error: number;
  /** One part a mesh, filled as they upload. */
  readonly parts: DrftPart[];
  /** Whether any of its meshes arrived as assemblies, kept small until paged in. */
  paged: boolean;
  /** Whether every mesh is up: always, for a level that is not paged. */
  resident: boolean;
}

export interface LoadedRegion {
  readonly id: number;
  /** Min xyz then max xyz, placed. */
  readonly bounds: Float32Array;
  /** Finest first. `HlodSet.add` takes the errors, scaled by the fit. */
  readonly levels: readonly LoadedRegionLevel[];
  /** Its props, one instanced part a prototype, culled per instance. */
  readonly batches: DrftPart[];
  /**
   * Which of the region's groups in the file each batch is, index for index. Batches are built as
   * their prototypes arrive, not in the file's order, so a caller pairing something of its own with
   * each group — a material, a blend — pairs through this, never by position.
   */
  readonly batchGroups: number[];
  /** Six floats a box, placed, for `addOccluder`. */
  readonly occluders: Float32Array;
  /** What it collides as, placed, or null. */
  readonly collision: DrftRegionCollision | null;
  /** Meshes and batches still to come; 0 once every level and prop is up. */
  pending: number;
}

/**
 * Copies of a fitted prototype, each matrix conjugated by the fit: M becomes F·M·F⁻¹, the same turn
 * and a translation of t − R·t + s·u for the fit's scale s and offset t and the copy's own
 * translation u. The prototype already carries the fit, so the copies land where its geometry does
 * and are not scaled twice.
 */
export function fitCopies(transforms: Float32Array, fit: LoaderFit): MeshInstances {
  const count = transforms.length / 16;
  const data = createMeshInstances(count);
  for (let k = 0; k < count; k++) {
    const at = k * 16;
    for (let i = 0; i < 12; i++) data.models[at + i] = transforms[at + i] as number;
    /* R·t, with R the copy's own 3×3 read column-major. */
    const rtx =
      (transforms[at] as number) * fit.x +
      (transforms[at + 4] as number) * fit.y +
      (transforms[at + 8] as number) * fit.z;
    const rty =
      (transforms[at + 1] as number) * fit.x +
      (transforms[at + 5] as number) * fit.y +
      (transforms[at + 9] as number) * fit.z;
    const rtz =
      (transforms[at + 2] as number) * fit.x +
      (transforms[at + 6] as number) * fit.y +
      (transforms[at + 10] as number) * fit.z;
    data.models[at + 12] = fit.x - rtx + fit.scale * (transforms[at + 12] as number);
    data.models[at + 13] = fit.y - rty + fit.scale * (transforms[at + 13] as number);
    data.models[at + 14] = fit.z - rtz + fit.scale * (transforms[at + 14] as number);
    data.models[at + 15] = 1;
  }
  data.tints.fill(1);
  data.count = count;
  return data;
}

/** Points packed xyz, placed by the fit into a new array. */
function placed(points: ArrayLike<number>, fit: LoaderFit): Float32Array {
  const out = new Float32Array(points.length);
  for (let i = 0; i < points.length; i += 3) {
    out[i] = (points[i] as number) * fit.scale + fit.x;
    out[i + 1] = (points[i + 1] as number) * fit.scale + fit.y;
    out[i + 2] = (points[i + 2] as number) * fit.scale + fit.z;
  }
  return out;
}

export class RegionStore {
  readonly regions = new Map<number, LoadedRegion>();
  /** Level meshes by ordinal: whose, and which level. */
  private readonly levelOwners = new Map<number, { region: LoadedRegion; level: number }>();
  /** Prototypes that have uploaded, by ordinal. */
  private readonly prototypes = new Map<number, DrftPart>();
  /** Groups whose prototype has not uploaded yet, by its ordinal. */
  private readonly waiting = new Map<
    number,
    { region: LoadedRegion; transforms: Float32Array; group: number }[]
  >();
  private readonly jobs: {
    region: LoadedRegion;
    prototype: DrftPart;
    transforms: Float32Array;
    group: number;
  }[] = [];
  private readonly made: MeshHandle[] = [];
  /** Assemblies held small, by ordinal, and each paged level's ordinals. */
  private readonly compact = new Map<number, { assembly: DrftAssembly; piece: PieceLookup }>();
  private readonly levelCompact = new Map<LoadedRegionLevel, number[]>();
  /** Paged meshes asked for and not yet up, and those that are. */
  private readonly requested = new Set<number>();
  private readonly pagedParts = new Map<number, DrftPart>();

  constructor(
    private readonly renderer: RendererApi,
    private readonly fit: () => LoaderFit | null,
  ) {}

  /** Whether a mesh is a region's, as a level or a prop, and so is not a part of the model. */
  owns(ordinal: number): boolean {
    return (
      this.levelOwners.has(ordinal) || this.prototypes.has(ordinal) || this.waiting.has(ordinal)
    );
  }

  /** Whether batches are queued. */
  get busy(): boolean {
    return this.jobs.length > 0;
  }

  /** A region's chunk has landed, ahead of the meshes it introduces. */
  admit(region: DrftRegion): void {
    const fit = this.fit() ?? { scale: 1, x: 0, y: 0, z: 0 };
    const loaded: LoadedRegion = {
      id: region.id,
      bounds: new Float32Array([
        ...placed([region.bounds[0], region.bounds[1], region.bounds[2]] as number[], fit),
        ...placed([region.bounds[3], region.bounds[4], region.bounds[5]] as number[], fit),
      ]),
      levels: region.levels.map((level) => ({
        error: level.error * fit.scale,
        parts: [],
        paged: false,
        resident: true,
      })),
      batches: [],
      batchGroups: [],
      occluders: placed(region.occluders, fit),
      collision:
        region.collision === null
          ? null
          : {
              positions: placed(region.collision.positions, fit),
              indices: region.collision.indices,
            },
      pending: 0,
    };
    region.levels.forEach((level, index) => {
      for (const mesh of level.meshes) {
        this.levelOwners.set(mesh, { region: loaded, level: index });
        loaded.pending++;
      }
    });
    region.instances.forEach((group, index) => {
      loaded.pending++;
      const prototype = this.prototypes.get(group.mesh);
      if (prototype !== undefined) {
        this.jobs.push({ region: loaded, prototype, transforms: group.transforms, group: index });
        return;
      }
      const list = this.waiting.get(group.mesh) ?? [];
      list.push({ region: loaded, transforms: group.transforms, group: index });
      this.waiting.set(group.mesh, list);
    });
    this.regions.set(region.id, loaded);
  }

  /** Whether a mesh is one of a region's levels. */
  isLevelMesh(ordinal: number): boolean {
    return this.levelOwners.has(ordinal);
  }

  /** A level's assembly has arrived: held small, its level paged and not yet up. */
  hold(ordinal: number, assembly: DrftAssembly, piece: PieceLookup): void {
    const owner = this.levelOwners.get(ordinal);
    const level = owner?.region.levels[owner.level];
    if (owner === undefined || level === undefined) return;
    this.compact.set(ordinal, { assembly, piece });
    const list = this.levelCompact.get(level) ?? [];
    list.push(ordinal);
    this.levelCompact.set(level, list);
    level.paged = true;
    level.resident = false;
    owner.region.pending--;
  }

  /**
   * Ask for a paged level's meshes, or free them. Coming up, returns each mesh still to upload with
   * a way to expand it, for the loader's queue; going down, frees what is up and returns the
   * ordinals released, so the loader can drop any still queued.
   */
  page(
    id: number,
    level: number,
    resident: boolean,
  ): { ordinal: number; expand: () => MeshData }[] {
    const lv = this.regions.get(id)?.levels[level];
    const ordinals = lv === undefined ? undefined : this.levelCompact.get(lv);
    if (lv === undefined || ordinals === undefined) return [];
    const out: { ordinal: number; expand: () => MeshData }[] = [];
    for (const ordinal of ordinals) {
      const held = this.compact.get(ordinal);
      if (held === undefined) continue;
      if (resident) {
        if (this.pagedParts.has(ordinal) || this.requested.has(ordinal)) continue;
        this.requested.add(ordinal);
        out.push({ ordinal, expand: () => expandAssembly(held.assembly, held.piece) });
        continue;
      }
      this.requested.delete(ordinal);
      const part = this.pagedParts.get(ordinal);
      out.push({ ordinal, expand: () => expandAssembly(held.assembly, held.piece) });
      if (part === undefined) continue;
      this.pagedParts.delete(ordinal);
      this.release(part);
      const at = lv.parts.indexOf(part);
      if (at >= 0) lv.parts.splice(at, 1);
    }
    if (!resident) lv.resident = false;
    return out;
  }

  private release(part: DrftPart): void {
    const at = this.made.indexOf(part.mesh);
    if (at >= 0) this.made.splice(at, 1);
    this.renderer.disposeMesh(part.mesh);
  }

  /** A region's mesh has uploaded, as the part the loader would have made of it. */
  arrived(ordinal: number, part: DrftPart): void {
    if (this.compact.has(ordinal)) {
      /* Paged out again while it was on its way up: nothing wants it. */
      if (!this.requested.delete(ordinal)) {
        this.renderer.disposeMesh(part.mesh);
        return;
      }
      this.made.push(part.mesh);
      this.pagedParts.set(ordinal, part);
      const owner = this.levelOwners.get(ordinal);
      const level = owner?.region.levels[owner.level];
      if (level === undefined) return;
      level.parts.push(part);
      level.resident = (this.levelCompact.get(level) ?? []).every((o) => this.pagedParts.has(o));
      return;
    }
    this.made.push(part.mesh);
    const owner = this.levelOwners.get(ordinal);
    if (owner !== undefined) {
      owner.region.levels[owner.level]?.parts.push(part);
      owner.region.pending--;
      return;
    }
    this.prototypes.set(ordinal, part);
    for (const group of this.waiting.get(ordinal) ?? []) {
      this.jobs.push({
        region: group.region,
        prototype: part,
        transforms: group.transforms,
        group: group.group,
      });
    }
    this.waiting.delete(ordinal);
  }

  /** Build one queued batch inside the caller's budget; false when none was queued. */
  buildNext(): boolean {
    const job = this.jobs.shift();
    if (job === undefined) return false;
    const data = fitCopies(job.transforms, this.fit() ?? { scale: 1, x: 0, y: 0, z: 0 });
    try {
      const batch = this.renderer.createInstanced(job.prototype.mesh, data.count, { cull: true });
      this.renderer.uploadInstanced(batch, data);
      job.region.batches.push({ ...job.prototype, reveal: 1, instances: { batch, data } });
      job.region.batchGroups.push(job.group);
    } catch (error) {
      console.warn(`DrftLoader: region ${job.region.id}'s props would not upload`, error);
    }
    job.region.pending--;
    return true;
  }

  dispose(): void {
    for (const region of this.regions.values()) {
      for (const part of region.batches) {
        if (part.instances !== null) this.renderer.disposeInstanced(part.instances.batch);
      }
    }
    for (const mesh of this.made) this.renderer.disposeMesh(mesh);
    this.made.length = 0;
    this.regions.clear();
  }
}
