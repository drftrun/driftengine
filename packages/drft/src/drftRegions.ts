/**
 * `REGN`: one region of a streamed world — its geometry at every level of detail, its prop
 * batches, its occluders and its collision — as one chunk, written just ahead of its meshes.
 *
 * **Required, because a reader that skipped it would draw every level of every region at once.**
 * A region's levels are ordinary meshes, so an old reader would open a city as each district drawn
 * three times over itself, and every prop it places as one copy at the origin — the `INST`
 * argument. A refusal naming `REGN` is the honest answer. What that gives up is opening such a file
 * at all in a reader before 1.21.
 *
 * **Levels are meshes named by ordinal, finest first, each with a geometric error**: how far, in
 * metres, that level's surface may stand from the real one. The runtime turns an error into a
 * switch distance against its own screen, which a file cannot know. A mesh belongs to at most one
 * region's levels. An instance group's prototype may be shared by any number of regions — a lamp
 * post is one mesh however many districts stand it — but is never also a level mesh.
 *
 * Layout, little-endian:
 * - u32 id, then f32 × 6 bounds (min xyz, max xyz);
 * - u32 level count, then per level: f32 error, u32 mesh count, that many u32 mesh ordinals;
 * - u32 group count, then per group: u32 mesh ordinal, u32 copies, that many 16-float matrices;
 * - u32 occluder count, then f32 × 6 a box (min xyz, max xyz);
 * - u32 vertex count, u32 index count, f32 × 3 a vertex, u32 an index: the region's collision.
 */
import { DrftError, align } from './drftFormat.ts';
import type { DrftInstanceGroup } from './drftInstances.ts';

export interface DrftRegionLevel {
  /** How far, in metres, this level's surface may stand from the real one. 0 for exact. */
  readonly error: number;
  /** The ordinals of the meshes this level draws. */
  readonly meshes: readonly number[];
}

export interface DrftRegionCollision {
  readonly positions: Float32Array;
  readonly indices: Uint32Array;
}

export interface DrftRegion {
  readonly id: number;
  /** Everything the region holds, min xyz then max xyz. */
  readonly bounds: ArrayLike<number>;
  /** Finest first; at least one. */
  readonly levels: readonly DrftRegionLevel[];
  /** Its props, drawn at its finest level. */
  readonly instances: readonly DrftInstanceGroup[];
  /** Boxes that hide what stands behind them, six floats each. */
  readonly occluders: Float32Array;
  /** One triangle mesh the region collides as, or null. */
  readonly collision: DrftRegionCollision | null;
}

/** The most levels a region may carry; the runtime keeps one value of a byte for "none". */
export const REGION_MAX_LEVELS = 254;

export function buildRegion(region: DrftRegion): Uint8Array {
  checkRegion(region, Number.POSITIVE_INFINITY);
  let bytes = 4 + 24 + 4 + 4 + 4 + 8;
  for (const level of region.levels) bytes += 8 + level.meshes.length * 4;
  for (const group of region.instances) bytes += 8 + group.transforms.length * 4;
  bytes += region.occluders.length * 4;
  const vertices = region.collision?.positions.length ?? 0;
  const indices = region.collision?.indices.length ?? 0;
  bytes += vertices * 4 + indices * 4;
  const out = new Uint8Array(align(bytes));
  const view = new DataView(out.buffer);
  let at = 0;
  const u32 = (value: number): void => {
    view.setUint32(at, value, true);
    at += 4;
  };
  const f32 = (value: number): void => {
    view.setFloat32(at, value, true);
    at += 4;
  };
  u32(region.id);
  for (let i = 0; i < 6; i++) f32(region.bounds[i] as number);
  u32(region.levels.length);
  for (const level of region.levels) {
    f32(level.error);
    u32(level.meshes.length);
    for (const mesh of level.meshes) u32(mesh);
  }
  u32(region.instances.length);
  for (const group of region.instances) {
    u32(group.mesh);
    u32(group.transforms.length / 16);
    for (let i = 0; i < group.transforms.length; i++) f32(group.transforms[i] as number);
  }
  u32(region.occluders.length / 6);
  for (let i = 0; i < region.occluders.length; i++) f32(region.occluders[i] as number);
  u32(vertices / 3);
  u32(indices);
  for (let i = 0; i < vertices; i++) f32(region.collision?.positions[i] as number);
  for (let i = 0; i < indices; i++) u32(region.collision?.indices[i] as number);
  /* The one check the builder owns: it wrote exactly what it measured. */
  if (at !== bytes) throw new DrftError(`internal: REGN wrote ${at} of ${bytes} bytes`);
  return out;
}

