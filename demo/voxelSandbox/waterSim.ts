/**
 * Water finding its way into whatever the player opens.
 *
 * **TypeScript rather than DriftScript, and the spec says why**: this is a hot per-cell loop over
 * thousands of cells a step, and putting it behind a script boundary would trade the demo's
 * performance argument for a language point.
 *
 * Two speeds, deliberately. Worldgen's oceans settle *instantly* as a chunk activates, so the sea
 * never visibly creeps in as you explore. Only what the player digs flows step by step, one block
 * ring at a time, which is the part that is worth watching.
 */
import { Block } from './blocks';
import { CHUNK_SX, CHUNK_SZ, SEA_LEVEL, WORLD_H } from './constants';
import type { ChunkRenderer } from './chunkRenderer';
import type { World } from './world';

/** Seconds between flow steps. Slow enough to read as pouring. */
const WATER_STEP = 0.2;
/** A catch-up cap, so a long stall cannot avalanche into one enormous frame. */
const MAX_STEPS_PER_FRAME = 4;
/** A bound on a single very large generation; the tail carries to the next step. */
const MAX_CELLS_PER_STEP = 8192;
/** A guard on the instant floods, which are bounded by the world but not by a clock. */
const MAX_INSTANT_CELLS = 4_000_000;

export class WaterSim {
  private readonly world: World;
  private readonly chunks: ChunkRenderer;

  /* Two generations, so a cell filled this step cannot feed its sibling this step. */
  private current: number[] = [];
  private next: number[] = [];
  private head = 0;
  private accum = 0;
  private readonly queued = new Set<string>();

  constructor(world: World, chunks: ChunkRenderer) {
    this.world = world;
    this.chunks = chunks;
  }

  /** A block was broken: water may now have somewhere to go. */
  onBreak(x: number, y: number, z: number): void {
    this.enqueueAround(x, y, z);
  }

  /** A block was placed: a water source spreads, and a solid one re-checks its surroundings. */
  onPlace(x: number, y: number, z: number): void {
    this.enqueueAround(x, y, z);
  }

  reset(): void {
    this.current.length = 0;
    this.next.length = 0;
    this.head = 0;
    this.accum = 0;
    this.queued.clear();
  }

  /**
   * Settle everything a freshly activated chunk introduces, at once.
   *
   * Worldgen fills an ocean straight down per column, which cannot reach a cave that opens
   * *sideways* into the seafloor — that leaves a wall of water beside a dry pocket the player
   * would swim into. This pours through the connected cavity and remeshes once per touched chunk.
   */
  settleChunk(cx: number, cz: number): void {
    const queue: number[] = [];
    const seen = new Set<string>();
    const push = (x: number, y: number, z: number): void => {
      if (y < 0 || y >= WORLD_H) return;
      if (!this.world.hasChunk(Math.floor(x / CHUNK_SX), Math.floor(z / CHUNK_SZ))) return;
      const key = `${x},${y},${z}`;
      if (seen.has(key)) return;
      seen.add(key);
      queue.push(x, y, z);
    };

    this.forEachFloodSeed(cx, cz, push);
    if (queue.length === 0) return;

    const dirty = new Set<string>();
    let i = 0;
    let guard = 0;
    while (i < queue.length && guard++ < MAX_INSTANT_CELLS) {
      const x = queue[i]!;
      const y = queue[i + 1]!;
      const z = queue[i + 2]!;
      i += 3;
      /* Allow a cell to be reconsidered once its feeder fills: a cell popped before the water
         above it arrived would otherwise be lost for good. */
      seen.delete(`${x},${y},${z}`);
      if (!this.feeds(x, y, z)) continue;
      this.world.setBlock(x, y, z, Block.WATER, false);
      this.markDirty(x, z, dirty);
      push(x, y - 1, z);
      push(x + 1, y, z);
      push(x - 1, y, z);
      push(x, y, z + 1);
      push(x, y, z - 1);
    }
    this.flush(dirty);
  }

