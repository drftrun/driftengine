/**
 * The city as a stream: blocks built as the eye comes near them and taken out once it has gone.
 *
 * **What makes the demo exercise streaming rather than a flag on a rig.** Every block is generated
 * from the seed and its place (`manhattan.ts`), clustered when it arrives and handed to one
 * `StreamingScene`, as the voxel sandbox's chunks are; the scene's free lists take it back when the
 * block leaves. A block built on arrival is the block that would have been built at load, because
 * its stream of numbers is its own — so where the camera flies does not change the city it sees.
 *
 * **Nearest first, a budget at a time.** A block of this city is 240 m of street wall and towers,
 * and costs up to fifty milliseconds to generate and cluster on the machine this was measured on;
 * so a frame builds one, or a few while there is time, and the rest arrive over the frames after —
 * the ones the camera is nearest to first.
 *
 * **One block past the reach is kept**, as `ChunkRenderer` keeps a chunk: an eye moving back and
 * forth across a block's edge would otherwise drop and rebuild a row each time.
 */
import { StreamingScene } from '../../packages/core/src/index';
import { clustered } from '../gpuDrivenRig';
import {
  CITY_COLS,
  CITY_ROWS,
  LOT_X,
  LOT_Z,
  MATERIAL_COUNT,
  PITCH_X,
  PITCH_Z,
  blockOrigin,
  cityBlock,
  inCity,
} from './manhattan';

import type { StreamCapacity, StreamHandle } from '../../packages/core/src/index';

/** The seed the published city is built from. */
export const CITY_SEED = 20260918;

/**
 * The largest block the published grid makes, in each of the three things a scene has room for.
 *
 * **Measured, not chosen**: every block of the grid at `CITY_SEED`, generated and clustered, on
 * 2026-09-18 — and `cityStream.test.ts` measures it again, so a change to the generator that grows
 * a block fails there rather than as a refused block in the demo.
 */
export const CITY_WORST = { vertices: 17629, indices: 83118, clusters: 1267 } as const;

/**
 * Room over the worst case, for fragmentation, as the sandbox takes it — `stream-fragmentation.mjs`
 * measured best fit clean at a quarter's headroom on a workload of this shape.
 */
const HEADROOM = 1.25;

/** Blocks either side of the eye's that a reach in metres needs, east to west and north to south. */
function spans(reach: number): [number, number] {
  return [Math.ceil(reach / PITCH_X), Math.ceil(reach / PITCH_Z)];
}

/** The scene a reach needs, from the worst block and the ring kept round the eye. */
export function cityCapacity(reach: number): StreamCapacity {
  const [rx, rz] = spans(reach);
  const blocks = Math.min(2 * (rx + 1) + 1, CITY_COLS) * Math.min(2 * (rz + 1) + 1, CITY_ROWS);
  return {
    vertices: Math.ceil(CITY_WORST.vertices * blocks * HEADROOM),
    indices: Math.ceil(CITY_WORST.indices * blocks * HEADROOM),
    clusters: Math.ceil(CITY_WORST.clusters * blocks * HEADROOM),
    /* One slot a material a block, so a slot freed is always the size of the next one asked for. */
    meshes: blocks * MATERIAL_COUNT,
  };
}

/**
 * The reaches this scene will step down through, largest first.
 *
 * A ladder rather than arithmetic because the capacity is a step function of the reach: blocks come
 * in whole rows and columns, so between two rungs nothing changes and solving for a reach would
 * land between them and mean the same city.
 */
const REACH_LADDER = [900, 700, 600, 500, 450, 350, 300, 250, 200] as const;

/**
 * Room to leave under the device's ceiling.
 *
 * The vertex buffer is the largest of the pipeline's storage bindings and it is not the only one,
 * so filling the limit exactly would refuse on the next binding instead of this one.
 */
const BINDING_FIT = 0.8;

/** What a reach costs as one storage binding, which is what a device actually refuses. */
export function cityVertexBytes(reach: number, bytesPerVertex: number): number {
  return cityCapacity(reach).vertices * bytesPerVertex;
}

/**
 * The largest reach this adapter can bind, which on a phone is not the one the desktop gets.
 *
 * **Reported from a Galaxy S23 Ultra: the scene asked for 152,314,560 bytes and the device binds
 * 134,217,728.** That is 128 MiB, the WebGPU default, and it is what most handhelds offer against
 * the several gigabytes a desktop adapter does. The engine was already asking the adapter for its
 * ceiling rather than taking the default, so there was nothing to raise: the scene was simply
 * larger than the part could hold, and every phone got a blank frame and a refusal in the console.
 *
 * **`budget` could not have fixed this on its own.** This scene ignored the one it was handed, and
 * it would not have helped if it had: the demos page passes `full` to every device and only a
 * `?budget=` in the address says otherwise, so a phone never asked for less. Sizing against the
 * limit the device reports needs no coordination with whoever is mounting the scene.
 *
 * A fresh adapter, because the one `createRenderer` used was consumed by the device it created.
 * Where there is nothing to ask, the asked-for reach stands and the pipeline refuses as before.
 */
