/**
 * Cached voxel light, and the budget that keeps computing it off the frame time.
 *
 * Two channels per cell, each 0 to 15, packed into one byte as `(sky << 4) | block`. Sky comes
 * from open air, full strength straight down and a level per block sideways, so digging under
 * cover gets darker. Block light comes from glowing blocks and falls off in every direction.
 *
 * `lightRegion.ts` owns the flood; this owns *when* one runs. That matters more than it sounds:
 * meshing one cold chunk reads light a block past its own border, which cascades a flood for that
 * chunk and all eight neighbours — nine in a single frame, which is a visible stall. `warmFor`
 * caps them and tells the caller to come back rather than paying for all nine at once.
 */
import { CHUNK_SX, CHUNK_SZ, chunkKey, WORLD_H } from './constants';
import { CHUNK_CELLS, LightRegion, MAX_LIGHT } from './lightRegion';
import type { World } from './world';

export { MAX_LIGHT };

/** What a cell above the world reads as: open sky, nothing emitting. */
const OPEN_SKY = MAX_LIGHT << 4;

export class WorldLight {
  private readonly world: World;
  private readonly cache = new Map<string, Uint8Array>();
  private readonly region = new LightRegion();
  /** The nine chunks handed to a flood, refilled per call rather than rebuilt. */
  private readonly neighbourhood: Uint8Array[] = new Array<Uint8Array>(9);
  private floodsThisFrame = 0;

  constructor(world: World) {
    this.world = world;
  }

  /** Reset the per-frame flood budget. Once a frame, before any `warmFor`. */
  beginFrame(): void {
    this.floodsThisFrame = 0;
  }

  /**
   * Make sure the 3×3 neighbourhood around a chunk is cached, so meshing it hits only the cache.
   *
   * Returns false when the budget ran out with work left, which asks the caller to defer the
   * build a frame rather than stall on the rest.
   */
  warmFor(cx: number, cz: number, maxFloods: number): boolean {
    for (let dz = -1; dz <= 1; dz++) {
      for (let dx = -1; dx <= 1; dx++) {
        const key = chunkKey(cx + dx, cz + dz);
        if (this.cache.has(key)) continue;
        if (this.floodsThisFrame >= maxFloods) return false;
        this.putLight(key, this.compute(cx + dx, cz + dz));
        this.floodsThisFrame++;
      }
    }
    return true;
  }

  /**
   * The chunk's light the last read landed in, for the reason `World` keeps one of its own.
   *
   * `getPacked` keyed the map on a template string per call, and the mesher reads light for every
   * vertex of every visible face — measured at 15.4 ms across a chunk's worth of reads. Meshing
   * walks a column, so the read before this one was almost always in this chunk.
   *
   * **Every mutation of `cache` drops it**, which is why the three writers below exist: the cache
   * is deleted from in five places and cleared in a sixth, and a memo that outlived any one of
   * them would answer from an array the store had already thrown away.
   */
  private memoKey = '';
  private memoLight: Uint8Array | null = null;

  private putLight(key: string, light: Uint8Array): void {
    this.cache.set(key, light);
    this.memoLight = null;
  }

  private dropLight(key: string): void {
    this.cache.delete(key);
    this.memoLight = null;
  }

  private clearLight(): void {
    this.cache.clear();
    this.memoLight = null;
  }

  /** Packed light at a world cell. Above the world is open sky; below it is dark. */
  getPacked(wx: number, wy: number, wz: number): number {
    if (wy >= WORLD_H) return OPEN_SKY;
    if (wy < 0) return 0;
    const cx = Math.floor(wx / CHUNK_SX);
    const cz = Math.floor(wz / CHUNK_SZ);
    const key = chunkKey(cx, cz);
    let light = this.memoLight !== null && key === this.memoKey ? this.memoLight : undefined;
    if (light === undefined) {
      light = this.cache.get(key);
      if (light === undefined) {
        light = this.compute(cx, cz);
        this.putLight(key, light);
      }
      this.memoKey = key;
      this.memoLight = light;
    }
    const lx = wx - cx * CHUNK_SX;
    const lz = wz - cz * CHUNK_SZ;
    return light[(wy * CHUNK_SZ + lz) * CHUNK_SX + lx]!;
  }

  /** Forget one chunk's light. */
  invalidate(cx: number, cz: number): void {
    this.cache.delete(chunkKey(cx, cz));
  }

  /** Forget all of it, for a world reload. */
  clear(): void {
    this.clearLight();
  }

  /**
   * Forget what a single-block edit can have changed: its own chunk always, and a neighbour only
   * when the edit sits on their shared seam.
   *
   * **An interior edit deliberately keeps every neighbour's cache.** Those chunks are not
   * remeshed for an interior edit either, and recomputing a full region for all eight of them per
   * block dug is what made the reference hitch while digging. They heal when they next remesh.
   */
  invalidateEdit(wx: number, wz: number): void {
    const cx = Math.floor(wx / CHUNK_SX);
    const cz = Math.floor(wz / CHUNK_SZ);
    this.cache.delete(chunkKey(cx, cz));
    const lx = wx - cx * CHUNK_SX;
    const lz = wz - cz * CHUNK_SZ;
    const nx = lx === 0 ? -1 : lx === CHUNK_SX - 1 ? 1 : 0;
    const nz = lz === 0 ? -1 : lz === CHUNK_SZ - 1 ? 1 : 0;
    if (nx !== 0) this.cache.delete(chunkKey(cx + nx, cz));
    if (nz !== 0) this.cache.delete(chunkKey(cx, cz + nz));
    if (nx !== 0 && nz !== 0) this.cache.delete(chunkKey(cx + nx, cz + nz));
  }

  private compute(cx: number, cz: number): Uint8Array {
    for (let gz = 0; gz < 3; gz++) {
      for (let gx = 0; gx < 3; gx++) {
        this.neighbourhood[gz * 3 + gx] = this.world.getChunk(cx - 1 + gx, cz - 1 + gz).blocks;
      }
    }
    const out = new Uint8Array(CHUNK_CELLS);
    this.region.compute(this.neighbourhood, this.world.anyEmitters, out);
    return out;
  }
}