  /**
   * Settle a whole region before anything is meshed, for the spawn warm-up.
   *
   * Data only: no remesh, because the caller meshes afterwards and each chunk is then built once
   * with its water already in place. Without this the first frame shows dry caves under the sea
   * and then a remesh storm as they fill.
   */
  prefill(chunks: ReadonlyArray<readonly [number, number]>): void {
    for (const [cx, cz] of chunks)
      this.forEachFloodSeed(cx, cz, (x, y, z) => this.enqueue(x, y, z));

    const discarded = new Set<string>();
    let guard = 0;
    while (
      (this.head < this.current.length || this.next.length > 0) &&
      guard++ < MAX_INSTANT_CELLS
    ) {
      if (this.head >= this.current.length) this.promote();
      const x = this.current[this.head]!;
      const y = this.current[this.head + 1]!;
      const z = this.current[this.head + 2]!;
      this.head += 3;
      this.queued.delete(`${x},${y},${z}`);
      if (this.feeds(x, y, z)) this.fill(x, y, z, discarded);
    }
    /* The live loop starts clean: everything above was settled without a clock. */
    this.reset();
  }

  /** Advance the flood on fixed steps, so it creeps a ring at a time whatever the frame rate. */
  update(dtSec: number): void {
    if (this.idle()) {
      this.accum = 0;
      return;
    }
    this.accum += dtSec;
    const dirty = new Set<string>();
    let steps = 0;
    while (this.accum >= WATER_STEP && steps < MAX_STEPS_PER_FRAME) {
      this.accum -= WATER_STEP;
      steps++;
      this.step(dirty);
      if (this.idle()) {
        this.accum = 0;
        break;
      }
    }
    this.flush(dirty);
  }

  /**
   * Every sub-sea air cell in a chunk that already touches water: the flood front a newly
   * generated chunk introduces.
   */
  private forEachFloodSeed(
    cx: number,
    cz: number,
    visit: (x: number, y: number, z: number) => void,
  ): void {
    const baseX = cx * CHUNK_SX;
    const baseZ = cz * CHUNK_SZ;
    for (let lx = 0; lx < CHUNK_SX; lx++) {
      for (let lz = 0; lz < CHUNK_SZ; lz++) {
        const wx = baseX + lx;
        const wz = baseZ + lz;
        for (let y = 1; y < SEA_LEVEL; y++) {
          if (this.world.getBlock(wx, y, wz) !== Block.AIR) continue;
          if (
            this.world.getBlock(wx, y + 1, wz) === Block.WATER ||
            this.world.getBlock(wx + 1, y, wz) === Block.WATER ||
            this.world.getBlock(wx - 1, y, wz) === Block.WATER ||
            this.world.getBlock(wx, y, wz + 1) === Block.WATER ||
            this.world.getBlock(wx, y, wz - 1) === Block.WATER
          ) {
            visit(wx, y, wz);
          }
        }
      }
    }
  }

  private idle(): boolean {
    return this.head >= this.current.length && this.next.length === 0;
  }

  /**
   * The cells this step decided to fill, reused across steps.
   *
   * **Held rather than made, because `step` is on the frame path.** It was a local, so every
   * generation allocated one — small, and exactly the shape `demo/scenes.test.ts` refuses, which
   * did not see it until that gate's corpus was widened from the scene modules to every module
   * under `demo/`. The keys `queued` holds are still strings and still allocate; that is a
   * different change and this comment is not claiming it.
   */
  private readonly fills: number[] = [];

  private promote(): void {
    this.head = 0;
    const spent = this.current;
    this.current = this.next;
    this.next = spent;
    this.next.length = 0;
  }

  /**
   * One generation, in two phases.
   *
   * **The split is what makes the spread exactly one ring per step.** Phase one decides which
   * cells fill, reading the world as it stood when the generation began; phase two applies them.
   * Applying mid-scan would let a cell filled early feed its sibling late, collapsing several
   * rings into one step and making a flood arrive all at once.
   */
  private step(dirty: Set<string>): void {
    if (this.head >= this.current.length) {
      if (this.next.length === 0) return;
      this.promote();
    }

    const fills = this.fills;
    fills.length = 0;
    let processed = 0;
    while (this.head < this.current.length && processed < MAX_CELLS_PER_STEP) {
      const x = this.current[this.head]!;
      const y = this.current[this.head + 1]!;
      const z = this.current[this.head + 2]!;
      this.head += 3;
      this.queued.delete(`${x},${y},${z}`);
      processed++;
      if (this.feeds(x, y, z)) fills.push(x, y, z);
    }

    /* Compact what has been consumed, or a generation that carries over across many steps grows
       its backing array without bound. */
    if (this.head >= this.current.length) {
      this.current.length = 0;
      this.head = 0;
    } else if (this.head > 4096) {
      /* In place rather than `slice`, which allocated a second array of everything left in the
         generation on every step past the threshold. */
      this.current.copyWithin(0, this.head);
      this.current.length -= this.head;
      this.head = 0;
    }

    for (let i = 0; i < fills.length; i += 3) {
      this.fill(fills[i]!, fills[i + 1]!, fills[i + 2]!, dirty);
    }
  }