/**
 * The largest reach on the ladder this ceiling can bind, never larger than the one asked for.
 *
 * Pure, and separated from the adapter that supplies the ceiling, because the arithmetic is the
 * part worth asserting and a device is the part a test cannot have.
 */
export function reachForCeiling(asked: number, ceiling: number, bytesPerVertex: number): number {
  const room = ceiling * BINDING_FIT;
  if (cityVertexBytes(asked, bytesPerVertex) <= room) return asked;
  for (const rung of REACH_LADDER) {
    if (rung <= asked && cityVertexBytes(rung, bytesPerVertex) <= room) return rung;
  }
  return REACH_LADDER[REACH_LADDER.length - 1];
}

function keyOf(bx: number, bz: number): string {
  return `${bx},${bz}`;
}

interface Held {
  readonly bx: number;
  readonly bz: number;
  readonly handles: StreamHandle[];
  readonly triangles: number;
}

export class CityStream {
  readonly scene: StreamingScene;
  /** Blocks that did not fit. It staying at zero is what says the capacity is right. */
  refused = 0;

  private readonly seed: number;
  private readonly rx: number;
  private readonly rz: number;
  private readonly live = new Map<string, Held>();
  private held = 0;
  /**
   * **Scratch for `update`, which runs every frame and so allocates nothing**: three numbers a
   * candidate block — its squared distance and its place — and the order they are built in.
   */
  private readonly candidates: Float64Array;
  private readonly order: number[] = [];

  /**
   * `reach` is how far from the eye, in metres to each side, a block is built. `capacity` is the
   * reach's own unless a test needs a block not to fit.
   */
  constructor(seed: number, reach: number, capacity: StreamCapacity = cityCapacity(reach)) {
    this.seed = seed;
    [this.rx, this.rz] = spans(reach);
    this.scene = new StreamingScene(capacity);
    this.candidates = new Float64Array((2 * this.rx + 1) * (2 * this.rz + 1) * 3);
  }

  /** Blocks in the scene. */
  get count(): number {
    return this.live.size;
  }

  /** Triangles in the scene, which is the number the demo's readout says. */
  get triangles(): number {
    return this.held;
  }

  has(bx: number, bz: number): boolean {
    return this.live.has(keyOf(bx, bz));
  }

  /**
   * Take out what the eye has left, then build up to `budget` of the blocks it is near, nearest
   * first — stopping sooner once `ms` milliseconds have gone, though never before the first. Returns
   * how many were built, so a caller can drain the ring by calling until it is zero.
   */
  update(x: number, z: number, budget: number, ms = Infinity): number {
    const ex = Math.floor(x / PITCH_X);
    const ez = Math.floor(z / PITCH_Z);

    for (const [key, held] of this.live) {
      if (Math.abs(held.bx - ex) > this.rx + 1 || Math.abs(held.bz - ez) > this.rz + 1) {
        for (const handle of held.handles) this.scene.remove(handle);
        this.held -= held.triangles;
        this.live.delete(key);
      }
    }

    const c = this.candidates;
    this.order.length = 0;
    let count = 0;
    for (let bz = ez - this.rz; bz <= ez + this.rz; bz += 1) {
      for (let bx = ex - this.rx; bx <= ex + this.rx; bx += 1) {
        if (!inCity(bx, bz) || this.live.has(keyOf(bx, bz))) continue;
        /* By distance from the eye to the block's middle, so the nearest arrive first. */
        const [ox, oz] = blockOrigin(bx, bz);
        const dx = ox + LOT_X / 2 - x;
        const dz = oz + LOT_Z / 2 - z;
        c[count * 3] = dx * dx + dz * dz;
        c[count * 3 + 1] = bx;
        c[count * 3 + 2] = bz;
        this.order.push(count);
        count += 1;
      }
    }
    /* Ties by place, so the order is the same on every run whatever the sort does with equals. */
    this.order.sort(
      (a, b) =>
        (c[a * 3] as number) - (c[b * 3] as number) ||
        (c[a * 3 + 2] as number) - (c[b * 3 + 2] as number) ||
        (c[a * 3 + 1] as number) - (c[b * 3 + 1] as number),
    );

    const started = performance.now();
    const most = Math.min(budget, count);
    let built = 0;
    while (built < most) {
      if (built > 0 && performance.now() - started >= ms) break;
      const at = this.order[built] as number;
      this.add(c[at * 3 + 1] as number, c[at * 3 + 2] as number);
      built += 1;
    }
    return built;
  }

  /** Build one block into the scene, all of its meshes or none of them. */
  private add(bx: number, bz: number): void {
    const handles: StreamHandle[] = [];
    let triangles = 0;
    for (const mesh of cityBlock(bx, bz, this.seed)) {
      const handle = this.scene.add(clustered(mesh), mesh.transform as Float32Array, mesh.material);
      if (handle === null) {
        for (const placed of handles) this.scene.remove(placed);
        this.refused += 1;
        return;
      }
      handles.push(handle);
      triangles += mesh.indices.length / 3;
    }
    this.live.set(keyOf(bx, bz), { bx, bz, handles, triangles });
    this.held += triangles;
  }
}