/** One `REGN` payload, checked on its own against the file's mesh count. */
export function readRegion(
  buffer: ArrayBufferLike,
  offset: number,
  byteLength: number,
  meshCount: number,
): DrftRegion {
  const view = new DataView(buffer, offset, byteLength);
  let at = 0;
  const need = (bytes: number, what: string): void => {
    if (at + bytes > byteLength) throw new DrftError(`REGN ends inside ${what}`);
  };
  const u32 = (): number => {
    const value = view.getUint32(at, true);
    at += 4;
    return value;
  };
  const floats = (count: number): Float32Array => {
    const out = new Float32Array(count);
    for (let i = 0; i < count; i++) out[i] = view.getFloat32(at + i * 4, true);
    at += count * 4;
    return out;
  };
  need(32, 'its header');
  const id = u32();
  const bounds = floats(6);
  const levelCount = u32();
  const levels: DrftRegionLevel[] = [];
  for (let l = 0; l < levelCount; l++) {
    need(8, `region ${id}'s level ${l}`);
    const error = view.getFloat32(at, true);
    at += 4;
    const count = u32();
    need(count * 4, `region ${id}'s level ${l}`);
    const meshes: number[] = [];
    for (let m = 0; m < count; m++) meshes.push(u32());
    levels.push({ error, meshes });
  }
  need(4, `region ${id}'s groups`);
  const groupCount = u32();
  const instances: DrftInstanceGroup[] = [];
  for (let g = 0; g < groupCount; g++) {
    need(8, `region ${id}'s group ${g}`);
    const mesh = u32();
    const copies = u32();
    need(copies * 64, `region ${id}'s group ${g}`);
    instances.push({ mesh, transforms: floats(copies * 16) });
  }
  need(4, `region ${id}'s occluders`);
  const occluderCount = u32();
  need(occluderCount * 24, `region ${id}'s occluders`);
  const occluders = floats(occluderCount * 6);
  need(8, `region ${id}'s collision`);
  const vertices = u32();
  const indexCount = u32();
  need(vertices * 12 + indexCount * 4, `region ${id}'s collision`);
  const positions = floats(vertices * 3);
  const indices = new Uint32Array(indexCount);
  for (let i = 0; i < indexCount; i++) indices[i] = u32();
  const region: DrftRegion = {
    id,
    bounds,
    levels,
    instances,
    occluders,
    collision: vertices === 0 && indexCount === 0 ? null : { positions, indices },
  };
  checkRegion(region, meshCount);
  return region;
}

/** What one region must be on its own, whoever is asking. */
function checkRegion(region: DrftRegion, meshCount: number): void {
  const name = `region ${region.id}`;
  const b = region.bounds;
  for (let axis = 0; axis < 3; axis++) {
    if (!((b[axis] as number) <= (b[axis + 3] as number))) {
      throw new DrftError(`${name}'s bounds are inside out on axis ${axis}`);
    }
  }
  if (region.levels.length < 1 || region.levels.length > REGION_MAX_LEVELS) {
    throw new DrftError(
      `${name} has ${region.levels.length} levels; 1 to ${REGION_MAX_LEVELS} are allowed`,
    );
  }
  let previous = 0;
  for (let l = 0; l < region.levels.length; l++) {
    const level = region.levels[l] as DrftRegionLevel;
    if (!(level.error >= previous) || !Number.isFinite(level.error)) {
      throw new DrftError(
        `${name}'s level ${l} has error ${level.error}, finer than the one before`,
      );
    }
    previous = level.error;
    for (const mesh of level.meshes) {
      if (mesh >= meshCount) {
        throw new DrftError(`${name} draws mesh ${mesh}, and the file carries ${meshCount}`);
      }
    }
  }
  const grouped = new Set<number>();
  for (const group of region.instances) {
    if (group.mesh >= meshCount) {
      throw new DrftError(`${name} places mesh ${group.mesh}, and the file carries ${meshCount}`);
    }
    if (group.transforms.length === 0 || group.transforms.length % 16 !== 0) {
      throw new DrftError(`${name}'s group for mesh ${group.mesh} is not whole matrices`);
    }
    if (grouped.has(group.mesh)) throw new DrftError(`${name} groups mesh ${group.mesh} twice`);
    grouped.add(group.mesh);
  }
  if (region.occluders.length % 6 !== 0) {
    throw new DrftError(`${name}'s occluders are not whole boxes`);
  }
  const collision = region.collision;
  if (collision !== null) {
    const vertices = collision.positions.length / 3;
    if (collision.positions.length % 3 !== 0 || collision.indices.length % 3 !== 0) {
      throw new DrftError(`${name}'s collision is not whole vertices and triangles`);
    }
    for (let i = 0; i < collision.indices.length; i++) {
      if ((collision.indices[i] as number) >= vertices) {
        throw new DrftError(
          `${name}'s collision names vertex ${collision.indices[i]} of ${vertices}`,
        );
      }
    }
  }
}

