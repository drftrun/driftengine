/**
 * The 3×3 chunk window a chunk's light is computed over, and the flood that fills it.
 *
 * **Why a margin at all.** Light travels at most fifteen blocks, and a chunk is sixteen wide, so
 * a window of one chunk on every side is enough for the centre chunk's light to be *complete* —
 * it can depend on neighbouring blocks, and never on a neighbour's light. That is what removes
 * ordering from the problem entirely: no seams, no second pass, and a chunk can be recomputed
 * alone at any time.
 *
 * Split from `worldLight.ts` because the buffers and the flood are a different job from the cache
 * and the budget that decide when to run one.
 *
 * **Allocates nothing per flood.** Every buffer here is sized once at construction; the two
 * queues grow only if a world ever needs them to, and then keep the larger size.
 */
import { Block, blockLight, lightOpaque } from './blocks';
import { blockIndex, CHUNK_SX, CHUNK_SZ, WORLD_H } from './constants';

export const MAX_LIGHT = 15;

/** The window: one chunk of margin on each side of the centre. */
const RW = CHUNK_SX * 3;
const RD = CHUNK_SZ * 3;
const REGION_CELLS = RW * RD * WORLD_H;
const CHUNK_CELLS = CHUNK_SX * CHUNK_SZ * WORLD_H;

/** Linear index into a region buffer. */
function ri(rx: number, ry: number, rz: number): number {
  return (ry * RD + rz) * RW + rx;
}

/** The nine chunks' block arrays, centre at index 4. */
export type RegionBlocks = readonly Uint8Array[];

export class LightRegion {
  private readonly sky = new Uint8Array(REGION_CELLS);
  private readonly blk = new Uint8Array(REGION_CELLS);
  /** Per column, the lowest cell still open to the sky: one above the topmost opaque block. */
  private readonly floor = new Int16Array(RW * RD);
  private skyQueue = new Int32Array(1 << 16);
  private blkQueue = new Int32Array(1 << 12);
  private region: RegionBlocks = [];

  /**
   * Flood the window and pack the centre chunk's slice out.
   *
   * `hasEmitters` skips the block-light pass entirely while nothing in the world emits, which is
   * every world until a player places a glowing block — and that pass is a full-height scan of
   * every column, where the sky pass stops at the first opaque cell.
   */
  compute(region: RegionBlocks, hasEmitters: boolean, out: Uint8Array): void {
    this.region = region;
    this.sky.fill(0);
    if (hasEmitters) this.blk.fill(0);

    this.markFloors();
    let skyTail = this.seedSky();
    this.flood(this.sky, skyTail, true);

    if (hasEmitters) {
      const blkTail = this.seedBlock();
      this.flood(this.blk, blkTail, false);
    }

    for (let y = 0; y < WORLD_H; y++) {
      for (let lz = 0; lz < CHUNK_SZ; lz++) {
        for (let lx = 0; lx < CHUNK_SX; lx++) {
          const i = ri(lx + CHUNK_SX, y, lz + CHUNK_SZ);
          out[blockIndex(lx, y, lz)] = (this.sky[i]! << 4) | this.blk[i]!;
        }
      }
    }
  }

  private blockAt(rx: number, ry: number, rz: number): Block {
    /* `>> 4` and `& 15` because a chunk is sixteen wide; the window is three of them. */
    return this.region[(rz >> 4) * 3 + (rx >> 4)]![blockIndex(rx & 15, ry, rz & 15)] as Block;
  }

  /** Top-down per column, stopping at the first opaque cell rather than walking all of it. */
  private markFloors(): void {
    for (let rz = 0; rz < RD; rz++) {
      for (let rx = 0; rx < RW; rx++) {
        let f = 0;
        for (let ry = WORLD_H - 1; ry >= 0; ry--) {
          if (lightOpaque(this.blockAt(rx, ry, rz))) {
            f = ry + 1;
            break;
          }
        }
        this.floor[rz * RW + rx] = f;
      }
    }
  }

