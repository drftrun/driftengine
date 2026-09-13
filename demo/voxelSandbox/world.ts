/**
 * The blocks, and the player's changes to them.
 *
 * Chunks generate lazily and deterministically on first touch, which is what lets the mesher
 * freely read across a chunk border for face culling and ambient occlusion: the neighbour always
 * exists by the time it is asked for, and always agrees.
 *
 * **Edits live beside the chunk rather than inside it.** That separation is what makes a save a
 * seed plus a few hundred numbers, and what lets a distant chunk be dropped to reclaim memory
 * without losing what the player built on it.
 */
import { Block, blockLight } from './blocks';
import { blockIndex, CHUNK_SX, CHUNK_SZ, chunkKey, WORLD_H } from './constants';
import { generateChunk } from './worldgen';
import { WorldLight } from './worldLight';

export interface Chunk {
  cx: number;
  cz: number;
  blocks: Uint8Array;
}

/**
 * What the mesher and the raycast need from a world, and nothing more.
 *
 * Narrower than `World` on purpose: reading a block is the only thing either of them does, so
 * this is what they take, and a test can satisfy it with a `Map`.
 */
export interface BlockSource {
  getBlock(wx: number, wy: number, wz: number): Block;
}

export class World implements BlockSource {
  seed: number;

  /** The light over these blocks. Owned here because every write has to invalidate it. */
  readonly light: WorldLight;

  private readonly chunks = new Map<string, Chunk>();
  /**
   * The chunk the last lookup landed in, so a run of reads inside one does not re-key the map.
   *
   * **`getBlock` was the mesher's whole cost.** Every call built `chunkKey`'s template string and
   * hashed it: measured at 20.0 ms of a 24.5 ms chunk mesh, across roughly 196,000 reads — a cell,
   * its six neighbours and the twelve ambient-occlusion probes around each visible face. A mesher
   * walks a column at a time, so almost every one of those reads is in the chunk the read before
   * it was in, and one slot of memo answers them without a string or a hash.
   *
   * Held as three fields rather than a small map because the win *is* not touching a map.
   * Invalidated wherever `chunks` changes, which is `getChunk`'s insert and `dropChunk`.
   */
  private lastCx = Number.NaN;
  private lastCz = Number.NaN;
  private lastChunk: Chunk | null = null;
  /**
   * The player's changes, keyed by chunk and then by in-chunk index.
   *
   * Kept out of the chunk data so an edit survives its chunk being streamed out and
   * regenerated, and so the set can be serialised on its own. Simulation writes — water
   * flooding — are deliberately not recorded: they re-derive from the terrain and these edits
   * on reload, and recording them would bloat a save with cells that regenerate for free.
   */
  private readonly edits = new Map<string, Map<number, number>>();

  /**
   * Whether any light-emitting block has ever been recorded.
   *
   * Worldgen never emits, so while this is false the light solver can stop each column at the
   * first opaque block instead of walking all ninety-six looking for emitters — which is the
   * dominant cost of computing light for a freshly streamed chunk. It latches on and never off:
   * a removed emitter only costs the slower scan, and tracking the removal would cost more than
   * the scan does.
   */
  private emitters = false;

  constructor(seed: number) {
    this.seed = seed;
    this.light = new WorldLight(this);
  }

  get anyEmitters(): boolean {
    return this.emitters;
  }

  /** The chunk at these chunk coordinates, generating it if this is its first touch. */
  getChunk(cx: number, cz: number): Chunk {
    const memo = this.lastChunk;
    if (memo !== null && cx === this.lastCx && cz === this.lastCz) return memo;
    const key = chunkKey(cx, cz);
    const existing = this.chunks.get(key);
    if (existing !== undefined) {
      this.remember(cx, cz, existing);
      return existing;
    }

    const blocks = new Uint8Array(CHUNK_SX * CHUNK_SZ * WORLD_H);
    generateChunk(this.seed, cx, cz, blocks);
    /* Replayed over the fresh terrain, so a chunk that streamed out and came back is the one
       the player left rather than the one the generator makes. */
    const recorded = this.edits.get(key);
    if (recorded !== undefined) {
      for (const [idx, id] of recorded) blocks[idx] = id;
    }
    const chunk: Chunk = { cx, cz, blocks };
    this.chunks.set(key, chunk);
    this.remember(cx, cz, chunk);
    return chunk;
  }

  /** Whether a chunk is already generated. Does not generate one to find out. */
  hasChunk(cx: number, cz: number): boolean {
    return this.chunks.has(chunkKey(cx, cz));
  }

  /** Forget a chunk's blocks. Its edits are kept, and replayed if it comes back. */
  dropChunk(cx: number, cz: number): void {
    this.chunks.delete(chunkKey(cx, cz));
    /* Or the next read of this column would be answered from a chunk the store no longer has,
       and the caller would be writing into geometry nothing else can see. */
    if (cx === this.lastCx && cz === this.lastCz) this.forget();
    /*
     * Only this chunk's light, never its neighbours'. Terrain regenerates identically and edits
     * replay, so a neighbour's cache stays valid — and invalidating the full 3×3 here forced
     * eight needless re-floods for every chunk that streamed out as the player walked.
     */
    this.light.invalidate(cx, cz);
  }

  private remember(cx: number, cz: number, chunk: Chunk): void {
    this.lastCx = cx;
    this.lastCz = cz;
    this.lastChunk = chunk;
  }

  private forget(): void {
    this.lastCx = Number.NaN;
    this.lastCz = Number.NaN;
    this.lastChunk = null;
  }