/**
 * What regions must be to each other: an id once, a level mesh in one region's one level, and a
 * group's prototype never also a level mesh. Kept across chunks by the writer, the whole-file reader
 * and the stream alike, so a file one of them refuses the others refuse too.
 */
export class RegionLedger {
  private readonly ids = new Set<number>();
  private readonly levelMeshes = new Set<number>();
  private readonly prototypes = new Set<number>();

  admit(region: DrftRegion): void {
    if (this.ids.has(region.id)) throw new DrftError(`region ${region.id} appears twice`);
    this.ids.add(region.id);
    for (const level of region.levels) {
      for (const mesh of level.meshes) {
        if (this.levelMeshes.has(mesh) || this.prototypes.has(mesh)) {
          throw new DrftError(
            `mesh ${mesh} is region ${region.id}'s and something else's; a level mesh belongs to one region's one level`,
          );
        }
        this.levelMeshes.add(mesh);
      }
    }
    for (const group of region.instances) {
      if (this.levelMeshes.has(group.mesh)) {
        throw new DrftError(
          `mesh ${group.mesh} is both a level mesh and a prop region ${region.id} places`,
        );
      }
      this.prototypes.add(group.mesh);
    }
  }

  /** Whether a mesh is any region's, as a level or a prop. */
  names(mesh: number): boolean {
    return this.levelMeshes.has(mesh) || this.prototypes.has(mesh);
  }
}

/**
 * Where each region's chunk goes among the meshes: `before[m]` is the regions written just ahead of
 * mesh `m`, and `before[meshCount]` those after the last. A streaming reader then always has a
 * region before the meshes it introduces.
 *
 * The meshes no region introduces come first, then each region's new meshes, in the order the
 * regions are given and ascending. **A region introduces the kit pieces its assemblies copy, where
 * no earlier region did** (`piecesOf` names them), so a piece travels with the first region that
 * needs it rather than at the head of the file: a world's kit is most of its bytes, and a walker's
 * first regions need a sliver of it. A piece ahead of the first mesh any region names is the
 * file's own, as every piece was before a region could carry one, so either layout is valid. That
 * a piece comes ahead of every assembly copying it is the kit's own rule (`checkCopies`). Anything
 * else is refused by name rather than reordered, because the ordinals are what the regions and the
 * materials already point at.
 */
export function planRegions(
  regions: readonly DrftRegion[],
  meshCount: number,
  piecesOf: (mesh: number) => ArrayLike<number> | undefined = () => undefined,
): DrftRegion[][] {
  const ledger = new RegionLedger();
  for (const region of regions) {
    checkRegion(region, meshCount);
    ledger.admit(region);
  }
  /* What each region introduces: its levels' meshes and its props, then the pieces its level
     meshes copy that nobody introduced before it — those past the first mesh any region names;
     a piece ahead of it is the file's own, written first as every piece once was. */
  let firstNamed = meshCount;
  for (let m = 0; m < meshCount; m++) {
    if (ledger.names(m)) {
      firstNamed = m;
      break;
    }
  }
  const introduced = new Set<number>();
  const fresh = regions.map((region) => {
    const out: number[] = [];
    const take = (mesh: number): void => {
      if (introduced.has(mesh)) return;
      introduced.add(mesh);
      out.push(mesh);
    };
    for (const level of region.levels) for (const mesh of level.meshes) take(mesh);
    for (const group of region.instances) take(group.mesh);
    for (const level of region.levels) {
      for (const mesh of level.meshes) {
        const pieces = piecesOf(mesh);
        for (let i = 0; i < (pieces?.length ?? 0); i++) {
          const piece = pieces?.[i] as number;
          if (piece > firstNamed && !ledger.names(piece)) take(piece);
        }
      }
    }
    return out.sort((a, b) => a - b);
  });
  let next = meshCount - introduced.size;
  for (let m = 0; m < next; m++) {
    if (introduced.has(m)) {
      throw new DrftError(
        `mesh ${m} is a region's and comes before mesh ${next - 1}, which no region names; ` +
          'a file with regions writes the meshes no region names first',
      );
    }
  }
  const before: DrftRegion[][] = [];
  for (let m = 0; m <= meshCount; m++) before.push([]);
  regions.forEach((region, r) => {
    (before[next] as DrftRegion[]).push(region);
    for (const mesh of fresh[r] as number[]) {
      if (mesh !== next) {
        throw new DrftError(
          `region ${region.id} introduces mesh ${mesh} where mesh ${next} is next; ` +
            "write each region's new meshes in the order the regions are written",
        );
      }
      next++;
    }
  });
  return before;
}