  /**
   * Every cell above its column's floor is full sky, set directly.
   *
   * **Only a cell that borders a taller column is queued.** An interior cell of an open plateau
   * is surrounded by cells already at maximum and can never raise one, so queueing it is work
   * that provably does nothing. That shrinks the frontier from "all open air" to a thin shell
   * along the terrain's silhouette, which is most of why this is affordable per chunk.
   */
  private seedSky(): number {
    let tail = 0;
    for (let rz = 0; rz < RD; rz++) {
      for (let rx = 0; rx < RW; rx++) {
        const base = rz * RW + rx;
        const f = this.floor[base]!;
        const west = rx > 0 ? this.floor[base - 1]! : f;
        const east = rx < RW - 1 ? this.floor[base + 1]! : f;
        const north = rz > 0 ? this.floor[base - RW]! : f;
        const south = rz < RD - 1 ? this.floor[base + RW]! : f;
        const tallest = Math.max(west, east, north, south);
        for (let ry = WORLD_H - 1; ry >= f; ry--) {
          const i = ri(rx, ry, rz);
          this.sky[i] = MAX_LIGHT;
          if (ry < tallest) tail = this.pushSky(tail, i);
        }
      }
    }
    return tail;
  }

  private seedBlock(): number {
    let tail = 0;
    for (let rz = 0; rz < RD; rz++) {
      for (let rx = 0; rx < RW; rx++) {
        for (let ry = WORLD_H - 1; ry >= 0; ry--) {
          const emitted = blockLight(this.blockAt(rx, ry, rz));
          if (emitted === 0) continue;
          const i = ri(rx, ry, rz);
          this.blk[i] = emitted;
          tail = this.pushBlk(tail, i);
        }
      }
    }
    return tail;
  }

  /**
   * Breadth-first flood over the window.
   *
   * `isSky` enables the one rule that makes sky light look like sky light: straight down at full
   * strength does not attenuate, so a shaft to the bottom of a cave stays bright while anything
   * sideways falls off a level per block.
   */
  private flood(buf: Uint8Array, tail: number, isSky: boolean): void {
    const queue = isSky ? 'skyQueue' : 'blkQueue';
    for (let head = 0; head < tail; head++) {
      /* Indexed through `this` every time because a push may have replaced the array. */
      const i = this[queue][head]!;
      const level = buf[i]!;
      if (level <= 1) continue;
      const rx = i % RW;
      const t = (i / RW) | 0;
      const rz = t % RD;
      const ry = (t / RD) | 0;

      const down = isSky && level === MAX_LIGHT ? level : level - 1;
      if (ry > 0) tail = this.spread(buf, rx, ry - 1, rz, down, tail, isSky);
      if (ry < WORLD_H - 1) tail = this.spread(buf, rx, ry + 1, rz, level - 1, tail, isSky);
      if (rx > 0) tail = this.spread(buf, rx - 1, ry, rz, level - 1, tail, isSky);
      if (rx < RW - 1) tail = this.spread(buf, rx + 1, ry, rz, level - 1, tail, isSky);
      if (rz > 0) tail = this.spread(buf, rx, ry, rz - 1, level - 1, tail, isSky);
      if (rz < RD - 1) tail = this.spread(buf, rx, ry, rz + 1, level - 1, tail, isSky);
    }
  }

  private spread(
    buf: Uint8Array,
    rx: number,
    ry: number,
    rz: number,
    level: number,
    tail: number,
    isSky: boolean,
  ): number {
    if (level <= 0) return tail;
    if (lightOpaque(this.blockAt(rx, ry, rz))) return tail;
    const i = ri(rx, ry, rz);
    if (buf[i]! >= level) return tail;
    buf[i] = level;
    return isSky ? this.pushSky(tail, i) : this.pushBlk(tail, i);
  }

  private pushSky(head: number, value: number): number {
    if (head >= this.skyQueue.length) {
      const bigger = new Int32Array(this.skyQueue.length * 2);
      bigger.set(this.skyQueue);
      this.skyQueue = bigger;
    }
    this.skyQueue[head] = value;
    return head + 1;
  }

  private pushBlk(head: number, value: number): number {
    if (head >= this.blkQueue.length) {
      const bigger = new Int32Array(this.blkQueue.length * 2);
      bigger.set(this.blkQueue);
      this.blkQueue = bigger;
    }
    this.blkQueue[head] = value;
    return head + 1;
  }
}

export { CHUNK_CELLS };