  getBlock(wx: number, wy: number, wz: number): Block {
    if (wy < 0 || wy >= WORLD_H) return Block.AIR;
    const cx = Math.floor(wx / CHUNK_SX);
    const cz = Math.floor(wz / CHUNK_SZ);
    return this.getChunk(cx, cz).blocks[
      blockIndex(wx - cx * CHUNK_SX, wy, wz - cz * CHUNK_SZ)
    ] as Block;
  }

  /** Packed light at a cell: sky in the high nibble, block light in the low one. */
  getPacked(wx: number, wy: number, wz: number): number {
    return this.light.getPacked(wx, wy, wz);
  }

  /**
   * Write a block, returning the chunk it landed in, or null if it was outside the world.
   *
   * `record` defaults to true and stores the change as a player edit. Pass false for a
   * simulation write that re-derives on reload.
   */
  setBlock(
    wx: number,
    wy: number,
    wz: number,
    id: Block,
    record = true,
  ): { cx: number; cz: number } | null {
    if (wy < 0 || wy >= WORLD_H) return null;
    const cx = Math.floor(wx / CHUNK_SX);
    const cz = Math.floor(wz / CHUNK_SZ);
    const idx = blockIndex(wx - cx * CHUNK_SX, wy, wz - cz * CHUNK_SZ);
    this.getChunk(cx, cz).blocks[idx] = id;
    if (record) this.recordEdit(cx, cz, idx, id);
    this.light.invalidateEdit(wx, wz);
    return { cx, cz };
  }

  private recordEdit(cx: number, cz: number, idx: number, id: number): void {
    if (blockLight(id) > 0) this.emitters = true;
    const key = chunkKey(cx, cz);
    let recorded = this.edits.get(key);
    if (recorded === undefined) {
      recorded = new Map();
      this.edits.set(key, recorded);
    }
    recorded.set(idx, id);
  }

  /** The player's edits as a flat `[wx, wy, wz, id, …]`. Deltas only. */
  exportEdits(): number[] {
    const out: number[] = [];
    for (const [key, recorded] of this.edits) {
      const comma = key.indexOf(',');
      const cx = Number.parseInt(key.slice(0, comma), 10);
      const cz = Number.parseInt(key.slice(comma + 1), 10);
      for (const [idx, id] of recorded) {
        const lx = idx % CHUNK_SX;
        const r = (idx - lx) / CHUNK_SX;
        const lz = r % CHUNK_SZ;
        const wy = (r - lz) / CHUNK_SZ;
        out.push(cx * CHUNK_SX + lx, wy, cz * CHUNK_SZ + lz, id);
      }
    }
    return out;
  }

  /**
   * Throw everything away and rebuild from a seed and an edit set.
   *
   * The caller owns rebuilding whatever was drawn from the old world; this only forgets it.
   */
  reset(seed: number, edits: number[]): void {
    this.seed = seed;
    this.chunks.clear();
    this.edits.clear();
    this.emitters = false;
    this.light.clear();
    for (let i = 0; i + 3 < edits.length; i += 4) {
      const wx = edits[i]!;
      const wy = edits[i + 1]!;
      const wz = edits[i + 2]!;
      const id = edits[i + 3]!;
      if (wy < 0 || wy >= WORLD_H) continue;
      const cx = Math.floor(wx / CHUNK_SX);
      const cz = Math.floor(wz / CHUNK_SZ);
      this.recordEdit(cx, cz, blockIndex(wx - cx * CHUNK_SX, wy, wz - cz * CHUNK_SZ), id);
    }
  }

  /** The Y of the topmost non-air block in a column, or -1 if the column is empty. */
  surfaceY(wx: number, wz: number): number {
    for (let y = WORLD_H - 1; y >= 0; y--) {
      if (this.getBlock(wx, y, wz) !== Block.AIR) return y;
    }
    return -1;
  }

  /**
   * Somewhere near `(wx, wz)` a player can stand: solid ground underfoot, two clear blocks
   * above, and never a tree, a cactus or the sea.
   *
   * Spirals outward a ring at a time so the answer is the nearest such column rather than the
   * first one a scan happens to reach.
   */
  findSpawn(wx: number, wz: number): { x: number; y: number; z: number } {
    const unstandable = (b: Block): boolean =>
      b === Block.AIR ||
      b === Block.WATER ||
      b === Block.LOG ||
      b === Block.LEAVES ||
      b === Block.CACTUS;

    for (let r = 0; r <= 24; r++) {
      for (let dz = -r; dz <= r; dz++) {
        for (let dx = -r; dx <= r; dx++) {
          /* The current ring only; the interior was covered by a smaller `r`. */
          if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue;
          const cx = wx + dx;
          const cz = wz + dz;
          const top = this.surfaceY(cx, cz);
          if (top < 0) continue;
          if (unstandable(this.getBlock(cx, top, cz))) continue;
          if (this.getBlock(cx, top + 1, cz) !== Block.AIR) continue;
          if (this.getBlock(cx, top + 2, cz) !== Block.AIR) continue;
          return { x: cx + 0.5, y: top + 1, z: cz + 0.5 };
        }
      }
    }

    /* Nothing clear within twenty-four rings. Stand on whatever is here rather than refusing
       to spawn at all. */
    const fallback = this.surfaceY(wx, wz);
    return { x: wx + 0.5, y: (fallback >= 0 ? fallback : 40) + 1, z: wz + 0.5 };
  }
}