  /**
   * Whether an air cell is currently fed.
   *
   * From above always, because water falls. From the sides only below sea level, which is what
   * stops a broken block on a hilltop turning into a spreading puddle across the whole surface.
   */
  private feeds(x: number, y: number, z: number): boolean {
    if (this.world.getBlock(x, y, z) !== Block.AIR) return false;
    if (this.world.getBlock(x, y + 1, z) === Block.WATER) return true;
    if (y >= SEA_LEVEL) return false;
    return (
      this.world.getBlock(x + 1, y, z) === Block.WATER ||
      this.world.getBlock(x - 1, y, z) === Block.WATER ||
      this.world.getBlock(x, y, z + 1) === Block.WATER ||
      this.world.getBlock(x, y, z - 1) === Block.WATER
    );
  }

  private fill(x: number, y: number, z: number, dirty: Set<string>): void {
    /* Not recorded as a player edit: it re-derives from the terrain on reload, and recording it
       would bloat every save with cells that regenerate for free. */
    this.world.setBlock(x, y, z, Block.WATER, false);
    this.markDirty(x, z, dirty);
    this.enqueue(x, y - 1, z);
    this.enqueue(x + 1, y, z);
    this.enqueue(x - 1, y, z);
    this.enqueue(x, y, z + 1);
    this.enqueue(x, y, z - 1);
  }

  private enqueueAround(x: number, y: number, z: number): void {
    this.enqueue(x, y, z);
    this.enqueue(x, y + 1, z);
    this.enqueue(x, y - 1, z);
    this.enqueue(x + 1, y, z);
    this.enqueue(x - 1, y, z);
    this.enqueue(x, y, z + 1);
    this.enqueue(x, y, z - 1);
  }

  /**
   * Queue a cell, unless it is outside the world or in a chunk that is not loaded.
   *
   * **The loaded-chunk test is load-bearing.** A long undersea cavern would otherwise pull in and
   * mutate chunks far beyond the render radius, one cell at a time. Cells just past the edge are
   * picked up by `settleChunk` when their chunk activates, so the flood resumes across the
   * boundary rather than being lost.
   */
  private enqueue(x: number, y: number, z: number): void {
    if (y < 0 || y >= WORLD_H) return;
    if (!this.world.hasChunk(Math.floor(x / CHUNK_SX), Math.floor(z / CHUNK_SZ))) return;
    const key = `${x},${y},${z}`;
    if (this.queued.has(key)) return;
    this.queued.add(key);
    this.next.push(x, y, z);
  }

  /**
   * Mark the filled cell's chunk, and a neighbour only when the cell is on their seam.
   *
   * An interior cell touches one chunk, so a spreading flood does not trigger a nine-chunk
   * remesh per filled cell.
   */
  private markDirty(wx: number, wz: number, dirty: Set<string>): void {
    const cx = Math.floor(wx / CHUNK_SX);
    const cz = Math.floor(wz / CHUNK_SZ);
    const lx = wx - cx * CHUNK_SX;
    const lz = wz - cz * CHUNK_SZ;
    const nx = lx === 0 ? -1 : lx === CHUNK_SX - 1 ? 1 : 0;
    const nz = lz === 0 ? -1 : lz === CHUNK_SZ - 1 ? 1 : 0;
    dirty.add(`${cx},${cz}`);
    if (nx !== 0) dirty.add(`${cx + nx},${cz}`);
    if (nz !== 0) dirty.add(`${cx},${cz + nz}`);
    if (nx !== 0 && nz !== 0) dirty.add(`${cx + nx},${cz + nz}`);
  }

  private flush(dirty: Set<string>): void {
    for (const key of dirty) {
      const comma = key.indexOf(',');
      this.chunks.remeshIfActive(
        Number.parseInt(key.slice(0, comma), 10),
        Number.parseInt(key.slice(comma + 1), 10),
      );
    }
  }
}
